// Wake's stable geography.
//
// Design (PLAN.md section 6, "Geography" and "Layout stability"):
//
//  * Regions nest by directory. Nothing is positioned by a simulation.
//  * Everything lives on one global integer lattice. A file is exactly 1x1
//    cell; a directory region is (w + 2*pad) x (h + 2*pad) cells, where w x h
//    is the region's own grid. Because pad and the grids are integers, a
//    child's footprint in its parent's grid is always integral: one lattice,
//    all the way down.
//  * Sibling order is frozen. It is used exactly once per child: to decide the
//    sequence in which children are first-fit into the region. After a child
//    has a slot, nothing ever reorders it.
//  * New children are greedily inserted into the first free block that fits
//    (GIT-style, Vernier/Comba/Telea 2018). Deleted children leave their cells
//    free, and existing siblings never shift to close the gap.
//  * A region grows only when insertion finds no free block. Growth is a
//    discrete step (whole rows or columns) that restores the slack target, and
//    it propagates to the parent as an ordinary footprint change: the parent
//    first tries to grow the child's block in place, and only relocates it if
//    the surrounding cells are taken.
//
// Layout state (per-region grid size + slot assignments) is carried across
// commits. It is the only state; given the same state and the same tree the
// result is bit-identical.

import type { DirNode, FileNode, Layout, Placement, Rect, TreeNode } from './types.ts';

export interface LayoutConfig {
  /**
   * A region at this depth or shallower reserves 1 cell of border gutter on
   * each side (room for the label and the motorway network). Deeper regions
   * get none: a whole cell of gutter at every one of 10 nesting levels costs
   * more area than the files themselves.
   */
  readonly padMaxDepth: number;
  /**
   * Bottom slack of a file column, as a fraction of the column's content
   * height. This is what absorbs a file growing past a LINES_PER_CELL
   * boundary without the district changing shape (docs/design.md section 4,
   * "Stability cost").
   */
  readonly colSlack: number;
  /** Tile width, in cells. Every file tile has this width. */
  readonly tileW: number;
  /** Gap between tiles and between subregions, in cells. */
  readonly gap: number;
  /** Lines of code one cell of height is worth. */
  readonly cellLines: number;
  /**
   * Height quantum in lines: a tile's height is a whole number of these.
   * docs/design.md's "40-line cells", first guess 40.
   */
  readonly linesPerCell: number;
  /** Effective lines above which a sheet is folded (docs/design.md 3). */
  readonly foldCap: number;
  /**
   * World width of one cell divided by its world height. One cell is
   * `tileW`-th of a 100-glyph sheet wide and `cellLines` lines tall, and a
   * glyph is about 0.6 of a line-height wide, so this is not exactly 1. Shape
   * decisions (aspect cap, column count) multiply x by it; positions never do.
   */
  readonly cellAspect: number;
  /**
   * Fallback bytes-per-effective-line, used only for a file node that carries
   * no `effectiveLines`. Both shipped callers count lines for real.
   */
  readonly bytesPerLine: number;
  /** Target whitespace inside a region that contains subregions. */
  readonly branchSlack: number;
  /** Hard cap on a region's aspect ratio (long side / short side). */
  readonly maxAspect: number;
  /**
   * Order used for the very first pack of a region. 'frozen' preserves the
   * sibling order unconditionally (ELK rectpacking's contract); 'height-desc'
   * sorts by footprint height first, which is textbook first-fit-decreasing-
   * height and wastes much less area when siblings differ wildly in size.
   * Either way the result is frozen afterwards.
   */
  readonly initialPack: 'frozen' | 'height-desc';
  /**
   * Growth reserve, as a fraction of a region's side. A region's footprint is
   * rounded up to a power-of-two quantum of roughly this size, so it can
   * absorb internal growth without its parent seeing anything. Trades area
   * for stability, and it is the single most important knob here.
   */
  readonly growthReserve: number;
  /**
   * Regions with both sides below this get no growth reserve at all. Moving a
   * small region is cheap, so paying area to pin it is not worth it; the
   * reserve is only worth its whitespace for the regions whose relocation
   * would drag thousands of files with it.
   */
  readonly reserveMinSide: number;
  /**
   * Largest footprint quantum, in cells. A cell is now a fraction of a tile
   * (a tile is `tileW` by `linesPerCell / cellLines` cells), so this cap has
   * to scale with the tile, or the growth reserve of a large region collapses
   * to a couple of percent of its side and every edit ripples to the root.
   */
  readonly reserveMaxQuantum: number;
}

export const DEFAULT_CONFIG: LayoutConfig = {
  padMaxDepth: 2,
  colSlack: 0.25,
  tileW: 5,
  gap: 1,
  cellLines: 10,
  linesPerCell: 40,
  foldCap: 400,
  cellAspect: 1.2,
  bytesPerLine: 35,
  branchSlack: 0.02,
  maxAspect: 3,
  initialPack: 'height-desc',
  growthReserve: 0.12,
  reserveMinSide: 1,
  reserveMaxQuantum: 32,
};

