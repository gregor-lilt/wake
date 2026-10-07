/**
 * The source tier: a pooled DOM <pre> per file, positioned by the same camera
 * matrix deck.gl uses (viewport.project), never by transform: scale. Font size
 * comes from the projected row height, so glyphs stay crisp at every zoom and
 * the lines sit exactly on the schematic rows underneath.
 *
 * Rules from docs/research/05 section 8, as amended by the review of the
 * labels phase (docs/design.md section 2):
 *  - at most 8 elements, reused from a pool,
 *  - a NEW overlay mounts only while the camera is at rest, so a fast pan does
 *    not churn the pool, but one that is up STAYS up and repositions every
 *    frame while the user pans: only zoom changes a tier,
 *  - only the visible line range is in the DOM, so a 1000-line file costs the
 *    same as a short one.
 *
 * The transition is an unblur, not a crossfade: the <pre> mounts blurred and
 * slightly transparent and sharpens over 300 ms while the schematic rects
 * underneath fade out. Leaving reverses it in 120 ms, unless the camera is
 * being dragged, where it goes at once. `will-change: filter` is set only
 * while a transition runs, so a page at rest never keeps a blurred raster.
 * Nothing is ever scaled with a transform. Under `prefers-reduced-motion` the
 * unblur is a plain 120 ms opacity fade with no blur at all (src/motion.ts).
 *
 * The overlay is inert to input (pointer-events: none) so wheel, drag and
 * pinch reach the deck.gl canvas underneath. That rules out hover, so removed
 * lines stay inline in the standard unified-diff way rather than collapsing to
 * a marker that expands.
 *
 * The diff is the standard inline view. Before the replay reaches the file's
 * first edit, the overlay shows the pre-image (added lines withheld, removed
 * lines from the diff shown), which is a per-line reverse apply. When the edit
 * lands, the added rows slide in and the removed rows dim, driven numerically
 * from the event time so it is deterministic and screenshottable.
 */
import type { CodeFile } from './code';
import { FADE_COLS, FONT_RATIO, ADVANCE } from './schematic';
import { reducedMotion } from './motion';

/** unblur in */
export const FADE_MS = 300;
/** blur back out, when the camera moves without a drag */
export const OUT_MS = 120;
export const APPLY_MS = 600;
const BLUR_PX = 6;
const MIN_ALPHA = 0.6;
/** at most this many <pre> elements, from docs/research/05 section 8 */
export const POOL = 8;
const MAX_LINES = 400;
const MARGIN_LINES = 12;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

type RowKind = 'ctx' | 'add' | 'mod' | 'del';

interface Row {
  kind: RowKind;
  /** current-text line, -1 for a removed line */
  line: number;
  html: string;
}

/**
 * The gutter (docs/design.md section 7): the line number of every row, right
 * aligned in the sheet's left margin, dimmed, in the same monospace. A removed
 * line has no number of its own in the current text and gets a blank cell.
 */
const gutterCell = (line: number): string =>
  line < 0 ? '<i class="ln"></i>' : `<i class="ln">${line + 1}</i>`;

interface Slot {
  wrap: HTMLDivElement;
  pre: HTMLPreElement;
  file: number;
  key: string;
  /** 'in' is sharpening or sharp, 'out' is blurring away before being freed */
  state: 'in' | 'out';
  stateAt: number;
  /** alpha at the moment the slot started leaving */
  outFrom: number;
  /** last eased progress, 1 when fully sharp */
  eased: number;
  willChange: boolean;
  /** rows that animate when the edit lands */
  anim: HTMLElement[];
  animKind: RowKind[];
  lineHeight: number;
  /**
   * The current-text line of every DOM row, -1 for a removed line. The rows
   * are stacked sequentially, and the pre-image withholds added lines and puts
   * removed ones back, so the DOM row index is NOT the line index whenever the
   * file carries a diff. This is what makes the gutter and the sticky header
   * agree with what is actually on the screen.
   */
  lineOfRow: Int32Array;
  /** screen y of the first DOM row */
  topPx: number;
}

