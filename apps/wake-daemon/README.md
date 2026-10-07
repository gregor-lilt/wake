# wake-daemon

The live side of Wake. Serves the map document, streams what Claude Code does
over a WebSocket, and keeps the map current while files change. The contract
is [docs/protocol.md](../../docs/protocol.md) (version 1); the document model
is the export schema (packages/export, schemaVersion 3).

Runtime: **Bun 1.4** (Bun.serve with native WebSocket, Bun.spawn for the
indexer). The code uses web-standard Request/Response and node: built-ins
only, so it also runs on Node >= 23.6 with the `ws` package
(`npm run serve:node`), which is what the `node` fallback in
`src/server.ts` and `src/runtime.ts` is for.

## Run

```sh
cd apps/wake-daemon
bun install

# once per repository: http hooks into .claude/settings.local.json, .wake/ into git's exclude
bun run src/main.ts init  --repo /path/to/repo [--port 7777]

# the daemon
bun run src/main.ts serve --repo /path/to/repo [--port 7777] [--fence 'protected/**']...
```

The repository path only ever comes from the command line. There is no
default. `WAKE_PORT` overrides the default port, `WAKE_PERMISSION_TIMEOUT` the
PermissionRequest hold (600 s).

On start, `serve`:

1. builds `target/release/wake-index` if it is missing (`cargo build --release`),
2. runs one `wake-index index <repo>` pass (cold or warm, the indexer decides),
3. builds the map document exactly as `packages/export` does, worktree mode
   (`buildTreeAndRects` + `readIndex`, imported, not copied), and warms a
   persistent `LayoutState` with the same tree so later changes take the
   layout module's incremental path,
4. starts `wake-index watch <repo>` as a child and parses its per-file lines,
5. listens on loopback: `GET /map`, `/file?path=`, `/diff?path=`, `/health`,
   `POST /hook`, and `ws://127.0.0.1:<port>/live`.

## Transcript mode

```sh
bun run src/main.ts serve --repo /path/to/repo --transcript ~/.claude/projects/<slug>/<session>.jsonl
```

No hooks at all: the daemon tails that transcript every 500 ms with the same
`buildSession` parser and emits every new event, not only assistant text.
This is how `wake --live` watches a session that was started before Wake,
or from another directory, without restarting it. A fresh edit is held back
up to 4 s until its tool result carries the line range. The session is
`running` while the file grows and `idle` after 30 s of quiet. Steering
(fences, permission holds) needs hooks and is off in this mode.

Files the watcher reports that git ignores (build output such as `dist/`)
are not added to the map.

## What streams

- `hello`, then `snapshot` (the last 5000 events of the primary session), then
  live frames. `ping` answers `pong`.
- `event`: hooks are mapped into export-shaped SessionEvents (`id`, `wall`
  added). To keep the export's title, summary, kind and path rules without
  duplicating them (its helpers are not exported), every hook that maps to an
  event is written as a Claude-Code-shaped record into a synthetic transcript
  under the OS temp dir and parsed with `buildSession`. Tool events fire on
  PreToolUse; Edit/Write/MultiEdit/NotebookEdit wait for PostToolUse so the
  event carries the `structuredPatch` line range. UserPromptSubmit becomes the
  `User prompt` message. Subagent hooks (`agent_id`) land in a synthetic
  `subagents/agent-<id>.jsonl` so the parser tags them with `agentId` and
  `agentType`.
- `message` events for assistant text: no hook carries it, so the transcript
  named by `transcript_path` is tailed (on every hook and every 500 ms),
  parsed with the same `buildSession`, filtered to assistant messages and
  de-duplicated.
- `session`: `running` on SessionStart/UserPromptSubmit, `idle` on Stop,
  `ended` on SessionEnd.
- `invalidate` + `node`: the watcher reports a changed file, the daemon
  recounts its effective lines (packages/layout `effectiveLinesOnDisk`),
  relayouts with the persisted `LayoutState`, and emits `node` only for rects
  that actually changed (files and, when a region grows, their directories).
  New files get new ids, ids are never renumbered. Deleted files keep their
  footprint, like the export's worktree mode.
- `edges`: after each watch batch the import edges are re-read from the
  wake-index SQLite and diffed. Symbol nodes are replaced in `/map` with fresh
  ids (protocol 1 has no symbol delta).
- `permission`: a PermissionRequest hook is held open (spike 4 logic) until a
  `decision` client frame or the timeout, which falls back to pass-through.
  PreToolUse fences (`--fence <glob>`) deny writers with a reason.

