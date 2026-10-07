// wake-daemon: the live side of Wake (docs/protocol.md).
//
//   wake-daemon serve --repo <path> [--port 7777] [--fence <glob>]... [--transcript <file>]
//   wake-daemon init  --repo <path> [--port 7777]
//
// Runs on Bun (Bun.serve, Bun.spawn). Falls back to Node >= 23.6 with the
// `ws` package for development (see package.json "serve:node").
//
// The repository path only ever comes from the command line. There is no
// default and nothing about any repository is baked into this app.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { HookHandler, type HookPayload } from './hooks.ts';
import { defaultDbPath, ensureIndexerBuilt, indexOnce, startWatch } from './indexer.ts';
import { initRepo } from './init.ts';
import { LiveMap } from './mapdoc.ts';
import { PROTOCOL_VERSION, type ClientMessage, type LoggedMessage, type ServerMessage } from './protocol.ts';
import { startServer, type WsClient } from './server.ts';
import { SessionManager } from './session.ts';

interface Args {
  readonly command: 'serve' | 'init';
  readonly repo: string;
  readonly port: number;
  readonly host: string;
  readonly fences: string[];
  readonly permissionTimeoutS: number;
  /** Transcript mode: tail this Claude Code transcript instead of waiting for hooks. */
  readonly transcript: string | null;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== 'serve' && command !== 'init') {
    throw new Error('usage: wake-daemon <serve|init> --repo <path> [--port 7777] [--fence <glob>]...');
  }
  let repo = '';
  let port = Number(process.env['WAKE_PORT'] ?? 7777);
  const fences: string[] = [];
  let permissionTimeoutS = Number(process.env['WAKE_PERMISSION_TIMEOUT'] ?? 600);
  let transcript: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--repo' && next !== undefined) {
      repo = next;
      i++;
    } else if (arg === '--port' && next !== undefined) {
      port = Number(next);
      i++;
    } else if (arg === '--fence' && next !== undefined) {
      fences.push(next);
      i++;
    } else if (arg === '--transcript' && next !== undefined) {
      transcript = resolve(next);
      i++;
    } else if (arg === '--permission-timeout' && next !== undefined) {
      permissionTimeoutS = Number(next);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (repo === '') throw new Error('--repo <path> is required; there is deliberately no default');
  const abs = resolve(repo);
  if (!existsSync(abs)) throw new Error(`repository not found: ${abs}`);
  if (transcript !== null && !existsSync(transcript)) throw new Error(`transcript not found: ${transcript}`);
  return { command, repo: abs, port, host: '127.0.0.1', fences, permissionTimeoutS, transcript };
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function text(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { ...JSON_HEADERS, 'content-type': contentType } });
}

