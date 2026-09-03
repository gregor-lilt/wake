// Spike 3 replay harness.
//
//   node --experimental-strip-types src/replay.ts [--repo PATH] [--branch main]
//        [--commits 50] [--order coupling|size] [--slack 0.3] [--out out]
//
// Walks N consecutive commits of a real repository, feeds each commit's tree
// through the layout with the SAME carried state, and measures how much the
// map moved beyond what the change forced.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  buildTree,
  changedPaths,

  listCommits,
  listTree,
} from './gitTree.ts';
import { DEFAULT_CONFIG, LayoutState, layoutTree, type LayoutResult } from './layout.ts';
import { effectiveLinesOfBlobs } from './lines.ts';
import {
  compareLayouts,
  insideChange,
  quantile,
  type CommitMetrics,
} from './metrics.ts';
import { extractCoupling, makeOrderFn, type CouplingMap, type OrderMode } from './order.ts';
import { renderOverlay, renderSvg } from './svg.ts';
import { writeIndexHtml } from './html.ts';
import { toPng } from './png.ts';
import type { Layout } from './types.ts';

interface Args {
  repo: string;
  branch: string;
  commits: number;
  order: OrderMode;
  colSlack: number;
  linesPerCell: number;
  tileW: number;
  gap: number;
  cellLines: number;
  cellAspect: number;
  foldCap: number;
  branchSlack: number;
  padMaxDepth: number;
  initialPack: 'frozen' | 'height-desc';
  growthReserve: number;
  reserveMinSide: number;
  reserveMaxQuantum: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    repo: process.env['WAKE_TEST_REPO'] ?? '',
    branch: 'main',
    commits: 50,
    order: 'coupling',
    colSlack: DEFAULT_CONFIG.colSlack,
    linesPerCell: DEFAULT_CONFIG.linesPerCell,
    tileW: DEFAULT_CONFIG.tileW,
    gap: DEFAULT_CONFIG.gap,
    cellLines: DEFAULT_CONFIG.cellLines,
    cellAspect: 0,
    foldCap: DEFAULT_CONFIG.foldCap,
    branchSlack: DEFAULT_CONFIG.branchSlack,
    padMaxDepth: DEFAULT_CONFIG.padMaxDepth,
    initialPack: DEFAULT_CONFIG.initialPack,
    growthReserve: DEFAULT_CONFIG.growthReserve,
    reserveMinSide: DEFAULT_CONFIG.reserveMinSide,
    reserveMaxQuantum: DEFAULT_CONFIG.reserveMaxQuantum,
    out: resolvePath(import.meta.dirname, '..', 'out'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (val === undefined) break;
    if (key === '--repo') a.repo = val;
    else if (key === '--branch') a.branch = val;
    else if (key === '--commits') a.commits = Number(val);
    else if (key === '--order') a.order = val as OrderMode;
    else if (key === '--col-slack') a.colSlack = Number(val);
    else if (key === '--lines-per-cell') a.linesPerCell = Number(val);
    else if (key === '--tile-w') a.tileW = Number(val);
    else if (key === '--gap') a.gap = Number(val);
    else if (key === '--cell-lines') a.cellLines = Number(val);
    else if (key === '--cell-aspect') a.cellAspect = Number(val);
    else if (key === '--fold-cap') a.foldCap = Number(val);
    else if (key === '--branch-slack') a.branchSlack = Number(val);
    else if (key === '--pad-max-depth') a.padMaxDepth = Number(val);
    else if (key === '--initial-pack') a.initialPack = val as 'frozen' | 'height-desc';
    else if (key === '--growth-reserve') a.growthReserve = Number(val);
    else if (key === '--reserve-min-side') a.reserveMinSide = Number(val);
    else if (key === '--reserve-max-quantum') a.reserveMaxQuantum = Number(val);
    else if (key === '--out') a.out = resolvePath(val);
  }
  if (a.cellAspect === 0) {
    // A cell is (100 / tileW) glyphs wide and cellLines lines tall, and a
    // monospace glyph is about 0.6 of a line-height wide.
    a.cellAspect = ((100 / a.tileW) * 0.6) / a.cellLines;
  }
  if (a.repo === '') {
    throw new Error('no repository given: pass --repo /path/to/repo or set WAKE_TEST_REPO');
  }
  return a;
}

