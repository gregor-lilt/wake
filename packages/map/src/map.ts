/**
 * The map: a repository rendered as a geographic map with deck.gl 9's
 * OrthographicView on WebGL2, with an agent's session playing over it.
 *
 * Everything down to the handle at the bottom is the renderer that grew in
 * apps/spike-renderer, moved here unchanged: the bands, the sheets, the roads,
 * the labels, the reading-band source overlays, the replay and its camera. The
 * handle is the seam a shell sees, and docs/protocol.md arrives through its
 * `applyDelta`.
 *
 * One long function on purpose. The layers, the camera and the frame loop
 * share one closure and one set of typed arrays, which is what keeps 50,000
 * tiles at 120 fps; splitting it would mean passing that state around.
 * See README.md for the map of the modules it draws on.
 */
import { Deck, OrthographicView } from '@deck.gl/core';
import { SolidPolygonLayer, PolygonLayer, PathLayer, TextLayer, ScatterplotLayer } from '@deck.gl/layers';
import { CollisionFilterExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';

import { generateRepo } from './repo';
import type { Dir, Repo } from './repo';
import { layoutRepo, sizeNorm, moveFileRect, moveDirRect, CELL_UNITS } from './layout';
import type { Layout, Rect, PolySoup, CityColor, BuildingColor } from './layout';
import { buildRoads, buildIncidence, incidentRoads, classOf, CLASS_WIDTH } from './edges';
import type { PathSoup, FocusRoad, Incidence, RoadClass } from './edges';
import { buildPlaceLabels, makeZoomPlan, fileLabels, widthOfMixed } from './labels';
import type { LabelItem, PlaceItem } from './labels';
import { appendDir, appendFile } from './grow';
import { Wayfinding } from './wayfind';
import type { Crumb, StickyInput, AgentTarget } from './wayfind';
import { fileSymbols, scopeChain, scopeText } from './scope';
import type { ScopeSym } from './scope';
import { makeTheme } from './theme';
import type { RGB, Theme, ThemeName } from './theme';
import { buildHud, buildControls } from './hud';
import type { Toggles } from './hud';
import { buildAgentConsole, fallbackTitle, lineKindOf } from './agentconsole';
import { flightMs, reducedMotion, onMotionChange, dampTime, setReducedMotion } from './motion';
import type { ConsoleLine, ConsoleHeader } from './agentconsole';
import { buildTimeline } from './timeline';
import { buildChanges } from './changes';
import type { Change, DiffScope } from './changes';
import type { TickKind } from './timeline';
import { runBench, formatBench } from './bench';
import type { BenchResult } from './bench';
import { makeRng } from './rng';
import { buildSession, pathOf, heatOf } from './session';
import type { Session, SessionEvent } from './session';
import { fetchExport, buildFixture, mapSessionEvent } from './exportmap';
import type { ExportDoc, ExportMeta, ExportNode } from './exportmap';
import { Autopilot } from './autopilot';
import type { HotTrip, Marker, Pulse } from './autopilot';
import { AutopilotCamera, Flight } from './camera';
import type { Pose } from './camera';
import { warmTokenWorker, exportSource } from './code';
import type { CodeSource } from './code';
import type { ServerMessage, WireEvent, WireEdge, SessionState } from './protocol';
import { Splash } from './splash';
import { CodeView, REST_MS, APPLY_MS, OVERLAY_KEEP, FADE_MS, OUT_MS } from './codeview';
import {
  ROW_PX_READ, ROW_PX_MAX, ROW_PX_SCHEMATIC, ROW_PX_GLOW_FADE,
  bandOf, rowPxOf, zoomForRowPx, tileGlowWeight, sheetGlowWeight
} from './schematic';
import type { DiffBand } from './schematic';
import { isNonCode } from './schematic';
import { ROW_WORLD, STUB_LINES, CELL_WORLD } from './lattice';

// ----------------------------------------------------------------- the shell
/**
 * What a shell can override. Everything else still comes from the query
 * string, so the spike's scripted runs and the app's own checks configure the
 * map the same way they always did.
 */
export interface MapOptions {
  /** Colour theme. Defaults to `?theme=`, else dark. */
  theme?: ThemeName;
  /** Force reduced motion instead of reading the system preference. */
  reducedMotion?: boolean;
  /** The focused file changed: a click, a deep link, an autopilot landing. */
  onFocus?: (info: FileInfo | null) => void;
  /** The user switched the changes list between uncommitted and this session. */
  onDiffScope?: (scope: DiffScope) => void;
  /** The pointer moved onto or off a file. */
  onHover?: (info: FileInfo | null) => void;
  /** A session event reached the replay, live or from the snapshot. */
  onEvent?: (index: number, total: number) => void;
  /** Where file text and diffs come from. Defaults to the `?data=` export. */
  source?: CodeSource;
  /** A splash the shell already started, so its stages continue in here. */
  splash?: Splash;
  /** Static export name for the `?data=` path. Defaults to `?data=`. */
  dataName?: string | null;
  /** Autopilot at startup. Defaults to `?autopilot=`. */
  autopilot?: boolean;
  /**
   * The two debug panels, top left and top right. Pass false in a product
   * shell: there is no debug panel in the product (docs/design.md section 10),
   * the agent console has that corner. The agent console is unaffected.
   */
  debugPanels?: boolean;
  /**
   * Live mode: a daemon feeds events as they happen, so the replay clock is
   * off and the log never loops.
   */
  live?: boolean;
}

/** One file, in the terms a shell outside the map can use. */
export interface FileInfo {
  /** Dense file index, the id every other call on the handle takes. */
  file: number;
  /** Repository-relative path, or null for the synthetic fixture. */
  path: string | null;
  name: string;
  line: number | null;
}

/** Counts a shell shows in its own chrome. */
export interface MapStats {
  files: number;
  dirs: number;
  symbols: number;
  edges: number;
  events: number;
  /** Repository name from the export, or null for the synthetic fixture. */
  repoName: string | null;
  /** The daemon's session lifecycle. 'ended' without a daemon. */
  session: SessionState;
  /**
   * Live frames that named a node this document does not have: a file created
   * after the map loaded. The map keeps playing; the shell can offer a reload.
   */
  unknownNodes: number;
}

/** The live map. `createMap` hands one of these out once a document is in. */
export interface MountedMap {
  applyDelta(msg: ServerMessage): void;
  flyTo(target: FlyTarget, ms?: number): void;
  focus(file: number | string | null, line?: number | null): void;
  setAutopilot(on: boolean): void;
  setTheme(theme: ThemeName): void;
  /** Every changed file, from the daemon's /changes; `null` when the daemon cannot say. */
  setChanges(changes: Change[] | null): void;
  setFollow(): void;
  /** A word about the connection behind the console, or null for none. */
  setStatus(text: string | null): void;
  scrub(index: number): void;
  stats(): MapStats;
  /** Index of a repository-relative path, or -1. */
  fileOf(path: string): number;
  destroy(): void;
}

/** Where `flyTo` can send the camera. */
export type FlyTarget =
  | { kind: 'world' }
  | { kind: 'file'; file: number | string; line?: number | null; rowPx?: number };

/**
 * Build the map inside `container` and play `doc`. Everything below this line
 * is the renderer that grew in the spike, unchanged except for the container
 * it hangs off and the options above.
 */
export async function mountMap(
  container: HTMLElement,
  options: MapOptions = {},
  doc: ExportDoc | null = null
): Promise<MountedMap> {
// ---------------------------------------------------------------- parameters
const qs = new URLSearchParams(location.search);
const num = (k: string, d: number) => (qs.has(k) ? Number(qs.get(k)) : d);
const flag = (k: string, d: boolean) => (qs.has(k) ? qs.get(k) !== '0' : d);
if (options.reducedMotion !== undefined) setReducedMotion(options.reducedMotion);

const SPEC = {
  seed: num('seed', 0xc0ffee),
  dirs: num('dirs', 400),
  files: num('files', 50_000),
  symbols: num('symbols', 200_000),
  edges: num('edges', 20_000),
  crossRegionShare: num('cross', 0.15)
};

const toggles: Toggles = {
  labels: flag('labels', true),
  // Roads are off by default since the review of the labels phase
  // (docs/design.md section 6): the network is a focus tool, not a base layer.
  // The checkbox is "show all roads".
  edges: flag('edges', false),
  traffic: flag('traffic', false),
  autopilot: options.autopilot ?? flag('autopilot', false),
  theme: options.theme ?? (qs.get('theme') === 'light' ? 'light' : ('dark' as ThemeName))
};
if (flag('nohud', false)) document.body.classList.add('nohud');
// `nohud` is the screenshot flag and takes the console with it. This is the
// product default: the two debug panels go, the console stays.
if (options.debugPanels === false) document.body.classList.add('no-debug');
/**
 * Frame rate and the internal counters live behind this flag (docs/design.md
 * section 10). Without it there is no debug panel at all: the agent card has
 * its corner.
 */
const debugHud = flag('debug', false);
/** Live mode: the daemon drives the replay, the cadence clock does not. */
const live = options.live ?? false;
/** Removals run by destroy(), in reverse. */
const teardown: Array<() => void> = [];
let destroyed = false;
function on<K extends keyof WindowEventMap>(
  el: Window | HTMLElement,
  type: K,
  fn: (ev: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions
): void;
function on(el: Window | HTMLElement, type: string, fn: () => void, opts?: AddEventListenerOptions): void;
function on(
  el: Window | HTMLElement,
  type: string,
  fn: (ev: Event) => void,
  opts?: AddEventListenerOptions
): void {
  el.addEventListener(type, fn as EventListener, opts);
  teardown.push(() => el.removeEventListener(type, fn as EventListener, opts));
}

// ------------------------------------------------------------------ the DOM
// The map owns its own chrome: the canvas, the two debug panels and the agent
// console are created inside the container rather than written into a page,
// so a shell only has to hand over an element.
container.classList.add('wake-map-root');
const el = (id: string, tag: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`#${id}`);
  if (found) return found;
  const made = document.createElement(tag);
  made.id = id;
  container.appendChild(made);
  return made;
};
const canvas = el('map', 'canvas') as HTMLCanvasElement;
const hudEl = el('hud', 'div');
const controlsEl = el('controls', 'div');
const agentEl = el('agent', 'div');
const timelineEl = el('timeline', 'div');
const changesEl = el('changes', 'div');

// ------------------------------------------------------------------- fixture
// `?data=<name>` loads a real repository export instead of the synthetic
// fixture. The JSON is served at runtime from a gitignored directory outside
// this package (see vite/export-data.ts) and nothing from it is written to
// disk. A shell with a daemon passes the document straight in instead.
const dataName = options.dataName !== undefined ? options.dataName : qs.get('data');

// --------------------------------------------------------------------- splash
// The splash owns the screen until the first framed frame is up, and every
// step below announces itself to it before it runs. `?nosplash=1` makes it
// inert, which is how the bench and the playwright scripts keep measuring the
// startup they always measured.
const splash = options.splash ?? new Splash({
  enabled: !flag('nosplash', false),
  steps: dataName || doc
    ? [
        { key: 'read', weight: 0.2 },
        { key: 'layout', weight: 0.25 },
        { key: 'roads', weight: 0.12 },
        { key: 'labels', weight: 0.08 },
        { key: 'highlighter', weight: 0.15 },
        { key: 'tokens', weight: 0.2 }
      ]
    : [
        { key: 'generate', weight: 0.3 },
        { key: 'layout', weight: 0.3 },
        { key: 'roads', weight: 0.15 },
        { key: 'labels', weight: 0.1 },
        { key: 'highlighter', weight: 0.15 }
      ]
});

let exportDoc: ExportDoc | null = doc;
if (!exportDoc && dataName) {
  await splash.step('read', 'reading export');
  exportDoc = await fetchExport(dataName);
}


  let theme: Theme = makeTheme(toggles.theme);
  const cityColor: CityColor = (region, t) => theme.cityFill(region, t);
  const buildingColor: BuildingColor = (kind, region) => theme.buildingFill(kind, region);

  let repo: Repo;
  let layout: Layout;
  let session: Session;
  let exportMeta: ExportMeta | null = null;
  /** Export node id to dense index, so a live delta can name a tile. */
  let liveIndex: { fileIndex: Map<number, number>; dirIndex: Map<number, number>; t0: number } | null = null;
  /** The last mapped file, so a live event forms a trip with the one before. */
  let livePrevFile = -1;
  let tGen = 0;
  let tLayout = 0;

  if (exportDoc) {
    // The export's districts are known before the layout runs, so the status
    // line can name the real count while it runs.
    let dirCount = 0;
    for (const n of exportDoc.nodes) if (n.kind === 'dir') dirCount++;
    await splash.step('layout', `laying out ${dirCount.toLocaleString()} districts`);
    const tA = performance.now();
    const fx = buildFixture(exportDoc, cityColor, buildingColor);
    tLayout = performance.now() - tA;
    repo = fx.repo;
    layout = fx.layout;
    session = fx.session;
    exportMeta = fx.meta;
    liveIndex = { fileIndex: fx.fileIndex, dirIndex: fx.dirIndex, t0: fx.t0 };
    for (let i = session.events.length - 1; i >= 0; i--) {
      if (session.events[i].file >= 0) { livePrevFile = session.events[i].file; break; }
    }
  } else {
    await splash.step('generate', 'generating repository');
    const tA = performance.now();
    repo = generateRepo(SPEC);
    tGen = performance.now() - tA;
    await splash.step('layout', `laying out ${repo.dirs.length.toLocaleString()} districts`);
    const tB = performance.now();
    layout = layoutRepo(repo, cityColor, buildingColor);
    tLayout = performance.now() - tB;
    session = buildSession(repo, { seed: num('sessionSeed', 0x5e5510) });
  }

  await splash.step('roads', `routing ${repo.edgeCount.toLocaleString()} roads`);
  const tC = performance.now();
  let roads = buildRoads(repo, layout, { local: theme.roadLocal, motorway: theme.roadMotorway });
  const tRoads = performance.now() - tC;

  /**
   * Which roads touch which file, so the default road layer (the hovered or
   * focused file's own roads, docs/design.md section 6) is a slice instead of a
   * scan over every edge.
   */
  let incidence: Incidence = buildIncidence(repo);
  /** After an `edges` delta the whole slice index is stale. */
  const rebuildIncidence = (): void => { incidence = buildIncidence(repo); };

  /** The file the pointer is over, from deck's own picking. -1 for none. */
  let hoverFile = -1;

  // ------------------------------------------------------- root files district
  /**
   * Files that sit directly in the repository root form their own bordered
   * district, labelled with the repository name and drawn like any other
   * top-level region (docs/design.md section 4). The root directory itself is
   * terrain, so without this its files float on bare ground and are invisible
   * until close up.
   *
   * Only the export path has a real root directory: the synthetic fixture's
   * top-level directories ARE its regions and it has no loose root files.
   */
  const rootDirId = repo.dirs.find((d) => d.parent < 0)?.id ?? repo.dirs[0].id;
  /** Inset of the district border past the tiles: half a lattice gap. */
  const DISTRICT_INSET = CELL_UNITS * 0.5;
  /**
   * Recomputed, not computed once: a file created during the session lands in
   * a district, and if that district is the root the border has to grow with
   * it (see `applyNode`).
   */
  function computeRootDistrict(): { rect: Rect; name: string; region: number } | null {
    const root = repo.dirs[rootDirId];
    if (root.depth >= repo.regionDepth || root.files.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const f of root.files) {
      x0 = Math.min(x0, layout.cityRect[f * 4]);
      y0 = Math.min(y0, layout.cityRect[f * 4 + 1]);
      x1 = Math.max(x1, layout.cityRect[f * 4] + layout.cityRect[f * 4 + 2]);
      y1 = Math.max(y1, layout.cityRect[f * 4 + 1] + layout.cityRect[f * 4 + 3]);
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return {
      rect: {
        x: x0 - DISTRICT_INSET,
        y: y0 - DISTRICT_INSET,
        w: x1 - x0 + 2 * DISTRICT_INSET,
        h: y1 - y0 + 2 * DISTRICT_INSET
      },
      // The repository's own name, from the export. Runtime only.
      name: exportMeta ? exportMeta.name : root.name,
      region: root.region
    };
  }
  let rootDistrict = computeRootDistrict();

  await splash.step('labels', 'ranking labels');
  const zoom = makeZoomPlan(Math.max(layout.world.w, layout.world.h), {
    localRoads: roads.local.count,
    symbols: repo.symCount,
    files: repo.fileCount
  });

  // Visibility is by fit, not by band (docs/design.md section 7), so the only
  // zoom gate left is the one on stubs: an empty file is not worth a name until
  // the source is on the page.
  const { places, cities: cityLabelPool } = buildPlaceLabels(
    repo, layout, zoom, zoomForRowPx(ROW_WORLD, ROW_PX_READ)
  );
  /**
   * The root district's own place item, appended to `places` below and rebuilt
   * with the pool whenever the map grows. `places` and `cityLabelPool` are
   * mutated in place and never replaced: the wayfinding DOM holds `places` by
   * reference for the life of the map.
   */
  const rootPlace = (): PlaceItem | null =>
    rootDistrict === null
      ? null
      : {
        text: rootDistrict.name,
        rect: [rootDistrict.rect.x, rootDistrict.rect.y, rootDistrict.rect.w, rootDistrict.rect.h],
        depth: repo.regionDepth,
        kind: 'region',
        priority: 100,
        minZoom: -Infinity,
        stub: false,
        file: -1,
        dir: rootDirId
      };
  // The root files district gets a sticky label like every other top-level
  // region, in the district-label style, carrying the repository name.
  const rp0 = rootPlace();
  if (rp0) places.push(rp0);

  // ------------------------------------------------------------------ code view
  // The schematic and source tiers. Inert without ?data=, since the synthetic
  // fixture has no source on disk to read.
  await splash.step('highlighter', 'loading highlighter');
  // Real work brought forward: this starts the tokenizer worker and builds
  // Shiki's highlighter inside it, and the CodeStore below adopts that same
  // worker. Without the splash it warms lazily on the first tokenize, exactly as
  // before, so the bench measures an unchanged startup.
  if (splash.active) await warmTokenWorker(toggles.theme);
  const codeView = new CodeView(repo, layout, theme, {
    source: options.source ?? (dataName ? exportSource(dataName, qs.get('diffrev') ?? '') : null),
    root: container,
    onReady: () => { redrawPending = true; },
    // Bench override. The layout's deliberate whitespace means only one or two
    // files can be at the source tier at once on a real screen, so the pool of
    // 8 is only reachable by lowering the reading threshold on purpose.
    l3MinRowPx: num('l3row', ROW_PX_READ)
  });
  /**
   * The map's one row height in world units, and the row height the 'source'
   * zoom step and a deep link land on: the start of the reading band.
   */
  const rowWorld = codeView.k;
  const sourceRowPx = Math.min(num('rowpx', ROW_PX_READ), ROW_PX_MAX);
  /** Current on-screen height of one source line, for the HUD and the tests. */
  const rowPxNow = () => rowPxOf(rowWorld, 2 ** vs.zoom);
  /** performance.now() at which the replay applied each file's diff. */
  const applied = new Map<number, number>();
  let appliedVersion = 0;
  let lastMoveAt = performance.now();
  /** A pointer is down on the canvas. A drag hides the source overlays at once. */
  let pointerDown = false;

  /** Repaint the baked color arrays after a theme switch. */
  function repaint(): void {
    const cc = layout.cities.colors;
    for (let f = 0; f < repo.fileCount; f++) {
      const [r, g, b] = theme.cityFill(repo.fileRegion[f], sizeNorm(repo.fileSize[f]));
      const a = repo.fileLines[f] < STUB_LINES ? 102 : 255;
      for (let v = 0; v < 4; v++) {
        const o = f * 16 + v * 4;
        cc[o] = r; cc[o + 1] = g; cc[o + 2] = b; cc[o + 3] = a;
      }
    }
    const bc = layout.buildings.colors;
    for (let f = 0; f < repo.fileCount; f++) {
      const region = repo.fileRegion[f];
      for (let s = repo.fileSymStart[f]; s < repo.fileSymStart[f + 1]; s++) {
        const [r, g, b] = theme.buildingFill(repo.symKind[s], region);
        for (let v = 0; v < 4; v++) {
          const o = s * 16 + v * 4;
          bc[o] = r; bc[o + 1] = g; bc[o + 2] = b; bc[o + 3] = 255;
        }
      }
    }
    roads = buildRoads(repo, layout, { local: theme.roadLocal, motorway: theme.roadMotorway });
  }

  // -------------------------------------------------------- binary data blocks
  // Rebuilt only on a theme change. Keeping the object identity stable is what
  // stops deck.gl from re-uploading ~10 MB of attributes on every zoom step.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Binary = any;
  let cityData: Binary;
  let bldData: Binary;
  let trunkData: Binary;
  let minorData: Binary;
  let localData: Binary;

  // The soups are allocated with headroom for the files a live session creates
  // (src/grow.ts), so what goes to deck.gl is the used prefix: views on the
  // same buffers, no copy.
  const polyBinary = (p: PolySoup): Binary => {
    const verts = p.startIndices[p.count];
    return {
      length: p.count,
      startIndices: p.startIndices.subarray(0, p.count + 1),
      attributes: {
        getPolygon: { value: p.positions.subarray(0, verts * 2), size: 2 },
        getFillColor: { value: p.colors.subarray(0, verts * 4), size: 4 }
      }
    };
  };
  const pathBinary = (p: PathSoup): Binary => ({
    length: p.count,
    startIndices: p.startIndices,
    attributes: {
      getPath: { value: p.positions, size: 2 },
      getColor: { value: p.colors, size: 4 },
      getWidth: { value: p.widths, size: 1 }
    }
  });
  function rebuildBinaries(): void {
    cityData = polyBinary(layout.cities);
    bldData = polyBinary(layout.buildings);
    trunkData = pathBinary(roads.trunk);
    minorData = pathBinary(roads.minor);
    localData = pathBinary(roads.local);
  }
  rebuildBinaries();

  // ---------------------------------------------------------------- camera set
  const view = () => ({ w: canvas.clientWidth || window.innerWidth, h: canvas.clientHeight || window.innerHeight });

  interface VS {
    target: [number, number, number];
    zoom: number;
    minZoom: number;
    maxZoom: number;
  }

  function fitRect(r: Rect, pad = 0.9): { target: [number, number, number]; zoom: number } {
    const { w, h } = view();
    const z = Math.log2(Math.min(w / Math.max(r.w, 1), h / Math.max(r.h, 1)) * pad);
    return { target: [r.x + r.w / 2, r.y + r.h / 2, 0], zoom: z };
  }

  const dirRectOf = (id: number): Rect => ({
    x: layout.dirRect[id * 4],
    y: layout.dirRect[id * 4 + 1],
    w: layout.dirRect[id * 4 + 2],
    h: layout.dirRect[id * 4 + 3]
  });

  // Deterministic bench / button targets.
  // Biggest top-level region, so the "country" button works on any dataset.
  const countryDir = repo.regions.reduce((best, id) =>
    repo.dirs[id].fileCount > repo.dirs[best].fileCount ? id : best, repo.regions[0]);
  const cityDir = (() => {
    let best = -1;
    let bestN = -1;
    for (const d of repo.dirs) {
      if (d.depth <= repo.regionDepth || d.files.length < 8) continue;
      if (d.files.length > bestN) { bestN = d.files.length; best = d.id; }
    }
    return best >= 0 ? best : repo.dirs[repo.dirs.length - 1].id;
  })();
  const streetFile = (() => {
    // ?file=<repo-relative path> targets one file, which is how the code-view
    // screenshots stay reproducible without naming a path in this package.
    const want = qs.get('file');
    if (want && repo.filePath) {
      const i = repo.filePath.indexOf(want);
      if (i >= 0) return i;
    }
    let best = 0;
    let bestS = -1;
    for (let f = 0; f < repo.fileCount; f++) {
      const s = repo.fileFanIn[f] * 3 + repo.fileSize[f] / 100;
      if (s > bestS) { bestS = s; best = f; }
    }
    return best;
  })();

  /** A square centred on one file that `fitRect` turns into a given rowPx. */
  function fileRectForRowPx(f: number, rowPx: number): Rect {
    const { w, h } = view();
    const side = (0.9 * Math.min(w, h) * rowWorld) / rowPx;
    return {
      x: layout.cityCentroid[f * 2] - side / 2,
      y: layout.cityCentroid[f * 2 + 1] - side / 2,
      w: side,
      h: side
    };
  }
  const RECTS: Record<string, () => Rect> = {
    continent: () => layout.world,
    country: () => dirRectOf(countryDir),
    city: () => dirRectOf(cityDir),
    // street: the middle of the schematic band, where the file is a minimap.
    street: () => fileRectForRowPx(streetFile, 5)
  };

  // Maximum zoom is where rowPx reaches 18 (docs/design.md section 2). Beyond
  // that there is nothing more to see.
  // The world is measured in lattice cells now, so its extent varies by orders
  // of magnitude between fixtures: minZoom has to follow the fit, not a constant.
  const worldFit = fitRect(layout.world).zoom;
  let vs: VS = { ...fitRect(layout.world), minZoom: worldFit - 1.5, maxZoom: codeView.maxZoom };

  /**
   * The programmatic flight in progress, or null. It is stepped from the frame
   * loop (stepFlight), the same imperative path the autopilot writes through,
   * instead of deck.gl's viewState transition, which lands on its first frame
   * for an OrthographicView (see Flight in src/camera.ts). Any user gesture
   * cancels it (the canvas listeners below and onViewStateChange).
   */
  let flight: Flight | null = null;

  const clampZoom = (z: number): number => Math.max(vs.minZoom, Math.min(vs.maxZoom, z));

  /**
   * The one write path to deck.gl for a camera the app owns (flights, jumps and
   * the autopilot). `moving` marks the frame as camera motion, the way a user
   * gesture does through onViewStateChange: the overlays wait for the camera to
   * rest, and the label set follows the zoom bucket.
   */
  function setPose(pose: Pose, moving: boolean): void {
    vs = { target: [pose.x, pose.y, 0], zoom: clampZoom(pose.zoom), minZoom: vs.minZoom, maxZoom: vs.maxZoom };
    deck.setProps({ viewState: vs as never });
    if (moving) cameraMoved(performance.now());
  }

  /** Bookkeeping for a frame in which the camera moved, whoever moved it. */
  function cameraMoved(now: number): void {
    lastMoveAt = now;
    const b = Math.round(vs.zoom * 4);
    if (b !== zoomBucket) {
      zoomBucket = b;
      redrawPending = true;
    } else if (toggles.labels) {
      redrawPending = true; // labelSets() is memoised, so this is a cheap check
    }
  }

  /** Advance the flight one frame. The landing frame is exactly the target. */
  function stepFlight(now: number): void {
    if (!flight) return;
    const pose = flight.at(now);
    if (flight.done(now)) flight = null;
    setPose(pose, true);
  }

  /** Fly to an explicit pose over `flyMs`, or jump when it is 0. */
  function flyToPose(pose: { x: number; y: number; zoom: number }, flyMs: number, userInitiated = false): void {
    const now = performance.now();
    if (userInitiated) cam.noteUserInput(now);
    // prefers-reduced-motion: a flight over a screenful of map is exactly what
    // the setting is about, so it becomes an instant jump (src/motion.ts).
    const ms = flightMs(flyMs);
    // Maximum zoom is where rowPx reaches 18: a fit that would go past it stops
    // there, like every other camera move.
    const to: Pose = { x: pose.x, y: pose.y, zoom: clampZoom(pose.zoom) };
    flyUntil = now + ms + 150;
    kickFrames = 24;
    if (ms <= 0) {
      flight = null;
      setPose(to, false);
      return;
    }
    flight = new Flight({ x: vs.target[0], y: vs.target[1], zoom: vs.zoom }, to, now, ms);
  }

  /** Fit a rect, flying there over `flyMs`. */
  function flyTo(r: Rect, flyMs: number, userInitiated = false): void {
    const f = fitRect(r);
    flyToPose({ x: f.target[0], y: f.target[1], zoom: f.zoom }, flyMs, userInitiated);
  }

  // ------------------------------------------------------------------- traffic
  const trafficRng = makeRng(7);
  const TRAFFIC_FADE = 2200;
  const AGENT_FADE = 6000;
  interface TouchState { at: number; strong: boolean; fade: number }
  const touched = new Map<number, TouchState>();
  let trafficBudget = 0;

  function touch(f: number, now: number, strong: boolean, fade: number): void {
    touched.set(f, { at: now, strong, fade });
  }

  function tickTraffic(dtMs: number, now: number): void {
    if (toggles.traffic) {
      trafficBudget += (50 * Math.min(dtMs, 200)) / 1000;
      while (trafficBudget >= 1) {
        trafficBudget -= 1;
        touch(trafficRng.int(repo.fileCount), now, false, TRAFFIC_FADE);
      }
    }
    for (const [f, t] of touched) if (now - t.at > t.fade) touched.delete(f);
  }

  interface TrafficItem { poly: Array<[number, number]>; alpha: number; strong: boolean }
  /**
   * The tile fill glow. Activity is drawn at the granularity of the band
   * (docs/design.md section 9), so the amber fill over a whole tile carries the
   * touch only while the file IS a tile: its weight ramps off continuously
   * between ROW_PX_GLOW_FADE and ROW_PX_READ and is zero in the reading band,
   * where it would be a brownish wash over readable source.
   */
  function trafficData(now: number): TrafficItem[] {
    const out: TrafficItem[] = [];
    const weight = tileGlowWeight(rowPxNow());
    if (weight <= 0) return out;
    for (const [f, t] of touched) {
      const alpha = Math.max(0, 1 - (now - t.at) / t.fade) * weight;
      if (alpha <= 0.002) continue;
      const x = layout.cityRect[f * 4];
      const y = layout.cityRect[f * 4 + 1];
      const w = layout.cityRect[f * 4 + 2];
      const h = layout.cityRect[f * 4 + 3];
      const g = w * (t.strong ? 0.5 : 0.34); // a halo so a touch reads at low zoom
      out.push({
        poly: [[x - g, y - g], [x + w + g, y - g], [x + w + g, y + h + g], [x - g, y + h + g]],
        alpha,
        strong: t.strong
      });
    }
    return out;
  }

  // ------------------------------------------------- reading-band activity glow
  /**
   * What replaces the fill in the reading band: the changed lines already carry
   * the diff inline, and the touch itself shows as a 2-3 px amber glow on the
   * sheet's own border and on its sticky header strip, fading on the slow
   * duration. Never a fill over the text box.
   */
  const GLOW_MS = APPLY_MS;
  interface SheetGlow { file: number; poly: Array<[number, number]>; alpha: number; widthPx: number }
  let sheetGlowLayerData: SheetGlow[] = [];
  /** The same glow per file, 0..1, for the DOM sticky header. */
  const sheetGlowNow = new Map<number, number>();

  function sheetGlowData(now: number): SheetGlow[] {
    const out: SheetGlow[] = [];
    sheetGlowNow.clear();
    const weight = sheetGlowWeight(rowPxNow());
    if (weight <= 0 || !codeView.enabled) return out;
    for (const box of codeView.sheetBoxes()) {
      const t = touched.get(box.file);
      if (!t) continue;
      const alpha = Math.max(0, 1 - (now - t.at) / GLOW_MS) * weight * (t.strong ? 1 : 0.62);
      if (alpha <= 0.004) continue;
      sheetGlowNow.set(box.file, alpha);
      const { x, y, w, h } = box;
      out.push({
        file: box.file,
        poly: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        alpha,
        widthPx: t.strong ? 3 : 2
      });
    }
    return out;
  }

  // -------------------------------------------------------------- trip clipping
  /** A trip's road, or one piece of it once the sheets have been cut out. */
  interface TripPath { trip: HotTrip; path: Array<[number, number]> }
  interface Box { x0: number; y0: number; x1: number; y1: number }

  /**
   * Liang-Barsky: the parameter interval of the part of a->b that lies inside
   * the box, or null when the segment misses it.
   */
  function segInBox(
    a: readonly [number, number], b: readonly [number, number], r: Box
  ): [number, number] | null {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const edges: Array<[number, number]> = [
      [-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dy, a[1] - r.y0], [dy, r.y1 - a[1]]
    ];
    for (const [pp, q] of edges) {
      if (pp === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / pp;
      if (pp < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
    return t1 > t0 ? [t0, t1] : null;
  }

  /** Union of intervals in [0,1], merged and sorted. */
  function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
    if (spans.length < 2) return spans;
    spans.sort((u, v) => u[0] - v[0]);
    const out: Array<[number, number]> = [spans[0]];
    for (let i = 1; i < spans.length; i++) {
      const last = out[out.length - 1];
      if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
      else out.push(spans[i]);
    }
    return out;
  }

  /**
   * The polyline with every part that lies on a sheet cut away, so a trip ends
   * exactly at the sheet edge of the origin and of the destination and never
   * crosses source (docs/design.md section 9). Returns the pieces that are left.
   */
  function clipPathToBoxes(
    path: ReadonlyArray<[number, number]>, boxes: Box[]
  ): Array<Array<[number, number]>> {
    const pieces: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> | null = null;
    const flush = (): void => {
      if (cur && cur.length >= 2) pieces.push(cur);
      cur = null;
    };
    const at = (a: readonly [number, number], b: readonly [number, number], t: number):
      [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const inside: Array<[number, number]> = [];
      for (const r of boxes) {
        const span = segInBox(a, b, r);
        if (span) inside.push(span);
      }
      // The complement of the inside spans is what is left to draw.
      const outside: Array<[number, number]> = [];
      let t = 0;
      for (const [u0, u1] of mergeSpans(inside)) {
        if (u0 > t) outside.push([t, u0]);
        t = Math.max(t, u1);
      }
      if (t < 1) outside.push([t, 1]);
      for (const [u0, u1] of outside) {
        if (u1 - u0 < 1e-9) continue;
        if (cur && u0 <= 1e-9) cur.push(at(a, b, u1));
        else {
          flush();
          cur = [at(a, b, u0), at(a, b, u1)];
        }
        if (u1 < 1 - 1e-9) flush();
      }
      if (outside.length === 0) flush();
    }
    flush();
    return pieces;
  }

  /** Sheets on screen this frame, as world boxes. Empty outside the reading band. */
  function sheetBoxesNow(): Box[] {
    if (!codeView.enabled || bandOf(rowPxNow()) !== 'reading') return [];
    const [bx0, by0, bx1, by1] = bounds();
    const out: Box[] = [];
    for (const s of codeView.sheetBoxes()) {
      const box = { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
      if (box.x1 < bx0 || box.x0 > bx1 || box.y1 < by0 || box.y0 > by1) continue;
      out.push(box);
    }
    return out;
  }

  const inBoxes = (p: readonly [number, number], boxes: Box[]): boolean =>
    boxes.some((r) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1);

  // ----------------------------------------------------------------- autopilot
  const autopilot = new Autopilot(
    repo,
    layout,
    session,
    [zoom.base - 0.4, zoom.base + 5.6],
    CELL_UNITS * 8.75
  );
  const cam = new AutopilotCamera({
    wait: num('wait', 8),
    time: num('recenter', 1.5),
    followSmooth: 0.55,
    zoomSmooth: 0.7
  });
  let frameNow = performance.now();
  let markerData: Marker[] = [];
  let pulseData: Pulse[] = [];
  let hotRoadData: HotTrip[] = [];
  let benchSuspendedAutopilot = false;
  /**
   * Camera override: the source the agent is working on, at reading zoom. Set
   * by every event that lands on a file and held until the next one, so the
   * user reads what the agent reads instead of a fitted overview.
   */
  let focus: { x: number; y: number; zoom: number } | null = null;

  /**
   * The agent console's own view of the replay (docs/design.md section 10): one
   * described line per event, built once when the session is known, and a
   * header with the current action, the autopilot state and the idle flag.
   *
   * The lines come from the replay cursor, not from the camera, so the console
   * is right even while the user is panning somewhere else entirely.
   */
  function consoleLines(): ConsoleLine[] {
    return session.events.map((e) => {
      const path = e.file >= 0 ? pathOf(repo, e.file) : null;
      // The export's `title` when it has one, the old plain-words fallback
      // otherwise, so an older export still reads.
      const title = e.title ?? fallbackTitle({
        kind: e.kind, tool: e.tool, path, lineStart: e.lineStart, lineEnd: e.lineEnd, summary: e.summary
      });
      const kind = lineKindOf(e.kind, e.role);
      const isMessage = kind === 'message-assistant' || kind === 'message-user';
      return {
        kind,
        time: clockOf(e.wallClock, e.t),
        text: isMessage ? (e.text ?? title) : title,
        command: e.kind === 'run' ? e.command : undefined,
        agentType: e.kind === 'subagent' ? e.agentType : undefined,
        file: e.file
      };
    });
  }

  /** The event timestamp, small and dim: the real wall clock (HH:MM:SS) if there is one. */
  function clockOf(wallClock: string | undefined, t: number): string {
    if (wallClock) {
      const d = new Date(wallClock);
      const two = (n: number) => String(n).padStart(2, '0');
      return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    }
    return `t+${(t / 1000).toFixed(1)}s`;
  }

  let consoleLineList: ConsoleLine[] = [];

  function consoleHeader(now: number): ConsoleHeader {
    const total = session.events.length;
    if (!toggles.autopilot) return { action: 'Autopilot off', time: '', camState: 'off' };
    const i = autopilot.cursor - 1;
    const e = i >= 0 ? session.events[i] : null;
    const line = i >= 0 ? consoleLineList[i] : null;
    const head = autopilot.paused ? 'Paused \u00b7 ' : '';
    // The replay has run out and the map has gone quiet: nothing is happening
    // and nothing is left to follow (docs/design.md section 10).
    const idle = autopilot.idle(now);
    // A message's title ("Thinking"), not its words: the header is one line.
    const current = e && line ? (e.kind === 'message' ? (e.title ?? 'Thinking') : line.text) : null;
    return {
      action: idle
        ? `Session ended \u00b7 ${total} event${total === 1 ? '' : 's'}`
        : (current !== null ? head + current : 'Waiting for the agent'),
      time: idle || !line ? '' : line.time,
      idle,
      // The chip is a state, not a sentence: following / manual / recentering.
      camState: cam.state === 'follow' ? 'following' : cam.state
    };
  }

  function eventLine(): string {
    const e = autopilot.lastEvent;
    if (!toggles.autopilot) return 'autopilot off';
    if (!e) return 'agent starting...';
    const head = autopilot.paused ? '[paused] ' : '';
    if (e.summary) return `${head}${e.summary}`;
    const verb = e.kind === 'read' ? 'Read' : 'Edit';
    return `${head}${verb} ${pathOf(repo, e.file)}`;
  }

  function eventTime(): string {
    const e = autopilot.lastEvent;
    if (!e) return '--';
    if (e.wallClock) return e.wallClock.replace('T', ' ').slice(0, 19) + 'Z';
    return `t+${(e.t / 1000).toFixed(1)}s`;
  }

  /**
   * One event reaches the map: the agent's current file, its glow, its diff,
   * and (autopilot on) the camera close-up on the source it is about. The
   * replay calls this from its clock, live mode from every pushed event, which
   * never passes through the replay clock.
   */
  function landEvent(e: SessionEvent, now: number): void {
    if (e.file < 0) return;
    // The agent's current file, which the off-screen marker points at.
    agentFile = e.file;
    touch(e.file, now, heatOf(e.kind) >= 0.7, AGENT_FADE);
    // The demo diff is the final state of the working tree, so a file's
    // whole diff is applied at its first edit and re-flashes on later ones.
    if (e.kind === 'edit' || e.kind === 'write') {
      applied.set(e.file, now);
      appliedVersion++;
    }
    // Show the source the event is about, at reading zoom: the line range
    // when the event has one (aimed at its middle, zoomed so the whole of
    // a short range fits), otherwise the file's first change, otherwise
    // its top. A search names a pattern, not a place, so it does not move
    // the camera.
    if (toggles.autopilot && codeView.enabled && e.kind !== 'search') {
      if (e.lineStart) {
        const span = Math.max(1, (e.lineEnd ?? e.lineStart) - e.lineStart + 1);
        const fit = (view().h * 0.72) / span;
        const rowPx = Math.max(CLOSE_UP_PX, Math.min(ROW_PX_MAX, fit));
        // A range taller than the screen (a whole-file read) is shown from its
        // start, the way a reader opens it, not from its middle.
        const shown = Math.floor((view().h * 0.72) / rowPx);
        const aim = span <= shown ? e.lineStart - 1 + Math.floor(span / 2) : e.lineStart - 1 + Math.floor(shown / 2);
        focus = codeView.focusPose(e.file, aim, rowPx);
      } else {
        focus = codeView.focusPose(e.file, null, CLOSE_UP_PX);
      }
      focusedFile = e.file;
    }
  }

  function stepAutopilot(now: number, dt: number): void {
    // Events are consumed whether or not the camera follows them: what the
    // agent did must land on the map (glow, diff, agent file) even when the
    // user holds the camera. Only the camera part below is gated.
    const before = autopilot.cursor;
    autopilot.tick(now);
    if (autopilot.cursor !== before) {
      for (let i = before; i < autopilot.cursor; i++) landEvent(session.events[i], now);
    }
    markerData = autopilot.markers(now);
    pulseData = autopilot.pulses(now);
    hotRoadData = autopilot.hotRoads();
    if (autopilot.cursor !== before) redrawPending = true;
    if (!toggles.autopilot) return;

    const { w, h } = view();
    const target =
      focus ?? autopilot.followTarget(now, w, h);
    const current: Pose = { x: vs.target[0], y: vs.target[1], zoom: vs.zoom };
    const pose = cam.step(now, dt, current, target);
    // A flight in progress owns the camera until it lands.
    if (pose && !flight) setPose(pose, false);
    redrawPending = true;
  }

  // -------------------------------------------------------------------- layers
  /** Current viewport in world units. Exact for an orthographic view. */
  function bounds(): [number, number, number, number] {
    const { w, h } = view();
    const s = 2 ** vs.zoom;
    const hw = w / 2 / s;
    const hh = h / 2 / s;
    return [vs.target[0] - hw, vs.target[1] - hh, vs.target[0] + hw, vs.target[1] + hh];
  }

  /**
   * The TextLayer's font atlas. deck.gl's default character set is plain ASCII,
   * so the ellipsis an abbreviated caption ends with would silently vanish; and
   * a real repository has the odd non-ASCII file name. Built once from the names
   * that can actually reach a label.
   */
  const charsSeen = new Set<string>();
  const CHAR_SET: string[] = [];
  const addChars = (text: string): void => {
    for (const ch of text) {
      if (charsSeen.has(ch)) continue;
      charsSeen.add(ch);
      CHAR_SET.push(ch);
    }
  };
  for (let c = 32; c < 127; c++) addChars(String.fromCharCode(c));
  addChars('\u2026');
  for (const it of cityLabelPool) addChars(it.text);

  /**
   * The label pools after the map grew: the ranking is over every file, so a
   * new tile takes its place in it rather than being pinned at the end. Both
   * arrays are mutated in place, because the wayfinding DOM and the caption
   * pass hold them by reference.
   */
  function refreshLabelPools(): void {
    const built = buildPlaceLabels(repo, layout, zoom, zoomForRowPx(ROW_WORLD, ROW_PX_READ));
    places.length = 0;
    for (const it of built.places) places.push(it);
    const rp = rootPlace();
    if (rp) places.push(rp);
    cityLabelPool.length = 0;
    for (const it of built.cities) {
      cityLabelPool.push(it);
      addChars(it.text);
    }
    labelKey = '';
  }

  /**
   * A tile or a district moved: its caption is anchored to a copy of the rect,
   * so the copy is what has to follow it. Cheaper than re-ranking the pool,
   * which a move cannot change.
   */
  function syncLabelRect(file: number, dir: number, r: [number, number, number, number]): void {
    if (file >= 0) {
      for (const it of cityLabelPool) if (it.file === file) { it.rect = r; break; }
    }
    if (dir >= 0) {
      for (const it of places) if (it.dir === dir) { it.rect = r; break; }
    }
    labelKey = '';
  }

  const collideOn = flag('collide', true);
  const collision = new CollisionFilterExtension();
  const labelExtensions = collideOn ? [collision] : [];
  const FONT = '-apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif';

  /**
   * A directory's nesting level for the fill ramp: 0 is the repository root,
   * which draws as terrain, 1 a top-level region, and so on to the fourth step.
   */
  const levelOf = (d: Dir): number => Math.max(0, d.depth - repo.regionDepth + 1);
  const districtFill = (d: Dir): RGB =>
    levelOf(d) === 0 ? theme.landFill : theme.districtFill(d.region, levelOf(d));
  const districtLine = (d: Dir): RGB =>
    levelOf(d) === 0 ? theme.landLine : theme.districtLine(d.region, levelOf(d));

  /**
   * A district's rect with 2 px corners. Three segments per corner is enough at
   * this radius, and the radius is clamped so a thin district cannot round away.
   */
  function roundedPoly(r: Rect, radius: number): Array<[number, number]> {
    const rad = Math.min(radius, Math.min(r.w, r.h) * 0.12);
    if (!(rad > 0)) {
      return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    }
    const out: Array<[number, number]> = [];
    const corners: Array<[number, number, number]> = [
      [r.x + rad, r.y + rad, Math.PI],
      [r.x + r.w - rad, r.y + rad, Math.PI * 1.5],
      [r.x + r.w - rad, r.y + r.h - rad, 0],
      [r.x + rad, r.y + r.h - rad, Math.PI * 0.5]
    ];
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= 3; i++) {
        const a = a0 + (Math.PI / 2) * (i / 3);
        out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
      }
    }
    return out;
  }

  /**
   * The default road layer (docs/design.md section 6): the roads incident to
   * the hovered file, or to the focused one when nothing is hovered. Everything
   * else stays hidden. Memoised on the subject and the theme, because a hover is
   * a pointer move and the routing is a spline sample per road.
   */
  let roadKey = '';
  let focusRoadData: FocusRoad[] = [];
  /** The file whose roads are drawn: hover wins, then focus. */
  const roadFileOf = (): number => (hoverFile >= 0 ? hoverFile : focusedFile);
  function focusRoads(): FocusRoad[] {
    const f = roadFileOf();
    const key = `${f}|${theme.name}`;
    if (key === roadKey) return focusRoadData;
    roadKey = key;
    focusRoadData = f < 0
      ? []
      : incidentRoads(repo, layout, incidence, f, {
          local: theme.roadLocal,
          motorway: theme.roadMotorway
        });
    return focusRoadData;
  }

  /** Import edges touching a file, by class. For the road checks. */
  function incidentCounts(f: number): Record<RoadClass | 'total', number> {
    const out = { local: 0, arterial: 0, motorway: 0, total: 0 };
    if (f < 0) return out;
    const seen = new Set<number>();
    for (let i = incidence.start[f]; i < incidence.start[f + 1]; i++) {
      const e = incidence.edge[i];
      if (seen.has(e)) continue;
      seen.add(e);
      out[classOf(repo, e)]++;
      out.total++;
    }
    return out;
  }

  let zoomBucket = 0;
  let trafficLayerData: TrafficItem[] = [];
  /**
   * What the trip layers actually draw. Above the reading band these are the
   * roads, markers and pulses as the autopilot produced them; in the reading
   * band the roads are cut at the sheet edges, and the marker and the arrival
   * pulse stay off the paper, because the sheet's border glow carries the
   * arrival there instead.
   */
  let tripPathData: TripPath[] = [];
  let markerDrawData: Marker[] = [];
  let pulseDrawData: Pulse[] = [];

  function clipTrips(): void {
    const boxes = sheetBoxesNow();
    if (boxes.length === 0) {
      tripPathData = hotRoadData.map((trip) => ({ trip, path: trip.path }));
      markerDrawData = markerData;
      pulseDrawData = pulseData;
      return;
    }
    const paths: TripPath[] = [];
    for (const trip of hotRoadData) {
      for (const path of clipPathToBoxes(trip.path, boxes)) paths.push({ trip, path });
    }
    tripPathData = paths;
    markerDrawData = markerData.filter((m) => !inBoxes(m.position, boxes));
    // The pulse is a ring on the destination's own centroid, which in the
    // reading band is the middle of a page: the border glow is its stand-in.
    pulseDrawData = pulseData.filter((m) => !inBoxes(m.position, boxes));
  }
  const dirsByDepth = [...repo.dirs].sort((a, b) => a.depth - b.depth || a.id - b.id);

  // The caption set is memoised on (zoom bucket, pan cell, labels on/off, where
  // the sticky region labels are) so its array identity is stable and deck.gl
  // does not regenerate text attributes per frame.
  let labelKey = '';
  let cityLabelData: LabelItem[] = [];
  function labelSets(): void {
    const b = bounds();
    const cellX = Math.max((b[2] - b[0]) / 3, 1);
    const cellY = Math.max((b[3] - b[1]) / 3, 1);
    // The region labels are sticky, so they move under a pan even when the zoom
    // bucket does not change. A 24 px grid over their corners is enough to know
    // when the suppression below could change.
    const obstacles = regionBoxes
      .map((r) => `${Math.round(r.x / 24)},${Math.round(r.y / 24)}`)
      .join(';');
    const key =
      `${zoomBucket}|${toggles.labels ? 1 : 0}|${focusedFile}|` +
      `${Math.round(vs.target[0] / cellX)}|${Math.round(vs.target[1] / cellY)}|${obstacles}`;
    if (key === labelKey) return;
    labelKey = key;
    kickFrames = 24;
    const caps = toggles.labels ? fileLabels(cityLabelPool, vs.zoom, 1200, b, focusedFile) : [];
    // Sticky region labels are DOM and the GPU collision filter cannot see them,
    // so a caption that would overlap one is dropped here instead
    // (docs/design.md section 7: region names outrank file names). The focused
    // file's own caption is the one exception: it outranks everything.
    if (regionBoxes.length === 0) {
      cityLabelData = caps;
    } else {
      const pj = projector();
      cityLabelData = caps.filter(
        (l) => l.file === focusedFile || !regionBoxes.some((r) => overlaps(labelBox(l, pj), r, 2))
      );
    }
  }

  // ---------------------------------------------------------------- wayfinding
  // docs/design.md section 7. Sticky region names, the sticky file header and
  // scope row, the jump bar and the off-screen agent marker are DOM, positioned
  // every frame from deck's own projection (src/wayfind.ts).
  /** The focused file: a deep link, a jump-bar click, or the autopilot's target. */
  let focusedFile = -1;
  /** The agent's current file: the last replayed event that landed on the map. */
  let agentFile = -1;
  /**
   * Files that differ from the session's baseline, and their terrain-band
   * strips. Declared up here because the first frame's layers are built
   * before the changes panel further down exists.
   */
  let changeByFile = new Map<number, Change>();
  let changeStrips: Array<{ poly: Array<[number, number]>; color: [number, number, number, number] }> = [];
  let changeVersion = 0;
  /** Screen boxes of this frame's sticky region labels, for caption collision. */
  let regionBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];

  const fileCentre = (f: number): [number, number] => [
    layout.cityRect[f * 4] + layout.cityRect[f * 4 + 2] / 2,
    layout.cityRect[f * 4 + 1] + layout.cityRect[f * 4 + 3] / 2
  ];

  /** The file whose tile contains a world point, -1 for none. */
  function fileAt(x: number, y: number): number {
    for (let f = 0; f < repo.fileCount; f++) {
      const rx = layout.cityRect[f * 4];
      const ry = layout.cityRect[f * 4 + 1];
      if (x < rx || y < ry) continue;
      if (x <= rx + layout.cityRect[f * 4 + 2] && y <= ry + layout.cityRect[f * 4 + 3]) return f;
    }
    return -1;
  }

  /** The deepest district containing a world point. */
  function dirAt(x: number, y: number): number {
    let best = -1;
    let bestDepth = -1;
    for (const d of repo.dirs) {
      const rx = layout.dirRect[d.id * 4];
      const ry = layout.dirRect[d.id * 4 + 1];
      if (x < rx || y < ry) continue;
      if (x > rx + layout.dirRect[d.id * 4 + 2] || y > ry + layout.dirRect[d.id * 4 + 3]) continue;
      if (d.depth > bestDepth) { bestDepth = d.depth; best = d.id; }
    }
    return best;
  }

  /** Region first, then every district down to `dirId`. The root is terrain. */
  function dirChain(dirId: number): number[] {
    const out: number[] = [];
    let d = dirId;
    while (d >= 0 && out.length < 12) {
      if (repo.dirs[d].depth >= repo.regionDepth) out.push(d);
      d = repo.dirs[d].parent;
    }
    out.reverse();
    return out;
  }

  /** Symbols of a file with their indentation, rebuilt once the source lands. */
  const symCache = new Map<number, { loaded: boolean; syms: ScopeSym[] }>();
  function symbolsOf(f: number): { syms: ScopeSym[]; lines: readonly string[] | null } {
    const lines = codeView.enabled ? codeView.sourceLines(f) : null;
    const hit = symCache.get(f);
    if (hit && hit.loaded === (lines !== null)) return { syms: hit.syms, lines };
    const syms = fileSymbols(repo, f, lines);
    symCache.set(f, { loaded: lines !== null, syms });
    return { syms, lines };
  }

  /** Zero-based source line under the centre of the viewport, for a file. */
  function centreLine(f: number): number | null {
    const pr = codeView.probe(f);
    if (!pr) return null;
    const line = Math.round((view().h / 2 - pr.text.y) / Math.max(pr.rowPx, 1e-6));
    return Math.max(0, Math.min(pr.drawnRows - 1, line));
  }

  /** Reading-band sheets whose header may stick, with their scope row. */
  function stickyInputs(): StickyInput[] {
    if (!codeView.enabled) return [];
    const out: StickyInput[] = [];
    for (const s of codeView.stickyInfo(6)) {
      const { syms, lines } = symbolsOf(s.file);
      out.push({
        file: s.file,
        name: repo.fileName[s.file],
        sheet: s.sheet,
        rowPx: s.rowPx,
        firstLine: s.firstLine,
        scope: scopeText(scopeChain(syms, lines, s.firstLine)),
        // The sheet border's glow, on the strip that has taken the sheet's top
        // edge over (docs/design.md section 9).
        glow: sheetGlowNow.get(s.file) ?? 0
      });
    }
    return out;
  }

  /**
   * The jump bar's crumbs: the point at the viewport centre, or the focused file
   * when focus or a deep link set one, or the autopilot's target while it is
   * following. Files are texture at the terrain band, so there the trail stops
   * at the districts; the scope and the line only exist in the reading band.
   */
  function jumpCrumbs(): Crumb[] {
    const b = bounds();
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const band = bandOf(rowPxNow());
    let file = focusedFile;
    if (file < 0 && toggles.autopilot && cam.state !== 'manual' && agentFile >= 0) file = agentFile;
    if (file < 0) file = fileAt(cx, cy);
    const dir = file >= 0 ? repo.fileDir[file] : dirAt(cx, cy);
    const out: Crumb[] = [];
    for (const d of dirChain(dir)) {
      out.push({
        text: repo.dirs[d].name,
        kind: repo.dirs[d].depth === repo.regionDepth ? 'region' : 'district',
        dir: d
      });
    }
    if (out.length === 0) {
      out.push({ text: exportMeta ? exportMeta.name : 'repository', kind: 'region', dir: rootDirId });
    }
    if (file >= 0 && band !== 'terrain') {
      out.push({ text: repo.fileName[file], kind: 'file', file });
      if (band === 'reading') {
        const line = centreLine(file);
        if (line !== null) {
          const { syms, lines } = symbolsOf(file);
          for (const sym of scopeChain(syms, lines, line)) {
            out.push({ text: sym.name, kind: 'scope', file, line: sym.lineStart - 1 });
          }
          out.push({ text: `L${line + 1}`, kind: 'line', file, line });
        }
      }
    }
    return out;
  }

  /** The agent's file when it is worth pointing at from the screen edge. */
  function agentTarget(): AgentTarget | null {
    if (agentFile < 0) return null;
    // Only when the camera is the user's: while autopilot is following, the
    // agent's file is where the camera is going anyway.
    if (toggles.autopilot && cam.state !== 'manual') return null;
    const [wx, wy] = fileCentre(agentFile);
    return { file: agentFile, name: repo.fileName[agentFile], wx, wy };
  }

  const READ_PX = Math.min(ROW_PX_READ, ROW_PX_MAX);
  /**
   * Row height of the autopilot's close-up. Well inside the reading band, not
   * on its edge: the camera eases toward its target and never quite reaches
   * it, so a target of exactly ROW_PX_READ settled a hair below the source
   * threshold and showed schematic bars at full size instead of code.
   */
  const CLOSE_UP_PX = Math.min(12, ROW_PX_MAX);
  const wayfind = new Wayfinding(container, places, theme, {
    frameDir: (d) => { if (d >= 0) flyTo(dirRectOf(d), 700, true); },
    frameFile: (f, line) => {
      focusedFile = f;
      flyToPose(codeView.focusPose(f, line, READ_PX), 800, true);
    },
    scrollTo: (f, line) => {
      flyToPose(codeView.focusPose(f, line, Math.max(READ_PX, rowPxNow())), 500, true);
    },
    goAgent: (f) => { flyToPose(codeView.focusPose(f, null, READ_PX), 900, true); }
  });

  /**
   * The jump bar's subject search scans every file's rect, which is 200k rect
   * tests on the scale probe. The bar is one line of text and 8 Hz is more than
   * enough for it, so the crumbs are recomputed on a timer (and at once when
   * focus changes) instead of every frame.
   */
  let crumbCache: Crumb[] = [];
  let crumbAt = 0;
  let crumbFocus = -2;
  const CRUMB_MS = 120;
  function crumbsNow(now: number): Crumb[] {
    if (now - crumbAt < CRUMB_MS && crumbFocus === focusedFile) return crumbCache;
    crumbAt = now;
    crumbFocus = focusedFile;
    crumbCache = jumpCrumbs();
    return crumbCache;
  }

  /** One wayfinding frame. Cheap: a few dozen rects and a handful of DOM writes. */
  function stepWayfinding(): void {
    wayfind.update({
      zoom: vs.zoom,
      bounds: bounds(),
      project: projector(),
      width: view().w,
      height: view().h,
      labels: toggles.labels,
      sticky: stickyInputs(),
      crumbs: crumbsNow(frameNow),
      agent: agentTarget()
    });
    regionBoxes = wayfind.regions.map((r) => r.box);
  }

  /**
   * A caption's own box in screen pixels, for the CPU collision test against the
   * sticky region labels. The GPU collision filter cannot see DOM.
   */
  function labelBox(
    l: LabelItem,
    project: (x: number, y: number) => [number, number]
  ): { x: number; y: number; w: number; h: number } {
    const [px, py] = project(l.position[0], l.position[1]);
    return { x: px, y: py - l.size / 2, w: widthOfMixed(l.text.length, l.size), h: l.size };
  }

  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
    pad: number
  ): boolean =>
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

  const DIFF_RGB = {
    add: [46, 160, 67],
    mod: [210, 153, 34],
    del: [248, 81, 73],
    pending: [140, 148, 158]
  } as const;

  /**
   * A band is grey until the replay reaches the edit that produced it, then it
   * takes its colour and flashes once. Re-flashes on every later edit of the
   * same file, which is how a real session behaves: the diff is the final state
   * of the working tree, so the whole file's diff lands at its first edit.
   */
  function bandColor(d: DiffBand): [number, number, number, number] {
    // Live: what is on disk has happened, every band is in colour (see
    // CodeViewParams.diffsLanded). Replay: grey until the replay gets there.
    const at = applied.get(d.file) ?? (live ? -Infinity : undefined);
    if (at === undefined) {
      const [r, g, b] = DIFF_RGB.pending;
      return [r, g, b, 150];
    }
    const t = Math.min(1, Math.max(0, (frameNow - at) / APPLY_MS));
    const [r, g, b] = DIFF_RGB[d.kind];
    const flash = 1 - t;
    return [
      Math.round(r + (255 - r) * flash),
      Math.round(g + (255 - g) * flash),
      Math.round(b + (255 - b) * flash),
      Math.round(190 + 65 * t)
    ];
  }

  /** Rebuild the band colours while a flash is running, then stop. */
  function bandTrigger(): string {
    let flashing = false;
    for (const at of applied.values()) if (frameNow - at < APPLY_MS) flashing = true;
    return `${appliedVersion}|${flashing ? Math.round(frameNow / 60) : 0}`;
  }

  /** CollisionFilterExtension props are not in TextLayer's prop type. */
  const textProps = (p: Record<string, unknown>): never => p as never;

  function buildLayers(): Layer[] {
    const z = vs.zoom;
    labelSets();
    // Files are the unit of the map. Symbols are only what a file looks like
    // from close up, so once the schematic exists the building grid is gone.
    const showBuildings = z >= zoom.buildings && !codeView.enabled;
    const code = codeView.layers();
    // Roads are off by default (docs/design.md section 6). "show all roads"
    // brings the whole bundled network back, with the per-class zoom gates it
    // always had, and never at the terrain band: at the world fit the network is
    // a grey wash over every tile and it costs real fill rate.
    const allRoads = toggles.edges && bandOf(rowPxNow()) !== 'terrain';
    const showLocal = allRoads && z >= zoom.localRoads;
    const roadsNow = focusRoads();

    const layers: Array<Layer | null> = [
      // Geography (docs/design.md section 4): the fill ramp reads depth as tone,
      // and every district has a border at fixed contrast against its parent's
      // fill, 2 px for a top-level region and 1 px below it, with a 2 px radius.
      new PolygonLayer<Dir>({
        id: 'regions',
        data: dirsByDepth,
        getPolygon: (d) => roundedPoly(dirRectOf(d.id), 2 / 2 ** vs.zoom),
        getFillColor: (d) => districtFill(d),
        getLineColor: (d) => districtLine(d),
        getLineWidth: (d) => (levelOf(d) === 1 ? 2 : 1),
        lineWidthUnits: 'pixels',
        stroked: true,
        filled: true,
        updateTriggers: {
          getPolygon: zoomBucket,
          getFillColor: theme.name,
          getLineColor: theme.name
        }
      }),
      // The root files district (docs/design.md section 4): the bounding box of
      // the tiles that sit directly in the repository root, filled with the
      // depth-1 ramp tone and bordered like any other top-level region. Its
      // sticky label carries the repository name (see `places` above).
      rootDistrict
        ? new PolygonLayer<{ rect: Rect }>({
            id: 'root-district',
            data: [rootDistrict],
            getPolygon: (d) => roundedPoly(d.rect, 2 / 2 ** vs.zoom),
            getFillColor: theme.districtFill(rootDistrict.region, 1),
            getLineColor: theme.districtLine(rootDistrict.region, 1),
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            stroked: true,
            filled: true,
            updateTriggers: { getPolygon: zoomBucket, getFillColor: theme.name, getLineColor: theme.name }
          })
        : null,
      new SolidPolygonLayer({
        id: 'cities',
        data: cityData,
        _normalize: false,
        positionFormat: 'XY',
        filled: true,
        // Hover picking for the focus roads, and click for focus itself
        // (docs/design.md sections 6 and 8).
        pickable: true,
        onHover: ({ index }) => {
          const f = index >= 0 && index < repo.fileCount ? index : -1;
          if (f === hoverFile) return;
          hoverFile = f;
          redrawPending = true;
        },
        onClick: ({ index }) => {
          if (index < 0 || index >= repo.fileCount) return false;
          focusedFile = index;
          labelKey = '';
          redrawPending = true;
          return true;
        }
      }),
      new SolidPolygonLayer({
        id: 'buildings',
        data: bldData,
        _normalize: false,
        positionFormat: 'XY',
        filled: true,
        visible: showBuildings
      }),
      new PathLayer({
        id: 'roads-local',
        data: localData,
        _pathType: 'open',
        positionFormat: 'XY',
        widthUnits: 'pixels',
        widthMinPixels: 0.4,
        widthMaxPixels: 2.2,
        jointRounded: true,
        visible: showLocal
      }),
      new PathLayer({
        id: 'roads-motorway-minor',
        data: minorData,
        _pathType: 'open',
        positionFormat: 'XY',
        widthUnits: 'pixels',
        widthMinPixels: 0.5,
        widthMaxPixels: 2.6,
        jointRounded: true,
        visible: allRoads && z >= zoom.minorMotorways
      }),
      new PathLayer({
        id: 'roads-motorway-trunk',
        data: trunkData,
        _pathType: 'open',
        positionFormat: 'XY',
        widthUnits: 'pixels',
        widthMinPixels: 0.8,
        widthMaxPixels: 4,
        capRounded: true,
        jointRounded: true,
        visible: allRoads
      }),
      // The default road layer: only the hovered or focused file's own roads,
      // at full contrast in their class widths (1 / 1.5 / 3 px). Independent of
      // the toggle, and drawn above the network so a focused road reads through
      // it when both are on.
      new PathLayer<FocusRoad>({
        id: 'roads-focus',
        data: roadsNow,
        getPath: (d) => d.path,
        getColor: (d) => [d.color[0], d.color[1], d.color[2], 232],
        getWidth: (d) => d.width,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        widthMaxPixels: 4,
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: theme.name }
      }),
      // The sheets. The fill is the code background and it IS the tile: there is
      // no second box. Then the bars, one thin rect per token run on its own
      // row, and the ones under a source overlay on their own fading layer.
      // Drawn after the roads, because a sheet is a page lying on the ground.
      code.fills
        ? new SolidPolygonLayer({
            id: 'sheet-fills',
            data: code.fills,
            _normalize: false,
            positionFormat: 'XY',
            filled: true
          })
        : null,
      // The gutter's schematic half: every tenth line as a small dimmed bar in
      // the sheet's left margin, from rowPx 6 up (docs/design.md section 7).
      code.gutter
        ? new SolidPolygonLayer({
            id: 'gutter',
            data: code.gutter,
            _normalize: false,
            positionFormat: 'XY',
            filled: true
          })
        : null,
      // The aggregation level steps at discrete zooms, so the level that was on
      // screen keeps drawing for the fast duration while the new one comes up.
      code.barsPrev && code.barsPrevOpacity > 0.01
        ? new SolidPolygonLayer({
            id: 'schematic-prev',
            data: code.barsPrev,
            _normalize: false,
            positionFormat: 'XY',
            filled: true,
            opacity: code.barsPrevOpacity
          })
        : null,
      code.bars
        ? new SolidPolygonLayer({
            id: 'schematic',
            data: code.bars,
            _normalize: false,
            positionFormat: 'XY',
            filled: true,
            opacity: code.barsOpacity
          })
        : null,
      code.barsFading && code.fadeOpacity > 0.01
        ? new SolidPolygonLayer({
            id: 'schematic-fading',
            data: code.barsFading,
            _normalize: false,
            positionFormat: 'XY',
            filled: true,
            opacity: code.fadeOpacity
          })
        : null,
      changeStrips.length > 0 && bandOf(rowPxNow()) === 'terrain'
        ? new SolidPolygonLayer({
            id: 'change-strips',
            data: changeStrips,
            getPolygon: (d: { poly: Array<[number, number]> }) => d.poly,
            getFillColor: (d: { color: [number, number, number, number] }) => d.color,
            updateTriggers: { getPolygon: changeVersion, getFillColor: changeVersion }
          })
        : null,
      code.bands.length > 0
        ? new SolidPolygonLayer<DiffBand>({
            id: 'diff-bands',
            data: code.bands,
            getPolygon: (d: DiffBand) => d.poly,
            getFillColor: (d: DiffBand) => bandColor(d),
            updateTriggers: { getFillColor: bandTrigger() }
          })
        : null,
      new SolidPolygonLayer<TrafficItem>({
        id: 'traffic',
        data: trafficLayerData,
        getPolygon: (d) => d.poly,
        getFillColor: (d) => [theme.traffic[0], theme.traffic[1], theme.traffic[2], Math.round((d.strong ? 175 : 120) * d.alpha)],
        visible: toggles.traffic || toggles.autopilot
      }),
      // The reading band's activity mark: a 2-3 px amber glow on the sheet's own
      // border, fading on the slow duration. Stroke only, so no wash ever lands
      // on the text box (docs/design.md section 9).
      new PolygonLayer<SheetGlow>({
        id: 'sheet-glow',
        data: sheetGlowLayerData,
        getPolygon: (d) => d.poly,
        filled: false,
        stroked: true,
        getLineColor: (d) => [theme.traffic[0], theme.traffic[1], theme.traffic[2], Math.round(235 * d.alpha)],
        getLineWidth: (d) => d.widthPx,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 2,
        lineWidthMaxPixels: 3,
        lineJointRounded: true,
        visible: toggles.traffic || toggles.autopilot,
        updateTriggers: { getLineColor: theme.name }
      }),
      new PathLayer<TripPath>({
        id: 'trip-roads',
        data: tripPathData,
        getPath: (d) => d.path,
        getColor: (d) => {
          const heat = Autopilot.heat(d.trip, frameNow);
          return [theme.traffic[0], theme.traffic[1], theme.traffic[2], Math.round(225 * heat)];
        },
        getWidth: (d) => 1.1 + 1.8 * Math.log2(1 + d.trip.volume),
        widthUnits: 'pixels',
        widthMinPixels: 1,
        widthMaxPixels: 11,
        capRounded: true,
        jointRounded: true,
        visible: toggles.autopilot
      }),
      new ScatterplotLayer<Pulse>({
        id: 'trip-pulses',
        data: pulseDrawData,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.6,
        getLineColor: (d) => [theme.traffic[0], theme.traffic[1], theme.traffic[2], Math.round(210 * d.alpha)],
        visible: toggles.autopilot
      }),
      new ScatterplotLayer<Marker>({
        id: 'trip-markers',
        data: markerDrawData,
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        filled: true,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        getLineColor: [theme.labelHalo[0], theme.labelHalo[1], theme.labelHalo[2], 220],
        getFillColor: (d) => [255, 243, 222, Math.round(255 * d.alpha)],
        visible: toggles.autopilot
      }),
      new TextLayer<LabelItem>(textProps({
        id: 'city-labels',
        data: cityLabelData,
        getPosition: (d: LabelItem) => d.position,
        getText: (d: LabelItem) => d.text,
        getSize: (d: LabelItem) => d.size,
        getColor: theme.cityLabel,
        // Left aligned, so a file name reads as a caption on its page. 'center'
        // for the baseline matters: CollisionFilterExtension samples the
        // collision map at the anchor, and a 'top' baseline puts the anchor on
        // the glyph edge, which fades every label to ~20% alpha.
        getTextAnchor: 'start',
        getAlignmentBaseline: 'center',
        sizeUnits: 'pixels',
        fontFamily: FONT,
        fontWeight: 500,
        characterSet: CHAR_SET,
        fontSettings: { sdf: true, fontSize: 44, radius: 10, buffer: 4 },
        outlineWidth: 2.4,
        outlineColor: theme.labelHalo,
        getCollisionPriority: (d: LabelItem) => d.priority,
        collisionGroup: 'labels',
        collisionTestProps: { sizeScale: 1.15 },
        extensions: labelExtensions,
        updateTriggers: { getColor: theme.name }
      }))
    ];
    return layers.filter((l): l is Layer => l !== null);
  }

  // ---------------------------------------------------------------------- deck
  function applyCss(): void {
    const s = document.documentElement.style;
    s.setProperty('--bg', theme.css.bg);
    s.setProperty('--fg', theme.css.fg);
    s.setProperty('--panel', theme.css.panel);
    s.setProperty('--border', theme.css.border);
    s.setProperty('--accent', theme.css.accent);
    s.setProperty('--code-bg', theme.css.codeBg);
    s.setProperty('--code-fg', theme.css.codeFg);
    s.setProperty('--jump', theme.css.jump);
    s.setProperty('--narration', theme.css.narration);
    s.colorScheme = theme.name;
    document.body.style.background = theme.css.bg;
  }
  applyCss();

  let frameCount = 0;
  let redrawPending = false;
  /**
   * deck.gl 9.3 pain point: CollisionFilterEffect only re-renders its collision
   * map when the viewport changes (or the layer list / bounds change). On a
   * static camera the map is rendered once, before the TextLayer font atlas is
   * ready, so every label fails the visibility test and stays hidden forever.
   * Nudging the camera by a sub-pixel amount for a few frames after the label
   * set changes forces the collision pass to run again. See README.
   */
  let kickFrames = 0;
  let flyUntil = 0;
  /** deck.gl renders since construction. The splash waits for the first ones. */
  let renders = 0;

  const deck = new Deck({
    canvas,
    views: [new OrthographicView({ id: 'ortho', flipY: false })],
    viewState: vs as never,
    controller: { doubleClickZoom: true, scrollZoom: { speed: 0.012, smooth: true } },
    layers: buildLayers(),
    useDevicePixels: qs.has('dpr') ? num('dpr', 1) : true,
    _animate: true,
    onAfterRender: () => { renders++; },
    onViewStateChange: ({ viewState }) => {
      // The controller only reports user gestures now (no transitions run
      // through it), so any report is a takeover: the flight ends here.
      flight = null;
      const next = viewState as unknown as { target: [number, number, number]; zoom: number };
      vs = { target: next.target, zoom: next.zoom, minZoom: vs.minZoom, maxZoom: vs.maxZoom };
      deck.setProps({ viewState: vs as never });
      cameraMoved(performance.now());
    },
    onError: (err: Error) => {
      console.error('[deck.gl error]', err);
      (window as unknown as { __wakeError?: string }).__wakeError = String(err && err.message);
    }
  });

  /**
   * The same projection deck.gl uses, taken from its own viewport so the DOM
   * overlays cannot drift from the canvas. Falls back to the orthographic
   * formula before the first render.
   */
  function projector(): (x: number, y: number) => [number, number] {
    // getViewports() asserts before the first render, hence the try.
    let vp: { project(c: number[]): number[] } | undefined;
    try {
      vp = deck.getViewports()[0] as unknown as { project(c: number[]): number[] } | undefined;
    } catch {
      vp = undefined;
    }
    if (vp) {
      return (x, y) => {
        const p = vp.project([x, y]);
        return [p[0], p[1]];
      };
    }
    const { w, h } = view();
    const s2 = 2 ** vs.zoom;
    return (x, y) => [(x - vs.target[0]) * s2 + w / 2, h / 2 - (y - vs.target[1]) * s2];
  }

  /**
   * Cheap change detector for the code layers. The row height is part of it:
   * the sheets' world geometry follows rowPx while the squeeze is being
   * released, and the polygon counts alone would not notice.
   */
  function codeSignature(): string {
    const c = codeView.layers();
    return [
      Math.round(codeView.state().rowPx * 100),
      c.fills?.length ?? -1,
      c.gutter?.length ?? -1,
      c.bars?.length ?? -1,
      c.barsOpacity.toFixed(2),
      c.barsPrev?.length ?? -1,
      c.barsPrevOpacity.toFixed(2),
      c.barsFading?.length ?? -1,
      c.fadeOpacity.toFixed(2),
      c.bands.length
    ].join('|');
  }

  // ------------------------------------------------------------------ hud loop
  const fixture = {
    isRealExport: exportMeta ? 1 : 0,
    regions: repo.regions.length,
    directories: repo.dirs.length,
    files: repo.fileCount,
    symbols: repo.symCount,
    edges: repo.edgeCount,
    trunkMotorways: roads.trunk.count,
    minorMotorways: roads.minor.count,
    localRoads: roads.local.count,
    roadVertices: roads.local.vertices + roads.trunk.vertices + roads.minor.vertices,
    cityLabelCandidates: cityLabelPool.length,
    sessionEvents: session.events.length,
    genMs: Math.round(tGen),
    layoutMs: Math.round(tLayout),
    roadsMs: Math.round(tRoads),
    worldSide: Math.round(Math.max(layout.world.w, layout.world.h)),
    zoomBase: Math.round(zoom.base * 100) / 100,
    cityAreaPctOfRegion: Math.round(layout.fillRatio * 1000) / 10,
    rowWorld: rowWorld,
    effectiveLines: exportMeta ? exportMeta.effectiveLines : 0,
    foldedFiles: exportMeta ? exportMeta.folded : countFolded(),
    stubs: exportMeta ? exportMeta.stubs : countStubs(),
    districtCoveragePct: Math.round(layout.districtCoverage * 1000) / 10,
    zoomSchematic: Math.round(zoomForRowPx(rowWorld, ROW_PX_SCHEMATIC) * 1000) / 1000,
    zoomReading: Math.round(zoomForRowPx(rowWorld, ROW_PX_READ) * 1000) / 1000,
    zoomMax: Math.round(codeView.maxZoom * 1000) / 1000
  };

  function countFolded(): number {
    let n = 0;
    for (let f = 0; f < repo.fileCount; f++) if (repo.fileFolded[f]) n++;
    return n;
  }
  function countStubs(): number {
    let n = 0;
    for (let f = 0; f < repo.fileCount; f++) if (repo.fileLines[f] < STUB_LINES) n++;
    return n;
  }

  const sourceLine = exportMeta
    ? `${exportMeta.name} @ ${exportMeta.commit} \u00b7 ${exportMeta.cells} cells \u00b7 session ${exportMeta.sessionId}\n` +
      `${exportMeta.dirs} dirs, ${exportMeta.files} files, ${exportMeta.symbols} symbols, ${exportMeta.edges} import edges\n` +
      `${exportMeta.events} events, ${exportMeta.mappedEvents} on the map\n` +
      `${exportMeta.effectiveLines.toLocaleString()} effective lines, ${exportMeta.folded} folded, ${exportMeta.stubs} stubs`
    : `${fixture.files.toLocaleString()} files, ${fixture.symbols.toLocaleString()} symbols, ${fixture.edges.toLocaleString()} edges`;
  const hud = buildHud(
    hudEl,
    `${sourceLine}\n` +
      `layout ${fixture.layoutMs}ms, roads ${fixture.roadsMs}ms\n` +
      `tiles cover ${fixture.cityAreaPctOfRegion}% of region area, ` +
      `${fixture.districtCoveragePct}% of the median district (>8 files)`,
    debugHud
  );
  /**
   * The agent console. It is the panel the design gives the bottom-left corner
   * (section 10), and it is always on: it is the only place the user sees what
   * the agent is doing when the camera is not following it.
   */
  const HOVER_GLOW_MS = 1400;
  const agentConsole = buildAgentConsole(agentEl, {
    follow: () => {
      if (!toggles.autopilot) controls.setToggle('autopilot', true);
      cam.engage();
    },
    go: (i) => {
      const e = session.events[i];
      if (!e || e.file < 0) return;
      focusedFile = e.file;
      labelKey = '';
      if (e.lineStart) {
        // The line range, framed the way the replay frames an edit: aim at the
        // middle of the hunk at the zoom that makes the whole of it readable.
        const span = Math.max(1, (e.lineEnd ?? e.lineStart) - e.lineStart + 1);
        const rowPx = Math.max(READ_PX, Math.min(ROW_PX_MAX, (view().h * 0.72) / span));
        flyToPose(codeView.focusPose(e.file, e.lineStart - 1 + Math.floor(span / 2), rowPx), 800, true);
      } else {
        flyToPose(codeView.focusPose(e.file, null, READ_PX), 800, true);
      }
      redrawPending = true;
    },
    hover: (i) => {
      const f = i >= 0 ? (session.events[i]?.file ?? -1) : -1;
      // A brief glow on the file's sheet border (its tile, zoomed out), and its
      // roads while the pointer rests on the line.
      if (f >= 0) touch(f, performance.now(), false, HOVER_GLOW_MS);
      hoverFile = f;
      redrawPending = true;
    }
  });
  consoleLineList = consoleLines();
  agentConsole.setLines(consoleLineList);
  let consoleCursor = -1;

  /**
   * The replay timeline (PLAN.md section 12): a finished session only. Live
   * mode has no timeline, the daemon is the clock.
   */
  const timeline = buildTimeline(timelineEl, {
    setPaused: (p) => autopilot.setPaused(p, performance.now()),
    scrub: (i) => scrubTo(i),
    setCadence: (ms) => autopilot.setCadence(ms, performance.now())
  });
  const tickOf = (e: SessionEvent): TickKind =>
    e.kind === 'edit' || e.kind === 'write' ? 'edit'
      : e.kind === 'read' || e.kind === 'search' ? 'read'
        : e.kind === 'run' ? 'run'
          : e.kind === 'message' ? (e.role === 'user' ? 'prompt' : 'say')
            : 'other';
  if (live) timelineEl.hidden = true;
  else timeline.setEvents(session.events.map(tickOf), consoleLineList.map((l) => l.time));

  /**
   * Every file that differs from the session's baseline (the shell feeds it
   * from the daemon's /changes): the list top right, and a strip on each
   * changed tile at the terrain band, where no file shows its own diff yet.
   */
  const changesPanel = buildChanges(changesEl, {
    go: (path) => {
      // Reviewing is taking the wheel: the autopilot would pull the camera
      // straight back to the agent. Follow hands it back.
      setAutopilotOn(false);
      handle.focus(path);
    },
    scope: (next) => {
      // The shell owns the source and the /changes fetch, so it learns the
      // scope first; then every loaded diff is refetched under it.
      options.onDiffScope?.(next);
      codeView.invalidateLoaded();
      redrawPending = true;
    }
  });
  function setChanges(list: Change[] | null): void {
    changeByFile = new Map();
    for (const c of list ?? []) {
      const f = fileOf(c.path);
      if (f >= 0) changeByFile.set(f, c);
    }
    changeStrips = [];
    for (const [f, c] of changeByFile) {
      const x = layout.cityRect[f * 4];
      const y = layout.cityRect[f * 4 + 1];
      const w = layout.cityRect[f * 4 + 2];
      const h = layout.cityRect[f * 4 + 3];
      const sw = w * 0.22;
      const rgb = c.created || c.removed === 0 ? DIFF_RGB.add : c.added === 0 ? DIFF_RGB.del : DIFF_RGB.mod;
      changeStrips.push({
        poly: [[x + w - sw, y], [x + w, y], [x + w, y + h], [x + w - sw, y + h]],
        color: [rgb[0], rgb[1], rgb[2], 235]
      });
    }
    changeVersion++;
    // null is "the daemon cannot say", which the panel states; [] is "nothing".
    changesPanel.set(list === null ? null : list.filter((c) => fileOf(c.path) >= 0));
    redrawPending = true;
  }

  function countVisible(): { cities: number; edges: number; buildings: number } {
    const [x0, y0, x1, y1] = bounds();
    let c = 0;
    let bl = 0;
    for (let f = 0; f < repo.fileCount; f++) {
      const x = layout.cityRect[f * 4];
      const y = layout.cityRect[f * 4 + 1];
      const w = layout.cityRect[f * 4 + 2];
      const h = layout.cityRect[f * 4 + 3];
      if (x + w >= x0 && x <= x1 && y + h >= y0 && y <= y1) {
        c++;
        bl += repo.fileSymStart[f + 1] - repo.fileSymStart[f];
      }
    }
    let e = 0;
    // Roads in view means roads DRAWN: the network only when "show all roads" is
    // on and the camera is off the terrain band, plus the hovered or focused
    // file's own roads, which are always drawn.
    const subject = roadFileOf();
    if (subject >= 0) e += incidentCounts(subject).total;
    if (toggles.edges && bandOf(rowPxNow()) !== 'terrain') {
      const localOn = vs.zoom >= zoom.localRoads;
      const minorOn = vs.zoom >= zoom.minorMotorways;
      for (let i = 0; i < repo.edgeCount; i++) {
        if (!repo.edgeCross[i]) {
          if (!localOn) continue;
        } else if (!minorOn && repo.edgeWeight[i] < roads.trunkWeight) continue;
        const a = repo.edgeSrc[i];
        const b = repo.edgeDst[i];
        const ax = layout.cityCentroid[a * 2];
        const ay = layout.cityCentroid[a * 2 + 1];
        const bx = layout.cityCentroid[b * 2];
        const by = layout.cityCentroid[b * 2 + 1];
        if (Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1) e++;
      }
    }
    return { cities: c, edges: e, buildings: !codeView.enabled && vs.zoom >= zoom.buildings ? bl : 0 };
  }

  const levelName = (z: number) => zoom.level(z);

  const recent: number[] = [];
  let sampling: number[] | null = null;
  let last = performance.now();
  let hudAt = 0;
  const stamps: number[] = [];

  function loop(now: number): void {
    if (destroyed) return;
    const dt = now - last;
    last = now;
    frameCount++;
    if (frameCount > 4) {
      recent.push(dt);
      if (recent.length > 400) recent.shift();
      if (sampling) sampling.push(dt);
      stamps.push(now);
      while (stamps.length > 1 && now - stamps[0] > 1000) stamps.shift();
    }

    if (kickFrames > 0 && now > flyUntil) {
      kickFrames--;
      const eps = (kickFrames % 2 === 0 ? 1 : -1) * 0.0008;
      vs = { target: [vs.target[0] + eps, vs.target[1], 0], zoom: vs.zoom, minZoom: vs.minZoom, maxZoom: vs.maxZoom };
      deck.setProps({ viewState: vs as never });
    }

    frameNow = now;
    stepFlight(now);
    stepAutopilot(now, dt);
    tickTraffic(dt, now);
    if (toggles.traffic || toggles.autopilot) {
      trafficLayerData = trafficData(now);
      redrawPending = true;
    }
    if (codeView.enabled) {
      const before = codeSignature();
      codeView.update({
        now,
        zoom: vs.zoom,
        bounds: bounds(),
        project: projector(),
        stillMs: now - lastMoveAt,
        dragging: pointerDown,
        applied,
        diffsLanded: live
      });
      if (codeSignature() !== before) redrawPending = true;
      // While a flash is running the band colours change every frame.
      for (const at of applied.values()) if (now - at < APPLY_MS) redrawPending = true;
    }

    // The sheets of this frame are known now, so the reading band's own activity
    // marks and the trip clip are built here rather than in stepAutopilot.
    if (toggles.traffic || toggles.autopilot) {
      const glow = sheetGlowData(now);
      if (glow.length > 0 || sheetGlowLayerData.length > 0) redrawPending = true;
      sheetGlowLayerData = glow;
    } else if (sheetGlowLayerData.length > 0) {
      sheetGlowLayerData = [];
      sheetGlowNow.clear();
      redrawPending = true;
    }
    if (toggles.autopilot) clipTrips();
    else if (tripPathData.length > 0) {
      tripPathData = [];
      markerDrawData = [];
      pulseDrawData = [];
    }

    // Wayfinding is DOM and cheap, and its region labels are obstacles for the
    // caption collision below, so it runs before the layers are rebuilt. The
    // console header is DOM too and diffs its own writes, so it can run per
    // frame and never lag the replay; the log is touched on event boundaries
    // only, when the cursor has moved (a tick, a scrub, a loop).
    stepWayfinding();
    agentConsole.setHeader(consoleHeader(now));
    if (autopilot.cursor !== consoleCursor) {
      consoleCursor = autopilot.cursor;
      agentConsole.setCursor(consoleCursor);
      if (!live) timeline.setCursor(consoleCursor);
    }
    changesPanel.setCurrent(agentFile >= 0 ? pathOf(repo, agentFile) : null);

    if (redrawPending) {
      redrawPending = false;
      deck.setProps({ layers: buildLayers() });
    }

    if (now - hudAt > 250) {
      hudAt = now;
      const c = countVisible();
      const cs = codeView.state();
      const fps = stamps.length > 1 ? (stamps.length - 1) / ((now - stamps[0]) / 1000) : 0;
      const sorted = [...recent].sort((a, b) => a - b);
      hud.update({
        fps,
        frameMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        zoom: vs.zoom,
        band: bandOf(rowPxNow()),
        rowPx: rowPxNow(),
        group: cs.group,
        cities: c.cities,
        labels: wayfind.regions.length + cityLabelData.length,
        edges: c.edges,
        buildings: c.buildings,
        traffic: touched.size,
        camState: toggles.autopilot ? cam.label(now) : 'off',
        event: eventLine(),
        codeTier: cs.tier,
        schematics: cs.schematics,
        overlays: cs.overlays,
        hotRoads: autopilot.trips.size,
        sessionPct: toggles.autopilot ? (100 * autopilot.cursor) / Math.max(1, autopilot.eventCount) : -1,
        eventTime: toggles.autopilot ? eventTime() : '--'
      });
      controls.setReplay(autopilot.cursor, autopilot.eventCount);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------------ controls
  const controls = buildControls(
    controlsEl,
    repo.regionNames.slice(0, 10),
    {
      fitAll: () => flyTo(layout.world, 900, true),
      flyRegion: (i) => flyTo(dirRectOf(repo.regions[i]), 1100, true),
      flyLevel: (l) => {
        // 'source' is not a rect: the zoom follows the file's own line count, so
        // that one source line is about 13 px tall whatever the file's length.
        if (l === 'source') flyToPose(codeView.focusPose(streetFile, null, sourceRowPx), 1100, true);
        else flyTo(RECTS[l](), 1100, true);
      },
      toggle: (key, on) => {
        (toggles as unknown as Record<string, boolean>)[key] = on;
        if (key === 'autopilot') {
          if (on) {
            autopilot.start(performance.now(), 0);
            cam.engage();
          } else {
            markerData = [];
            pulseData = [];
            hotRoadData = [];
            focus = null;
            focusedFile = -1;
          }
        }
        labelKey = '';
        redrawPending = true;
      },
      follow: () => cam.engage(),
      pauseAgent: (paused) => autopilot.setPaused(paused, performance.now()),
      setWait: (v) => { cam.params.wait = v; },
      setTime: (v) => { cam.params.time = v; },
      scrub: (i) => scrubTo(i),
      setSpeed: (ms) => autopilot.setCadence(ms, performance.now()),
      setTheme: applyTheme,
      runBench: () => void startBench()
    },
    { ...toggles, wait: cam.params.wait, time: cam.params.time, cadenceMs: autopilot.cadenceMs, events: autopilot.eventCount, scrubbable: true }
  );

  /** Switch the palette everywhere: the layers, the source overlays and the CSS. */
  function applyTheme(t: ThemeName): void {
    theme = makeTheme(t);
    toggles.theme = t;
    codeView.setTheme(theme);
    repaint();
    rebuildBinaries();
    applyCss();
    timeline.redraw();
    redrawPending = true;
  }

  /** Jump the replay to event `i`: the controls' scrubber and the test hook. */
  function scrubTo(i: number): void {
    const now = performance.now();
    autopilot.seekTo(i, now);
    focus = null;
    // Rebuild the applied set from the events before the cursor, already
    // past their animation, so scrubbing shows the state at that point.
    applied.clear();
    for (let k = 0; k < Math.min(i, session.events.length); k++) {
      const e = session.events[k];
      if (e.file >= 0 && (e.kind === 'edit' || e.kind === 'write')) applied.set(e.file, now - APPLY_MS);
    }
    appliedVersion++;
    redrawPending = true;
  }
  (window as unknown as { __wakeScrub?: (i: number) => void }).__wakeScrub = (i) => scrubTo(i);
  (window as unknown as { __wakeCadence?: (ms: number) => void }).__wakeCadence = (ms) => {
    autopilot.setCadence(ms, performance.now());
  };

  // --------------------------------------------------------------------- bench
  async function startBench(): Promise<BenchResult> {
    hud.setBenchText('bench running...');
    benchSuspendedAutopilot = toggles.autopilot;
    toggles.autopilot = false;
    const result = await runBench({
      goto: (level, ms) => flyTo(RECTS[level](), ms),
      sample: (ms) =>
        new Promise<number[]>((resolve) => {
          sampling = [];
          setTimeout(() => {
            const out = sampling ?? [];
            sampling = null;
            resolve(out);
          }, ms);
        }),
      snapshot: () => {
        const c = countVisible();
        return {
          zoom: vs.zoom,
          cities: c.cities,
          labels: wayfind.regions.length + cityLabelData.length,
          edges: c.edges,
          buildings: c.buildings
        };
      },
      fixture,
      canvas: { width: view().w, height: view().h },
      deckMetrics: () => {
        const m = (deck as unknown as { metrics?: Record<string, number> }).metrics;
        if (!m) return null;
        const keep = ['fps', 'framesRedrawn', 'gpuTimePerFrame', 'cpuTimePerFrame', 'updateAttributesTime', 'setPropsTime'];
        const out: Record<string, number> = {};
        for (const k of keep) if (typeof m[k] === 'number') out[k] = Math.round(m[k] * 100) / 100;
        return out;
      },
      onPhase: (name, done, total) => hud.setBenchText(`bench ${done}/${total} (${name})...`)
    });
    const text = formatBench(result);
    console.log('[wake spike 1 bench]\n' + text);
    hud.setBenchText(text);
    if (benchSuspendedAutopilot) {
      toggles.autopilot = true;
      autopilot.start(performance.now(), 0);
      cam.engage();
    }
    (window as unknown as { __wakeBench?: BenchResult }).__wakeBench = result;
    return result;
  }
  (window as unknown as { __wakeStartBench?: () => Promise<BenchResult> }).__wakeStartBench = startBench;

  // --------------------------------------------------------------- entry point
  const initialView = qs.get('view');
  /**
   * A deep link lands on the file (docs/design.md section 8): the start of the
   * reading band, with the file's first changed line centred, or its first line
   * when it has no diff. `?file=` alone is the deep link, and `view=street` and
   * `view=source` are aliases for it; `view=schematic` aims at the middle of the
   * schematic band instead, for the schematic screenshots.
   */
  const READING_VIEWS = ['source', 'street', 'reading'];
  const deepLink = codeView.enabled &&
    (READING_VIEWS.includes(initialView ?? '') || initialView === 'schematic' ||
      (qs.get('file') !== null && initialView === null));
  if (deepLink) {
    const rowPx = initialView === 'schematic' ? 5 : sourceRowPx;
    // A deep link is focus (docs/design.md section 8), so the jump bar and the
    // caption priority both describe the file the link landed on.
    focusedFile = streetFile;
    // The line count and the diff are not known until the file is fetched, so
    // aim at its first line now and re-aim at the first changed line once the
    // tokens and the diff are in.
    flyToPose(codeView.focusPose(streetFile, null, rowPx), 0);
    let corrected = false;
    const correct = setInterval(() => {
      if (corrected) return;
      if (codeView.lineCountOf(streetFile) === null) return;
      corrected = true;
      clearInterval(correct);
      flyToPose(codeView.focusPose(streetFile, null, rowPx), 500);
    }, 120);
    setTimeout(() => clearInterval(correct), 20_000);
  } else if (initialView && RECTS[initialView]) {
    const f = fitRect(RECTS[initialView]());
    vs = { target: f.target, zoom: f.zoom, minZoom: vs.minZoom, maxZoom: vs.maxZoom };
    zoomBucket = Math.round(vs.zoom * 4);
    labelKey = '';
    deck.setProps({ viewState: vs as never, layers: buildLayers() });
  }
  // Any gesture on the canvas is a takeover, immediately and unambiguously.
  // deck.gl's interactionState arrives a frame late and does not see the wheel.
  for (const type of ['wheel', 'pointerdown', 'touchstart', 'gesturestart'] as const) {
    on(canvas, type, () => {
      cam.noteUserInput(performance.now());
      flight = null;
    }, { passive: true, capture: true });
  }
  // A drag is the one case where the overlays go instantly: a blurred ghost
  // lagging a pan looks worse than the schematic standing in.
  for (const type of ['pointerdown', 'touchstart'] as const) {
    on(canvas, type, () => { pointerDown = true; redrawPending = true; }, { passive: true, capture: true });
  }
  for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const) {
    on(window, type, () => { pointerDown = false; }, { passive: true, capture: true });
  }
  // `?loop=0` lets the replay end instead of starting over, which is the idle
  // state the agent card reports (docs/design.md section 10).
  autopilot.loop = flag('loop', true);
  if (toggles.autopilot) {
    autopilot.start(performance.now(), num('seek', 0));
    // The splash reveals the map where it will start. With autopilot on that is
    // its current target, not the fit-all the camera was built with, so jump
    // there before the first render instead of flying there behind the splash.
    const { w, h } = view();
    const t = autopilot.openingTarget(performance.now(), w, h);
    if (t) flyToPose(t, 0);
  }

  // Escape clears focus (docs/design.md section 8), so the jump bar goes back to
  // describing the viewport centre.
  on(window, 'keydown', (e) => {
    const inField = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    // `l` toggles the console's log between its two heights.
    if (e.key === 'l' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
      agentConsole.toggleExpanded();
      return;
    }
    if (e.key !== 'Escape') return;
    focusedFile = -1;
    labelKey = '';
    redrawPending = true;
  });

  on(window, 'resize', () => { redrawPending = true; });
  // The setting can flip while the page is open: drop the spring's velocity so
  // the new time constant is not applied to momentum built under the old one.
  onMotionChange(() => {
    // A flight caught by the flip lands now: reduced motion means no flights.
    if (flight) { setPose(flight.to, true); flight = null; }
    cam.engage();
    redrawPending = true;
  });
  (window as unknown as { __wakeReady?: boolean }).__wakeReady = true;
  (window as unknown as { __deck?: unknown }).__deck = deck;
  /** Test hook for the screenshot script. */
  (window as unknown as { __wakeAutoState?: () => unknown }).__wakeAutoState = () => {
    const now = performance.now();
    let crossAgeMs = 1e9;
    for (const tr of autopilot.trips.values()) {
      if (tr.cross) crossAgeMs = Math.min(crossAgeMs, now - tr.startedAt);
    }
    return {
      on: toggles.autopilot,
      camState: cam.state,
      label: cam.label(now),
      zoom: vs.zoom,
      level: levelName(vs.zoom),
      band: bandOf(rowPxNow()),
      event: eventLine(),
      trips: autopilot.trips.size,
      touches: autopilot.touches.length,
      crossAgeMs,
      sessionPct: (100 * autopilot.clock(now)) / session.duration,
      wait: cam.params.wait,
      time: cam.params.time,
      crossTripTimes: autopilot.crossTripTimes(),
      sessionDuration: session.duration
    };
  };
  (window as unknown as { __wakeFixture?: typeof fixture }).__wakeFixture = fixture;
  /** Test hook for the code-view screenshots and fps probe. */
  (window as unknown as { __wakeCodeState?: () => unknown }).__wakeCodeState = () => {
    const now = performance.now();
    const cs = codeView.state();
    const fps = stamps.length > 1 ? (stamps.length - 1) / ((now - stamps[0]) / 1000) : 0;
    const sorted = [...recent].sort((a, b) => a - b);
    return {
      ...cs,
      enabled: codeView.enabled,
      zoom: vs.zoom,
      maxZoom: vs.maxZoom,
      level: levelName(vs.zoom),
      band: bandOf(rowPxNow()),
      rowPx: rowPxNow(),
      rowWorld,
      stillMs: Math.round(now - lastMoveAt),
      restMs: REST_MS,
      readablePx: ROW_PX_READ,
      maxRowPx: ROW_PX_MAX,
      file: streetFile,
      sheet: codeView.probe(streetFile),
      firstChanged: codeView.firstChangedLineOf(streetFile),
      probes: codeView.sheetFiles().map((f) => codeView.probe(f)),
      appliedFiles: applied.size,
      hover: hoverFile,
      focusedFile,
      fps,
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      frames: frameCount
    };
  };

  /**
   * Test hooks for the phase-1 verification: fly to an exact row height, and
   * audit the sheet geometry.
   */
  /** The file whose tile is nearest to `f`, for the two-file type checks. */
  function nearestOther(f: number): number {
    const x = layout.cityRect[f * 4];
    const y = layout.cityRect[f * 4 + 1];
    let best = -1;
    let bestD = Infinity;
    for (let g = 0; g < repo.fileCount; g++) {
      if (g === f) continue;
      const dx = layout.cityRect[g * 4] - x;
      const dy = layout.cityRect[g * 4 + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }
  (window as unknown as {
    __wakeGoto?: (o: {
      rowPx: number; file?: number; line?: number | null; ms?: number;
      dxPx?: number; dyPx?: number; pair?: boolean;
    }) => unknown
  }).__wakeGoto = (o) => {
      const f = o.file ?? streetFile;
      const pose = codeView.focusPose(f, o.line ?? null, o.rowPx);
      // `pair` centres the camera between this file's sheet and its right-hand
      // neighbour's, so both are on screen at once.
      const n = o.pair ? nearestOther(f) : -1;
      if (n >= 0) {
        const pa = codeView.focusPose(f, 0, o.rowPx);
        const pb = codeView.focusPose(n, 0, o.rowPx);
        pose.x = (pa.x + pb.x) / 2;
        pose.y = (pa.y + pb.y) / 2;
      }
      // Offsets are in screen pixels at the pose's own zoom, so a test can put
      // two neighbouring sheets in view.
      const s2 = 2 ** pose.zoom;
      pose.x += (o.dxPx ?? 0) / s2;
      pose.y -= (o.dyPx ?? 0) / s2;
      flyToPose(pose, o.ms ?? 0);
      return { file: f, ...pose, maxZoom: vs.maxZoom };
    };
  (window as unknown as { __wakeAudit?: (limit?: number) => unknown }).__wakeAudit = (limit) => codeView.audit(limit);

  /** The flight in progress, for the checks that a fly-to glides and a gesture ends it. */
  (window as unknown as { __wakeFlight?: () => unknown }).__wakeFlight = () =>
    flight ? { from: flight.from, to: flight.to, ms: flight.ms, progress: flight.progress(performance.now()) } : null;

  /** Fit the whole world, for the label checks at the widest zoom. */
  (window as unknown as { __wakeFitAll?: () => void }).__wakeFitAll = () => flyTo(layout.world, 0);

  /** sheetOf on a hypothetical file length, at the current zoom. */
  (window as unknown as { __wakeSheetProbe?: (n: number) => unknown }).__wakeSheetProbe =
    (n) => codeView.sheetProbe(n, 2 ** vs.zoom);

  /**
   * Geography, for the phase-2 checks: every district's rect, its nesting level,
   * and the exact fill and border colour the ramp gave it. No names leave here.
   */
  (window as unknown as { __wakeGeo?: () => unknown }).__wakeGeo = () => ({
    regionDepth: repo.regionDepth,
    theme: theme.name,
    land: { fill: theme.landFill, line: theme.landLine },
    dirs: repo.dirs.map((d) => ({
      id: d.id,
      parent: d.parent,
      depth: d.depth,
      level: levelOf(d),
      region: d.region,
      files: d.files.length,
      subtreeFiles: d.fileCount,
      fill: districtFill(d),
      line: districtLine(d),
      rect: dirRectOf(d.id)
    }))
  });

  /**
   * Every label on the screen, projected. `districts` are the sticky region
   * labels, which are DOM since phase 5, and `files` the captions still fed to
   * the TextLayer.
   */
  (window as unknown as { __wakeLabels?: () => unknown }).__wakeLabels = () => {
    const p = projector();
    const shot = (l: LabelItem) => {
      const [px, py] = p(l.position[0], l.position[1]);
      const tl = p(l.rect[0], l.rect[1] + l.rect[3]);
      const br = p(l.rect[0] + l.rect[2], l.rect[1]);
      return {
        text: l.text,
        size: l.size,
        priority: l.priority,
        kind: l.kind,
        file: l.file,
        anchor: { x: px, y: py },
        rect: { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] }
      };
    };
    return {
      districts: wayfind.regions.map((r) => ({
        text: r.text,
        full: r.full,
        size: r.size,
        priority: r.priority,
        kind: 'region',
        depth: r.depth,
        dir: r.dir,
        stack: r.stack,
        sticky: r.sticky,
        anchor: { x: r.box.x, y: r.box.y },
        box: r.box,
        clip: r.clip,
        rect: r.rect
      })),
      files: cityLabelData.map(shot)
    };
  };

  /** Everything the wayfinding checks read: labels, headers, bar, marker. */
  (window as unknown as { __wakeWayfind?: () => unknown }).__wakeWayfind = () => ({
    band: bandOf(rowPxNow()),
    rowPx: rowPxNow(),
    focusedFile,
    agentFile,
    regions: wayfind.regions,
    stickies: wayfind.stickies,
    cornerYields: wayfind.cornerYields,
    crumbs: wayfind.crumbs,
    jumpText: (document.getElementById('wf-jump')?.textContent ?? '').trim(),
    edge: wayfind.edgeMarker,
    captions: cityLabelData.map((l) => ({ text: l.text, file: l.file, size: l.size, priority: l.priority })),
    camState: cam.state,
    autopilot: toggles.autopilot
  });

  /**
   * Test hook: expand the collapsed panels. The controls panel starts collapsed
   * now (docs/design.md section 10), so a script that clicks one of its inputs
   * has to open it first.
   */
  (window as unknown as { __wakeExpandPanels?: () => void }).__wakeExpandPanels = () => {
    for (const id of ['controls', 'hud']) {
      document.getElementById(id)?.classList.remove('collapsed');
    }
  };

  /** Test hook: flip a toggle exactly as the controls panel does. */
  (window as unknown as { __wakeToggle?: (k: string, on: boolean) => void }).__wakeToggle = (k, on) => {
    controls.setToggle(k as keyof Toggles, on);
  };

  /**
   * Test hook: put a touch on one file, as the replay would. Lets the glow
   * checks drive a known tile at a known zoom instead of waiting for the session
   * to visit one.
   */
  (window as unknown as { __wakeTouch?: (f: number, strong?: boolean) => void }).__wakeTouch =
    (f, strong = true) => {
      if (f < 0 || f >= repo.fileCount) return;
      touch(f, performance.now(), strong, AGENT_FADE);
      redrawPending = true;
    };

  /**
   * Reduced motion (src/motion.ts), for the check that emulates the media query:
   * what the page thinks the setting is, what a flight costs, and whether the
   * arrival pulse is still growing while the trip marker still moves.
   */
  (window as unknown as { __wakeMotion?: () => unknown }).__wakeMotion = () => {
    const now = performance.now();
    const pulses = autopilot.pulses(now);
    return {
      reduced: reducedMotion(),
      /** what the base 900 ms fly-to actually becomes */
      flightMs: flightMs(900),
      followSmooth: cam.params.followSmooth,
      /** the spring's time constant as the camera applies it */
      dampSeconds: dampTime(cam.params.followSmooth),
      recenterSeconds: cam.params.time,
      unblurMs: reducedMotion() ? OUT_MS : FADE_MS,
      markers: markerDrawData.map((m) => ({ x: m.position[0], y: m.position[1], r: m.radius })),
      pulses: pulses.map((q) => ({ r: q.radius, alpha: q.alpha }))
    };
  };

  /** Test hook: end the replay here, with every fade already expired. */
  (window as unknown as { __wakeEndSession?: () => void }).__wakeEndSession = () => {
    autopilot.endNow();
    touched.clear();
    tripPathData = [];
    markerDrawData = [];
    pulseDrawData = [];
    hotRoadData = [];
    sheetGlowLayerData = [];
    sheetGlowNow.clear();
    redrawPending = true;
  };

  /** Test hook: click a jump-bar crumb by index. */
  (window as unknown as { __wakeCrumb?: (i: number) => boolean }).__wakeCrumb = (i) => {
    const b = document.querySelectorAll<HTMLButtonElement>('#wf-jump .crumb');
    if (i < 0 || i >= b.length) return false;
    b[i].click();
    return true;
  };

  /** Test hook: click the off-screen agent marker. */
  (window as unknown as { __wakeEdgeClick?: () => boolean }).__wakeEdgeClick = () => {
    const el = document.getElementById('wf-edge');
    if (!el || el.hidden) return false;
    el.click();
    return true;
  };

  /**
   * Roads (docs/design.md section 6): what is drawn, for whom, and how it
   * compares with the subject's own import edges. No path or name leaves here.
   */
  (window as unknown as { __wakeRoads?: () => unknown }).__wakeRoads = () => {
    const subject = roadFileOf();
    const drawn = focusRoads();
    const byClass = { local: 0, arterial: 0, motorway: 0 };
    for (const r of drawn) byClass[r.cls]++;
    return {
      hover: hoverFile,
      focus: focusedFile,
      subject,
      showAll: toggles.edges,
      band: bandOf(rowPxNow()),
      /** the whole bundled network is actually on screen */
      networkVisible: toggles.edges && bandOf(rowPxNow()) !== 'terrain',
      networkPaths: toggles.edges && bandOf(rowPxNow()) !== 'terrain'
        ? roads.local.count + roads.trunk.count + roads.minor.count
        : 0,
      drawn: drawn.length,
      byClass,
      widths: CLASS_WIDTH,
      incident: incidentCounts(subject),
      /** agent trips, which do not depend on the toggle at all */
      trips: {
        roads: hotRoadData.length,
        paths: tripPathData.length,
        markers: markerDrawData.length,
        pulses: pulseDrawData.length,
        clipped: sheetBoxesNow().length
      },
      /** what deck was actually handed: paths per road layer and its visibility */
      layers: (deck.props.layers as Array<Layer | null>)
        .filter((l): l is Layer => l !== null && /^roads|^trip-/.test(l.id))
        .map((l) => {
          const props = l.props as { visible?: boolean; data?: { length?: number } | unknown[] };
          const data = props.data as { length?: number } | undefined;
          return {
            id: l.id,
            visible: props.visible !== false,
            paths: data && typeof data.length === 'number' ? data.length : 0
          };
        })
    };
  };

  /**
   * Activity at the granularity of the band (docs/design.md section 9): the
   * weight the tile fill glow and the sheet border glow carry at this zoom, the
   * tile-glow quads in screen pixels, and the sheet borders that are glowing.
   * No path and no name leaves here.
   */
  (window as unknown as { __wakeGlow?: () => unknown }).__wakeGlow = () => {
    const px = rowPxNow();
    const p = projector();
    const { w, h } = view();
    const quad = (poly: Array<[number, number]>) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [wx, wy] of poly) {
        const [sx, sy] = p(wx, wy);
        x0 = Math.min(x0, sx);
        y0 = Math.min(y0, sy);
        x1 = Math.max(x1, sx);
        y1 = Math.max(y1, sy);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x + b.w > 0 && b.x < w && b.y + b.h > 0 && b.y < h;
    return {
      rowPx: px,
      band: bandOf(px),
      glowFadeFrom: ROW_PX_GLOW_FADE,
      tileWeight: tileGlowWeight(px),
      sheetWeight: sheetGlowWeight(px),
      glowMs: GLOW_MS,
      /** every tile-glow quad handed to the layer, in screen pixels */
      tiles: trafficLayerData.map((t) => {
        const box = quad(t.poly);
        return { box, alpha: t.alpha, strong: t.strong, onScreen: onScreen(box) };
      }),
      /** the sheet borders that are glowing, and the strips that echo them */
      sheets: sheetGlowLayerData.map((g) => ({
        file: g.file, alpha: g.alpha, widthPx: g.widthPx, box: quad(g.poly)
      })),
      stickies: wayfind.stickies.map((l) => ({ file: l.file, glow: l.glow })),
      /** the trip geometry actually drawn, in screen pixels */
      trips: tripPathData.map((t) => ({
        volume: t.trip.volume,
        points: t.path.map(([wx, wy]) => {
          const [sx, sy] = p(wx, wy);
          return [Math.round(sx * 100) / 100, Math.round(sy * 100) / 100];
        })
      })),
      markers: markerDrawData.map((m) => {
        const [sx, sy] = p(m.position[0], m.position[1]);
        return { x: sx, y: sy, r: m.radius };
      }),
      pulses: pulseDrawData.length,
      /** the sheet text boxes on screen, which nothing amber may cross */
      text: (codeView.sheetFiles()
        .map((f) => codeView.probe(f))
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .map((x) => ({ file: x.file, box: x.text })))
        .filter((x) => onScreen(x.box))
    };
  };

  /** The source overlays that are up, and whether each is still inside the margin. */
  (window as unknown as { __wakeOverlays?: () => unknown }).__wakeOverlays = () => ({
    tier: codeView.state().tier,
    tierChanges: codeView.state().tierChanges,
    mounts: codeView.state().mounts,
    unmounts: codeView.state().unmounts,
    slots: codeView.overlayInfo(view().w, view().h)
  });

  /**
   * Tile boxes in screen pixels for a set of files, and whether each is still
   * inside the viewport plus the overlay keep-margin. The pan check needs this
   * for files that have already lost their slot.
   */
  (window as unknown as { __wakeTileBoxes?: (fs: number[]) => unknown }).__wakeTileBoxes = (fs) => {
    const p = projector();
    const { w, h } = view();
    const mx = w * OVERLAY_KEEP;
    const my = h * OVERLAY_KEEP;
    return fs.map((f) => {
      const tl = p(layout.cityRect[f * 4], layout.cityRect[f * 4 + 1] + layout.cityRect[f * 4 + 3]);
      const br = p(layout.cityRect[f * 4] + layout.cityRect[f * 4 + 2], layout.cityRect[f * 4 + 1]);
      const box = { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] };
      return {
        file: f,
        box,
        inMargin: box.x + box.w >= -mx && box.x <= w + mx && box.y + box.h >= -my && box.y <= h + my
      };
    });
  };

  /** Test hook: set the hovered file directly, as deck's picking would. */
  (window as unknown as { __wakeHover?: (f: number) => void }).__wakeHover = (f) => {
    hoverFile = f >= 0 && f < repo.fileCount ? f : -1;
    redrawPending = true;
  };

  /** Test hook: set the focused file, as a click or a deep link would. */
  (window as unknown as { __wakeFocus?: (f: number) => void }).__wakeFocus = (f) => {
    focusedFile = f >= 0 && f < repo.fileCount ? f : -1;
    labelKey = '';
    redrawPending = true;
  };

  /**
   * The schematic as texture (docs/design.md section 2): the aggregation level,
   * how many sheets are built and how many of them carry bars.
   */
  (window as unknown as { __wakeBars?: () => unknown }).__wakeBars = () => ({
    ...codeView.barQuads(),
    band: bandOf(rowPxNow()),
    rowPx: rowPxNow(),
    fileCount: repo.fileCount,
    missing: codeView.missingSheets().length
  });

  /** The root files district: its rect, its label and the tiles inside it. */
  (window as unknown as { __wakeRootDistrict?: () => unknown }).__wakeRootDistrict = () => {
    if (!rootDistrict) return null;
    const p = projector();
    const tl = p(rootDistrict.rect.x, rootDistrict.rect.y + rootDistrict.rect.h);
    const br = p(rootDistrict.rect.x + rootDistrict.rect.w, rootDistrict.rect.y);
    const files = repo.dirs[rootDirId].files.slice();
    const label = wayfind.regions.find((r) => r.dir === rootDirId) ?? null;
    return {
      dir: rootDirId,
      files: files.length,
      inset: DISTRICT_INSET,
      fill: theme.districtFill(rootDistrict.region, 1),
      line: theme.districtLine(rootDistrict.region, 1),
      box: { x: tl[0], y: tl[1], w: br[0] - tl[0], h: br[1] - tl[1] },
      label: label ? { text: label.text, full: label.full, size: label.size, box: label.box } : null,
      /** does the label say the repository's name */
      nameMatches: label ? rootDistrict.name.startsWith(label.full) : false,
      fileList: files
    };
  };

  /** What the agent console is showing, and whether the debug panel exists. */
  (window as unknown as { __wakeChrome?: () => unknown }).__wakeChrome = () => {
    const card = document.getElementById('agent');
    const panel = document.getElementById('hud');
    const probe = agentConsole.probe();
    return {
      debug: debugHud,
      card: card !== null && card.childElementCount > 0,
      action: (card?.querySelector('#ac-action')?.textContent ?? '').trim(),
      time: (card?.querySelector('#ac-time')?.textContent ?? '').trim(),
      chip: (card?.querySelector('#ac-chip')?.textContent ?? '').trim(),
      followButton: card?.querySelector('#ac-follow') !== null,
      /** dead once the session has ended: nothing left to follow */
      followDisabled: (card?.querySelector('#ac-follow') as HTMLButtonElement | null)?.disabled ?? null,
      /** the log: lines that exist (before the cursor), of the session's total */
      lines: probe.cursor,
      total: probe.total,
      rendered: probe.rendered,
      expanded: probe.expanded,
      /** the old panel: present only under ?debug=1 */
      panel: panel !== null && panel.childElementCount > 0,
      panelFps: (panel?.querySelector('#h-fps')?.textContent ?? null),
      /** the collapsed debug strip is gone entirely */
      strips: document.querySelectorAll('#hud .strip').length,
      controlsCollapsed: document.getElementById('controls')?.classList.contains('collapsed') ?? null
    };
  };

  /** The console's log in detail: rendered lines, their classes, follow state. */
  (window as unknown as { __wakeConsole?: () => unknown }).__wakeConsole = () => ({
    ...agentConsole.probe(),
    logHeight: document.getElementById('ac-log')?.getBoundingClientRect().height ?? 0,
    domLines: document.querySelectorAll('#agent .cx-line').length,
    /** which event indices have a file, so a test can pick a clickable line */
    withFile: session.events.map((e, i) => (e.file >= 0 ? i : -1)).filter((i) => i >= 0),
    /** the file each line lands on, so a test can pick the line for one file */
    eventFiles: session.events.map((e) => e.file)
  });
  /** Test hook: click a log line by event index, as the pointer would. */
  (window as unknown as { __wakeConsoleClick?: (i: number) => boolean }).__wakeConsoleClick = (i) => {
    // The log is virtualized: an older line has to be scrolled to before it can
    // be clicked, exactly as a pointer would.
    agentConsole.reveal(i);
    const el = document.querySelector<HTMLElement>(`#agent .cx-line[data-i="${i}"]`);
    if (!el) return false;
    el.click();
    return true;
  };
  (window as unknown as { __wakeConsoleToggle?: (on?: boolean) => boolean }).__wakeConsoleToggle = (on) => {
    agentConsole.toggleExpanded(on);
    return agentConsole.expanded;
  };

  /** Files whose sheet is folded, and the export's own effective line counts. */
  (window as unknown as { __wakeFiles?: () => unknown }).__wakeFiles = () => {
    const folded: number[] = [];
    const stubs: number[] = [];
    const nonCode: number[] = [];
    for (let f = 0; f < repo.fileCount; f++) {
      if (repo.fileFolded[f]) folded.push(f);
      if (repo.fileLines[f] < STUB_LINES) stubs.push(f);
      if (isNonCode(repo.filePath?.[f] ?? null)) nonCode.push(f);
    }
    return {
      count: repo.fileCount,
      folded,
      stubs,
      /** prose and config sheets, drawn at half contrast (section 3) */
      nonCode,
      /** the district each file sits in, so a test can aim at a nested one */
      // Sliced to the count: the columns carry headroom for the files a live
      // session creates, and the free slots are not files.
      fileDirs: Array.from(repo.fileDir.subarray(0, repo.fileCount)),
      lines: Array.from(repo.fileLines.subarray(0, repo.fileCount)),
      folds: codeView.foldInfo(),
      lineAudit: codeView.lineAudit()
    };
  };

  /**
   * The theme as the page applies it, for the light/dark parity check: the
   * tones the map draws with and the grounds the chrome actually computed.
   */
  (window as unknown as { __wakeTheme?: () => unknown }).__wakeTheme = () => {
    const bgOf = (sel: string) => {
      const e = document.querySelector<HTMLElement>(sel);
      return e ? getComputedStyle(e).backgroundColor : null;
    };
    const region = document.querySelector<HTMLElement>('.wf-region:not([hidden])');
    return {
      name: theme.name,
      background: theme.background,
      land: theme.landFill,
      sheet: theme.sheetFill,
      label: theme.label,
      labelHalo: theme.labelHalo,
      glow: theme.traffic,
      jump: theme.css.jump,
      cardBg: bgOf('#agent'),
      jumpBg: bgOf('.wf-jump'),
      regionLabelColor: region ? getComputedStyle(region).color : null,
      // The district ramp itself is in __wakeGeo, per directory.
      districtLevel1: theme.districtFill(0, 1)
    };
  };

  if (flag('bench', false)) setTimeout(() => void startBench(), 1500);

  // --------------------------------------------------------------- splash tail
  /** Test hook: what the splash is showing, and every stage it has shown. */
  (window as unknown as { __wakeSplash?: () => unknown }).__wakeSplash = () => ({
    present: document.getElementById('splash') !== null,
    status: document.querySelector('#splash .status')?.textContent ?? null,
    barPct: Math.round(
      100 * (parseFloat((document.querySelector('#splash .bar i') as HTMLElement | null)?.style.width ?? '0') / 100)
    ),
    active: splash.active,
    log: splash.log
  });

  /** Resolve once deck.gl has actually drawn the framed map. */
  function firstContentFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tick = (): void => {
        if (renders >= 2) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // The tokenizer stage runs last because it needs the opening camera, which the
  // entry point above has just set (deep link, autopilot target, or fit-all).
  // The map renders behind the splash while this runs, so the fade uncovers it
  // already framed and already coloured.
  if (splash.active) {
    void (async () => {
      if (codeView.enabled) {
        const want = codeView.warmTargets(bounds(), 8);
        if (want.length > 0) {
          const n = want.length;
          await splash.step('tokens', `tokenizing ${n} files`);
          await codeView.warmTokens(want, (done) => {
            splash.within(done / n);
            if (done > 0) splash.relabel(`tokenizing ${done}/${n} files`);
          });
        }
      }
      await firstContentFrame();
      await splash.finish();
      console.log('[wake splash] ' + JSON.stringify(splash.log));
    })();
  }


// ------------------------------------------------------------------- handle
/**
 * Everything above is the map. What follows is the seam the shell sees: the
 * live protocol applied to the state the replay already owns, plus the few
 * camera and chrome calls a surrounding app needs.
 */

/** Dense file index for a repository-relative path, or -1. */
function fileOf(path: string): number {
  if (!repo.filePath) return -1;
  const i = repo.filePath.indexOf(path);
  return i;
}

/** A file id from either form, or -1. */
function resolveFile(f: number | string | null): number {
  if (f === null) return -1;
  if (typeof f === 'number') return f >= 0 && f < repo.fileCount ? f : -1;
  return fileOf(f);
}

const infoOf = (f: number, line: number | null): FileInfo | null =>
  f < 0 || f >= repo.fileCount
    ? null
    : { file: f, path: repo.filePath ? repo.filePath[f] : null, name: repo.fileName[f], line };

/** Live mode never loops and never advances on its own clock. */
if (live) {
  autopilot.live = true;
  autopilot.loop = false;
}

/** The daemon's session lifecycle, shown in the console header. */
let sessionState: SessionState = live ? 'running' : 'ended';
/** Node frames naming a file or directory this document does not have. */
let unknownNodes = 0;

function pushConsole(): void {
  consoleLineList = consoleLines();
  agentConsole.setLines(consoleLineList);
  controls.setReplay(autopilot.cursor, autopilot.eventCount);
  options.onEvent?.(autopilot.cursor, autopilot.eventCount);
}

/** One wire event, mapped through the same path the export takes. */
function pushEvent(w: WireEvent): void {
  if (!liveIndex) return;
  const mapped = mapSessionEvent(w, liveIndex.fileIndex, liveIndex.t0, livePrevFile);
  if (mapped.file >= 0) livePrevFile = mapped.file;
  const atEnd = autopilot.cursor >= session.events.length;
  autopilot.appendLive(mapped, performance.now());
  if (atEnd) landEvent(mapped, performance.now());
  pushConsole();
  redrawPending = true;
}

/**
 * A node frame: a rect changed, or a node the document never had arrived.
 *
 * An agent creates files, so the second case is not an edge case: it happens in
 * every real session, and ignoring it loses the file and every edit on it. The
 * dense arrays carry headroom for exactly this (src/grow.ts), so a new file is
 * an append into a free slot, not a reload. A new district is the same, which
 * is what makes a file created in a directory that did not exist work too.
 *
 * Symbols are not appended here. A new file has none until the indexer has run,
 * and its symbol frames are a later milestone: an unknown symbol id is ignored
 * exactly as it was, without holding up the file.
 */
function applyNode(node: ExportNode, rect: [number, number, number, number, number]): void {
  if (!liveIndex) return;
  const [, cx, cy, cw, chh] = rect;
  const x = cx * CELL_WORLD;
  const y = cy * CELL_WORLD;
  const w = cw * CELL_WORLD;
  const h = chh * CELL_WORLD;
  let grew = false;
  let movedFile = -1;
  let movedDir = -1;
  if (node.kind === 'file') {
    const f = liveIndex.fileIndex.get(node.id);
    if (f === undefined) {
      const dir = node.parent === null || node.parent === undefined
        ? -1
        : liveIndex.dirIndex.get(node.parent) ?? -1;
      const added = dir < 0 ? -1 : appendFile(
        repo,
        layout,
        {
          dir,
          name: node.name,
          path: node.path,
          lines: Math.max(1, Math.round(node.effectiveLines ?? 1)),
          folded: node.folded ?? false,
          x, y, w, h
        },
        cityColor,
        buildingColor
      );
      if (added < 0) { unknownNodes++; return; }
      liveIndex.fileIndex.set(node.id, added);
      grew = true;
    } else {
      if (typeof node.effectiveLines === 'number') repo.fileLines[f] = node.effectiveLines;
      if (typeof node.folded === 'boolean') repo.fileFolded[f] = node.folded ? 1 : 0;
      moveFileRect(repo, layout, f, x, y, w, h, cityColor, buildingColor);
      // The height step changed, so what the schematic cut from the old one is
      // stale; the source itself comes with the invalidate frame.
      codeView.invalidate(f);
      movedFile = f;
    }
  } else if (node.kind === 'dir') {
    const d = liveIndex.dirIndex.get(node.id);
    if (d === undefined) {
      const parent = node.parent === null || node.parent === undefined
        ? -1
        : liveIndex.dirIndex.get(node.parent) ?? -1;
      const added = parent < 0
        ? -1
        : appendDir(repo, layout, { parent, name: node.name, path: node.path, x, y, w, h });
      if (added < 0) { unknownNodes++; return; }
      liveIndex.dirIndex.set(node.id, added);
      grew = true;
    } else {
      moveDirRect(layout, d, x, y, w, h);
      movedDir = d;
    }
  } else {
    return;
  }
  // The root files district is drawn around the tiles inside it, so it follows
  // both a move and an append.
  rootDistrict = computeRootDistrict();
  if (grew) {
    // A slot more means the CSR incidence index is a row short, and the label
    // ranking has a file it has never seen.
    rebuildIncidence();
    refreshLabelPools();
  } else {
    syncLabelRect(movedFile, movedDir, [x, y, w, h]);
    if (movedFile >= 0 || movedDir >= 0) {
      const rp = rootPlace();
      const at = places.findIndex((it) => it.dir === rootDirId && it.kind === 'region');
      if (rp && at >= 0) places[at] = rp;
    }
  }
  // Roads start and end at tile centroids, so a move invalidates them.
  roads = buildRoads(repo, layout, { local: theme.roadLocal, motorway: theme.roadMotorway });
  rebuildBinaries();
  labelKey = '';
  redrawPending = true;
}

/** Import edges after a reindex. The road network is rebuilt from scratch. */
function applyEdges(added: WireEdge[], removed: WireEdge[]): void {
  if (!liveIndex) return;
  const idx = liveIndex.fileIndex;
  const key = (a: number, b: number) => a * 1e7 + b;
  const drop = new Set<number>();
  for (const e of removed) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined) drop.add(key(a, b));
  }
  const src: number[] = [];
  const dst: number[] = [];
  const wgt: number[] = [];
  for (let i = 0; i < repo.edgeCount; i++) {
    if (drop.has(key(repo.edgeSrc[i], repo.edgeDst[i]))) continue;
    src.push(repo.edgeSrc[i]);
    dst.push(repo.edgeDst[i]);
    wgt.push(repo.edgeWeight[i]);
  }
  for (const e of added) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) { if (a === undefined || b === undefined) unknownNodes++; continue; }
    src.push(a);
    dst.push(b);
    wgt.push(e.weight);
  }
  const E = src.length;
  // Capacity, not count: every file-indexed column keeps its headroom so the
  // next created file still has a slot to land in (src/grow.ts).
  const fanIn = new Uint16Array(Math.max(repo.fileCount, repo.fileCapacity ?? 0));
  repo.edgeCount = E;
  repo.edgeSrc = Uint32Array.from(src);
  repo.edgeDst = Uint32Array.from(dst);
  repo.edgeWeight = Float32Array.from(wgt);
  repo.edgeCross = new Uint8Array(E);
  for (let i = 0; i < E; i++) {
    repo.edgeCross[i] = repo.fileRegion[src[i]] !== repo.fileRegion[dst[i]] ? 1 : 0;
    if (fanIn[dst[i]] < 65535) fanIn[dst[i]]++;
  }
  repo.fileFanIn = fanIn;
  roads = buildRoads(repo, layout, { local: theme.roadLocal, motorway: theme.roadMotorway });
  rebuildIncidence();
  rebuildBinaries();
  roadKey = '';
  redrawPending = true;
}

