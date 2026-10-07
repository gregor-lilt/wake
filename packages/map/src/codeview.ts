/**
 * The code half of the zoom ladder (docs/design.md sections 2, 3 and 8).
 *
 * One number decides everything, for every file at once: `rowPx`, the
 * on-screen height of one source line, `clamp(k * scale, 0, 18)`. The tier is
 * derived from it once per frame, with hysteresis, and applies to the whole
 * map:
 *
 *   schematic  rowPx under 9. The sheet is paper on the district and carries
 *              the file's minimap. Above rowPx 1 that is one bar per token run
 *              on its own row; below it, consecutive lines are grouped so a
 *              bar row is never thinner than a device pixel (schematic.ts
 *              `groupSizeOf`), which is what makes the schematic the tile's
 *              texture from the terrain band up. There is no tile-only tier.
 *   source     rowPx 9 and up: a pooled <pre> mounts on the same sheet with
 *              exactly that row height, so its lines sit on the schematic's
 *              rows whatever the file's length. The schematic under it fades
 *              as the source unblurs.
 *
 * ONLY the zoom decides the tier. Panning never does: an overlay that is up
 * stays up and repositions every frame, and leaves only when its sheet leaves
 * the viewport plus a margin or the zoom leaves the reading band. The at-rest
 * gate survives for MOUNTING a new overlay, so a fast pan across a district
 * does not churn the pool.
 *
 * Only the real-export path has source, so this module is inert on the
 * synthetic fixture.
 */
import type { Repo } from './repo';
import type { Layout, Rect } from './layout';
import type { Theme } from './theme';
import { CodeStore } from './code';
import type { CodeSource } from './code';
import {
  buildSchematic, buildAggregate, aggregateQuads, groupSizeOf, concatSoups, fillSoup,
  sheetOf, visibleRows, isNonCode, inkOf,
  rowPxOf, zoomForRowPx, maxZoomFor, bandOf, tierOf, lineTopY, foldMarkerRow,
  gutterCols, gutterSoup, GUTTER_MIN_ROW_PX,
  ROW_PX_READ, ROW_PX_MAX, TEXT_COLS, TRIVIAL_LINES, STUB_ALPHA
} from './schematic';
import {
  ROW_WORLD, CELL_WORLD, TILE_CELLS_W, effectiveLinesOf, tileCellsH, isFolded, FOLD_MARKER_ROWS
} from './lattice';
import type { Band, Binary, DiffBand, FileSchematic, Sheet, Soup, Tier } from './schematic';
import { OverlayPool, FADE_MS, OUT_MS, APPLY_MS, POOL } from './overlay';
import type { OverlayRequest } from './overlay';

/**
 * Camera has to be still this long before a NEW DOM overlay mounts. An overlay
 * that is already up is never gated on this: it stays mounted and repositions
 * every frame while the user pans (docs/design.md section 2).
 */
export const REST_MS = 150;
/** Files whose sheet is built at the per-line tiers, nearest the view centre. */
const MAX_SHEETS = 96;
/**
 * Sheets the aggregated tier will build. Every file in view gets one, which is
 * the point of the aggregation, but a pathological repository still has to
 * stop somewhere.
 */
const MAX_SHEETS_AGG = 8192;
/**
 * Quads the schematic may spend in one frame. The layout spike's budget from
 * docs/research: aggregation is what keeps the terrain band under it with
 * every file's sheet built.
 */
const QUAD_BUDGET = 78_000;
/**
 * Files whose bars are rebuilt while the squeeze is being released. Above the
 * ramp the geometry is camera independent again and everything is cached.
 */
const MAX_LIVE = 32;
/**
 * How far past the viewport an already-mounted source overlay is kept, as a
 * fraction of the viewport, so a pan does not drop and remount the sheet the
 * user is reading the moment its edge crosses the screen.
 */
export const OVERLAY_KEEP = 0.35;
/** Crossfade when the aggregation level changes: the fast duration. */
export const AGG_FADE_MS = 120;

export interface UpdateParams {
  now: number;
  zoom: number;
  bounds: [number, number, number, number];
  project: (x: number, y: number) => [number, number];
  /** ms since the last viewState change */
  stillMs: number;
  /** a pointer is down on the canvas: hide the overlays at once, no blur out */
  dragging: boolean;
  applied: Map<number, number>;
  /**
   * Live mode: the working tree on disk is the present, so every file's diff
   * has already landed, whether or not an edit event was seen for it (a
   * change made through the shell has none). Replay keeps the reveal.
   */
  diffsLanded?: boolean;
}

export interface CodeViewState {
  schematics: number;
  sheets: number;
  overlays: number;
  quads: number;
  tier: Tier | 'off';
  band: Band;
  rowPx: number;
  /** lines per aggregated bar row: 1 above rowPx 1 */
  group: number;
  /** tier flips since load. Only zoom may cause one. */
  tierChanges: number;
  /** aggregation-level steps since load */
  aggChanges: number;
  /** overlay slots taken and released since load, for the pan check */
  mounts: number;
  unmounts: number;
  fetched: number;
  tokenized: number;
  tokenMs: number;
}

export interface StickyInfo {
  file: number;
  /** the sheet in screen pixels, y down */
  sheet: { x: number; y: number; w: number; h: number };
  rowPx: number;
  /** zero-based first source line on screen */
  firstLine: number;
  drawnRows: number;
}

