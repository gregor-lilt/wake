# Research: rendering engines and canvas libraries

Raw research report, 2026-09-02. Versions and dates verified against GitHub and
npm APIs on that date unless flagged. Synthesis in ../research-stack.md.

## Bottom line

- 10k-50k nodes with edges, labels, 60fps, pulses and semantic zoom is
  comfortably inside the envelope of three stacks: Sigma.js v4, deck.gl v9.3
  (OrthographicView), and MapLibre GL v6 with generated vector tiles. It is
  outside the envelope of every DOM-based canvas (React Flow, tldraw,
  Excalidraw, Rete) and marginal for Cytoscape.js even with its WebGL renderer.
- The hard part is not node count. GPU quad rendering at 50k is trivial. The
  hard parts are (a) label placement and decluttering at 50k, (b) semantic zoom
  and level of detail, (c) thousands of simultaneous per-node animations without
  per-frame CPU buffer rebuilds.
- WebGPU is not a 2026 requirement. Shipped in all major desktop browsers, but
  WebView shells (Tauri on some platforms, Android WebView, WKWebView) do not
  enable it by default, and the relevant libraries are WebGL2-only in practice.
  deck.gl WebGPU is "not production ready" (no picking, no extensions, no
  TextLayer). MapLibre WebGPU "in progress". Target WebGL2.

## Comparison table

