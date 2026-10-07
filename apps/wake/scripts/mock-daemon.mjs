/**
 * A stand-in for apps/wake-daemon, for development and for the checks in
 * verify.mjs. It speaks the same four endpoints docs/protocol.md defines and
 * nothing else: no hooks, no indexer, no event log.
 *
 * It serves a static export from the gitignored exports directory, reads /file
 * and /diff out of the repository that export names in `repo.path`, and on
 * /live sends hello, an empty snapshot, then replays the export's own session
 * events as `event` frames at a fixed cadence before saying the session ended.
 *
 *   node scripts/mock-daemon.mjs --export <name> [--port 7777] [--cadence 1500]
 *                                 [--script new-file] [--script-at 3]
 *
 * `--script new-file` plays the one thing a recording cannot: mid-replay the
 * agent CREATES a file. The daemon picks a district with room in it, invents a
 * file inside it, and sends the `node`, `event` and `invalidate` frames a real
 * daemon would (docs/protocol.md), serving the invented text from memory. The
 * district, the parent path and the free slot are all derived from the export
 * at run time, so nothing of the exported repository is written down here.
 *
 * The export name is a real repository's, so it is passed in and never written
 * down here. Node, because the app's own toolchain is Node and this has no
 * reason to need anything else.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS = path.resolve(HERE, '../../../.wake/exports');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const NAME = arg('export', process.env.WAKE_EXPORT ?? '');
const PORT = Number(arg('port', process.env.WAKE_PORT ?? 7777));
const CADENCE = Number(arg('cadence', process.env.WAKE_CADENCE ?? 1500));
/** Hold the session open after the last event instead of ending it. */
const HOLD = process.argv.includes('--hold');
/** Scripted deltas the recording does not contain. Only 'new-file' so far. */
const SCRIPT = arg('script', process.env.WAKE_SCRIPT ?? '');
/** Events to replay before the script fires. */
const SCRIPT_AT = Number(arg('script-at', process.env.WAKE_SCRIPT_AT ?? 3));

if (!NAME || !/^[A-Za-z0-9._-]+$/.test(NAME)) {
  console.error('usage: node scripts/mock-daemon.mjs --export <name> [--port 7777] [--cadence 1500]');
  process.exit(2);
}

const docPath = path.join(EXPORTS, `${NAME}.json`);
const doc = JSON.parse(readFileSync(docPath, 'utf8'));
const repoRoot = realpathSync(doc.repo.path);
const files = new Set();
for (const n of doc.nodes) if (n.kind === 'file' && n.path) files.add(n.path);
const sessionId = doc.session.sessionId ?? null;

// ---- the scripted new file -------------------------------------------------
/**
 * A file the agent creates during the session: the case every real session has
 * and no export can hold. Its tile goes into a free slot at the bottom of a
 * column of an existing district, on the lattice (5 cells wide, 4 cells per
 * 40-line step), so it lands inside that district's rect and overlaps nothing.
 */
const CELL_TILE_W = 5;
const NEW_LINES = 24;
const NEW_CELLS_H = 4 * Math.max(1, Math.ceil(NEW_LINES / 40));
/** Invented text, served from memory: exactly NEW_LINES lines, none over 100 columns. */
const syntheticText = () => {
  const lines = [
    '/** Created by the agent during the session. */',
    "import { describe, expect, it } from 'vitest';",
    ''
  ];
  while (lines.length < NEW_LINES - 1) {
    const i = lines.length;
    lines.push(`it('case ${i}', () => {`, `  expect(${i} % 7).toBe(${i % 7});`, '});', '');
  }
  return lines.slice(0, NEW_LINES).join('\n') + '\n';
};

