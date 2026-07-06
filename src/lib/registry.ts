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
  // group/cwd/repo/status always come from the current call's params, even when a prior
  // (possibly ended, possibly different-group) record exists — a rejoin must actually
  // move the session to the new group rather than silently reactivating the old one.
  // joined_at is the one field worth preserving across re-registrations.
  const membership: Membership = {
    v: 1,
    session_id: params.sessionId,
    group: params.group,
    cwd: params.cwd,
    repo: params.repo,
    transcript_path: params.transcriptPath ?? existing?.transcript_path,
    joined_at: existing?.joined_at ?? now,
    last_seen: now,
    status: "active",
  };
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
 * CLI, which only knows its cwd, never its own session_id). Prefers an active session over
 * an ended one regardless of timestamps — an ended session's last_seen can be more recent
 * than a genuinely active one's (e.g. right after a `/sync leave`), and callers like
 * `status`/`now`/`push`/`leave` want the live session, not whichever happened to touch
 * its file last. Falls back to the most recent match of any status if none are active. */
export async function resolveByCwd(cwd: string, group?: string): Promise<Membership | undefined> {
  const all = await listMemberships();
  const matches = all.filter((m) => m.cwd === cwd && (!group || m.group === group));
  if (matches.length === 0) return undefined;
  const active = matches.filter((m) => m.status === "active");
  const pool = active.length > 0 ? active : matches;
  pool.sort((a, b) => b.last_seen - a.last_seen);
  return pool[0];
}