async function serve(args: Args): Promise<void> {
  const say = (line: string): void => console.log(`${new Date().toISOString().slice(11, 23)}  ${line}`);
  const name = basename(args.repo);
  say(`repo             ${args.repo}`);

  await ensureIndexerBuilt();
  const indexOut = await indexOnce(args.repo);
  for (const line of indexOut.split('\n')) if (line.trim() !== '') say(`  | ${line}`);

  // .wake/ must be excluded before the tree is read, or the event log would
  // show up as untracked files on the map. `wake-daemon init` writes the rule.
  const excluded = spawnSync('git', ['-C', args.repo, 'check-ignore', '-q', '.wake/x'], { encoding: 'utf8' }).status === 0;
  if (!excluded) say(`WARNING          .wake/ is not git-ignored in this repository, run \`wake-daemon init --repo ${args.repo}\` first`);

  const dbPath = defaultDbPath(args.repo);
  const map = await LiveMap.create(args.repo, name, dbPath);

  // Clients and broadcasting. Every frame is JSON, one per WebSocket message.
  const clients = new Set<WsClient>();
  const broadcast = (message: ServerMessage): void => {
    const frame = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.send(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const sessions = new SessionManager({ repo: args.repo, fileIds: map.fileIds, dirPaths: map.dirPaths, broadcast, log: say });
  const hooks = new HookHandler({
    sessions,
    repo: args.repo,
    broadcast,
    fences: args.fences,
    permissionTimeoutS: args.permissionTimeoutS,
    log: say,
    afterHook: () => tail(),
  });

  // Transcript mode: no hooks, the transcript is the whole event source. The
  // session is running while the file grows and idle after a quiet spell.
  const QUIET_MS = 30_000;
  let lastGrowth = Date.now();
  if (args.transcript !== null) {
    const store = sessions.get(sessionIdOf(args.transcript), args.transcript);
    store.tailAll = true;
    say(`transcript mode  ${args.transcript}`);
  }

  // Transcript tail: on every hook and every 500 ms.
  const tail = (): void => {
    const primary = sessions.primary;
    if (primary === null) return;
    const fresh = primary.tailTranscript();
    for (const event of fresh) say(`transcript       ${event.title}${event.text ? `: ${clipLog(event.text)}` : ''}`);
    if (args.transcript === null) return;
    if (fresh.length > 0) {
      lastGrowth = Date.now();
      primary.setState('running');
    } else if (Date.now() - lastGrowth > QUIET_MS) {
      primary.setState('idle');
    }
  };
  const tailTimer = setInterval(tail, 500);
  tailTimer.unref?.();

  // Map deltas go to every client and into the primary session's log.
  const sendDelta = (message: LoggedMessage): void => {
    const primary = sessions.primary;
    if (primary !== null) primary.send(message);
    else broadcast(message);
  };

  // Indexer watch: every debounce batch updates the map and the edges.
  const watcher = await startWatch(args.repo, (batch) => {
    const paths = [...batch.changed, ...batch.deleted];
    const change = map.applyFileChanges(paths);
    // store.send broadcasts and appends to the session log in one step.
    for (const message of change.messages) {
      if (message.type === 'node' || message.type === 'invalidate') sendDelta(message);
    }
    let edgesLine = '';
    try {
      const delta = map.readIndexNow();
      if (delta.added.length > 0 || delta.removed.length > 0) {
        sendDelta({ type: 'edges', added: delta.added, removed: delta.removed });
        edgesLine = `, edges +${delta.added.length} -${delta.removed.length}`;
      }
    } catch (err) {
      edgesLine = `, reindex read failed: ${String(err)}`;
    }
    const counts = { node: 0, invalidate: 0 };
    for (const m of change.messages) if (m.type === 'node' || m.type === 'invalidate') counts[m.type]++;
    say(`watch            ${paths.length} path(s): ${counts.invalidate} invalidate, ${counts.node} node${change.relayouted ? ' (relayout)' : ''}${edgesLine}`);
  });

  const index = map.readIndexNow();
  say(`index            ${index.symbols} symbol nodes, ${index.added.length} import edges from ${dbPath}`);

  // The session's baseline: the commit HEAD pointed at when the session
  // started, from the reflog. Diffs and /changes are against it, so the map
  // shows everything this session changed, committed or not.
  let baseKey = '';
  let baseSha = 'HEAD';
  const sessionBase = (): string => {
    const startedAt = sessions.primary?.exportSession().startedAt ?? '';
    const key = startedAt === '' ? 'none' : startedAt;
    if (key !== baseKey) {
      baseKey = key;
      baseSha = headAt(args.repo, startedAt === '' ? Date.now() : Date.parse(startedAt));
      say(`baseline         ${baseSha.slice(0, 10)} (HEAD at ${startedAt || 'now'})`);
    }
    return baseSha;
  };

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (req.method === 'GET' && path === '/health') {
      return json({ ok: true, repo: args.repo, sessionId: sessions.primary?.sessionId ?? null, indexed: map.indexed });
    }
    if (req.method === 'GET' && path === '/map') {
      const now = new Date().toISOString();
      const session = sessions.primary?.exportSession() ?? { sessionId: '', transcriptPath: '', startedAt: now, endedAt: now, events: [] };
      return json(map.document(session));
    }
    if (req.method === 'GET' && (path === '/file' || path === '/diff')) {
      const rel = url.searchParams.get('path') ?? '';
      const abs = map.resolveFile(rel);
      if (abs === null) return json({ error: 'unknown path' }, 404);
      if (path === '/file') {
        try {
          return text(await readFile(abs, 'utf8'));
        } catch {
          return json({ error: 'unreadable' }, 404);
        }
      }
      // Against the session's baseline, not HEAD: an agent that commits as it
      // goes would otherwise erase its own work from the map.
      const base = sessionBase();
      const inBase = spawnSync('git', ['-C', args.repo, 'cat-file', '-e', `${base}:${rel}`]).status === 0;
      const diff = inBase
        ? gitDiff(args.repo, ['diff', base, '--', rel])
        : gitDiff(args.repo, ['diff', '--no-index', '--', '/dev/null', rel]);
      return text(diff, 200, 'text/x-diff; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/changes') {
      const base = sessionBase();
      return json({ base, files: changedFiles(args.repo, base, map.fileIds) });
    }
    if (req.method === 'POST' && path === '/hook') {
      let payload: HookPayload;
      try {
        payload = (await req.json()) as HookPayload;
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      try {
        return json(await hooks.handle(payload));
      } catch (err) {
        say(`hook             ERROR ${String(err)}`);
        return json({});
      }
    }
    return json({ error: 'not found' }, 404);
  };

  const server = await startServer(args.host, args.port, {
    fetch,
    wsPath: '/live',
    ws: {
      open(client) {
        clients.add(client);
        const hello: ServerMessage = {
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          repo: { name, path: args.repo, commit: map.commit, generatedAt: new Date().toISOString() },
          sessionId: sessions.primary?.sessionId ?? null,
        };
        client.send(JSON.stringify(hello));
        const snapshot: ServerMessage = { type: 'snapshot', events: [...(sessions.primary?.events ?? [])] };
        client.send(JSON.stringify(snapshot));
      },
      message(client, raw) {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw) as ClientMessage;
        } catch {
          return;
        }
        if (message.type === 'ping') {
          client.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
        } else if (message.type === 'decision') {
          const ok = hooks.decide(message.requestId, {
            behavior: message.behavior,
            ...(message.updatedInput === undefined ? {} : { updatedInput: message.updatedInput }),
            ...(message.message === undefined ? {} : { message: message.message }),
          });
          if (!ok) say(`decision         ${message.requestId} unknown or already answered`);
        }
      },
      close(client) {
        clients.delete(client);
      },
    },
  });

  say(`listening        http://${args.host}:${server.port} (${server.runtime}), ws://${args.host}:${server.port}/live`);
  say(`hook endpoint    POST http://${args.host}:${server.port}/hook`);
  say(`fences           ${args.fences.length === 0 ? '(none)' : JSON.stringify(args.fences)}`);

  const shutdown = (): void => {
    say('shutting down');
    hooks.releaseAll();
    clearInterval(tailTimer);
    watcher.kill();
    map.close();
    void server.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** The session id a transcript records, or its file name when it records none yet. */
function sessionIdOf(transcript: string): string {
  try {
    const head = readFileSync(transcript, 'utf8').slice(0, 65536);
    const m = /"sessionId":"([^"]+)"/.exec(head);
    if (m) return m[1]!;
  } catch {
    // fall through to the file name
  }
  return basename(transcript, '.jsonl');
}

/**
 * The commit HEAD pointed at, at a moment: the newest reflog entry at or
 * before it. Without reflog history that old, the oldest entry's commit;
 * without a reflog at all, HEAD.
 */
function headAt(repo: string, ms: number): string {
  const res = spawnSync('git', ['-C', repo, 'reflog', 'show', '--date=unix', '--format=%H %gd', 'HEAD'], { encoding: 'utf8' });
  let oldest = '';
  for (const line of (res.stdout ?? '').split('\n')) {
    const m = /^([0-9a-f]{40}) HEAD@\{(\d+)\}$/.exec(line.trim());
    if (!m) continue;
    oldest = m[1]!;
    if (Number(m[2]) * 1000 <= ms) return m[1]!;
  }
  if (oldest !== '') return oldest;
  return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'HEAD';
}

interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** new since the baseline, committed or not */
  readonly created: boolean;
}

