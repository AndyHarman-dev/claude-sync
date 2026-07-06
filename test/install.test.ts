import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, lstat, readlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { install, defaultInstallPaths } from "../src/install/install";
import { uninstall } from "../src/install/uninstall";
import type { InstallPaths } from "../src/install/install";

const REAL_REPO_ROOT = join(import.meta.dir, "..");

let dir: string;
let sandboxPaths: InstallPaths;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-install-"));
  process.env.CLAUDE_SYNC_DATA_DIR = join(dir, "data");
  sandboxPaths = {
    repoRoot: REAL_REPO_ROOT, // bin/claude-sync and bin/csync must actually exist, for chmod
    settingsPath: join(dir, "claude-home", "settings.json"),
    hookMainPath: join(REAL_REPO_ROOT, "src", "hooks", "main.ts"),
    skillSrcDir: join(REAL_REPO_ROOT, "assets", "skills", "sync"),
    skillDestDir: join(dir, "claude-home", "skills", "sync"),
    localBinDir: join(dir, "local-bin"),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("install", () => {
  test("creates settings.json from scratch with our hooks merged in", async () => {
    await install(sandboxPaths);
    const settings = JSON.parse(await readFile(sandboxPaths.settingsPath, "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
  });

  test("merges into existing settings.json and preserves unrelated keys, with a backup", async () => {
    await mkdir(join(dir, "claude-home"), { recursive: true });
    await writeFile(sandboxPaths.settingsPath, JSON.stringify({ model: "claude-fable-5", theme: "dark" }));

    await install(sandboxPaths);

    const settings = JSON.parse(await readFile(sandboxPaths.settingsPath, "utf8"));
    expect(settings.model).toBe("claude-fable-5");
    expect(settings.theme).toBe("dark");
    expect(settings.hooks).toBeDefined();

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, "claude-home"));
    expect(files.some((f) => f.includes(".claude-sync.bak."))).toBe(true);
  });

  test("refuses to install over malformed JSON rather than overwriting it", async () => {
    await mkdir(join(dir, "claude-home"), { recursive: true });
    await writeFile(sandboxPaths.settingsPath, "{ not valid json");

    await expect(install(sandboxPaths)).rejects.toThrow(/not valid JSON/);

    // the malformed file must be left untouched, not clobbered
    const contents = await readFile(sandboxPaths.settingsPath, "utf8");
    expect(contents).toBe("{ not valid json");
  });

  test("links the skill and both binaries as symlinks pointing into the repo", async () => {
    await install(sandboxPaths);

    const skillLink = await lstat(sandboxPaths.skillDestDir);
    expect(skillLink.isSymbolicLink()).toBe(true);
    expect(await readlink(sandboxPaths.skillDestDir)).toBe(sandboxPaths.skillSrcDir);

    const csyncLink = await lstat(join(sandboxPaths.localBinDir, "csync"));
    expect(csyncLink.isSymbolicLink()).toBe(true);
    const claudeSyncLink = await lstat(join(sandboxPaths.localBinDir, "claude-sync"));
    expect(claudeSyncLink.isSymbolicLink()).toBe(true);
  });

  test("re-installing is idempotent and does not error on existing correct symlinks", async () => {
    await install(sandboxPaths);
    await install(sandboxPaths); // should not throw
    const settings = JSON.parse(await readFile(sandboxPaths.settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test("refuses to clobber a real (non-symlink) file at the skill destination", async () => {
    await mkdir(sandboxPaths.skillDestDir, { recursive: true });
    await writeFile(join(sandboxPaths.skillDestDir, "SKILL.md"), "not ours");
    await expect(install(sandboxPaths)).rejects.toThrow(/not a symlink/);
  });

  test("project-scoped install (via defaultInstallPaths project paths) writes into <cwd>/.claude, not the home dir", async () => {
    const projectDir = join(dir, "some-project");
    await mkdir(projectDir, { recursive: true });
    const projectPaths: InstallPaths = {
      ...defaultInstallPaths({ project: true, cwd: projectDir }),
      repoRoot: REAL_REPO_ROOT,
      localBinDir: sandboxPaths.localBinDir, // keep bins sandboxed, never touch the real ~/.local/bin
    };

    await install(projectPaths);

    const settings = JSON.parse(await readFile(join(projectDir, ".claude", "settings.json"), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);

    const skillLink = await lstat(join(projectDir, ".claude", "skills", "sync"));
    expect(skillLink.isSymbolicLink()).toBe(true);
  });
});

describe("defaultInstallPaths", () => {
  test("project: true scopes settings and skill under <cwd>/.claude, keeping bins/hook global", () => {
    const p = defaultInstallPaths({ project: true, cwd: "/repo/a" });
    expect(p.settingsPath).toBe(join("/repo/a", ".claude", "settings.json"));
    expect(p.skillDestDir).toBe(join("/repo/a", ".claude", "skills", "sync"));
    expect(p.localBinDir).toBe(join(homedir(), ".local", "bin"));
    expect(p.hookMainPath).toBe(join(REAL_REPO_ROOT, "src", "hooks", "main.ts"));
  });

  test("project: true without an explicit cwd falls back to process.cwd()", () => {
    const p = defaultInstallPaths({ project: true });
    expect(p.settingsPath).toBe(join(process.cwd(), ".claude", "settings.json"));
  });

  test("without project, settings/skill are scoped under the home directory as before", () => {
    const p = defaultInstallPaths();
    expect(p.settingsPath).toBe(join(homedir(), ".claude", "settings.json"));
    expect(p.skillDestDir).toBe(join(homedir(), ".claude", "skills", "sync"));
  });
});

describe("uninstall", () => {
  test("removes our hooks and symlinks, restoring the settings shape", async () => {
    await mkdir(join(dir, "claude-home"), { recursive: true });
    await writeFile(sandboxPaths.settingsPath, JSON.stringify({ model: "claude-fable-5" }));
    await install(sandboxPaths);

    await uninstall(sandboxPaths);

    const settings = JSON.parse(await readFile(sandboxPaths.settingsPath, "utf8"));
    expect(settings.hooks).toBeUndefined();
    expect(settings.model).toBe("claude-fable-5");

    await expect(lstat(sandboxPaths.skillDestDir)).rejects.toThrow();
    await expect(lstat(join(sandboxPaths.localBinDir, "csync"))).rejects.toThrow();
  });

  test("purge additionally removes the sandboxed data directory", async () => {
    await install(sandboxPaths);
    await mkdir(process.env.CLAUDE_SYNC_DATA_DIR!, { recursive: true });
    await writeFile(join(process.env.CLAUDE_SYNC_DATA_DIR!, "marker"), "x");

    await uninstall({ ...sandboxPaths, purge: true });

    const { fileExists } = await import("../src/lib/atomic");
    expect(await fileExists(join(process.env.CLAUDE_SYNC_DATA_DIR!, "marker"))).toBe(false);
  });

  test("is a safe no-op when nothing was ever installed", async () => {
    await expect(uninstall(sandboxPaths)).resolves.toBeUndefined();
  });
});
