/**
 * Wayfinding (docs/design.md section 7): everything that answers "where am I"
 * without moving the camera.
 *
 * Four pieces, all DOM, all positioned per frame from deck's own
 * `viewport.project` so they cannot drift from the canvas:
 *
 *   region labels   a region's name is drawn at the top-left of the
 *                   INTERSECTION of its rect with the viewport, not at its own
 *                   corner, so it slides along the border and stays on screen
 *                   while the user pans through the middle of a district.
 *                   Nested regions whose intersections share that corner stack
 *                   downward, parent above child. Visibility is by fit: full
 *                   name, then an ellipsis, then nothing, and never across its
 *                   own border.
 *   sticky headers  in the reading band, a sheet whose top edge has left the
 *                   screen keeps its file name on a translucent strip of the
 *                   paper colour at the top of its visible part, with the
 *                   enclosing scope of the first visible line under it. Where
 *                   a header and a region stack want the same corner the stack
 *                   collapses to its deepest name and the header moves below
 *                   it, so the two never overlap (see resolveCorner).
 *   jump bar        one line at the top centre in the district style, naming
 *                   the point at the viewport centre (or the focused file, or
 *                   the autopilot target) from the region down to the line.
 *                   Every crumb is a button that frames that level.
 *   edge marker     an arrow at the screen edge pointing at the agent's
 *                   current file when it is off screen, with its name.
 *
 * DOM rather than a TextLayer for the region labels because their anchor moves
 * with the camera every frame, which would rebuild the text attributes every
 * frame, and because a sticky label wants crisp text and a chevron affordance.
 * They are also the reason `main.ts` drops any file caption that would overlap
 * one: the GPU collision filter cannot see them.
 */
import type { PlaceItem } from './labels';
import { fitText, ADV_CAPS, ADV_MIXED, TRACK, FILE_SIZE, FIT_MIN_CHARS } from './labels';
import type { Theme } from './theme';

/** Pixel inset of a region name inside the corner it sticks to. */
export const REGION_PAD = 7;
export const REGION_MIN = 10;
export const REGION_MAX = 14;
/** Line box of a region name as a multiple of its size, so nothing clips. */
export const REGION_LINE = 1.25;
/** Gap between a parent's label and its child's when they stack. */
export const REGION_STACK_GAP = 1;
/** Most region labels in the DOM at once. */
const REGION_POOL = 64;
/** Most sticky file headers at once. */
const STICKY_POOL = 6;
/** Height of one row of a sticky header. */
const STICKY_ROW = 15;
/** How far the edge marker sits inside the viewport. */
const EDGE_INSET = 34;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Region name size from the district's on-screen width, 10 to 14 px. */
export const regionSize = (widthPx: number): number =>
  clamp(REGION_MIN + 4 * ((widthPx - 300) / 900), REGION_MIN, REGION_MAX);

export interface RegionLabel {
  dir: number;
  depth: number;
  /** the name as drawn, abbreviated if it had to be */
  text: string;
  full: string;
  size: number;
  priority: number;
  /** stack index at this corner: 0 is the outermost region */
  stack: number;
  /** the shared corner this label stacks at */
  group: string;
  /**
   * The stack at this corner collapsed to this one line because a sheet's
   * sticky header wanted the same corner: the shallower names are gone and
   * the jump bar carries them.
   */
  collapsed: boolean;
  /** true when the anchor is not the region's own top-left corner */
  sticky: boolean;
  /** the label's box in screen pixels */
  box: { x: number; y: number; w: number; h: number };
  /** the region's whole rect in screen pixels */
  rect: { x: number; y: number; w: number; h: number };
  /** the visible intersection in screen pixels */
  clip: { x: number; y: number; w: number; h: number };
}

/** One reading-band sheet whose header may stick. */
export interface StickyInput {
  file: number;
  name: string;
  /** the sheet in screen pixels, y down */
  sheet: { x: number; y: number; w: number; h: number };
  rowPx: number;
  /** zero-based first source line visible on screen */
  firstLine: number;
  /** "Class › method", or '' at module level */
  scope: string;
  /**
   * The sheet border's activity glow, 0..1. The strip has taken the sheet's
   * top edge over, so it carries the same ring (docs/design.md section 9).
   */
  glow: number;
}

export interface StickyLabel extends StickyInput {
  /** screen y the strip was placed at */
  y: number;
  text: string;
}

export type CrumbKind = 'region' | 'district' | 'file' | 'scope' | 'line';

export interface Crumb {
  text: string;
  kind: CrumbKind;
  /** directory id for a region or district crumb */
  dir?: number;
  /** file index for a file or scope crumb */
  file?: number;
  /** zero-based line for a scope or line crumb */
  line?: number;
}

