# Research: app shell, runtime, and animation/UI stack

Raw research report, 2026-09-02. Grounded in fetched primary docs, repos,
release assets and issue threads. Synthesis in ../research-stack.md.

## 0. The one decision that drives everything

The animated 10k-50k node canvas is the product. Chat, indexer and hooks are
solvable in any stack. So the shell must be chosen on GPU predictability across
all three OSes, not on binary size or ideology. That criterion eliminates the
ecosystem's default choice: Tauri's system-webview model is the most heavily
documented failure mode for exactly this workload, and the Claude Code GUI
cohort that picked it has been abandoning it.

Recommendation: Bun server plus the user's own browser for v0/v1, Electron for
a windowed v2, same frontend code both times. Runner-up: Electron from day one.
Serious non-web alternative: egui plus a hand-written wgpu instanced renderer.

## 1. Shell decision table (1-5, 5 best for Wake)

| Shell | GPU perf | Spawn | Files | Packaging | Solo velocity | Community | Total |
|---|---|---|---|---|---|---|---|
| (a) Local server + browser tab (Bun/Node + Chrome/Firefox) | 5 full Chromium GPU stack, DevTools, WebGPU where available | 5 unrestricted, Bun.Terminal PTY built in | 5 | 5 npx wake, nothing to sign | 5 no shell layer, instant reload | 4 vibe-kanban, CloudCLI, ccusage | 29 |
| (b) Electron 44 (Chromium 152, Node 24.19) | 5 one Chromium everywhere, WebGPU production since 32+ | 5 | 5 | 3 98-150 MB/arch, mac signing for updater | 4 | 5 Obsidian ships a PixiJS WebGL graph on it | 27 |
| (c) Tauri 2.11.5 | 2 (see section 2) | 4 | 4 | 5 13-38 MB dmg, free updater | 3 two languages, JSON IPC | 4 | 22 |
| (f) egui/eframe 0.36 + wgpu | 5 you own the render pass | 5 | 5 | 4 8-25 MB, still mac signing | 3 chat scrollback is real work | 3 | 25 |
| (d) VS Code extension + webview | 2 iframe, "resource heavy", postMessage has no transferables | 4 | 4 | 5 | 3 | 5 | 23 but IPC kills it |
| (e) Zed extension | 0 WASM only, no view API | | | | | | impossible |
| (e) JetBrains plugin (JCEF) | 3 | 4 | 4 | 3 | 2 | 3 | 19 |

## 2. Why not Tauri

- Linux WebKitGTK is the blocker. Tauri's own "Linux Graphics Issues" page:
  blank windows, flicker, crashes, DMABUF errors. Workarounds escalate to
  WEBKIT_DISABLE_COMPOSITING_MODE=1, which kills accelerated compositing. Docs
  warn "WebGL contexts may silently use slow rendering paths without throwing
  errors". tauri#6559 "WebGL: context lost" open since March 2023, a Jan 2026
  comment recommends CEF or Electron.
