# Research: layout algorithms and software-map prior art

Raw research report, 2026-09-02. Version and maintenance data verified against
npm and the GitHub API on that date. Synthesis in ../research-stack.md.

## 0. Headline recommendation

1. Do not use a graph layout engine for Wake's containment structure. Use a
   deterministic, hierarchy-anchored packing keyed off the directory tree, with
   GIT-style (Greedy Insertion Treemap) incremental insertion into free space,
   quantized to a grid. Graph layout is for edges only, and even there prefer
   routing over layout.
2. Bundle edges hierarchically (Holten), not geometrically (FDEB/KDEEB).
   Hierarchical bundling derives control points from the tree Wake already has,
   so it is deterministic, iteration-free, and inherits the node layout's
   stability. Geometric bundling re-solves globally on every change.
3. The cheapest stability win is quantization. Snap everything to a grid at
   every level. "Did the layout move" becomes a discrete question, hand nudges
   become cell swaps (trivially persistable), and diffs are auditable.

## 1. Layout library table

### 1a. Hierarchy / containment layouts

| Library | Tech | License | Maintenance | Nested | Stability / pinning | Verdict |
|---|---|---|---|---|---|---|
| d3-hierarchy (treemap, pack, treemapResquarify) | JS | ISC | v3.1.2, 2022-04-02, frozen not abandoned | Native | treemapResquarify preserves previous topology, sizes only. No insert/delete stability | Baseline primitive, not sufficient alone |
| @antv/hierarchy | TS | MIT | v0.7.1, 2025-12-25 | Yes | None | Optional |
| treemap (Rust crate) | Rust | MIT | Low activity | Flat squarified | None | Squarified is the wrong algorithm for stability |
| tue-alga/TreemapComparison | Java | No license file | Last push 2020-02-18 | Yes | Reference impls of 12 algorithms incl. Local Moves, GIT, Hilbert, Moore, Spiral | Read it, port it, do not depend on it. Canonical source for LM and GIT |
| grtlr/bubble-treemaps | JS/D3 | BSD-3 | 2019 | Yes | Force-based, none | No |
| Voronoi treemaps | none maintained in JS | | | Yes | Unstable by construction (random Lloyd init), fixable via Hilbert site placement | No |

### 1b. Graph layout engines

