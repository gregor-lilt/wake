/**
 * Screenshots at the four zoom levels plus a light-theme shot, then the bench.
 * Output: apps/spike-renderer/screenshots/*.png and bench.json
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, launch, openMap, glInfo, runOneBench, printPhases, sleep } from './driver.mjs';

const OUT = path.join(ROOT, 'screenshots');
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { file: '01-continent-dark.png', q: 'view=continent&theme=dark' },
  { file: '02-country-dark.png', q: 'view=country&theme=dark' },
  { file: '03-city-dark.png', q: 'view=city&theme=dark' },
  { file: '04-street-dark.png', q: 'view=street&theme=dark' },
  { file: '05-continent-light.png', q: 'view=continent&theme=light' },
  { file: '06-country-light.png', q: 'view=country&theme=light' },
  { file: '07-city-traffic-dark.png', q: 'view=city&theme=dark&traffic=1' },
  { file: '08-continent-nolabels.png', q: 'view=continent&theme=dark&labels=0' },
  // Autopilot: seek into the simulated session so the shots are reproducible.
  { file: '09-autopilot-follow-dark.png', q: 'autopilot=1&theme=dark&seek=20000', settle: 4000 },
  {
    file: '10-autopilot-crossjump-dark.png',
    q: 'autopilot=1&theme=dark&seek=30000',
    // Catch it late enough that the damped camera has pulled back to country
    // zoom while the trip marker is still in flight.
    until: 'window.__wakeAutoState().crossAgeMs > 950 && window.__wakeAutoState().crossAgeMs < 1350',
    settle: 20
  }
];

// Real repository export, opt-in. The export name is never written into this
// package: pass it at run time, WAKE_EXPORT=<name> npm run screenshots.
// The two shots it produces render real paths as map labels and are gitignored.
if (process.env.WAKE_EXPORT) {
  const d = encodeURIComponent(process.env.WAKE_EXPORT);
  SHOTS.push(
    { file: '11-real-export-country.png', q: `data=${d}&view=country&theme=dark`, settle: 3000 },
    {
      file: '12-real-export-replay.png',
      q: `data=${d}&autopilot=1&theme=dark&seek=112500`,
      until: 'window.__wakeAutoState().trips >= 3',
      settle: 400
    }
  );
}

const stop = await startServer();
const { browser, context } = await launch();
const allErrors = [];
try {
  for (const shot of SHOTS) {
    const { page, errors } = await openMap(context, shot.q + '&nohud=0');
    if (!process.env.QUIET) {
      const gl = await glInfo(page);
      console.log(`webgl2=${gl.webgl2} renderer=${gl.renderer ?? '?'}`);
      process.env.QUIET = '1';
    }
    if (shot.until) await page.waitForFunction(shot.until, null, { timeout: 60_000 });
    await sleep(shot.settle ?? 2500); // let fonts, the collision pass and fps settle
    await page.screenshot({ path: path.join(OUT, shot.file) });
    console.log('wrote screenshots/' + shot.file);
    if (errors.length) allErrors.push(`${shot.file}: ${errors.join(' | ')}`);
    await page.close();
  }

  console.log('bench running (about 70s)...');
  const a = await runOneBench(context, 'bench=1&theme=dark&nohud=1', 'bench.json', glInfo);
  console.log('\n== labels + edges on ==');
  printPhases(a);
  const b = await runOneBench(context, 'bench=1&theme=dark&nohud=1&traffic=1', 'bench-traffic.json', glInfo);
  console.log('\n== same, plus traffic demo (50 cities/s, CPU side) ==');
  printPhases(b);
  allErrors.push(...a.pageErrors, ...b.pageErrors);
  if (allErrors.length) console.log('\npage errors:\n' + allErrors.join('\n'));
  console.log('\nwrote screenshots/bench.json and screenshots/bench-traffic.json');
  await sleep(50);
} finally {
  await browser.close();
  stop();
}

process.exit(0);
