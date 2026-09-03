# Spike 1: renderer fixture at scale

Kills the risk in `docs/spikes.md` section "Spike 1": no published fps benchmark
exists for a 50k-tile deck.gl scene. This is a throwaway fixture, not product
code. It renders a synthetic repository as a geographic map with deck.gl 9
`OrthographicView` on WebGL2 and measures frame times at four zoom levels.

## Run it

```
cd apps/spike-renderer
npm install
npm run dev            # http://localhost:5199
```

Other commands:

```
npm run build          # tsc --noEmit && vite build
npm run bench          # headless bench suite, writes screenshots/bench*.json
npm run screenshots    # PNGs at four zoom levels + the two main bench runs
WAKE_EXPORT=<name> npm run phase1   # design phase 1 checks: type and sheet
WAKE_EXPORT=<name> npm run phase2   # design phase 2 checks: geography
WAKE_EXPORT=<name> npm run phase5   # design phase 5 checks: labels and wayfinding
WAKE_EXPORT=<name> npm run phase6   # phase 6 checks: aggregated schematic, roads, chrome, quiet pass
WAKE_EXPORT=<name> npm run splash   # splash checks, both data sources
HEADED=1 npm run bench # same bench in a visible window
```

URL parameters (all optional): `data=<name>` loads a real repository export
instead of the synthetic fixture (see below), `bench=1` runs the fly-through on
load,
`view=continent|country|city` opens at that zoom, `file=<repo-relative path>`
is the deep link and lands on that file at the start of the reading band
(`view=street|source|reading` are aliases, `view=schematic` aims at the middle
of the schematic band instead), `diffrev=<git ref>` diffs against a ref instead
of the working tree, `rowpx=N` overrides the row height the deep link aims for,
`l3row` overrides the reading threshold for benching, `theme=light`,
`labels=0`, `edges=1` turns the whole road network on (it is off by default:
roads follow the hovered or focused file), `debug=1` brings the old debug panel
back, `traffic=1`, `autopilot=1` starts the agent-session
demo, `wait=8` / `recenter=1.5` set the takeover parameters in seconds,
`seek=30000` starts the simulated session part way in, `sessionSeed=N` picks a
different session, `collide=0` disables the label collision filter, `nohud=1`
hides the panels, `nosplash=1` skips the loading splash (every playwright
script passes it), `dpr=N` sets `useDevicePixels`,
`seed`/`files`/`symbols`/`edges`/`dirs`/`cross` resize the fixture.

## What to look at

- **Continent.** Five muted territories with borders, sub-region borders inside
  them, region names only, and the trunk motorway network. `01-continent-dark.png`
- **Country.** One region fills the screen. Sub-region names and the top city
  names appear. Light cross-region roads switch on. `02-country-dark.png`
- **City.** Individual files as city blocks on a quantized grid with slack, file
  names placed by the collision filter, local roads visible. `03-city-dark.png`
- **Street.** The middle of the schematic band (one source line 5 px tall).
  Symbols appear as small blocks inside each city, coloured by kind, because
  the synthetic fixture has no source to draw instead. `04-street-dark.png`
- **Geography, on a real export.** `31-band-terrain.png` .. `34-band-reading.png`
  are the four bands and `35-fold-marker.png` a folded page in the reading
  band, written by `npm run phase2`. All gitignored.
- **Wayfinding, on a real export.** `41-schematic-mid-district.png` (stacked
  sticky region labels in the middle of a nested district),
  `42-reading-sticky-header.png` (sticky file names, scope rows and the
  gutter), `43-jump-bar.png` (the bar, cropped), `44-edge-marker.png` (the
  off-screen agent arrow), `45-gutter-schematic.png` and
  `46-terrain-jump.png`, written by `npm run phase5`. All gitignored.
