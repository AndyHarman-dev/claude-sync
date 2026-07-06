import { readJson, writeJsonAtomic } from "../lib/atomic";
import { paths } from "../lib/paths";
import { readJournalFrom } from "../lib/journal";
import { CAPS, clampRecapBody, emptyRecapBody } from "../lib/types";
import type { JournalLine, Recap, RecapBody } from "../lib/types";
import { log } from "./log";

export function renderJournalLine(line: JournalLine): string | undefined {
  switch (line.e) {
    case "start":
      return `[start] opened session in ${line.repo} (${line.cwd})`;
    case "prompt":
      return `[prompt] ${line.text}`;
    case "tool":
      if (line.file) return `[tool] ${line.tool} ${line.file}`;
      if (line.cmd) return `[tool] ${line.tool}: ${line.cmd}`;
      return `[tool] ${line.tool}`;
    case "note":
      return `[note] ${line.text}`;
    case "end":
      return "[end] session ended";
    default:
      return undefined;
  }
}

export function buildPrompt(params: {
  repo: string;
  cwd: string;
  prevRecap: RecapBody | undefined;
  deltaLines: JournalLine[];
}): string {
  const { repo, cwd, prevRecap, deltaLines } = params;
  const eventsText = deltaLines.map(renderJournalLine).filter(Boolean).join("\n");
  const truncatedEvents =
    eventsText.length > CAPS.journalDeltaBytes ? eventsText.slice(-CAPS.journalDeltaBytes) : eventsText;
  const prevText = prevRecap ? JSON.stringify(prevRecap) : "none";

  return `You maintain a terse status recap of one coding session for its peer sessions.
Output ONLY a JSON object, no markdown, matching:
{"focus": string<=240, "recent":[{"repo":string,"summary":string<=140,"files":[string]}] (max 5, newest first),
 "problems":[string<=160] (max 3, only real blockers/bugs encountered, else [])}
Rules: third person, no filler, file paths relative to repo, merge with the previous recap
(carry forward still-relevant items, drop stale ones), never invent work not in the events.

PREVIOUS RECAP:
${prevText}

NEW EVENTS (chronological, from session in repo "${repo}", cwd ${cwd}):
${truncatedEvents}`;
}

/** Tolerant extraction: find the first {...} block in the model's output and parse it,
 * ignoring any surrounding prose or code fences. Returns undefined on any failure. */
export function parseRecapResponse(raw: string): RecapBody | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const body: RecapBody = {
      focus: typeof parsed.focus === "string" ? parsed.focus : "",
      recent: Array.isArray(parsed.recent)
        ? parsed.recent
            .filter((r: unknown): r is { repo?: string; summary: string; files?: string[] } =>
              typeof r === "object" && r !== null && typeof (r as any).summary === "string",
            )
            .map((r: any) => ({ repo: r.repo ?? "", summary: r.summary, files: r.files }))
        : [],
      problems: Array.isArray(parsed.problems)
        ? parsed.problems.filter((p: unknown): p is string => typeof p === "string")
        : [],
    };
    return clampRecapBody(body);
  } catch {
    return undefined;
  }
}

