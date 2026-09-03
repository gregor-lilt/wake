// Optional PNG rendering. sharp is an optional dependency: if it is not
// installed (or fails to load) the harness emits SVG only.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type SharpFn = (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };

async function loadSharp(): Promise<SharpFn | null> {
  try {
    const mod: unknown = await import('sharp');
    const candidate =
      typeof mod === 'object' && mod !== null && 'default' in mod
        ? (mod as { default: unknown }).default
        : mod;
    return typeof candidate === 'function' ? (candidate as SharpFn) : null;
  } catch {
    return null;
  }
}

export async function toPng(dir: string): Promise<string[]> {
  const sharp = await loadSharp();
  if (sharp === null) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.svg')) continue;
    try {
      const buf = await sharp(readFileSync(join(dir, name))).png().toBuffer();
      const png = name.replace(/\.svg$/, '.png');
      writeFileSync(join(dir, png), buf);
      out.push(png);
    } catch {
      // A single failed conversion is not worth failing the run over.
    }
  }
  return out;
}