| Library | Version / date | License | Health | Render tech | 60fps ceiling | Semantic zoom / LOD | Labels | Animation | Coupling | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| Sigma.js v4 | 4.0.0-beta.5, 2026-08-20 (v3 stable 3.0.3, 2026-04-30) | MIT | 12.2k stars, 100+ commits on v4 branch, main near-dormant | WebGL2 only, single canvas, SDF shapes + SDF text atlas, GPU picking, data textures | "tens of thousands of nodes and edges", perf guide profiled at "hundreds of thousands of edges", no FPS table | No tiles, zoom-aware label density culling, depth layers, custom WebGL layers | Best in class for a graph lib. GPU SDF text, labelVisibility auto, backdrops | Style-driven state flags, GPU ForceAtlas2 in ping-pong textures, no tween engine | Vanilla + graphology, @react-sigma exists | Top pick |
| deck.gl | v9.3.11, 2026-08-28 | MIT | 14.5k stars, 401 commits since 2025-09, vis.gl / Linux Foundation | WebGL2 (luma.gl 9), WebGPU experimental | ~1M items at 60fps on a 2015 MBP (official docs) | OrthographicView + TileLayer gives real tiled semantic zoom, v9.3 added visibleMinZoom/MaxZoom, per-axis zoom | TextLayer (SDF) + CollisionFilterExtension, GPU realtime declutter, WebGL only | Best animation model: GPU attribute transitions (interpolation, spring), enter backfill, view-state interpolators. Objects keyed by array index | Agnostic core, first-class React | Top pick, best animation + LOD + headroom |
| MapLibre GL JS | v6.6.0, 2026-08-24 (v6.0.0 2026-07-22) | BSD-3 | 11.5k stars, 1303 commits (most active) | WebGL2 mandatory, ESM only | Planet scale via tiles | Semantic zoom for free via zoom expressions and tile pyramid | Best label engine, full collision boxes, variable anchors, SDF glyphs | Weakest. Camera easing great, per-feature animation means GeoJSON re-upload or feature-state churn (v6 3.4x faster) | Vanilla | Strong for the map, weak for pulses. Pair with deck.gl overlay |
| cosmos.gl | v3.4.0, 2026-07-27 | MIT | 1.26k stars, OpenJS incubating since 2025-05 | WebGL2 via luma.gl, layout and render on GPU | "hundreds of thousands of points and links" | Viewport fitting only | No native labels | Force simulation is the animation | Vanilla | Great GPU layout engine, wrong tool for a labeled hierarchical map |
| PixiJS | v8.20.1, 2026-08-26 | MIT | 48.1k stars, 228 commits, 1.06M npm/wk | WebGL2 + WebGPU, experimental Canvas fallback | 200k sprites at 60fps, 1M particles in ParticleContainer (M3, team numbers) | None, build it | BitmapText fast, no declutter | Excellent scene-graph animation, reactive render loop, ParticleContainer for trails | Vanilla | Best build-it-yourself base |
| Cytoscape.js | v3.34.2, 2026-08-25 | MIT | 11.2k stars, 15.5M npm/wk (bio) | Canvas2D, WebGL preview since 3.31 | WebGL preview: 3.2k nodes / 68k edges only 10fps | No | Center labels only in WebGL | CPU-bound | Vanilla | Rule out |
| AntV G6 | 5.1.1 latest tag 2026-04-17, 5.3.1 published 2026-05-19 (tag mismatch) | MIT | 12.3k stars, 333 open issues | Canvas default, WebGL opt-in, WASM layouts | No published scale table | No tiles | Rich styling, no scale label engine | Element animation API | Vanilla + wrappers | Skip, murky release state |
| vis-network | community | Apache-2.0 | 3.6k stars, 349 open issues | Canvas2D | Low thousands | No | Basic | Physics | Vanilla | Rule out |
| React Flow / xyflow | current | MIT | 38.2k stars, 11.2M npm/wk | DOM nodes + SVG edges | Maintainers: "not intended for that kind of scale" re 1000+ nodes | No | DOM text | React re-render storms | React only | Rule out for 10k+ |
| tldraw SDK | v5.3.2, 2026-08-18 | Proprietary tldraw license, ~$6k/yr commercial since 4.0 | 50.1k stars | DOM canvas | Hundreds to low thousands | Culling only | DOM text | React state | React only | Rule out twice |
| Excalidraw | active | MIT | 131k stars | Canvas2D + rough.js | Low thousands | No | Canvas2D | Manual | React app | Rule out |
| Konva | 10.3.2, 2026-08-26 | MIT | 14.7k stars, 1 open issue | Canvas2D, layer dirty rendering | Low thousands interactive | No | Canvas2D | Good tween API | Vanilla + react-konva | Nice API, Canvas2D ceiling |
| Fabric.js | active | MIT | 31.4k stars | Canvas2D | Low thousands | No | Canvas2D | Object-level | Vanilla | Rule out |
| Three.js (2D) | r185, 2026-07-01 | MIT | 115k stars, 2040 commits | WebGL2 + WebGPURenderer | Millions via InstancedMesh | Build it | troika-three-text SDF, no declutter | Full control | Vanilla | Viable, reimplements Sigma/Pixi |
| Babylon.js | active | Apache-2.0 | 26k stars | WebGL2 + WebGPU | High | No | No | Full | Vanilla | Overkill |
| regl | 2 commits since 2025-09 | MIT | 5.6k stars | WebGL1/2 wrapper | Whatever you write | Build it | Build it | Build it | Vanilla | Dormant, cosmos migrated off it |
| Reagraph | 1.1k stars, last push 2026-06-25 | Apache-2.0 | Modest | three.js + React | Low tens of thousands claimed | No | Basic | React | React only | Small maintainer surface |
| Ogma | commercial | Proprietary | Vendor | WebGL | "millions" (unverified) | n/a | n/a | n/a | Wrappers | Rule out for OSS |
| KeyLines / ReGraph | commercial | Proprietary | Vendor | GPU | "any scale" (unverified) | Combo grouping | n/a | Smooth | ReGraph React | Rule out for OSS |
| Graphistry | commercial | Proprietary | Vendor | Server-side GPU streams | 1M+ edges | Server | Server | Server | Python | Wrong architecture |

## Cross-cutting findings

### WebGPU in 2026

