import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, journalSize, readJournalFrom } from "../src/lib/journal";
import { paths } from "../src/lib/paths";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-journal-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("appendJournal / readJournalFrom", () => {
  test("reads back appended lines from offset 0", async () => {
    await appendJournal("demo", "sess-1", { v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });
    await appendJournal("demo", "sess-1", { v: 1, t: 2, e: "prompt", text: "hello" });

    const { lines, newOffset } = await readJournalFrom("demo", "sess-1", 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });
    expect(lines[1]).toEqual({ v: 1, t: 2, e: "prompt", text: "hello" });

    const size = await journalSize("demo", "sess-1");
    expect(newOffset).toBe(size);
  });

  test("second read from the returned offset yields only new lines", async () => {
    await appendJournal("demo", "sess-1", { v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });
    const first = await readJournalFrom("demo", "sess-1", 0);
    expect(first.lines).toHaveLength(1);

    await appendJournal("demo", "sess-1", { v: 1, t: 2, e: "end" });
    const second = await readJournalFrom("demo", "sess-1", first.newOffset);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toEqual({ v: 1, t: 2, e: "end" });
  });

  test("a partial (torn) trailing line is not returned and offset does not advance past it", async () => {
    await appendJournal("demo", "sess-1", { v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });
    // Simulate a writer mid-append: a line with no trailing newline yet.
    await appendFile(paths.journalFile("demo", "sess-1"), '{"v":1,"t":2,"e":"end"');

    const { lines, newOffset } = await readJournalFrom("demo", "sess-1", 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });

    // Now the writer finishes the line.
    await appendFile(paths.journalFile("demo", "sess-1"), "}\n");
    const followUp = await readJournalFrom("demo", "sess-1", newOffset);
    expect(followUp.lines).toHaveLength(1);
    expect(followUp.lines[0]).toEqual({ v: 1, t: 2, e: "end" });
  });

  test("malformed complete lines are skipped, not fatal", async () => {
    await appendJournal("demo", "sess-1", { v: 1, t: 1, e: "start", cwd: "/x", repo: "x" });
    await appendFile(paths.journalFile("demo", "sess-1"), "not json at all\n");
    await appendJournal("demo", "sess-1", { v: 1, t: 3, e: "end" });

    const { lines } = await readJournalFrom("demo", "sess-1", 0);
    expect(lines).toHaveLength(2);
    expect(lines[0].e).toBe("start");
    expect(lines[1].e).toBe("end");
  });

  test("journalSize is 0 for a session with no journal yet", async () => {
    const size = await journalSize("demo", "no-such-session");
    expect(size).toBe(0);
  });
});
