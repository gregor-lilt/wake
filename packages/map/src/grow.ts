/**
 * Growing the map during a live session.
 *
 * The document arrives once and the deltas that follow it are a stream, but an
 * agent does not only edit files it found: it creates them. The daemon says so
 * with a `node` frame (docs/protocol.md) naming an id the document never had,
 * and everything the map draws a file with is dense and typed and indexed by a
 * file's slot: the repo columns, the layout's rects and centroids, the baked
 * quad soups.
 *
 * So the arrays are allocated with headroom at load and a new file takes the
 * next free slot: one quad written, one count raised, nothing reallocated and
 * nothing rebuilt. The reallocation path below exists for the session that
 * outgrows its headroom; it copies the columns into wider ones in place, so
 * every holder of the `repo` and `layout` objects keeps working (nothing in
 * this package holds a typed array across a frame).
 *
 * Headroom is a quarter of the document, and never fewer than the minimums
 * here: a 12-file scratch repository gets the same 256 spare slots a 5,000-file
 * one gets 1,250 of, which is a few hundred kilobytes at the top end and the
 * difference between a session that grows and one that reloads.
 */
import type { Dir, Repo } from './repo';
import type { BuildingColor, CityColor, Layout } from './layout';
import { moveDirRect, moveFileRect } from './layout';

/** Spare slots as a share of the document's own size. */
export const HEADROOM_SHARE = 0.25;
export const FILE_HEADROOM_MIN = 256;
export const SYM_HEADROOM_MIN = 256;
export const DIR_HEADROOM_MIN = 64;

/** Slots to allocate for `n` of something: a quarter more, at least `min`. */
export const capacityFor = (n: number, min: number): number =>
  n + Math.max(min, Math.ceil(n * HEADROOM_SHARE));

type Typed = Int32Array | Uint32Array | Uint16Array | Uint8Array | Float32Array;

/** The same array, longer, with what it held copied into the front. */
function widen<T extends Typed>(a: T, len: number): T {
  const ctor = a.constructor as new (n: number) => T;
  const out = new ctor(len);
  (out as Typed).set(a as unknown as Uint8Array as never);
  return out;
}

/** What a `node` frame of kind "file" carries, in the map's own terms. */
export interface NewFile {
  /** dense directory index of the district it belongs to */
  dir: number;
  name: string;
  path: string | null;
  lines: number;
  folded: boolean;
  /** tile rect in world units */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a `node` frame of kind "dir" carries for a district that is new. */
export interface NewDir {
  parent: number;
  name: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Room for `want` files. Returns true when the columns were actually widened,
 * which is the caller's cue that the derived indices (roads, incidence) are
 * stale — an append inside the headroom leaves them stale too, so in practice
 * the caller rebuilds either way.
 */
export function ensureFileCapacity(repo: Repo, layout: Layout, want: number): boolean {
  const cap = repo.fileCapacity ?? repo.fileCount;
  if (want <= cap) return false;
  const next = capacityFor(want, FILE_HEADROOM_MIN);
  repo.fileDir = widen(repo.fileDir, next);
  repo.fileSize = widen(repo.fileSize, next);
  repo.fileLines = widen(repo.fileLines, next);
  repo.fileFolded = widen(repo.fileFolded, next);
  repo.fileRegion = widen(repo.fileRegion, next);
  repo.fileFanIn = widen(repo.fileFanIn, next);
  repo.fileSymStart = widen(repo.fileSymStart, next + 1);
  layout.cityRect = widen(layout.cityRect, next * 4);
  layout.cityCentroid = widen(layout.cityCentroid, next * 2);
  layout.cities.positions = widen(layout.cities.positions, next * 8);
  layout.cities.colors = widen(layout.cities.colors, next * 16);
  const start = widen(layout.cities.startIndices, next + 1);
  for (let f = 0; f <= next; f++) start[f] = f * 4;
  layout.cities.startIndices = start;
  repo.fileCapacity = next;
  return true;
}

/** Room for `want` directories. */
export function ensureDirCapacity(repo: Repo, layout: Layout, want: number): boolean {
  const cap = repo.dirCapacity ?? repo.dirs.length;
  if (want <= cap) return false;
  const next = capacityFor(want, DIR_HEADROOM_MIN);
  layout.dirRect = widen(layout.dirRect, next * 4);
  layout.dirCentroid = widen(layout.dirCentroid, next * 2);
  repo.dirCapacity = next;
  return true;
}

/**
 * Append one file and draw it. The tile is written straight into the free slot
 * by the same arithmetic a move uses, so a created file is a tile on the next
 * frame with no rebuild of anything the document already laid out.
 *
 * Symbols are not part of this: a new file has none until the indexer says so,
 * and `fileSymStart` closes the empty span. A later symbol frame appends into
 * the symbol headroom the same way.
 */
export function appendFile(
  repo: Repo,
  layout: Layout,
  spec: NewFile,
  cityColor: CityColor,
  buildingColor: BuildingColor
): number {
  if (spec.dir < 0 || spec.dir >= repo.dirs.length) return -1;
  ensureFileCapacity(repo, layout, repo.fileCount + 1);
  const f = repo.fileCount;
  const dir = repo.dirs[spec.dir];
  repo.fileDir[f] = spec.dir;
  repo.fileRegion[f] = dir.region;
  repo.fileName[f] = spec.name;
  repo.fileLines[f] = Math.max(1, Math.round(spec.lines));
  repo.fileSize[f] = repo.fileLines[f];
  repo.fileFolded[f] = spec.folded ? 1 : 0;
  repo.fileFanIn[f] = 0;
  // An empty span at the end of the symbol space: start and end both at S.
  repo.fileSymStart[f] = repo.symCount;
  repo.fileSymStart[f + 1] = repo.symCount;
  if (repo.filePath) repo.filePath[f] = spec.path ?? '';
  repo.fileCount = f + 1;
  layout.cities.count = repo.fileCount;
  dir.files.push(f);
  for (let d = spec.dir; d >= 0; d = repo.dirs[d].parent) repo.dirs[d].fileCount++;
  moveFileRect(repo, layout, f, spec.x, spec.y, spec.w, spec.h, cityColor, buildingColor);
  return f;
}

/**
 * Append one district. A file the agent creates in a directory that did not
 * exist arrives as a dir frame first, and without this its file would have
 * nowhere to live. A district at the region depth becomes a region of its own,
 * which is what gives it its own hue.
 */
export function appendDir(repo: Repo, layout: Layout, spec: NewDir): number {
  if (spec.parent < 0 || spec.parent >= repo.dirs.length) return -1;
  ensureDirCapacity(repo, layout, repo.dirs.length + 1);
  const parent = repo.dirs[spec.parent];
  const id = repo.dirs.length;
  const depth = parent.depth + 1;
  const isRegion = depth === repo.regionDepth && repo.regions.length < 255;
  const d: Dir = {
    id,
    name: spec.name,
    path: spec.path,
    parent: spec.parent,
    depth,
    region: isRegion ? repo.regions.length : parent.region,
    children: [],
    files: [],
    fileCount: 0
  };
  repo.dirs.push(d);
  parent.children.push(id);
  if (isRegion) {
    repo.regions.push(id);
    repo.regionNames.push(spec.name);
  }
  repo.dirCapacity = Math.max(repo.dirCapacity ?? 0, repo.dirs.length);
  moveDirRect(layout, id, spec.x, spec.y, spec.w, spec.h);
  return id;
}
