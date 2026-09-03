/**
 * Tokenizer worker. One Shiki instance, fine-grained bundle, JS RegExp engine
 * (no wasm, instant startup), six languages, one theme per appearance.
 *
 * One codeToTokens pass per file feeds both code tiers: the schematic draws
 * one GPU rect per run, the source wraps the same runs in spans. Runs are maximal non-whitespace
 * spans inside a token, which is what gives the minimap its word shapes, and
 * what lets the source rebuild the exact line by slicing the gaps back out.
 *
 * Output is typed arrays, transferred, never objects per token.
 */
import { createHighlighterCore } from '@shikijs/core';
import type { HighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import python from '@shikijs/langs/python';
import typescript from '@shikijs/langs/typescript';
import tsx from '@shikijs/langs/tsx';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import markdown from '@shikijs/langs/markdown';
import darkTheme from '@shikijs/themes/github-dark-default';
import lightTheme from '@shikijs/themes/github-light-default';

export type TokenLang = 'python' | 'typescript' | 'tsx' | 'javascript' | 'json' | 'markdown' | 'plain';

export interface TokenRequest {
  id: number;
  lang: TokenLang;
  theme: 'dark' | 'light';
  code: string;
}

export interface TokenReply {
  id: number;
  lineCount: number;
  maxCols: number;
  /** 3 uint32 per run: startCol, len, colorIndex */
  runs: Uint32Array;
  /** run index where each line starts, length lineCount + 1 */
  lineRunStart: Uint32Array;
  /** rgb triplets, colorIndex * 3 */
  palette: Uint8Array;
  ms: number;
  error?: string;
}

const THEME_NAME = { dark: 'github-dark-default', light: 'github-light-default' } as const;
const FALLBACK_FG = { dark: '#c9d1d9', light: '#24292f' } as const;

let hl: HighlighterCore | null = null;
async function highlighter(): Promise<HighlighterCore> {
  if (!hl) {
    hl = await createHighlighterCore({
      langs: [python, typescript, tsx, javascript, json, markdown],
      themes: [darkTheme, lightTheme],
      engine: createJavaScriptRegexEngine()
    });
  }
  return hl;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 13 || c === 12 || c === 11;

/** Growable uint32 sink. */
class U32 {
  private buf = new Uint32Array(4096);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.buf.length) {
      const next = new Uint32Array(Math.max(this.buf.length * 2, this.length + 3));
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf[this.length++] = a;
    this.buf[this.length++] = b;
    this.buf[this.length++] = c;
  }
  take(): Uint32Array {
    return this.buf.slice(0, this.length);
  }
}

class Palette {
  private index = new Map<string, number>();
  private rgb: number[] = [];
  of(hex: string): number {
    const found = this.index.get(hex);
    if (found !== undefined) return found;
    const i = this.index.size;
    this.index.set(hex, i);
    const h = hex.replace('#', '');
    const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const v = parseInt(s.padEnd(6, '0'), 16);
    this.rgb.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
    return i;
  }
  take(): Uint8Array {
    return new Uint8Array(this.rgb);
  }
}

/** Split one line into non-whitespace runs, all in one colour. */
function plainLine(line: string, from: number, color: number, runs: U32): void {
  let i = 0;
  while (i < line.length) {
    if (isSpace(line.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < line.length && !isSpace(line.charCodeAt(i))) i++;
    runs.push3(from + start, i - start, color);
  }
}

async function tokenize(req: TokenRequest): Promise<TokenReply> {
  const t0 = performance.now();
  const lines = req.code.split('\n');
  const palette = new Palette();
  const runs = new U32();
  const lineRunStart = new Uint32Array(lines.length + 1);
  let maxCols = 1;
  let error: string | undefined;

  const fallback = palette.of(FALLBACK_FG[req.theme]);
  let colored: Array<Array<{ offset: number; content: string; color?: string }>> | null = null;
  if (req.lang !== 'plain') {
    try {
      const h = await highlighter();
      const out = h.codeToTokens(req.code, { lang: req.lang, theme: THEME_NAME[req.theme] });
      colored = out.tokens;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  // Absolute offset of every line start, so a token's absolute offset becomes
  // a column.
  let abs = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    lineRunStart[ln] = runs.length / 3;
    if (line.length > maxCols) maxCols = line.length;
    const toks = colored ? colored[ln] : null;
    if (toks && toks.length > 0) {
      for (const t of toks) {
        const col = t.offset - abs;
        if (col < 0 || col > line.length) continue;
        plainLine(t.content, col, t.color ? palette.of(t.color) : fallback, runs);
      }
    } else if (line.length > 0) {
      plainLine(line, 0, fallback, runs);
    }
    abs += line.length + 1;
  }
  lineRunStart[lines.length] = runs.length / 3;

  return {
    id: req.id,
    lineCount: lines.length,
    maxCols,
    runs: runs.take(),
    lineRunStart,
    palette: palette.take(),
    ms: Math.round(performance.now() - t0),
    error
  };
}

self.onmessage = (ev: MessageEvent<TokenRequest>) => {
  void tokenize(ev.data).then((reply) => {
    (self as unknown as { postMessage(m: TokenReply, t: Transferable[]): void }).postMessage(reply, [
      reply.runs.buffer,
      reply.lineRunStart.buffer,
      reply.palette.buffer
    ]);
  });
};
