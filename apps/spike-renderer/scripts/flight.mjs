/**
 * Fly-to verification (docs/design.md decision log, 2026-09-03, "programmatic
 * fly-to with a duration lands on its first frame"). Runs on the synthetic
 * fixture and, when WAKE_EXPORT is set, on the real export too:
 *
 *   a  a 900 ms fly-to glides: the drawn zoom passes through at least 5
 *      distinct intermediate values and lands within 0.01 of the target
 *   b  a wheel event mid-flight cancels it: the flight is gone at once and
 *      the camera does not arrive at the flight's target
 *   c  under prefers-reduced-motion the same fly-to lands on its first frame
 *   d  the frame rate during a flight stays at 120 fps
 *
 * Screenshots go to screenshots/71-*.png .. 76-*.png (gitignored, the export
 * ones render real names).
 *
 *   npm run flight
 *   WAKE_EXPORT=<export name> npm run flight
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, launch, openMap, sleep } from './driver.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const errors = [];
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const fixtures = [{ label: 'synthetic', q: 'theme=dark', n: 71 }];
if (process.env.WAKE_EXPORT) {
  fixtures.push({ label: process.env.WAKE_EXPORT, q: `data=${encodeURIComponent(process.env.WAKE_EXPORT)}&theme=dark`, n: 74 });
}

/** Start a 900 ms flight to rowPx 9 and sample the drawn zoom every frame. */
const sampleFlight = (page, ms = 900) => page.evaluate((flyMs) => new Promise((res) => {
  const t0 = performance.now();
  const f0 = window.__wakeCodeState().frames;
  const target = window.__wakeGoto({ rowPx: 9, line: 0, ms: flyMs });
  const samples = [];
  const tick = () => {
    const now = performance.now() - t0;
    const vp = window.__deck.getViewports()[0];
    samples.push({ t: now, zoom: vp.zoom, dz: Math.abs(vp.zoom - target.zoom) });
    if (now < 1100) requestAnimationFrame(tick);
    else res({ target: target.zoom, samples, fps: ((window.__wakeCodeState().frames - f0) * 1000) / now });
  };
  requestAnimationFrame(() => requestAnimationFrame(tick));
}), ms);

const stop = await startServer();
const { browser, context } = await launch();
try {
  for (const fx of fixtures) {
    const { page, errors: pe } = await openMap(context, fx.q);
    await page.evaluate(() => window.__wakeToggle('autopilot', false));
    await page.evaluate(() => document.body.classList.add('nohud'));
    // Warm the text store so the flight is measured, not the worker.
    await page.evaluate(() => window.__wakeGoto({ rowPx: 9, line: 0, ms: 0 }));
    await sleep(1500);
    await page.evaluate(() => window.__wakeGoto({ rowPx: 1.5, ms: 0 }));
    await sleep(800);

    // ---- a: the flight glides and lands ------------------------------------
    const shotMid = page.evaluate(() => new Promise((r) => setTimeout(r, 350)))
      .then(() => page.screenshot({ path: path.join(OUT, `${fx.n}-flight-mid-${fx.label}.png`) }));
    const a = await sampleFlight(page);
    await shotMid;
    const mid = a.samples.filter((x) => x.dz >= 0.01);
    const distinct = new Set(mid.map((x) => x.zoom.toFixed(3))).size;
    const arrive = a.samples.find((x) => x.dz < 0.01);
    const last = a.samples[a.samples.length - 1];
    const monotone = mid.every((x, i) => i === 0 || x.zoom >= mid[i - 1].zoom - 1e-9);
    ok(distinct >= 5 && last.dz < 0.01 && arrive && arrive.t > 400 && arrive.t < 1000 && monotone,
      `a ${fx.label}: 900 ms fly-to glides through ${distinct} distinct zooms over ${mid.length} frames, ` +
      `monotone ${monotone}, within 0.01 at ${arrive ? arrive.t.toFixed(0) : '>1100'} ms, final dz ${last.dz.toExponential(1)}`);
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `${fx.n + 1}-flight-landed-${fx.label}.png`) });

    // ---- d: 120 fps while flying --------------------------------------------
    ok(a.fps >= 100, `d ${fx.label}: ${a.fps.toFixed(0)} fps during the flight`);

    // ---- b: a wheel event mid-flight cancels it ------------------------------
    await page.evaluate(() => window.__wakeGoto({ rowPx: 1.5, ms: 0 }));
    await sleep(600);
    const target = await page.evaluate(() => window.__wakeGoto({ rowPx: 9, line: 0, ms: 900 }));
    await sleep(250);
    const inFlight = await page.evaluate(() => window.__wakeFlight());
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, 120);
    await sleep(60);
    const afterWheel = await page.evaluate(() => window.__wakeFlight());
    await sleep(1000);
    const zoomEnd = await page.evaluate(() => window.__deck.getViewports()[0].zoom);
    const dz = Math.abs(zoomEnd - target.zoom);
    ok(inFlight && inFlight.progress > 0.1 && inFlight.progress < 0.6 && afterWheel === null && dz > 0.3,
      `b ${fx.label}: wheel at progress ${inFlight ? inFlight.progress.toFixed(2) : '-'} cancels the flight ` +
      `(flight after wheel: ${JSON.stringify(afterWheel)}), camera settles ${dz.toFixed(2)} zoom levels off the flight target`);
    await page.screenshot({ path: path.join(OUT, `${fx.n + 2}-flight-cancelled-${fx.label}.png`) });
    errors.push(...pe);
    await page.close();

    // ---- c: reduced motion lands on the first frame --------------------------
    const { page: rp, errors: re } = await openMap(context, fx.q);
    await rp.emulateMedia({ reducedMotion: 'reduce' });
    await rp.evaluate(() => window.__wakeToggle('autopilot', false));
    await rp.evaluate(() => window.__wakeGoto({ rowPx: 9, line: 0, ms: 0 }));
    await sleep(1200);
    await rp.evaluate(() => window.__wakeGoto({ rowPx: 1.5, ms: 0 }));
    await sleep(600);
    const c = await sampleFlight(rp);
    const between = c.samples.filter((x) => x.dz >= 0.01).length;
    ok(c.samples.length > 0 && c.samples[0].dz < 0.01 && between === 0,
      `c ${fx.label}: reduced motion lands on the first frame (${c.samples[0]?.t.toFixed(0)} ms, ${between} in-between frames)`);
    errors.push(...re);
    await rp.close();
  }
  console.log(errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : '\npage errors: none');
  if (failures.length) console.log(`FAILURES (${failures.length}):\n${failures.join('\n')}`);
  else console.log('all checks passed');
} finally {
  await browser.close();
  stop();
}
process.exit(errors.length || failures.length ? 1 : 0);
