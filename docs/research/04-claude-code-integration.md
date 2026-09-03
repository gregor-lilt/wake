# Research: Claude Code integration surfaces and existing UIs

Raw research report, 2026-09-02. Verified against Claude Code CLI 2.1.258
(local install, transcripts inspected), @anthropic-ai/claude-agent-sdk 0.3.258
(sdk.d.ts read directly), MCP spec 2026-07-28. Docs live at
code.claude.com/docs (moved from docs.anthropic.com). Field names below are
ground truth from types and live files, not paraphrase. Uncertain items are
marked (unverified). Synthesis in ../research-stack.md.

## 1. Headline findings that change Wake's design

1. Hooks have an `http` handler type. `{"type":"http","url":"http://127.0.0.1:PORT/hook"}`.
   Claude Code POSTs the hook JSON and reads the JSON verdict from the response
   body. Wake's local server needs no shell scripts for live ingest, fencing,
   or approval. The single most important surface.
2. 33 hook events, including several that map 1:1 onto Wake features:
   PermissionRequest, PermissionDenied, FileChanged, MessageDisplay,
   SubagentStart, PostToolBatch, CwdChanged, ConfigChange, TaskCreated,
   TaskCompleted.
3. Settings files hot-reload, including permissions and hooks. Wake can fence a
   path by writing .claude/settings.local.json mid-session, effective without a
   restart.
4. The Agent SDK ships read-only session APIs: listSessions, getSessionInfo,
   getSessionMessages, listSubagents, getSubagentMessages, forkSession. Replay
   does not require hand-parsing JSONL.
5. TodoWrite is gone on current models. Replaced by
   TaskCreate/TaskUpdate/TaskGet/TaskList, off by default on Opus 4.8 / Sonnet
   5 / Fable 5. Zero TodoWrite occurrences across 40 recent local transcripts.
   Plans live as markdown at ~/.claude/plans/<slug>.md, linked from transcript
   records by a `slug` field.
6. Subagents no longer use isSidechain. They get their own files:
   ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl plus
   agent-<id>.meta.json with agentType, description, toolUseId, parentAgentId,
   spawnDepth. isSidechain is present but always false.
7. The IDE integration is an officially documented WebSocket MCP server that
   the editor hosts and the CLI connects to. Wake can write
   ~/.claude/ide/<port>.lock and present itself as an IDE. That gives openDiff
   (returns FILE_SAVED or DIFF_REJECTED, approve-in-place natively),
   at_mentioned with lineStart/lineEnd (anchored comments natively), plus
   selection and open-editor context.
8. Channels (research preview) let an MCP server push into a running
   interactive session (notifications/claude/channel) and receive permission
   prompts. Powerful, but gated behind an Anthropic-curated allowlist.
9. MCP Apps cannot render UI inside Claude Code. ext-apps supported clients are
   ChatGPT, Claude (claude.ai/desktop), VS Code, Goose, Postman. Not Claude
   Code. Wake's UI must be its own window.
10. ToS risk on the SDK path. code.claude.com/docs/en/legal-and-compliance says
    developers building products "including those using the Agent SDK, should
    use API key authentication", and Anthropic "does not permit third-party
    developers to route requests through Free, Pro, or Max plan credentials on
    behalf of their users." Carve-out: "an end user signing in to the
    unmodified Claude Code binary with their own Claude subscription."
    d-kimuson/claude-code-viewer read this as prohibiting SDK-driven chat and
    shipped a subscription mode that disables its own chat. Strongly favors
    Wake attaching to the user's own `claude` process over driving one via
    the SDK.

## 2. Integration surfaces

