/**
 * A simulated Claude Code session, for the autopilot demo. Deterministic from
 * one seed: ~40 trips over 90 seconds, each trip a read of one city followed by
 * an edit of another, mostly inside one region, with occasional cross-region
 * jumps and occasional bursts of 5-8 edits inside a single directory.
 *
 * The real thing is fed by http hooks (PLAN.md section 11). The shape of the
 * event stream is the same: one normalised record per tool call, timestamped.
 */
import { makeRng } from './rng';
import type { Repo } from './repo';

export type EventKind = 'read' | 'edit' | 'write' | 'search' | 'run' | 'message' | 'subagent' | 'other';

/** How strongly an event lights up the city it lands on. */
export function heatOf(kind: EventKind): number {
  if (kind === 'edit' || kind === 'write') return 1;
  if (kind === 'run') return 0.75;
  return 0.45;
}

export interface SessionEvent {
  /** milliseconds from session start */
  t: number;
  kind: EventKind;
  /** file node index, or -1 for an event with no position on the map */
  file: number;
  trip: number;
  /** origin city of the trip, -1 when this event starts one */
  from: number;
  tool?: string;
  summary?: string;
  /** real wall-clock time, ISO, only on a replayed session */
  wallClock?: string;
  /** 1-based source range the tool call touched, only on a replayed session */
  lineStart?: number;
  lineEnd?: number;
  /**
   * The console's own fields (docs/design.md section 10), all optional: an
   * export without them falls back to `summary`. `title` is a short human
   * phrase for any tool event, `text` the agent's or the user's words on a
   * message, `command` the shell line on a run, `agentType` the kind of
   * subagent on a subagent event.
   */
  title?: string;
  text?: string;
  role?: 'assistant' | 'user';
  command?: string;
  agentType?: string;
}

export interface Session {
  events: SessionEvent[];
  duration: number;
  trips: number;
  crossRegionTrips: number;
  bursts: number;
  /**
   * 'timestamp' plays each event at its own `t`. 'cadence' ignores `t` and
   * plays one event every `cadenceMs`, which is the only way a real session
   * spanning days is watchable.
   */
  mode: 'timestamp' | 'cadence';
  cadenceMs: number;
  label: string;
}

export interface SessionSpec {
  seed?: number;
  trips?: number;
  duration?: number;
  crossRegionShare?: number;
  burstShare?: number;
}

export function buildSession(repo: Repo, spec: SessionSpec = {}): Session {
  const seed = spec.seed ?? 0x5e5510;
  const targetTrips = spec.trips ?? 40;
  const duration = spec.duration ?? 90_000;
  const crossShare = spec.crossRegionShare ?? 0.15;
  const burstShare = spec.burstShare ?? 0.18;
  const rng = makeRng(seed);

  const regionFiles: number[][] = repo.regionNames.map(() => []);
  for (let f = 0; f < repo.fileCount; f++) regionFiles[repo.fileRegion[f]].push(f);
  const hostDirs = repo.dirs.filter((d) => d.files.length >= 6);
  const dirsByRegion: number[][] = repo.regionNames.map(() => []);
  for (const d of hostDirs) dirsByRegion[d.region].push(d.id);

  const events: SessionEvent[] = [];
  // Short gaps are the common case, long pauses the tail. 0.5 s to 3 s.
  const gap = () => 500 + rng.next() ** 2 * 2500;
  const pickIn = (dir: number) => repo.dirs[dir].files[rng.int(repo.dirs[dir].files.length)];

  let region = rng.int(repo.regionNames.length);
  let dir = dirsByRegion[region][rng.int(dirsByRegion[region].length)];
  let t = 800;
  let trip = 0;
  let cross = 0;
  let bursts = 0;

  while (trip < targetTrips) {
    // The agent drifts: it usually stays in the directory it is working in.
    if (rng.next() < 0.35) dir = dirsByRegion[region][rng.int(dirsByRegion[region].length)];
    const isCross = rng.next() < crossShare;
    const isBurst = !isCross && rng.next() < burstShare;

    const a = pickIn(dir);
    events.push({ t, kind: 'read', file: a, trip, from: -1 });
    t += gap();

    if (isBurst) {
      bursts++;
      const n = 5 + rng.int(4);
      for (let i = 0; i < n; i++) {
        events.push({ t, kind: 'edit', file: pickIn(dir), trip, from: i === 0 ? a : events[events.length - 1].file });
        t += 400 + rng.next() ** 2 * 900;
      }
    } else if (isCross) {
      cross++;
      let r2 = rng.int(repo.regionNames.length);
      if (r2 === region) r2 = (r2 + 1) % repo.regionNames.length;
      const d2 = dirsByRegion[r2][rng.int(dirsByRegion[r2].length)];
      events.push({ t, kind: 'edit', file: pickIn(d2), trip, from: a });
      t += gap();
      // A cross-region jump usually means the agent keeps working over there.
      if (rng.next() < 0.6) {
        region = r2;
        dir = d2;
      }
    } else {
      // Local trip: same directory, or a sibling under the same parent.
      const parent = repo.dirs[dir].parent;
      let d2 = dir;
      if (parent >= 0 && rng.next() < 0.45) {
        const sibs = repo.dirs[parent].children.filter((c) => repo.dirs[c].files.length >= 6);
        if (sibs.length > 0) d2 = sibs[rng.int(sibs.length)];
      }
      events.push({ t, kind: 'edit', file: pickIn(d2), trip, from: a });
      t += gap();
    }
    trip++;
  }

  // Scale the natural cadence onto the requested wall clock.
  const scale = duration / t;
  for (const e of events) e.t = Math.round(e.t * scale);

  return {
    events,
    duration,
    trips: trip,
    crossRegionTrips: cross,
    bursts,
    mode: 'timestamp',
    cadenceMs: 1500,
    label: 'synthetic session'
  };
}

export function pathOf(repo: Repo, file: number): string {
  return `${repo.dirs[repo.fileDir[file]].path}/${repo.fileName[file]}`;
}