- **Phase 6, on a real export.** `51-fit-all-root-district.png` (the whole
  repository at the world fit, every tile carrying its aggregated schematic,
  with the root files district bordered and labelled),
  `52-terrain-schematic-texture.png` (the aggregated texture up close),
  `53-hover-roads.png` (one file's incident roads and nothing else),
  `54-agent-card.png` (the card, cropped),
  `55-reading-band-mid-pan.png` (source overlays halfway through a pan) and
  `56-reading-band-edit-glow.png` (the replay following an edit into the
  reading band: the sheet border and its sticky strip glow, the source carries
  no wash, and the trip line stops at the paper),
  written by `npm run phase6`. All gitignored.
- **Light theme.** `05-continent-light.png`, `06-country-light.png`
- **Traffic demo.** 50 random cities per second brighten and fade over 2.2 s.
  `07-city-traffic-dark.png`
- **Labels off.** `08-continent-nolabels.png`
- **Autopilot mid-follow**, city zoom, one trip marker in flight and three
  recently touched cities glowing. `09-autopilot-follow-dark.png`
- **Autopilot during a cross-region jump**, camera pulled back to country zoom
  on its own. `10-autopilot-crossjump-dark.png`

Buttons fly to each region and to each zoom level, `fit all` returns to the
whole map. Drag to pan, scroll to zoom, hover a tile to see its roads, click it
to focus it. The permanent chrome is the jump bar at the top and the agent card
at the bottom left; the controls panel on the right starts collapsed and
remembers its state in `localStorage` (`c` toggles it, the chevron in its corner
does the same). `?debug=1` adds the old debug panel top-left, with `h` to
collapse it.

## What to judge

1. Does it hold 60 fps at every zoom level with labels on, on your machine and
   in your browser. That is the pass condition in `docs/spikes.md`.
2. Does it read as a map or as a diagram. Region borders, whitespace between
   cities, road weight, label density and halos are the levers.
3. Are the semantic zoom steps in the right places, or does detail arrive too
   early or too late.
4. Does the aggregated schematic read as the repository at the world fit, or as
   noise. It is the one thing the terrain band now has to carry.
5. Are the hovered file's roads enough, or is the whole network missed.

## What it builds

| Piece | File | Notes |
|---|---|---|
| Synthetic repository | `src/repo.ts` | 5 regions, 400 directories 2-4 deep, 50k files (lognormal size), 200k symbols, 20k edges, 15% cross-region. One seed, typed arrays for everything except names |
| Lattice | `src/lattice.ts` | One cell is 20 glyph columns by 10 source lines. Fixes the world scale, the row height, the tile's 5-cell width and its 40-line height step, and the 400-line fold cap. Shared by both data paths |
| Layout | `src/layout.ts` | Squarified treemap over subtree *tile footprint* with per-depth padding, then file tiles packed into columns on the lattice inside each directory. Deterministic and hierarchical, but **not** the stable incremental algorithm from PLAN.md, that is spike 3 and `packages/layout` |
| Roads | `src/edges.ts` | Holten hierarchical bundling. Control polygon = chain of directory centroids from source up the tree and back down, blended toward the straight line by beta, sampled as a uniform cubic B-spline with tripled endpoints |
| Wayfinding | `src/wayfind.ts` | Sticky region labels, sticky file headers with their scope row, the jump bar and the off-screen agent marker. All DOM, positioned each frame from `viewport.project`, pooled |
| Scope | `src/scope.ts` | The enclosing class and function of a line: real containment from the export's symbol spans, with `parentId` for the breadcrumb, and an indentation heuristic as the fallback for a schema-2 export |
| Labels | `src/labels.ts` | Two styles, both anchored to a rect: district names tracked and inset inside their own top-left corner, file names as captions above the sheet. Ranked once by structural importance (fan-in + size), each gets a minzoom, then placed per zoom bucket, fitted, and capped before it reaches the TextLayer |
| Layers | `src/main.ts` | `PolygonLayer` for regions, `SolidPolygonLayer` (binary) for 50k cities and 200k buildings, three `PathLayer`s (binary) for trunk motorways, light motorways and local roads, `TextLayer` + `CollisionFilterExtension` for labels |
| Camera | `src/main.ts` | deck.gl `OrthographicView` controller plus `LinearInterpolator` fly-to. `FlyToInterpolator` is geospatial only |
| Real export loader | `src/exportmap.ts` | Fetches an export and presents it through the same `Repo` and `Layout` shapes as the synthetic fixture, so no renderer code branches on the source |
| Simulated session | `src/session.ts` | 40 trips over 90 s, read A then edit B, 15% cross-region, 18% bursts of 5-8 edits in one directory, tool calls 0.5-3 s apart. Deterministic, loops |
| Autopilot runtime | `src/autopilot.ts` | Emits events on the clock, keeps the 10 s touch window, animates one marker per trip along its road, keeps a decaying link volume per road |
| Activity per band | `src/main.ts`, `src/schematic.ts` | The tile fill glow's weight ramps from 1 at rowPx 6 to 0 at rowPx 9 (`tileGlowWeight`), so it is gone in the reading band. Its complement drives a 2-3 px amber glow on the sheet border and on the sticky header strip, fading on the slow 600 ms duration. Trip roads are Liang-Barsky clipped against the sheets in view, and the marker and the arrival pulse stay off the paper |
| Autopilot camera | `src/camera.ts` | FOLLOW / MANUAL / RECENTERING with Unity's `smoothDamp` (critically damped, frame-rate independent) |
| Tokenizer | `src/tokens.worker.ts`, `src/code.ts` | Shiki 4.4.3 in a worker, fine-grained bundle, JS RegExp engine, six languages. Typed-array runs plus a palette, cached per content hash and theme, one pass feeding both code tiers |
| Diff | `src/diff.ts` | Unified diff to per-line changes plus removals anchored at the line they sat in front of. Removal run followed by an addition run is a modification |
| Schematic tier | `src/schematic.ts` | World-space quads per token run, class and function bands, changed lines in the right margin, the fold marker's dashes. Clipped to the 96-column text box with a per-vertex fade. Cached per file, because the row height no longer follows the camera at all |
| Source tier | `src/overlay.ts` | Pool of 8 DOM `<pre>`, positioned by deck's own `viewport.project`, transparent, row height and text box taken from the sheet, visible line range only |
| Sheet | `src/schematic.ts` | The map's one row height, the bands, the tier with its hysteresis, the sheet geometry (the tile, its margins, its fold) and the closed form for "what zoom makes one line N px tall" |
| Code ladder | `src/codeview.ts` | The global tier per frame, on-demand fetch and tokenize, the unblur, the focus pose and the sheet audit |
| Bench | `src/bench.ts`, `scripts/bench.mjs` | Four zoom levels, 900 ms fly, 1100 ms settle discarded, 6 s sampled. Suspends autopilot so the bench owns the camera |

All large geometry goes to the GPU as binary attributes (`_normalize: false`,
`positionFormat: 'XY'`, per-vertex `Uint8Array` colours), and the data objects
keep their identity across zoom changes so deck.gl does not re-upload ~10 MB of
attributes on every zoom step.

## Loading a real export

The renderer can read a real repository plus a real Claude Code session instead
of the synthetic fixture. `packages/export` writes that file to
`<wake>/.wake/exports/<name>.json`. `.wake/` is gitignored and the file stays
there. **`schemaVersion` 2 or 3**: version 1's rects mean "one cell is one
file", which would draw the map at a twentieth of its scale, so the loader
rejects them with a message rather than rendering something wrong. Re-run the
exporter. Version 3 keeps version 2's rects, ids and edges and adds real symbol
spans, the definition's indentation column and the enclosing symbol's id, which
is what the sticky scope row reads (see "Wayfinding").

```
npm run dev
open http://localhost:5199/?data=<name>&autopilot=1
```

`vite.config.ts` adds a dev-and-preview middleware that serves
`/data/<name>.json` straight out of that gitignored directory. The name is
sanitised and the resolved path is checked to stay inside it.

**The leak rule.** An export is derived from a private codebase. Nothing from it
may enter the tracked tree: do not copy the JSON into this package, into
`public/`, or anywhere else under version control, and do not write a repository
name or any of its paths into code, comments, README text or committed
screenshots. The renderer fetches the file at run time, holds it in memory, and
displays the repository name and commit in the HUD. That is the only place they
appear. `npm run screenshots` takes the two real-export shots only when you pass
the name at run time (`WAKE_EXPORT=<name> npm run screenshots`), and those two
files are gitignored.

What changes on the export path:

- Directories become regions, nesting by `parent`. The repository root is drawn
  as the land underneath, its top-level directories are the coloured regions,
  and files that sit directly in the root belong to the root's own region.
- Files use the rects from the export, scaled from layout cells to world units.
  **A cell is not a file any more** (see "Map geometry"): the rect IS the drawn
  tile, five cells wide and one cell per ten effective lines, and nothing is
  inset or shrunk. Byte size drives nothing.
- Symbols get no rect in the export, so they are laid out inside their file's
  rect in source order by `lineStart`, which is what the synthetic path does
  with its own symbol order.
- Roads come from the `edges` array and route through the same
  `routePath` bundling.
- Every zoom threshold and label minzoom is an offset from the zoom at which
  the world fits, and the road and symbol thresholds also shift with how many
  roads and symbols there actually are. A repository with 375 local roads shows
  all of them at continent zoom, one with 17,000 does not.

The session replays instead of the synthetic one. A real session spans hours or
days with idle gaps, so playback ignores the timestamps and plays one event
every 1.5 s (HUD slider, 0.2 to 4 s). The HUD shows the real wall-clock time of
the current event. The **event** slider is a scrubber over event index: it jumps
the replay and recomputes glows and link volumes from the preceding events, so
what you see is what the session had built up at that point, already fading.
Events that carry no file node (a message, a search, a shell command naming
nothing tracked) show in the HUD and nowhere on the map. Reads glow faintly,
edits and writes strongly, `run` events in between.


## Map geometry

Design phase 2. One fact fixes the whole world scale: **a lattice cell is 20
glyph columns wide and 10 source lines tall**, which is what
`packages/layout` cut the tiles from and what `packages/export` writes in
`rects`. `src/lattice.ts` holds it and nothing else derives a scale
independently.

```
CELL_WORLD = 48                     world units per cell (arbitrary, one number)
rowWorld   = CELL_WORLD / 10 = 4.8  world units per source line   <- the k of rowPx
colWorld   = CELL_WORLD / 20 = 2.4  world units per glyph column
rowPx      = clamp(rowWorld * zoomScale, 0, 18)
```

`rowWorld` is **not fitted to the data** any more. Phase 1 took the median over
all files of "the row height that makes this file fill its tile", which is why
`k` was 0.195 on one export and something else on the next; now it is a
property of the lattice, the same on the synthetic fixture and on any export,
and every band sits at a fixed zoom:

| band | rowPx | zoom | what is drawn |
|---|---|---|---|
| terrain | under 1 | under -2.26 | regions with borders and names. Every tile carries its schematic as texture, aggregated so a bar row is never thinner than a pixel |
| schematic | 1 to 9 | -2.26 to 0.91 | one bar row per source line. File labels wherever they fit |
| reading | 9 to 18 | 0.91 to 1.91 | the real source on the same sheet, diff inline |

Three bands, not four: the review of the labels phase deleted the tile-only
`blocks` band, because a tile with no texture in it is not a place.

Maximum zoom is 1.91 on every dataset, because it is where `rowPx` reaches 18.
Fit-all lands at zoom -4.77 on the demo export (448 x 512 cells = 21504 x 24576
world units), so the whole ladder is 6.7 zoom units wide.

**The tile.** Width is `5` cells = **100 columns** for every file. Height is
`4` cells per 40-line step, minimum 4, capped at 40 cells:

```
tileCellsH(effectiveLines) = 4 * ceil(min(effectiveLines, 400) / 40)
```

So a stub is 5 x 4 cells (40 rows of paper), a 214-line file 5 x 24 (240 rows),
and a folded file 5 x 40 (400 rows). Every footprint carries a one-cell gap on
its right and bottom edge, which is the 20 % gap `docs/design.md` section 4
asks for, and the gap is **outside** the rect: the rect is the page.

**The sheet is the tile, exactly.** Nothing is squeezed and nothing overflows:
`rowH` is `rowWorld` at every band, so a file of N effective lines fills N rows
of its tile and the rest of the tile is empty paper. The margins come from
inside the tile: two glyphs left and right (so the text box is **96 of the 100
columns**, and a line longer than that is clipped with a three-column fade),
and one row top and bottom. A file whose length lands exactly on a height step
has no slack for the row margin, so the margin shrinks to zero rather than
pushing a row outside the tile: `padRows = min(1, (tileRows - contentRows) / 2)`.

The one consequence worth naming: the sheet's geometry no longer depends on the
camera at all, so the phase-1 squeeze ramp, the per-frame bar rebuilds and the
"a sheet's height corrects itself once the real line count arrives" step are
all gone. Bars are cached per file everywhere except under a source overlay,
where they still have to fade.

**The fold.** Above 400 effective lines the tile is exactly the cap and the
last two of its rows are a fold marker: a dashed rule across the text box and a
`+N lines` caption in the district-label style, `N = effectiveLines - 400`. In
the reading band both are real DOM in the overlay; in the schematic band the
rule is a row of dashes and the caption a short dashed bar. The marker sits
after the last drawn row, so a folded file whose own line count is short of the
cap gets its rule where the text actually ends. Windows of interest inside the
budget are phase 4.

**Effective lines are the export's.** The tile's height was cut from
`effectiveLines`, so that number is the source of truth and the tile is never
resized to match anything the renderer counts. When the real text arrives the
renderer applies the exporter's own formula to it
(`sum ceil(max(1, len) / 100)`, ignoring the empty string a trailing newline
leaves behind) and warns with both counts when they disagree. Content is capped
at the rows the sheet holds either way, which is what keeps a binary the
exporter counted as one line from drawing 1200 rows past its tile.

**The fill ramp.** The terrain is the base tone and each nesting level is one
step lighter in the dark theme, darker in the light one, four steps and then the
fourth again. A top-level region carries its hue at 0.22 saturation, its
descendants keep the hue at 0.13. Measured on the demo export, dark theme,
relative luminance of one nesting chain: terrain 28.7, region 36.3, level 2
42.1, level 3 47.9. Borders are 1 px at a fixed contrast against the **parent's**
fill (2 px for a top-level region) with a 2 px corner radius, which is a
rounded-rect polygon regenerated per zoom bucket rather than a shader.

**Coverage.** On the demo export the file tiles cover 39.3 % of the median
district with more than eight files (mean 33.3 %, 9 of those 12 districts at or
above the 35 % target in `docs/design.md` section 4), and 8.2 % of the total
region area — the rest is the layout's growth reserve and column slack, which
`packages/layout` measures and accepts. What matters for reading is what the
band shows: with the camera in the schematic band (rowPx 5, a 32 x 20 cell
viewport) sitting on a file inside such a district, paper covers about **48 % of
the screen and 54 % of the district's on-screen area** (median over the 12
districts, range 20 to 83 %), because the slack sits at the bottom and right of
a district and the camera is in the middle of the columns.

