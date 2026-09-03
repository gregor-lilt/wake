# Wake map design

Design rules for the map, written after the first review of the real-repository
demo (2026-09-03). PLAN.md says what the map is. This document says how it must
look and behave so that it works. Everything here follows one idea: the map is
read, not admired. Every rule is derived from what the user is doing at that
zoom.

## 1. Principles

- One type scale. At a given zoom, all text on the map has one size. Never let
  a file's length, a tile's size, or anything but the camera decide the size
  of a glyph. A map where two neighboring towns are labeled in 8 pt and 40 pt
  is broken. So is code.
- The tile is the page. A file is a sheet of paper lying on the terrain. The
  schematic and the source are the same sheet at two distances. Same width,
  same top, same background. Nothing about a file is ever drawn outside its
  sheet.
- Borders make geography. A directory that cannot be seen is not a place. If
  the user cannot say which district a file is in without reading its label,
  the layout has failed.
- Quiet by default. Roads, stubs, config files and chrome recede. Source code
  and the agent's activity are the figure, everything else is ground.
- Continuous, then discrete. Sizes and positions change continuously with
  zoom. Representation changes discretely, for all files at once, at a small
  number of well-defined moments. The user should feel the map breathe, not
  flicker.
- One motion language. One easing curve, three durations (fast 120 ms, base
  250 ms, slow 600 ms), and a rule: things that become readable unblur, things
  that appear slide in, things that leave fade. Nothing bounces.

## 2. The zoom ladder, defined by row height

Every decision keys off one number: the on-screen height of one line of code,
`rowPx`, which is the same for every file at a given zoom.

`rowPx = clamp(k * zoomScale, 0, 18)`

| Band | rowPx | What the user is doing | What is drawn |
|---|---|---|---|
| Terrain | under 1 | Orienting | Regions with borders and names. Every tile shows its schematic as texture, aggregated so bars never shimmer (one bar per group of lines, chosen so a bar is at least 1 px). Agent traffic |
| Schematic | 1 to 9 | Finding a district, then a file | Schematic bars per line as soon as a row is a pixel tall. File captions wherever they fit. Agent traffic |
| Reading | 9 to 18 | Reading and reviewing | Source on the sheet, diff inline, gutter, sticky headers. Roads only for the focused file |

Maximum zoom is where `rowPx` reaches 18. Zooming stops there. Beyond that
there is nothing more to see, and a map that keeps magnifying past its own
detail feels broken.

Tier changes happen for all files at the same zoom, and only zoom changes a
tier. Panning never does: a source overlay stays mounted and repositions every
frame while the user pans, and leaves only when the sheet leaves the viewport
or the zoom leaves the reading band. The unblur from schematic to source is the
one visible transition, at `rowPx` 9, with hysteresis of one pixel on the way
out.

## 3. The sheet

- Background. The sheet's fill is the code background color, on both tiers. It
  sits on the district fill like paper on a desk. There is no second dark box.
- Width. A sheet is `columns` glyph widths wide, with `columns` fixed at 100.
  Lines longer than that are clipped with a 3-character fade at the right
  margin. At schematic zoom the same rule applies to the bars. Nothing extends
  past the sheet, ever.
- Height. A sheet's height is proportional to its effective line count, at
  every zoom. Effective lines count wrapped long lines (a 250-column line is
  three lines at 100 columns). Because all sheets share one width, this gives
  every file the same row height at a given zoom without any rule enforcing
  it. Nothing is ever squeezed or stretched. The schematic is the sheet at a
  small scale, the source is the same sheet up close.
- Domination. Very long files would dwarf a district. Above a cap (first guess
  400 effective lines) the sheet is folded. Its height is the cap, its content
  is a budget of `cap` visible lines arranged as windows of interest separated
  by fold markers. A fold marker is a dashed rule with a caption "+340 lines"
  in the district-label style. This is the collapsed unified diff every
  developer already reads.
- Windows follow attention. With no activity the budget goes to the head of
  the file (imports, first definitions). When the agent or the user reads or
  edits a range, a window opens around it with a few lines of context. New
  windows open where the work is, the oldest close when the budget is
  exceeded. Content moves inside the page, the page never changes shape or
  position because of navigation.
- Folds are live in the reading band. A fold marker expands on click. Focus
  can unfold the whole sheet, shifting the column below it down for the
  duration. Autopilot targeting a line inside a folded stretch opens a window
  there before the camera arrives, so the user never lands on a fold marker.
