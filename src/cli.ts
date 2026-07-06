#!/usr/bin/env bun
import { readJson, writeJsonAtomic } from "./lib/atomic";
import { paths } from "./lib/paths";
import { listMemberships, resolveByCwd, endSession } from "./lib/registry";
import { getCursor, setCursor } from "./lib/cursor";
import { renderDigest, deltaSessions } from "./lib/digest";
import { appendJournal } from "./lib/journal";
import { CAPS, clampStr } from "./lib/types";
import type { Digest, Membership, PendingJoin } from "./lib/types";
import { daemonStatus, ensureDaemon, stopDaemon, runForeground } from "./daemon/index";
import { sendControlCommand } from "./daemon/control";
import { install, defaultInstallPaths } from "./install/install";
import { uninstall } from "./install/uninstall";

interface Flags {
  [key: string]: string;
}

export function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function resolveSession(flags: Flags): Promise<Membership | undefined> {
  const cwd = flags.cwd ?? process.cwd();
  if (flags.session) {
    const all = await listMemberships();
    const match = all.find(
      (m) => m.session_id.startsWith(flags.session!) && m.status === "active" && (!flags.group || m.group === flags.group),
    );
    if (match) return match;
  }
  return resolveByCwd(cwd, flags.group);
}

async function cmdStatus(flags: Flags): Promise<void> {
  const daemon = await daemonStatus();
  console.log(`Daemon: ${daemon.running ? `running (pid ${daemon.pid})` : "not running"}`);

  const membership = await resolveSession(flags);
  if (!membership) {
    console.log(`Not part of a sync group in ${flags.cwd ?? process.cwd()}.`);
    return;
  }

  const digest = await readJson<Digest>(paths.digestFile(membership.group));
  const cursor = await getCursor(membership.group, membership.session_id);
  const cursorVersion = cursor?.digest_version ?? 0;
  const digestVersion = digest?.version ?? 0;

  console.log(`Group: ${membership.group}`);
  console.log(`Your session: ${membership.session_id.slice(0, 8)} (${membership.status})`);
  console.log(
    `Cursor: v${cursorVersion} / digest v${digestVersion}${digestVersion > cursorVersion ? " — STALE, run `claude-sync now`" : " — caught up"}`,
  );

  if (digest) {
    console.log("");
    for (const [sid, entry] of Object.entries(digest.sessions)) {
      const marker = sid === membership.session_id ? "*" : " ";
      const focus = entry.recap.focus ? ` — ${entry.recap.focus}` : "";
      console.log(`${marker} ${entry.label} [${entry.repo}] ${entry.status}${focus}`);
    }
  }
}

async function cmdNow(flags: Flags): Promise<void> {
  const membership = await resolveSession(flags);
  if (!membership) {
    console.log("Not part of a sync group here.");
    return;
  }

  // The daemon's handler awaits the full summarize retry chain before responding — up to
  // ~215s worst case (three attempts at up to 60s each, plus 5s/30s backoffs). The default
  // 30s client timeout would report a healthy, still-working daemon as "not running", so
  // `now` gets a generous timeout of its own; every other command keeps the 30s default.
  const response = (await sendControlCommand({ cmd: "summarize_now", session_id: membership.session_id }, 220_000)) as
    | { ok: boolean; error?: string }
    | undefined;
  if (!response) {
    console.log("Daemon is not running or timed out. Try `claude-sync daemon start`.");
    return;
  }
  if (!response.ok) {
    console.log(`Failed: ${response.error}`);
    return;
  }

  const digest = await readJson<Digest>(paths.digestFile(membership.group));
  if (!digest) {
    console.log("No digest yet.");
    return;
  }
  const cursor = await getCursor(membership.group, membership.session_id);
  const cursorVersion = cursor?.digest_version ?? 0;

  if (digest.version <= cursorVersion) {
    console.log("Already caught up.");
    return;
  }

  const delta = deltaSessions(digest, cursorVersion, membership.session_id);
  const deltaIds = Object.keys(delta);
  if (deltaIds.length > 0) {
    const totalOthers = Object.keys(digest.sessions).filter((id) => id !== membership.session_id).length;
    const unchangedCount = totalOthers - deltaIds.length;
    console.log(renderDigest({ digest, excludeSessionId: membership.session_id, entries: delta, unchangedCount }));
  } else {
    console.log("No changes from peers since your last sync.");
  }
  await setCursor(membership.group, membership.session_id, digest.version);
}

async function cmdPush(positional: string[], flags: Flags): Promise<void> {
  const message = flags.message ?? positional.join(" ");
  if (!message) {
    console.log('usage: claude-sync push "<message>" [--cwd <path>] [--session <label>]');
    return;
  }
  const membership = await resolveSession(flags);
  if (!membership) {
    console.log("Not part of a sync group here.");
    return;
  }
  await appendJournal(membership.group, membership.session_id, {
    v: 1,
    t: Date.now(),
    e: "note",
    text: clampStr(message, CAPS.noteMax),
  });
  console.log("Pinned. Peers will see it once the daemon processes it (or they run `claude-sync now`).");
}

async function cmdJoin(positional: string[], flags: Flags): Promise<void> {
  const group = positional[0];
  if (!group) {
    console.log("usage: claude-sync join <group> [--cwd <path>]");
    return;
  }
  const cwd = flags.cwd ?? process.cwd();
  const pending: PendingJoin = { v: 1, group, created_at: Date.now() };
  await writeJsonAtomic(paths.pendingJoinFile(cwd), pending);
  await ensureDaemon().catch(() => {});
  console.log(`Joined "${group}" — sync activates on your next message.`);
}

async function cmdLeave(flags: Flags): Promise<void> {
  const membership = await resolveSession(flags);
  if (!membership) {
    console.log("Not part of a sync group here.");
    return;
  }
  await endSession(membership.session_id);
  await appendJournal(membership.group, membership.session_id, { v: 1, t: Date.now(), e: "end" });
  console.log(`Left group "${membership.group}".`);
}

async function cmdDaemon(positional: string[]): Promise<void> {
  const sub = positional[0];
  if (sub === "start" || sub === "ensure") {
    await ensureDaemon();
    console.log("daemon ensured running.");
  } else if (sub === "stop") {
    const stopped = await stopDaemon();
    console.log(stopped ? "daemon stopped." : "daemon was not running.");
  } else if (sub === "status") {
    console.log(JSON.stringify(await daemonStatus()));
  } else if (sub === "foreground") {
    await runForeground();
  } else {
    console.log("usage: claude-sync daemon <start|stop|status|ensure|foreground>");
  }
}

export async function main(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  switch (sub) {
    case "status":
      await cmdStatus(flags);
      break;
    case "now":
      await cmdNow(flags);
      break;
    case "push":
      await cmdPush(positional, flags);
      break;
    case "join":
      await cmdJoin(positional, flags);
      break;
    case "leave":
      await cmdLeave(flags);
      break;
    case "daemon":
      await cmdDaemon(positional);
      break;
    case "install":
      await install(flags.project === "true" ? defaultInstallPaths({ project: true, cwd: flags.cwd }) : {});
      break;
    case "uninstall":
      await uninstall({
        ...(flags.project === "true" ? defaultInstallPaths({ project: true, cwd: flags.cwd }) : {}),
        purge: flags.purge === "true",
      });
      break;
    default:
      console.log("usage: claude-sync <status|now|push|join|leave|daemon|install|uninstall>");
      process.exitCode = sub ? 2 : 0;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
