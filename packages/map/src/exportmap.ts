/**
 * Loader for a real repository export (schemaVersion 2, produced by
 * packages/export). The export lives outside the tracked tree in the
 * gitignored .wake/exports directory and is served by a dev-only Vite
 * middleware at /data/<name>.json. Nothing from it is ever written back into
 * this package: it is fetched at runtime, held in memory, and displayed.
 *
 * The job here is to present the export through exactly the same Repo and
 * Layout shapes the synthetic fixture uses, so the renderer, the roads, the
 * labels and the autopilot need no export-specific branches.
 */
import type { Dir, Repo } from './repo';
import { finishLayout } from './layout';
import { capacityFor, DIR_HEADROOM_MIN, FILE_HEADROOM_MIN, SYM_HEADROOM_MIN } from './grow';
import { CELL_WORLD, STUB_LINES, isFolded, tileCellsH, TILE_CELLS_W } from './lattice';
import type { CityColor, BuildingColor, Layout, Rect } from './layout';
import type { Session, SessionEvent, EventKind } from './session';

export interface ExportNode {
  id: number;
  kind: 'dir' | 'file' | 'symbol';
  name: string;
  path: string;
  parent: number | null;
  size: number;
  lang: string | null;
  symbolKind: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** v3, symbols only: indentation column of the definition */
  col?: number | null;
  /** v3, symbols only: node id of the enclosing symbol (a method's class) */
  parentId?: number | null;
  /** v2, files only: lines with anything past 100 columns counted as several */
  effectiveLines?: number;
  /** v2, files only, and only when effectiveLines is past the fold cap */
  folded?: boolean;
}

export interface ExportDoc {
  schemaVersion: number;
  repo: { name: string; path: string; commit: string; generatedAt: string };
  nodes: ExportNode[];
  rects: Array<[number, number, number, number, number]>;
  edges: Array<{ from: number; to: number; kind: string; weight: number }>;
  symbolEdges: Array<{ from: number; to: number; kind: string; weight: number }>;
  session: {
    sessionId: string;
    transcriptPath: string;
    startedAt: string;
    endedAt: string;
    events: Array<{
      t: number;
      kind: EventKind;
      tool: string;
      nodeId: number | null;
      path: string | null;
      lineStart: number | null;
      lineEnd: number | null;
      summary: string;
      /** console fields, optional: older exports do not have them */
      title?: string;
      text?: string;
      role?: 'assistant' | 'user';
      command?: string;
      agentType?: string;
    }>;
  };
}

export interface ExportMeta {
  /** repo.name from the JSON, displayed at runtime only */
  name: string;
  commit: string;
  generatedAt: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  dirs: number;
  files: number;
  symbols: number;
  edges: number;
  events: number;
  mappedEvents: number;
  cells: string;
  /** effective lines over all files, and how many are folded */
  effectiveLines: number;
  folded: number;
  stubs: number;
  /** median file-tile coverage of a district with more than eight files, % */
  coverage: number;
}

export interface ExportFixture {
  repo: Repo;
  layout: Layout;
  session: Session;
  meta: ExportMeta;
  worldSide: number;
  /** Export node id to dense file index, the key every live delta arrives on. */
  fileIndex: Map<number, number>;
  /** Export node id to dense directory index. */
  dirIndex: Map<number, number>;
  /** Session start as epoch ms, so a live event can be given a wall clock. */
  t0: number;
}

/**
 * One export or wire event in the renderer's terms. `prevFile` is the last
 * event that landed on the map, which is what makes two consecutive events a
 * trip; live events are mapped one at a time through the same function the
 * export walk uses, so a replayed session and a live one are the same data.
 */
export function mapSessionEvent(
  e: ExportDoc['session']['events'][number],
  fileIndex: Map<number, number>,
  t0: number,
  prevFile: number
): SessionEvent {
  const f = e.nodeId === null || e.nodeId === undefined ? -1 : (fileIndex.get(e.nodeId) ?? -1);
  const from = f >= 0 && prevFile >= 0 && prevFile !== f ? prevFile : -1;
  return {
    t: e.t,
    kind: e.kind,
    file: f,
    trip: 0,
    from,
    tool: e.tool,
    summary: e.summary,
    wallClock: new Date(t0 + e.t).toISOString(),
    lineStart: e.lineStart ?? undefined,
    lineEnd: e.lineEnd ?? undefined,
    title: typeof e.title === 'string' && e.title.trim() ? e.title.trim() : undefined,
    text: typeof e.text === 'string' && e.text.trim() ? e.text.trim() : undefined,
    role: e.role === 'user' || e.role === 'assistant' ? e.role : undefined,
    command: typeof e.command === 'string' && e.command.trim() ? e.command.trim() : undefined,
    agentType: typeof e.agentType === 'string' && e.agentType.trim() ? e.agentType.trim() : undefined
  };
}

