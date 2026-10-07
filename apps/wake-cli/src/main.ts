// wake: the front door. Run it in any repository you have used Claude Code in
// and the most recent session that worked there plays back on the map.
//
//   wake                       the repository around the current directory
//   wake --repo <path>         another repository
//   wake --session <file>      a specific transcript instead of the latest
//   wake --list                the recent sessions that worked in the repo
//   wake --live                watch the latest session as it happens
//   wake --live --session-id <id> --detach
//                              what /wake runs from inside a Claude Code
//                              session: that session, in the background,
//                              reusing a running instance for the same one
//   wake --stop                stop the background instance for this repo
//   wake --port 5300 --no-open
//
// No hooks, no config. Replay reads the transcript Claude Code already wrote,
// exports the repository and that session (packages/export, worktree mode),
// and serves the app in replay mode on loopback. `--live` instead starts the
// daemon in transcript mode, which tails the same file as it grows, so a
// session that is already running can be watched without restarting it.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const WAKE_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const APP_DIR = join(WAKE_ROOT, 'apps', 'wake');
const EXPORTS_DIR = join(WAKE_ROOT, '.wake', 'exports');
const INDEX_BINARY = join(WAKE_ROOT, 'target', 'release', 'wake-index');
const PROJECTS = join(homedir(), '.claude', 'projects');

/** How many of the newest transcripts are opened before giving up. */
const SCAN_LIMIT = 400;

interface Args {
  readonly repo: string;
  readonly session: string | null;
  readonly port: number;
  readonly open: boolean;
  readonly list: boolean;
  readonly live: boolean;
  readonly detach: boolean;
  readonly stop: boolean;
}

function usage(): never {
  console.error('usage: wake [--repo <path>] [--session <transcript.jsonl> | --session-id <id>] [--live] [--detach] [--stop] [--list] [--port 5300] [--no-open]');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let repo: string | null = null;
  let session: string | null = null;
  let port = Number(process.env['WAKE_PORT'] ?? 5300);
  let open = true;
  let list = false;
  let live = false;
  let detach = false;
  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--repo' && next !== undefined) {
      repo = next;
      i++;
    } else if (arg === '--session' && next !== undefined) {
      session = resolve(next);
      i++;
    } else if (arg === '--session-id' && next !== undefined) {
      session = transcriptForId(next);
      i++;
    } else if (arg === '--detach') {
      detach = true;
    } else if (arg === '--stop') {
      stop = true;
    } else if (arg === '--port' && next !== undefined) {
      port = Number(next);
      i++;
    } else if (arg === '--no-open') {
      open = false;
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--live') {
      live = true;
    } else {
      usage();
    }
  }
  return { repo: gitRoot(resolve(repo ?? process.cwd())), session, port, open, list, live, detach, stop };
}

/** `<projects>/<any slug>/<id>.jsonl`: a session id names one transcript wherever it was started. */
function transcriptForId(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`not a session id: ${id}`);
  for (const project of readdirSync(PROJECTS)) {
    const path = join(PROJECTS, project, `${id}.jsonl`);
    if (existsSync(path)) return path;
  }
  throw new Error(`no transcript for session ${id} under ${PROJECTS}`);
}

// ------------------------------------------------------------------ background instance

/**
 * One background live instance per repository, described in
 * `.wake/live/wake.json` so a second `/wake` reuses it instead of starting
 * another daemon and app server.
 */
interface Running {
  readonly pid: number;
  readonly transcript: string;
  readonly url: string;
}