/**
 * Every file on the map that differs from the baseline: tracked changes
 * (committed or not) from `git diff --numstat`, plus untracked files, which
 * count as wholly added. Binary files report 0/0.
 */
function changedFiles(repo: string, base: string, fileIds: ReadonlyMap<string, number>): ChangedFile[] {
  const out = new Map<string, ChangedFile>();
  const numstat = spawnSync('git', ['-C', repo, 'diff', '--numstat', '--no-renames', base], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const createdRes = spawnSync('git', ['-C', repo, 'diff', '--name-only', '--diff-filter=A', '--no-renames', base], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const created = new Set((createdRes.stdout ?? '').split('\n').filter((l) => l !== ''));
  for (const line of (numstat.stdout ?? '').split('\n')) {
    const [a, r, path] = line.split('\t');
    if (path === undefined || !fileIds.has(path)) continue;
    out.set(path, { path, added: Number(a) || 0, removed: Number(r) || 0, created: created.has(path) });
  }
  const untracked = spawnSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  for (const path of (untracked.stdout ?? '').split('\n')) {
    if (path === '' || out.has(path) || !fileIds.has(path)) continue;
    let lines = 0;
    try {
      const body = readFileSync(join(repo, path), 'utf8');
      lines = body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
    } catch {
      // unreadable: counts as changed with no lines
    }
    out.set(path, { path, added: lines, removed: 0, created: true });
  }
  return [...out.values()].sort((x, y) => x.path.localeCompare(y.path));
}

/** `git diff` exits 1 when there are differences, so the exit code is not an error here. */
function clipLog(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ');
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function gitDiff(repo: string, argv: string[]): string {
  const res = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8' });
  return res.stdout ?? '';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'init') {
    await initRepo(args.repo, args.port);
    return;
  }
  await serve(args);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