Every SessionEvent and every node/invalidate/edges delta of the primary
session is appended to `<repo>/.wake/live/<sessionId>.jsonl`, one frame per
line.

### Several sessions at once

Claude Code runs short helper sessions next to the user's (a prompt, no tools,
SessionEnd seconds later) that hit the same hook endpoint. The daemon keeps a
store and a log file per session id and streams one primary: the first
session seen, until another session sends a tool hook while the primary has
none or is not running, or sends a prompt after the primary ended. Promotion
is announced with a `session` frame; a
client that wants the new session's history refetches `/map`.

## init

`init --repo <path> [--port]` merges one http hook group per event into
`<repo>/.claude/settings.local.json` (created if missing, every other key
kept, an earlier Wake group replaced by url so re-running is idempotent):
SessionStart, UserPromptSubmit, PreToolUse(*), PostToolUse(*),
PostToolBatch, PermissionRequest(*), SubagentStart, SubagentStop, Stop,
SessionEnd. Timeouts: 600 s for PermissionRequest, 10 s for the tool hooks,
5 s for the rest, 1 s for SessionEnd. It then appends `.wake/` to
`<common git dir>/info/exclude`, resolved with `git rev-parse --git-common-dir`
so a worktree is handled. Run it before `serve`: the daemon warns when
`.wake/` is not ignored, because the event log would otherwise appear on the
map as untracked files.

## Test

```sh
bun run src/e2e.ts --repo /path/to/repo [--port 7791]
```

No interactive session needed. It runs `init`, a static export
(`packages/export`, on Node), starts `serve`, compares `GET /map` with the
export, connects to `/live`, runs a headless
`claude -p "<read two files, no edits>" --permission-mode acceptEdits --max-turns 6`
inside the target repository (real http hooks), then appends a line to a
tracked file and restores it. Everything it touched is put back, including
`.claude/settings.local.json` when it did not exist before.

Result on the target repository (a git worktree with uncommitted changes),
2026-09-03, Bun 1.4.0, Claude Code 2.1.259: **26 of 26 checks pass** in
about 22 s.

- `GET /map`: 90 dirs, 357 files, 3021 symbols, 447 rects, 582 import edges,
  3578 symbol edges, byte-identical rects to the static export.
- `/live`: hello, snapshot, pong; then 4 `event` frames from the headless run
  (1 user prompt, 2 reads mapped to file nodes, 1 assistant message from the
  transcript tail), `session` running, idle (Stop), ended (SessionEnd),
  monotonic ids, the same events in `GET /map`, and the
  `.wake/live/<sessionId>.jsonl` log.
- File touch: `invalidate` within the watcher's 1 s debounce, 2 `node` frames
  (the tile grew one height step and its region followed), `invalidate` again
  on restore, file restored byte for byte.
- Node 23.9 fallback smoke (`serve:node`): health, `/map`, hello, snapshot,
  pong, layout identical. The headless run was only exercised on Bun.

## Findings against docs/protocol.md and the hook payloads

- Hooks carry no assistant text, as expected; the transcript tail covers it.
  `claude -p` does write a transcript under `~/.claude/projects/`.
- `SessionStart` did not fire for the headless run (as in spike 4).
  UserPromptSubmit and Stop did, so `session` still moves running -> idle.
  SessionEnd fired.
- Three session ids shared one hook endpoint during a single `claude -p` run:
  the working session, one with a prompt and a SessionEnd three seconds later
  and no tools, and one that sent only SessionEnd (see above). Protocol 1
  has a single `sessionId` in `hello`/`health`; the daemon resolves that with
  the primary rule rather than a protocol change.
- The protocol's `node` frame says FileNode; region growth also changes
  directory rects, and the daemon emits those as `node` frames with a
  `kind: 'dir'` node. A client that keys rects by id needs no special case.
- Bun 1.4 `node:sqlite`: a `readOnly` open of a WAL database fails with
  "unable to open database file" when the `-shm`/`-wal` sidecars are absent
  (Node accepts it). `packages/export`'s `readIndex` opens read-only, so the
  daemon holds one read-write connection for its lifetime to keep the
  sidecars present. The static export itself hits the same quirk under Bun,
  hence the e2e runs that step on Node.
- Not built (stubs): the PostToolBatch stop gate from spike 4, `decision`
  rewrites beyond `updatedInput` merge, symbol-level deltas, removal of
  deleted nodes.
