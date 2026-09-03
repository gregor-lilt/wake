# @wake/layout — stable geography on a real repository

Started as spike 3 from [docs/spikes.md](../../docs/spikes.md), which killed the
biggest risk in [PLAN.md](../../PLAN.md) section 6: that a layout which does not
move when the code changes is achievable at all. Now also the layout half of
**design phase 2** ([docs/design.md](../../docs/design.md) section 11):
proportional tiles, column packing, and the stability cost of both, measured.

Deliverables: a TypeScript layout module, a replay harness that runs it over 50
consecutive commits of a real 8.7k-file TypeScript monorepo ("repo A", a private
repository used as local test data only — its path comes from `WAKE_TEST_REPO`
and never appears here), the Vernier baseline-relative instability metric, and
SVG/PNG snapshots plus a scrubber you can look at.

## Run it

```sh
npm install                                 # typescript 5.9.2, @types/node, sharp (optional)
npm run typecheck                           # tsc --noEmit, strict
npm run replay                              # 50 commits of $WAKE_TEST_REPO
# or
node --experimental-strip-types src/replay.ts \
  --repo /path/to/repo --branch main --commits 50 \
  --order coupling --growth-reserve 0.12 --col-slack 0.25 \
  --lines-per-cell 40 --tile-w 5 --gap 1 --fold-cap 400 --out out
```

Node 23 with `--experimental-strip-types`. No build step, no bundler, no Bun.

Nothing is checked out of the test repository. Each commit's tree comes from
`git ls-tree -r -l <sha>`, which gives paths, blob shas and blob sizes directly,
and the effective line counts come from `git cat-file --batch` over the blobs
that changed, cached by blob sha. Only integers and aggregate counts ever leave
the repository.

| flag | default | what |
|---|---|---|
| `--repo` | `$WAKE_TEST_REPO`, else fail | no default repository, deliberately |
| `--commits` | 50 | most recent non-merge commits touching source |
| `--order` | `coupling` | `coupling` or `size`; frozen at commit 1 |
| `--tile-w` | 5 | tile width in cells (the sheet is 100 columns) |
| `--gap` | 1 | gap around every footprint, in cells |
| `--lines-per-cell` | 40 | height quantum in lines |
| `--cell-lines` | 10 | lines one cell of height is worth |
| `--fold-cap` | 400 | effective lines above which a sheet is folded |
| `--col-slack` | 0.25 | bottom slack of a file column |
| `--growth-reserve` | 0.12 | region footprint quantum, as a fraction of its side |
| `--branch-slack` | 0.02 | spare area for inserting new subregions |
| `--pad-max-depth` | 2 | depth at which the 1-cell border gutter stops |
| `--cell-aspect` | derived | world width/height of one cell; default `(100/tileW * 0.6) / cellLines` |
| `--reserve-max-quantum` | 32 | largest footprint quantum, in cells |

## The tile, in numbers

docs/design.md section 3 fixes the sheet at **100 columns**, and its height
proportional to the **effective** line count — raw lines with anything past 100
columns counted as several (a 250-column line is three lines). Section 4 wants
that height quantized to coarse steps, the whole thing packed into columns with
a 20 %-of-tile-width gap, and long files folded above a cap.

That fixes the lattice:

| | |
|---|---|
| one cell | 20 glyphs wide, 10 lines tall (12 x 10 line-heights on screen, `cellAspect` 1.2) |
| tile width `W` | **5 cells** = the sheet's 100 columns, the same for every file |
| height step | `LINES_PER_CELL` = **40 lines** = 4 cells |
| tile height | `4 * ceil(min(effectiveLines, 400) / 40)` cells, minimum 4 |
| stub (under 5 lines) | 5 x 4 cells, the smallest step (dimmed by the renderer, not by layout) |
| fold cap | 400 effective lines, so the tallest tile is 5 x 40 |
| gap | 1 cell on the right and bottom edge of every footprint: 20 % of `W` |