/** District-label style: small caps, tracked. The caption follows it. */
const trackCaption = (text: string): string =>
  esc(text.toUpperCase()).split('').join('\u2009');

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function lineHtml(code: CodeFile, line: number): string {
  const text = code.lines[line] ?? '';
  const r0 = code.lineRunStart[line];
  const r1 = code.lineRunStart[line + 1];
  if (r1 <= r0) return esc(text) || '​';
  let out = '';
  let col = 0;
  const pal = code.palette;
  for (let i = r0; i < r1; i++) {
    const start = code.runs[i * 3];
    const len = code.runs[i * 3 + 1];
    const ci = code.runs[i * 3 + 2] * 3;
    if (start > col) out += esc(text.slice(col, start));
    const rgb = `rgb(${pal[ci]},${pal[ci + 1]},${pal[ci + 2]})`;
    out += `<span style="color:${rgb}">${esc(text.slice(start, start + len))}</span>`;
    col = start + len;
  }
  if (col < text.length) out += esc(text.slice(col));
  return out || '​';
}

/**
 * Build the row list for one line range. `applied` decides whether the file's
 * diff has landed in the replay yet.
 */
function rows(code: CodeFile, from: number, to: number, applied: boolean): Row[] {
  const out: Row[] = [];
  const removalsAt = new Map<number, string[][]>();
  for (const r of code.diff.removals) {
    const list = removalsAt.get(r.at) ?? [];
    list.push(r.lines);
    removalsAt.set(r.at, list);
  }
  for (let line = from; line < to; line++) {
    const rem = removalsAt.get(line);
    if (rem) {
      for (const block of rem) {
        for (const text of block) out.push({ kind: 'del', line: -1, html: esc(text) || '​' });
      }
    }
    const change = code.diff.changed.get(line);
    if (change && !applied) continue; // pre-image: the added line is not there yet
    out.push({ kind: change ?? 'ctx', line, html: lineHtml(code, line) });
  }
  return out;
}

export interface OverlayRequest {
  file: number;
  code: CodeFile;
  /** columns the sheet is wide */
  cols: number;
  /**
   * The sheet's text box, projected to CSS pixels: `x` is its left edge, `y`
   * the top edge of line 0, `w` exactly `cols` glyph advances. The overlay has
   * no background of its own, the sheet underneath is the background.
   *
   * Since the gutter arrived the box is no longer at the schematic bars' own
   * left edge: it is pushed right by `gutterPx` so the line numbers have the
   * sheet's margin to sit in, and the 96 columns of text still end inside the
   * 100-column sheet.
   */
  screen: { x: number; y: number; w: number };
  /** width of the gutter in CSS pixels, to the left of `screen.x` */
  gutterPx: number;
  /** CSS pixels per source line: the map's rowPx, the same for every file */
  rowPx: number;
  /** rows the sheet can draw: the tile's rows, less the fold marker's */
  maxRows: number;
  /**
   * The fold marker, for a file past the cap: `rows` rows of the sheet after
   * the last drawn one, carrying a dashed rule and a "+hidden lines" caption
   * in the district-label style (docs/design.md section 3).
   */
  fold: { rows: number; hidden: number } | null;
  /** ink contrast, 0.5 for a non-code sheet */
  ink: number;
  /** ms since the file's diff was applied by the replay, or null */
  appliedAgo: number | null;
}

export class OverlayPool {
  private slots: Slot[] = [];
  private root: HTMLDivElement;
  visible = 0;
  /**
   * Slots taken and released since load. The pan check reads these: crossing
   * three files in the reading band must not release a single one.
   */
  mounts = 0;
  unmounts = 0;