/** Aspect ratio in WORLD units: a cell is cellAspect times wider than tall. */
function aspect(w: number, h: number, cellAspect = DEFAULT_CONFIG.cellAspect): number {
  const ww = w * cellAspect;
  return ww >= h ? ww / Math.max(1, h) : h / Math.max(1e-9, ww);
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = {
    ...DEFAULT_CONFIG,
    colSlack: args.colSlack,
    linesPerCell: args.linesPerCell,
    tileW: args.tileW,
    gap: args.gap,
    cellLines: args.cellLines,
    cellAspect: args.cellAspect,
    foldCap: args.foldCap,
    branchSlack: args.branchSlack,
    padMaxDepth: args.padMaxDepth,
    initialPack: args.initialPack,
    growthReserve: args.growthReserve,
    reserveMinSide: args.reserveMinSide,
    reserveMaxQuantum: args.reserveMaxQuantum,
  };
  mkdirSync(args.out, { recursive: true });

  const t0 = performance.now();
  const commits = listCommits(args.repo, args.branch, args.commits);
  if (commits.length === 0) throw new Error('no commits found');
  console.log(
    `replaying ${commits.length} commits of ${args.repo} (${commits[0]!.date} .. ${commits.at(-1)!.date})`,
  );

  // Frozen order, computed ONCE on the first commit and never recomputed.
  let coupling: CouplingMap | null = null;
  let couplingNote = 'size-desc then name';
  if (args.order === 'coupling') {
    const tCoup = performance.now();
    const firstTree = buildTree(listTree(args.repo, commits[0]!.sha));
    const res = await extractCoupling(args.repo, commits[0]!.sha, firstTree);
    coupling = res.coupling;
    couplingNote =
      `coupling seriation from ${res.edges} relative-import edges over ` +
      `${res.filesScanned} .ts/.tsx files (${(res.bytesScanned / 1e6).toFixed(1)} MB scanned, ` +
      `${((performance.now() - tCoup) / 1000).toFixed(1)}s)`;
    console.log(couplingNote);
  }
  const order = makeOrderFn(args.order, coupling);

  const state = new LayoutState();
  const lineCache = new Map<string, number>();
  let blobsRead = 0;
  let bytesRead = 0;
  const rows: CommitMetrics[] = [];
  const snapshots = new Map<number, { layout: Layout; result: LayoutResult }>();
  const frames: { sha: string; date: string; layout: Layout }[] = [];
  let prev: Layout | null = null;
  let prevSha: string | null = null;
  const outsideExamples: string[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]!;
    // Effective lines per commit, from `git cat-file --batch`, cached by blob
    // sha: a sha pins its content, so only blobs that actually changed are
    // read. Commit 1 pays for the whole tree, the other 49 pay for their diff.
    const raw = listTree(args.repo, c.sha);
    const linesRes = await effectiveLinesOfBlobs(
      args.repo,
      raw.map((e) => ({ sha: e.sha ?? '', path: e.path, size: e.size })),
      cfg.foldCap,
      lineCache,
    );
    blobsRead += linesRes.blobsRead;
    bytesRead += linesRes.bytesRead;
    const entries = raw.map((e) => ({ ...e, lines: linesRes.lines.get(e.sha ?? '') ?? 1 }));
    const tc = performance.now();
    const tree = buildTree(entries);
    const result = layoutTree(tree, state, order, cfg);
    const ms = performance.now() - tc;

    const dirs = result.regionStats.length;
    const files = result.fileCount;
    const rootArea = result.root.w * result.root.h;
    // Whitespace is now measured against the DRAWN tile area, not a file
    // count: a tile is tileW x (its height in cells), not one cell.
    let fileArea = 0;
    let folded = 0;
    let gapCells = 0;
    for (const p of result.layout.values()) {
      // Every footprint carries the tile gap on its right and bottom edge.
      gapCells += (p.w + cfg.gap) * (p.h + cfg.gap) - p.w * p.h;
      if (p.kind !== 'file') continue;
      fileArea += p.w * p.h;
      if (p.folded) folded++;
    }
    const whitespace = 1 - fileArea / rootArea;
    let freeSum = 0;
    let freeCells = 0;
    let borderCells = 0;
    let reserveCells = 0;
    let meanAspectSum = 0;
    let worst = 0;
    let worstPath = '';
    // docs/design.md section 4: file footprints should cover at least 35 % of
    // a district with more than eight files. Measured on the district's own
    // drawn rect, growth reserve and border gutter included.
    const coverages: number[] = [];
    for (const r of result.regionStats) {
      if (r.directFiles > 8 && r.w * r.h > 0) coverages.push(r.fileCells / (r.w * r.h));
    }
    coverages.sort((a, b) => a - b);
    for (const r of result.regionStats) {
      freeCells += r.free;
      borderCells += r.borderOverhead;
      reserveCells += r.reserveOverhead;
      freeSum += r.total > 0 ? r.free / r.total : 0;
      const ar = aspect(r.w, r.h, cfg.cellAspect);
      meanAspectSum += ar;
      if (ar > worst) {
        worst = ar;
        worstPath = r.path || '(root)';
      }
    }

    let changed: string[] = [];
    let diff = {
      samples: [] as { path: string; sigma: number }[],
      moved: 0,
      movedOutside: 0,
      movedOutsidePaths: [] as string[],
      added: files,
      removed: 0,
    };
    if (prev && prevSha) {
      changed = changedPaths(args.repo, prevSha, c.sha);
      diff = compareLayouts(prev, result.layout, insideChange(changed));
      for (const p of diff.movedOutsidePaths) {
        if (outsideExamples.length < 20) outsideExamples.push(`c${i + 1} ${p}`);
      }
    }

    const sigmas = diff.samples.map((s) => s.sigma).sort((a, b) => a - b);
    let maxPath = '';
    let maxSigma = 0;
    for (const s of diff.samples) {
      if (s.sigma > maxSigma) {
        maxSigma = s.sigma;
        maxPath = s.path;
      }
    }

    rows.push({
      index: i + 1,
      sha: c.sha.slice(0, 10),
      date: c.date,
      files,
      dirs,
      rootW: result.root.w,
      rootH: result.root.h,
      rootAspect: aspect(result.root.w, result.root.h, cfg.cellAspect),
      whitespace,
      gapFrac: gapCells / rootArea,
      foldedFiles: folded,
      coverageMedian: quantile(coverages, 0.5),
      coverageMean: coverages.length
        ? coverages.reduce((x, y) => x + y, 0) / coverages.length
        : 0,
      coverageAtTarget: coverages.filter((v) => v >= 0.35).length,
      coverageDistricts: coverages.length,
      slackFrac: freeCells / rootArea,
      gutterFrac: borderCells / rootArea,
      reserveFrac: reserveCells / rootArea,
      meanRegionFree: dirs > 0 ? freeSum / dirs : 0,
      meanAspect: dirs > 0 ? meanAspectSum / dirs : 0,
      worstAspect: worst,
      worstAspectPath: worstPath,
      added: diff.added,
      removed: diff.removed,
      moved: diff.moved,
      movedOutsideChange: diff.movedOutside,
      meanInstability: sigmas.length ? sigmas.reduce((x, y) => x + y, 0) / sigmas.length : 0,
      medianInstability: quantile(sigmas, 0.5),
      p95Instability: quantile(sigmas, 0.95),
      maxInstability: maxSigma,
      maxInstabilityPath: maxPath,
      growEvents: result.events.filter((e) => e.kind === 'grow').length,
      relocateEvents: result.events.filter((e) => e.kind === 'relocate').length,
      changedFiles: changed.length,
      ms,
    });

    frames.push({ sha: c.sha.slice(0, 10), date: c.date, layout: result.layout });
    if (i === 0 || i === 24 || i === commits.length - 1) {
      snapshots.set(i + 1, { layout: result.layout, result });
    }
    prev = result.layout;
    prevSha = c.sha;
    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(
        `  c${i + 1}  files=${files}  root=${result.root.w}x${result.root.h}  ` +
          `moved=${diff.moved}  outside=${diff.movedOutside}  p95sigma=${fmt(quantile(sigmas, 0.95), 2)}`,
      );
    }
  }

  // ---- CSV ---------------------------------------------------------------
  const header = [
    'commit', 'sha', 'date', 'files', 'dirs', 'root_w', 'root_h', 'root_aspect',
    'whitespace_frac', 'gap_frac', 'folded_files', 'coverage_median', 'coverage_mean',
    'coverage_at_target', 'coverage_districts', 'slack_frac', 'border_frac', 'reserve_frac', 'mean_region_free_frac', 'mean_region_aspect',
    'worst_region_aspect', 'worst_region_path', 'nodes_added', 'nodes_removed',
    'nodes_moved', 'nodes_moved_outside_change', 'mean_sigma_cells',
    'median_sigma_cells', 'p95_sigma_cells', 'max_sigma_cells', 'max_sigma_path',
    'grow_events', 'relocate_events', 'changed_files', 'layout_ms',
  ];
  const csvLines = [header.join(',')];
  for (const r of rows) {
    csvLines.push([
      r.index, r.sha, r.date, r.files, r.dirs, r.rootW, r.rootH, fmt(r.rootAspect),
      fmt(r.whitespace), fmt(r.gapFrac), r.foldedFiles, fmt(r.coverageMedian), fmt(r.coverageMean),
      r.coverageAtTarget, r.coverageDistricts, fmt(r.slackFrac), fmt(r.gutterFrac), fmt(r.reserveFrac), fmt(r.meanRegionFree), fmt(r.meanAspect),
      fmt(r.worstAspect), r.worstAspectPath, r.added, r.removed, r.moved,
      r.movedOutsideChange, fmt(r.meanInstability), fmt(r.medianInstability),
      fmt(r.p95Instability), fmt(r.maxInstability), r.maxInstabilityPath,
      r.growEvents, r.relocateEvents, r.changedFiles, fmt(r.ms, 1),
    ].join(','));
  }
  writeFileSync(join(args.out, 'metrics.csv'), `${csvLines.join('\n')}\n`);

  // ---- summary -----------------------------------------------------------
  const after = rows.slice(1); // commit 1 has no predecessor
  const pick = (f: (r: CommitMetrics) => number): number[] =>
    after.map(f).sort((a, b) => a - b);
  const summary = {
    commits: rows.length,
    files_first: rows[0]!.files,
    files_last: rows.at(-1)!.files,
    median_of_median_sigma: quantile(pick((r) => r.medianInstability), 0.5),
    median_of_p95_sigma: quantile(pick((r) => r.p95Instability), 0.5),
    p95_of_p95_sigma: quantile(pick((r) => r.p95Instability), 0.95),
    max_sigma: Math.max(...after.map((r) => r.maxInstability), 0),
    median_moved: quantile(pick((r) => r.moved), 0.5),
    p95_moved: quantile(pick((r) => r.moved), 0.95),
    max_moved: Math.max(...after.map((r) => r.moved), 0),
    zero_movement_layouts: after.filter((r) => r.moved === 0).length,
    zero_outside_movement_layouts: after.filter((r) => r.movedOutsideChange === 0).length,
    layouts_compared: after.length,
    whitespace_first: rows[0]!.whitespace,
    whitespace_last: rows.at(-1)!.whitespace,
    whitespace_from_gaps_last: rows.at(-1)!.gapFrac,
    whitespace_from_slack_last: rows.at(-1)!.slackFrac,
    whitespace_from_borders_last: rows.at(-1)!.gutterFrac,
    whitespace_from_growth_reserve_last: rows.at(-1)!.reserveFrac,
    mean_region_aspect_last: rows.at(-1)!.meanAspect,
    worst_region_aspect_last: rows.at(-1)!.worstAspect,
    worst_region_aspect_path_last: rows.at(-1)!.worstAspectPath,
    root_first: `${rows[0]!.rootW}x${rows[0]!.rootH}`,
    root_last: `${rows.at(-1)!.rootW}x${rows.at(-1)!.rootH}`,
    grow_events_total: rows.reduce((s, r) => s + r.growEvents, 0) - rows[0]!.growEvents,
    relocate_events_total: rows.reduce((s, r) => s + r.relocateEvents, 0) - rows[0]!.relocateEvents,
    order: couplingNote,
    col_slack_target: cfg.colSlack,
    lines_per_cell: cfg.linesPerCell,
    tile_w: cfg.tileW,
    gap: cfg.gap,
    cell_lines: cfg.cellLines,
    cell_aspect: cfg.cellAspect,
    fold_cap: cfg.foldCap,
    folded_files_last: rows.at(-1)!.foldedFiles,
    coverage_median_big_districts: rows.at(-1)!.coverageMedian,
    coverage_mean_big_districts: rows.at(-1)!.coverageMean,
    coverage_districts_at_target: rows.at(-1)!.coverageAtTarget,
    coverage_big_districts: rows.at(-1)!.coverageDistricts,
    blob_lines_read: blobsRead,
    blob_lines_cached: lineCache.size,
    branch_slack_target: cfg.branchSlack,
    pad_max_depth: cfg.padMaxDepth,
    initial_pack: cfg.initialPack,
    growth_reserve: cfg.growthReserve,
    reserve_min_side: cfg.reserveMinSide,
    reserve_max_quantum: cfg.reserveMaxQuantum,
    outside_movement_examples: outsideExamples,
    total_seconds: 0,
  };

  // ---- snapshots ---------------------------------------------------------
  const last = commits.length;
  for (const [n, snap] of snapshots) {
    writeFileSync(
      join(args.out, `commit-${String(n).padStart(2, '0')}.svg`),
      renderSvg(snap.layout, snap.result.root, {
        title: `commit ${n} (${rows[n - 1]!.sha})`,
        labelMaxDepth: 2,
      }),
    );
  }
  const first = snapshots.get(1)!;
  const final = snapshots.get(last)!;
  writeFileSync(
    join(args.out, 'overlay-1-vs-50.svg'),
    renderOverlay(first.layout, final.layout, final.result.root, final.layout,
      `commit 1 vs commit ${last}`),
  );
  writeIndexHtml(args.out, frames, final.result.root, rows, summary);

  const pngs = await toPng(args.out);
  console.log(pngs.length ? `PNG: ${pngs.join(', ')}` : 'PNG: no converter available, SVG only');

  summary.total_seconds = (performance.now() - t0) / 1000;
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${args.out}/metrics.csv, summary.json, commit-*.svg, overlay-1-vs-50.svg, index.html`);
  console.log(`total ${summary.total_seconds.toFixed(1)}s`);

  // Determinism check: same tree + fresh state twice must be identical.
  const t = buildTree(listTree(args.repo, commits.at(-1)!.sha));
  const a = layoutTree(t, new LayoutState(), makeOrderFn(args.order, coupling), cfg);
  const b = layoutTree(t, new LayoutState(), makeOrderFn(args.order, coupling), cfg);
  let same = a.layout.size === b.layout.size;
  if (same) {
    for (const [p, ra] of a.layout) {
      const rb = b.layout.get(p);
      if (!rb || rb.x !== ra.x || rb.y !== ra.y || rb.w !== ra.w || rb.h !== ra.h) {
        same = false;
        break;
      }
    }
  }
  console.log(`determinism (cold layout twice, same commit): ${same ? 'identical' : 'DIFFERENT'}`);
}

await main();
