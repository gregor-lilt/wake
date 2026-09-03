// The export schema, version 3. This is the contract between the exporter and
// the renderer. Keep it additive: bump schemaVersion for anything else.
//
// Units: rect coordinates are LAYOUT CELLS. A cell is no longer one file: it
// is 20 glyphs by 10 lines, and a file tile is 5 cells wide by one cell per
// 10 lines of its (capped) effective line count. See @wake/layout.
//
// Version 2 added `effectiveLines` and `folded` to file nodes and made file
// rects proportional to length.
//
// Version 3 gives symbol nodes real spans: `lineEnd` is now the last line of
// the definition's body instead of a copy of `lineStart`, and two optional
// fields come with it, `col` (indentation) and `parentId` (the enclosing
// definition). Nothing was removed or renamed and rects are untouched, so a
// version-2 reader parses a version-3 payload unchanged; only `lineEnd` and a
// symbol node's `size` carry different numbers than before.

export type NodeKind = 'dir' | 'file' | 'symbol';

/** Symbol kinds as produced by the indexer, plus null for dirs and files. */
export type SymbolKind = 'class' | 'function' | 'method' | 'module' | 'constant' | 'other' | null;

export interface ExportNode {
  readonly id: number;
  readonly kind: NodeKind;
  /** Basename for dirs and files, symbol name for symbols. */
  readonly name: string;
  /** Repo-relative path. Symbols carry the path of the file they live in. */
  readonly path: string;
  readonly parent: number | null;
  /** Bytes for dirs/files, lines for symbols. */
  readonly size: number;
  readonly lang: string | null;
  readonly symbolKind: SymbolKind;
  readonly lineStart: number | null;
  /**
   * Symbols: the last line of the definition, inclusive, and always
   * `>= lineStart` (schemaVersion 3; it was a copy of `lineStart` before).
   * Equal to `lineStart` only for a genuinely one-line definition. Null on
   * dirs and files.
   */
  readonly lineEnd: number | null;
  /**
   * Symbols only, schemaVersion 3. Indentation of the definition's first
   * line: the 0-based column of that line's first non-whitespace character.
   * Absent on dirs and files.
   */
  readonly col?: number;
  /**
   * Symbols only, schemaVersion 3. `id` of the innermost symbol node whose
   * span contains this one, which is always a symbol in the same file (a
   * method's class, a nested function's function). Absent on a top-level
   * definition, on dirs and on files, so `'parentId' in node` is the test.
   * `parent` stays the FILE node either way.
   */
  readonly parentId?: number;
  /**
   * Files only, schemaVersion 2. Effective line count: raw lines with lines
   * longer than 100 columns counted as many (see @wake/layout's lines.ts).
   * Absent on dirs and symbols, and on a file whose content could not be
   * read. This is what the tile's height is proportional to.
   */
  readonly effectiveLines?: number;
  /**
   * Files only, schemaVersion 2. Present and true when `effectiveLines`
   * exceeded the fold cap (400), so the tile's height is the cap and the
   * renderer must draw the sheet folded (docs/design.md section 3).
   */
  readonly folded?: boolean;
}

/** [id, x, y, w, h] in layout cells. Dirs and files only. */
export type ExportRect = readonly [number, number, number, number, number];

export interface ExportEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: 'import';
  readonly weight: number;
}

export interface ExportSymbolEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: 'call' | 'reference';
  readonly weight: number;
}

export type EventKind = 'read' | 'edit' | 'write' | 'search' | 'run' | 'message' | 'other';

export interface ExportEvent {
  /** Milliseconds since the first event of the session. */
  readonly t: number;
  readonly kind: EventKind;
  readonly tool: string;
  readonly nodeId: number | null;
  readonly path: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  /** Tool name plus repo-relative path. Never file contents or prose. */
  readonly summary: string;
  /**
   * Optional. Present only on events that came from a subagent transcript
   * (`<session>/subagents/agent-<id>.jsonl`), carrying that agent's id, so the
   * renderer can give each parallel agent its own cursor. Absent means the
   * event belongs to the main session.
   */
  readonly agentId?: string;
}

export interface ExportSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly events: ExportEvent[];
}

export interface ExportRepo {
  readonly name: string;
  readonly path: string;
  readonly commit: string;
  readonly generatedAt: string;
}

export interface WakeExport {
  readonly schemaVersion: 3;
  readonly repo: ExportRepo;
  readonly nodes: ExportNode[];
  readonly rects: ExportRect[];
  readonly edges: ExportEdge[];
  readonly symbolEdges: ExportSymbolEdge[];
  readonly session: ExportSession;
}
