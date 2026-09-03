/**
 * Plays a simulated session on the map: emits events at their timestamps,
 * keeps the recent-touch window the follow camera aims at, animates one marker
 * per trip along its road, and keeps a decaying link volume per road so a
 * corridor the agent uses repeatedly widens and brightens (PLAN.md section 7).
 *
 * All of this is CPU side. Spike 2 replaces the fade and pulse with per-node
 * attributes evaluated against a uNow uniform.
 */
import type { Repo } from './repo';
import type { Layout } from './layout';
import { routePath } from './edges';
import type { Session, SessionEvent, EventKind } from './session';
import { heatOf } from './session';
import type { Pose } from './camera';
import { reducedMotion } from './motion';

export interface Touch { file: number; at: number; kind: EventKind; heat: number }

export interface HotTrip {
  key: string;
  from: number;
  to: number;
  path: Array<[number, number]>;
  volume: number;
  lastAt: number;
  startedAt: number;
  cross: boolean;
}

export interface Marker { position: [number, number]; radius: number; alpha: number }
export interface Pulse { position: [number, number]; radius: number; alpha: number }

const TOUCH_WINDOW = 10_000; // cities touched in this window must fit on screen
const FOLLOW_N = 3; // camera target is the centroid of the last N touches
const VOLUME_FADE = 20_000;
const MARKER_MS = 1400;
const PULSE_MS = 900;
/** Radius the arrival ring is drawn at when it may not expand. */
const PULSE_STATIC_R = 19;
const FIT_MARGIN = 0.8;
const MAX_HOT = 400;

export class Autopilot {
  paused = false;
  cursor = 0;
  loops = 0;
  /**
   * Replay the session again once it runs out. On by default, because the
   * demo is watched for minutes and a session is a few tens of events;
   * `?loop=0` lets it end, which is the idle state the agent card reports
   * (docs/design.md section 10).
   */
  loop = true;
  lastEvent: SessionEvent | null = null;
  touches: Touch[] = [];
  trips = new Map<string, HotTrip>();
  cadenceMs: number;
  private startedAt = 0;
  private pausedFor = 0;
  private pausedAt = 0;
  private endedAt = -1;

  constructor(
    private repo: Repo,
    private layout: Layout,
    private session: Session,
    /** [min, max] follow zoom, derived from the world extent by the caller */
    private zoomRange: [number, number],
    /** world units the follow box never shrinks below */
    private minExtent: number
  ) {
    this.cadenceMs = session.cadenceMs;
  }

  get eventCount(): number { return this.session.events.length; }

  /** The replay has run out of events and will not start over. */
  get ended(): boolean {
    return !this.loop && this.cursor >= this.session.events.length;
  }

  /** Something the follow camera would aim at: a touch inside the glow window. */
  hasTarget(now: number): boolean {
    for (const t of this.touches) if (now - t.at <= TOUCH_WINDOW) return true;
    return false;
  }

  /**
   * Ended, and with nothing left on the map: no touch the camera would
   * follow and no trip still carrying link volume. Everything has faded out
   * on its own clock by then, so the map holds no glow at all and the card
   * says so. The leftovers are dropped here, at zero, so nothing lingers.
   */
  idle(now: number): boolean {
    if (!this.ended) return false;
    if (this.hasTarget(now)) return false;
    for (const tr of this.trips.values()) if (Autopilot.heat(tr, now) > 0) return false;
    if (this.touches.length > 0) this.touches.length = 0;
    if (this.trips.size > 0) this.trips.clear();
    return true;
  }

  /**
   * Test hook: end the replay here and now, with every fade already expired.
   * Only the precondition, not the state under test: the card text and the
   * glow are still computed by the normal path.
   */
  endNow(): void {
    this.loop = false;
    this.cursor = this.session.events.length;
    this.touches.length = 0;
    this.trips.clear();
    this.endedAt = -1;
  }
  get mode(): 'timestamp' | 'cadence' { return this.session.mode; }
  get label(): string { return this.session.label; }

  /** `seekMs` starts the session part way in, for scripted screenshots. */
  start(now: number, seekMs = 0): void {
    this.startedAt = now - seekMs;
    this.pausedFor = 0;
    this.pausedAt = now;
    this.endedAt = -1;
    this.cursor = 0;
    this.loops = 0;
    this.lastEvent = null;
    this.touches.length = 0;
    this.trips.clear();
    if (this.session.mode === 'cadence') {
      this.seekTo(Math.floor(seekMs / this.cadenceMs), now);
      return;
    }
    while (this.cursor < this.session.events.length && this.session.events[this.cursor].t < seekMs) this.cursor++;
  }

