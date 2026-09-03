// Tree and rects: reuse @wake/layout for both the git tree and the stable
// geography. Nothing is checked out; `git ls-tree -r -l HEAD` gives every
// tracked path plus its blob size.

import { execFileSync } from 'node:child_process';
import { openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree, listTree, subtreeBytes } from '../../layout/src/gitTree.ts';
import { DEFAULT_CONFIG, LayoutState, layoutTree } from '../../layout/src/layout.ts';
import { effectiveLinesOfBlobs, effectiveLinesOnDisk } from '../../layout/src/lines.ts';
import { makeOrderFn } from '../../layout/src/order.ts';
import type { DirNode, TreeNode } from '../../layout/src/types.ts';
import type { Entry } from '../../layout/src/gitTree.ts';
import type { ExportNode, ExportRect } from './schema.ts';

const EXT_LANG = new Map<string, string>([
  ['py', 'py'], ['pyi', 'py'],
  ['ts', 'ts'], ['tsx', 'tsx'], ['mts', 'ts'], ['cts', 'ts'],
  ['js', 'js'], ['jsx', 'jsx'], ['mjs', 'js'], ['cjs', 'js'],
  ['rs', 'rs'], ['go', 'go'], ['java', 'java'], ['rb', 'rb'], ['sh', 'sh'],
  ['md', 'md'], ['json', 'json'], ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'], ['sql', 'sql'], ['proto', 'proto'], ['html', 'html'],
  ['css', 'css'], ['scss', 'scss'], ['ini', 'ini'], ['cfg', 'ini'],
  ['txt', 'txt'], ['lock', 'lock'], ['hcl', 'hcl'], ['xml', 'xml'],
]);

export function langOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_LANG.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

export interface TreeResult {
  /** Dir and file nodes only, in deterministic depth-first order. */
  readonly nodes: ExportNode[];
  readonly rects: ExportRect[];
  /** Repo-relative file path -> node id. */
  readonly fileIds: Map<string, number>;
  /** Repo-relative directory paths, for search calls that target a region. */
  readonly dirPaths: Set<string>;
  readonly dirCount: number;
  readonly fileCount: number;
  readonly extent: { readonly w: number; readonly h: number };
  readonly nextId: number;
  /** Working-tree accounting, all zero unless --worktree was given. */
  readonly worktree: {
    readonly enabled: boolean;
    readonly untrackedAdded: number;
    readonly sizesFromDisk: number;
    readonly missingOnDisk: number;
  };
  /** Effective-line accounting (schemaVersion 2). */
  readonly lines: {
    readonly counted: number;
    readonly unreadable: number;
    readonly folded: number;
    readonly total: number;
    readonly max: number;
  };
}

/**
 * Union of `git ls-tree -r -l HEAD` and the current working tree, sorted by
 * path so the layout stays deterministic:
 *   - a tracked file that exists on disk contributes its on-disk size, so a
 *     modified file is drawn at its current size
 *   - a tracked file deleted in the working tree keeps its HEAD blob size, so
 *     a deletion never silently removes a city from the map mid-session
 *   - untracked, non-ignored files become file nodes with their on-disk size
 */
function worktreeEntries(repo: string, sha: string): {
  entries: Entry[];
  untrackedAdded: number;
  sizesFromDisk: number;
  missingOnDisk: number;
} {
  const byPath = new Map<string, number>();
  let sizesFromDisk = 0;
  let missingOnDisk = 0;

  const diskSize = (path: string): number | null => {
    try {
      const stat = statSync(join(repo, path));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };

  for (const entry of listTree(repo, sha)) {
    const size = diskSize(entry.path);
    if (size === null) {
      missingOnDisk++;
      byPath.set(entry.path, entry.size);
    } else {
      if (size !== entry.size) sizesFromDisk++;
      byPath.set(entry.path, size);
    }
  }

  const others = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  let untrackedAdded = 0;
  for (const line of others.split('\n')) {
    const path = line.trim();
    if (path === '' || byPath.has(path)) continue;
    const size = diskSize(path);
    if (size === null) continue;
    byPath.set(path, size);
    untrackedAdded++;
  }

  const entries = [...byPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, size]) => ({ path, size }));
  return { entries, untrackedAdded, sizesFromDisk, missingOnDisk };
}

function lineStats(counts: Map<string, number>): TreeResult['lines'] {
  let counted = 0;
  let unreadable = 0;
  let folded = 0;
  let total = 0;
  let max = 0;
  for (const n of counts.values()) {
    counted++;
    if (n <= 1) unreadable++;
    if (n > DEFAULT_CONFIG.foldCap) folded++;
    total += n;
    max = Math.max(max, n);
  }
  return { counted, unreadable, folded, total, max };
}

