// Standalone viewer: the three snapshots side by side (inlined SVG) plus a
// canvas scrubber over every replayed commit, fed by delta-encoded rect data.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitMetrics } from './metrics.ts';
import type { Layout, Rect } from './types.ts';

interface Frame {
  readonly sha: string;
  readonly date: string;
  readonly layout: Layout;
}

interface Packed {
  root: { w: number; h: number };
  ids: string[];
  kinds: number[];
  depths: number[];
  base: number[][];
  deltas: { add: number[][]; del: number[]; mov: number[][] }[];
  labels: { i: number; x: number; y: number }[];
  meta: { sha: string; date: string; files: number; moved: number; outside: number; p95: number }[];
}

function pack(frames: Frame[], root: Rect, rows: CommitMetrics[]): Packed {
  const index = new Map<string, number>();
  const ids: string[] = [];
  const kinds: number[] = [];
  const depths: number[] = [];
  const idOf = (path: string, kind: 'file' | 'dir', depth: number): number => {
    let i = index.get(path);
    if (i === undefined) {
      i = ids.length;
      index.set(path, i);
      ids.push(path);
      kinds.push(kind === 'dir' ? 1 : 0);
      depths.push(depth);
    }
    return i;
  };

  const first = frames[0]!;
  const base: number[][] = [];
  for (const p of first.layout.values()) {
    if (p.depth === 0) continue;
    base.push([idOf(p.path, p.kind, p.depth), p.x, p.y, p.w, p.h]);
  }

  const deltas: Packed['deltas'] = [];
  for (let f = 1; f < frames.length; f++) {
    const prev = frames[f - 1]!.layout;
    const cur = frames[f]!.layout;
    const add: number[][] = [];
    const mov: number[][] = [];
    const del: number[] = [];
    for (const p of cur.values()) {
      if (p.depth === 0) continue;
      const before = prev.get(p.path);
      const i = idOf(p.path, p.kind, p.depth);
      if (!before) add.push([i, p.x, p.y, p.w, p.h]);
      else if (before.x !== p.x || before.y !== p.y || before.w !== p.w || before.h !== p.h) {
        mov.push([i, p.x, p.y, p.w, p.h]);
      }
    }
    for (const p of prev.values()) {
      if (p.depth === 0) continue;
      if (!cur.has(p.path)) del.push(idOf(p.path, p.kind, p.depth));
    }
    deltas.push({ add, del, mov });
  }

  const labels = [...frames.at(-1)!.layout.values()]
    .filter((p) => p.kind === 'dir' && p.depth === 1)
    .map((p) => ({ i: idOf(p.path, 'dir', 1), x: p.x, y: p.y }));

  const meta = rows.map((r) => ({
    sha: r.sha,
    date: r.date,
    files: r.files,
    moved: r.moved,
    outside: r.movedOutsideChange,
    p95: Number(r.p95Instability.toFixed(3)),
  }));

  return { root: { w: root.w, h: root.h }, ids, kinds, depths, base, deltas, labels, meta };
}

function readSvgBody(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return '<p>missing</p>';
  }
}

