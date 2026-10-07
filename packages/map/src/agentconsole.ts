/**
 * The agent console (docs/design.md section 10). It takes the bottom-left
 * corner the debug panel used to own and replaces the agent card:
 *
 *   header   what the agent is doing right now (the latest event's title, or
 *            "Thinking", or "Session ended · N events"), its real wall-clock
 *            time small and dim, the autopilot chip, a Follow button and the
 *            chevron that expands the log
 *   log      one line per replayed event, newest at the bottom, 7 rows tall
 *            by default and 20 expanded (remembered in localStorage). It
 *            follows the replay unless the user scrolls up, in which case a
 *            small "↓ latest" pill offers the way back.
 *
 * Each line carries the time (HH:MM:SS), a glyph for its kind and text. Tool
 * lines show the export's `title`, run lines add the `command` in dimmed
 * monospace, message lines show the agent's words in a warmer tone with no
 * glyph background, so narration reads apart from actions; user messages get
 * a different glyph and a left rule; subagent lines are indented one step
 * with the agent type as a chip. Clicking a line that has a file flies there,
 * hovering one lights that file's sheet border briefly.
 *
 * Only the lines before the replay cursor exist: the log grows as the replay
 * plays and truncates when the user scrubs back. Only the visible lines are in
 * the DOM (simple windowing over the array), nothing is rebuilt per frame, and
 * the log is touched on event boundaries only. Same visual language as the
 * jump bar: opaque ground, hairline border, tracked small caps for the chips.
 */

export type LineKind =
  | 'read' | 'edit' | 'write' | 'search' | 'run'
  | 'message-assistant' | 'message-user' | 'subagent' | 'other';

/** One line of the log, described once per event when the session loads. */
export interface ConsoleLine {
  kind: LineKind;
  /** HH:MM:SS of the real event, or a session offset */
  time: string;
  /** the title, or the message text */
  text: string;
  /** run lines: the shell command, dimmed monospace after the title */
  command?: string;
  /** subagent lines: the agent type, as a chip */
  agentType?: string;
  /** file node the line flies to, -1 when it names nothing on the map */
  file: number;
}

export interface ConsoleHeader {
  /** the current action */
  action: string;
  /** the real wall-clock time of that event */
  time: string;
  /** 'following' | 'manual' | 'recentering' | 'off' */
  camState: string;
  /** the replay has ended: nothing left to follow, the button is dead */
  idle?: boolean;
}

export interface AgentConsoleHandles {
  /** The whole session, described. The log shows the first `cursor` of them. */
  setLines(lines: ConsoleLine[]): void;
  /** Lines [0, n) exist. Called on event boundaries, not per frame. */
  setCursor(n: number): void;
  /** Per frame is fine: every write is diffed. */
  setHeader(h: ConsoleHeader): void;
  toggleExpanded(force?: boolean): void;
  /**
   * A word about the connection behind the console, or null for none. The
   * shell owns the socket, so it owns this: "daemon offline" while it is
   * reconnecting, nothing while the frames are arriving.
   */
  setStatus(text: string | null): void;
  /**
   * Scroll one line into the window. The log is virtualized, so a line that is
   * scrolled away is not in the DOM at all: this is what a pointer does before
   * it can click an older line, and what the test hook does for it.
   */
  reveal(i: number): void;
  readonly expanded: boolean;
  /** Test hook: what the log is showing. */
  probe(): ConsoleProbe;
}

export interface ConsoleProbe {
  total: number;
  cursor: number;
  rendered: number;
  /** rendered lines, in order: index, kind class and the extra classes */
  lines: Array<{ index: number; kind: LineKind; classes: string[]; hasFile: boolean; text: string }>;
  expanded: boolean;
  following: boolean;
  latestPill: boolean;
  rowsVisible: number;
}

/** Rows of log in each state. */
export const ROWS_COLLAPSED = 7;
export const ROWS_EXPANDED = 20;
/** One row in CSS pixels; a message line takes two. */
export const ROW_PX = 18;
const MESSAGE_ROWS = 2;
const STORAGE_KEY = 'wake.console.expanded';

const GLYPH: Record<LineKind, string> = {
  read: '◇',              // ◇
  edit: '✎',              // ✎
  write: '◆',             // ◆
  search: '⌕',            // ⌕
  run: '$',
  'message-assistant': '“', // “
  'message-user': '›',      // ›
  subagent: '⤷',            // ⤷
  other: '·'                // ·
};

/**
 * A tool call in a short human phrase, the fallback when the export has no
 * `title`. Same shape as the exporter's own titles: the verb, the file's
 * basename, the line range. `summary` is the export's one-liner ("Bash find",
 * "Read src/a/b.py"), so the tool's leading word is stripped from it.
 */
