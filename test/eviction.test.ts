import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldHistoryEntry,
  isEvictable,
  runTombstoneEviction,
  runOrphanFileGC,
  backdateFile,
  TOMBSTONE_GRACE_MS,
  CRASHED_TIMEOUT_MS,
  ORPHAN_FILE_GC_MS,
} from "../src/daemon/eviction";
import { registerSession, endSession, getMembership, listMemberships } from "../src/lib/registry";
import { appendJournal } from "../src/lib/journal";
import { writeJsonAtomic, readJson, fileExists } from "../src/lib/atomic";
import { rebuildGroupDigest } from "../src/daemon/digest-writer";
import { paths } from "../src/lib/paths";
import { CAPS, emptyRecapBody } from "../src/lib/types";
import type { Recap, Digest } from "../src/lib/types";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-eviction-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("foldHistoryEntry (pure)", () => {
  test("summarizes focus + recent into a labeled entry", () => {
    const recap: Recap = {
      v: 1,
      session_id: "sess-aaa111",
      updated_at: 1,
      journal_offset: 1,
      recap: { focus: "shipped the auth rewrite", recent: [{ repo: "a", summary: "rewrote middleware.ts" }], problems: [] },
    };
    const folded = foldHistoryEntry("", "sess-aaa111", recap);
    expect(folded).toContain("sess-aaa");
    expect(folded).toContain("shipped the auth rewrite");
    expect(folded).toContain("rewrote middleware.ts");
  });

  test("appends to existing history rather than replacing it", () => {
    const first = foldHistoryEntry("", "s1", { v: 1, session_id: "s1", updated_at: 1, journal_offset: 1, recap: { focus: "did X", recent: [], problems: [] } });
    const second = foldHistoryEntry(first, "s2", { v: 1, session_id: "s2", updated_at: 1, journal_offset: 1, recap: { focus: "did Y", recent: [], problems: [] } });
    expect(second).toContain("did X");
    expect(second).toContain("did Y");
  });

  test("handles an undefined recap (session departed with no summary ever produced)", () => {
    const folded = foldHistoryEntry("", "s1", undefined);
    expect(folded).toContain("no recorded activity");
  });

  test("clamps to CAPS.historyMax, keeping the newest entry rather than truncating it away", () => {
    const longPrev = "x".repeat(CAPS.historyMax);
    const folded = foldHistoryEntry(longPrev, "s1", { v: 1, session_id: "s1", updated_at: 1, journal_offset: 1, recap: { focus: "the newest event", recent: [], problems: [] } });
    expect(folded.length).toBe(CAPS.historyMax);
    // the tail (newest entry) survived the clamp — a "keep the head, drop the tail" bug
    // would truncate the string at historyMax and cut this entry off entirely.
    expect(folded.endsWith("the newest event")).toBe(true);
  });
});

describe("isEvictable", () => {
  const base = { v: 1 as const, group: "demo", cwd: "/repo/a", repo: "a", joined_at: 0 };

  test("an ended session is evictable only after the tombstone grace period", () => {
    const now = 1_000_000;
    const justEnded = { ...base, session_id: "s1", status: "ended" as const, last_seen: now - 1000 };
    const longEnded = { ...base, session_id: "s2", status: "ended" as const, last_seen: now - TOMBSTONE_GRACE_MS - 1 };
    expect(isEvictable(justEnded, now)).toBe(false);
    expect(isEvictable(longEnded, now)).toBe(true);
  });

  test("an active session is evictable only after the crashed-timeout window", () => {
    const now = 1_000_000;
    const recentlyActive = { ...base, session_id: "s1", status: "active" as const, last_seen: now - 1000 };
    const staleActive = { ...base, session_id: "s2", status: "active" as const, last_seen: now - CRASHED_TIMEOUT_MS - 1 };
    expect(isEvictable(recentlyActive, now)).toBe(false);
    expect(isEvictable(staleActive, now)).toBe(true);
  });
});

describe("runTombstoneEviction (integration)", () => {
  test("ending every session in a group does NOT remove the group's digest or history", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    const recap: Recap = { v: 1, session_id: "s1", updated_at: 1, journal_offset: 10, recap: { ...emptyRecapBody(), focus: "finished the migration" } };
    await writeJsonAtomic(paths.recapFile("demo", "s1"), recap);
    await rebuildGroupDigest("demo");
    await endSession("s1");

    const now = Date.now() + TOMBSTONE_GRACE_MS + 1000;
    await runTombstoneEviction(now);

    // the session is gone from membership and from the digest...
    expect(await getMembership("s1")).toBeUndefined();
    const digest = await readJson<Digest>(paths.digestFile("demo"));
    expect(digest!.sessions.s1).toBeUndefined();

    // ...but the group's digest file and history persist.
    expect(digest).toBeDefined();
    expect(digest!.history).toContain("finished the migration");
  });

  test("a still-active session in the same group is untouched", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await registerSession({ sessionId: "s2", group: "demo", cwd: "/repo/b", repo: "b" });
    await rebuildGroupDigest("demo");
    await endSession("s1");

    const now = Date.now() + TOMBSTONE_GRACE_MS + 1000;
    await runTombstoneEviction(now);

    expect(await getMembership("s1")).toBeUndefined();
    expect(await getMembership("s2")).toBeDefined();
    const digest = await readJson<Digest>(paths.digestFile("demo"));
    expect(digest!.sessions.s2).toBeDefined();
    expect(digest!.sessions.s1).toBeUndefined();
  });

  test("a crashed session (active, silent past the crash timeout, no SessionEnd) is also evicted", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await rebuildGroupDigest("demo");

    const now = Date.now() + CRASHED_TIMEOUT_MS + 1000;
    await runTombstoneEviction(now);

    expect(await getMembership("s1")).toBeUndefined();
    const digest = await readJson<Digest>(paths.digestFile("demo"));
    expect(digest!.sessions.s1).toBeUndefined();
  });

  test("does nothing when no session qualifies yet", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await endSession("s1");
    await runTombstoneEviction(Date.now());
    expect(await getMembership("s1")).toBeDefined();
  });
});

describe("runOrphanFileGC (integration)", () => {
  test("deletes journal/recap/cursor for a session with no membership past the GC window", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    await writeJsonAtomic(paths.recapFile("demo", "s1"), { v: 1, session_id: "s1", updated_at: 1, journal_offset: 1, recap: emptyRecapBody() });
    await writeJsonAtomic(paths.cursorFile("demo", "s1"), { v: 1, digest_version: 1, updated_at: 1 });
    await backdateFile(paths.journalFile("demo", "s1"), ORPHAN_FILE_GC_MS + 1000);

    await runOrphanFileGC(Date.now());

    expect(await fileExists(paths.journalFile("demo", "s1"))).toBe(false);
    expect(await fileExists(paths.recapFile("demo", "s1"))).toBe(false);
    expect(await fileExists(paths.cursorFile("demo", "s1"))).toBe(false);
  });

  test("leaves files alone if the session still has an active membership", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    await backdateFile(paths.journalFile("demo", "s1"), ORPHAN_FILE_GC_MS + 1000);

    await runOrphanFileGC(Date.now());

    expect(await fileExists(paths.journalFile("demo", "s1"))).toBe(true);
  });

  test("leaves orphaned files alone before the GC window has elapsed", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    await runOrphanFileGC(Date.now());
    expect(await fileExists(paths.journalFile("demo", "s1"))).toBe(true);
  });
});
