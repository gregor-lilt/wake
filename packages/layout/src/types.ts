// Core data model for Wake's stable geography.
//
// Everything is measured in CELLS, never pixels. One cell is the footprint of
// one file ("city"). Pixels only appear in the SVG writer. Keeping the whole
// layout on an integer lattice is what makes "did it move" a discrete question
// (research/02-layout-and-prior-art.md, headline recommendation 3).

export interface FileNode {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  /** Blob size in bytes. Never drives the footprint. */
  readonly size: number;
  /**
   * Effective line count: raw lines with long lines wrapped at 100 columns
   * (see lines.ts). This DOES drive the footprint: a tile's height is
   * proportional to it, quantized to LINES_PER_CELL steps and capped at the
   * fold cap. Absent means "unknown", and the layout falls back to a byte
   * estimate.
   */
  readonly effectiveLines?: number;
}

export interface DirNode {
  readonly kind: 'dir';
  readonly name: string;
  readonly path: string;
  readonly children: TreeNode[];
}

export type TreeNode = FileNode | DirNode;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement extends Rect {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly depth: number;
  /** Bytes, for files. Sum of subtree bytes, for dirs. */
  readonly bytes: number;
  /** Files only: the effective line count the height was derived from. */
  readonly effectiveLines?: number;
  /** Files only: true when effectiveLines exceeded the fold cap. */
  readonly folded?: boolean;
}

/** Absolute layout of one commit: path -> rect in cells. */
export type Layout = Map<string, Placement>;

export interface Commit {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
}
