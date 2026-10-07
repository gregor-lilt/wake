/**
 * The debug panel. There is no debug panel in the product (docs/design.md
 * section 10): the agent card has its corner, and this whole panel only exists
 * under `?debug=1`. `buildHud` with `enabled: false` writes nothing to the DOM
 * and returns no-op handles, so the render loop needs no branch.
 */
export interface HudState {
  fps: number;
  frameMs: number;
  zoom: number;
  /** the design's band name: terrain / schematic / reading */
  band: string;
  /** lines per aggregated bar row, 1 above rowPx 1 */
  group: number;
  /** on-screen height of one source line, the number the ladder keys off */
  rowPx: number;
  cities: number;
  labels: number;
  edges: number;
  buildings: number;
  traffic: number;
  /** autopilot */
  camState: string;
  event: string;
  hotRoads: number;
  sessionPct: number;
  /** real wall-clock time of the current event when replaying */
  eventTime: string;
  /** 'off' | 'tile' | 'schematic' | 'source' */
  codeTier: string;
  schematics: number;
  overlays: number;
}

export interface Toggles {
  labels: boolean;
  /** "show all roads": the whole bundled network. Off by default now. */
  edges: boolean;
  traffic: boolean;
  autopilot: boolean;
  theme: 'dark' | 'light';
}

export interface HudHandles {
  update(s: HudState): void;
  setBenchText(text: string): void;
  setStats(text: string): void;
}

/**
 * Panel collapse. Each panel keeps a chevron in its own corner, a keyboard
 * shortcut, and its state in localStorage so a reload comes back the way the
 * user left it. Collapsed, a panel shrinks to a one-line strip.
 */
