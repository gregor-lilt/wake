/**
 * Wake spike 4: hook round-trip and approval in place.
 *
 * Single-file HTTP server, node built-ins only. Run with:
 *   node --experimental-strip-types src/server.ts
 *
 * Claude Code http hooks POST to /hook. A browser page on / renders the
 * live event stream, holds PermissionRequest decisions, edits the fence
 * list and arms the PostToolBatch stop gate.
 *
 * Schema source: https://code.claude.com/docs/en/hooks.md (verified 2026-09-02,
 * Claude Code 2.1.258). See README.md for the two places where the docs and
 * docs/research/04-claude-code-integration.md disagree.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- config

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");

const PORT = Number(process.env["WAKE_PORT"] ?? 7777);
const HOST = process.env["WAKE_HOST"] ?? "127.0.0.1";
const EVENTS_FILE = process.env["WAKE_EVENTS_FILE"] ?? resolve(APP_DIR, "events.jsonl");
const FENCES_FILE = process.env["WAKE_FENCES_FILE"] ?? resolve(APP_DIR, "fences.json");
/** Seconds a PermissionRequest is held open waiting for a click. */
const PERMISSION_TIMEOUT_S = Number(process.env["WAKE_PERMISSION_TIMEOUT"] ?? 300);
const DEFAULT_FENCES = ["protected/**"];
const MAX_EVENTS = 500;

// ---------------------------------------------------------------- types

type Json = Record<string, unknown>;

interface HookPayload extends Json {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Json;
  tool_use_id?: string;
  tool_response?: unknown;
  tool_calls?: Json[];
}

interface EventRecord {
  seq: number;
  ts: string;
  hook_event_name: string;
  tool_name: string | null;
  session_id: string | null;
  summary: string;
  has_tool_response: boolean;
  note: string | null;
}

interface Pending {
  id: string;
  ts: string;
  tool_name: string;
  session_id: string | null;
  file_path: string | null;
  old_string: string | null;
  new_string: string | null;
  tool_input: Json;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

type Decision =
  | { action: "allow" }
  | { action: "deny"; message?: string | undefined }
  | { action: "rewrite"; new_string: string };

// ---------------------------------------------------------------- state

let seq = 0;
const events: EventRecord[] = [];
const pending = new Map<string, Pending>();
const sseClients = new Set<ServerResponse>();
let stopAfterBatch = false;
let fences: string[] = loadFences();

function loadFences(): string[] {
  if (existsSync(FENCES_FILE)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(FENCES_FILE, "utf8"));
      if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
    } catch {
      /* fall through to defaults */
    }
  }
  saveFences(DEFAULT_FENCES);
  return [...DEFAULT_FENCES];
}

