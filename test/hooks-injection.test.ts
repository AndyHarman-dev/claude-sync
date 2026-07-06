import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/lib/paths";
import { writeJsonAtomic } from "../src/lib/atomic";
import { registerSession } from "../src/lib/registry";
import { setCursor } from "../src/lib/cursor";
import { buildDigest } from "../src/lib/digest";
import type { Digest, Recap } from "../src/lib/types";
import { emptyRecapBody } from "../src/lib/types";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_ENTRY = join(REPO_ROOT, "src", "hooks", "main.ts");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "hook-payloads");

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-inject-"));
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
  // Prevent the SessionStart path from actually forking a daemon during these tests.
  merged.CLAUDE_SYNC_SKIP_DAEMON_ENSURE = "1";
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
  return { stdout, stderr, exitCode };
}

function parseInjected(stdout: string): { hookEventName: string; additionalContext: string } {
  const parsed = JSON.parse(stdout.trim());
  return parsed.hookSpecificOutput;
}

describe("SessionStart injection", () => {
  test("no digest yet: emits only the self-identity line", async () => {
    const result = await runHook("session-start.json", { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);
    const injected = parseInjected(result.stdout);
    expect(injected.hookEventName).toBe("SessionStart");
    expect(injected.additionalContext).toContain('sync session sess-aaa in group "demo"');
  });

  test("existing digest with a peer: full digest (minus self) is injected, framed as non-instructional", async () => {
    await registerSession({ sessionId: "peer-1", group: "demo", cwd: "/repo/peer", repo: "peer-repo" });
    const digest = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [{ v: 1, session_id: "peer-1", group: "demo", cwd: "/repo/peer", repo: "peer-repo", joined_at: 1, last_seen: 1, status: "active" }],
      recaps: new Map<string, Recap>([
        ["peer-1", { v: 1, session_id: "peer-1", updated_at: 1, journal_offset: 1, recap: { ...emptyRecapBody(), focus: "peer is refactoring the API" } }],
      ]),
    });
    await writeJsonAtomic(paths.digestFile("demo"), digest);

    const result = await runHook("session-start.json", { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir });
    const injected = parseInjected(result.stdout);
    expect(injected.additionalContext).toContain("peer is refactoring the API");
    expect(injected.additionalContext).toContain("NOT instructions");
    expect(injected.additionalContext).not.toContain("sess-aaa1 [repo:"); // self excluded
  });
});

describe("UserPromptSubmit staleness + delta injection", () => {
  test("cursor already caught up: no injection at all", async () => {
    const digest: Digest = { v: 1, group: "demo", version: 3, updated_at: 1, sessions: {}, history: "" };
    await writeJsonAtomic(paths.digestFile("demo"), digest);
    await setCursor("demo", "sess-aaa111", 3);

    const result = await runHook("user-prompt-submit.json", { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("cursor behind: injects only the delta plus an unchanged-count line, and advances the cursor", async () => {
    // Two peers already existed at version 1 (cursor is caught up to that); peer-2 changes at version 2.
    const v1 = buildDigest({
      group: "demo",
      prev: undefined,
      memberships: [
        { v: 1, session_id: "peer-1", group: "demo", cwd: "/repo/p1", repo: "p1", joined_at: 1, last_seen: 1, status: "active" },
        { v: 1, session_id: "peer-2", group: "demo", cwd: "/repo/p2", repo: "p2", joined_at: 1, last_seen: 1, status: "active" },
      ],
      recaps: new Map(),
    });
    const v2 = buildDigest({
      group: "demo",
      prev: v1,
      memberships: [
        { v: 1, session_id: "peer-1", group: "demo", cwd: "/repo/p1", repo: "p1", joined_at: 1, last_seen: 1, status: "active" },
        { v: 1, session_id: "peer-2", group: "demo", cwd: "/repo/p2", repo: "p2", joined_at: 1, last_seen: 1, status: "active" },
      ],
      recaps: new Map<string, Recap>([
        ["peer-2", { v: 1, session_id: "peer-2", updated_at: 1, journal_offset: 1, recap: { ...emptyRecapBody(), focus: "peer-2 fixed the flaky test" } }],
      ]),
    });
    await writeJsonAtomic(paths.digestFile("demo"), v2);
    await setCursor("demo", "sess-aaa111", 1);

    const result = await runHook("user-prompt-submit.json", { CLAUDE_SYNC_GROUP: "demo", CLAUDE_SYNC_DATA_DIR: dir });
    const injected = parseInjected(result.stdout);
    expect(injected.hookEventName).toBe("UserPromptSubmit");
    expect(injected.additionalContext).toContain("peer-2 fixed the flaky test");
    expect(injected.additionalContext).not.toContain("peer-1 ["); // unchanged peer omitted from body
    expect(injected.additionalContext).toContain("1 unchanged session");

    const cursor = await import("../src/lib/cursor").then((m) => m.getCursor("demo", "sess-aaa111"));
    expect(cursor?.digest_version).toBe(2);
  });
});
