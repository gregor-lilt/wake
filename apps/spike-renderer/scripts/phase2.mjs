/**
 * Phase 2 verification, "geography" (docs/design.md section 11).
 *
 * Opt-in, because only a real export has the lattice and the source on disk:
 *
 *   WAKE_EXPORT=<export name> npm run phase2
 *
 * The target file is taken from the export's own session, so no path from the
 * exported repository is written down here. Checks:
 *
 *   a  every sheet's content (bars, diff bands and glyphs) lies inside its
 *      tile, at three zooms across three bands, 30 files sampled
 *   b  at rowPx 9 a 40-line file is exactly 40 rows plus its margins inside a
 *      4-cell tile, and two files of different lengths share one font size and
 *      one line height
 *   c  every folded tile carries a fold marker inside the tile, and the
 *      caption reads effectiveLines - 400 on five sampled files
 *   d  district fill luminance rises with nesting depth along a chain of three
 *   e  district labels sit inside their own district's rect, at two zooms
 *   f  120 fps at all four bands
 *   g  the deep link still lands on the file
 *
 * Screenshots go to screenshots/31-*.png .. 35-*.png, all gitignored because
 * they render real paths and real source.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, launch, openMap, sleep } from './driver.mjs';

const NAME = process.env.WAKE_EXPORT;
if (!NAME) {
  console.error('set WAKE_EXPORT=<export name>');
  process.exit(2);
}
const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const doc = JSON.parse(readFileSync(path.resolve(ROOT, '../../.wake/exports', `${NAME}.json`), 'utf8'));

/** First file the session edited, from the export itself. */
function targetFile() {
  const files = new Set(doc.nodes.filter((n) => n.kind === 'file' && n.path).map((n) => n.path));
  for (const e of doc.session.events) {
    if ((e.kind === 'edit' || e.kind === 'write') && e.path && files.has(e.path)) return e.path;
  }
  return null;
}
const FILE = process.env.WAKE_FILE ?? targetFile();
if (!FILE) {
  console.error('no edited file in this export, set WAKE_FILE=<repo-relative path>');
  process.exit(2);
}

const errors = [];
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};
/** Relative luminance of an sRGB triplet, the plain Rec. 709 weighting. */
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const base = `data=${encodeURIComponent(NAME)}&theme=dark`;

async function goto(page, opts, settle = 1600) {
  await page.evaluate((o) => window.__wakeGoto({ ...o, ms: 0 }), opts);
  await sleep(settle);
}

/** Everything the containment checks need, read in one pass. */
async function snap(page, limit = 96) {
  return page.evaluate((n) => {
    const st = window.__wakeCodeState();
    const audit = window.__wakeAudit(n);
    const overlays = [...document.querySelectorAll('.wake-ov')]
      .filter((el) => el.style.visibility === 'visible' && Number(el.style.opacity) > 0.3)
      .map((el) => {
        const pre = el.querySelector('pre');
        const cs = getComputedStyle(pre);
        const r = el.getBoundingClientRect();
        return {
          file: Number(el.dataset.file),
          fontSize: parseFloat(cs.fontSize),
          lineHeight: parseFloat(cs.lineHeight),
          rect: { x: r.left, y: r.top, w: r.width, h: r.height }
        };
      });
    return { st, audit, overlays };
  }, limit);
}

/** fps at rest, measured over 2 s of the page's own frame counter. */
async function fpsHere(page) {
  const f0 = await page.evaluate('window.__wakeCodeState().frames');
  await sleep(2000);
  const st = await page.evaluate('window.__wakeCodeState()');
  return { fps: ((st.frames - f0) * 1000) / 2000, st };
}

