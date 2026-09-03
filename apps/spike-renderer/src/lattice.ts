/**
 * The layout lattice, design phase 2 (docs/design.md sections 3 and 4, and
 * packages/layout/README.md "The tile, in numbers").
 *
 * One cell is 20 glyph columns wide and 10 source lines tall. That single fact
 * fixes the whole world scale, and it replaces phase 1's fitted `k`:
 *
 *     rowWorld = CELL_WORLD / CELL_LINES      // world units per source line
 *     colWorld = CELL_WORLD / CELL_COLS       // world units per glyph column
 *     rowPx    = rowWorld * zoomScale         // capped at 18, which is max zoom
 *
 * Because a cell is square in world units, the glyph advance is exactly half a
 * row (`ADVANCE = colWorld / rowWorld = 10 / 20`), which is what `FONT_RATIO`
 * in schematic.ts is derived from: a monospace face at 0.6 em advance needs a
 * font size of 5/6 of the row to land on the lattice.
 *
 * A file tile is TILE_CELLS_W cells wide (the sheet's 100 columns, the same for
 * every file) and a whole number of 40-line steps tall, capped at the fold.
 * Nothing here depends on byte size.
 */

/** Glyph columns per lattice cell. */
export const CELL_COLS = 20;
/** Source lines per lattice cell. */
export const CELL_LINES = 10;
/** Tile width in cells: 5 * 20 = the sheet's 100 columns. */
export const TILE_CELLS_W = 5;
/** Height quantum in lines, and the same in cells. */
export const LINES_PER_STEP = 40;
export const STEP_CELLS = LINES_PER_STEP / CELL_LINES;
/** Effective lines above which a sheet is folded. */
export const FOLD_CAP = 400;
/** Rows of the sheet the fold marker owns: a dashed rule and its caption. */
export const FOLD_MARKER_ROWS = 2;
/** Files with fewer effective lines than this are stubs. */
export const STUB_LINES = 5;

/**
 * World units per lattice cell. Arbitrary in principle (every zoom threshold
 * that matters is derived from `rowWorld` or from the world's own extent), but
 * fixed here so a world of a few hundred cells lands in a comfortable float
 * range and the synthetic fixture and a real export share one scale.
 */
export const CELL_WORLD = 48;
/** World units per source line: the k of rowPx = k * scale. */
export const ROW_WORLD = CELL_WORLD / CELL_LINES;
/** World units per glyph column. */
export const COL_WORLD = CELL_WORLD / CELL_COLS;
/** Columns a sheet (and therefore a tile) is wide. */
export const COLS = TILE_CELLS_W * CELL_COLS;

/** Tile height in cells for an effective line count, quantized and capped. */
export function tileCellsH(effectiveLines: number): number {
  const lines = Math.min(Math.max(effectiveLines, 1), FOLD_CAP);
  return STEP_CELLS * Math.max(1, Math.ceil(lines / LINES_PER_STEP));
}

/** A file past the cap: its sheet is folded and its tile is exactly the cap. */
export const isFolded = (effectiveLines: number): boolean => effectiveLines > FOLD_CAP;

/**
 * The exporter's effective-line formula (packages/export/README.md): a line
 * longer than the sheet counts as several. Used to check the renderer's own
 * row count against the export's once the real text arrives.
 */
export function effectiveLinesOf(lines: readonly string[]): number {
  // A trailing newline leaves an empty last element behind, which the exporter
  // does not count either.
  const end = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  let n = 0;
  for (let i = 0; i < end; i++) n += Math.ceil(Math.max(1, lines[i].length) / COLS);
  return n;
}