function stateFile(repo: string): string {
  return join(repo, '.wake', 'live', 'wake.json');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRunning(repo: string): Running | null {
  try {
    const r = JSON.parse(readFileSync(stateFile(repo), 'utf8')) as Running;
    return alive(r.pid) ? r : null;
  } catch {
    return null;
  }
}

function stopRunning(repo: string): boolean {
  const r = readRunning(repo);
  rmSync(stateFile(repo), { force: true });
  if (r === null) return false;
  process.kill(r.pid, 'SIGTERM');
  return true;
}

/**
 * The daemon writes `.wake/live/` into the repository, so it has to be
 * ignored before anything is written, or the event log shows up on the map
 * as new files. Local only: `<common git dir>/info/exclude`, never a tracked
 * file. The same rule `wake-daemon init` writes.
 */
function excludeWakeDir(repo: string): void {
  if (spawnSync('git', ['-C', repo, 'check-ignore', '-q', '.wake/x']).status === 0) return;
  const common = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
  const info = join(resolve(repo, common), 'info');
  mkdirSync(info, { recursive: true });
  appendFileSync(join(info, 'exclude'), '\n# Wake: event logs and exports\n.wake/\n');
}

/**
 * Start this command again without `--detach`, detached from the terminal,
 * output to `.wake/live/wake.log`, and return once it has written its URL.
 */
async function detachSelf(repo: string): Promise<void> {
  const log = join(repo, '.wake', 'live', 'wake.log');
  mkdirSync(join(repo, '.wake', 'live'), { recursive: true });
  const fd = openSync(log, 'w');
  const argv = process.argv.slice(1).filter((a) => a !== '--detach');
  const child = spawn(process.execPath, [...process.execArgv, ...argv], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  for (let i = 0; i < 600; i++) {
    const r = readRunning(repo);
    if (r !== null && r.pid === child.pid) {
      console.log(`  live      ${r.url}`);
      console.log(`  log       ${log}`);
      console.log('  stop      wake --stop\n');
      return;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the background instance did not start, see ${log}:\n${readFileSync(log, 'utf8')}`);
}

function gitRoot(dir: string): string {
  const out = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (out.status !== 0) {
    console.error(`wake: ${dir} is not inside a git repository`);
    process.exit(1);
  }
  return out.stdout.trim();
}

// ------------------------------------------------------------------ sessions

interface Found {
  readonly transcript: string;
  readonly mtimeMs: number;
  readonly prompt: string;
}

/** Every top-level transcript, newest first. Subagent files live one level down and are merged by the exporter. */
function transcriptsNewestFirst(): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  let projects: string[];
  try {
    projects = readdirSync(PROJECTS);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(PROJECTS, project);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        out.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readText(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A transcript worked in the repository when one of its records ran with the
 * repository (or a directory inside it) as cwd and it made at least one tool
 * call. The cwd is per record, so a session started elsewhere that moved into
 * the repository counts too.
 */
function workedIn(text: string, repo: string): boolean {
  const cwd = JSON.stringify(repo).slice(0, -1);
  return (text.includes(`"cwd":${cwd}"`) || text.includes(`"cwd":${cwd}/`)) && text.includes('"type":"tool_use"');
}

/** The first real user prompt, for a human-readable list. */
function firstPrompt(text: string): string {
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const record = JSON.parse(line) as { message?: { content?: unknown }; isMeta?: boolean };
      if (record.isMeta) continue;
      const content = record.message?.content;
      const words = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b: { type?: string }) => b.type === 'text').map((b: { text?: string }) => b.text ?? '').join(' ')
          : '';
      const flat = words.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (flat !== '') return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat;
    } catch {
      // a partial last line while the session is still writing
    }
  }
  return '(no prompt)';
}

function findSessions(repo: string, want: number): Found[] {
  const found: Found[] = [];
  const all = transcriptsNewestFirst();
  for (const t of all.slice(0, SCAN_LIMIT)) {
    let text: string;
    try {
      text = readText(t.path);
    } catch {
      continue;
    }
    if (!workedIn(text, repo)) continue;
    found.push({ transcript: t.path, mtimeMs: t.mtimeMs, prompt: firstPrompt(text) });
    if (found.length >= want) break;
  }
  return found;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ------------------------------------------------------------------ steps

const t0 = performance.now();
function step(label: string, detail = ''): void {
  const at = ((performance.now() - t0) / 1000).toFixed(1).padStart(5);
  console.log(`  ${at}s  ${label.padEnd(10)} ${detail}`);
}

function ensureIndexer(): void {
  if (existsSync(INDEX_BINARY)) return;
  step('indexer', 'building wake-index once (cargo build --release), this takes a minute');
  const r = spawnSync('cargo', ['build', '--release', '-p', 'wake-index'], { cwd: WAKE_ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('cargo build failed');
}

/** Newest mtime under a directory, for a cheap "is the build stale" check. */
function newest(dir: string): number {
  let best = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.mtimeMs > best) best = st.mtimeMs;
    }
  };
  walk(dir);
  return best;
}

function ensureAppBuilt(): void {
  const index = join(APP_DIR, 'dist', 'index.html');
  const built = existsSync(index) ? statSync(index).mtimeMs : 0;
  const source = Math.max(newest(join(APP_DIR, 'src')), newest(join(WAKE_ROOT, 'packages', 'map', 'src')));
  if (built >= source) return;
  step('app', 'building the app (vite build)');
  const r = spawnSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: APP_DIR, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('vite build failed');
}

function exportName(repo: string): string {
  return `${basename(repo).replace(/[^A-Za-z0-9._-]/g, '-')}-replay`;
}

function runExport(repo: string, transcript: string, name: string): void {
  const out = join(EXPORTS_DIR, `${name}.json`);
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types', '--experimental-sqlite', '--no-warnings=ExperimentalWarning',
      join(WAKE_ROOT, 'packages', 'export', 'src', 'main.ts'),
      '--repo', repo, '--session', transcript, '--out', out, '--worktree',
    ],
    { encoding: 'utf8' },
  );
  const lines = r.stdout.split('\n');
  const pick = (key: string): string => (lines.find((l) => l.startsWith(key)) ?? '').slice(16).trim();
  if (r.status !== 0 && !existsSync(out)) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error('export failed');
  }
  step('map', pick('tree'));
  step('symbols', pick('symbols'));
  const events = (lines.find((l) => l.trim().startsWith('events')) ?? '').trim().slice(14);
  const duration = (lines.find((l) => l.trim().startsWith('duration')) ?? '').trim().slice(14).split(' (')[0];
  step('session', `${events}, ${duration}`);
}