function planNewFile() {
  const rectOf = new Map();
  for (const r of doc.rects) rectOf.set(r[0], r);
  const hasSubDir = new Set();
  for (const n of doc.nodes) if (n.kind === 'dir' && n.parent !== null) hasSubDir.add(n.parent);
  const kids = new Map();
  for (const n of doc.nodes) {
    if (n.kind !== 'file' || n.parent === null) continue;
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent).push(n);
  }
  const dirNodes = doc.nodes.filter((n) => n.kind === 'dir');
  // A leaf district, the fullest one: its rect is its own files' box, so the
  // room made below it lands on nothing else, and its columns are long enough
  // that the new tile is easy to aim a camera at.
  const cand = dirNodes
    .filter((d) => rectOf.has(d.id) && !hasSubDir.has(d.id) && (kids.get(d.id) ?? []).length >= 2)
    .sort((a, b) => (kids.get(b.id).length - kids.get(a.id).length) || (a.id - b.id))[0];
  if (!cand) return null;
  const dr = rectOf.get(cand.id);
  const columns = new Map();
  for (const f of kids.get(cand.id)) {
    const r = rectOf.get(f.id);
    if (!r) continue;
    columns.set(r[1], Math.min(columns.get(r[1]) ?? Infinity, r[2]));
  }
  // The leftmost column, one gap under its lowest tile. A packed district has
  // no slack, which is why the district grows with it: a real daemon re-runs
  // the layout and sends the district's new rect in the same burst
  // (docs/protocol.md, "a directory whose region grew").
  const [x, bottom] = [...columns].sort((a, b) => a[0] - b[0])[0];
  const y = bottom - 1 - NEW_CELLS_H;
  const dirY = Math.min(dr[2], y);
  return {
    dirNodeId: cand.id,
    dirIndex: dirNodes.indexOf(cand),
    dirRect: [cand.id, dr[1], dirY, dr[3], dr[2] + dr[4] - dirY],
    nodeId: Math.max(...doc.nodes.map((n) => n.id)) + 1,
    name: 'wake_live_probe.test.ts',
    path: (cand.path ? cand.path + '/' : '') + 'wake_live_probe.test.ts',
    lines: NEW_LINES,
    rect: [0, x, y, CELL_TILE_W, NEW_CELLS_H]
  };
}

const plan = SCRIPT === 'new-file' ? planNewFile() : null;
if (SCRIPT && !plan) {
  console.error(`no district in ${NAME} has room for the scripted file; --script ignored`);
}
/** Paths this process invented, served from memory rather than from the repo. */
const synthetic = new Map();
let scriptFired = false;

/** Resolve a repo-relative path, refusing anything the export does not list. */
function resolveInRepo(rel) {
  if (!files.has(rel)) return null;
  const abs = path.resolve(repoRoot, rel);
  if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) return null;
  try {
    if (!statSync(abs).isFile() || realpathSync(abs) !== abs) return null;
    return abs;
  } catch {
    return null;
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 32 << 20, timeout: 15000 }).toString();
  } catch {
    return '';
  }
}

/**
 * The replay is the session, not the connection: one clock for the process, so
 * a client that drops and comes back gets a snapshot of what it missed and the
 * stream continues where it was, exactly as a real daemon behaves.
 */
const emitted = [];
let state = 'idle';
let cursor = 0;
/** Monotonic id over everything sent, the scripted event included. */
let seq = 0;
let timer = null;
const sockets = new Set();

const send = (res, status, type, payload) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // The app is served from a different origin in development.
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    send(res, 200, 'application/json',
      JSON.stringify({ ok: true, repo: doc.repo.name, sessionId, indexed: true }));
    return;
  }
  if (url.pathname === '/map') {
    // "The session part holds the events observed so far in the current
    // session" (docs/protocol.md), which here is whatever the replay has
    // emitted, not the whole recording it is playing from.
    const payload = { ...doc, session: { ...doc.session, events: emitted } };
    send(res, 200, 'application/json', JSON.stringify(payload));
    return;
  }
  if (url.pathname === '/changes') {
    // Three files of the document, in path order, as the daemon reports
    // files that differ from the session baseline.
    const picked = [...files].sort().slice(0, 3);
    const list = picked.map((path, i) => ({ path, added: 10 * (i + 1), removed: i, created: i === 0 }));
    send(res, 200, 'application/json', JSON.stringify({ base: 'mock', files: list }));
    return;
  }
  if (url.pathname === '/script') {
    send(res, 200, 'application/json', JSON.stringify({ script: SCRIPT || null, at: SCRIPT_AT, plan, fired: scriptFired }));
    return;
  }
  if (url.pathname === '/file' || url.pathname === '/diff') {
    const rel = url.searchParams.get('path') ?? '';
    if (synthetic.has(rel)) {
      send(res, 200, 'text/plain; charset=utf-8', url.pathname === '/file' ? synthetic.get(rel) : '');
      return;
    }
    const abs = resolveInRepo(rel);
    if (!abs) {
      send(res, 403, 'text/plain; charset=utf-8', 'not a file of this repository');
      return;
    }
    if (url.pathname === '/file') {
      send(res, 200, 'text/plain; charset=utf-8', readFileSync(abs, 'utf8'));
      return;
    }
    const inRepo = path.relative(repoRoot, abs);
    const un = git(['diff', '--no-color', '-U3', '--', inRepo]);
    const st = git(['diff', '--no-color', '-U3', '--cached', '--', inRepo]);
    send(res, 200, 'text/plain; charset=utf-8', un + (un && st ? '\n' : '') + st);
    return;
  }
  if (url.pathname === '/hook') {
    send(res, 200, 'application/json', '{}');
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'no such endpoint');
});

