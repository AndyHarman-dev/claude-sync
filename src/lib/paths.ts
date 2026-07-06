import { homedir } from "node:os";
import { join } from "node:path";

function dataRoot(): string {
  return process.env.CLAUDE_SYNC_DATA_DIR ?? join(homedir(), ".claude-sync");
}

export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
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
