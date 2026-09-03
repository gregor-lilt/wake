/**
 * File captions (docs/design.md section 7).
 *
 * Since phase 5 the district names are DOM and sticky (src/wayfind.ts),
 * because their anchor is the intersection of the region with the viewport and
 * therefore moves with the camera every frame. What is left here is the file
 * caption: sentence case, one weight, one size, a fixed pixel gap above the
 * sheet's top-left corner and left aligned, so it reads as a caption on a
 * page, plus the zoom plan the rest of the map still keys off.
 *
 * Visibility is by fit, not by band: a caption appears whenever its tile is
 * wider than the caption, at every band including blocks. When only part of
 * it fits it is abbreviated with an ellipsis, and below FIT_MIN_CHARS
 * characters it is dropped. That is the clip / abbreviate / hide cascade from
 * section 7, and it is the only thing that decides whether a name is drawn.
 *
 * Collision is still the GPU CollisionFilterExtension, in one group. Sticky
 * region labels are DOM and take precedence over it: `main.ts` drops any
 * caption whose box overlaps one of them. Inside the group the order is the
 * focused file, then tile height, then fan-in.
 */
import type { Repo } from './repo';
import type { Layout } from './layout';
import { STUB_LINES } from './lattice';

/** What a label is attached to. Positions are derived, not stored. */
export interface PlaceItem {
  text: string;
  /** the rect the label belongs to: a district's region or a file's tile */
  rect: [number, number, number, number];
  depth: number;
  kind: 'region' | 'sub' | 'city';
  priority: number;
  minZoom: number;
  /** a stub file: no label at all below the reading band */
  stub: boolean;
  /** file index for a city, -1 for a district */
  file: number;
  /** directory id for a district, -1 for a city */
  dir: number;
}

/** What the TextLayer eats. */
export interface LabelItem {
  text: string;
  position: [number, number];
  size: number;
  priority: number;
  kind: 'region' | 'sub' | 'city';
  /** the rect the label is anchored to, for the verification hooks */
  rect: [number, number, number, number];
  /** file index, -1 when the label is not a file caption */
  file: number;
}

/** File labels: one size, a fixed gap above the sheet's top-left corner. */
export const FILE_SIZE = 11.5;
/**
 * The size the fit is judged legible at (docs/design.md section 7: "wider than
 * the label at minimum size"). Captions are drawn at FILE_SIZE and abbreviated
 * to fit; nothing is ever drawn smaller than this.
 */
export const FILE_MIN_SIZE = 10;
const FILE_GAP = 3;
/** Fewer characters than this and a name is hidden rather than abbreviated. */
export const FIT_MIN_CHARS = 6;
/** Collision priority of the focused file's caption: top of the file group. */
export const FOCUSED_PRIORITY = 61;
/**
 * Nudge the anchor a couple of pixels inside the text box. deck.gl's collision
 * filter samples the label's anchor, not its box, so an anchor sitting exactly
 * on the left edge of the first glyph fades the label to ~20% alpha.
 */
const ANCHOR_INSET = 2.5;

/** Tracking for the district style, as a fraction of the em. */
const TRACK = 0.28;
/** Advance of the sans-serif stack, per em, upper case and mixed case. */
const ADV_CAPS = 0.66;
const ADV_MIXED = 0.56;

/** Small caps and tracked, the district style. A thin space is the tracking. */
export const trackText = (s: string): string => s.toUpperCase().split('').join(' ');

const widthOfCaps = (chars: number, size: number) => chars * size * (ADV_CAPS + TRACK);

/**
 * Semantic zoom thresholds in deck.gl OrthographicView zoom units
 * (2**zoom = screen pixels per world unit).
 *
 * Every threshold is an offset from the zoom at which the whole world fits a
 * nominal 1200 px viewport, so the same plan works for the synthetic fixture
 * and for a real export whose world is a different size.
 */
export interface ZoomPlan {
  base: number;
  buildings: number;
  localRoads: number;
  minorMotorways: number;
  dirDepth(depth: number, regionDepth: number): number;
  cityMinZoom(t: number): number;
  level(z: number): string;
}

/**
 * Counts of the two things whose thresholds are about ink, not scale. A repo
 * with 375 local roads can show all of them at continent zoom; one with 17,000
 * cannot. Same for symbols.
 */
export interface ZoomCounts {
  localRoads: number;
  symbols: number;
  files: number;
}

/** Reference counts: the synthetic fixture the offsets were tuned on. */
const REF = { localRoads: 17050, symbols: 200000, files: 50000 };

export function makeZoomPlan(worldSide: number, counts: ZoomCounts): ZoomPlan {
  const base = Math.log2(1200 / Math.max(worldSide, 1));
  const roadOffset = Math.max(-0.9, 2.18 + Math.log2(Math.max(counts.localRoads, 1) / REF.localRoads) * 0.5);
  const symbolOffset = Math.max(0.6, 4.78 + Math.log2(Math.max(counts.symbols, 1) / REF.symbols) * 0.55);
  // How much zoom the file-label ladder is spread over. It is about label ink:
  // 50k file names cannot all appear at once, 356 can.
  const cityLabelSpan = Math.max(0.85, 4.8 + Math.log2(Math.max(counts.files, 1) / REF.files) * 0.7);
  return {
    base,
    /** buildings (symbols) appear here */
    buildings: base + symbolOffset,
    /** local roads appear here, trunk motorways are always on */
    localRoads: base + roadOffset,
    /** light cross-region roads appear here, heavy ones are always on */
    minorMotorways: base + 0.98,
    dirDepth: (depth, regionDepth) => {
      const rel = depth - regionDepth;
      if (rel <= 0) return -99;
      return base + 0.38 + (Math.min(rel, 5) - 1) * 0.9;
    },
    cityMinZoom: (t) => base + 0.58 + cityLabelSpan * Math.pow(t, 0.55),
    level: (z) => (z < base ? 'continent' : z < base + 1.98 ? 'country' : z < base + symbolOffset ? 'city' : 'street')
  };
}

