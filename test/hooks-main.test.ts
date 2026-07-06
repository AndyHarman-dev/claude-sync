import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/lib/paths";
import { readJournalFrom } from "../src/lib/journal";
import { getMembership } from "../src/lib/registry";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_ENTRY = join(REPO_ROOT, "src", "hooks", "main.ts");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "hook-payloads");

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-hooks-"));
  // The subprocess gets CLAUDE_SYNC_DATA_DIR via its own env override, but assertions in
  // this test process read through the same `paths`/`registry`/`journal` modules, so this
  // process needs to point at the same sandbox too.
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

async function runHook(fixtureName: string, env: Record<string, string | undefined>) {
  const stdin = await Bun.file(join(FIXTURES, fixtureName)).text();
  const merged: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  // Never let a test's SessionStart fixture fork a real daemon against a throwaway sandbox.
  merged.CLAUDE_SYNC_SKIP_DAEMON_ENSURE = "1";
  const start = performance.now();
  const proc = Bun.spawn({
    cmd: ["bun", HOOK_ENTRY],
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: merged,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const elapsedMs = performance.now() - start;
  return { stdout, stderr, exitCode, elapsedMs };
}

describe("hooks/main.ts — synced session (CLAUDE_SYNC_GROUP set)", () => {
  test("SessionStart registers membership and journals a start event", async () => {
    const result = await runHook("session-start.json", { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);

    const membership = await getMembership("sess-aaa111");
    expect(membership).toBeDefined();
    expect(membership!.group).toBe("demo");
    expect(membership!.status).toBe("active");

    const { lines } = await readJournalFrom("demo", "sess-aaa111", 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].e).toBe("start");
  });

  test("full session lifecycle journals start, prompt, tool x2, end", async () => {
    const env = { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir };
    await runHook("session-start.json", env);
    await runHook("user-prompt-submit.json", env);
    await runHook("post-tool-use-edit.json", env);
    await runHook("post-tool-use-bash.json", env);
    await runHook("session-end.json", env);

    const { lines } = await readJournalFrom("demo", "sess-aaa111", 0);
    expect(lines.map((l) => l.e)).toEqual(["start", "prompt", "tool", "tool", "end"]);

    const promptLine = lines[1] as any;
    expect(promptLine.text).toContain("JWT refresh tokens");

    const editLine = lines[2] as any;
    expect(editLine.tool).toBe("Edit");
    expect(editLine.file).toBe("src/auth/middleware.ts");

    const bashLine = lines[3] as any;
    expect(bashLine.tool).toBe("Bash");
    expect(bashLine.cmd).toBe("bun test");

    const membership = await getMembership("sess-aaa111");
    expect(membership!.status).toBe("ended");
  });
});

describe("hooks/main.ts — plain session (no env, not a member)", () => {
  test("exits 0 with no output and creates no files, quickly", async () => {
    const result = await runHook("post-tool-use-edit.json", { CLAUDE_SYNC_GROUP: undefined, CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // Nothing should have been created under the sandboxed data dir.
    const exists = await Bun.file(join(dir, "sessions", "sess-aaa111.json")).exists();
    expect(exists).toBe(false);

    // Generous CI-safe ceiling; local runs are typically well under this.
    expect(result.elapsedMs).toBeLessThan(1500);
  });

  test("SessionEnd for an unknown session is also a silent no-op", async () => {
    const result = await runHook("session-end.json", { CLAUDE_SYNC_GROUP: undefined, CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("hooks/main.ts — join via pending-joins bridge", () => {
  test("SessionStart claims a fresh pending join and starts journaling", async () => {
    const { writeJsonAtomic } = await import("../src/lib/atomic");
    await writeJsonAtomic(paths.pendingJoinFile("/tmp/claude-sync-fixture-repo"), {
      v: 1,
      group: "joined-group",
      created_at: Date.now(),
    });

    const result = await runHook("session-start.json", { CLAUDE_SYNC_GROUP: undefined, CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);

    const membership = await getMembership("sess-aaa111");
    expect(membership!.group).toBe("joined-group");
  });
});
