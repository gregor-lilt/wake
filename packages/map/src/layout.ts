/**
 * Spike layout: a deterministic, grid-quantized, hierarchical treemap with
 * slack. Not the final stable algorithm from PLAN.md (no frozen coupling
 * order, no greedy insertion into free space), but it has the two properties
 * the renderer spike needs: it is hierarchical and it is deterministic, and it
 * leaves deliberate whitespace so the road network has room.
 *
 * Levels: world -> region (depth 1) -> sub-region (depth 2..4) -> city grid.
 * Coordinates are snapped to a grid, then every child is inset by a
 * depth-dependent padding so the snapping error is absorbed and borders read
 * as borders.
 */
import type { Repo } from './repo';
import { CELL_WORLD, TILE_CELLS_W, tileCellsH, STUB_LINES } from './lattice';
import { STUB_ALPHA } from './schematic';

export interface Rect { x: number; y: number; w: number; h: number }

/** Binary polygon soup, ready for SolidPolygonLayer with _normalize: false. */
export interface PolySoup {
  count: number;
  positions: Float32Array;
  startIndices: Uint32Array;
  colors: Uint8Array;
}

export interface Layout {
  world: Rect;
  /** 4 floats (x, y, w, h) per directory, indexed by dir id. */
  dirRect: Float32Array;
  dirCentroid: Float32Array;
  /** 4 floats per file. */
  cityRect: Float32Array;
  cityCentroid: Float32Array;
  cities: PolySoup;
  buildings: PolySoup;
  /** fraction of region area covered by city footprints */
  fillRatio: number;
  /**
   * Median coverage of a district's own rect by the file tiles in it, over the
   * districts with more than eight files: the local density target
   * docs/design.md section 4 sets (at least 35%).
   */
  districtCoverage: number;
}

/**
 * The world is measured in lattice cells (20 glyphs by 10 lines, see
 * lattice.ts) on both paths now, so a file tile is 5 cells wide and a whole
 * number of 40-line steps tall here exactly as it is in a real export.
 */
const CELL = CELL_WORLD;
const TARGET_FILL = 0.35;
/** Footprint of one file tile in cells, gap on the right and bottom included. */
const TILE_FOOT_W = TILE_CELLS_W + 1;
const footH = (lines: number): number => tileCellsH(lines) + 1;
/** A column is never asked to be shorter than one folded page. */
const FOLD_LINES = 400;
const GRID = 4; // world-unit quantum for region and sub-region rectangles
const PAD = [0, 72, 44, 28, 18]; // inset by depth, scaled with the world size

const snap = (v: number, q: number) => Math.round(v / q) * q;

/** Normalised code size, log scaled so the long tail is actually visible. */
export function sizeNorm(loc: number): number {
  const t = Math.log(Math.max(loc, 8) / 8) / Math.log(3000 / 8);
  return Math.max(0, Math.min(1, t));
}

/** World units per layout cell, used by the real-export path. */
export const CELL_UNITS = CELL;

/** World side in world units for a total tile footprint given in cells. */
export function worldSide(footprintCells: number): number {
  const raw = Math.sqrt(footprintCells / TARGET_FILL) * CELL;
  return Math.max(2048, Math.round(raw / 512) * 512);
}

interface Item { id: number; area: number }

/** Classic squarified treemap (Bruls, Huizing, van Wijk 2000). */
function squarify(rect: Rect, items: Item[], out: (id: number, r: Rect) => void): void {
  let { x, y, w, h } = rect;
  let i = 0;
  let row: Item[] = [];
  const worst = (extra: Item | null): number => {
    let s = 0;
    let mn = Infinity;
    let mx = 0;
    for (const it of row) { s += it.area; mn = Math.min(mn, it.area); mx = Math.max(mx, it.area); }
    if (extra) { s += extra.area; mn = Math.min(mn, extra.area); mx = Math.max(mx, extra.area); }
    if (s <= 0 || mn <= 0) return Infinity;
    const side = Math.min(w, h);
    const s2 = s * s;
    const d2 = side * side;
    return Math.max((d2 * mx) / s2, s2 / (d2 * mn));
  };
  const flush = (): void => {
    if (row.length === 0) return;
    let s = 0;
    for (const it of row) s += it.area;
    if (w <= h) {
      const t = Math.min(h, s / Math.max(w, 1e-6));
      let cx = x;
      for (const it of row) {
        const iw = (it.area / s) * w;
        out(it.id, { x: cx, y, w: iw, h: t });
        cx += iw;
      }
      y += t;
      h -= t;
    } else {
      const t = Math.min(w, s / Math.max(h, 1e-6));
      let cy = y;
      for (const it of row) {
        const ih = (it.area / s) * h;
        out(it.id, { x, y: cy, w: t, h: ih });
        cy += ih;
      }
      x += t;
      w -= t;
    }
    row = [];
  };
  while (i < items.length) {
    const it = items[i];
    if (row.length === 0 || worst(it) <= worst(null)) {
      row.push(it);
      i++;
    } else {
      flush();
    }
  }
  flush();
}

