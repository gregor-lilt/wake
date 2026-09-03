# Spikes before M0

Each spike is one to three evenings, kills one specific risk from
research-stack.md, and ends with a written verdict in this file. Order matters:
1 and 3 decide the renderer and the layout, everything else depends on them.

## Spike 1: renderer fixture at scale

Risk: no published FPS benchmark exists for a 50k-tile deck.gl scene, and none
at all for Sigma.js v4.

Build: a synthetic repository shape (5 top-level regions, 400 directories, 50k
files, 200k symbols hidden until zoom) rendered with deck.gl OrthographicView.
SolidPolygonLayer for regions and cities, ScatterplotLayer for buildings,
PathLayer for 20k bundled edges, TextLayer with CollisionFilterExtension for
labels. Camera fly-to between regions.

Measure: fps at continent, country and city zoom on a Mac (Apple Silicon) and a
Linux box (Intel or NVIDIA), in Chrome and Firefox. Frame time breakdown from
the browser profiler.

Pass: 60fps at all three zoom levels on both machines with labels on.
Fail: below 30fps anywhere. Then try the hand-rolled instanced WebGL2 renderer
on the same fixture before considering Sigma.

## Spike 2: shader-driven traffic

Risk: deck.gl transitions are index-keyed and CPU-scheduled. The plan needs a
per-node lastTouchedAt evaluated against a time uniform with zero per-frame JS.

Build: on the spike 1 fixture, add a custom attribute per city (lastTouchedAt)
and a per-edge attribute (linkVolume, lastTraversed). Inject a shader hook
(deck.gl layer extension or a subclassed layer) that computes fade and pulse
from uNow. Fire 200 random touch events per second from a worker for one
minute. Then set uNow backward to test scrubbing.

Pass: no measurable frame-time increase during the event storm, scrubbing is
instant, no visual artifacts on insert or delete of a city.
Fail: deck.gl's layer model fights the injection. Then the fallback is the
instanced renderer where the shader is ours from the start.

## Spike 3: stable geography on a real repository

Risk: the whole plan rests on a layout that does not move when the code
changes. This is the assumption with the least prior art.

Build: a TypeScript layout module. Input: a directory tree with file sizes.
Output: nested quantized rectangles with slack, siblings ordered by a frozen
coupling order (use import counts). Greedy insertion into free space for new
files, discrete region growth when slack is exhausted.

Run: replay 50 consecutive commits of one real repository with 5k to 10k files
(candidate: a mid-size Python or TypeScript monorepo you know). After each
commit compute the Vernier baseline-relative instability (corner travel minus
the minimum the change forced) and the mean aspect ratio.

Pass: median instability near zero, 95th percentile bounded to one region's
slack, aspect ratios acceptable to the eye. Screenshots of commit 1 and commit
50 side by side look like the same map.
Fail: regions reflow on ordinary commits. Then implement Local Moves (LM4) as
the alternative before touching anything else.

## Spike 4: hook round-trip and approval in place

Risk: the steering milestone assumes http hooks, hot-reloaded deny rules, and
a held-open PermissionRequest hook all behave as documented.

Build: a Bun server on localhost with one /hook endpoint. A Claude Code
project with hooks.json pointing PreToolUse, PostToolUse, PostToolBatch and
PermissionRequest at it. A minimal browser page listing incoming events with
timestamps and one Approve / Reject button for pending edits.

Run: a live Claude Code session in a scratch repo doing a small multi-file
edit. Approve one edit, reject one, rewrite one via updatedInput. Write a deny
rule for a subdirectory into settings.local.json mid-session and ask the agent
to edit there. Send a PostToolBatch continue false and observe.

Pass: every tool call arrives with tool_input and tool_response, approval
holds the agent until the click, the rewritten edit is what lands on disk, the
fence denies without restart, the batch gate stops the loop.
Fail: any of these is undocumented in practice. Record which and downgrade the
corresponding steering feature in PLAN.md.

## Spike 5: indexer speed

Risk: the plan needs 50k files cold in a few minutes and sub-second per-file
updates. Prior art (codegraph, codebase-memory-mcp) claims it. Verify in our
own stack.

Build: a Rust binary. Walk with ignore, hash with blake3 into a per-directory
Merkle tree, parse with tree-sitter 0.27 and tree-sitter-tags for Python and
TypeScript, write symbols and import edges to SQLite. Extract and drop each
tree. Watch with notify, 1s debounce, reparse only changed files.

Run: cold index of the spike 3 repository and of one 50k-file repository
(candidate: a large open-source monorepo checked out locally). Then edit one
file and time the update.

Pass: 50k files under 4 minutes cold on a laptop, single-file update under
0.5s, peak memory under 1 GB.
Fail: parse-tree memory or grammar quality. Record which languages and which
constructs failed, then decide whether tags.scm forks are needed before M0.

## Verdicts

Machine for all numbers: Apple M3, 8 cores, 16 GiB, macOS, 2026-09-02.

### Spike 1: renderer fixture. PASS on this Mac, Linux and Firefox legs open

deck.gl 9.3.11, OrthographicView, WebGL2, headless Chromium 151 via ANGLE Metal,
1600x1000. 50k cities, 200k symbols, 20k bundled edges.

