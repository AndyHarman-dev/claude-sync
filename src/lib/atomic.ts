import { mkdir, rename, unlink, appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/** Write JSON atomically: write to a tmp file in the same dir, then rename over the target. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(data));
  await rename(tmp, path);
}

/** Read and parse JSON, returning undefined if the file doesn't exist or fails to parse. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Append one line (newline-terminated) to a file, creating parent dirs as needed. */
export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(path);
  await appendFile(path, line.endsWith("\n") ? line : `${line}\n`);
}

/**
 * Create a file exclusively (fails if it already exists). Used for the daemon pidfile
 * singleton lock. Returns true if created, false if it already existed.
 */
export async function createExclusive(path: string, data: string): Promise<boolean> {
  await ensureDir(path);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(data);
    await handle.close();
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
