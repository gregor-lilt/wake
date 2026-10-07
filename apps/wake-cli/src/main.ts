// wake: the front door. Run it in any repository you have used Claude Code in
// and the most recent session that worked there plays back on the map.
//
//   wake                       the repository around the current directory
//   wake --repo <path>         another repository
//   wake --session <file>      a specific transcript instead of the latest
//   wake --list                the recent sessions that worked in the repo
//   wake --port 5300 --no-open
//
// No hooks, no config, no daemon. It reads transcripts Claude Code already
// wrote, exports the repository and that session (packages/export, worktree
// mode), and serves the app in replay mode on loopback.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
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
}

function usage(): never {
  console.error('usage: wake [--repo <path>] [--session <transcript.jsonl>] [--list] [--port 5300] [--no-open]');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let repo: string | null = null;
  let session: string | null = null;
  let port = Number(process.env['WAKE_PORT'] ?? 5300);
  let open = true;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--repo' && next !== undefined) {
      repo = next;
      i++;
    } else if (arg === '--session' && next !== undefined) {
      session = resolve(next);
      i++;
    } else if (arg === '--port' && next !== undefined) {
      port = Number(next);
      i++;
    } else if (arg === '--no-open') {
      open = false;
    } else if (arg === '--list') {
      list = true;
    } else {
      usage();
    }
  }
  return { repo: gitRoot(resolve(repo ?? process.cwd())), session, port, open, list };
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

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n  wake  ${args.repo}\n`);

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

  ensureIndexer();
  const name = exportName(args.repo);
  runExport(args.repo, transcript, name);
  ensureAppBuilt();

  const { preview } = await import(join(WAKE_ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  const server = await preview({
    root: APP_DIR,
    configFile: join(APP_DIR, 'vite.config.ts'),
    logLevel: 'error',
    preview: { port: args.port, strictPort: false, host: '127.0.0.1', open: false },
  });
  const address = server.httpServer.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/?data=${encodeURIComponent(name)}&autopilot=1`;
  step('ready', url);
  console.log('\n  Ctrl+C to stop.\n');
  if (args.open) openBrowser(url);
}

main().catch((err: unknown) => {
  console.error(`wake: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

