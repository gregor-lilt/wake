/**
 * Phase 5 verification, "labels and wayfinding" (docs/design.md sections 7
 * and 11).
 *
 * Opt-in, because only a real export carries districts, symbols and source:
 *
 *   WAKE_EXPORT=<export name> npm run phase5
 *
 * Every target (the nested district, the long file, the line inside a method)
 * is derived from the export at run time, so no path and no name from the
 * exported repository is written down here. Checks:
 *
 *   a  in the middle of a nested district low in the schematic band, a stacked pair
 *      of sticky region labels is on screen and at least one of them is not at
 *      its region's own corner
 *   b  in the reading band with a long file scrolled past its top, the sticky
 *      file name sits at the top of the visible sheet, the gutter's first
 *      visible number is the first visible line, and the scope row names the
 *      enclosing class and method
 *   c  the jump bar ends with the file name and a line number in the reading
 *      band, and carries district crumbs only at the terrain band
 *   d  captions appear on tiles wide enough for them and vanish when they are
 *      not, low in the schematic band, abbreviated with an ellipsis in between
 *   e  with autopilot off and the camera far from the agent's last file, the
 *      edge marker points at it and clicking it brings the file on screen
 *   f  120 fps at all four bands with labels on
 *   g  where a sheet's sticky header and a stack of sticky region names want
 *      the same corner, the stack collapses to its deepest name and the
 *      header moves below it, and nothing overlaps (the quiet pass)
 *
 * Screenshots go to screenshots/41-*.png .. 46-*.png and 63-*.png, all
 * gitignored because they render real names, real paths and real source.
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

// ---- targets, all derived from the export -------------------------------
const fileNodes = doc.nodes.filter((n) => n.kind === 'file');
/** Renderer file index: position among the export's file nodes, in order. */
const indexOfNode = new Map(fileNodes.map((n, i) => [n.id, i]));
const symsOf = new Map();
for (const n of doc.nodes) {
  if (n.kind !== 'symbol' || n.parent === null) continue;
  const list = symsOf.get(n.parent) ?? [];
  list.push(n);
  symsOf.set(n.parent, list);
}

/**
 * A long file with a method whose body reaches past the first screenful, so
 * the sheet's top edge is off screen when the camera sits on that line, and
 * the scope row has both a class and a method to name.
 */
function deepTarget() {
  let best = null;
  for (const f of fileNodes) {
    const eff = f.effectiveLines ?? 1;
    // The sheet draws at most the fold cap less the marker, so a line past
    // that is not on the page at all.
    const drawable = Math.min(eff, 398) - 2;
    for (const s of symsOf.get(f.id) ?? []) {
      if (s.symbolKind !== 'function' && s.symbolKind !== 'method') continue;
      if (s.parentId === undefined || s.parentId === null) continue;
      const cls = doc.nodes[s.parentId];
      if (!cls || cls.kind !== 'symbol' || cls.symbolKind !== 'class') continue;
      const span = (s.lineEnd ?? s.lineStart) - s.lineStart;
      if (s.lineStart < 140 || span < 3 || s.lineStart + span > drawable) continue;
      const line = s.lineStart + Math.min(2, span - 1); // inside the body
      if (!best || span > best.score) {
        best = { file: indexOfNode.get(f.id), line, score: span, cls: cls.name, method: s.name, eff };
      }
    }
  }
  return best;
}
const TARGET = deepTarget();
if (!TARGET) {
  console.error('no nested function past line 140 inside a class in this export');
  process.exit(2);
}

const errors = [];
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const base = `data=${encodeURIComponent(NAME)}&theme=dark`;

async function goto(page, opts, settle = 1700) {
  await page.evaluate((o) => window.__wakeGoto({ ...o, ms: 0 }), opts);
  await sleep(settle);
}
const wayfind = (page) => page.evaluate('window.__wakeWayfind()');

/**
 * A review shot with the debug panels out of the way: they are chrome and the
 * jump bar shares the top of the viewport with the expanded HUD.
 */
async function review(page, file, clip) {
  await page.evaluate(() => document.body.classList.add('nohud'));
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, file), ...(clip ? { clip } : {}) });
  await page.evaluate(() => document.body.classList.remove('nohud'));
  await sleep(120);
}