/**
 * `stubMinZoom` is the zoom at which the reading band starts: a stub carries no
 * name until the source is on the page. Every other caption is gated by fit
 * alone.
 */
export function buildPlaceLabels(
  repo: Repo,
  layout: Layout,
  zoom: ZoomPlan,
  stubMinZoom: number
): { places: PlaceItem[]; cities: PlaceItem[] } {
  const places: PlaceItem[] = [];
  for (const d of repo.dirs) {
    // The repository root is the terrain, not a district: it gets no name.
    if (d.depth < repo.regionDepth) continue;
    const isRegion = d.depth === repo.regionDepth;
    places.push({
      // The plain name: the sticky region label is DOM and CSS does the small
      // caps and the tracking, so the string is not padded out any more.
      text: d.name,
      rect: [
        layout.dirRect[d.id * 4],
        layout.dirRect[d.id * 4 + 1],
        layout.dirRect[d.id * 4 + 2],
        layout.dirRect[d.id * 4 + 3]
      ],
      depth: d.depth,
      kind: isRegion ? 'region' : 'sub',
      // Every district outranks every file label, and a shallower district
      // outranks a deeper one.
      priority: 100 - Math.min(6, d.depth - repo.regionDepth) * 5,
      minZoom: zoom.dirDepth(d.depth, repo.regionDepth),
      stub: false,
      file: -1,
      dir: d.id
    });
  }

  const n = repo.fileCount;
  // Collision order inside the file group: tile height first, fan-in second
  // (docs/design.md section 7). A tile's height is its effective line count.
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) score[i] = repo.fileLines[i] * 4096 + Math.min(4095, repo.fileFanIn[i]);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => score[b] - score[a] || a - b);

  const cities: PlaceItem[] = [];
  const cap = Math.min(24000, n);
  for (let rank = 0; rank < cap; rank++) {
    const f = sorted[rank];
    const t = rank / cap;
    const stub = repo.fileLines[f] < STUB_LINES;
    cities.push({
      text: repo.fileName[f],
      rect: [
        layout.cityRect[f * 4],
        layout.cityRect[f * 4 + 1],
        layout.cityRect[f * 4 + 2],
        layout.cityRect[f * 4 + 3]
      ],
      depth: 99,
      kind: 'city',
      priority: Math.round(60 - 50 * t),
      // Visibility by fit, not by band: a caption appears as soon as its tile
      // is wide enough for it, which is what `fileLabels` decides. A stub is
      // still not worth a name until the source is on the page.
      minZoom: stub ? stubMinZoom : -99,
      stub,
      file: f,
      dir: -1
    });
  }
  return { places, cities };
}

/** Rect intersects the padded viewport. */
function inView(r: [number, number, number, number], b: [number, number, number, number]): boolean {
  const mx = (b[2] - b[0]) * 0.08;
  const my = (b[3] - b[1]) * 0.08;
  return r[0] + r[2] >= b[0] - mx && r[0] <= b[2] + mx && r[1] + r[3] >= b[1] - my && r[1] <= b[3] + my;
}

/**
 * The clip / abbreviate / hide cascade of docs/design.md section 7, in
 * characters. Returns null when the name is to be dropped.
 */
export function fitText(text: string, size: number, availPx: number, adv = ADV_MIXED): string | null {
  const per = size * adv;
  const maxChars = Math.floor(availPx / Math.max(per, 1e-6));
  if (maxChars >= text.length) return text;
  // One column goes to the ellipsis itself.
  const keep = maxChars - 1;
  if (keep < FIT_MIN_CHARS) return null;
  return text.slice(0, keep) + '\u2026';
}

/** Width in pixels of a mixed-case name at a size. */
export const widthOfMixed = (chars: number, size: number): number => chars * size * ADV_MIXED;
export { widthOfCaps, ADV_CAPS, ADV_MIXED, TRACK };

/**
 * File names: one size for the whole map, left aligned, a fixed gap above the
 * sheet's top-left corner. Visibility is by fit: a caption whose tile is too
 * narrow is abbreviated with an ellipsis and then dropped, at every band.
 * Capped, most important first, because a repository with 50k files cannot
 * show every caption.
 */
export function fileLabels(
  items: PlaceItem[],
  zoom: number,
  limit: number,
  bounds: [number, number, number, number],
  focused = -1
): LabelItem[] {
  const scale = 2 ** zoom;
  const out: LabelItem[] = [];
  for (const it of items) {
    if (it.minZoom > zoom || !inView(it.rect, bounds)) continue;
    const [x, y, w, h] = it.rect;
    // A caption never reaches past its own page: the tile is the budget.
    const text = fitText(it.text, FILE_SIZE, w * scale);
    if (text === null) continue;
    out.push({
      text,
      position: [x + ANCHOR_INSET / scale, y + h + (FILE_GAP + FILE_SIZE / 2) / scale],
      size: FILE_SIZE,
      // The focused file's caption is the first thing collision keeps, at the
      // top of the file group but still under every district: region labels
      // are DOM now and outrank the group by suppression instead, and the
      // focused file is the one caption `main.ts` exempts from it.
      priority: it.file === focused ? FOCUSED_PRIORITY : it.priority,
      kind: 'city',
      rect: it.rect,
      file: it.file
    });
    if (out.length >= limit) break;
  }
  return out;
}
