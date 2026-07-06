import { stat } from "node:fs/promises";
import { paths } from "./paths";
import { appendLine } from "./atomic";
import type { JournalLine } from "./types";

export async function appendJournal(group: string, sessionId: string, line: JournalLine): Promise<void> {
  await appendLine(paths.journalFile(group, sessionId), JSON.stringify(line));
}

export async function journalSize(group: string, sessionId: string): Promise<number> {
  try {
    const s = await stat(paths.journalFile(group, sessionId));
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Read journal lines starting at a byte offset, returning the parsed lines and the new
 * offset (end of file at read time). Malformed lines are skipped rather than failing the
 * whole read — a torn last line from a concurrent append should never wedge the daemon.
 */
export async function readJournalFrom(
  group: string,
  sessionId: string,
  offset: number,
): Promise<{ lines: JournalLine[]; newOffset: number }> {
  const file = Bun.file(paths.journalFile(group, sessionId));
  const size = file.size;
  if (size <= offset) return { lines: [], newOffset: size };

  const slice = file.slice(offset, size);
  const text = await slice.text();

  // Only trust content up through the last newline; a partial final line means a writer
  // is mid-append, so leave that tail for the next poll.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], newOffset: offset };

  const complete = text.slice(0, lastNewline);
  const newOffset = offset + Buffer.byteLength(complete, "utf8") + 1;

  const lines: JournalLine[] = [];
  for (const raw of complete.split("\n")) {
    if (!raw) continue;
    try {
      lines.push(JSON.parse(raw) as JournalLine);
    } catch {
      // skip malformed line
    }
  }
  return { lines, newOffset };
}
