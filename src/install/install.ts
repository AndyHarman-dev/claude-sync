import { readFile, writeFile, rename, mkdir, symlink, lstat, readlink, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mergeHooks } from "./settings-merge";
import { paths } from "../lib/paths";

export interface InstallPaths {
  repoRoot: string;
  settingsPath: string;
  hookMainPath: string;
  skillSrcDir: string;
  skillDestDir: string;
  localBinDir: string;
}

export function defaultInstallPaths(): InstallPaths {
  const repoRoot = join(import.meta.dir, "..", "..");
  return {
    repoRoot,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    hookMainPath: join(repoRoot, "src", "hooks", "main.ts"),
    skillSrcDir: join(repoRoot, "assets", "skills", "sync"),
    skillDestDir: join(homedir(), ".claude", "skills", "sync"),
    localBinDir: join(homedir(), ".local", "bin"),
  };
}

async function backupAndWriteSettings(settingsPath: string, next: unknown): Promise<void> {
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    await writeFile(`${settingsPath}.claude-sync.bak.${Date.now()}`, raw);
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, settingsPath);
}

/** Create (or repair) a symlink at linkPath -> target. Refuses to touch a real file/dir
 * that isn't already a symlink we recognize, so install never clobbers unrelated state. */
async function ensureSymlink(target: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath);
      if (existingTarget === target) return;
      await unlink(linkPath);
    } else {
      throw new Error(`${linkPath} already exists and is not a symlink claude-sync manages — remove it manually first`);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  await symlink(target, linkPath);
}

export async function install(overrides: Partial<InstallPaths> = {}): Promise<void> {
  const p = { ...defaultInstallPaths(), ...overrides };

  let raw: string;
  try {
    raw = await readFile(p.settingsPath, "utf8");
  } catch {
    raw = "{}";
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Refusing to install: ${p.settingsPath} is not valid JSON (${err}). Fix or remove it, then retry.`);
  }

  const next = mergeHooks(settings, p.hookMainPath);
  await backupAndWriteSettings(p.settingsPath, next);

  await ensureSymlink(p.skillSrcDir, p.skillDestDir);
  await ensureSymlink(join(p.repoRoot, "bin", "claude-sync"), join(p.localBinDir, "claude-sync"));
  await ensureSymlink(join(p.repoRoot, "bin", "csync"), join(p.localBinDir, "csync"));
  await chmod(join(p.repoRoot, "bin", "claude-sync"), 0o755);
  await chmod(join(p.repoRoot, "bin", "csync"), 0o755);

  await mkdir(paths.root(), { recursive: true });

  console.log("claude-sync installed.");
  console.log(`Hooks merged into ${p.settingsPath} (a backup was saved alongside it).`);
  console.log(`Skill linked at ${p.skillDestDir}`);
  console.log(`Binaries linked into ${p.localBinDir} (csync, claude-sync)`);
}
