/**
 * Wake spike 4 selftest.
 *
 *   npm run selftest
 *
 * Spawns src/server.ts on a scratch port with scratch state files, posts
 * synthetic hook payloads shaped like the ones in
 * https://code.claude.com/docs/en/hooks.md, and asserts the responses.
 *
 * It covers everything that does not need a live interactive Claude Code
 * session: fence deny, pass-through, the held-open PermissionRequest and its
 * allow / deny / rewrite / timeout paths, the PostToolBatch stop gate, hot
 * fence edits, the raw events.jsonl log and the SSE stream.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Imported for its pure fence matcher only. WAKE_NO_LISTEN must be set before
// the module is evaluated, so this has to be a dynamic import (static imports
// are hoisted above any assignment to process.env).
process.env["WAKE_NO_LISTEN"] = "1";
const { matchesFence } = await import("./server.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const TMP = resolve(APP_DIR, ".selftest");
const PORT = Number(process.env["WAKE_SELFTEST_PORT"] ?? 7788);
const BASE = `http://127.0.0.1:${PORT}`;
const EVENTS_FILE = resolve(TMP, "events.jsonl");
const FENCES_FILE = resolve(TMP, "fences.json");
const CWD = "/Users/someone/scratch-project";
const SESSION = "11111111-2222-3333-4444-555555555555";
/** Server is started with a 2s permission hold so the timeout path is testable. */
const HOLD_S = 2;

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;

let hookPosts = 0;

