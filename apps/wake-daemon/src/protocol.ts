// Wire types for docs/protocol.md, version 1. The document model is the
// export schema (packages/export/src/schema.ts); everything here is either
// that schema or a thin frame around it.

import type {
  ExportEdge,
  ExportEvent,
  ExportNode,
  ExportRect,
  ExportRepo,
} from '../../../packages/export/src/schema.ts';

export const PROTOCOL_VERSION = 1;

/** The export's session event plus a monotonic id and a wall-clock stamp. */
export interface SessionEvent extends ExportEvent {
  readonly id: number;
  readonly wall: string;
}

export type SessionState = 'idle' | 'running' | 'ended';

export type ServerMessage =
  | { type: 'hello'; protocol: 1; repo: ExportRepo; sessionId: string | null }
  | { type: 'snapshot'; events: SessionEvent[] }
  | { type: 'event'; event: SessionEvent }
  | { type: 'node'; node: ExportNode; rect: ExportRect }
  | { type: 'invalidate'; nodeId: number; effectiveLines: number }
  | { type: 'edges'; added: ExportEdge[]; removed: ExportEdge[] }
  | { type: 'session'; state: SessionState; sessionId: string | null }
  | { type: 'permission'; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'pong' };

export type ClientMessage =
  | {
      type: 'decision';
      requestId: string;
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
    }
  | { type: 'ping' };

/** Frames that are also appended to `.wake/live/<sessionId>.jsonl`. */
export type LoggedMessage = Extract<
  ServerMessage,
  { type: 'event' } | { type: 'node' } | { type: 'invalidate' } | { type: 'edges' } | { type: 'session' }
>;
