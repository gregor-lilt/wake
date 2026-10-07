/** Automated fly-through. Four zoom levels, steady-state frame times only. */

export interface BenchPhase {
  name: string;
  zoom: number;
  frames: number;
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  fps: number;
  citiesInView: number;
  labelsDrawn: number;
  roadsInView: number;
  buildingsDrawn: number;
}

export interface BenchResult {
  startedAt: string;
  userAgent: string;
  devicePixelRatio: number;
  canvas: { width: number; height: number };
  fixture: Record<string, number>;
  phases: BenchPhase[];
  deckMetrics: Record<string, number> | null;
}

export interface BenchCtx {
  goto(level: 'continent' | 'country' | 'city' | 'street', ms: number): void;
  sample(ms: number): Promise<number[]>;
  snapshot(): { zoom: number; cities: number; labels: number; edges: number; buildings: number };
  fixture: Record<string, number>;
  canvas: { width: number; height: number };
  deckMetrics(): Record<string, number> | null;
  onPhase(name: string, done: number, total: number): void;
}

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runBench(ctx: BenchCtx): Promise<BenchResult> {
  const levels: Array<'continent' | 'country' | 'city' | 'street'> = ['continent', 'country', 'city', 'street'];
  const phases: BenchPhase[] = [];
  const FLY = 900;
  const SETTLE = 1100;
  const SAMPLE = 6000;
  for (let i = 0; i < levels.length; i++) {
    const name = levels[i];
    ctx.onPhase(name, i, levels.length);
    ctx.goto(name, FLY);
    await wait(FLY + SETTLE);
    const frames = await ctx.sample(SAMPLE);
    const snap = ctx.snapshot();
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / Math.max(frames.length, 1);
    phases.push({
      name,
      zoom: Number(snap.zoom.toFixed(3)),
      frames: frames.length,
      medianMs: Number(quantile(sorted, 0.5).toFixed(2)),
      p95Ms: Number(quantile(sorted, 0.95).toFixed(2)),
      meanMs: Number(mean.toFixed(2)),
      fps: Number((1000 / Math.max(mean, 0.001)).toFixed(1)),
      citiesInView: snap.cities,
      labelsDrawn: snap.labels,
      roadsInView: snap.edges,
      buildingsDrawn: snap.buildings
    });
  }
  ctx.onPhase('done', levels.length, levels.length);
  return {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    canvas: ctx.canvas,
    fixture: ctx.fixture,
    phases,
    deckMetrics: ctx.deckMetrics()
  };
}

export function formatBench(r: BenchResult): string {
  const head = 'level      zoom   med   p95  mean   fps  cities  labels   roads';
  const rows = r.phases.map((p) =>
    [
      p.name.padEnd(10),
      p.zoom.toFixed(2).padStart(5),
      p.medianMs.toFixed(1).padStart(5),
      p.p95Ms.toFixed(1).padStart(5),
      p.meanMs.toFixed(1).padStart(5),
      p.fps.toFixed(0).padStart(5),
      String(p.citiesInView).padStart(7),
      String(p.labelsDrawn).padStart(7),
      String(p.roadsInView).padStart(7)
    ].join(' ')
  );
  return [head, ...rows].join('\n');
}
