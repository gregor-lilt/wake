// The wake-index sidecar: build if missing, one index pass at startup, then
// `wake-index watch` as a child whose stdout names every changed file.
//
// Watch output (crates/wake-index/src/main.rs, cmd_watch), one line each:
//   watching <repo> (<n> known files), 1s debounce; ctrl-c to stop
//     <rel>: <n> symbols, <m> imports in <t>ms          changed or new file
//     deleted <rel> in <t>ms                            file gone
//   batch of <n> file(s) in <t>ms, peak rss <x> MiB     end of a debounce batch
//
// The watcher hashes every file it sees, so a Markdown edit still produces a
// "<rel>: 0 symbols, 0 imports" line; only an unchanged content hash is
// silent. Paths under .git/ are skipped by the watcher itself.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultDbPath } from '../../../packages/export/src/indexdb.ts';
import { runCapture, spawnLines, type LineProcess } from './runtime.ts';

export const WAKE_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const INDEX_BINARY = join(WAKE_ROOT, 'target', 'release', 'wake-index');

export { defaultDbPath };

export async function ensureIndexerBuilt(binary = INDEX_BINARY): Promise<void> {
  if (existsSync(binary)) return;
  console.log(`indexer          building ${binary} (cargo build --release)`);
  await runCapture('cargo', ['build', '--release'], join(WAKE_ROOT, 'crates', 'wake-index'));
  if (!existsSync(binary)) throw new Error(`cargo build finished but ${binary} is missing`);
}

/** One `wake-index index <repo>` pass. Cold or warm is the indexer's call. */
export async function indexOnce(repo: string, binary = INDEX_BINARY): Promise<string> {
  return runCapture(binary, ['index', repo]);
}

export interface WatchBatch {
  readonly changed: string[];
  readonly deleted: string[];
}

const CHANGED = /^ {2}(.+?): (\d+) symbols, (\d+) imports in [\d.]+ms$/;
const DELETED = /^ {2}deleted (.+) in [\d.]+ms$/;
const BATCH = /^batch of (\d+) file\(s\) in /;

/**
 * Start the watcher. `onBatch` fires once per debounce batch with the
 * repo-relative paths the indexer re-parsed or dropped. Resolves once the
 * watcher has announced itself (its database connection is then open, which
 * keeps the SQLite WAL sidecar files alive for our read-only reader).
 */
export async function startWatch(
  repo: string,
  onBatch: (batch: WatchBatch) => void,
  binary = INDEX_BINARY,
): Promise<LineProcess> {
  let ready: () => void = () => {};
  const announced = new Promise<void>((ok) => {
    ready = ok;
  });
  let changed: string[] = [];
  let deleted: string[] = [];
  const proc = await spawnLines(binary, ['watch', repo], (line) => {
    if (line.startsWith('watching ')) {
      console.log(`indexer          ${line}`);
      ready();
      return;
    }
    const c = CHANGED.exec(line);
    if (c) {
      changed.push(c[1]!);
      return;
    }
    const d = DELETED.exec(line);
    if (d) {
      deleted.push(d[1]!);
      return;
    }
    if (BATCH.test(line)) {
      const batch = { changed, deleted };
      changed = [];
      deleted = [];
      onBatch(batch);
    }
  });
  const timeout = new Promise<void>((_, fail) =>
    setTimeout(() => fail(new Error('wake-index watch did not start within 30 s')), 30_000).unref?.(),
  );
  await Promise.race([announced, timeout]);
  return proc;
}
