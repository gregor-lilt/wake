/**
 * The loading splash: the first thing on screen, and the only thing, until
 * the map has a framed first frame. The look is assets/brand/splash-preview.html
 * (dark radial ground, icon, wordmark, tracked tagline, thin amber bar, one
 * status line, one footer hint); the styles live in splash.css, linked from
 * index.html so nothing flashes unstyled.
 *
 * The progress is real. Every step of the startup declares itself here before
 * it runs, the bar sits at the start of that step's weight band, and a step
 * that knows its own sub-progress (the tokenizer, over the visible files)
 * reports it. Nothing advances on a timer.
 *
 * `?nosplash=1` returns an inert instance: no element, no yields, no extra
 * work, so the bench and the playwright scripts measure the same startup they
 * always did.
 */

/** One step of the startup, with its share of the bar. */
export interface SplashStep {
  /** stable key, only for the log the tests read */
  key: string;
  /** relative share of the progress bar */
  weight: number;
}

/** Durations from docs/design.md section 1. */
const FADE_MS = 600;
/** Below this the splash would flicker, so it stays. */
const MIN_VISIBLE_MS = 400;

export interface StageLog {
  key: string;
  label: string;
  atMs: number;
  ms: number;
}

export class Splash {
  /** false when ?nosplash=1: every method is then a no-op. */
  readonly active: boolean;
  private el: HTMLElement | null = null;
  private fill: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private readonly t0 = performance.now();
  private steps: SplashStep[];
  private total: number;
  /** index of the running step, -1 before the first one */
  private at = -1;
  private skipped = false;
  private gone = false;
  /** what the status line said, and for how long, for the report and tests */
  readonly log: StageLog[] = [];

  constructor(opts: { enabled: boolean; steps: SplashStep[] }) {
    this.active = opts.enabled;
    this.steps = opts.steps;
    this.total = opts.steps.reduce((s, x) => s + x.weight, 0) || 1;
    if (!this.active) return;
    this.mount();
  }

  private mount(): void {
    const el = document.createElement('div');
    el.id = 'splash';
    el.innerHTML =
      '<div class="stack">' +
      '<img class="icon" src="/icon.svg" alt="" />' +
      '<div class="word">Wake</div>' +
      '<div class="tag">the map behind the agent</div>' +
      '<div class="bar"><i></i></div>' +
      '<div class="status"></div>' +
      '</div>' +
      '<div class="keys">press any key to skip · the map opens where the agent is</div>';
    document.body.appendChild(el);
    this.el = el;
    this.fill = el.querySelector('.bar i');
    this.statusEl = el.querySelector('.status');
    // A key or a click skips the fade. Before the map is ready there is
    // nothing to reveal yet, so the skip is remembered and applied the moment
    // the first frame is up.
    const skip = () => { this.skipped = true; if (this.el?.classList.contains('leaving')) this.remove(); };
    addEventListener('keydown', skip, { once: true });
    addEventListener('pointerdown', skip, { once: true });
  }

  /** Fraction of the bar filled by the steps before index `i`. */
  private startOf(i: number): number {
    let s = 0;
    for (let k = 0; k < i && k < this.steps.length; k++) s += this.steps[k].weight;
    return s / this.total;
  }

  private setBar(frac: number): void {
    if (this.fill) this.fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  }

  /**
   * Announce the step about to run and hand the browser a frame to paint it,
   * so the status line is on screen before the work blocks the thread. Inert
   * (and without the yield) when the splash is off.
   */
  async step(key: string, label: string): Promise<void> {
    const i = this.steps.findIndex((s) => s.key === key);
    const now = performance.now();
    this.closeLast(now);
    this.at = i;
    this.log.push({ key, label, atMs: Math.round(now - this.t0), ms: 0 });
    if (!this.active) return;
    if (this.statusEl) this.statusEl.textContent = label;
    this.setBar(this.startOf(i < 0 ? 0 : i));
    await paint();
  }

  private closeLast(now: number): void {
    const prev = this.log[this.log.length - 1];
    if (prev && prev.ms === 0) prev.ms = Math.round(now - this.t0 - prev.atMs);
  }

  /** Sub-progress inside the running step, 0..1. */
  within(frac: number): void {
    if (!this.active || this.at < 0) return;
    const step = this.steps[this.at];
    if (!step) return;
    this.setBar(this.startOf(this.at) + (Math.max(0, Math.min(1, frac)) * step.weight) / this.total);
  }

  /** Update the running step's own status text, keeping its bar band. */
  relabel(label: string): void {
    const prev = this.log[this.log.length - 1];
    if (prev) prev.label = label;
    if (this.active && this.statusEl) this.statusEl.textContent = label;
  }

  /**
   * Everything is loaded and the first framed frame is up: fill the bar, hold
   * the minimum display time so a fast load does not flicker, then fade out
   * over 600 ms. A key or a click during the fade removes it at once.
   */
  async finish(): Promise<void> {
    this.closeLast(performance.now());
    if (!this.active || this.gone) return;
    this.setBar(1);
    const left = MIN_VISIBLE_MS - (performance.now() - this.t0);
    if (left > 0) await sleep(left);
    if (this.skipped) { this.remove(); return; }
    this.el?.classList.add('leaving');
    await sleep(FADE_MS);
    this.remove();
  }

  private remove(): void {
    if (this.gone) return;
    this.gone = true;
    this.el?.remove();
    this.el = null;
  }
}

/** Resolve after the browser has painted the current DOM. */
function paint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
