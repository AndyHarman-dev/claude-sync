# claude-sync

A local, eventually-consistent sync layer for concurrent Claude Code sessions — so
sessions working in parallel across a multi-service or multi-repo codebase stay aware of
what each other is doing, without sharing full context and without you having to remember
to catch anyone up.

## Why this exists

Splitting work across several focused Claude Code sessions — one per microservice, one per
repo, one per layer of a system — tends to produce better results than one session trying
to hold an entire multi-service architecture in its head at once: each session stays
narrow, fast, and grounded in the part of the system it's actually touching.

The cost of that split is coordination. Sessions working in adjacent services drift apart:
one renames an endpoint the other still calls, one is mid-refactor on a shared contract,
one hits a bug the others are about to walk into — and none of that surfaces unless a
human manually copies context between terminals. In practice, that catch-up step is the
first thing to get skipped under time pressure, and the sessions quietly stop speaking the
same language about the system they're jointly building.

claude-sync closes that gap without collapsing the sessions back into one. Any sessions
launched into the same *group* — regardless of which repo or directory they're in —
converge on a shared, compact picture of what every peer session is focused on, what it
recently did, and any problems it ran into. Convergence is eventual and automatic: no
session has to remember to sync, ask another session what it's doing, or paste anything
across terminals. A session finds out about its peers' progress the moment it next talks
to the model, via a small, clearly-labeled block of background context — never by sharing
full transcripts, and never as instructions the model is expected to act on unprompted.

Sessions that don't opt in are completely unaffected. Plain `claude` behaves exactly as it
always has, with zero added files and effectively zero added latency.

## How it works, in short

Each opted-in session's hooks append small structured events (prompts, file touches,
session start/end) to a per-session journal. A background daemon watches those journals,
periodically asks a small model to fold new events into a terse per-session recap
(*"working on X, recently did Y, hit problem Z"*), and folds every session's recap into one
shared **digest** for the group. Each session tracks a version cursor; whenever the
group's digest has moved past what a session has seen, its next turn gets that delta
injected as background context. Nothing is pushed proactively into a running turn, no
peer's full conversation is ever read, and the daemon degrades gracefully — if it's down,
journaling continues and hooks stay fast, sessions just stop getting fresher recaps until
it's back.

