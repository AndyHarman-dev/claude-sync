import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeJsonAtomic,
  readJson,
  appendLine,
  createExclusive,
  removeIfExists,
  fileExists,
} from "../src/lib/atomic";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic / readJson", () => {
  test("round-trips data and leaves no tmp files behind", async () => {
    const path = join(dir, "nested", "file.json");
    await writeJsonAtomic(path, { a: 1, b: "two" });
    const result = await readJson<{ a: number; b: string }>(path);
    expect(result).toEqual({ a: 1, b: "two" });

    const entries = await readdir(join(dir, "nested"));
    expect(entries).toEqual(["file.json"]);
  });

  test("second write fully replaces the first (no partial merge)", async () => {
    const path = join(dir, "file.json");
    await writeJsonAtomic(path, { version: 1 });
    await writeJsonAtomic(path, { version: 2 });
    const result = await readJson<{ version: number }>(path);
    expect(result).toEqual({ version: 2 });
  });

  test("readJson returns undefined for missing file", async () => {
    const result = await readJson(join(dir, "nope.json"));
    expect(result).toBeUndefined();
  });

  test("readJson returns undefined for malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await Bun.write(path, "{not json");
    const result = await readJson(path);
    expect(result).toBeUndefined();
  });
});

describe("appendLine", () => {
  test("creates file and appends newline-terminated lines", async () => {
    const path = join(dir, "journal", "a.jsonl");
    await appendLine(path, JSON.stringify({ e: "one" }));
    await appendLine(path, JSON.stringify({ e: "two" }));
    const text = await Bun.file(path).text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ e: "one" });
    expect(JSON.parse(lines[1])).toEqual({ e: "two" });
  });
});

describe("createExclusive", () => {
  test("first call succeeds, second call for same path fails", async () => {
    const path = join(dir, "lock.pid");
    const first = await createExclusive(path, "123");
    const second = await createExclusive(path, "456");
    expect(first).toBe(true);
    expect(second).toBe(false);
    const contents = await Bun.file(path).text();
    expect(contents).toBe("123");
  });
});

describe("removeIfExists / fileExists", () => {
  test("removes existing file and is a no-op for missing file", async () => {
    const path = join(dir, "x.json");
    await writeJsonAtomic(path, { x: 1 });
    expect(await fileExists(path)).toBe(true);
    await removeIfExists(path);
    expect(await fileExists(path)).toBe(false);
    await expect(removeIfExists(path)).resolves.toBeUndefined();
  });
});
