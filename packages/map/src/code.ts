/**
 * Source and diff store for the two code tiers.
 *
 * Everything is dev-only and driven by the export: the text comes from
 * /file?data=&path=, the diff from /diff?data=&path=, both served by the Vite
 * middleware out of the exported repository's own checkout. Tokens are
 * produced once per (content hash, theme) in the worker and shared by the
 * schematic and the source tier.
 *
 * The store never blocks a frame: request() enqueues, get() returns what is
 * ready, and the renderer draws the plain city rect until then.
 */
import type { TokenLang, TokenReply, TokenRequest } from './tokens.worker';
import { parseUnifiedDiff, emptyDiff } from './diff';
import type { FileDiff } from './diff';

export interface CodeFile {
  file: number;
  path: string;
  lang: TokenLang;
  text: string;
  lines: string[];
  lineCount: number;
  maxCols: number;
  runs: Uint32Array;
  lineRunStart: Uint32Array;
  /** rgb triplets */
  palette: Uint8Array;
  diff: FileDiff;
  tokenMs: number;
}

const LANG_OF_EXT: Record<string, TokenLang> = {
  py: 'python',
  pyi: 'python',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown'
};

export function langOf(path: string): TokenLang {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'plain';
  return LANG_OF_EXT[path.slice(dot + 1).toLowerCase()] ?? 'plain';
}

/** FNV-1a over the text, enough to key a token cache. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(36) + ':' + s.length;
}

interface Tokens {
  runs: Uint32Array;
  lineRunStart: Uint32Array;
  palette: Uint8Array;
  lineCount: number;
  maxCols: number;
  ms: number;
}

const MAX_LINES = 12_000;

function newWorker(): Worker {
  return new Worker(new URL('./tokens.worker.ts', import.meta.url), { type: 'module' });
}

/** A worker warmed by warmTokenWorker(), waiting to be adopted by a store. */
let warmed: Worker | null = null;

/**
 * Start the tokenizer worker and force Shiki's highlighter to be built inside
 * it, which is the expensive half of the first tokenize (module load, grammar
 * and theme registration). The warm worker is then adopted by the CodeStore,
 * so this is real startup work moved in front of the loader, not a probe.
 * Resolves with the elapsed milliseconds.
 */
export function warmTokenWorker(theme: 'dark' | 'light'): Promise<number> {
  const t0 = performance.now();
  const w = warmed ?? newWorker();
  warmed = w;
  return new Promise<number>((resolve) => {
    // id 0 is reserved for the warm-up, so a store that adopts this worker
    // cannot confuse a late reply with one of its own requests.
    const req: TokenRequest = { id: 0, lang: 'typescript', theme, code: 'const wake = 1\n' };
    w.onmessage = () => {
      w.onmessage = null;
      resolve(performance.now() - t0);
    };
    w.postMessage(req);
  });
}

/**
 * Where a file's current text and its diff against HEAD come from. The static
 * export path reads them from the dev server's export middleware; a daemon
 * serves the same two endpoints without the `data` parameter. Everything else
 * in the code view is the same either way.
 */
export interface CodeSource {
  text(path: string): Promise<string>;
  diff(path: string): Promise<string>;
}

/** The `?data=<name>` source: the export middleware of vite/export-data.ts. */
export function exportSource(dataName: string, diffRev = ''): CodeSource {
  const q = (path: string) => `data=${encodeURIComponent(dataName)}&path=${encodeURIComponent(path)}`;
  return {
    async text(path) {
      const res = await fetch(`/file?${q(path)}`);
      if (!res.ok) throw new Error(`file ${res.status}`);
      return res.text();
    },
    async diff(path) {
      const res = await fetch(`/diff?${q(path)}${diffRev ? `&rev=${encodeURIComponent(diffRev)}` : ''}`);
      return res.ok ? res.text() : '';
    }
  };
}

/** A daemon serving docs/protocol.md's `/file` and `/diff` at `base`. */
export function daemonSource(base: string): CodeSource {
  const url = (kind: string, path: string) => `${base.replace(/\/$/, '')}/${kind}?path=${encodeURIComponent(path)}`;
  return {
    async text(path) {
      const res = await fetch(url('file', path));
      if (!res.ok) throw new Error(`file ${res.status}`);
      return res.text();
    },
    async diff(path) {
      const res = await fetch(url('diff', path)).catch(() => null);
      return res && res.ok ? res.text() : '';
    }
  };
}

export class CodeStore {
  private worker: Worker;
  private pending = new Map<number, (r: TokenReply) => void>();
  private nextId = 1;
  private text = new Map<number, string>();
  private diffs = new Map<number, FileDiff>();
  private tokens = new Map<string, Tokens>();
  private ready = new Map<number, CodeFile>();
  private queue: Array<{ file: number; priority: number }> = [];
  private inFlight = 0;
  private failed = new Set<number>();
  /** files whose tokens must be redone after a theme switch */
  private theme: 'dark' | 'light';

  stats = { fetched: 0, tokenized: 0, tokenMs: 0, failed: 0 };

  constructor(
    private source: CodeSource,
    theme: 'dark' | 'light',
    private pathOf: (file: number) => string | null,
    private onReady: (file: number) => void
  ) {
    this.theme = theme;
    // Adopt the worker the loader warmed, if there is one.
    this.worker = warmed ?? newWorker();
    warmed = null;
    this.worker.onmessage = (ev: MessageEvent<TokenReply>) => {
      const done = this.pending.get(ev.data.id);
      this.pending.delete(ev.data.id);
      if (done) done(ev.data);
    };
  }

