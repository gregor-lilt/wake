// Session traffic from a real Claude Code transcript.
//
// Format notes (docs/research/04-claude-code-integration.md section 4):
//   - ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<session-uuid>.jsonl
//   - an assistant record carries message.content[] blocks; a tool call is
//     { type:'tool_use', id:'toolu_...', name, input }
//   - the matching user record carries the tool_result block plus a wrapper
//     `toolUseResult`, which for Edit holds structuredPatch[] with the real
//     line ranges of the change
//   - isSidechain is dead; subagents live in <session-uuid>/subagents/
//   - compaction rewrites the parent chain (logicalParentUuid), so events are
//     ordered by timestamp, never by walking parentUuid
//
// Nothing but tool names, paths, line numbers and timestamps is read out. No
// file contents, no oldString/newString, no prompt or assistant prose.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { EventKind, ExportEvent, ExportSession } from './schema.ts';

export function projectSlug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

const KIND_BY_TOOL = new Map<string, EventKind>([
  ['Read', 'read'],
  ['NotebookRead', 'read'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Write', 'write'],
  ['Grep', 'search'],
  ['Glob', 'search'],
  ['Bash', 'run'],
  ['BashOutput', 'run'],
]);

function kindOf(tool: string): EventKind {
  return KIND_BY_TOOL.get(tool) ?? 'other';
}

interface RawRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isMeta?: boolean;
  toolUseResult?: {
    structuredPatch?: { newStart?: number; newLines?: number }[];
  };
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface ToolUseBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly tool_use_id?: string;
}

function blocks(record: RawRecord): ToolUseBlock[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ToolUseBlock => typeof b === 'object' && b !== null && 'type' in b);
}

function readJsonl(path: string): RawRecord[] {
  const out: RawRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as RawRecord);
    } catch {
      // A truncated tail line is normal on a live session. Skip it.
    }
  }
  return out;
}

/** Absolute path of whatever file the tool call names, if it names one. */
function pathOf(input: Record<string, unknown> | undefined, cwd: string | undefined): string | null {
  if (!input) return null;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value !== 'string' || value === '') continue;
    return isAbsolute(value) ? value : resolvePath(cwd ?? '/', value);
  }
  return null;
}

/**
 * Best-effort file target for a shell command. A Bash-heavy session is the
 * normal case for some workflows, and a run event with no position at all is
 * traffic the map cannot draw. Only exact matches against tracked paths are
 * accepted, either repo-relative or absolute under the repository; the command
 * text itself never reaches the export, only the path it names.
 */