export interface SheetProbe {
  file: number;
  lineCount: number;
  /** world units per line */
  rowWorld: number;
  /** CSS pixels per line, the map's rowPx */
  rowPx: number;
  /** screen y of the top edge of line 0 */
  topPx: number;
  /** the sheet in screen pixels, y down */
  sheet: { x: number; y: number; w: number; h: number };
  /** the text box in screen pixels */
  text: { x: number; y: number; w: number; h: number };
  /** the file's tile in screen pixels */
  tile: { x: number; y: number; w: number; h: number };
  overflows: boolean;
  ramp: number;
  cols: number;
  nonCode: boolean;
  trivial: boolean;
  /** rows the tile holds, and the rows the content is allowed to use */
  tileRows: number;
  contentRows: number;
  /** rows actually drawn, capped at the sheet's rows */
  drawnRows: number;
  padRows: number;
  folded: boolean;
  /** effective lines the fold hides: the "+N lines" caption's N */
  hiddenLines: number;
  effectiveLines: number;
  /** row the fold marker's dashed rule sits on, -1 when the file is not folded */
  markerRow: number;
  stub: boolean;
}

export class CodeView {
  readonly enabled: boolean;
  /** the map's row height in world units, the k of rowPx = k * scale */
  readonly k: number;
  readonly maxZoom: number;
  private store: CodeStore | null = null;
  private pool: OverlayPool | null = null;
  /** bars whose geometry does not depend on the camera, keyed by file */
  private cache = new Map<number, FileSchematic>();
  /** aggregated bars, rebuilt whenever the group size steps */
  private aggCache = new Map<number, FileSchematic>();
  private aggCacheGroup = 1;
  private sheets = new Map<number, Sheet>();
  private setKey = '';
  private fills: Binary | null = null;
  private gutter: Binary | null = null;
  private bars: Binary | null = null;
  private barsFading: Binary | null = null;
  private fadeOpacity = 1;
  /** the aggregation level the bars in `bars` were built at */
  private group = 1;
  /** the previous aggregation level's bars, crossfading out */
  private barsPrev: Binary | null = null;
  private barsPrevAt = 0;
  private barsOpacity = 1;
  private barsPrevOpacity = 0;
  private bands: DiffBand[] = [];
  private staticFiles: number[] = [];
  private liveFiles: number[] = [];
  private quads = 0;
  private dirty = true;
  private readAtPx: number;
  private tier: Tier = 'schematic';
  private band: Band = 'terrain';
  private rowPx = 0;
  /** Verification counters: only zoom may change a tier, panning never does. */
  private tierChanges = 0;
  private aggChanges = 0;

  constructor(
    private repo: Repo,
    private layout: Layout,
    private theme: Theme,
    opts: {
      /** null when there is nothing to read source from: the dev fixture. */
      source: CodeSource | null;
      root: HTMLElement;
      onReady: () => void;
      /** bench override of the reading threshold */
      l3MinRowPx?: number;
    }
  ) {
    // The lattice fixes the row height: one cell is 10 lines tall, so this is
    // no longer fitted to the data (phase 1) but read off the geometry.
    this.k = ROW_WORLD;
    this.maxZoom = maxZoomFor(this.k);
    this.readAtPx = opts.l3MinRowPx ?? ROW_PX_READ;
    this.enabled = Boolean(opts.source && repo.filePath);
    if (!this.enabled || !opts.source) return;
    this.store = new CodeStore(
      opts.source,
      theme.name,
      (f) => repo.filePath?.[f] ?? null,
      () => {
        this.dirty = true;
        this.setKey = '';
        opts.onReady();
      }
    );
    this.pool = new OverlayPool(opts.root);
  }

  /**
   * An `invalidate` frame: the file changed on disk, so its text, its diff and
   * its tokens are refetched and every cached sheet of it is dropped.
   */
  invalidate(file: number): void {
    this.measured.delete(file);
    this.cache.delete(file);
    this.aggCache.delete(file);
    this.setKey = '';
    this.dirty = true;
    this.store?.invalidate(file);
  }

  /** Give up the overlay pool and the tokenizer worker. */
  destroy(): void {
    this.pool?.destroy();
    this.store?.destroy();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.cache.clear();
    this.aggCache.clear();
    this.setKey = '';
    this.dirty = true;
    this.store?.setTheme(theme.name);
  }

  private rectOf(f: number): Rect {
    return {
      x: this.layout.cityRect[f * 4],
      y: this.layout.cityRect[f * 4 + 1],
      w: this.layout.cityRect[f * 4 + 2],
      h: this.layout.cityRect[f * 4 + 3]
    };
  }

  /**
   * The file's effective line count as the export reported it, which is what
   * its tile's height was cut from. Deliberately NOT the loaded line count:
   * the tile is never resized to match what the renderer counts itself, so a
   * sheet never changes shape once it is on screen.
   */
  private linesOf(f: number): number {
    return Math.max(1, this.repo.fileLines[f]);
  }

  private sheetFor(f: number): Sheet {
    // The tile's height comes from the export's count, always. The caption's
    // hidden-line count uses the larger of the export's and the renderer's own
    // wrapped count, because the export reports a floor of 401 for a blob it
    // refused to read (packages/export/README.md) and "+1 lines" on a
    // thousand-line file would be a visible lie.
    const measured = this.measured.get(f) ?? 0;
    const lines = Math.max(this.linesOf(f), measured);
    return sheetOf(this.rectOf(f), lines, this.repo.fileFolded[f] === 1);
  }

