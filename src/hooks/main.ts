#!/usr/bin/env bun
import { guard } from "./guard";
import { registerSession, heartbeat, endSession, getMembership } from "../lib/registry";
import { appendJournal } from "../lib/journal";
import { detectRepo } from "../lib/repo";
import { CAPS, clampStr } from "../lib/types";
import type { Digest } from "../lib/types";
import { readJson } from "../lib/atomic";
import { paths } from "../lib/paths";
import { getCursor, setCursor } from "../lib/cursor";
import { renderDigest, deltaSessions, sessionLabel } from "../lib/digest";
import { ensureDaemon } from "../daemon/index";

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

function emitAdditionalContext(hookEventName: string, text: string): void {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
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
      await ensureDaemon().catch(() => {});

      const digest = await readJson<Digest>(paths.digestFile(group));
      const identity = `You are sync session ${sessionLabel(sessionId)} in group "${group}".`;
      if (digest) {
        const block = renderDigest({ digest, excludeSessionId: sessionId });
        emitAdditionalContext(eventName, `${identity}\n${block}`);
        await setCursor(group, sessionId, digest.version);
      } else {
        emitAdditionalContext(eventName, identity);
        await setCursor(group, sessionId, 0);
      }
      break;
    }
    case "UserPromptSubmit": {
      await heartbeat(sessionId);
      const text = typeof payload.prompt === "string" ? clampStr(payload.prompt, CAPS.promptTruncate) : "";
      await appendJournal(group, sessionId, { v: 1, t: Date.now(), e: "prompt", text });

      const digest = await readJson<Digest>(paths.digestFile(group));
      if (digest) {
        const cursor = await getCursor(group, sessionId);
        const cursorVersion = cursor?.digest_version ?? 0;
        if (digest.version > cursorVersion) {
          const delta = deltaSessions(digest, cursorVersion, sessionId);
          const deltaIds = Object.keys(delta);
          if (deltaIds.length > 0) {
            const totalOthers = Object.keys(digest.sessions).filter((id) => id !== sessionId).length;
            const unchangedCount = totalOthers - deltaIds.length;
            const block = renderDigest({ digest, excludeSessionId: sessionId, entries: delta, unchangedCount });
            emitAdditionalContext(eventName, block);
          }
          await setCursor(group, sessionId, digest.version);
        }
      }
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
