/**
 * The enclosing scope of a source line, for the sticky scope row and the jump
 * bar (docs/design.md section 7).
 *
 * Two paths, and the first one is the real answer:
 *
 *   containment    export schema 3 gives every symbol a real body span
 *                  (`lineEnd` past `lineStart`), the indentation column of its
 *                  definition, and the id of the symbol enclosing it. The
 *                  scope of a line is then the DEEPEST symbol whose span
 *                  contains it, and the breadcrumb is that symbol's `parentId`
 *                  chain walked upward: "ClassName › method_name".
 *   indentation    the fallback for a schema-2 export, where `lineEnd` equals
 *                  `lineStart` and there is nothing to contain a line in: walk
 *                  the file's symbols backwards from the line and take the
 *                  nearest preceding definition whose own indentation is at or
 *                  below the line's, then repeat one indent step further out.
 *                  That is how a reader resolves scope by eye, and it is right
 *                  whenever a body is indented past its header.
 *
 * Only classes, functions and methods are scopes. A module-level constant is a
 * definition, not a place to be inside.
 */
import type { Repo } from './repo';

export interface ScopeSym {
  name: string;
  /** 'class' | 'function' | 'method' | 'constant' | ... */
  kind: string;
  /** 1-based first line of the definition, as the export reports it */
  lineStart: number;
  lineEnd: number;
  /** leading whitespace of the definition's own line, tabs as four columns */
  indent: number;
  /** index of the enclosing symbol in the same array, -1 at file level */
  parent: number;
  /** index of this symbol in the array, so a parent walk can be reported */
  self: number;
}

/** Symbol kinds that count as an enclosing scope. */
const SCOPE_KINDS = new Set(['class', 'function', 'method', 'module']);

const TAB = 4;

/** Leading whitespace of a line in columns, or -1 for a blank line. */
export function indentOf(line: string | undefined): number {
  if (line === undefined) return -1;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') n++;
    else if (c === '\t') n += TAB - (n % TAB);
    else return n;
  }
  return -1; // whitespace only: carries no indentation of its own
}

/** Indentation of the first non-blank line at or after `line`. */
function indentAtOrAfter(lines: readonly string[], line: number): number {
  for (let i = Math.max(0, line); i < lines.length && i < line + 40; i++) {
    const ind = indentOf(lines[i]);
    if (ind >= 0) return ind;
  }
  return 0;
}

/**
 * The file's symbols in source order, with the indentation of their own
 * definition line read off the source text. `lines` may be null before the
 * file is fetched, in which case every indentation is 0 and the approximation
 * degenerates to "the nearest preceding definition", which is still right for
 * a flat module.
 */
export function fileSymbols(repo: Repo, file: number, lines: readonly string[] | null): ScopeSym[] {
  const names = repo.symName;
  const kinds = repo.symKindName;
  const starts = repo.symLineStart;
  const ends = repo.symLineEnd;
  if (!names || !kinds || !starts || !ends) return [];
  const cols = repo.symCol;
  const parents = repo.symParent;
  const from = repo.fileSymStart[file];
  const to = repo.fileSymStart[file + 1];
  const out: ScopeSym[] = [];
  for (let s = from; s < to; s++) {
    const lineStart = starts[s];
    if (lineStart < 1) continue;
    out.push({
      name: names[s],
      kind: kinds[s],
      lineStart,
      lineEnd: Math.max(ends[s], lineStart),
      // The export's own column when it has one (schema 3), the source text's
      // indentation otherwise.
      indent: cols && cols[s] >= 0
        ? cols[s]
        : lines ? Math.max(0, indentOf(lines[lineStart - 1])) : 0,
      parent: parents ? parents[s] : -1,
      self: s
    });
  }
  out.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  // Rewrite the parent links, which are dense global symbol indices, into
  // positions in this sorted array. `self` still carries the global index at
  // this point, which is what the map is built from.
  const pos = new Map<number, number>();
  out.forEach((sym, i) => pos.set(sym.self, i));
  for (const sym of out) sym.parent = sym.parent >= 0 ? (pos.get(sym.parent) ?? -1) : -1;
  out.forEach((sym, i) => { sym.self = i; });
  return out;
}

/** True when the indexer gave this file at least one real span. */
export function hasRealSpans(syms: readonly ScopeSym[]): boolean {
  for (const s of syms) if (s.lineEnd > s.lineStart) return true;
  return false;
}

/**
 * The enclosing scope chain of a zero-based source line, outermost first.
 * Empty at module level.
 */
export function scopeChain(
  syms: readonly ScopeSym[],
  lines: readonly string[] | null,
  line0: number
): ScopeSym[] {
  if (syms.length === 0) return [];
  const line1 = line0 + 1;
  if (hasRealSpans(syms)) {
    // The deepest symbol whose body span contains the line. Nested spans are
    // contained, so the innermost one is the one that starts last and, on a
    // tie, ends first.
    let deepest = -1;
    for (let i = 0; i < syms.length; i++) {
      const s = syms[i];
      if (!SCOPE_KINDS.has(s.kind) || s.lineStart > line1 || line1 > s.lineEnd) continue;
      if (deepest < 0) { deepest = i; continue; }
      const d = syms[deepest];
      if (s.lineStart > d.lineStart || (s.lineStart === d.lineStart && s.lineEnd < d.lineEnd)) deepest = i;
    }
    if (deepest < 0) return [];
    // Breadcrumb: follow parentId upward, and fall back to containment when a
    // symbol has no parent link (the export leaves it out for a definition it
    // could not attach).
    const chain: ScopeSym[] = [];
    let cur = deepest;
    const seen = new Set<number>();
    while (cur >= 0 && !seen.has(cur) && chain.length < 8) {
      seen.add(cur);
      const s = syms[cur];
      if (SCOPE_KINDS.has(s.kind)) chain.push(s);
      let next = s.parent;
      if (next < 0) {
        // No link: the nearest enclosing span, if any.
        next = -1;
        for (let i = 0; i < syms.length; i++) {
          const o = syms[i];
          if (i === cur || !SCOPE_KINDS.has(o.kind)) continue;
          if (o.lineStart > s.lineStart || o.lineEnd < s.lineEnd) continue;
          if (o.lineStart === s.lineStart && o.lineEnd === s.lineEnd) continue;
          if (next < 0 || o.lineStart > syms[next].lineStart) next = i;
        }
      }
      cur = next;
    }
    chain.reverse();
    return chain;
  }
  // Indentation approximation.
  const ind = lines ? indentAtOrAfter(lines, line0) : 0;
  const chain: ScopeSym[] = [];
  let limit = ind;
  let cursor = line1;
  // Symbols are sorted by lineStart, so walk backwards from the line.
  let i = syms.length - 1;
  while (i >= 0 && limit >= 0) {
    const s = syms[i];
    if (s.lineStart > cursor) { i--; continue; }
    if (!SCOPE_KINDS.has(s.kind) || s.indent > limit) { i--; continue; }
    chain.push(s);
    limit = s.indent - 1;
    cursor = s.lineStart;
    i--;
  }
  chain.reverse();
  return chain;
}

/** "ClassName › method_name", the sticky scope row's text. */
export const scopeText = (chain: readonly ScopeSym[]): string =>
  chain.map((s) => s.name).join(' › ');
