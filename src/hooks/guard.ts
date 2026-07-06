import { paths } from "../lib/paths";
import { readJson, removeIfExists } from "../lib/atomic";
import { getMembership } from "../lib/registry";
import type { PendingJoin, Membership } from "../lib/types";

const PENDING_JOIN_TTL_MS = 2 * 60 * 1000;

export interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

export type GuardOutcome =
  | { kind: "env"; group: string }
  | { kind: "member"; group: string; membership: Membership }
  | { kind: "claim"; group: string }
  | { kind: "none" };

/**
 * The hot-path decision: is this event's session part of a sync group, and which one.
 * Order matters — env var (csync-launched sessions) is checked first since it requires
 * zero disk I/O, so a plain, non-synced `claude` session that happens to share this hook
 * script pays only that one env read before bailing.
 */
export async function guard(payload: HookPayload): Promise<GuardOutcome> {
  const envGroup = process.env.CLAUDE_SYNC_GROUP;
  if (envGroup) return { kind: "env", group: envGroup };

  const membership = await getMembership(payload.session_id);
  if (membership && membership.status === "active") {
    return { kind: "member", group: membership.group, membership };
  }

  if (payload.hook_event_name === "SessionStart" || payload.hook_event_name === "UserPromptSubmit") {
    const pendingPath = paths.pendingJoinFile(payload.cwd);
    const pending = await readJson<PendingJoin>(pendingPath);
    if (pending && Date.now() - pending.created_at < PENDING_JOIN_TTL_MS) {
      await removeIfExists(pendingPath);
      return { kind: "claim", group: pending.group };
    }
  }

  return { kind: "none" };
}
