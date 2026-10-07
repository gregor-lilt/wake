/**
 * The changes list: every file that differs from the session's baseline (the
 * commit HEAD pointed at when the session started), committed or not, with
 * its added and removed line counts. Top right under the shell's controls,
 * collapsed to one line by default, expanded state remembered.
 *
 *   87 files changed  +4,210 −2,931                                   [▾]
 *   apps/wake-daemon/src/  main.ts                          +408
 *   packages/map/src/      autopilot.ts                       +9   −2
 *
 * Clicking a file takes the wheel from the autopilot and flies to the file's
 * first change at reading zoom. The file the agent is on right now carries
 * the accent. Same visual language as the agent console: opaque ground,
 * hairline border, tabular numbers.
 */

export interface Change {
  path: string;
  added: number;
  removed: number;
  /** new since the baseline */
  created: boolean;
}

export interface ChangesActions {
  go(path: string): void;
}

export interface ChangesHandles {
  set(changes: Change[]): void;
  /** The agent's current file, highlighted when it is in the list. */
  setCurrent(path: string | null): void;
  /** Test hook. */
  state(): { files: number; expanded: boolean };
}

const STORE_KEY = 'wake.changes.expanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeExpanded(on: boolean): void {
  try {
    localStorage.setItem(STORE_KEY, on ? '1' : '0');
  } catch {
    // private window: the default is fine
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function buildChanges(root: HTMLElement, actions: ChangesActions): ChangesHandles {
  root.innerHTML = `
    <button class="ch-head" type="button" aria-expanded="false">
      <span class="ch-count"></span>
      <span class="ch-add"></span>
      <span class="ch-del"></span>
      <span class="ch-chev" aria-hidden="true">▾</span>
    </button>
    <ol class="ch-list"></ol>`;
  const head = root.querySelector<HTMLButtonElement>('.ch-head')!;
  const count = root.querySelector<HTMLSpanElement>('.ch-count')!;
  const add = root.querySelector<HTMLSpanElement>('.ch-add')!;
  const del = root.querySelector<HTMLSpanElement>('.ch-del')!;
  const list = root.querySelector<HTMLOListElement>('.ch-list')!;

  let expanded = readExpanded();
  let changes: Change[] = [];
  let current: string | null = null;
  let renderedKey = '';

  function applyExpanded(): void {
    root.classList.toggle('expanded', expanded);
    head.setAttribute('aria-expanded', String(expanded));
  }

  function render(): void {
    const key = changes.map((c) => `${c.path}:${c.added}:${c.removed}`).join('|');
    if (key !== renderedKey) {
      renderedKey = key;
      let a = 0;
      let r = 0;
      for (const c of changes) {
        a += c.added;
        r += c.removed;
      }
      count.textContent = changes.length === 1 ? '1 file changed' : `${fmt(changes.length)} files changed`;
      add.textContent = `+${fmt(a)}`;
      del.textContent = `−${fmt(r)}`;
      list.textContent = '';
      for (const c of changes) {
        const li = document.createElement('li');
        li.dataset.path = c.path;
        li.title = c.path;
        const slash = c.path.lastIndexOf('/');
        const dir = document.createElement('span');
        dir.className = 'ch-dir';
        // The column truncates from the left (direction rtl), so the deepest
        // directories stay visible. The trailing mark keeps the final slash
        // where it belongs instead of letting rtl move it to the front.
        dir.textContent = slash < 0 ? '' : `${c.path.slice(0, slash + 1)}\u200e`;
        const name = document.createElement('span');
        name.className = 'ch-name';
        name.textContent = c.path.slice(slash + 1);
        if (c.created) name.classList.add('created');
        const plus = document.createElement('span');
        plus.className = 'ch-a';
        plus.textContent = c.added > 0 ? `+${fmt(c.added)}` : '';
        const minus = document.createElement('span');
        minus.className = 'ch-r';
        minus.textContent = c.removed > 0 ? `−${fmt(c.removed)}` : '';
        li.append(dir, name, plus, minus);
        li.addEventListener('click', () => actions.go(c.path));
        list.appendChild(li);
      }
      root.hidden = changes.length === 0;
    }
    for (const li of list.children) {
      (li as HTMLElement).classList.toggle('current', (li as HTMLElement).dataset.path === current);
    }
  }

  head.addEventListener('click', () => {
    expanded = !expanded;
    writeExpanded(expanded);
    applyExpanded();
  });

  applyExpanded();
  root.hidden = true;

  return {
    set(next) {
      changes = next;
      render();
    },
    setCurrent(path) {
      if (path === current) return;
      current = path;
      render();
    },
    state: () => ({ files: changes.length, expanded })
  };
}