  /**
   * A file changed on disk (an `invalidate` frame): drop its text, its diff
   * and its tokens and fetch it again at the priority it already had.
   */
  invalidate(file: number): void {
    const had = this.ready.has(file) || this.text.has(file);
    this.text.delete(file);
    this.diffs.delete(file);
    this.ready.delete(file);
    this.failed.delete(file);
    if (had) this.request(file, 1);
  }

  /** Stop the tokenizer worker. */
  destroy(): void {
    this.pending.clear();
    this.queue.length = 0;
    this.worker.terminate();
  }

  setTheme(theme: 'dark' | 'light'): void {
    if (theme === this.theme) return;
    this.theme = theme;
    const again = [...this.ready.keys()];
    this.ready.clear();
    for (const f of again) this.request(f, 1);
  }

  get(file: number): CodeFile | undefined {
    return this.ready.get(file);
  }

  has(file: number): boolean {
    return this.ready.has(file);
  }

  /** Enqueue a file. Higher priority is served first. Idempotent. */
  request(file: number, priority: number): void {
    if (this.ready.has(file) || this.failed.has(file)) return;
    const found = this.queue.find((q) => q.file === file);
    if (found) {
      if (priority > found.priority) found.priority = priority;
      return;
    }
    if (this.pathOf(file) === null) {
      this.failed.add(file);
      return;
    }
    this.queue.push({ file, priority });
    this.pump();
  }

  /** Drop everything not in `keep`, so a long pan does not grow forever. */
  trim(keep: Set<number>, limit = 120): void {
    if (this.ready.size <= limit) return;
    for (const f of [...this.ready.keys()]) {
      if (this.ready.size <= limit) break;
      if (!keep.has(f)) this.ready.delete(f);
    }
  }

  /** True once the file is loaded and tokenized, or known to be unusable. */
  private settled(file: number): boolean {
    return this.ready.has(file) || this.failed.has(file);
  }

  /**
   * Load and tokenize `files`, reporting how many have settled as they land.
   * Used by the loader for the files the opening view shows, so the first
   * zoom into a sheet has its tokens already. Gives up after `timeoutMs` so a
   * stuck fetch can never hold the splash on screen.
   */
  async whenReady(
    files: number[],
    onProgress: (done: number, total: number) => void,
    timeoutMs = 15_000
  ): Promise<number> {
    for (const f of files) this.request(f, 100);
    const deadline = performance.now() + timeoutMs;
    let done = -1;
    for (;;) {
      const n = files.reduce((s, f) => s + (this.settled(f) ? 1 : 0), 0);
      if (n !== done) {
        done = n;
        onProgress(n, files.length);
      }
      if (n >= files.length || performance.now() > deadline) return n;
      await new Promise<void>((r) => setTimeout(r, 25));
    }
  }

  private pump(): void {
    while (this.inFlight < 4 && this.queue.length > 0) {
      this.queue.sort((a, b) => b.priority - a.priority);
      const next = this.queue.shift();
      if (!next) return;
      this.inFlight++;
      void this.load(next.file).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async load(file: number): Promise<void> {
    const path = this.pathOf(file);
    if (path === null) return;
    try {
      let text = this.text.get(file);
      if (text === undefined) {
        const [body, diff] = await Promise.all([this.source.text(path), this.source.diff(path)]);
        text = body;
        this.text.set(file, text);
        this.diffs.set(file, diff ? parseUnifiedDiff(diff) : emptyDiff());
        this.stats.fetched++;
      }
      const lang = langOf(path);
      const key = `${hash(text)}|${lang}|${this.theme}`;
      let tok = this.tokens.get(key);
      if (!tok) {
        const lineCount = 1 + (text.match(/\n/g)?.length ?? 0);
        if (lineCount > MAX_LINES) {
          this.failed.add(file);
          this.stats.failed++;
          return;
        }
        tok = await this.tokenizeIn(text, lang);
        if (this.tokens.size > 200) this.tokens.clear();
        this.tokens.set(key, tok);
        this.stats.tokenized++;
        this.stats.tokenMs += tok.ms;
      }
      this.ready.set(file, {
        file,
        path,
        lang,
        text,
        lines: text.split('\n'),
        lineCount: tok.lineCount,
        maxCols: tok.maxCols,
        runs: tok.runs,
        lineRunStart: tok.lineRunStart,
        palette: tok.palette,
        diff: this.diffs.get(file) ?? emptyDiff(),
        tokenMs: tok.ms
      });
      this.onReady(file);
    } catch {
      this.failed.add(file);
      this.stats.failed++;
    }
  }

  private tokenizeIn(code: string, lang: TokenLang): Promise<Tokens> {
    const id = this.nextId++;
    const req: TokenRequest = { id, lang, theme: this.theme, code };
    return new Promise<Tokens>((resolve) => {
      this.pending.set(id, (r) =>
        resolve({
          runs: r.runs,
          lineRunStart: r.lineRunStart,
          palette: r.palette,
          lineCount: r.lineCount,
          maxCols: r.maxCols,
          ms: r.ms
        })
      );
      this.worker.postMessage(req);
    });
  }
}