export function fallbackTitle(e: {
  kind: string;
  tool?: string;
  path?: string | null;
  lineStart?: number;
  lineEnd?: number;
  summary?: string;
}): string {
  const path = e.path ?? '';
  const base = path ? path.slice(path.lastIndexOf('/') + 1) : '';
  const range = e.lineStart
    ? ` L${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ''}`
    : '';
  const tail = (() => {
    const sum = (e.summary ?? '').trim();
    if (!sum) return '';
    const tool = (e.tool ?? '').trim();
    if (tool && sum.toLowerCase().startsWith(tool.toLowerCase())) return sum.slice(tool.length).trim();
    return sum;
  })();
  switch (e.kind) {
    case 'edit': return `Edit ${base || tail || 'a file'}${range}`;
    case 'write': return `Write ${base || tail || 'a file'}${range}`;
    case 'read': return `Read ${base || tail || 'a file'}${range}`;
    case 'run': return `Run ${tail || 'a command'}`;
    case 'search': return `Search ${tail || 'the repository'}`;
    case 'message': return 'Thinking';
    case 'subagent': return `Subagent: ${tail || 'task'}`;
    default: return tail || 'Working';
  }
}

export function lineKindOf(kind: string, role?: string): LineKind {
  switch (kind) {
    case 'read': case 'edit': case 'write': case 'search': case 'run': case 'subagent':
      return kind;
    case 'message':
      return role === 'user' ? 'message-user' : 'message-assistant';
    default:
      return 'other';
  }
}

function rowsOf(l: ConsoleLine): number {
  return l.kind === 'message-assistant' || l.kind === 'message-user' ? MESSAGE_ROWS : 1;
}

function readStored(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}
function writeStored(on: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* private window */ }
}