export async function fetchExport(name: string): Promise<ExportDoc> {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
  const res = await fetch(`/data/${safe}.json`);
  if (!res.ok) throw new Error(`export /data/${safe}.json -> HTTP ${res.status}`);
  const doc = (await res.json()) as ExportDoc;
  // Version 2 is the phase-2 lattice: a rect cell is 20 glyphs by 10 lines and
  // a file tile is 5 cells wide, so a version-1 export would draw at the wrong
  // scale even though it parses. Re-export instead.
  //
  // Version 3 keeps the rects, ids and edges of version 2 and adds real symbol
  // spans (`lineEnd` past `lineStart`), the definition's indentation column and
  // the enclosing symbol's id, which is what the sticky scope row wants
  // (docs/design.md section 7). Both load.
  if (doc.schemaVersion !== 2 && doc.schemaVersion !== 3) {
    throw new Error(
      `unsupported export schemaVersion ${doc.schemaVersion}, this renderer needs 2 or 3 ` +
      '(re-run packages/export)'
    );
  }
  return doc;
}

/** Bytes to a rough line count, the fallback when effectiveLines is absent. */
const bytesToLoc = (bytes: number) => Math.max(1, Math.round(bytes / 30));

const SYMBOL_KIND: Record<string, number> = { class: 0, function: 1, method: 2, constant: 3, other: 3, module: 2 };

