/**
 * The live protocol, client side. One type per server frame of docs/protocol.md
 * version 1. The document a `GET /map` returns is the same schemaVersion 3
 * shape the static export has, so it is `ExportDoc` and lives in exportmap.ts.
 *
 * These are declarations only: nothing here talks to a socket. The shell owns
 * the connection and hands each frame to the map's `applyDelta`.
 */
import type { ExportNode } from './exportmap';
import type { EventKind } from './session';

/** A session event as the wire carries it, plus the daemon's own id and clock. */
export interface WireEvent {
  id?: number;
  wall?: string;
  t: number;
  kind: EventKind;
  tool: string;
  nodeId: number | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  summary: string;
  title?: string;
  text?: string;
  role?: 'assistant' | 'user';
  command?: string;
  agentId?: string;
  agentType?: string;
}

export interface WireEdge {
  from: number;
  to: number;
  kind: string;
  weight: number;
}

export type SessionState = 'idle' | 'running' | 'ended';

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  repo: { name: string; path: string; commit: string; generatedAt?: string };
  sessionId: string | null;
}
export interface SnapshotMessage {
  type: 'snapshot';
  events: WireEvent[];
}
export interface EventMessage {
  type: 'event';
  event: WireEvent;
}
/**
 * A node was added or its rect changed. `node.kind` is "file" for a tile and
 * "dir" for a region that grew or moved because a child changed, so a client
 * that only moves tiles leaves districts behind.
 */
export interface NodeMessage {
  type: 'node';
  node: ExportNode;
  rect: [number, number, number, number, number];
}
export interface InvalidateMessage {
  type: 'invalidate';
  nodeId: number;
  effectiveLines: number;
}
export interface EdgesMessage {
  type: 'edges';
  added: WireEdge[];
  removed: WireEdge[];
}
export interface SessionMessage {
  type: 'session';
  state: SessionState;
  sessionId: string | null;
}
export interface PermissionMessage {
  type: 'permission';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}
export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | HelloMessage
  | SnapshotMessage
  | EventMessage
  | NodeMessage
  | InvalidateMessage
  | EdgesMessage
  | SessionMessage
  | PermissionMessage
  | PongMessage;
