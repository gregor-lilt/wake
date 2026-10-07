// Session state and the event stream.
//
// Two sources feed one ordered stream of SessionEvents:
//
//   1. Hooks. Every hook payload that maps to an export event is turned into
//      a Claude-Code-shaped transcript record and appended to a SYNTHETIC
//      transcript under the OS temp dir. packages/export's buildSession then
//      parses that file, so title, summary, kind, path mapping and line
//      ranges follow exactly the export's rules without duplicating them
//      here (its helpers are not exported). Records get monotonic
//      timestamps, so the parser's time-sorted output only ever grows at the
//      end and the new tail is what gets emitted.
//   2. The real transcript (transcript_path from the hook payload), tailed
//      for assistant text, which no hook carries. Same parser, filtered to
//      assistant `message` events, de-duplicated by (agent, time, text).
//      In transcript mode (`serve --transcript`, no hooks at all) the tail is
//      the only source and every event kind is emitted from it.
//
// Everything emitted is appended to `.wake/live/<sessionId>.jsonl` in the
// target repository, one protocol frame per line.

import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportEvent, ExportSession } from '../../../packages/export/src/schema.ts';
import { buildSession } from '../../../packages/export/src/session.ts';
import type { LoggedMessage, ServerMessage, SessionEvent, SessionState } from './protocol.ts';

export const MAX_EVENTS = 5000;

type Json = Record<string, unknown>;

export interface SessionStoreOptions {
  readonly repo: string;
  readonly fileIds: Map<string, number>;
  readonly dirPaths: Set<string>;
  readonly broadcast: (message: ServerMessage) => void;
  readonly log?: (line: string) => void;
}

export class SessionStore {
  readonly sessionId: string;
  state: SessionState = 'idle';
  transcriptPath: string | null;
  readonly events: SessionEvent[] = [];

  private nextId = 1;
  private t0: number | null = null;
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  private readonly logPath: string;
  private readonly synthDir: string;
  private synthRecords = 0;
  private emittedHookEvents = 0;
  private transcriptSize = -1;
  private readonly seenMessages = new Set<string>();
  private readonly agentTypes = new Map<string, string>();

  private readonly opts: SessionStoreOptions;
  /** Hooks that name a tool, the signal that this is a working session. */
  toolHooks = 0;
  /**
   * Transcript mode: the tail emits every event, not just assistant text,
   * because no hooks are coming. Set by `serve --transcript`.
   */
  tailAll = false;

  constructor(sessionId: string, transcriptPath: string | null, opts: SessionStoreOptions) {
    this.opts = opts;
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;

    const liveDir = join(opts.repo, '.wake', 'live');
    mkdirSync(liveDir, { recursive: true });
    this.logPath = join(liveDir, `${sessionId}.jsonl`);

    this.synthDir = join(tmpdir(), 'wake-daemon', sessionId);
    rmSync(this.synthDir, { recursive: true, force: true });
    mkdirSync(this.synthDir, { recursive: true });
    writeFileSync(this.synthPath(null), '');

    this.setState('running');
  }

  /** A later hook may carry the transcript path an earlier one lacked. */
  learnTranscript(transcriptPath: string | null): void {
    if (transcriptPath !== null && this.transcriptPath === null) this.transcriptPath = transcriptPath;
  }

  setState(state: SessionState): void {
    if (state === this.state) return;
    this.state = state;
    this.send({ type: 'session', state, sessionId: this.sessionId });
  }


  rememberAgentType(agentId: string, agentType: string | null): void {
    if (agentType !== null) this.agentTypes.set(agentId, agentType);
  }

  private synthPath(agentId: string | null): string {
    if (agentId === null) return join(this.synthDir, 'main.jsonl');
    return join(this.synthDir, 'main', 'subagents', `agent-${agentId}.jsonl`);
  }

  /**
   * Append a transcript-shaped record (or several) and emit whatever new
   * events the export parser makes of them.
   */
  appendHookRecords(records: Json[], agentId: string | null): SessionEvent[] {
    const path = this.synthPath(agentId);
    if (agentId !== null && !existsSync(path)) {
      mkdirSync(join(this.synthDir, 'main', 'subagents'), { recursive: true });
      const agentType = this.agentTypes.get(agentId);
      if (agentType !== undefined) {
        writeFileSync(join(this.synthDir, 'main', 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType }));
      }
    }
    appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    this.synthRecords += records.length;

