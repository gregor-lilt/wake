/**
 * Phase 6 verification: the review of the labels phase (docs/design.md
 * decision log, 2026-09-03, and sections 2, 4, 6 and 10).
 *
 * Opt-in, because only a real export carries districts, root files, import
 * edges and source:
 *
 *   WAKE_EXPORT=<export name> npm run phase6
 *
 * Every target is derived from the export at run time, so no path and no name
 * from the exported repository is written down here. Checks:
 *
 *   a  at the world fit every file tile carries its schematic as texture
 *      (aggregated), and the root files district is drawn with its label
 *   b  panning across three files in the reading band unmounts no overlay that
 *      is still inside the viewport margin, and flips no tier
 *   c  with nothing hovered or focused, zero road paths are drawn; hovering one
 *      file draws exactly its own incident roads, in the three class widths;
 *      "show all roads" turns the whole network on
 *   d  agent trips draw with the road network hidden
 *   e  the default chrome is the agent card, `?debug=1` brings the old panel
 *      back, and the collapsed debug strip is gone
 *   f  120 fps at the terrain, schematic and reading bands
 *   g  activity at the granularity of the band (section 9): the tile fill
 *      glow fades out continuously between rowPx 6 and 9 and is zero in the
 *      reading band, where the touch shows on the sheet border and its sticky
 *      strip instead and fades on the slow duration; and a trip line stops at
 *      the sheet edge, so no segment and no marker lands on source
 *
 * The quiet pass added four groups:
 *
 *   h  non-code sheets (markdown, yaml, json, toml, lock, txt) draw at half
 *      contrast on every path: the aggregated terrain texture, the per-line
 *      schematic and the source overlay
 *   i  the light theme holds every rule of the dark one with the tone steps
 *      inverted: the ramp darkens with depth, paper is lighter than its desk,
 *      labels keep their contrast, the glow stays warm, and the agent card and
 *      the jump bar share one opaque ground
 *   j  prefers-reduced-motion: camera flights are instant, the unblur is a
 *      plain 120 ms fade with no blur, trip markers still move, arrival pulses
 *      hold one radius
 *   k  after the replay ends the agent card says "Session ended · N events",
 *      follow is disabled and no glow is alive on the map
 *
 * Screenshots go to screenshots/51-*.png .. 56-*.png and 61-*.png, 62-*.png,
 * 64-*.png, all gitignored because they render real names, real paths and real
 * source.
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

const errors = [];
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const base = `data=${encodeURIComponent(NAME)}&theme=dark`;

async function goto(page, opts, settle = 1500) {
  await page.evaluate((o) => window.__wakeGoto({ ...o, ms: 0 }), opts);
  await sleep(settle);
}

/** A review shot with the chrome out of the way, unless the chrome IS the shot. */
async function shot(page, file, { chrome = false, clip } = {}) {
  if (!chrome) await page.evaluate(() => document.body.classList.add('nohud'));
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, file), ...(clip ? { clip } : {}) });
  if (!chrome) await page.evaluate(() => document.body.classList.remove('nohud'));
  await sleep(120);
}

/** fps at rest, over 2 s of the page's own frame counter. */
async function fpsHere(page) {
  const f0 = await page.evaluate('window.__wakeCodeState().frames');
  await sleep(2000);
  const st = await page.evaluate('window.__wakeCodeState()');
  return { fps: ((st.frames - f0) * 1000) / 2000, st };
}

/** Wait until every sheet in view has its text, so the texture is complete. */
async function settleSheets(page, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const pending = await page.evaluate('window.__wakeBars().pending');
    if (pending === 0) return true;
    await sleep(500);
  }
  return false;
}