/** Bun runs the daemon (Bun.serve, Bun.spawn). On the PATH, or where its installer puts it. */
function findBun(): string {
  const which = spawnSync('which', ['bun'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim() !== '') return which.stdout.trim();
  const local = join(homedir(), '.bun', 'bin', 'bun');
  if (existsSync(local)) return local;
  throw new Error('--live needs Bun >= 1.4 (https://bun.sh), the daemon runs on it');
}

/**
 * The daemon in transcript mode, on the first free port from 7777. Resolves
 * with its base URL once /health answers. It dies with this process.
 */
async function startDaemon(repo: string, transcript: string): Promise<string> {
  const bun = findBun();
  const port = await freePort(Number(process.env['WAKE_DAEMON_PORT'] ?? 7777));
  const child = spawn(
    bun,
    ['run', join(WAKE_ROOT, 'apps', 'wake-daemon', 'src', 'main.ts'), 'serve', '--repo', repo, '--port', String(port), '--transcript', transcript],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
  const stop = (): void => { child.kill('SIGTERM'); };
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop(); process.exit(0); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`daemon exited:\n${output}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return base;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not come up in 30 s:\n${output}`);
}

async function freePort(from: number): Promise<number> {
  const { createServer } = await import('node:net');
  for (let port = from; port < from + 50; port++) {
    const ok = await new Promise<boolean>((done) => {
      const srv = createServer();
      srv.once('error', () => done(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => done(true)));
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${from}..${from + 49}`);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n  wake  ${args.repo}\n`);

  if (args.stop) {
    console.log(stopRunning(args.repo) ? '  stopped\n' : '  nothing running\n');
    return;
  }

  if (args.list) {
    const sessions = findSessions(args.repo, 10);
    if (sessions.length === 0) console.log('  no Claude Code sessions have worked in this repository yet');
    for (const s of sessions) console.log(`  ${ago(s.mtimeMs).padStart(8)}  ${s.prompt}\n            ${s.transcript}`);
    return;
  }

  let transcript = args.session;
  if (transcript === null) {
    const latest = findSessions(args.repo, 1)[0];
    if (latest === undefined) {
      console.log('  No Claude Code session has worked in this repository yet.');
      console.log('  Run `claude` here, do something, then run `wake` again.\n');
      process.exit(1);
    }
    transcript = latest.transcript;
    step('session', `${ago(latest.mtimeMs)}  "${latest.prompt}"`);
  } else if (!existsSync(transcript)) {
    throw new Error(`no such transcript: ${transcript}`);
  }

  if (args.live) {
    excludeWakeDir(args.repo);
    const running = readRunning(args.repo);
    if (running !== null && running.transcript === transcript) {
      // Already watching this session: show it again, start nothing.
      step('running', running.url);
      if (args.open) openBrowser(running.url);
      console.log('');
      return;
    }
    if (running !== null) {
      step('replacing', `the instance watching ${basename(running.transcript, '.jsonl')}`);
      stopRunning(args.repo);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (args.detach) {
      await detachSelf(args.repo);
      return;
    }
  }

  ensureIndexer();
  let query: string;
  if (args.live) {
    const daemon = await startDaemon(args.repo, transcript);
    const health = await (await fetch(`${daemon}/health`)).json() as { sessionId: string | null };
    step('daemon', `${daemon}, tailing ${health.sessionId ?? 'the transcript'}`);
    query = `?daemon=${encodeURIComponent(daemon)}`;
  } else {
    const name = exportName(args.repo);
    runExport(args.repo, transcript, name);
    query = `?data=${encodeURIComponent(name)}&autopilot=1`;
  }
  ensureAppBuilt();

  const { preview } = await import(join(WAKE_ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  const server = await preview({
    root: APP_DIR,
    configFile: join(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
    preview: { port: args.port, strictPort: false, host: '127.0.0.1', open: false },
  });
  const address = server.httpServer.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/${query}`;
  step('ready', url);
  console.log('\n  Ctrl+C to stop.\n');
  if (args.live) {
    const running: Running = { pid: process.pid, transcript, url };
    writeFileSync(stateFile(args.repo), JSON.stringify(running));
    process.on('exit', () => {
      if (readRunning(args.repo)?.pid === process.pid) rmSync(stateFile(args.repo), { force: true });
    });
  }
  if (args.open) openBrowser(url);
}

main().catch((err: unknown) => {
  console.error(`wake: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

