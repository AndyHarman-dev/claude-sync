import { readdir } from "node:fs/promises";
import { paths } from "../lib/paths";
import { readJson } from "../lib/atomic";
import { journalSize } from "../lib/journal";
import type { Recap } from "../lib/types";

export async function listGroups(): Promise<string[]> {
  try {
    return await readdir(paths.groupsRoot());
  } catch {
    return [];
  }
}

/** A session is "dirty" when its journal has grown past what the last recap consumed. */
export async function findDirtySessionsInGroup(group: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(paths.journalDir(group));
  } catch {
    return [];
  }
  const dirty: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const sessionId = f.slice(0, -".jsonl".length);
    const size = await journalSize(group, sessionId);
    const recap = await readJson<Recap>(paths.recapFile(group, sessionId));
    const offset = recap?.journal_offset ?? 0;
    if (size > offset) dirty.push(sessionId);
  }
  return dirty;
}

export async function findAllDirtySessions(): Promise<Array<{ group: string; sessionId: string }>> {
  const groups = await listGroups();
  const results: Array<{ group: string; sessionId: string }> = [];
  for (const group of groups) {
    const dirty = await findDirtySessionsInGroup(group);
    for (const sessionId of dirty) results.push({ group, sessionId });
  }
  return results;
}