function saveFences(list: string[]): void {
  writeFileSync(FENCES_FILE, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------- fences

/** Minimal glob: `**` crosses separators, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      const doubled = pattern[i + 1] === "*";
      if (doubled) {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * True when filePath hits a fence. Patterns are matched against the
 * absolute path and against the path relative to the session cwd; a
 * relative pattern also matches at any depth (like gitignore).
 */
export function matchesFence(filePath: string, cwd: string | undefined, patterns: string[]): string | null {
  const abs = filePath.replaceAll("\\", "/");
  const candidates = new Set<string>([abs, abs.replace(/^\/+/, "")]);
  if (cwd) {
    const base = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    if (abs.startsWith(`${base}/`)) candidates.add(abs.slice(base.length + 1));
  }
  for (const pattern of patterns) {
    const p = pattern.trim();
    if (!p) continue;
    const forms = p.startsWith("/") ? [p, p.slice(1)] : [p, `**/${p}`];
    for (const form of forms) {
      const re = globToRegExp(form);
      for (const candidate of candidates) if (re.test(candidate)) return pattern;
    }
  }
  return null;
}

// ---------------------------------------------------------------- logging

function summarizeInput(toolName: string | null, input: Json | undefined): string {
  if (!input) return "";
  const s = (k: string): string | null => (typeof input[k] === "string" ? (input[k] as string) : null);
  const clip = (v: string, n = 100): string => (v.length > n ? `${v.slice(0, n)}…` : v);
  switch (toolName) {
    case "Edit":
    case "Write":
    case "Read":
    case "MultiEdit":
    case "NotebookEdit":
      return s("file_path") ?? clip(JSON.stringify(input));
    case "Bash":
      return clip(s("command") ?? "", 120);
    case "Glob":
    case "Grep":
      return clip(`${s("pattern") ?? ""} ${s("path") ?? ""}`.trim());
    case "Task":
      return clip(s("description") ?? "");
    default:
      return clip(JSON.stringify(input), 120);
  }
}

function record(payload: HookPayload, note: string | null): EventRecord {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : null;
  const batch = Array.isArray(payload.tool_calls) ? payload.tool_calls : null;
  const rec: EventRecord = {
    seq: ++seq,
    ts: new Date().toISOString(),
    hook_event_name: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "(missing)",
    tool_name: toolName ?? (batch ? `${batch.length} call(s)` : null),
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    summary: batch
      ? batch
          .map((c) => `${String(c["tool_name"])}(${summarizeInput(String(c["tool_name"]), c["tool_input"] as Json)})`)
          .join(", ")
      : summarizeInput(toolName, payload.tool_input),
    has_tool_response: payload.tool_response !== undefined,
    note,
  };
  events.push(rec);
  if (events.length > MAX_EVENTS) events.shift();
  const sid = rec.session_id ? rec.session_id.slice(0, 8) : "-";
  console.log(
    `${rec.ts}  ${rec.hook_event_name.padEnd(18)} tool=${(rec.tool_name ?? "-").padEnd(12)} ` +
      `session=${sid} resp=${rec.has_tool_response ? "yes" : "no"} ${rec.summary}` +
      (note ? `  [${note}]` : ""),
  );
  broadcast("event", rec);
  return rec;
}

function persist(payload: HookPayload): void {
  try {
    appendFileSync(EVENTS_FILE, `${JSON.stringify({ wake_received_at: new Date().toISOString(), ...payload })}\n`);
  } catch (err) {
    console.error("could not append to events.jsonl:", err);
  }
}

// ---------------------------------------------------------------- SSE

function broadcast(kind: string, data: unknown): void {
  const frame = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function pendingView(): Json[] {
  return [...pending.values()].map((p) => ({
    id: p.id,
    ts: p.ts,
    tool_name: p.tool_name,
    session_id: p.session_id,
    file_path: p.file_path,
    old_string: p.old_string,
    new_string: p.new_string,
    tool_input: p.tool_input,
  }));
}

function broadcastState(): void {
  broadcast("state", { fences, stopAfterBatch, pending: pendingView() });
}

// ---------------------------------------------------------------- hook handlers

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function handlePreToolUse(payload: HookPayload, res: ServerResponse): void {
  const toolName = payload.tool_name ?? "";
  const filePath = typeof payload.tool_input?.["file_path"] === "string" ? (payload.tool_input["file_path"] as string) : null;
  const writer = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName);
  const hit = writer && filePath ? matchesFence(filePath, payload.cwd, fences) : null;
  if (hit) {
    record(payload, `fence deny (${hit})`);
    sendJson(res, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Wake fence: ${filePath} matches "${hit}". Ask the user to lift the fence in the Wake UI.`,
      },
    });
    return;
  }
  record(payload, null);
  // Pass-through: no opinion, normal permission flow continues.
  sendJson(res, {});
}

function handlePostToolBatch(payload: HookPayload, res: ServerResponse): void {
  if (stopAfterBatch) {
    stopAfterBatch = false;
    record(payload, "batch gate: continue=false");
    broadcastState();
    // continue/stopReason at the top level per SyncHookJSONOutput, mirrored
    // inside hookSpecificOutput because hooks.md documents it there too.
    sendJson(res, {
      continue: false,
      stopReason: "Stopped from Wake",
      systemMessage: "Wake stopped the agentic loop after this batch.",
      hookSpecificOutput: { hookEventName: "PostToolBatch", continue: false, stopReason: "Stopped from Wake" },
    });
    return;
  }
  record(payload, null);
  sendJson(res, {});
}

function handlePermissionRequest(payload: HookPayload, res: ServerResponse): void {
  const rec = record(payload, `held for decision (timeout ${PERMISSION_TIMEOUT_S}s)`);
  const id = `perm-${rec.seq}`;
  const input = (payload.tool_input ?? {}) as Json;
  const str = (k: string): string | null => (typeof input[k] === "string" ? (input[k] as string) : null);
  const timer = setTimeout(() => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    console.log(`${new Date().toISOString()}  PermissionRequest ${id} timed out, falling back to the terminal prompt`);
    broadcastState();
    // Empty object = no decision from Wake. The normal terminal prompt stands.
    sendJson(entry.res, {});
  }, PERMISSION_TIMEOUT_S * 1000);
  timer.unref?.();
  pending.set(id, {
    id,
    ts: rec.ts,
    tool_name: payload.tool_name ?? "(unknown)",
    session_id: rec.session_id,
    file_path: str("file_path"),
    old_string: str("old_string"),
    new_string: str("new_string"),
    tool_input: input,
    res,
    timer,
  });
  broadcastState();
}

function resolvePending(id: string, decision: Decision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  let body: Json;
  if (decision.action === "deny") {
    body = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: decision.message ?? "Rejected in Wake.", interrupt: false },
      },
    };
  } else if (decision.action === "rewrite") {
    body = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          message: "Approved in Wake with a rewritten edit.",
          updatedInput: { ...entry.tool_input, new_string: decision.new_string },
        },
      },
    };
  } else {
    body = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", message: "Approved in Wake." },
      },
    };
  }
  console.log(`${new Date().toISOString()}  decision ${decision.action} for ${id} (${entry.file_path ?? "-"})`);
  sendJson(entry.res, body);
  broadcastState();
  return true;
}

// ---------------------------------------------------------------- HTTP

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    const html = PAGE;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (method === "GET" && path === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    for (const rec of events.slice(-100)) res.write(`event: event\ndata: ${JSON.stringify(rec)}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify({ fences, stopAfterBatch, pending: pendingView() })}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (method === "GET" && path === "/api/state") {
    sendJson(res, { fences, stopAfterBatch, pending: pendingView(), events: events.slice(-100) });
    return;
  }

  if (method === "POST" && path === "/hook") {
    void readBody(req).then((raw) => {
      let payload: HookPayload;
      try {
        payload = JSON.parse(raw || "{}") as HookPayload;
      } catch {
        console.error("unparsable hook body:", raw.slice(0, 200));
        sendJson(res, { error: "invalid json" }, 400);
        return;
      }
      persist(payload);
      switch (payload.hook_event_name) {
        case "PreToolUse":
          handlePreToolUse(payload, res);
          return;
        case "PermissionRequest":
          handlePermissionRequest(payload, res);
          return;
        case "PostToolBatch":
          handlePostToolBatch(payload, res);
          return;
        default:
          // PostToolUse, PostToolUseFailure, SessionStart, Stop, everything else.
          record(payload, null);
          sendJson(res, {});
          return;
      }
    });
    return;
  }

  if (method === "POST" && path === "/api/decision") {
    void readBody(req).then((raw) => {
      let body: { id?: string; action?: string; new_string?: string; message?: string };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, { error: "invalid json" }, 400);
        return;
      }
      const id = body.id ?? "";
      let decision: Decision;
      if (body.action === "deny") decision = { action: "deny", message: body.message };
      else if (body.action === "rewrite") decision = { action: "rewrite", new_string: body.new_string ?? "" };
      else if (body.action === "allow") decision = { action: "allow" };
      else {
        sendJson(res, { error: "action must be allow, deny or rewrite" }, 400);
        return;
      }
      const ok = resolvePending(id, decision);
      sendJson(res, { ok, id, action: decision.action }, ok ? 200 : 404);
    });
    return;
  }

  if (method === "POST" && path === "/api/fences") {
    void readBody(req).then((raw) => {
      try {
        const body = JSON.parse(raw || "{}") as { fences?: unknown };
        const list = Array.isArray(body.fences)
          ? body.fences.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter(Boolean)
          : [];
        fences = list;
        saveFences(fences);
        console.log(`${new Date().toISOString()}  fences updated: ${JSON.stringify(fences)}`);
        broadcastState();
        sendJson(res, { ok: true, fences });
      } catch {
        sendJson(res, { error: "invalid json" }, 400);
      }
    });
    return;
  }

  if (method === "POST" && path === "/api/stop-after-batch") {
    void readBody(req).then((raw) => {
      let enabled = true;
      try {
        const body = JSON.parse(raw || "{}") as { enabled?: unknown };
        if (typeof body.enabled === "boolean") enabled = body.enabled;
      } catch {
        /* default to arming it */
      }
      stopAfterBatch = enabled;
      console.log(`${new Date().toISOString()}  stopAfterBatch=${stopAfterBatch}`);
      broadcastState();
      sendJson(res, { ok: true, stopAfterBatch });
    });
    return;
  }

  sendJson(res, { error: "not found" }, 404);
});

