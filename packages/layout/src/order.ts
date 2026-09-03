// Frozen sibling order.
//
// The order is consumed exactly once per child: it decides the sequence in
// which a child is first-fit into its region. After that the slot is frozen,
// so a later change to the order can never reorder anything that already
// exists. Two orders are implemented:
//
//   'size'     subtree bytes descending, then name ascending. Deterministic
//              from the tree alone, and descending-first-fit packs well.
//   'coupling' a greedy seriation over sibling-to-sibling relative-import
//              counts, so directories that import each other tend to border
//              each other (PLAN.md: "Sibling regions are ordered by coupling,
//              computed once and frozen"). Falls back to 'size' for siblings
//              with no coupling at all.

import { spawn } from 'node:child_process';
import type { DirNode, TreeNode } from './types.ts';
import { subtreeBytes } from './gitTree.ts';

export type OrderMode = 'size' | 'coupling';

/** dirPath -> (childName -> childName -> import count) */
export type CouplingMap = Map<string, Map<string, Map<string, number>>>;

function sizeOrder(dir: DirNode): string[] {
  const weight = new Map<string, number>();
  for (const c of dir.children) weight.set(c.name, subtreeBytes(c));
  return dir.children
    .map((c) => c.name)
    .sort((a, b) => (weight.get(b)! - weight.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
}

export function makeOrderFn(mode: OrderMode, coupling: CouplingMap | null) {
  const cache = new Map<string, string[]>();
  return (dir: DirNode): string[] => {
    const hit = cache.get(dir.path);
    if (hit && hit.length >= dir.children.length) return hit;
    const base = sizeOrder(dir);
    const out = mode === 'coupling' && coupling ? seriate(base, coupling.get(dir.path)) : base;
    cache.set(dir.path, out);
    return out;
  };
}

/**
 * Greedy chain seriation: start from the most-coupled sibling, then repeatedly
 * append the unplaced sibling with the strongest coupling to the one just
 * placed (ties broken by total coupling, then by the size order). Siblings
 * with no coupling keep their size order and go last.
 */
function seriate(
  base: string[],
  edges: Map<string, Map<string, number>> | undefined,
): string[] {
  if (!edges || edges.size === 0) return base;
  const rank = new Map(base.map((n, i) => [n, i] as const));
  const weight = (a: string, b: string): number =>
    (edges.get(a)?.get(b) ?? 0) + (edges.get(b)?.get(a) ?? 0);

  const total = new Map<string, number>();
  for (const name of base) {
    let t = 0;
    for (const other of base) if (other !== name) t += weight(name, other);
    total.set(name, t);
  }

  const coupled = base.filter((n) => (total.get(n) ?? 0) > 0);
  const isolated = base.filter((n) => (total.get(n) ?? 0) === 0);
  if (coupled.length === 0) return base;

  const remaining = new Set(coupled);
  const better = (a: string, b: string, prev: string | null): boolean => {
    const wa = prev ? weight(a, prev) : (total.get(a) ?? 0);
    const wb = prev ? weight(b, prev) : (total.get(b) ?? 0);
    if (wa !== wb) return wa > wb;
    const ta = total.get(a) ?? 0;
    const tb = total.get(b) ?? 0;
    if (ta !== tb) return ta > tb;
    return rank.get(a)! < rank.get(b)!;
  };

  const chain: string[] = [];
  let prev: string | null = null;
  while (remaining.size > 0) {
    let pick: string | null = null;
    for (const cand of remaining) if (pick === null || better(cand, pick, prev)) pick = cand;
    chain.push(pick!);
    remaining.delete(pick!);
    prev = pick!;
  }
  return [...chain, ...isolated];
}

// ---------------------------------------------------------------------------
// Coupling extraction.
//
// Reads the .ts/.tsx blobs of ONE commit through a single `git cat-file
// --batch` process, counts relative imports only, and keeps nothing but the
// aggregate sibling-to-sibling counts. Blob text never leaves this module.
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:\bfrom|\bimport|\brequire\()\s*['"](\.[^'"]*)['"]/g;

export interface CouplingResult {
  readonly coupling: CouplingMap;
  readonly edges: number;
  readonly filesScanned: number;
  readonly bytesScanned: number;
}

export async function extractCoupling(
  repo: string,
  sha: string,
  tree: DirNode,
): Promise<CouplingResult> {
  const files: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.kind === 'file') {
      if (/\.tsx?$/.test(n.path)) files.push(n.path);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(tree);

  const known = new Set(files);
  const coupling: CouplingMap = new Map();
  let edges = 0;
  let scanned = 0;
  let bytesScanned = 0;

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
            idx++;
            continue;
          }
          need = Number(header.split(' ')[2]);
          if (!Number.isFinite(need)) {
            fail(new Error('unparsable cat-file header'));
            return;
          }
        }
        if (buf.length < need + 1) break;
        const body = buf.subarray(0, need).toString('utf8');
        buf = buf.subarray(need + 1);
        bytesScanned += need;
        need = -1;
        const from = files[idx++];
        if (from !== undefined) {
          scanned++;
          countImports(from, body, known, coupling, () => edges++);
        }
      }
    });
    proc.on('error', fail);
    proc.on('close', () => done());
    for (const p of files) proc.stdin.write(`${sha}:${p}\n`);
    proc.stdin.end();
  });

  return { coupling, edges, filesScanned: scanned, bytesScanned };
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function resolveSpec(fromDir: string, spec: string, known: Set<string>): string | null {
  const parts = fromDir.length ? fromDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  if (parts.length === 0) return null;
  const base = parts.join('/');
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(cand)) return cand;
  }
  return null;
}

function countImports(
  from: string,
  text: string,
  known: Set<string>,
  coupling: CouplingMap,
  onEdge: () => void,
): void {
  const fromDir = dirname(from);
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const to = resolveSpec(fromDir, m[1]!, known);
    if (to === null || to === from) continue;
    creditLca(coupling, from, to, onEdge);
  }
}

/**
 * Walk up to the lowest common ancestor directory of the two files and credit
 * that ancestor's two children. This is exactly the granularity the seriation
 * consumes: sibling to sibling, at every level of the tree.
 */
function creditLca(coupling: CouplingMap, from: string, to: string, onEdge: () => void): void {
  const a = from.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= a.length || i >= b.length) return;
  const parent = a.slice(0, i).join('/');
  const ca = a[i]!;
  const cb = b[i]!;
  if (ca === cb) return;
  let byParent = coupling.get(parent);
  if (!byParent) {
    byParent = new Map();
    coupling.set(parent, byParent);
  }
  let row = byParent.get(ca);
  if (!row) {
    row = new Map();
    byParent.set(ca, row);
  }
  row.set(cb, (row.get(cb) ?? 0) + 1);
  onEdge();
}