- Chrome/Edge 113+ (macOS, Windows), Chrome Android 121+, Firefox 141+ Windows
  / 145+ Apple Silicon, Safari 26+. Linux partial (Chromium 144+ Intel Gen12+,
  147+ NVIDIA Wayland). Android WebView and WKWebView do not ship it by default.
- Verdict: target WebGL2. WebGPU is a 2027+ upgrade path.

### Labels are the real bottleneck

Ranked by label engine maturity for 50k nodes:

1. MapLibre GL. Full collision-box engine, variable anchors, zoom expressions.
2. Sigma.js v4. GPU SDF atlas plus zoom-aware density culling
   (labelRenderedSizeThreshold, labelDensity), backdrops and attachments as
   primitives. A 2026 addition and a big reason v4 matters.
3. deck.gl. SDF TextLayer plus CollisionFilterExtension, GPU collision every
   frame, approximate, WebGL only.
4. PixiJS / Three.js. Fast SDF glyphs, zero decluttering, you write the grid.
5. cosmos.gl. No labels.
6. Cytoscape WebGL. Center labels only.

### Animation at scale, three architectures

- GPU attribute transitions (deck.gl). Declare transitions per accessor,
  interpolation in the shader. Sharp edge: objects keyed by array index, so
  insert/remove mid-animation breaks the transition. Workaround: stable
  pre-allocated index space for the whole graph, animate visibility/opacity.
- Simulation as animation (cosmos.gl, Sigma FA2-GPU). Positions live in
  ping-pong float textures, never touch the CPU.
- Scene-graph tweening (PixiJS, Konva, Three.js). Per-object tweens from JS,
  most flexible, you own scheduling. ParticleContainer for trails and sparks.

For Wake specifically: heat trails and fading pulses are per-node scalar decay.
The cheapest correct implementation in any of the top three stacks is a single
per-node "last touched at" float in a data texture or attribute plus a global
time uniform, decay computed in the fragment shader. Zero per-frame CPU work.
Do not use a tween library for the heat map.

### Sigma.js v4 is a significant release for this use case

From the v4 CHANGELOG and docs (4.0.0-beta.5, 2026-08-20):

- Labels migrated to WebGL SDF (were DOM/canvas in v3).
- All WebGL layers merged into one, WebGL1 dropped.
- Primitives system: pathLine, pathCurved, pathCurvedS, pathStep,
  pathStepCurved, pathLoop, layerDashed.
- Declarative styles API replacing nodeReducer/edgeReducer, internal per-node
  and per-edge state flags.
- depth layers split from zIndex for performance: changing an item's depth moves
  it between buckets "without re-processing the rest of the graph". Exactly
  "the agent just touched this file, raise it above the rest".
- GPU picking with downsized picking framebuffer, edge and label events off by
  default.
- @sigma/layer-webgl for custom WebGL layers (color layer and heatmap layer
  shipped), @sigma/layer-maplibre for a map background.

Perf guide, directly useful:

- antialiasEdges false gives up to 5x GPU gain.
- Semi-transparency is expensive. Use a solid near-background color instead.
- Every edge pays the vertex cost of the heaviest registered path. pathLoop is
  66 vertices. Register only pathLine if no self-loops.
- Frames are fragment-bound, not vertex-bound.
- Ships DEBUG_gpuTimerQueries, DEBUG_logRenderStats, DEBUG_logShaders.

Maintenance caveat: main branch had 6 commits in 12 months, all work on the v4
branch, small team (médialab Sciences Po), v4 in alpha/beta since ~April 2026
with no stable date. Betting on v4 is betting on a beta from a two-to-three
person project.

### Map-engine approach: someone is doing it, and it works

anvaka/map-of-github is the proof of concept for non-geo maps with MapLibre:
~690k GitHub repos clustered by shared stargazers, layout to GeoJSON to
tippecanoe to vector tiles to MapLibre GL. MIT, sponsored. What you get for
free: tile pyramid, per-zoom style expressions, best label collision engine,
inertial camera, PMTiles single-file hosting. What you lose: MapLibre's model
is static tiles, and Wake is about live animation. Sigma has
@sigma/layer-maplibre and deck.gl has MapboxOverlay interleaved so you can put a
real graph renderer on top of a map camera.