function applyDelta(msg: ServerMessage): void {
  if (destroyed) return;
  switch (msg.type) {
    case 'snapshot': {
      // A snapshot is the whole session so far, so it REPLACES what the map
      // has rather than adding to it. That is what makes a reconnect safe:
      // the daemon repeats the snapshot and the log does not double.
      if (!liveIndex) break;
      session.events.length = 0;
      livePrevFile = -1;
      for (const w of msg.events) {
        const mapped = mapSessionEvent(w, liveIndex.fileIndex, liveIndex.t0, livePrevFile);
        if (mapped.file >= 0) livePrevFile = mapped.file;
        session.events.push(mapped);
      }
      // seekTo replays the tail with backdated timestamps, so the glow and the
      // link volumes are what the session had built up, already fading, rather
      // than every event of the session firing at once.
      autopilot.seekTo(session.events.length, performance.now());
      pushConsole();
      redrawPending = true;
      break;
    }
    case 'event':
      pushEvent(msg.event);
      break;
    case 'node':
      applyNode(msg.node, msg.rect);
      break;
    case 'invalidate': {
      const f = liveIndex ? liveIndex.fileIndex.get(msg.nodeId) : undefined;
      if (f === undefined) { unknownNodes++; break; }
      if (msg.effectiveLines > 0) repo.fileLines[f] = msg.effectiveLines;
      codeView.invalidate(f);
      redrawPending = true;
      break;
    }
    case 'edges':
      applyEdges(msg.added, msg.removed);
      break;
    case 'session':
      sessionState = msg.state;
      autopilot.liveEnded = msg.state === 'ended';
      redrawPending = true;
      break;
    default:
      break;
  }
}

