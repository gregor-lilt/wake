/**
 * Road network. Edges are drawn on top of the geography and never move a city.
 *
 * Routing is Holten-style hierarchical bundling: the control polygon of each
 * road is the chain of directory centroids from the source file up the tree and
 * back down to the target file, so dependencies that share ancestors share a
 * corridor. A beta parameter blends the bundled polygon back toward the
 * straight line, which is what stops every region centroid from turning into a
 * starburst. The polygon is then sampled as a uniform cubic B-spline with
 * tripled endpoints, so the road starts and ends exactly on its two cities.
 *
 * Three classes, from docs/design.md section 6:
 *
 *   local     both endpoints in ONE directory, bundled to it,      1 px
 *   arterial  same region, different directories, bundled to their 1.5 px
 *             lowest common ancestor,
 *   motorway  cross-region. The chain stops at each region         3 px
 *             centroid rather than at a global root, so five
 *             regions give ten corridors instead of one hub.
 *
 * Since the review of the labels phase the whole network is OFF by default:
 * it is a focus tool, not a base layer. `incidentRoads` builds the handful of
 * roads touching the hovered or focused file, at full contrast in these
 * widths; the static soups below are only built for the "show all roads"
 * toggle.
 */
import type { Repo } from './repo';
import type { Layout } from './layout';
import type { RGB } from './theme';

export interface PathSoup {
  count: number;
  positions: Float32Array;
  startIndices: Uint32Array;
  widths: Float32Array;
  colors: Uint8Array;
  vertices: number;
}

export interface Roads { local: PathSoup; trunk: PathSoup; minor: PathSoup; trunkWeight: number }

/** Road class of one import edge (docs/design.md section 6). */
export type RoadClass = 'local' | 'arterial' | 'motorway';

/** Reference-zoom width in pixels, one per class. */
export const CLASS_WIDTH: Record<RoadClass, number> = { local: 1, arterial: 1.5, motorway: 3 };

/** The class of an edge: same directory, same region, or across regions. */
export function classOf(repo: Repo, e: number): RoadClass {
  const a = repo.edgeSrc[e];
  const b = repo.edgeDst[e];
  if (repo.fileRegion[a] !== repo.fileRegion[b]) return 'motorway';
  return repo.fileDir[a] === repo.fileDir[b] ? 'local' : 'arterial';
}

/**
 * Edges touching each file, as a CSR pair (`start[f]` .. `start[f + 1]` index
 * into `edge`). Built once: hovering a tile then costs a slice, not a scan
 * over every edge in the repository.
 */
export interface Incidence { start: Uint32Array; edge: Uint32Array }

export function buildIncidence(repo: Repo): Incidence {
  const n = repo.fileCount;
  const start = new Uint32Array(n + 1);
  for (let e = 0; e < repo.edgeCount; e++) {
    start[repo.edgeSrc[e] + 1]++;
    start[repo.edgeDst[e] + 1]++;
  }
  for (let f = 0; f < n; f++) start[f + 1] += start[f];
  const edge = new Uint32Array(start[n]);
  const cursor = Uint32Array.from(start.subarray(0, n));
  for (let e = 0; e < repo.edgeCount; e++) {
    edge[cursor[repo.edgeSrc[e]]++] = e;
    edge[cursor[repo.edgeDst[e]]++] = e;
  }
  return { start, edge };
}

/** One drawn road: its path, class width and colour. */
export interface FocusRoad {
  edge: number;
  cls: RoadClass;
  path: Array<[number, number]>;
  width: number;
  color: RGB;
}

/**
 * The roads incident to one file, at full contrast in their class widths. This
 * is the default road layer: hover or focus a file and its own roads appear,
 * everything else stays hidden (docs/design.md section 6).
 */
export function incidentRoads(
  repo: Repo,
  layout: Layout,
  inc: Incidence,
  file: number,
  colors: { local: RGB; motorway: RGB }
): FocusRoad[] {
  if (file < 0 || file >= repo.fileCount) return [];
  const out: FocusRoad[] = [];
  const seen = new Set<number>();
  for (let i = inc.start[file]; i < inc.start[file + 1]; i++) {
    const e = inc.edge[i];
    if (seen.has(e)) continue;
    seen.add(e);
    const cls = classOf(repo, e);
    out.push({
      edge: e,
      cls,
      path: routePath(repo, layout, repo.edgeSrc[e], repo.edgeDst[e]),
      width: CLASS_WIDTH[cls],
      color: cls === 'motorway' ? colors.motorway : colors.local
    });
  }
  return out;
}