  /**
   * Rows this file actually draws: its own line count, capped at the rows the
   * sheet can hold. The two agree whenever the renderer's wrapping agrees with
   * the exporter's, and `checkLines` warns when they do not.
   */
  private drawnRows(f: number, s: Sheet): number {
    const code = this.store?.get(f);
    return code ? Math.min(code.lineCount, s.lineCount) : s.lineCount;
  }

  /**
   * Cross-check the export's effective line count against the same formula
   * applied to the text that just arrived (long lines wrapped at the sheet's
   * columns). A disagreement is logged with both counts, once per file, and
   * changes nothing about the tile.
   */
  private checkLines(f: number): void {
    if (this.checked.has(f)) return;
    const code = this.store?.get(f);
    if (!code) return;
    this.checked.add(f);
    const want = this.linesOf(f);
    const got = effectiveLinesOf(code.lines);
    this.measured.set(f, got);
    const rec = { file: f, exported: want, wrapped: got, raw: code.lineCount };
    if (want !== got) {
      this.mismatches.push(rec);
      console.warn(
        `[wake] effective lines disagree for ${this.repo.filePath?.[f] ?? f}: ` +
        `export ${want}, wrapped at ${TEXT_COLS + 4} columns ${got} (${code.lineCount} raw lines). ` +
        'Keeping the export\'s tile.'
      );
    }
  }

  private checked = new Set<number>();
  private measured = new Map<number, number>();
  private mismatches: Array<{ file: number; exported: number; wrapped: number; raw: number }> = [];

  /** What the effective-line cross-check has found so far, for the tests. */
  lineAudit(): {
    checked: number;
    mismatches: Array<{ file: number; exported: number; wrapped: number; raw: number }>;
  } {
    return { checked: this.checked.size, mismatches: this.mismatches.slice(0, 20) };
  }

  /**
   * Every folded file's marker geometry, whether or not it has a sheet this
   * frame: the rows the tile holds, the rows the source may use, the row the
   * dashed rule sits on and the hidden-line count its caption shows.
   */
  foldInfo(): Array<{
    file: number; effectiveLines: number; tileRows: number; contentRows: number;
    textRows: number; markerRow: number; hidden: number; fits: boolean;
  }> {
    const out = [];
    for (let f = 0; f < this.repo.fileCount; f++) {
      if (this.repo.fileFolded[f] !== 1) continue;
      const s = this.sheetFor(f);
      const drawn = this.drawnRows(f, s);
      const markerRow = foldMarkerRow(s, drawn);
      out.push({
        file: f,
        effectiveLines: s.effectiveLines,
        tileRows: s.tileRows,
        contentRows: s.contentRows,
        textRows: s.lineCount,
        markerRow,
        hidden: s.hiddenLines,
        fits: markerRow + FOLD_MARKER_ROWS <= s.tileRows
      });
    }
    return out;
  }

  /** sheetOf on a hypothetical file of `effectiveLines`, for the geometry checks. */
  sheetProbe(effectiveLines: number, scale: number): Record<string, number> {
    const cells = tileCellsH(effectiveLines);
    const rect: Rect = { x: 0, y: 0, w: TILE_CELLS_W * CELL_WORLD, h: cells * CELL_WORLD };
    const s = sheetOf(rect, effectiveLines, isFolded(effectiveLines));
    return {
      effectiveLines,
      tileCells: cells,
      tileRows: s.tileRows,
      contentRows: s.contentRows,
      textRows: s.lineCount,
      padRows: s.padRows,
      rowPx: s.rowH * scale,
      tileHeightPx: rect.h * scale,
      contentHeightPx: s.contentRows * s.rowH * scale,
      textWidthPx: s.textW * scale,
      tileWidthPx: rect.w * scale,
      cols: s.cols,
      hiddenLines: s.hiddenLines
    };
  }

  /** Loaded line count, or null when the file is not in the store yet. */
  lineCountOf(file: number): number | null {
    return this.store?.get(file)?.lineCount ?? null;
  }

  /** First changed line of a loaded file, or -1. */
  firstChangedLineOf(file: number): number {
    const code = this.store?.get(file);
    if (!code) return -1;
    return firstChangedLine(code.diff.changed.keys(), code.diff.removals);
  }

  /**
   * Camera pose that lands on `file` at `rowPx` with `line` centred, which is
   * what a deep link, the focus gesture and the autopilot all use. Closed
   * form: at a given rowPx the sheet geometry of a file is fixed, so there is
   * no fixed point to iterate.
   */
  focusPose(file: number, line: number | null, rowPx = ROW_PX_READ): { x: number; y: number; zoom: number } {
    const px = Math.min(rowPx, ROW_PX_MAX);
    const s = this.sheetFor(file);
    const lines = s.lineCount;
    let at = line;
    if (at === null || at < 0) {
      at = this.firstChangedLineOf(file);
      if (at < 0) at = 0;
    }
    at = Math.max(0, Math.min(lines - 1, at));
    return {
      x: s.textX + s.textW / 2,
      y: lineTopY(s, at) - s.rowH / 2,
      zoom: zoomForRowPx(this.k, px)
    };
  }