function inset(r: Rect, p: number): Rect {
  const w = Math.max(GRID, r.w - 2 * p);
  const h = Math.max(GRID, r.h - 2 * p);
  return { x: snap(r.x + (r.w - w) / 2, GRID), y: snap(r.y + (r.h - h) / 2, GRID), w: snap(w, GRID), h: snap(h, GRID) };
}

export type CityColor = (region: number, sizeT: number) => [number, number, number];
export type BuildingColor = (kind: number, region: number) => [number, number, number];

export function layoutRepo(repo: Repo, cityColor: CityColor, buildingColor: BuildingColor): Layout {
  const { dirs } = repo;
  const dirRect = new Float32Array(dirs.length * 4);
  // Weight is the tile footprint in cells, not the file count: a district of
  // long files needs more room than one of the same number of stubs.
  const ownFoot = new Float64Array(dirs.length);
  const subtreeFoot = new Float64Array(dirs.length);
  for (let f = 0; f < repo.fileCount; f++) {
    ownFoot[repo.fileDir[f]] += TILE_FOOT_W * footH(repo.fileLines[f]);
  }
  for (const d of [...dirs].sort((a, b) => b.depth - a.depth)) {
    subtreeFoot[d.id] += ownFoot[d.id];
    if (d.parent >= 0) subtreeFoot[d.parent] += subtreeFoot[d.id];
  }
  let totalFoot = 0;
  for (const id of repo.regions) totalFoot += subtreeFoot[id];
  const side = worldSide(totalFoot);
  const padScale = side / 16384;
  const world: Rect = { x: 0, y: 0, w: side, h: side };

  const setRect = (id: number, r: Rect): void => {
    dirRect[id * 4] = r.x;
    dirRect[id * 4 + 1] = r.y;
    dirRect[id * 4 + 2] = r.w;
    dirRect[id * 4 + 3] = r.h;
  };

  // Where a directory's own files live when it also has sub-directories.
  const ownBox = new Map<number, Rect>();
  const rescale = (items: Item[], targetArea: number): Item[] => {
    const s = items.reduce((a, b) => a + b.area, 0) || 1;
    return items.map((it) => ({ id: it.id, area: (it.area / s) * targetArea }));
  };

  const weightOf = (id: number) => Math.max(1, subtreeFoot[id]);

  const subdivide = (id: number, slot: Rect): void => {
    const d = dirs[id];
    const box = inset(slot, PAD[Math.min(d.depth, 4)] * padScale);
    setRect(id, box);
    if (d.children.length === 0) return;
    const childItems: Item[] = d.children.map((c) => ({ id: c, area: weightOf(c) }));
    const ownWeight = ownFoot[d.id];
    const total = childItems.reduce((a, b) => a + b.area, 0) + ownWeight;
    const boxArea = box.w * box.h;
    const items: Item[] = childItems
      .map((it) => ({ id: it.id, area: (it.area / total) * boxArea }))
      .sort((a, b) => b.area - a.area || (dirs[a.id].name < dirs[b.id].name ? -1 : 1));
    if (ownWeight === 0) {
      squarify(box, items, (cid, r) => subdivide(cid, r));
      return;
    }
    // Reserve a strip along the longer edge for this directory's own files.
    const share = ownWeight / total;
    if (box.w >= box.h) {
      const cut = Math.min(Math.max(snap(box.w * share, GRID), GRID * 3), box.w - GRID * 4);
      ownBox.set(id, { x: box.x, y: box.y, w: cut, h: box.h });
      const rest: Rect = { x: box.x + cut, y: box.y, w: box.w - cut, h: box.h };
      squarify(rest, rescale(items, rest.w * rest.h), (cid, r) => subdivide(cid, r));
    } else {
      const cut = Math.min(Math.max(snap(box.h * share, GRID), GRID * 3), box.h - GRID * 4);
      ownBox.set(id, { x: box.x, y: box.y, w: box.w, h: cut });
      const rest: Rect = { x: box.x, y: box.y + cut, w: box.w, h: box.h - cut };
      squarify(rest, rescale(items, rest.w * rest.h), (cid, r) => subdivide(cid, r));
    }
  };

  // Regions across the world rect.
  const regionItems: Item[] = repo.regions
    .map((id) => ({ id, area: weightOf(id) }))
    .sort((a, b) => b.area - a.area || (dirs[a.id].name < dirs[b.id].name ? -1 : 1));
  const worldArea = world.w * world.h;
  const rSum = regionItems.reduce((a, b) => a + b.area, 0);
  squarify(world, regionItems.map((it) => ({ id: it.id, area: (it.area / rSum) * worldArea })), (id, r) => subdivide(id, r));

  const cityRect = new Float32Array(repo.fileCount * 4);
  // Files pack into columns on the lattice, in frozen sibling order, exactly
  // as the real layout does: every tile is TILE_CELLS_W cells wide, its height
  // is one 40-line step per 4 cells, and every footprint carries its gap on
  // the right and bottom edge, so the slack sits at the bottom of a column and
  // never between two tiles.
  for (const d of dirs) {
    if (d.files.length === 0) continue;
    const box = d.children.length === 0
      ? { x: dirRect[d.id * 4], y: dirRect[d.id * 4 + 1], w: dirRect[d.id * 4 + 2], h: dirRect[d.id * 4 + 3] }
      : ownBox.get(d.id)!;
    const inner = inset(box, PAD[4] * 0.5 * padScale);
    const cellsW = Math.max(TILE_FOOT_W, Math.floor(inner.w / CELL));
    const cellsH = Math.max(footH(1), Math.floor(inner.h / CELL));
    const maxCols = Math.max(1, Math.floor(cellsW / TILE_FOOT_W));
    let totalH = 0;
    for (const f of d.files) totalH += footH(repo.fileLines[f]);
    const cols = Math.max(1, Math.min(maxCols, Math.ceil(totalH / cellsH)));
    const target = Math.max(footH(FOLD_LINES), Math.ceil(totalH / cols));
    const topY = inner.y + cellsH * CELL;
    let col = 0;
    let used = 0;
    for (const f of d.files) {
      const th = tileCellsH(repo.fileLines[f]);
      if (used > 0 && used + th + 1 > target && col + 1 < maxCols) {
        col++;
        used = 0;
      }
      cityRect[f * 4] = inner.x + col * TILE_FOOT_W * CELL;
      cityRect[f * 4 + 1] = topY - (used + th) * CELL;
      cityRect[f * 4 + 2] = TILE_CELLS_W * CELL;
      cityRect[f * 4 + 3] = th * CELL;
      used += th + 1;
    }
  }
  return finishLayout(repo, world, dirRect, cityRect, cityColor, buildingColor);
}