function padAt(depth: number, cfg: LayoutConfig): number {
  return depth <= cfg.padMaxDepth ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Tile geometry (docs/design.md sections 3 and 4).
//
// One cell is `100 / tileW` glyphs wide and `cellLines` lines tall. With the
// shipped defaults (tileW 5, cellLines 10) a cell is 20 glyphs by 10 lines,
// which is 12 by 10 line-heights on screen: near enough square that one gap
// cell reads the same horizontally and vertically.
//
// Every file tile is `tileW` cells wide — the sheet is 100 columns, always —
// and `linesPerCell / cellLines` cells tall per height step. A stub is one
// step. A sheet at the fold cap is `foldCap / cellLines` cells tall.
//
// Footprints carry the gap on their right and bottom edge, so the packer needs
// no gap arithmetic and growth reserve can never end up between two tiles.
// The DRAWN rect is the footprint minus the gap; that is what `emit` reports.
// ---------------------------------------------------------------------------

/** Cells of height one LINES_PER_CELL step is worth. */
export function stepCells(cfg: LayoutConfig): number {
  return Math.max(1, Math.round(cfg.linesPerCell / cfg.cellLines));
}

/** Effective lines of a file node, with the documented byte fallback. */
export function effectiveLinesOf(node: FileNode, cfg: LayoutConfig): number {
  if (node.effectiveLines !== undefined) return Math.max(1, node.effectiveLines);
  return Math.max(1, Math.round(node.size / cfg.bytesPerLine));
}

export interface TileGeometry {
  /** Drawn tile size in cells. */
  readonly w: number;
  readonly h: number;
  readonly effectiveLines: number;
  readonly folded: boolean;
}

export function tileGeometry(node: FileNode, cfg: LayoutConfig): TileGeometry {
  const lines = effectiveLinesOf(node, cfg);
  const used = Math.min(lines, cfg.foldCap);
  const steps = Math.max(1, Math.ceil(used / cfg.linesPerCell));
  return {
    w: cfg.tileW,
    h: steps * stepCells(cfg),
    effectiveLines: lines,
    folded: lines > cfg.foldCap,
  };
}

/** Aspect ratio (long side / short side) of a cell rectangle, in world units. */
function worldAspect(w: number, h: number, cfg: LayoutConfig): number {
  const ww = Math.max(1e-9, w * cfg.cellAspect);
  const wh = Math.max(1e-9, h);
  return ww >= wh ? ww / wh : wh / ww;
}

/**
 * Footprint quantum. A region's FOOTPRINT (what its parent sees) is rounded up
 * to a multiple of this, so the region can absorb several rows of internal
 * growth before the parent notices anything at all. Without it, one new file
 * in a leaf can ripple all the way to the root and relocate a whole
 * continent: measured on a real repo, that is the single largest source of
 * instability. Bigger regions get a coarser quantum, so the reserve stays a
 * roughly constant fraction of their area.
 */
function quantumFor(side: number, cfg: LayoutConfig): number {
  if (side < cfg.reserveMinSide) return 1;
  const want = side * cfg.growthReserve;
  if (want <= 1) return 1;
  return Math.min(cfg.reserveMaxQuantum, 2 ** Math.ceil(Math.log2(want)));
}

function ceilTo(v: number, q: number): number {
  return q <= 1 ? v : Math.ceil(v / q) * q;
}

/**
 * A region with a handful of children gets no slack: reserving a whole spare
 * cell next to two files costs more area than it saves movement, and the
 * growth event when a third file arrives is cheap and local.
 */
const SLACK_MIN_CHILDREN = 8;

/**
 * Slack for the SUBREGION block only. File tiles carry their slack at the
 * bottom of their own column (cfg.colSlack), which is the only place growth
 * from an edit can appear, so a region's spare area is now purely about
 * inserting new subdirectories.
 */
function slackFor(dir: DirNode, cfg: LayoutConfig): number {
  if (dir.children.length < SLACK_MIN_CHILDREN) return 0;
  for (const c of dir.children) if (c.kind === 'dir') return cfg.branchSlack;
  return 0;
}

/**
 * Per-region persistent state. Subregions keep frozen 2D slots as before.
 * File tiles keep a frozen COLUMN ASSIGNMENT instead: their y follows from the
 * heights of the tiles above them in the same column, so a file that crosses
 * a height step shifts the tiles below it in its own column and nothing else
 * (docs/design.md section 4, "Stability cost"). Column assignment, column
 * order and the target column height are all frozen at first build.
 */
interface Region {
  w: number;
  h: number;
  /** child name -> slot rect in region-grid coordinates */
  readonly slots: Map<string, Rect>;
  /** File children per column, top to bottom, in frozen sibling order. */
  cols: string[][];
  /** Allocated height per column in cells, monotonically non-decreasing. */
  colAlloc: number[];
  /** Target column height chosen at first build, in cells. */
  colTargetH: number;
  /**
   * Frozen origin of the subregion block, and the frozen y of the file block.
   * The two blocks sit side by side or stacked, whichever wastes less area,
   * decided once at first build. Either way the file columns are free to grow
   * downward into empty terrain, so a file crossing a height step can never
   * displace a subregion.
   */
  dirOriginX: number;
  fileOriginY: number;
}

export class LayoutState {
  private readonly regions = new Map<string, Region>();

  region(path: string): Region {
    let r = this.regions.get(path);
    if (!r) {
      r = {
        w: 0, h: 0, slots: new Map(), cols: [], colAlloc: [],
        colTargetH: 0, dirOriginX: 0, fileOriginY: 0,
      };
      this.regions.set(path, r);
    }
    return r;
  }

  /** Growth and relocation events recorded during the last layout pass. */
  events: LayoutEvent[] = [];
}

export interface LayoutEvent {
  readonly kind: 'grow' | 'relocate' | 'insert' | 'remove';
  readonly path: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Free-space bookkeeping over a region's grid.
// ---------------------------------------------------------------------------

class Grid {
  private occ: Uint8Array;
  w: number;
  h: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.occ = new Uint8Array(Math.max(1, w * h));
  }

  private idx(x: number, y: number): number {
    return y * this.w + x;
  }

  resize(w: number, h: number): void {
    const next = new Uint8Array(Math.max(1, w * h));
    for (let y = 0; y < Math.min(this.h, h); y++) {
      for (let x = 0; x < Math.min(this.w, w); x++) {
        next[y * w + x] = this.occ[this.idx(x, y)]!;
      }
    }
    this.w = w;
    this.h = h;
    this.occ = next;
  }

  mark(r: Rect, value: 0 | 1): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.occ[y * this.w + x] = value;
    }
  }

  free(x: number, y: number, w: number, h: number): boolean {
    if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) return false;
    for (let yy = y; yy < y + h; yy++) {
      const row = yy * this.w;
      for (let xx = x; xx < x + w; xx++) if (this.occ[row + xx]) return false;
    }
    return true;
  }

  /**
   * Try to give an existing block a larger footprint while keeping it where it
   * is. The block's own cells must already be unmarked. Anchor shifts (growing
   * up or left instead of down or right) are allowed but ranked last, so a
   * block that can grow without moving does not move.
   */
  expandInPlace(slot: Rect, w: number, h: number): Rect | null {
    const maxDx = Math.max(0, w - slot.w);
    const maxDy = Math.max(0, h - slot.h);
    const cands: { dx: number; dy: number }[] = [];
    for (let dy = 0; dy <= maxDy; dy++) {
      for (let dx = 0; dx <= maxDx; dx++) cands.push({ dx, dy });
    }
    cands.sort((a, b) => a.dx + a.dy - (b.dx + b.dy) || a.dy - b.dy || a.dx - b.dx);
    for (const c of cands) {
      const x = slot.x - c.dx;
      const y = slot.y - c.dy;
      if (x < 0 || y < 0) continue;
      if (this.free(x, y, w, h)) return { x, y, w, h };
    }
    return null;
  }

  /**
   * First-fit, row-major from the top-left: the topmost row that fits, and the
   * leftmost x in it. This is the greedy insertion (GIT, Vernier/Comba/Telea
   * 2018).
   *
   * Implemented as one bottom-up pass with a free-run-downward counter per
   * column, so a query costs O(w*h) in the GRID's cells and not O(grid *
   * candidate). The naive scan was fine when a file was one cell; with the
   * phase-2 lattice a region's grid has ~20x the cells and a candidate ~20x
   * the area, and relocating a top-level region inside the root went from
   * milliseconds to effectively never finishing.
   */
  firstFit(w: number, h: number): { x: number; y: number } | null {
    const W = this.w;
    const H = this.h;
    if (w > W || h > H) return null;
    const down = new Int32Array(W);
    let bestX = -1;
    let bestY = -1;
    for (let y = H - 1; y >= 0; y--) {
      const row = y * W;
      for (let x = 0; x < W; x++) down[x] = this.occ[row + x] ? 0 : down[x]! + 1;
      if (y + h > H) continue;
      let run = 0;
      for (let x = 0; x < W; x++) {
        run = down[x]! >= h ? run + 1 : 0;
        if (run >= w) {
          bestX = x - w + 1;
          bestY = y;
          break;
        }
      }
    }
    return bestX < 0 ? null : { x: bestX, y: bestY };
  }

  used(): number {
    let n = 0;
    for (let i = 0; i < this.occ.length; i++) if (this.occ[i]) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Pass 1 (bottom-up): footprints and slot assignment.
// ---------------------------------------------------------------------------

export type OrderFn = (dir: DirNode) => string[];

interface Sized {
  readonly node: TreeNode;
  /**
   * Footprint in the PARENT's grid, in cells, INCLUDING the gap carried on the
   * right and bottom edge. The drawn rect is `drawnW x drawnH`.
   */
  readonly w: number;
  readonly h: number;
  readonly drawnW: number;
  readonly drawnH: number;
  readonly bytes: number;
  /** Files only. */
  readonly effectiveLines?: number;
  readonly folded?: boolean;
  readonly children?: Sized[];
  /** Free cells inside this region (dirs only). */
  readonly freeCells?: number;
  readonly totalCells?: number;
  /** Footprint before the growth-reserve quantum was applied. */
  readonly rawW?: number;
  readonly rawH?: number;
  /** Drawn area of the file tiles directly inside this region, in cells. */
  readonly fileCells?: number;
  readonly directFiles?: number;
}

function grownExtent(
  usedArea: number,
  w: number,
  h: number,
  needW: number,
  needH: number,
  slack: number,
  cfg: LayoutConfig,
): { w: number; h: number } {
  // Discrete growth: enlarge whole rows/columns until the grid can plausibly
  // hold the used area plus the newcomer at the slack target, and until the
  // newcomer's own footprint fits at all.
  let nw = Math.max(w, needW);
  let nh = Math.max(h, needH);
  const targetArea = Math.ceil(usedArea / (1 - slack));
  let guard = 0;
  while ((nw * nh < targetArea || nw < needW || nh < needH) && guard++ < 4096) {
    // Square-ish in WORLD units, never a sliver: a cell is not square.
    const growW = nw * cfg.cellAspect <= nh;
    if (growW && (nw + 1) * cfg.cellAspect <= nh * cfg.maxAspect) nw += 1;
    else if (!growW && nh + 1 <= nw * cfg.cellAspect * cfg.maxAspect) nh += 1;
    else if (growW) nh += 1;
    else nw += 1;
  }
  return { w: nw, h: nh };
}

function freeOf(s: Shelf): number {
  let used = 0;
  for (const r of s.slots.values()) used += r.w * r.h;
  return s.w * s.h - used;
}

/**
 * Grow a freshly packed grid until its free fraction reaches the slack target.
 * Row packing already leaves ragged free space, so this often adds nothing.
 */
function withSlack(
  w: number,
  h: number,
  usedArea: number,
  slack: number,
  cfg: LayoutConfig,
): { w: number; h: number } {
  return grownExtent(usedArea, w, h, 1, 1, slack, cfg);
}

/** Slots that intersect a candidate block, excluding the block's own slot. */
function overlapping(
  slots: Map<string, Rect>,
  self: string,
  x: number,
  y: number,
  w: number,
  h: number,
): { name: string; rect: Rect }[] {
  const hit: { name: string; rect: Rect }[] = [];
  for (const [name, r] of slots) {
    if (name === self) continue;
    if (intersects(r, { x, y, w, h })) hit.push({ name, rect: r });
  }
  hit.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return hit;
}

interface ShelfItem {
  readonly key: number;
  readonly w: number;
  readonly h: number;
}

interface Shelf {
  readonly slots: Map<number, Rect>;
  readonly w: number;
  readonly h: number;
}

/**
 * Row ("shelf") packing at a fixed grid width. Rigid rectangles of very
 * different sizes cannot be packed into a square of their total area, so the
 * first build lays siblings out in rows and the region's extent follows. Free
 * cells at the ragged right end of each row are real slack and are reused by
 * later greedy insertions.
 */
function shelf(items: ShelfItem[], width: number): Shelf {
  let W = width;
  for (const it of items) W = Math.max(W, it.w);
  const slots = new Map<number, Rect>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > W) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    slots.set(it.key, { x, y, w: it.w, h: it.h });
    x += it.w;
    rowH = Math.max(rowH, it.h);
  }
  return { slots, w: W, h: y + rowH };
}


