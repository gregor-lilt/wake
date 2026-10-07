/**
 * The sheet: one row height for the whole map, shared by both code tiers
 * (docs/design.md sections 2 and 3), on the phase-2 lattice.
 *
 * Every decision keys off one number, the on-screen height of one source line:
 *
 *     rowPx = clamp(ROW_WORLD * scale, 0, ROW_PX_MAX)
 *
 * `ROW_WORLD` is no longer fitted to the data: it is `CELL_WORLD / CELL_LINES`,
 * a property of the lattice the layout used (see lattice.ts). Nothing about a
 * file, not its length and not its tile, is allowed to change the size of a
 * glyph.
 *
 * The sheet IS the tile, exactly, at every band:
 *
 *   width   the tile is TILE_CELLS_W cells = COLS glyph columns, the same for
 *           every file. Two glyphs of margin on each side are taken from
 *           inside it, so the text box is COLS - 2 * MARGIN_COLS columns and a
 *           longer line is clipped there with a FADE_COLS fade.
 *   height  the tile is a whole number of 40-line steps, so a file of N
 *           effective lines fills N of its rows and the rest of the tile is
 *           empty paper. One row of padding top and bottom whenever the
 *           rounding leaves room for it (it does not when N is an exact
 *           multiple of the step, and the padding shrinks rather than pushing
 *           a row outside the tile).
 *
 * Nothing is squeezed any more: `rowH` is `ROW_WORLD` at every band, so the
 * schematic and the source are the same page at two distances and the sheet
 * geometry no longer depends on the camera at all.
 *
 * Above the fold cap the sheet shows the first `FOLD_CAP` rows and gives its
 * last FOLD_MARKER_ROWS to a fold marker: a dashed rule across the text box
 * plus a "+N lines" caption (drawn as dashes here, as real text in the source
 * overlay).
 *
 * The schematic is the tile's texture from the terrain band up (review of the
 * labels phase, docs/design.md sections 2 and 4): there is no tile-only tier
 * any more. Below one device pixel per row a bar row cannot be drawn without
 * shimmering, so consecutive lines are grouped:
 *
 *     group = ceil(1 / rowPx)     // 1 at and above rowPx 1
 *
 * which is the smallest group whose bar is at least one pixel tall. A group's
 * colour is its dominant token colour (the one covering the most glyph
 * columns) and its width is the longest line in it, so the texture keeps the
 * shape of the file. Aggregation means FEWER quads at low zoom, not more,
 * which is what keeps the terrain band inside the quad budget with every
 * file's sheet built.
 */
import type { Rect } from './layout';
import type { CodeFile } from './code';
import type { Theme } from './theme';
import type { Repo } from './repo';
import { bandRows } from './diff';
import {
  COLS, ROW_WORLD, COL_WORLD, FOLD_CAP, FOLD_MARKER_ROWS, STUB_LINES
} from './lattice';

export { COLS, ROW_WORLD, FOLD_CAP, FOLD_MARKER_ROWS };

/** Row height where the source is readable, and the reading band begins. */
export const ROW_PX_READ = 9;
/** Hysteresis on the way out of the reading band. */
export const ROW_PX_READ_EXIT = 8;
/**
 * Row height where one bar row is one device pixel, and therefore where the
 * schematic stops being aggregated. Also the terrain/schematic band boundary.
 */
export const ROW_PX_SCHEMATIC = 1;
/** Maximum zoom is where the row height reaches this. Zooming stops there. */
export const ROW_PX_MAX = 18;
/**
 * Row height where the tile fill glow starts leaving. Activity is shown at the
 * granularity of the band (docs/design.md section 9): the amber fill over a
 * whole tile reads while a file IS a tile, so it fades out continuously
 * between here and ROW_PX_READ and is gone in the reading band, where a wash
 * over readable text is never allowed. Continuous, not a snap.
 */
export const ROW_PX_GLOW_FADE = 6;

/** Weight of the tile fill glow at a row height: 1 below the ramp, 0 above. */
export function tileGlowWeight(rowPx: number): number {
  if (rowPx <= ROW_PX_GLOW_FADE) return 1;
  if (rowPx >= ROW_PX_READ) return 0;
  return (ROW_PX_READ - rowPx) / (ROW_PX_READ - ROW_PX_GLOW_FADE);
}