  /** Sheet geometry of one file at the current camera, for tests. */
  probe(file: number): SheetProbe | null {
    const s = this.sheets.get(file);
    if (!s || !this.lastProject) return null;
    const p = this.lastProject;
    const tl = p(s.x, s.y + s.h);
    const br = p(s.x + s.w, s.y);
    const t0 = p(s.textX, s.topY);
    const it = p(s.inner.x, s.inner.y + s.inner.h);
    const ib = p(s.inner.x + s.inner.w, s.inner.y);
    const drawn = this.drawnRows(file, s);
    return {
      file,
      lineCount: s.lineCount,
      rowWorld: s.rowH,
      rowPx: s.rowH * this.lastScale,
      topPx: t0[1],
      sheet: { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] },
      text: { x: t0[0], y: t0[1], w: s.textW * this.lastScale, h: drawn * s.rowH * this.lastScale },
      tile: { x: it[0], y: it[1], w: ib[0] - it[0], h: ib[1] - it[1] },
      overflows: s.overflows,
      ramp: s.ramp,
      cols: s.cols,
      nonCode: isNonCode(this.repo.filePath?.[file] ?? null),
      trivial: s.effectiveLines < TRIVIAL_LINES,
      tileRows: s.tileRows,
      contentRows: s.contentRows,
      drawnRows: drawn,
      padRows: s.padRows,
      folded: s.folded,
      hiddenLines: s.hiddenLines,
      effectiveLines: s.effectiveLines,
      markerRow: s.folded ? foldMarkerRow(s, drawn) : -1,
      stub: s.effectiveLines < TRIVIAL_LINES
    };
  }

  /**
   * Audit: every quad of every sheet built this frame has to lie inside its
   * own sheet, and every bar inside the shared text box. Nothing about a file
   * is ever drawn outside its sheet (docs/design.md section 3), and this is
   * the check for it.
   */
  audit(limit = 20): {
    files: number;
    outside: number;
    worstPx: number;
    perFile: Array<{
      file: number; quads: number; outside: number; rowPx: number; lineCount: number;
      worstDxPx?: number; worstDyPx?: number; bbox?: number[]; sheet?: number[];
    }>;
  } {
    // Tolerance is 0.02 screen pixels, not an absolute world distance: the
    // world is tens of thousands of units across on this lattice and the quad
    // positions are float32, so exact equality with a tile edge is off by
    // ~0.001 world units. Anything a viewer could see is far above this.
    const eps = Math.max(1e-4, 0.02 / this.lastScale);
    let outside = 0;
    let worst = 0;
    const perFile: Array<{
      file: number; quads: number; outside: number; rowPx: number; lineCount: number;
      worstDxPx?: number; worstDyPx?: number; bbox?: number[]; sheet?: number[];
    }> = [];
    for (const b of this.lastBuilt.slice(0, limit)) {
      const s = b.s;
      const x0 = s.textX - eps;
      const x1 = s.textX + s.textW + eps;
      const yTop = s.y + s.h + eps;
      const yBot = s.y - eps;
      let bad = 0;
      let wdx = 0;
      let wdy = 0;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      const pos = b.soup.positions;
      for (let i = 0; i < b.soup.count * 4; i++) {
        const x = pos[i * 2];
        const y = pos[i * 2 + 1];
        const dx = Math.max(x0 - x, x - x1, 0);
        const dy = Math.max(y - yTop, yBot - y, 0);
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y); by1 = Math.max(by1, y);
        if (dx > 0 || dy > 0) {
          bad++;
          wdx = Math.max(wdx, dx * this.lastScale);
          wdy = Math.max(wdy, dy * this.lastScale);
          worst = Math.max(worst, Math.max(dx, dy) * this.lastScale);
        }
      }
      // The diff bands live in the sheet's right margin, so they are checked
      // against the sheet and not against the text box.
      for (const d of b.diffBands) {
        for (const [x, y] of d.poly) {
          const dx = Math.max(s.x - eps - x, x - (s.x + s.w + eps), 0);
          const dy = Math.max(y - yTop, yBot - y, 0);
          if (dx > 0 || dy > 0) {
            bad++;
            worst = Math.max(worst, Math.max(dx, dy) * this.lastScale);
          }
        }
      }
      outside += bad;
      perFile.push({
        file: b.file,
        quads: b.soup.count + b.diffBands.length,
        outside: bad,
        rowPx: s.rowH * this.lastScale,
        lineCount: s.lineCount,
        worstDxPx: Math.round(wdx * 100) / 100,
        worstDyPx: Math.round(wdy * 100) / 100,
        bbox: [bx0, by0, bx1, by1],
        sheet: [s.textX, s.y, s.textX + s.textW, s.y + s.h]
      });
    }
    return { files: perFile.length, outside, worstPx: worst, perFile };
  }

  /**
   * What the sticky file name and the sticky scope row need, for the sheets in
   * view nearest the camera first (docs/design.md section 7): the sheet in
   * screen pixels and the zero-based first source line that is on screen.
   * Empty outside the reading band, where there is nothing to stick.
   */
  stickyInfo(limit = 8): StickyInfo[] {
    const out: StickyInfo[] = [];
    if (!this.lastProject || this.band !== 'reading') return out;
    const p = this.lastProject;
    for (const f of this.sheetFiles()) {
      const s = this.sheets.get(f);
      if (!s) continue;
      const tl = p(s.x, s.y + s.h);
      const br = p(s.x + s.w, s.y);
      const t0 = p(s.textX, s.topY);
      const rowPx = s.rowH * this.lastScale;
      const drawn = this.drawnRows(f, s);
      // The overlay's own answer where it has one: with a diff on the page the
      // DOM rows and the sheet's rows are not the same sequence, and what the
      // gutter shows is what the header and the scope row have to agree with.
      const dom = this.pool?.lineAtScreenY(f, 0) ?? null;
      const first = dom !== null
        ? Math.max(0, Math.min(drawn - 1, dom))
        : Math.max(0, Math.min(drawn - 1, Math.floor((0 - t0[1]) / Math.max(rowPx, 1e-6))));
      out.push({
        file: f,
        sheet: { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] },
        rowPx,
        firstLine: first,
        drawnRows: drawn
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The file's source lines, or null before it is fetched and tokenized. */
  sourceLines(file: number): readonly string[] | null {
    return this.store?.get(file)?.lines ?? null;
  }

  /** Files with a sheet this frame, nearest first. */
  sheetFiles(): number[] {
    return [...this.staticFiles, ...this.liveFiles];
  }

  /**
   * The sheets built this frame as world rects, nearest first. The reading
   * band's trip clip needs them: a trip line ends at the sheet edge and never
   * crosses source (docs/design.md section 9), and the paper's own rect is
   * where it has to stop.
   */
  sheetBoxes(): Array<{ file: number; x: number; y: number; w: number; h: number }> {
    const out: Array<{ file: number; x: number; y: number; w: number; h: number }> = [];
    for (const f of this.sheetFiles()) {
      const s = this.sheets.get(f);
      if (s) out.push({ file: f, x: s.x, y: s.y, w: s.w, h: s.h });
    }
    return out;
  }

  /**
   * The files the opening view shows, nearest the centre of the viewport
   * first, that are not in the store yet. The loader tokenizes these before
   * it lifts the splash, so the map is revealed with its visible sheets
   * already syntax-coloured.
   */
  warmTargets(bounds: [number, number, number, number], limit: number): number[] {
    if (!this.enabled || !this.store) return [];
    const [x0, y0, x1, y1] = bounds;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const near: Array<{ f: number; d: number }> = [];
    const r = this.layout.cityRect;
    for (let f = 0; f < this.repo.fileCount; f++) {
      const x = r[f * 4];
      const y = r[f * 4 + 1];
      const w = r[f * 4 + 2];
      const h = r[f * 4 + 3];
      if (x + w < x0 || x > x1 || y + h < y0 || y > y1) continue;
      if (this.store.has(f) || this.repo.filePath?.[f] == null) continue;
      const dx = x + w / 2 - cx;
      const dy = y + h / 2 - cy;
      near.push({ f, d: dx * dx + dy * dy });
    }
    near.sort((a, b) => a.d - b.d);
    return near.slice(0, limit).map((n) => n.f);
  }

  /** Load and tokenize `files`, reporting progress. See CodeStore.whenReady. */
  async warmTokens(files: number[], onProgress: (done: number, total: number) => void): Promise<number> {
    if (!this.store || files.length === 0) return 0;
    return this.store.whenReady(files, onProgress);
  }

  private lastScale = 1;
  private lastProject: ((x: number, y: number) => [number, number]) | null = null;

  update(p: UpdateParams): void {
    if (!this.enabled || !this.store || !this.pool) return;
    const scale = 2 ** p.zoom;
    this.lastScale = scale;
    this.lastProject = p.project;
    const rowPx = rowPxOf(this.k, scale);
    this.rowPx = rowPx;
    this.band = bandOf(rowPx);
    // One tier for the whole map, from rowPx alone, with hysteresis. Nothing
    // else feeds this: panning cannot flip a tier (docs/design.md section 2).
    const prevTier = this.tier;
    this.tier = tierOf(this.tier, rowPx, this.readAtPx);
    if (this.tier !== prevTier) this.tierChanges++;
    // Below one pixel per row the bars are grouped, and the group size is a
    // step function of the zoom. It changes at discrete zooms, and the two
    // levels crossfade over the fast duration so nothing pops.
    const group = groupSizeOf(rowPx);
    if (group !== this.aggCacheGroup) {
      this.aggCache.clear();
      this.aggCacheGroup = group;
    }
    const [x0, y0, x1, y1] = p.bounds;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    // ---- candidates: files in view, nearest to the centre first -----------
    // Every file in view gets a sheet: the schematic is the tile's texture at
    // every band now. The aggregated tier is cheap enough to afford that, and
    // the quad budget below is what actually bounds the frame.
    const maxSheets = group > 1 ? MAX_SHEETS_AGG : MAX_SHEETS;
    // An overlay that is up survives this much slack past the viewport.
    const keepX = (x1 - x0) * OVERLAY_KEEP;
    const keepY = (y1 - y0) * OVERLAY_KEEP;
    const upNow = new Set(this.pool.activeFiles());
    const cand: Array<{ file: number; d2: number }> = [];
    const inMargin = new Set<number>();
    for (let f = 0; f < this.repo.fileCount; f++) {
      const x = this.layout.cityRect[f * 4];
      const y = this.layout.cityRect[f * 4 + 1];
      const w = this.layout.cityRect[f * 4 + 2];
      const h = this.layout.cityRect[f * 4 + 3];
      // The sheet IS the tile now, so a plain rect test is exact.
      const on = x + w >= x0 && x <= x1 && y + h >= y0 && y <= y1;
      if (!on) {
        // A mounted overlay is kept while its sheet is only just off screen.
        if (!upNow.has(f)) continue;
        if (x + w < x0 - keepX || x > x1 + keepX) continue;
        if (y + h < y0 - keepY || y > y1 + keepY) continue;
        inMargin.add(f);
      }
      const dx = x + w / 2 - cx;
      const dy = y + h - cy;
      cand.push({ file: f, d2: dx * dx + dy * dy });
    }
    // A mounted overlay is always a candidate, whatever the sheet budget says.
    cand.sort((a, b) => (upNow.has(b.file) ? 1 : 0) - (upNow.has(a.file) ? 1 : 0) || a.d2 - b.d2);
    if (cand.length > maxSheets) cand.length = maxSheets;

    const keep = new Set<number>();
    for (let i = 0; i < cand.length; i++) {
      keep.add(cand[i].file);
      this.store.request(cand[i].file, cand.length - i);
    }
    this.store.trim(keep, Math.max(120, keep.size + 32));

    // ---- sheets: one row height for all of them ---------------------------
    this.sheets.clear();
    const sheetList: Sheet[] = [];
    const fileOfSheet = new Map<Sheet, number>();
    let budget = QUAD_BUDGET;
    for (const c of cand) {
      const s = this.sheetFor(c.file);
      // The quad budget, spent nearest first. In the aggregated tier the cost
      // of a sheet is known in closed form, so this is exact rather than a
      // guess; at the per-line tiers MAX_SHEETS is the bound as before.
      if (group > 1) {
        const cost = aggregateQuads(s, group);
        if (budget - cost < 0 && sheetList.length > 0) break;
        budget -= cost;
      }
      this.sheets.set(c.file, s);
      sheetList.push(s);
      fileOfSheet.set(s, c.file);
      if (this.store.has(c.file)) this.checkLines(c.file);
    }
    // The paper: the sheet's fill is the code background, and the sheet is the
    // tile. Drawn for every candidate, loaded or not, so the page appears with
    // the tier and not one file at a time, and far to near, so a sheet that
    // has grown past its tile is drawn above its neighbours below.
    this.fills = sheetList.length > 0
      ? toBinary(fillSoup(
          sheetList.slice().reverse(),
          this.theme.sheetFill,
          // Stubs are not worth a page: 40% paper and no label below reading.
          (s) => (s.effectiveLines < TRIVIAL_LINES ? STUB_ALPHA : 1)
        ))
      : null;

    // The schematic band's half of the gutter: every tenth line as a small
    // dimmed bar in the sheet's left margin, and nothing at all below
    // GUTTER_MIN_ROW_PX, where it would not be legible.
    this.gutter =
      sheetList.length > 0 && rowPx >= GUTTER_MIN_ROW_PX && this.tier !== 'source'
        ? toBinary(gutterSoup(
            sheetList, (s) => this.drawnRows(fileOfSheet.get(s) ?? -1, s),
            this.theme.cityLabel, 0.35
          ))
        : null;

    // ---- source: readable rows, only zoom decides --------------------------
    // An overlay that is up stays up while the user pans and repositions from
    // the view matrix every frame. It leaves only when its sheet leaves the
    // viewport plus OVERLAY_KEEP, or when the zoom leaves the reading band
    // (which is `tier`, with its one pixel of hysteresis). The at-rest gate is
    // kept for MOUNTING a new sheet, so a fast pan does not churn the pool.
    const atRest = p.stillMs >= REST_MS;
    const wantSource: number[] = [];
    if (this.tier === 'source') {
      // Mounted first, so a pan can never lose the sheet under the pointer to
      // a newcomer taking the last slot.
      for (const c of cand) {
        if (!upNow.has(c.file) || !this.store.has(c.file)) continue;
        wantSource.push(c.file);
        if (wantSource.length >= POOL) break;
      }
      if (atRest) {
        for (const c of cand) {
          if (wantSource.length >= POOL) break;
          if (upNow.has(c.file) || inMargin.has(c.file)) continue;
          if (!this.store.has(c.file)) continue;
          wantSource.push(c.file);
        }
      }
    }

    // ---- overlays ---------------------------------------------------------
    // Ordered far to near, so the pool can stack the near ones on top.
    const wanted = new Set(wantSource);
    const d2Of = new Map(cand.map((c) => [c.file, c.d2]));
    const reqFiles = [...wantSource].sort((a, b) => (d2Of.get(b) ?? 0) - (d2Of.get(a) ?? 0));
    for (const f of this.pool.activeFiles()) if (!wanted.has(f)) reqFiles.push(f);
    const reqs: OverlayRequest[] = [];
    for (const f of reqFiles) {
      const code = this.store.get(f);
      const s = this.sheets.get(f);
      if (!code || !s) continue;
      const at = p.applied.get(f) ?? (p.diffsLanded ? -Infinity : undefined);
      const drawn = this.drawnRows(f, s);
      // The gutter takes the sheet's left margin plus what the line count
      // needs, and the 96-column text box moves right by exactly that, so it
      // still ends inside the 100-column sheet (docs/design.md section 7).
      const gcols = gutterCols(drawn);
      const tl = p.project(s.x + gcols * s.colW, s.topY);
      reqs.push({
        file: f,
        code,
        cols: TEXT_COLS,
        maxRows: drawn,
        fold: s.folded && drawn + FOLD_MARKER_ROWS <= s.tileRows
          ? { rows: FOLD_MARKER_ROWS, hidden: s.hiddenLines }
          : null,
        // The text box, pushed right by the gutter. Nothing is drawn outside
        // the sheet: gcols + TEXT_COLS is at most the sheet's own COLS.
        screen: { x: tl[0], y: tl[1], w: s.textW * scale },
        gutterPx: gcols * s.colW * scale,
        rowPx: s.rowH * scale,
        ink: inkOf(isNonCode(this.repo.filePath?.[f] ?? null)),
        appliedAgo: at === undefined ? null : p.now - at
      });
    }
    // Never an instant hide on a drag any more: the overlay is repositioned
    // from the same matrix deck.gl draws with, so it cannot lag the camera,
    // and the design asks it to stay on the page while the user pans.
    this.pool.update(reqs, wanted, p.now, false);

    const owners = this.pool.activeFiles();
    let cover = 0;
    for (const f of owners) cover = Math.max(cover, this.pool.coverage(f));
    this.fadeOpacity = 1 - cover;

    // ---- bars -------------------------------------------------------------
    // Below the ramp the geometry is camera independent and cached per file.
    // Inside the ramp the row height moves with the zoom, so the nearest
    // MAX_LIVE files are rebuilt over their visible rows only.
    const ownerSet = new Set(owners);
    const live: number[] = [];
    const statics: number[] = [];
    for (const c of cand) {
      if (!this.store.has(c.file)) continue;
      const s = this.sheets.get(c.file);
      if (!s) continue;
      // The sheet's geometry no longer follows the camera at all, so every
      // file's bars are cached. A file under a source overlay is the one
      // exception: its bars have to fade on their own layer while the source
      // unblurs.
      if (ownerSet.has(c.file) && live.length < MAX_LIVE) live.push(c.file);
      else statics.push(c.file);
    }

    this.bands = [];
    this.quads = 0;
    const key = `${statics.join(',')}|${this.theme.name}|g${group}`;
    if (key !== this.setKey || this.dirty) {
      this.setKey = key;
      this.dirty = false;
      this.cachedList = [];
      // Far to near, so the nearest sheet's bars end up on top.
      for (const f of [...statics].reverse()) {
        const built = this.staticOf(f, group);
        if (built) this.cachedList.push(built);
      }
      this.staticBinary = this.cachedList.length > 0
        ? concatSoups(this.cachedList.map((b) => b.soup))
        : null;
    }
    for (const b of this.cachedList) {
      this.quads += b.quads;
      if (!ownerSet.has(b.file)) this.bands.push(...b.diffBands);
    }

    const liveSoups: Soup[] = [];
    const fadeSoups: Soup[] = [];
    // Nearest first, for the audit and for the tests.
    const built: FileSchematic[] = this.cachedList.filter((b) => this.sheets.has(b.file));
    // Far to near, so the nearest file's bars are drawn last.
    for (const f of [...live].reverse()) {
      const code = this.store.get(f);
      const s = this.sheets.get(f);
      if (!code || !s) continue;
      const ink = inkOf(isNonCode(this.repo.filePath?.[f] ?? null));
      const b = group > 1
        ? buildAggregate(f, s, group, code, ink)
        : buildSchematic(f, s, visibleRows(s, p.bounds), code, this.repo, this.theme, ink);
      this.quads += b.quads;
      built.unshift(b);
      (ownerSet.has(f) ? fadeSoups : liveSoups).push(b.soup);
      if (!ownerSet.has(f)) this.bands.push(...b.diffBands);
    }
    this.lastBuilt = built;
    const bars = mergeBinaries(this.staticBinary, liveSoups);
    // The aggregation level is a step function of the zoom. When it steps, the
    // level that was on screen keeps drawing and the two crossfade over the
    // fast duration, so the texture never pops (docs/design.md section 2).
    if (group !== this.group) {
      this.aggChanges++;
      this.barsPrev = this.bars;
      this.barsPrevAt = p.now;
      this.group = group;
    }
    this.bars = bars;
    if (this.barsPrev) {
      const t = (p.now - this.barsPrevAt) / AGG_FADE_MS;
      if (t >= 1) {
        this.barsPrev = null;
        this.barsOpacity = 1;
        this.barsPrevOpacity = 0;
      } else {
        const e = t < 0 ? 0 : t;
        this.barsOpacity = e;
        this.barsPrevOpacity = 1 - e;
      }
    } else {
      this.barsOpacity = 1;
      this.barsPrevOpacity = 0;
    }
    this.barsFading = fadeSoups.length > 0 ? concatSoups(fadeSoups) : null;
    this.staticFiles = statics;
    this.liveFiles = live;
  }

  private cachedList: FileSchematic[] = [];
  private lastBuilt: FileSchematic[] = [];
  private staticBinary: Binary | null = null;

  private staticOf(f: number, group: number): FileSchematic | null {
    const s = this.sheets.get(f);
    if (!s) return null;
    // Two caches, because the aggregated build's geometry depends on the group
    // size and the per-line build's does not depend on the camera at all.
    const cache = group > 1 ? this.aggCache : this.cache;
    const hit = cache.get(f);
    if (hit && Math.abs(hit.s.rowH - s.rowH) < 1e-9 && Math.abs(hit.s.colW - s.colW) < 1e-9) return hit;
    const code = this.store?.get(f);
    if (!code) return null;
    const ink = inkOf(isNonCode(this.repo.filePath?.[f] ?? null));
    const built = group > 1
      ? buildAggregate(f, s, group, code, ink)
      : buildSchematic(f, s, [0, Math.min(s.lineCount, 900)], code, this.repo, this.theme, ink);
    cache.set(f, built);
    const limit = group > 1 ? MAX_SHEETS_AGG : 200;
    if (cache.size > limit) {
      for (const k of cache.keys()) {
        if (cache.size <= limit) break;
        if (!this.sheets.has(k)) cache.delete(k);
      }
    }
    return built;
  }

  layers(): {
    fills: Binary | null;
    gutter: Binary | null;
    bars: Binary | null;
    /** 1, except while two aggregation levels are crossfading */
    barsOpacity: number;
    /** the previous aggregation level, fading out over AGG_FADE_MS */
    barsPrev: Binary | null;
    barsPrevOpacity: number;
    barsFading: Binary | null;
    fadeOpacity: number;
    bands: DiffBand[];
  } {
    return {
      fills: this.fills,
      gutter: this.gutter,
      bars: this.bars,
      barsOpacity: this.barsOpacity,
      barsPrev: this.barsPrev,
      barsPrevOpacity: this.barsPrevOpacity,
      barsFading: this.barsFading,
      fadeOpacity: this.fadeOpacity,
      bands: this.bands
    };
  }

  hideOverlays(): void {
    this.pool?.hideAll(true);
  }

  /**
   * Bar quads per file this frame, for the terrain-texture check: at the world
   * fit every file's tile has to carry a schematic (docs/design.md section 2).
   * `pending` are the files with a sheet whose text has not arrived yet.
   */
  barQuads(): { group: number; files: number; withQuads: number; pending: number; quads: number;
    perFile: Array<{ file: number; quads: number; maxAlpha: number; nonCode: boolean }> } {
    const perFile: Array<{ file: number; quads: number; maxAlpha: number; nonCode: boolean }> = [];
    let withQuads = 0;
    let pending = 0;
    let quads = 0;
    for (const b of this.lastBuilt) {
      // The strongest quad of the sheet: 236 for code, half that for a
      // non-code sheet (docs/design.md section 3), on both build paths.
      let maxAlpha = 0;
      const col = b.soup.colors;
      for (let i = 3; i < b.soup.count * 16; i += 4) if (col[i] > maxAlpha) maxAlpha = col[i];
      perFile.push({
        file: b.file, quads: b.quads, maxAlpha,
        nonCode: isNonCode(this.repo.filePath?.[b.file] ?? null)
      });
      quads += b.quads;
      if (b.quads > 0) withQuads++;
    }
    const seen = new Set(this.lastBuilt.map((b) => b.file));
    for (const f of this.sheets.keys()) if (!seen.has(f)) pending++;
    return { group: this.group, files: this.sheets.size, withQuads, pending, quads, perFile };
  }

  /**
   * The source overlays that are up, with their sheet in screen pixels and
   * whether the sheet is still inside the viewport plus OVERLAY_KEEP. The pan
   * check reads this: an overlay inside the margin must never be released.
   */
  overlayInfo(width: number, height: number): Array<{
    file: number; sheet: { x: number; y: number; w: number; h: number }; inMargin: boolean;
    nonCode: boolean; style: { opacity: number; filter: string; state: 'in' | 'out' } | null;
  }> {
    const out: Array<{
      file: number; sheet: { x: number; y: number; w: number; h: number }; inMargin: boolean;
      nonCode: boolean; style: { opacity: number; filter: string; state: 'in' | 'out' } | null;
    }> = [];
    if (!this.pool || !this.lastProject) return out;
    const mx = width * OVERLAY_KEEP;
    const my = height * OVERLAY_KEEP;
    for (const f of this.pool.activeFiles()) {
      const s = this.sheets.get(f) ?? this.sheetFor(f);
      const tl = this.lastProject(s.x, s.y + s.h);
      const br = this.lastProject(s.x + s.w, s.y);
      const box = { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] };
      out.push({
        file: f,
        sheet: box,
        inMargin: box.x + box.w >= -mx && box.x <= width + mx &&
          box.y + box.h >= -my && box.y <= height + my,
        nonCode: isNonCode(this.repo.filePath?.[f] ?? null),
        style: this.pool.styleOf(f)
      });
    }
    return out;
  }

  /** Files whose text is not in the store yet, nearest the camera first. */
  missingSheets(): number[] {
    const out: number[] = [];
    for (const f of this.sheets.keys()) if (!this.store?.has(f)) out.push(f);
    return out;
  }

  state(): CodeViewState {
    const s = this.store?.stats ?? { fetched: 0, tokenized: 0, tokenMs: 0, failed: 0 };
    return {
      schematics: this.staticFiles.length + this.liveFiles.length,
      sheets: this.sheets.size,
      overlays: this.pool?.visible ?? 0,
      tier: this.enabled ? this.tier : 'off',
      band: this.band,
      rowPx: this.rowPx,
      group: this.group,
      tierChanges: this.tierChanges,
      aggChanges: this.aggChanges,
      mounts: this.pool?.mounts ?? 0,
      unmounts: this.pool?.unmounts ?? 0,
      quads: this.quads,
      fetched: s.fetched,
      tokenized: s.tokenized,
      tokenMs: s.tokenMs
    };
  }
}

const toBinary = (s: Soup): Binary => concatSoups([s]);

/** One polygon block from a cached binary plus this frame's live soups. */
function mergeBinaries(base: Binary | null, live: Soup[]): Binary | null {
  if (live.length === 0) return base;
  const soups: Soup[] = [];
  if (base) {
    soups.push({
      count: base.length,
      positions: base.attributes.getPolygon.value,
      colors: base.attributes.getFillColor.value
    });
  }
  soups.push(...live);
  return concatSoups(soups);
}

function firstChangedLine(changed: Iterable<number>, removals: Array<{ at: number }>): number {
  let first = Infinity;
  for (const l of changed) first = Math.min(first, l);
  for (const r of removals) first = Math.min(first, r.at);
  return first === Infinity ? -1 : first;
}

export { FADE_MS, OUT_MS, APPLY_MS, ROW_PX_READ, ROW_PX_MAX };
