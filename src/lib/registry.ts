import { readdir } from "node:fs/promises";
import { paths } from "./paths";
import { readJson, writeJsonAtomic, fileExists } from "./atomic";
import type { Membership } from "./types";

export async function getMembership(sessionId: string): Promise<Membership | undefined> {
  return readJson<Membership>(paths.sessionFile(sessionId));
}

export async function isMember(sessionId: string): Promise<boolean> {
  return fileExists(paths.sessionFile(sessionId));
}

export async function registerSession(params: {
  sessionId: string;
  group: string;
  cwd: string;
  repo: string;
  transcriptPath?: string;
}): Promise<Membership> {
  const existing = await getMembership(params.sessionId);
  const now = Date.now();
  const membership: Membership = existing ?? {
    v: 1,
    session_id: params.sessionId,
    group: params.group,
    cwd: params.cwd,
    repo: params.repo,
    transcript_path: params.transcriptPath,
    joined_at: now,
    last_seen: now,
    status: "active",
  };
  membership.last_seen = now;
  membership.status = "active";
  await writeJsonAtomic(paths.sessionFile(params.sessionId), membership);
  return membership;
}

export async function heartbeat(sessionId: string): Promise<void> {
  const membership = await getMembership(sessionId);
  if (!membership) return;
  membership.last_seen = Date.now();
  await writeJsonAtomic(paths.sessionFile(sessionId), membership);
}

export async function endSession(sessionId: string): Promise<void> {
  const membership = await getMembership(sessionId);
  if (!membership) return;
  membership.status = "ended";
  membership.last_seen = Date.now();
  await writeJsonAtomic(paths.sessionFile(sessionId), membership);
}

export async function listMemberships(): Promise<Membership[]> {
  let files: string[];
  try {
    files = await readdir(paths.sessionsDir());
  } catch {
    return [];
  }
  const memberships: Membership[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const sessionId = f.slice(0, -".json".length);
    const membership = await getMembership(sessionId);
    if (membership) memberships.push(membership);
  }
  return memberships;
}

/** Resolve the most recently active session registered against a given cwd (used by the
 * CLI, which only knows its cwd, never its own session_id). */
export async function resolveByCwd(cwd: string, group?: string): Promise<Membership | undefined> {
  const all = await listMemberships();
  const matches = all.filter((m) => m.cwd === cwd && (!group || m.group === group));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.last_seen - a.last_seen);
  return matches[0];
}