/**
 * The complement: what the sheet border and its sticky header carry instead,
 * so the two cross-fade over the same three pixels and nothing snaps.
 */
export const sheetGlowWeight = (rowPx: number): number => 1 - tileGlowWeight(rowPx);
/** The two-glyph margin on each side, taken from inside the tile. */
export const MARGIN_COLS = 2;
/** Columns of the text box: the tile's COLS, less both margins. */
export const TEXT_COLS = COLS - 2 * MARGIN_COLS;
/** Columns the right-margin fade covers. */
export const FADE_COLS = 3;
/** Files with fewer effective lines than this are a blank sheet, no bars. */
export const TRIVIAL_LINES = STUB_LINES;
/** Opacity of a stub's sheet (docs/design.md section 4: dimmed). */
export const STUB_ALPHA = 0.4;
/** Rects for lines outside the viewport are not built at all. */
export const ROW_MARGIN = 24;
/**
 * Glyph advance as a fraction of the row height. The lattice fixes it: a cell
 * is 20 columns by 10 lines and square in world units, so one column is
 * exactly half a row.
 */
export const ADVANCE = COL_WORLD / ROW_WORLD;
const CHAR_RATIO = 0.6;
/**
 * Font size as a fraction of the row height. Follows from ADVANCE: a monospace
 * face whose advance is CHAR_RATIO em has to be set at ADVANCE / CHAR_RATIO of
 * the row for its glyphs to land on the lattice's columns.
 */
export const FONT_RATIO = ADVANCE / CHAR_RATIO;

export type Band = 'terrain' | 'schematic' | 'reading';
/**
 * What is drawn for every file, decided once per frame. The tile-only tier is
 * gone: every file shows its schematic at every zoom, aggregated below
 * ROW_PX_SCHEMATIC.
 */
export type Tier = 'schematic' | 'source';

/**
 * Lines per aggregated bar row: the smallest group whose bar is at least one
 * device pixel tall. 1 at and above ROW_PX_SCHEMATIC, where every line gets
 * its own row of bars. Capped so a camera at the world fit cannot ask for a
 * group larger than a folded sheet.
 */
export function groupSizeOf(rowPx: number): number {
  if (rowPx >= ROW_PX_SCHEMATIC) return 1;
  return Math.max(1, Math.min(FOLD_CAP, Math.ceil(ROW_PX_SCHEMATIC / Math.max(rowPx, 1e-6))));
}

/** On-screen height of one source line, the number the whole ladder keys off. */
export function rowPxOf(k: number, scale: number): number {
  return Math.min(ROW_PX_MAX, k * scale);
}

/** Zoom (log2 scale) at which one source line is `rowPx` tall. */
export function zoomForRowPx(k: number, rowPx: number): number {
  return Math.log2(Math.max(rowPx, 1e-6) / Math.max(k, 1e-9));
}

/** Maximum zoom: where rowPx reaches ROW_PX_MAX. */
export function maxZoomFor(k: number): number {
  return zoomForRowPx(k, ROW_PX_MAX);
}

export function bandOf(rowPx: number): Band {
  if (rowPx < ROW_PX_SCHEMATIC) return 'terrain';
  if (rowPx < ROW_PX_READ) return 'schematic';
  return 'reading';
}

/**
 * The tier for the whole map, with one pixel of hysteresis on the way out of
 * the reading band, so a camera resting on the threshold does not flicker.
 * There are only two tiers now: a file is either schematic or source, and
 * ONLY the zoom decides which (docs/design.md section 2).
 */
export function tierOf(prev: Tier, rowPx: number, readAt = ROW_PX_READ): Tier {
  const readExit = readAt - (ROW_PX_READ - ROW_PX_READ_EXIT);
  if (rowPx >= readAt || (prev === 'source' && rowPx >= readExit)) return 'source';
  return 'schematic';
}

