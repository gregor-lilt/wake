# Wake: technology stack research, synthesis

Date: 2026-09-02. This document reconciles five raw research reports in
docs/research/ (rendering, layout and prior art, code graph extraction, Claude
Code integration, app shell and animation) into one recommended stack and a
list of decisions still open. PLAN.md stays library-free on purpose. This file
is where the libraries live.

## 1. Findings that change the plan

Five things came out of the research that PLAN.md did not anticipate.

1. The map should be a treemap, not a graph. Every long-lived software map
   (Seerene, CodeCharta, Understand, SonarQube) is containment-based. Graph
   layouts are globally coupled: one new edge moves everything, and every
   mitigation (pinning, aging) degrades quality over time. The layout report's
   recommendation is a deterministic, grid-quantized, hierarchy-anchored
   packing with greedy insertion into free space (the GIT algorithm, Vernier
   2018). Edges are drawn on top via hierarchical bundling and never move
   nodes. This rules out the graph-first renderers (Sigma.js, cosmos.gl) as the
   primary engine and pushes toward a general 2D GPU renderer.
2. Claude Code hooks have an HTTP handler type and 33 events. Wake's daemon
   receives every tool call as a POST with no shell scripts. PermissionRequest
   gives approve-in-place with the ability to rewrite the edit. Settings files
   hot-reload, so a fence is a deny rule written to .claude/settings.local.json.
   The steering milestone is far cheaper than assumed.
3. The chat pane has a licensing problem. Anthropic's legal page says
   third-party products using the Agent SDK should use API-key auth, and does
   not permit routing requests through Pro/Max subscription credentials. The
   carve-out is the user running the unmodified Claude Code binary themselves.
   One existing viewer already disabled its SDK chat over this. Two consequences:
   Wake should attach to the user's own `claude` process rather than spawn one,
   and the "chat window" in PLAN.md needs a decision (section 6).
4. The extraction tier is commoditized. Two MIT projects at 69k and 42k stars
   (colbymchenry/codegraph, DeusData/codebase-memory-mcp) already do
   tree-sitter to SQLite with a watcher, with published speed numbers (50k
   files in 2-4 minutes cold, 0.3-0.5 s per changed file). Neither ships a map.
   Wake's extractor can copy their design, and the differentiator is entirely
   the live visual layer.
5. Tauri is the wrong shell for this workload, despite being the ecosystem
   default. Linux WebKitGTK WebGL is broken in documented ways, macOS WKWebView
   capped at 60fps on macOS 13-15 and only got WebGPU on macOS 26, and the
   biggest Claude Code GUIs on Tauri stalled or moved to Electron (opencode,
   203k stars, left in April 2026).

## 2. Recommended stack by layer

