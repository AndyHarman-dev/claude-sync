import { mkdir, appendFile, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "../lib/paths";

const ROTATE_BYTES = 5 * 1024 * 1024;

/** Append a line to the daemon log, rotating once at 5MB (keeping one prior file). Never
 * throws — a logging failure must not be allowed to take down the daemon. */
export async function log(message: string): Promise<void> {
  try {
    const path = paths.daemonLog();
    await mkdir(dirname(path), { recursive: true });
    try {
      const s = await stat(path);
      if (s.size > ROTATE_BYTES) {
        await rename(path, `${path}.1`);
      }
    } catch {
      // no existing log file yet
    }
    await appendFile(path, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never crash the daemon
  }
}