export interface Sheet {
  /**
   * Rows of source the sheet can draw: the tile's content rows, less the fold
   * marker. Content is additionally capped at the file's own line count when
   * the text is loaded.
   */
  lineCount: number;
  /** world units per source line, ROW_WORLD at every band */
  rowH: number;
  /** world units per glyph column */
  colW: number;
  /** columns the tile is wide */
  cols: number;
  /** the sheet, world units, +y up: (x, y) is its bottom left corner */
  x: number;
  y: number;
  w: number;
  h: number;
  /** the text box inside the sheet's margins, shared by bars and glyphs */
  textX: number;
  textW: number;
  /** world y of the top edge of line 0, one row below the sheet's top */
  topY: number;
  /** the file's tile, which the sheet now equals exactly */
  inner: Rect;
  /** rows the tile holds: a whole number of 40-line steps */
  tileRows: number;
  /** rows the content may use: min(effective lines, fold cap) */
  contentRows: number;
  /** rows of padding above line 0 (and the same below the last row) */
  padRows: number;
  /** the file is past the fold cap */
  folded: boolean;
  /** effective lines the fold hides, for the "+N lines" caption */
  hiddenLines: number;
  /** the file's effective line count as the export reported it */
  effectiveLines: number;
  /** kept for the phase-1 call sites: the squeeze is gone, so always 1 */
  ramp: number;
  /** the sheet is taller than its tile: impossible now, kept for the audit */
  overflows: boolean;
}

/**
 * Sheet geometry of one file. Depends only on the tile and the effective line
 * count: the sheet IS the tile, and the row height is the lattice's, so this
 * no longer moves with the camera at all.
 *
 * `effectiveLines` is the export's count (long lines wrapped at COLS), which
 * is what the layout used to pick the tile's height. The tile is never
 * resized to match anything the renderer counts itself.
 */
export function sheetOf(rect: Rect, effectiveLines: number, folded: boolean): Sheet {
  const n = Math.max(Math.round(effectiveLines), 1);
  const rowH = ROW_WORLD;
  const colW = rect.w / COLS;
  const tileRows = Math.max(1, Math.round(rect.h / rowH));
  const contentRows = Math.min(n, tileRows, FOLD_CAP);
  const textRows = Math.max(1, folded ? contentRows - FOLD_MARKER_ROWS : contentRows);
  // One row of padding top and bottom, taken from inside the tile. A file
  // whose length lands exactly on a height step has no slack for it, and the
  // padding shrinks rather than pushing a row outside the tile.
  const slack = tileRows - contentRows;
  const padRows = Math.min(1, slack / 2);
  const top = rect.y + rect.h;
  return {
    lineCount: textRows,
    rowH,
    colW,
    cols: COLS,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    textX: rect.x + MARGIN_COLS * colW,
    textW: TEXT_COLS * colW,
    topY: top - padRows * rowH,
    inner: rect,
    tileRows,
    contentRows,
    padRows,
    folded,
    hiddenLines: folded ? Math.max(0, n - FOLD_CAP) : 0,
    effectiveLines: n,
    ramp: 1,
    overflows: false
  };
}

/** Row the fold marker's dashed rule sits on, given the rows actually drawn. */
export function foldMarkerRow(s: Sheet, drawnRows: number): number {
  return Math.min(Math.max(drawnRows, 0), s.lineCount);
}

/** World y of the top edge of a source line. +y is up. */
export function lineTopY(s: Sheet, line: number): number {
  return s.topY - line * s.rowH;
}

/** Source line whose row contains a world y. */
export function lineAtY(s: Sheet, y: number): number {
  return Math.max(0, Math.min(s.lineCount - 1, Math.floor((s.topY - y) / s.rowH)));
}

/** The line range worth building, clipped to the viewport plus a margin. */
export function visibleRows(s: Sheet, bounds: [number, number, number, number]): [number, number] {
  const top = lineAtY(s, bounds[3]);
  const bottom = lineAtY(s, bounds[1]);
  return [Math.max(0, top - ROW_MARGIN), Math.min(s.lineCount, bottom + 1 + ROW_MARGIN)];
}

export interface Soup {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
}

export interface DiffBand {
  file: number;
  line: number;
  kind: 'add' | 'mod' | 'del';
  poly: Array<[number, number]>;
}