- Margins. Inside the sheet, one row of padding top and bottom and two glyphs
  left and right at every tier, so the schematic and the source share the
  same text box.
- Empty and trivial files (under 5 lines) show a blank sheet, no bars. They
  are not worth a texture.
- Non-code sheets (markdown, yaml, json, lock files) draw at 50% contrast on
  both tiers. Prose and config are context, not subject.

## 4. Geography

- Fill ramp. The terrain is the base tone. Each nesting level of directory is
  one step lighter (dark theme) or darker (light theme), four steps maximum,
  deeper levels reuse the fourth. Top-level regions carry a hue, their
  descendants keep the hue at lower saturation. The user reads depth from
  tone before reading any label.
- Borders. Every directory has a 1 px border at a fixed contrast against its
  parent fill, with a 2 px radius. Top-level regions get 2 px.
- District labels. Small caps, tracked, top-left inside the border with the
  same inset at every level. Size scales with the district's on-screen width
  between 10 and 14 px, hidden when the district is narrower than the label.
  No centered floating names.
- Density. Files inside a directory pack into a grid with a gap of 20% of the
  tile size. Growth reserve is placed at the bottom and right of the district,
  as terrain, never between tiles. A district reads as a block of pages with
  land around it, not as pages scattered across a field. Target: file
  footprints cover at least 35% of a district that has more than eight files.
- Tile shape. All tiles share one width, the sheet width. Height is
  proportional to effective lines, quantized to coarse steps (first guess
  40-line cells) so that ordinary edits do not change a tile's height. A
  district is a shelf of pages of different lengths, packed into columns in
  frozen sibling order, with slack at the bottom of each column absorbing
  growth. Stubs (under 5 lines) are the smallest step, dimmed and unlabeled
  below reading zoom. A directory full of `__init__.py` stubs stops shouting.
- Root files. Files that sit directly in the repository root form their own
  bordered district, labelled with the repository name, drawn like every other
  directory. Otherwise they are invisible until close up.
- Sibling order stays frozen as PLAN.md requires. Density and heights change
  how a directory is packed, not the order.
- Stability cost. Height now depends on content, so an edit that crosses a
  height step moves tiles below it in the column. The replay harness from the
  layout spike measures this. Step size and column slack are tuned until the
  median commit still moves nothing.

## 5. Reading layout

With proportional sheets there is no separate reading layout. A district looks
the same at every zoom, only closer. Two things change in the reading band:

- Folded sheets (section 3) unfold to full height when focused. Tiles below in
  the same column shift down for the duration, continuously with the unfold,
  and return when focus leaves. Nothing inside a district ever overlaps
  anything else inside it.
- The camera anchor is the line under the pointer, or the focused file's
  first changed line when autopilot or a deep link drives the camera. That
  line stays fixed on screen while zooming.

## 6. Roads

Review of the real-repository demo settled this: the full road network adds
little and distracts, there are always more roads than anyone can follow. The
agent's trips, by contrast, are the most informative thing on the map. So:

- Roads are off by default. The network is a focus tool, not a base layer.
- Hovering or focusing a file shows its roads at full contrast: local
  (inside its directory), arterial (to other directories in its region),
  motorway (to other regions), with widths 1, 1.5 and 3 px at reference zoom.
  Everything else stays hidden.
- A toggle shows the whole network for the moments when the user wants the
  architecture view. Then the three classes and their visibility by zoom
  apply, bundled through the region hierarchy, drawn beneath tiles.
- Agent trips are always on. A trip rides the road between its two files if
  one exists, otherwise a routed curve, and leaves link volume behind that
  fades on the slow duration. Trips are the traffic layer from PLAN.md and
  they do not depend on the road toggle.

## 7. Labels and wayfinding

The user must always be able to answer four questions without moving the
camera: which file is in front of me, where in it, which district and region
it sits in, and where the agent is if not here. Labels anchored to corners
fail this the moment the corner leaves the screen, which is exactly where the
user works. So labels are anchored to the viewport, not to corners.

- Sticky labels. A region's name is drawn at the intersection of the region
  and the viewport. When the user pans into the middle of a district, its name
  slides along the border and stays pinned at the top-left of the visible
  part. Nested regions stack: the top-level region sticks at the very top,
  its child just below. A file's name behaves the same way on its sheet in the
  reading band: it sticks to the top of the visible portion of the page.
