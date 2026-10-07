/**
 * The replay timeline (PLAN.md section 12). A thin bar along the bottom edge,
 * right of the agent console, present only when a finished session is being
 * replayed. Live mode has no timeline: the daemon is the clock.
 *
 *   [play] [2x]  ||||| |  |||||||||  | ||||  |||   12:24:54  17 / 42
 *
 * The track is the whole session as one tick per event, coloured by kind:
 * edits and writes in the accent, user prompts bright, reads and searches
 * dim, everything else faint. The part already played is lit, the rest is
 * dimmed. Click or drag anywhere on the track to scrub; the map rebuilds the
 * state at that event. Space plays and pauses, the arrow keys step one event.
 *
 * Same visual language as the agent console: opaque ground, hairline border,
 * small tracked caps for the chips. The ticks are drawn on one canvas so a
 * session of thousands of events costs one element.
 */

export type TickKind = 'edit' | 'read' | 'run' | 'prompt' | 'say' | 'other';

export interface TimelineActions {
  setPaused(paused: boolean): void;
  scrub(index: number): void;
  setCadence(ms: number): void;
}

export interface TimelineHandles {
  setEvents(kinds: TickKind[], times: string[]): void;
  /** Events [0, n) have been applied. Event boundaries only. */
  setCursor(n: number): void;
  setPaused(paused: boolean): void;
  /** Repaint the ticks, for a theme change or a resize. */
  redraw(): void;
  readonly paused: boolean;
  /** Test hook. */
  state(): { cursor: number; events: number; paused: boolean; speed: string };
}

/** One event every this many ms at 1x, matching the export's own cadence. */
const BASE_CADENCE_MS = 1500;
const SPEEDS = [1, 2, 4, 8];

export function buildTimeline(root: HTMLElement, actions: TimelineActions): TimelineHandles {
  root.innerHTML = `
    <button class="tl-play" type="button" aria-label="Pause">❚❚</button>
    <button class="tl-speed" type="button" aria-label="Replay speed">1x</button>
    <div class="tl-track" role="slider" aria-label="Session timeline" tabindex="-1">
      <canvas class="tl-ticks"></canvas>
      <div class="tl-head"></div>
    </div>
    <span class="tl-time"></span>
    <span class="tl-count"></span>`;
  const play = root.querySelector<HTMLButtonElement>('.tl-play')!;
  const speed = root.querySelector<HTMLButtonElement>('.tl-speed')!;
  const track = root.querySelector<HTMLDivElement>('.tl-track')!;
  const ticks = root.querySelector<HTMLCanvasElement>('.tl-ticks')!;
  const head = root.querySelector<HTMLDivElement>('.tl-head')!;
  const time = root.querySelector<HTMLSpanElement>('.tl-time')!;
  const count = root.querySelector<HTMLSpanElement>('.tl-count')!;

  let kinds: TickKind[] = [];
  let times: string[] = [];
  let cursor = 0;
  let paused = false;
  let speedIx = 0;
  let drawnCursor = -1;

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = track.clientWidth;
    const h = track.clientHeight;
    if (w === 0 || h === 0) return;
    if (ticks.width !== Math.round(w * dpr) || ticks.height !== Math.round(h * dpr)) {
      ticks.width = Math.round(w * dpr);
      ticks.height = Math.round(h * dpr);
    }
    const ctx = ticks.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(root);
    const accent = css.getPropertyValue('--accent').trim() || '#ffb050';
    const fg = css.getPropertyValue('--fg').trim() || '#e6e6e6';
    const n = kinds.length;
    if (n === 0) return;
    const step = w / n;
    const bar = Math.max(1, Math.min(3, step - 1));
    for (let i = 0; i < n; i++) {
      const k = kinds[i];
      const played = i < cursor;
      let color = fg;
      let tall = 0.3;
      let alpha = 0.35;
      if (k === 'edit') { color = accent; tall = 1; alpha = 1; }
      else if (k === 'prompt') { tall = 0.85; alpha = 0.9; }
      else if (k === 'read') { tall = 0.5; alpha = 0.5; }
      else if (k === 'run') { tall = 0.4; alpha = 0.45; }
      else if (k === 'say') { tall = 0.25; alpha = 0.3; }
      ctx.globalAlpha = played ? alpha : alpha * 0.32;
      ctx.fillStyle = color;
      const th = Math.max(3, Math.round(h * tall));
      ctx.fillRect(Math.floor(i * step + (step - bar) / 2), Math.round((h - th) / 2), bar, th);
    }
    ctx.globalAlpha = 1;
    drawnCursor = cursor;
  }

  function placeHead(): void {
    const n = kinds.length;
    const frac = n === 0 ? 0 : Math.min(1, cursor / n);
    head.style.left = `${(frac * 100).toFixed(3)}%`;
    time.textContent = times[Math.max(0, Math.min(n - 1, cursor - 1))] ?? '';
    count.textContent = `${Math.min(cursor, n)} / ${n}`;
    track.setAttribute('aria-valuenow', String(cursor));
    track.setAttribute('aria-valuemax', String(n));
    if (drawnCursor !== cursor) draw();
  }

  function setPausedUi(p: boolean): void {
    paused = p;
    play.textContent = p ? '▶' : '❚❚';
    play.setAttribute('aria-label', p ? 'Play' : 'Pause');
    root.classList.toggle('paused', p);
  }

  function indexAt(clientX: number): number {
    const r = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return Math.round(frac * kinds.length);
  }

  function scrubTo(i: number): void {
    const n = kinds.length;
    const clamped = Math.max(0, Math.min(n, i));
    actions.scrub(clamped);
    cursor = clamped;
    placeHead();
  }

  play.addEventListener('click', () => {
    setPausedUi(!paused);
    actions.setPaused(paused);
  });
  speed.addEventListener('click', () => {
    speedIx = (speedIx + 1) % SPEEDS.length;
    speed.textContent = `${SPEEDS[speedIx]}x`;
    actions.setCadence(BASE_CADENCE_MS / SPEEDS[speedIx]);
  });

  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    scrubTo(indexAt(e.clientX));
  });
  track.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const i = indexAt(e.clientX);
    if (i !== cursor) scrubTo(i);
  });
  const end = (): void => {
    dragging = false;
    root.classList.remove('dragging');
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
    if (t instanceof HTMLElement && t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      play.click();
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      scrubTo(cursor + 1);
    } else if (e.key === 'ArrowLeft' && e.shiftKey) {
      scrubTo(cursor - 1);
    }
  });

  new ResizeObserver(() => draw()).observe(track);

  return {
    setEvents(k, t) {
      kinds = k;
      times = t;
      root.hidden = k.length === 0;
      drawnCursor = -1;
      placeHead();
    },
    setCursor(n) {
      cursor = n;
      placeHead();
    },
    setPaused(p) {
      if (p !== paused) setPausedUi(p);
    },
    redraw() {
      drawnCursor = -1;
      draw();
    },
    get paused() { return paused; },
    state: () => ({ cursor, events: kinds.length, paused, speed: speed.textContent ?? '' })
  };
}