| Zoom | Median frame | p95 | fps |
|---|---|---|---|
| continent (50k cities in view) | 8.3 ms | 9.8 ms | 120 (vsync) |
| country (16.9k) | 8.3 ms | 9.9 ms | 120 |
| city (969 cities, 159 labels) | 8.3 ms | 10.0 ms | 120 |
| street (buildings on) | 8.3 ms | 10.1 ms | 120 |

Stress: dpr 3 (14.4 Mpixel) 68-81 fps. 200k files / 800k symbols / 80k edges
120 fps except street 91 fps. Traffic demo at 50 touches/s: no change.

Pain points to carry: CollisionFilterExtension hid all labels with a parked
camera (its collision map only re-renders on viewport change, and first render
happens before the font atlas exists). Worked around by nudging the camera for
24 frames when the label set changes. Collision tests the anchor not the box,
so use center baseline. FlyToInterpolator is geospatial only, non-geo needs
LinearInterpolator and a hand-written van Wijk curve. No viewport culling inside
a layer. Binary data object identity must stay stable across zoom or every step
re-uploads ~10 MB. Code: apps/spike-renderer, screenshots and bench JSON there.

### Spike 3: stable geography. PASS on stability, FAIL on compactness

50 commits of a real 8.7k-file TypeScript monorepo (repo A, a private codebase used as local test data only), replay 6.9 s, median layout
67 ms. 46 of 49 transitions bit-identical for every pre-existing node, 47 of 49
with zero movement outside changed directories. Median instability 0.00 cells,
p95-of-p95 4.95 cells, worst 71. Root extent 128x256 unchanged for all 50
commits. Mean aspect 1.60, worst 3.00 (the cap). Deterministic across runs.
Greedy insertion is sufficient, Local Moves not needed.

Whitespace 73.5% (22 slack, 14 borders, 37 growth reserve) against a 25-35%
target. Structural: rigid nested rectangles pay area at every one of 11 levels.
Dropping growth reserve to zero costs 40x worst-case movement and still leaves
75% whitespace as fragmentation.

Design findings, now requirements: file footprint must be decoupled from byte
size (largest blobs were 16 MB fonts, uniform 1x1 cells pack a 686-file flat
directory losslessly). When one child dominates its parent, growth must evict
the smaller siblings, never relocate the large one (first version moved 4,523
nodes on a 30-file commit). Borders only at the top two levels, slack only at
leaves and only for regions with more than ~8 children (851 of 1,446 regions
hold 4 cells or fewer). All instability came from new directories, never from
edits. Coupling order vs size order gave identical stability, freezing at first
sight makes order fragility moot. Next: size growth reserve from git history
per directory instead of uniformly. Code and snapshots: packages/layout.

### Spike 4: hooks. PASS on what runs headless, approve-in-place pending

Real http hooks fired from headless claude -p runs: PreToolUse, PostToolUse
(with tool_input, tool_response, duration_ms), PostToolBatch, Stop, all with
session_id, transcript_path, cwd, permission_mode. Fence deny worked live (agent
reported blocked, file untouched). Batch gate stopped the loop after 2 turns.
SessionStart and PermissionRequest never fire headless, so approve-in-place
needs the interactive run in apps/spike-hooks/RUNBOOK.md. Selftest: 44
assertions pass.

Doc mismatches: "async": true is command-hooks only, http hooks are always
synchronous and add latency to the loop. PostToolBatch.tool_calls carry
tool_response, not the documented success/output. Stop has no stop_reason.
Edit tool_response.structuredPatch gives the per-edit diff without reading the
transcript.

### Spike 5: indexer. PASS with margin, TypeScript tags query must be forked

Rust, tree-sitter 0.27.0, tree-sitter-tags 0.27.0, tree-sitter-python 0.25.0,
tree-sitter-typescript 0.23.2, ignore 0.4.33, notify 8.2.0, blake3 1.8.7,
rusqlite 0.40.2. rustup update to 1.98 was required (MSRV 1.90).

| Repo | Files | Symbols def/ref | Imports | Unresolved | Cold | Warm | 1 file | Peak RSS |
|---|---|---|---|---|---|---|---|---|
| microsoft/TypeScript | 65,938 | 46.6k / 72.2k | 18.5k | 97% | 11.6 s | 9.3 s | 9.1 s | 166 MiB |
| repo B, Python, committed venv included | 52,071 | 516k / 2.2M | 202k | 83% | 30.8 s | 12.4 s | 11.0 s | 479 MiB |
| repo A, TypeScript monorepo | 8,605 | 2.0k / 20.3k | 35.1k | 71% | 2.9 s | 1.3 s | 1.3 s | 70 MiB |

Watch mode single-file reparse 2-100 ms, a 30-append burst collapsed by the 1 s
debounce into one 94 ms reparse.

Stock tree-sitter-typescript tags.scm is unusable: 1,972 definitions in 7,263 TS
files and zero call references (misses class_declaration, arrow-const
functions, method_definition, enums, type aliases, calls). The forked query
behind --fork-ts-tags fixes it at no cost. Python tags.scm is exact. Warm
rescan is bound by per-file open+read (~0.14 ms/file), an (mtime, size)
pre-filter is the next optimization. tsconfig baseUrl is the biggest resolution
gap (~11k of repo A's 25k unresolved imports point at real files). Relative
resolution is near-exact. Code: crates/wake-index.

### Spike 2: shader-driven traffic. Not started

Depends on spike 1's fixture. Next.