export interface FileSchematic {
  file: number;
  s: Sheet;
  /** row range that was built */
  rows: [number, number];
  soup: Soup;
  diffBands: DiffBand[];
  quads: number;
}

function pushQuad(
  pos: Float32Array,
  col: Uint8Array,
  i: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
  /** alpha at the right edge, for the right-margin fade */
  aRight = a
): void {
  const o = i * 8;
  pos[o] = x; pos[o + 1] = y;
  pos[o + 2] = x + w; pos[o + 3] = y;
  pos[o + 4] = x + w; pos[o + 5] = y + h;
  pos[o + 6] = x; pos[o + 7] = y + h;
  const c = i * 16;
  const alphas = [a, aRight, aRight, a];
  for (let v = 0; v < 4; v++) {
    col[c + v * 4] = r;
    col[c + v * 4 + 1] = g;
    col[c + v * 4 + 2] = b;
    col[c + v * 4 + 3] = alphas[v];
  }
}

/**
 * The sheets' own fill: one quad per sheet in the code background colour.
 * This is what makes the tile the page. There is no second dark box, and no
 * separate backdrop for a sheet that has grown past its tile.
 */
export function fillSoup(sheets: Sheet[], rgb: readonly number[], alphaOf?: (s: Sheet) => number): Soup {
  const positions = new Float32Array(sheets.length * 8);
  const colors = new Uint8Array(sheets.length * 16);
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const a = Math.round(255 * (alphaOf ? alphaOf(s) : 1));
    pushQuad(positions, colors, i, s.x, s.y, s.w, s.h, rgb[0], rgb[1], rgb[2], a);
  }
  return { count: sheets.length, positions, colors };
}

/**
 * The gutter (docs/design.md section 7). In the reading band the line numbers
 * are real glyphs in the source overlay; here, at the top of the schematic
 * band, every tenth line gets a small dimmed bar in the sheet's left margin
 * instead, which is as much as a 6 to 9 px row can carry legibly. Below
 * GUTTER_MIN_ROW_PX nothing is drawn at all.
 */
export const GUTTER_MIN_ROW_PX = 6;
/** Line numbers are marked every this many lines in the schematic band. */
export const GUTTER_EVERY = 10;
/** Columns the tick occupies inside the sheet's two-column left margin. */
const TICK_COLS = 1.2;
const TICK_INSET_COLS = 0.4;

/**
 * Digits the gutter needs for a sheet, and therefore the columns it takes:
 * the two margin columns at least, one more for the separating space, and
 * never more than four, so the 96-column text box still fits inside the
 * 100-column sheet.
 */
export function gutterCols(rows: number): number {
  const digits = Math.min(4, Math.max(1, String(Math.max(1, Math.round(rows))).length));
  return Math.min(4, Math.max(MARGIN_COLS, digits + 1));
}

/** Every tenth line of every sheet as a small dimmed bar in its left margin. */
export function gutterSoup(
  sheets: Sheet[],
  drawnOf: (s: Sheet) => number,
  rgb: readonly number[],
  alpha: number
): Soup {
  let n = 0;
  for (const s of sheets) n += Math.floor(drawnOf(s) / GUTTER_EVERY);
  const positions = new Float32Array(n * 8);
  const colors = new Uint8Array(n * 16);
  const a = Math.round(255 * alpha);
  let i = 0;
  for (const s of sheets) {
    const drawn = drawnOf(s);
    for (let line = GUTTER_EVERY; line <= drawn && i < n; line += GUTTER_EVERY) {
      const y = lineTopY(s, line - 1) - s.rowH * 0.78;
      pushQuad(
        positions, colors, i++,
        s.x + TICK_INSET_COLS * s.colW, y,
        TICK_COLS * s.colW, s.rowH * 0.5,
        rgb[0], rgb[1], rgb[2], a
      );
    }
  }
  return { count: i, positions, colors };
}

/** Contrast of the right-margin fade at a column, 1 solid to 0 at the edge. */
const fadeAt = (col: number): number => Math.max(0, Math.min(1, (TEXT_COLS - col) / FADE_COLS));

