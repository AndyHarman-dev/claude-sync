import { readdir } from "node:fs/promises";
import { paths } from "../lib/paths";
import { readJson, writeJsonAtomic } from "../lib/atomic";
import { buildDigest } from "../lib/digest";
import { listMemberships } from "../lib/registry";
import type { Digest, Recap } from "../lib/types";

async function loadRecapsForGroup(group: string): Promise<Map<string, Recap>> {
  let files: string[];
  try {
    files = await readdir(paths.recapsDir(group));
  } catch {
    return new Map();
  }
  const map = new Map<string, Recap>();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const sessionId = f.slice(0, -".json".length);
    const recap = await readJson<Recap>(paths.recapFile(group, sessionId));
    if (recap) map.set(sessionId, recap);
  }
  return map;
}

const groupLocks = new Map<string, Promise<unknown>>();

/**
 * Serializes every read-modify-write cycle against a group's digest.json. Without this,
 * a tombstone-eviction fold (which reads, folds history, writes, then calls
 * rebuildGroupDigest) and a summarizer-triggered rebuild fired from the SummarizerQueue's
 * own async drain loop can interleave: the rebuild reads the pre-fold digest before
 * eviction writes, then writes it back afterward, silently reverting the just-folded
 * history. Chaining every writer through one promise per group makes that impossible —
 * whichever call arrived first fully completes (read AND write) before the next begins.
 */
export function withGroupDigestLock<T>(group: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupLocks.get(group) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  groupLocks.set(
    group,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Rebuild a group's digest from the current registry + recap snapshot, writing it only
 * if the version actually advanced (buildDigest is the pure decision of "did anything
 * peers care about change"). Daemon-only writer — hooks and the CLI only ever read this file. */
export async function rebuildGroupDigest(group: string): Promise<Digest> {
  return withGroupDigestLock(group, async () => {
    const [prev, allMemberships, recaps] = await Promise.all([
      readJson<Digest>(paths.digestFile(group)),
      listMemberships(),
      loadRecapsForGroup(group),
    ]);
    const memberships = allMemberships.filter((m) => m.group === group);
    const next = buildDigest({ group, prev, memberships, recaps });
    if (!prev || prev.version !== next.version) {
      await writeJsonAtomic(paths.digestFile(group), next);
    }
    return next;
  });
}
