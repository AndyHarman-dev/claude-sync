import { readFile, writeFile, rename, unlink, lstat, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeHooks } from "./settings-merge";
import { defaultInstallPaths } from "./install";
import type { InstallPaths } from "./install";
import { paths } from "../lib/paths";

/** Remove a symlink only if it's actually a symlink pointing somewhere under our repo —
 * never touches a real file, or a symlink some other tool put there. */
async function removeOwnedSymlink(linkPath: string): Promise<void> {
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) return;
    const target = await readlink(linkPath);
    if (!target.includes("claude-sync")) return;
    await unlink(linkPath);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

export async function uninstall(overrides: Partial<InstallPaths> & { purge?: boolean } = {}): Promise<void> {
  const { purge, ...pathOverrides } = overrides;
  const p = { ...defaultInstallPaths(), ...pathOverrides };

  let raw: string | undefined;
  try {
    raw = await readFile(p.settingsPath, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    const settings = JSON.parse(raw);
    const next = removeHooks(settings);
    const tmp = `${p.settingsPath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, p.settingsPath);
  }

  await removeOwnedSymlink(p.skillDestDir);
  await removeOwnedSymlink(join(p.localBinDir, "claude-sync"));
  await removeOwnedSymlink(join(p.localBinDir, "csync"));

  if (purge) {
    await rm(paths.root(), { recursive: true, force: true });
  }

  console.log("claude-sync uninstalled.");
}