function collapsible(root: HTMLElement, key: string, shortcut: string, byDefault = false): void {
  const store = `wake.panel.${key}`;
  const chev = document.createElement('button');
  chev.className = 'chev';
  chev.title = `collapse (${shortcut})`;
  root.appendChild(chev);
  let collapsed = byDefault;
  try {
    // Remembered state wins; `byDefault` is only what a first visit gets.
    const saved = localStorage.getItem(store);
    if (saved !== null) collapsed = saved === '1';
  } catch {
    collapsed = byDefault;
  }
  const apply = (): void => {
    root.classList.toggle('collapsed', collapsed);
    chev.textContent = collapsed ? '\u25b8' : '\u25be';
    chev.title = `${collapsed ? 'expand' : 'collapse'} (${shortcut})`;
    try {
      localStorage.setItem(store, collapsed ? '1' : '0');
    } catch {
      /* private mode: the panel still toggles, it just does not persist */
    }
  };
  const toggle = (): void => {
    collapsed = !collapsed;
    apply();
  };
  chev.onclick = toggle;
  window.addEventListener('keydown', (e) => {
    if (e.key !== shortcut || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    toggle();
  });
  apply();
}

export function buildHud(root: HTMLElement, stats: string, enabled = true): HudHandles {
  if (!enabled) {
    root.innerHTML = '';
    return { update() {}, setBenchText() {}, setStats() {} };
  }
  root.innerHTML = `
    <h1>Wake spike 1 &middot; deck.gl</h1>
    <div class="fps"><span id="h-fps">--</span> fps</div>
    <table>
      <tr><td>frame</td><td><span id="h-ms">--</span> ms</td></tr>
      <tr><td>zoom</td><td><span id="h-zoom">--</span></td></tr>
      <tr><td>band</td><td><span id="h-band">--</span></td></tr>
      <tr><td>row</td><td><span id="h-rowpx">--</span> px</td></tr>
      <tr><td>bar group</td><td><span id="h-group">--</span> lines</td></tr>
      <tr><td>cities in view</td><td><span id="h-cities">--</span></td></tr>
      <tr><td>labels drawn</td><td><span id="h-labels">--</span></td></tr>
      <tr><td>roads in view</td><td><span id="h-edges">--</span></td></tr>
      <tr><td>buildings</td><td><span id="h-bld">--</span></td></tr>
      <tr><td>traffic</td><td><span id="h-traffic">--</span></td></tr>
      <tr><td>hot roads</td><td><span id="h-hot">--</span></td></tr>
      <tr><td>code tier</td><td><span id="h-tier">--</span></td></tr>
      <tr><td>schematics</td><td><span id="h-schem">--</span></td></tr>
      <tr><td>source overlays</td><td><span id="h-ov">--</span></td></tr>
    </table>
    <hr />
    <table>
      <tr><td>autopilot</td><td><span id="h-cam">off</span></td></tr>
      <tr><td>session</td><td><span id="h-sess">--</span></td></tr>
      <tr><td>event time</td><td><span id="h-etime">--</span></td></tr>
    </table>
    <div id="h-event" class="event">agent idle</div>
    <hr />
    <div id="h-stats" class="hint"></div>
    <pre id="h-bench" hidden></pre>`;
  const el = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const fps = el('h-fps');
  const ms = el('h-ms');
  const zoom = el('h-zoom');
  const band = el('h-band');
  const rowpx = el('h-rowpx');
  const group = el('h-group');
  const cities = el('h-cities');
  const labels = el('h-labels');
  const edges = el('h-edges');
  const bld = el('h-bld');
  const traffic = el('h-traffic');
  const hot = el('h-hot');
  const tier = el('h-tier');
  const schem = el('h-schem');
  const ov = el('h-ov');
  const cam = el('h-cam');
  const sess = el('h-sess');
  const event = el('h-event');
  const etime = el('h-etime');
  const bench = el('h-bench');
  const statsEl = el('h-stats');
  statsEl.textContent = stats;
  collapsible(root, 'hud', 'h');
  const fmt = (n: number) => n.toLocaleString('en-US');
  return {
    update(s) {
      fps.textContent = s.fps.toFixed(0);
      ms.textContent = s.frameMs.toFixed(1);
      zoom.textContent = s.zoom.toFixed(2);
      band.textContent = s.band;
      rowpx.textContent = s.rowPx.toFixed(2);
      group.textContent = String(s.group);
      cities.textContent = fmt(s.cities);
      labels.textContent = fmt(s.labels);
      edges.textContent = fmt(s.edges);
      bld.textContent = s.buildings > 0 ? fmt(s.buildings) : 'hidden';
      traffic.textContent = s.traffic > 0 ? fmt(s.traffic) : 'off';
      hot.textContent = s.hotRoads > 0 ? fmt(s.hotRoads) : '0';
      tier.textContent = s.codeTier;
      schem.textContent = s.codeTier === 'off' ? '--' : fmt(s.schematics);
      ov.textContent = s.codeTier === 'off' ? '--' : fmt(s.overlays);
      cam.textContent = s.camState;
      sess.textContent = s.sessionPct >= 0 ? `${s.sessionPct.toFixed(0)}%` : '--';
      event.textContent = s.event;
      etime.textContent = s.eventTime;
    },
    setBenchText(text) {
      bench.hidden = text.length === 0;
      bench.textContent = text;
    },
    setStats(text) { statsEl.textContent = text; }
  };
}

export function buildControls(
  root: HTMLElement,
  regionNames: string[],
  handlers: {
    fitAll(): void;
    flyRegion(i: number): void;
    flyLevel(level: 'country' | 'city' | 'street' | 'source'): void;
    toggle(key: keyof Toggles, on: boolean): void;
    setTheme(t: 'dark' | 'light'): void;
    runBench(): void;
    follow(): void;
    pauseAgent(paused: boolean): void;
    setWait(seconds: number): void;
    setTime(seconds: number): void;
    scrub(index: number): void;
    setSpeed(cadenceMs: number): void;
  },
  initial: Toggles & { wait: number; time: number; cadenceMs: number; events: number; scrubbable: boolean }
): { setReplay(cursor: number, count: number): void; setToggle(key: keyof Toggles, on: boolean): void } {
  root.innerHTML = `
    <div class="row" id="c-regions"></div>
    <div class="row">
      <button data-fit="1">fit all</button>
      <button data-level="country">country</button>
      <button data-level="city">city</button>
      <button data-level="street">street</button>
      <button data-level="source">source</button>
    </div>
    <hr />
    <label class="chk"><input type="checkbox" id="t-labels" /> labels</label>
    <label class="chk"><input type="checkbox" id="t-edges" /> show all roads</label>
    <label class="chk"><input type="checkbox" id="t-traffic" /> traffic demo (50/s)</label>
    <label class="chk"><input type="checkbox" id="t-autopilot" /> autopilot (agent session)</label>
    <label class="chk"><input type="checkbox" id="t-theme" /> light theme</label>
    <hr />
    <div class="row">
      <button id="c-follow">follow</button>
      <button id="c-pause">pause agent</button>
    </div>
    <label class="slider">event <span id="v-scrub">0 / ${initial.events}</span>
      <input type="range" id="s-scrub" min="0" max="${Math.max(0, initial.events - 1)}" step="1" value="0" />
    </label>
    <label class="slider">replay speed <span id="v-speed">--</span> s/event
      <input type="range" id="s-speed" min="0.2" max="4" step="0.1" value="${(initial.cadenceMs / 1000).toFixed(1)}" />
    </label>
    <label class="slider">wait <span id="v-wait">--</span> s
      <input type="range" id="s-wait" min="0" max="20" step="0.5" value="${initial.wait}" />
    </label>
    <label class="slider">recenter time <span id="v-time">--</span> s
      <input type="range" id="s-time" min="0.2" max="5" step="0.1" value="${initial.time}" />
    </label>
    <hr />
    <div class="row"><button id="c-bench">run bench (30s)</button></div>
    <div class="hint">drag to pan, scroll to zoom. roads follow the hovered or
      focused file; ?debug=1 brings the debug panel back.</div>
    <div class="strip">controls</div>`;
  // Collapsed by default (docs/design.md section 10), and it remembers.
  collapsible(root, 'controls', 'c', true);
  const regions = root.querySelector<HTMLElement>('#c-regions')!;
  regionNames.forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => handlers.flyRegion(i);
    regions.appendChild(b);
  });
  root.querySelector<HTMLButtonElement>('[data-fit]')!.onclick = () => handlers.fitAll();
  root.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => {
    b.onclick = () => handlers.flyLevel(b.dataset.level as 'country' | 'city' | 'street' | 'source');
  });
  const boxes = new Map<string, HTMLInputElement>();
  const bind = (id: string, key: keyof Toggles, on: boolean) => {
    const cb = root.querySelector<HTMLInputElement>(`#${id}`)!;
    cb.checked = on;
    cb.onchange = () => handlers.toggle(key, cb.checked);
    boxes.set(key, cb);
  };
  bind('t-labels', 'labels', initial.labels);
  bind('t-edges', 'edges', initial.edges);
  bind('t-traffic', 'traffic', initial.traffic);
  bind('t-autopilot', 'autopilot', initial.autopilot);
  const th = root.querySelector<HTMLInputElement>('#t-theme')!;
  th.checked = initial.theme === 'light';
  th.onchange = () => handlers.setTheme(th.checked ? 'light' : 'dark');
  root.querySelector<HTMLButtonElement>('#c-bench')!.onclick = () => handlers.runBench();
  root.querySelector<HTMLButtonElement>('#c-follow')!.onclick = () => handlers.follow();
  const pause = root.querySelector<HTMLButtonElement>('#c-pause')!;
  let paused = false;
  pause.onclick = () => {
    paused = !paused;
    pause.textContent = paused ? 'resume agent' : 'pause agent';
    pause.classList.toggle('on', paused);
    handlers.pauseAgent(paused);
  };
  const slider = (id: string, out: string, apply: (v: number) => void) => {
    const el2 = root.querySelector<HTMLInputElement>(`#${id}`)!;
    const label = root.querySelector<HTMLElement>(`#${out}`)!;
    const push = () => {
      const v = Number(el2.value);
      label.textContent = v.toFixed(1);
      apply(v);
    };
    el2.oninput = push;
    push();
  };
  slider('s-wait', 'v-wait', handlers.setWait);
  slider('s-time', 'v-time', handlers.setTime);

  const scrub = root.querySelector<HTMLInputElement>('#s-scrub')!;
  const scrubOut = root.querySelector<HTMLElement>('#v-scrub')!;
  let dragging = false;
  scrub.oninput = () => {
    dragging = true;
    scrubOut.textContent = `${scrub.value} / ${initial.events}`;
    handlers.scrub(Number(scrub.value));
  };
  scrub.onchange = () => { dragging = false; };
  const speed = root.querySelector<HTMLInputElement>('#s-speed')!;
  const speedOut = root.querySelector<HTMLElement>('#v-speed')!;
  const pushSpeed = () => {
    speedOut.textContent = Number(speed.value).toFixed(1);
    handlers.setSpeed(Math.round(Number(speed.value) * 1000));
  };
  speed.oninput = pushSpeed;
  pushSpeed();

  return {
    setReplay(cursor, count) {
      if (dragging) return;
      const v = String(Math.min(cursor, count));
      if (scrub.value !== v) scrub.value = v;
      scrubOut.textContent = `${v} / ${count}`;
    },
    /** Flip a toggle from outside the panel, checkbox and handler together. */
    setToggle(key, on) {
      const cb = boxes.get(key);
      if (cb) cb.checked = on;
      handlers.toggle(key, on);
    }
  };
}