- Sticky scope row. Inside a sheet in the reading band, a header row shows the
  enclosing class and function of the first visible line. It is content
  anchored and changes as the user pans through the file. This is the sticky
  scroll idiom from code editors. It needs real symbol spans (start and end
  line) from the indexer.
- Gutter. In the reading band the left margin is a gutter with line numbers on
  every line, dimmed, same monospace. At the top of the schematic band every
  tenth line. Line numbers are part of the page, not chrome. The gutter takes
  its columns from the sheet margin, the text box stays 96 columns.
- Jump bar. One persistent line at the top of the viewport in the district
  label style: region, district, file, class, function, line, separated by
  chevrons. It describes the viewport center, or the focused file when there
  is one, so it is never off-screen and never wrong. Each crumb is a button
  that frames that level. Sticky labels say where you are on the map, the jump
  bar says where you are in the tree, and they always agree. In the product
  the jump bar replaces the debug strip.
- Visibility by fit, not by band. A file label appears whenever its tile is
  wider than the label at minimum size. A region label appears whenever the
  region is wider than its name. A name never crosses its own border: clip to
  the region, abbreviate with an ellipsis, then hide, in that order.
- Two label styles only. District names (small caps, tracked) and file names
  (sentence case, one weight). One size per style per zoom.
- Priority for collision: focused file, region names by depth, file names by
  tile height then fan-in. A label that loses collision disappears, it never
  overlaps.
- Off-screen agent marker. When the agent works outside the viewport, an arrow
  at the screen edge points toward it, with the file name. The user learns
  where the agent is without the camera moving.

## 8. Focus and deep links

- Clicking a file, or arriving via `file=` in the URL, or autopilot targeting
  it, gives the file focus. Focus frames the file at the start of the reading
  band with its first changed line centered, lifts its roads, and dims
  everything outside its district by 30%.
- Escape or a click on terrain clears focus.
- A deep link must land on the file. It does today not.

## 9. Traffic and diff, unchanged in principle

- Activity is shown at the granularity of the band. While a file is a tile,
  reads glow the tile softly and edits strongly, both fading on the slow
  duration. In the reading band the fill glow is off: activity on a sheet the
  user is reading shows at line level (the changed lines carry it) and as a
  glow on the sheet border and its sticky header. Never a tinted wash over
  readable text.
- Trips ride roads and are ground. In the reading band a trip line ends at
  the sheet edge and never crosses source. Link volume widens and brightens
  roads.
- In the schematic band, changed lines are a band on the right margin of the
  sheet. In the reading band, added lines are tinted, removed lines are inline
  and dimmed, and the change blends in when the replay reaches it.

## 10. Chrome

- There is no debug panel in the product. Its place, bottom-left, is taken by
  the agent card: one line for what the agent is doing right now (tool, file,
  line range), a short trail of the last few events fading with age,
  autopilot state and a follow button. It is the only always-visible panel
  besides the jump bar and the minimap. Frame rate and internals live behind
  a debug flag.
- The controls panel is collapsed by default and remembers its state.
- The minimap appears at schematic zoom and deeper, bottom right, and shows
  the viewport on the whole map. It is the only permanent overlay.
- Light and dark themes share every rule above. Tone steps invert.

## 11. Order of work

Each phase is one agent task and ends with screenshots at all four bands on
the real export for review.

1. Type and sheet. Uniform `rowPx`, max zoom, global tiers, sheet is the tile
   with fixed columns and right-margin fade, no second box, short files do not
   stretch, deep link lands on the file. Fixes review items 1, 2, 3, 5, 6, 16.
2. Geography. Proportional tiles (one width, height by effective lines,
   quantized, folded above the cap), column packing with bottom slack, fill
   ramp, borders, district labels top-left, stubs dimmed. Stability re-measured
   with the layout spike harness. Fixes 7, 8, 9, 10, 13, 14.
3. Roads on focus only, off by default, whole-network toggle. Agent trips
   always on. Fixes 11, 12 by removal.
4. Focus and unfold. Deferred (2026-09-03): only files past the 400-line cap
   are affected, 15% of the demo repository. Until it lands, an edit deep in a
   folded file has no visible line to land on and autopilot stops at the fold
   marker. Windows of interest, unfold on focus with column shift, camera
   anchoring inside folds.
5. Labels and wayfinding, pulled forward after the phase 2 review. Sticky
   region and file labels, gutter, jump bar, visibility by fit, collision
   priority, off-screen agent marker. Sticky scope row once the indexer emits
   symbol end lines. Fixes 15 and the wayfinding failures found in review.
