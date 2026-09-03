/**
 * Splash verification.
 *
 *   npm run splash                          synthetic fixture only
 *   WAKE_EXPORT=<export name> npm run splash    both data sources
 *
 * Checks, per data source:
 *
 *   a  the splash is on screen before the map is
 *   b  the status line walks the real startup stages, in order, with real
 *      counts (every distinct line it showed is logged)
 *   c  it is gone after the first rendered frame, and the map is left framed
 *   d  a key during the fade removes it at once, and a key during the load
 *      skips the fade altogether
 *   e  ?nosplash=1 never mounts a splash element
 *   f  no page errors on any of the runs
 *
 * The mid-load screenshot of the real export goes to screenshots/27-splash.png
 * (gitignored with the rest of the 2*.png phase-1 shots).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, BASE, startServer, launch, sleep } from './driver.mjs';

const NAME = process.env.WAKE_EXPORT ?? null;
const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const PROBE = () => {
  const el = document.getElementById('splash');
  const bar = el ? el.querySelector('.bar i') : null;
  return {
    present: el !== null,
    leaving: el ? el.classList.contains('leaving') : false,
    status: el ? (el.querySelector('.status')?.textContent ?? '') : null,
    bar: bar ? bar.style.width : null,
    ready: window.__wakeReady === true,
    icon: el ? (el.querySelector('.icon')?.getAttribute('src') ?? '') : null,
    word: el ? (el.querySelector('.word')?.textContent ?? '') : null,
    tag: el ? (el.querySelector('.tag')?.textContent ?? '') : null,
    keys: el ? (el.querySelector('.keys')?.textContent ?? '') : null
  };
};

/** Open a page and sample the splash every few ms until it is gone. */
async function watch(context, query, opts = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
  });
  const stages = [];
  let sawSplash = false;
  let chrome = null;
  let goneAtMs = null;
  let shot = false;
  let skippedAtMs = null;
  let sawLeaving = false;
  const t0 = Date.now();
  await page.goto(`${BASE}/?${query}`, { waitUntil: 'commit' });
  for (;;) {
    const at = Date.now() - t0;
    if (at > 90_000) break;
    const s = await page.evaluate(PROBE);
    if (s.present) {
      sawSplash = true;
      chrome ??= { icon: s.icon, word: s.word, tag: s.tag, keys: s.keys };
      const last = stages[stages.length - 1];
      if (s.status && (!last || last.status !== s.status)) stages.push({ status: s.status, atMs: at, bar: s.bar });
    }
    if (s.leaving) sawLeaving = true;
    // ?skip=load presses a key while the map is still loading (the skip is
    // remembered and applied the moment the first frame is up); ?skip=fade
    // presses one during the 600 ms fade, which must end it at once.
    if (skippedAtMs === null && s.present && opts.skip === 'load') {
      skippedAtMs = at;
      await page.keyboard.press('Space');
    }
    if (skippedAtMs === null && s.present && s.leaving && opts.skip === 'fade') {
      skippedAtMs = at;
      await page.keyboard.press('Space');
    }
    // The mid-load shot is taken on a named stage when one is asked for, so
    // the picture is the same one every time, with a time fallback in case
    // that stage is skipped.
    const stageWanted = opts.shotWhen ? (s.status ?? '').includes(opts.shotWhen) : at > (opts.shotAfterMs ?? 250);
    if (!shot && opts.shotPath && s.present && !s.leaving && (stageWanted || at > (opts.shotByMs ?? 1200))) {
      shot = true;
      await page.screenshot({ path: opts.shotPath });
      console.log(`      shot at ${at}ms, status "${s.status}"`);
    }
    if (sawSplash && !s.present) { goneAtMs = at; break; }
    if (!sawSplash && s.ready && at > (opts.settleMs ?? 1500)) break;
    await sleep(8);
  }
  await page.waitForFunction('window.__wakeReady === true', null, { timeout: 60_000 });
  const state = await page.evaluate(() => ({
    log: window.__wakeSplash ? window.__wakeSplash().log : null,
    active: window.__wakeSplash ? window.__wakeSplash().active : null,
    present: document.getElementById('splash') !== null,
    zoom: window.__wakeCodeState ? window.__wakeCodeState().zoom : null,
    band: window.__wakeCodeState ? window.__wakeCodeState().band : null
  }));
  return { page, errors, stages, sawSplash, chrome, goneAtMs, skippedAtMs, sawLeaving, state };
}