**Paper.** A file tile draws in the paper tone at *every* band, faintly tinted
by its region, so nothing inverts on the way into the schematic tier. Phase 1
drew a light tile below the schematic tier and a dark sheet on top of it at the
schematic tier, which read as a flicker of representation; the tile is now the
page from the first pixel it is worth drawing. Stubs (under 5 effective lines)
draw at 40 % and carry no label below the reading band.

**Labels.** Two styles, one size per style per zoom, both anchored to a rect and
placed per zoom bucket because their inset and gap are in pixels:

- district names, small caps and tracked, at a fixed 7 px inset inside the
  district's own top-left corner at every level, 10 to 14 px with the district's
  on-screen width, dropped when the district is narrower than the name. The
  centred floating names are gone. **Design phase 5 moved these off the GPU and
  made them sticky, see "Wayfinding".**
- file names, sentence case, one weight, 11.5 px, 3 px above the sheet's
  top-left corner and left aligned, so they read as captions on pages. Phase 5
  replaced the band gate with a fit gate: a caption appears wherever its tile
  is wide enough for it, at every band, and a stub still has no name until the
  reading band.

Districts outrank every file label in the collision filter's one group, so a
file caption that loses simply disappears.

## Wayfinding

Design phase 5 (`docs/design.md` section 7). The user has to be able to answer
four questions without moving the camera: which file is in front of me, where
in it, which district and region it sits in, and where the agent is if not
here. Corner-anchored labels fail all four the moment the corner leaves the
screen, which is exactly where the user works, so **labels are anchored to the
viewport, not to corners**. `src/wayfind.ts` owns the DOM half,
`src/scope.ts` the symbol half.

**Sticky region labels.** A region's name is drawn at the top-left of the
intersection of its rect with the viewport, inset the same fixed 7 px as
before, so it slides along the border and stays pinned while the user pans
through the middle of a district. Every nesting level gets one. Nested regions
whose intersections share that corner stack downward, parent above child, one
label height apart. Visibility is by fit: the name is drawn at 10 to 14 px with
the region's on-screen width, and it is dropped unless the *visible*
intersection is wider than it, abbreviated with an ellipsis when at least six
characters fit, hidden below that. A name never crosses its own border, in
either axis. They are DOM (a small pool of `<div>`, positioned every frame from
`viewport.project`, the same projection the source overlay uses) rather than a
`TextLayer`, because the anchor moves with the camera every frame, which would
rebuild the text attributes every frame, and because a sticky label wants crisp
text and, later, a chevron affordance. Same style as before: small caps,
tracked, via CSS.

**Sticky file names and the scope row.** In the reading band, a sheet whose top
edge has left the screen keeps its file name on a translucent strip of the
paper colour at the top of its visible part, inside the sheet, with the
enclosing scope of the first visible line under it: `ClassName › method_name`.
Both come from the export's symbol nodes. Below the reading band the
caption stays above the tile, with the same fit rule as a region name (see
below).

**The gutter.** In the reading band every row carries its line number in the
sheet's left margin, right aligned, at 35 % contrast in the same monospace as
the code. The gutter takes the sheet's two margin columns plus one more for the
separating space, capped at four, and the 96-column text box moves right by
exactly that, so the whole of it still ends inside the 100-column sheet: the
text box is never narrowed and no glyph leaves the page. At the top of the
schematic band (rowPx 6 and up) the numbers are not legible, so every tenth
line gets a small dimmed bar in the same margin instead, on its own GPU layer;
below rowPx 6 there is nothing.

The one thing the gutter has to get right is *which* line it shows. A file with
a diff on the page does not stack its DOM rows one per source line (the
pre-image withholds added lines and puts removed ones back), so the overlay
keeps the line of every row it built and answers "what line is at screen y"
itself. The sticky header, the scope row and the gutter therefore always agree.

**The jump bar.** One persistent line at the top centre of the viewport in the
district style: `region › district › … › file › class › function · L<line>`. It
describes the point at the viewport centre, or the focused file when focus or a
deep link set one, or the autopilot's target while it is following, so it is
never off screen and never wrong. Every crumb is a button: a region or district
crumb fits its rect, the file crumb frames the file at rowPx 9, a scope crumb
scrolls to that symbol. Files are texture at the terrain band, so there the
trail stops at the districts; the scope and the line only exist in the reading
band. The bar took the collapsed debug strip's place, and that strip moved to
the bottom-left corner. `h` still brings the whole debug panel back.

**Off-screen agent marker.** With autopilot off, or while the camera is the
user's (`manual`), if the agent's current file (the last replayed event that
landed on the map) is outside the viewport, an arrow sits on the viewport edge
along the direction to it with the file name beside it, in the file-label style
at 60 % contrast. Clicking it flies there. It hides as soon as the file is on
screen.

**Fit, and collision.** Visibility is by geometric fit and nothing else:

```
maxChars = floor(available px / (size * advance))
maxChars >= name.length   ->  the whole name
maxChars - 1 >= 6         ->  name.slice(0, maxChars - 1) + '…'
otherwise                 ->  nothing
```

