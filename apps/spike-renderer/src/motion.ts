/**
 * One motion language (docs/design.md section 1) and the one exemption from
 * it: `prefers-reduced-motion`.
 *
 * The rule is not "no animation". Things that carry meaning keep moving and
 * things that only decorate stop:
 *
 *   camera flights   become instant jumps. A fly-to is a tween over a whole
 *                    screenful of map, which is exactly what the setting is
 *                    about, and the destination is the point of it.
 *   autopilot        keeps its critically damped spring, because a hard jump
 *                    per agent event would be worse than a glide, but with a
 *                    much shorter time constant, so it arrives in about a
 *                    tenth of the usual glide.
 *   the unblur       becomes a plain 120 ms opacity fade: no blur, no 300 ms
 *                    sharpening, and the schematic underneath still hands over
 *                    on the same clock.
 *   trip markers     still move. The marker riding a road IS the information:
 *                    which file the agent came from and which it went to.
 *   arrival pulses   stop expanding. The ring is decoration on top of a mark
 *                    the touch glow already carries, so it is drawn at one
 *                    radius and fades out instead of growing.
 *
 * The query is live: the setting can change while the page is open, so it is
 * read from the media query every time rather than latched at load, and
 * `onMotionChange` lets the camera drop its damping state when it flips.
 */

const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

let reduced = mq ? mq.matches : false;
const listeners = new Set<(reduced: boolean) => void>();

mq?.addEventListener('change', (e) => {
  reduced = e.matches;
  for (const fn of listeners) fn(reduced);
});

/** True while the user asks for reduced motion. */
export const reducedMotion = (): boolean => reduced;

export function onMotionChange(fn: (reduced: boolean) => void): void {
  listeners.add(fn);
}

/** A camera flight's duration: 0 under reduced motion, so it is a jump. */
export const flightMs = (ms: number): number => (reduced ? 0 : ms);

/** Smoothing time of the follow spring under reduced motion, seconds. */
export const REDUCED_SMOOTH = 0.09;
/** Seconds a recentering glide takes under reduced motion. */
export const REDUCED_RECENTER = 0.12;

/** A damping time constant, shortened under reduced motion but never zero. */
export const dampTime = (seconds: number): number =>
  (reduced ? Math.min(seconds, REDUCED_SMOOTH) : seconds);
