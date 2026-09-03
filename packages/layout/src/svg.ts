// SVG snapshots, by string building. No rendering library.

import type { Layout, Placement, Rect } from './types.ts';

// Px per cell. A cell is now a fraction of a tile (20 glyphs by 10 lines), so
// there are roughly twenty of them per file: the snapshot scales itself to a
// readable page instead of using a fixed cell size.
const MAX_SIDE = 1600;
const MARGIN = 12;

function cellPx(root: Rect): number {
  const side = Math.max(root.w, root.h, 1);
  return Math.max(0.5, Math.min(6, MAX_SIDE / side));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function regionFill(depth: number): string {
  // Depth ramp, light and desaturated so the cities read on top.
  const l = Math.max(24, 94 - depth * 9);
  const h = 210 - depth * 6;
  return `hsl(${h} 26% ${l}%)`;
}

function regionStroke(depth: number): string {
  const l = Math.max(30, 70 - depth * 8);
  return `hsl(${210 - depth * 6} 30% ${l}%)`;
}

/**
 * Tile fill. A sheet is drawn at its full footprint now, so length is visible
 * in the geometry itself; colour only says what kind of sheet it is. Stubs
 * (under 5 effective lines) are dimmed, folded sheets are marked warmer.
 */
function tileFill(p: Placement): string {
  const lines = p.effectiveLines ?? 0;
  if (p.folded) return '#ffb340';
  if (lines > 0 && lines < 5) return '#6f6a55';
  return '#ffd479';
}

function px(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

export interface SvgOptions {
  readonly title: string;
  readonly labelMaxDepth: number;
}

export function renderSvg(layout: Layout, root: Rect, opts: SvgOptions): string {
  const CELL = cellPx(root);
  const w = root.w * CELL + MARGIN * 2;
  const h = root.h * CELL + MARGIN * 2;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<title>${esc(opts.title)}</title>`,
    `<rect width="${w}" height="${h}" fill="#0f1115"/>`,
    `<g transform="translate(${MARGIN},${MARGIN})">`,
  );

  const nodes = [...layout.values()].sort((a, b) => a.depth - b.depth);
  const labels: Placement[] = [];

  for (const n of nodes) {
    const x = n.x * CELL;
    const y = n.y * CELL;
    if (n.kind === 'dir') {
      if (n.depth === 0) continue;
      parts.push(
        `<rect x="${px(x)}" y="${px(y)}" width="${px(n.w * CELL)}" height="${px(n.h * CELL)}" ` +
          `fill="${regionFill(n.depth)}" stroke="${regionStroke(n.depth)}" stroke-width="${n.depth <= 2 ? 1.2 : 0.5}" rx="1.5"/>`,
      );
      if (n.depth <= opts.labelMaxDepth && n.w * CELL > 34 && n.h * CELL > 14) labels.push(n);
    } else {
      // The sheet, at its full footprint: one width for every file, height
      // proportional to its effective line count.
      parts.push(
        `<rect x="${px(x)}" y="${px(y)}" width="${px(n.w * CELL)}" height="${px(n.h * CELL)}" ` +
          `fill="${tileFill(n)}" rx="${px(Math.min(1, CELL * 0.3))}"/>`,
      );
      if (n.folded && n.h * CELL > 6) {
        // Fold marker: a dashed rule across the sheet, the collapsed-diff idiom.
        const my = y + n.h * CELL * 0.5;
        parts.push(
          `<line x1="${px(x + 1)}" y1="${px(my)}" x2="${px(x + n.w * CELL - 1)}" y2="${px(my)}" ` +
            `stroke="#0f1115" stroke-width="0.8" stroke-dasharray="2 2"/>`,
        );
      }
    }
  }

  for (const n of labels) {
    const fs = n.depth === 1 ? 13 : 9;
    parts.push(
      `<text x="${px(n.x * CELL + 3)}" y="${px(n.y * CELL + fs + 1)}" font-family="ui-monospace,Menlo,monospace" ` +
        `font-size="${fs}" fill="#e8eef7" opacity="${n.depth === 1 ? 0.95 : 0.7}">${esc(pathName(n.path))}</text>`,
    );
  }

  parts.push('</g>', '</svg>');
  return parts.join('\n');
}

export function renderOverlay(
  a: Layout,
  b: Layout,
  root: Rect,
  labelsFrom: Layout,
  title: string,
): string {
  const CELL = cellPx(root);
  const w = root.w * CELL + MARGIN * 2;
  const h = root.h * CELL + MARGIN * 2;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="${w}" height="${h}" fill="#0f1115"/>`,
    `<g transform="translate(${MARGIN},${MARGIN})">`,
  ];

  const draw = (l: Layout, stroke: string, fill: string, sw: number, maxDepth: number): void => {
    for (const n of l.values()) {
      if (n.kind !== 'dir' || n.depth === 0 || n.depth > maxDepth) continue;
      parts.push(
        `<rect x="${px(n.x * CELL)}" y="${px(n.y * CELL)}" width="${px(n.w * CELL)}" height="${px(n.h * CELL)}" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
      );
    }
  };

  // commit 1 as cool outlines, commit 50 as translucent warm fills on top
  draw(a, '#5ec8ff', 'none', 1.1, 3);
  draw(b, '#ff9d4d', 'rgba(255,157,77,0.16)', 1.1, 3);

  for (const n of labelsFrom.values()) {
    if (n.kind !== 'dir' || n.depth !== 1) continue;
    parts.push(
      `<text x="${px(n.x * CELL + 3)}" y="${px(n.y * CELL + 14)}" font-family="ui-monospace,Menlo,monospace" ` +
        `font-size="13" fill="#e8eef7">${esc(pathName(n.path))}</text>`,
    );
  }

  parts.push(
    `<g font-family="ui-monospace,Menlo,monospace" font-size="12">`,
    `<rect x="4" y="4" width="250" height="42" fill="rgba(0,0,0,0.55)"/>`,
    `<text x="12" y="20" fill="#5ec8ff">commit 1 outline</text>`,
    `<text x="12" y="36" fill="#ff9d4d">commit 50 fill</text>`,
    `</g>`,
    '</g>',
    '</svg>',
  );
  return parts.join('\n');
}

export function pathName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}
