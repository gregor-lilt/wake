/** Deterministic PRNG. mulberry32: tiny, fast, good enough for a fixture. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    range: (a: number, b: number) => a + next() * (b - a),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    /** Standard normal via Box-Muller. */
    normal: () => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  };
}

export interface Rng {
  next(): number;
  int(n: number): number;
  range(a: number, b: number): number;
  pick<T>(xs: readonly T[]): T;
  normal(): number;
}
