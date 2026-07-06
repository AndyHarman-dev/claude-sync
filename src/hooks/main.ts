#!/usr/bin/env bun
import { guard } from "./guard";
import { registerSession, heartbeat, endSession, getMembership } from "../lib/registry";
import { appendJournal } from "../lib/journal";
import { detectRepo } from "../lib/repo";
import { CAPS, clampStr } from "../lib/types";

interface RawHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string; [key: string]: unknown };
  [key: string]: unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(): Promise<void> {
  const raw = await readStdin();

  let payload: RawHookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = payload.session_id;
  const cwd = payload.cwd;
  const eventName = payload.hook_event_name;
  if (!sessionId || !cwd || !eventName) return;

  const outcome = await guard({ session_id: sessionId, cwd, hook_event_name: eventName, transcript_path: payload.transcript_path });
  if (outcome.kind === "none") return;

  const group = outcome.group;
  const existing = outcome.kind === "member" ? outcome.membership : await getMembership(sessionId);
  const repo = existing?.repo ?? detectRepo(cwd);

  if (!existing) {
    await registerSession({ sessionId, group, cwd, repo, transcriptPath: payload.transcript_path });
  }

  switch (eventName) {
    case "SessionStart": {
      await appendJournal(group, sessionId, { v: 1, t: Date.now(), e: "start", cwd, repo });
      // Phase 2+: fire-and-forget daemon ensure
      // Phase 3+: inject full digest via additionalContext
      break;
    }
    case "UserPromptSubmit": {
      await heartbeat(sessionId);
      const text = typeof payload.prompt === "string" ? clampStr(payload.prompt, CAPS.promptTruncate) : "";
      await appendJournal(group, sessionId, { v: 1, t: Date.now(), e: "prompt", text });
      // Phase 3+: staleness check + inject delta
      break;
    }
    case "PostToolUse": {
      const tool = payload.tool_name ?? "unknown";
      const input = payload.tool_input ?? {};
      const file = typeof input.file_path === "string" ? input.file_path : undefined;
      const cmd = typeof input.command === "string" ? clampStr(input.command, 120) : undefined;
      await appendJournal(group, sessionId, { v: 1, t: Date.now(), e: "tool", tool, file, cmd });
      break;
    }
    case "SessionEnd": {
      await endSession(sessionId);
      await appendJournal(group, sessionId, { v: 1, t: Date.now(), e: "end" });
      break;
    }
    default:
      break;
  }
}

if (import.meta.main) {
  run().catch(() => {
    // A hook must never break the host session, no matter what goes wrong.
  });
}
