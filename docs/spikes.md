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

(filled in as spikes complete)