// ---------------------------------------------------------------- page

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Wake spike 4</title>
<style>
 :root { color-scheme: light dark; --line:#8883; }
 body { margin:0; font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
 header { padding:10px 14px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
 h1 { font-size:14px; margin:0 12px 0 0; }
 main { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); gap:0; height:calc(100vh - 46px); }
 section { overflow:auto; padding:10px 14px; }
 section + section { border-left:1px solid var(--line); }
 h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; opacity:.7; margin:14px 0 6px; }
 table { border-collapse:collapse; width:100%; }
 td { padding:2px 6px 2px 0; vertical-align:top; border-bottom:1px solid var(--line); }
 td.sum { word-break:break-all; }
 .tag { padding:0 5px; border-radius:3px; background:#8882; }
 .deny { background:#e5484d33; }
 .hold { background:#f5a52333; }
 .card { border:1px solid var(--line); border-radius:5px; padding:8px 10px; margin:8px 0; }
 pre { margin:4px 0; padding:6px; background:#8881; border-radius:4px; overflow:auto; max-height:180px; white-space:pre-wrap; }
 .del { background:#e5484d22; } .ins { background:#30a04622; }
 button { font:inherit; padding:3px 9px; margin-right:6px; cursor:pointer; }
 textarea { width:100%; min-height:110px; font:inherit; }
 input[type=text] { font:inherit; width:100%; }
 #armed { font-weight:bold; color:#e5484d; }
 .muted { opacity:.6; }
</style></head><body>
<header>
  <h1>Wake spike 4</h1>
  <button id="stopbtn">Stop after this batch</button>
  <span id="armed" hidden>ARMED, next PostToolBatch stops the loop</span>
  <span id="conn" class="muted">connecting…</span>
</header>
<main>
  <section>
    <h2>Events</h2>
    <table><tbody id="rows"></tbody></table>
  </section>
  <section>
    <h2>Pending permission requests</h2>
    <div id="pending" class="muted">none</div>
    <h2>Fences (glob, one per line)</h2>
    <textarea id="fences" style="min-height:80px"></textarea>
    <div style="margin-top:6px"><button id="savefences">Save fences</button><span id="fencemsg" class="muted"></span></div>
    <p class="muted">Matched against the absolute path and the path relative to the session cwd.
    A relative pattern matches at any depth. Edit/Write/MultiEdit/NotebookEdit only.</p>
  </section>
</main>
<script>
const rows = document.getElementById('rows');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function addEvent(e) {
  const tr = document.createElement('tr');
  if (e.note && e.note.startsWith('fence deny')) tr.className = 'deny';
  if (e.note && e.note.startsWith('held')) tr.className = 'hold';
  tr.innerHTML = '<td class="muted">' + esc(e.ts.slice(11,23)) + '</td>'
    + '<td><span class="tag">' + esc(e.hook_event_name) + '</span></td>'
    + '<td>' + esc(e.tool_name || '') + '</td>'
    + '<td>' + (e.has_tool_response ? 'resp' : '') + '</td>'
    + '<td class="sum">' + esc(e.summary) + (e.note ? ' <span class="muted">[' + esc(e.note) + ']</span>' : '') + '</td>';
  rows.prepend(tr);
  while (rows.children.length > 300) rows.lastChild.remove();
}
function diffBlock(p) {
  if (p.old_string == null && p.new_string == null) {
    return '<pre>' + esc(JSON.stringify(p.tool_input, null, 2)) + '</pre>';
  }
  let out = '';
  if (p.old_string != null) out += '<pre class="del">- ' + esc(p.old_string) + '</pre>';
  if (p.new_string != null) out += '<pre class="ins">+ ' + esc(p.new_string) + '</pre>';
  return out;
}
function renderPending(list) {
  const host = document.getElementById('pending');
  if (!list.length) { host.className = 'muted'; host.textContent = 'none'; return; }
  host.className = '';
  host.innerHTML = list.map(p =>
    '<div class="card" data-id="' + esc(p.id) + '">'
    + '<div><b>' + esc(p.tool_name) + '</b> ' + esc(p.file_path || '') + ' <span class="muted">' + esc(p.ts.slice(11,19)) + '</span></div>'
    + diffBlock(p)
    + '<div><button data-a="allow">Approve</button><button data-a="deny">Reject</button>'
    + '<button data-a="edit">Rewrite…</button></div>'
    + '<div class="rw" hidden><textarea>' + esc(p.new_string == null ? '' : p.new_string) + '</textarea>'
    + '<button data-a="rewrite">Rewrite then approve</button></div>'
    + '</div>').join('');
}
document.getElementById('pending').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button'); if (!btn) return;
  const card = btn.closest('.card'); const id = card.dataset.id; const a = btn.dataset.a;
  if (a === 'edit') { card.querySelector('.rw').hidden = false; return; }
  const body = { id, action: a };
  if (a === 'rewrite') body.new_string = card.querySelector('.rw textarea').value;
  if (a === 'deny') body.message = 'Rejected in Wake.';
  btn.disabled = true;
  await fetch('/api/decision', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
});
document.getElementById('savefences').addEventListener('click', async () => {
  const list = document.getElementById('fences').value.split('\n').map(s => s.trim()).filter(Boolean);
  await fetch('/api/fences', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({fences:list}) });
  const msg = document.getElementById('fencemsg'); msg.textContent = ' saved'; setTimeout(() => msg.textContent = '', 1500);
});
document.getElementById('stopbtn').addEventListener('click', async () => {
  await fetch('/api/stop-after-batch', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({enabled:true}) });
});
let fencesDirty = false;
document.getElementById('fences').addEventListener('input', () => { fencesDirty = true; });
const es = new EventSource('/events');
es.addEventListener('open', () => { document.getElementById('conn').textContent = 'live'; });
es.addEventListener('error', () => { document.getElementById('conn').textContent = 'disconnected, retrying…'; });
es.addEventListener('event', (m) => addEvent(JSON.parse(m.data)));
es.addEventListener('state', (m) => {
  const s = JSON.parse(m.data);
  renderPending(s.pending);
  document.getElementById('armed').hidden = !s.stopAfterBatch;
  if (!fencesDirty) document.getElementById('fences').value = s.fences.join('\n');
});
</script></body></html>
`;

// ---------------------------------------------------------------- start

if (process.env["WAKE_NO_LISTEN"] !== "1") {
  server.listen(PORT, HOST, () => {
    console.log(`Wake spike 4 hook server on http://${HOST}:${PORT}`);
    console.log(`  hook endpoint : POST http://${HOST}:${PORT}/hook`);
    console.log(`  UI            : http://${HOST}:${PORT}/`);
    console.log(`  raw events    : ${EVENTS_FILE}`);
    console.log(`  fences        : ${FENCES_FILE} -> ${JSON.stringify(fences)}`);
    console.log(`  permission hold timeout: ${PERMISSION_TIMEOUT_S}s`);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      try {
        sendJson(p.res, {});
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  });
}