// --- MaxRects (best-short-side-fit) -----------------------------------------
// Shelves are cheap but waste badly when a region mixes one huge subregion
// with many small ones, which is exactly what a real repository root looks
// like. MaxRects fills the space beside the big block. Only used for regions
// with few children, where it is both affordable and where it pays.

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function pruneFree(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i]!;
    if (a.w <= 0 || a.h <= 0) continue;
    let dominated = false;
    for (let j = 0; j < rects.length && !dominated; j++) {
      if (i === j) continue;
      const b = rects[j]!;
      if (b.w <= 0 || b.h <= 0) continue;
      if (contains(b, a) && (b.w !== a.w || b.h !== a.h || j < i)) dominated = true;
    }
    if (!dominated) out.push(a);
  }
  return out;
}

function maxRects(items: ShelfItem[], width: number): Shelf | null {
  let area = 0;
  let tallest = 1;
  for (const it of items) {
    if (it.w > width) return null;
    area += it.w * it.h;
    tallest = Math.max(tallest, it.h);
  }
  const H = Math.ceil((area * 3) / width) + tallest + 2;
  let free: Rect[] = [{ x: 0, y: 0, w: width, h: H }];
  const slots = new Map<number, Rect>();
  let usedW = 0;
  let usedH = 0;

  for (const it of items) {
    let best: Rect | null = null;
    let bestKey: Key4 = [0, 0, 0, 0];
    for (const fr of free) {
      if (fr.w < it.w || fr.h < it.h) continue;
      const lh = fr.w - it.w;
      const lv = fr.h - it.h;
      const key: Key4 = [Math.min(lh, lv), Math.max(lh, lv), fr.y, fr.x];
      if (best === null || lexLess(key, bestKey)) {
        best = fr;
        bestKey = key;
      }
    }
    if (best === null) return null;
    const placed: Rect = { x: best.x, y: best.y, w: it.w, h: it.h };
    slots.set(it.key, placed);
    usedW = Math.max(usedW, placed.x + placed.w);
    usedH = Math.max(usedH, placed.y + placed.h);

    const next: Rect[] = [];
    for (const fr of free) {
      if (!intersects(fr, placed)) {
        next.push(fr);
        continue;
      }
      if (placed.x > fr.x) next.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
      if (placed.x + placed.w < fr.x + fr.w) {
        next.push({
          x: placed.x + placed.w, y: fr.y,
          w: fr.x + fr.w - (placed.x + placed.w), h: fr.h,
        });
      }
      if (placed.y > fr.y) next.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y });
      if (placed.y + placed.h < fr.y + fr.h) {
        next.push({
          x: fr.x, y: placed.y + placed.h,
          w: fr.w, h: fr.y + fr.h - (placed.y + placed.h),
        });
      }
    }
    free = pruneFree(next);
  }
  return { slots, w: usedW, h: usedH };
}

