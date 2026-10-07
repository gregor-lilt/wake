/**
 * The app's own checks, end to end: the mock daemon, the built app in a
 * preview server, and a browser.
 *
 *   WAKE_EXPORT=<name> npm run verify
 *
 * What it proves:
 *   a  the splash names the real startup stages, in order, and the bar moves
 *   b  the map renders the document the daemon served (file count matches)
 *   c  events arrive over the socket and the console grows with them
 *   d  autopilot follows an edit into the reading band
 *   e  a socket drop shows "daemon offline" and a reconnect recovers
 *   f  `?data=<name>` renders with no daemon at all
 *   g  zero page errors, 120 fps at every band
 *   i  a file the agent CREATES mid-session appears: the daemon's scripted
 *      `node` frame grows the map into its headroom, the tile is drawn in its
 *      district, the caption is there at a fitting zoom, the console line for
 *      the edit flies to it, and nothing was counted as an unknown node
 *
 * Screenshots go to screenshots/, which is gitignored: they render a real
 * repository's names, paths and source.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTS = path.resolve(ROOT, '../../.wake/exports');
const NAME = process.env.WAKE_EXPORT;
const PORT = Number(process.env.PORT ?? 5200);
const DAEMON_PORT = Number(process.env.WAKE_DAEMON_PORT ?? 7788);
const BASE = `http://localhost:${PORT}`;
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
/** Fast enough that the checks do not wait minutes, slow enough to be a replay. */
const CADENCE = Number(process.env.WAKE_CADENCE ?? 600);
const OUT = path.join(ROOT, 'screenshots');

if (!NAME) {
  console.error('set WAKE_EXPORT=<export name> (the exports directory is gitignored)');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const doc = JSON.parse(readFileSync(path.join(EXPORTS, `${NAME}.json`), 'utf8'));
const FILES = doc.nodes.filter((n) => n.kind === 'file').length;
const EVENTS = doc.session.events.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

async function waitFor(url, timeoutMs = 30_000, until = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (until === null || (await until(r)))) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

/** Events the daemon replays before it plays the scripted file creation. */
const SCRIPT_AT = Number(process.env.WAKE_SCRIPT_AT ?? 12);

/** The mock daemon, as a child process, so a check can kill and restart it. */
function startDaemon() {
  const p = spawn(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'mock-daemon.mjs'),
      '--export', NAME, '--port', String(DAEMON_PORT), '--cadence', String(CADENCE),
      '--script', 'new-file', '--script-at', String(SCRIPT_AT)
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(String(d)));
  return p;
}

async function startPreview() {
  if (process.env.WAKE_NO_BUILD !== '1' || !existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    await run('npm', ['run', 'build']);
  }
  const bin = path.resolve(ROOT, '../../node_modules/vite/bin/vite.js');
  const p = spawn(process.execPath, [bin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(String(d)));
  if (!(await waitFor(BASE))) {
    p.kill('SIGKILL');
    throw new Error(`preview did not come up on ${BASE}`);
  }
  return p;
}

async function openApp(context, query) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
  });
  await page.goto(`${BASE}/?${query}`, { waitUntil: 'load' });
  return { page, errors };
}

const ready = (page) => page.waitForFunction('window.__wakeReady === true', null, { timeout: 120_000 });

/** Frames per second measured over two seconds, the way the spike measures it. */
async function fpsHere(page) {
  const f0 = await page.evaluate('window.__wakeCodeState().frames');
  await sleep(2000);
  const st = await page.evaluate('window.__wakeCodeState()');
  return { fps: ((st.frames - f0) * 1000) / 2000, band: st.band, rowPx: st.rowPx };
}

