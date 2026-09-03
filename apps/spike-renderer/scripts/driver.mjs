import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT ?? 5199);
export const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

export async function startServer() {
  // Always build. The preview server serves dist/, so a suite run against a
  // stale bundle silently checks the previous version of the code: skipping
  // the build when dist/ merely exists cost more than the three seconds it
  // takes.
  if (process.env.WAKE_NO_BUILD !== '1' || !existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    await run('npm', ['run', 'build']);
  }
  const bin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [bin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(String(d)));
  const up = await waitForServer(BASE);
  if (!up) {
    proc.kill('SIGKILL');
    throw new Error(`preview server did not come up on ${BASE}`);
  }
  return () => proc.kill('SIGKILL');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

export async function launch() {
  const { chromium } = await import('playwright');
  const headless = process.env.HEADED !== '1';
  const args = [
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--use-angle=metal'
  ];
  // channel 'chromium' is the full browser (new headless mode), which can reach
  // the real GPU; the default headless shell falls back to SwiftShader.
  const browser = await chromium.launch({ headless, channel: 'chromium', args });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  return { browser, context };
}

/**
 * The loading splash is off for every automated run: it would sit over the
 * first frames and its stage yields would show up in the timings. A caller
 * that wants it (scripts/splash.mjs) passes nosplash= itself.
 */
export function mapQuery(query) {
  if (/(^|&)nosplash=/.test(query)) return query;
  return `${query}${query ? '&' : ''}nosplash=1`;
}

export async function openMap(context, query) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
  });
  await page.goto(`${BASE}/?${mapQuery(query)}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__wakeReady === true', null, { timeout: 60_000 });
  return { page, errors };
}

export async function glInfo(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { webgl2: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    };
  });
}


export function printPhases(bench) {
  console.log('\nlevel      zoom   med   p95  mean   fps  cities  labels   roads');
  for (const p of bench.phases) {
    console.log(
      [
        p.name.padEnd(10),
        p.zoom.toFixed(2).padStart(5),
        p.medianMs.toFixed(1).padStart(5),
        p.p95Ms.toFixed(1).padStart(5),
        p.meanMs.toFixed(1).padStart(5),
        p.fps.toFixed(0).padStart(5),
        String(p.citiesInView).padStart(7),
        String(p.labelsDrawn).padStart(7),
        String(p.roadsInView).padStart(7)
      ].join(' ')
    );
  }
}

export async function runOneBench(context, query, outFile, glInfoFn) {
  const { page, errors } = await openMap(context, query);
  const gl = await glInfoFn(page);
  const handle = await page.waitForFunction('window.__wakeBench || null', null, { timeout: 180_000 });
  const bench = await handle.jsonValue();
  bench.gl = gl;
  bench.headless = process.env.HEADED !== '1';
  bench.query = mapQuery(query);
  bench.pageErrors = errors;
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(path.join(ROOT, 'screenshots'), { recursive: true });
  writeFileSync(path.join(ROOT, 'screenshots', outFile), JSON.stringify(bench, null, 2));
  await page.close();
  return bench;
}

export { sleep };
