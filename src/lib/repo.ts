import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** Best-effort repo name: git toplevel basename if cwd is inside a git repo, else cwd basename.
 * Runs once at session registration only — never on the steady-state hot path. */
export function detectRepo(cwd: string): string {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 2000,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout) {
      return basename(result.stdout.trim());
    }
  } catch {
    // not a git repo, git unavailable, or timed out
  }
  return basename(cwd) || cwd;
}
