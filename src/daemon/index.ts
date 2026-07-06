#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createExclusive, removeIfExists } from "../lib/atomic";
import { paths } from "../lib/paths";
import { journalSize } from "../lib/journal";
import { listMemberships } from "../lib/registry";
import { findAllDirtySessions } from "./poller";
import { SummarizerQueue } from "./summarizer";
import { rebuildGroupDigest } from "./digest-writer";
import { startControlServer, type ControlCommand } from "./control";
import { runTombstoneEviction, runOrphanFileGC } from "./eviction";
import { log } from "./log";

const POLL_INTERVAL_MS = 2_000;
const DEBOUNCE_MS = 10_000;
const MAX_STALENESS_MS = 60_000;
const EVICTION_INTERVAL_MS = 60_000;

interface DirtyState {
  firstDirtyAt: number;
  lastGrowthAt: number;
  lastSize: number;
}

async function probeAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function daemonStatus(): Promise<{ running: boolean; pid?: number }> {
  const pidPath = paths.daemonPid();
  const text = await Bun.file(pidPath)
    .text()
    .catch(() => undefined);
  if (!text) return { running: false };
  const pid = parseInt(text, 10);
  if (!pid || !(await probeAlive(pid))) return { running: false };
  return { running: true, pid };
}

/** Acquire the singleton pidfile lock, clearing a stale (dead-process) pidfile first. */
export async function acquirePidLock(): Promise<boolean> {
  const pidPath = paths.daemonPid();
  if (await createExclusive(pidPath, String(process.pid))) return true;

  const existing = await Bun.file(pidPath)
    .text()
    .catch(() => "");
  const pid = parseInt(existing, 10);
  if (!pid || !(await probeAlive(pid))) {
    await removeIfExists(pidPath);
    return createExclusive(pidPath, String(process.pid));
  }
  return false;
}

/** Spawn a detached daemon process if one isn't already running. Fire-and-forget — never
 * awaited by callers on the hook hot path.
 *
 * CLAUDE_SYNC_SKIP_DAEMON_ENSURE is a test-only escape hatch: it lets hook/CLI tests run
 * against a throwaway sandbox data dir without actually forking a real daemon process
 * that would outlive the test and poll a since-deleted directory. */
export async function ensureDaemon(): Promise<void> {
  if (process.env.CLAUDE_SYNC_SKIP_DAEMON_ENSURE) return;

  const status = await daemonStatus();
  if (status.running) return;

  const child = spawn(process.execPath, [import.meta.path, "--foreground"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export async function stopDaemon(): Promise<boolean> {
  const status = await daemonStatus();
  if (!status.running || !status.pid) return false;
  process.kill(status.pid, "SIGTERM");
  return true;
}

async function handleControlCommand(queue: SummarizerQueue, cmd: ControlCommand): Promise<unknown> {
  if (cmd.cmd === "status") {
    const memberships = await listMemberships();
    return { ok: true, pid: process.pid, sessions: memberships.length };
  }
  if (cmd.cmd === "shutdown") {
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 0);
    return { ok: true };
  }
  if (cmd.cmd === "summarize_now") {
    const sessionId = cmd.session_id as string | undefined;
    if (!sessionId) return { ok: false, error: "missing session_id" };
    const memberships = await listMemberships();
    const membership = memberships.find((m) => m.session_id === sessionId);
    if (!membership) return { ok: false, error: "unknown session" };
    await queue.enqueue({
      group: membership.group,
      sessionId: membership.session_id,
      repo: membership.repo,
      cwd: membership.cwd,
    });
    const digest = await rebuildGroupDigest(membership.group);
    return { ok: true, digestVersion: digest.version };
  }
  return { ok: false, error: "unknown command" };
}

export async function runForeground(): Promise<void> {
  // ensureDaemon() is typically invoked from inside a synced session's SessionStart hook
  // (via spawn with `env: process.env`), so this process would otherwise inherit
  // CLAUDE_SYNC_GROUP from whichever session happened to start it. The daemon serves every
  // group, it must never appear to *be* a member of one — and just as importantly, every
  // `claude -p` child it spawns for summarization (see summarizer.ts) inherits process.env
  // by default, so leaving this set would make the summarizer's own headless calls trip
  // their own SessionStart hook and register a phantom "session" back into the group,
  // which then gets summarized itself in an unbounded feedback loop.
  delete process.env.CLAUDE_SYNC_GROUP;

  if (!(await acquirePidLock())) {
    console.error("claude-sync daemon already running");
    process.exitCode = 1;
    return;
  }

  await log(`daemon starting (pid ${process.pid})`);

  const queue = new SummarizerQueue({
    onDigestDirty: (group) => {
      void rebuildGroupDigest(group).catch((err) => log(`digest rebuild failed for ${group}: ${err}`));
    },
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await removeIfExists(paths.daemonPid());
    await removeIfExists(paths.daemonSock());
    await log("daemon stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await startControlServer((cmd) => handleControlCommand(queue, cmd));

  const dirtyState = new Map<string, DirtyState>();
  let lastEvictionAt = 0;

  while (!stopped) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (stopped) break;

    try {
      const now0 = Date.now();
      if (now0 - lastEvictionAt >= EVICTION_INTERVAL_MS) {
        lastEvictionAt = now0;
        await runTombstoneEviction(now0).catch((err) => log(`tombstone eviction error: ${err}`));
        await runOrphanFileGC(now0).catch((err) => log(`orphan file gc error: ${err}`));
      }

      const dirty = await findAllDirtySessions();
      const memberships = await listMemberships();
      const byId = new Map(memberships.map((m) => [m.session_id, m]));
      const now = Date.now();
      const seenKeys = new Set<string>();

      for (const { group, sessionId } of dirty) {
        const key = `${group}:${sessionId}`;
        seenKeys.add(key);
        const membership = byId.get(sessionId);
        if (!membership) continue;

        const size = await journalSize(group, sessionId);
        const prevState = dirtyState.get(key);
        if (!prevState) {
          dirtyState.set(key, { firstDirtyAt: now, lastGrowthAt: now, lastSize: size });
          continue;
        }
        if (size > prevState.lastSize) {
          prevState.lastGrowthAt = now;
          prevState.lastSize = size;
        }

        const debounceElapsed = now - prevState.lastGrowthAt >= DEBOUNCE_MS;
        const maxStalenessElapsed = now - prevState.firstDirtyAt >= MAX_STALENESS_MS;
        if (debounceElapsed || maxStalenessElapsed) {
          dirtyState.delete(key);
          void queue.enqueue({ group, sessionId, repo: membership.repo, cwd: membership.cwd });
        }
      }

      for (const key of dirtyState.keys()) {
        if (!seenKeys.has(key)) dirtyState.delete(key);
      }
    } catch (err) {
      await log(`poll loop error: ${err}`);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "start" || args.includes("--foreground")) {
    await runForeground();
  } else if (args[0] === "stop") {
    const stopped = await stopDaemon();
    console.log(stopped ? "daemon stopped" : "daemon was not running");
  } else if (args[0] === "status") {
    const status = await daemonStatus();
    console.log(JSON.stringify(status));
  } else if (args[0] === "ensure") {
    await ensureDaemon();
  } else {
    console.error("usage: daemon <start|stop|status|ensure> [--foreground]");
    process.exitCode = 2;
  }
}