/**
 * Shared tail of both layout paths: city and building quad soups, centroids and
 * the coverage ratio. `dirRect` and `cityRect` are already in world units, so
 * this works for the synthetic treemap and for a real repository export alike.
 */
export function finishLayout(
  repo: Repo,
  world: Rect,
  dirRect: Float32Array,
  cityRect: Float32Array,
  cityColor: CityColor,
  buildingColor: BuildingColor
): Layout {
  // Capacity, not count: the arrays carry headroom so a file created during a
  // live session lands in a free slot (src/grow.ts). Everything below is
  // written for the first `fileCount` slots and drawn for exactly that many.
  const dirCap = Math.max(repo.dirs.length, repo.dirCapacity ?? 0, dirRect.length >> 2);
  const fileCap = Math.max(repo.fileCount, repo.fileCapacity ?? 0);
  const symCap = Math.max(repo.symCount, repo.symCapacity ?? 0);
  const dirCentroid = new Float32Array(dirCap * 2);
  for (let i = 0; i < repo.dirs.length; i++) {
    dirCentroid[i * 2] = dirRect[i * 4] + dirRect[i * 4 + 2] / 2;
    dirCentroid[i * 2 + 1] = dirRect[i * 4 + 1] + dirRect[i * 4 + 3] / 2;
  }
  const n = repo.fileCount;
  const cityCentroid = new Float32Array(fileCap * 2);
  const cityPos = new Float32Array(fileCap * 8);
  const cityStart = new Uint32Array(fileCap + 1);
  const cityCol = new Uint8Array(fileCap * 16);
  let cityArea = 0;
  // Pack the city quads in file order so the binary buffers stay contiguous.
  for (let f = 0; f < n; f++) {
    const x = cityRect[f * 4];
    const y = cityRect[f * 4 + 1];
    const w = cityRect[f * 4 + 2];
    const h = cityRect[f * 4 + 3];
    const o = f * 8;
    cityPos[o] = x; cityPos[o + 1] = y;
    cityPos[o + 2] = x + w; cityPos[o + 3] = y;
    cityPos[o + 4] = x + w; cityPos[o + 5] = y + h;
    cityPos[o + 6] = x; cityPos[o + 7] = y + h;
    cityCentroid[f * 2] = x + w / 2;
    cityCentroid[f * 2 + 1] = y + h / 2;
    cityArea += w * h;
    const [r, g, b] = cityColor(repo.fileRegion[f], sizeNorm(repo.fileSize[f]));
    // Stubs are dimmed at every band below reading (docs/design.md section 4):
    // a directory full of empty __init__.py files stops shouting.
    const a = repo.fileLines[f] < STUB_LINES ? Math.round(255 * STUB_ALPHA) : 255;
    for (let v = 0; v < 4; v++) {
      const c = f * 16 + v * 4;
      cityCol[c] = r; cityCol[c + 1] = g; cityCol[c + 2] = b; cityCol[c + 3] = a;
    }
  }
  // Every slot's start index, free ones included: an append then only has to
  // write its quad and raise the count.
  for (let f = 0; f <= fileCap; f++) cityStart[f] = f * 4;

  // ---- buildings ----------------------------------------------------------
  const bCount = repo.symCount;
  const bPos = new Float32Array(symCap * 8);
  const bStart = new Uint32Array(symCap + 1);
  const bCol = new Uint8Array(symCap * 16);
  for (let f = 0; f < n; f++) {
    const s0 = repo.fileSymStart[f];
    const s1 = repo.fileSymStart[f + 1];
    const k = s1 - s0;
    if (k <= 0) continue;
    const x = cityRect[f * 4];
    const y = cityRect[f * 4 + 1];
    const tw = cityRect[f * 4 + 2];
    const th = cityRect[f * 4 + 3];
    // Symbols are laid out inside the tile, which is no longer square.
    const cols = Math.max(1, Math.round(Math.sqrt((k * tw) / Math.max(th, 1e-6))));
    const rows = Math.ceil(k / cols);
    const bw = tw / cols;
    const bh = th / rows;
    const fw = bw * 0.62;
    const fh = bh * 0.62;
    const region = repo.fileRegion[f];
    for (let i = 0; i < k; i++) {
      const s = s0 + i;
      const bx = x + (i % cols) * bw + (bw - fw) / 2;
      const by = y + Math.floor(i / cols) * bh + (bh - fh) / 2;
      const o = s * 8;
      bPos[o] = bx; bPos[o + 1] = by;
      bPos[o + 2] = bx + fw; bPos[o + 3] = by;
      bPos[o + 4] = bx + fw; bPos[o + 5] = by + fh;
      bPos[o + 6] = bx; bPos[o + 7] = by + fh;
      const [r, g, b] = buildingColor(repo.symKind[s], region);
      for (let v = 0; v < 4; v++) {
        const c = s * 16 + v * 4;
        bCol[c] = r; bCol[c + 1] = g; bCol[c + 2] = b; bCol[c + 3] = 255;
      }
    }
  }
  for (let s = 0; s <= symCap; s++) bStart[s] = s * 4;

  let regionArea = 0;
  for (const id of repo.regions) regionArea += dirRect[id * 4 + 2] * dirRect[id * 4 + 3];

  const cov: number[] = [];
  for (const d of repo.dirs) {
    if (d.files.length <= 8) continue;
    const area = dirRect[d.id * 4 + 2] * dirRect[d.id * 4 + 3];
    if (area <= 0) continue;
    let tiles = 0;
    for (const f of d.files) tiles += cityRect[f * 4 + 2] * cityRect[f * 4 + 3];
    cov.push(tiles / area);
  }
  cov.sort((a, b) => a - b);

  return {
    world,
    dirRect,
    dirCentroid,
    cityRect,
    cityCentroid,
    cities: { count: n, positions: cityPos, startIndices: cityStart, colors: cityCol },
    buildings: { count: bCount, positions: bPos, startIndices: bStart, colors: bCol },
    fillRatio: cityArea / Math.max(regionArea, 1),
    districtCoverage: cov.length > 0 ? cov[Math.floor(cov.length / 2)] : 0
  };
}