const LOCAL_POINTS = 10;
const MOTORWAY_POINTS = 26;
const BETA_LOCAL = 0.55;
const BETA_CROSS = 0.8;
/**
 * How many cross-region roads stay visible at continent zoom. Deriving the
 * weight threshold from a target count rather than a constant keeps the
 * continent view legible whether the graph has 3000 cross-region edges or 200.
 */
const TRUNK_TARGET = 150;

export function lca(repo: Repo, a: number, b: number): number {
  let x = a;
  let y = b;
  while (repo.dirs[x].depth > repo.dirs[y].depth) x = repo.dirs[x].parent;
  while (repo.dirs[y].depth > repo.dirs[x].depth) y = repo.dirs[y].parent;
  while (x !== y) {
    x = repo.dirs[x].parent;
    y = repo.dirs[y].parent;
    if (x < 0 || y < 0) return repo.regions[repo.dirs[a].region];
  }
  return x;
}

/** Chain of directory ids from `dir` up to `stop`, inclusive. */
function chainUp(repo: Repo, dir: number, stop: number): number[] {
  const out: number[] = [];
  let d = dir;
  for (let guard = 0; guard < 8; guard++) {
    out.push(d);
    if (d === stop || repo.dirs[d].parent < 0) break;
    d = repo.dirs[d].parent;
  }
  return out;
}

/**
 * Control polygon of one road: source city, the directory centroids up to the
 * bundling root and back down, then the target city, beta-blended toward the
 * straight line.
 */
function controlPolygon(repo: Repo, layout: Layout, a: number, b: number, cross: boolean, cx: number[], cy: number[]): void {
  const ax = layout.cityCentroid[a * 2];
  const ay = layout.cityCentroid[a * 2 + 1];
  const bx = layout.cityCentroid[b * 2];
  const by = layout.cityCentroid[b * 2 + 1];
  cx.length = 0;
  cy.length = 0;
  cx.push(ax);
  cy.push(ay);
  let up: number[];
  let down: number[];
  if (cross) {
    up = chainUp(repo, repo.fileDir[a], repo.regions[repo.fileRegion[a]]);
    down = chainUp(repo, repo.fileDir[b], repo.regions[repo.fileRegion[b]]);
  } else {
    const l = lca(repo, repo.fileDir[a], repo.fileDir[b]);
    up = chainUp(repo, repo.fileDir[a], l);
    down = chainUp(repo, repo.fileDir[b], l);
    down.pop(); // the LCA is already the last element of `up`
  }
  for (const d of up) { cx.push(layout.dirCentroid[d * 2]); cy.push(layout.dirCentroid[d * 2 + 1]); }
  for (let k = down.length - 1; k >= 0; k--) {
    cx.push(layout.dirCentroid[down[k] * 2]);
    cy.push(layout.dirCentroid[down[k] * 2 + 1]);
  }
  cx.push(bx);
  cy.push(by);
  const beta = cross ? BETA_CROSS : BETA_LOCAL;
  const m = cx.length - 1;
  for (let k = 1; k < m; k++) {
    const s = k / m;
    cx[k] = beta * cx[k] + (1 - beta) * (ax + s * (bx - ax));
    cy[k] = beta * cy[k] + (1 - beta) * (ay + s * (by - ay));
  }
}

/**
 * One road as an array of [x, y] pairs, for the autopilot trip overlay. Same
 * routing as the static network, so a trip rides exactly on its road when the
 * dependency exists and looks like a road when it does not.
 */