async function hook(payload: Json): Promise<Json> {
  hookPosts++;
  const res = await fetch(`${BASE}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as Json;
}

function hookRaw(payload: Json): { done: boolean; promise: Promise<Json> } {
  const state = { done: false, promise: null as unknown as Promise<Json> };
  state.promise = hook(payload).then((v) => {
    state.done = true;
    return v;
  });
  return state as { done: boolean; promise: Promise<Json> };
}

async function api(path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as Json;
}

const base = (event: string): Json => ({
  session_id: SESSION,
  transcript_path: `/Users/someone/.claude/projects/-scratch/${SESSION}.jsonl`,
  cwd: CWD,
  permission_mode: "default",
  hook_event_name: event,
});

// --------------------------------------------------------------- run

async function waitForPending(n: number, timeoutMs = 3000): Promise<Json[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const state = await api("/api/state");
    const list = state["pending"] as Json[];
    if (list.length === n) return list;
    if (Date.now() > until) throw new Error(`pending never reached ${n}, saw ${list.length}`);
    await sleep(50);
  }
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const child = spawn(process.execPath, ["--experimental-strip-types", resolve(HERE, "server.ts")], {
    env: {
      ...process.env,
      WAKE_NO_LISTEN: "0",
      WAKE_PORT: String(PORT),
      WAKE_EVENTS_FILE: EVENTS_FILE,
      WAKE_FENCES_FILE: FENCES_FILE,
      WAKE_PERMISSION_TIMEOUT: String(HOLD_S),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog: string[] = [];
  child.stdout.on("data", (d: Buffer) => serverLog.push(d.toString()));
  child.stderr.on("data", (d: Buffer) => serverLog.push(d.toString()));

  try {
    // wait for listen
    const until = Date.now() + 10000;
    for (;;) {
      try {
        await api("/api/state");
        break;
      } catch {
        if (Date.now() > until) throw new Error(`server never came up:\n${serverLog.join("")}`);
        await sleep(100);
      }
    }

    console.log("\n# fence glob unit checks");
    check("relative pattern matches at depth", matchesFence(`${CWD}/protected/config.ts`, CWD, ["protected/**"]) === "protected/**");
    check("relative pattern is not a prefix hack", matchesFence(`${CWD}/src/protection.ts`, CWD, ["protected/**"]) === null);
    check("* does not cross a separator", matchesFence(`${CWD}/a/b.ts`, CWD, ["a/*"]) === "a/*" && matchesFence(`${CWD}/a/b/c.ts`, CWD, ["a/*"]) === null);
    check("absolute pattern matches", matchesFence("/etc/hosts", CWD, ["/etc/**"]) === "/etc/**");
    check("suffix pattern matches", matchesFence(`${CWD}/src/main.ts`, CWD, ["**/*.ts"]) === "**/*.ts");

    console.log("\n# SessionStart");
    const ss = await hook({ ...base("SessionStart"), reason: "startup", model: "claude-opus-5" });
    check("SessionStart gets an empty pass-through", JSON.stringify(ss) === "{}", ss);

    console.log("\n# PreToolUse pass-through and fence deny");
    const allowed = await hook({
      ...base("PreToolUse"),
      tool_name: "Edit",
      tool_use_id: "toolu_a",
      tool_input: { file_path: `${CWD}/src/greet.ts`, old_string: "Hello", new_string: "Hi" },
    });
    check("unfenced Edit passes through as {}", JSON.stringify(allowed) === "{}", allowed);

    const denied = await hook({
      ...base("PreToolUse"),
      tool_name: "Write",
      tool_use_id: "toolu_b",
      tool_input: { file_path: `${CWD}/protected/config.ts`, content: "nope" },
    });
    const dso = denied["hookSpecificOutput"] as Json | undefined;
    check("fenced Write is denied", dso?.["permissionDecision"] === "deny", denied);
    check("deny carries hookEventName PreToolUse", dso?.["hookEventName"] === "PreToolUse", denied);
    check("deny carries a reason naming the pattern", String(dso?.["permissionDecisionReason"] ?? "").includes("protected/**"), denied);

    const readProtected = await hook({
      ...base("PreToolUse"),
      tool_name: "Read",
      tool_use_id: "toolu_c",
      tool_input: { file_path: `${CWD}/protected/config.ts` },
    });
    check("non-writing tool is not fenced", JSON.stringify(readProtected) === "{}", readProtected);

    console.log("\n# hot fence edit (no restart)");
    await api("/api/fences", { fences: ["src/**"] });
    const nowAllowed = await hook({
      ...base("PreToolUse"),
      tool_name: "Edit",
      tool_use_id: "toolu_d",
      tool_input: { file_path: `${CWD}/protected/config.ts`, old_string: "3", new_string: "4" },
    });
    check("lifted fence lets protected/ through", JSON.stringify(nowAllowed) === "{}", nowAllowed);
    const nowDenied = await hook({
      ...base("PreToolUse"),
      tool_name: "Edit",
      tool_use_id: "toolu_e",
      tool_input: { file_path: `${CWD}/src/greet.ts`, old_string: "Hello", new_string: "Hi" },
    });
    check("new fence denies src/", (nowDenied["hookSpecificOutput"] as Json | undefined)?.["permissionDecision"] === "deny", nowDenied);
    check("fences.json was persisted", existsSync(FENCES_FILE) && readFileSync(FENCES_FILE, "utf8").includes("src/**"));
    await api("/api/fences", { fences: ["protected/**"] });

    console.log("\n# PostToolUse");
    const post = await hook({
      ...base("PostToolUse"),
      tool_name: "Edit",
      tool_use_id: "toolu_a",
      tool_input: { file_path: `${CWD}/src/greet.ts`, old_string: "Hello", new_string: "Hi" },
      tool_response: { filePath: `${CWD}/src/greet.ts`, structuredPatch: [{ oldStart: 2, newStart: 2, lines: ["-  Hello", "+  Hi"] }] },
      duration_ms: 12,
    });
    check("PostToolUse gets an empty pass-through", JSON.stringify(post) === "{}", post);
    const stateAfterPost = await api("/api/state");
    const evs = stateAfterPost["events"] as Json[];
    const postEv = [...evs].reverse().find((e) => e["hook_event_name"] === "PostToolUse");
    check("PostToolUse event is logged with tool_response present", postEv?.["has_tool_response"] === true, postEv);
    check("event summary is the file path", postEv?.["summary"] === `${CWD}/src/greet.ts`, postEv);

    console.log("\n# PermissionRequest: hold then allow");
    const p1 = hookRaw({
      ...base("PermissionRequest"),
      tool_name: "Edit",
      tool_use_id: "toolu_f",
      tool_input: { file_path: `${CWD}/src/math.ts`, old_string: "return a + b;", new_string: "return a + b + 0;" },
    });
    const list1 = await waitForPending(1);
    check("request is held open (no response yet)", p1.done === false);
    check("pending exposes the diff", list1[0]?.["old_string"] === "return a + b;" && list1[0]?.["new_string"] === "return a + b + 0;", list1[0]);
    const dec1 = await api("/api/decision", { id: String(list1[0]?.["id"]), action: "allow" });
    check("decision endpoint acknowledges", dec1["ok"] === true, dec1);
    const body1 = await p1.promise;
    const d1 = (body1["hookSpecificOutput"] as Json)?.["decision"] as Json;
    check("allow releases the held request", d1?.["behavior"] === "allow", body1);
    check("allow carries hookEventName PermissionRequest", (body1["hookSpecificOutput"] as Json)?.["hookEventName"] === "PermissionRequest", body1);
    check("allow does not smuggle updatedInput", d1?.["updatedInput"] === undefined, body1);

    console.log("\n# PermissionRequest: rewrite then approve");
    const p2 = hookRaw({
      ...base("PermissionRequest"),
      tool_name: "Edit",
      tool_use_id: "toolu_g",
      tool_input: { file_path: `${CWD}/src/math.ts`, old_string: "return n * 2;", new_string: "return n * 3;", replace_all: false },
    });
    const list2 = await waitForPending(1);
    await api("/api/decision", { id: String(list2[0]?.["id"]), action: "rewrite", new_string: "return n * 4;" });
    const body2 = await p2.promise;
    const d2 = (body2["hookSpecificOutput"] as Json)?.["decision"] as Json;
    check("rewrite allows", d2?.["behavior"] === "allow", body2);
    const ui = d2?.["updatedInput"] as Json | undefined;
    check("rewrite sets updatedInput.new_string", ui?.["new_string"] === "return n * 4;", ui);
    check("rewrite preserves the rest of tool_input", ui?.["file_path"] === `${CWD}/src/math.ts` && ui?.["old_string"] === "return n * 2;" && ui?.["replace_all"] === false, ui);

    console.log("\n# PermissionRequest: reject");
    const p3 = hookRaw({
      ...base("PermissionRequest"),
      tool_name: "Write",
      tool_use_id: "toolu_h",
      tool_input: { file_path: `${CWD}/src/new.ts`, content: "x" },
    });
    const list3 = await waitForPending(1);
    await api("/api/decision", { id: String(list3[0]?.["id"]), action: "deny", message: "not this one" });
    const body3 = await p3.promise;
    const d3 = (body3["hookSpecificOutput"] as Json)?.["decision"] as Json;
    check("reject denies", d3?.["behavior"] === "deny", body3);
    check("reject carries the message", d3?.["message"] === "not this one", body3);

    console.log(`\n# PermissionRequest: timeout falls back to the terminal (${HOLD_S}s)`);
    const p4 = hookRaw({
      ...base("PermissionRequest"),
      tool_name: "Edit",
      tool_use_id: "toolu_i",
      tool_input: { file_path: `${CWD}/src/greet.ts`, old_string: "Hi", new_string: "Yo" },
    });
    await waitForPending(1);
    const body4 = await p4.promise;
    check("timeout responds with no decision", JSON.stringify(body4) === "{}", body4);
    check("timeout clears the pending list", ((await api("/api/state"))["pending"] as Json[]).length === 0);

    console.log("\n# stale decision id");
    const stale = await fetch(`${BASE}/api/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "perm-9999", action: "allow" }),
    });
    check("unknown pending id is a 404", stale.status === 404, stale.status);

    console.log("\n# PostToolBatch gate");
    const batchPayload = {
      ...base("PostToolBatch"),
      tool_calls: [
        { tool_use_id: "toolu_a", tool_name: "Edit", tool_input: { file_path: `${CWD}/src/greet.ts` }, success: true, output: "ok" },
        { tool_use_id: "toolu_j", tool_name: "Bash", tool_input: { command: "ls" }, success: true, output: "src" },
      ],
    };
    const b1 = await hook(batchPayload);
    check("unarmed batch passes through", JSON.stringify(b1) === "{}", b1);
    const arm = await api("/api/stop-after-batch", { enabled: true });
    check("gate arms", arm["stopAfterBatch"] === true, arm);
    const b2 = await hook(batchPayload);
    check("armed batch stops the loop", b2["continue"] === false, b2);
    check("armed batch carries stopReason", b2["stopReason"] === "Stopped from Wake", b2);
    check("armed batch mirrors continue in hookSpecificOutput", (b2["hookSpecificOutput"] as Json)?.["continue"] === false, b2);
    const b3 = await hook(batchPayload);
    check("gate is one-shot", JSON.stringify(b3) === "{}", b3);
    check("gate reads disarmed", ((await api("/api/state"))["stopAfterBatch"]) === false);

    console.log("\n# Stop");
    const stop = await hook({ ...base("Stop"), last_assistant_message: "done", stop_reason: "end_turn" });
    check("Stop gets an empty pass-through", JSON.stringify(stop) === "{}", stop);

    console.log("\n# raw event log");
    const lines = readFileSync(EVENTS_FILE, "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as Json);
    check("every hook post is one JSON line", parsed.length === hookPosts, { lines: parsed.length, posts: hookPosts });
    check("raw payload is preserved verbatim", parsed.some((p) => p["hook_event_name"] === "PostToolUse" && (p["tool_response"] as Json)?.["structuredPatch"] !== undefined));
    check("receive timestamp is added", parsed.every((p) => typeof p["wake_received_at"] === "string"));

    console.log("\n# SSE stream");
    const ctrl = new AbortController();
    const sse = await fetch(`${BASE}/events`, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
    const reader = sse.body!.getReader();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(text.includes("event: state") && text.includes("event: event"))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    check("SSE replays the event backlog", text.includes("event: event"));
    check("SSE sends a state frame", text.includes("event: state") && text.includes("protected/**"));
  } finally {
    child.kill("SIGTERM");
    await sleep(150);
    if (!child.killed) child.kill("SIGKILL");
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