`available` is the visible intersection for a region name and the tile for a
caption. Captions stay at one size (11.5 px) at every band, so the six-character
floor is what "wider than the label at minimum size" comes to in practice: a
tile narrower than about 45 px carries no name. That is the one deviation from
section 7's wording, which suggests judging the fit at 10 px; drawing at two
sizes at one zoom would break the one-type-scale rule, and drawing everything
at 10 px would cost the reading band its legibility.

Collision priority is the focused file's caption, then region names by depth
(shallower first), then captions by tile height and then fan-in. Region labels
are DOM, so the GPU `CollisionFilterExtension` cannot see them: `main.ts`
projects each caption's box and drops any that overlaps a sticky region label,
which is a few dozen rect tests on the labels actually in view. The focused
file's caption is the one exemption, which is what puts it first. Region names
collide against each other on the CPU in the same pass, so two districts whose
corners are near but not identical never print over each other.

One deck.gl detail: an abbreviated name ends in `…`, which is not in
`TextLayer`'s default ASCII character set and would silently vanish, so the
layer is given an explicit `characterSet` built from the names that can reach a
label.

**Symbol spans.** The scope row and the jump bar's scope crumbs want real
spans. Export schema 3 has them: `lineEnd` past `lineStart`, the definition's
indentation column, and the id of the enclosing symbol. The scope of a line is
then the deepest symbol whose span contains it and the breadcrumb is that
symbol's `parentId` chain walked outward. A schema-2 export sets `lineEnd` to
the definition's own line, and `src/scope.ts` falls back to an indentation
heuristic there: the nearest preceding definition whose own indentation is at
or below the line's, repeated one indent step further out. Only classes,
functions and methods are scopes; a module-level constant is a definition, not
a place to be inside. Both schemas load.