type Key4 = readonly [number, number, number, number];

function lexLess(a: Key4, b: Key4): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  if (a[2] !== b[2]) return a[2] < b[2];
  return a[3] < b[3];
}

/**
 * Score a candidate packing: area, mildly penalised for being oblong and
 * hard-penalised for exceeding the aspect cap. Slivers are what makes
 * slice-and-dice unreadable; the cap is what keeps this readable.
 */
function shelfScore(s: Shelf, cfg: LayoutConfig): number {
  const ar = worldAspect(s.w, s.h, cfg);
  const soft = 1 + 0.12 * (ar - 1);
  const hard = ar > cfg.maxAspect ? (ar / cfg.maxAspect) ** 3 : 1;
  return s.w * s.h * soft * hard;
}

/** Max children for which MaxRects is worth its cost. */
const MAXRECTS_LIMIT = 96;

/**
 * Pick the packing and grid width that minimise area subject to the aspect
 * cap. The candidate set is a fixed deterministic ladder around sqrt(total
 * area), so the choice is reproducible from the tree alone.
 */
function bestShelf(items: ShelfItem[], cfg: LayoutConfig): Shelf {
  let area = 0;
  let maxW = 1;
  for (const it of items) {
    area += it.w * it.h;
    maxW = Math.max(maxW, it.w);
  }
  const root = Math.max(1, Math.ceil(Math.sqrt(area)));
  const factors = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.45, 1.7, 2.0];
  let best: Shelf | null = null;
  let bestScore = Infinity;
  const consider = (cand: Shelf | null): void => {
    if (cand === null) return;
    const score = shelfScore(cand, cfg);
    if (score < bestScore) {
      best = cand;
      bestScore = score;
    }
  };
  for (const f of factors) {
    const w = Math.max(maxW, Math.round(root * f));
    consider(shelf(items, w));
    if (items.length <= MAXRECTS_LIMIT) consider(maxRects(items, w));
  }
  return best!;
}


// ---------------------------------------------------------------------------
// File columns.
//
// Files stack top to bottom in frozen sibling order, wrapping to the next
// column when the column reaches the region's target height. The target is
// picked once, from the aspect the whole block will have: square-ish or wider,
// hard-capped at cfg.maxAspect, exactly as for a subregion. After that the
// assignment is frozen, so the only thing a content change can move is the
// tiles below the changed file IN ITS OWN COLUMN.
// ---------------------------------------------------------------------------

