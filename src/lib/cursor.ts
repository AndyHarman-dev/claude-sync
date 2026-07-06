import { paths } from "./paths";
import { readJson, writeJsonAtomic } from "./atomic";
import type { Cursor } from "./types";

export async function getCursor(group: string, sessionId: string): Promise<Cursor | undefined> {
  return readJson<Cursor>(paths.cursorFile(group, sessionId));
}

export async function setCursor(group: string, sessionId: string, digestVersion: number): Promise<void> {
  const cursor: Cursor = { v: 1, digest_version: digestVersion, updated_at: Date.now() };
  await writeJsonAtomic(paths.cursorFile(group, sessionId), cursor);
}
