import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGroups, findDirtySessionsInGroup, findAllDirtySessions } from "../src/daemon/poller";
import { appendJournal } from "../src/lib/journal";
import { writeJsonAtomic } from "../src/lib/atomic";
import { paths } from "../src/lib/paths";
import { emptyRecapBody } from "../src/lib/types";
import type { Recap } from "../src/lib/types";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-poller-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("listGroups / findDirtySessionsInGroup / findAllDirtySessions", () => {
  test("no groups directory yet => empty results, no throw", async () => {
    expect(await listGroups()).toEqual([]);
    expect(await findAllDirtySessions()).toEqual([]);
  });

  test("a session with a journal but no recap yet is dirty", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    expect(await listGroups()).toEqual(["demo"]);
    expect(await findDirtySessionsInGroup("demo")).toEqual(["s1"]);
  });

  test("a session whose recap has consumed the full journal is not dirty", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    const size = Bun.file(paths.journalFile("demo", "s1")).size;
    const recap: Recap = { v: 1, session_id: "s1", updated_at: Date.now(), journal_offset: size, recap: emptyRecapBody() };
    await writeJsonAtomic(paths.recapFile("demo", "s1"), recap);

    expect(await findDirtySessionsInGroup("demo")).toEqual([]);
  });

  test("further journal growth past the last consumed offset makes it dirty again", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    const size = Bun.file(paths.journalFile("demo", "s1")).size;
    const recap: Recap = { v: 1, session_id: "s1", updated_at: Date.now(), journal_offset: size, recap: emptyRecapBody() };
    await writeJsonAtomic(paths.recapFile("demo", "s1"), recap);

    await appendJournal("demo", "s1", { v: 1, t: 2, e: "end" });
    expect(await findDirtySessionsInGroup("demo")).toEqual(["s1"]);
  });

  test("findAllDirtySessions spans multiple groups", async () => {
    await appendJournal("alpha", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    await appendJournal("beta", "s2", { v: 1, t: 1, e: "start", cwd: "/repo/b", repo: "b" });
    const all = await findAllDirtySessions();
    expect(all.sort((a, b) => a.group.localeCompare(b.group))).toEqual([
      { group: "alpha", sessionId: "s1" },
      { group: "beta", sessionId: "s2" },
    ]);
  });
});