function bashTarget(
  command: string,
  repo: string,
  fileIds: Map<string, number>,
): string | null {
  for (const raw of command.split(/[\s'"=,;()[\]{}|&<>]+/)) {
    let token = raw.replace(/^[@+]+/, '').replace(/:\d+(:\d+)?$/, '').replace(/[.,:]+$/, '');
    if (token === '') continue;
    if (token.startsWith(repo)) {
      const rel = relativeTo(repo, token);
      if (rel !== null && rel !== '' && fileIds.has(rel)) return rel;
      continue;
    }
    token = token.replace(/^\.\//, '');
    if (fileIds.has(token)) return token;
  }
  return null;
}

function relativeTo(repo: string, absolute: string): string | null {
  if (absolute === repo) return '';
  if (!absolute.startsWith(`${repo}/`)) return null;
  return absolute.slice(repo.length + 1);
}

export interface Candidate {
  readonly transcript: string;
  readonly sessionId: string;
  /** Tool calls naming a file inside the target repository. */
  readonly repoFileCalls: number;
  /** Of those, the read/edit/write/search ones. */
  readonly repoTouchCalls: number;
  readonly toolCalls: number;
  readonly cwdRecords: number;
  /** Records whose cwd is the target repository root itself, not a subdirectory. */
  readonly exactCwdRecords: number;
}

function listTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 3) walk(full, depth + 1);
      } else if (name.endsWith('.jsonl')) {
        // Subagent transcripts are merged into their parent session, never
        // ranked as sessions of their own.
        if (!full.includes('/subagents/')) out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Score every transcript by how much of it happened inside the target
 * repository. The repository's own project slug is not enough on its own: a
 * session that started elsewhere and then worked in this repository is stored
 * under the other directory's slug, so all slugs are scanned.
 */
export function rankSessions(repo: string, root: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const transcript of listTranscripts(root)) {
    let repoFileCalls = 0;
    let repoTouchCalls = 0;
    let toolCalls = 0;
    let cwdRecords = 0;
    let exactCwdRecords = 0;
    let sessionId = '';
    for (const record of readJsonl(transcript)) {
      if (record.cwd !== undefined && relativeTo(repo, record.cwd) !== null) cwdRecords++;
      if (record.cwd === repo) exactCwdRecords++;
      if (record.sessionId && sessionId === '') sessionId = record.sessionId;
      if (record.type !== 'assistant') continue;
      for (const block of blocks(record)) {
        if (block.type !== 'tool_use' || !block.name) continue;
        toolCalls++;
        const absolute = pathOf(block.input, record.cwd);
        if (absolute === null || relativeTo(repo, absolute) === null) continue;
        repoFileCalls++;
        const kind = kindOf(block.name);
        if (kind === 'read' || kind === 'edit' || kind === 'write' || kind === 'search') {
          repoTouchCalls++;
        }
      }
    }
    if (toolCalls === 0) continue;
    candidates.push({
      transcript,
      sessionId,
      repoFileCalls,
      repoTouchCalls,
      toolCalls,
      cwdRecords,
      exactCwdRecords,
    });
  }
  // A session whose cwd IS the target wins outright: that is the session the
  // caller means. Everything else falls back to the activity score.
  candidates.sort(
    (a, b) =>
      Number(b.exactCwdRecords > 0) - Number(a.exactCwdRecords > 0) ||
      b.repoTouchCalls - a.repoTouchCalls ||
      b.repoFileCalls - a.repoFileCalls ||
      b.cwdRecords - a.cwdRecords ||
      b.toolCalls - a.toolCalls,
  );
  return candidates;
}

export interface SessionResult {
  readonly session: ExportSession;
  readonly stats: {
    readonly toolCalls: number;
    readonly mappedEvents: number;
    readonly unmappedPathEvents: number;
    readonly pathsOutsideRepo: number;
    readonly missingFileNodes: number;
    readonly missingPaths: string[];
    readonly dirTargets: number;
    readonly bashTargets: number;
    readonly editsWithLineRange: number;
    readonly byKind: Record<string, number>;
    readonly durationMs: number;
    readonly subagentTranscripts: number;
    readonly subagentEvents: number;
  };
}

export function buildSession(
  transcript: string,
  repo: string,
  fileIds: Map<string, number>,
  dirPaths: Set<string>,
): SessionResult {
  interface Staged {
    readonly ms: number;
    readonly event: Omit<ExportEvent, 't'>;
  }
  const staged: Staged[] = [];
  let sessionId = '';
  let toolCalls = 0;
  let unmappedPathEvents = 0;
  let pathsOutsideRepo = 0;
  let missingFileNodes = 0;
  let dirTargets = 0;
  let bashTargets = 0;
  let editsWithLineRange = 0;
  let subagentEvents = 0;
  const missingPaths = new Set<string>();

  /**
   * One transcript, main session or subagent. `agentId` is null for the main
   * session and becomes the event's optional `agentId` for a subagent, so
   * parallel agents stay distinguishable on one timeline.
   */
  const ingest = (records: RawRecord[], agentId: string | null): void => {
    // Pass 1: Edit line ranges, from the tool_result side. toolUseResult sits
    // on the wrapper of the user record, the id on its tool_result block. Ids
    // are per transcript, so this map is too.
    const ranges = new Map<string, { start: number; end: number }>();
    for (const record of records) {
      const patch = record.toolUseResult?.structuredPatch;
      if (!patch || patch.length === 0) continue;
      let start = Number.POSITIVE_INFINITY;
      let end = 0;
      for (const hunk of patch) {
        const newStart = hunk.newStart ?? 0;
        const newLines = hunk.newLines ?? 0;
        if (newStart <= 0) continue;
        start = Math.min(start, newStart);
        end = Math.max(end, newStart + Math.max(newLines, 1) - 1);
      }
      if (!Number.isFinite(start) || end === 0) continue;
      for (const block of blocks(record)) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          ranges.set(block.tool_use_id, { start, end });
        }
      }
    }

    // Pass 2: events.
    const tag = agentId === null ? {} : { agentId };
    for (const record of records) {
      if (agentId === null && record.sessionId && sessionId === '') sessionId = record.sessionId;
      const ms = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
      if (!Number.isFinite(ms)) continue;

      if (record.type === 'assistant') {
        for (const block of blocks(record)) {
          if (block.type !== 'tool_use' || !block.name) continue;
          toolCalls++;
          if (agentId !== null) subagentEvents++;
          const tool = block.name;
          const kind = kindOf(tool);
          const absolute = pathOf(block.input, record.cwd);
          let relative: string | null = null;
          let nodeId: number | null = null;

          if (absolute !== null) {
            relative = relativeTo(repo, absolute);
            if (relative === null) {
              pathsOutsideRepo++;
            } else if (relative === '') {
              relative = null; // the repository root itself, e.g. a repo-wide Grep
            } else {
              const id = fileIds.get(relative);
              if (id !== undefined) {
                nodeId = id;
              } else if (dirPaths.has(relative)) {
                // A search scoped to a region. The path is worth keeping; there
                // is no file node to point at, and the schema allows nodeId null.
                dirTargets++;
              } else {
                // Touched during the session but not in the node set: renamed,
                // deleted, or (without --worktree) never committed.
                missingFileNodes++;
                missingPaths.add(relative);
                relative = null;
              }
            }
          } else if (kind === 'run') {
            const command = block.input?.['command'];
            const guess = typeof command === 'string' ? bashTarget(command, repo, fileIds) : null;
            if (guess !== null) {
              relative = guess;
              nodeId = fileIds.get(guess) ?? null;
              bashTargets++;
            }
          } else if (kind !== 'other' && kind !== 'message') {
            unmappedPathEvents++;
          }

          let lineStart: number | null = null;
          let lineEnd: number | null = null;
          if ((kind === 'edit' || kind === 'write') && block.id) {
            const range = ranges.get(block.id);
            if (range) {
              lineStart = range.start;
              lineEnd = range.end;
              if (kind === 'edit') editsWithLineRange++;
            }
          }
          if (kind === 'read' && block.input) {
            const offset = block.input['offset'];
            const limit = block.input['limit'];
            if (typeof offset === 'number' && offset > 0) {
              lineStart = offset;
              lineEnd = typeof limit === 'number' && limit > 0 ? offset + limit - 1 : null;
            }
          }

          staged.push({
            ms,
            event: {
              kind,
              tool,
              nodeId,
              path: relative,
              lineStart,
              lineEnd,
              summary: summarize(tool, kind, relative, block.input),
              ...tag,
            },
          });
        }
        continue;
      }

      if (record.type === 'user' && !record.isMeta) {
        // A prompt, not a tool result. Content is never read, only its existence.
        const content = record.message?.content;
        const isToolResult =
          Array.isArray(content) && blocks(record).some((b) => b.type === 'tool_result');
        if (isToolResult) continue;
        staged.push({
          ms,
          event: {
            kind: 'message',
            tool: agentId === null ? 'user' : 'agent',
            nodeId: null,
            path: null,
            lineStart: null,
            lineEnd: null,
            summary: agentId === null ? 'user message' : 'agent prompt',
            ...tag,
          },
        });
      }
    }
  };

  ingest(readJsonl(transcript), null);

  // Subagents live in <session>/subagents/agent-<id>.jsonl (isSidechain is
  // dead). Their tool calls are merged into the one timeline and tagged, never
  // ranked as a session of their own.
  const subagents = subagentTranscripts(transcript);
  for (const sub of subagents) ingest(readJsonl(sub.path), sub.agentId);

  staged.sort((a, b) => a.ms - b.ms);
  const first = staged[0]?.ms ?? 0;
  const last = staged[staged.length - 1]?.ms ?? first;
  const events: ExportEvent[] = staged.map((s) => ({ t: s.ms - first, ...s.event }));

  const byKind: Record<string, number> = {};
  let mappedEvents = 0;
  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.nodeId !== null) mappedEvents++;
  }

  return {
    session: {
      sessionId,
      transcriptPath: transcript,
      startedAt: new Date(first).toISOString(),
      endedAt: new Date(last).toISOString(),
      events,
    },
    stats: {
      toolCalls,
      mappedEvents,
      unmappedPathEvents,
      pathsOutsideRepo,
      missingFileNodes,
      missingPaths: [...missingPaths].sort(),
      dirTargets,
      bashTargets,
      editsWithLineRange,
      byKind,
      durationMs: last - first,
      subagentTranscripts: subagents.length,
      subagentEvents,
    },
  };
}