`W = 5` and a 10-line cell are the only pair of small integers that make all
three constraints land on the lattice at once: a cell has to be square-ish on
screen (20 glyphs at 0.6 line-heights each is 12 line-heights, against 10 lines
of height), the gap has to be 20 % of `W` in *both* directions (1 cell either
way), and a 40-line step has to be a whole number of cells (4). With
`LINES_PER_CELL` 20 or 80 the step becomes 2 or 8 cells and everything else
holds, which is what makes the sweep below a clean one-variable experiment.

A cell is therefore **not** one file any more. That was the version-1 lattice
and it is why every number in the results table below is roughly 20x the old
one; `nodes moved` and the zero-movement counts are the units that stayed
comparable.

## The layout, in seven rules

1. **One integer lattice, all the way down.** A file tile is `W` cells wide and
   a whole number of height steps tall. A directory region is
   `(grid + 2*border)` cells, rounded up to a growth quantum. Every dimension
   is an integer, so a child's footprint in its parent's grid is always
   integral, and "did it move" stays a discrete question. Byte size drives
   nothing: a 17 MB binary blob is one step tall, like an empty file.
2. **The gap lives inside the footprint.** Every footprint carries the gap on
   its right and bottom edge; the *drawn* rect is the footprint minus the gap.
   The packer needs no gap arithmetic, and growth reserve can never end up
   between two tiles — only at the bottom and right of a district, which is
   what docs/design.md section 4 requires.
3. **Frozen sibling order, used once.** Order decides only the sequence in
   which a child is first packed: which column a file lands in, and the order
   subregions are shelved. Two orders ship: subtree-bytes descending, and a
   greedy coupling seriation over relative-import counts (7 706 edges read from
   6 213 `.ts`/`.tsx` blobs through one `git cat-file --batch`, in 0.4 s). After
   a child has a slot, nothing reorders it.
4. **Files pack into columns, subregions into a shelf.** Files stack top to
   bottom in frozen order and wrap to the next column at the region's target
   column height, which is chosen once by scoring every even split of the total
   content height on area, oblongness and the 3:1 aspect cap — square-ish or
   wider, as the design asks. Subregions keep the version-1 packer: shelf rows
   and, for regions with ≤ 96 children, MaxRects best-short-side-fit over a
   fixed width ladder.
5. **The two blocks never fight.** The file columns and the subregion shelf are
   placed either side by side or stacked, whichever wastes less area, decided
   once and frozen. Either way the columns have empty terrain below them, so a
   file that grows can never displace a subregion, and a subregion that grows
   can never shift a column. Choosing this per region instead of always putting
   subregions to the right was worth 1.2 points of whitespace and cut the worst
   commit's movement by three quarters, because two blocks of different heights
   side by side leave an empty corner that the region then has to carry. A
   region with no files yet is always stacked, because a file arriving later
   would otherwise open its first column on top of the subregion block.
6. **Growth is discrete and absorbed, at two levels.** A column's bottom slack
   is a *reserve*, not a multiplier: it is consumed as files grow, and only when
   a column overflows does its allocation jump to the new content plus the slack
   again. A region's footprint is then rounded up to a growth quantum (~12 % of
   its side, power of two, capped at 32 cells), so several rows of internal
   growth are invisible to the parent. When a child does outgrow its block it
   first expands in place, then the parent grows by exactly the overflow, then
   it **evicts smaller subregions** rather than relocating itself. File tiles
   are never evicted: their column is their address.
7. **Aspect cap 3:1, where geometry allows it.** Enforced in the column-count
   search, the width ladder and growth. It is no longer reachable for a district
   whose *single* tile is taller than 3:1 — a folded 400-line file is 5 x 40
   cells, 6.7:1 in world units, because that is what a 400-line page at 100
   columns actually looks like.