export function buildAgentConsole(
  root: HTMLElement,
  handlers: {
    follow(): void;
    /** a line with a file was clicked */
    go(index: number): void;
    /** the pointer entered a line (index) or left the log (-1) */
    hover(index: number): void;
  }
): AgentConsoleHandles {
  root.innerHTML = `
    <div class="cx-head">
      <span class="cx-action" id="ac-action">—</span>
      <i class="cx-time" id="ac-time"></i>
      <span class="cx-offline" id="ac-offline" hidden></span>
      <span class="cx-chip" id="ac-chip">off</span>
      <button class="cx-follow" id="ac-follow" title="follow the agent">follow</button>
      <button class="cx-chev" id="ac-chev" title="expand the log (l)" aria-expanded="false">▴</button>
    </div>
    <div class="cx-log" id="ac-log"><div class="cx-spacer" id="ac-spacer"></div></div>
    <button class="cx-latest" id="ac-latest" hidden>↓ latest</button>`;
  const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const action = el('ac-action');
  const time = el('ac-time');
  const chip = el('ac-chip');
  const offline = el('ac-offline');
  const follow = el('ac-follow') as HTMLButtonElement;
  const chev = el('ac-chev') as HTMLButtonElement;
  const log = el('ac-log');
  const spacer = el('ac-spacer');
  const latest = el('ac-latest') as HTMLButtonElement;

  let lines: ConsoleLine[] = [];
  /** top offset of each line in px, plus the total at the end */
  let tops: number[] = [0];
  let cursor = 0;
  let expanded = readStored();
  let following = true;
  /** the DOM node per rendered index, and the key it was filled with */
  const pool = new Map<number, { el: HTMLElement; key: string }>();
  let headerKey = '';

  const rows = () => (expanded ? ROWS_EXPANDED : ROWS_COLLAPSED);
  const applyExpanded = () => {
    root.classList.toggle('expanded', expanded);
    log.style.height = `${rows() * ROW_PX}px`;
    chev.textContent = expanded ? '▾' : '▴';
    chev.title = expanded ? 'collapse the log (l)' : 'expand the log (l)';
    chev.setAttribute('aria-expanded', String(expanded));
  };

  const totalHeight = () => tops[Math.min(cursor, lines.length)];

  const fill = (node: HTMLElement, i: number): void => {
    const l = lines[i];
    node.className = `cx-line k-${l.kind}${l.file >= 0 ? ' has-file' : ''}`;
    node.dataset.i = String(i);
    node.style.top = `${tops[i]}px`;
    node.style.height = `${rowsOf(l) * ROW_PX}px`;
    // Built once per line, on entry into the window: textContent everywhere,
    // never innerHTML with event text in it.
    node.textContent = '';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = l.time;
    const g = document.createElement('i');
    g.className = 'g';
    g.textContent = GLYPH[l.kind];
    const x = document.createElement('span');
    x.className = 'x';
    if (l.kind === 'subagent' && l.agentType) {
      const c = document.createElement('b');
      c.className = 'chip';
      c.textContent = l.agentType;
      x.appendChild(c);
    }
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = l.text;
    x.appendChild(w);
    if (l.kind === 'run' && l.command) {
      const c = document.createElement('code');
      c.className = 'cmd';
      c.textContent = l.command;
      x.appendChild(c);
    }
    node.append(t, g, x);
  };

  /** Windowing: only the lines that intersect the scroll viewport are in the DOM. */
  const render = (): void => {
    const n = Math.min(cursor, lines.length);
    spacer.style.height = `${totalHeight()}px`;
    const y0 = log.scrollTop;
    const y1 = y0 + log.clientHeight;
    // First line whose bottom is past the top of the viewport.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid + 1] <= y0) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    let last = first;
    while (last < n && tops[last] < y1) last++;
    for (const [i, p] of pool) {
      if (i < first || i >= last) {
        p.el.remove();
        pool.delete(i);
      }
    }
    for (let i = first; i < last; i++) {
      const l = lines[i];
      const key = `${l.kind}|${l.time}|${l.text}|${l.command ?? ''}|${l.agentType ?? ''}|${l.file}|${tops[i]}`;
      const p = pool.get(i);
      if (p && p.key === key) continue;
      const node = p ? p.el : document.createElement('div');
      fill(node, i);
      if (!p) spacer.appendChild(node);
      pool.set(i, { el: node, key });
    }
    latest.hidden = following || n === 0;
  };

  const atBottom = () => log.scrollTop + log.clientHeight >= log.scrollHeight - 2;
  const scrollToEnd = () => { log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight); };

  log.addEventListener('scroll', () => {
    // A scroll to the very end, by hand or by the follow, is a follow; a
    // scroll up parks the log and shows the way back.
    following = atBottom();
    render();
  }, { passive: true });
  latest.onclick = () => {
    following = true;
    scrollToEnd();
    render();
  };
  follow.onclick = () => handlers.follow();
  chev.onclick = () => api.toggleExpanded();
  spacer.addEventListener('click', (ev) => {
    const line = (ev.target as HTMLElement).closest<HTMLElement>('.cx-line');
    if (!line || !line.classList.contains('has-file')) return;
    handlers.go(Number(line.dataset.i));
  });
  let hovered = -1;
  spacer.addEventListener('mouseover', (ev) => {
    const line = (ev.target as HTMLElement).closest<HTMLElement>('.cx-line');
    const i = line ? Number(line.dataset.i) : -1;
    if (i === hovered) return;
    hovered = i;
    handlers.hover(i);
  });
  log.addEventListener('mouseleave', () => {
    if (hovered === -1) return;
    hovered = -1;
    handlers.hover(-1);
  });

  const api: AgentConsoleHandles = {
    setLines(next) {
      lines = next;
      tops = new Array(lines.length + 1);
      tops[0] = 0;
      for (let i = 0; i < lines.length; i++) tops[i + 1] = tops[i] + rowsOf(lines[i]) * ROW_PX;
      cursor = Math.min(cursor, lines.length);
      for (const p of pool.values()) p.el.remove();
      pool.clear();
      render();
    },
    setCursor(n) {
      const next = Math.max(0, Math.min(n, lines.length));
      if (next === cursor) return;
      const grew = next > cursor;
      cursor = next;
      spacer.style.height = `${totalHeight()}px`;
      if (following && grew) scrollToEnd();
      // A scroll the browser clamps (the log truncated) fires no scroll
      // event, and neither does one that did not move, so render here too.
      render();
    },
    setHeader(h) {
      const key = `${h.action}|${h.time}|${h.camState}|${h.idle ? 'i' : ''}`;
      if (key === headerKey) return;
      headerKey = key;
      action.textContent = h.action;
      time.textContent = h.time;
      follow.disabled = h.idle === true;
      chip.textContent = h.camState;
      chip.classList.toggle('live', h.camState === 'following');
      chip.classList.toggle('manual', h.camState === 'manual');
    },
    setStatus(text) {
      offline.hidden = !text;
      offline.textContent = text ?? '';
    },
    reveal(i) {
      if (lines.length === 0) return;
      const at = Math.max(0, Math.min(i, lines.length - 1));
      following = false;
      log.scrollTop = tops[at];
      render();
    },
    toggleExpanded(force) {
      const next = force ?? !expanded;
      if (next === expanded) return;
      expanded = next;
      writeStored(expanded);
      applyExpanded();
      if (following) scrollToEnd();
      render();
    },
    get expanded() { return expanded; },
    probe() {
      const out = [...pool.entries()].sort((a, b) => a[0] - b[0]).map(([i, p]) => ({
        index: i,
        kind: lines[i].kind,
        classes: [...p.el.classList],
        hasFile: lines[i].file >= 0,
        text: p.el.querySelector('.w')?.textContent ?? ''
      }));
      return {
        total: lines.length,
        cursor: Math.min(cursor, lines.length),
        rendered: pool.size,
        lines: out,
        expanded,
        following,
        latestPill: !latest.hidden,
        rowsVisible: rows()
      };
    }
  };
  applyExpanded();
  return api;
}
