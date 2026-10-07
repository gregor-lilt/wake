/**
 * The Wake map: a repository drawn as a geographic map, with an agent's
 * session playing over it.
 *
 * A shell hands over one element and gets back a handle:
 *
 *   const map = createMap(el, { theme: 'dark' });
 *   await map.loadDocument(await fetch(daemon + '/map').then((r) => r.json()));
 *   map.applyDelta(JSON.parse(frame));      // docs/protocol.md
 *
 * The jump bar, the agent console and the sticky labels are part of the map
 * experience, so they are drawn by the package inside that element rather than
 * left to the shell. What the shell adds around it is its own chrome.
 */
import { mountMap } from './map';
import type { MapOptions, MountedMap, MapStats, FileInfo, FlyTarget } from './map';
import type { ExportDoc } from './exportmap';
import type { ServerMessage } from './protocol';
import { fetchExport } from './exportmap';
import { generateRepo } from './repo';
import { Splash } from './splash';

export type { MapOptions, MountedMap, MapStats, FileInfo, FlyTarget };
export type { ExportDoc, ExportNode, ExportMeta } from './exportmap';
export type {
  ServerMessage, HelloMessage, SnapshotMessage, EventMessage, NodeMessage,
  InvalidateMessage, EdgesMessage, SessionMessage, PermissionMessage,
  WireEvent, WireEdge, SessionState
} from './protocol';
export type { ThemeName, Theme } from './theme';
export type { SessionEvent, EventKind } from './session';
export type { CodeSource } from './code';
export { exportSource, daemonSource } from './code';
export { fetchExport } from './exportmap';
export { Splash } from './splash';
export type { SplashStep, StageLog } from './splash';
export { reducedMotion, setReducedMotion, onMotionChange } from './motion';
export { generateRepo } from './repo';
export type { Repo, RepoSpec } from './repo';

/** The map before a document is in: every call queues until `loadDocument`. */
export interface MapHandle {
  /**
   * Play a document. The argument is a packages/export file or a daemon's
   * `GET /map`, both schemaVersion 3; `null` builds the synthetic dev fixture.
   * Resolves once the first frame is drawn. One document per handle.
   */
  loadDocument(doc: ExportDoc | null): Promise<void>;
  /** A server frame from docs/protocol.md. Ignored before a document is in. */
  applyDelta(msg: ServerMessage): void;
  flyTo(target: FlyTarget, ms?: number): void;
  /** Focus a file by dense index or repository-relative path. `null` clears. */
  focus(file: number | string | null, line?: number | null): void;
  setAutopilot(on: boolean): void;
  setFollow(): void;
  setTheme(theme: ThemeNameArg): void;
  /** A word about the connection behind the console, or null for none. */
  setStatus(text: string | null): void;
  /** Jump the replay to an event index. */
  scrub(index: number): void;
  /** Dense file index for a repository-relative path, or -1. */
  fileOf(path: string): number;
  /** Counts for a shell's own chrome, or null before a document is in. */
  stats(): MapStats | null;
  /** True once a document has been loaded and the map is live. */
  readonly ready: boolean;
  destroy(): void;
}

type ThemeNameArg = 'dark' | 'light';

/**
 * Build a map in `container`. Returns at once; the work happens in
 * `loadDocument`, so a shell can show its own splash while it fetches.
 */
export function createMap(container: HTMLElement, options: MapOptions = {}): MapHandle {
  let inner: MountedMap | null = null;
  let loading: Promise<void> | null = null;
  let dead = false;
  /** Connection word set before the document was in, applied on mount. */
  let status: string | null = null;
  /** Frames that arrived while the document was still loading. */
  const queued: ServerMessage[] = [];

  return {
    loadDocument(doc) {
      if (loading) return loading;
      loading = mountMap(container, options, doc).then((m) => {
        if (dead) { m.destroy(); return; }
        inner = m;
        if (status !== null) m.setStatus(status);
        for (const msg of queued) m.applyDelta(msg);
        queued.length = 0;
      });
      return loading;
    },
    applyDelta(msg) {
      if (dead) return;
      if (inner) inner.applyDelta(msg);
      else queued.push(msg);
    },
    flyTo: (target, ms) => inner?.flyTo(target, ms),
    focus: (file, line) => inner?.focus(file, line ?? null),
    setAutopilot: (on) => inner?.setAutopilot(on),
    setFollow: () => inner?.setFollow(),
    setTheme: (theme) => inner?.setTheme(theme),
    setStatus: (text) => { status = text; inner?.setStatus(text); },
    scrub: (index) => inner?.scrub(index),
    fileOf: (path) => inner?.fileOf(path) ?? -1,
    stats: () => inner?.stats() ?? null,
    get ready() { return inner !== null; },
    destroy() {
      dead = true;
      inner?.destroy();
      inner = null;
    }
  };
}

/**
 * The synthetic repository the spike grew on, kept as a dev fixture: it needs
 * no export, no daemon and no repository on disk, and it is the only way to
 * put 50,000 tiles on the screen. `createMap(...).loadDocument(null)` uses it.
 */
export const devFixture = { generateRepo, fetchExport, Splash };