6. Quiet. Non-code at 50%, HUD defaults, focus states. Fixes 4.

Review after each phase decides whether the next one starts.

## 12. Open questions

- Fold cap. 400 effective lines is a guess. The right number is the one where
  a district with one huge file still reads as a district.
- Window context. How many lines of context around an edited range, and
  whether a window snaps to enclosing definition boundaries (probably yes,
  the symbol spans from the index make that cheap).
- Height step. 40 lines is a guess. Smaller steps show length more honestly,
  larger steps keep the map stiller under editing.

## 13. Decision log

Dated record of design decisions and what they replaced, so the reasoning
survives the edits above.

- 2026-09-03. First review of the real-repository demo produced sixteen
  problems (font size tied to file length, mixed tiers at one zoom, clipped
  source, schematic bars spilling out of tiles, a second dark box over the
  tile, sheets covering neighbors with labels on top, invisible directories,
  5% footprint density, inconsistent label scale, roads crossing tiles, no
  road hierarchy, stub noise, lost size cue, label collisions, deep link not
  landing). This document was written in response.
- 2026-09-03. One type scale adopted as the first principle. Row height is a
  function of zoom alone, capped at 18 px, which also defines maximum zoom.
- 2026-09-03. Tile shape changed from uniform squares to one fixed width with
  height proportional to effective lines (wrapped long lines counted),
  quantized to coarse steps. Reason: developers read file length at a glance,
  and uniform width plus proportional height makes the one-type-scale rule a
  consequence of geometry instead of a rule to enforce. This replaced the
  earlier three-size tile scheme and made the planned reading-layout accordion
  unnecessary, so phase 4 became focus and unfold.
- 2026-09-03. Long files are folded above a cap rather than compressed or
  log-scaled. Log scaling would break the one-type-scale rule and was
  rejected. The fold keeps proportional reading below the cap and keeps one
  huge file from dominating a district.
- 2026-09-03. Fold content is windows of interest under a fixed line budget,
  following attention (edits and reads open windows, oldest windows close),
  with fold markers captioned by hidden line count. Reason: it is the
  collapsed unified diff idiom developers already know, and it lets content
  move inside a page without the page ever changing shape or position. Folds
  are live in the reading band, and autopilot opens a window before landing.
- 2026-09-03. Accepted stability cost: tile height now depends on content, so
  an edit that crosses a height step moves tiles below it in the column.
  Mitigation is coarse height steps and slack at the bottom of each column,
  tuned with the layout spike's replay harness until the median commit still
  moves nothing.
- 2026-09-03. Brand. Icon direction A adopted: a bright head with two amber
  wake lines diverging behind it over a faint grid of map tiles, on a dark
  navy squircle. It shows both halves of the name, the trail and the map it is
  drawn on. Rejected: nested chevrons (generic), tiles with trail (busy at
  small sizes), W mark (not descriptive). Splash adopted as previewed: dark
  radial ground, icon, wordmark, tracked tagline "the map behind the agent",
  thin amber progress bar, one status line naming the real loader stage.
  Source: assets/brand/.
