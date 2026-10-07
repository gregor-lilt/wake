/**
 * The shell around the map.
 *
 * The map fills the window and brings its own chrome with it: the jump bar at
 * the top centre, the agent console bottom left, the sticky labels on the
 * terrain. What this adds is the thin control cluster top right, the collapsed
 * terminal pane on the left, and the startup: splash, `GET /map`, mount, then
 * the `/live` socket feeding deltas into the map handle.
 */
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createMap, daemonSource, Splash } from '@wake/map';
import type { MapHandle, ServerMessage } from '@wake/map';
import { Daemon, daemonUrl } from './daemon';
import type { Connection } from './daemon';
import { ControlCluster } from './components/ControlCluster';
import { TerminalPane } from './components/TerminalPane';

/**
 * The startup, in the order it happens, with each stage's share of the bar.
 * The last five belong to the map; the first two are the daemon's.
 */
const STAGES = [
  { key: 'daemon', weight: 0.08 },
  { key: 'read', weight: 0.14 },
  { key: 'layout', weight: 0.22 },
  { key: 'roads', weight: 0.11 },
  { key: 'labels', weight: 0.07 },
  { key: 'highlighter', weight: 0.13 },
  { key: 'tokens', weight: 0.25 }
];

/** What the console header says about the socket, per state. */
const STATUS: Record<Connection, string | null> = {
  connecting: null,
  live: null,
  offline: 'daemon offline'
};

export function App() {
  const qs = new URLSearchParams(location.search);
  /** `?data=<name>` plays a static export and never opens a socket. */
  const dataName = qs.get('data');
  const base = daemonUrl(location.search);

  const [theme, setTheme] = createSignal<'dark' | 'light'>(qs.get('theme') === 'light' ? 'light' : 'dark');
  const [autopilot, setAutopilot] = createSignal(qs.get('autopilot') !== '0');
  const [connection, setConnection] = createSignal<Connection>(dataName ? 'live' : 'connecting');
  const [repoName, setRepoName] = createSignal<string | null>(null);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  let mapEl!: HTMLDivElement;
  let map: MapHandle | null = null;
  let daemon: Daemon | null = null;

  onMount(() => {
    const splash = new Splash({ enabled: qs.get('nosplash') !== '1', steps: STAGES });
    map = createMap(mapEl, {
      theme: theme(),
      autopilot: autopilot(),
      splash,
      live: !dataName,
      // The product has no debug panels; `?debug=1` brings them back.
      debugPanels: qs.get('debug') === '1',
      // Without a daemon the source comes from the export middleware, which
      // the package wires up itself from `?data=`.
      source: dataName ? undefined : daemonSource(base),
      dataName,
      onFocus: () => { /* the jump bar in the package already says where we are */ }
    });

    void (async () => {
      try {
        if (dataName) {
          // The no-daemon path: the package fetches the export and reads
          // source through the same dev middleware the spike uses.
          await map!.loadDocument(null);
          setRepoName(map!.stats()?.repoName ?? null);
          return;
        }

        await splash.step('daemon', 'contacting the daemon');
        daemon = new Daemon(base, {
          onMessage: (msg: ServerMessage) => {
            if (msg.type === 'hello') setRepoName(msg.repo.name);
            map?.applyDelta(msg);
          },
          onConnection: (state) => {
            setConnection(state);
            map?.setStatus(STATUS[state]);
          }
        });
        // A daemon whose indexer is still starting answers /health with
        // indexed false; the map document is served either way, so this is
        // only a better status line, never a gate.
        const health = await daemon.health().catch(() => null);
        await splash.step(
          'read',
          health && !health.indexed ? 'reading the map (still indexing)' : 'reading the map'
        );
        const doc = await daemon.map();
        setRepoName(doc.repo.name);
        await map!.loadDocument(doc);
        // Only now: the snapshot and every event after it go into a map that
        // already has the document they refer to.
        daemon.connect();
      } catch (err) {
        setFailure(String(err instanceof Error ? err.message : err));
        await splash.finish();
      }
    })();
  });

  onCleanup(() => {
    daemon?.close();
    map?.destroy();
  });

  // Test hooks for scripts/verify.mjs. The map publishes its own; these are
  // the shell's: what the socket is doing, and a way to cut it.
  const hooks = window as unknown as Record<string, unknown>;
  hooks.__wakeApp = () => ({
    connection: connection(),
    repoName: repoName(),
    failure: failure(),
    daemon: base,
    dataName,
    ready: map?.ready ?? false,
    stats: map?.stats() ?? null,
    terminalOpen: terminalOpen(),
    theme: theme(),
    autopilot: autopilot(),
    offlineChip: (document.getElementById('ac-offline')?.hidden === false
      ? document.getElementById('ac-offline')?.textContent ?? null
      : null)
  });
  hooks.__wakeDropSocket = () => daemon?.dropForTest() ?? false;

  return (
    <div class="shell" classList={{ 'term-open': terminalOpen(), light: theme() === 'light' }}>
      <Show when={terminalOpen()}>
        <TerminalPane open={terminalOpen()} onClose={() => setTerminalOpen(false)} />
      </Show>
      <div class="map-host" id="map-host" ref={mapEl} />
      <ControlCluster
        theme={theme()}
        autopilot={autopilot()}
        connection={connection()}
        repoName={repoName()}
        terminalOpen={terminalOpen()}
        onTheme={(next) => { setTheme(next); map?.setTheme(next); }}
        onAutopilot={(next) => { setAutopilot(next); map?.setAutopilot(next); }}
        onFollow={() => { setAutopilot(true); map?.setFollow(); }}
        onTerminal={(next) => setTerminalOpen(next)}
      />
      <Show when={failure()}>
        <div class="failure" id="failure">
          <b>No daemon at {base}</b>
          <span>{failure()}</span>
          <span>Start one, or open this page with <code>?data=&lt;export&gt;</code>.</span>
        </div>
      </Show>
    </div>
  );
}