DataMapPlot (0.7.3, 2026-05-31, MIT, 1.0k stars) renders embedding maps with
deck.gl and implements multi-resolution semantic-zoom labels natively. The
Semantic Map of GitHub showcase is a working example. Its author first tried
deck.gl directly, then found DataMapPlot did it already. Hint about how much
semantic-zoom label plumbing you would otherwise write.

## Prior art: codebases as zoomable maps

| Project | Era | Rendering | Status | Why it died or survived |
|---|---|---|---|---|
| CodeSee | 2019-2024 | Web, D3/SVG-era maps | Dead. Shut down 2024-02-22, acquired by GitKraken 2024-05 | Business, not tech. Static architecture maps are a vitamin, not a painkiller |
| Sourcetrail | 2016-2021 | Qt desktop, custom 2D graph | Dead, archived 2021-12, 16.5k stars | Could not sustain per-language indexers plus a desktop app. The indexer, not the renderer, is the maintenance sink |
| CodeCity (Wettel and Lanza 2008) | 2008 | Smalltalk/Moose, 3D city | Research artifact | 3D city is memorable but navigation and occlusion worse than 2D |
| Software Cartography / Codemap (Kuhn, Bern 2010) | 2010 | Eclipse plugin, 2D thematic map from source vocabulary | Research, dead | Most instructive. User study: developers "found the base layout surprising and often confusing". Stable layout beats optimal layout |
| Gource | 2009-present | Native OpenGL | Alive, 13.1k stars, GPL-3 | Tiny, single-purpose, zero-config. Closest existing thing to "animated as things change", but git history not a live agent |
| GitHub repo-visualizer | 2021-2022 | Static SVG via renderToStaticMarkup | Archived | GitHub Next experiment |
| CodeFlower | 2013 | D3 force, SVG | Abandoned | Toy |
| Emerge | 2020-present | D3 force on Canvas2D | Semi-alive | Personal project, Canvas2D ceiling |
| Code Galaxies / map-of-github (anvaka) | 2016-2025 | WebGL/ngraph, then MapLibre + tippecanoe | Alive, sponsored | Treated as exploration, off-the-shelf map rendering, precomputed everything |
| CodeMap Hotel (JamsusMaximus/codemap) | 2025-2026 | Custom Canvas2D at 60fps, pixel-art, Node + Vue | Alive but small, 130 stars, last push 2026-01-15 | Nearest competitor. Visualizes Claude Code and Cursor activity live via hook injection, folders as hotel rooms, agents as characters. Limits: 10 agents, caps at ~50 rooms for 10k+ file repos. That is the Canvas2D wall Wake must not hit |
| Semantic Zoom and Mini-Maps for Software Cities (arXiv 2510.00003, Oct 2025) | 2025 | Three.js, k-means + mean-shift LOD | Research | Confirms semantic zoom plus minimap is the right model |
| CodeBoarding, LLM Code Map, Understand-Anything, various CodeAtlas | 2025-2026 | D3/SVG in VS Code webviews | Early, crowded | "Agent reads repo and draws diagram". All hit the few-hundred-node ceiling. None attempt live animation at scale |

Synthesis: almost none died from rendering performance. They died from business
model, indexer maintenance cost, and being a static artifact nobody returns to.
The one map-design lesson is Kuhn's: an unpredictable layout defeats the
purpose. The directory hierarchy is a gift, stable and already in the user's
head.

## Shortlist, ranked

### 1. Sigma.js v4 + graphology + @sigma/layer-webgl (recommended default)

