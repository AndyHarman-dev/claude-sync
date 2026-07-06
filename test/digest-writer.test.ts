import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildGroupDigest, withGroupDigestLock } from "../src/daemon/digest-writer";
import { registerSession } from "../src/lib/registry";
import { writeJsonAtomic, readJson } from "../src/lib/atomic";
import { paths } from "../src/lib/paths";
import type { Digest, Recap } from "../src/lib/types";
import { emptyRecapBody } from "../src/lib/types";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-digest-writer-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

async function writeRecap(group: string, sessionId: string, focus: string) {
  const recap: Recap = { v: 1, session_id: sessionId, updated_at: Date.now(), journal_offset: 100, recap: { ...emptyRecapBody(), focus } };
  await writeJsonAtomic(paths.recapFile(group, sessionId), recap);
}

describe("rebuildGroupDigest", () => {
  test("builds a fresh digest at version 1 from registry + recaps and persists it", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await writeRecap("demo", "s1", "doing setup");

    const digest = await rebuildGroupDigest("demo");
    expect(digest.version).toBe(1);
    expect(digest.sessions.s1?.recap.focus).toBe("doing setup");

    const onDisk = await readJson<Digest>(paths.digestFile("demo"));
    expect(onDisk?.version).toBe(1);
  });

  test("a no-op rebuild does not rewrite the file on disk", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await writeRecap("demo", "s1", "doing setup");
    const first = await rebuildGroupDigest("demo");
    const onDiskAfterFirst = await readJson<Digest>(paths.digestFile("demo"));

    const second = await rebuildGroupDigest("demo");
    expect(second.version).toBe(first.version);
    // The in-memory buildDigest result always carries a fresh updated_at, but the file on
    // disk should be untouched by a no-op rebuild — that's the real "no rewrite" guarantee.
    const onDiskAfterSecond = await readJson<Digest>(paths.digestFile("demo"));
    expect(onDiskAfterSecond?.updated_at).toBe(onDiskAfterFirst!.updated_at);
  });

  test("a recap update bumps the version on rebuild", async () => {
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await writeRecap("demo", "s1", "doing setup");
    const first = await rebuildGroupDigest("demo");

    await writeRecap("demo", "s1", "shipping the feature");
    const second = await rebuildGroupDigest("demo");
    expect(second.version).toBe(first.version + 1);
    expect(second.sessions.s1?.recap.focus).toBe("shipping the feature");
  });

  test("only sessions in the requested group are included", async () => {
    await registerSession({ sessionId: "s1", group: "alpha", cwd: "/repo/a", repo: "a" });
    await registerSession({ sessionId: "s2", group: "beta", cwd: "/repo/b", repo: "b" });
    const digest = await rebuildGroupDigest("alpha");
    expect(Object.keys(digest.sessions)).toEqual(["s1"]);
  });

  test("a group with no sessions yet produces an empty digest without throwing", async () => {
    const digest = await rebuildGroupDigest("nonexistent");
    expect(digest.sessions).toEqual({});
  });
});

describe("withGroupDigestLock", () => {
  test("serializes overlapping calls for the same group — no interleaving", async () => {
    const order: string[] = [];
    const first = withGroupDigestLock("demo", async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("first-end");
    });
    const second = withGroupDigestLock("demo", async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  test("calls for different groups do not block each other", async () => {
    const order: string[] = [];
    const slow = withGroupDigestLock("alpha", async () => {
      order.push("alpha-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("alpha-end");
    });
    const fast = withGroupDigestLock("beta", async () => {
      order.push("beta");
    });
    await Promise.all([slow, fast]);
    // beta must not have been forced to wait behind alpha's slow critical section.
    expect(order.indexOf("beta")).toBeLessThan(order.indexOf("alpha-end"));
  });

  test("a rejection in one critical section does not wedge the lock for the next caller", async () => {
    await expect(
      withGroupDigestLock("demo", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await withGroupDigestLock("demo", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("regression: a concurrent rebuild cannot revert a history fold when both go through the shared lock", async () => {
    // Mirrors the real race: eviction reads/folds/writes history for a group while a
    // summarizer-triggered rebuild for the SAME group is also in flight and happens to be
    // slower to finish its own write. Without serializing both through the same lock, the
    // rebuild could read the pre-fold digest and write its result back AFTER eviction's
    // write, silently reverting the just-folded history — which is exactly what happens if
    // either critical section below is changed to bypass withGroupDigestLock.
    await registerSession({ sessionId: "s1", group: "demo", cwd: "/repo/a", repo: "a" });
    await writeRecap("demo", "s1", "doing setup");
    await rebuildGroupDigest("demo"); // establishes an initial digest with history: ""

    const evictionFold = withGroupDigestLock("demo", async () => {
      const digest = await readJson<Digest>(paths.digestFile("demo"));
      await writeJsonAtomic(paths.digestFile("demo"), { ...digest!, history: "s1: finished the migration" });
    });
    const concurrentRebuild = withGroupDigestLock("demo", async () => {
      const digest = await readJson<Digest>(paths.digestFile("demo"));
      await new Promise((r) => setTimeout(r, 15)); // this side is slower to finish
      await writeJsonAtomic(paths.digestFile("demo"), { ...digest!, version: digest!.version + 1 });
    });

    await Promise.all([evictionFold, concurrentRebuild]);

    const final = await readJson<Digest>(paths.digestFile("demo"));
    expect(final!.history).toBe("s1: finished the migration");
  });
});