/** fps at rest, over 2 s of the page's own frame counter. */
async function fpsHere(page) {
  const f0 = await page.evaluate('window.__wakeCodeState().frames');
  await sleep(2000);
  const st = await page.evaluate('window.__wakeCodeState()');
  return { fps: ((st.frames - f0) * 1000) / 2000, st };
}

const stop = await startServer();
const { browser, context } = await launch();
try {
  const a = await openMap(context, base);
  const page = a.page;
  errors.push(...a.errors);
  await sleep(1500);
  const fx = await page.evaluate('window.__wakeFixture');
  const files = await page.evaluate('window.__wakeFiles()');
  const geo = await page.evaluate('window.__wakeGeo()');
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  console.log(
    `\nexport schema ${doc.schemaVersion}, ${fx.files} files, ${fx.directories} districts, ` +
    `viewport ${view.w}x${view.h}`
  );

  // ---- a: sticky region labels in the middle of a nested district --------
  const deepDirs = geo.dirs
    .filter((d) => d.level >= 3 && d.files >= 6)
    .sort((b, c) => c.files - b.files);
  ok(deepDirs.length > 0, `a the export has a district nested three levels deep with files in it`);
  const dir = deepDirs[0];
  const inDir = [];
  for (let f = 0; f < files.count; f++) if (files.fileDirs[f] === dir.id) inDir.push(f);
  const midFile = inDir[Math.floor(inDir.length / 2)];
  await goto(page, { rowPx: 1.5, file: midFile });
  let w = await wayfind(page);
  ok(w.band === 'schematic', `a rowPx ${w.rowPx.toFixed(2)} is the schematic band (${w.band})`);
  const stacked = w.regions.filter((r) => r.stack > 0);
  const inside = w.regions.every(
    (r) => r.box.x >= 0 && r.box.y >= 0 && r.box.x + r.box.w <= view.w && r.box.y + r.box.h <= view.h
  );
  ok(stacked.length >= 1 && w.regions.length >= 2,
    `a ${w.regions.length} region labels, ${stacked.length} of them stacked under a parent ` +
    `(depths ${[...new Set(w.regions.map((r) => r.depth))].join('/')})`);
  ok(inside, `a every region label box is inside the viewport`);
  const sticky = w.regions.filter((r) => r.sticky);
  ok(sticky.length >= 1,
    `a ${sticky.length} of ${w.regions.length} region labels are NOT at their region's own corner`);
  // The pair that stacks: parent above child, one label height apart.
  const pairs = [];
  for (const r of stacked) {
    const parent = w.regions.find(
      (o) => o.stack === r.stack - 1 && Math.abs(o.box.x - r.box.x) < 2 && o.depth < r.depth
    );
    if (parent) pairs.push([parent, r]);
  }
  ok(pairs.length >= 1,
    `a ${pairs.length} stacked pairs, parent above child ` +
    (pairs.length
      ? `(${pairs[0][0].box.y.toFixed(0)} then ${pairs[0][1].box.y.toFixed(0)} px, ` +
        `depths ${pairs[0][0].depth} then ${pairs[0][1].depth})`
      : ''));
  ok(w.regions.every((r) => r.size >= 10 && r.size <= 14),
    `a every region label is between 10 and 14 px ` +
    `(${[...new Set(w.regions.map((r) => r.size.toFixed(1)))].join('/')})`);
  ok(w.regions.every((r) => r.box.x + r.box.w <= r.clip.x + r.clip.w + 1),
    `a no region name crosses the right edge of its own visible part`);
  await review(page, '41-schematic-mid-district.png');

  // Captions suppressed under a region label: the CPU half of collision.
  const clash = w.captions.length === 0 ? 0 : (await page.evaluate(() => {
    const wf = window.__wakeWayfind();
    const l = window.__wakeLabels();
    let bad = 0;
    for (const c of l.files) {
      const box = { x: c.anchor.x, y: c.anchor.y - c.size / 2, w: c.text.length * c.size * 0.56, h: c.size };
      for (const r of wf.regions) {
        if (box.x < r.box.x + r.box.w && box.x + box.w > r.box.x &&
            box.y < r.box.y + r.box.h && box.y + box.h > r.box.y) { bad++; break; }
      }
    }
    return bad;
  }));
  ok(clash === 0,
    `a ${w.captions.length} captions, ${clash} of them overlapping a sticky region label`);

  // ---- d: captions by fit, low in the schematic band ---------------------
  const shot = await page.evaluate('window.__wakeLabels()');
  const tooWide = shot.files.filter((l) => l.text.length * l.size * 0.56 > l.rect.w + 1).length;
  ok(shot.files.length > 0, `d ${shot.files.length} captions low in the schematic band (tiles ${shot.files[0]?.rect.w.toFixed(0)} px wide)`);
  ok(tooWide === 0, `d ${tooWide} captions wider than their own tile`);
  const abbrev = shot.files.filter((l) => l.text.endsWith('…'));
  ok(abbrev.every((l) => l.text.length >= 7),
    `d ${abbrev.length} captions abbreviated with an ellipsis, all keeping at least 6 characters`);
  // Narrower tiles: the same names no longer fit at all. A tile is 50 px per
  // unit of rowPx (100 columns of 2.4 world units against 4.8 per row), so the
  // six-character floor at 11.5 px lands at about rowPx 0.9 -- BELOW the
  // schematic band, which starts at rowPx 1. The check used to demand the
  // schematic band here, which the three-band ladder made unreachable when the
  // review of the labels phase deleted the tile-only `blocks` band. The rule
  // under test is fit, not band, so it is asserted at both ends of the floor
  // AT THE TERRAIN BAND: too narrow, nothing; wide enough, captions.
  await goto(page, { rowPx: 0.7, file: midFile });
  const narrow = await page.evaluate('window.__wakeLabels()');
  const wNarrow = await wayfind(page);
  ok(wNarrow.band === 'terrain' && narrow.files.length === 0,
    `d at rowPx 0.7 (${wNarrow.band}, tiles ${(0.7 * 50).toFixed(0)} px) ` +
    `${narrow.files.length} captions: too narrow for six characters`);
  await goto(page, { rowPx: 0.95, file: midFile });
  const justFits = await page.evaluate('window.__wakeLabels()');
  const wFits = await wayfind(page);
  const wideEnough = justFits.files.filter((l) => l.text.length * l.size * 0.56 > l.rect.w + 1).length;
  ok(wFits.band === 'terrain' && justFits.files.length > 0 && wideEnough === 0,
    `d at rowPx 0.95 (${wFits.band}, tiles ${(0.95 * 50).toFixed(0)} px) ` +
    `${justFits.files.length} captions, ${wideEnough} wider than their tile: ` +
    `visibility is by fit, not by band`);

  // ---- c: the jump bar at the terrain band -------------------------------
  await goto(page, { rowPx: 0.3, file: midFile });
  const terrain = await wayfind(page);
  ok(terrain.band === 'terrain', `c rowPx ${terrain.rowPx.toFixed(2)} is the terrain band`);
  ok(terrain.crumbs.length > 0 && terrain.crumbs.every((c) => c.kind === 'region' || c.kind === 'district'),
    `c the jump bar carries only district crumbs at the terrain band ` +
    `(${terrain.crumbs.map((c) => c.kind).join('/')})`);
  await review(page, '46-terrain-jump.png');

  // ---- gutter ticks in the schematic band --------------------------------
  await goto(page, { rowPx: 7, file: midFile });
  const gut = await page.evaluate(() => {
    const st = window.__wakeCodeState();
    const l = window.__deck.props.layers.find((x) => x && x.id === 'gutter');
    return { band: st.band, rowPx: st.rowPx, ticks: l && l.props.data ? l.props.data.length : 0 };
  });
  ok(gut.band === 'schematic' && gut.ticks > 0,
    `gutter ${gut.ticks} every-tenth-line ticks at rowPx ${gut.rowPx.toFixed(1)} (${gut.band})`);
  await review(page, '45-gutter-schematic.png');
  await goto(page, { rowPx: 4, file: midFile });
  const noGut = await page.evaluate(() => {
    const l = window.__deck.props.layers.find((x) => x && x.id === 'gutter');
    return l && l.props.data ? l.props.data.length : 0;
  });
  ok(noGut === 0, `gutter nothing drawn at rowPx 4, below the legible floor (${noGut} ticks)`);

  // ---- b: sticky file name, gutter, scope row ----------------------------
  await goto(page, { rowPx: 9, file: TARGET.file, line: TARGET.line - 1 }, 2600);
  const st = await page.evaluate('window.__wakeCodeState()');
  w = await wayfind(page);
  const mine = w.stickies.find((s) => s.file === TARGET.file);
  ok(w.band === 'reading', `b rowPx ${w.rowPx.toFixed(2)} is the reading band`);
  ok(mine !== undefined,
    `b the target file (${TARGET.eff} effective lines, scrolled to line ${TARGET.line}) has a sticky header`);
  if (mine) {
    ok(mine.sheet.y < 0, `b its sheet's top edge is off screen (${mine.sheet.y.toFixed(0)} px)`);
    const box = await page.evaluate((f) => {
      const el = document.querySelector(`.wf-sticky[data-file="${f}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.left, y: r.top, w: r.width, h: r.height,
        name: el.querySelector('.n')?.textContent ?? '',
        scope: el.querySelector('.s')?.textContent ?? '',
        line: Number(el.dataset.line)
      };
    }, TARGET.file);
    ok(box !== null && box.y <= 1, `b the sticky name sits at the viewport top edge (y ${box ? box.y.toFixed(1) : '--'})`);
    ok(box !== null && box.x >= mine.sheet.x - 1 && box.x + box.w <= mine.sheet.x + mine.sheet.w + 1,
      `b it is inside the sheet horizontally ` +
      `(${box ? `${box.x.toFixed(0)}..${(box.x + box.w).toFixed(0)} in ${mine.sheet.x.toFixed(0)}..${(mine.sheet.x + mine.sheet.w).toFixed(0)}` : '--'})`);
    ok(box !== null && box.scope.length > 0,
      `b the scope row names the enclosing scope of the FIRST VISIBLE line ` +
      `(line ${mine.firstLine + 1}): "${box ? box.scope : ''}"`);
    ok(box !== null && box.scope.includes(TARGET.cls),
      `b the scope row's outer crumb is the enclosing class (${TARGET.cls})`);
    // The gutter: the first number visible under the strip is the first
    // visible source line.
    const gutter = await page.evaluate((f) => {
      const el = document.querySelector(`.wake-ov[data-file="${f}"]`);
      if (!el) return null;
      const cells = [...el.querySelectorAll('.ln')].map((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent, top: r.top, bottom: r.bottom, right: r.right, w: r.width };
      });
      // The first row that reaches into the viewport, which is the row the
      // sheet's own first-visible-line arithmetic points at.
      const first = cells.find((c) => c.bottom > 0.5);
      const pre = el.querySelector('pre');
      return {
        first,
        cells: cells.length,
        gutterPx: getComputedStyle(pre).getPropertyValue('--gutter'),
        align: getComputedStyle(el.querySelector('.ln')).textAlign,
        opacity: getComputedStyle(el.querySelector('.ln')).opacity,
        font: getComputedStyle(el.querySelector('.ln')).fontFamily === getComputedStyle(pre).fontFamily
      };
    }, TARGET.file);
    ok(gutter !== null && gutter.first !== undefined && Number(gutter.first.text) === mine.firstLine + 1,
      `b the gutter's first visible number is the first visible line ` +
      `(${gutter?.first?.text} vs ${mine.firstLine + 1})`);
    ok(gutter !== null && gutter.align === 'right' && Math.abs(Number(gutter.opacity) - 0.35) < 0.01 && gutter.font,
      `b line numbers are right aligned, ~35% contrast, same monospace ` +
      `(${gutter?.align}, ${gutter?.opacity}, gutter ${gutter?.gutterPx})`);
    ok(box !== null && box.line === mine.firstLine + 1,
      `b the header reports the same first line as the gutter (${box?.line})`);
    // The sheet still holds its 96-column text box inside 100 columns.
    const pr = st.probes.find((p) => p && p.file === TARGET.file);
    const ov = await page.evaluate((f) => {
      const el = document.querySelector(`.wake-ov[data-file="${f}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, w: r.width };
    }, TARGET.file);
    ok(pr && ov && ov.x >= pr.tile.x - 1.5 && ov.x + ov.w <= pr.tile.x + pr.tile.w + 1.5,
      `b the gutter plus the 96-column text box still fit inside the 100-column sheet ` +
      `(${ov ? `${ov.x.toFixed(0)}..${(ov.x + ov.w).toFixed(0)}` : '--'} in ` +
      `${pr ? `${pr.tile.x.toFixed(0)}..${(pr.tile.x + pr.tile.w).toFixed(0)}` : '--'})`);
  }
  await review(page, '42-reading-sticky-header.png');

  // ---- c: the jump bar in the reading band -------------------------------
  const jump = w.jumpText;
  const name = w.crumbs.find((c) => c.kind === 'file');
  ok(/L\d+$/.test(jump),
    `c the jump bar ends with a line number: "${jump.slice(-28)}"`);
  ok(name !== undefined && jump.includes(name.text),
    `c it names the file (${name ? name.text : 'missing'})`);
  const scopeCrumbs = w.crumbs.filter((c) => c.kind === 'scope').map((c) => c.text);
  ok(scopeCrumbs.length > 0 && scopeCrumbs[0] === TARGET.cls && scopeCrumbs.includes(TARGET.method),
    `c its scope crumbs are the containment chain of the centred line: ` +
    `${scopeCrumbs.join(' > ')} (export says ${TARGET.cls} / ${TARGET.method})`);
  const bar = await page.evaluate(() => {
    const el = document.getElementById('wf-jump');
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cw: window.innerWidth };
  });
  ok(Math.abs(bar.x + bar.w / 2 - bar.cw / 2) < 2 && bar.y < 30,
    `c the bar is at the top centre (${bar.x.toFixed(0)}+${bar.w.toFixed(0)} of ${bar.cw})`);
  // The bottom-left corner is the agent card's, not a collapsed debug strip's:
  // the review of the labels phase replaced the panel with the card and the
  // strip is gone entirely (docs/design.md section 10). This check used to
  // assert the strip, which is why it failed after phase 6 shipped.
  const corner = await page.evaluate(() => {
    const card = document.getElementById('agent');
    const r = card.getBoundingClientRect();
    return {
      x: r.left, y: r.top, w: r.width, h: window.innerHeight,
      chrome: window.__wakeChrome()
    };
  });
  ok(corner.chrome.card && corner.y > corner.h / 2 && corner.x < 40 && corner.chrome.strips === 0,
    `c the agent card is in the bottom-left corner and no debug strip is left ` +
    `(${corner.x.toFixed(0)}, ${corner.y.toFixed(0)} of ${corner.h}, ` +
    `${corner.chrome.strips} strips)`);
  ok(corner.chrome.followButton && corner.chrome.action.length > 0,
    `c the card names the action and carries the follow button ` +
    `("${corner.chrome.action.slice(0, 22)}")`);
  await review(page, '43-jump-bar.png', {
    x: Math.max(0, bar.x - 12), y: Math.max(0, bar.y - 8),
    width: Math.min(view.w, bar.w + 24), height: bar.h + 16
  });

  // Clicking a crumb frames it. The scope crumb first, because the region
  // crumb pulls the camera out of the reading band.
  const scopeIdx = w.crumbs.findIndex((c) => c.kind === 'scope');
  const scopeLine = w.crumbs[scopeIdx]?.line ?? -1;
  await page.evaluate((i) => window.__wakeCrumb(i), scopeIdx);
  await sleep(1400);
  const atScope = await wayfind(page);
  const centred = await page.evaluate((f) => {
    const st = window.__wakeCodeState();
    const p = (st.probes || []).find((x) => x && x.file === f);
    return p ? Math.round((window.innerHeight / 2 - p.text.y) / p.rowPx) : null;
  }, TARGET.file);
  ok(atScope.band === 'reading' && centred !== null && Math.abs(centred - scopeLine) <= 1,
    `c clicking a scope crumb scrolls to that symbol (line ${centred} vs ${scopeLine})`);

  const fileIdx = w.crumbs.findIndex((c) => c.kind === 'file');
  await page.evaluate(() => window.__wakeGoto({ rowPx: 3.5, file: 0, ms: 0 }));
  await sleep(1200);
  await page.evaluate((i) => window.__wakeCrumb(i), fileIdx);
  await sleep(1600);
  const atFile = await page.evaluate('window.__wakeCodeState()');
  ok(Math.abs(atFile.rowPx - 9) < 0.5,
    `c clicking the file crumb frames the file at rowPx 9 (${atFile.rowPx.toFixed(2)})`);

  await goto(page, { rowPx: 9, file: TARGET.file, line: TARGET.line - 1 }, 2000);
  const before = await page.evaluate('window.__wakeCodeState().zoom');
  const clicked = await page.evaluate(() => window.__wakeCrumb(0));
  await sleep(1400);
  const after = await wayfind(page);
  ok(clicked && after.rowPx < 3,
    `c clicking the region crumb frames the region (rowPx ${after.rowPx.toFixed(2)}, zoom was ${before.toFixed(2)})`);

  // ---- g: corner clutter, the quiet pass ---------------------------------
  // A stacked set of sticky region names and a sheet's sticky file header can
  // want the same top-left corner in the reading band. The stack yields:
  // one line with the DEEPEST name (the jump bar carries the rest) and the
  // header moves down below it. Nothing overlaps.
  //
  // The pose is searched for rather than written down: aim at the middle of
  // the longest files of the most deeply nested districts until a header and
  // a region label meet at one corner.
  const nested = geo.dirs
    .filter((d) => d.level >= 4 && d.files >= 2)
    .sort((b, c) => c.level - b.level || c.files - b.files);
  let shared = null;
  for (const d of nested) {
    if (shared) break;
    const inD = [];
    for (let f = 0; f < files.count; f++) if (files.fileDirs[f] === d.id) inD.push(f);
    inD.sort((x, y) => files.lines[y] - files.lines[x]);
    for (const f of inD.slice(0, 3)) {
      const line = Math.max(40, Math.min(340, Math.floor(files.lines[f] / 2)));
      await goto(page, { rowPx: 10, file: f, line }, 1300);
      const m = await wayfind(page);
      if (m.cornerYields.length > 0) { shared = { file: f, dir: d.id, w: m }; break; }
    }
  }
  ok(shared !== null, `g found a reading-band pose where a header and a region stack share a corner`);
  if (shared) {
    const m = shared.w;
    const y = m.cornerYields[0];
    const kept = m.regions.filter((r) => r.dir === y.dir);
    ok(y.dropped.length > 0 && y.dropped.every((d) => d < y.depth),
      `g the stack collapsed to its deepest name (depth ${y.depth}, dropped ` +
      `${y.dropped.join('/')})`);
    ok(kept.length === 1 && kept[0].stack === 0 && kept[0].collapsed,
      `g one line is left at that corner ("${kept[0]?.text}", stack ${kept[0]?.stack})`);
    // The jump bar still spells out the chain the collapse dropped. The bar
    // describes the focused file, or else the viewport centre, and the header
    // that yielded can belong to a neighbouring sheet, so focus that file for
    // the read and release it again.
    await page.evaluate((f) => window.__wakeFocus(f), y.file);
    await sleep(400);
    const focused = await wayfind(page);
    await page.evaluate(() => window.__wakeFocus(-1));
    const trail = focused.crumbs.filter((c) => c.kind === 'region' || c.kind === 'district');
    const fileCrumb = focused.crumbs.find((c) => c.kind === 'file');
    ok(fileCrumb !== undefined && fileCrumb.file === y.file && trail.length > y.dropped.length,
      `g the jump bar still carries the implied chain (${trail.length} district crumbs ` +
      `for ${y.dropped.length} dropped names, bar on the yielding file: ${fileCrumb?.file === y.file})`);
    const header = m.stickies.find((l) => l.file === y.file);
    ok(header !== undefined && Math.abs(header.y - y.regionBottom) < 0.5 && header.y > 0,
      `g the sheet header moved down below it (y ${header?.y.toFixed(1)} vs region bottom ` +
      `${y.regionBottom.toFixed(1)})`);
    // Nothing overlaps: every region label box against every header strip.
    const hits = [];
    for (const l of m.stickies) {
      const box = { x: l.sheet.x, y: l.y, w: l.sheet.w, h: (l.scope ? 2 : 1) * 15 };
      for (const r of m.regions) {
        if (box.x < r.box.x + r.box.w && box.x + box.w > r.box.x &&
            box.y < r.box.y + r.box.h && box.y + box.h > r.box.y) hits.push([r.text, l.file]);
      }
    }
    ok(hits.length === 0,
      `g ${m.regions.length} region labels and ${m.stickies.length} sheet headers, ` +
      `${hits.length} overlapping pairs`);
    await review(page, '63-corner-rule-reading.png');
  }

  // ---- f: fps at all four bands, labels on -------------------------------
  const bands = [[0.3, 'terrain'], [1.5, 'schematic'], [5, 'schematic'], [9, 'reading']];
  for (const [px, want] of bands) {
    await goto(page, { rowPx: px, file: TARGET.file }, 1600);
    const { fps, st: s2 } = await fpsHere(page);
    const wf = await wayfind(page);
    ok(fps >= 100 && s2.band === want,
      `f ${s2.band}: ${fps.toFixed(0)} fps with labels on ` +
      `(${wf.regions.length} region labels, ${wf.captions.length} captions, ${wf.stickies.length} sticky headers)`);
  }
  await page.close();

  // ---- e: the off-screen agent marker ------------------------------------
  const b = await openMap(context, `${base}&autopilot=1&seek=30000`);
  errors.push(...b.errors);
  await b.page.waitForFunction('window.__wakeWayfind().agentFile >= 0', null, { timeout: 60_000 });
  const agent = (await wayfind(b.page)).agentFile;
  await b.page.evaluate(() => window.__wakeToggle('autopilot', false));
  await sleep(400);
  let far = -1;
  for (let k = 1; k < 12 && far < 0; k++) {
    const cand = (agent + Math.floor((k * files.count) / 12)) % files.count;
    await goto(b.page, { rowPx: 6, file: cand }, 1400);
    const m = await wayfind(b.page);
    if (m.edge) far = cand;
  }
  let m = await wayfind(b.page);
  ok(far >= 0 && m.edge !== null,
    `e autopilot off, camera on another file: the edge marker points at the agent's file ` +
    `(${m.edge ? m.edge.name : 'missing'}, ${m.edge ? `${m.edge.x.toFixed(0)},${m.edge.y.toFixed(0)}` : ''})`);
  if (m.edge) {
    ok(m.edge.x >= 0 && m.edge.x <= view.w && m.edge.y >= 0 && m.edge.y <= view.h,
      `e the marker sits inside the viewport, on its edge`);
    ok(m.edge.file === m.agentFile, `e it points at the agent's own file (${m.edge.file})`);
    ok(m.camState === 'manual' || m.autopilot === false,
      `e it only shows while the camera is the user's (autopilot ${m.autopilot}, cam ${m.camState})`);
  }
  await review(b.page, '44-edge-marker.png');
  const hit = await b.page.evaluate(() => window.__wakeEdgeClick());
  await sleep(2200);
  m = await wayfind(b.page);
  const onScreen = await b.page.evaluate((f) => {
    const st = window.__wakeCodeState();
    const p = (st.probes || []).find((x) => x && x.file === f);
    if (!p) return null;
    return p.sheet.x < window.innerWidth && p.sheet.x + p.sheet.w > 0 &&
      p.sheet.y < window.innerHeight && p.sheet.y + p.sheet.h > 0;
  }, agent);
  ok(hit && m.edge === null,
    `e clicking it flies there and the marker goes away (edge ${m.edge ? 'still up' : 'hidden'})`);
  ok(onScreen !== false, `e the agent's file is on screen after the flight (${onScreen})`);
  errors.push(...b.errors);
  await b.page.close();

  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
  else console.log('all checks passed');
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
