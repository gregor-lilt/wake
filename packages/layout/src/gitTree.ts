// Build the layout input (a directory tree with file sizes) straight out of
// git, without ever checking a commit out. `git ls-tree -r -l <sha>` gives
// every path plus its blob size for any commit in O(tree size).

import { execFileSync } from 'node:child_process';
import type { Commit, DirNode, TreeNode } from './types.ts';

const SEP = '\u001f';
const MAX_BUFFER = 512 * 1024 * 1024;

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
}

/** Source-ish extensions used only to pick which commits to replay. */
const SOURCE_GLOBS = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs',
  '*.py', '*.css', '*.scss', '*.less', '*.html',
];

/**
 * The N most recent non-merge commits on the given branch that touch source
 * files, returned oldest first.
 */
export function listCommits(repo: string, branch: string, n: number): Commit[] {
  const out = git(repo, [
    'log', branch, '--no-merges', '-n', String(n),
    '--format=%H%x1f%ad%x1f%s', '--date=short',
    '--', ...SOURCE_GLOBS,
  ]);
  const commits: Commit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, date, subject] = line.split(SEP);
    if (!sha || !date) continue;
    commits.push({ sha, date, subject: subject ?? '' });
  }
  return commits.reverse();
}

export interface Entry {
  readonly path: string;
  readonly size: number;
  /** Blob sha, when the entry came from a git tree. Keys the line cache. */
  readonly sha?: string;
  /** Effective lines (lines.ts), when a caller has counted them. */
  readonly lines?: number;
}

/** Flat path+size listing of one commit. */
export function listTree(repo: string, sha: string): Entry[] {
  const out = git(repo, ['ls-tree', '-r', '-l', sha]);
  const entries: Entry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    // mode blob sha size
    if (meta[1] !== 'blob') continue;
    const size = Number(meta[3]);
    entries.push({
      path: line.slice(tab + 1),
      size: Number.isFinite(size) ? size : 0,
      sha: meta[2] ?? '',
    });
  }
  return entries;
}

/** Paths changed between two commits (name-only, no renames). */
export function changedPaths(repo: string, from: string, to: string): string[] {
  const out = git(repo, ['diff', '--name-only', from, to]);
  return out.split('\n').filter((l) => l.length > 0);
}

/**
 * Turn the flat listing into a directory tree. Children are left in the order
 * git produced them (byte-sorted by full path); the layout module imposes its
 * own frozen order, so tree order carries no meaning.
 */
export function buildTree(entries: Entry[]): DirNode {
  const root: DirNode = { kind: 'dir', name: '', path: '', children: [] };
  const dirs = new Map<string, DirNode>([['', root]]);

  const dirFor = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const node: DirNode = { kind: 'dir', name, path, children: [] };
    dirs.set(path, node);
    dirFor(parentPath).children.push(node);
    return node;
  };

  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const parent = dirFor(slash < 0 ? '' : e.path.slice(0, slash));
    parent.children.push({
      kind: 'file',
      name: slash < 0 ? e.path : e.path.slice(slash + 1),
      path: e.path,
      size: e.size,
      ...(e.lines === undefined ? {} : { effectiveLines: e.lines }),
    });
  }
  return root;
}

export function subtreeBytes(node: TreeNode): number {
  if (node.kind === 'file') return node.size;
  let total = 0;
  for (const c of node.children) total += subtreeBytes(c);
  return total;
}

