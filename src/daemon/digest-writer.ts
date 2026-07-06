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

/** Rebuild a group's digest from the current registry + recap snapshot, writing it only
 * if the version actually advanced (buildDigest is the pure decision of "did anything
 * peers care about change"). Daemon-only writer — hooks and the CLI only ever read this file. */
export async function rebuildGroupDigest(group: string): Promise<Digest> {
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
}
