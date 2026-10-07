// `wake-daemon init --repo <path>`: wire Claude Code's http hooks at the
// daemon and keep `.wake/` out of git, without touching anything else the
// user has in `.claude/settings.local.json`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runCapture } from './runtime.ts';

type Json = Record<string, unknown>;

interface HookSpec {
  readonly event: string;
  /** Tool matcher; omitted for events that have no tool. */
  readonly matcher?: string;
  readonly timeout: number;
  readonly statusMessage: string;
}

/**
 * Timeouts are seconds. Non-gating events get short ones so a slow or dead
 * daemon costs the agent little (an http hook timeout is a non-blocking
 * error). PermissionRequest is the one deliberately long hold. SessionEnd has
 * a 1.5 s budget in Claude Code itself.
 */
export const HOOKS: readonly HookSpec[] = [
  { event: 'SessionStart', timeout: 5, statusMessage: 'Wake: session start' },
  { event: 'UserPromptSubmit', timeout: 5, statusMessage: 'Wake: prompt' },
  { event: 'PreToolUse', matcher: '*', timeout: 10, statusMessage: 'Wake: pre-tool' },
  { event: 'PostToolUse', matcher: '*', timeout: 10, statusMessage: 'Wake: post-tool' },
  { event: 'PostToolBatch', timeout: 10, statusMessage: 'Wake: batch' },
  { event: 'PermissionRequest', matcher: '*', timeout: 600, statusMessage: 'Wake: waiting for a decision in the map' },
  { event: 'SubagentStart', timeout: 5, statusMessage: 'Wake: subagent start' },
  { event: 'SubagentStop', timeout: 5, statusMessage: 'Wake: subagent stop' },
  { event: 'Stop', timeout: 5, statusMessage: 'Wake: stop' },
  { event: 'SessionEnd', timeout: 1, statusMessage: 'Wake: session end' },
];

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook`;
}

/**
 * Merge our http hooks into a settings object. Existing keys are preserved,
 * existing hook groups for the same event are kept, and a group we wrote
 * earlier (identified by its url) is replaced so re-running init is
 * idempotent even when the port changes.
 */
export function mergeHooks(settings: Json, url: string): { settings: Json; added: string[]; replaced: string[] } {
  const out: Json = { ...settings };
  const hooks: Json = typeof out['hooks'] === 'object' && out['hooks'] !== null ? { ...(out['hooks'] as Json) } : {};
  const added: string[] = [];
  const replaced: string[] = [];
  const isOurs = (group: unknown): boolean =>
    typeof group === 'object' &&
    group !== null &&
    Array.isArray((group as Json)['hooks']) &&
    ((group as Json)['hooks'] as unknown[]).some(
      (h) => typeof h === 'object' && h !== null && (h as Json)['type'] === 'http' && isWakeUrl((h as Json)['url']),
    );
  for (const spec of HOOKS) {
    const existing = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    const kept = existing.filter((g) => !isOurs(g));
    if (kept.length !== existing.length) replaced.push(spec.event);
    else added.push(spec.event);
    const group: Json = {
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ type: 'http', url, timeout: spec.timeout, statusMessage: spec.statusMessage }],
    };
    hooks[spec.event] = [...kept, group];
  }
  out['hooks'] = hooks;
  return { settings: out, added, replaced };
}

function isWakeUrl(url: unknown): boolean {
  return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(url);
}

/** `<common git dir>/info/exclude`, correct for worktrees too. */
export async function gitInfoExclude(repo: string): Promise<string> {
  const common = (await runCapture('git', ['-C', repo, 'rev-parse', '--git-common-dir'])).trim();
  const dir = isAbsolute(common) ? common : resolve(repo, common);
  return join(dir, 'info', 'exclude');
}

export async function initRepo(repo: string, port: number): Promise<void> {
  const settingsPath = join(repo, '.claude', 'settings.local.json');
  let settings: Json = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${settingsPath} is not a JSON object`);
    }
    settings = parsed as Json;
  }
  const url = hookUrl(port);
  const merged = mergeHooks(settings, url);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(merged.settings, null, 2)}\n`);
  console.log(`settings         ${settingsPath}`);
  console.log(`hook url         ${url}`);
  if (merged.added.length > 0) console.log(`hooks added      ${merged.added.join(', ')}`);
  if (merged.replaced.length > 0) console.log(`hooks replaced   ${merged.replaced.join(', ')}`);
  const otherKeys = Object.keys(settings).filter((k) => k !== 'hooks');
  console.log(`kept keys        ${otherKeys.length === 0 ? '(none)' : otherKeys.join(', ')}`);

  const exclude = await gitInfoExclude(repo);
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes('.wake/') || lines.includes('.wake')) {
    console.log(`git exclude      ${exclude} already lists .wake/`);
  } else {
    mkdirSync(dirname(exclude), { recursive: true });
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    writeFileSync(exclude, `${current}${sep}.wake/\n`);
    console.log(`git exclude      ${exclude} += .wake/`);
  }
}
