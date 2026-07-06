import { homedir } from "node:os";
import { join } from "node:path";

function dataRoot(): string {
  return process.env.CLAUDE_SYNC_DATA_DIR ?? join(homedir(), ".claude-sync");
}

/** A readable slug plus a hash of the full path — the slug alone isn't collision-free
 * (e.g. "/repo/a" and "/repo-a" both collapse to "-repo-a"), which would let a
 * pending-join intended for one cwd be silently claimed by a session in the other. */
export function mungeCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const hash = Bun.hash(cwd).toString(36);
  return `${slug}-${hash}`;
}

export const paths = {
  root: (): string => dataRoot(),
  daemonDir: (): string => join(dataRoot(), "daemon"),
  daemonPid: (): string => join(dataRoot(), "daemon", "daemon.pid"),
  daemonSock: (): string => join(dataRoot(), "daemon", "daemon.sock"),
  daemonLog: (): string => join(dataRoot(), "daemon", "daemon.log"),
  sessionsDir: (): string => join(dataRoot(), "sessions"),
  sessionFile: (sessionId: string): string => join(dataRoot(), "sessions", `${sessionId}.json`),
  pendingJoinsDir: (): string => join(dataRoot(), "pending-joins"),
  pendingJoinFile: (cwd: string): string => join(dataRoot(), "pending-joins", `${mungeCwd(cwd)}.json`),
  groupsRoot: (): string => join(dataRoot(), "groups"),
  groupDir: (group: string): string => join(dataRoot(), "groups", group),
  journalDir: (group: string): string => join(dataRoot(), "groups", group, "journal"),
  journalFile: (group: string, sessionId: string): string =>
    join(dataRoot(), "groups", group, "journal", `${sessionId}.jsonl`),
  recapsDir: (group: string): string => join(dataRoot(), "groups", group, "recaps"),
  recapFile: (group: string, sessionId: string): string =>
    join(dataRoot(), "groups", group, "recaps", `${sessionId}.json`),
  cursorsDir: (group: string): string => join(dataRoot(), "groups", group, "cursors"),
  cursorFile: (group: string, sessionId: string): string =>
    join(dataRoot(), "groups", group, "cursors", `${sessionId}.json`),
  digestFile: (group: string): string => join(dataRoot(), "groups", group, "digest.json"),
};
