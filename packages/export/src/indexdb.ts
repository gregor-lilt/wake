// Run wake-index over the repository and turn its SQLite into symbol nodes,
// file-to-file import edges and symbol-to-symbol call edges.
//
// wake-index schema:
//   files(path, hash, size, lang)
//   dirs(path, hash)
//   symbols(id, file, name, kind, start_line, end_line, start_col, parent_id)
//                                                     -- kind 'ref:*' = reference
//   imports(from_file, to_file_or_module, resolved)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExportEdge, ExportNode, ExportSymbolEdge, SymbolKind } from './schema.ts';

/** Same derivation as wake-index's db_path_for: '/', ' ' and '.' become '_'. */
export function defaultDbPath(repo: string): string {
  const key = repo.replace(/[/ .]/g, '_');
  return join(homedir(), '.cache', 'wake-index', `${key}.sqlite`);
}

export function runIndexer(binary: string, repo: string): string {
  return execFileSync(binary, ['index', repo], { encoding: 'utf8' });
}

interface SymbolRow {
  readonly id: number;
  readonly file: string;
  readonly name: string;
  readonly kind: string;
  readonly start_line: number;
  readonly end_line: number;
  /** Indentation of the definition's first line, 0-based. */
  readonly start_col: number;
  /** `symbols.id` of the innermost enclosing definition, or null. */
  readonly parent_id: number | null;
}

interface ImportRow {
  readonly from_file: string;
  readonly to_file_or_module: string;
  readonly resolved: number;
}

const SYMBOL_KINDS = new Set(['class', 'function', 'method', 'module', 'constant']);

function symbolKindOf(kind: string): SymbolKind {
  return SYMBOL_KINDS.has(kind) ? (kind as SymbolKind) : 'other';
}

// ---------------------------------------------------------------------------
// Python dotted-module resolution.
//
// wake-index resolves relative specifiers only, so every intra-repo absolute
// import ("pkg.mod.sub") lands in the unresolved bucket even though it points
// at a file in this very repository. Recovering those is what makes the road
// network exist at all for a Python codebase. The rule is the standard one:
// walk up from a module file while the directory has an __init__.py, and the
// first directory without one is the package root.
// ---------------------------------------------------------------------------

export function pythonModuleMap(files: Iterable<string>): Map<string, string> {
  const set = new Set(files);
  const map = new Map<string, string>();
  const py = [...set].filter((p) => p.endsWith('.py')).sort();

  for (const path of py) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const base = path.slice(slash + 1);

    const segments: string[] = [];
    let cursor = dir;
    while (cursor !== '' && set.has(`${cursor}/__init__.py`)) {
      const cut = cursor.lastIndexOf('/');
      segments.unshift(cut < 0 ? cursor : cursor.slice(cut + 1));
      cursor = cut < 0 ? '' : cursor.slice(0, cut);
    }

    const own = base === '__init__.py' ? [] : [base.slice(0, -3)];
    const parts = [...segments, ...own];
    if (parts.length === 0) continue;
    const dotted = parts.join('.');
    // A package's __init__.py wins over a same-named module, and the shallowest
    // candidate wins over a deeper one; `py` is sorted so this is deterministic.
    const existing = map.get(dotted);
    if (existing === undefined || base === '__init__.py') map.set(dotted, path);
  }
  return map;
}

