import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "../src/hooks/guard";
import { registerSession, endSession } from "../src/lib/registry";
import { writeJsonAtomic } from "../src/lib/atomic";
import { paths } from "../src/lib/paths";
import type { PendingJoin } from "../src/lib/types";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;
const prevGroupEnv = process.env.CLAUDE_SYNC_GROUP;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-guard-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
  delete process.env.CLAUDE_SYNC_GROUP;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
  if (prevGroupEnv) process.env.CLAUDE_SYNC_GROUP = prevGroupEnv;
  else delete process.env.CLAUDE_SYNC_GROUP;
});

describe("guard decision table", () => {
  test("env var set => kind env, regardless of registry state", async () => {
    process.env.CLAUDE_SYNC_GROUP = "demo";
    const outcome = await guard({ session_id: "s1", cwd: "/repo/a", hook_event_name: "PostToolUse" });
    expect(outcome).toEqual({ kind: "env", group: "demo" });
  });

  test("no env, active membership exists => kind member", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    const outcome = await guard({ session_id: "s1", cwd: "/repo/a", hook_event_name: "PostToolUse" });
    expect(outcome.kind).toBe("member");
    if (outcome.kind === "member") expect(outcome.group).toBe("demo");
  });

  test("no env, ended membership => kind none (session has left)", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    const outcome = await guard({ session_id: "s1", cwd: "/repo/a", hook_event_name: "PostToolUse" });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("no env, no membership, no pending join => kind none", async () => {
    const outcome = await guard({ session_id: "unknown", cwd: "/repo/a", hook_event_name: "PostToolUse" });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("fresh pending join claimed on SessionStart, and the pending file is consumed", async () => {
    const pending: PendingJoin = { v: 1, group: "demo", created_at: Date.now() };
    await writeJsonAtomic(paths.pendingJoinFile("/repo/a"), pending);

    const outcome = await guard({ session_id: "new-sess", cwd: "/repo/a", hook_event_name: "SessionStart" });
    expect(outcome).toEqual({ kind: "claim", group: "demo" });

    // consumed: a second guard call finds nothing pending
    const second = await guard({ session_id: "new-sess-2", cwd: "/repo/a", hook_event_name: "SessionStart" });
    expect(second).toEqual({ kind: "none" });
  });

  test("pending join is NOT claimed on PostToolUse (only SessionStart/UserPromptSubmit)", async () => {
    const pending: PendingJoin = { v: 1, group: "demo", created_at: Date.now() };
    await writeJsonAtomic(paths.pendingJoinFile("/repo/a"), pending);

    const outcome = await guard({ session_id: "new-sess", cwd: "/repo/a", hook_event_name: "PostToolUse" });
    expect(outcome).toEqual({ kind: "none" });
  });

  test("expired pending join (older than TTL) is not claimed", async () => {
    const stale: PendingJoin = { v: 1, group: "demo", created_at: Date.now() - 3 * 60 * 1000 };
    await writeJsonAtomic(paths.pendingJoinFile("/repo/a"), stale);

    const outcome = await guard({ session_id: "new-sess", cwd: "/repo/a", hook_event_name: "SessionStart" });
    expect(outcome).toEqual({ kind: "none" });
  });
});
