# Wake live protocol

Contract between the daemon (`apps/wake-daemon`) and the map client. Version 1.
The static export format (packages/export, schemaVersion 3) is the document
model. The live protocol delivers that document once and then streams deltas.

## HTTP

- `GET /map` → the map document, identical to a packages/export file
  (schemaVersion 3): repo, nodes, rects, edges, symbolEdges, session. The
  session part holds the events observed so far in the current session.
- `GET /file?path=<repo-relative>` → current file text (validated against the
  node list, resolved inside the repo root).
- `GET /diff?path=<repo-relative>[&since=head|session]` → unified diff of the
  working tree for that file. `since=head` (the default) is plain `git diff
  HEAD`: what is not committed yet. `since=session` diffs against the session
  baseline, the commit HEAD pointed at when the primary session started (from
  the reflog), so work the session committed stays visible. A file not in the
  base diffs against `/dev/null`.
- `GET /changes[?since=head|session]` → `{ base, files: [{ path, added,
  removed, created }] }`: every file on the map that differs from that base,
  plus untracked files (wholly added). Binary files report 0/0.
- `POST /hook` → Claude Code http hook endpoint. Accepts every hook event the
  plugin registers. Responds per the Claude Code hook output schema. Pass
  through (empty object) for everything that is not a steering decision.
- `GET /health` → `{ ok: true, repo, sessionId, indexed: <bool> }`.

## WebSocket `/live`

Server to client messages, JSON, one per frame:

- `{ "type": "hello", "protocol": 1, "repo": {...}, "sessionId": string|null }`
  first message after connect.
- `{ "type": "snapshot", "events": [SessionEvent...] }` right after hello, the
  events already observed in the current session, in order.
- `{ "type": "event", "event": SessionEvent }` one new session event. The
  SessionEvent shape is exactly packages/export's session event (t, kind,
  tool, nodeId, path, lineStart, lineEnd, summary, title, text, role,
  command, agentId, agentType) plus `id` (monotonic integer) and `wall` (ISO
  timestamp).
- `{ "type": "node", "node": Node, "rect": [id,x,y,w,h] }` a node was added
  or its layout rect changed: a file (new file, folded state change, height
  step change) or a directory whose region grew or moved because a child
  changed. Node is the export's node shape, `kind` tells which.
- `{ "type": "invalidate", "nodeId": int, "effectiveLines": int }` a file's
  content changed on disk; the client refetches text and diff and re-tokenizes.
- `{ "type": "edges", "added": [Edge...], "removed": [Edge...] }` import edge
  changes after a reindex of changed files.
- `{ "type": "session", "state": "idle"|"running"|"ended", "sessionId": string|null }`
  session lifecycle from SessionStart, Stop, SessionEnd hooks.
- `{ "type": "permission", "requestId": string, "toolName": string, "input": object }`
  a PermissionRequest hook is being held open for a decision (steering,
  later milestone; the daemon may emit it already).

Client to server messages:

- `{ "type": "decision", "requestId": string, "behavior": "allow"|"deny", "updatedInput"?: object, "message"?: string }`
  answers a held permission request (later milestone).
- `{ "type": "ping" }` → server answers `{ "type": "pong" }`.

## Event sourcing

The daemon appends every SessionEvent and every node/invalidate/edges delta
to `.wake/live/<sessionId>.jsonl` in the target repo (gitignored by the
plugin's init). A client that connects late gets the snapshot; a replay tool
can read the file directly. Responses to external queries that feed the map
(indexer results, layout output) are derived from the repository state and
are recomputed, not logged.

## Ports and discovery

- Default port 7777, override with `WAKE_PORT`. Loopback only.
- The plugin's hooks point at `http://127.0.0.1:<port>/hook`.
- `wake init <repo>` writes the hooks into `<repo>/.claude/settings.local.json`
  (merging, never overwriting other settings) and adds `.wake/` to
  `.git/info/exclude`.

## Sessions

A single `claude` run can hit the hook endpoint from several session ids (the
working session plus helper sessions that make no tool calls). The daemon
picks a primary session: the first id that produces a tool event, or the most
recent SessionStart, and reports only that id in `hello` and `session`
messages. Events from other ids are logged but not broadcast. `SessionStart`
does not fire for headless `claude -p` runs, so the primary rule must not
depend on it.
