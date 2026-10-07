// Process helpers with a Bun-first implementation and a node:child_process
// fallback. Bun.spawn streams stdout as a web ReadableStream; Node gives a
// Readable. Both are reduced to "call me once per line".

import { isBun } from './server.ts';

export interface LineProcess {
  readonly pid: number | undefined;
  kill(): void;
  /** Resolves with the exit code once the process is gone. */
  readonly exited: Promise<number>;
}

interface BunSubprocess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

interface BunSyncResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface BunProc {
  spawn(cmd: string[], opts: { cwd?: string; stdout: 'pipe'; stderr: 'inherit' | 'pipe' }): BunSubprocess;
  spawnSync(cmd: string[], opts: { cwd?: string; stdout: 'pipe'; stderr: 'pipe' }): BunSyncResult;
}

function bun(): BunProc {
  return (globalThis as unknown as { Bun: BunProc }).Bun;
}

/** Run to completion, return stdout. Throws on a non-zero exit. */
export async function runCapture(cmd: string, args: string[], cwd?: string): Promise<string> {
  if (isBun()) {
    const result = bun().spawnSync([cmd, ...args], { ...(cwd === undefined ? {} : { cwd }), stdout: 'pipe', stderr: 'pipe' });
    const out = new TextDecoder().decode(result.stdout);
    if (result.exitCode !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
    }
    return out;
  }
  const { execFileSync } = await import('node:child_process');
  return execFileSync(cmd, args, { encoding: 'utf8', ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Long-running child; `onLine` gets every stdout line without its newline. */
export async function spawnLines(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  cwd?: string,
): Promise<LineProcess> {
  if (isBun()) {
    const proc = bun().spawn([cmd, ...args], { ...(cwd === undefined ? {} : { cwd }), stdout: 'pipe', stderr: 'inherit' });
    void pumpLines(proc.stdout, onLine);
    return { pid: proc.pid, kill: () => proc.kill(), exited: proc.exited };
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(cmd, args, { ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  const exited = new Promise<number>((ok) => child.on('exit', (code) => ok(code ?? -1)));
  return { pid: child.pid, kill: () => child.kill(), exited };
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer !== '') onLine(buffer);
}