export interface AgentTarget {
  file: number;
  name: string;
  /** the file's tile centre in world units */
  wx: number;
  wy: number;
}

export interface WayfindFrame {
  zoom: number;
  bounds: [number, number, number, number];
  project: (x: number, y: number) => [number, number];
  width: number;
  height: number;
  /** labels toggle: off hides the region labels and the sticky headers */
  labels: boolean;
  /** reading-band sheets, nearest the camera first */
  sticky: StickyInput[];
  crumbs: Crumb[];
  /** the agent's current file, when it should be pointed at from the edge */
  agent: AgentTarget | null;
}

export interface WayfindHandlers {
  /** frame a directory: fit to its rect */
  frameDir(dir: number): void;
  /** frame a file at the start of the reading band */
  frameFile(file: number, line: number | null): void;
  /** scroll to a symbol inside a file, keeping the current row height */
  scrollTo(file: number, line: number): void;
  /** fly to the agent's file */
  goAgent(file: number): void;
}

/**
 * A pooled region label. `last` is what was written to the DOM: style writes
 * are diffed, because with the pool full this loop is a few hundred property
 * assignments per frame and most of them do not change.
 */
interface RegionSlot {
  el: HTMLDivElement;
  text: HTMLSpanElement;
  last: { x: number; y: number; size: number; dir: number; sticky: number; hidden: boolean };
}
interface StickySlot { el: HTMLDivElement; name: HTMLDivElement; scope: HTMLDivElement }

export class Wayfinding {
  private root: HTMLDivElement;
  private regionRoot: HTMLDivElement;
  private stickyRoot: HTMLDivElement;
  private jump: HTMLDivElement;
  private edge: HTMLDivElement;
  private regionSlots: RegionSlot[] = [];
  private stickySlots: StickySlot[] = [];
  private jumpKey = '';
  private edgeKey = '';
  /** what the last frame drew, for the verification hooks */
  regions: RegionLabel[] = [];
  stickies: StickyLabel[] = [];
  crumbs: Crumb[] = [];
  edgeMarker: { file: number; name: string; x: number; y: number; angle: number } | null = null;
  /**
   * What the corner rule did this frame: one entry per sheet header that a
   * region stack yielded to, with the name that survived, the depths that were
   * dropped and where the header ended up. For the verification hooks.
   */
  cornerYields: Array<{
    file: number; dir: number; depth: number; dropped: number[];
    headerY: number; regionBottom: number;
  }> = [];

  constructor(
    parent: HTMLElement,
    private places: PlaceItem[],
    private theme: Theme,
    private handlers: WayfindHandlers
  ) {
    this.root = document.createElement('div');
    this.root.className = 'wf-root';
    this.regionRoot = document.createElement('div');
    this.regionRoot.className = 'wf-regions';
    this.stickyRoot = document.createElement('div');
    this.stickyRoot.className = 'wf-stickies';
    this.jump = document.createElement('div');
    this.jump.className = 'wf-jump';
    this.jump.id = 'wf-jump';
    this.edge = document.createElement('div');
    this.edge.className = 'wf-edge';
    this.edge.id = 'wf-edge';
    this.edge.hidden = true;
    this.edge.onclick = () => {
      if (this.edgeMarker) this.handlers.goAgent(this.edgeMarker.file);
    };
    this.root.append(this.regionRoot, this.stickyRoot, this.jump, this.edge);
    parent.appendChild(this.root);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.jumpKey = '';
  }

