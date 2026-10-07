/**
 * Synthetic repository generator for spike 1.
 *
 * Shape (from docs/spikes.md): 5 top-level regions, ~400 directories nested
 * 2-4 deep, 50k files with a long-tailed size distribution, 200k symbols
 * attached to files, 20k dependency edges (~15% cross-region).
 *
 * Everything is derived from one seed, so the fixture is byte-identical on
 * every run. Per-node data lives in typed arrays; only names are strings.
 */
import { makeRng } from './rng';
import { isFolded } from './lattice';

export interface Dir {
  id: number;
  name: string;
  path: string;
  parent: number; // -1 for a region
  depth: number; // 1 = region, up to 4
  region: number; // 0..4
  children: number[];
  files: number[];
  fileCount: number; // subtree
}

export interface Repo {
  dirs: Dir[];
  regions: number[]; // dir ids, one per top-level region
  regionNames: string[];
  /** tree depth at which a directory is styled and coloured as a region */
  regionDepth: number;

  fileCount: number;
  fileDir: Int32Array;
  fileSize: Float32Array; // "lines of code"
  fileName: string[];
  fileRegion: Uint8Array;
  fileSymStart: Uint32Array; // length fileCount + 1
  fileFanIn: Uint16Array;
  /**
   * Effective lines per file (long lines wrapped at the sheet's 100 columns),
   * which is what the tile's height was cut from, and 1 where the file is
   * past the fold cap. Both are on every path: the synthetic fixture takes
   * its line counts from the generator, a real export from `effectiveLines`.
   */
  fileLines: Int32Array;
  fileFolded: Uint8Array;

  symCount: number;
  symKind: Uint8Array; // 0 class, 1 function, 2 method, 3 const
  /**
   * Source extent per symbol, only on the real-export path. The synthetic
   * fixture has no source, so it has no lines and no code view.
   */
  symLineStart?: Int32Array;
  symLineEnd?: Int32Array;
  /**
   * Symbol names and their export kind ('class', 'function', 'method',
   * 'constant'), only on the real-export path. The sticky scope row and the
   * jump bar's scope crumbs read these (src/scope.ts). Runtime only: like
   * `filePath`, nothing derived from a real repository is written anywhere.
   */
  symName?: string[];
  symKindName?: string[];
  /**
   * Export schema 3: the indentation column of the definition, and the
   * enclosing symbol as an index into the same dense symbol space (-1 for a
   * top-level definition). With these the scope row is exact containment
   * rather than an indentation guess.
   */
  symCol?: Int32Array;
  symParent?: Int32Array;

  /** repo-relative path per file, only on the real-export path. */
  filePath?: string[];

  /**
   * Slots the file- and symbol-indexed arrays are allocated for, which is more
   * than the counts above: a live session creates files, and a `node` frame for
   * one appends into a free slot instead of rebuilding the document
   * (src/grow.ts). Absent on the synthetic fixture, where the counts are the
   * capacities and nothing grows.
   */
  fileCapacity?: number;
  symCapacity?: number;
  dirCapacity?: number;

  edgeCount: number;
  edgeSrc: Uint32Array;
  edgeDst: Uint32Array;
  edgeWeight: Float32Array;
  edgeCross: Uint8Array; // 1 when the two endpoints sit in different regions
}

const REGION_NAMES = ['core', 'services', 'ui', 'platform', 'tooling'];

const DIR_WORDS = [
  'api', 'auth', 'cache', 'client', 'codec', 'config', 'db', 'events',
  'graph', 'http', 'index', 'io', 'jobs', 'layout', 'lib', 'model',
  'net', 'parser', 'query', 'render', 'router', 'runtime', 'schema',
  'server', 'session', 'store', 'stream', 'sync', 'telemetry', 'test',
  'transform', 'types', 'util', 'view', 'worker'
];

const FILE_WORDS = [
  'adapter', 'builder', 'client', 'context', 'engine', 'factory', 'handler',
  'helpers', 'index', 'loader', 'manager', 'mapper', 'parser', 'pool',
  'queue', 'reducer', 'registry', 'resolver', 'runner', 'schema', 'server',
  'service', 'session', 'state', 'store', 'stream', 'types', 'utils',
  'validator', 'walker', 'watcher', 'worker'
];