  /**
   * Jump the replay to an event index. Link volumes and glows are recomputed
   * from a window of preceding events with backdated timestamps, so what the
   * map shows is what the session had built up at that point, already fading.
   */
  seekTo(index: number, now: number): void {
    const i = Math.max(0, Math.min(index, this.session.events.length));
    this.touches.length = 0;
    this.trips.clear();
    this.lastEvent = null;
    this.endedAt = -1;
    this.cursor = i;
    this.startedAt = now - i * this.cadenceMs;
    this.pausedFor = 0;
    this.pausedAt = now;
    const from = Math.max(0, i - 40);
    for (let j = from; j < i; j++) {
      this.apply(this.session.events[j], now - (i - j) * this.cadenceMs);
    }
  }

  /** Change replay speed without losing the position. */
  setCadence(ms: number, now: number): void {
    const pos = this.cursor;
    this.cadenceMs = ms;
    this.startedAt = now - pos * ms;
    this.pausedFor = 0;
    this.pausedAt = now;
  }

  /** Session times of the cross-region trips, for the screenshot script. */
  crossTripTimes(): number[] {
    const out: number[] = [];
    for (const e of this.session.events) {
      if (e.kind === 'edit' && e.from >= 0 && this.repo.fileRegion[e.from] !== this.repo.fileRegion[e.file]) out.push(e.t);
    }
    return out;
  }