const stop = await startServer();
const { browser, context } = await launch();
// The lattice makes a tile 450 px wide and 360 to 3600 px tall at the start of
// the reading band, so a wide viewport still helps for the multi-file checks.
const wideCtx = await browser.newContext({ viewport: { width: 2400, height: 1500 }, deviceScaleFactor: 1 });
try {
  const a = await openMap(context, `${base}&file=${encodeURIComponent(FILE)}`);
  errors.push(...a.errors);
  await a.page.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await sleep(1200);

  const fx = await a.page.evaluate('window.__wakeFixture');
  const files = await a.page.evaluate('window.__wakeFiles()');
  console.log(
    `\nlattice: rowWorld ${fx.rowWorld} world units/line, world ${fx.worldSide} units, ` +
    `bands at zoom ${fx.zoomSchematic} (schematic) / ${fx.zoomReading} (reading) / ${fx.zoomMax} (max)`
  );
  console.log(
    `${files.count} files, ${files.folded.length} folded, ${files.stubs.length} stubs, ` +
    `${fx.effectiveLines.toLocaleString()} effective lines, ` +
    `district coverage ${fx.districtCoveragePct}% (median of districts with > 8 files), ` +
    `global tile area ${fx.cityAreaPctOfRegion}% of region area`
  );

  // ---- b: the geometry of a 40-line file, and one type scale --------------
  const w = await openMap(wideCtx, `${base}&file=${encodeURIComponent(FILE)}`);
  const wide = w.page;
  errors.push(...w.errors);
  await wide.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await goto(wide, { rowPx: 9 });
  const sp = await wide.evaluate('window.__wakeSheetProbe(40)');
  console.log(`   sheet of a 40-line file: ${JSON.stringify(sp)}`);
  ok(sp.tileCells === 4 && sp.tileRows === 40,
    `b a 40-line file gets a 4-cell tile of 40 rows (${sp.tileCells} cells, ${sp.tileRows} rows)`);
  ok(sp.contentRows === 40 && Math.abs(sp.contentHeightPx - 40 * 9) < 0.01,
    `b it occupies exactly 40 rows at rowPx 9 (${sp.contentRows} rows, ${sp.contentHeightPx} px)`);
  ok(Math.abs(sp.contentHeightPx + 2 * sp.padRows * sp.rowPx - sp.tileHeightPx) < 0.01,
    `b rows plus margins are the tile exactly (${sp.contentHeightPx} + 2 x ${sp.padRows} rows = ${sp.tileHeightPx} px)`);
  ok(sp.cols === 100 && Math.abs(sp.tileWidthPx - 100 * 4.5) < 0.01 && Math.abs(sp.textWidthPx - 96 * 4.5) < 0.01,
    `b the tile is 100 columns and the text box 96 (${sp.tileWidthPx} / ${sp.textWidthPx} px)`);
  const sp190 = await wide.evaluate('window.__wakeSheetProbe(190)');
  ok(sp190.tileRows === 200 && sp190.contentRows === 190 && sp190.padRows === 1,
    `b a 190-line file fills 190 rows of a 20-cell tile with one row of margin ` +
    `(${sp190.contentRows} of ${sp190.tileRows} rows, pad ${sp190.padRows})`);
  const sp200 = await wide.evaluate('window.__wakeSheetProbe(200)');
  ok(sp200.tileRows === 200 && sp200.padRows === 0,
    `b a 200-line file lands exactly on a step, so the margin shrinks to 0 rather than ` +
    `pushing a row outside the tile (${sp200.contentRows} of ${sp200.tileRows} rows)`);

  // two files of different lengths, one font size
  const pairShot = await snap(wide);
  const seenPair = new Map();
  for (const o of pairShot.overlays) if (!seenPair.has(o.file)) seenPair.set(o.file, o);
  const two = [...seenPair.values()].slice(0, 2);
  ok(two.length >= 2, `b ${seenPair.size} source overlays on one screen at rowPx 9`);
  if (two.length >= 2) {
    const probes = new Map(pairShot.st.probes.filter(Boolean).map((p) => [p.file, p]));
    const l0 = probes.get(two[0].file)?.effectiveLines;
    const l1 = probes.get(two[1].file)?.effectiveLines;
    ok(l0 !== l1, `b the two files are different lengths (${l0} vs ${l1} effective lines)`);
    ok(Math.abs(two[0].fontSize - two[1].fontSize) < 0.01,
      `b same font size (${two[0].fontSize} / ${two[1].fontSize})`);
    ok(Math.abs(two[0].lineHeight - two[1].lineHeight) < 0.01,
      `b same line height (${two[0].lineHeight} / ${two[1].lineHeight})`);
    ok(Math.abs(two[0].lineHeight - pairShot.st.rowPx) < 0.05,
      `b line height is rowPx (${two[0].lineHeight} vs ${pairShot.st.rowPx.toFixed(2)})`);
  }

  // ---- a: nothing outside its tile, three bands, 30 files ----------------
  // The camera is aimed at a spread of files rather than at pixel offsets,
  // because a district covers a small part of its region and a grid of camera
  // positions mostly lands on terrain.
  const spread = [];
  for (let i = 0; i < 12; i++) spread.push(Math.floor((i * files.count) / 12));
  const allSeen = new Set();
  for (const [px, want] of [[3.5, 'schematic'], [6, 'schematic'], [9, 'reading'], [14, 'reading']]) {
    const seen = new Map();
    let outside = 0;
    let quads = 0;
    let ovOut = 0;
    let ovCount = 0;
    let bandName = '';
    for (const file of spread) {
      await goto(wide, { rowPx: px, file }, 1400);
      const s = await snap(wide);
      bandName = `${s.st.band}/${s.st.tier}`;
      outside += s.audit.outside;
      for (const f of s.audit.perFile) {
        if (seen.has(f.file)) continue;
        seen.set(f.file, f);
        allSeen.add(f.file);
        quads += f.quads;
      }
      // The DOM half: an overlay's box never leaves its own tile.
      const probes = new Map(s.st.probes.filter(Boolean).map((p) => [p.file, p]));
      for (const o of s.overlays) {
        const p = probes.get(o.file);
        if (!p) continue;
        ovCount++;
        const eps = 1.5;
        if (o.rect.x < p.tile.x - eps || o.rect.x + o.rect.w > p.tile.x + p.tile.w + eps ||
            o.rect.y < p.tile.y - eps || o.rect.y + o.rect.h > p.tile.y + p.tile.h + eps) ovOut++;
      }
      if (seen.size >= 30) break;
    }
    ok(bandName.startsWith(want), `a rowPx ${px} is the ${want} band (${bandName})`);
    ok(outside === 0,
      `a rowPx ${px} (${bandName}): ${quads} quads over ${seen.size} files, ${outside} outside their tile`);
    ok(ovOut === 0, `a rowPx ${px}: ${ovCount} source overlays, ${ovOut} outside their tile`);
  }
  ok(allSeen.size >= 30, `a ${allSeen.size} distinct files sampled across the three bands`);

  // ---- c: the fold marker ------------------------------------------------
  const folds = files.folds;
  ok(folds.length === files.folded.length && folds.every((f) => f.fits),
    `c ${folds.length} folded tiles, all with the marker inside the tile`);
  ok(folds.every((f) => f.tileRows === 400 && f.textRows === 398),
    'c every folded tile is 400 rows with 398 for source and 2 for the marker');
  const sample = folds.filter((f) => f.effectiveLines !== 401).slice(0, 5);
  for (const f of sample) {
    await goto(wide, { rowPx: 9, file: f.file, line: Math.max(0, f.markerRow - 20) }, 2000);
    const marks = await wide.evaluate((id) => {
      const el = document.querySelector(`.wake-ov[data-file="${id}"] .r.fold`);
      if (!el) return null;
      const b = el.querySelector('b');
      const r = el.getBoundingClientRect();
      return { text: b ? b.textContent : null, h: r.height, rule: !!el.querySelector('u') };
    }, f.file);
    const want = `+${(f.effectiveLines - 400).toLocaleString()} lines`.toUpperCase().split('').join(' ');
    ok(marks !== null && marks.text === want && marks.rule,
      `c file ${f.file} (${f.effectiveLines} effective lines): marker reads ` +
      `"${marks ? marks.text.replace(/ /g, '') : 'missing'}", wanted "${want.replace(/ /g, '')}"`);
    if (marks) {
      ok(Math.abs(marks.h - 2 * 9) < 1.5, `c file ${f.file}: the marker is two rows tall (${marks.h.toFixed(1)} px)`);
    }
  }

  // ---- d: the fill ramp ---------------------------------------------------
  const geo = await wide.evaluate('window.__wakeGeo()');
  const byId = new Map(geo.dirs.map((d) => [d.id, d]));
  let chain = null;
  for (const d of geo.dirs) {
    if (d.level !== 3) continue;
    const p = byId.get(d.parent);
    const g = p ? byId.get(p.parent) : null;
    if (p && g && p.level === 2 && g.level === 1) { chain = [g, p, d]; break; }
  }
  ok(chain !== null, 'd a nesting chain of three levels exists');
  if (chain) {
    const ls = chain.map((d) => Math.round(lum(d.fill) * 10) / 10);
    ok(ls[0] < ls[1] && ls[1] < ls[2],
      `d fill luminance rises with depth in one region: ${ls.join(' < ')} (levels 1, 2, 3)`);
    const land = Math.round(lum(geo.land.fill) * 10) / 10;
    ok(land < ls[0], `d the terrain is darker than a top-level region (${land} < ${ls[0]})`);
    ok(chain.every((d) => d.region === chain[0].region), 'd the chain stays in one region, so the hue is fixed');
    const w1 = chain[0], w3 = chain[2];
    ok(lum(w1.line) > lum(w1.fill) && lum(w3.line) > lum(w3.fill),
      'd every border is lighter than its own fill in the dark theme');
  }

  // ---- e: district labels inside their district --------------------------
  for (const view of ['fit', 'district']) {
    if (view === 'fit') {
      await wide.evaluate(() => window.__wakeFitAll());
    } else {
      await goto(wide, { rowPx: 2.5 }, 1600);
    }
    await sleep(1600);
    const labels = await wide.evaluate('window.__wakeLabels()');
    let out = 0;
    for (const l of labels.districts) {
      // Since phase 5 the district labels are DOM and CSS does the tracking,
      // so the string is the plain name and its width is the tracked advance
      // times its own length.
      const chars = l.text.length;
      const wPx = chars * l.size * (0.66 + 0.28);
      const inside =
        l.anchor.x >= l.rect.x - 1 && l.anchor.x + wPx <= l.rect.x + l.rect.w + 1 &&
        l.anchor.y - l.size / 2 >= l.rect.y - 1 && l.anchor.y + l.size / 2 <= l.rect.y + l.rect.h + 1;
      if (!inside) out++;
    }
    const zoomNow = await wide.evaluate('window.__wakeCodeState().zoom');
    ok(out === 0,
      `e ${view} (zoom ${zoomNow.toFixed(2)}): ${labels.districts.length} district labels, ${out} outside their rect ` +
      `(sizes ${[...new Set(labels.districts.map((l) => l.size.toFixed(1)))].join('/')} px)`);
    ok(labels.districts.every((l) => l.size >= 10 && l.size <= 14),
      `e ${view}: every district label is between 10 and 14 px`);
    const maxFile = Math.max(0, ...labels.files.map((l) => l.priority));
    const minDistrict = Math.min(100, ...labels.districts.map((l) => l.priority));
    ok(labels.districts.length === 0 || labels.files.length === 0 || minDistrict > maxFile,
      `e district labels outrank file labels (${minDistrict} > ${maxFile})`);
    ok(new Set(labels.files.map((l) => l.size)).size <= 1,
      `e one file-label size at this zoom (${[...new Set(labels.files.map((l) => l.size))].join('/')})`);
  }

  // File labels arrive with the schematic band, one size for the whole map.
  await goto(wide, { rowPx: 5 }, 1800);
  const fl = await wide.evaluate('window.__wakeLabels()');
  ok(fl.files.length > 0, `e ${fl.files.length} file labels in the schematic band`);
  ok(new Set(fl.files.map((l) => l.size)).size === 1,
    `e one file-label size (${[...new Set(fl.files.map((l) => l.size))].join('/')} px)`);
  ok(fl.files.every((l) => l.anchor.y < l.rect.y + 0.5),
    'e every file label sits above its sheet\'s top edge');
  ok(fl.files.every((l) => Math.abs(l.anchor.x - l.rect.x) < 4),
    'e every file label is left aligned on its sheet');
  ok(fl.files.every((l) => !l.text.includes(' ')), 'e file labels are sentence case, not tracked');
  const stubLabels = fl.files.filter((l) => files.stubs.includes(l.file)).length;

  await wide.close();

  // ---- f: fps at all four bands, plus the screenshots --------------------
  const shots = [
    [0.3, '31-band-terrain.png'],
    [1.5, '32-band-schematic-low.png'],
    [5, '33-band-schematic.png'],
    [9, '34-band-reading.png']
  ];
  for (const [px, shot] of shots) {
    await goto(a.page, { rowPx: px }, 1600);
    const { fps, st } = await fpsHere(a.page);
    await a.page.screenshot({ path: path.join(OUT, shot) });
    ok(fps >= 100,
      `f ${st.band}: ${fps.toFixed(0)} fps, rowPx ${st.rowPx.toFixed(2)}, ` +
      `${st.sheets} sheets, ${st.quads} quads -> ${shot}`);
    // Coming up from the terrain, the two bands below the schematic draw no
    // code at all: files are texture and flat tiles.
    if (px < 3) {
      ok(st.tier === 'tile' && st.quads === 0 && st.sheets === 0,
        `a the ${st.band} band draws no sheet content at all (tier ${st.tier})`);
    }
  }
  // A folded tile in the reading band, for review.
  const foldShot = folds.filter((f) => f.effectiveLines !== 401)[0];
  await goto(a.page, { rowPx: 9, file: foldShot.file, line: Math.max(0, foldShot.markerRow - 30) }, 2400);
  await a.page.screenshot({ path: path.join(OUT, '35-fold-marker.png') });
  console.log(`shot 35-fold-marker.png  file ${foldShot.file}, +${foldShot.hidden} lines hidden`);

  // ---- g: the deep link --------------------------------------------------
  const d = await openMap(context, `${base}&file=${encodeURIComponent(FILE)}`);
  errors.push(...d.errors);
  await d.page.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await sleep(2200);
  const land = await d.page.evaluate(() => {
    const st = window.__wakeCodeState();
    return { st, p: st.sheet, cx: window.innerWidth / 2, cy: window.innerHeight / 2 };
  });
  ok(Math.abs(land.st.rowPx - 9) < 0.5, `g deep link lands at rowPx ${land.st.rowPx.toFixed(2)}`);
  ok(land.p !== null, 'g the target file has a sheet');
  if (land.p) {
    const p = land.p;
    ok(p.sheet.x <= land.cx && p.sheet.x + p.sheet.w >= land.cx,
      `g the sheet spans the centre horizontally (${p.sheet.x.toFixed(0)}..${(p.sheet.x + p.sheet.w).toFixed(0)} vs ${land.cx})`);
    ok(p.sheet.y <= land.cy && p.sheet.y + p.sheet.h >= land.cy,
      `g the sheet spans the centre vertically (${p.sheet.y.toFixed(0)}..${(p.sheet.y + p.sheet.h).toFixed(0)} vs ${land.cy})`);
    const line = Math.round((land.cy - p.text.y) / p.rowPx);
    ok(land.st.firstChanged < 0 || Math.abs(line - land.st.firstChanged) <= 1,
      `g the centred row is the first changed line (row ${line} vs ${land.st.firstChanged})`);
  }
  await d.page.close();

  // The effective-line cross-check, over every file the run touched.
  const audit = (await a.page.evaluate('window.__wakeFiles()')).lineAudit;
  const floors = audit.mismatches.filter((m) => m.exported === 401).length;
  ok(audit.mismatches.length === floors,
    `wrapping agrees with the export on ${audit.checked} files ` +
    `(${audit.mismatches.length} mismatches, ${floors} of them the export's 401 floor)`);
  if (audit.mismatches.length) {
    console.log('   ' + audit.mismatches.map((m) => `file ${m.file}: export ${m.exported}, wrapped ${m.wrapped}, raw ${m.raw}`).join('\n   '));
  }

  errors.push(...a.errors, ...w.errors);
  await a.page.close();
  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
  else console.log(`all checks passed`);
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
