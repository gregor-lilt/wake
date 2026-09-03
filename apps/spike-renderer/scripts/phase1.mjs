/**
 * Phase 1 verification, "type and sheet" (docs/design.md section 11). Still
 * green on the phase-2 lattice, where the squeeze it sweeps through is gone
 * and every sheet is its tile. Phase 2's own checks are in phase2.mjs.
 *
 * Opt-in, because only a real export has source on disk to read:
 *
 *   WAKE_EXPORT=<export name> npm run phase1
 *
 * The target file is taken from the export's own session (the first file the
 * agent edited), so no path from the exported repository is written down here.
 * Checks:
 *
 *   a  at three zooms in the reading band, two visible files have the same
 *      overlay font size and line height, and the line height is rowPx
 *   b  zoom clamps at rowPx 18, by fly-to and by wheel
 *   c  no bar, diff band or glyph lies outside its sheet, 20 files sampled
 *   d  a deep link lands on the file at the start of the reading band with
 *      its first changed line centred
 *
 * Screenshots of the four bands go to screenshots/21-*.png .. 24-*.png, all
 * gitignored because they render real source.
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

/** First file the session edited, from the export itself. */
function targetFile() {
  const doc = JSON.parse(readFileSync(path.resolve(ROOT, '../../.wake/exports', `${NAME}.json`), 'utf8'));
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

const base = `data=${encodeURIComponent(NAME)}&theme=dark`;

async function goto(page, rowPx, dxPx = 0) {
  await page.evaluate((o) => window.__wakeGoto({ rowPx: o.px, dxPx: o.dx, ms: 0 }), { px: rowPx, dx: dxPx });
  await sleep(1500);
}

/**
 * Put the target sheet and its right-hand neighbour both in view. Since the
 * phase-2 lattice the sheet IS the tile, 100 columns wide, so this is 450 px
 * at the start of the reading band; the wide viewport is kept so the two
 * sheets are comfortably apart.
 */
async function gotoPair(page, rowPx) {
  await page.evaluate((px) => window.__wakeGoto({ rowPx: px, pair: true, ms: 0 }), rowPx);
  await sleep(2200);
  return page.evaluate('window.__wakeCodeState().sheet?.tile.w ?? 0');
}

/** Everything the checks need, read in one pass so the frame is consistent. */
async function snap(page) {
  return page.evaluate(() => {
    const st = window.__wakeCodeState();
    const audit = window.__wakeAudit(20);
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
    return { st, audit, overlays, view: { w: window.innerWidth, h: window.innerHeight } };
  });
}

const stop = await startServer();
const { browser, context } = await launch();
// A tile is 450 px wide and 360 to 3600 px tall at the start of the reading
// band, so two files share a screen easily, but twenty distinct files at the
// bottom of the schematic band still want a large viewport.
const wideCtx = await browser.newContext({ viewport: { width: 3600, height: 4200 }, deviceScaleFactor: 1 });
const wide20Ctx = await browser.newContext({ viewport: { width: 3600, height: 2400 }, deviceScaleFactor: 1 });
try {
  // ---- a, b, c on one page ----------------------------------------------
  const a = await openMap(context, `${base}&file=${encodeURIComponent(FILE)}`);
  errors.push(...a.errors);
  await a.page.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await sleep(1200);
  const w = await openMap(wideCtx, `${base}&file=${encodeURIComponent(FILE)}`);
  const wide = w.page;
  errors.push(...w.errors);
  await wide.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  const w20 = await openMap(wide20Ctx, `${base}&file=${encodeURIComponent(FILE)}`);
  const wide20 = w20.page;
  errors.push(...w20.errors);
  await wide20.waitForFunction('window.__wakeReady === true', null, { timeout: 60_000 });

  console.log(`\nk = ${(await a.page.evaluate('window.__wakeCodeState().rowWorld')).toFixed(5)} world units/row`);
  for (const px of [9, 12, 16]) {
    const tileW = await gotoPair(wide, px);
    const s = await snap(wide);
    console.log(`   (tile ${tileW.toFixed(0)} px wide, sheet ${s.st.sheet ? s.st.sheet.sheet.w.toFixed(0) : '?'} px)`);
    const files = [...new Set(s.overlays.map((o) => o.file))];
    const two = s.overlays.filter((o, i) => s.overlays.findIndex((x) => x.file === o.file) === i).slice(0, 2);
    ok(two.length >= 2, `a rowPx ${px}: at least two source overlays (${files.length} files, band ${s.st.band})`);
    if (two.length >= 2) {
      ok(Math.abs(two[0].fontSize - two[1].fontSize) < 0.01,
        `a rowPx ${px}: same font size on two files (${two[0].fontSize} / ${two[1].fontSize})`);
      ok(Math.abs(two[0].lineHeight - two[1].lineHeight) < 0.01,
        `a rowPx ${px}: same line height on two files (${two[0].lineHeight} / ${two[1].lineHeight})`);
      ok(Math.abs(two[0].lineHeight - s.st.rowPx) < 0.05,
        `a rowPx ${px}: line height is rowPx (${two[0].lineHeight.toFixed(2)} vs ${s.st.rowPx.toFixed(2)})`);
    }
    // c, the DOM half: an overlay never leaves its sheet.
    const probes = new Map(s.st.probes.filter(Boolean).map((p) => [p.file, p]));
    let out = 0;
    for (const o of s.overlays) {
      const p = probes.get(o.file);
      if (!p) continue;
      const eps = 1.5;
      if (o.rect.x < p.sheet.x - eps || o.rect.x + o.rect.w > p.sheet.x + p.sheet.w + eps ||
          o.rect.y < p.sheet.y - eps || o.rect.y + o.rect.h > p.sheet.y + p.sheet.h + eps) out++;
    }
    ok(out === 0, `c rowPx ${px}: ${s.overlays.length} overlays inside their sheet (${out} outside)`);
    ok(s.audit.outside === 0,
      `c rowPx ${px}: ${s.audit.files} files, ${s.audit.perFile.reduce((n, f) => n + f.quads, 0)} quads inside their sheet ` +
      `(${s.audit.outside} outside, worst ${s.audit.worstPx.toFixed(3)} px)`);
  }

  // b: the clamp
  const clamp = await a.page.evaluate(() => window.__wakeGoto({ rowPx: 100, ms: 0 }));
  await sleep(1000);
  let st = await a.page.evaluate('window.__wakeCodeState()');
  ok(Math.abs(st.rowPx - 18) < 0.01, `b fly to rowPx 100 clamps at rowPx ${st.rowPx.toFixed(3)}`);
  ok(Math.abs(st.zoom - st.maxZoom) < 0.01,
    `b zoom is maxZoom ${st.maxZoom.toFixed(3)} (asked ${clamp.zoom.toFixed(3)})`);
  await a.page.evaluate(() => {
    const c = document.getElementById('map');
    for (let i = 0; i < 30; i++) {
      c.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -240, clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, bubbles: true, cancelable: true
      }));
    }
  });
  await sleep(1200);
  st = await a.page.evaluate('window.__wakeCodeState()');
  ok(st.rowPx <= 18.01, `b 30 wheel steps past the top stay at rowPx ${st.rowPx.toFixed(3)}`);

  // The ramp: the squeeze is released between rowPx 6 and 9, the one window
  // where the sheets' world geometry follows the camera. Nothing may leave a
  // sheet on the way through, and the tier has to flip exactly once.
  let sweepOut = 0;
  const tiers = [];
  for (let px = 4; px <= 10.001; px += 0.5) {
    await goto(a.page, px);
    const sw = await snap(a.page);
    sweepOut += sw.audit.outside;
    tiers.push(`${px}:${sw.st.tier}`);
  }
  ok(sweepOut === 0, `c rowPx 4 to 10 in 0.5 steps: ${sweepOut} quads outside their sheet`);
  console.log(`   tiers through the ramp ${tiers.join(' ')}`);

  // c over 20 sampled files. This export's districts cover about 5% of their
  // region, so twenty tiles never share one screen: the audit is accumulated
  // over a grid of camera positions at the bottom of the schematic band.
  const seen = new Map();
  let outside20 = 0;
  let quads20 = 0;
  let band20 = '';
  for (const dy of [0, 900, -900]) {
    for (const dx of [0, 1200, -1200]) {
      if (seen.size >= 24) break;
      await wide20.evaluate((o) => window.__wakeGoto({ rowPx: 3.2, dxPx: o.dx, dyPx: o.dy, ms: 0 }), { dx, dy });
      await sleep(2200);
      const s20 = await snap(wide20);
      band20 = `${s20.st.band}/${s20.st.tier}`;
      outside20 += s20.audit.outside;
      for (const f of s20.audit.perFile) {
        if (seen.has(f.file)) continue;
        seen.set(f.file, f);
        quads20 += f.quads;
      }
    }
  }
  ok(seen.size >= 20, `c ${seen.size} distinct files sampled in the schematic band (${band20})`);
  ok(outside20 === 0, `c ${quads20} quads over ${seen.size} files, ${outside20} outside their sheet`);
  const counts = [...seen.values()].map((f) => f.lineCount);
  console.log(`   sampled sheet rows ${Math.min(...counts)}..${Math.max(...counts)} ` +
    '(the rows each tile holds: 40 lines per height step, 400 at the fold cap)');

  // The other pages go first: a browser throttles requestAnimationFrame in a
  // page that is not the active tab, so the fps below would be meaningless.
  errors.push(...w.errors, ...w20.errors);
  await wide.close();
  await wide20.close();

  // ---- the four bands, for review ---------------------------------------
  for (const [px, shot] of [[0.3, '21-band-terrain.png'], [1.5, '22-band-schematic-low.png'], [5, '23-band-schematic.png'], [9, '24-band-reading.png']]) {
    await goto(a.page, px);
    await sleep(1400);
    // fps at rest in this band, measured after the flight has settled
    const f0 = await a.page.evaluate('window.__wakeCodeState().frames');
    await sleep(2000);
    const bs = await a.page.evaluate('window.__wakeCodeState()');
    const fps = ((bs.frames - f0) * 1000) / 2000;
    await a.page.screenshot({ path: path.join(OUT, shot) });
    console.log(`shot ${shot}  band ${bs.band}  tier ${bs.tier}  rowPx ${bs.rowPx.toFixed(2)}  ` +
      `zoom ${bs.zoom.toFixed(2)}  sheets ${bs.sheets}  ${fps.toFixed(0)} fps`);
  }
  // The light theme has to hold the same rules.
  await goto(a.page, 9);
  // The controls panel starts collapsed since design phase 6, so open it first.
  await a.page.evaluate(() => window.__wakeExpandPanels());
  await a.page.click('#t-theme');
  await sleep(2500);
  await a.page.screenshot({ path: path.join(OUT, '26-band-reading-light.png') });
  const lt = await a.page.evaluate('window.__wakeCodeState()');
  ok(lt.tier === 'source' && Math.abs(lt.rowPx - 9) < 0.01,
    `light theme keeps the ladder (${lt.tier}, rowPx ${lt.rowPx.toFixed(2)})`);
  errors.push(...a.errors);
  await a.page.close();

  // ---- e: the source pool under load ------------------------------------
  // The reading threshold is lowered on purpose, which is the only way to get
  // the pool of eight overlays onto one screen with this layout.
  // No `file=`, so no deep link re-aims the camera under the test.
  const poolCtx = await browser.newContext({ viewport: { width: 3600, height: 2400 }, deviceScaleFactor: 1 });
  const e = await openMap(poolCtx, `${base}&l3row=3`);
  errors.push(...e.errors);
  await goto(e.page, 3.5);
  await e.page.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await sleep(3000);
  const f0 = await e.page.evaluate('window.__wakeCodeState().frames');
  await sleep(2000);
  const es = await e.page.evaluate('window.__wakeCodeState()');
  console.log(`pool  ${(((es.frames - f0) * 1000) / 2000).toFixed(0)} fps with ${es.overlays} source overlays, ` +
    `${es.schematics} schematics, ${es.quads} quads, rowPx ${es.rowPx.toFixed(2)}`);
  ok(es.overlays >= 4, `e ${es.overlays} source overlays at once`);
  errors.push(...e.errors);
  await e.page.close();

  // ---- d: the deep link --------------------------------------------------
  const d = await openMap(context, `${base}&file=${encodeURIComponent(FILE)}`);
  errors.push(...d.errors);
  await d.page.waitForFunction('window.__wakeCodeState().tier === "source"', null, { timeout: 60_000 });
  await sleep(2200);
  const land = await d.page.evaluate(() => {
    const st = window.__wakeCodeState();
    const p = st.sheet;
    return { st, p, cx: window.innerWidth / 2, cy: window.innerHeight / 2 };
  });
  ok(Math.abs(land.st.rowPx - 9) < 0.5, `d deep link lands at rowPx ${land.st.rowPx.toFixed(2)}`);
  ok(land.p !== null, 'd the target file has a sheet');
  if (land.p) {
    const p = land.p;
    ok(p.sheet.x <= land.cx && p.sheet.x + p.sheet.w >= land.cx,
      `d the sheet spans the centre horizontally (${p.sheet.x.toFixed(0)}..${(p.sheet.x + p.sheet.w).toFixed(0)} vs ${land.cx})`);
    ok(p.sheet.y <= land.cy && p.sheet.y + p.sheet.h >= land.cy,
      `d the sheet spans the centre vertically (${p.sheet.y.toFixed(0)}..${(p.sheet.y + p.sheet.h).toFixed(0)} vs ${land.cy})`);
    const line = Math.round((land.cy - p.text.y) / p.rowPx);
    const changed = land.st.firstChanged;
    ok(changed < 0 || Math.abs(line - changed) <= 1,
      `d the centred row is the first changed line (row ${line} vs ${changed})`);
  }
  await d.page.screenshot({ path: path.join(OUT, '25-deep-link.png') });
  errors.push(...d.errors);
  await d.page.close();

  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
