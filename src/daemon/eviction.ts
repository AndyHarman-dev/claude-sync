import { readdir, stat, utimes } from "node:fs/promises";
import { paths } from "../lib/paths";
import { readJson, writeJsonAtomic, removeIfExists } from "../lib/atomic";
import { listMemberships } from "../lib/registry";
import { listGroups } from "./poller";
import { sessionLabel } from "../lib/digest";
import { CAPS } from "../lib/types";
import type { Membership, Recap, Digest } from "../lib/types";
import { rebuildGroupDigest } from "./digest-writer";
import { log } from "./log";

/** How long an ended session stays visible in the digest as "left the group" before its
 * recap is folded into the group's persistent history and the entry disappears. */
export const TOMBSTONE_GRACE_MS = 15 * 60 * 1000;
/** A session that never sent SessionEnd (crashed terminal, killed process) is treated the
 * same way once it's been silent this long. */
export const CRASHED_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Per-session journal/recap/cursor files are kept around for a while after the session
 * drops out of the digest, in case they're useful for debugging, then swept. */
export const ORPHAN_FILE_GC_MS = 24 * 60 * 60 * 1000;

/** Fold one departing session's recap into the running history string, keeping the most
 * recent content when the combined text exceeds the cap (oldest history is what's least
 * likely to still matter). Exported for unit testing. */
export function foldHistoryEntry(prevHistory: string, sessionId: string, recap: Recap | undefined): string {
  const bits: string[] = [];
  if (recap?.recap.focus) bits.push(recap.recap.focus);
  if (recap?.recap.recent.length) bits.push(recap.recap.recent.map((r) => r.summary).join("; "));
  const summary = bits.join(" — ") || "no recorded activity";
  const entry = `${sessionLabel(sessionId)}: ${summary}`;
  const combined = prevHistory ? `${prevHistory}; ${entry}` : entry;
  return combined.length > CAPS.historyMax ? combined.slice(combined.length - CAPS.historyMax) : combined;
}

export function isEvictable(m: Membership, now: number): boolean {
  if (m.status === "ended") return now - m.last_seen > TOMBSTONE_GRACE_MS;
  return now - m.last_seen > CRASHED_TIMEOUT_MS;
}

/**
 * Tier 1: sessions that have been gone long enough get their final recap folded into the
 * group's persistent `history` and their membership dropped — which is what makes them
 * disappear from the digest. The group itself, its digest file, and `history` are never
 * deleted here (or anywhere): ending every session in a group does not remove the group.
 */
export async function runTombstoneEviction(now = Date.now()): Promise<void> {
  const memberships = await listMemberships();
  const byGroup = new Map<string, Membership[]>();
  for (const m of memberships) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group)!.push(m);
  }

  for (const [group, groupMemberships] of byGroup) {
    const evictable = groupMemberships.filter((m) => isEvictable(m, now));
    if (evictable.length === 0) continue;

    const digest = await readJson<Digest>(paths.digestFile(group));
    let history = digest?.history ?? "";
    for (const m of evictable) {
      const recap = await readJson<Recap>(paths.recapFile(group, m.session_id));
      history = foldHistoryEntry(history, m.session_id, recap);
      await removeIfExists(paths.sessionFile(m.session_id));
      await log(`evicted ${group}:${m.session_id} into history`);
    }

    // Persist the updated history immediately — it must never be lost even if the
    // subsequent digest rebuild below decides nothing else changed.
    if (digest) {
      await writeJsonAtomic(paths.digestFile(group), { ...digest, history });
    }
    await rebuildGroupDigest(group);
  }
}

/** Tier 2: once a session's files are orphaned (no membership left) and have sat untouched
 * past the GC window, delete the journal/recap/cursor triplet. Independent of tombstone
 * eviction timing — a session could in principle have its files linger a while after
 * dropping out of the digest, which is fine; this is just disk hygiene. */
export async function runOrphanFileGC(now = Date.now()): Promise<void> {
  const memberships = await listMemberships();
  const knownIds = new Set(memberships.map((m) => m.session_id));

  const groups = await listGroups();
  for (const group of groups) {
    let files: string[];
    try {
      files = await readdir(paths.journalDir(group));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.slice(0, -".jsonl".length);
      if (knownIds.has(sessionId)) continue;

      const journalPath = paths.journalFile(group, sessionId);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(journalPath)).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > ORPHAN_FILE_GC_MS) {
        await removeIfExists(journalPath);
        await removeIfExists(paths.recapFile(group, sessionId));
        await removeIfExists(paths.cursorFile(group, sessionId));
        await log(`GC'd orphaned files for ${group}:${sessionId}`);
      }
    }
  }
}

/** Test helper: backdate a file's mtime so GC-window tests don't need real sleeps. */
export async function backdateFile(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}