Only library where every hard requirement is already a first-class feature,
built in the last 12 months by people who profiled this workload. SDF labels
with zoom-aware culling, depth layers for promoting touched items, data
textures for a per-node lastTouchedAt float, GPU picking, custom WebGL layers
with a heatmap shipped, GPU force layout and MapLibre background optional. MIT.
graphology gives graph algorithms.

Risks: v4 is beta with no stable date, small team. v3 lacks SDF labels and
depth layers. Mitigation: pin the beta, vendor if needed, keep the graph model
in plain graphology so the renderer is swappable.

### 2. deck.gl v9.3 OrthographicView + TileLayer + CollisionFilterExtension

Most headroom and best animation primitives. ~1M items at 60fps on 2015
hardware, 20x margin at 50k. OrthographicView is the documented non-geo path,
v9.3 improved it (per-axis zoom, calc() view layout). TileLayer with
OrthographicView plus visibleMinZoom/MaxZoom is a real tiled semantic-zoom
mechanism: precompute directory tiles, stream symbol tiles when zoomed in.
Spring transitions on 50k nodes for free. Healthiest large-scale option.

Risks: index-keyed transitions (allocate a stable index per node per session).
Attribute generation is the CPU wall ("99% of CPU time in updating buffers is
calling the accessors you supply"), use updateTriggers surgically, prefer
*Scale uniform props, precomputed typed arrays. More assembly than Sigma.
WebGPU path dead end for now.

### 3. MapLibre GL v6 camera + deck.gl interleaved overlay

If "Google Maps for code" is the product thesis, this is the honest way.
MapLibre handles tiles, zoom styling, labels, camera. deck.gl draws the live
layer into MapLibre's WebGL2 context via interleaved true. Pipeline follows
map-of-github: graph to layout to GeoJSON to tippecanoe to PMTiles to style.

Risks: tile regeneration latency when the graph changes structurally
(structure in tiles on a debounce, activity in the overlay live). v6 breaking
changes are recent. Two large deps plus a Python/C++ tile toolchain. Heaviest
ops burden.

### Honorable mention: PixiJS v8 as escape hatch

Best raw canvas if Sigma's model and deck.gl's data model both fight you.
200k sprites / 1M particles, WebGPU backend ready, BitmapText, ParticleContainer
built for trails. You write the graph layer, LOD, and label collision, roughly
2-4 weeks Sigma gives free.

## Concrete recommendation

- Prototype on Sigma.js v4 beta. Keep the graph in plain graphology so the
  renderer stays replaceable.
- Keep deck.gl OrthographicView as the fallback and scale plan (real tiled LOD,
  spring transitions). Migration bounded, both consume the same node/edge
  arrays.
- Treat MapLibre as a v2 metaphor bet, not a v1 engine.
- Do not build on React Flow, tldraw, Excalidraw, Konva, Fabric, Cytoscape.
- Kuhn's lesson: directory tree as base layout. Sourcetrail's lesson: the
  extractor is what eats your years.

## Uncertainty and gaps

- No published FPS-at-N benchmark for Sigma v4. Build a 50k fixture before
  committing.
- G6 release state unclear (5.1.1 vs 5.3.1), no scale benchmarks.
- Ogma and KeyLines scale claims are vendor marketing.
- cosmos.gl "over one million" is from the OpenJS post, README says "hundreds
  of thousands". Prefer the README figure.
- PixiJS figures are bunnymark-derived on an M3, team cautions they are not
  real-world.
- Web search budget was exhausted mid-research, some items filled by direct
  fetch and GitHub API.

## Sources

Graph renderers
- https://github.com/jacomyal/sigma.js
- https://v4.sigmajs.org/
- https://github.com/jacomyal/sigma.js/blob/v4/CHANGELOG.md
- https://github.com/jacomyal/sigma.js/blob/v4/packages/website/src/content/docs/how-to/technical/performance.md
- https://github.com/jacomyal/sigma.js/blob/v4/packages/website/src/content/docs/concepts/rendering.md
- https://github.com/jacomyal/sigma.js/blob/v4/packages/layout-fa2-gpu/README.md
- https://github.com/cosmosgl/graph
- https://openjsf.org/blog/introducing-cosmos-gl
- https://github.com/antvis/G6
- https://js.cytoscape.org/
- https://blog.js.cytoscape.org/2025/01/13/webgl-preview/
- https://github.com/gephi/gephi-lite
- https://linkurious.com/ogma/
- https://cambridge-intelligence.com/keylines/
- https://github.com/graphistry/pygraphistry
- https://www.sciencedirect.com/science/article/pii/S2468502X21000048 (NetV.js)
- https://github.com/reaviz/reagraph
- https://github.com/graphology/graphology
- https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/

General 2D GPU renderers
- https://deck.gl/docs/whats-new
- https://deck.gl/docs/developer-guide/performance
- https://deck.gl/docs/developer-guide/animations-and-transitions
- https://deck.gl/docs/developer-guide/webgpu
- https://deck.gl/docs/api-reference/core/orthographic-view
- https://deck.gl/docs/api-reference/geo-layers/tile-layer
- https://deck.gl/docs/api-reference/extensions/collision-filter-extension
- https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre
- https://github.com/visgl/deck.gl/discussions/5556
- https://pixijs.com/blog/8.17.0
- https://pixijs.com/blog/particlecontainer-v8
- https://pixijs.com/8.x/guides/concepts/performance-tips
- https://github.com/pixijs/bunny-mark
- https://konvajs.org/docs/guides/best-canvas-library.html
- https://github.com/regl-project/regl
- https://github.com/mrdoob/three.js
- https://github.com/BabylonJS/Babylon.js

Infinite canvas SDKs
- https://reactflow.dev/learn/advanced-use/performance
- https://github.com/xyflow/xyflow/discussions/3003
- https://github.com/tldraw/tldraw
- https://tldraw.dev/pricing
- https://tldraw.dev/community/license
- https://github.com/excalidraw/excalidraw
- https://github.com/retejs/rete

WebGPU status
- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- https://web.dev/blog/webgpu-supported-major-browsers
- https://developer.chrome.com/docs/web-platform/webgpu/overview

Map-engine approach
- https://github.com/maplibre/maplibre-gl-js
- https://maplibre.org/maplibre-gl-js/docs/
- https://arxiv.org/html/2508.10791v1 (MapLibre Tile format)
- https://github.com/anvaka/map-of-github
- https://github.com/anvaka/map-of-github-data
- https://github.com/protomaps/PMTiles
- https://docs.mapbox.com/help/dive-deeper/optimize-map-label-placement/
- https://github.com/mapbox/mapbox-gl-js/issues/4704
- https://datamapplot.readthedocs.io/en/latest/interactive_intro.html
- https://stevenfazzio.github.io/semantic-github-map

Prior art
- https://www.crunchbase.com/acquisition/gitkraken-acquires-codesee--b5a40293
- https://en.wikipedia.org/wiki/Sourcetrail
- https://github.com/CoatiSoftware/Sourcetrail
- https://www.inf.usi.ch/lanza/PUBS/P/Wett2008a.pdf (CodeCity)
- https://scg.unibe.ch/archive/papers/Kuhn10bSoftwareMaps.pdf
- https://scg.unibe.ch/archive/softvis2010-kuhn-codemap-userstudy.pdf
- https://arxiv.org/pdf/2510.00003
- https://gource.io/
- https://github.com/acaudwell/Gource
- https://githubnext.com/projects/repo-visualization/
- https://github.com/githubocto/repo-visualizer
- https://github.com/fzaninotto/CodeFlower
- https://github.com/glato/emerge
- https://anvaka.github.io/pm/
- https://github.com/JamsusMaximus/codemap
- https://www.blog.brightcoding.dev/2026/05/24/codemap-hotel-visualize-ai-coding-agents-in-real-time
- https://www.codeboarding.org/