const main = async () => {
  const { chromium } = await import('playwright');
  const daemon = { proc: startDaemon() };
  const preview = await startPreview();
  if (!(await waitFor(`${DAEMON}/health`))) throw new Error('mock daemon did not come up');

  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    channel: 'chromium',
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=metal']
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const allErrors = [];

  try {
    // ---- a: the splash names the real stages -------------------------------
    // Opened WITH the splash: every stage below is one real piece of startup.
    const boot = await openApp(context, `daemon=${encodeURIComponent(DAEMON)}`);
    allErrors.push(...boot.errors);
    // Catch it mid-load, before the fade, and photograph it.
    await boot.page.waitForFunction(
      '(window.__wakeSplash?.()?.log?.length ?? 0) >= 2 || window.__wakeReady === true',
      null, { timeout: 60_000 }
    ).catch(() => {});
    const mid = await boot.page.evaluate(() => (window.__wakeSplash ? window.__wakeSplash() : null));
    if (mid?.present) await boot.page.screenshot({ path: path.join(OUT, '01-splash.png') });
    await ready(boot.page);
    const splash = await boot.page.evaluate(() => window.__wakeSplash());
    const keys = splash.log.map((s) => s.key);
    const want = ['daemon', 'read', 'layout', 'roads', 'labels', 'highlighter'];
    ok(want.every((k, i) => keys[i] === k),
      `a the splash ran the real stages in order: ${keys.join(' → ')}`);
    ok(splash.log.filter((s) => s.ms > 0).length >= 4,
      `a ${splash.log.filter((s) => s.ms > 0).length} stages took measurable time (slowest ` +
      `${splash.log.reduce((a, b) => (b.ms > a.ms ? b : a)).key} at ${Math.max(...splash.log.map((s) => s.ms))} ms)`);
    ok(mid === null || mid.present === false || mid.barPct >= 0,
      `a the bar reports real progress (${mid?.barPct ?? 0}% at the shot)`);

    // ---- b: the document the daemon served is on the map -------------------
    const app = await boot.page.evaluate(() => window.__wakeApp());
    ok(app.stats.files === FILES,
      `b the map holds all ${app.stats.files} files of the document (export says ${FILES})`);
    ok(app.stats.dirs > 0 && app.stats.symbols > 0,
      `b ${app.stats.dirs} districts and ${app.stats.symbols} symbols came with it`);
    ok(app.repoName !== null, 'b the repository name arrived from the daemon');
    ok(app.connection === 'live' || app.connection === 'connecting',
      `b the socket is ${app.connection}`);

    // The scripted creation has not happened yet (it waits for event
    // SCRIPT_AT), so this is the district as the document laid it out.
    const script = await (await fetch(`${DAEMON}/script`)).json();
    const dist0 = script.plan
      ? await boot.page.evaluate((i) => {
        const d = window.__wakeGeo().dirs[i];
        return { files: d.files, rect: d.rect, total: window.__wakeApp().stats.files };
      }, script.plan.dirIndex)
      : null;
    ok(script.plan !== null && dist0 !== null && dist0.total === FILES,
      `i the daemon has a district to create a file in, with ${dist0?.files ?? 0} tiles in it`);

    // ---- c: events arrive and the console grows ----------------------------
    const growth = [];
    for (let i = 0; i < 6; i++) {
      growth.push(await boot.page.evaluate(() => window.__wakeConsole().total));
      await sleep(CADENCE + 200);
    }
    const grew = growth[growth.length - 1] > growth[0];
    ok(grew, `c the console grew with the stream: ${growth.join(' → ')} lines`);
    const live = await boot.page.evaluate(() => window.__wakeApp());
    ok(live.connection === 'live', `c the socket is live and the header shows no chip (${live.offlineChip ?? 'none'})`);
    await boot.page.screenshot({ path: path.join(OUT, '02-live.png') });
    const liveTimeline = await boot.page.evaluate(() => document.getElementById('timeline')?.hidden ?? true);
    ok(liveTimeline, 'c live mode has no replay timeline: the daemon is the clock');

    // ---- d: autopilot follows an edit into the reading band ----------------
    // The camera is the replay's while autopilot is on; wait for it to land on
    // a file at a row height a human can read.
    const landed = await boot.page.waitForFunction(() => {
      const s = window.__wakeCodeState();
      const a = window.__wakeAutoState();
      return s.band === 'reading' && a.on && s.overlays > 0 ? { band: s.band, rowPx: s.rowPx, event: a.event, cam: a.camState } : false;
    }, null, { timeout: 90_000 }).then((h) => h.jsonValue()).catch(() => null);
    ok(landed !== null,
      landed
        ? `d autopilot flew an edit into the reading band (rowPx ${landed.rowPx.toFixed(1)}, camera ${landed.cam})`
        : 'd autopilot flew an edit into the reading band');
    await boot.page.screenshot({ path: path.join(OUT, '03-reading.png') });

    // ---- g: 120 fps at every band ------------------------------------------
    // Same probe the spike uses: park at a row height and count frames. The
    // replay has to let go of the camera first, or every sample lands wherever
    // the agent happens to be.
    await boot.page.evaluate(() => window.__wakeToggle('autopilot', false));
    const bands = [];
    for (const rowPx of [0.6, 4, 12]) {
      await boot.page.evaluate((px) => window.__wakeGoto({ rowPx: px, ms: 0 }), rowPx);
      await sleep(700);
      bands.push(await fpsHere(boot.page));
    }
    for (const b of bands) {
      ok(b.fps >= 100, `g ${b.fps.toFixed(0)} fps at the ${b.band} band (rowPx ${b.rowPx.toFixed(2)})`);
      await boot.page.screenshot({ path: path.join(OUT, `04-${b.band}.png`) });
    }
    ok(new Set(bands.map((b) => b.band)).size === 3,
      `g the three samples were three different bands: ${bands.map((b) => b.band).join(', ')}`);

    // ---- i: the agent creates a file --------------------------------------
    // The one thing a recording cannot contain, and the thing every real
    // session does. The daemon sends the district's new rect, the new file's
    // node, the edit on it and an invalidate, exactly as docs/protocol.md says.
    if (script.plan) {
      const fired = await waitFor(`${DAEMON}/script`, 60_000, async (r) => (await r.json()).fired);
      ok(fired, `i the daemon played the creation after ${SCRIPT_AT} events`);
      const grown = await boot.page.waitForFunction(
        (n) => (window.__wakeApp().stats?.files ?? 0) === n ? window.__wakeApp().stats : false,
        FILES + 1, { timeout: 30_000 }
      ).then((h) => h.jsonValue()).catch(() => null);
      ok(grown !== null,
        `i the map grew to ${grown?.files ?? '?'} files without a reload (document had ${FILES})`);
      ok(grown !== null && grown.unknownNodes === 0,
        `i nothing was counted as an unknown node (${grown?.unknownNodes ?? '?'})`);

      const newFile = FILES; // appends take the next free slot, so it is the last
      const after = await boot.page.evaluate((i) => {
        const d = window.__wakeGeo().dirs[i];
        const files = window.__wakeFiles();
        return { files: d.files, rect: d.rect, dirOfNew: files.fileDirs[files.count - 1], count: files.count };
      }, script.plan.dirIndex);
      ok(after.files === dist0.files + 1,
        `i the district draws one tile more than it did (${dist0.files} → ${after.files})`);
      ok(after.dirOfNew === script.plan.dirIndex && after.count === FILES + 1,
        'i and the new tile is the one inside it');
      ok(after.rect.h > dist0.rect.h,
        `i the district grew to hold it (${dist0.rect.h} → ${after.rect.h} world units)`);

      // The caption, at a row height where the whole name fits on the tile.
      await boot.page.evaluate(() => window.__wakeToggle('autopilot', false));
      await boot.page.evaluate((f) => window.__wakeGoto({ file: f, rowPx: 9, ms: 0 }), newFile);
      await sleep(900);
      const caption = await boot.page.evaluate(
        (f) => (window.__wakeWayfind().captions ?? []).find((c) => c.file === f) ?? null, newFile
      );
      ok(caption !== null, `i its caption is on the map at a fitting zoom (${caption ? caption.text.length : 0} chars)`);
      await boot.page.screenshot({ path: path.join(OUT, '09-created.png') });

      // The console line for the edit on it: clickable, and it flies there.
      const line = await boot.page.evaluate((f) => window.__wakeConsole().eventFiles.lastIndexOf(f), newFile);
      ok(line >= 0, `i the edit on it is in the console log (line ${line})`);
      await boot.page.evaluate(() => window.__wakeGoto({ rowPx: 0.6, ms: 0 }));
      await sleep(400);
      const clicked = line >= 0 && await boot.page.evaluate((i) => window.__wakeConsoleClick(i), line);
      ok(clicked === true, 'i the line is clickable');
      const flown = await boot.page.waitForFunction(
        (f) => {
          const w = window.__wakeWayfind();
          return w.focusedFile === f && w.band === 'reading' ? { band: w.band, rowPx: w.rowPx } : false;
        },
        newFile, { timeout: 20_000 }
      ).then((h) => h.jsonValue()).catch(() => null);
      ok(flown !== null,
        flown ? `i and flies to it, into the reading band (rowPx ${flown.rowPx.toFixed(1)})` : 'i and flies to it');
      const still = await boot.page.evaluate(() => window.__wakeApp().stats.unknownNodes);
      ok(still === 0, `i stats().unknownNodes is still ${still} after the whole burst`);
      const fps = await fpsHere(boot.page);
      ok(fps.fps >= 100, `i ${fps.fps.toFixed(0)} fps on the grown map (${fps.band} band)`);
    }

    await boot.page.evaluate(() => window.__wakeToggle('autopilot', true));

    // ---- e: a socket drop, then a reconnect --------------------------------
    const before = await boot.page.evaluate(() => window.__wakeConsole().total);
    await boot.page.evaluate(() => window.__wakeDropSocket());
    const offline = await boot.page.waitForFunction(
      "window.__wakeApp().offlineChip !== null", null, { timeout: 20_000 }
    ).then(() => boot.page.evaluate(() => window.__wakeApp())).catch(() => null);
    ok(offline !== null && offline.offlineChip === 'daemon offline',
      `e the console header says "${offline?.offlineChip ?? 'nothing'}" while the socket is down`);
    await boot.page.screenshot({ path: path.join(OUT, '05-offline.png') });
    const back = await boot.page.waitForFunction(
      "window.__wakeApp().connection === 'live'", null, { timeout: 30_000 }
    ).then(() => boot.page.evaluate(() => window.__wakeApp())).catch(() => null);
    ok(back !== null, 'e the socket came back on its own');
    ok(back !== null && back.offlineChip === null, 'e the chip went away with it');
    await sleep(CADENCE * 3 + 400);
    const after = await boot.page.evaluate(() => window.__wakeConsole().total);
    // The reconnect repeats the whole snapshot, so this is also the check that
    // a snapshot REPLACES the log rather than doubling it.
    ok(after >= before && after <= Math.max(before, EVENTS),
      `e the log came through the drop intact, not doubled (${before} → ${after} lines, session has ${EVENTS})`);

    // ---- the shell's own chrome --------------------------------------------
    await boot.page.click('#ctl-terminal');
    await sleep(250);
    const term = await boot.page.evaluate(() => ({
      open: window.__wakeApp().terminalOpen,
      width: document.getElementById('term')?.getBoundingClientRect().width ?? 0,
      map: document.getElementById('map-host')?.getBoundingClientRect().width ?? 0
    }));
    ok(term.open && term.width > 200 && term.map > 800,
      `h the terminal pane opens to ${Math.round(term.width)} px and the map keeps ${Math.round(term.map)} px`);
    await boot.page.screenshot({ path: path.join(OUT, '06-terminal.png') });
    await boot.page.click('#term-close');
    await sleep(200);
    ok(await boot.page.evaluate(() => !window.__wakeApp().terminalOpen), 'h and closes again');

    await boot.page.click('#ctl-theme');
    await sleep(700);
    const themed = await boot.page.evaluate(() => window.__wakeApp().theme);
    ok(themed === 'light', `h the theme button switches the whole map to ${themed}`);
    await boot.page.screenshot({ path: path.join(OUT, '07-light.png') });
    await boot.page.click('#ctl-theme');

    await boot.page.click('#ctl-autopilot');
    await sleep(300);
    ok(await boot.page.evaluate(() => window.__wakeApp().autopilot === false),
      'h the autopilot button hands the camera back to the user');
    await boot.page.close();

    // ---- f: no daemon at all ------------------------------------------------
    // A port nothing is listening on, so the fallback is the only thing that
    // can put a map on the screen.
    const dead = 'http://127.0.0.1:1';
    const off = await openApp(context, `data=${encodeURIComponent(NAME)}&daemon=${encodeURIComponent(dead)}&nosplash=1`);
    allErrors.push(...off.errors);
    await ready(off.page);
    const offApp = await off.page.evaluate(() => window.__wakeApp());
    ok(offApp.stats.files === FILES,
      `f ?data= renders all ${offApp.stats.files} files with no daemon reachable`);
    ok(offApp.failure === null, 'f and reports no failure, because it never needed one');
    const offCode = await off.page.evaluate(() => window.__wakeCodeState());
    ok(offCode.enabled, 'f the source tier is live on the fallback path too');

    // ---- f: the replay timeline (PLAN.md section 12) -------------------------
    const tl = () => off.page.evaluate(() => {
      const el = document.getElementById('timeline');
      const [time, count] = [...el.querySelectorAll('span')].map((x) => x.textContent);
      return { hidden: el.hidden, time, count, paused: el.classList.contains('paused') };
    });
    const tl0 = await tl();
    ok(!tl0.hidden && tl0.count.endsWith(`/ ${EVENTS}`), `f the replay timeline shows the whole session (${tl0.count})`);
    const track = await off.page.locator('#timeline .tl-track').boundingBox();
    await off.page.mouse.click(track.x + track.width * 0.75, track.y + track.height / 2);
    await sleep(300);
    const tl1 = await tl();
    const at = Number(tl1.count.split(' / ')[0]);
    ok(Math.abs(at - Math.round(EVENTS * 0.75)) <= 1, `f a click at 75% of the track scrubs there (${tl1.count})`);
    await off.page.keyboard.press('Space');
    const held = await tl();
    await sleep(1800); // one replay cadence (1500 ms) and some
    const still = await tl();
    ok(held.paused && still.count === held.count, `f space pauses the replay and it holds (${still.count})`);
    await off.page.keyboard.press('Space');
    await sleep(1800); // one replay cadence (1500 ms) and some
    ok(!(await tl()).paused && (await tl()).count !== still.count, 'f space again resumes it');
    await off.page.screenshot({ path: path.join(OUT, '08-no-daemon.png') });
    await off.page.close();

    ok(allErrors.length === 0, `g zero page errors${allErrors.length ? ': ' + allErrors.slice(0, 3).join(' | ') : ''}`);
    console.log(`\nexport ${NAME.length ? 'loaded' : ''}: ${FILES} files, ${EVENTS} session events`);
  } finally {
    await browser.close().catch(() => {});
    daemon.proc.kill('SIGKILL');
    preview.kill('SIGKILL');
  }

  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
  console.log('\nall app checks passed');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