  setPaused(paused: boolean, now: number): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pausedAt = now;
    else this.pausedFor += now - this.pausedAt;
  }

  /** Session clock in ms, excluding paused time. */
  clock(now: number): number {
    const held = this.paused ? now - this.pausedAt : 0;
    return now - this.startedAt - this.pausedFor - held;
  }

  /** Emit every event that is due. Loops the session. */
  tick(now: number): void {
    if (this.paused) return;
    const events = this.session.events;
    if (this.session.mode === 'cadence') {
      if (this.cursor >= events.length) {
        // Hold on the last frame for a beat, then start over. With looping off
        // the session simply ends and the map goes quiet.
        if (this.endedAt < 0) this.endedAt = now;
        else if (this.loop && now - this.endedAt > 2500) {
          this.loops++;
          this.seekTo(0, now);
        }
      } else {
        const due = Math.floor(this.clock(now) / this.cadenceMs);
        while (this.cursor < events.length && this.cursor <= due) {
          this.apply(events[this.cursor], now);
          this.cursor++;
        }
      }
      this.retire(now);
      return;
    }
    let t = this.clock(now);
    if (t >= this.session.duration + 1500 && this.loop) {
      // Restart, keeping the map state so volumes decay naturally.
      this.startedAt = now;
      this.pausedFor = 0;
      this.cursor = 0;
      this.loops++;
      t = 0;
    }
    while (this.cursor < events.length && events[this.cursor].t <= t) {
      this.apply(events[this.cursor], now);
      this.cursor++;
    }
    this.retire(now);
  }

  private retire(now: number): void {
    while (this.touches.length > 0 && now - this.touches[0].at > TOUCH_WINDOW * 3) this.touches.shift();
    if (this.trips.size > 0) {
      for (const [k, tr] of this.trips) if (now - tr.lastAt > VOLUME_FADE) this.trips.delete(k);
    }
  }

  private apply(e: SessionEvent, at: number): void {
    this.lastEvent = e;
    // Events with no file node (a message, a search, a shell command that
    // named nothing tracked) show in the HUD and nowhere on the map.
    if (e.file < 0) return;
    this.touches.push({ file: e.file, at, kind: e.kind, heat: heatOf(e.kind) });
    if (e.from < 0 || e.from === e.file) return;
    const key = `${e.from}|${e.file}`;
    const existing = this.trips.get(key);
    if (existing) {
      existing.volume += 1;
      existing.lastAt = at;
      existing.startedAt = at;
      return;
    }
    if (this.trips.size >= MAX_HOT) return;
    this.trips.set(key, {
      key,
      from: e.from,
      to: e.file,
      path: routePath(this.repo, this.layout, e.from, e.file),
      volume: 1,
      lastAt: at,
      startedAt: at,
      cross: this.repo.fileRegion[e.from] !== this.repo.fileRegion[e.file]
    });
  }

  /** Where the follow camera should be, or null before the first event. */
  /**
   * The pose one file is framed at, the same fit the follow camera uses.
   */
  private poseForFile(f: number, viewW: number, viewH: number): Pose {
    const w = Math.max(this.layout.cityRect[f * 4 + 2], this.minExtent);
    const h = Math.max(this.layout.cityRect[f * 4 + 3], this.minExtent);
    const fit = Math.log2(Math.min(viewW / w, viewH / h) * FIT_MARGIN);
    return {
      x: this.layout.cityCentroid[f * 2],
      y: this.layout.cityCentroid[f * 2 + 1],
      zoom: Math.max(this.zoomRange[0], Math.min(this.zoomRange[1], fit))
    };
  }

  /**
   * Where the map opens with autopilot on: the current follow target when the
   * replay has already touched something (after a seek), otherwise the file of
   * the next mapped event, framed the same way. The loader reveals this pose,
   * so the demo starts where the agent is about to be instead of flying there
   * from fit-all after the splash has gone.
   */
  openingTarget(now: number, viewW: number, viewH: number): Pose | null {
    const following = this.followTarget(now, viewW, viewH);
    if (following) return following;
    for (let i = this.cursor; i < this.session.events.length; i++) {
      const f = this.session.events[i].file;
      if (f >= 0) return this.poseForFile(f, viewW, viewH);
    }
    return null;
  }

  followTarget(now: number, viewW: number, viewH: number): Pose | null {
    if (this.touches.length === 0) return null;
    const last = this.touches.slice(-FOLLOW_N);
    let cx = 0;
    let cy = 0;
    for (const t of last) {
      cx += this.layout.cityCentroid[t.file * 2];
      cy += this.layout.cityCentroid[t.file * 2 + 1];
    }
    cx /= last.length;
    cy /= last.length;

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of this.touches) {
      if (now - t.at > TOUCH_WINDOW) continue;
      const f = t.file;
      x0 = Math.min(x0, this.layout.cityRect[f * 4]);
      y0 = Math.min(y0, this.layout.cityRect[f * 4 + 1]);
      x1 = Math.max(x1, this.layout.cityRect[f * 4] + this.layout.cityRect[f * 4 + 2]);
      y1 = Math.max(y1, this.layout.cityRect[f * 4 + 1] + this.layout.cityRect[f * 4 + 3]);
    }
    if (!isFinite(x0)) {
      const f = last[last.length - 1].file;
      x0 = this.layout.cityRect[f * 4];
      y0 = this.layout.cityRect[f * 4 + 1];
      x1 = x0 + this.layout.cityRect[f * 4 + 2];
      y1 = y0 + this.layout.cityRect[f * 4 + 3];
    }
    const w = Math.max(x1 - x0, this.minExtent);
    const h = Math.max(y1 - y0, this.minExtent);
    const fit = Math.log2(Math.min(viewW / w, viewH / h) * FIT_MARGIN);
    return { x: cx, y: cy, zoom: Math.max(this.zoomRange[0], Math.min(this.zoomRange[1], fit)) };
  }

  markers(now: number): Marker[] {
    const out: Marker[] = [];
    for (const tr of this.trips.values()) {
      const age = now - tr.startedAt;
      if (age > MARKER_MS) continue;
      const p = age / MARKER_MS;
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      const n = tr.path.length - 1;
      const u = e * n;
      const i = Math.min(n - 1, Math.floor(u));
      const f = u - i;
      const a = tr.path[i];
      const b = tr.path[i + 1];
      out.push({
        position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
        radius: tr.cross ? 5.5 : 4,
        alpha: 1 - 0.35 * p
      });
    }
    return out;
  }

  pulses(now: number): Pulse[] {
    const out: Pulse[] = [];
    for (const tr of this.trips.values()) {
      const age = now - (tr.startedAt + MARKER_MS * 0.85);
      if (age < 0 || age > PULSE_MS) continue;
      const p = age / PULSE_MS;
      // The arrival ring is decoration over a mark the touch glow already
      // carries, so under prefers-reduced-motion it does not expand: one
      // radius, and it leaves on a fade (src/motion.ts). The trip marker
      // itself keeps moving, because the movement IS the information.
      out.push({
        position: [this.layout.cityCentroid[tr.to * 2], this.layout.cityCentroid[tr.to * 2 + 1]],
        radius: reducedMotion() ? PULSE_STATIC_R : 6 + 26 * p,
        alpha: 1 - p
      });
    }
    return out;
  }

  /** Roads with a live link volume, newest last so they draw on top. */
  hotRoads(): HotTrip[] {
    const out = [...this.trips.values()];
    out.sort((a, b) => a.lastAt - b.lastAt);
    return out;
  }

  static heat(tr: HotTrip, now: number): number {
    return Math.max(0, 1 - (now - tr.lastAt) / VOLUME_FADE);
  }
}