/** `<dir>/<session-uuid>/subagents/agent-<id>.jsonl`, sorted for determinism. */
export function subagentTranscripts(
  transcript: string,
): { readonly path: string; readonly agentId: string }[] {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({
      path: join(dir, name),
      agentId: name.replace(/\.jsonl$/, '').replace(/^agent-/, ''),
    }));
}

/**
 * Short, safe label. Tool name plus in-repo path. For Bash only the first word
 * of the command, because arguments carry heredocs, patterns and code. Search
 * patterns are deliberately dropped for the same reason.
 */
function summarize(
  tool: string,
  kind: EventKind,
  relative: string | null,
  input: Record<string, unknown> | undefined,
): string {
  if (kind === 'run') {
    const command = input?.['command'];
    // First word only, and only its basename: an invoked script's full path is
    // not part of the story the map tells, and arguments can contain anything.
    const first = typeof command === 'string' ? (command.trim().split(/\s+/)[0] ?? '') : '';
    const head = first.replace(/^[^A-Za-z0-9_./-]+/, '').replace(/^.*\//, '').slice(0, 40);
    const target = relative === null ? '' : ` ${relative}`;
    return head === '' ? tool : `${tool} ${head}${target}`;
  }
  if (relative !== null) return `${tool} ${relative}`;
  return tool;
}
