import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  parseRecapResponse,
  isNoteOnlyBatch,
  processSession,
  SummarizerQueue,
} from "../src/daemon/summarizer";
import { appendJournal } from "../src/lib/journal";
import { readJson } from "../src/lib/atomic";
import { paths } from "../src/lib/paths";
import type { Recap } from "../src/lib/types";

describe("buildPrompt (pure)", () => {
  test("includes repo/cwd, previous recap JSON, and rendered events", () => {
    const prompt = buildPrompt({
      repo: "api-server",
      cwd: "/repo/api-server",
      prevRecap: { focus: "old focus", recent: [], problems: [] },
      deltaLines: [
        { v: 1, t: 1, e: "prompt", text: "add refresh tokens" },
        { v: 1, t: 2, e: "tool", tool: "Edit", file: "src/auth.ts" },
      ],
    });
    expect(prompt).toContain("api-server");
    expect(prompt).toContain('"focus":"old focus"');
    expect(prompt).toContain("[prompt] add refresh tokens");
    expect(prompt).toContain("[tool] Edit src/auth.ts");
  });

  test("uses 'none' for a first-ever recap", () => {
    const prompt = buildPrompt({ repo: "r", cwd: "/r", prevRecap: undefined, deltaLines: [] });
    expect(prompt).toContain("PREVIOUS RECAP:\nnone");
  });
});

describe("parseRecapResponse (tolerant extraction)", () => {
  test("parses a clean JSON object", () => {
    const body = parseRecapResponse('{"focus":"x","recent":[{"repo":"a","summary":"did stuff"}],"problems":["flaky test"]}');
    expect(body).toEqual({ focus: "x", recent: [{ repo: "a", summary: "did stuff", files: undefined }], problems: ["flaky test"] });
  });

  test("extracts JSON embedded in prose/code fences", () => {
    const raw = 'Sure, here you go:\n```json\n{"focus":"y","recent":[],"problems":[]}\n```\nHope that helps!';
    const body = parseRecapResponse(raw);
    expect(body?.focus).toBe("y");
  });

  test("returns undefined for non-JSON garbage", () => {
    expect(parseRecapResponse("I refuse to comply")).toBeUndefined();
  });

  test("clamps oversized fields", () => {
    const longFocus = "x".repeat(500);
    const body = parseRecapResponse(JSON.stringify({ focus: longFocus, recent: [], problems: [] }));
    expect(body!.focus.length).toBe(240);
  });
});