    const parsed = buildSession(this.synthPath(null), this.opts.repo, this.opts.fileIds, this.opts.dirPaths);
    const base = Date.parse(parsed.session.startedAt);
    const all = parsed.session.events;
    const fresh = all.slice(this.emittedHookEvents);
    this.emittedHookEvents = all.length;
    return fresh.map((event) => this.emit(event, base + event.t));
  }

  /**
   * Re-read the real transcript if it grew; emit new assistant messages, or
   * in transcript mode every new event.
   */
  tailTranscript(force = false): SessionEvent[] {
    if (this.transcriptPath === null) return [];
    let size: number;
    try {
      size = statSync(this.transcriptPath).size;
    } catch {
      return [];
    }
    if (!force && size === this.transcriptSize) return [];
    this.transcriptSize = size;
    let parsed;
    try {
      parsed = buildSession(this.transcriptPath, this.opts.repo, this.opts.fileIds, this.opts.dirPaths);
    } catch (err) {
      this.opts.log?.(`transcript       unreadable: ${String(err)}`);
      return [];
    }
    const base = Date.parse(parsed.session.startedAt);
    const out: SessionEvent[] = [];
    const now = Date.now();
    for (const event of parsed.session.events) {
      const isAssistantText = event.kind === 'message' && event.role === 'assistant';
      if (!this.tailAll && !isAssistantText) continue;
      const ms = base + event.t;
      const key = isAssistantText
        ? `${event.agentId ?? ''}|${ms}|${event.text ?? ''}`
        : `${event.agentId ?? ''}|${ms}|${event.kind}|${event.title}`;
      if (this.seenMessages.has(key)) continue;
      // An edit's line range comes from its tool result, a moment after the
      // call. Hold a fresh edit back briefly so it is emitted once, complete.
      if ((event.kind === 'edit' || event.kind === 'write') && event.lineStart === null && now - ms < 4000) continue;
      this.seenMessages.add(key);
      out.push(this.emit(event, ms));
    }
    return out;
  }

  private emit(event: ExportEvent, ms: number): SessionEvent {
    if (this.t0 === null) {
      this.t0 = ms;
      this.startedAt = new Date(ms).toISOString();
    }
    this.endedAt = new Date(Math.max(ms, Date.parse(this.endedAt ?? '0') || 0)).toISOString();
    const full: SessionEvent = {
      ...event,
      t: Math.max(0, ms - this.t0),
      id: this.nextId++,
      wall: new Date(ms).toISOString(),
    };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.send({ type: 'event', event: full });
    return full;
  }

  /** Broadcast and log a frame that belongs to the session record. */
  send(message: LoggedMessage): void {
    this.opts.broadcast(message);
    try {
      appendFileSync(this.logPath, `${JSON.stringify(message)}\n`);
    } catch (err) {
      this.opts.log?.(`event log        write failed: ${String(err)}`);
    }
  }

  exportSession(): ExportSession {
    const now = new Date().toISOString();
    return {
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath ?? '',
      startedAt: this.startedAt ?? now,
      endedAt: this.endedAt ?? this.startedAt ?? now,
      events: [...this.events],
    };
  }

  get syntheticRecords(): number {
    return this.synthRecords;
  }
}

/**
 * One store per Claude Code session id, all logged, ONE streamed. Claude Code
 * runs short helper sessions next to the user's session (a prompt, no tools,
 * SessionEnd seconds later) and they hit the same hook endpoint, so the
 * streamed "primary" session is the first one seen until another session
 * proves itself with a tool hook, or sends a prompt after the primary ended.
 */
export class SessionManager {
  private readonly stores = new Map<string, SessionStore>();
  private primaryStore: SessionStore | null = null;
  private readonly opts: SessionStoreOptions;

  constructor(opts: SessionStoreOptions) {
    this.opts = opts;
  }

  get primary(): SessionStore | null {
    return this.primaryStore;
  }

  get(sessionId: string, transcriptPath: string | null): SessionStore {
    let store = this.stores.get(sessionId);
    if (store !== undefined) {
      store.learnTranscript(transcriptPath);
      return store;
    }
    // Compared by id, not by reference: the constructor already sends its
    // first `session` frame before this assignment completes.
    store = new SessionStore(sessionId, transcriptPath, {
      ...this.opts,
      broadcast: (message) => {
        if (this.primaryStore?.sessionId === sessionId) this.opts.broadcast(message);
      },
    });
    this.stores.set(sessionId, store);
    this.opts.log?.(`session          new ${sessionId}${this.primaryStore === null ? ' (primary)' : ''}`);
    if (this.primaryStore === null) this.promote(store);
    return store;
  }

  /** A prompt: enough to take over from a primary that has ended. */
  notePrompt(store: SessionStore): void {
    if (this.primaryStore !== store && this.primaryStore !== null && this.primaryStore.state === 'ended') this.promote(store);
  }

  /** A tool hook: this session is doing work. */
  noteToolHook(store: SessionStore): void {
    store.toolHooks++;
    if (this.primaryStore !== store && (this.primaryStore === null || this.primaryStore.toolHooks === 0 || this.primaryStore.state !== 'running')) {
      this.promote(store);
    }
  }

  private promote(store: SessionStore): void {
    if (this.primaryStore === store) return;
    if (this.primaryStore !== null) this.opts.log?.(`session          primary ${this.primaryStore.sessionId} -> ${store.sessionId}`);
    this.primaryStore = store;
    // Tell connected clients which session they are now looking at. A client
    // that wants the new session's history refetches /map.
    this.opts.broadcast({ type: 'session', state: store.state, sessionId: store.sessionId });
  }
}