interface ColumnFill {
  readonly cols: string[][];
  /** Tallest column's content height, in cells. */
  readonly height: number;
}

function fillColumns(
  names: readonly string[],
  heightOf: (name: string) => number,
  target: number,
): ColumnFill {
  const cols: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  let height = 0;
  for (const name of names) {
    const h = heightOf(name);
    if (cur.length > 0 && used + h > target) {
      cols.push(cur);
      height = Math.max(height, used);
      cur = [];
      used = 0;
    }
    cur.push(name);
    used += h;
  }
  if (cur.length > 0) {
    cols.push(cur);
    height = Math.max(height, used);
  }
  return { cols, height };
}

/**
 * Choose the column target height. Candidates are the exact even splits of the
 * total content height (1..n columns); each is scored by the block's area with
 * the same soft-oblong / hard-aspect-cap penalty the subregion packer uses,
 * plus a mild extra penalty for being TALLER than wide, because design.md asks
 * for square-ish or wider.
 */
function chooseColumns(
  names: readonly string[],
  heightOf: (name: string) => number,
  cfg: LayoutConfig,
): { fill: ColumnFill; target: number } {
  let total = 0;
  let tallest = 1;
  for (const n of names) {
    const h = heightOf(n);
    total += h;
    tallest = Math.max(tallest, h);
  }
  const pitch = cfg.tileW + cfg.gap;
  let best: { fill: ColumnFill; target: number } | null = null;
  let bestScore = Infinity;
  for (let k = 1; k <= Math.max(1, names.length); k++) {
    const target = Math.max(tallest, Math.ceil(total / k));
    const fill = fillColumns(names, heightOf, target);
    const w = fill.cols.length * pitch;
    const ar = worldAspect(w, fill.height, cfg);
    const tallPenalty = w * cfg.cellAspect < fill.height ? 1 + 0.3 * (ar - 1) : 1;
    const soft = 1 + 0.12 * (ar - 1);
    const hard = ar > cfg.maxAspect ? (ar / cfg.maxAspect) ** 3 : 1;
    const score = w * fill.height * soft * hard * tallPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = { fill, target };
    }
    if (fill.cols.length >= names.length) break;
  }
  return best ?? { fill: { cols: [], height: 0 }, target: 1 };
}

/** Where a newcomer goes: the first column with room, else a new column. */
function appendToColumns(
  region: Region,
  name: string,
  h: number,
  usedOf: (col: string[]) => number,
): void {
  for (let i = 0; i < region.cols.length; i++) {
    if (usedOf(region.cols[i]!) + h <= region.colAlloc[i]!) {
      region.cols[i]!.push(name);
      return;
    }
  }
  const last = region.cols.length - 1;
  if (last >= 0 && usedOf(region.cols[last]!) + h <= region.colTargetH) {
    region.cols[last]!.push(name);
    return;
  }
  region.cols.push([name]);
  region.colAlloc.push(0);
}

/**
 * Absolute slots for the file tiles of one region, straight out of the frozen
 * column assignment. Column x is the column pitch; y is the running sum of the
 * heights above. Allocation per column only ever grows, so a file that shrinks
 * never shrinks the district.
 */
function layoutFileColumns(
  region: Region,
  heights: Map<string, number>,
  cfg: LayoutConfig,
): { slots: Map<string, Rect>; w: number; h: number; contentH: number } {
  const pitch = cfg.tileW + cfg.gap;
  const slots = new Map<string, Rect>();
  let contentH = 0;
  while (region.colAlloc.length < region.cols.length) region.colAlloc.push(0);
  for (let i = 0; i < region.cols.length; i++) {
    let y = 0;
    for (const name of region.cols[i]!) {
      const h = heights.get(name) ?? 1;
      slots.set(name, { x: i * pitch, y, w: cfg.tileW + cfg.gap, h });
      y += h;
    }
    contentH = Math.max(contentH, y);
    // Discrete growth, like a region's: the slack is a RESERVE that gets
    // consumed, not a multiplier that grows on every edit. A file crossing a
    // height step eats into the reserve and the district does not change shape
    // at all; only when the reserve is gone does the column grow, and then it
    // grows past the new content by the slack again.
    if (y > region.colAlloc[i]!) region.colAlloc[i] = Math.ceil(y * (1 + cfg.colSlack));
  }
  let allocH = 0;
  for (const a of region.colAlloc) allocH = Math.max(allocH, a);
  return {
    slots,
    w: region.cols.length * pitch,
    h: Math.max(allocH, contentH),
    contentH,
  };
}