/**
 * Move one file's tile after a live `node` delta, rewriting exactly the slices
 * of the baked soups that belong to it: the quad, the centroid and the symbol
 * boxes inside it. The same arithmetic finishLayout does, for one file.
 */
export function moveFileRect(
  repo: Repo,
  layout: Layout,
  f: number,
  x: number,
  y: number,
  w: number,
  h: number,
  cityColor: CityColor,
  buildingColor: BuildingColor
): void {
  layout.cityRect[f * 4] = x;
  layout.cityRect[f * 4 + 1] = y;
  layout.cityRect[f * 4 + 2] = w;
  layout.cityRect[f * 4 + 3] = h;
  const pos = layout.cities.positions;
  const o = f * 8;
  pos[o] = x; pos[o + 1] = y;
  pos[o + 2] = x + w; pos[o + 3] = y;
  pos[o + 4] = x + w; pos[o + 5] = y + h;
  pos[o + 6] = x; pos[o + 7] = y + h;
  layout.cityCentroid[f * 2] = x + w / 2;
  layout.cityCentroid[f * 2 + 1] = y + h / 2;
  const [cr, cg, cb] = cityColor(repo.fileRegion[f], sizeNorm(repo.fileSize[f]));
  const a = repo.fileLines[f] < STUB_LINES ? Math.round(255 * STUB_ALPHA) : 255;
  const cc = layout.cities.colors;
  for (let v = 0; v < 4; v++) {
    const c = f * 16 + v * 4;
    cc[c] = cr; cc[c + 1] = cg; cc[c + 2] = cb; cc[c + 3] = a;
  }

  const s0 = repo.fileSymStart[f];
  const s1 = repo.fileSymStart[f + 1];
  const k = s1 - s0;
  if (k <= 0) return;
  const cols = Math.max(1, Math.round(Math.sqrt((k * w) / Math.max(h, 1e-6))));
  const bw = w / cols;
  const bh = h / Math.ceil(k / cols);
  const fw = bw * 0.62;
  const fh = bh * 0.62;
  const region = repo.fileRegion[f];
  const bPos = layout.buildings.positions;
  const bCol = layout.buildings.colors;
  for (let i = 0; i < k; i++) {
    const s = s0 + i;
    const bx = x + (i % cols) * bw + (bw - fw) / 2;
    const by = y + Math.floor(i / cols) * bh + (bh - fh) / 2;
    const p = s * 8;
    bPos[p] = bx; bPos[p + 1] = by;
    bPos[p + 2] = bx + fw; bPos[p + 3] = by;
    bPos[p + 4] = bx + fw; bPos[p + 5] = by + fh;
    bPos[p + 6] = bx; bPos[p + 7] = by + fh;
    const [r, g, b] = buildingColor(repo.symKind[s], region);
    for (let v = 0; v < 4; v++) {
      const c = s * 16 + v * 4;
      bCol[c] = r; bCol[c + 1] = g; bCol[c + 2] = b; bCol[c + 3] = 255;
    }
  }
}

/** Move one district after a live `node` delta of kind "dir". */
export function moveDirRect(layout: Layout, id: number, x: number, y: number, w: number, h: number): void {
  layout.dirRect[id * 4] = x;
  layout.dirRect[id * 4 + 1] = y;
  layout.dirRect[id * 4 + 2] = w;
  layout.dirRect[id * 4 + 3] = h;
  layout.dirCentroid[id * 2] = x + w / 2;
  layout.dirCentroid[id * 2 + 1] = y + h / 2;
}