| Layer | Pick | Runner-up | Why |
|---|---|---|---|
| Shell v0/v1 | Bun server + the user's own browser, launched by `npx wake` | Electron 44 from day one | Full Chromium GPU stack, DevTools, zero signing, $0. Same frontend moves to Electron later |
| Shell v2 | Electron 44 (Chromium 152) | none | Only shell with proof for a large WebGL scene on all three OSes (Obsidian's PixiJS graph) |
| Runtime | Bun 1.4 | Node 24 LTS | Built-in PTY (no node-pty), native WebSocket, Bun.markdown, single-binary compile, Agent SDK fast mode is Bun-only. Claude Code itself is a Bun binary |
| Renderer | deck.gl 9.3, OrthographicView | Hand-rolled instanced WebGL2 (or three.js with TSL) | Fits a treemap: SolidPolygonLayer for regions, ScatterplotLayer for symbols, PathLayer for bundled edges, TextLayer + CollisionFilterExtension for labels, TileLayer for tiled semantic zoom, GPU attribute transitions with enter backfill, FlyToInterpolator with onTransitionInterrupt. ~1M items at 60fps on 2015 hardware |
| Renderer, if the map turns graph-first | Sigma.js v4 beta | cosmos.gl | Best graph-specific label engine and depth layers. Beta from a 2-3 person team, main branch near-dormant |
| Graphics API | WebGL2 baseline, WebGPU opt-in behind detection | | Firefox ships WebGPU disabled, Safari needs 26+, deck.gl WebGPU is not production-ready |
| Layout | Own implementation: deterministic key per node, GIT-style greedy insertion, grid quantization, nudges as lattice constraints | ELK rectpacking + topdownpacking (read, do not depend) | No library does stable incremental containment. tue-alga/TreemapComparison has reference code (unlicensed, port it) |
| Edge bundling | Hierarchical (Holten) via d3 curveBundle from the directory tree | libavoid-js (LGPL, WASM) for orthogonal routing as an optional style | Deterministic, iteration-free, inherits node stability. FDEB is GPL and unstable |
| Labels | Per-label minzoom computed once, rank by structure not recency, tile pyramid per Nachmanson and Chen 2026 | | Mapping-industry solution. Recency in color and motion, never in label priority |
| Node animation | Per-instance attributes (animT0, animDuration, animKind, animAmp) evaluated in the vertex shader against one uNow uniform | deck.gl transitions for the simple cases | Zero per-frame JS for 50k concurrent animations. Time scrubbing becomes uNow = t |
| Camera | d3-zoom for gestures, interpolateZoom (van Wijk) for fly-to, FOLLOW / MANUAL / RECENTERING state machine with damped follow and Cinemachine's Wait + Time | pixi-viewport | d3-zoom already interrupts programmatic transitions on user gesture, the takeover for free |
| Camera easing, DOM chrome | tween.js (3 KB, MIT) | anime.js v4 (MIT) or GSAP (free, not OSI) | |
| Map thread | OffscreenCanvas in a Worker via transferControlToOffscreen | | Chat re-renders and Shiki physically cannot drop map frames |
| UI framework | Solid | Svelte 5 with $state.raw | Components run once, the canvas ref is never touched. Node state lives in typed arrays, never in framework state |
| State | Event log (append-only) to pure reducer to typed arrays to dirty-range bufferSubData. UI state in signals or nanostores | | Deterministic replay and snapshots fall out. Log external query responses into the stream |
| Code at depth | LOD ladder: L0 quads, L1 MSDF labels, L2 token-run rects, L3 pooled DOM pre overlay shown only at camera rest, hard cap 8-30 | | Do not build a GPU glyph grid (VS Code has been at it two years). Scale via font-size, never transform scale |
| Highlighting | Shiki v4 fine-grained bundle, JS RegExp engine, in a Worker, tokens cached as Uint32Array by content hash + theme | | One tokenize feeds L2 rects and L3 spans. Never ship bundle/full (6.4 MB) |
| Diffs | CodeMirror 6 pool of 2-3, @codemirror/merge unifiedMergeView + collapseUnchanged | | No Monaco (ts.worker alone 6.7 MB) |
| Indexer core | Rust: ignore (walk), blake3 Merkle tree, tree-sitter 0.27 pinned + tree-sitter-tags, own imports.scm per language, rusqlite WAL + FTS5, petgraph projection, notify with 1-2 s debounce | | Both prior-art projects chose native cores. Extract facts from each tree and drop it, never retain trees. No ts_tree_edit |
| Indexer to UI | Sidecar binary speaking JSON over stdio (`wake-index`) | napi-rs module | Sidecar keeps the indexer usable standalone and avoids Bun N-API edge cases. Verify napi-rs under Bun before switching |
| Reference edges | Codebase-Memory 6-strategy cascade with a confidence score per edge (import-map 0.95 down to fuzzy 0.30) | | Strategies 1-3 resolve ~80% of calls. Confidence lets the precise tier upgrade edges later |
| Precise tier | One LSP server per language via async-lsp, lazy spawn on user click, idle kill, hard memory cap, explicit opt-in for gopls (8-10 GB) and rust-analyzer (2.5 GB). Results written back as confidence-1.0 edges | SCIP import via the scip crate as batch enrichment | LSP for one clicked symbol, never bulk (arXiv 2604.18413 learned this the hard way) |
| Hunk to symbol | git diff -U0 line ranges intersected with stored symbol spans | difftastic as reference only | Wake owns the spans, the intersection is free |
| Claude Code ingest | http hooks to Wake's daemon on 17 events, non-gating ones marked async | Transcript JSONL tail as backfill | No shell scripts. Hook payload carries transcript_path for backfill |
| Replay | Agent SDK listSessions / getSessionMessages / listSubagents for structure, raw JSONL adapter for toolUseResult.structuredPatch (the per-edit diff) | | Isolate raw-format knowledge in one module keyed on the per-record version field. Handle compact_boundary via logicalParentUuid |
| Stop | Synchronous PostToolBatch hook returning continue false | asyncRewake hook for a nudge | No documented way to interrupt an interactive session from outside. This gates before the next model call |
| Fence | Deny rules in .claude/settings.local.json (Edit(path), Read(path) only) plus a synchronous PreToolUse hook returning deny | | Hot-reloaded. Only covers built-in file tools and known Bash commands, Wake's UI must say so |
| Approve in place | Synchronous PermissionRequest hook, held open, returns allow with updatedInput | | "Edit the proposal then accept" works natively |
| Anchored comments | Wake hosts an IDE lock file (~/.claude/ide/port.lock) and a WebSocket MCP server, emits at_mentioned {filePath, lineStart, lineEnd} | Channels (allowlisted) or $CLAUDE_CODE_MESSAGING_SOCKET | Same surface claudecode.nvim and claude-code-ide.el use. Half-documented, gate on a handshake probe |
| Tour | Wake as MCP server (ws transport), skill with allowed-tools mcp__wake__tour_begin / tour_stop / tour_end, one call per stop | structured_output as an end-of-tour manifest | Typed, ordered, plays as produced. Never a marker format in the text stream |
| Packaging | npx, then personal Homebrew tap, then bun --compile binaries + npm optionalDependencies with a spawn shim, then Electron with signing | | $0 until a .app, then $99/yr Apple. SignPath for Windows. npx is the Linux story |

## 3. Architecture, conceptual to concrete

PLAN.md section 12 maps onto:

- Event stream: Bun daemon receiving http hooks, tailing transcripts, reading
  the indexer sidecar, publishing over a WebSocket to the browser. Append-only
  log persisted for replay.
- Code graph: Rust sidecar `wake-index`, SQLite on disk in `.wake/`.
- Layout engine: TypeScript, own implementation, runs in the map Worker at
  1-5 Hz, persists layout and nudges in `.wake/layout.json`.
- Renderer: deck.gl in an OffscreenCanvas Worker, WebGL2.
- Chat: see section 6.
- Tour player: consumes MCP tool calls from the daemon, drives the camera.

Wake ships as a Claude Code plugin (hooks/hooks.json, .mcp.json, skills/) plus
the daemon. Plugin hooks and .mcp.json do not hot-reload, SKILL.md does.

## 4. What to spike first (before M0)

Each spike is one to three evenings and kills a specific risk.

1. deck.gl OrthographicView with 50k SolidPolygon tiles + 5k labels +
   CollisionFilterExtension, measure fps on a Mac and a Linux box. Kills the
   "no Sigma v4 benchmark exists" gap and validates the renderer choice.
2. Custom shader injection in deck.gl for the uNow-driven pulse. If deck.gl
   fights it, the fallback is the hand-rolled instanced renderer.
3. GIT-style quantized treemap on the directory tree of a real 10k-file repo,
   replay 50 commits, measure the Vernier baseline-relative stability metric.
   Kills the layout-stability assumption.
4. http hook round-trip: a Bun endpoint receiving PreToolUse and PostToolUse
   from a live session, and a PermissionRequest hook that holds an Edit until
   a browser click. Kills the steering-surface risk.
5. tree-sitter-tags in Rust over the same repo, time cold index and per-file
   reparse. Compare against codegraph's numbers.

## 5. Risks carried forward

- deck.gl transitions are keyed by array index. Allocate a stable index per
  node for the session and animate visibility, never array membership.
- deck.gl attribute generation is the CPU wall ("99% of CPU time is calling
  the accessors you supply"). Precomputed typed arrays, surgical updateTriggers.
- Transcript JSONL format is officially unstable. One adapter module, version
  keyed.
- TodoWrite is gone on current models. Plans are markdown at
  ~/.claude/plans/slug.md, joined via the slug field on transcript records.
  TaskCreate/TaskUpdate are opt-in.
- Subagents have their own JSONL files and meta.json. isSidechain is dead.
- Fences are advisory against a Python script the agent writes. Real
  containment needs sandbox settings.
- The IDE protocol is unversioned. The lock file holds a plaintext token.
- Compositing-layer count is a VRAM ceiling. The L3 DOM cap is load-bearing.
- tags.scm covers no imports and varies in quality. Budget for maintaining
  per-language queries. TS path aliases and barrels are the biggest trap,
  study dependency-cruiser.
- Stability is a product requirement, not a proven comprehension win
  (Archambault and Purchase 2013, a 2025 process-mining study found a negative
  effect). Do not oversell it in the README.
- Ecosystem churn: opcode, CodeLayer, cui, claude-code-webui, Terragon all
  stalled within 12 months. Chat wrappers get commoditized by Anthropic. The
  map, tour and fence are the durable parts.

## 6. Decisions (resolved 2026-09-02 unless marked open)

- Chat: embed the unmodified Claude Code TUI in a PTY (xterm.js +
  addon-webgl). No Agent SDK, no API key. Stop = interrupt keystroke to the
  PTY. Tool events from hooks and transcript only.
- Indexer: Rust sidecar from day one.
- UI framework: Solid.
- License: MIT.
- ACP: not now. Moot with the embedded TUI (the ACP adapter wraps the SDK).
  Keep the event stream agent-neutral.
- Map model: geographic. Containment from the directory tree with
  coupling-ordered siblings and deliberate slack, routed and bundled edges
  that never move nodes, semantic zoom with ranked labels, agent activity
  as traffic with link volumes. No force layout. Alternate projections
  (topic map, dependency projection) as toggles only.

The original option list is kept for the record.

## 6a. Original option list

1. The chat pane. Three options.
   (a) No chat pane in v0/v1. Claude Code runs in the user's terminal, Wake is
   the map beside it. Steering goes through hooks, fences, approvals and
   anchored comments via the IDE surface. Reading the conversation works via
   the transcript. This is the ToS-safe path and drops the two hardest UI
   problems (streaming markdown, terminal embedding).
   (b) Chat via the Agent SDK with the user's API key. Full control
   (interrupt, canUseTool), but excludes Pro/Max subscribers unless they also
   have API billing.
   (c) Embed the Claude Code TUI in xterm.js. Documented input bugs until
   xterm 7.0 (~Dec 2026), and you cannot read tool events from a terminal
   buffer anyway.
   Recommendation: (a), and revisit once Anthropic clarifies or ships a
   sanctioned attach surface. PLAN.md sections 5 and 8 would need a line.
2. Treemap-first (recommended) vs graph-first map. Changes the renderer pick
   and the whole layout section of PLAN.md.
3. Rust indexer from day one, or TypeScript with web-tree-sitter for M0 and
   Rust later. Rust is the right end state. For a solo M0 the WASM path gets a
   replay demo faster.
4. License. The research pulled in nothing that constrains an MIT or Apache
   2.0 choice, as long as ctags and srcML stay subprocess-only, FDEB and
   GitNexus are not used, and libavoid-js stays behind a WASM boundary.
5. Should Wake also be an ACP (Agent Client Protocol) client to support other
   agents later. Cheap insurance against SDK churn, but PLAN.md says Claude
   Code only for the first year.

## 7. Raw reports

- docs/research/01-rendering-engines.md
- docs/research/02-layout-and-prior-art.md
- docs/research/03-code-graph-extraction.md
- docs/research/04-claude-code-integration.md
- docs/research/05-app-shell-and-animation.md
