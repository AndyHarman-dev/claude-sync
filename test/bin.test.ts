import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BIN_CLAUDE_SYNC = join(REPO_ROOT, "bin", "claude-sync");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-bin-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runBin(args: string[]) {
  const proc = Bun.spawn({
    cmd: [BIN_CLAUDE_SYNC, ...args],
    env: { ...process.env, CLAUDE_SYNC_DATA_DIR: dir } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("bin/claude-sync (real subprocess, not an in-process import)", () => {
  // Regression test: cli.ts guards its own CLI dispatch behind `if (import.meta.main)`,
  // which is only true when cli.ts itself is the process entry point. bin/claude-sync used
  // to just `import "../src/cli.ts"` — that makes cli.ts a module being imported, not the
  // entry point, so import.meta.main is false there and main() never ran. The wrapper
  // silently produced zero output and exit code 0 for every subcommand, which every
  // in-process test (calling `main()` directly) was blind to since it doesn't go through
  // this actual entry file the way a real installed `claude-sync` binary does.
  test("status subcommand actually runs and prints output through the real bin entrypoint", async () => {
    const { stdout, exitCode } = await runBin(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Daemon:");
  });

  test("an unknown subcommand prints usage and exits non-zero", async () => {
    const { stdout, exitCode } = await runBin(["bogus"]);
    expect(stdout).toContain("usage:");
    expect(exitCode).toBe(2);
  });
});
