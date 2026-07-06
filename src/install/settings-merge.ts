/** Any hook entry whose command contains this substring is ours — used to make install
 * idempotent (re-install replaces our entries instead of duplicating them) and uninstall
 * surgical (removes only our entries, never another tool's hooks on the same event). */
export const HOOK_SENTINEL = "claude-sync/src/hooks/main.ts";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks: HookEntry[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookMatcherEntry[]> };

const OUR_EVENTS: Record<string, string | undefined> = {
  SessionStart: undefined,
  UserPromptSubmit: undefined,
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit|Bash",
  SessionEnd: undefined,
};

function ourEntry(hookMainPath: string, matcher: string | undefined, bunPath: string): HookMatcherEntry {
  const entry: HookMatcherEntry = { hooks: [{ type: "command", command: `${bunPath} ${hookMainPath}`, timeout: 10 }] };
  if (matcher) entry.matcher = matcher;
  return entry;
}

function isOurEntry(entry: HookMatcherEntry): boolean {
  return Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === "string" && h.command.includes(HOOK_SENTINEL));
}

/** Pure, idempotent merge: for each of our four events, drop any prior entry of ours and
 * append a fresh one — entries belonging to other tools on the same event are preserved
 * untouched. Every other top-level settings key is passed through unchanged.
 *
 * `bunPath` must be an absolute path (callers should pass `process.execPath`), not the bare
 * string "bun" — hook commands run through a non-interactive shell that does not source
 * .zshrc/.bashrc, so a bun installed via a PATH export made there (as the official bun
 * installer does) would be unresolvable and every hook invocation would silently fail. */
export function mergeHooks(settings: Settings, hookMainPath: string, bunPath: string): Settings {
  const next: Settings = { ...settings };
  const hooks: Record<string, HookMatcherEntry[]> = { ...(next.hooks ?? {}) };

  for (const [event, matcher] of Object.entries(OUR_EVENTS)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const withoutOurs = existing.filter((e) => !isOurEntry(e));
    hooks[event] = [...withoutOurs, ourEntry(hookMainPath, matcher, bunPath)];
  }

  next.hooks = hooks;
  return next;
}

/** Pure inverse of mergeHooks: strips only our entries. An event left with zero entries
 * is removed entirely; `hooks` itself is removed if it ends up empty. */
export function removeHooks(settings: Settings): Settings {
  const next: Settings = { ...settings };
  if (!next.hooks) return next;

  const hooks: Record<string, HookMatcherEntry[]> = {};
  for (const [event, list] of Object.entries(next.hooks)) {
    const filtered = (list ?? []).filter((e) => !isOurEntry(e));
    if (filtered.length > 0) hooks[event] = filtered;
  }

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}
