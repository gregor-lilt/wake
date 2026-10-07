// The live map document. Built at startup exactly as packages/export does
// (buildTreeAndRects in worktree mode plus readIndex), then kept current:
//
//   * file content change  -> effectiveLines recount, relayout with the SAME
//                             LayoutState (the layout module's incremental
//                             path: slots are kept, only what must move
//                             moves), `invalidate` plus `node` for every rect
//                             that changed
//   * new file             -> new node ids (never renumbered), inserted by the
//                             layout's first-fit, `node` messages
//   * reindex batch        -> import edges re-read from the wake-index
//                             SQLite, diffed into one `edges` message; symbol
//                             nodes are replaced in the document (fresh ids,
//                             protocol v1 has no symbol delta)
//
// Ids: dir and file ids are exactly the export's at startup. Symbol ids start
// at tree.nextId as in the export and, after a reindex, continue past every
// id ever handed out, so an id is never reused for a different thing.
//
// Deleted files keep their node and rect (the export's worktree mode does the
// same for tracked files: a deletion never removes a city mid-session).

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readIndex } from '../../../packages/export/src/indexdb.ts';
import type {
  ExportEdge,
  ExportNode,
  ExportRect,
  ExportSession,
  ExportSymbolEdge,
  WakeExport,
} from '../../../packages/export/src/schema.ts';
import { buildTreeAndRects, langOf } from '../../../packages/export/src/tree.ts';
import { buildTree } from '../../../packages/layout/src/gitTree.ts';
import type { Entry } from '../../../packages/layout/src/gitTree.ts';
import { DEFAULT_CONFIG, LayoutState, layoutTree } from '../../../packages/layout/src/layout.ts';
import { effectiveLinesOnDisk } from '../../../packages/layout/src/lines.ts';
import { makeOrderFn } from '../../../packages/layout/src/order.ts';
import type { ServerMessage } from './protocol.ts';

type MutableNode = { -readonly [K in keyof ExportNode]: ExportNode[K] };

export interface FileChangeResult {
  readonly messages: ServerMessage[];
  readonly relayouted: boolean;
}

/** Paths the daemon itself writes, or git internals: never map traffic. */
export function isInternalPath(rel: string): boolean {
  return rel === '.wake' || rel.startsWith('.wake/') || rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/');
}

