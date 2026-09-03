// wake export: one repository at HEAD plus one real Claude Code session,
// written as a single JSON file for the renderer.
//
//   npm run export -- --repo /path/to/repo
//   WAKE_TEST_REPO=/path/to/repo npm run export
//
// The repository is never modified and never read for content beyond what the
// indexer needs: only paths, symbol names, line numbers, sizes and aggregate
// counts reach the output. The output goes to a gitignored directory.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defaultDbPath, readIndex, runIndexer } from './indexdb.ts';
import type { WakeExport } from './schema.ts';
import { buildSession, projectSlug, projectsRoot, rankSessions } from './session.ts';
import { buildTreeAndRects } from './tree.ts';

const WAKE_ROOT = resolve(import.meta.dirname, '..', '..', '..');

interface Args {
  readonly repo: string;
  readonly out: string;
  readonly binary: string;
  readonly db: string | null;
  readonly session: string | null;
  readonly skipIndex: boolean;
  readonly worktree: boolean;
  readonly projects: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  let skipIndex = false;
  let worktree = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--skip-index') {
      skipIndex = true;
      continue;
    }
    if (arg === '--worktree') {
      worktree = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) continue;
    flags.set(arg.slice(2), next);
    i++;
  }

  const repoRaw = flags.get('repo') ?? process.env['WAKE_TEST_REPO'] ?? '';
  if (repoRaw === '') {
    throw new Error(
      'no repository given: pass --repo /path/to/repo or set WAKE_TEST_REPO. ' +
        'There is deliberately no default.',
    );
  }
  const repo = resolve(repoRaw);
  const name = basename(repo);
  return {
    repo,
    out: resolve(flags.get('out') ?? join(WAKE_ROOT, '.wake', 'exports', `${name}.json`)),
    binary: resolve(flags.get('index-binary') ?? join(WAKE_ROOT, 'target', 'release', 'wake-index')),
    db: flags.get('db') ?? null,
    session: flags.get('session') ?? null,
    skipIndex,
    worktree,
    projects: flags.get('projects') ?? projectsRoot(),
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const name = basename(args.repo);
  const commit = git(args.repo, ['rev-parse', 'HEAD']);
  const lines: string[] = [];
  const say = (text: string): void => {
    lines.push(text);
    console.log(text);
  };

  say(`repo            ${args.repo}`);
  say(`commit          ${commit}`);

  // 1. tree + rects, straight out of git via @wake/layout
  const tree = await buildTreeAndRects(args.repo, commit, name, args.worktree);
  say(`tree            ${tree.dirCount} dirs, ${tree.fileCount} files, ${tree.rects.length} rects`);
  if (tree.worktree.enabled) {
    say(
      `worktree        HEAD union working tree: +${tree.worktree.untrackedAdded} untracked files, ` +
        `${tree.worktree.sizesFromDisk} sizes taken from disk, ` +
        `${tree.worktree.missingOnDisk} tracked files absent on disk (kept at HEAD size)`,
    );
  }
  say(`layout extent   ${tree.extent.w}x${tree.extent.h} cells`);
  say(
    `effective lines ${tree.lines.total} over ${tree.lines.counted} files ` +
      `(max ${tree.lines.max}, ${tree.lines.folded} folded above the ${400} cap, ` +
      `${tree.lines.unreadable} binary or unreadable counted as 1)`,
  );

  // 2. symbols and edges from wake-index
  if (!args.skipIndex) {
    const out = runIndexer(args.binary, args.repo);
    for (const line of out.split('\n')) if (line.trim() !== '') lines.push(`  | ${line}`);
  }
  const dbPath = args.db ?? defaultDbPath(args.repo);
  const index = readIndex(dbPath, tree.fileIds, tree.nextId);
  const s = index.stats;
  say(`index db        ${dbPath}`);
  say(
    `index files     ${s.indexedFiles} indexed, ${s.indexedFilesNotInTree} not in the git tree, ` +
      `${tree.fileCount - s.indexedFiles} tracked files not indexed`,
  );
  say(
    `symbols         ${index.symbolNodes.length} nodes ` +
      `(${s.symbolRows} definition rows, ${s.symbolsSkippedNoFile} dropped for a missing file node)`,
  );
  const spanPct =
    index.symbolNodes.length === 0
      ? 0
      : (100 * s.definitionsMultiLine) / index.symbolNodes.length;
  say(
    `symbol spans    ${s.definitionsMultiLine} of ${index.symbolNodes.length} span more than one ` +
      `line (${spanPct.toFixed(1)}%), ${s.definitionsWithParent} carry a parentId`,
  );
  say(
    `imports         ${s.importRows} rows -> ${index.edges.length} file edges; ` +
      `resolved ${s.importsResolvedByIndexer} by wake-index + ${s.importsResolvedByModuleMap} by the ` +
      `module map, unresolved ${s.importsUnresolved}, ` +
      `${s.importsResolvedOutsideTree} resolved outside the tree`,
  );
  say(
    `references      ${s.referenceRows} rows -> ${index.symbolEdges.length} symbol edges ` +
      `(${s.referencesResolvedUniquely} unique-name, ${s.referencesResolvedSameFile} same-file, ` +
      `${s.referencesResolvedViaImport} via an import, ${s.referencesAmbiguous} still ambiguous, ` +
      `${s.referencesUnresolved} no definition in repo)`,
  );

  // 3. session
  const slug = projectSlug(args.repo);
  let transcript = args.session;
  if (transcript === null) {
    const ranked = rankSessions(args.repo, args.projects);
    if (ranked.length === 0) throw new Error(`no Claude Code transcripts found under ${args.projects}`);
    const top = ranked[0]!;
    transcript = top.transcript;
    say(`project slug    ${slug}`);
    say(`sessions ranked ${ranked.length} transcripts scanned, top 3:`);
    for (const c of ranked.slice(0, 3)) {
      lines.push(
        `  | ${basename(c.transcript)} exactCwd=${c.exactCwdRecords} touch=${c.repoTouchCalls} ` +
          `fileCalls=${c.repoFileCalls} cwdRecords=${c.cwdRecords} tools=${c.toolCalls}`,
      );
      console.log(lines[lines.length - 1]);
    }
  }
  const session = buildSession(transcript, args.repo, tree.fileIds, tree.dirPaths);
  const ss = session.stats;
  say(`session         ${session.session.sessionId}`);
  say(`  transcript    ${session.session.transcriptPath}`);
  say(`  window        ${session.session.startedAt} -> ${session.session.endedAt}`);
  say(`  duration      ${(ss.durationMs / 3_600_000).toFixed(2)} h (${ss.durationMs} ms)`);
  say(`  events        ${session.session.events.length} (${ss.mappedEvents} mapped to a file node)`);
  say(`  by kind       ${JSON.stringify(ss.byKind)}`);
  say(`  subagents     ${ss.subagentTranscripts} transcripts merged, ${ss.subagentEvents} tool events tagged`);
  say(
    `  messages      ${ss.messagesByRole.assistant} assistant, ${ss.messagesByRole.user} user, ` +
      `${ss.emptyMessagesSkipped} empty skipped, ${ss.thinkingEvents} thinking-only turns`,
  );
  say(
    `  paths         ${ss.pathsOutsideRepo} outside the repo, ${ss.dirTargets} targeting a directory, ` +
      `${ss.bashTargets} shell commands matched to a file, ` +
      `${ss.missingFileNodes} in-repo paths with no node at HEAD, ` +
      `${ss.editsWithLineRange} edits with a structuredPatch line range`,
  );

  // 4. validate
  const nodes = [...tree.nodes, ...index.symbolNodes];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const problems: string[] = [];
  for (const [id] of tree.rects.map((r) => [r[0]])) {
    if (!byId.has(id as number)) problems.push(`rect for unknown node ${String(id)}`);
  }
  const isFile = (id: number): boolean => byId.get(id)?.kind === 'file';
  const isSymbol = (id: number): boolean => byId.get(id)?.kind === 'symbol';
  for (const rect of tree.rects) {
    const kind = byId.get(rect[0])?.kind;
    if (kind !== 'file' && kind !== 'dir') problems.push(`rect on a ${String(kind)} node`);
  }
  for (const edge of index.edges) {
    if (!isFile(edge.from) || !isFile(edge.to)) problems.push(`import edge off a non-file node`);
  }
  for (const edge of index.symbolEdges) {
    if (!isSymbol(edge.from) || !isSymbol(edge.to)) problems.push(`symbol edge off a non-symbol node`);
  }
  for (const node of nodes) {
    if (node.parent !== null && !byId.has(node.parent)) problems.push(`node ${node.id} has no parent`);
  }
  const pathOf = new Map(nodes.map((n) => [n.id, n.path]));
  for (const node of index.symbolNodes) {
    if (node.lineStart === null || node.lineEnd === null) {
      problems.push(`symbol ${node.id} has no line range`);
      continue;
    }
    if (node.lineStart < 1) problems.push(`symbol ${node.id} starts before line 1`);
    if (node.lineEnd < node.lineStart) problems.push(`symbol ${node.id} has lineEnd < lineStart`);
    if (node.parentId === undefined) continue;
    const parent = byId.get(node.parentId);
    if (parent === undefined || parent.kind !== 'symbol') {
      problems.push(`symbol ${node.id} parentId is not a symbol node`);
      continue;
    }
    if (pathOf.get(node.parentId) !== node.path) {
      problems.push(`symbol ${node.id} parentId is in another file`);
    } else if (
      parent.lineStart === null ||
      parent.lineEnd === null ||
      parent.lineStart > node.lineStart ||
      parent.lineEnd < node.lineEnd
    ) {
      problems.push(`symbol ${node.id} is not contained in its parentId's span`);
    }
  }
  for (const event of session.session.events) {
    if (event.nodeId !== null && !isFile(event.nodeId)) problems.push(`event nodeId is not a file`);
    if (typeof event.title !== 'string' || event.title === '') problems.push(`event without a title`);
    if (event.kind === 'message' && (!event.text || !event.role)) {
      problems.push(`message event without text or role`);
    }
    if (event.kind === 'run' && !event.command) problems.push(`run event without a command`);
  }
  const rectIds = new Set(tree.rects.map((r) => r[0]));
  for (const node of tree.nodes) {
    if (!rectIds.has(node.id)) problems.push(`no rect for ${node.kind} node ${node.id}`);
  }
  say(`validation      ${problems.length === 0 ? 'ok' : `${problems.length} PROBLEMS`}`);
  for (const p of [...new Set(problems)].slice(0, 10)) say(`  ! ${p}`);

  const payload: WakeExport = {
    schemaVersion: 3,
    repo: { name, path: args.repo, commit, generatedAt: new Date().toISOString() },
    nodes,
    rects: tree.rects,
    edges: index.edges,
    symbolEdges: index.symbolEdges,
    session: session.session,
  };

  mkdirSync(join(args.out, '..'), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(payload)}\n`);
  writeFileSync(`${args.out.replace(/\.json$/, '')}.summary.txt`, `${lines.join('\n')}\n`);
  say(`written         ${args.out}`);

  if (problems.length > 0) process.exitCode = 1;
}

await main();