/** Prose and config are context, not subject: half contrast on both tiers. */
const NON_CODE = new Set(['md', 'markdown', 'yaml', 'yml', 'json', 'toml', 'lock', 'txt', 'rst', 'cfg', 'ini']);
export function isNonCode(path: string | null): boolean {
  if (!path) return false;
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.lock') || base === 'package-lock.json') return true;
  const dot = base.lastIndexOf('.');
  return dot > 0 && NON_CODE.has(base.slice(dot + 1));
}
/** Dashes in a fold marker's rule, and in the bar standing in for its caption. */
const FOLD_DASHES = 24;
const CAPTION_DASHES = 4;

/** Contrast multiplier of a sheet's ink. */
export const inkOf = (nonCode: boolean): number => (nonCode ? 0.5 : 1);

/**
 * Build the rects for one file over one row range: symbol bands under token
 * runs, the fold marker, plus the diff bands, all inside the sheet's text box
 * and clipped to TEXT_COLS with a fade over the last FADE_COLS. Only the rows
 * on screen are ever built.
 *
 * The row range is clipped to the rows the sheet can hold, so a file whose own
 * line count disagrees with the export's effective count (a binary, or one the
 * working tree has grown) is cut off rather than drawn past its tile.
 */
export function buildSchematic(
  file: number,
  s: Sheet,
  rows: [number, number],
  code: CodeFile,
  repo: Repo,
  theme: Theme,
  ink = 1
): FileSchematic {
  // Rows the sheet can actually hold, and the row the fold marker sits on.
  const drawn = Math.min(code.lineCount, s.lineCount);
  const r0 = Math.max(0, Math.min(rows[0], drawn));
  const r1 = Math.max(r0, Math.min(rows[1], drawn));
  const trivial = s.effectiveLines < TRIVIAL_LINES;
  const markerRow = s.folded ? foldMarkerRow(s, drawn) : -1;
  const showMarker = markerRow >= 0 && markerRow + FOLD_MARKER_ROWS <= s.tileRows;

  // Symbol extents that overlap the range: a faint band plus a left bracket.
  const bands: Array<{ from: number; to: number; kind: number }> = [];
  if (repo.symLineStart && repo.symLineEnd && !trivial) {
    for (let i = repo.fileSymStart[file]; i < repo.fileSymStart[file + 1]; i++) {
      const k = repo.symKind[i];
      if (k > 2) continue; // constants are not blocks
      const from = repo.symLineStart[i] - 1;
      const to = Math.min(repo.symLineEnd[i] - 1, drawn - 1);
      if (from < 0 || to < from || to < r0 || from > r1) continue;
      bands.push({ from, to, kind: k });
    }
    bands.sort((a, b) => b.to - b.from - (a.to - a.from)); // big blocks under small
  }

  let runTotal = 0;
  if (!trivial) {
    for (let line = r0; line < r1; line++) {
      runTotal += code.lineRunStart[line + 1] - code.lineRunStart[line];
    }
  }
  const cap = bands.length * 2 + runTotal + (showMarker ? FOLD_DASHES + CAPTION_DASHES : 0);
  const positions = new Float32Array(cap * 8);
  const colors = new Uint8Array(cap * 16);
  let q = 0;

  for (const b of bands) {
    const y1 = lineTopY(s, Math.max(b.from, r0));
    const y0 = lineTopY(s, Math.min(b.to + 1, r1));
    const [r, g, bl] = theme.buildingFill(b.kind, repo.fileRegion[file]);
    const h = Math.max(y1 - y0, s.rowH * 0.5);
    pushQuad(positions, colors, q++, s.textX, y0, s.textW, h, r, g, bl, Math.round(30 * ink));
    pushQuad(positions, colors, q++, s.textX, y0, s.colW * 0.5, h, r, g, bl, Math.round(120 * ink));
  }

  const pal = code.palette;
  const rowFill = s.rowH * 0.82;
  const alpha = 236 * ink;
  if (!trivial) {
    for (let line = r0; line < r1; line++) {
      const a0 = code.lineRunStart[line];
      const a1 = code.lineRunStart[line + 1];
      if (a1 <= a0) continue;
      const y = lineTopY(s, line + 1) + (s.rowH - rowFill) / 2;
      for (let i = a0; i < a1; i++) {
        const startCol = code.runs[i * 3];
        if (startCol >= TEXT_COLS) continue; // clipped at the text box, never outside
        const len = Math.min(code.runs[i * 3 + 1], TEXT_COLS - startCol);
        if (len <= 0) continue;
        const ci = code.runs[i * 3 + 2] * 3;
        pushQuad(
          positions, colors, q++,
          s.textX + startCol * s.colW, y, len * s.colW, rowFill,
          pal[ci], pal[ci + 1], pal[ci + 2],
          Math.round(alpha * fadeAt(startCol)),
          Math.round(alpha * fadeAt(startCol + len))
        );
      }
    }
  }

  // The fold marker: a dashed rule across the text box on the row after the
  // last drawn one, and a short dashed bar under it standing in for the
  // "+N lines" caption, which is real text in the source overlay.
  if (showMarker) {
    const [lr, lg, lb] = theme.cityLabel;
    const ruleY = lineTopY(s, markerRow + 1) + s.rowH * 0.45;
    const dashW = (s.textW / FOLD_DASHES) * 0.6;
    const step = s.textW / FOLD_DASHES;
    const ruleH = Math.max(s.rowH * 0.1, 0.35);
    for (let i = 0; i < FOLD_DASHES; i++) {
      pushQuad(positions, colors, q++, s.textX + i * step, ruleY, dashW, ruleH, lr, lg, lb, Math.round(190 * ink));
    }
    const capY = lineTopY(s, markerRow + 2) + s.rowH * 0.25;
    const capH = Math.max(s.rowH * 0.5, 0.5);
    const capStep = s.colW * 2.4;
    for (let i = 0; i < CAPTION_DASHES; i++) {
      pushQuad(positions, colors, q++, s.textX + i * capStep, capY, s.colW * 1.5, capH, lr, lg, lb, Math.round(150 * ink));
    }
  }

  // The changed lines sit in the sheet's right margin, outside the text box
  // and inside the sheet.
  const diffBands: DiffBand[] = [];
  const bandW = MARGIN_COLS * s.colW;
  const x = s.textX + s.textW;
  for (const row of bandRows(code.diff)) {
    if (row.line < r0 || row.line >= r1) continue;
    // One row per changed line, and never past the sheet's top edge: rows are
    // not squeezed any more, so a band does not need to be thickened to be
    // visible at the bottom of the schematic band.
    const h = s.rowH;
    const y0 = Math.min(lineTopY(s, row.line + 1), s.y + s.h - h);
    diffBands.push({
      file,
      line: row.line,
      kind: row.kind,
      poly: [[x, y0], [x + bandW, y0], [x + bandW, y0 + h], [x, y0 + h]]
    });
  }

  return {
    file,
    s,
    rows,
    soup: { count: q, positions: positions.subarray(0, q * 8), colors: colors.subarray(0, q * 16) },
    diffBands,
    quads: q
  };
}