export function writeIndexHtml(
  out: string,
  frames: Frame[],
  root: Rect,
  rows: CommitMetrics[],
  summary: Record<string, unknown>,
): void {
  const packed = pack(frames, root, rows);
  const last = frames.length;
  const snapNames = [1, 25, last].filter((n, i, arr) => arr.indexOf(n) === i && n <= last);
  const panels = snapNames
    .map(
      (n) =>
        `<figure><figcaption>commit ${n} &middot; ${rows[n - 1]!.sha} &middot; ${rows[n - 1]!.date}</figcaption>` +
        `<div class="svgbox">${readSvgBody(out, `commit-${String(n).padStart(2, '0')}.svg`)}</div></figure>`,
    )
    .join('\n');
  const overlay = readSvgBody(out, 'overlay-1-vs-50.svg');

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td>${r.index}</td><td>${r.sha}</td><td>${r.files}</td><td>${r.rootW}x${r.rootH}</td>` +
        `<td>${r.whitespace.toFixed(3)}</td><td>${r.meanAspect.toFixed(2)}</td><td>${r.worstAspect.toFixed(2)}</td>` +
        `<td>${r.moved}</td><td>${r.movedOutsideChange}</td><td>${r.medianInstability.toFixed(2)}</td>` +
        `<td>${r.p95Instability.toFixed(2)}</td><td>${r.maxInstability.toFixed(2)}</td>` +
        `<td>${r.growEvents}</td><td>${r.relocateEvents}</td><td>${r.changedFiles}</td></tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Wake spike 3: stable geography replay</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f1115; color:#e8eef7; font:13px/1.5 ui-monospace,Menlo,monospace; }
  h1 { font-size:16px; margin:16px; font-weight:600; }
  h2 { font-size:13px; margin:24px 16px 8px; color:#8fb3d9; text-transform:uppercase; letter-spacing:.08em; }
  .row { display:flex; gap:12px; padding:0 16px; overflow-x:auto; }
  figure { margin:0; flex:0 0 auto; }
  figcaption { color:#8fb3d9; padding-bottom:6px; }
  .svgbox svg { width:420px; height:auto; display:block; border:1px solid #2a3240; }
  #overlay svg { width:min(900px,95vw); height:auto; border:1px solid #2a3240; }
  #wrap { padding:0 16px; }
  canvas { border:1px solid #2a3240; background:#0f1115; max-width:100%; }
  .ctl { display:flex; align-items:center; gap:12px; padding:8px 16px; }
  input[type=range] { flex:1; }
  #stat { color:#ffd479; white-space:pre; }
  table { border-collapse:collapse; margin:8px 16px; font-size:11px; }
  th,td { border:1px solid #2a3240; padding:2px 6px; text-align:right; }
  th { color:#8fb3d9; position:sticky; top:0; background:#151922; }
  pre { margin:8px 16px; padding:10px; background:#151922; border:1px solid #2a3240; overflow-x:auto; }
</style>
<h1>Wake spike 3 &mdash; stable geography over ${last} real commits</h1>

<h2>Snapshots</h2>
<div class="row">${panels}</div>

<h2>Commit 1 vs commit ${last} overlay</h2>
<div id="overlay" style="padding:0 16px">${overlay}</div>

<h2>Scrubber</h2>
<div class="ctl">
  <button id="play">play</button>
  <input id="slider" type="range" min="1" max="${last}" value="1">
  <span id="stat"></span>
</div>
<div id="wrap"><canvas id="c"></canvas></div>

<h2>Per-commit metrics</h2>
<table><thead><tr>
<th>#</th><th>sha</th><th>files</th><th>root</th><th>white</th><th>meanAR</th><th>worstAR</th>
<th>moved</th><th>outside</th><th>medSig</th><th>p95Sig</th><th>maxSig</th><th>grow</th><th>reloc</th><th>chgFiles</th>
</tr></thead><tbody>${rowsHtml}</tbody></table>

<h2>Summary</h2>
<pre>${JSON.stringify(summary, null, 2).replace(/</g, '&lt;')}</pre>

<script id="data" type="application/json">${JSON.stringify(packed)}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const CELL = Math.max(0.5, Math.min(6, 1500 / Math.max(D.root.w, D.root.h))), PAD = 8;
const cv = document.getElementById('c');
cv.width = D.root.w * CELL + PAD * 2;
cv.height = D.root.h * CELL + PAD * 2;
const ctx = cv.getContext('2d');

function stateAt(n) {
  const m = new Map();
  for (const r of D.base) m.set(r[0], r);
  for (let i = 0; i < n - 1; i++) {
    const d = D.deltas[i];
    for (const r of d.add) m.set(r[0], r);
    for (const r of d.mov) m.set(r[0], r);
    for (const id of d.del) m.delete(id);
  }
  return m;
}

function fillFor(depth) {
  const l = Math.max(24, 94 - depth * 9);
  return 'hsl(' + (210 - depth * 6) + ' 26% ' + l + '%)';
}

function draw(n) {
  const m = stateAt(n);
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const rects = [...m.values()].sort((a, b) => D.depths[a[0]] - D.depths[b[0]]);
  for (const r of rects) {
    const id = r[0], depth = D.depths[id];
    const x = PAD + r[1] * CELL, y = PAD + r[2] * CELL;
    if (D.kinds[id] === 1) {
      ctx.fillStyle = fillFor(depth);
      ctx.fillRect(x, y, r[3] * CELL, r[4] * CELL);
      ctx.strokeStyle = 'hsl(' + (210 - depth * 6) + ' 30% ' + Math.max(30, 70 - depth * 8) + '%)';
      ctx.lineWidth = depth <= 2 ? 1 : 0.4;
      ctx.strokeRect(x + 0.5, y + 0.5, r[3] * CELL - 1, r[4] * CELL - 1);
    } else {
      // A file is a sheet: one width, height proportional to its lines.
      ctx.fillStyle = '#ffd479';
      ctx.fillRect(x, y, r[3] * CELL, r[4] * CELL);
    }
  }
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = '#e8eef7';
  for (const l of D.labels) {
    const r = m.get(l.i);
    if (!r) continue;
    ctx.fillText(D.ids[l.i], PAD + r[1] * CELL + 3, PAD + r[2] * CELL + 11);
  }
  const md = D.meta[n - 1];
  document.getElementById('stat').textContent =
    'c' + n + '  ' + md.sha + '  ' + md.date + '  files=' + md.files +
    '  moved=' + md.moved + '  moved outside change=' + md.outside + '  p95 sigma=' + md.p95;
}

const slider = document.getElementById('slider');
slider.oninput = () => draw(+slider.value);
let timer = null;
document.getElementById('play').onclick = (e) => {
  if (timer) { clearInterval(timer); timer = null; e.target.textContent = 'play'; return; }
  e.target.textContent = 'stop';
  timer = setInterval(() => {
    let v = +slider.value + 1;
    if (v > +slider.max) v = 1;
    slider.value = v;
    draw(v);
  }, 300);
};
draw(1);
</script>
`;
  writeFileSync(join(out, 'index.html'), html);
}