  /** Take the pool's root, and every mounted slot with it, off the page. */
  destroy(): void {
    this.slots.length = 0;
    this.visible = 0;
    this.root.remove();
  }

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'wake-ov-root';
    parent.appendChild(this.root);
  }

  /**
   * Start every slot leaving. `instant` is for an active drag, where a blurred
   * ghost lagging behind the camera would look worse than nothing.
   */
  hideAll(instant = false): void {
    for (const s of this.slots) {
      if (instant) this.free(s);
      else this.leave(s, performance.now());
    }
    this.visible = this.slots.filter((s) => s.file >= 0).length;
  }

  private free(s: Slot): void {
    if (s.file >= 0) this.unmounts++;
    s.wrap.style.opacity = '0';
    s.wrap.style.visibility = 'hidden';
    s.wrap.style.filter = '';
    s.wrap.style.willChange = '';
    s.willChange = false;
    s.file = -1;
    s.key = '';
  }

  private leave(s: Slot, now: number): void {
    if (s.file < 0 || s.state === 'out') return;
    const minAlpha = reducedMotion() ? 0 : MIN_ALPHA;
    s.outFrom = minAlpha + (1 - minAlpha) * s.eased;
    s.state = 'out';
    s.stateAt = now;
  }

  /**
   * The source line the overlay actually draws at a screen y, which is what
   * the gutter shows there. Null when the file has no slot up.
   */
  lineAtScreenY(file: number, y: number): number | null {
    const s = this.slots.find((x) => x.file === file && x.lineOfRow.length > 0);
    if (!s || s.lineHeight <= 0) return null;
    const k = Math.floor((y - s.topPx) / s.lineHeight);
    for (let i = Math.max(0, k); i < s.lineOfRow.length; i++) {
      if (s.lineOfRow[i] >= 0) return s.lineOfRow[i];
    }
    return null;
  }

  /** Files that own a slot, sharpening, sharp or blurring away. */
  activeFiles(): number[] {
    return this.slots.filter((s) => s.file >= 0).map((s) => s.file);
  }

  /**
   * How much of the file the source overlay currently covers, 0..1. The
   * schematic underneath uses 1 - this as its own opacity, which is what makes
   * the unblur read as one movement rather than two.
   */
  coverage(file: number): number {
    const s = this.slots.find((x) => x.file === file);
    return s ? s.eased : 0;
  }

  /**
   * What the slot's element is showing right now, for the verification hooks:
   * the opacity carries the ink contrast, the filter is the blur (or none
   * under prefers-reduced-motion).
   */
  styleOf(file: number): { opacity: number; filter: string; state: 'in' | 'out' } | null {
    const s = this.slots.find((x) => x.file === file);
    if (!s) return null;
    return { opacity: parseFloat(s.wrap.style.opacity || '1'), filter: s.wrap.style.filter || 'none', state: s.state };
  }

  private slotFor(file: number, now: number, reenter: boolean): Slot {
    let s = this.slots.find((x) => x.file === file);
    if (!s) {
      s = this.slots.find((x) => x.file < 0);
      if (!s && this.slots.length < POOL) {
        const wrap = document.createElement('div');
        wrap.className = 'wake-ov';
        const pre = document.createElement('pre');
        wrap.appendChild(pre);
        this.root.appendChild(wrap);
        s = {
          wrap, pre, file: -1, key: '', state: 'in', stateAt: now, outFrom: 0,
          eased: 0, willChange: false, anim: [], animKind: [], lineHeight: 0,
          lineOfRow: new Int32Array(0), topPx: 0
        };
        this.slots.push(s);
      }
      if (!s) {
        s = this.slots[0]; // pool full: steal the one that has been up longest
        for (const x of this.slots) if (x.stateAt < s.stateAt) s = x;
      }
      if (s.file !== file) {
        s.file = file;
        s.key = '';
        s.state = 'in';
        s.stateAt = now;
        s.eased = 0;
        this.mounts++;
      }
      return s;
    }
    if (s.state === 'out' && reenter) {
      // Came back before it finished leaving: re-enter from where it is, so
      // the blur does not jump.
      const back = clamp01((s.outFrom - MIN_ALPHA) / (1 - MIN_ALPHA));
      s.state = 'in';
      s.stateAt = now - back * FADE_MS;
    }
    return s;
  }

  /**
   * Position and fill the pool for this frame. `reqs` carries every slot that
   * still needs positioning, including the ones on their way out; `wanted` is
   * the set that should be sharp.
   */
  update(reqs: OverlayRequest[], wanted: Set<number>, now: number, instantHide = false): void {
    for (const s of this.slots) {
      if (s.file >= 0 && !wanted.has(s.file)) {
        if (instantHide) this.free(s);
        else this.leave(s, now);
      }
    }
    this.visible = 0;
    const list = reqs.slice(0, POOL);
    for (let i = 0; i < list.length; i++) {
      const req = list[i];
      if (!wanted.has(req.file) && !this.slots.some((x) => x.file === req.file)) continue;
      const slot = this.slotFor(req.file, now, wanted.has(req.file));
      // `reqs` arrives ordered far to near, so the file the camera is on ends
      // up on top of the sheets it is unrolled over.
      slot.wrap.style.zIndex = String(i);
      this.render(slot, req, now);
      if (slot.state === 'in') this.visible++;
    }
    // Retire anything that finished leaving.
    for (const s of this.slots) {
      if (s.file >= 0 && s.state === 'out' && now - s.stateAt >= OUT_MS) this.free(s);
    }
  }

  private render(s: Slot, req: OverlayRequest, now: number): void {
    const { screen, code } = req;
    // The row height comes from the map, not from the file's own height on
    // screen, so every file's glyphs are the same size at a given zoom.
    const lineH = req.rowPx;
    const vh = window.innerHeight;
    const drawable = Math.min(code.lineCount, req.maxRows);
    const first = Math.max(0, Math.floor((-screen.y) / lineH) - MARGIN_LINES);
    const last = Math.min(drawable, Math.ceil((vh - screen.y) / lineH) + MARGIN_LINES, first + MAX_LINES);
    const applied = req.appliedAgo !== null;
    // The fold marker only goes in the DOM when the window reaches the end of
    // the drawn rows, because the rows are stacked from `first`.
    const fold = req.fold && last >= drawable ? req.fold : null;
    const key = `${first}-${last}-${applied ? 1 : 0}-${Math.round(lineH * 100)}-${fold ? fold.hidden : 0}`;

    if (key !== s.key) {
      s.key = key;
      s.wrap.dataset.file = String(req.file);
      s.wrap.dataset.first = String(first);
      const list = rows(code, first, Math.max(first, last), applied);
      const parts: string[] = [];
      for (const r of list) parts.push(`<div class="r ${r.kind}">${gutterCell(r.line)}${r.html}</div>`);
      if (fold) {
        parts.push(
          `<div class="r fold" style="height:${(fold.rows * lineH).toFixed(2)}px">` +
          `<u></u><b>${trackCaption(`+${fold.hidden.toLocaleString()} lines`)}</b></div>`
        );
      }
      s.pre.innerHTML = parts.join('');
      s.lineOfRow = new Int32Array(list.length);
      for (let i = 0; i < list.length; i++) s.lineOfRow[i] = list[i].line;
      s.anim = [];
      s.animKind = [];
      const kids = s.pre.children;
      for (let i = 0; i < Math.min(kids.length, list.length); i++) {
        const el = kids[i] as HTMLElement;
        const k = list[i].kind;
        if (k === 'del' || k === 'add' || k === 'mod') {
          s.anim.push(el);
          s.animKind.push(k);
        }
      }
    }

    // Font size follows the row height and nothing else. The box is exactly
    // `cols` columns wide and clips, so no glyph is ever drawn outside the
    // sheet, and the last FADE_COLS columns fade out.
    const fontPx = Math.max(1, lineH * FONT_RATIO);
    const fadePx = Math.max(1, FADE_COLS * lineH * ADVANCE);
    s.lineHeight = lineH;
    const wrap = s.wrap;
    wrap.style.visibility = 'visible';
    // The element spans the gutter and the text box, so the numbers scroll and
    // clip with the code and still sit inside the sheet.
    wrap.style.left = `${Math.round(screen.x - req.gutterPx)}px`;
    s.topPx = Math.round(screen.y + first * lineH);
    wrap.style.top = `${s.topPx}px`;
    wrap.style.width = `${Math.round(screen.w + req.gutterPx)}px`;
    const mask = `linear-gradient(to right, #000 calc(100% - ${fadePx.toFixed(1)}px), transparent 100%)`;
    wrap.style.maskImage = mask;
    wrap.style.webkitMaskImage = mask;
    s.pre.style.fontSize = `${fontPx.toFixed(2)}px`;
    s.pre.style.lineHeight = `${lineH.toFixed(2)}px`;
    // One glyph column of the gutter is the space before the code.
    s.pre.style.setProperty('--gutter', `${req.gutterPx.toFixed(2)}px`);
    s.pre.style.setProperty('--gutter-pad', `${(lineH * ADVANCE).toFixed(2)}px`);

    // The unblur. Sharpening in over FADE_MS, blurring away over OUT_MS.
    // Under prefers-reduced-motion it is a plain OUT_MS opacity fade from
    // zero, with no blur at all (src/motion.ts).
    const quiet = reducedMotion();
    const inMs = quiet ? OUT_MS : FADE_MS;
    const minAlpha = quiet ? 0 : MIN_ALPHA;
    const blurPx = quiet ? 0 : BLUR_PX;
    let alpha: number;
    let blur: number;
    let moving: boolean;
    if (s.state === 'in') {
      const e = easeOut(clamp01((now - s.stateAt) / inMs));
      s.eased = e;
      alpha = minAlpha + (1 - minAlpha) * e;
      blur = blurPx * (1 - e);
      moving = e < 1;
    } else {
      const e = easeOut(clamp01((now - s.stateAt) / OUT_MS));
      s.eased = 1 - e;
      alpha = s.outFrom * (1 - e);
      blur = blurPx * e;
      moving = true;
    }
    wrap.style.opacity = (alpha * req.ink).toFixed(3);
    wrap.style.filter = blur > 0.02 ? `blur(${blur.toFixed(2)}px)` : '';
    // will-change only while a transition runs: keeping it would leave the
    // element on its own blurred raster layer at rest.
    if (moving !== s.willChange) {
      s.willChange = moving;
      wrap.style.willChange = moving ? 'filter, opacity' : '';
    }

    // Apply animation, driven from the replay clock.
    const t = req.appliedAgo === null ? 0 : Math.max(0, Math.min(1, req.appliedAgo / APPLY_MS));
    for (let i = 0; i < s.anim.length; i++) {
      const el = s.anim[i];
      const kind = s.animKind[i];
      if (!applied) {
        // Pre-image: the file as it was before the agent touched it, which is
        // the current text with the added lines withheld and the removed lines
        // put back. It carries no diff marks at all: this file has not been
        // edited yet as far as the replay is concerned.
        el.style.height = '';
        el.style.opacity = '1';
        el.style.transform = '';
        el.classList.add('preimage');
        continue;
      }
      el.classList.remove('preimage');
      if (kind === 'del') {
        // The overlay takes no input, so there is no hover to expand a
        // collapsed marker. Removed lines stay inline, the standard unified
        // way, and only dim as the edit lands.
        el.style.height = '';
        el.style.transform = '';
        el.style.opacity = (1 - 0.45 * t).toFixed(3);
      } else if (t >= 1) {
        el.style.height = '';
        el.style.opacity = '';
        el.style.transform = '';
      } else {
        el.style.height = `${t * lineH}px`;
        el.style.opacity = String(t);
        el.style.transform = `translateX(${((1 - t) * -8).toFixed(1)}px)`;
      }
    }
  }
}
