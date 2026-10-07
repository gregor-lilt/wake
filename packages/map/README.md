# @wake/map

The map: a repository drawn as a geographic map with deck.gl 9's
`OrthographicView` on WebGL2, with an agent's session playing over it.

This is the whole map experience, not just a canvas. The jump bar at the top
centre, the sticky region and file labels, the gutter, the agent console at the
bottom left and the loading splash all belong to it, because none of them are
decoration around the map: they are how you know where you are on it
(docs/design.md sections 7 and 10). A shell hands over one element and adds its
own chrome around the edges.

It grew inside `apps/spike-renderer` and moved here unchanged. The spike is
still its regression suite.

## Using it

```ts
import { createMap } from '@wake/map';
import '@wake/map/style.css';
import '@wake/map/splash.css';

const map = createMap(container, { theme: 'dark', debugPanels: false });

// A packages/export file, or a daemon's GET /map. Both schemaVersion 3.
await map.loadDocument(doc);

// Server frames from docs/protocol.md, straight through.
socket.onmessage = (ev) => map.applyDelta(JSON.parse(ev.data));
```

`createMap` returns at once and does the work in `loadDocument`, so a shell can
show its own splash while it fetches. Frames that arrive before the document is
in are queued, not dropped.

### The handle

| Call | What it does |
|---|---|
| `loadDocument(doc)` | Play a document. `null` falls back to `?data=<name>`, and to the synthetic dev fixture when there is no export either. Resolves when the first frame is drawn. One document per handle |
| `applyDelta(msg)` | One server frame: `snapshot`, `event`, `node`, `invalidate`, `edges`, `session`. Anything else is ignored. A `node` frame for a file or directory the document never had grows the map into its headroom; one for a node it has moves it in place |
| `flyTo(target, ms?)` | `{ kind: 'world' }` or `{ kind: 'file', file, line?, rowPx? }` |
| `focus(file, line?)` | Focus a file by dense index or repository-relative path. `null` clears it |
| `setAutopilot(on)` | Whether the session drives the camera |
| `setFollow()` | Recentre on what the agent is doing now |
| `setTheme('dark' \| 'light')` | Repaints the layers, the source overlays and the CSS variables |
| `setStatus(text \| null)` | A word about the connection, shown in the console header. The shell owns the socket, so it owns this |
| `scrub(index)` | Jump the replay to an event index |
| `fileOf(path)` | Dense file index for a repository-relative path, or -1 |
| `stats()` | Counts for a shell's own chrome, plus the session state and any deltas that named a node the document does not have |
| `destroy()` | Stops the frame loop, removes every listener, terminates the tokenizer worker, empties the container |

### Options

`theme`, `autopilot`, `live`, `reducedMotion`, `debugPanels`, `dataName`,
`source`, `splash`, `onFocus`, `onHover`, `onEvent`. Everything not given falls
back to the query string, which is how the scripted runs in
`apps/spike-renderer/scripts` configure the map and why they still work.

- `live` tells the map a daemon is feeding it: the replay clock stops driving
  the cursor and the session never loops.
- `source` is where file text and diffs come from. `exportSource(name)` reads
  the dev middleware in `vite/export-data.ts`; `daemonSource(base)` reads a
  daemon's `/file` and `/diff`. Without one the source tier is inert, which is
  the synthetic fixture's normal state.
- `splash` lets a shell pass a `Splash` it already started, so its own stages
  and the map's are one bar.
- `debugPanels: false` drops the two panels the spike uses. The agent console
  stays: there is no debug panel in the product (docs/design.md section 10).

### The Vite plugin

`vite/export-data.ts` serves `/data/<name>.json`, `/file` and `/diff` in dev and
preview. Exports live in the gitignored `.wake/exports` and the repository they
point at is read through their own `repo.path`, so only the paths an export
lists as files can be read and nothing is ever written. Both apps use it: it is
what makes `?data=<name>` work with no daemon at all.

## What is where

| File | |
|---|---|
| `map.ts` | The map itself: layers, camera, bands, the frame loop, and the handle at the bottom |
| `lattice.ts` | One cell is 20 glyphs by 10 lines. The single source of scale |
| `layout.ts` | Districts, tiles and the baked polygon soups |
| `exportmap.ts` | An export or a `GET /map` in the renderer's own terms |
| `schematic.ts` | The zoom ladder: `rowPx`, the bands, the aggregated bars |
| `codeview.ts`, `code.ts`, `overlay.ts`, `diff.ts`, `tokens.worker.ts` | The reading band: fetch, tokenize in a worker, pooled DOM overlays, inline diff |
| `edges.ts` | Import edges as roads, bundled through the directory tree |
| `labels.ts`, `wayfind.ts`, `scope.ts` | Captions, sticky labels, the jump bar, scope by symbol containment |
| `session.ts`, `autopilot.ts`, `camera.ts`, `agentconsole.ts` | The session, the replay, the follow camera, the console |
| `theme.ts`, `motion.ts`, `splash.ts`, `hud.ts` | Palette, the one motion language, the splash, the debug panels |
| `grow.ts` | Headroom in the dense arrays, and the append a created file lands in |
| `repo.ts`, `rng.ts` | The synthetic fixture, kept as a dev fixture: 50,000 tiles with no repository on disk |
| `protocol.ts` | The live protocol's frames, client side. Declarations only |

## Known gaps

- Symbols are not appended yet: a file created during the session draws as an
  empty tile until a reindex, and a `node` frame of kind `symbol` is ignored
  (not counted as unknown). Its file, its caption and its source are all there.
- A `node` frame whose parent is a directory the map does not have is still
  counted in `stats().unknownNodes` and ignored: it cannot be placed. Anything
  else the daemon creates is appended, files and directories both.
- `loadDocument` runs once per handle. A second document means a new handle.
