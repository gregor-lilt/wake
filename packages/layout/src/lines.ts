// Effective line counts.
//
// A sheet's height is proportional to its EFFECTIVE line count, not its raw
// line count: a line longer than the sheet's 100 columns wraps, and a
// 250-column line is three lines on the page (docs/design.md section 3).
//
//     effectiveLines = sum over lines of ceil(max(1, length) / COLUMNS)
//
// An empty line still costs one row. Binary or unreadable content counts as 1.
//
// Two sources, one formula:
//   * `effectiveLinesOfText` for text already in hand (working-tree mode)
//   * `effectiveLinesOfBlobs` for a commit's blobs, through ONE
//     `git cat-file --batch`, cached by blob sha so a 50-commit replay reads
//     each blob exactly once.
//
// Blob text never leaves this module. Only the integer count does.

import { spawn } from 'node:child_process';

/** Sheet width in glyphs. docs/design.md section 3: fixed at 100. */
export const COLUMNS = 100;

/**
 * A blob this large cannot have fewer effective lines than the fold cap: each
 * effective line covers at most COLUMNS characters plus a newline, so
 * `bytes > cap * (COLUMNS + 1)` implies `effectiveLines > cap`. Such a blob is
 * folded whatever its exact count, so there is no reason to read it — which is
 * also what keeps the replay from streaming multi-megabyte generated files.
 */
export function alwaysFoldedAbove(foldCap: number): number {
  return foldCap * (COLUMNS + 1);
}

/** Extensions we are willing to call text without looking inside. */
const TEXT_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'cs', 'c', 'h', 'cc',
  'cpp', 'hpp', 'm', 'mm', 'swift', 'scala', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'proto', 'graphql', 'gql', 'html', 'htm', 'css', 'scss', 'less',
  'md', 'mdx', 'rst', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'lock', 'xml', 'svg', 'csv', 'tsv', 'snap', 'vue', 'svelte',
]);

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Cheap binary test: a NUL byte in the first 8 KB, like git's own. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/** The formula, on text. */
export function effectiveLinesOfText(text: string, columns = COLUMNS): number {
  let total = 0;
  let lineLen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      total += Math.ceil(Math.max(1, lineLen) / columns);
      lineLen = 0;
    } else {
      lineLen++;
    }
  }
  // A trailing fragment with no newline is still a line. A file that ends with
  // a newline does not get a phantom extra line.
  if (lineLen > 0) total += Math.ceil(lineLen / columns);
  return Math.max(1, total);
}

export function effectiveLinesOfBuffer(buf: Buffer): number {
  if (looksBinary(buf)) return 1;
  return effectiveLinesOfText(buf.toString('utf8'));
}

/**
 * Effective lines for one working-tree file. Unreadable, a directory, a
 * symlink to nowhere, or binary: 1. A text file too big to be anything but
 * folded returns `foldCap + 1`, which is a FLOOR and not a count: it says
 * "past the cap", which is all the layout needs.
 */
export function effectiveLinesOnDisk(
  absPath: string,
  size: number,
  foldCap: number,
  readFile: (p: string) => Buffer,
  readHead: (p: string, n: number) => Buffer,
): { lines: number; read: boolean } {
  if (size > alwaysFoldedAbove(foldCap)) {
    // Too big to be anything but folded — unless it is not text at all.
    try {
      if (looksBinary(readHead(absPath, 8192))) return { lines: 1, read: false };
    } catch {
      return { lines: 1, read: false };
    }
    return { lines: foldCap + 1, read: false };
  }
  try {
    return { lines: effectiveLinesOfBuffer(readFile(absPath)), read: true };
  } catch {
    return { lines: 1, read: false };
  }
}

export interface BlobRequest {
  readonly sha: string;
  readonly path: string;
  readonly size: number;
}

export interface BlobLinesResult {
  /** blob sha -> effective lines. */
  readonly lines: Map<string, number>;
  readonly blobsRead: number;
  readonly bytesRead: number;
  readonly blobsSkippedLarge: number;
}

/**
 * Effective lines for a set of blobs, through one `git cat-file --batch`.
 * `cache` is keyed by blob sha and is safe to reuse across commits: a blob sha
 * pins its content, so the count can never go stale. Blobs above
 * `alwaysFoldedAbove(foldCap)` are not read at all (see above); they are
 * folded if their extension says text and counted as 1 if it does not.
 */
export async function effectiveLinesOfBlobs(
  repo: string,
  requests: readonly BlobRequest[],
  foldCap: number,
  cache: Map<string, number> = new Map(),
): Promise<BlobLinesResult> {
  const big = alwaysFoldedAbove(foldCap);
  const want: BlobRequest[] = [];
  let blobsSkippedLarge = 0;
  const seen = new Set<string>();
  for (const r of requests) {
    if (cache.has(r.sha) || seen.has(r.sha)) continue;
    seen.add(r.sha);
    if (r.size > big) {
      cache.set(r.sha, TEXT_EXT.has(ext(r.path)) ? foldCap + 1 : 1);
      blobsSkippedLarge++;
      continue;
    }
    want.push(r);
  }

  let blobsRead = 0;
  let bytesRead = 0;
  if (want.length > 0) {
    await new Promise<void>((done, fail) => {
      const proc = spawn('git', ['-C', repo, 'cat-file', '--batch'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buf: Buffer = Buffer.alloc(0);
      let idx = 0;
      let need = -1;
      proc.stdout.on('data', (chunk: Buffer) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        for (;;) {
          if (need < 0) {
            const nl = buf.indexOf(10);
            if (nl < 0) break;
            const header = buf.subarray(0, nl).toString('utf8');
            buf = buf.subarray(nl + 1);
            if (header.endsWith(' missing')) {
              const r = want[idx++];
              if (r) cache.set(r.sha, 1);
              continue;
            }
            need = Number(header.split(' ')[2]);
            if (!Number.isFinite(need)) {
              fail(new Error('unparsable cat-file header'));
              return;
            }
          }
          if (buf.length < need + 1) break;
          const body = buf.subarray(0, need);
          buf = buf.subarray(need + 1);
          bytesRead += need;
          need = -1;
          const r = want[idx++];
          if (r) {
            cache.set(r.sha, effectiveLinesOfBuffer(body));
            blobsRead++;
          }
        }
      });
      proc.on('error', fail);
      proc.on('close', () => done());
      for (const r of want) proc.stdin.write(`${r.sha}\n`);
      proc.stdin.end();
    });
  }

  const lines = new Map<string, number>();
  for (const r of requests) lines.set(r.sha, cache.get(r.sha) ?? 1);
  return { lines, blobsRead, bytesRead, blobsSkippedLarge };
}