describe("isNoteOnlyBatch", () => {
  test("true only when every line is a note", () => {
    expect(isNoteOnlyBatch([{ v: 1, t: 1, e: "note", text: "hi" }])).toBe(true);
    expect(isNoteOnlyBatch([{ v: 1, t: 1, e: "note", text: "hi" }, { v: 1, t: 2, e: "prompt", text: "x" }])).toBe(false);
    expect(isNoteOnlyBatch([])).toBe(false);
  });
});

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-summarizer-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("processSession", () => {
  test("note-only batch bypasses the backend and pins the note verbatim", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "note", text: "don't touch schema.sql" });
    let backendCalled = false;
    const result = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => {
        backendCalled = true;
        return "{}";
      },
    });
    expect(result.ok).toBe(true);
    expect(backendCalled).toBe(false);
    expect(result.recap?.recap.pinned).toBe("don't touch schema.sql");
  });

  test("mixed batch (note + other events) goes through the backend", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "do the thing" });
    await appendJournal("demo", "s1", { v: 1, t: 2, e: "note", text: "heads up" });
    const result = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => JSON.stringify({ focus: "doing the thing", recent: [], problems: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.recap?.recap.focus).toBe("doing the thing");
  });

  test("a previously pinned note survives a later mixed-batch LLM summarization instead of being silently erased", async () => {
    // First: a pure-note batch pins a note via the fast path.
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "note", text: "don't touch schema.sql" });
    const pinned = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => {
        throw new Error("fast path should not call the backend");
      },
    });
    expect(pinned.recap?.recap.pinned).toBe("don't touch schema.sql");

    // Then: a mixed batch (any non-note event) goes through the LLM path, whose schema
    // never includes `pinned` — it must not vanish as a result.
    await appendJournal("demo", "s1", { v: 1, t: 2, e: "prompt", text: "keep working" });
    const summarized = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => JSON.stringify({ focus: "still working", recent: [], problems: [] }),
    });
    expect(summarized.ok).toBe(true);
    expect(summarized.recap?.recap.focus).toBe("still working");
    expect(summarized.recap?.recap.pinned).toBe("don't touch schema.sql");
  });

  test("no new journal lines is a skipped success, recap untouched", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "start", cwd: "/repo/a", repo: "a" });
    const first = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => JSON.stringify({ focus: "f", recent: [], problems: [] }),
    });
    expect(first.ok).toBe(true);

    const second = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => {
        throw new Error("should not be called");
      },
    });
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
  });

  test("backend failure leaves the recap file and offset untouched", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    const result = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    const recap = await readJson<Recap>(paths.recapFile("demo", "s1"));
    expect(recap).toBeUndefined();
  });

  test("unparsable backend output also leaves the recap untouched", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    const result = await processSession({
      group: "demo",
      sessionId: "s1",
      repo: "a",
      cwd: "/repo/a",
      backend: async () => "not json",
    });
    expect(result.ok).toBe(false);
    const recap = await readJson<Recap>(paths.recapFile("demo", "s1"));
    expect(recap).toBeUndefined();
  });
});

describe("SummarizerQueue", () => {
  test("succeeds on first attempt and fires onDigestDirty once", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    let dirtyCount = 0;
    const queue = new SummarizerQueue({
      backend: async () => JSON.stringify({ focus: "ok", recent: [], problems: [] }),
      onDigestDirty: () => dirtyCount++,
    });
    await queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    expect(dirtyCount).toBe(1);
    const recap = await readJson<Recap>(paths.recapFile("demo", "s1"));
    expect(recap?.recap.focus).toBe("ok");
  });

  test("retries after failure and eventually succeeds, using injected short backoff", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    let calls = 0;
    const queue = new SummarizerQueue({
      backoffMs: [1, 1],
      backend: async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return JSON.stringify({ focus: "recovered", recent: [], problems: [] });
      },
    });
    await queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    expect(calls).toBe(2);
    const recap = await readJson<Recap>(paths.recapFile("demo", "s1"));
    expect(recap?.recap.focus).toBe("recovered");
  });

  test("exhausting all retries leaves the digest untouched and enters cooldown", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    let calls = 0;
    let dirtyCount = 0;
    const queue = new SummarizerQueue({
      backoffMs: [1, 1],
      cooldownMs: 60_000,
      backend: async () => {
        calls++;
        throw new Error("model unavailable");
      },
      onDigestDirty: () => dirtyCount++,
    });
    await queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    expect(calls).toBe(3); // initial attempt + 2 retries
    expect(dirtyCount).toBe(0);
    const recap = await readJson<Recap>(paths.recapFile("demo", "s1"));
    expect(recap).toBeUndefined();

    // still within cooldown: re-enqueueing the same session does not call the backend again
    await queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    expect(calls).toBe(3);
  });

  test("duplicate enqueue for an already-queued session is a no-op", async () => {
    await appendJournal("demo", "s1", { v: 1, t: 1, e: "prompt", text: "x" });
    let calls = 0;
    const queue = new SummarizerQueue({
      backoffMs: [],
      backend: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return JSON.stringify({ focus: "f", recent: [], problems: [] });
      },
    });
    const p1 = queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    const p2 = queue.enqueue({ group: "demo", sessionId: "s1", repo: "a", cwd: "/repo/a" });
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