/** Dirs before files, each group by name. Deterministic and readable. */
function sortedChildren(dir: DirNode): TreeNode[] {
  return [...dir.children].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * Effective lines for every entry (docs/design.md section 3): raw lines with
 * anything past 100 columns wrapped. Working-tree mode reads the files on
 * disk, so a file the agent just edited is drawn at its current length; HEAD
 * mode reads the blobs through one `git cat-file --batch`. Either way only the
 * integer count is kept, never the text.
 */
function countLines(
  repo: string,
  entries: readonly { path: string; size: number; sha?: string }[],
  useWorktree: boolean,
): Promise<Map<string, number>> {
  const cap = DEFAULT_CONFIG.foldCap;
  if (useWorktree) {
    const readHead = (p: string, n: number): Buffer => {
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(n);
        const read = readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    };
    const out = new Map<string, number>();
    for (const e of entries) {
      const r = effectiveLinesOnDisk(join(repo, e.path), e.size, cap, readFileSync, readHead);
      out.set(e.path, r.lines);
    }
    return Promise.resolve(out);
  }
  return effectiveLinesOfBlobs(
    repo,
    entries.map((e) => ({ sha: e.sha ?? '', path: e.path, size: e.size })),
    cap,
  ).then((res) => {
    const out = new Map<string, number>();
    for (const e of entries) out.set(e.path, res.lines.get(e.sha ?? '') ?? 1);
    return out;
  });
}

export async function buildTreeAndRects(
  repo: string,
  sha: string,
  repoName: string,
  useWorktree = false,
): Promise<TreeResult> {
  const wt = useWorktree
    ? worktreeEntries(repo, sha)
    : { entries: listTree(repo, sha), untrackedAdded: 0, sizesFromDisk: 0, missingOnDisk: 0 };
  const lineCounts = await countLines(repo, wt.entries, useWorktree);
  const entries = wt.entries.map((e) => ({ ...e, lines: lineCounts.get(e.path) ?? 1 }));
  const root = buildTree(entries);

  // 'size' order, not 'coupling': the layout module's coupling seriation reads
  // relative TS/TSX imports only, so on other languages it yields no edges and
  // the two orders coincide. Footprint is decoupled from BYTE size: a tile's
  // height follows its effective line count, so a flat directory of huge
  // generated blobs cannot distort the geography (a 17 MB binary is one step
  // tall), which is what the layout README asks for.
  const result = layoutTree(root, new LayoutState(), makeOrderFn('size', null), DEFAULT_CONFIG);

  const nodes: ExportNode[] = [];
  const rects: ExportRect[] = [];
  const fileIds = new Map<string, number>();
  const dirPaths = new Set<string>();
  let nextId = 0;
  let dirCount = 0;
  let fileCount = 0;

  const walk = (node: TreeNode, parent: number | null): void => {
    const id = nextId++;
    const isDir = node.kind === 'dir';
    if (isDir) dirCount++;
    else fileCount++;

    nodes.push({
      id,
      kind: isDir ? 'dir' : 'file',
      name: node.path === '' ? repoName : node.name,
      path: node.path,
      parent,
      size: isDir ? subtreeBytes(node) : node.size,
      lang: isDir ? null : langOf(node.path),
      symbolKind: null,
      lineStart: null,
      lineEnd: null,
      ...(isDir ? {} : { effectiveLines: lineCounts.get(node.path) ?? 1 }),
      ...(!isDir && (lineCounts.get(node.path) ?? 1) > DEFAULT_CONFIG.foldCap
        ? { folded: true as const }
        : {}),
    });

    const placement = result.layout.get(node.path);
    if (placement) rects.push([id, placement.x, placement.y, placement.w, placement.h]);

    if (!isDir) {
      fileIds.set(node.path, id);
      return;
    }
    if (node.path !== '') dirPaths.add(node.path);
    for (const child of sortedChildren(node)) walk(child, id);
  };

  walk(root, null);

  return {
    nodes,
    rects,
    fileIds,
    dirPaths,
    dirCount,
    fileCount,
    extent: { w: result.root.w, h: result.root.h },
    nextId,
    worktree: {
      enabled: useWorktree,
      untrackedAdded: wt.untrackedAdded,
      sizesFromDisk: wt.sizesFromDisk,
      missingOnDisk: wt.missingOnDisk,
    },
    lines: lineStats(lineCounts),
  };
}
