// POST /hook: Claude Code http hook payloads in, hook JSON output back.
//
// Payload schema: docs/research/04-claude-code-integration.md section 3 and
// apps/spike-hooks/README.md "Schema notes" (observed 2.1.258). The fence
// matcher and the held-open PermissionRequest are lifted from
// apps/spike-hooks/src/server.ts; the Promise<Response> form replaces the
// node ServerResponse so the same code runs on Bun.serve.

import type { SessionEvent, ServerMessage } from './protocol.ts';
import type { SessionManager } from './session.ts';

type Json = Record<string, unknown>;

export interface HookPayload extends Json {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Json;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  agent_id?: string;
  agent_type?: string;
}

/** Tools whose event waits for PostToolUse so it can carry the patch range. */
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ---------------------------------------------------------------- fences (spike 4)

/** Minimal glob: `**` crosses separators, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesFence(filePath: string, cwd: string | undefined, patterns: readonly string[]): string | null {
  const abs = filePath.replaceAll('\\', '/');
  const candidates = new Set<string>([abs, abs.replace(/^\/+/, '')]);
  if (cwd) {
    const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
    if (abs.startsWith(`${base}/`)) candidates.add(abs.slice(base.length + 1));
  }
  for (const pattern of patterns) {
    const p = pattern.trim();
    if (!p) continue;
    const forms = p.startsWith('/') ? [p, p.slice(1)] : [p, `**/${p}`];
    for (const form of forms) {
      const re = globToRegExp(form);
      for (const candidate of candidates) if (re.test(candidate)) return pattern;
    }
  }
  return null;
}

// ---------------------------------------------------------------- handler

export interface Decision {
  behavior: 'allow' | 'deny';
  updatedInput?: Json;
  message?: string;
}

interface Pending {
  readonly id: string;
  readonly toolName: string;
  readonly input: Json;
  readonly resolve: (body: Json) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface HookHandlerOptions {
  readonly sessions: SessionManager;
  /** Absolute repository root, the cwd fallback for a payload without one. */
  readonly repo: string;
  readonly broadcast: (message: ServerMessage) => void;
  readonly fences: readonly string[];
  readonly permissionTimeoutS: number;
  readonly log: (line: string) => void;
  /** Called after every hook so the transcript tail can catch up quickly. */
  readonly afterHook?: () => void;
}

export class HookHandler {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private lastStamp = 0;
  hooksSeen = 0;

  /** Monotonic wall clock, so the parser's time-sorted output only grows at its end. */
  private stamp(): number {
    const now = Math.max(Date.now(), this.lastStamp + 1);
    this.lastStamp = now;
    return now;
  }

  private readonly opts: HookHandlerOptions;

  constructor(opts: HookHandlerOptions) {
    this.opts = opts;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async handle(payload: HookPayload): Promise<Json> {
    this.hooksSeen++;
    const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '(missing)';
    // Hooks from a Claude Code session running in another repository (a stale
    // settings file, a second project pointing at the same port) are not ours.
    // Pass them through untouched so that session is never slowed or blocked.
    if (typeof payload.cwd === 'string' && !isInsideRepo(payload.cwd, this.opts.repo)) {
      this.opts.log(`hook             ignored ${name} from foreign cwd`);
      return {};
    }
    const sid = typeof payload.session_id === 'string' ? payload.session_id : null;
    const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    if (sid === null) {
      this.opts.log(`hook             ${name} without session_id, ignored`);
      return {};
    }
    const store = this.opts.sessions.get(sid, transcript);
    if (typeof payload.tool_name === 'string') this.opts.sessions.noteToolHook(store);
    const agentId = typeof payload.agent_id === 'string' && payload.agent_id !== '' ? payload.agent_id : null;
    if (agentId !== null) store.rememberAgentType(agentId, typeof payload.agent_type === 'string' ? payload.agent_type : null);

    let emitted: SessionEvent[] = [];
    let response: Json = {};
    switch (name) {
      case 'SessionStart':
        store.setState('running');
        break;
      case 'UserPromptSubmit':
        this.opts.sessions.notePrompt(store);
        store.setState('running');
        if (typeof payload.prompt === 'string' && payload.prompt.trim() !== '') {
          emitted = store.appendHookRecords([this.userRecord(payload, payload.prompt)], agentId);
        }
        break;
      case 'PreToolUse': {
        const tool = payload.tool_name ?? '';
        const filePath = typeof payload.tool_input?.['file_path'] === 'string' ? (payload.tool_input['file_path'] as string) : null;
        const hit = WRITERS.has(tool) && filePath !== null ? matchesFence(filePath, payload.cwd, this.opts.fences) : null;
        if (hit !== null) {
          this.opts.log(`fence            deny ${tool} ${filePath} (${hit})`);
          response = {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Wake fence: ${filePath} matches "${hit}". Ask the user to lift the fence in Wake.`,
            },
          };
          break;
        }
        if (!WRITERS.has(tool)) emitted = store.appendHookRecords([this.toolUseRecord(payload)], agentId);
        break;
      }
      case 'PostToolUse': {
        const tool = payload.tool_name ?? '';
        if (WRITERS.has(tool)) {
          emitted = store.appendHookRecords([this.toolUseRecord(payload), this.toolResultRecord(payload)], agentId);
        }
        break;
      }
      case 'PermissionRequest':
        return this.hold(payload);
      case 'SubagentStart':
        if (agentId !== null) this.opts.log(`subagent         start ${agentId} (${payload.agent_type ?? '?'})`);
        break;
      case 'Stop':
        store.setState('idle');
        break;
      case 'SessionEnd':
        store.setState('ended');
        break;
      default:
        // PostToolBatch, PostToolUseFailure, SubagentStop, Notification, ...
        break;
    }
    const tool = typeof payload.tool_name === 'string' ? ` ${payload.tool_name}` : '';
    this.opts.log(`hook             ${name.padEnd(18)}${tool.padEnd(14)} ${emitted.map((e) => e.title).join(' | ')}`);
    this.opts.afterHook?.();
    return response;
  }

  // -------------------------------------------------------------- records

  private envelope(payload: HookPayload): Json {
    return {
      uuid: `wake-${++this.seq}`,
      timestamp: new Date(this.stamp()).toISOString(),
      cwd: payload.cwd ?? this.opts.repo,
      sessionId: payload.session_id,
    };
  }

  private userRecord(payload: HookPayload, text: string): Json {
    return { ...this.envelope(payload), type: 'user', message: { role: 'user', content: text } };
  }

  private toolUseRecord(payload: HookPayload): Json {
    const id = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : `wake-tu-${this.seq + 1}`;
    return {
      ...this.envelope(payload),
      type: 'assistant',
      message: {
        id: `wake-msg-${this.seq}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: payload.tool_name ?? 'unknown', input: payload.tool_input ?? {} }],
      },
    };
  }

  /** The PostToolUse `tool_response` carries the same structuredPatch the transcript's toolUseResult does. */
  private toolResultRecord(payload: HookPayload): Json {
    const id = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : `wake-tu-${this.seq}`;
    const response = typeof payload.tool_response === 'object' && payload.tool_response !== null ? (payload.tool_response as Json) : {};
    const patch = Array.isArray(response['structuredPatch']) ? response['structuredPatch'] : undefined;
    return {
      ...this.envelope(payload),
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] },
      ...(patch === undefined ? {} : { toolUseResult: { structuredPatch: patch } }),
    };
  }

  // -------------------------------------------------------------- permissions (spike 4)

  private hold(payload: HookPayload): Promise<Json> {
    const id = `perm-${++this.seq}`;
    const toolName = payload.tool_name ?? '(unknown)';
    const input = payload.tool_input ?? {};
    this.opts.log(`permission       ${id} ${toolName} held (timeout ${this.opts.permissionTimeoutS}s)`);
    return new Promise<Json>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.opts.log(`permission       ${id} timed out, terminal prompt stands`);
        resolve({});
      }, this.opts.permissionTimeoutS * 1000);
      timer.unref?.();
      this.pending.set(id, { id, toolName, input, resolve, timer });
      this.opts.broadcast({ type: 'permission', requestId: id, toolName, input });
    });
  }

  decide(requestId: string, decision: Decision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const body: Json =
      decision.behavior === 'deny'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'deny', message: decision.message ?? 'Rejected in Wake.', interrupt: false },
            },
          }
        : {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: {
                behavior: 'allow',
                ...(decision.updatedInput === undefined ? {} : { updatedInput: { ...entry.input, ...decision.updatedInput } }),
              },
            },
          };
    this.opts.log(`permission       ${requestId} ${decision.behavior}`);
    entry.resolve(body);
    return true;
  }

  /** On shutdown: answer every held request with pass-through. */
  releaseAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({});
    }
    this.pending.clear();
  }
}

function isInsideRepo(cwd: string, repo: string): boolean {
  const norm = (x: string) => x.replaceAll('\\', '/').replace(/\/+$/, '');
  const c = norm(cwd);
  const r = norm(repo);
  return c === r || c.startsWith(r + '/');
}