- 2026-09-03. Phase 1 (type and sheet) shipped in the renderer spike and
  verified: 31 checks, one font size per zoom, max zoom at 18 px rows, zero
  quads or glyphs outside their sheet, deep link lands on the first changed
  line, 120 fps at all bands on the real export. Two deviations accepted: the
  squeeze is released continuously over 6 to 9 px rows instead of snapping at
  9 (a long file's rows would otherwise jump threefold at one zoom), and paper
  tone begins with the schematic tier, below that a tile keeps its district
  tone. The remaining gap, tiles far larger than their 100-column sheet, is
  the tile-shape change in phase 2.
- 2026-09-03. Phase 2 layout half shipped: one lattice cell is 20 glyphs by 10
  lines, tiles are 5 cells wide (100 columns), height is 4 cells per 40-line
  step, fold cap 400 lines, 20% gaps, 25% column slack. Sweep over height
  step {20, 40, 80} and slack {15%, 25%, 40%} on the 50-commit replay: 20-line
  steps fail (median commit moves one node), 25% slack is a sharp optimum,
  15% and 40% both blow up the worst commit to ~9,000 nodes moved. 40/25%
  shipped. Median commit still moves zero nodes, worst commit improved from
  156 to 38 moved, p95 widened from 7 to 23. Coverage inside districts with
  more than eight files: median 37%, meeting the 35% target, mean 31%. Global
  whitespace rose to 87% (half of it column slack), the 25-35% target is not
  met and stays open. The 3:1 aspect cap is unreachable for a district holding
  one folded 400-line page (6.7:1). Export schema is now version 2 with
  effectiveLines and folded on file nodes.
- 2026-09-03. Phase 2 renderer half shipped: the lattice (20 columns by 10
  lines per cell) is the single source of scale, so bands are fixed on every
  dataset and phase 1's fitted constant is gone. Sheet equals tile, 100
  columns wide, 4 cells per 40-line step, no squeeze. Fold markers on all 54
  folded tiles with captions matching the hidden line count. Fill ramp by
  depth verified by luminance, borders, district labels top-left at 10 to 14
  px outranking file labels, stubs dimmed. 66 checks, 120 fps at all bands.
  Paper covers 39% of the median district with more than eight files (target
  35%). Accepted deviations: text box is 96 columns inside the 100-column
  sheet, a file landing exactly on a step has no row margin, no soft wrap yet
  (long lines clip), and the export's folded floor means captions are
  corrected once the text arrives. Regression to watch: eight forced source
  overlays fell from 120 to 74 fps because a sheet is now the whole tile.
- 2026-09-03. Phase 2 review found a wayfinding failure: at most zooms the
  user cannot tell which file or district is in front of them, and in the
  reading band there is no file name, line number or scope at all. Root cause
  is labels anchored to corners that leave the screen before the content
  does. Decided: sticky labels anchored to the viewport intersection, a sticky
  scope row inside sheets, a gutter with line numbers, a persistent jump bar
  describing the viewport center, label visibility by geometric fit rather
  than by band, and an off-screen agent marker. Labels moved ahead of roads
  in the order of work. Section 7 rewritten accordingly.
- 2026-09-03. Indexer emits real symbol spans (definition body, indentation
  column, parent symbol by containment), export schema version 3. On the demo
  repository 92% of definitions span more than one line, the rest are genuine
  one-liners, and 57% have a parent. This unblocks the sticky scope row and
  the jump bar's scope crumbs by containment instead of an indentation guess.
- 2026-09-03. Labels and wayfinding phase shipped: sticky region names at the
  region-viewport intersection at all nesting levels, sticky file name and
  scope row on the sheet in the reading band, gutter with a number on every
  row, jump bar of clickable crumbs at top center (debug strip moved to the
  bottom-left), off-screen agent arrow, visibility by fit with the cascade
  full name, ellipsis, hide below six characters. Scope by real span
  containment on schema 3 exports. 46 checks, 120 fps with labels on. Accepted
  deviations: captions keep one size so "fits at minimum size" became the
  six-character floor, region names are not yet buttons, and a region name can
  paint over a sticky file header that shares its corner (correct by priority,
  cluttered in practice, a candidate for the quiet phase).
- 2026-09-03. Review of the labels phase. Decided: roads off by default and
  shown only for the hovered or focused file (the full network is a toggle),
  agent trips always on since they carry the story. Schematic bars become the
  tile texture from the terrain band up, aggregated at small sizes, so the
  separate blocks band disappears. Only zoom changes a tier, panning never
  does, and source overlays stay mounted while panning. The debug panel is
  removed in favor of an agent activity card bottom-left. Files in the
  repository root get their own bordered district labelled with the
  repository name. Sections 2, 4, 6, 10 and the order of work updated.
- 2026-09-03. Review fixes shipped and verified (43 checks, zero page errors,
  120 fps): schematic texture at every zoom with aggregation below one pixel
  per row, overlays persist while panning and only zoom changes tier, roads
  hidden unless a file is hovered or focused with a whole-network toggle,
  agent trips always on, agent activity card bottom-left replacing the debug
  panel (old panel behind ?debug=1), root files as a bordered district
  labelled with the repository name, controls collapsed by default.
- 2026-09-03. Review: at reading zoom the tile-level edit glow tinted the
  whole viewport brown and a trip line crossed the source. Decided: fill glow
  only while tiles are tiles, line-level marks plus border and header glow in
  the reading band, trip lines end at the sheet edge. Section 9 updated.
- 2026-09-03. Reading-band glow fix shipped: tile fill glow ramps to zero
  from 6 to 9 px rows, a 2-3 px amber ring on the sheet border and sticky
  header carries edits in the reading band, trip lines are clipped against
  sheets in view. Verified with 7 new checks. Two stale checks in the labels
  suite remain: one deliberately superseded by the agent card, one on
  terrain-band caption width to look at in the quiet pass.