export function buildFixture(doc: ExportDoc, cityColor: CityColor, buildingColor: BuildingColor): ExportFixture {
  const nodes = doc.nodes;
  const rectOf = new Map<number, [number, number, number, number]>();
  for (const [id, x, y, w, h] of doc.rects) rectOf.set(id, [x, y, w, h]);

  // ---- tree ---------------------------------------------------------------
  // Export ids are array indices over dirs, files and symbols together. Build
  // dense local index spaces: dirs 0..D, files 0..F, symbols 0..S.
  const dirIndex = new Map<number, number>();
  const fileIndex = new Map<number, number>();
  const dirNodes: ExportNode[] = [];
  const fileNodes: ExportNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'dir') {
      dirIndex.set(n.id, dirNodes.length);
      dirNodes.push(n);
    } else if (n.kind === 'file') {
      fileIndex.set(n.id, fileNodes.length);
      fileNodes.push(n);
    }
  }

  const depthOf = new Map<number, number>();
  const depth = (n: ExportNode): number => {
    const cached = depthOf.get(n.id);
    if (cached !== undefined) return cached;
    const d = n.parent === null ? 1 : depth(nodes[n.parent]) + 1;
    depthOf.set(n.id, d);
    return d;
  };

  const dirs: Dir[] = dirNodes.map((n, i) => ({
    id: i,
    name: n.name || n.path || 'root',
    path: n.path,
    parent: n.parent === null ? -1 : dirIndex.get(n.parent)!,
    depth: depth(n),
    region: 0,
    children: [],
    files: [],
    fileCount: 0
  }));
  for (const d of dirs) if (d.parent >= 0) dirs[d.parent].children.push(d.id);

  // Regions are the top-level directories. The root itself is region-coloured
  // last, which is where the loose files directly under it end up.
  const rootLocal = dirs.findIndex((d) => d.parent < 0);
  const regionDepth = 2;
  const regions = dirs.filter((d) => d.depth === regionDepth).map((d) => d.id);
  regions.push(rootLocal);
  const regionNames = regions.map((id) => dirs[id].name);
  const regionOfDir = new Int32Array(dirs.length).fill(regions.length - 1);
  const paint = (id: number, region: number): void => {
    regionOfDir[id] = region;
    for (const c of dirs[id].children) paint(c, region);
  };
  regions.forEach((id, r) => { if (id !== rootLocal) paint(id, r); });
  for (const d of dirs) d.region = regionOfDir[d.id];

  // ---- files --------------------------------------------------------------
  const F = fileNodes.length;
  // Headroom, not a snug fit: the agent creates files during a session and a
  // `node` frame for a new one appends into a free slot (src/grow.ts). Only
  // running out of slots costs a reallocation.
  const fileCap = capacityFor(F, FILE_HEADROOM_MIN);
  const fileDir = new Int32Array(fileCap);
  const fileSize = new Float32Array(fileCap);
  const fileLines = new Int32Array(fileCap);
  const fileFolded = new Uint8Array(fileCap);
  const fileRegion = new Uint8Array(fileCap);
  const fileName: string[] = new Array(F);
  const cityRect = new Float32Array(fileCap * 4);
  let effTotal = 0;
  let foldedCount = 0;
  let stubCount = 0;
  let mismatched = 0;
  for (let f = 0; f < F; f++) {
    const n = fileNodes[f];
    const parentDir = n.parent === null ? rootLocal : dirIndex.get(n.parent)!;
    fileDir[f] = parentDir;
    fileRegion[f] = regionOfDir[parentDir];
    fileName[f] = n.name;
    // Effective lines, not bytes, are what the tile's height was cut from
    // (packages/layout/README.md). Byte size drives nothing at all now.
    const eff = Math.max(1, Math.round(n.effectiveLines ?? bytesToLoc(n.size)));
    fileLines[f] = eff;
    fileSize[f] = eff;
    fileFolded[f] = (n.folded ?? isFolded(eff)) ? 1 : 0;
    effTotal += eff;
    if (fileFolded[f]) foldedCount++;
    if (eff < STUB_LINES) stubCount++;
    dirs[parentDir].files.push(f);
    // The rect IS the drawn tile: 5 cells wide and one 40-line step per 4
    // cells tall, gap excluded. Nothing is inset or shrunk any more.
    const r = rectOf.get(n.id) ?? [0, 0, TILE_CELLS_W, tileCellsH(eff)];
    if (r[2] !== TILE_CELLS_W || r[3] !== tileCellsH(eff)) mismatched++;
    cityRect[f * 4] = r[0] * CELL_WORLD;
    cityRect[f * 4 + 1] = r[1] * CELL_WORLD;
    cityRect[f * 4 + 2] = r[2] * CELL_WORLD;
    cityRect[f * 4 + 3] = r[3] * CELL_WORLD;
  }
  if (mismatched > 0) {
    console.warn(
      `[wake] ${mismatched} of ${F} file tiles do not match the lattice ` +
      `(expected ${TILE_CELLS_W} cells wide and 4 cells per 40-line step); ` +
      'drawing the export\'s rects as they are'
    );
  }
  // Subtree file counts, deepest first.
  for (const d of [...dirs].sort((a, b) => b.depth - a.depth)) {
    d.fileCount = d.files.length;
    for (const c of d.children) d.fileCount += dirs[c].fileCount;
  }

  // ---- directory rects ----------------------------------------------------
  // A directory's rect is the drawn region: the layout already keeps its gap
  // and its border gutter inside the footprint, so there is nothing to inset.
  const dirCap = capacityFor(dirs.length, DIR_HEADROOM_MIN);
  const dirRect = new Float32Array(dirCap * 4);
  for (let i = 0; i < dirs.length; i++) {
    const r = rectOf.get(dirNodes[i].id) ?? [0, 0, 1, 1];
    dirRect[i * 4] = r[0] * CELL_WORLD;
    dirRect[i * 4 + 1] = r[1] * CELL_WORLD;
    dirRect[i * 4 + 2] = Math.max(1, r[2] * CELL_WORLD);
    dirRect[i * 4 + 3] = Math.max(1, r[3] * CELL_WORLD);
  }
  const rootRect = rectOf.get(dirNodes[rootLocal].id) ?? [0, 0, 40, 40];
  const world: Rect = { x: 0, y: 0, w: rootRect[2] * CELL_WORLD, h: rootRect[3] * CELL_WORLD };

  // ---- symbols ------------------------------------------------------------
  // Symbols get no rect. Group them by file in source order (lineStart) so
  // finishLayout can lay them out inside their city.
  const symsByFile: ExportNode[][] = Array.from({ length: F }, () => []);
  for (const n of nodes) {
    if (n.kind !== 'symbol' || n.parent === null) continue;
    const f = fileIndex.get(n.parent);
    if (f === undefined) continue;
    symsByFile[f].push(n);
  }
  let S = 0;
  for (const list of symsByFile) {
    list.sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0) || a.id - b.id);
    S += list.length;
  }
  const symCap = capacityFor(S, SYM_HEADROOM_MIN);
  const fileSymStart = new Uint32Array(fileCap + 1);
  const symKind = new Uint8Array(symCap);
  // Source extents, which the schematic turns into class and function bands.
  const symLineStart = new Int32Array(symCap);
  const symLineEnd = new Int32Array(symCap);
  // Names and the export's own kind string, for the sticky scope row and the
  // jump bar's scope crumbs (src/scope.ts).
  const symName: string[] = new Array(S);
  const symKindName: string[] = new Array(S);
  // v3: the definition's indentation column, and the enclosing symbol as a
  // dense local index. -1 for both where the export does not say.
  const symCol = new Int32Array(symCap).fill(-1);
  const symParent = new Int32Array(symCap).fill(-1);
  const symIndex = new Map<number, number>();
  let cursor = 0;
  for (let f = 0; f < F; f++) {
    fileSymStart[f] = cursor;
    for (const n of symsByFile[f]) {
      symLineStart[cursor] = n.lineStart ?? -1;
      symLineEnd[cursor] = n.lineEnd ?? n.lineStart ?? -1;
      symName[cursor] = n.name;
      symKindName[cursor] = n.symbolKind ?? 'other';
      symCol[cursor] = n.col ?? -1;
      symIndex.set(n.id, cursor);
      symKind[cursor++] = SYMBOL_KIND[n.symbolKind ?? 'other'] ?? 3;
    }
  }
  fileSymStart[F] = cursor;
  // Second pass: parentId is a node id, and a child can precede its parent in
  // source order only in pathological cases, but the map is complete now.
  cursor = 0;
  for (let f = 0; f < F; f++) {
    for (const n of symsByFile[f]) {
      const pid = n.parentId;
      symParent[cursor] = pid === null || pid === undefined ? -1 : (symIndex.get(pid) ?? -1);
      cursor++;
    }
  }

  // ---- import edges -------------------------------------------------------
  const keep = doc.edges.filter((e) => fileIndex.has(e.from) && fileIndex.has(e.to) && e.from !== e.to);
  const E = keep.length;
  const edgeSrc = new Uint32Array(E);
  const edgeDst = new Uint32Array(E);
  const edgeWeight = new Float32Array(E);
  const edgeCross = new Uint8Array(E);
  const fileFanIn = new Uint16Array(fileCap);
  for (let i = 0; i < E; i++) {
    const a = fileIndex.get(keep[i].from)!;
    const b = fileIndex.get(keep[i].to)!;
    edgeSrc[i] = a;
    edgeDst[i] = b;
    edgeWeight[i] = keep[i].weight;
    edgeCross[i] = fileRegion[a] !== fileRegion[b] ? 1 : 0;
    if (fileFanIn[b] < 65535) fileFanIn[b]++;
  }

  const repo: Repo = {
    dirs,
    regions,
    regionNames,
    regionDepth,
    fileCount: F,
    fileDir,
    fileSize,
    fileName,
    fileRegion,
    fileSymStart,
    fileFanIn,
    fileLines,
    fileFolded,
    symCount: S,
    symKind,
    symLineStart,
    symLineEnd,
    symName,
    symKindName,
    symCol,
    symParent,
    fileCapacity: fileCap,
    symCapacity: symCap,
    dirCapacity: dirCap,
    // Repo-relative paths, the key the /file and /diff endpoints validate
    // against. Runtime only, never written anywhere.
    filePath: fileNodes.map((n) => n.path),
    edgeCount: E,
    edgeSrc,
    edgeDst,
    edgeWeight,
    edgeCross
  };

  const layout = finishLayout(repo, world, dirRect, cityRect, cityColor, buildingColor);

  // ---- session ------------------------------------------------------------
  const t0 = Date.parse(doc.session.startedAt);
  const events: SessionEvent[] = [];
  let prevFile = -1;
  let trip = 0;
  let mapped = 0;
  for (const e of doc.session.events) {
    const ev = mapSessionEvent(e, fileIndex, t0, prevFile);
    if (ev.file >= 0) mapped++;
    // Consecutive events that land on the map form a trip.
    if (ev.from >= 0) trip++;
    ev.trip = trip;
    events.push(ev);
    if (ev.file >= 0) prevFile = ev.file;
  }
  let crossTrips = 0;
  for (const e of events) if (e.from >= 0 && fileRegion[e.from] !== fileRegion[e.file]) crossTrips++;

  const session: Session = {
    events,
    duration: doc.session.events.length > 0 ? doc.session.events[doc.session.events.length - 1].t : 0,
    trips: trip,
    crossRegionTrips: crossTrips,
    bursts: 0,
    mode: 'cadence',
    cadenceMs: 1500,
    label: 'replayed session'
  };

  return {
    repo,
    layout,
    session,
    worldSide: Math.max(world.w, world.h),
    fileIndex,
    dirIndex,
    t0,
    meta: {
      name: doc.repo.name,
      commit: doc.repo.commit.slice(0, 7),
      generatedAt: doc.repo.generatedAt,
      sessionId: doc.session.sessionId.slice(0, 8),
      startedAt: doc.session.startedAt,
      endedAt: doc.session.endedAt,
      dirs: dirs.length,
      files: F,
      symbols: S,
      edges: E,
      events: events.length,
      mappedEvents: mapped,
      cells: `${rootRect[2]}x${rootRect[3]}`,
      effectiveLines: effTotal,
      folded: foldedCount,
      stubs: stubCount,
      coverage: Math.round(layout.districtCoverage * 1000) / 10
    }
  };
}
