import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildGroupDigest } from "../src/daemon/digest-writer";
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
