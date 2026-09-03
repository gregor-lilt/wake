# spike-hooks

Spike 4 from `docs/spikes.md`: does the Claude Code http hook round-trip
behave as documented? Hooks in, fence out, PermissionRequest held open until a
human clicks, PostToolBatch gate that stops the loop.

Node built-ins only. TypeScript is run through `node --experimental-strip-types`,
no bundler, no Bun. `typescript` and `@types/node` are devDependencies for
`npm run typecheck` and are not needed to run anything.

## Files

| Path | What |
|---|---|
| `src/server.ts` | The whole thing. HTTP server on 127.0.0.1:7777, hook endpoint, SSE stream, inline UI page. |
| `src/selftest.ts` | Spawns the server on port 7788 and posts synthetic payloads. 44 assertions. |
| `scratch-project/` | Toy repo for a live session, with `.claude/settings.json` wiring six hook events. |
| `scratch-project/.claude/settings.local.json.example` | Deny rules for `protected/**`, to test hot reload mid-session. |
| `RUNBOOK.md` | The at-the-keyboard procedure and the verdict form. |
| `events.jsonl` | Every raw hook payload, one JSON line, appended. Gitignored. |
| `fences.json` | Fence globs, written by the UI. Gitignored, defaults to `["protected/**"]`. |

## Run

```sh
npm run start        # http://127.0.0.1:7777
npm run selftest     # no live session needed
npm run typecheck    # needs npm install first
```

Env: `WAKE_PORT`, `WAKE_HOST`, `WAKE_EVENTS_FILE`, `WAKE_FENCES_FILE`,
`WAKE_PERMISSION_TIMEOUT` (seconds a PermissionRequest is held, default 300).

## HTTP surface

| Route | Purpose |
|---|---|
| `POST /hook` | Claude Code http hooks. Dispatches on `hook_event_name`. |
| `GET /` | UI: event list, pending approvals with diff, fence editor, stop button. |
| `GET /events` | SSE. `event: event` per hook, `event: state` for pending/fences/gate. |
| `GET /api/state` | Same data as JSON, for scripts and the selftest. |
| `POST /api/decision` | `{id, action: allow\|deny\|rewrite, new_string?, message?}`. Releases a held request. |
| `POST /api/fences` | `{fences: string[]}`. Persisted, effective immediately, no restart. |
| `POST /api/stop-after-batch` | `{enabled: true}`. Arms the one-shot PostToolBatch gate. |

Responses the server sends back to Claude Code:

- PreToolUse, fenced write: `hookSpecificOutput.permissionDecision = "deny"` plus a reason.
- PreToolUse, anything else: `{}` (no opinion, normal flow continues).
- PermissionRequest: held, then `hookSpecificOutput.decision` with
  `behavior: "allow"` (optionally `updatedInput` for a rewrite) or
  `behavior: "deny"` with a message. On timeout `{}`, so the terminal prompt stands.
- PostToolBatch, gate armed: `continue: false` and `stopReason: "Stopped from Wake"`,
  then the gate disarms itself.

## Schema notes, docs vs observed (2026-09-02, Claude Code 2.1.258)

Checked against https://code.claude.com/docs/en/hooks.md and against real
payloads captured from `claude -p` runs in `scratch-project`.

1. **`async` is not available to http hooks.** The docs list `async` and
   `asyncRewake` under command hook fields only, and the common fields table
   has neither. `docs/research/04-claude-code-integration.md` section 10
   ("mark every non-gating hook async") therefore cannot be done with http
   hooks. Nothing in `scratch-project/.claude/settings.json` sets `async`.
   Latency control for non-gating events has to come from short `timeout`
   values, or from command hooks that fan out to Wake.
2. **`PostToolBatch` continue/stopReason placement.** `hooks.md` documents
   both inside `hookSpecificOutput`, the SDK type in the research doc has them
   at the top level of `SyncHookJSONOutput`. The server sends both. The
   observed stop worked, so at least one placement is honoured (not
   distinguished by this spike).
3. **`PostToolBatch.tool_calls` element shape.** Docs say
   `{tool_use_id, tool_name, tool_input, success, output}`. Observed:
   `{tool_name, tool_input, tool_use_id, tool_response}`. No `success`, no
   `output`. Wake should read `tool_response`.
4. **`Stop` payload.** Docs list `stop_reason`. Observed fields:
   `stop_hook_active, last_assistant_message, background_tasks, session_crons`.
   No `stop_reason`.
5. **Undocumented extras present on real payloads:** `prompt_id`,
   `effort: {level}`, `duration_ms` on PostToolUse. These match the research
   doc, not the public hooks reference.
6. **PostToolUse `tool_response` for Edit** carries
   `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}`.
   `structuredPatch` hunks are `{oldStart, oldLines, newStart, newLines, lines}`.
   That is the diff Wake needs, straight off the hook, without touching the
   transcript JSONL.

## Headless probe, what fired without a human

Three `claude -p` runs in `scratch-project` against a live server. All
non-interactive, none needed an answer at the terminal.

| Probe | Command | Result |
|---|---|---|
| Tool round-trip | `claude -p "... Edit greet.ts ..." --permission-mode acceptEdits --output-format stream-json --verbose` | http hooks fired for real. Arrived: PostToolUse(Read), PostToolBatch, PreToolUse(Edit), PostToolUse(Edit), PostToolBatch, Stop. Every PostToolUse carried `tool_input` and `tool_response`. |
| Fence | `claude -p "Write to protected/config.ts ..." --permission-mode acceptEdits` | PreToolUse deny worked. The agent replied `BLOCKED` and quoted the fence reason, the file was unchanged. |
| Batch gate | arm `/api/stop-after-batch`, then a three-read prompt | Loop stopped after the first batch. `num_turns: 2`, empty result, the second and third reads never happened. |

Two things headless mode could **not** show, they need the interactive session
in `RUNBOOK.md`:

- **`SessionStart` never fired** under `claude -p`. The hook is wired, and the
  event simply does not occur for a headless run.
- **`PermissionRequest` never fired**, not even in default permission mode
  without `--permission-mode acceptEdits`. The Edit was applied without any
  permission event, so the held-open approval, the reject and the
  `updatedInput` rewrite are only exercised by the selftest so far. The
  selftest covers the full protocol (hold, allow, deny, rewrite, timeout,
  stale id), the runbook covers whether Claude Code honours it.

The raw payloads from those three probes are kept in `probe-events.jsonl`
(gitignored) so the field shapes above can be re-checked without a new run.
