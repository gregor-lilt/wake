/**
 * Agent console checks on a real export (docs/design.md section 10):
 *
 *   a  replayed to the end, the log has one line per session event and the
 *      header says "Session ended · N events" once the map has gone quiet
 *   b  scrubbing back to event 10 leaves 10 lines
 *   c  a message line and a run line render with their own treatment (by
 *      class name, never by content)
 *   d  clicking a line with a file flies the camera to that file
 *   e  expanded / collapsed persists across a reload, and `l` toggles it
 *   f  the frame rate is unchanged with the console up
 *
 * Screenshots 71-console-collapsed.png (mid-replay) and 72-console-expanded.png,
 * gitignored: they render real names, paths and commands.
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
const TOTAL = doc.session.events.length;
const enriched = doc.session.events.filter((e) => typeof e.title === 'string').length;

const errors = [];
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const base = `data=${encodeURIComponent(NAME)}&theme=dark&autopilot=1&loop=0`;

/** Every rendered line's classes, walking the log from top to bottom. */
async function allLineClasses(page) {
  return page.evaluate(async () => {
    const log = document.getElementById('ac-log');
    const seen = new Map();
    const step = Math.max(1, log.clientHeight - 18);
    for (let y = 0; y <= log.scrollHeight; y += step) {
      log.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(r));
      for (const l of window.__wakeConsole().lines) seen.set(l.index, l.classes);
    }
    log.scrollTop = log.scrollHeight;
    await new Promise((r) => requestAnimationFrame(r));
    return [...seen.values()];
  });
}