  // ------------------------------------------------------------- region names
  /**
   * Region labels for this frame. Anchored to the intersection of the region
   * with the viewport, stacked when nested regions share that corner, and
   * dropped when the visible part is too narrow for the name.
   */
  private buildRegions(p: WayfindFrame): RegionLabel[] {
    const scale = 2 ** p.zoom;
    const [bx0, by0, bx1, by1] = p.bounds;
    const out: RegionLabel[] = [];
    for (const it of this.places) {
      if (it.dir < 0) continue;
      const [x, y, w, h] = it.rect;
      const ix0 = Math.max(x, bx0);
      const ix1 = Math.min(x + w, bx1);
      const iy0 = Math.max(y, by0);
      const iy1 = Math.min(y + h, by1);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const size = regionSize(w * scale);
      const clipW = (ix1 - ix0) * scale;
      const clipH = (iy1 - iy0) * scale;
      // Vertically the label has to fit inside the visible part too, or it
      // would sit across the region's own border.
      if (clipH < size * REGION_LINE + 2 * REGION_PAD) continue;
      // Tracked caps: the letter-spacing counts toward the advance.
      const text = fitText(it.text, size, clipW - 2 * REGION_PAD, ADV_CAPS + TRACK);
      if (text === null) continue;
      const [sx, sy] = p.project(ix0, iy1);
      const [rx, ry] = p.project(x, y + h);
      out.push({
        dir: it.dir,
        depth: it.depth,
        text,
        full: it.text,
        size,
        priority: it.priority,
        stack: 0,
        group: '',
        collapsed: false,
        // The anchor is the region's own corner only when the corner is what
        // the viewport clipped to.
        sticky: Math.abs(sx - rx) > 0.5 || Math.abs(sy - ry) > 0.5,
        box: {
          x: sx + REGION_PAD,
          y: sy + REGION_PAD,
          w: text.length * size * (ADV_CAPS + TRACK),
          h: size * REGION_LINE
        },
        rect: { x: rx, y: ry, w: w * scale, h: h * scale },
        clip: { x: sx, y: sy, w: clipW, h: clipH }
      });
    }
    // Parent above child at a shared corner, and the shallower region wins
    // every collision (docs/design.md section 7).
    out.sort((a, b) => a.depth - b.depth || b.clip.w * b.clip.h - a.clip.w * a.clip.h || a.dir - b.dir);
    // Per shared corner: how many labels are already there and where the next
    // one goes, which is exactly one label height below the last.
    const stacks = new Map<string, { n: number; y: number }>();
    const kept: RegionLabel[] = [];
    for (const l of out) {
      const key = `${Math.round(l.box.x / 8)}|${Math.round(l.box.y / 8)}`;
      const st = stacks.get(key);
      l.group = key;
      if (st) {
        l.stack = st.n;
        l.box.y = st.y;
      }
      // A stacked label still may not cross its own bottom border.
      if (l.box.y + l.box.h > l.clip.y + l.clip.h - REGION_PAD) continue;
      // Two regions whose corners are near but not identical would otherwise
      // print over each other. A label that loses simply disappears. The
      // vertical test has no padding, because a stack is exactly one label
      // height apart and must survive it.
      let hidden = false;
      for (const o of kept) {
        if (l.box.x < o.box.x + o.box.w + 6 && l.box.x + l.box.w + 6 > o.box.x &&
            l.box.y < o.box.y + o.box.h && l.box.y + l.box.h > o.box.y) {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      stacks.set(key, { n: l.stack + 1, y: l.box.y + l.box.h + REGION_STACK_GAP });
      kept.push(l);
      if (kept.length >= REGION_POOL) break;
    }
    return kept;
  }

  private regionSlot(i: number): RegionSlot {
    while (this.regionSlots.length <= i) {
      const el = document.createElement('div');
      el.className = 'wf-region';
      const text = document.createElement('span');
      text.className = 't';
      const chev = document.createElement('i');
      chev.className = 'chev';
      el.append(text, chev);
      this.regionRoot.appendChild(el);
      this.regionSlots.push({
        el, text,
        last: { x: NaN, y: NaN, size: NaN, dir: -2, sticky: -1, hidden: false }
      });
    }
    return this.regionSlots[i];
  }

  // ------------------------------------------------------- sticky file header
  private stickySlot(i: number): StickySlot {
    while (this.stickySlots.length <= i) {
      const el = document.createElement('div');
      el.className = 'wf-sticky';
      const name = document.createElement('div');
      name.className = 'n';
      const scope = document.createElement('div');
      scope.className = 's';
      el.append(name, scope);
      this.stickyRoot.appendChild(el);
      this.stickySlots.push({ el, name, scope });
    }
    return this.stickySlots[i];
  }


  // ---------------------------------------------------------- corner clutter
  /**
   * A stacked set of sticky region names and a sheet's sticky file header can
   * want the same top-left corner in the reading band, and the region stack
   * used to simply paint over the header (correct by priority, cluttered in
   * practice: the labels phase logged it as a deviation for this pass).
   *
   * The rule: when a sheet header is directly beneath the region stack, within
   * the stack's own height, the STACK YIELDS. It collapses to a single line
   * carrying only the DEEPEST region name, because that is the one the file is
   * actually in and the jump bar already spells out the chain above it, and the
   * header moves down to just below that line. Nothing overlaps, and neither
   * piece of wayfinding is lost.
   *
   * Returns the region labels that survive; `stick` is moved in place.
   */
  private resolveCorner(regions: RegionLabel[], stick: StickyLabel[]): RegionLabel[] {
    this.cornerYields = [];
    if (regions.length === 0 || stick.length === 0) return regions;
    const groups = new Map<string, RegionLabel[]>();
    for (const r of regions) {
      const list = groups.get(r.group);
      if (list) list.push(r);
      else groups.set(r.group, [r]);
    }
    const dropped = new Set<RegionLabel>();
    for (const s of stick) {
      const h = (s.scope ? 2 : 1) * STICKY_ROW;
      for (const list of groups.values()) {
        const live = list.filter((r) => !dropped.has(r));
        if (live.length === 0) continue;
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const r of live) {
          x0 = Math.min(x0, r.box.x);
          x1 = Math.max(x1, r.box.x + r.box.w);
          y0 = Math.min(y0, r.box.y);
          y1 = Math.max(y1, r.box.y + r.box.h);
        }
        // The header is beneath the stack when the two boxes meet at all: the
        // strip spans the whole sheet, so this is the shared-corner test.
        const meets = x0 < s.sheet.x + s.sheet.w && x1 > s.sheet.x && y0 < s.y + h && y1 > s.y;
        if (!meets) continue;
        let deepest = live[0];
        for (const r of live) if (r.depth > deepest.depth) deepest = r;
        for (const r of live) if (r !== deepest) dropped.add(r);
        deepest.stack = 0;
        deepest.collapsed = live.length > 1;
        // The one line stays at the top of the stack, but never above its own
        // border: the corners in a stack agree only to within the stack key.
        deepest.box.y = Math.max(y0, deepest.clip.y + REGION_PAD);
        const bottom = deepest.box.y + deepest.box.h + REGION_STACK_GAP;
        s.y = Math.max(s.y, bottom);
        this.cornerYields.push({
          file: s.file,
          dir: deepest.dir,
          depth: deepest.depth,
          dropped: live.filter((r) => r !== deepest).map((r) => r.depth),
          headerY: s.y,
          regionBottom: bottom
        });
      }
    }
    return regions.filter((r) => !dropped.has(r));
  }

  // -------------------------------------------------------------- the update
  update(p: WayfindFrame): void {
    let regions = p.labels ? this.buildRegions(p) : [];

    // ---- sticky file names and scope rows ---------------------------------
    // Built before the region labels reach the DOM, because a header sharing
    // a corner with a region stack collapses it (see resolveCorner).
    const stick: StickyLabel[] = [];
    if (p.labels) {
      for (const s of p.sticky) {
        // Only when the page's own top edge has left the screen: otherwise the
        // caption above the tile is still visible and is the right place.
        if (s.sheet.y >= 0) continue;
        if (s.sheet.y + s.sheet.h < STICKY_ROW) continue;
        const text = fitText(s.name, FILE_SIZE, s.sheet.w - 12, ADV_MIXED);
        if (text === null) continue;
        stick.push({ ...s, y: 0, text });
        if (stick.length >= STICKY_POOL) break;
      }
    }
    regions = this.resolveCorner(regions, stick);
    // A header pushed down below a collapsed region name needs the room for it
    // inside its own sheet, or the strip would hang off the bottom of the page.
    this.stickies = stick.filter((l) => l.y + (l.scope ? 2 : 1) * STICKY_ROW <= l.sheet.y + l.sheet.h);

    this.regions = regions;
    for (let i = 0; i < this.regions.length; i++) {
      const l = this.regions[i];
      const s = this.regionSlot(i);
      const p0 = s.last;
      if (p0.hidden) { s.el.hidden = false; p0.hidden = false; }
      const x = Math.round(l.box.x * 10) / 10;
      const y = Math.round(l.box.y * 10) / 10;
      if (x !== p0.x) { s.el.style.left = `${x}px`; p0.x = x; }
      if (y !== p0.y) { s.el.style.top = `${y}px`; p0.y = y; }
      if (l.size !== p0.size) { s.el.style.fontSize = `${l.size.toFixed(2)}px`; p0.size = l.size; }
      if (l.dir !== p0.dir) {
        s.el.dataset.dir = String(l.dir);
        s.el.dataset.depth = String(l.depth);
        p0.dir = l.dir;
      }
      const st = l.sticky ? 1 : 0;
      if (st !== p0.sticky) { s.el.dataset.sticky = String(st); p0.sticky = st; }
      if (s.text.textContent !== l.text) s.text.textContent = l.text;
    }
    for (let i = this.regions.length; i < this.regionSlots.length; i++) {
      const s = this.regionSlots[i];
      if (!s.last.hidden) { s.el.hidden = true; s.last.hidden = true; }
    }

    // ---- the sticky headers reach the DOM ---------------------------------
    const drawn = this.stickies;
    for (let i = 0; i < drawn.length; i++) {
      const l = drawn[i];
      const slot = this.stickySlot(i);
      const rows = l.scope ? 2 : 1;
      slot.el.hidden = false;
      slot.el.style.left = `${l.sheet.x.toFixed(1)}px`;
      slot.el.style.top = `${l.y.toFixed(1)}px`;
      slot.el.style.width = `${l.sheet.w.toFixed(1)}px`;
      slot.el.style.height = `${rows * STICKY_ROW}px`;
      slot.el.style.background = this.theme.css.codeBg;
      slot.el.dataset.file = String(l.file);
      slot.el.dataset.line = String(l.firstLine + 1);
      const t = this.theme.traffic;
      slot.el.style.boxShadow = l.glow > 0.004
        ? `0 0 0 ${(2 + l.glow).toFixed(2)}px rgba(${t[0]},${t[1]},${t[2]},${l.glow.toFixed(3)})`
        : '';
      if (slot.name.textContent !== l.text) slot.name.textContent = l.text;
      slot.scope.hidden = !l.scope;
      if (slot.scope.textContent !== l.scope) slot.scope.textContent = l.scope;
    }
    for (let i = drawn.length; i < this.stickySlots.length; i++) {
      this.stickySlots[i].el.hidden = true;
    }

    this.updateJump(p);
    this.updateEdge(p);
  }

  // ---------------------------------------------------------------- jump bar
  private updateJump(p: WayfindFrame): void {
    this.crumbs = p.crumbs;
    const key = p.crumbs.map((c) => `${c.kind}:${c.text}:${c.dir ?? ''}:${c.file ?? ''}:${c.line ?? ''}`).join('>');
    if (key === this.jumpKey) return;
    this.jumpKey = key;
    this.jump.textContent = '';
    p.crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('i');
        sep.className = 'sep';
        sep.textContent = c.kind === 'line' ? '·' : '›';
        this.jump.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = `crumb ${c.kind}`;
      b.textContent = c.text;
      b.dataset.kind = c.kind;
      if (c.dir !== undefined) b.dataset.dir = String(c.dir);
      if (c.file !== undefined) b.dataset.file = String(c.file);
      if (c.line !== undefined) b.dataset.line = String(c.line);
      b.onclick = () => {
        if ((c.kind === 'region' || c.kind === 'district') && c.dir !== undefined) {
          this.handlers.frameDir(c.dir);
        } else if (c.kind === 'file' && c.file !== undefined) {
          this.handlers.frameFile(c.file, null);
        } else if (c.kind === 'scope' && c.file !== undefined && c.line !== undefined) {
          this.handlers.scrollTo(c.file, c.line);
        }
      };
      this.jump.appendChild(b);
    });
  }

  // ------------------------------------------------------------- edge marker
  private updateEdge(p: WayfindFrame): void {
    const a = p.agent;
    this.edgeMarker = null;
    if (!a) {
      if (!this.edge.hidden) this.edge.hidden = true;
      this.edgeKey = '';
      return;
    }
    const [ax, ay] = p.project(a.wx, a.wy);
    const cx = p.width / 2;
    const cy = p.height / 2;
    // On screen: the marker is not needed at all.
    if (ax >= 0 && ax <= p.width && ay >= 0 && ay <= p.height) {
      if (!this.edge.hidden) this.edge.hidden = true;
      this.edgeKey = '';
      return;
    }
    const dx = ax - cx;
    const dy = ay - cy;
    const hw = Math.max(1, p.width / 2 - EDGE_INSET);
    const hh = Math.max(1, p.height / 2 - EDGE_INSET);
    // Longest ray from the centre toward the file that stays inside the inset
    // viewport rect: the marker sits where it leaves the screen.
    const t = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
    const x = cx + dx * t;
    const y = cy + dy * t;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    this.edgeMarker = { file: a.file, name: a.name, x, y, angle };
    const key = `${a.file}|${Math.round(x)}|${Math.round(y)}`;
    this.edge.hidden = false;
    this.edge.style.left = `${x.toFixed(1)}px`;
    this.edge.style.top = `${y.toFixed(1)}px`;
    // The name goes on the side the file is not, so the arrow points outward
    // with the label behind it.
    this.edge.classList.toggle('flip', dx > 0);
    if (key !== this.edgeKey) {
      this.edgeKey = key;
      this.edge.dataset.file = String(a.file);
      this.edge.innerHTML =
        `<i class="arrow" style="transform:rotate(${angle.toFixed(1)}deg)"></i>` +
        `<span class="n"></span>`;
      const n = this.edge.querySelector('.n');
      if (n) n.textContent = a.name;
    }
  }
}

export { FIT_MIN_CHARS };
