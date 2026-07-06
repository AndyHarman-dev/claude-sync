import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSession,
  getMembership,
  isMember,
  heartbeat,
  endSession,
  listMemberships,
  resolveByCwd,
} from "../src/lib/registry";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-registry-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("registerSession / getMembership / isMember", () => {
  test("registers a new session as active", async () => {
    const m = await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    expect(m.status).toBe("active");
    expect(await isMember("s1")).toBe(true);
    expect(await getMembership("s1")).toEqual(m);
  });

  test("re-registering preserves joined_at but bumps last_seen", async () => {
    const first = await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    expect(second.joined_at).toBe(first.joined_at);
    expect(second.last_seen).toBeGreaterThanOrEqual(first.last_seen);
  });

  test("isMember is false for unknown session", async () => {
    expect(await isMember("nope")).toBe(false);
  });

  test("re-registering an ended session reactivates it to active", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    const reactivated = await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    expect(reactivated.status).toBe("active");
    expect(await getMembership("s1")).toEqual(reactivated);
  });

  test("re-registering an ended session under a NEW group actually moves it, not just reactivates the old group", async () => {
    const first = await registerSession({ sessionId: "s1", group: "alpha", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    const rejoined = await registerSession({ sessionId: "s1", group: "beta", cwd: "/repo/a", repo: "a" });
    expect(rejoined.group).toBe("beta");
    expect(rejoined.status).toBe("active");
    expect(rejoined.joined_at).toBe(first.joined_at); // joined_at is still preserved
  });
});

describe("heartbeat", () => {
  test("bumps last_seen for an existing session", async () => {
    const m = await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await heartbeat("s1");
    const updated = await getMembership("s1");
    expect(updated!.last_seen).toBeGreaterThan(m.last_seen);
  });

  test("is a no-op for a session that was never registered", async () => {
    await heartbeat("ghost");
    expect(await getMembership("ghost")).toBeUndefined();
  });
});

describe("endSession", () => {
  test("marks status ended", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    const m = await getMembership("s1");
    expect(m!.status).toBe("ended");
  });
});

describe("listMemberships / resolveByCwd", () => {
  test("lists all registered sessions", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await registerSession({ sessionId: "s2", group: "demo", cwd: "/repo/b", repo: "b" });
    const all = await listMemberships();
    expect(all.map((m) => m.session_id).sort()).toEqual(["s1", "s2"]);
  });

  test("resolveByCwd picks the most recently active session for that cwd", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await registerSession({ sessionId: "s2", group: "demo", cwd: "/repo/a", repo: "a" });

    const resolved = await resolveByCwd("/repo/a");
    expect(resolved!.session_id).toBe("s2");
  });

  test("resolveByCwd returns undefined when no session matches", async () => {
    expect(await resolveByCwd("/nowhere")).toBeUndefined();
  });

  test("resolveByCwd can filter by group", async () => {
    await registerSession({ sessionId: "s1", group: "alpha", cwd: "/repo/a", repo: "a" });
    await registerSession({ sessionId: "s2", group: "beta", cwd: "/repo/a", repo: "a" });
    const resolved = await resolveByCwd("/repo/a", "alpha");
    expect(resolved!.session_id).toBe("s1");
  });

  test("resolveByCwd prefers an active session even when an ended session has a more recent last_seen", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await registerSession({ sessionId: "s2", group: "demo", cwd: "/repo/a", repo: "a" });
    // s2 "leaves" after both were registered, so its last_seen is now the most recent —
    // but it's no longer the session anyone should be operating on.
    await endSession("s2");

    const resolved = await resolveByCwd("/repo/a");
    expect(resolved!.session_id).toBe("s1");
  });

  test("resolveByCwd falls back to the most recent match of any status when none are active", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    const resolved = await resolveByCwd("/repo/a");
    expect(resolved!.session_id).toBe("s1");
  });
});
