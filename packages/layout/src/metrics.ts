// Stability metrics.
//
// Vernier, Sondag, Comba, Speckmann, Telea (CGF 2020) define instability as
// movement in EXCESS of what the data change forced:
//
//     sigma(R) = max(0, delta(R, R') - delta(R, R*))
//
// delta is corner travel and R* is a baseline layout with the minimum mandated
// movement. Our baseline: the node keeps its old top-left corner and takes on
// its new footprint. For a file that is R* == R (a file is always 1x1, so any
// file movement is pure instability). For a directory region that grew, R*
// absorbs the growth the change forced and only the rest counts.
//
// All distances are in cells. One cell is one file's footprint.

import type { Layout, Rect } from './types.ts';

function corners(r: Rect): [number, number][] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];
}

/** Mean Euclidean travel of the four corners, in cells. */
export function cornerTravel(a: Rect, b: Rect): number {
  const ca = corners(a);
  const cb = corners(b);
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const dx = cb[i]![0] - ca[i]![0];
    const dy = cb[i]![1] - ca[i]![1];
    sum += Math.hypot(dx, dy);
  }
  return sum / 4;
}

export interface CommitMetrics {
  readonly index: number;
  readonly sha: string;
  readonly date: string;
  readonly files: number;
  readonly dirs: number;
  readonly rootW: number;
  readonly rootH: number;
  readonly rootAspect: number;
  /** 1 - (drawn file tile area / root area). */
  readonly whitespace: number;
  /** Share of the map that is the 20 %-of-tile-width gap around footprints. */
  readonly gapFrac: number;
  /** Files whose effective lines exceeded the fold cap. */
  readonly foldedFiles: number;
  /** File-footprint coverage of districts with more than eight files. */
  readonly coverageMedian: number;
  readonly coverageMean: number;
  /** How many of those districts reach the 35 % target. */
  readonly coverageAtTarget: number;
  readonly coverageDistricts: number;
  /** Share of the map that is region slack (free cells inside a grid). */
  readonly slackFrac: number;
  /** Share of the map that is region border gutter. */
  readonly gutterFrac: number;
  /** Share of the map that is growth reserve (footprint quantum). */
  readonly reserveFrac: number;
  readonly meanRegionFree: number;
  readonly meanAspect: number;
  readonly worstAspect: number;
  readonly worstAspectPath: string;
  readonly added: number;
  readonly removed: number;
  /** Nodes present in both layouts whose rect changed at all. */
  readonly moved: number;
  /** Of those, how many are outside every changed path's subtree/ancestry. */
  readonly movedOutsideChange: number;
  readonly meanInstability: number;
  readonly medianInstability: number;
  readonly p95Instability: number;
  readonly maxInstability: number;
  readonly maxInstabilityPath: string;
  readonly growEvents: number;
  readonly relocateEvents: number;
  readonly changedFiles: number;
  readonly ms: number;
}

export interface InstabilitySample {
  readonly path: string;
  readonly sigma: number;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * A node is "inside the change" if it is a changed file, an ancestor of one,
 * or a descendant of a directory that directly contains one. Everything else
 * must not move at all: that is the PLAN.md promise ("A file added to one
 * directory moves nothing outside that directory's slack").
 */
export function insideChange(changedPaths: string[]): (path: string) => boolean {
  const ancestors = new Set<string>();
  const touchedDirs: string[] = [];
  for (const p of changedPaths) {
    const segs = p.split('/');
    for (let i = 0; i < segs.length; i++) ancestors.add(segs.slice(0, i + 1).join('/'));
    const dir = segs.slice(0, -1).join('/');
    touchedDirs.push(dir);
  }
  const dirSet = new Set(touchedDirs);
  return (path: string): boolean => {
    if (path === '' || ancestors.has(path)) return true;
    for (const d of dirSet) {
      if (d === '' || path === d || path.startsWith(`${d}/`)) return true;
    }
    return false;
  };
}

export interface Diff {
  readonly samples: InstabilitySample[];
  readonly moved: number;
  readonly movedOutside: number;
  readonly movedOutsidePaths: string[];
  readonly added: number;
  readonly removed: number;
}

export function compareLayouts(
  prev: Layout,
  next: Layout,
  isInside: (path: string) => boolean,
): Diff {
  const samples: InstabilitySample[] = [];
  let moved = 0;
  let movedOutside = 0;
  const movedOutsidePaths: string[] = [];
  let added = 0;

  for (const [path, b] of next) {
    const a = prev.get(path);
    if (!a) {
      added++;
      continue;
    }
    const changed = a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
    if (!changed) continue;
    // Baseline: same top-left, new footprint.
    const baseline: Rect = { x: a.x, y: a.y, w: b.w, h: b.h };
    const sigma = Math.max(0, cornerTravel(a, b) - cornerTravel(a, baseline));
    if (a.x !== b.x || a.y !== b.y) {
      moved++;
      if (!isInside(path)) {
        movedOutside++;
        if (movedOutsidePaths.length < 12) movedOutsidePaths.push(path);
      }
    }
    if (sigma > 0) samples.push({ path, sigma });
  }

  let removed = 0;
  for (const path of prev.keys()) if (!next.has(path)) removed++;

  return { samples, moved, movedOutside, movedOutsidePaths, added, removed };
}