`WAKE_EXPORT=<name> npm run phase5` verifies all of it on a real export: 54
checks (46 plus the quiet pass's corner rule, group g), zero page errors, 120
fps at all four bands with labels on, screenshots `41-*.png` .. `46-*.png` and
`63-*.png`, all gitignored.

## Roads

Design phase 3 (`docs/design.md` section 6), decided by the review of the
labels phase: **the full network adds little and distracts, there are always
more roads than anyone can follow, and the agent's trips are the informative
thing.** So roads are off by default and the network is a focus tool.

- **Default.** The only roads drawn are the ones incident to the **hovered**
  file (deck's own picking on the tile layer) or, with nothing hovered, to the
  **focused** one (a click, a deep link, or the autopilot's target). They are
  drawn at full contrast in their class widths. `src/edges.ts` keeps a CSR
  incidence index, so a hover is a slice, not a scan over every edge.
- **Three classes**, from the two endpoints and nothing else: `local` both in
  one directory (1 px), `arterial` same region, different directories (1.5 px),
  `motorway` across regions (3 px). The routing is unchanged Holten bundling.
- **The toggle.** "show all roads" in the controls panel brings the whole
  bundled network back with its per-class zoom gates, drawn beneath the tiles.
  It is never on at the terrain band even when the box is ticked: at the world
  fit the network is a grey wash over every tile and it costs real fill rate.
- **Agent trips are always on** and do not look at the toggle at all: the
  marker, the pulse and the link volume along a trip's path are the traffic
  layer, and they draw with the network hidden.

On the demo export the file with the most imports has 46 incident edges (2
local, 37 arterial, 7 motorway); hovering it draws exactly 46 paths and nothing
else, against 582 for the whole network.

## Root files district

`docs/design.md` section 4: files that sit directly in the repository root form
their own bordered district, labelled with the repository name and drawn like
any other top-level region. Without it they float on bare terrain and are
invisible until close up, because the repository root itself draws as terrain.

The district is the **bounding box of those tiles** plus half a lattice gap of
inset, filled with the depth-1 ramp tone, bordered at 2 px like a top-level
region, with a sticky label in the district style carrying `repo.name` from the
export. Their captions and their schematics follow the normal rules. Only the
export path has one: the synthetic fixture's top-level directories *are* its
regions and it has no loose root files.

## Chrome

`docs/design.md` section 10. **There is no debug panel in the product.** Its
corner, bottom-left, is the agent card (`src/agentcard.ts`):

- line 1, what the agent is doing right now in plain words, with the real event
  timestamp small and dim beside it: `Editing src/a/b.py · L40-71`,
  `Reading …`, `Running ruff …`, `Thinking`. The tool name is chrome and is
  stripped; what is left of the export's summary is the useful half;
- lines 2 to 4, the previous three events, fading with age;
- an autopilot chip (`following` / `manual` / `recentering`) and a follow
  button, which turns the replay on if it is off;
- a thin session progress bar, event index over total.

Same visual language as the jump bar: opaque ground, hairline border, the pill
radius, tracked small caps for the chip. It is DOM in the per-frame loop and
diffs its own writes, so it never lags the replay and never rewrites a node for
nothing.

Frame rate and the internal counters live behind **`?debug=1`**, which brings
the old panel back verbatim (its collapsed one-line strip is gone: the jump bar
and the card own those two corners now). The controls panel on the right stays,
and starts collapsed.

## Code view

Zoomed out you get the schematic view an editor shows in its minimap; zoomed in
you get the real source with the current diff. Since phase 1 of
`docs/design.md` it is one ladder keyed on a single number for the whole map,
the on-screen height of one source line, and not on the size of any individual
file. Files are the unit of the map, so symbols are no longer drawn as separate
buildings anywhere on this path: what a file looks like from close up *is* its
schematic.

**One row height for the whole map.** Every decision keys off `rowPx`, and
since design phase 2 the constant in it comes from the lattice rather than from
the data (see "Map geometry"):

```
rowPx = clamp(rowWorld * scale, 0, 18)
rowWorld = CELL_WORLD / CELL_LINES = 4.8 world units per source line
```

Nothing about a file, not its length and not its tile, may change the size of a
glyph. The bands are therefore at the same zoom on every dataset:

| Band | rowPx | zoom | What is drawn |
|---|---|---|---|
| terrain | under 1 | under -2.26 | the sheet and its schematic, aggregated: one GPU rect per *group* of source lines, coloured by the group's dominant token colour and as wide as its longest line. Changed lines grouped the same way |
| schematic | 1 to 9 | -2.26 to 0.91 | one GPU rect per token run, one row per source line, faint band per class and function, changed lines in the right margin, a dashed fold marker where a page is folded |
| reading | 9 to 18 | 0.91 to 1.91 | the real source in a pooled DOM `<pre>` on the same sheet, syntax highlighted, with the inline diff and a `+N lines` fold caption |

Maximum zoom is where `rowPx` reaches 18, which is 1.91 everywhere. Zooming
stops there, by the controller and by every fly-to, deep link and autopilot
pose.

**The schematic is the texture, from the terrain up.** There is no tile-only
tier. Below one device pixel per row a bar row cannot be drawn without
shimmering, so consecutive lines are grouped:

```
group = ceil(1 / rowPx)          // 1 at and above rowPx 1
```

which is the smallest group whose bar is at least one pixel tall. A group is
one quad: its height is `group * rowH`, its width is the longest line in the
group (clipped at the text box, so the file keeps its silhouette), and its
colour is the group's **dominant token colour**, the palette entry covering the
most glyph columns, so a block of comments and a block of code still read
differently. Symbol bands, the fold marker and per-line diff rows are all
sub-pixel there and are left out; the changed lines are grouped like the bars.

The group size is a step function of the zoom, so it changes at discrete zooms
and nothing in between. When it steps, the level that was on screen keeps
drawing and the two **crossfade over the fast duration** (120 ms), which is what
stops the texture popping as the camera moves. On the demo export the levels
from the world fit inwards are 7, 5, 4, 3, 2 and then 1 in the schematic band,
and a bar is 1.00 to 1.05 px tall at every one of them.

Aggregation means *fewer* quads at low zoom, not more, which is what pays for
every file in the world having a sheet: 357 sheets and 9,248 quads at the world
fit against a 78k budget, at 120 fps. The frame budget, not a sheet count, is
what bounds it: a sheet's aggregated cost is `ceil(sheetRows / group)`, known in
closed form, so sheets are added nearest-first until 78k quads are spent.

**The tier is global, decided by zoom alone, with hysteresis.** `schematic` and
`source` are decided once per frame from `rowPx`, for every file at the same
moment: source at 9 and out again at 8. There is no per-file threshold, so two
neighbouring files can never be at two different tiers, and **panning cannot
change a tier**. A source overlay that is up stays up and repositions every
frame from the same matrix deck.gl draws with; it leaves only when its sheet
leaves the viewport plus 35 % of it, or when the zoom leaves the reading band.
The 150 ms at-rest gate survives only for *mounting* a new overlay, so a fast
pan across a district does not churn the pool, and the old "hide the overlays
instantly on a drag" rule is gone with it.

**The sheet is the tile, and nothing is squeezed.** A file is a sheet of paper
lying on the terrain, and its fill *is* the code background on both tiers, so
there is no second dark box. The tile is 100 columns wide and a whole number of
40-line steps tall, `rowH` is `rowWorld` at every band, and the margins are
taken from inside it:

```
rowH        = rowWorld                                   // every band
colW        = tileWidth / 100
textX, textW = tile.x + 2 * colW, 96 * colW              // two glyphs each side
padRows     = min(1, (tileRows - contentRows) / 2)       // one row, if it fits
topY        = tile.y + tile.h - padRows * rowH
```

A file of N effective lines fills N rows of its tile and the rest of the tile
is empty paper. The phase-1 squeeze, and the ramp that released it over rowPx 6
to 9, are both gone: there is nothing left to release, because the tile was cut
to the file's length in the first place. A file whose length lands exactly on a
height step has no slack for the row margin, and the margin shrinks rather than
pushing a row outside the tile.

**Fixed columns, and nothing outside the tile.** The tile is exactly 100 glyph
columns wide and the text box is the middle 96 of them, at every band, with no
interpolation. Longer lines are clipped at the text box with a three-column
fade: a per-vertex alpha ramp on the bars, a `mask-image` on the source. The
source overlay is transparent, has the tile's exact text box for its own box
and clips, and its row range is capped at the rows the sheet holds, so no glyph
and no bar is ever drawn outside its tile. `npm run phase2` asserts that over
every quad of 65 sampled files at four zooms across the schematic and reading
bands, and `npm run phase1` still asserts the phase-1 version of it.

**Quiet sheets.** Stubs (under 5 effective lines) draw a blank sheet with no
bars, at 40 % opacity, and carry no label below the reading band: a directory
full of empty `__init__.py` files stops shouting. Non-code sheets (md, yaml, yml,
json, toml, lock, txt, rst, cfg, ini) draw at 50% contrast on both tiers, bars
and glyphs alike. Prose and config are context, not subject.

**Aiming at a file.** `focusPose(file, line, rowPx)` is closed form: at a given
`rowPx` a file's sheet geometry is fixed, so there is no fixed point to
iterate. It puts the sheet's centre column on screen and the wanted line in the
middle of the viewport. A deep link (`?data=<name>&file=<repo-relative>`, or
`view=street` / `view=source` / `view=reading`, all aliases) lands on that file
at the start of the reading band with its first changed line centred, its first
line when it has no diff. The line count and the diff arrive after the fetch,
so the camera aims at the first line immediately and re-aims once.

Both tiers are fed by **one** tokenizer pass. `src/tokens.worker.ts` runs Shiki
4.4.3 in a worker (the `@shikijs/*` subpackages only, never `shiki/bundle/full`), fine-grained bundle, JS RegExp engine, six languages
(python, typescript, tsx, javascript, json, markdown) and one theme per
appearance. It returns typed arrays only: per line a set of runs
`(startCol, len, colourIndex)` plus an RGB palette, cached per content hash and
theme. A run is a maximal non-whitespace span inside a token, which is what
gives the schematic its word shapes and lets the source rebuild the exact line
by slicing the gaps back out. Anything without a grammar (yaml, toml, shell)
still gets runs in the default colour, so every file has a schematic.

Source and diffs come from two dev-only endpoints in `vite.config.ts`:
`/file?data=<name>&path=<repo-relative>` and `/diff?data=<name>&path=<...>`.
Both resolve against the exported repository's own checkout (`repo.path` in the
export), and a path is served only if the export lists it as a file node and it
resolves inside that root with no symlink hop. `/diff` runs `git diff` plus
`git diff --cached`; if the working tree is clean, `&rev=<git ref>` diffs
against a ref instead so there is something to animate. Both are cached per
`(name, path, mtime)`. Nothing is written, and no path from the repository is
ever stored in this package.

**The diff, and how it lands.** The demo diff is the final state of the working
tree, so a file's whole diff is applied at its **first** edit in the replay and
re-flashes on later ones. Before that first edit the file is shown as its
pre-image, with no diff marks at all: added lines are withheld and removed
lines are rendered from the diff, which is a per-line reverse apply at render
time, not a second copy of the file. On the schematic tier the right-margin
band is grey until the edit lands, then it takes its colour (green added, amber
modified, red removed) and flashes white once over 600 ms. On the source tier
the same event slides the added rows in (height and opacity from zero, an 8 px
lead-in) and dims the removed rows, driven numerically from the event time, so
scrubbing the replay is deterministic. Removed lines stay inline, the standard
unified way: red tint, dimmed once the edit has landed.

**Following an edit.** When the replay reaches an edit or write that carries a
line range, the camera aims at the middle of that range rather than the file's
centre, and picks the row height that makes the range readable (between 9 and
18 px, the whole range on screen when it fits). It holds that pose for 7
seconds, then the normal follow camera takes over again. Falls back to the
file's first changed line for events with no range.

**The unblur.** The source only mounts when the camera has been still for
150 ms, and it arrives as an unblur, not a crossfade: the `<pre>` mounts at
`filter: blur(6px)` and 0.6 opacity and sharpens to `blur(0)` and 1 over 300 ms
on an ease-out, while the same file's bars fade out underneath it over the same
window (their layer opacity is 1 minus the overlay's progress). Leaving
reverses it in 120 ms, so a wheel or a fly-to blurs the source away instead of
snapping it off; a **drag** is the exception and hides it at once, because a
blurred ghost lagging a pan is worse than the schematic standing in.
`will-change: filter` is set only while a transition runs, so a page at rest
never holds a blurred raster layer. The font size is `0.86 * rowPx` and the
line height is `rowPx` exactly, never `transform: scale`. Only the visible line
range plus a margin is in the DOM, so panning down a long file scrolls it.

Run it:

```
npm run dev
open 'http://localhost:5199/?data=<name>&file=<repo-relative path>'   # reading
open 'http://localhost:5199/?data=<name>&file=<p>&view=schematic'     # schematic
```

Without `file=` the deep link is off and the `street` and `source` buttons aim
at the file with the highest fan-in. The HUD's **band** and **row** readouts are
the ladder above. Move the **event** slider past an edit to apply that file's
diff, or run the replay with `autopilot=1` and watch it land on its own.

`WAKE_EXPORT=<name> npm run phase1` drives the whole thing headless. It takes
its target file from the export's own session, checks that two files in view
share one font size and line height and that the line height is `rowPx` at
three zooms in the reading band, that the zoom clamps at `rowPx` 18 by fly-to
and by wheel, that no quad and no overlay leaves its sheet over twenty sampled
files, and that the deep link lands. It prints the fps at each band and writes
`screenshots/21-*.png` .. `26-*.png`, all gitignored because they render real
source.

### What to judge

1. Does the schematic read as the file, at a glance, the way a minimap does.
   Indentation shape, block bands, comment colour.
2. Does the schematic to source unblur read as one movement in place, or does
   the eye lose the position. Watch the way back out too, on a wheel and on a
   drag.
3. Are 3 and 9 px per row the right moments for the schematic and for real
   source, and is 18 px the right place to stop. Watch a long file and a short
   one through the same zoom: they change together now.
4. Does the diff read the same way in both tiers: same lines, same colours, the
   margin band telling you a file changed without opening it.
5. Is the paper tone right on the district fill, in both themes, and is 100
   columns the right width.
6. Do the districts read as places from their tone and their borders alone,
   before any label, and is the 40-line height step honest about length.
7. Does a folded page read as a collapsed diff, or does the marker look like an
   error.

### Simplified, on purpose

- Only the real-export path has a code view. The synthetic fixture has no
  source on disk, so it keeps the building grid and its bench numbers. It does
  use the same lattice: its tiles are 5 cells wide, one 40-line step per 4
  cells, folded above 400 lines, packed into columns with the gap inside each
  footprint.
- A cached schematic draws at most its first 900 rows, which is above the
  400-row fold cap, so on a real export nothing is ever cut off there.
- Columns are clipped at 96 (the text box inside a 100-column tile), tabs count
  as one column. The glyph advance is exactly `0.5 * rowPx`, because a lattice
  cell is 20 columns by 10 lines and square in world units, and the overlay's
  font size follows from it: `0.5 / 0.6 = 0.833 * rowPx` for a monospace face
  whose advance is 0.6 em. A font whose advance differs would drift from the
  bars by about a pixel over 100 columns.
- Effective lines wrap at 100 columns, matching the exporter, while the text
  box draws 96 of them. The four columns of difference are inside the
  right-margin fade, so a 100-column line reads as clipped either way, but it
  does mean the renderer never soft-wraps: it draws one row per source line and
  the wrapped count is only used to check the export's tile height.
- Symbol bands come from the export's `lineStart`/`lineEnd`, so they are only as
  good as the exporter's symbol extents. Constants get no band.
- Untracked files have no `git diff`, so a file the session created shows as
  unchanged.
- The overlay takes no input (`pointer-events: none`), so wheel, drag and pinch
  reach the canvas underneath at any zoom. That rules out hover and text
  selection inside the source; neither is needed for the spike.
- At the per-line tiers at most 96 sheets are built for one screen, nearest to
  the centre first; in the aggregated tier the bound is the 78k quad budget
  instead, which on the demo export means every one of the 357 files. At most 8
  sheets carry a source overlay. Bars are cached per file, in two caches: the
  per-line build does not depend on the camera at all, and the aggregated one
  is rebuilt only when the group size steps.
- A file whose text has not arrived yet has paper but no texture, so at the
  world fit the map fills in over a second or two as the store fetches. The
  store's cap rises with the sheet count so a pan does not evict what is on
  screen, and the 30 stub files under 5 effective lines stay blank paper by
  design.
- Mounted source overlays are the first candidates every frame, so a pan can
  never lose the sheet under the pointer to a newcomer taking the last slot.
  Sheets are otherwise drawn far to near, so the file nearest the centre of the
  screen is on top and its overlay gets the highest z-index. In the reading band a long
  sheet still overlaps its neighbours below; phase 4 replaces that with the
  accordion.
- The line count before a file is fetched is the export's byte estimate, so a
  sheet's height can correct itself once by a visible step.

## Loading splash

`src/splash.ts` + `src/splash.css`, the look approved in
`assets/brand/splash-preview.html`: dark radial ground, the project icon
(`public/icon.svg`, also the favicon), the wordmark, the tracked tagline, a
thin amber bar, one status line and one footer hint. It mounts before the
module graph does any work and owns the screen until the map has a framed
first frame.

The progress is real. Every startup step announces itself to the splash
before it runs and owns a weighted band of the bar, so the bar can only move
when a step actually finishes. Nothing runs on a timer.

| stage | synthetic | real export |
|---|---|---|
| `reading export` | - | fetch + schema check |
| `generating repository` | `generateRepo` | - |
| `laying out N districts` | `layoutRepo` + session | `buildFixture` |
| `routing N roads` | `buildRoads` | `buildRoads` |
| `ranking labels` | `makeZoomPlan` + `buildPlaceLabels` | same |
| `loading highlighter` | tokenizer worker + Shiki core | same |
| `tokenizing N files` | - | the visible files, nearest the centre first |

The counts are the real ones (districts from the tree, roads from the import
edges, files from the tokenizer's queue), and the tokenizer stage reports
`d/N` as files land. The highlighter stage is real work brought forward: it
starts the worker and builds Shiki's highlighter inside it, and the CodeStore
then adopts that same worker. Without the splash both happen lazily on the
first tokenize, as before.

Rules, from docs/design.md section 1:

- Announcing a stage yields two frames so the status line is painted before
  the work blocks the thread. That is the only change to startup ordering,
  and it costs about 25 ms per stage.
- The splash leaves by fading, 600 ms on the one easing curve. The bar
  advances at 250 ms, the status line and the footer slide in at 250 ms.
- Minimum display 400 ms, so a fast load cannot flicker.
- Any key or click skips the fade immediately.
- It lifts only after deck.gl has drawn, so it uncovers the map already
  framed where it will start: the deep link target, the autopilot target (the
  camera jumps there before the first render), else fit-all.
- `?nosplash=1` mounts nothing, yields nothing and warms nothing. Every
  playwright script passes it (`mapQuery` in `scripts/driver.mjs`), so the
  bench and the screenshots measure the startup they always did.

`WAKE_EXPORT=<name> npm run splash` checks all of it on both data sources and
writes a mid-load shot to `screenshots/27-splash.png` (gitignored, like every
`2*.png`).

## Autopilot demo

Tick **autopilot (agent session)** in the right-hand panel. A simulated Claude
Code session starts: 40 trips over 90 seconds, then it loops. The HUD shows the
current tool call (`Read platform/io/session/parser.ts`), the camera state, and
how far through the session it is.

What to click, in this order:

1. **Watch it follow.** The camera target is the centroid of the last three
   touched cities. The zoom is chosen so everything touched in the last 10
   seconds fits with margin, so a burst of edits inside one directory sinks to
   city zoom and a cross-region jump pulls back to country zoom on its own. Both
   axes and the zoom are driven by a critically damped spring, so a new event
   never restarts an animation and the camera never overshoots or snaps.
2. **Take over.** Scroll or drag anywhere on the map. The state flips to
   `manual (recenter in 8s)` on the first event, before deck.gl's own
   `interactionState` would report it, and the camera stops being written to.
   The agent keeps working and the map keeps animating underneath you.
3. **Let it come back.** After `wait` seconds of no input the state becomes
   `recentering` and the camera glides to wherever the agent is now over
   `recenter time` seconds, then resumes following. Both parameters are HUD
   sliders. Set wait to 0 to see the recenter fire immediately, or to 20 to see
   it stay out of your way.
4. **`follow`** re-engages immediately, with no glide. The spring absorbs the
   jump, which is the difference from a fly-to.
5. **`pause agent`** freezes the session so you can inspect the map. The camera
   still follows the last position, and takeover still works.

What to watch for on the map:

- A small marker rides the bundled road from the read city to the edit city,
  then the destination pulses.
- The road it used keeps a link volume. Repeat the same trip and the road
  widens and brightens. It fades out over 20 seconds, so the corridors that are
  lit are where the agent has been working recently, which is the "motorway
  between two regions glowing" claim in PLAN.md section 7.
- Reads glow faintly, edits strongly, both fading over 6 seconds.
- Cross-region trips ride the motorway corridor, so a jump between two packages
  is visibly a long-distance trip and not a straight line through the middle.

What to judge:

- Does the follow camera feel like a camera operator or like a machine. Watch
  for overshoot, for jitter when two events land in the same frame, and for
  zoom-out that is too aggressive on a single cross-region jump.
- Is the takeover instant, and is `wait` 8 s the right default.
- Is the trip marker readable at country zoom, or is it lost in the road ink.

Known rough edges: the link volume, the touch fade and the marker are all CPU
side, rebuilt into small overlay layers every frame. That is fine at this event
rate and is exactly what spike 2 has to move into a shader. The camera writes
`viewState` every frame while following, which conflicts with deck.gl's own
transitions, so the fly-to buttons deliberately count as user input and drop the
camera into MANUAL.

## Quiet pass

The last pass over the design's "quiet by default" and "one motion language"
principles (`docs/design.md` sections 1, 3, 7, 10). Nothing new to look at,
which is the point:

- **Corner clutter** (`src/wayfind.ts`, `resolveCorner`). In the reading band a
  sheet's sticky file header and a stack of sticky region names could want the
  same top-left corner, and the stack painted over the header. Now the stack
  yields: it collapses to its deepest name (the one the file is actually in,
  the jump bar spells out the rest) and the header moves down below it.
  Nothing overlaps. `63-corner-rule-reading.png`.
- **Non-code at half contrast.** Markdown, yaml, json, toml, lock and txt sheets
  draw at 50% ink on every path: the aggregated terrain texture, the per-line
  schematic and the source overlay. The aggregation path had kept it; the
  check is new.
- **Light theme parity.** The ramp darkens with depth instead of lightening,
  paper is one step lighter than its desk instead of darker, labels keep their
  contrast, the glow is retuned but still warm, and the agent card and the jump
  bar share the theme's one opaque ground. `61-light-schematic.png`,
  `62-dark-schematic.png`.
- **Reduced motion** (`src/motion.ts`). Under `prefers-reduced-motion` camera
  flights are instant, the follow spring keeps gliding but ten times tighter (a
  hard cut per agent event would be worse), the unblur is a plain 120 ms
  opacity fade with no blur, trip markers still move because the movement is
  the information, and arrival pulses hold one radius and leave on a fade. The
  media query is read live, so flipping the setting with the page open takes
  effect at once.
- **Idle state** (`src/agentcard.ts`). When the replay ends (`?loop=0`, the
  demo loops by default) the card says `Session ended · N events`, the follow
  button is disabled and nothing on the map glows. `64-idle-agent-card.png`.
- **Two stale checks in the labels suite.** The collapsed debug strip check now
  asserts the agent card in that corner. The terrain-band caption check was a
  stale expectation, not a regression: it demanded the schematic band at rowPx
  0.7, which the three-band ladder no longer has there since the `blocks` band
  went; the rule under test is fit, not band, so it now asserts both ends of
  the six-character floor at the terrain band.

`WAKE_EXPORT=<name> npm run phase5` carries the corner rule (group g) and
`npm run phase6` the other four (groups h to k). Both green on the real export,
zero page errors, 120 fps at every band. One finding for the spike, not fixed
here: a programmatic fly-to with a duration (`flyTo`, `flyToPose`) lands on its
first frame on this build even without reduced motion, deck.gl's `viewState`
transition does not run for it. The reduced-motion check reports it and
asserts only the reduced page.

## Results

Headless Chromium 151 on this Mac (Apple M3, macOS 26.6), WebGL2 through
`ANGLE Metal Renderer: Apple M3`, canvas 1600x1000, `devicePixelRatio` 1,
labels and edges on. **These are headless-Chromium-on-this-Mac numbers, not the
Mac-plus-Linux, Chrome-plus-Firefox matrix that `docs/spikes.md` asks for.**
Raw data in `screenshots/bench.json` and its siblings.

The Mac runs a 120 Hz display and deck.gl draws on `requestAnimationFrame`, so
any configuration that fits the budget reports exactly 8.3 ms. Two extra probes
exist to find where the budget actually breaks.

**50k files, 200k symbols, 20k edges** (`bench.json`), re-measured on the
phase-2 lattice, where the 50k tiles are proportional pages rather than 1x1
cells and the world is 151,552 units across instead of 17,000:

| level | zoom | median ms | p95 ms | fps | cities in view | labels fed | roads in view |
|---|---|---|---|---|---|---|---|
| continent | -7.40 | 8.3 | 9.2 | 120 | 50,000 | 5 | 0 |
| country | -6.35 | 8.3 | 9.3 | 120 | 18,152 | 28 | 0 |
| city | -4.05 | 8.3 | 9.3 | 120 | 986 | 8 | 0 |
| street | 0.06 | 8.3 | 9.3 | 120 | 13 | 9 | 0 |

Unchanged against the phase-5 run to the tenth of a millisecond. Roads in view
is 0 rather than 167 / 109 / 1,173 / 80 because the network is off by default
now and the bench neither hovers nor focuses anything; nothing else moved.

Fewer labels are fed than in phase 1 because file captions now wait for the
schematic band and stubs for the reading band. District coverage on the
synthetic fixture is 35.3 % (median of districts with more than eight files),
against the 35 % target in `docs/design.md` section 4.

deck.gl's own counters: `cpuTimePerFrame` 2.1 ms, `gpuTimePerFrame` unavailable
(ANGLE Metal exposes no timer query).

**Plus the traffic demo**, 50 cities per second, CPU-side (`bench-traffic.json`):
identical, 8.3 ms median and 120 fps at every level. `updateAttributesTime` rises
to 10 ms per second of wall clock, about 0.17 ms per frame.

**Fill-rate probe**, same scene at `dpr=3` (4800x3000, 14.4 Mpixel)
(`bench-dpr3.json`):

| level | median ms | p95 ms | fps |
|---|---|---|---|
| continent | 8.5 | 17.0 | 88 |
| country | 8.4 | 16.8 | 95 |
| city | 16.0 | 17.1 | 78 |
| street | 8.8 | 17.1 | 84 |

**Scale probe**, 200k files, 800k symbols, 80k edges, 1 Mpixel canvas
(`bench-200k.json`):

| level | median ms | p95 ms | fps | cities in view |
|---|---|---|---|---|
| continent | 8.3 | 9.9 | 120 | 200,000 |
| country | 8.3 | 9.3 | 120 | 67,417 |
| city | 8.3 | 9.2 | 120 | 3,842 |
| street | 8.4 | 17.0 | 91 | 35 |

The street-level drop at 200k is the 800k building polygons, all of which are
drawn once the zoom threshold is crossed. There is no per-layer viewport culling
in deck.gl, so that is the first thing a real renderer has to add.

Fixture build cost, single threaded, on the main thread: generate 26 ms, layout
26 ms, roads 16 ms for 50k files (61 / 52 / 38 ms for 200k).

**Code view on a real export** (`npm run phase2`, same machine, 1600x1000, the
demo export: 357 files, 90 dirs, 448x512 cells):

| band | rowPx | fps | sheets | quads | on screen |
|---|---|---|---|---|---|
| terrain, world fit | 0.18 | 120 | 357 | 9,248 | every tile's aggregated schematic, group 6 |
| terrain | 0.3 | 121 | 248 | 9,445 | aggregated schematic, group 4 |
| schematic | 5 | 121 | 3 | 5,326 | the sheet and one bar row per line |
| reading | 10 | 120 | 3 | 867 | source on the sheet |
| schematic, forced | 3.5 | 74 | 21 | 8,979 | 8 source overlays (3600x2400, `l3row=3`) |

The terrain band went from 0 sheets and 0 quads (a flat tile) to every file in
the world at 9k quads, and it is still 120 fps: aggregating to one quad per 6
lines is cheaper than one quad per token run over a tenth as many files.

Tokenizing is off the main thread and on demand: 6-9 ms per file. The forced
8-overlay row lost half its fps against phase 1 (74 against 120) and it is the
one number that got worse: a sheet is now the whole tile, so eight of them on a
3600x2400 canvas are eight much larger blurred DOM layers. At the real reading
threshold, where a screen holds three to five pages, it is still 120.

**Phase 2 verification** (`WAKE_EXPORT=<name> npm run phase2`): 66 checks, zero
page errors, zero failures. The quiet pass turned one check around: below rowPx
3 it demanded flat tiles with no sheet content, which was the pre-review ladder;
since the schematic became the tile texture from the terrain band up, it asserts
schematic quads on every sheet there, aggregated below one pixel per row.

| check | result |
|---|---|
| a  content inside its tile | 0 of 78,384 quads and 0 of 65 overlays outside, over 65 distinct files at rowPx 3.5, 6, 9 and 14 |
| b  a 40-line file | 4-cell tile, 40 rows, 360 px content in a 360 px tile at rowPx 9, 100-column tile and 96-column text box |
| b  one type scale | 8 overlays on one screen, two files of 10 and 127 effective lines at the same 7.5 px font and 9 px line height |
| c  the fold | 54 folded tiles, all 400 rows with 398 for source, marker inside the tile; captions `+71`, `+168`, `+36`, `+489`, `+246` lines match `effectiveLines - 400` |
| d  the fill ramp | luminance 28.7 (terrain) < 36.3 < 42.1 < 47.9 along one nesting chain, borders lighter than their own fill |
| e  district labels | 9 and 7 labels at two zooms, 0 outside their rect, all between 10 and 14 px, all outranking file labels |
| e  file labels | 17 in the schematic band, one size, all above and left aligned on their sheet |
| f  fps | 120 at all four bands |
| g  the deep link | lands at rowPx 9 with the first changed line centred |
| effective lines | the renderer's wrapping agrees with the export on every file it read except the one blob the exporter refused to read and reported as the 401 floor |

The phase-1 suite (`npm run phase1`) is still green on the new lattice: 31
checks, one font size per zoom, the clamp at rowPx 18 by fly-to and by wheel,
0 quads outside their sheet over 31 sampled files, and the deep link.

**Phase 6 verification** (`WAKE_EXPORT=<name> npm run phase6`): 89 checks (43,
plus 7 from the reading-band glow fix and 39 from the quiet pass, groups h to
k), zero page errors, zero failures.

| check | result |
|---|---|
| a  schematic from the terrain up | at the world fit all 357 files have a sheet and 327 of them carry bars; the other 30 are the stubs under 5 effective lines, blank paper by design |
| a  the aggregation rule | group 6 at rowPx 0.176, bars 1.05 px tall, 9,248 quads inside the 78k budget; `group == ceil(1 / rowPx)` and a bar 1.00 to 1.05 px at every level over rowPx 0.15 to 6 (groups 7/5/4/3/3/2/1/1/1) |
| a  root files district | 14 root files, on screen at the world fit at 84x84 px, sticky label carrying the repository name at 10 px, fill luminance 38.5 against 28.7 for the terrain, all 12 of its non-stub tiles textured |
| b  only zoom changes a tier | panning across three files at rowPx 10 in 12 steps: all three keep their source overlay for the whole pan, no overlay whose sheet is still inside the margin was released, 0 tier flips |
| c  roads off by default | nothing hovered or focused: 0 road paths drawn, network hidden |
| c  roads on hover | picking reports the file; 46 paths drawn for its 46 incident edges, split 2 local / 37 arterial / 7 motorway, matching the export; widths 1 / 1.5 / 3 px; the network still off |
| c  roads on focus | focus alone keeps the same 46 roads with nothing hovered |
| c  the toggle | "show all roads" draws all 582 edges, and still draws 0 at the terrain band |
| d  trips | 7 trip paths, 6 hot roads and the marker draw with the network hidden |
| e  the agent card | the default chrome, current action in plain words with its real timestamp, a three-event trail, the `following` chip, a follow button, the progress bar at 75 % (27 / 36); no debug panel and no collapsed strip; controls collapsed |
| e  `?debug=1` | the old panel back with the frame rate on it, the card still up |
| f  fps | 120 at the terrain, schematic and reading bands; the synthetic bench unchanged at 8.3 ms and 120 fps at all four levels |

**Verdict against the pass condition in `docs/spikes.md`:** pass on this
machine, with the caveat that the vsync cap hides the real headroom. The Linux
and Firefox legs are still open.

## Pain points found in deck.gl 9.3.11

1. **`CollisionFilterExtension` hides every label on a static camera.**
   `CollisionFilterEffect` re-renders its collision map only when the viewport
   changes, or when the layer list, layer bounds or load state change. On first
   load it renders the map once, before the `TextLayer` font atlas exists, so
   every label fails the visibility test, and with a stationary camera nothing
   ever invalidates it. The labels stay invisible forever. Verified by reading
   the collision FBO back: all zeros. A one-pixel drag makes every label appear.
   Workaround here: nudge the camera target by 0.0008 world units for 24 frames
   whenever the label set changes (`kickFrames` in `src/main.ts`). Compare with
   `?collide=0`.
2. **The collision test samples the label anchor, not the label box.** With
   `getAlignmentBaseline: 'top'` the anchor sits on the glyph edge, the 5x5
   sample straddles it, and every city label fades to about 20% alpha. Use
   `center`.
3. **The collision filter cannot separate labels of equal priority.** Every
   top-level region label carries the same top priority, and at continent zoom
   three adjacent region names simply overlap. Fixed here without the
   extension: region and sub-region names are set to the on-screen width of
   the territory they name, with a floor, and dropped when they still do not
   fit (`fitPlaceLabels` in `src/labels.ts`), which is what a paper map does.
4. **Extension props are invisible to TypeScript.** `getCollisionPriority`,
   `collisionGroup` and `collisionTestProps` are not in `TextLayerProps`, so the
   props object has to be cast. See `textProps` in `src/main.ts`.
5. **Binary attributes are per-vertex, not per-object.** Fill colours and path
   widths have to be expanded to one entry per vertex, which is four values per
   city quad and 26 per motorway. Cheap to build, but it triples the buffer size
   for what is conceptually per-object data.
6. **`FlyToInterpolator` is geospatial only.** Non-geo views need
   `LinearInterpolator({transitionProps})`, so the van Wijk zoom curve that
   `docs/research-stack.md` wants has to be written by hand.
7. **Typed `viewState` in controlled mode.** `Deck`'s `viewState` prop types as
   a per-view-id record, so a single view state needs a cast on every
   `setProps`.
8. **No viewport culling inside a layer.** See the 200k street result above.

## Not covered here

- Firefox and a Linux box. Both are in the spike 1 pass condition.
- Shader-driven traffic. Both the traffic demo and the autopilot trip overlay
  brighten cities from JavaScript by rebuilding small overlay layers every
  frame, which is acceptable at 50 touches per second but is exactly what spike
  2 has to replace with a `lastTouchedAt` attribute evaluated against a `uNow`
  uniform.
- Real hook input. Both sessions here are recordings. `src/session.ts` and
  `src/exportmap.ts` are the only places that have to be swapped for the live
  http hook stream.
- `prefers-reduced-motion`. The research doc asks for it, the spike ignores it.
- Layout stability. This treemap is deterministic but not incremental. Adding a
  file reflows its directory. Spike 3, and `packages/layout` on the export path.
- Roads under the tiles when the whole network is on. The focus roads are drawn
  above the tiles on purpose, so a hovered file's fan-out reads through its own
  district; the bundled network is beneath them.
- Windows of interest inside a folded page. The fold shows the head of the file
  and one marker; the attention-following budget is design phase 4.
- Tooltips, and unbundling a hovered file's roads: they are picked and drawn,
  but they still ride the bundled corridors rather than straightening out.
- Windows of interest driving the aggregation. A group's colour is its dominant
  token colour, which is honest but crude: a one-line comment inside a group of
  code disappears entirely at the world fit.
- Cities in the light theme are darker than their region, not lighter, because
  lighter is unreadable on a light basemap. The dark theme follows the brief.

## Taking screenshots by hand

`npm run screenshots` uses Playwright with `channel: 'chromium'` (the full
browser in new headless mode, which reaches the Metal GPU) and works on this
machine. If `npx playwright install chromium` fails on yours, do it by hand:

```
npm run dev
```

then open, one at a time, and use the browser's own screenshot:

```
http://localhost:5199/?view=continent&theme=dark
http://localhost:5199/?view=country&theme=dark
http://localhost:5199/?view=city&theme=dark
http://localhost:5199/?view=city&theme=dark&labels=0
http://localhost:5199/?autopilot=1&theme=dark&seek=20000
http://localhost:5199/?autopilot=1&theme=dark&seek=30000
```

For numbers, open `http://localhost:5199/?bench=1`, wait about 35 seconds, and
read the table in the HUD or in the console. `window.__wakeBench` holds the same
object as JSON.