/** Exact module, then progressively strip trailing `from pkg.mod import Name` parts. */
function resolveModule(spec: string, modules: Map<string, string>): string | null {
  let candidate = spec;
  for (let i = 0; i < 3; i++) {
    const hit = modules.get(candidate);
    if (hit !== undefined) return hit;
    const cut = candidate.lastIndexOf('.');
    if (cut < 0) return null;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

export interface IndexResult {
  readonly symbolNodes: ExportNode[];
  readonly edges: ExportEdge[];
  readonly symbolEdges: ExportSymbolEdge[];
  readonly stats: {
    readonly indexedFiles: number;
    readonly indexedFilesNotInTree: number;
    readonly symbolRows: number;
    readonly referenceRows: number;
    readonly symbolsSkippedNoFile: number;
    /** Exported symbol nodes whose span is more than one line. */
    readonly definitionsMultiLine: number;
    /** Exported symbol nodes carrying a `parentId`. */
    readonly definitionsWithParent: number;
    readonly importRows: number;
    readonly importsResolvedByIndexer: number;
    readonly importsResolvedByModuleMap: number;
    readonly importsUnresolved: number;
    readonly importsResolvedOutsideTree: number;
    readonly referencesResolvedUniquely: number;
    readonly referencesResolvedSameFile: number;
    readonly referencesResolvedViaImport: number;
    readonly referencesAmbiguous: number;
    readonly referencesUnresolved: number;
  };
}

export function readIndex(
  dbPath: string,
  fileIds: Map<string, number>,
  firstSymbolId: number,
): IndexResult {
  if (!existsSync(dbPath)) throw new Error(`index database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const indexedFiles = db.prepare('SELECT path, lang FROM files ORDER BY path').all() as unknown as
      { path: string; lang: string }[];
    const langByFile = new Map<string, string>();
    let indexedFilesNotInTree = 0;
    for (const row of indexedFiles) {
      langByFile.set(row.path, row.lang);
      if (!fileIds.has(row.path)) indexedFilesNotInTree++;
    }

    const symbolRows = db
      .prepare(
        'SELECT id, file, name, kind, start_line, end_line, start_col, parent_id FROM symbols ' +
          'ORDER BY file, start_line, end_line, name, kind',
      )
      .all() as unknown as SymbolRow[];

    // --- symbol nodes (definitions only) ---
    const symbolNodes: ExportNode[] = [];
    /** file -> definitions in source order, for enclosing-symbol lookup. */
    const defsByFile = new Map<string, { id: number; row: SymbolRow }[]>();
    /** symbol name -> node ids that define it. */
    const defsByName = new Map<string, number[]>();
    let nextId = firstSymbolId;
    let defs = 0;
    let refs = 0;
    let symbolsSkippedNoFile = 0;
    let definitionsMultiLine = 0;
    let definitionsWithParent = 0;

    // Two passes over the definitions: `parent_id` is an index-database row id
    // and a parent is not guaranteed to sort before its child, so every export
    // id has to exist before any `parentId` can be filled in.
    const kept: { readonly id: number; readonly row: SymbolRow }[] = [];
    const exportIdByRowId = new Map<number, number>();
    for (const row of symbolRows) {
      if (row.kind.startsWith('ref:')) {
        refs++;
        continue;
      }
      defs++;
      if (!fileIds.has(row.file)) {
        symbolsSkippedNoFile++;
        continue;
      }
      const id = nextId++;
      kept.push({ id, row });
      exportIdByRowId.set(row.id, id);
    }

    for (const { id, row } of kept) {
      const parent = fileIds.get(row.file)!;
      const parentSymbol = row.parent_id === null ? undefined : exportIdByRowId.get(row.parent_id);
      if (row.end_line > row.start_line) definitionsMultiLine++;
      if (parentSymbol !== undefined) definitionsWithParent++;
      symbolNodes.push({
        id,
        kind: 'symbol',
        name: row.name,
        path: row.file,
        parent,
        size: Math.max(1, row.end_line - row.start_line + 1),
        lang: langByFile.get(row.file) === 'python' ? 'py' : (langByFile.get(row.file) ?? null),
        symbolKind: symbolKindOf(row.kind),
        lineStart: row.start_line,
        lineEnd: row.end_line,
        col: row.start_col,
        ...(parentSymbol === undefined ? {} : { parentId: parentSymbol }),
      });
      const list = defsByFile.get(row.file);
      if (list) list.push({ id, row });
      else defsByFile.set(row.file, [{ id, row }]);
      const named = defsByName.get(row.name);
      if (named) named.push(id);
      else defsByName.set(row.name, [id]);
    }

    // --- file-level import edges ---
    const importRows = db
      .prepare('SELECT from_file, to_file_or_module, resolved FROM imports ORDER BY from_file, to_file_or_module')
      .all() as unknown as ImportRow[];

    const modules = pythonModuleMap(fileIds.keys());
    const weights = new Map<string, number>();
    let importsResolvedByIndexer = 0;
    let importsResolvedByModuleMap = 0;
    let importsUnresolved = 0;
    let importsResolvedOutsideTree = 0;

    for (const row of importRows) {
      const fromId = fileIds.get(row.from_file);
      let target: string | null = null;
      if (row.resolved === 1) {
        target = row.to_file_or_module;
        importsResolvedByIndexer++;
      } else {
        target = resolveModule(row.to_file_or_module, modules);
        if (target !== null) importsResolvedByModuleMap++;
        else importsUnresolved++;
      }
      if (target === null) continue;
      const toId = fileIds.get(target);
      if (fromId === undefined || toId === undefined) {
        importsResolvedOutsideTree++;
        continue;
      }
      if (fromId === toId) continue;
      const key = `${fromId}>${toId}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }

    const edges: ExportEdge[] = [...weights.entries()]
      .map(([key, weight]) => {
        const [from, to] = key.split('>');
        return { from: Number(from), to: Number(to), kind: 'import' as const, weight };
      })
      .sort((a, b) => a.from - b.from || a.to - b.to);

    // --- symbol-level call edges ---
    // A reference row is a call site: file + line, no enclosing scope. The
    // caller is approximated by the nearest preceding definition in the same
    // file, preferring a function over a class. Definitions now carry real
    // body spans (schemaVersion 3), so exact containment is available and is
    // the obvious next step here; it is deliberately NOT taken in this change
    // so that `symbolEdges` stays byte-identical to version 2. The callee is
    // resolved by name
    // in three tiers, each conservative:
    //   1. the name has exactly one definition in the whole repository
    //   2. the name is ambiguous but exactly one candidate sits in this file
    //   3. the name is ambiguous but exactly one candidate sits in a file this
    //      file actually imports (the edges computed above)
    // Anything still ambiguous is dropped rather than guessed. A wrong road is
    // worse than a missing one.
    for (const list of defsByFile.values()) {
      list.sort((a, b) => a.row.start_line - b.row.start_line);
    }
    const fileOfSymbol = new Map<number, string>();
    for (const [file, list] of defsByFile) for (const d of list) fileOfSymbol.set(d.id, file);
    const importsOf = new Map<number, Set<number>>();
    for (const edge of edges) {
      const set = importsOf.get(edge.from);
      if (set) set.add(edge.to);
      else importsOf.set(edge.from, new Set([edge.to]));
    }

    const symbolWeights = new Map<string, number>();
    let referencesResolvedUniquely = 0;
    let referencesResolvedSameFile = 0;
    let referencesResolvedViaImport = 0;
    let referencesAmbiguous = 0;
    let referencesUnresolved = 0;

    for (const row of symbolRows) {
      if (!row.kind.startsWith('ref:')) continue;
      const targets = defsByName.get(row.name);
      if (targets === undefined) {
        referencesUnresolved++;
        continue;
      }
      const from = enclosing(defsByFile.get(row.file), row.start_line);
      if (from === null) {
        referencesUnresolved++;
        continue;
      }

      let toId: number | null = null;
      if (targets.length === 1) {
        toId = targets[0]!;
        referencesResolvedUniquely++;
      } else {
        const sameFile = targets.filter((id) => fileOfSymbol.get(id) === row.file);
        if (sameFile.length === 1) {
          toId = sameFile[0]!;
          referencesResolvedSameFile++;
        } else {
          const fromFileId = fileIds.get(row.file);
          const imported = fromFileId === undefined ? new Set<number>() : (importsOf.get(fromFileId) ?? new Set<number>());
          const viaImport = targets.filter((id) => {
            const file = fileOfSymbol.get(id);
            const fileId = file === undefined ? undefined : fileIds.get(file);
            return fileId !== undefined && imported.has(fileId);
          });
          if (viaImport.length === 1) {
            toId = viaImport[0]!;
            referencesResolvedViaImport++;
          } else {
            referencesAmbiguous++;
            continue;
          }
        }
      }

      if (from === toId) continue;
      const key = `${from}>${toId}`;
      symbolWeights.set(key, (symbolWeights.get(key) ?? 0) + 1);
    }

    const symbolEdges: ExportSymbolEdge[] = [...symbolWeights.entries()]
      .map(([key, weight]) => {
        const [from, to] = key.split('>');
        return { from: Number(from), to: Number(to), kind: 'call' as const, weight };
      })
      .sort((a, b) => a.from - b.from || a.to - b.to);

    return {
      symbolNodes,
      edges,
      symbolEdges,
      stats: {
        indexedFiles: indexedFiles.length,
        indexedFilesNotInTree,
        symbolRows: defs,
        referenceRows: refs,
        symbolsSkippedNoFile,
        definitionsMultiLine,
        definitionsWithParent,
        importRows: importRows.length,
        importsResolvedByIndexer,
        importsResolvedByModuleMap,
        importsUnresolved,
        importsResolvedOutsideTree,
        referencesResolvedUniquely,
        referencesResolvedSameFile,
        referencesResolvedViaImport,
        referencesAmbiguous,
        referencesUnresolved,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Nearest preceding definition, which is the best available stand-in for "the
 * symbol this call sits inside" when only definition start lines are used. A
 * function wins over a class at the same distance (a call in a method body is
 * closer to the method than to the class header), and constants never win.
 */
function enclosing(
  defs: { id: number; row: SymbolRow }[] | undefined,
  line: number,
): number | null {
  if (!defs) return null;
  let best: { id: number; line: number; isFunction: boolean } | null = null;
  for (const d of defs) {
    if (d.row.start_line > line) break;
    if (d.row.kind === 'constant') continue;
    const isFunction = d.row.kind === 'function' || d.row.kind === 'method';
    if (best === null || d.row.start_line > best.line || (d.row.start_line === best.line && isFunction)) {
      best = { id: d.id, line: d.row.start_line, isFunction };
    }
  }
  return best === null ? null : best.id;
}