function setAutopilotOn(on: boolean): void {
  if (on === toggles.autopilot) return;
  controls.setToggle('autopilot', on);
}

const handle: MountedMap = {
  applyDelta,
  flyTo: (target, ms = 900) => {
    if (target.kind === 'world') { flyTo(layout.world, ms, true); return; }
    const f = resolveFile(target.file);
    if (f < 0) return;
    const rowPx = Math.max(READ_PX, Math.min(ROW_PX_MAX, target.rowPx ?? READ_PX));
    flyToPose(codeView.focusPose(f, target.line ?? null, rowPx), ms, true);
  },
  focus: (file, line = null) => {
    const f = resolveFile(file);
    focusedFile = f;
    labelKey = '';
    redrawPending = true;
    if (f >= 0) flyToPose(codeView.focusPose(f, line, READ_PX), 800, true);
    options.onFocus?.(infoOf(f, line));
  },
  setAutopilot: setAutopilotOn,
  setChanges,
  setTheme: applyTheme,
  setFollow: () => {
    setAutopilotOn(true);
    cam.engage();
  },
  setStatus: (text) => agentConsole.setStatus(text),
  scrub: (i) => scrubTo(i),
  fileOf,
  stats: () => ({
    files: repo.fileCount,
    dirs: repo.dirs.length,
    symbols: repo.symCount,
    edges: repo.edgeCount,
    events: session.events.length,
    repoName: exportMeta ? exportMeta.name : null,
    session: sessionState,
    /** Deltas that named a node this document does not have: a reload is due. */
    unknownNodes
  }),
  destroy: () => {
    if (destroyed) return;
    destroyed = true;
    for (let i = teardown.length - 1; i >= 0; i--) teardown[i]();
    teardown.length = 0;
    codeView.destroy();
    try { deck.finalize(); } catch { /* already gone */ }
    container.classList.remove('wake-map-root');
    while (container.firstChild) container.removeChild(container.firstChild);
  }
};
return handle;
}
