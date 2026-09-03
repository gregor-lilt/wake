/**
 * Autopilot camera: Cinemachine's FOLLOW / MANUAL / RECENTERING state machine
 * (docs/research/05-app-shell-and-animation.md section 6, PLAN.md section 8).
 *
 * FOLLOW uses a critically damped spring per axis, not a tween, so a new agent
 * event never restarts an animation and the camera never overshoots. Zoom is
 * damped in deck.gl zoom units, which are log2 of scale, so damping there is
 * exponential in scale. That is the van Wijk feel for the cheap: constant
 * relative zoom speed, no linear-in-scale rush at the end.
 *
 * Any user gesture goes to MANUAL immediately and resets the idle timer. After
 * `wait` seconds of no input the camera glides back over `time` seconds
 * (RECENTERING) and then resumes FOLLOW.
 *
 * Under `prefers-reduced-motion` the spring stays (a hard cut per agent event
 * would be worse than a glide) but its time constant drops to
 * `REDUCED_SMOOTH`, and the recentering glide is over in `REDUCED_RECENTER`.
 * See src/motion.ts.
 */
import { dampTime, reducedMotion, REDUCED_RECENTER } from './motion';

export type CamState = 'follow' | 'manual' | 'recentering';

export interface Pose {
  x: number;
  y: number;
  zoom: number;
}

export interface CamParams {
  /** seconds of no input before recentering starts */
  wait: number;
  /** seconds the recentering glide takes */
  time: number;
  /** smoothing time of the follow spring, seconds */
  followSmooth: number;
  zoomSmooth: number;
}

/** Unity's SmoothDamp. Critically damped, stable at any frame rate. */
function smoothDamp(cur: number, target: number, vel: number, smoothTime: number, dt: number): [number, number] {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  const nextVel = (vel - omega * temp) * exp;
  return [target + (change + temp) * exp, nextVel];
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export class AutopilotCamera {
  state: CamState = 'follow';
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private lastInputAt = -1e9;
  private recenterFrom: Pose = { x: 0, y: 0, zoom: 0 };
  private recenterStart = 0;

  constructor(public params: CamParams) {}

  /** Called from a native wheel / pointerdown / touchstart listener. */
  noteUserInput(now: number): void {
    this.lastInputAt = now;
    this.state = 'manual';
  }

  /** The "Follow" button: re-engage now, the spring does the rest. */
  engage(): void {
    this.state = 'follow';
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
  }

  /** Seconds left before recentering starts, or 0 when not waiting. */
  countdown(now: number): number {
    if (this.state !== 'manual') return 0;
    return Math.max(0, this.params.wait - (now - this.lastInputAt) / 1000);
  }

  label(now: number): string {
    if (this.state === 'follow') return 'following';
    if (this.state === 'recentering') return 'recentering';
    return `manual (recenter in ${this.countdown(now).toFixed(0)}s)`;
  }

  /**
   * Advance one frame. Returns the pose to apply, or null when the user owns
   * the camera and nothing should be written.
   */
  step(now: number, dtMs: number, current: Pose, target: Pose | null): Pose | null {
    const dt = Math.min(dtMs, 100) / 1000;
    if (!target) return null;

    if (this.state === 'manual') {
      if (now - this.lastInputAt >= this.params.wait * 1000) {
        this.state = 'recentering';
        this.recenterFrom = { ...current };
        this.recenterStart = now;
      }
      return null;
    }

    if (this.state === 'recentering') {
      const secs = reducedMotion() ? Math.min(this.params.time, REDUCED_RECENTER) : this.params.time;
      const p = Math.min(1, (now - this.recenterStart) / (secs * 1000));
      const e = easeInOut(p);
      const pose = {
        x: this.recenterFrom.x + (target.x - this.recenterFrom.x) * e,
        y: this.recenterFrom.y + (target.y - this.recenterFrom.y) * e,
        zoom: this.recenterFrom.zoom + (target.zoom - this.recenterFrom.zoom) * e
      };
      if (p >= 1) this.engage();
      return pose;
    }

    const follow = dampTime(this.params.followSmooth);
    const [x, vx] = smoothDamp(current.x, target.x, this.vx, follow, dt);
    const [y, vy] = smoothDamp(current.y, target.y, this.vy, follow, dt);
    const [z, vz] = smoothDamp(current.zoom, target.zoom, this.vz, dampTime(this.params.zoomSmooth), dt);
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    return { x, y, zoom: z };
  }
}
