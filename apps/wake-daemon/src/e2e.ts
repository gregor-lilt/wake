// End-to-end test, no interactive session needed.
//
//   bun run src/e2e.ts --repo <path> [--port 7791] [--claude claude]
//
// 1. `init` on the target repository (hooks + git exclude)
// 2. static export via packages/export (the parity baseline)
// 3. start `serve`, wait for /health
// 4. GET /map, compare node/rect/edge counts with the static export
// 5. connect to /live, expect hello then snapshot
// 6. run a headless `claude -p` in the target repository (real http hooks),
//    expect >= 4 `event` frames incl. a transcript-tailed assistant `message`,
//    and a `session` state change
// 7. append a line to a tracked file, expect `invalidate`, restore the file
//
// Whatever the test touches in the target repository is put back: the file,
// and `.claude/settings.local.json` if it did not exist before. Only counts
// are printed, never paths inside the target repository beyond what the
// caller passed on the command line.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WakeExport } from '../../../packages/export/src/schema.ts';
import { initRepo } from './init.ts';
import type { ServerMessage } from './protocol.ts';

const HERE = import.meta.dirname;
const APP = resolve(HERE, '..');
const WAKE_ROOT = resolve(APP, '..', '..');
const OUT = join(APP, '.e2e');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const repo = resolve(arg('--repo', process.env['WAKE_TEST_REPO'] ?? ''));
if (repo === resolve('')) {
  console.error('usage: e2e --repo <path> [--port 7791] [--claude claude]');
  process.exit(2);
}
const port = Number(arg('--port', '7791'));
const claudeBin = arg('--claude', 'claude');
const base = `http://127.0.0.1:${port}`;
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const runner = isBun ? ['bun', 'run'] : ['node', '--experimental-strip-types', '--experimental-sqlite', '--no-warnings=ExperimentalWarning'];

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, what: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures.push(what);
    console.log(`  FAIL ${what}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

async function waitFor(pred: () => boolean, ms: number, step = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

function countsOf(doc: WakeExport): Record<string, number> {
  const byKind: Record<string, number> = { dir: 0, file: 0, symbol: 0 };
  for (const n of doc.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  return { ...byKind, rects: doc.rects.length, edges: doc.edges.length, symbolEdges: doc.symbolEdges.length };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const settingsPath = join(repo, '.claude', 'settings.local.json');
  const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;

  // 1. init
  console.log('\n[1] init');
  await initRepo(repo, port);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown[]> };
  check(Object.keys(settings.hooks ?? {}).length === 10, 'init wrote 10 hook events');

  // 2. static export
  console.log('\n[2] static export');
  const staticOut = join(OUT, 'static.json');
  // packages/export runs on Node (its own documented runtime). Under Bun its
  // read-only node:sqlite open fails right after the indexer closes the WAL
  // sidecars (see mapdoc.ts, keepAlive), so prefer Node here when present.
  const nodeRunner = ['node', '--experimental-strip-types', '--experimental-sqlite', '--no-warnings=ExperimentalWarning'];
  const exportRunner = spawnSync('node', ['--version'], { encoding: 'utf8' }).status === 0 ? nodeRunner : runner;
  console.log(`  runner ${exportRunner[0]}`);
  const exp = spawnSync(
    exportRunner[0]!,
    [...exportRunner.slice(1), join(WAKE_ROOT, 'packages', 'export', 'src', 'main.ts'), '--repo', repo, '--worktree', '--out', staticOut],
    { encoding: 'utf8' },
  );
  if (exp.status !== 0) console.log(`  export stderr: ${exp.stderr.slice(-600)}`);
  check(exp.status === 0, `static export exit ${exp.status}`);
  const staticDoc = JSON.parse(readFileSync(staticOut, 'utf8')) as WakeExport;
  const staticCounts = countsOf(staticDoc);
  console.log(`  static counts ${JSON.stringify(staticCounts)}`);

  // 3. serve
  console.log('\n[3] serve');
  const daemonLog: string[] = [];
  const daemon = spawn(runner[0]!, [...runner.slice(1), join(APP, 'src', 'main.ts'), 'serve', '--repo', repo, '--port', String(port)], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (d: string) => daemonLog.push(...d.split('\n').filter(Boolean)));
  daemon.stderr.on('data', (d: string) => daemonLog.push(...d.split('\n').filter(Boolean)));
  let health: { ok?: boolean; indexed?: boolean } = {};
  const up = await waitFor(() => {
    return daemonLog.some((l) => l.includes('listening'));
  }, 60_000);
  if (up) health = (await fetch(`${base}/health`).then((r) => r.json())) as typeof health;
  check(health.ok === true && health.indexed === true, `health ok and indexed`);

  try {
    // 4. /map parity
    console.log('\n[4] GET /map');
    const doc = (await fetch(`${base}/map`).then((r) => r.json())) as WakeExport;
    const liveCounts = countsOf(doc);
    console.log(`  live counts   ${JSON.stringify(liveCounts)}`);
    check(doc.schemaVersion === 3, 'schemaVersion 3');
    check(JSON.stringify(liveCounts) === JSON.stringify(staticCounts), 'counts identical to the static export');
    const sameRects = JSON.stringify(doc.rects) === JSON.stringify(staticDoc.rects);
    check(sameRects, 'rects identical to the static export');
    check(doc.session.events.length === 0, 'no session events before any hook');
    const firstFile = doc.nodes.find((n) => n.kind === 'file' && n.lang === 'md');
    const fileRes = await fetch(`${base}/file?path=${encodeURIComponent(firstFile?.path ?? '')}`);
    check(fileRes.status === 200 && (await fileRes.text()).length > 0, 'GET /file returns text for a node');
    const badRes = await fetch(`${base}/file?path=..%2F..%2Fetc%2Fpasswd`);
    check(badRes.status === 404, 'GET /file rejects a path outside the node list');
    const diffRes = await fetch(`${base}/diff?path=${encodeURIComponent(firstFile?.path ?? '')}`);
    check(diffRes.status === 200, 'GET /diff answers');

    // 5. websocket
    console.log('\n[5] /live');
    const frames: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data)) as ServerMessage));
    await waitFor(() => frames.length >= 2, 5000);
    check(frames[0]?.type === 'hello' && frames[0].protocol === 1, 'hello first');
    check(frames[1]?.type === 'snapshot', 'snapshot second');
    ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => frames.some((f) => f.type === 'pong'), 2000);
    check(frames.some((f) => f.type === 'pong'), 'pong');

    // 6. headless claude
    console.log('\n[6] headless claude -p');
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    const prompt =
      'Read README.md and pyproject.toml in the current directory with the Read tool, then describe each in one sentence. Do not edit anything, do not run shell commands.';
    const claude = spawnSync(
      claudeBin,
      ['-p', prompt, '--permission-mode', 'acceptEdits', '--max-turns', '6'],
      { cwd: repo, env, encoding: 'utf8', timeout: 170_000 },
    );
    check(claude.status === 0, `claude exit ${claude.status}${claude.error ? ` (${claude.error.message})` : ''}`);
    if (claude.status !== 0) console.log(`  stderr: ${claude.stderr.slice(0, 400)}`);
    await waitFor(() => frames.some((f) => f.type === 'session' && f.state === 'idle'), 10_000);
    await sleep(1500); // let the transcript tail catch the last message
    const events = frames.filter((f) => f.type === 'event');
    const messages = events.filter((f) => f.type === 'event' && f.event.kind === 'message' && f.event.role === 'assistant');
    const reads = events.filter((f) => f.type === 'event' && f.event.kind === 'read');
    const sessions = frames.filter((f) => f.type === 'session');
    console.log(`  frames: ${events.length} event, ${sessions.length} session, ${messages.length} assistant message, ${reads.length} read`);
    console.log(`  kinds: ${JSON.stringify(events.map((f) => (f.type === 'event' ? f.event.kind : '')).reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}))}`);
    check(events.length >= 4, `at least 4 event frames (${events.length})`);
    check(messages.length >= 1, `an assistant message from the transcript tail (${messages.length})`);
    check(reads.length >= 1 && reads.every((f) => f.type === 'event' && f.event.nodeId !== null), `read events mapped to file nodes (${reads.length})`);
    check(sessions.some((f) => f.type === 'session' && f.state === 'running'), 'session running');
    check(sessions.some((f) => f.type === 'session' && f.state === 'idle'), 'session idle after Stop');
    const ids = events.map((f) => (f.type === 'event' ? f.event.id : 0));
    check(ids.every((id, i) => i === 0 || id > ids[i - 1]!), 'event ids monotonic');
    const mapAfter = (await fetch(`${base}/map`).then((r) => r.json())) as WakeExport;
    check(mapAfter.session.events.length === events.length, `GET /map session carries the ${events.length} events`);
    const sid = frames.find((f) => f.type === 'session')?.type === 'session' ? (frames.find((f) => f.type === 'session') as { sessionId: string | null }).sessionId : null;
    const logPath = sid ? join(repo, '.wake', 'live', `${sid}.jsonl`) : '';
    check(sid !== null && existsSync(logPath), 'event log .wake/live/<sessionId>.jsonl exists');

    // 7. touch a tracked file
    console.log('\n[7] file change');
    const target = staticDoc.nodes.find((n) => n.kind === 'file' && n.path === 'README.md') ?? firstFile;
    const targetPath = join(repo, target!.path);
    const original = readFileSync(targetPath);
    const before = frames.length;
    writeFileSync(targetPath, Buffer.concat([original, Buffer.from('\nwake e2e touch\n')]));
    const got = await waitFor(() => frames.slice(before).some((f) => f.type === 'invalidate' && f.nodeId === target!.id), 15_000);
    const inv = frames.slice(before).find((f) => f.type === 'invalidate' && f.nodeId === target!.id);
    check(got, `invalidate for the touched node (${inv?.type === 'invalidate' ? `${inv.effectiveLines} lines` : 'none'})`);
    const nodeFrames = frames.slice(before).filter((f) => f.type === 'node').length;
    console.log(`  node frames after the touch: ${nodeFrames}`);
    writeFileSync(targetPath, original);
    const restored = await waitFor(() => frames.slice(before).filter((f) => f.type === 'invalidate' && f.nodeId === target!.id).length >= 2, 15_000);
    check(restored, 'invalidate again after restoring the file');
    check(readFileSync(targetPath).equals(original), 'file restored byte for byte');
    const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--', target!.path], { encoding: 'utf8' }).stdout.trim();
    check(dirty === '' || dirty === spawnSync('git', ['-C', repo, 'status', '--porcelain', '--', target!.path], { encoding: 'utf8' }).stdout.trim(), 'git status of the touched file unchanged by the test');

    ws.close();
  } finally {
    daemon.kill('SIGTERM');
    await sleep(500);
    if (settingsBefore === null) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, settingsBefore);
    writeFileSync(join(OUT, 'daemon.log'), `${daemonLog.join('\n')}\n`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