| Library | Tech | License | Maintenance | Compound | Stability / pinning | Perf | Verdict |
|---|---|---|---|---|---|---|---|
| elkjs | Java to JS (GWT) | EPL-2.0 OR GPL-3.0 | v0.12.0, 2026-07-17, 2.7k stars, active | Yes, full compound with cross-hierarchy edges | fixed algorithm, interactiveLayout, position constraints. No native incremental relayout (issue #100 open) | Web Workers, heavyweight bundle, seconds on large graphs | Best-in-class compound layout, wrong for a live 60fps map. Mine rectpacking and topdownpacking |
| ELK rectpacking | in elkjs | same | same | No (flat boxes) | Preserves input order always, left-to-right, target aspect ratio, 4 phases | Fast | Directly relevant: "files as tiles inside a directory region" with order preservation |
| ELK topdownpacking | in elkjs | same | same | Yes | Fixed-size boxes, parent scales with child count | Fast | Directly relevant: ELK's own semantic-zoom mechanism |
| dagre | JS | MIT | v0.8.5, 2019, dead | No | None | Fast | No |
| @dagrejs/dagre | TS | MIT | v3.1.1, 2026-08-08, 5.8k stars | Clusters | None | Fast | Sub-diagrams only |
| WebCola | TS | MIT | npm v3.4.0 2019 (stale), repo pushed 2026-04-30 | Yes, nested groups | Best constraint story in JS: fixed nodes, alignment, separation, non-overlap, iterative from a given start state | Few thousand | Strong for an edge/constraint layer. Vendor it |
| cytoscape.js + fcose | JS | MIT | cytoscape 3.34.2, fcose 2.2.0 (2023-01), repo pushed 2026-04 | Yes | fixedNodeConstraint, alignment, relative placement | ~2x CoSE, Canvas | Prototype path. Known defect: fixed nodes plus compounds degrade (fcose #48) |
| @msagl/core (MSAGL-JS) | TS | MIT | v1.1.24, repo pushed 2026-09-02, Microsoft | Clusters | Sugiyama, not incremental | Benchmarked to 32,768 nodes / 236,978 edges client-side, WebGL, tile-pyramid semantic zoom, sleeve routing | Sleeper pick. The 2026 tile-pyramid paper is the closest published match to Wake's rendering problem |
| @viz-js/viz (Graphviz WASM) | C to WASM | MIT | v3.30.0, 2026-09-01 | cluster subgraphs | None, stateless | Sub-second to few thousand | Static export only |
| @hpcc-js/wasm-graphviz | C to WASM | Apache-2.0 | v1.28.0, 2026-07-24 | Yes | None | Same | Same |
| cosmos.gl | WebGL2 | MIT | v3.4.1, 2026-08-13 | No | Seedable and freezable, but force model is global | 1M+ on GPU | Renderer not layout. Legacy @cosmograph/cosmos is CC-BY-NC, use @cosmos.gl/graph |
| sigma.js + graphology | WebGL | MIT | sigma 3.0.3, graphology 0.26.0, forceatlas2 0.10.1 (2022) | No | FA2 in worker, seedable, not stable under insertion | Large | Renderer candidate. GitNexus uses it |
| d3-force | JS | ISC | v3.0.0, 2021 | No | fx/fy pinning | ~5k | Prototype only |
| @antv/layout + layout-wasm | TS + Rust | MIT | v2.0.0, 2026-02-11 | Partial | Some | Multithreaded WASM | Interesting for a WASM layout core |
| OGDF | C++ | GPL-family | pushed 2026-04-21 | Yes | Rich | Native | No maintained WASM/JS binding |
| yFiles | commercial | proprietary | active | Yes | Best incremental/partial layout | Good | Out of scope |

### 1c. Edge bundling and routing

| Library | Tech | License | Maintenance | Notes |
|---|---|---|---|---|
| d3 hierarchical edge bundling (curveBundle + d3-hierarchy) | JS | ISC | stable | Zero-cost, deterministic, tree-derived. Holten. Control points are the path through the LCA |
| d3.ForceBundle (FDEB) | JS | GPL-2.0 | 2023 | Iterative, O(E^2), non-deterministic under change. GPL blocker |
| GPUEdgeBundling | WebGL | GPL-2.0 | 2017 | Abandoned |
| KDEEB / CUBu / FFTEB | C#/CUDA | research | none | No browser path |
| libavoid-js | C++ to WASM | LGPL-2.1+ | v0.5.0-beta.5, 2026-02-23 | Orthogonal and polyline object-avoiding routing. Routes without moving nodes. Keep behind a WASM boundary |
| ELK libavoid integration | C++ via stdio | LGPL-2.1 | 2022 | "routing edges without changing node positions has been a highly requested feature for several years" |
| MSAGL-JS sleeve routing | TS | MIT | 2026 | CDT dual-graph search plus funnel algorithm. Client-side to 237k edges |

## 2. What stability means and how to measure it

Vernier, Sondag, Comba, Speckmann and Telea (CGF 2020, arXiv 1906.06014) built
the reference benchmark: 14 rectangular treemap algorithms, 2000+ datasets, 28
dynamic hierarchies from evolving software codebases.

Their baseline-relative stability metric: instability is only the movement in
excess of what the data change forced. sigma(R_i) = max(0, delta(R_i, R_i') -
delta(R_i, R_i*)), delta is corner travel, R_i* is a baseline layout with the
minimum mandated movement.

Wake should adopt this metric as a regression test: record commit sequences
from a few repos, replay through the layout, assert sigma stays under a
threshold. The single most valuable thing to steal from the literature.

Findings:

- Best stability: SND (slice-and-dice), LM0 and LM4 (Local Moves), GIT. All
  except SND are state-aware.
- Best aspect ratio: SQR (squarified) for low variance, APP for high.
- SND is most stable with worst visual quality (slivers).
- No algorithm wins both. State-aware methods degrade quality gracefully as
  change rate rises, stateless methods degrade stability catastrophically.
- Deep hierarchies (4+ levels) favor state-aware methods on both metrics.
  Wake's hierarchy is deep.

## 3. Stable treemap vs graph layout, and the recommendation

### The trade-off

A graph layout decides position from relationships, so it is globally coupled:
one new edge can move everything. Pinning, aging, cooling, constraints all
suppress that coupling and degrade quality over time. Crnovrsanin, Chu and Ma
(UC Davis) document it: pinning (Frishman and Tal) and aging (Gorochowski)
both "generate long edges and edge crossings, characteristics which degrade the
graph over time." Their fix moves parts of the graph, "at the cost of more
movement". Unacceptable for Wake: the map is a place, movement is the cost.

A containment layout decides position from the hierarchy, which for a codebase
is slowly changing, mostly append-only, with a natural total order. Every
long-lived software-map product (Seerene, CodeCharta, Understand, SonarQube
treemaps) is treemap-based, not graph-based.

### Four-part hierarchical layout

1. Deterministic key per node. Sort key derived only from path (basename sort
   within a directory, or a Hilbert index of a path hash for spatial spread).
   Reproducible from the tree alone. Same trick van Hees used to make Voronoi
   treemaps deterministic (Utrecht 2014, IST 2017).
2. GIT-style greedy insertion into free space. Vernier, Comba, Telea (SIBGRAPI
   2018): initialized squarified, then no changes to the combinatorial layout
   between time steps, new items inserted greedily into available space.
   "Simple to implement, generic, and fast." Design-point match.
   Alternatives: Local Moves (Sondag, Speckmann, Verbeek, TVCG 2018), LM4 is
   the sweet spot, more complex. SizePairs (Han et al., IEEE VIS 2022) beats
   Hilbert, LM and GIT on both metrics and is faster than LM, but is offline
   (knows the time series). Use for a history-replay mode, not live.
3. Quantize to a grid, grow parents in quantized steps. File tiles occupy
   integer cells in their directory region. Region extent is a rounded-up
   block, so most insertions consume slack and cause zero movement. Growth
   events are rare and explicable ("src/api grew a row"). ELK rectpacking
   already implements the phases (width approximation, row placement,
   compaction, expansion) with unconditional order preservation. ELK
   topdownpacking implements the semantic-zoom half. Read both, implement in
   own code rather than pulling a GWT-transpiled bundle.
4. Nudges as constraints on the quantized layout. A nudge is {nodeId,
   cellDelta} or {nodeId, absoluteCell}. Persist, replay as a hard constraint
   after the deterministic pass, resolve collisions by pushing non-pinned
   neighbors. Exactly solvable on a lattice, unlike continuous constraint
   solvers (fcose #48 failure mode).

### Reject, and why

- Voronoi treemaps. Random init makes each run different. Fixable at the cost
  of Lloyd relaxation per frame. Non-rectangular cells make quantization,
  labels and sub-layout harder.
- Circle packing (d3 pack, GitHub repo-visualizer). Circles waste 20-30% area,
  do not nest cleanly, reflow on insertion. repo-visualizer archived
  2026-01-22.
- Force-directed containment (Gource). Author: "getting this to behave well in
  most situations was the most time consuming part of the project." Gorgeous
  as a movie, useless as a map.
- Vocabulary-based positioning (Kuhn's Software Cartography). Stable because
  vocabulary is stable, but deliberately decouples position from the directory
  tree. Steal as an optional alternate projection ("by topic, not by folder").
- treemapResquarify as the whole answer. Solves resize stability only.

### Where graph layout belongs

Only inside a single file tile at symbol zoom, and even there source line order
is the right layout: deterministic 1D key, matches the user's mental model,
zero algorithm. fCoSE or WebCola only for a call-graph sub-view that abandons
file order on purpose.

## 4. Edge bundling recommendation

Hierarchical edge bundling (Holten 2006) computed from Wake's directory tree.

- Control points are the path up and over the LCA. Pure function of node
  layout, inherits its stability. No iteration.
- Already in d3 (curveBundle with beta tension). No new dependency.
- Composes with semantic zoom: directory-to-directory bundles with
  weight-encoded thickness at project zoom, file-to-file at file zoom,
  individual calls at symbol zoom. The bundle is the aggregate.

Two behaviors from prior art:

1. Hover-to-unbundle. Wattenberger's decision in repo-visualization: "I only
   show connections from and to a file on hover." Wallinger and Kobourov (arXiv
   2607.20089, 2026): bundling enables bundle-level tasks and disables
   element-level precision. Need both modes.
2. Orthogonal routing as an optional style. libavoid-js (LGPL, WASM) or
   MSAGL-JS sleeve routing (MIT). Both route without moving nodes.

Reject for live view: FDEB (iterative, O(E^2), GPL), KDEEB/CUBu (no browser
path). If geometric bundling is ever needed, current frontier is spectral
sparsification bundling (Jiang et al., arXiv 2604.26994, April 2026) with
faithfulness metrics that measure whether a bundling lies about the structure.

## 5. Label placement and decluttering across zoom

Adopt the mapping industry's solution wholesale.

- Per-label minzoom, not per-frame re-decision. Mapbox GL: "label placements
  must be continuous so labels don't jump around when zooming." Assign each
  label a minimum zoom once, test collisions in screen space.
- Rank nodes once, build a tile pyramid. Nachmanson and Chen, "Browsing Large
  Graphs with Tile Pyramids and Sleeve Routing in the Browser" (arXiv
  2605.17498, May 2026): at every zoom the labels of the highest-ranked nodes
  stay readable, like major geographic features. Client-side in MSAGL-JS
  WebGL, benchmarked to 32,768 nodes / 236,978 edges. Read before writing the
  renderer.
- Semantic zoom plus a mini-map, both validated by two user studies (Hansen et
  al., arXiv 2510.00003, ExplorViz). A minimap is cheap and users want it.
- LOD selection driven by screen-space budget, not zoom level alone
  (Limberger, Scheibel, Trapp, Döllner, patent US9953443B2).
- Ranking for Wake: directory > file > symbol as base tier, then by a stable
  structural signal (fan-in, LOC). Do not put edit recency in label priority,
  labels will flicker as the agent works. Recency goes in color and motion.

## 6. Prior-art lessons, attributed

On stability

- Vernier et al. (CGF 2020): no algorithm wins both stability and aspect
  ratio. Pick the objective explicitly, measure relative to forced movement.
- Vernier, Comba, Telea (GIT, 2018): designing for stability from the start
  beats retrofitting. Forbidding combinatorial changes is what buys it.
- Sondag, Speckmann, Verbeek (Local Moves, 2018): quality and stability both,
  if you only change the layout through local modifications.
- van Hees (2014, 2017): Voronoi instability is random init, not Voronoi.
  Audit every source of nondeterminism (hash order, Set iteration, float
  accumulation, worker races) before blaming the algorithm.
- Han et al. (SizePairs, 2022): if you know the future you beat every online
  method. Exploit for history replay.
- Crnovrsanin, Chu, Ma: pinning and aging accumulate long edges and crossings.
  Containment layout avoids the trap, no energy to accumulate.
- Kuhn, Loretan, Nierstrasz (WCRE 2008): "Software has no physical shape ...
  most visualizations use a layout in which position and distance have no
  meaning." Wake's differentiator is committing to one meaning for position.
- Steinbrückner and Lewerentz (EvoStreets, 2010): stable-by-construction is
  achievable, the price is compactness. Budget for whitespace.
- Archambault and Purchase, "The Map in the mental map" (IJHCS 2013): no
  experiment has conclusively shown mental-map preservation improves
  comprehension of dynamic graphs. A 2025/2026 process-mining study found
  stabilizing had no positive effect and a significant negative impact.
  Stability is a product requirement (the map feels like a place, nudges are
  worth doing, screenshots compare), not a proven comprehension requirement.
  Do not oversell it in the README.

On software maps that shipped

- Wettel, Lanza, Robbes (CodeCity, ICSE 2011): +24% correctness, -12% time vs
  Eclipse plus Excel, but only on big-picture tasks, not detail tasks.
  CodeCity shows no dependencies at all. Sell the overview, hand off to the
  editor for detail.
- Bohnet and Döllner to Seerene: the one commercially durable software map.
  Survived by selling to executives (portfolio governance), not developers.
- Sourcetrail (16.5k stars, archived 2021-12): killed by JetBrains shipping
  go-to-definition and call hierarchies free, not by layout quality. Users
  loved navigation, not the picture. The map must be a navigation surface, not
  a poster, and it must be free.
- CodeSee to GitKraken (2024): codesee.io returns 404 as of 2026-09-02.
  Automated code maps get acquired as a feature, not sustained as a product.
- GitHub Next repo-visualizer (archived 2026-01-22): most durable idea was
  distribution, a GitHub Action committing an SVG into the README. Integration
  surface matters more than the algorithm.
- Gource (13.1k stars, pushed 2026-03-06): a movie player, not a tool. There is
  enormous appetite for watching code change. Do not confuse watching with
  using.
- CodeCharta (501 stars, BSD-3, pushed 2026-09-01, MaibornWolff since 2017)
  and Emerge (1.1k stars, MIT): the realistic bar for an OSS project here.
- NDepend's Dependency Structure Matrix: "DSM scales better than graph." Have a
  matrix view as the escape hatch when the map gets too dense.
- Visual Studio Code Map: Enterprise edition only, dead by pricing.
- Structure101, Lattix, Understand: alive, sold on architecture governance and
  rule enforcement. Maps that enforce something survive.
- Adoption literature (Sensalire, Merino "Software visualization today" 2016):
  barriers are unfamiliarity, cognitive-model mismatch, immature interfaces,
  scalability, interoperability, overhead. Every one is a product requirement:
  zero setup, lives where the developer already is, maps to an existing task.

On the 2025-2026 AI codebase-map wave

- GitNexus (46.9k stars): tree-sitter in the browser, knowledge graph, MCP,
  UI via sigma.js force-directed. Layout stability is not a design goal.
  Nearest competitor on mindshare, weak on exactly Wake's axis.
- Codebase Memory MCP (~39k stars): extraction is solved and commoditized.
  Consume an existing index rather than build another parser.
- Prevailing framing: "the visualization being optional and the routing logic
  being the product." Wake's bet is the opposite: a human watching an agent
  needs a place. State the contrast explicitly.
- "LLM Agents Can See Code Repositories" (arXiv 2606.14061): visual repo
  renderings cut agent input tokens up to 26% with accuracy maintained.
  Pure-vision degrades. Hybrid wins. The map has a plausible second customer,
  the agent, as a supplement.
- "Illuminating LLM Coding Agents" (arXiv 2508.12555) and TraceView (arXiv
  2606.22110): visualize agent trajectories, not the code substrate. That
  niche is getting crowded, the stable-substrate niche is not.
- CodeLayers (2026): 3D dep graph, VS Code plus GitHub Action plus Vision Pro.
  The actual product is blast radius: changed files red, affected deps by hop
  distance. "What does this change touch" is the killer question and a color
  ramp over hop distance answers it. Wake gets this nearly free from edges.
- Sourcegraph (2026): Cody Free/Pro terminated, enterprise only. No self-serve
  developer market for code comprehension.
- Augment context engine: Merkle-tree diffs over the working copy for
  incremental re-indexing. Steal the Merkle invalidation, it also yields the
  change-event feed to animate.

## 7. Academic frontier 2023-2026

| Paper | Date | Why it matters |
|---|---|---|
| Nachmanson and Chen, Tile Pyramids and Sleeve Routing, arXiv 2605.17498 | 2026-05 | Read first. Semantic zoom with rank-preserving labels, sleeve routing, client-side WebGL, 32k nodes / 237k edges |
| Wallinger and Kobourov, Task Taxonomy for Edge Bundling, arXiv 2607.20089 | 2026-07 | Bundling enables global tasks and disables element precision. Justifies hover-to-unbundle |
| Jiang et al., Spectral Sparsification Bundling, arXiv 2604.26994 | 2026-04 | SOTA geometric bundling with faithfulness metrics |
| Li et al., NCP Neighborhood-Preserving Circle Packing, arXiv 2602.00668 | 2026-01 | Rigorous version of repo-visualizer |
| Paetzold et al., Neighborhood-Preserving Voronoi Treemaps, arXiv 2508.03445 | 2025-08 | SOTA if you insist on Voronoi |
| Li et al., Semantic Zooming and Edge Bundling for Supply Chain Flow, arXiv 2604.08823 | 2026-04 | Reference implementation of Wake's exact pattern (macro bundles, meso density, micro detail), Vue3 plus deck.gl |
| Hansen et al., Semantic Zoom and Mini-Maps for Software Cities, arXiv 2510.00003 | 2025-08 | Two user studies, both features help |
| Behroozi et al., Regular and Spiral Treemaps, arXiv 2308.16855 | 2023-08 | Optimization model as ground-truth oracle for layout tests |
| Han et al., SizePairs, IEEE VIS 2022 | 2022 | Offline SOTA, use for history replay |
| Ba, Thorgeirsson, Su, Code Semantic Zooming, arXiv 2510.06452 | 2025-10 | n=26, matched Claude Code usability, 90%+ felt more in control. Evidence that a zoomable abstraction over agent code is a real need |
| Liang et al., Rendered Code for Coding Agents, arXiv 2608.09268 | 2026-08 | Companion to SeeRepo |
| Mental Maps in Process Mining, Springer LNCS 978-3-032-02867-9 ch.31 | 2025/26 | The negative result. Paywalled, verify before citing |

Gap: no paper on stable layout for agent-driven code change, none combining a
stable hierarchical software map with live edit streaming. Wake is in open
territory.

## 8. Sources

Treemap stability
- https://ar5iv.labs.arxiv.org/html/1906.06014
- https://github.com/tue-alga/TreemapComparison
- https://eduardovernier.github.io/dynamic-treemap-resources-eurovis/docs/treemaps/algorithms/
- https://pubmed.ncbi.nlm.nih.gov/28866573/ (Local Moves)
- https://ieeexplore.ieee.org/document/8614324/ (GIT)
- https://virtual.ieeevis.org/year/2022/paper_v-full-1163.html (SizePairs)
- https://arxiv.org/abs/2308.16855
- https://arxiv.org/pdf/2508.03445
- https://arxiv.org/abs/2602.00668
- https://www.macs.hw.ac.uk/~jh2054/downloads/rinsevanhees-msc.pdf
- https://www.sciencedirect.com/science/article/abs/pii/S0950584916302828
- https://d3js.org/d3-hierarchy/treemap
- https://vanwijk.win.tue.nl/stm.pdf

Graph layout engines
- https://github.com/kieler/elkjs and https://github.com/kieler/elkjs/issues/100
- https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-rectpacking.html
- https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-topdownpacking.html
- https://github.com/dagrejs/dagre
- https://github.com/tgdwyer/WebCola and https://github.com/tgdwyer/WebCola/wiki/Constraints
- https://github.com/iVis-at-Bilkent/cytoscape.js-fcose (issue #48)
- https://github.com/microsoft/msagljs
- https://arxiv.org/abs/2605.17498
- https://github.com/cosmosgl/graph
- https://www.npmjs.com/package/@viz-js/viz
- https://www.npmjs.com/package/@antv/layout-wasm
- https://github.com/ogdf/ogdf

Dynamic layout and mental map
- https://vis.cs.ucdavis.edu/papers/tarik_incremental.pdf
- https://www.sciencedirect.com/science/article/abs/pii/S107158191300102X
- https://link.springer.com/chapter/10.1007/978-3-032-02867-9_31

Edge bundling and routing
- https://arxiv.org/abs/2607.20089
- https://arxiv.org/abs/2604.26994
- https://arxiv.org/abs/2604.08823
- https://github.com/upphiminn/d3.ForceBundle
- https://www.adaptagrams.org/documentation/libavoid.html
- https://eclipse.dev/elk/blog/posts/2022/22-11-17-libavoid.html
- https://github.com/Aksem/libavoid-js
- https://gist.github.com/mbostock/1044242

Labels and semantic zoom
- https://medium.com/mapbox/map-label-placement-in-mapbox-gl-c6f843a7caaa
- https://arxiv.org/abs/2510.00003
- https://patents.google.com/patent/US9953443B2/en

Software cartography prior art
- https://arxiv.org/abs/1209.5490 (Kuhn, Loretan, Nierstrasz)
- https://scg.unibe.ch/archive/papers/Kuhn10bSoftwareMaps.pdf
- https://dl.acm.org/doi/10.1145/1985793.1985868 (Wettel, Lanza, Robbes)
- https://d-nb.info/1036129632/34 (Steinbrückner, Consistent Software Cities)
- https://www.seerene.com/our-company

Tools and postmortems
- https://github.com/CoatiSoftware/Sourcetrail/issues/1214
- https://news.ycombinator.com/item?id=28637193
- https://www.gitkraken.com/press/gitkraken-acquires-codesee-launches-devex-platform
- https://githubnext.com/projects/repo-visualization/
- https://gource.io/
- https://github.com/MaibornWolff/codecharta
- https://github.com/glato/emerge
- https://www.ndepend.com/docs/dependency-structure-matrix-dsm
- https://learn.microsoft.com/en-us/visualstudio/modeling/map-dependencies-across-your-solutions?view=vs-2022
- https://dl.acm.org/doi/10.1145/2994310.2994327

AI codebase-map wave
- https://github.com/abhigyanpatwari/GitNexus
- https://github.com/DeusData/codebase-memory-mcp
- https://www.augmentcode.com/context-engine
- https://codelayers.ai/blog/complete-guide-code-visualization-2026
- https://sourcegraph.com/blog/changes-to-cody-free-pro-and-enterprise-starter-plans
- https://arxiv.org/abs/2606.14061
- https://arxiv.org/abs/2508.12555
- https://arxiv.org/pdf/2606.22110
- https://arxiv.org/abs/2608.09268
- https://arxiv.org/abs/2510.06452
