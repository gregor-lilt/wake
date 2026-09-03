/**
 * Unified diff parsing, reduced to what the two code tiers need:
 *
 *  - per current-text line: added / modified, so the schematic can draw a
 *    margin band and the source a
 *    tint,
 *  - removals anchored at the current-text line they sat in front of, with
 *    their text, so the source can show the pre-image and collapse it when
 *    the edit
 *    lands.
 *
 * "Modified" is a removal run immediately followed by an addition run inside
 * one hunk, which is how a human reads an edited line.
 */
export type LineChange = 'add' | 'mod';

export interface Removal {
  /** current-text line index (0 based) this block sits in front of */
  at: number;
  lines: string[];
  /** paired with an addition run, so it is a modification, not a deletion */
  paired: boolean;
}

export interface FileDiff {
  /** current-text line index -> change */
  changed: Map<number, LineChange>;
  removals: Removal[];
  added: number;
  removed: number;
  hunks: number;
}

const EMPTY: FileDiff = { changed: new Map(), removals: [], added: 0, removed: 0, hunks: 0 };

export function emptyDiff(): FileDiff {
  return EMPTY;
}

/**
 * `text` may hold several concatenated diffs (unstaged then staged), so every
 * @@ header is handled independently and the last one wins on overlap.
 */
export function parseUnifiedDiff(text: string): FileDiff {
  if (!text.trim()) return EMPTY;
  const changed = new Map<number, LineChange>();
  const removals: Removal[] = [];
  let added = 0;
  let removed = 0;
  let hunks = 0;

  const lines = text.split('\n');
  let newLine = -1; // 0-based index into the current text
  let pendingRemoval: string[] = [];
  let pendingAt = 0;

  const flush = (paired: boolean): void => {
    if (pendingRemoval.length === 0) return;
    removals.push({ at: pendingAt, lines: pendingRemoval, paired });
    pendingRemoval = [];
  };

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      flush(false);
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m ? Math.max(0, Number(m[1]) - 1) : -1;
      hunks++;
      continue;
    }
    if (newLine < 0) continue;
    const c = raw.charCodeAt(0);
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (c === 43 /* + */) {
      const paired = pendingRemoval.length > 0;
      if (paired) flush(true);
      changed.set(newLine, paired ? 'mod' : 'add');
      added++;
      newLine++;
    } else if (c === 45 /* - */) {
      if (pendingRemoval.length === 0) pendingAt = newLine;
      pendingRemoval.push(raw.slice(1));
      removed++;
    } else if (c === 92 /* \ (no newline at end of file) */) {
      continue;
    } else {
      flush(false);
      newLine++;
    }
  }
  flush(false);
  return { changed, removals, added, removed, hunks };
}

/** Rows a band should mark: every changed line plus every removal anchor. */
export function bandRows(d: FileDiff): Array<{ line: number; kind: 'add' | 'mod' | 'del' }> {
  const out: Array<{ line: number; kind: 'add' | 'mod' | 'del' }> = [];
  for (const [line, kind] of d.changed) out.push({ line, kind });
  for (const r of d.removals) if (!r.paired) out.push({ line: r.at, kind: 'del' });
  out.sort((a, b) => a.line - b.line);
  return out;
}
