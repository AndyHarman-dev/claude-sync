import { readFile, writeFile, rename, unlink, lstat, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeHooks } from "./settings-merge";
import { defaultInstallPaths, WRAPPER_SENTINEL } from "./install";
import type { InstallPaths } from "./install";
import { paths } from "../lib/paths";
import { stopDaemon, daemonStatus } from "../daemon/index";

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

/** Remove a `claude-sync`/`csync` bin entry — either a legacy symlink from an older
 * install, or the generated wrapper script (recognized by its sentinel comment) that
 * replaced it. Never touches a real file that isn't ours. */
async function removeOwnedBin(binPath: string): Promise<void> {
  let st;
  try {
    st = await lstat(binPath);
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(binPath);
    if (target.includes("claude-sync")) await unlink(binPath);
    return;
  }
  const contents = await readFile(binPath, "utf8").catch(() => "");
  if (contents.includes(WRAPPER_SENTINEL)) await unlink(binPath);
}

/** Stop a running daemon before `--purge` deletes its data directory out from under it —
 * otherwise it keeps running orphaned with a deleted pidfile/socket, and the next `daemon
 * ensure` spawns a second daemon racing the first over the same (recreated) data. Only
 * called for purge: the daemon is global machine-wide state, not scoped to one project or
 * settings file, so a plain (non-purge) uninstall — including `--project` in some other
 * repo — must not stop a daemon that other still-active sessions elsewhere depend on. */
async function stopDaemonAndWait(timeoutMs = 3000): Promise<void> {
  if (!(await stopDaemon())) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await daemonStatus()).running) return;
    await new Promise((r) => setTimeout(r, 100));
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
  await removeOwnedBin(join(p.localBinDir, "claude-sync"));
  await removeOwnedBin(join(p.localBinDir, "csync"));

  if (purge) {
    await stopDaemonAndWait();
    await rm(paths.root(), { recursive: true, force: true });
  }

  console.log("claude-sync uninstalled.");
}