async function main() {
  const stop = await startServer();
  const { browser, context } = await launch();
  try {
    const sources = [{ label: 'synthetic fixture', q: 'theme=dark' }];
    if (NAME) sources.push({ label: 'real export', q: `data=${encodeURIComponent(NAME)}&theme=dark` });

    for (const src of sources) {
      console.log(`\n== ${src.label}`);
      const real = src.label === 'real export';
      const w = await watch(context, `${src.q}&nosplash=0`, {
        shotPath: real ? path.join(OUT, '27-splash.png') : null,
        shotWhen: 'tokenizing'
      });
      ok(w.sawSplash, 'splash mounts before the map');
      ok(
        w.chrome?.word === 'Wake' &&
          w.chrome?.tag === 'the map behind the agent' &&
          w.chrome?.icon === '/icon.svg' &&
          /press any key to skip/.test(w.chrome?.keys ?? ''),
        'splash shows the approved icon, wordmark, tagline and skip hint'
      );
      console.log('      stages:');
      for (const s of w.stages) console.log(`        ${String(s.atMs).padStart(5)}ms  bar ${String(s.bar).padStart(6)}  ${s.status}`);
      console.log('      in-page log: ' + JSON.stringify(w.state.log));
      const seen = w.stages.map((s) => s.status);
      const want = real
        ? [/^reading export$/, /^laying out [\d,]+ districts$/, /^routing [\d,]+ roads$/, /^ranking labels$/, /^loading highlighter$/]
        : [/^generating repository$/, /^laying out [\d,]+ districts$/, /^routing [\d,]+ roads$/, /^ranking labels$/, /^loading highlighter$/];
      let i = 0;
      for (const rx of want) {
        const at = seen.findIndex((s, k) => k >= i && rx.test(s));
        ok(at >= 0, `status line showed ${rx.source}`);
        if (at >= 0) i = at + 1;
      }
      if (real) ok(seen.some((s) => /^tokenizing \d+(\/\d+)? files$/.test(s)), 'status line showed tokenizing N files');
      ok(w.goneAtMs !== null && !w.state.present, `splash dismissed after the first frame (${w.goneAtMs}ms)`);
      ok(w.goneAtMs === null || w.goneAtMs >= 400 + 600, 'minimum display plus fade honoured (>= 1000ms)');
      ok(w.errors.length === 0, `no page errors (${w.errors.length})` + (w.errors[0] ? ` first: ${w.errors[0]}` : ''));
      await w.page.close();

      // A key during the fade ends it at once.
      const f = await watch(context, `${src.q}&nosplash=0`, { skip: 'fade' });
      ok(
        f.sawLeaving && f.goneAtMs !== null && f.goneAtMs - f.skippedAtMs < 150,
        `a key during the fade removes the splash at once (${f.goneAtMs - f.skippedAtMs}ms after the key)`
      );
      await f.page.close();

      // A key during the load skips the fade entirely once the map is up.
      const k = await watch(context, `${src.q}&nosplash=0`, { skip: 'load' });
      ok(k.goneAtMs !== null && !k.sawLeaving, `a key during the load skips the fade (gone at ${k.goneAtMs}ms)`);
      await k.page.close();

      // ?nosplash=1: nothing mounts, ever.
      const n = await watch(context, `${src.q}&nosplash=1`, { settleMs: 1200 });
      ok(!n.sawSplash && !n.state.present && n.state.active === false, '?nosplash=1 produces no splash element');
      ok(n.errors.length === 0, `no page errors with ?nosplash=1 (${n.errors.length})`);
      await n.page.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURES`}`);
  if (failures.length) process.exit(1);
}

await main();
