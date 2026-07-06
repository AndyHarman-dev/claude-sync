export type SessionStatus = "active" | "ended";

export interface Membership {
  v: 1;
  session_id: string;
  group: string;
  cwd: string;
  repo: string;
  transcript_path?: string;
  joined_at: number;
  last_seen: number;
  status: SessionStatus;
}

export type JournalLine =
  | { v: 1; t: number; e: "start"; cwd: string; repo: string }
  | { v: 1; t: number; e: "prompt"; text: string }
  | { v: 1; t: number; e: "tool"; tool: string; file?: string; cmd?: string }
  | { v: 1; t: number; e: "note"; text: string }
  | { v: 1; t: number; e: "end" };

export interface RecapBody {
  focus: string;
  recent: Array<{ repo: string; summary: string; files?: string[] }>;
  problems: string[];
  pinned?: string;
}

export interface Recap {
  v: 1;
  session_id: string;
  updated_at: number;
  journal_offset: number;
  recap: RecapBody;
}

export interface DigestSessionEntry {
  label: string;
  repo: string;
  cwd: string;
  status: SessionStatus;
  last_seen: number;
  recap_version: number;
  recap: RecapBody;
}

export interface Digest {
  v: 1;
  group: string;
  version: number;
  updated_at: number;
  sessions: Record<string, DigestSessionEntry>;
  history: string;
}

export interface Cursor {
  v: 1;
  digest_version: number;
  updated_at: number;
}

export interface PendingJoin {
  v: 1;
  group: string;
  created_at: number;
}

// Field caps, enforced daemon-side after summarization.
export const CAPS = {
  promptTruncate: 300,
  noteMax: 280,
  focusMax: 240,
  recentMax: 5,
  recentSummaryMax: 140,
  problemsMax: 3,
  problemMax: 160,
  pinnedMax: 280,
  historyMax: 1200,
  journalDeltaBytes: 6 * 1024,
  renderSessionCap: 8,
} as const;

export function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function emptyRecapBody(): RecapBody {
  return { focus: "", recent: [], problems: [] };
}

export function clampRecapBody(r: RecapBody): RecapBody {
  return {
    focus: clampStr(r.focus ?? "", CAPS.focusMax),
    recent: (r.recent ?? []).slice(0, CAPS.recentMax).map((entry) => ({
      repo: entry.repo,
      summary: clampStr(entry.summary ?? "", CAPS.recentSummaryMax),
      files: entry.files,
    })),
    problems: (r.problems ?? []).slice(0, CAPS.problemsMax).map((p) => clampStr(p, CAPS.problemMax)),
    pinned: r.pinned !== undefined ? clampStr(r.pinned, CAPS.pinnedMax) : undefined,
  };
}