export interface RepoSpec {
  seed?: number;
  dirs?: number;
  files?: number;
  symbols?: number;
  edges?: number;
  crossRegionShare?: number;
}

export function generateRepo(spec: RepoSpec = {}): Repo {
  const seed = spec.seed ?? 0xc0ffee;
  const targetDirs = spec.dirs ?? 400;
  const fileCount = spec.files ?? 50_000;
  const symCount = spec.symbols ?? 200_000;
  const edgeCount = spec.edges ?? 20_000;
  const crossShare = spec.crossRegionShare ?? 0.15;
  const rng = makeRng(seed);

  // ---- directory tree -----------------------------------------------------
  const dirs: Dir[] = [];
  const regions: number[] = [];
  for (let r = 0; r < REGION_NAMES.length; r++) {
    const id = dirs.length;
    dirs.push({
      id, name: REGION_NAMES[r], path: REGION_NAMES[r], parent: -1,
      depth: 1, region: r, children: [], files: [], fileCount: 0
    });
    regions.push(id);
  }
  // Grow the tree by repeatedly attaching a child to an existing directory.
  // Shallow parents are preferred, which yields a realistic fan-out at depth 2
  // and a thinner tail at depth 4.
  const nameUse = new Map<string, number>();
  while (dirs.length < targetDirs) {
    const candidates: number[] = [];
    for (const d of dirs) {
      if (d.depth >= 4) continue;
      const w = d.depth === 1 ? 4 : d.depth === 2 ? 3 : 1;
      for (let i = 0; i < w; i++) candidates.push(d.id);
    }
    const parent = dirs[rng.pick(candidates)];
    let name = rng.pick(DIR_WORDS);
    const key = `${parent.id}/${name}`;
    const n = nameUse.get(key) ?? 0;
    nameUse.set(key, n + 1);
    if (n > 0) name = `${name}${n + 1}`;
    const id = dirs.length;
    dirs.push({
      id, name, path: `${parent.path}/${name}`, parent: parent.id,
      depth: parent.depth + 1, region: parent.region,
      children: [], files: [], fileCount: 0
    });
    parent.children.push(id);
  }
  // Frozen sibling order: by name. Deterministic and independent of insertion.
  for (const d of dirs) d.children.sort((a, b) => dirs[a].name < dirs[b].name ? -1 : 1);

  // ---- files --------------------------------------------------------------
  // Files land in leaves plus a slice of interior directories, with a
  // long-tailed per-directory mass so some folders are dense and most are not.
  const hosts: number[] = [];
  for (const d of dirs) {
    if (d.children.length === 0 || rng.next() < 0.35) hosts.push(d.id);
  }
  const mass = new Float64Array(hosts.length);
  let massSum = 0;
  for (let i = 0; i < hosts.length; i++) {
    const m = Math.exp(rng.normal() * 0.85);
    mass[i] = m;
    massSum += m;
  }
  const fileDir = new Int32Array(fileCount);
  const fileSize = new Float32Array(fileCount);
  const fileLines = new Int32Array(fileCount);
  const fileFolded = new Uint8Array(fileCount);
  const fileRegion = new Uint8Array(fileCount);
  const fileName: string[] = new Array(fileCount);
  let cursor = 0;
  let acc = 0;
  for (let i = 0; i < hosts.length; i++) {
    acc += mass[i];
    const upto = i === hosts.length - 1
      ? fileCount
      : Math.min(fileCount, Math.round((acc / massSum) * fileCount));
    const dir = dirs[hosts[i]];
    for (let f = cursor; f < upto; f++) {
      fileDir[f] = dir.id;
      fileRegion[f] = dir.region;
      // Long tail: lognormal lines-of-code, 1 to ~6000. A tenth of the files
      // are stubs, which is what a real repository full of __init__.py looks
      // like, and 6% land past the fold cap.
      const stub = rng.next() < 0.1;
      fileSize[f] = stub
        ? 1 + rng.int(4)
        : Math.min(6000, Math.max(6, Math.exp(4.1 + rng.normal() * 1.05)));
      fileLines[f] = Math.max(1, Math.round(fileSize[f]));
      fileFolded[f] = isFolded(fileLines[f]) ? 1 : 0;
      const base = FILE_WORDS[rng.int(FILE_WORDS.length)];
      const idx = f - cursor;
      fileName[f] = idx === 0 ? `${base}.ts` : `${base}${idx > 30 ? idx : ''}.ts`;
      dir.files.push(f);
    }
    cursor = upto;
  }
  // Subtree file counts, deepest first.
  const byDepth = [...dirs].sort((a, b) => b.depth - a.depth);
  for (const d of byDepth) {
    d.fileCount = d.files.length;
    for (const c of d.children) d.fileCount += dirs[c].fileCount;
  }

  // ---- symbols ------------------------------------------------------------
  // One per file as a floor, the rest handed out proportional to file size.
  const fileSymStart = new Uint32Array(fileCount + 1);
  let sizeSum = 0;
  for (let f = 0; f < fileCount; f++) sizeSum += fileSize[f];
  const extra = Math.max(0, symCount - fileCount);
  let placed = 0;
  let carry = 0;
  for (let f = 0; f < fileCount; f++) {
    fileSymStart[f] = placed;
    let k = 1;
    if (f === fileCount - 1) {
      k = symCount - placed;
    } else {
      const want = (fileSize[f] / sizeSum) * extra + carry;
      const take = Math.floor(want);
      carry = want - take;
      k = 1 + take;
    }
    placed += Math.max(1, k);
  }
  fileSymStart[fileCount] = placed;
  const symKind = new Uint8Array(placed);
  for (let s = 0; s < placed; s++) {
    const r = rng.next();
    symKind[s] = r < 0.12 ? 0 : r < 0.55 ? 1 : r < 0.88 ? 2 : 3;
  }

  // ---- dependency edges ---------------------------------------------------
  const regionFiles: number[][] = REGION_NAMES.map(() => []);
  for (let f = 0; f < fileCount; f++) regionFiles[fileRegion[f]].push(f);

  const edgeSrc = new Uint32Array(edgeCount);
  const edgeDst = new Uint32Array(edgeCount);
  const edgeWeight = new Float32Array(edgeCount);
  const edgeCross = new Uint8Array(edgeCount);
  const fanIn = new Uint16Array(fileCount);
  for (let e = 0; e < edgeCount; e++) {
    const cross = rng.next() < crossShare;
    let a: number;
    let b: number;
    if (cross) {
      const ra = rng.int(REGION_NAMES.length);
      let rb = rng.int(REGION_NAMES.length);
      if (rb === ra) rb = (rb + 1) % REGION_NAMES.length;
      a = regionFiles[ra][rng.int(regionFiles[ra].length)];
      b = regionFiles[rb][rng.int(regionFiles[rb].length)];
    } else {
      const r = rng.int(REGION_NAMES.length);
      const pool = regionFiles[r];
      a = pool[rng.int(pool.length)];
      // 70% of local roads stay inside the source's own directory or its
      // parent, which is what real import graphs look like.
      if (rng.next() < 0.7) {
        const src = dirs[fileDir[a]];
        const near = src.parent >= 0 && rng.next() < 0.5 ? dirs[src.parent] : src;
        const cand = near.files.length > 0 ? near.files : pool;
        b = cand[rng.int(cand.length)];
      } else {
        b = pool[rng.int(pool.length)];
      }
      if (b === a) b = pool[(rng.int(pool.length) + 1) % pool.length];
    }
    edgeSrc[e] = a;
    edgeDst[e] = b;
    edgeCross[e] = cross ? 1 : 0;
    edgeWeight[e] = Math.min(64, 1 + Math.floor(Math.exp(rng.normal() * 1.1 + 0.5)));
    if (fanIn[b] < 65535) fanIn[b]++;
  }

  return {
    dirs, regions, regionNames: REGION_NAMES, regionDepth: 1,
    fileCount, fileDir, fileSize, fileName, fileRegion, fileSymStart,
    fileFanIn: fanIn, fileLines, fileFolded,
    symCount: placed, symKind,
    edgeCount, edgeSrc, edgeDst, edgeWeight, edgeCross
  };
}