// ---- the /live socket ------------------------------------------------------
// A minimal RFC 6455 server. The real daemon uses Bun's, but pulling a
// dependency into a test double is worse than forty lines of framing.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  if (!(req.url ?? '').startsWith('/live')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  play(socket);
});

/** One text frame, unmasked, as a server must send it. */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function broadcast(obj) {
  const buf = frame(JSON.stringify(obj));
  for (const s of sockets) {
    try { s.write(buf); } catch { sockets.delete(s); }
  }
}

/**
 * The scripted creation, as three frames in the order a daemon sends them: the
 * node first, so the map has somewhere to put the edit, then the edit, then the
 * invalidate that tells the client to read the file it now knows about.
 */
function fireScript() {
  scriptFired = true;
  const node = {
    id: plan.nodeId,
    kind: 'file',
    name: plan.name,
    path: plan.path,
    parent: plan.dirNodeId,
    size: plan.lines * 30,
    lang: 'typescript',
    symbolKind: null,
    lineStart: null,
    lineEnd: null,
    effectiveLines: plan.lines,
    folded: false
  };
  const rect = [plan.nodeId, plan.rect[1], plan.rect[2], plan.rect[3], plan.rect[4]];
  // A late client gets the same map: GET /map is the document as it stands now.
  const dirNode = doc.nodes.find((n) => n.id === plan.dirNodeId);
  const dirAt = doc.rects.findIndex((r) => r[0] === plan.dirNodeId);
  if (dirAt >= 0) doc.rects[dirAt] = plan.dirRect;
  doc.nodes.push(node);
  doc.rects.push(rect);
  synthetic.set(plan.path, syntheticText());
  // The district grew to hold it, and says so first.
  broadcast({ type: 'node', node: dirNode, rect: plan.dirRect });
  broadcast({ type: 'node', node, rect });
  const last = emitted.length > 0 ? emitted[emitted.length - 1].t : 0;
  const e = {
    t: last + CADENCE,
    kind: 'write',
    tool: 'Write',
    nodeId: plan.nodeId,
    path: plan.path,
    lineStart: 1,
    lineEnd: plan.lines,
    summary: `Write ${plan.path}`,
    title: `Write ${plan.path}`,
    role: 'assistant',
    id: ++seq,
    wall: new Date().toISOString()
  };
  emitted.push(e);
  broadcast({ type: 'event', event: e });
  broadcast({ type: 'invalidate', nodeId: plan.nodeId, effectiveLines: plan.lines });
}

function startReplay() {
  if (timer) return;
  state = 'running';
  broadcast({ type: 'session', state, sessionId });
  timer = setInterval(() => {
    if (plan && !scriptFired && cursor >= SCRIPT_AT) {
      fireScript();
      return;
    }
    const events = doc.session.events;
    if (cursor >= events.length) {
      clearInterval(timer);
      timer = null;
      if (!HOLD) {
        state = 'ended';
        broadcast({ type: 'session', state, sessionId });
      }
      return;
    }
    const e = { ...events[cursor], id: ++seq, wall: new Date().toISOString() };
    emitted.push(e);
    cursor++;
    broadcast({ type: 'event', event: e });
  }, CADENCE);
}

function play(socket) {
  sockets.add(socket);
  const write = (obj) => {
    try { socket.write(frame(JSON.stringify(obj))); } catch { sockets.delete(socket); }
  };
  // A client frame is masked; nothing here needs its content beyond noticing
  // a close.
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) === 0x8) { sockets.delete(socket); socket.end(); }
  });
  socket.on('error', () => sockets.delete(socket));
  socket.on('close', () => sockets.delete(socket));

  write({ type: 'hello', protocol: 1, repo: doc.repo, sessionId });
  write({ type: 'snapshot', events: emitted });
  write({ type: 'session', state: state === 'idle' ? 'running' : state, sessionId });
  startReplay();
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock daemon on http://127.0.0.1:${PORT} (${files.size} files, ` +
    `${doc.session.events.length} events, ${CADENCE} ms cadence` +
    `${plan ? `, script new-file at event ${SCRIPT_AT}` : ''})`
  );
});