- macOS WKWebView lags the OS. WebGPU only on macOS 26+. WKWebView capped
  requestAnimationFrame at 60fps on macOS 13-15. A maintainer answered "yes"
  to "for WebGPU across OS we're better off with electron" (#6381).
- IPC is the wrong shape for a high-frequency stream. Docs: "The event system
  is not designed for low latency or high throughput situations", JSON only.
  Channel<T> and raw-bytes Response exist but you must know to use them.
- CEF escape hatch is not shipped (feat/cef branch, 3.0.0-alpha, no releases).
- The field is leaving. opencode (203k stars) removed Tauri in April 2026 and
  moved to Electron ("scrolling experience was extremely poor"). opcode (22.4k)
  last released 2025-08-31. CodeLayer (11.4k) README says code is "pretty much
  all deprecated". Readest: WebKitGTK "one of our biggest pain points".
- Reconsider only if Linux is out of scope or when CEF ships in Tauri 3.

## 3. Runtime: Node vs Bun vs Deno

Versions: Node 24.20 LTS / 26.8 Current, Bun 1.4 (2026-08-20), Deno 2.9.6.

| | Node | Bun 1.4 | Deno 2.9 |
|---|---|---|---|
| Spawn claude | child_process | Bun.spawn with terminal option = real PTY (openpty/ConPTY), no node-pty | Deno.Command, no PTY |
| File watching | fs.watch, chokidar in practice | fs.watch rewritten in 1.3.14 | Deno.watchFs |
| WebSocket server | needs ws | Bun.serve native | Deno.serve native |
| Single binary | SEA still Stability 1.1, ~100 MB, strip and re-sign, dlopen crash on Linux arm64 | bun build --compile, 8 targets, cross-compile, --asset embeds frontend, 60-110 MB (Claude Code itself 199 MB) | deno compile, 240-257 MB |
| Markdown | npm | Bun.markdown built in, Rust parser, GFM, React component output | npm |
| Agent SDK | supported | supported, only runtime with fast mode | supported |

Agent SDK: executable is 'bun' | 'deno' | 'node', auto-detected. Ships the
Claude Code binary as per-platform optional deps, version-locked.
pathToClaudeCodeExecutable, spawnClaudeCodeProcess, startup() escape hatches.
bun build --compile breaks require.resolve inside $bunfs, fix is import with
{ type: "file" } plus extractFromBunfs() (SDK 0.3.144+). Fast mode is Bun-only
(issue #216), silently degrades under Node. Intermittent "Bun is not defined"
under Node (issue #266).

Verdict: Bun. Built-in PTY (node-pty is a native module needing Xcode /
build-essential / Windows SDK), built-in markdown, native WebSocket, credible
single binary, fast mode. Claude Code itself is a bun-compiled binary. Node is
the safe fallback.

## 4. UI framework for chat and controls

Requirement: the canvas must never be re-rendered by the framework, and the
framework must absorb a high-frequency stream without re-rendering the world.

| Option | Canvas interop | Stream | Verdict |
|---|---|---|---|
| Solid 1.x | Components run once, signals update DOM directly | Fine-grained by default | Best fit. Canvas is a ref Solid never touches again |
| Svelte 5 runes | Compiled fine-grained, $state.raw skips deep proxying of large arrays | Good | Very close second, better DX |
| React 19 + Compiler 1.0 | Needs discipline, per-frame work out of state | Compiler stable, still React | Only for ecosystem (Streamdown, react-shiki, CM wrappers) |
| Vue 3 | Fine | Good | No reason here |
| None | Zero cost | Hand-written chat DOM | Bad for chat |

State for the event stream, three tiers, node state never in framework state:

1. Event log: append-only ring buffer outside the framework. Source of truth.
2. World state: typed arrays (positions, colors, animation start times).
   Mutated by a reducer, uploaded via bufferSubData on dirty ranges. Never
   reactive.
3. UI state: selection, filter, camera mode. Signals or nanostores.

TC39 Signals is Stage 1, pick a framework's signals.

Render the map in a Worker. OffscreenCanvas plus transferControlToOffscreen()
(Baseline since March 2023) puts the WebGL loop on its own thread. Chat
re-renders, Shiki, markdown parsing then physically cannot drop map frames.
Highest-leverage architectural choice in the frontend, near-zero cost.

## 5. Animation architecture

Core insight: with 10k-50k nodes and thousands of concurrent fades, per-node JS
tweening is the wrong model. Encode each node's animation as data and evaluate
in the vertex shader.

Per-instance attributes (vertexAttribDivisor + drawArraysInstanced, one draw
call):

```
position (vec2), size (float), colorIndex (uint)
animT0 (float), animDuration (float), animKind (uint), animAmp (float)
```

One uniform uNow. Every fade, pulse and pop is f(uNow, animT0, animDuration,
animKind). Per-frame JS cost for 50k animations: zero. Consequences:

- Time scrubbing is trivial: set uNow.
- Deterministic replay is a reducer, not a rendering problem. Event sourcing:
  append-only log, pure reducer, snapshot every N events. Log the responses to
  external queries (git output, indexer results) into the event stream or
  replay diverges. Rerun (v0.37, Rust/egui/wgpu) is the closest shipped
  analogue.
- CPU side can be lazy. Layout and indexer at 1-5 Hz, only the GPU at display
  rate.

Libraries:

| Library | Status | Use for |
|---|---|---|
| GSAP 3.15 | Fully free incl. former Club plugins after Webflow acquisition, but "standard no-charge" license is not OSI (competitive-use restriction). Fine as npm dep, do not vendor | Camera easing, DOM chrome. gsap.ticker as the single rAF loop with lagSmoothing |
| anime.js v4 | MIT, 72.6k stars, WAAPI, timelines, springs | Clean MIT alternative to GSAP |
| Motion (ex Framer) | MIT core, vanilla animate(), Motion+ paid | Only if chat is React |
| tween.js 23.1.3 | MIT, does one thing | The 3 KB answer for camera state |
| Popmotion | Superseded | Skip |
| d3-transition / ease / interpolate | Standard | Easings, you already have d3-zoom |
| deck.gl 9.3 | GPU attribute transitions (interpolation, spring), enter backfill for new objects (node fade-in), OrthographicView, FlyToInterpolator, onTransitionInterrupt | Strongest "80% for free" option |
| cosmos.gl 3.0 | MIT, GPU force sim and render in shaders, clustering, GPU transitions | If the map is a force graph |
| three.js + TSL | WebGPURenderer alongside WebGL, TSL compiles to GLSL and WGSL | Full control with one shader source |
| PixiJS v8 | Sprites batched, BitmapText, DOMContainer experimental | 2D alternative with pixi-viewport |

Target WebGL2, offer WebGPU. Firefox 155-157 still ships WebGPU disabled,
Safari needs 26+. xterm's WebGL addon needs WebGL2 anyway.

## 6. Camera and gestures

- Use d3-zoom as the input layer even on WebGL. DOM-agnostic {k, x, y}
  transform into the projection matrix. Handles trackpad pinch (ctrlKey wheel,
  deltaMode). "User gestures interrupt programmatic transitions", the takeover
  problem for free.
- Fly-to via d3 interpolateZoom (van Wijk "Smooth and efficient zooming and
  panning"), same curve as MapLibre flyTo.
- pixi-viewport 6.0 (MIT, Pixi v8) has drag/pinch/wheel/decelerate/follow
  plugins, but plugin priority and input preemption of follow are not spelled
  out.
- Autopilot with takeover, copy Cinemachine: state machine FOLLOW / MANUAL /
  RECENTERING. FOLLOW uses position damping (critically damped spring or
  exponential smoothing), not a tween, so new targets never restart. Any
  gesture (d3-zoom start event) goes to MANUAL and resets an idle timer. Two
  parameters: Wait (seconds of no input before recentering) and Time (duration
  of recentering). Recentering target: axis center or "whatever Claude is
  touching". Respect prefers-reduced-motion with an essential override. Give
  the user a visible autopilot toggle.

## 7. Non-web stacks, honestly assessed

No native toolkit hands you 50k animated nodes. Every viable path is a widget
toolkit for chat plus a raw GPU escape hatch for the map.

| Stack | Escape hatch | Chat pane | Verdict |
|---|---|---|---|
| egui/eframe 0.36.1 | Best in class, egui_wgpu::CallbackTrait gives Device, Queue, CommandEncoder and your own render passes | egui_commonmark 0.22 + syntect, ScrollArea::show_rows | Strongest non-web candidate. 8-25 MB, <100ms start, monthly releases |
| iced 0.14 | shader widget, canvas | Best out of the box: built-in markdown, iced_highlighter | Runner-up, 15 months between releases, Elm arch fights a streaming backend |
| GPUI / gpui-component | Weakest, its own quad pipeline | Best chat pane anywhere (tree-sitter editor, markdown, VirtualList) | Viable with pain, gpui crate stale since Oct 2025, Zed's markdown crate is GPL |
| Flutter + Impeller | flutter_gpu experimental | flutter_markdown discontinued by flutter.dev | Viable with pain |
| Bevy 0.19 | Trivial | EditableText only, no markdown | Only if map is 80% of the app |
| Godot 4 | MultiMeshInstance2D | RichTextLabel + BBCode good | Viable with pain, OS.execute blocking, DIY watching/packaging |
| Compose Multiplatform 1.12 | Skia canvas | Real selection, IME | Dark horse for chat, wrong for map, 60-120 MB with JRE |
| SwiftUI + MTKView | Trivial | Best, nearly free | Kills Linux |
| Slint, Freya, Xilem/Vello, Makepad, Dioxus native, Dear ImGui, raw wgpu | | | Not viable in 2026 (immature text/rich text, tiny maintainer bases, or six months of chat-pane work) |

Precedent: GraphPU (latentcat/graphpu) is Rust, egui UI, wgpu + WGSL compute,
renders millions of nodes with instanced rendering and GPU Barnes-Hut. Rerun
is egui + re_renderer on wgpu at 1-2M points, and documents that frame rate
suffers at 1M because they re-upload the point cloud every frame. Lesson for
either stack: persistent GPU buffer, animate via time uniform, never re-upload
per frame.

## 8. Code at the deepest zoom

Do not build a GPU glyph-grid code renderer. VS Code's team has been on theirs
two years (issue #221145) and it still cannot render long lines, proportional
fonts, RTL, ligatures.

Do use a DOM <pre> overlay positioned by the same camera matrix, from a fixed
pool. Prior art converges: Microsoft Research Code Canvas (VS 2010), tldraw
(DOM shapes culled by a spatial index, maxShapesPerPage 4,000, fidelity
degrades at low zoom, zoom debounced above 500 shapes).

LOD ladder keyed on on-screen node size with hysteresis, not zoom level:

| Tier | On-screen size | Drawn as | Budget |
|---|---|---|---|
| L0 | <4px | Instanced colored quads | 10-50k nodes, 1 draw call |
| L1 | 4-40px | Quads + MSDF labels from one atlas | 1-2k visible labels |
| L2 | 40-300px | One colored rect per token run, rows = lines (Sublime-minimap look from Shiki token colors) | 200 files x 5k rects |
| L3 | glyph height >= 9-10px | Real syntax-highlighted source and diffs in pooled DOM <pre> | hard cap 8-30 elements |

Critical trick: show the L3 DOM overlay only when the camera is at rest, L2
rects stand in during motion. Kills blurry text from will-change transform +
CSS scale, sub-pixel drift between canvas and CSS transforms, and per-zoom-step
reflow. Scale via font-size, never transform: scale.

Highlighting: Shiki v4 fine-grained bundle with the JS RegExp engine (instant
startup), in a Worker, one instance, tokens cached as Uint32Array (line,
startCol, len, colorIdx) plus palette keyed by content hash + theme. One
codeToTokens call feeds both L2 rects and L3 spans. bundle/full is 6.4 MB
minified, do not ship it. Monaco out (ts.worker.js 6.68 MB). CodeMirror 6
(~124 KB gz) pool of 2-3 for the focused file, @codemirror/merge 6.12
unifiedMergeView + collapseUnchanged for diffs (maps onto approve/reject of a
Claude edit). CM6 has no official benchmarks, "many small instances" is
unmeasured.

## 9. Chat vs terminal embedding

Build the chat on the Agent SDK, do not host the Claude Code TUI as the primary
pane. You cannot reverse-engineer "Claude edited src/foo.rs lines 40-70" from a
scraped terminal buffer, and every documented TUI-in-xterm.js integration hits
the same bugs (2code issue #145: scroll jumps, Kitty keyboard protocol, IME).
xterm.js 7.0 viewport fix expected around Dec 2026.

Note: the Claude Code integration report finds ToS constraints on SDK-driven
chat with subscription credentials. See ../research-stack.md for the
reconciliation.

SDK streaming gotchas: stream events are main-session only (subagent deltas
not forwarded, parent_tool_use_id null on stream events), so render complete
messages to attribute subagent activity. partial_json is not valid JSON
mid-stream, need a tolerant partial-JSON parser to show file paths live.
structured_output only lands in the final result.

xterm.js + PTY as a secondary plain-shell tab only. @xterm/addon-webgl 0.19
(WebGL2), handle webglcontextlost. Skip @xterm/addon-canvas (deprecated).

Streaming markdown: marked / markdown-it / react-markdown re-parse the whole
string per token, O(n^2). Fixes: split at block boundaries so only the last
block is live, memoize completed blocks, throttle highlighting to 10-15 Hz,
cache Shiki GrammarState at block boundaries. Copy Streamdown's code-block
strategy (plain text while streaming, Shiki once the block closes). Options:
Streamdown (Vercel, React), streaming-markdown (3 KB, append-only DOM), or
Bun.markdown server-side streaming blocks over WebSocket. @shikijs/stream
(shiki-stream archived 2026-06) allowRecalls false by default.

## 10. Packaging and distribution

Survey of 26 comparable tools: Tauri 7 (two of the biggest stalled, biggest
OSS one left), Electron 6 (Crystal, Nimbalyst, Sculptor, opencode desktop,
Obsidian, Cursor), local server + npx 4 (vibe-kanban 28k, CloudCLI 13.5k),
native GPU 4 (Zed, Warp, Ghostty, Raycast, all funded teams), bun-compiled
binary + npm optionalDependencies 3 (Claude Code 21.4M/wk, ccusage 84.6k/wk,
opencode 2.9M/wk). The last pattern has by far the best adoption.

Artifact sizes: Tauri 13-38 MB dmg but 85-114 MB AppImage. Electron 98-150 MB
per arch. bun --compile 60-110 MB. deno compile 240-257 MB. RAM is not a Tauri
win (~313 MB vs ~260 MB Electron empty app on Windows).

Recommended path:

1. v0, weeks: npx wake / bunx wake. Bun server + Vite frontend in the npm
   tarball, opens a browser tab. Zero signing, $0. Chromium --app switch for a
   chromeless window.
2. v0.5, days: personal Homebrew tap. Homebrew 6.0 made tap trust mandatory,
   put fully-qualified brew install you/tap/wake in the README.
3. v1, weeks: bun single binary + npm optionalDependencies per platform with a
   1 KB spawn shim (copy ccusage cli.js). Works with --ignore-scripts. Avoid
   postinstall downloads (vibe-kanban does this, breaks behind proxies).
   Self-update via static manifest.json like Claude Code.
4. v2: Electron, not Tauri. electron-builder + electron-updater with GitHub
   Releases feed and blockmaps.

Costs: everything $0 until a .app. Apple Developer Program $99/yr, no OSS
waiver. macOS 15+ removed Control-click Gatekeeper override, unsigned apps show
"is damaged". brew --no-quarantine removed in 6.0.13. homebrew-cask requires
Gatekeeper pass. SignPath Foundation gives OSS free Windows certs. Nobody signs
Linux. Homebrew notability: >= 75 stars, or >= 225 if self-submitted, then
BrewTestBot autobumps.

## 11. Genuinely different options

1. Skip the chat pane for v0. Wake = Claude Code in the user's own terminal
   plus a browser map that follows via hooks and transcript tailing. Drops the
   two hardest UI problems. Honest positioning: the map is the differentiator,
   not the chat.
2. Be an ACP (Agent Client Protocol) client. JSON-RPC over stdio, reuses MCP
   representations. @agentclientprotocol/claude-agent-acp (Apache-2.0, 2.4k
   stars) wraps the Agent SDK. One integration for Claude Code, Gemini CLI and
   future agents, insulation from SDK churn. Trade: ACP's abstraction, not
   Claude Code's full fidelity.
3. deck.gl as the whole map: OrthographicView, GPU transitions with enter,
   FlyToInterpolator with onTransitionInterrupt, GPU aggregation, widgets.
4. cosmos.gl if the map is a graph.
5. Rerun as the architectural template for time-scrubbing.

Ruled out: tldraw SDK (proprietary, watermark, 4,000-shape cap), Excalidraw
(Canvas 2D), MapLibre as the whole UI (Mercator-bound, steal its camera API
design instead), Bun.WebView (headless only), Verso/Servo (archived), TUI with
Kitty graphics protocol (base64 overhead, no input precision).

## 12. Recommended stack

Shell and runtime
- Bun 1.4 server. Bun.spawn terminal for PTY, Bun.serve WebSocket, fs.watch,
  Bun.markdown if it measures well.
- v0/v1 shell: the user's browser via npx wake. v2: Electron 44, same bundle.

Frontend
- Solid (or Svelte 5 with $state.raw) for chat and controls.
- Map in a Worker via OffscreenCanvas. Non-negotiable.
- WebGL2 baseline, WebGPU opt-in behind capability detection.
- Renderer: deck.gl 9.3 if its layer model fits, otherwise three.js with TSL or
  hand-rolled instanced WebGL2. cosmos.gl only if the map is a force graph.

Animation
- Per-instance attributes evaluated in the vertex shader against uNow.
- tween.js or gsap.ticker for camera and DOM chrome.
- Event-sourced state: log to reducer to typed arrays to dirty-range
  bufferSubData. Snapshot every N events. Log external query responses.
- Time scrubbing is uNow = t.

Camera
- d3-zoom for gestures, interpolateZoom for fly-to, Cinemachine-style
  FOLLOW/MANUAL/RECENTERING with damped follow and Wait + Time parameters.

Code at depth
- LOD ladder L0 quads, L1 MSDF labels, L2 token rects, L3 pooled DOM <pre> at
  rest only, 8-30 cap.
- Shiki v4 fine-grained + JS engine in a Worker, tokens as typed arrays.
- CodeMirror 6 pool of 2-3, unifiedMergeView for diffs. No Monaco.

Chat
- Agent SDK with includePartialMessages (subject to the ToS reconciliation).
  Streamdown or streaming-markdown with block-split + memoize.
- xterm.js + addon-webgl as a secondary plain-shell tab only.

Packaging
- npx, then tap, then bun binary + optionalDeps, then Electron with signing.

Runner-up: Electron from day one. Rust answer: egui/eframe +
egui_wgpu::CallbackTrait + egui_commonmark, where the chat scrollback is the
hard half ("very large UI in a scroll area can be slow" per egui README).

## 13. Risks

- WebGL in a system webview is the top risk and the reason for the shell
  recommendation.
- Browser-tab v0 exports GPU risk to the user's browser. Ship WebGL2, WebGPU
  as enhancement.
- Bun signing regressed in 1.3.12 (#29361). Pin Bun, codesign --verify in CI.
- bun build --compile needs extractFromBunfs() for the SDK, fails at runtime.
- Node/Deno silently lose SDK fast mode.
- will-change transform + CSS scale blurs overlay code. Scale via font-size.
- Compositing-layer count is a hard VRAM ceiling. The L3 cap is load-bearing.
- Naive per-token markdown re-render is O(n^2).
- Subagent deltas are not streamed. UI looks frozen during Tasks otherwise.
- No official CM6 benchmarks.
- GSAP not OSI. tldraw proprietary. Zed markdown crate GPL.
- Ecosystem churn: opcode, CodeLayer, happy-cli, claude-code-webui, Terragon,
  Crystal all stalled or died within 12 months. Keep artifact count small.
- Losing the updater private key permanently prevents updates. Back it up.
- Linux distribution cost is real. Consider npx as the Linux story.

Unverified: macOS 26 Gatekeeper beyond Sequoia, Azure Artifact Signing price,
Flathub process, whether VS Code landed ArrayBuffer transferables in webview
postMessage.

## 14. Sources

Tauri
- https://v2.tauri.app/develop/debug/linux-graphics/
- https://v2.tauri.app/reference/webview-versions/
- https://v2.tauri.app/develop/calling-frontend/
- https://v2.tauri.app/plugin/updater/
- https://github.com/tauri-apps/tauri/issues/6381
- https://github.com/tauri-apps/tauri/issues/6559
- https://github.com/tauri-apps/tauri/issues/9394
- https://github.com/tauri-apps/wry/issues/890
- https://github.com/orgs/tauri-apps/discussions/11944
- https://github.com/userFRM/tauri-plugin-macos-fps
- https://github.com/tauri-apps/tauri/tree/feat/cef

Electron, VS Code, Zed, JetBrains
- https://releases.electronjs.org/
- https://www.electronjs.org/docs/latest/tutorial/updates
- https://code.visualstudio.com/api/extension-guides/webview
- https://github.com/microsoft/vscode/issues/115411, /115807, /221145
- https://zed.dev/docs/extensions/developing-extensions
- https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html
- https://github.com/versotile-org/verso
- https://github.com/Elanis/web-to-desktop-framework-comparison
- https://www.dbreunig.com/2026/02/21/why-is-claude-an-electron-app.html

Runtime
- https://bun.com/blog/bun-v1.4
- https://bun.com/docs/api/spawn
- https://bun.com/docs/runtime/markdown
- https://bun.com/docs/bundler/executables
- https://github.com/oven-sh/bun/issues/29361
- https://nodejs.org/api/single-executable-applications.html
- https://docs.deno.com/runtime/reference/cli/compile/
- https://github.com/microsoft/node-pty

Agent SDK / ACP
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://github.com/anthropics/claude-agent-sdk-typescript/issues/216, /266
- https://agentclientprotocol.com/overview/introduction
- https://github.com/zed-industries/claude-code-acp

UI frameworks and state
- https://docs.solidjs.com/concepts/intro-to-reactivity
- https://svelte.dev/docs/svelte/$state
- https://react.dev/blog/2025/10/07/react-compiler-1
- https://github.com/pmndrs/react-three-fiber/discussions/3130
- https://github.com/nanostores/nanostores
- https://github.com/tc39/proposal-signals
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas

Animation
- https://gsap.com/pricing/ and https://gsap.com/community/standard-license/
- https://gsap.com/docs/v3/GSAP/gsap.ticker/
- https://github.com/juliangarnier/anime
- https://github.com/motiondivision/motion
- https://github.com/tweenjs/tween.js
- https://deck.gl/docs/developer-guide/animations-and-transitions
- https://github.com/cosmograph-org/cosmos
- https://threejs.org/docs/#manual/en/introduction/WebGPU-Renderer
- https://webglfundamentals.org/webgl/lessons/webgl-instanced-drawing.html
- https://caniuse.com/webgpu
- https://martinfowler.com/eaaDev/EventSourcing.html
- https://github.com/rerun-io/rerun/blob/main/ARCHITECTURE.md

Camera
- https://d3js.org/d3-zoom
- https://github.com/davidfig/pixi-viewport
- https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/
- https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineFollow.html

Code display
- https://shiki.style/guide/bundles and /best-performance
- https://github.com/shikijs/shiki/issues/599
- https://github.com/codemirror/merge/blob/main/README.md
- https://discuss.codemirror.net/t/cm6-performance-benchmarks/2471
- https://github.com/Microsoft/monaco-editor/issues/5154
- https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md
- https://tldraw.dev/sdk-features/performance
- https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
- https://www.microsoft.com/en-us/research/project/code-canvas/

Terminal and streaming markdown
- https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md
- https://github.com/AkaraChen/2code/issues/145
- https://github.com/thetarnav/streaming-markdown
- https://streamdown.ai/
- https://sw.kovidgoyal.net/kitty/graphics-protocol/

Native stacks
- https://github.com/emilk/egui, https://crates.io/crates/egui_commonmark
- https://github.com/iced-rs/iced/releases/tag/0.14.0
- https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md
- https://github.com/longbridge/gpui-component
- https://docs.flutter.dev/perf/impeller
- https://bevy.org/news/bevy-0-19/
- https://github.com/latentcat/graphpu
- https://linebender.org/blog/tmil-25/
- https://github.com/JetBrains/compose-multiplatform/releases

Packaging and comparable tools
- https://github.com/farion1231/cc-switch
- https://github.com/BloopAI/vibe-kanban
- https://github.com/ccusage/ccusage
- https://github.com/anomalyco/opencode
- https://github.com/stravu/crystal, https://github.com/Nimbalyst/nimbalyst, https://github.com/imbue-ai/sculptor
- https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- https://plus.excalidraw.com/blog/deprecating-excalidraw-electron
- https://github.com/localsend/localsend/blob/main/CODE_SIGNING.md
- https://raw.githubusercontent.com/Homebrew/brew/master/docs/Acceptable-Casks.md
- https://developer.apple.com/news/?id=saqachfa
- https://signpath.org/
- https://peter.sh/experiments/chromium-command-line-switches/
