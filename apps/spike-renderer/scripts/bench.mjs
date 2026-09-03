/**
 * Headless bench. Runs several configurations and writes one JSON per run into
 * screenshots/. HEADED=1 runs them in a visible window.
 *
 * Note: on a 120 Hz Mac every configuration that fits the frame budget reports
 * exactly 8.3 ms because deck.gl renders on requestAnimationFrame and is
 * vsync-locked. The dpr3 and 200k runs exist to find where the budget actually
 * breaks.
 */
import { startServer, launch, glInfo, runOneBench, printPhases, sleep } from './driver.mjs';

const RUNS = [
  { name: 'labels + edges on', q: 'bench=1&theme=dark&nohud=1', out: 'bench.json' },
  { name: 'plus traffic demo (50 cities/s, CPU side)', q: 'bench=1&theme=dark&nohud=1&traffic=1', out: 'bench-traffic.json' },
  { name: 'fill-rate probe: 3x device pixels', q: 'bench=1&theme=dark&nohud=1&dpr=3', out: 'bench-dpr3.json' },
  {
    name: 'scale probe: 200k files / 800k symbols / 80k edges',
    q: 'bench=1&theme=dark&nohud=1&files=200000&symbols=800000&edges=80000',
    out: 'bench-200k.json'
  }
];

const only = process.argv[2];
const stop = await startServer();
const { browser, context } = await launch();
const errs = [];
try {
  for (const run of RUNS) {
    if (only && !run.out.includes(only)) continue;
    const b = await runOneBench(context, run.q, run.out, glInfo);
    console.log(`\n== ${run.name} ==`);
    console.log('renderer:', b.gl.renderer ?? '(unknown)', '| canvas', b.canvas.width + 'x' + b.canvas.height, '| dpr', b.devicePixelRatio);
    console.log('fixture:', JSON.stringify(b.fixture));
    printPhases(b);
    console.log('deck metrics:', JSON.stringify(b.deckMetrics));
    errs.push(...b.pageErrors);
    console.log('-> screenshots/' + run.out);
  }
  if (errs.length) console.log('\npage errors:\n' + errs.join('\n'));
  await sleep(50);
} finally {
  await browser.close();
  stop();
}

process.exit(0);