function place(dir: DirNode, state: LayoutState, order: OrderFn, cfg: LayoutConfig, depth: number): Sized {
  const sizedChildren: Sized[] = [];
  for (const child of dir.children) {
    if (child.kind === 'file') {
      const g = tileGeometry(child, cfg);
      sizedChildren.push({
        node: child,
        w: g.w + cfg.gap,
        h: g.h + cfg.gap,
        drawnW: g.w,
        drawnH: g.h,
        bytes: child.size,
        effectiveLines: g.effectiveLines,
        folded: g.folded,
      });
    } else {
      sizedChildren.push(place(child, state, order, cfg, depth + 1));
    }
  }

  const region = state.region(dir.path);
  const slack = slackFor(dir, cfg);
  const pad = padAt(depth, cfg);
  const byName = new Map(sizedChildren.map((s) => [s.node.name, s] as const));
  const fileSized = sizedChildren.filter((s) => s.node.kind === 'file');
  const dirSized = sizedChildren.filter((s) => s.node.kind === 'dir');
  const heights = new Map(fileSized.map((s) => [s.node.name, s.h] as const));
  const heightOf = (name: string): number => heights.get(name) ?? 1;
  const isDirSlot = (name: string): boolean => byName.get(name)?.node.kind === 'dir';

  // 1. Retire slots and column entries whose child is gone. The cells become
  //    free; siblings do not move, so the gap stays visible until something is
  //    inserted there.
  for (const name of [...region.slots.keys()]) {
    if (!byName.has(name)) {
      region.slots.delete(name);
      state.events.push({ kind: 'remove', path: `${dir.path}/${name}`, detail: 'slot freed' });
    }
  }
  const wasEmpty = region.cols.length === 0 && region.slots.size === 0;
  // A column that loses all its files keeps its index and its allocation: the
  // cells stay free for the next insertion, and no other column shifts left.
  region.cols = region.cols.map((col) =>
    col.filter((n) => byName.get(n)?.node.kind === 'file'),
  );

  // 2. File columns. Frozen sibling order is consumed exactly once, to choose
  //    the column target and the initial assignment.
  if (region.cols.length === 0 && fileSized.length > 0) {
    const rank = new Map(order(dir).map((n, i) => [n, i] as const));
    const names = fileSized
      .map((s) => s.node.name)
      .sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
    const chosen = chooseColumns(names, heightOf, cfg);
    region.cols = chosen.fill.cols.map((c) => [...c]);
    region.colAlloc = region.cols.map(() => 0);
    region.colTargetH = chosen.target;
  } else if (fileSized.length > 0) {
    const placed = new Set(region.cols.flat());
    const rank = new Map(order(dir).map((n, i) => [n, i] as const));
    const newcomers = fileSized
      .filter((s) => !placed.has(s.node.name))
      .sort((a, b) => (rank.get(a.node.name) ?? 1e9) - (rank.get(b.node.name) ?? 1e9));
    const usedOf = (col: string[]): number => {
      let sum = 0;
      for (const n of col) sum += heightOf(n);
      return sum;
    };
    for (const s of newcomers) {
      appendToColumns(region, s.node.name, s.h, usedOf);
      state.events.push({ kind: 'insert', path: s.node.path, detail: 'appended to a file column' });
    }
  }
  const fileBlock = layoutFileColumns(region, heights, cfg);

  // 3. Subregions: one block, either to the right of the file columns or above
  //    them, whichever wastes less of the region's rectangle. Both origins are
  //    frozen at first build, and in both arrangements the file columns have
  //    empty terrain below them, so a file crossing a height step can never
  //    displace a subregion (nor the other way round).
  const hasDirSlot = [...region.slots.keys()].some(isDirSlot);
  const freshDirs = dirSized.length > 0 && !hasDirSlot;

  if (freshDirs) {
    const rank0 = new Map(order(dir).map((n, i) => [n, i] as const));
    const seq = [...dirSized].sort(
      (a, b) => (rank0.get(a.node.name) ?? 1e9) - (rank0.get(b.node.name) ?? 1e9),
    );
    if (cfg.initialPack === 'height-desc') {
      seq.sort(
        (a, b) =>
          b.h - a.h ||
          b.w - a.w ||
          (rank0.get(a.node.name) ?? 1e9) - (rank0.get(b.node.name) ?? 1e9),
      );
    }
    const packed = bestShelf(seq.map((sz, i) => ({ key: i, w: sz.w, h: sz.h })), cfg);
    const usedArea = packed.w * packed.h - freeOf(packed);
    const ext = withSlack(packed.w, packed.h, usedArea, slack, cfg);
    // Side by side leaves an empty corner whenever the two blocks differ in
    // height; stacked leaves one whenever they differ in width. Score both the
    // way the packer scores anything else: area, softly penalised for being
    // oblong, hard-penalised past the aspect cap.
    const score = (w: number, h: number): number => {
      const ar = worldAspect(w, h, cfg);
      const hard = ar > cfg.maxAspect ? (ar / cfg.maxAspect) ** 3 : 1;
      return w * h * (1 + 0.12 * (ar - 1)) * hard;
    };
    const beside = score(fileBlock.w + ext.w, Math.max(fileBlock.h, ext.h));
    const stacked = score(Math.max(fileBlock.w, ext.w), fileBlock.h + ext.h);
    if (fileBlock.w > 0 && beside <= stacked) {
      region.dirOriginX = fileBlock.w;
      region.fileOriginY = 0;
    } else {
      // Stacked: subregions on top, file columns below them. This is also the
      // only safe choice for a region that has no files YET — a file arriving
      // later would otherwise start its first column at (0,0), straight on top
      // of the subregion block, and evict every subregion in the district.
      region.dirOriginX = 0;
      region.fileOriginY = ext.h;
    }
    region.w = Math.max(region.w, fileBlock.w, region.dirOriginX + ext.w);
    region.h = Math.max(region.h, region.fileOriginY + fileBlock.h, ext.h);
    for (const [key, slot] of packed.slots) {
      region.slots.set(seq[key]!.node.name, {
        x: region.dirOriginX + slot.x,
        y: slot.y,
        w: slot.w,
        h: slot.h,
      });
    }
  } else {
    region.w = Math.max(region.w, fileBlock.w, 1);
    region.h = Math.max(region.h, region.fileOriginY + fileBlock.h, 1);
  }
  for (const [name, slot] of fileBlock.slots) {
    region.slots.set(name, { ...slot, y: slot.y + region.fileOriginY });
  }

  const grid = new Grid(region.w, region.h);
  const pending: Sized[] = [];
  for (const [name, slot] of region.slots) {
    if (isDirSlot(name)) continue;
    if (slot.x + slot.w <= grid.w && slot.y + slot.h <= grid.h) grid.mark(slot, 1);
  }

  // 4. Subregion slots: mark what fits, then fix up whatever changed shape or
  //    was overrun by a widened file block.
  const dirSlots = new Map<string, Rect>();
  for (const [name, slot] of region.slots) if (isDirSlot(name)) dirSlots.set(name, slot);
  const kept: { name: string; sized: Sized }[] = [];
  // `marked` is the set of subregion slots whose cells are actually ours to
  // unmark later. A slot that no longer fits, or that a widened file block now
  // covers, is NOT marked — and must never be unmarked either, or it would
  // erase the file tile underneath it.
  const marked = new Set<string>();
  for (const [name, slot] of dirSlots) {
    const sized = byName.get(name)!;
    const fits = slot.x + slot.w <= grid.w && slot.y + slot.h <= grid.h;
    if (fits && grid.free(slot.x, slot.y, slot.w, slot.h)) {
      grid.mark(slot, 1);
      marked.add(name);
    }
    kept.push({ name, sized });
  }
  const evicted = new Set<string>();
  const enqueue = (sz: Sized): void => {
    if (evicted.has(sz.node.name)) return;
    evicted.add(sz.node.name);
    pending.push(sz);
  };
  for (const { name, sized } of kept) {
    const slot = region.slots.get(name);
    // Gone already: an earlier, larger sibling evicted it this pass.
    if (!slot) continue;
    const mine = marked.has(name);
    if (mine && sized.w === slot.w && sized.h === slot.h) continue; // unchanged
    if (!mine && sized.w === slot.w && sized.h === slot.h) {
      // Its footprint is the same but something else now occupies its cells:
      // the file columns widened over it, or the region shrank around it.
      region.slots.delete(name);
      enqueue(sized);
      state.events.push({
        kind: 'relocate',
        path: sized.node.path,
        detail: 'its slot is no longer free',
      });
      continue;
    }
    // The child's own region grew. Free its own cells and try to keep it here.
    if (mine) grid.mark(slot, 0);
    let spot = grid.expandInPlace(slot, sized.w, sized.h);
    if (!spot) {
      // Grow this region by exactly the overflow, not by a whole strip, then
      // try again. Enlarging the map a few cells is far cheaper than moving a
      // continent, and the footprint quantum usually hides it from the parent.
      const needW = Math.max(grid.w, slot.x + sized.w);
      const needH = Math.max(grid.h, slot.y + sized.h);
      if (needW > grid.w || needH > grid.h) {
        const before = `${grid.w}x${grid.h}`;
        grid.resize(needW, needH);
        region.w = needW;
        region.h = needH;
        state.events.push({
          kind: 'grow',
          path: dir.path,
          detail: `${before} -> ${needW}x${needH} (in-place growth of ${name})`,
        });
        spot = grid.expandInPlace(slot, sized.w, sized.h);
      }
    }
    if (!spot) {
      // Last resort before moving this region: if the SUBREGION siblings
      // standing in its way are collectively smaller than it is, evict THEM. A
      // region that dominates its parent must never be the one that teleports.
      // File tiles are never evicted: their column is their address.
      const blockers = overlapping(dirSlots, name, slot.x, slot.y, sized.w, sized.h)
        .filter((b) => region.slots.has(b.name));
      let blockerArea = 0;
      for (const b of blockers) blockerArea += b.rect.w * b.rect.h;
      if (blockers.length > 0 && blockerArea < sized.w * sized.h) {
        for (const b of blockers) {
          grid.mark(b.rect, 0);
          region.slots.delete(b.name);
          const ev = byName.get(b.name);
          if (ev) enqueue(ev);
          state.events.push({
            kind: 'relocate',
            path: `${dir.path}/${b.name}`,
            detail: `evicted by larger sibling ${name}`,
          });
        }
        spot = grid.expandInPlace(slot, sized.w, sized.h);
      }
    }
    if (spot) {
      slot.x = spot.x;
      slot.y = spot.y;
      slot.w = sized.w;
      slot.h = sized.h;
      grid.mark(slot, 1);
    } else {
      region.slots.delete(name);
      enqueue(sized);
      state.events.push({
        kind: 'relocate',
        path: sized.node.path,
        detail: `footprint ${slot.w}x${slot.h} -> ${sized.w}x${sized.h}, no room in place`,
      });
    }
  }

  // 5. New subregions, in frozen sibling order (only their insertion sequence
  //    depends on it, and only once).
  const insertOrder = order(dir);
  const rank = new Map(insertOrder.map((n, i) => [n, i] as const));
  const newcomers = dirSized.filter(
    (s) => !region.slots.has(s.node.name) && !pending.includes(s),
  );
  newcomers.sort((a, b) => (rank.get(a.node.name) ?? 1e9) - (rank.get(b.node.name) ?? 1e9));
  pending.sort((a, b) => (rank.get(a.node.name) ?? 1e9) - (rank.get(b.node.name) ?? 1e9));

  for (const sized of [...pending, ...newcomers]) {
    let spot = grid.firstFit(sized.w, sized.h);
    if (!spot) {
      const before = `${grid.w}x${grid.h}`;
      const ext = grownExtent(
        grid.used() + sized.w * sized.h, grid.w, grid.h, sized.w, sized.h, slack, cfg,
      );
      grid.resize(ext.w, ext.h);
      region.w = ext.w;
      region.h = ext.h;
      state.events.push({
        kind: 'grow',
        path: dir.path,
        detail: `${before} -> ${ext.w}x${ext.h} (slack exhausted)`,
      });
      spot = grid.firstFit(sized.w, sized.h);
      if (!spot) {
        // Fragmentation: the grown grid has the AREA but no free rectangle of
        // the right shape. Grow by the SMALLEST number of rows or columns that
        // admits one, on whichever axis keeps the region closest to square.
        // Minimality is what keeps the region from doubling and cascading into
        // its parent; growing by a whole strip instead cost 9 points of
        // whitespace and 9 231 moved nodes in the worst commit when tried.
        //
        // "Does it fit after adding k?" is monotone in k, and k = the
        // newcomer's own footprint always fits (that is a wholly free strip),
        // so the minimum is found by binary search in ~log2(k) probes instead
        // of the row-at-a-time scan this used when a file was one cell — which
        // on the phase-2 lattice is thousands of searches over millions of
        // cells.
        const before = `${grid.w}x${grid.h}`;
        const w0 = grid.w;
        const h0 = grid.h;
        const growW = grid.w * cfg.cellAspect < grid.h;
        const resize = (k: number): void =>
          growW ? grid.resize(w0 + k, h0) : grid.resize(w0, h0 + k);
        let lo = 1;
        let hi = growW ? sized.w : sized.h;
        let bestK = hi;
        let best: { x: number; y: number } | null = null;
        while (lo <= hi) {
          const k = (lo + hi) >> 1;
          resize(k);
          const cand = grid.firstFit(sized.w, sized.h);
          if (cand) {
            best = cand;
            bestK = k;
            hi = k - 1;
          } else {
            lo = k + 1;
          }
        }
        resize(bestK);
        region.w = grid.w;
        region.h = grid.h;
        state.events.push({
          kind: 'grow',
          path: dir.path,
          detail: `${before} -> ${grid.w}x${grid.h} (fragmented)`,
        });
        spot = best ?? grid.firstFit(sized.w, sized.h);
        if (!spot) throw new Error(`cannot place ${sized.node.path} in ${dir.path}`);
      }
    }
    const slot: Rect = { x: spot.x, y: spot.y, w: sized.w, h: sized.h };
    region.slots.set(sized.node.name, slot);
    grid.mark(slot, 1);
    if (!wasEmpty) {
      state.events.push({ kind: 'insert', path: sized.node.path, detail: `at ${slot.x},${slot.y}` });
    }
  }

  const usedCells = grid.used();
  let bytes = 0;
  let fileCells = 0;
  for (const s of sizedChildren) {
    bytes += s.bytes;
    if (s.node.kind === 'file') fileCells += s.drawnW * s.drawnH;
  }

  const rawW = region.w + 2 * pad;
  const rawH = region.h + 2 * pad;
  const q = quantumFor(Math.max(rawW, rawH), cfg);
  const footW = ceilTo(rawW, q);
  const footH = ceilTo(rawH, q);

  return {
    node: dir,
    w: footW + cfg.gap,
    h: footH + cfg.gap,
    drawnW: footW,
    drawnH: footH,
    rawW,
    rawH,
    bytes,
    children: sizedChildren,
    freeCells: region.w * region.h - usedCells,
    totalCells: region.w * region.h,
    fileCells,
    directFiles: fileSized.length,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 (top-down): absolute positions.
// ---------------------------------------------------------------------------

export interface RegionStat {
  readonly path: string;
  readonly depth: number;
  /** Free cells inside the region's own grid. */
  readonly free: number;
  readonly total: number;
  /** Cells this region's border gutter costs its parent. */
  readonly borderOverhead: number;
  /** Cells this region's growth reserve (footprint quantum) costs its parent. */
  readonly reserveOverhead: number;
  readonly w: number;
  readonly h: number;
  /** Drawn area of the file tiles directly inside this region, in cells. */
  readonly fileCells: number;
  /** Number of file children directly inside this region. */
  readonly directFiles: number;
}

export interface LayoutResult {
  readonly layout: Layout;
  readonly root: Rect;
  readonly regionStats: RegionStat[];
  readonly events: LayoutEvent[];
  readonly fileCount: number;
}

function emit(
  sized: Sized,
  x: number,
  y: number,
  depth: number,
  state: LayoutState,
  cfg: LayoutConfig,
  layout: Layout,
  stats: RegionStat[],
): void {
  // The footprint carries the gap on its right and bottom edge; the DRAWN
  // rect, which is what the renderer and the metrics see, is the footprint
  // minus that gap. Positions are unaffected.
  const placement: Placement = {
    path: sized.node.path,
    kind: sized.node.kind,
    depth,
    bytes: sized.bytes,
    x, y, w: sized.drawnW, h: sized.drawnH,
    ...(sized.effectiveLines === undefined ? {} : { effectiveLines: sized.effectiveLines }),
    ...(sized.folded ? { folded: true } : {}),
  };
  layout.set(sized.node.path, placement);
  if (sized.node.kind === 'file') return;

  stats.push({
    path: sized.node.path,
    depth,
    free: sized.freeCells ?? 0,
    total: sized.totalCells ?? 0,
    borderOverhead:
      (sized.rawW ?? sized.drawnW) * (sized.rawH ?? sized.drawnH) - (sized.totalCells ?? 0),
    reserveOverhead:
      sized.drawnW * sized.drawnH - (sized.rawW ?? sized.drawnW) * (sized.rawH ?? sized.drawnH),
    w: sized.drawnW,
    h: sized.drawnH,
    fileCells: sized.fileCells ?? 0,
    directFiles: sized.directFiles ?? 0,
  });

  const region = state.region(sized.node.path);
  const pad = padAt(depth, cfg);
  const ox = x + pad;
  const oy = y + pad;
  for (const child of sized.children ?? []) {
    const slot = region.slots.get(child.node.name);
    if (!slot) continue;
    emit(child, ox + slot.x, oy + slot.y, depth + 1, state, cfg, layout, stats);
  }
}

export function layoutTree(
  root: DirNode,
  state: LayoutState,
  order: OrderFn,
  cfg: LayoutConfig = DEFAULT_CONFIG,
): LayoutResult {
  state.events = [];
  const sized = place(root, state, order, cfg, 0);
  const layout: Layout = new Map();
  const stats: RegionStat[] = [];
  emit(sized, 0, 0, 0, state, cfg, layout, stats);
  let fileCount = 0;
  for (const p of layout.values()) if (p.kind === 'file') fileCount++;
  return {
    layout,
    root: { x: 0, y: 0, w: sized.drawnW, h: sized.drawnH },
    regionStats: stats,
    events: state.events,
    fileCount,
  };
}
