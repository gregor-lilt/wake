/**
 * The agent card (docs/design.md section 10). It takes the bottom-left corner
 * the debug panel used to own:
 *
 *   line 1     what the agent is doing right now, in plain words, with the
 *              real event timestamp small and dim beside it
 *   lines 2-4  the previous three events, fading with age
 *   a chip     the autopilot state (following / manual / recentering) and a
 *              follow button
 *   a bar      session progress, event index over total
 *
 * When the replay has ended and the map has gone quiet, line 1 is
 * "Session ended · N events" and the follow button is disabled: there is
 * nothing left to follow.
 *
 * Same visual language as the jump bar: opaque ground, a hairline border, the
 * pill radius, tracked small caps for the chip. Frame rate and the internal
 * counters are not here at all: they live behind `?debug=1`, which brings the
 * old panel back.
 */

/** One line of the trail. */
export interface AgentEventLine {
  text: string;
  time: string;
}

export interface AgentCardState {
  /** the current action in plain words */
  action: string;
  /** the real wall-clock time of that event, or a session offset */
  time: string;
  /** the previous three events, newest first */
  trail: AgentEventLine[];
  /** 'following' | 'manual' | 'recentering' | 'off' */
  camState: string;
  /** event index and total, for the progress bar */
  index: number;
  total: number;
  /**
   * The replay has ended and there is nothing left to follow. The card says
   * so and the follow button is disabled: there is nothing to follow to.
   */
  idle?: boolean;
}

export interface AgentCardHandles {
  update(s: AgentCardState): void;
}

/** Rows of trail under the current action. */
export const TRAIL_ROWS = 3;

/**
 * A tool call in plain words. The map is not a log viewer: the user should
 * read "Editing" and a path, not a tool name and a JSON blob.
 *
 * `summary` is the export's own one-liner ("Bash find", "Read src/a/b.py"),
 * so the tool's leading word is stripped from it: what is left is the useful
 * half, and for a Bash call that is the command.
 */
export function actionWords(e: {
  kind: string;
  tool?: string;
  path?: string | null;
  lineStart?: number;
  lineEnd?: number;
  summary?: string;
} | null): string {
  if (!e) return 'Waiting for the agent';
  const path = e.path ?? '';
  const range = e.lineStart
    ? ` · L${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ''}`
    : '';
  // "Bash grep" -> "grep": the tool's own name is chrome, the argument is not.
  const tail = (() => {
    const sum = (e.summary ?? '').trim();
    if (!sum) return '';
    const tool = (e.tool ?? '').trim();
    if (tool && sum.toLowerCase().startsWith(tool.toLowerCase())) {
      return sum.slice(tool.length).trim();
    }
    return sum;
  })();
  switch (e.kind) {
    case 'edit':
      return `Editing ${path || tail || 'a file'}${range}`;
    case 'write':
      return `Writing ${path || tail || 'a file'}${range}`;
    case 'read':
      return `Reading ${path || tail || 'a file'}${range}`;
    case 'run':
      return `Running ${tail || 'a command'}`;
    case 'search':
      return `Searching ${tail || 'the repository'}`;
    case 'message':
      return 'Thinking';
    default:
      return tail || 'Working';
  }
}

export function buildAgentCard(
  root: HTMLElement,
  handlers: { follow(): void }
): AgentCardHandles {
  const trail = Array.from({ length: TRAIL_ROWS }, (_, i) => `<div class="ac-past" id="ac-p${i}">` +
    `<span class="t"></span><i class="w"></i></div>`).join('');
  root.innerHTML = `
    <div class="ac-now"><span class="t" id="ac-action">—</span><i class="w" id="ac-time"></i></div>
    <div class="ac-trail">${trail}</div>
    <div class="ac-foot">
      <span class="ac-chip" id="ac-chip">off</span>
      <button id="ac-follow">follow</button>
      <span class="ac-count" id="ac-count"></span>
    </div>
    <div class="ac-bar"><i id="ac-fill"></i></div>`;
  const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const action = el('ac-action');
  const time = el('ac-time');
  const chip = el('ac-chip');
  const count = el('ac-count');
  const fill = el('ac-fill');
  const follow = el('ac-follow') as HTMLButtonElement;
  const rows = Array.from({ length: TRAIL_ROWS }, (_, i) => {
    const row = el(`ac-p${i}`);
    return {
      row,
      text: row.querySelector<HTMLElement>('.t')!,
      when: row.querySelector<HTMLElement>('.w')!
    };
  });
  follow.onclick = () => handlers.follow();

  let key = '';
  return {
    update(s) {
      // The card is DOM in a per-frame loop, so every write is diffed: a
      // session at one event per 1.5 s would otherwise rewrite eight nodes
      // sixty times a second for nothing.
      const next = `${s.action}|${s.time}|${s.camState}|${s.index}/${s.total}|${s.idle ? 'i' : ''}|` +
        s.trail.map((t) => `${t.text}@${t.time}`).join(';');
      if (next === key) return;
      key = next;
      action.textContent = s.action;
      time.textContent = s.time;
      for (let i = 0; i < rows.length; i++) {
        const t = s.trail[i];
        rows[i].row.hidden = !t;
        if (!t) continue;
        rows[i].text.textContent = t.text;
        rows[i].when.textContent = t.time;
        // Fading with age: the oldest line is the faintest.
        rows[i].row.style.opacity = String(0.62 - i * 0.16);
      }
      // Nothing to follow to: the button is dead rather than misleading.
      follow.disabled = s.idle === true;
      chip.textContent = s.camState;
      chip.classList.toggle('live', s.camState === 'following');
      chip.classList.toggle('manual', s.camState === 'manual');
      count.textContent = s.total > 0 ? `${Math.min(s.index, s.total)} / ${s.total}` : '';
      fill.style.width = `${s.total > 0 ? Math.round((100 * Math.min(s.index, s.total)) / s.total) : 0}%`;
    }
  };
}