function readHead(p: string, n: number): Buffer {
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function rectEq(a: ExportRect | undefined, b: ExportRect): boolean {
  return a !== undefined && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
}

export class LiveMap {
  private readonly state = new LayoutState();
  private readonly order = makeOrderFn('size', null);
  /** Repo-relative file path -> {size, lines}: the union the layout is built from. */
  private readonly entries = new Map<string, { size: number; lines: number }>();
  private readonly byPath = new Map<string, MutableNode>();
  private readonly rects = new Map<number, ExportRect>();
  private treeNodes: MutableNode[] = [];
  private symbolNodes: ExportNode[] = [];
  private edges: ExportEdge[] = [];
  private symbolEdges: ExportSymbolEdge[] = [];
  private nextId = 0;
  /**
   * Bun's node:sqlite refuses a read-only open of a WAL database whose -shm
   * and -wal sidecars are absent (Node accepts it). One read-write connection
   * held open for the daemon's lifetime keeps the sidecars present, so
   * packages/export's read-only reader works unchanged on both runtimes.
   */
  private keepAlive: DatabaseSync | null = null;

  readonly fileIds = new Map<string, number>();
  readonly dirPaths = new Set<string>();
  indexed = false;

  readonly repo: string;
  readonly name: string;
  readonly commit: string;
  readonly dbPath: string;

  private constructor(repo: string, name: string, commit: string, dbPath: string) {
    this.repo = repo;
    this.name = name;
    this.commit = commit;
    this.dbPath = dbPath;
  }

  static async create(repo: string, name: string, dbPath: string): Promise<LiveMap> {
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const map = new LiveMap(repo, name, commit, dbPath);
    const tree = await buildTreeAndRects(repo, commit, name, true);
    for (const node of tree.nodes) {
      const copy: MutableNode = { ...node };
      map.treeNodes.push(copy);
      map.byPath.set(node.path, copy);
      if (node.kind === 'file') {
        map.fileIds.set(node.path, node.id);
        map.entries.set(node.path, { size: node.size, lines: node.effectiveLines ?? 1 });
      } else if (node.path !== '') {
        map.dirPaths.add(node.path);
      }
    }
    for (const rect of tree.rects) map.rects.set(rect[0], rect);
    map.nextId = tree.nextId;

    // Warm the persistent layout state with the same tree. layoutTree is
    // deterministic, so this reproduces the export's rects and leaves the
    // slot assignments behind for incremental updates.
    const result = layoutTree(buildTree(map.sortedEntries()), map.state, map.order, DEFAULT_CONFIG);
    let mismatched = 0;
    for (const p of result.layout.values()) {
      const node = map.byPath.get(p.path);
      if (!node || !rectEq(map.rects.get(node.id), [node.id, p.x, p.y, p.w, p.h])) mismatched++;
    }
    console.log(
      `tree             ${tree.dirCount} dirs, ${tree.fileCount} files, ${tree.rects.length} rects` +
        (tree.worktree.enabled ? `, +${tree.worktree.untrackedAdded} untracked` : ''),
    );
    console.log(`layout state     warmed, ${mismatched === 0 ? 'identical to the export' : `${mismatched} RECT MISMATCHES`}`);
    return map;
  }

  private sortedEntries(): Entry[] {
    return [...this.entries.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([path, e]) => ({ path, size: e.size, lines: e.lines }));
  }

  /** Re-read symbols and edges from the index database. Returns the edge delta. */
  readIndexNow(): { added: ExportEdge[]; removed: ExportEdge[]; symbols: number } {
    if (this.keepAlive === null) this.keepAlive = new DatabaseSync(this.dbPath);
    const index = readIndex(this.dbPath, this.fileIds, this.nextId);
    const before = new Map(this.edges.map((e) => [`${e.from}>${e.to}`, e]));
    const after = new Map(index.edges.map((e) => [`${e.from}>${e.to}`, e]));
    const added: ExportEdge[] = [];
    const removed: ExportEdge[] = [];
    for (const [key, edge] of after) {
      const old = before.get(key);
      if (old === undefined) added.push(edge);
      else if (old.weight !== edge.weight) {
        removed.push(old);
        added.push(edge);
      }
    }
    for (const [key, edge] of before) if (!after.has(key)) removed.push(edge);
    this.symbolNodes = index.symbolNodes;
    this.edges = index.edges;
    this.symbolEdges = index.symbolEdges;
    for (const n of index.symbolNodes) if (n.id >= this.nextId) this.nextId = n.id + 1;
    this.indexed = true;
    return { added, removed, symbols: index.symbolNodes.length };
  }

  /**
   * Files the indexer reported as changed or deleted. Recount lines, relayout
   * incrementally, and return the `invalidate` and `node` messages to send.
   */
  applyFileChanges(paths: readonly string[]): FileChangeResult {
    const messages: ServerMessage[] = [];
    const invalidated: { path: string; lines: number }[] = [];
    let needLayout = false;

    // A path the map has never seen is only new land when git would track
    // it: the watcher reports build output (dist/, target/) too, and a file
    // git ignores is not part of the repository's geography.
    const unknown = paths.filter((rel) => !this.entries.has(rel) && !isInternalPath(rel));
    const ignored = gitIgnored(this.repo, unknown);
    for (const rel of paths) {
      if (isInternalPath(rel) || ignored.has(rel)) continue;
      const abs = join(this.repo, rel);
      let size: number;
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        // Gone. Keep the node and its footprint, exactly like a tracked file
        // deleted in the working tree in the export's worktree mode.
        continue;
      }
      const lines = effectiveLinesOnDisk(abs, size, DEFAULT_CONFIG.foldCap, readFileSync, readHead).lines;
      const previous = this.entries.get(rel);
      this.entries.set(rel, { size, lines });
      if (previous === undefined || previous.lines !== lines || previous.size !== size) needLayout = true;
      invalidated.push({ path: rel, lines });
    }

    if (needLayout) {
      const result = layoutTree(buildTree(this.sortedEntries()), this.state, this.order, DEFAULT_CONFIG);
      // Paths are visited parent-first so a new file's directories exist
      // before the file asks for its parent id.
      const placements = [...result.layout.values()].sort((a, b) => a.path.length - b.path.length);
      for (const p of placements) {
        let node = this.byPath.get(p.path);
        if (node === undefined) node = this.addNode(p.path, p.kind);
        const rect: ExportRect = [node.id, p.x, p.y, p.w, p.h];
        node.size = p.bytes;
        if (node.kind === 'file') {
          const lines = this.entries.get(p.path)?.lines ?? 1;
          node.effectiveLines = lines;
          if (lines > DEFAULT_CONFIG.foldCap) node.folded = true;
          else delete node.folded;
        }
        if (!rectEq(this.rects.get(node.id), rect)) {
          this.rects.set(node.id, rect);
          messages.push({ type: 'node', node: { ...node }, rect });
        }
      }
    }

    for (const inv of invalidated) {
      const id = this.fileIds.get(inv.path);
      if (id !== undefined) messages.push({ type: 'invalidate', nodeId: id, effectiveLines: inv.lines });
    }
    // `node` frames go first so a client never sees an invalidate for an id it
    // has not met yet.
    messages.sort((a, b) => Number(a.type === 'invalidate') - Number(b.type === 'invalidate'));
    return { messages, relayouted: needLayout };
  }

  private addNode(path: string, kind: 'file' | 'dir'): MutableNode {
    const slash = path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : path.slice(0, slash);
    const parent = this.byPath.get(parentPath) ?? this.addNode(parentPath, 'dir');
    const node: MutableNode = {
      id: this.nextId++,
      kind,
      name: path.slice(slash + 1),
      path,
      parent: parent.id,
      size: 0,
      lang: kind === 'file' ? langOf(path) : null,
      symbolKind: null,
      lineStart: null,
      lineEnd: null,
    };
    this.treeNodes.push(node);
    this.byPath.set(path, node);
    if (kind === 'file') this.fileIds.set(path, node.id);
    else this.dirPaths.add(path);
    return node;
  }

  /** Absolute path for a repo-relative file that exists in the node list. */
  resolveFile(rel: string): string | null {
    if (!this.fileIds.has(rel)) return null;
    if (rel.split('/').includes('..')) return null;
    return join(this.repo, rel);
  }

  document(session: ExportSession): WakeExport {
    return {
      schemaVersion: 3,
      repo: { name: this.name, path: this.repo, commit: this.commit, generatedAt: new Date().toISOString() },
      nodes: [...this.treeNodes.map((n) => ({ ...n })), ...this.symbolNodes],
      rects: [...this.rects.values()],
      edges: this.edges,
      symbolEdges: this.symbolEdges,
      session,
    };
  }

  close(): void {
    this.keepAlive?.close();
    this.keepAlive = null;
  }
}

/** The subset of repo-relative paths git ignores, in one `git check-ignore` call. */
function gitIgnored(repo: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const res = spawnSync('git', ['-C', repo, 'check-ignore', '--stdin'], { input: paths.join('\n'), encoding: 'utf8' });
  return new Set((res.stdout ?? '').split('\n').filter((line) => line !== ''));
}