See [Architecture](#architecture) below for the full mechanics.

## Requirements

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code](https://claude.com/claude-code) (the `claude` CLI)

## Install

```sh
git clone https://github.com/AndyHarman-dev/claude-sync.git
cd claude-sync
bun install
bun bin/claude-sync install
```

This is safe and reversible:

- Backs up `~/.claude/settings.json` before touching it (a timestamped copy is saved
  alongside it).
- Merges four hook entries into it — identified by a sentinel in their command string, so
  re-running install is idempotent and uninstalling only ever removes claude-sync's own
  entries, never another tool's hooks on the same event.
- Symlinks the `/sync` skill into `~/.claude/skills/sync`.
- Symlinks the `claude-sync` and `csync` binaries into `~/.local/bin`.
- Creates an empty `~/.claude-sync/` data directory.

Plain `claude` sessions are unaffected by any of this: the hooks check for group
membership first and exit immediately if there is none, before touching the filesystem.

### Project-scoped install

To wire claude-sync into a single project instead of globally — so only sessions started
in that project ever see it at all — pass `--project` from inside that project's directory:

```sh
bun /path/to/claude-sync/bin/claude-sync install --project
```

This writes the hooks and the `/sync` skill into `<project>/.claude/` instead of
`~/.claude/`. The `claude-sync`/`csync` binaries are still installed globally either way —
they're shared tooling, not something that makes sense to duplicate per project. Combine
with `--cwd <path>` to target a project directory other than the current one.

### Uninstall

```sh
claude-sync uninstall            # remove hooks, skill, and binary symlinks
claude-sync uninstall --purge    # also delete ~/.claude-sync (all groups' data)
claude-sync uninstall --project [--cwd <path>]   # mirror of a --project install
```

## Usage

### Joining a group

Two ways to launch a session into a sync group, usable interchangeably and at the same
time across different repos:

**Launch synced from the start**, with the `csync` wrapper in place of `claude`:

```sh
csync my-project claude-args...
```

This sets `CLAUDE_SYNC_GROUP=my-project` and execs `claude`, so the session is a member
from its very first turn.

**Join an already-running plain session**, from inside it:

```
/sync join my-project
```

Sync activates on that session's next message — the join is staged as a pending ticket and
claimed by the hook on the next prompt, since only a hook invocation (not the CLI, run
standalone) knows the session's real session ID.

A group is just a name. Sessions in the same group converge regardless of which repository
or directory each one is running in — that's the point: a group can span your entire
microservice fleet.

### In-session commands (the `/sync` skill)

- **`/sync status`** — group membership, daemon state, and the current digest.
- **`/sync now`** — force an immediate re-summarization and pull the latest peer delta
  right now, instead of waiting for the next prompt's automatic check.
- **`/sync push "<message>"`** — pin a short note verbatim into the group digest for
  peers to see (e.g. "don't touch schema.sql, I'm mid-migration"), bypassing the
  summarizer entirely.
- **`/sync join <group>`** — join a group from a session that wasn't launched with
  `csync`.
- **`/sync leave`** — leave the current sync group.

### CLI reference

The skill is a thin wrapper over the `claude-sync` CLI, which also works standalone:

```
claude-sync status  [--cwd <path>] [--session <label>] [--group <group>]
claude-sync now     [--cwd <path>] [--session <label>] [--group <group>]
claude-sync push    "<message>" [--cwd <path>] [--session <label>] [--group <group>]
claude-sync leave   [--cwd <path>] [--session <label>] [--group <group>]
claude-sync join    <group> [--cwd <path>]
claude-sync daemon  <start|stop|status|ensure|foreground>
claude-sync install [--project] [--cwd <path>]
claude-sync uninstall [--project] [--cwd <path>] [--purge]
```

`--session <label>` disambiguates when more than one synced session shares the same
working directory; the label is the short identity ("you are sync session `<label>`")
each session is told at startup. `--group` further narrows the match. Without either,
commands fall back to the most recently active session for `--cwd` (defaulting to the
current directory).

## Architecture

```
Session A hooks ──append──▶ ~/.claude-sync/groups/<g>/journal/<A>.jsonl
                                       │
                              claude-sync daemon (polls every 2s)
                              debounce 10s / max staleness 60s
                                       │
                              claude -p --model haiku  (small, cheap, tool-free)
                                       │
                              recaps/<A>.json ──▶ rebuild digest.json (version++)
                                       │
Session B's next UserPromptSubmit: its cursor < digest.version → inject the delta
```

- **Hooks are dumb and fast.** They append a journal line, heartbeat, read the
  already-computed digest, and inject a delta if stale — never calling the model or
  blocking on the daemon. Everything is wrapped so a hook failure can never break the host
  session.
- **The daemon owns all writes** to recaps and the digest — a single writer per file means
  no locking beyond a plain `O_EXCL` pidfile lock and a per-group in-process async lock
  around digest read-modify-write cycles.
- **Summarization is fully async and best-effort.** A failure just leaves the digest
  stale — never wrong — which is the whole eventual-consistency guarantee: sessions
  converge as soon as the daemon catches up, and nothing blocks on it in the meantime.
- **A pure fast path for notes**: `/sync push` lines skip the model entirely and go
  straight into the digest as a pinned, verbatim note.

### On-disk layout (`~/.claude-sync/`, or `$CLAUDE_SYNC_DATA_DIR` if set)

```
daemon/{daemon.pid, daemon.sock, daemon.log}
sessions/<session_id>.json                  # membership marker
pending-joins/<munged-cwd>.json             # bridges /sync join to session_id
groups/<group>/
  journal/<session_id>.jsonl                # append-only, one writer (that session's hooks)
  recaps/<session_id>.json                  # daemon-only writer
  cursors/<session_id>.json                 # what digest version this session has seen
  digest.json                               # daemon-only writer, monotonically versioned
```

Every JSON file is written via tmp-file-then-rename for crash safety. A recap holds a
capped `focus` (≤240 chars), up to 5 `recent` items (≤140 chars each), up to 3 `problems`
(≤160 chars each), and an optional pinned note (≤280 chars) — small enough that injecting
several peers' worth of context costs a session very little.

### Liveness and cleanup

- A prompt heartbeats `last_seen`; ending a session (or `/sync leave`) marks it `ended`.
- Ended sessions are kept visible as tombstones for 15 minutes ("left the group") before
  being folded into a persistent, capped (1200 char) `history` string on the digest and
  removed — so a session joining a group days later still gets the gist of who was there
  and what they did, without the digest growing without bound.
- A session that goes silent for 2 hours without a clean end is treated the same way
  (crash recovery).
- Per-session journal/recap/cursor files are garbage-collected 24 hours after last
  modification. Groups and their digests are **never** deleted automatically — only an
  explicit `claude-sync uninstall --purge` removes data.

### Non-goals (v1)

- No sharing of full conversation transcripts between sessions — only compact recaps.
- No automatic file-lock or edit-conflict warnings across sessions (the injected context
  can surface "I'm mid-edit on X" via `/sync push`, but there's no enforcement).
- No MCP server — a background daemon, a small CLI, and four hooks cover the whole
  mechanism.

## Development

```sh
bun test          # full test suite
bun run daemon    # run the daemon in the foreground for debugging
```

`CLAUDE_SYNC_DATA_DIR` overrides the data root for any command — tests use it to run
against a disposable temp directory instead of `~/.claude-sync`.