const stop = await startServer();
const { browser, context } = await launch();
try {
  const a = await openMap(context, base);
  const page = a.page;
  errors.push(...a.errors);
  await sleep(1200);
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const fx = await page.evaluate('window.__wakeFixture');
  const files = await page.evaluate('window.__wakeFiles()');
  console.log(
    `\nexport schema ${doc.schemaVersion}, ${fx.files} files, ${fx.directories} districts, ` +
    `${fx.edges} import edges, viewport ${view.w}x${view.h}`
  );

  // ---- a: schematic from the terrain up, and the root district -----------
  await page.evaluate(() => window.__wakeFitAll());
  await sleep(600);
  const complete = await settleSheets(page);
  const bars = await page.evaluate(() => {
    const b = window.__wakeBars();
    const f = window.__wakeFiles();
    const stubs = new Set(f.stubs);
    const zero = b.perFile.filter((x) => x.quads === 0).map((x) => x.file);
    return {
      band: b.band, rowPx: b.rowPx, group: b.group, files: b.files, fileCount: b.fileCount,
      withQuads: b.withQuads, quads: b.quads, pending: b.pending,
      zero: zero.length,
      zeroNonStub: zero.filter((x) => !stubs.has(x)).length,
      stubs: f.stubs.length
    };
  });
  ok(complete && bars.pending === 0,
    `a every file in view has its text (${bars.pending} pending)`);
  ok(bars.band === 'terrain' && bars.files === bars.fileCount,
    `a the world fit is the terrain band at rowPx ${bars.rowPx.toFixed(3)} and every one of ` +
    `${bars.fileCount} files has a sheet (${bars.files})`);
  ok(bars.zeroNonStub === 0,
    `a every non-stub tile carries schematic quads: ${bars.withQuads} of ${bars.files} tiles, ` +
    `the other ${bars.zero} are stubs under 5 lines and are blank paper by design ` +
    `(${bars.stubs} stubs in the export)`);
  ok(bars.group > 1,
    `a the bars are aggregated at ${bars.group} lines per row, so a bar is ` +
    `${(bars.group * bars.rowPx).toFixed(2)} px tall`);
  ok(bars.quads < 78_000,
    `a ${bars.quads.toLocaleString()} schematic quads at the world fit, inside the 78k budget`);
  const rootD = await page.evaluate(() => {
    const r = window.__wakeRootDistrict();
    if (r) delete r.fileList;
    return r;
  });
  ok(rootD !== null && rootD.files > 0,
    `a the export has ${rootD ? rootD.files : 0} files directly in the repository root`);
  if (rootD) {
    ok(rootD.box.w > 0 && rootD.box.h > 0 &&
       rootD.box.x + rootD.box.w > 0 && rootD.box.x < view.w &&
       rootD.box.y + rootD.box.h > 0 && rootD.box.y < view.h,
      `a the root district is on screen at the world fit ` +
      `(${rootD.box.w.toFixed(0)}x${rootD.box.h.toFixed(0)} px)`);
    ok(rootD.label !== null && rootD.nameMatches,
      `a its sticky label is up and carries the repository name ` +
      `(${rootD.label ? `"${rootD.label.text}" at ${rootD.label.size} px` : 'missing'})`);
    // Depth-1 ramp tone, and lighter than the terrain it sits on (dark theme).
    const geo = await page.evaluate('window.__wakeGeo()');
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    ok(lum(rootD.fill) > lum(geo.land.fill),
      `a its fill is the depth-1 ramp tone, one step off the terrain ` +
      `(${lum(rootD.fill).toFixed(1)} vs land ${lum(geo.land.fill).toFixed(1)})`);
    // Its tiles carry the same texture as everything else.
    const rootTiles = await page.evaluate(() => {
      const r = window.__wakeRootDistrict();
      const b = window.__wakeBars();
      const q = new Map(b.perFile.map((x) => [x.file, x.quads]));
      const f = window.__wakeFiles();
      const stubs = new Set(f.stubs);
      const list = r.fileList.filter((x) => !stubs.has(x));
      return { n: list.length, withQuads: list.filter((x) => (q.get(x) ?? 0) > 0).length };
    });
    ok(rootTiles.n > 0 && rootTiles.withQuads === rootTiles.n,
      `a the root district's own tiles show schematic texture ` +
      `(${rootTiles.withQuads} of ${rootTiles.n} non-stub tiles)`);
  }
  await shot(page, '51-fit-all-root-district.png');

  // The terrain band up close, where the aggregated texture is the point.
  const long = files.folded[0] ?? 0;
  await goto(page, { rowPx: 0.6, file: long }, 2200);
  await settleSheets(page, 20);
  const terrain = await page.evaluate(() => {
    const b = window.__wakeBars();
    delete b.perFile;
    return b;
  });
  ok(terrain.band === 'terrain' && terrain.group === Math.ceil(1 / terrain.rowPx),
    `a group = ceil(1 / rowPx): ${terrain.group} at rowPx ${terrain.rowPx.toFixed(3)}`);
  await shot(page, '52-terrain-schematic-texture.png');

  // The aggregation level steps with the zoom, and never below one pixel.
  const ladder = [];
  for (const px of [0.15, 0.2, 0.26, 0.34, 0.5, 0.9, 1.4, 3, 6]) {
    await goto(page, { rowPx: px, file: long }, 500);
    const b = await page.evaluate('window.__wakeBars()');
    ladder.push({ rowPx: b.rowPx, group: b.group, barPx: b.group * b.rowPx });
  }
  ok(ladder.every((l) => l.barPx >= 0.999),
    `a every aggregation level keeps a bar at least one pixel tall ` +
    `(${ladder.map((l) => l.barPx.toFixed(2)).join(', ')})`);
  ok(ladder.every((l) => l.group === (l.rowPx >= 1 ? 1 : Math.ceil(1 / l.rowPx))),
    `a the level is monotone in the zoom and 1 in the schematic band ` +
    `(groups ${ladder.map((l) => l.group).join('/')})`);

  // ---- f: 120 fps at the three bands -------------------------------------
  for (const [px, want] of [[0.3, 'terrain'], [5, 'schematic'], [10, 'reading']]) {
    await goto(page, { rowPx: px, file: long }, 1800);
    await settleSheets(page, 12);
    const { fps, st } = await fpsHere(page);
    const b = await page.evaluate('window.__wakeBars()');
    ok(fps >= 100 && st.band === want,
      `f ${st.band}: ${fps.toFixed(0)} fps, ${b.files} sheets, ${b.quads.toLocaleString()} quads, ` +
      `group ${b.group}`);
  }

  // ---- b: only zoom changes a tier ---------------------------------------
  // Three files side by side in one district, at a row height where all three
  // sheets fit on screen at once, panned across in small steps. The district
  // has to be wide enough to pack three columns, so the candidate is looked up
  // rather than assumed: the biggest districts first.
  const wide = (await page.evaluate('window.__wakeGeo()')).dirs
    .filter((d) => d.files >= 6)
    .sort((x, y) => y.files - x.files)
    .slice(0, 6);
  let panFile = -1;
  let row = [];
  for (const d of wide) {
    const inDir = [];
    for (let f = 0; f < files.count; f++) if (files.fileDirs[f] === d.id) inDir.push(f);
    for (const f of [inDir[Math.floor(inDir.length / 2)], inDir[0]]) {
      if (f === undefined) continue;
      await goto(page, { rowPx: 10, file: f, line: 0 }, 1400);
      const found = await page.evaluate(() => {
        const st = window.__wakeCodeState();
        const mid = window.innerHeight / 2;
        // Sheets that cross the vertical middle of the viewport, left to right.
        return (st.probes || [])
          .filter((p) => p && p.sheet.y < mid && p.sheet.y + p.sheet.h > mid)
          .map((p) => ({ file: p.file, x: p.sheet.x, w: p.sheet.w }))
          .sort((a2, b2) => a2.x - b2.x);
      });
      if (found.length >= 3) { panFile = f; row = found; break; }
      if (found.length > row.length) { panFile = f; row = found; }
    }
    if (row.length >= 3) break;
  }
  ok(row.length >= 3,
    `b ${row.length} sheets across the middle of the viewport at rowPx 10, three to pan over`);
  // Start centred on the leftmost of the three and pan right until the centre
  // is on the third, so all three tiles pass under the viewport centre and all
  // three stay inside the keep-margin for the whole move.
  const first = row[0].file;
  const span = row.length >= 3 ? row[2].x - row[0].x : 0;
  await goto(page, { rowPx: 10, file: first, line: 0 }, 2000);
  const STEPS = 12;
  let churn = null;
  /** Once one of the three has an overlay it must keep it for the whole pan. */
  const seen = new Map();
  let dropped = null;
  const three = row.slice(0, 3).map((r) => r.file);
  const crossed = new Set();
  const before = await page.evaluate('window.__wakeOverlays()');
  let prev = before;
  for (const f of before.slots.map((x) => x.file)) if (three.includes(f)) seen.set(f, 0);
  for (let k = 1; k <= STEPS; k++) {
    await goto(page, { rowPx: 10, file: first, line: 0, dxPx: (span * k) / STEPS }, 320);
    const now = await page.evaluate('window.__wakeOverlays()');
    const up = new Set(now.slots.map((s) => s.file));
    // The invariant: an overlay that was up and whose tile is STILL inside the
    // viewport margin has to still be up. Only the zoom may release one, and
    // the margin is evaluated on this frame, not the last one, because a tile
    // that genuinely left is allowed to go.
    const wasUp = prev.slots.map((s) => s.file).filter((f) => !up.has(f));
    if (wasUp.length > 0) {
      const boxes = await page.evaluate((fs) => window.__wakeTileBoxes(fs), wasUp);
      for (const bx of boxes) if (bx.inMargin) churn = churn ?? { file: bx.file, step: k };
    }
    const c = await page.evaluate(() => {
      const st = window.__wakeCodeState();
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const hit = (st.probes || []).find(
        (p) => p && p.sheet.x <= cx && p.sheet.x + p.sheet.w >= cx &&
          p.sheet.y <= cy && p.sheet.y + p.sheet.h >= cy
      );
      return hit ? hit.file : -1;
    });
    if (c >= 0) crossed.add(c);
    for (const f of three) {
      if (up.has(f)) { if (!seen.has(f)) seen.set(f, k); }
      else if (seen.has(f)) dropped = dropped ?? { file: f, step: k, since: seen.get(f) };
    }
    prev = now;
  }
  const after = await page.evaluate('window.__wakeOverlays()');
  ok(crossed.size >= 3,
    `b the pan crossed ${crossed.size} files under the viewport centre`);
  ok(churn === null,
    `b no overlay whose sheet is still inside the viewport margin was unmounted` +
    (churn ? ` (file ${churn.file} at step ${churn.step})` : ''));
  ok(seen.size === 3 && dropped === null,
    `b all three files kept their source overlay for the whole pan ` +
    `(${seen.size} of 3 mounted` +
    (dropped ? `, file ${dropped.file} lost its slot at step ${dropped.step}` : '') +
    `, ${after.unmounts - before.unmounts} slots released in total, all of tiles that left the margin)`);
  ok(after.tierChanges === before.tierChanges && after.tier === 'source',
    `b the tier stayed ${after.tier} across the whole pan ` +
    `(${after.tierChanges - before.tierChanges} flips)`);
  await shot(page, '55-reading-band-mid-pan.png');

  // ---- c: roads on focus only --------------------------------------------
  // The subject is the file with the most import edges, so "only its incident
  // roads" is a real count and not a trivially satisfied zero.
  const hub = (() => {
    const fileNodes = doc.nodes.filter((n) => n.kind === 'file');
    const idx = new Map(fileNodes.map((n, i) => [n.id, i]));
    const deg = new Int32Array(fileNodes.length);
    for (const e of doc.edges) {
      const s2 = idx.get(e.from);
      const d2 = idx.get(e.to);
      if (s2 === undefined || d2 === undefined || s2 === d2) continue;
      deg[s2]++;
      deg[d2]++;
    }
    let best = 0;
    for (let f = 1; f < deg.length; f++) if (deg[f] > deg[best]) best = f;
    return { file: best, degree: deg[best] };
  })();
  console.log(`\n  road subject: the file with ${hub.degree} incident import edges`);
  const target = hub.file;
  await goto(page, { rowPx: 4, file: target }, 1600);
  await page.evaluate(() => { window.__wakeFocus(-1); window.__wakeHover(-1); });
  await sleep(400);
  let r = await page.evaluate('window.__wakeRoads()');
  const drawnPaths = (x) => x.layers.filter((l) => l.id.startsWith('roads') && l.visible)
    .reduce((s2, l) => s2 + l.paths, 0);
  ok(r.drawn === 0 && drawnPaths(r) === 0,
    `c nothing hovered or focused: ${drawnPaths(r)} road paths drawn, ` +
    `network ${r.networkVisible ? 'visible' : 'hidden'}`);

  // Hover with the real pointer, over the tile the camera is on.
  const at = await page.evaluate((f) => {
    const st = window.__wakeCodeState();
    const p = (st.probes || []).find((x) => x && x.file === f);
    if (!p) return null;
    // A folded sheet is taller than the screen, so hover the centre of the
    // sheet's INTERSECTION with the viewport, not the centre of the sheet.
    const x0 = Math.max(p.sheet.x, 2);
    const x1 = Math.min(p.sheet.x + p.sheet.w, window.innerWidth - 2);
    const y0 = Math.max(p.sheet.y, 2);
    const y1 = Math.min(p.sheet.y + p.sheet.h, window.innerHeight - 2);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }, target);
  ok(at !== null, `c the target file's tile is on screen to hover`);
  if (at) {
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await sleep(500);
  }
  r = await page.evaluate('window.__wakeRoads()');
  ok(r.hover === target,
    `c deck's picking reports the hovered file (${r.hover}, wanted ${target})`);
  ok(r.drawn === r.incident.total && drawnPaths(r) === r.incident.total,
    `c only its own roads are drawn: ${r.drawn} paths for ${r.incident.total} incident edges ` +
    `(local ${r.byClass.local}, arterial ${r.byClass.arterial}, motorway ${r.byClass.motorway})`);
  ok(r.byClass.local === r.incident.local && r.byClass.arterial === r.incident.arterial &&
     r.byClass.motorway === r.incident.motorway,
    `c the classes match the edges: incident local ${r.incident.local}, ` +
    `arterial ${r.incident.arterial}, motorway ${r.incident.motorway}`);
  ok(r.widths.local === 1 && r.widths.arterial === 1.5 && r.widths.motorway === 3,
    `c the class widths are 1 / 1.5 / 3 px`);
  ok(!r.networkVisible, `c the whole network is still off while hovering`);
  await shot(page, '53-hover-roads.png');

  // Focus keeps them up once the pointer leaves.
  await page.evaluate((f) => { window.__wakeHover(-1); window.__wakeFocus(f); }, target);
  await sleep(400);
  r = await page.evaluate('window.__wakeRoads()');
  ok(r.hover === -1 && r.focus === target && r.drawn === r.incident.total,
    `c focus alone keeps the same ${r.drawn} roads up with nothing hovered`);

  // The toggle turns the whole network on.
  await page.evaluate(() => { window.__wakeFocus(-1); window.__wakeToggle('edges', true); });
  await sleep(700);
  r = await page.evaluate('window.__wakeRoads()');
  ok(r.showAll && r.networkVisible && drawnPaths(r) > 100,
    `c "show all roads" turns the network on: ${drawnPaths(r)} paths over ${fx.edges} edges`);
  // ... and never at the terrain band, where it is a grey wash over every tile.
  await goto(page, { rowPx: 0.3, file: target }, 1200);
  r = await page.evaluate('window.__wakeRoads()');
  ok(r.showAll && !r.networkVisible && drawnPaths(r) === 0,
    `c with the toggle on the network is still off at the terrain band ` +
    `(${drawnPaths(r)} paths)`);
  await page.evaluate(() => window.__wakeToggle('edges', false));
  errors.push(...a.errors);
  await page.close();

  // ---- d: trips with the roads hidden, and e: the chrome ------------------
  const b = await openMap(context, `${base}&autopilot=1&seek=40000`);
  errors.push(...b.errors);
  await b.page.waitForFunction('window.__wakeAutoState().trips > 0', null, { timeout: 60_000 });
  await sleep(600);
  const trips = await b.page.evaluate('window.__wakeRoads()');
  const tripPaths = trips.layers.filter((l) => l.id.startsWith('trip-') && l.visible)
    .reduce((s2, l) => s2 + l.paths, 0);
  ok(!trips.showAll && !trips.networkVisible && tripPaths > 0,
    `d agent trips draw with the network hidden: ${tripPaths} trip paths, ` +
    `${trips.trips.roads} hot roads, ${trips.trips.markers} markers, ` +
    `road network ${trips.networkVisible ? 'visible' : 'hidden'}`);

  const chrome = await b.page.evaluate('window.__wakeChrome()');
  ok(chrome.card && chrome.action.length > 0,
    `e the agent card is the default chrome, showing "${chrome.action}"`);
  ok(/^(Editing|Reading|Writing|Running|Searching|Thinking|Working|Paused)/.test(chrome.action),
    `e the current action is in plain words, not a tool name`);
  ok(chrome.time.length > 0, `e with the real event timestamp beside it (${chrome.time})`);
  ok(chrome.trail.length >= 1 && chrome.trail.length <= 3,
    `e ${chrome.trail.length} previous events in the trail (at most three)`);
  ok(['following', 'manual', 'recentering'].includes(chrome.chip) && chrome.followButton,
    `e an autopilot chip ("${chrome.chip}") and a follow button`);
  ok(chrome.progressPct > 0 && chrome.counter.includes('/'),
    `e a session progress bar at ${chrome.progressPct}% (${chrome.counter})`);
  ok(!chrome.panel && chrome.strips === 0,
    `e no debug panel and no collapsed debug strip by default`);
  ok(chrome.controlsCollapsed === true, `e the controls panel starts collapsed`);
  await shot(b.page, '54-agent-card.png', {
    chrome: true,
    clip: { x: 0, y: view.h - 190, width: 420, height: 190 }
  });
  errors.push(...b.errors);
  await b.page.close();

  const c = await openMap(context, `${base}&autopilot=1&seek=40000&debug=1`);
  errors.push(...c.errors);
  await sleep(1500);
  const dbg = await c.page.evaluate('window.__wakeChrome()');
  ok(dbg.debug && dbg.panel && dbg.panelFps !== null,
    `e ?debug=1 brings the old panel back with the frame rate on it (${dbg.panelFps} fps)`);
  ok(dbg.card, `e the agent card stays up alongside it`);
  errors.push(...c.errors);
  await c.page.close();

  // ---- g: activity at the granularity of the band ------------------------
  // The tile fill glow ramps off between rowPx 6 and 9 and is gone in the
  // reading band; there the touch shows on the sheet border and its sticky
  // strip, and a trip line stops at the sheet edge (docs/design.md section 9).
  const g = await openMap(context, `${base}&autopilot=1&seek=40000`);
  errors.push(...g.errors);
  const gp = g.page;
  // The camera is the test's own here, so the replay's follow is switched off
  // and the touches are placed by hand on a known tile.
  await gp.evaluate(() => { window.__wakeToggle('autopilot', false); window.__wakeToggle('traffic', true); });
  await sleep(400);
  const ramp = [];
  for (const px of [3, 6, 7, 7.5, 8, 9, 12]) {
    await goto(gp, { rowPx: px, file: long }, 350);
    await gp.evaluate((f) => window.__wakeTouch(f, true), long);
    await sleep(160);
    const st = await gp.evaluate('window.__wakeGlow()');
    ramp.push({
      want: px,
      rowPx: st.rowPx,
      weight: st.tileWeight,
      quads: st.tiles.filter((t) => t.onScreen && t.alpha > 0).length,
      borders: st.sheets.filter((x) => x.alpha > 0).length
    });
  }
  const below = ramp.filter((r2) => r2.want <= 6);
  const above = ramp.filter((r2) => r2.want >= 9);
  const mid = ramp.filter((r2) => r2.want > 6 && r2.want < 9);
  ok(below.every((r2) => r2.weight === 1 && r2.quads > 0),
    `g below the ramp the tile glow still lands on the touched tile ` +
    `(rowPx ${below.map((r2) => r2.rowPx.toFixed(1)).join('/')}, ` +
    `${below.map((r2) => r2.quads).join('/')} quads at weight ` +
    `${below.map((r2) => r2.weight.toFixed(2)).join('/')})`);
  ok(mid.every((r2, i) => r2.weight < 1 && r2.weight > 0 && (i === 0 || r2.weight < mid[i - 1].weight)),
    `g it fades out continuously across the ramp, not in a snap ` +
    `(weights ${mid.map((r2) => `${r2.rowPx.toFixed(1)}px:${r2.weight.toFixed(2)}`).join(', ')})`);
  ok(above.every((r2) => r2.weight === 0 && r2.quads === 0),
    `g no tile-glow quad with alpha > 0 is on screen in the reading band ` +
    `(rowPx ${above.map((r2) => r2.rowPx.toFixed(1)).join('/')}, ` +
    `${above.map((r2) => r2.quads).join('/')} quads)`);
  ok(above.every((r2) => r2.borders > 0),
    `g the touch shows on the sheet border there instead ` +
    `(${above.map((r2) => r2.borders).join('/')} borders glowing)`);
  errors.push(...g.errors);
  await gp.close();

  // The live case the defect was reported from: the replay follows an edit
  // into the reading band.
  const hh = await openMap(context, `${base}&autopilot=1&seek=40000`);
  errors.push(...hh.errors);
  const hp = hh.page;
  await hp.waitForFunction('window.__wakeAutoState().trips > 0', null, { timeout: 60_000 });
  const caughtEdit = await hp.waitForFunction(() => {
    const st = window.__wakeGlow();
    if (st.rowPx >= 9 && st.sheets.some((x) => x.alpha > 0.35)) {
      window.__wakeCatchGlow = st;
      return true;
    }
    return false;
  }, null, { timeout: 120_000, polling: 50 }).then(() => true).catch(() => false);
  ok(caughtEdit, `g the replay followed an edit into the reading band with a fresh glow`);
  if (caughtEdit) {
    const st = await hp.evaluate('window.__wakeCatchGlow');
    const lit = st.sheets.slice().sort((x, y) => y.alpha - x.alpha)[0];
    ok(st.tileWeight === 0 && st.tiles.filter((t) => t.onScreen && t.alpha > 0).length === 0,
      `g at rowPx ${st.rowPx.toFixed(1)} the fill glow is off entirely: ` +
      `${st.tiles.length} quads handed to the layer, weight ${st.tileWeight}`);
    ok(lit.alpha > 0.35 && lit.widthPx >= 2 && lit.widthPx <= 3,
      `g the focused sheet's border glows right after the event ` +
      `(alpha ${lit.alpha.toFixed(2)}, ${lit.widthPx} px)`);
    const strip = st.stickies.find((x) => x.file === lit.file);
    ok(strip === undefined || strip.glow > 0,
      `g the sticky header strip carries the same glow ` +
      (strip ? `(${strip.glow.toFixed(2)})` : '(no strip up on this sheet)'));
    // ... and fades on the slow duration. The replay may carry the camera to
    // the next event before the fade is over, which empties the reading-band
    // glow list at once; that is not the fade, so such a run is retried on a
    // fresh event, up to three times.
    const sampleFade = (f) => hp.evaluate(async (file) => {
      const out = [];
      for (let i = 0; i < 20; i++) {
        const s2 = window.__wakeGlow();
        const hit = s2.sheets.find((x) => x.file === file);
        out.push({ a: hit ? hit.alpha : 0, rowPx: s2.rowPx });
        await new Promise((r2) => setTimeout(r2, 60));
      }
      return out;
    }, f);
    let series = await sampleFade(lit.file);
    let left = series.some((x) => x.rowPx < 9) && Math.max(...series.map((x) => x.a)) < 0.5;
    for (let attempt = 0; left && attempt < 3; attempt++) {
      const again = await hp.waitForFunction(() => {
        const st2 = window.__wakeGlow();
        if (st2.rowPx >= 9 && st2.sheets.some((x) => x.alpha > 0.8)) {
          window.__wakeCatchGlow2 = st2.sheets.slice().sort((x, y) => y.alpha - x.alpha)[0].file;
          return true;
        }
        return false;
      }, null, { timeout: 120_000, polling: 40 }).then(() => true).catch(() => false);
      if (!again) break;
      series = await sampleFade(await hp.evaluate('window.__wakeCatchGlow2'));
      left = series.some((x) => x.rowPx < 9) && Math.max(...series.map((x) => x.a)) < 0.5;
    }
    const alphas = series.map((x) => x.a);
    ok(Math.max(...alphas) > 0.5 && Math.min(...alphas) < 0.03,
      `g and it fades on the slow duration (${st.glowMs} ms): ` +
      `peak ${Math.max(...alphas).toFixed(2)} down to ${Math.min(...alphas).toFixed(2)}`);
    // The review shot, with the glow put back at its peak: a screenshot takes
    // longer than the fade does.
    await hp.evaluate((f) => window.__wakeTouch(f, true), lit.file);
    await hp.evaluate(() => document.body.classList.add('nohud'));
    await hp.screenshot({ path: path.join(OUT, '56-reading-band-edit-glow.png') });
    await hp.evaluate(() => document.body.classList.remove('nohud'));
  }

  // The trip line stops at the paper: no drawn segment and no marker lies
  // inside the text box of a sheet that is on screen.
  const caughtTrip = await hp.waitForFunction(() => {
    const st = window.__wakeGlow();
    if (st.rowPx >= 9 && st.trips.length > 0 && st.text.length > 0) {
      window.__wakeCatchTrip = st;
      return true;
    }
    return false;
  }, null, { timeout: 120_000, polling: 50 }).then(() => true).catch(() => false);
  ok(caughtTrip, `g a trip drew while the camera was in the reading band`);
  if (caughtTrip) {
    const cross = await hp.evaluate(() => {
      const st = window.__wakeCatchTrip;
      // Liang-Barsky: does a->b enter the rect at all.
      const hits = (a, b, r) => {
        let t0 = 0;
        let t1 = 1;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const e = [[-dx, a[0] - r.x], [dx, r.x + r.w - a[0]], [-dy, a[1] - r.y], [dy, r.y + r.h - a[1]]];
        for (const [pp, q] of e) {
          if (pp === 0) { if (q < 0) return false; continue; }
          const t = q / pp;
          if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
          else { if (t < t0) return false; if (t < t1) t1 = t; }
        }
        return t1 - t0 > 1e-6;
      };
      let segs = 0;
      let bad = 0;
      for (const tr of st.trips) {
        for (let i = 0; i + 1 < tr.points.length; i++) {
          segs++;
          for (const box of st.text) if (hits(tr.points[i], tr.points[i + 1], box.box)) { bad++; break; }
        }
      }
      const inBox = (m) => st.text.some(
        (b) => m.x >= b.box.x && m.x <= b.box.x + b.box.w && m.y >= b.box.y && m.y <= b.box.y + b.box.h
      );
      return {
        rowPx: st.rowPx, paths: st.trips.length, segs, bad,
        sheets: st.text.length,
        markers: st.markers.length,
        markersOnPaper: st.markers.filter(inBox).length,
        pulses: st.pulses
      };
    });
    ok(cross.bad === 0,
      `g no trip segment lies inside a visible sheet's text box at rowPx ` +
      `${cross.rowPx.toFixed(1)}: ${cross.segs} segments of ${cross.paths} clipped paths ` +
      `over ${cross.sheets} sheets`);
    ok(cross.markersOnPaper === 0,
      `g the moving marker stays off the paper (${cross.markers} markers, ` +
      `${cross.pulses} pulses)`);
  }
  errors.push(...hh.errors);
  await hp.close();

  // ======================================================== the quiet pass
  {
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const rgbOf = (s) => {
    if (!s) return null;
    if (s.startsWith('#')) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    const m = s.match(/rgba?\(([^)]+)\)/);
    return m ? m[1].split(',').slice(0, 3).map((v) => parseFloat(v)) : null;
  };
  const sameRgb = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= 1);

  // Targets: the non-code sheet with the most lines under the fold cap, and a
  // code file of similar size, so both carry a texture worth measuring.
  const nonCodeSet = new Set(files.nonCode);
  const pick = (want) => {
    let best = -1;
    for (let f = 0; f < files.count; f++) {
      if (nonCodeSet.has(f) !== want) continue;
      const n = files.lines[f];
      if (n < 30 || n > 380) continue;
      if (best < 0 || n > files.lines[best]) best = f;
    }
    return best;
  };
  const proseFile = pick(true);
  const codeFile = pick(false);
  ok(proseFile >= 0 && codeFile >= 0,
    `h the export has a non-code sheet (${files.nonCode.length} of ${files.count} files) and a code sheet to compare`);

  const qq = await openMap(context, base);
  const q = qq.page;
  await sleep(800);
  // ---- h: non-code sheets at half contrast on every path ------------------
  const HALF = Math.round(236 * 0.5);
  for (const [px, wantBand, wantAgg] of [[0.3, 'terrain', true], [1.5, 'schematic', false]]) {
    await goto(q, { rowPx: px, file: proseFile });
    await settleSheets(q);
    const bars = await q.evaluate('window.__wakeBars()');
    const prose = bars.perFile.filter((p) => p.nonCode && p.quads > 0);
    const code = bars.perFile.filter((p) => !p.nonCode && p.quads > 0);
    const proseMax = Math.max(0, ...prose.map((p) => p.maxAlpha));
    const codeMax = Math.max(0, ...code.map((p) => p.maxAlpha));
    ok(bars.band === wantBand && (bars.group > 1) === wantAgg,
      `h at rowPx ${px} the ${bars.band} band draws ${wantAgg ? 'the aggregated' : 'the per-line'} texture (group ${bars.group})`);
    ok(prose.length > 0 && proseMax <= HALF && prose.every((p) => p.maxAlpha <= HALF),
      `h ${prose.length} non-code sheets peak at alpha ${proseMax} (half of 236 is ${HALF})`);
    ok(code.length > 0 && codeMax >= 230,
      `h ${code.length} code sheets keep full contrast (peak alpha ${codeMax})`);
  }
  // The source overlay: its opacity carries the ink.
  const overlayInk = async (f) => {
    await goto(q, { rowPx: 9, file: f }, 1200);
    for (let i = 0; i < 40; i++) {
      const ov = await q.evaluate('window.__wakeOverlays()');
      const slot = ov.slots.find((s) => s.file === f);
      if (slot && slot.style && slot.style.state === 'in' && slot.style.opacity > 0) {
        await sleep(400);
        const again = await q.evaluate('window.__wakeOverlays()');
        return again.slots.find((s) => s.file === f);
      }
      await sleep(250);
    }
    return null;
  };
  const proseOv = await overlayInk(proseFile);
  const codeOv = await overlayInk(codeFile);
  ok(proseOv && proseOv.nonCode && Math.abs(proseOv.style.opacity - 0.5) < 0.03,
    `h in the reading band the non-code overlay sits at opacity ${proseOv?.style.opacity}`);
  ok(codeOv && !codeOv.nonCode && codeOv.style.opacity > 0.97,
    `h and the code overlay at ${codeOv?.style.opacity}`);

  // ---- i: light theme parity -------------------------------------------
  const ll = await openMap(context, base.replace('theme=dark', 'theme=light'));
  const l = ll.page;
  await sleep(800);
  const midFile = codeFile;
  for (const [px, wantBand] of [[0.3, 'terrain'], [1.5, 'schematic'], [9, 'reading']]) {
    await goto(l, { rowPx: px, file: midFile });
    const st = await l.evaluate('window.__wakeBars()');
    ok(st.band === wantBand, `i the light theme reaches the ${wantBand} band at rowPx ${px} (${st.band})`);
  }
  await goto(l, { rowPx: 1.5, file: midFile });
  await goto(q, { rowPx: 1.5, file: midFile });
  await settleSheets(l);
  await settleSheets(q);
  const [gl, gd, tl, td] = await Promise.all([
    l.evaluate('window.__wakeGeo()'), q.evaluate('window.__wakeGeo()'),
    l.evaluate('window.__wakeTheme()'), q.evaluate('window.__wakeTheme()')
  ]);
  ok(gl.theme === 'light' && gd.theme === 'dark', `i two pages, one per theme (${gl.theme}, ${gd.theme})`);
  const chainOf = (geo) => {
    const byId = new Map(geo.dirs.map((d) => [d.id, d]));
    for (const d of geo.dirs) {
      if (d.level !== 3) continue;
      const p = byId.get(d.parent);
      const g = p ? byId.get(p.parent) : null;
      if (p && g && p.level === 2 && g.level === 1) return [g, p, d];
    }
    return null;
  };
  const cl = chainOf(gl);
  const cd = chainOf(gd);
  if (cl && cd) {
    const ls = cl.map((d) => lum(d.fill));
    const ds = cd.map((d) => lum(d.fill));
    ok(ls[0] > ls[1] && ls[1] > ls[2] && ds[0] < ds[1] && ds[1] < ds[2],
      `i the ramp inverts: light ${ls.map((v) => v.toFixed(0)).join(' > ')}, dark ${ds.map((v) => v.toFixed(0)).join(' < ')}`);
    ok(lum(gl.land.fill) > ls[0] && lum(gd.land.fill) < ds[0],
      `i the terrain is the far end of the ramp in both (light ${lum(gl.land.fill).toFixed(0)}, dark ${lum(gd.land.fill).toFixed(0)})`);
    ok(cl.every((d) => lum(d.line) < lum(d.fill)) && cd.every((d) => lum(d.line) > lum(d.fill)),
      `i borders are darker than their fill in light, lighter in dark`);
  } else {
    ok(false, 'i a three-level nesting chain exists in both themes');
  }
  ok(lum(tl.sheet) > lum(tl.districtLevel1) && lum(td.sheet) < lum(td.districtLevel1),
    `i paper sits one step off the desk, in opposite directions (light ${lum(tl.sheet).toFixed(0)} vs ${lum(tl.districtLevel1).toFixed(0)}, ` +
    `dark ${lum(td.sheet).toFixed(0)} vs ${lum(td.districtLevel1).toFixed(0)})`);
  const contrast = (t) => Math.abs(lum(t.label) - lum(t.background));
  ok(contrast(tl) > 150 && contrast(td) > 150,
    `i label contrast against the ground: light ${contrast(tl).toFixed(0)}, dark ${contrast(td).toFixed(0)}`);
  const warm = (c) => c[0] > c[1] && c[1] > c[2];
  ok(warm(tl.glow) && warm(td.glow) && !sameRgb(tl.glow, td.glow),
    `i the glow is warm in both and retuned for light (${tl.glow.join(',')} vs ${td.glow.join(',')})`);
  const rl = rgbOf(tl.regionLabelColor);
  const rd = rgbOf(td.regionLabelColor);
  ok(rl && rd && lum(rl) < lum(tl.background) && lum(rd) > lum(td.background),
    `i region labels are dark on light and light on dark (${tl.regionLabelColor}, ${td.regionLabelColor})`);
  for (const [t, name] of [[tl, 'light'], [td, 'dark']]) {
    const card = rgbOf(t.cardBg);
    const jump = rgbOf(t.jumpBg);
    ok(sameRgb(card, jump) && sameRgb(card, rgbOf(t.jump)),
      `i ${name}: the agent card and the jump bar share the theme's opaque ground (${t.cardBg}, ${t.jumpBg})`);
  }
  await shot(l, '61-light-schematic.png', { chrome: true });
  await shot(q, '62-dark-schematic.png', { chrome: true });
  errors.push(...ll.errors);
  await l.close();

  // ---- j: prefers-reduced-motion ------------------------------------------
  const rr = await openMap(context, `${base}&autopilot=1&seek=40000`);
  const rp = rr.page;
  await sleep(600);
  const before = await rp.evaluate('window.__wakeMotion()');
  await rp.emulateMedia({ reducedMotion: 'reduce' });
  await sleep(300);
  const mo = await rp.evaluate('window.__wakeMotion()');
  ok(!before.reduced && mo.reduced, `j the page reads the media query live (${before.reduced} -> ${mo.reduced})`);
  ok(mo.flightMs === 0 && before.flightMs === 900, `j a 900 ms flight becomes ${mo.flightMs} ms`);
  ok(mo.dampSeconds <= 0.09 && mo.dampSeconds < before.dampSeconds,
    `j the follow spring tightens from ${before.dampSeconds} s to ${mo.dampSeconds} s, never a hard cut`);
  ok(mo.unblurMs === 120 && before.unblurMs === 300, `j the unblur becomes a ${mo.unblurMs} ms fade`);
  // Trip markers still move, pulses hold one radius.
  const gotMarker = await rp.waitForFunction(() => window.__wakeMotion().markers.length > 0, null, { timeout: 120_000, polling: 40 })
    .then(() => true).catch(() => false);
  ok(gotMarker, `j a trip marker is in flight`);
  if (gotMarker) {
    const m0 = await rp.evaluate('window.__wakeMotion().markers');
    await sleep(120);
    const m1 = await rp.evaluate('window.__wakeMotion().markers');
    const moved = m0.length > 0 && m1.length > 0 && Math.hypot(m1[0].x - m0[0].x, m1[0].y - m0[0].y) > 1e-6;
    ok(moved, `j the trip marker still moves under reduced motion (${m0.length} -> ${m1.length} markers)`);
  }
  const gotPulse = await rp.waitForFunction(() => window.__wakeMotion().pulses.length > 0, null, { timeout: 120_000, polling: 40 })
    .then(() => true).catch(() => false);
  ok(gotPulse, `j an arrival pulse is up`);
  if (gotPulse) {
    const radii = [];
    for (let i = 0; i < 4; i++) {
      const ps = await rp.evaluate('window.__wakeMotion().pulses');
      radii.push(...ps.map((p) => p.r));
      await sleep(90);
    }
    ok(radii.length > 0 && radii.every((v) => Math.abs(v - radii[0]) < 1e-6),
      `j the pulse holds one radius (${radii.length} samples at r ${radii[0]?.toFixed(0)})`);
  }

  // ---- k: idle after the replay ends -----------------------------------------
  await rp.evaluate(() => window.__wakeEndSession());
  await sleep(500);
  const idle = await rp.evaluate('window.__wakeChrome()');
  const glow = await rp.evaluate('window.__wakeGlow()');
  const total = (idle.counter.split('/').pop() ?? '').trim();
  ok(/^Session ended · \d+ events?$/.test(idle.action) && idle.time === '' && idle.action.includes(` ${total} `),
    `k the card says "${idle.action}" (counter ${idle.counter})`);
  ok(idle.followDisabled === true, `k the follow button is disabled`);
  const alive = glow.tiles.filter((t) => t.alpha > 0).length + glow.sheets.length + glow.trips.length +
    glow.markers.length + glow.pulses + glow.stickies.filter((s) => s.glow > 0).length;
  ok(alive === 0, `k no glow is alive: ${glow.tiles.length} tile quads at alpha 0, ${glow.sheets.length} sheet rings, ` +
    `${glow.trips.length} trips, ${glow.markers.length} markers, ${glow.pulses} pulses`);
  const cardBox = await rp.evaluate(() => {
    const b = document.getElementById('agent').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await shot(rp, '64-idle-agent-card.png', {
    chrome: true,
    clip: { x: Math.max(0, cardBox.x - 12), y: Math.max(0, cardBox.y - 12), width: cardBox.w + 24, height: cardBox.h + 24 }
  });

  // Flights, with the autopilot out of the way so nothing else steers.
  await rp.evaluate(() => window.__wakeToggle('autopilot', false));
  await sleep(300);
  const flight = async (page, f) => page.evaluate((file) => new Promise((res) => {
    const t0 = performance.now();
    const target = window.__wakeGoto({ rowPx: 9, file, line: 0, ms: 900 });
    const samples = [];
    const tick = () => {
      const now = performance.now() - t0;
      const ov = window.__wakeOverlays().slots.find((s) => s.file === file);
      // The camera deck.gl actually draws with, not the target the page
      // already holds: a flight in progress sits between the two.
      const vp = window.__deck.getViewports()[0];
      samples.push({
        t: now,
        dz: Math.abs(vp.zoom - target.zoom),
        opacity: ov && ov.style ? ov.style.opacity : null,
        filter: ov && ov.style ? ov.style.filter : null
      });
      if (now < 700) requestAnimationFrame(tick);
      else res(samples);
    };
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }), f);
  // Warm the text store on both pages first, so the overlay is only waiting
  // for the camera to rest, not for the worker.
  await goto(rp, { rowPx: 9, file: codeFile, line: 0 }, 1500);
  await goto(rp, { rowPx: 1.5, file: codeFile }, 800);
  const reduced = await flight(rp, codeFile);
  await goto(q, { rowPx: 9, file: codeFile, line: 0 }, 1500);
  await goto(q, { rowPx: 1.5, file: codeFile }, 800);
  const normal = await flight(q, codeFile);
  // Instant: the very first frame after the call is already at the target and
  // no frame sits between the two poses. The same probe on the normal page is
  // reported, not asserted: on this build a programmatic 900 ms fly-to also
  // lands on its first frame (deck.gl's viewState transition does not run for
  // it), which is a finding for the spike, not part of the reduced-motion rule.
  const between = (s) => s.filter((x) => x.dz >= 0.01).length;
  const na = normal.find((x) => x.dz < 0.01);
  ok(reduced.length > 0 && reduced[0].dz < 0.01 && between(reduced) === 0,
    `j the flight is instant under reduced motion (at the target from the first frame, ` +
    `${reduced[0]?.t.toFixed(0)} ms, ${between(reduced)} in-between frames; normal page for reference: ` +
    `${between(normal)} in-between frames, arrives at ${na ? `${na.t.toFixed(0)} ms` : '>700 ms'})`);
  const blurred = reduced.filter((x) => x.filter && /blur\((0*\.?[0-9]+)px\)/.test(x.filter) &&
    parseFloat(x.filter.match(/blur\(([0-9.]+)px\)/)[1]) > 0.01);
  const fadeIn = reduced.filter((x) => x.opacity !== null);
  const partial = fadeIn.filter((x) => x.opacity > 0.02 && x.opacity < 0.9);
  const settled = fadeIn.filter((x) => x.opacity > 0.97);
  // The overlay mounts once the camera has rested (REST_MS 150) and fades in
  // over 120 ms, so it is opaque well before 400 ms; a 300 ms unblur would not.
  const firstFade = partial[0]?.t ?? null;
  ok(blurred.length === 0 && partial.length > 0 && settled.length > 0 && settled[0].t < 400 &&
    firstFade !== null && settled[0].t - firstFade < 200,
    `j the unblur is a plain fade: ${blurred.length} blurred frames, ${partial.length} mid-fade frames ` +
    `from ${firstFade?.toFixed(0)} ms, opaque at ${settled[0]?.t.toFixed(0)} ms`);
  errors.push(...rr.errors, ...qq.errors);
  await rp.close();
  await q.close();
  }

  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
  else console.log('all checks passed');
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