export function routePath(repo: Repo, layout: Layout, a: number, b: number): Array<[number, number]> {
  const cross = repo.fileRegion[a] !== repo.fileRegion[b];
  const cx: number[] = [];
  const cy: number[] = [];
  controlPolygon(repo, layout, a, b, cross, cx, cy);
  const points = cross ? MOTORWAY_POINTS : LOCAL_POINTS;
  const flat = new Float32Array(points * 2);
  sampleSpline(cx, cy, flat, 0, points);
  const out: Array<[number, number]> = new Array(points);
  for (let k = 0; k < points; k++) out[k] = [flat[k * 2], flat[k * 2 + 1]];
  return out;
}

/** Uniform cubic B-spline through a control polygon, endpoints tripled. */
function sampleSpline(cx: number[], cy: number[], out: Float32Array, at: number, points: number): void {
  const px = [cx[0], cx[0], ...cx, cx[cx.length - 1], cx[cx.length - 1]];
  const py = [cy[0], cy[0], ...cy, cy[cy.length - 1], cy[cy.length - 1]];
  const spans = px.length - 3;
  for (let k = 0; k < points; k++) {
    const u = (k / (points - 1)) * spans;
    const span = Math.min(Math.floor(u), spans - 1);
    const t = u - span;
    const t2 = t * t;
    const t3 = t2 * t;
    const b0 = (1 - 3 * t + 3 * t2 - t3) / 6;
    const b1 = (4 - 6 * t2 + 3 * t3) / 6;
    const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
    const b3 = t3 / 6;
    const o = (at + k) * 2;
    out[o] = b0 * px[span] + b1 * px[span + 1] + b2 * px[span + 2] + b3 * px[span + 3];
    out[o + 1] = b0 * py[span] + b1 * py[span + 1] + b2 * py[span + 2] + b3 * py[span + 3];
  }
}

export function buildRoads(repo: Repo, layout: Layout, colors: { local: RGB; motorway: RGB }): Roads {
  const idxLocal: number[] = [];
  const cross: number[] = [];
  for (let e = 0; e < repo.edgeCount; e++) (repo.edgeCross[e] ? cross : idxLocal).push(e);
  const sortedWeights = cross.map((e) => repo.edgeWeight[e]).sort((a, b) => b - a);
  const trunkWeight = sortedWeights.length === 0
    ? Infinity
    : sortedWeights[Math.min(TRUNK_TARGET, sortedWeights.length) - 1];
  const idxTrunk: number[] = [];
  const idxMinor: number[] = [];
  for (const e of cross) (repo.edgeWeight[e] >= trunkWeight ? idxTrunk : idxMinor).push(e);

  const build = (ids: number[], points: number, color: RGB, motorway: boolean): PathSoup => {
    const count = ids.length;
    const positions = new Float32Array(count * points * 2);
    const widths = new Float32Array(count * points);
    const cols = new Uint8Array(count * points * 4);
    const startIndices = new Uint32Array(count + 1);
    const cx: number[] = [];
    const cy: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = ids[i];
      const a = repo.edgeSrc[e];
      const b = repo.edgeDst[e];
      startIndices[i] = i * points;
      controlPolygon(repo, layout, a, b, motorway, cx, cy);
      sampleSpline(cx, cy, positions, i * points, points);

      const w = repo.edgeWeight[e];
      // The class caps the width (docs/design.md section 6): 1 px local,
      // 1.5 px arterial, 3 px motorway, reached by the heaviest edges.
      const capPx = motorway ? CLASS_WIDTH.motorway : classOf(repo, e) === 'local'
        ? CLASS_WIDTH.local
        : CLASS_WIDTH.arterial;
      const px = Math.min(capPx, 0.35 * capPx + 0.35 * capPx * Math.log2(1 + w));
      for (let k = 0; k < points; k++) {
        const v = i * points + k;
        widths[v] = px;
        cols[v * 4] = color[0];
        cols[v * 4 + 1] = color[1];
        cols[v * 4 + 2] = color[2];
        cols[v * 4 + 3] = motorway ? 58 : 62;
      }
    }
    startIndices[count] = count * points;
    return { count, positions, startIndices, widths, colors: cols, vertices: count * points };
  };

  return {
    local: build(idxLocal, LOCAL_POINTS, colors.local, false),
    trunk: build(idxTrunk, MOTORWAY_POINTS, colors.motorway, true),
    minor: build(idxMinor, MOTORWAY_POINTS, colors.motorway, true),
    trunkWeight
  };
}