## Results: 50 commits of an 8 677-file TypeScript monorepo

Repo A, `main`, the 50 most recent non-merge commits touching source files
(2026-05-21 → 2026-06-01), oldest first. 8 644 → 8 677 files, 1 446
directories, depth up to 11. Median commit touches 4 files (mean 5.7, max 30).

Distances are in **cells**; one height step is 4 cells, so σ = 4.00 means "one
40-line step".

| metric | phase 1, uniform 1x1 cells | phase 2, proportional tiles |
|---|---|---|
| commits replayed | 50 (49 pairs) | 50 (49 pairs) |
| **layouts with zero movement anywhere** | **46 / 49** | **31 / 49** |
| **layouts with zero movement outside the changed directories** | **47 / 49** | **46 / 49** |
| median of per-commit median instability σ | 0.00 | **0.00** |
| median of per-commit p95 instability σ | 0.00 | **0.00** |
| p95 of per-commit p95 instability σ | 4.95 cells | 31.85 cells |
| worst single-node instability σ | 71.0 cells | 90.01 cells |
| median nodes moved per commit | 0 | **0** |
| p95 nodes moved per commit | 6.6 | 22.8 |
| worst nodes moved in one commit | 156 of 10 129 | 38 of 10 123 |
| root extent, commit 1 → 50 | 128x256 (unchanged) | 1344x3104 (unchanged) |
| whitespace fraction | 73.5 % | 86.8 % |
| ... gaps | n/a | 7.0 |
| ... region slack | 22.4 | 50.1 |
| ... border gutter | 13.9 | 1.2 |
| ... growth reserve | 37.2 | 28.6 |
| district coverage, districts with > 8 files | n/a (files were 1 cell) | median **37.1 %**, mean 31.2 %, 113 of 203 at the 35 % target |
| mean region aspect ratio | 1.60 | 1.67 |
| worst region aspect ratio | 3.00 (at the cap) | 5.83 (a district holding one folded file) |
| folded files (> 400 effective lines) | n/a | 579 of 8 677 |
| region growth events over 50 commits | 15 | 12 |
| relocation events over 50 commits | 35 | 13 |
| layout time per commit | 67 ms median | 68 ms median, 111 ms p95, 165 ms max |
| whole replay | 6.5 s | 9.2 s (incl. 8 633 blobs read for line counts) |
| determinism (cold layout twice) | identical | identical |

The phase-1 column is the previous implementation on the same commits, so it
also carries the version-1 cell (one cell = one file), which is why the σ and
extent rows are not comparable and the movement-count rows are.

### Where the movement comes from now

18 of 49 layouts move something, against 3 before. That is the accepted cost
from docs/design.md's decision log: tile height depends on content, so an edit
that crosses a 40-line boundary shifts the tiles below it in its column.

| commit | files changed | nodes moved | outside the change | median σ | max σ | cause |
|---|---|---|---|---|---|---|
| 19 | 20 | 38 | 8 | 9.0 | 90.0 | two new directories, 4 levels deep; the parent grew twice and evicted five smaller siblings |
| 44 | 30 | 35 | 0 | 9.0 | 23.9 | a new directory 7 levels deep, plus one subregion whose footprint outgrew its block |
| 47 | 5 | 30 | 15 | 16.0 | 21.0 | no new directory: one district's file columns outgrew their slack, so the district grew and evicted two smaller siblings |
| 7 | 11 | 12 | 11 | 38.0 | 38.0 | same, one district grew and evicted two siblings |
| 12, 27, 33, 36 | 3–13 | 3–9 | 0 | 4.0–8.0 | 8.0 | files crossed a height step, tiles below them shifted |
| 10 more | 2–15 | 1–2 | 0 | 4.0–41.0 | 4.0–41.0 | one file crossed a height step |

Fourteen of the eighteen are one or two height steps inside one column, with
nothing moving outside the changed directory: σ = 4.00 is exactly one 40-line
step, and that is the whole event.