async function consoleBox(page) {
  return page.evaluate(() => {
    const b = document.getElementById('agent').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
}

async function shotConsole(page, file) {
  const b = await consoleBox(page);
  await page.screenshot({
    path: path.join(OUT, file),
    clip: { x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12), width: b.w + 24, height: b.h + 24 }
  });
}

const stop = await startServer();
const { browser, context } = await launch();
try {
  console.log(`\nexport ${doc.schemaVersion}, ${TOTAL} session events, ${enriched} with a title` +
    (enriched === 0 ? ' (titles fall back to the summary)' : ''));

  // ---- 71: collapsed, mid-replay --------------------------------------------
  const a = await openMap(context, `${base}&seek=${20 * 1500}`);
  const page = a.page;
  await page.evaluate(() => window.__wakeConsoleToggle(false));
  await sleep(1200);
  const mid = await page.evaluate('window.__wakeChrome()');
  ok(mid.card && mid.lines >= 20 && mid.lines <= 22 && !mid.expanded,
    `71 mid-replay the console shows ${mid.lines} lines collapsed ("${mid.action}" at ${mid.time})`);
  await shotConsole(page, '71-console-collapsed.png');

  // ---- f: frame rate with the console up, mid-replay -----------------------
  // Measured against the same page with the console hidden, so a busy machine
  // shows up in both numbers and only the difference is the console's cost.
  const fpsHere = async () => {
    const f0 = await page.evaluate('window.__wakeCodeState().frames');
    await sleep(2000);
    const st = await page.evaluate('window.__wakeCodeState()');
    return { fps: ((st.frames - f0) * 1000) / 2000, band: st.band };
  };
  const withConsole = await fpsHere();
  await page.evaluate(() => { document.getElementById('agent').style.display = 'none'; });
  const without = await fpsHere();
  await page.evaluate(() => { document.getElementById('agent').style.display = ''; });
  ok(withConsole.fps >= 100 || withConsole.fps >= without.fps - 4,
    `f ${withConsole.fps.toFixed(0)} fps with the console at the ${withConsole.band} band while the replay plays ` +
    `(${without.fps.toFixed(0)} fps with it hidden)`);

  // ---- a: replay to the end -------------------------------------------------
  await page.evaluate(() => window.__wakeCadence(40));
  await page.waitForFunction((n) => window.__wakeChrome().lines === n, TOTAL, { timeout: 30_000 });
  const end = await page.evaluate('window.__wakeChrome()');
  ok(end.lines === TOTAL && end.total === TOTAL,
    `a replayed to the end, the log has ${end.lines} lines for ${TOTAL} events`);
  const c1 = await page.evaluate('window.__wakeConsole()');
  ok(c1.following && !c1.latestPill && c1.rendered <= c1.rowsVisible + 2,
    `a the log follows: ${c1.rendered} lines in the DOM for ${c1.rowsVisible} visible rows, no "latest" pill`);
  // The glows fade on their own clocks (up to 20 s); the test hook expires them.
  await page.evaluate(() => window.__wakeEndSession());
  await sleep(400);
  const idle = await page.evaluate('window.__wakeChrome()');
  ok(idle.action === `Session ended · ${TOTAL} events` && idle.time === '' && idle.followDisabled === true,
    `a the header says "${idle.action}", follow disabled`);

  // ---- c: message and run lines by class ------------------------------------
  await page.evaluate(() => window.__wakeConsoleToggle(true));
  await sleep(400);
  const classes = await allLineClasses(page);
  const has = (k) => classes.filter((c) => c.includes(k)).length;
  const msgs = has('k-message-assistant') + has('k-message-user');
  ok(msgs >= 1, `c ${msgs} message line(s) with the narration treatment (k-message-*)`);
  ok(has('k-run') >= 1, `c ${has('k-run')} run line(s) with the command treatment (k-run)`);
  ok(classes.length === TOTAL && classes.every((c) => c.includes('cx-line')),
    `c walking the log rendered every one of the ${classes.length} lines`);
  const runCmd = await page.evaluate(() => document.querySelectorAll('#agent .k-run .cmd').length);
  console.log(`      (${runCmd} run lines carry a command in the current window)`);
  const shots = await page.evaluate(() => ({
    msgGlyphBg: (() => {
      const g = document.querySelector('#agent .k-message-assistant .g, #agent .k-message-user .g');
      return g ? getComputedStyle(g).backgroundColor : null;
    })(),
    toolGlyphBg: (() => {
      const g = document.querySelector('#agent .k-run .g, #agent .k-read .g, #agent .k-edit .g');
      return g ? getComputedStyle(g).backgroundColor : null;
    })()
  }));
  ok(shots.toolGlyphBg && shots.toolGlyphBg !== 'rgba(0, 0, 0, 0)' &&
    (shots.msgGlyphBg === null || shots.msgGlyphBg === 'rgba(0, 0, 0, 0)'),
    `c tool glyphs sit on a box (${shots.toolGlyphBg}), message glyphs on none (${shots.msgGlyphBg ?? 'not in window'})`);

  // ---- 72: expanded ---------------------------------------------------------
  const exp = await page.evaluate('window.__wakeConsole()');
  ok(exp.expanded && exp.rowsVisible === 20 && Math.abs(exp.logHeight - (20 * 18 + 4)) < 8,
    `72 expanded: ${exp.rowsVisible} rows, log ${exp.logHeight.toFixed(0)} px tall`);
  await shotConsole(page, '72-console-expanded.png');

  // ---- d: click a line with a file ------------------------------------------
  await page.evaluate(() => window.__wakeToggle('autopilot', false));
  await page.evaluate(() => window.__wakeFitAll());
  await sleep(600);
  const before = await page.evaluate(() => {
    const vp = window.__deck.getViewports()[0];
    return { x: vp.center[0], y: vp.center[1], zoom: vp.zoom, focused: window.__wakeCodeState().focusedFile };
  });
  const pick = await page.evaluate(() => {
    const c = window.__wakeConsole();
    // a line with a file that is in the current window, scrolling if needed
    const log = document.getElementById('ac-log');
    log.scrollTop = 0;
    return c.withFile[0] ?? -1;
  });
  await sleep(150);
  const clicked = await page.evaluate((i) => window.__wakeConsoleClick(i), pick);
  await sleep(1200);
  const after = await page.evaluate((i) => {
    const vp = window.__deck.getViewports()[0];
    const st = window.__wakeCodeState();
    const [tile] = st.focusedFile >= 0 ? window.__wakeTileBoxes([st.focusedFile]) : [null];
    const b = tile ? tile.box : null;
    return {
      x: vp.center[0], y: vp.center[1], zoom: vp.zoom, focused: st.focusedFile,
      onScreen: b ? b.x < window.innerWidth && b.x + b.w > 0 && b.y < window.innerHeight && b.y + b.h > 0 : null,
      clickedIndex: i
    };
  }, pick);
  const moved = Math.hypot(after.x - before.x, after.y - before.y) > 1 || Math.abs(after.zoom - before.zoom) > 0.05;
  ok(clicked && after.focused >= 0 && after.focused !== before.focused && moved,
    `d clicking line ${pick} flew the camera (zoom ${before.zoom.toFixed(2)} -> ${after.zoom.toFixed(2)}) ` +
    `and focused file ${after.focused}${after.onScreen === null ? '' : `, sheet on screen: ${after.onScreen}`}`);
  errors.push(...a.errors);

  // ---- e: expanded state persists, `l` toggles ------------------------------
  await page.evaluate(() => window.__wakeConsoleToggle(true));
  await page.close();
  const b = await openMap(context, `${base}&seek=3000`);
  await sleep(500);
  const p1 = await b.page.evaluate('window.__wakeConsole()');
  ok(p1.expanded === true && p1.rowsVisible === 20, `e expanded survives a reload (${p1.rowsVisible} rows)`);
  await b.page.keyboard.press('l');
  await sleep(400);
  const p2 = await b.page.evaluate('window.__wakeConsole()');
  ok(p2.expanded === false && p2.rowsVisible === 7, `e \`l\` collapses it (${p2.rowsVisible} rows)`);
  await b.page.close();
  const c = await openMap(context, `${base}&seek=3000`);
  await sleep(500);
  const p3 = await c.page.evaluate('window.__wakeConsole()');
  ok(p3.expanded === false && p3.rowsVisible === 7, `e collapsed survives a reload too (${p3.rowsVisible} rows)`);

  // ---- b: scrub back to event 10 --------------------------------------------
  await c.page.evaluate(() => window.__wakeCadence(40));
  await c.page.waitForFunction((n) => window.__wakeChrome().lines === n, TOTAL, { timeout: 30_000 });
  await c.page.evaluate(() => window.__wakeCadence(1500));
  await c.page.evaluate(() => window.__wakeScrub(10));
  await sleep(300);
  const back = await c.page.evaluate('window.__wakeChrome()');
  ok(back.lines === 10 && back.rendered <= 10, `b scrubbing back to event 10 leaves ${back.lines} lines (${back.rendered} in the DOM)`);
  errors.push(...b.errors, ...c.errors);
  await c.page.close();

  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
  else console.log('all console checks passed');
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
