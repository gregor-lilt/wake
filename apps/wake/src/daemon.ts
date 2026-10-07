/**
 * The daemon connection: the HTTP half of docs/protocol.md and the `/live`
 * socket, with reconnection.
 *
 * Nothing here knows about the map. It hands whole server frames to a callback
 * and reports whether the socket is up, which is all the shell needs to feed
 * the map handle and put a word in the console header.
 */
import type { Change, ServerMessage } from '@wake/map';
import type { ExportDoc } from '@wake/map';

export interface Health {
  ok: boolean;
  repo: string;
  sessionId: string | null;
  indexed: boolean;
}

/** Where the socket is, in the terms the console header shows. */
export type Connection = 'connecting' | 'live' | 'offline';

export interface DaemonHandlers {
  onMessage(msg: ServerMessage): void;
  onConnection(state: Connection, attempt: number): void;
}

/** Backoff between reconnects: quick at first, then a few seconds, capped. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];

export class Daemon {
  /** Absolute base, no trailing slash: `http://127.0.0.1:7777`. */
  readonly base: string;
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(base: string, private handlers: DaemonHandlers) {
    this.base = base.replace(/\/+$/, '');
  }

  /** `GET /health`. Throws when the daemon is not there. */
  async health(signal?: AbortSignal): Promise<Health> {
    const res = await fetch(`${this.base}/health`, { signal });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await res.json()) as Health;
  }

  /** `GET /map`: the whole document, a schemaVersion 3 export. */
  async map(signal?: AbortSignal): Promise<ExportDoc> {
    const res = await fetch(`${this.base}/map`, { signal });
    if (!res.ok) throw new Error(`map ${res.status}`);
    return (await res.json()) as ExportDoc;
  }

  /**
   * `GET /changes`: every file that differs from the session's baseline, with
   * line counts. An older daemon without the endpoint answers 404: no list.
   */
  async changes(since: 'head' | 'session' = 'head', signal?: AbortSignal): Promise<Change[]> {
    const res = await fetch(`${this.base}/changes?since=${since}`, { signal });
    if (!res.ok) return [];
    return ((await res.json()) as { files: Change[] }).files;
  }

  /** Open `/live` and keep it open. Safe to call once. */
  connect(): void {
    if (this.closed || this.socket) return;
    const url = `${this.base.replace(/^http/, 'ws')}/live`;
    this.handlers.onConnection(this.attempt === 0 ? 'connecting' : 'offline', this.attempt);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onConnection('live', 0);
    };
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return; // a frame we cannot read is not a reason to drop the socket
      }
      this.handlers.onMessage(msg);
    };
    socket.onerror = () => { /* onclose does the work */ };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.retry();
    };
  }

  private retry(): void {
    if (this.closed) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.handlers.onConnection('offline', this.attempt);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }

  /**
   * Cut the socket without closing the client, so the reconnect path runs.
   * Only scripts/verify.mjs calls this.
   */
  dropForTest(): boolean {
    if (!this.socket) return false;
    this.socket.close();
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

/** The daemon URL for this page: `?daemon=`, else the documented default. */
export const DEFAULT_DAEMON = 'http://127.0.0.1:7777';

export function daemonUrl(search: string): string {
  const q = new URLSearchParams(search);
  const raw = q.get('daemon');
  if (!raw) return DEFAULT_DAEMON;
  try {
    // Only http(s) and only an origin plus path: a socket URL is derived from
    // this, so a stray scheme would open a connection somewhere else.
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_DAEMON;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return DEFAULT_DAEMON;
  }
}