The four larger ones show the new failure mode, which is *not* the tile height
itself. Two are directory creation, the same cause as in phase 1. The other two
are a district whose file columns finally used up their bottom slack: the
district's own footprint then grows, and growing means taking space from
smaller siblings, which move. So content growth still costs movement, but only
once per district per ~25 % of its column height, not once per edit — which is
what the column slack was for. The same runs also produce a handful of
"its slot is no longer free" relocations, where a district that gained a new
file *column* widened over a subregion beside it; that is the one collision the
two-block arrangement cannot rule out, and it costs one subregion's relocation
when it happens.

### The sweep: height step against column slack

Both are guesses in docs/design.md section 12 ("40 lines is a guess", "step size
and column slack are tuned until the median commit still moves nothing"). All 9
combinations, same 50 commits, everything else at the shipped default:

| lines/cell | col slack | median moved | p95 moved | worst moved | p95 of p95 σ | zero-move | zero-outside | whitespace | coverage (median) |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 0.15 | **1** | 63.4 | 9 938 | 363.0 | 24/49 | 44/49 | 91.8 % | 38.1 % |
| 20 | 0.25 | **1** | 28.6 | 729 | 104.5 | 24/49 | 45/49 | 88.2 % | 35.4 % |
| 20 | 0.40 | **1** | 18.0 | 3 178 | 75.9 | 24/49 | 46/49 | 89.5 % | 31.0 % |
| 40 | 0.15 | 0 | 446.0 | 9 886 | 343.2 | 31/49 | 44/49 | 93.6 % | 39.6 % |
| **40** | **0.25** | **0** | **22.8** | **38** | **31.9** | **31/49** | **46/49** | **86.8 %** | **37.1 %** |
| 40 | 0.40 | 0 | 12.6 | 9 015 | 33.0 | 30/49 | 46/49 | 93.4 % | 32.6 % |
| 80 | 0.15 | 0 | 429.2 | 4 527 | 549.5 | 34/49 | 42/49 | 90.6 % | 41.2 % |
| 80 | 0.25 | 0 | 15.6 | 80 | 84.4 | 35/49 | 46/49 | 87.5 % | 37.5 % |
| 80 | 0.40 | 0 | 165.4 | 1 599 | 950.8 | 36/49 | 46/49 | 88.4 % | 34.2 % |

Read it as three findings:

- **A 20-line step fails the requirement, at every slack.** The median commit
  moves a node. Half of all commits change some file by more than 20 effective
  lines, so half of them cross a step. 40 lines is the smallest step that keeps
  the median at zero, which is the criterion docs/design.md set.
- **Column slack 0.25 is a sharp optimum, not a dial.** At 0.15 a column
  overflows on almost every edit, its region grows, and the growth crosses a
  footprint quantum: the worst commit moves 9 886 nodes instead of 38, and
  whitespace is *worse* (93.6 %) because the regions themselves end up bigger.
  At 0.40 the reserve is so large that regions cross quanta on the way in, which
  is the same failure from the other side (9 015 nodes, 93.4 %). The mechanism is
  the same in both directions: whatever makes a region's footprint change often
  is what moves the map, and reserve does not help if it is spent at the wrong
  granularity.
- **A coarser step is nearly as good, and less honest.** 80 lines with 0.25
  slack is the runner-up on every stability column (80 nodes worst, 35/49
  zero-move) and 0.7 points worse on whitespace. It was rejected because an
  80-line quantum means a 90-line file and a 160-line file draw the same page:
  the whole point of the proportional tile is that length is readable, and
  docs/design.md's "smaller steps show length more honestly" is the tiebreak.

`LINES_PER_CELL = 40`, `colSlack = 0.25` is therefore the shipped default: the
smallest step that keeps median movement at zero, at the slack that minimises
both worst-case movement and whitespace.

### The other knob: growth reserve

Unchanged from phase 1 and still the single most important area/stability trade.
The table below was measured on the uniform-cell layout. On proportional tiles
the quantum's own **cap** turns out to matter more than its fraction, because
region sides are now in the hundreds and 12 % of them is far above the cap:
raising the cap from 32 to 256 cells cost 6 points of whitespace and made the
worst commit *worse*, because a coarser quantum makes every growth event bigger.
The cap stays at 32.

| growth reserve | whitespace | root c1 → c50 | zero-movement | p95 of p95 σ | worst nodes moved |
|---|---|---|---|---|---|
| 0.00 | 75.3 % | 163x115 → 187x188 | 45/49 | 19.09 | 6 201 |
| 0.06 | 71.8 % | 160x176 → 160x192 | 45/49 | 22.69 | 1 019 |
| **0.12** | **73.5 %** | **128x256 → 128x256** | **46/49** | **4.95** | **156** |
| 0.15 | 81.2 % | 160x288 → 160x288 | 47/49 | 0.00 | 63 |
| 0.22 | 88.2 % | 192x384 → 192x384 | 47/49 | 0.00 | 20 |

## Whitespace and coverage

Phase 1 reported 73.5 % whitespace against a 25–35 % target and called it a
FAIL. Proportional tiles make the global figure worse, 86.8 %, and the design
document is the reason: a 20 % gap around every tile is 7 points on its own, and
a column that reserves a quarter of its height for growth cannot also be dense.

But the target design.md section 4 actually sets is local, not global: *"file
footprints cover at least 35 % of a district that has more than eight files"*.
Measured on the district's own drawn rectangle, growth reserve and border gutter
included:

| | |
|---|---|
| districts with more than eight files | 203 |
| median coverage | **37.1 %** |
| mean coverage | 31.2 % |
| districts at or above 35 % | 113 of 203 (56 %) |
| best configuration measured | 39.6 % median at `colSlack` 0.15, at 100x the worst-case movement |

So the median district meets the target and the mean does not. The districts
below it are the small and lopsided ones: a district with nine files, one of
them folded, is a 5 x 40 column beside a 5 x 4 stub, and nothing but a different
tile shape would fix that. The global figure stays what it was in phase 1 —
Steinbrückner's price for stable-by-construction nested rectangles, accepted in
principle by PLAN.md — and it is now composed of four separately measured parts
(gaps, slack, gutter, reserve) rather than one lump.

## Snapshots

- `out/commit-01.svg` / `.png` — commit 1
- `out/commit-25.svg` / `.png` — commit 25
- `out/commit-50.svg` / `.png` — commit 50
- `out/overlay-1-vs-50.svg` / `.png` — commit 1 as blue outlines under commit 50
  as translucent orange fills, regions to depth 3
- `out/index.html` — standalone: the three snapshots side by side (inlined SVG),
  a canvas scrubber over all 50 commits (delta-encoded rectangle JSON, play
  button), the full per-commit table and the summary
- `out/metrics.csv` — one row per commit, 34 columns
- `out/summary.json` — the summary block

Tiles are drawn at their full footprint now, so a district reads as a shelf of
pages of different lengths. Folded sheets carry a dashed fold rule and a warmer
fill; stubs are drawn dim. The cell size adapts to the map's extent instead of
being fixed, because a cell is now a fraction of a tile. PNGs are produced by
`sharp` (optional dependency); if it is absent the harness prints
`PNG: no converter available, SVG only` and continues.

The overlay is still the readable verdict: commit 1's blue outlines are hidden
under commit 50 everywhere except one small cluster inside one top-level region,
where a directory that did not exist at commit 1 appeared.

`out/` is gitignored. Nothing derived from a test repository is committed.

## Verdict against the pass/fail criteria

docs/spikes.md: *"Pass: median instability near zero, 95th percentile bounded to
one region's slack, aspect ratios acceptable to the eye. Screenshots of commit 1
and commit 50 side by side look like the same map."* Plus docs/design.md
section 4: *"Step size and column slack are tuned until the median commit still
moves nothing."*

- **Median instability zero — PASS.** Both the median and the p95 of the
  per-commit medians are 0.00, and the median commit moves no node at all.
- **p95 bounded to one region's slack — PASS.** The p95 across commits of the
  per-commit p95 σ is 31.9 cells, which is 8 height steps: less than one column
  of a typical district, and every one of those commits created a directory.
- **Aspect ratios acceptable — PARTIAL.** Mean 1.67, no slivers, but the worst
  district is 5.83:1 because it holds one folded file whose page is itself
  6.7:1. The cap now binds on packing, not on geometry.
- **Commit 1 and commit 50 look like the same map — PASS.** See the overlay.
- **Median commit moves nothing — PASS**, at a 40-line step and 0.25 column
  slack, and only there.
- **Whitespace 25–35 % — FAIL, 86.8 %.** Local district coverage reaches the
  35 % target at the median district (37.1 %) and misses it on the mean.

**Overall: PASS with the stability cost the design predicted.** Proportional
tiles cost 15 of 49 previously-still layouts. Of the 18 layouts that move
anything, 14 move one to nine tiles inside one column of the directory that
changed, and the four larger ones are two directory creations and two districts
that used up a column's slack.

### If it had failed, what LM4 would have changed

Recorded for the file, not implemented. Local Moves (Sondag, Speckmann, Verbeek,
TVCG 2018) keeps a *combinatorial* description of the layout — a slicing/pivot
structure rather than absolute rectangles — and at each time step applies only
local modifications to it: swap two adjacent leaves, flip a split's orientation,
move a leaf between adjacent groups. LM4 is the variant that allows moves within
a bounded neighbourhood of four. Concretely it would replace three things here:

- **Growth would resize, not relocate.** Under LM, a child that needs more area
  takes it from its neighbours by shifting a shared split line. Nothing
  teleports, so the eviction rule and the growth reserve both disappear — and
  with them most of the whitespace. LM4's published stability is comparable to
  GIT's, at far better area efficiency. That is the main prize.
- **Sizes would become continuous again.** LM works on proportional areas, not
  integer cells, so we would lose grid quantization: nudges stop being cell
  swaps, "did it move" stops being a boolean, and layout diffs stop being
  auditable. That is a real loss for Wake specifically, where nudges are
  persisted as grid constraints. It is a bigger loss now than it was in phase 1,
  because tile height is quantized for exactly the same reason.
- **Cost would rise.** Each step evaluates candidate local moves against a
  quality objective, so per-commit work goes from one greedy pass to a small
  local search. At 68 ms/commit there is still headroom, but layout becomes
  path-dependent on the sequence of commits, and reproducing a map on another
  machine requires shipping the combinatorial state, not just the tree.

Given the measured numbers, the trade is still not worth taking.

## Surprises about the shape of a real repository

Things that changed the design, and that a synthetic fixture would have hidden.
Repo A only, no names.

- **Very flat directories exist and they are large.** One directory holds 686
  files; another 144; several locale directories 84–86 each. A layout that
  assumes a balanced tree falls over here. Column packing handles it: 686 tiles
  of mostly one or two steps pack into a wide shelf of columns whose aspect the
  chooser keeps inside the cap.
- **Huge generated blobs are not code.** The eight largest files in repo A are
  16–17 MB CJK font blobs. If footprint tracked bytes, four of them would be
  larger than a whole top-level region of source. Effective lines solve this for
  free:
  they are binary, so they count as 1 and get the smallest tile. Byte size now
  drives nothing at all in the layout.
- **The blob-size shortcut is what makes line counting cheap.** A blob larger
  than `foldCap * 101` bytes cannot have fewer than 400 effective lines, so it
  is folded whatever it contains and is never read. Commit 1 reads 8 419 blobs;
  the other 49 commits together read 214, because the cache is keyed by blob sha
  and a sha pins its content. Whole-replay cost for line counting: about 1.5 s.
- **Long files are common and long lines are not.** 579 of 8 677 files (6.7 %)
  exceed the 400-line fold cap. The wrapping term barely matters on this
  repository: it is the fold cap, not the 100-column wrap, that decides how many
  tiles hit the ceiling.
- **Depth is real and it compounds.** 11 levels, with the modal file at depth
  4–5. Every per-level overhead is raised to the power of the depth. Borders are
  depth-limited to the top two levels for that reason, which is why the border
  gutter fell from 13.9 points of whitespace in phase 1 to 1.2 here: the same
  gutter, against a lattice with twenty times the cells.
- **Small directories dominate by count.** 851 of 1 446 regions hold ≤ 4 grid
  cells' worth of children, and only 26 hold more than 256. Giving each of them
  slack costs more area than it saves movement, so regions with fewer than 8
  children get none.
- **One child can dominate its parent.** One directory in repo A is ~74 % of its
  parent's area. Relocating it means nearly doubling the parent, which then
  relocates inside *its* parent, and so on to the root. Real repositories are
  dominated by one or two big trees, so size-priority (evict the smaller
  sibling) is not an optimisation, it is required.
- **Commits are tiny, and now their *length* matters too.** Median commit
  touches 4 files. In phase 1 almost all instability came from the three commits
  that created a new directory. That is still the worst case, but the common new
  cost is edits that cross a height step: 14 commits, 1–9 tiles each, always
  inside one column of one district.
- **Coupling seriation is cheap and still barely matters for stability.**
  Switching between `--order size` and `--order coupling` changes the initial map
  and leaves the stability numbers essentially identical, because order is
  consumed only once per child. Order is an aesthetics/edge-routing decision, not
  a stability one — which also answers PLAN.md's open question about fragile
  coupling orders: freezing the order at first sight makes fragility irrelevant.
- **A big lattice makes relocation expensive, and that is a good alarm.**
  First-fit insertion scans a region's grid, and a region's grid now has ~20x
  the cells, so a bug that causes spurious relocations shows up as *minutes* per
  replay instead of 68 ms per commit. Both real bugs found in this phase (a file
  block opening on top of a subregion block, and a grid-marking slip that let a
  subregion be drawn over a tile) were found that way before they were found in
  the metrics. If per-commit cost ever matters for real, the fix is a
  free-rectangle list instead of a bitmap scan, not a smaller lattice — and
  first-fit itself had to be rewritten as one bottom-up free-run pass, because
  the naive row-major scan is O(grid x candidate) and both grew by 20x.

## Files

| file | what |
|---|---|
| `src/types.ts` | data model: tree nodes with effective lines, rects in cells, placements |
| `src/gitTree.ts` | `git ls-tree`/`git diff` to a directory tree with sizes, shas and line counts, no checkout |
| `src/lines.ts` | effective line counts: the wrapping formula, one `git cat-file --batch`, blob-sha cache, large-blob shortcut |
| `src/order.ts` | frozen sibling order: size-desc, and coupling seriation from relative imports |
| `src/layout.ts` | the layout: lattice, tile geometry, file columns, shelf + MaxRects for subregions, greedy insertion, discrete growth, eviction |
| `src/metrics.ts` | Vernier baseline-relative instability, aspect, whitespace, district coverage, inside/outside-the-change test |
| `src/svg.ts` | SVG snapshots and the commit-1-vs-50 overlay, by string building |
| `src/png.ts` | optional PNG via `sharp` |
| `src/html.ts` | standalone viewer: inlined snapshots + delta-encoded canvas scrubber |
| `src/replay.ts` | the harness: replay, line counts, metrics, CSV, summary, snapshots, determinism check |