| Surface | What it gives Wake | Latency | Steer? | Stability / risk |
|---|---|---|---|---|
| http hooks to Wake's localhost server | Every tool call pre/post with tool_name, tool_input, tool_use_id, tool_response, duration_ms, cwd, session_id, transcript_path | Synchronous in-band. Default timeout 600s, 30s UserPromptSubmit, 10s MessageDisplay, 1.5s SessionEnd | Yes: deny/allow/ask, rewrite updatedInput, block Stop, inject additionalContext | Documented, stable. Best surface. If Wake is down the hook is a non-blocking error |
| PermissionRequest hook | Fires only when a decision is needed. Returns decision object: allow + updatedInput/updatedPermissions, or deny + interrupt | Blocks the prompt | Yes, approve-in-place incl. edit rewriting | Documented. Exit code ignored, must return JSON |
| .claude/settings.local.json deny rules | Fence paths: Edit(/src/**), Read(//abs/**), gitignore syntax | Hot-reloaded on save | Yes, declarative fencing | Documented. Best fencing mechanism |
| Transcript JSONL tail | Full history incl. toolUseResult.structuredPatch (hunks with oldStart/newStart/lines), an actual diff per edit | File-write cadence | No | Officially "internal to Claude Code and changes between versions" |
| SDK session read APIs | Same data, supported | Poll | forkSession only | Documented, TS + Python. Use for replay |
| CLI -p --output-format stream-json | Full typed event stream | Real-time, --include-partial-messages gives deltas | With --input-format stream-json | Documented. But it is a new session Wake spawns, not the user's |
| Agent SDK query() / ClaudeSDKClient | Everything: canUseTool, interrupt(), in-process hooks, setPermissionMode, stopTask, rewindFiles, applyFlagSettings, readFile, setMcpServers | Real-time | Fully | Documented, but ToS expects API-key auth for third-party products |
| IDE MCP over WebSocket (~/.claude/ide/<port>.lock) | openDiff (FILE_SAVED/DIFF_REJECTED), at_mentioned {filePath, lineStart, lineEnd}, selection_changed, getOpenEditors, getDiagnostics, openFile | Real-time, bidirectional | Yes, diffs and anchored comments | Half-documented. Transport/auth/lock file official (vs-code.md), the 12-tool schema is reverse-engineered (coder/claudecode.nvim PROTOCOL.md). No versioning guarantee |
| Channels (MCP) | Push text + meta map into a running interactive session, receive and answer permission prompts | Between tool calls or as new turn | Yes | Research preview plus allowlist. Needs --dangerously-load-development-channels server:wake |
| Session inbox socket ($CLAUDE_CODE_MESSAGING_SOCKET) | A script posts a message into a session, auth line with $CLAUDE_CODE_MESSAGING_TOKEN | Immediate | Text only | Documented as a surface, message-line schema not documented |
| Discovery: ~/.claude/sessions/<pid>.json | Live registry: pid, sessionId, cwd, version, kind, entrypoint, messagingSocketPath, name, status (busy/idle), updatedAt, peerFeatures | Seconds | No | Undocumented, stable-looking, verified live |
| Discovery: claude agents --json | {cwd, kind, startedAt, id, state, pid, status, waitingFor, sessionId, name}, state in working/blocked/done/failed/stopped | Poll | claude attach/stop/logs <id> | Documented |
| ~/.claude/plans/<slug>.md | Plan-mode document, slug on transcript records | File watch | No | Undocumented path |
| MCP tools Wake exposes (stdio / http / ws) | Agent calls wake_tour_stop(...) etc. ws transport suits servers that push | Per tool call | Agent-initiated | Documented, stable. The right surface for the tour |
| Statusline command | Session JSON incl. transcript_path, cost | Per render | No | Low value |
| MCP Apps (ui://) | none | | | Not supported by Claude Code |
| Remote Control | claude.ai/mobile window into the local session | | Anthropic's UI only | Closed, not a third-party attach point |

## 3. Hooks in detail

### All 33 events (HookEvent union in sdk.d.ts, identical to docs)

PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop,
StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact,
PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
FileChanged, DirectoryAdded, MessageDisplay.

### Five handler types

command (default), http, mcp_tool, prompt (Haiku evaluator, 30s), agent
(subagent verifier, experimental, 60s).

```json
{ "type": "http",
  "url": "http://127.0.0.1:7777/hook",
  "headers": { "Authorization": "$WAKE_TOKEN" },
  "allowedEnvVars": ["WAKE_TOKEN"],
  "timeout": 600,
  "statusMessage": "Wake",
  "if": "Edit(src/**)" }
```

POST body is the same JSON a command hook gets on stdin, response body the same
JSON output format. Non-2xx, invalid JSON, or timeout is a non-blocking error
(the action proceeds).

### Input schema (BaseHookInput)

```
session_id, transcript_path, cwd, prompt_id?, permission_mode?,
effort?: {level}, hook_event_name, agent_id?, agent_type?
```

Per-event additions:

```
PreToolUse            : tool_name, tool_input, tool_use_id
PostToolUse           : + tool_response, duration_ms?
PostToolUseFailure    : + tool_response
PostToolBatch         : tool_calls: PostToolBatchToolCall[]
PermissionRequest     : tool_name, tool_input, permission_suggestions?: PermissionUpdate[]
PermissionDenied      : tool_name, tool_input, decision:{default,reason}
FileChanged           : file_path, event: 'change'|'add'|'unlink'
MessageDisplay        : turn_id, message_id, index, final, delta
SubagentStart         : agent_id, agent_type
SubagentStop          : agent_id, agent_transcript_path, agent_type,
                        last_assistant_message?, background_tasks?
SessionStart          : reason: 'startup'|'resume'|'clear'|'compact'|'fork', model?
Stop / SubagentStop   : last_assistant_message
ConfigChange          : source: user_settings|project_settings|local_settings|
                        policy_settings|skills, file_path?
```

permission_mode in default | plan | acceptEdits | auto | dontAsk |
bypassPermissions.

### Output schema

```ts
SyncHookJSONOutput = { continue?, suppressOutput?, stopReason?,
  decision?: 'approve'|'block', systemMessage?, terminalSequence?, reason?,
  hookSpecificOutput? }

PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow'|'deny'|'ask'|'defer';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;   // rewrite the tool args
  additionalContext?: string; }

PermissionRequestHookSpecificOutput = {
  hookEventName: 'PermissionRequest';
  decision: { behavior:'allow'; updatedInput?; updatedPermissions?: PermissionUpdate[] }
          | { behavior:'deny'; message?; interrupt? }; }

AsyncHookJSONOutput = { async: true, asyncTimeout? }
```

### Exit codes

0 = proceed (stdout parsed as JSON if it is a JSON object). 2 = blocking
(blocks PreToolUse, UserPromptSubmit, Stop, SubagentStop, PostToolBatch,
TaskCreated, TaskCompleted, ConfigChange, PreModelSwitch, WorktreeCreate.
Ignored for PermissionRequest, use the decision object). Other codes are
non-blocking except WorktreeCreate.

### Async and rewake

"async": true runs in background, no timeout. "asyncRewake": true runs in
background and wakes Claude on exit code 2, showing stderr as a system
reminder. A legitimate way for Wake to interrupt or steer out-of-band.

### Matchers

"*" or omitted = all. Plain names or Edit|Write = exact list. Anything else is
an unanchored regex. MCP tools match mcp__<server>__<tool>. Also "if":
"<permission rule>" for pre-filtering, and ${CLAUDE_PROJECT_DIR} /
${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA} placeholders.

### Where hooks can be declared

~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json,
managed policy, plugin hooks/hooks.json, and skill/subagent frontmatter
(hooks: field, registered when the skill is invoked, kept for the session).
disableAllHooks: true kills all but managed ones.

## 4. Transcript JSONL, current format (v2.1.25x)

~/.claude/projects/<cwd-with-non-alnum-to-dashes>/<session-uuid>.jsonl.
Officially: "The entry format is internal to Claude Code and changes between
versions, so scripts that parse these files directly can break on any release."

Record type values observed across ~28k lines / 40 sessions:

```
assistant  user  attachment  system  mode  permission-mode  last-prompt
ai-title   atis-latch  file-history-snapshot  file-history-delta
queue-operation  agent-name  cost-state  pr-link  frame-link
artifact-comment-monitor  artifact-autoreact-ledger
```

system subtypes: turn_duration, away_summary, stop_hook_summary,
local_command, compact_boundary, informational.

Common envelope on message records:

```
parentUuid, isSidechain (always false now), uuid, timestamp, type,
message, userType, entrypoint, cwd, sessionId, session_id, version,
gitBranch, slug?, isMeta?, promptId?, permissionMode?, origin?, promptSource?
```

tool_use to tool_result linking, verified:

- assistant record: message.content[] { type:"tool_use", id:"toolu_...",
  name:"Edit", input:{...}, caller:{type:"direct"} }, plus wrapper requestId,
  effort, apiBlockIndex.
- user record: message.content[] { type:"tool_result",
  tool_use_id:"toolu_...", content:"..." }, plus two wrapper fields:
  - toolUseResult: the structured output. For Edit: { filePath, oldString,
    newString, originalFile, structuredPatch:[{oldStart, oldLines, newStart,
    newLines, lines[]}], userModified, replaceAll }. A ready-made diff per
    edit, exactly the payload for animating the map.
  - sourceToolAssistantUUID: direct back-pointer to the assistant record.

Other useful records:

- cost-state: totalCostUSD, totalAPIDuration, totalToolDuration,
  totalLinesAdded, totalLinesRemoved, modelUsage{model: tokens, costUSD}.
- file-history-snapshot / file-history-delta: messageId, snapshotMessageId,
  trackingPath, backup{backupFileName, version, backupTime, realParentDir}.
  Backs /rewind, stored under ~/.claude/file-history/.
- system/compact_boundary: compactMetadata{trigger, preTokens, postTokens,
  cumulativeDroppedTokens, durationMs, preservedSegment{headUuid, anchorUuid,
  tailUuid}, preservedMessages{anchorUuid, uuids[], allUuids[]}}, and the
  record carries logicalParentUuid (not parentUuid). A naive parent-chain walk
  breaks at compaction. Relink via preservedMessages.
- attachment records carry hook results: attachment{type:"hook_success",
  hookName:"SessionStart:startup", hookEvent, stdout, stderr, exitCode,
  command, durationMs}.

Subagents: <session-uuid>/subagents/agent-<id>.jsonl plus
agent-<id>.meta.json:

```json
{"agentType":"general-purpose","description":"...","toolUseId":"toolu_...",
 "parentAgentId":"...","spawnDepth":2}
```

Also <session-uuid>/tool-results/ holds spilled large tool outputs.

Plans: ~/.claude/plans/<slug>.md, slug field on transcript records is the
join key.

## 5. Agent SDK (TypeScript 0.3.258)

### query() and the Query interface

```ts
function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>
  setPermissionMode(mode), setModel(model?), setMaxThinkingTokens(n, display?)
  setMcpPermissionModeOverride(server, 'default'|'auto'|null)
  applyFlagSettings(settings)      // live-merge settings incl. permissions
  updateSettings('localSettings', {...})
  initializationResult(), reinitialize(), supportedCommands(), supportedModels(),
  supportedAgents(), mcpServerStatus(), getContextUsage({detail}), accountInfo()
  readFile(path, {maxBytes, encoding})      // "for the remote sidebar viewer"
  rewindFiles(userMessageId, {dryRun})      // needs enableFileCheckpointing
  seedReadState(path, mtime)
  reloadPlugins(), reloadSkills()
  setMcpServers(record), reconnectMcpServer(name), toggleMcpServer(name, enabled)
  stopTask(taskId), backgroundTasks(toolUseId?)
  close()
}
```

interrupt, setPermissionMode, setModel, applyFlagSettings are control
requests: streaming-input mode only. Single-shot query({prompt: "string"})
cannot be steered.

### Options (0.3.258)

abortController, additionalDirectories, agent, agents, allowedTools,
canUseTool, continue, cwd, disallowedTools, toolAliases, tools, env,
executable, executableArgs, extraArgs, fallbackModel, enableFileCheckpointing,
toolConfig, forkSession, betas, hooks, onElicitation, onUserDialog,
supportedDialogKinds, perTaskStopAffordance, persistSession, sessionStore,
sessionStoreFlush, loadTimeoutMs, includeHookEvents, includePartialMessages,
forwardSubagentText, thinking, effort, maxThinkingTokens, maxTurns,
maxBudgetUsd, taskBudget, mcpServers, model, outputFormat,
pathToClaudeCodeExecutable, permissionMode, planModeInstructions,
allowDangerouslySkipPermissions, permissionPromptToolName, plugins,
promptSuggestions, agentProgressSummaries, resume, sessionId,
resumeSessionAt, resumeDropsTurn, sandbox, settings, managedSettings,
settingSources, skills, debug, debugFile, stderr, strictMcpConfig,
systemPrompt, title, spawnClaudeCodeProcess.

```ts
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
HookCallbackMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number }
HookCallback = (input: HookInput, toolUseID: string|undefined, {signal}) => Promise<HookJSONOutput>
```

The public docs page renders a simplified {match, handle} shape. The shipped
types are the above. Trust the .d.ts.

### canUseTool, richer than documented

```ts
CanUseTool = (toolName, input, options: {
  signal, suggestions?: PermissionUpdate[], blockedPath?, decisionReason?,
  title?, displayName?, description?, toolUseID, agentID?, requestId, matchedAskRule?
}) => Promise<PermissionResult | null>

PermissionResult =
  | { behavior:'allow'; updatedInput?; updatedPermissions?: PermissionUpdate[]; toolUseID?; decisionClassification? }
  | { behavior:'deny';  message: string; interrupt?: boolean; toolUseID?; decisionClassification? }
```

PermissionUpdate types: addRules | replaceRules | removeRules | setMode |
addDirectories | removeDirectories, each with a destination. How Wake would
persist "always allow this folder" from its UI.

### SDKMessage union (38 members)

assistant, user, user_replay, result, system (many subtypes), stream_event,
plus tool_progress, tool_use_summary, task_started, task_updated,
task_progress, task_notification, background_tasks_changed,
session_state_changed, hook_started/hook_progress/hook_response,
permission_denied, compact_boundary, api_retry, commands_changed,
files_persisted, memory_recall, rate_limit, model_refusal_fallback,
conversation_reset, informational, mirror_error, plugin_install,
prompt_suggestion, thinking_tokens, active_goal, auth_status,
worker_shutting_down, local_command_output, control_request_progress,
elicitation_complete.

Wake-relevant shapes:

- SDKAssistantMessage: {type:'assistant', message: BetaMessage,
  parent_tool_use_id, uuid, session_id, request_id?, user_message_uuid?,
  aborted?, subagent_type?, task_description?, timestamp?, context_usage?,
  supersedes?}. One assistant message per completed content block while
  streaming, several share message.id, stop_reason null on those.
- SDKUserMessage: {type:'user', message: MessageParam, parent_tool_use_id,
  tool_use_result?, priority?:'now'|'next'|'later', origin?, shouldQuery?,
  uuid?, session_id?}. tool_use_result is "the tool's full Output object",
  the SDK equivalent of toolUseResult.
- SDKPartialAssistantMessage: {type:'stream_event', event, parent_tool_use_id,
  uuid, session_id, ttft_ms?}.
- SDKToolProgressMessage: {type:'tool_progress', tool_use_id, tool_name,
  elapsed_time_seconds, task_id?, heartbeat?, subagent_type?}. Good for a
  live spinner on the map.
- SDKSessionStateChangedMessage: {subtype:'session_state_changed',
  state:'idle'|'running'|'requires_action'}.
- SDKResultSuccess: {subtype:'success', duration_ms, duration_api_ms,
  ttft_ms?, num_turns, result, stop_reason, total_cost_usd, usage,
  modelUsage, permission_denials, queued_turn_count?, structured_output?,
  terminal_reason?}. total_cost_usd and modelUsage are cumulative running
  totals in streaming mode, read the latest, do not sum.
- SDKSystemMessage init: {apiKeySource, claude_code_version, cwd, tools[],
  mcp_servers[], model, permissionMode, slash_commands[], skills[], plugins[],
  agents?, betas?, effort?, capabilities?}. Feature-detect via capabilities
  (e.g. interrupt_receipt_v1) rather than version-sniffing.

### Session read/write APIs (the replay surface)

```ts
listSessions(opts?: {dir, limit, offset, includeWorktrees, includeProgrammatic, sessionStore}) : Promise<SDKSessionInfo[]>
getSessionInfo(sessionId, opts?)      : Promise<SDKSessionInfo|undefined>
getSessionMessages(sessionId, opts?: {dir, limit, offset, includeSystemMessages, sessionStore}) : Promise<SessionMessage[]>
listSubagents(sessionId, opts?)       : Promise<string[]>
getSubagentMessages(sessionId, agentId, opts?)
forkSession(sessionId, {upToMessageId, title}) : Promise<{sessionId}>
renameSession / tagSession / deleteSession
importSessionToStore(sessionId, store, opts?)   // alpha
resolveSettings(opts?)                          // alpha, merge engine with provenance

SDKSessionInfo = { sessionId, summary, lastModified, fileSize?, customTitle?,
                   firstPrompt?, gitBranch?, cwd?, tag?, createdAt? }
SessionMessage = { type:'user'|'assistant'|'system', uuid, session_id,
                   message: unknown, parent_tool_use_id, parent_agent_id }
```

Pluggable SessionStore (append/load/listSessions/listSessionSummaries/delete/
listSubkeys). Wake could register as a mirror of every SDK-driven session and
get batches at ~100ms cadence.

Python SDK: query(), ClaudeSDKClient (connect, query, receive_messages,
receive_response, interrupt, set_permission_mode, set_model, rewind_files,
get_mcp_status, stop_task, disconnect), list_sessions, get_session_messages,
get_session_info, rename_session, tag_session, tool(),
create_sdk_mcp_server(). Narrower than TS (no setMcpServers, readFile,
getContextUsage, applyFlagSettings, backgroundTasks).

Cost SDK vs CLI: identical model calls. SDK spawns the bundled binary. Extra
levers: maxBudgetUsd, taskBudget, modelUsage on every result. The real
difference is auth and licensing, not price.

## 6. CLI surface

```
-p/--print   --output-format text|json|stream-json   --input-format text|stream-json
--include-partial-messages      (needs --print --output-format stream-json)
--verbose                       (required with stream-json in most combos)
--replay-user-messages   --forward-subagent-text   --include-hook-events
--prompt-suggestions
-c/--continue   -r/--resume <id|name>   --fork-session   --session-id <uuid>   -n/--name
--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual
--permission-prompt-tool <mcp tool>     (non-interactive only)
--allowedTools   --disallowedTools
--dangerously-skip-permissions   --allow-dangerously-skip-permissions
--mcp-config <files|json>   --strict-mcp-config   --add-dir   --agents '<json>'
--settings <path|json>   --setting-sources user,project,local
--system-prompt[-file]  --append-system-prompt[-file]  --append-subagent-system-prompt
--json-schema '<schema>'   --max-turns   --max-budget-usd   --model   --effort   --fallback-model
--bg/--background   --exec   --bare   --safe-mode   --restrict-mode
--no-session-persistence   --debug[=cats]   --debug-file <path>
--init  --init-only  --maintenance   --disable-slash-commands   --autocompact
```

Subcommands: claude agents [--json] [--all] [--cwd], claude attach <id>,
claude logs <id>, claude stop <id>, claude respawn <id>, claude rm <id>,
claude daemon status, claude mcp serve, claude remote-control.

Stream ordering caveat: system/init is the first event unless plugin_install
or hook_* events precede it.

## 7. MCP for the tour

- Wake as an MCP server is the right home for the tour. Transports: stdio,
  sse, http, and ws ({"type":"ws","url":"ws://127.0.0.1:PORT","headers":{}},
  header-only auth). Register via .mcp.json, claude mcp add-json,
  --mcp-config, or a plugin's .mcp.json.
- The agent calls mcp__wake__tour_begin, mcp__wake__tour_stop({file,
  line_start, line_end, narration, order}), mcp__wake__tour_end. Wake gets the
  calls in real time. Pre-approve via the skill's allowed-tools frontmatter or
  --allowedTools "mcp__wake__.*".
- Channels: capabilities.experimental['claude/channel'] plus
  notifications/claude/channel with content and a meta map whose keys become
  XML attributes on a channel tag. Also claude/channel/permission for
  permission relay (permission_request in, permission out with request_id and
  behavior).
- MCP elicitation (Elicitation/ElicitationResult hooks, onElicitation SDK
  option) lets a server ask the user for structured input mid-tool-call,
  rendered by Claude Code's own dialog, not Wake's.
- MCP Apps / ui:// / mcp-ui: not available in Claude Code. ext-apps (2.8k
  stars, spec 2026-01-26) lists ChatGPT, Claude connectors, VS Code, Goose,
  Postman, MCPJam as hosts.
- claude mcp serve turns Claude Code into a stdio MCP server exposing its tools
  to an outside client. Inverse of what Wake needs.

## 8. The IDE surface (best fit for approve-in-place and anchored comments)

Officially documented in code.claude.com/docs/en/vs-code:

- The editor hosts a WebSocket MCP server on 127.0.0.1, random port
  10000-65535, plain ws://.
- Discovery file ~/.claude/ide/<port>.lock (mode 0600 in a 0700 dir).
  Verified live:
  ```json
  {"pid":79079,"workspaceFolders":["/Users/gregor/repos/example"],
   "ideName":"Visual Studio Code","transport":"ws","runningInWindows":false,
   "authToken":"..."}
  ```
- The CLI presents header X-Claude-Code-Ide-Authorization: <authToken>.
- Server name is `ide`, hidden from /mcp. ~12 tools but only two reach the
  model: mcp__ide__getDiagnostics and mcp__ide__executeCode. The rest are
  internal RPC the CLI drives for its own UI.
- While connected, the CLI attaches current selection and active file path to
  every prompt.

Unofficial but corroborated by coder/claudecode.nvim PROTOCOL.md (3.0k stars)
and manzaltu/claude-code-ide.el (1.7k stars): env vars CLAUDE_CODE_SSE_PORT
and ENABLE_IDE_INTEGRATION=true. JSON-RPC 2.0 over MCP 2025-03-26. IDE to
Claude notifications: selection_changed {text, filePath, fileUrl,
selection{start{line,character}, end, isEmpty}} and at_mentioned {filePath,
lineStart, lineEnd}. Claude to IDE tool calls: openDiff {old_file_path,
new_file_path, new_file_contents, tab_name} which blocks and returns
FILE_SAVED or DIFF_REJECTED, plus openFile, getCurrentSelection,
getLatestSelection, getOpenEditors, getWorkspaceFolders, getDiagnostics,
checkDocumentDirty, saveDocument, close_tab, closeAllDiffTabs, executeCode.

There is no documented VS Code extension API for a third party to attach to
the extension's session. The practical route is for Wake to be an IDE: write
its own lock file, host the WS server, implement openDiff.

## 9. Existing third-party UIs and viewers

| Project | Stars | Last push | Stack | Surface | Notes |
|---|---|---|---|---|---|
| musistudio/claude-code-router | 37.0k | 2026-09-01 | TS | API proxy | Not a UI, invasive |
| winfunc/opcode (ex-Claudia) | 22.4k | 2025-10-16 | TS + Tauri/Rust | Spawns CLI, reads ~/.claude | Effectively abandoned, ~11 months stale. Most-starred GUI is dead |
| ccusage/ccusage | 18.3k | 2026-09-01 | Rust | Parses JSONL for cost | Transcript parsing viable at scale, rewritten in Rust |
| siteboon/claudecodeui (CloudCLI) | 13.5k | 2026-09-01 | React + Node | Auto-discovers all sessions from ~/.claude, reads and writes config, plugin system | Closest competitor. "All your sessions, not just one" |
| coder/claudecode.nvim | 3.0k | 2026-08-11 | Lua | IDE WebSocket MCP (hosts lock file + server) | Reference implementation for the IDE surface. PROTOCOL.md is the best doc |
| jhlee0409/claude-code-history-viewer | 2.1k | 2026-09-01 | Tauri v2 + Rust | JSONL, also Pi, Qwen, OpenCode | --export headless mode. Multi-agent generalization is the trend |
| manzaltu/claude-code-ide.el | 1.7k | 2026-08-07 | Emacs Lisp | IDE WebSocket MCP | Second independent implementation |
| simonw/claude-code-transcripts | 1.7k | 2026-02-12 | Python | JSONL to HTML | Reference for the format |
| disler/claude-code-hooks-multi-agent-observability | 1.5k | 2026-02-08 | Bun + SQLite + Vue | Hooks to HTTP POST to server to WebSocket to client | Exactly Wake's live architecture, but with command hooks shelling out. http hooks skip that. Stale |
| d-kimuson/claude-code-viewer | 1.3k | 2026-08-18 | Next.js + SSE | Transcript tail for read, Agent SDK for chat | The ToS canary. Ships a Subscription mode that disables SDK chat |
| daaain/claude-code-log | 1.2k | 2026-09-01 | Python | JSONL to HTML/MD, TUI | --detail low/high drops system/hook noise, worth copying |
| wbopan/cui | 1.1k | 2026-03-20 | TS | CLI stream-json | Archived |
| sugyan/claude-code-webui | 1.1k | 2026-05-29 | TS/Deno | CLI stream-json | Archived |
| delexw/claude-code-trace | 351 | 2026-08-30 | Rust + Tauri + React 19 | JSONL browse and tail | Closest to Wake's replay milestone |
| S40911120/recensa | 70 | 2026-08-30 | TS | Transcript viewer with replay | Small, on-point |
| liaohch3/claude-tap | 3.2k | 2026-08-26 | Python | API traffic interception | Deepest visibility, most fragile |

Pattern: every long-lived read-only tool uses the transcript JSONL. Every
archived tool was a CLI stream-json chat wrapper (value eaten by Remote
Control and claude agents). The two maintained interactive integrations (nvim,
Emacs) both chose the IDE WebSocket MCP surface. Nobody has built the
file-activity map.

## 10. Recommended architecture for Wake

Core stance: Wake attaches to the user's own unmodified claude process. It
never spawns the agent with borrowed credentials. Dodges the ToS problem,
matches the product (companion UI), and uses the best-documented surface.

Wake ships as one installable plugin (hooks/hooks.json + .mcp.json + skills/
+ optionally agents/) plus a local daemon that is an HTTP hook endpoint, an
MCP server, and an IDE-lock-file WebSocket host.

### M1 Replay from finished sessions

- Enumerate with listSessions({dir}), hydrate with getSessionMessages(id,
  {includeSystemMessages: true}), subagents via listSubagents +
  getSubagentMessages.
- For the file-activity map you need toolUseResult.structuredPatch, which
  getSessionMessages may not surface (SessionMessage.message is unknown and
  wrapper fields are not in the type). Read via the SDK for structure,
  supplement from raw JSONL for toolUseResult / sourceToolAssistantUUID.
  Isolate all raw-format knowledge in one adapter module keyed on the per-
  record version field.
- Handle system/compact_boundary by relinking through
  compactMetadata.preservedMessages.uuids and logicalParentUuid.
- Plans: read ~/.claude/plans/<slug>.md via the slug on transcript records.

### M2 Live view

- hooks/hooks.json with {"type":"http","url":"http://127.0.0.1:PORT/hook"}
  on SessionStart, UserPromptSubmit, PreToolUse (*), PostToolUse,
  PostToolUseFailure, PostToolBatch, SubagentStart, SubagentStop,
  TaskCreated, TaskCompleted, Notification, PreCompact/PostCompact,
  CwdChanged, FileChanged, Stop, SessionEnd.
- Mark every non-gating hook "async": true so Wake never adds latency.
  Reserve synchronous hooks for gates.
- Use MessageDisplay (turn_id, message_id, index, final, delta, 10s timeout)
  for narration text without stream-json.
- Discover live sessions from ~/.claude/sessions/<pid>.json and claude agents
  --json. The former is undocumented, fall back to scanning ~/.claude/projects
  mtimes.
- Read transcript_path from any hook payload to backfill what hooks do not
  carry.

### M3 Stop / fence / approve

- Stop: a synchronous PostToolBatch http hook returning {"continue": false}
  stops the agentic loop before the next model call. For hard interrupt on an
  SDK-driven session, Query.interrupt(). No documented way to interrupt an
  interactive session from outside. PostToolBatch gate is closest, plus
  asyncRewake for a nudge.
- Fence: write deny rules into .claude/settings.local.json
  (Edit(/src/vendor/**), Read(//abs/path/**)), rely on live reload. Also
  enforce in a synchronous PreToolUse hook returning permissionDecision deny
  with a reason, so the fence holds if reload lags and you get an event to
  render.
- Approve in place: synchronous PermissionRequest http hook. Wake holds the
  request open (raise timeout deliberately), renders the diff, returns
  hookSpecificOutput.decision = {behavior:"allow", updatedInput: {...}}.
  updatedInput makes "edit the proposal then accept" work. On timeout the
  normal terminal prompt still stands, the correct failure mode.
- Comments anchored to file:line: best is the IDE surface, Wake hosts the lock
  file and emits at_mentioned {filePath, lineStart, lineEnd}. Fallbacks: a
  channel notification, or posting to $CLAUDE_CODE_MESSAGING_SOCKET. Both
  fallbacks have partly undocumented wire formats.
- Undo: ~/.claude/file-history/ plus file-history-snapshot/delta records, or
  Query.rewindFiles on SDK-driven sessions with enableFileCheckpointing.

### M4 Guided review / tour

- Ship skills/guided-review/SKILL.md with frontmatter: allowed-tools
  mcp__wake__tour_begin, mcp__wake__tour_stop, mcp__wake__tour_end
  (pre-approved for that turn only), hooks: registering Wake's session hooks
  on invocation, disable-model-invocation: true if it should be /-only.
- The skill instructs the agent to call one tour_stop per stop with {order,
  file, line_start, line_end, title, narration, severity}. Wake plays each
  immediately.
- Do not use outputFormat json_schema as the primary channel: structured_output
  only lands on the final result message, so the tour could not play as it is
  produced. Optional end-of-tour manifest only.
- Do not use a marker format in the text stream. An MCP tool call is typed,
  ordered, and returns an acknowledgement.
- The tour data lives in Wake. There is no way to render it inside the
  terminal.

## 11. Pitfalls

1. Transcript format is explicitly unstable. Pin behavior on the per-record
   version field. Prefer getSessionMessages() where it suffices.
2. TodoWrite no longer exists on current models. TaskCreate/TaskUpdate are
   opt-in via allowedTools, the tools option, or
   CLAUDE_CODE_ENABLE_TODO_TOOLS=1. Streamed task tool inputs are raw model
   output, Claude Code repairs id/task_id to taskId and active_form to
   activeForm after the stream. Read those keys defensively.
3. isSidechain is dead. Subagent detection is parent_tool_use_id != null
   (stream/SDK) or the subagents/ directory plus meta.json (disk).
4. ToS on subscription credentials. Do not drive the SDK with a user's
   Pro/Max login as a product feature. Attach to the unmodified binary.
5. Channels are research-preview and allowlisted. Do not make a milestone
   depend on it.
6. PreToolUse timeout does not block, a slow Wake means the tool proceeds.
   Know which gates fail open.
7. SessionEnd has a 1.5s budget. Flush state incrementally.
8. .claude/settings.json hot-reloads but plugin hooks/ and .mcp.json do not,
   those need /reload-plugins or a restart. SKILL.md edits apply immediately.
   Affects install UX.
9. Streaming emits one assistant message per content block, all sharing
   message.id with stop_reason null. Bind replies to sends via
   user_message_uuid (first frame of a turn only).
10. total_cost_usd and modelUsage are cumulative in streaming sessions.
11. Control-request methods are streaming-input only.
12. --include-partial-messages requires --print --output-format stream-json,
    most combos want --verbose.
13. IDE protocol is unversioned and half-undocumented. Gate Wake's IDE
    features on a handshake probe.
14. The IDE lock file contains a plaintext auth token and Wake would be
    creating one. 0600 in a 0700 dir, loopback only.
15. Edit/Read deny rules only cover built-in file tools and recognized Bash
    file commands (cat, head, tail, sed). A Python script the agent writes
    bypasses them. Real fencing needs sandbox.* settings. Wake's UI should say
    so rather than imply guarantees.
16. Write/NotebookEdit/Glob path rules are silently never consulted. Use
    Edit(path) and Read(path) only.
17. Compaction breaks the parentUuid chain.
18. The most-starred Claude Code GUI (opcode, 22k stars) has been dead since
    Oct 2025, two 1k-star stream-json chat wrappers are archived. Chat-wrapper
    UIs get commoditized by Anthropic. Wake's map/tour/fence differentiation is
    the durable part, a chat pane is not.

## Sources

Official documentation (fetched as .md):
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/vs-code
- https://code.claude.com/docs/en/jetbrains
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/checkpointing
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/python
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/agent-sdk/structured-outputs
- https://code.claude.com/docs/en/agent-sdk/todo-tracking
- https://code.claude.com/docs/llms.txt

Package and type ground truth:
- https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk (v0.3.258, sdk.d.ts, sdk-tools.d.ts)
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Local: ~/.claude/projects/**/*.jsonl, ~/.claude/sessions/<pid>.json, ~/.claude/ide/<port>.lock, ~/.claude/plans/

MCP:
- https://modelcontextprotocol.io/specification/2026-07-28
- https://github.com/modelcontextprotocol/ext-apps

Community:
- https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md
- https://github.com/manzaltu/claude-code-ide.el
- https://github.com/siteboon/claudecodeui
- https://github.com/d-kimuson/claude-code-viewer
- https://github.com/daaain/claude-code-log
- https://github.com/simonw/claude-code-transcripts
- https://github.com/disler/claude-code-hooks-multi-agent-observability
- https://github.com/jhlee0409/claude-code-history-viewer
- https://github.com/delexw/claude-code-trace
- https://github.com/winfunc/opcode
- https://github.com/ccusage/ccusage
- https://github.com/S40911120/recensa
- https://github.com/wbopan/cui, https://github.com/sugyan/claude-code-webui (archived)
- https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b
- https://claude-dev.tools/docs/jsonl-format