export async function runHaikuSummarize(prompt: string): Promise<string> {
  // Defense in depth: the daemon already scrubs CLAUDE_SYNC_GROUP from its own env before
  // this can be reached (see runForeground), but a stray env var here would make this
  // headless call trip its own SessionStart hook and register itself as a phantom group
  // member — so scrub explicitly rather than relying solely on the caller. --tools ""
  // additionally ensures this is pure text generation, never a tool-using turn.
  const env = { ...process.env };
  delete env.CLAUDE_SYNC_GROUP;

  const proc = Bun.spawn({
    cmd: ["claude", "-p", prompt, "--model", "haiku", "--output-format", "json", "--tools", ""],
    stdout: "pipe",
    stderr: "pipe",
    cwd: paths.root(),
    env,
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  let stdout: string;
  try {
    [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } finally {
    clearTimeout(timer);
  }
  try {
    const envelope = JSON.parse(stdout);
    if (typeof envelope.result === "string") return envelope.result;
  } catch {
    // not a JSON envelope — fall through, parseRecapResponse tolerates raw text too
  }
  return stdout;
}

export function isNoteOnlyBatch(lines: JournalLine[]): boolean {
  return lines.length > 0 && lines.every((l) => l.e === "note");
}

export type SummarizeBackend = (prompt: string) => Promise<string>;

export interface SummarizeResult {
  ok: boolean;
  recap?: Recap;
  /** true when nothing new needed summarizing (no-op success) — the caller should not
   * treat this as a change worth rebuilding the digest for. */
  skipped?: boolean;
}

/**
 * Process one session's pending journal delta into an updated recap. A batch made up
 * entirely of `/sync push` note lines bypasses the LLM and pins the note verbatim
 * (deterministic, zero cost); everything else goes through the haiku summarizer.
 */
export async function processSession(params: {
  group: string;
  sessionId: string;
  repo: string;
  cwd: string;
  backend?: SummarizeBackend;
}): Promise<SummarizeResult> {
  const { group, sessionId, repo, cwd } = params;
  const backend = params.backend ?? runHaikuSummarize;

  const prevRecap = await readJson<Recap>(paths.recapFile(group, sessionId));
  const offset = prevRecap?.journal_offset ?? 0;
  const { lines, newOffset } = await readJournalFrom(group, sessionId, offset);
  if (lines.length === 0) return { ok: true, skipped: true, recap: prevRecap };

  if (isNoteOnlyBatch(lines)) {
    const lastNote = [...lines].reverse().find((l): l is Extract<JournalLine, { e: "note" }> => l.e === "note")!;
    const body = clampRecapBody({ ...(prevRecap?.recap ?? emptyRecapBody()), pinned: lastNote.text });
    const recap: Recap = { v: 1, session_id: sessionId, updated_at: Date.now(), journal_offset: newOffset, recap: body };
    await writeJsonAtomic(paths.recapFile(group, sessionId), recap);
    return { ok: true, recap };
  }

  const prompt = buildPrompt({ repo, cwd, prevRecap: prevRecap?.recap, deltaLines: lines });

  let raw: string;
  try {
    raw = await backend(prompt);
  } catch (err) {
    await log(`summarize backend threw for ${group}:${sessionId}: ${err}`);
    return { ok: false };
  }

  const parsedBody = parseRecapResponse(raw);
  if (!parsedBody) {
    await log(`summarize response unparsable for ${group}:${sessionId}`);
    return { ok: false };
  }

  // The model is never asked to produce `pinned` (it's not part of the requested JSON
  // schema), so parsedBody.pinned is always undefined here — carry the prior pinned note
  // forward rather than letting every LLM summarization silently erase it.
  const recapBody = { ...parsedBody, pinned: parsedBody.pinned ?? prevRecap?.recap.pinned };
  const recap: Recap = { v: 1, session_id: sessionId, updated_at: Date.now(), journal_offset: newOffset, recap: recapBody };
  await writeJsonAtomic(paths.recapFile(group, sessionId), recap);
  return { ok: true, recap };
}

export interface QueueJob {
  group: string;
  sessionId: string;
  repo: string;
  cwd: string;
}

export interface SummarizerQueueOptions {
  backend?: SummarizeBackend;
  /** delay before each retry attempt after a failure; length = number of retries */
  backoffMs?: number[];
  /** after all retries are exhausted, stop re-enqueueing this session for this long */
  cooldownMs?: number;
  onDigestDirty?: (group: string) => void;
}

/**
 * Global serial queue: one `claude -p` call in flight at a time. Debounce/staleness
 * timing lives in the daemon's poll loop (daemon/index.ts) — this queue only owns
 * per-job retry/backoff and the cooldown that follows exhausting retries.
 */
export class SummarizerQueue {
  private pending: Array<{ job: QueueJob; resolve: () => void }> = [];
  private draining = false;
  private cooldownUntil = new Map<string, number>();
  private activeKeys = new Set<string>();
  private readonly backoffMs: number[];
  private readonly cooldownMs: number;
  private readonly backend?: SummarizeBackend;
  private readonly onDigestDirty?: (group: string) => void;

  constructor(opts: SummarizerQueueOptions = {}) {
    this.backoffMs = opts.backoffMs ?? [5_000, 30_000];
    this.cooldownMs = opts.cooldownMs ?? 5 * 60 * 1000;
    this.backend = opts.backend;
    this.onDigestDirty = opts.onDigestDirty;
  }

  /** Enqueue a job; resolves once it has either succeeded or exhausted retries. Duplicate
   * jobs for a session already queued OR currently in flight, or a session still in its
   * post-failure cooldown, are dropped (the latter silently — it'll be picked up again
   * next poll cycle). `activeKeys` (not just the `pending` array) is what makes the
   * in-flight case safe: a job is removed from `pending` the instant it starts running,
   * well before it finishes, so checking `pending` alone would miss it. */
  enqueue(job: QueueJob): Promise<void> {
    const key = `${job.group}:${job.sessionId}`;
    const until = this.cooldownUntil.get(key);
    if (until && Date.now() < until) return Promise.resolve();
    if (this.activeKeys.has(key)) return Promise.resolve();
    this.activeKeys.add(key);
    return new Promise<void>((resolve) => {
      this.pending.push({ job, resolve });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const { job, resolve } = this.pending.shift()!;
        await this.runWithRetry(job);
        this.activeKeys.delete(`${job.group}:${job.sessionId}`);
        resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  private async runWithRetry(job: QueueJob): Promise<void> {
    const key = `${job.group}:${job.sessionId}`;
    const totalAttempts = this.backoffMs.length + 1;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const result = await processSession({ ...job, backend: this.backend });
      if (result.ok) {
        this.cooldownUntil.delete(key);
        if (!result.skipped) this.onDigestDirty?.(job.group);
        return;
      }
      await log(`summarize failed for ${key} (attempt ${attempt + 1}/${totalAttempts})`);
      if (attempt < this.backoffMs.length) {
        await new Promise((r) => setTimeout(r, this.backoffMs[attempt]));
      }
    }
    await log(`summarize giving up for ${key}, cooling down for ${this.cooldownMs}ms`);
    this.cooldownUntil.set(key, Date.now() + this.cooldownMs);
  }
}