/**
 * Aggregated bar rows for one file, for the terrain band (docs/design.md
 * section 2: "every tile shows its schematic as texture, aggregated so bars
 * never shimmer").
 *
 * `group` consecutive source lines become ONE quad:
 *
 *   height  group * rowH, which is at least one device pixel by construction
 *           (group = ceil(1 / rowPx)), so nothing shimmers,
 *   width   the longest line in the group, clipped at the text box, so the
 *           texture keeps the file's silhouette,
 *   colour  the group's dominant token colour, the one covering the most glyph
 *           columns, so a block of comments and a block of code still read
 *           differently.
 *
 * Symbol bands, the fold marker and per-line diff rows are all sub-pixel here
 * and are left out: the changed lines are aggregated the same way as the bars.
 * The result is fewer quads than the per-line build, which is what lets every
 * file in the world have a sheet at the world fit.
 */
export function buildAggregate(
  file: number,
  s: Sheet,
  group: number,
  code: CodeFile,
  ink = 1
): FileSchematic {
  const drawn = Math.min(code.lineCount, s.lineCount);
  const trivial = s.effectiveLines < TRIVIAL_LINES;
  const g = Math.max(1, Math.round(group));
  const groups = trivial ? 0 : Math.ceil(drawn / g);
  // One quad per group of lines, plus one per group of changed lines.
  const changed = trivial ? [] : bandRows(code.diff);
  const cap = groups + changed.length;
  const positions = new Float32Array(cap * 8);
  const colors = new Uint8Array(cap * 16);
  let q = 0;

  const pal = code.palette;
  const alpha = Math.round(236 * ink);
  // Reused across groups: covered columns per palette entry.
  const cover = new Float64Array(Math.max(1, pal.length / 3));
  for (let gi = 0; gi < groups; gi++) {
    const from = gi * g;
    const to = Math.min(drawn, from + g);
    cover.fill(0);
    let maxEnd = 0;
    let best = -1;
    let bestCover = 0;
    for (let line = from; line < to; line++) {
      const a0 = code.lineRunStart[line];
      const a1 = code.lineRunStart[line + 1];
      for (let i = a0; i < a1; i++) {
        const startCol = code.runs[i * 3];
        if (startCol >= TEXT_COLS) continue;
        const len = Math.min(code.runs[i * 3 + 1], TEXT_COLS - startCol);
        if (len <= 0) continue;
        const ci = code.runs[i * 3 + 2];
        cover[ci] += len;
        if (cover[ci] > bestCover) { bestCover = cover[ci]; best = ci; }
        if (startCol + len > maxEnd) maxEnd = startCol + len;
      }
    }
    if (best < 0 || maxEnd <= 0) continue; // a run of blank lines is blank paper
    const y = lineTopY(s, to);
    const h = (to - from) * s.rowH;
    const ci = best * 3;
    pushQuad(
      positions, colors, q++,
      s.textX, y, maxEnd * s.colW, h,
      pal[ci], pal[ci + 1], pal[ci + 2], alpha
    );
  }

  // The changed lines, grouped exactly like the bars so a one-line edit is
  // still a visible mark at this scale and never a sub-pixel flicker.
  const diffBands: DiffBand[] = [];
  const bandW = MARGIN_COLS * s.colW;
  const x = s.textX + s.textW;
  let lastGroup = -1;
  for (const row of changed) {
    if (row.line < 0 || row.line >= drawn) continue;
    const gi = Math.floor(row.line / g);
    if (gi === lastGroup) continue;
    lastGroup = gi;
    const to = Math.min(drawn, (gi + 1) * g);
    const h = (to - gi * g) * s.rowH;
    const y0 = Math.min(lineTopY(s, to), s.y + s.h - h);
    diffBands.push({
      file,
      line: gi * g,
      kind: row.kind,
      poly: [[x, y0], [x + bandW, y0], [x + bandW, y0 + h], [x, y0 + h]]
    });
  }

  return {
    file,
    s,
    rows: [0, drawn],
    soup: { count: q, positions: positions.subarray(0, q * 8), colors: colors.subarray(0, q * 16) },
    diffBands,
    quads: q
  };
}

/** Quads an aggregated build will cost, for the per-frame budget. */
export function aggregateQuads(s: Sheet, group: number): number {
  if (s.effectiveLines < TRIVIAL_LINES) return 0;
  return Math.ceil(s.lineCount / Math.max(1, group));
}

export interface Binary {
  length: number;
  startIndices: Uint32Array;
  attributes: {
    getPolygon: { value: Float32Array; size: number };
    getFillColor: { value: Uint8Array; size: number };
  };
}

/** Concatenate per-file soups into one binary polygon block. */
export function concatSoups(list: Soup[]): Binary {
  let total = 0;
  for (const s of list) total += s.count;
  const positions = new Float32Array(total * 8);
  const colors = new Uint8Array(total * 16);
  const startIndices = new Uint32Array(total + 1);
  let q = 0;
  for (const s of list) {
    positions.set(s.positions, q * 8);
    colors.set(s.colors, q * 16);
    q += s.count;
  }
  for (let i = 0; i <= total; i++) startIndices[i] = i * 4;
  return {
    length: total,
    startIndices,
    attributes: {
      getPolygon: { value: positions, size: 2 },
      getFillColor: { value: colors, size: 4 }
    }
  };
}
