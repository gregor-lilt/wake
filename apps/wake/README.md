# The Wake app

The map, the agent console and the daemon connection, in a browser.

Solid, Vite and TypeScript in strict mode. The map, the jump bar, the sticky
labels and the agent console come from `@wake/map`; what this app adds is the
startup, the socket, and a thin control cluster.

## Layout

- The map fills the window.
- The jump bar is at the top centre and the agent console at the bottom left.
  Both are the package's: they are part of the map, not chrome around it.
- A thin control cluster sits top right: theme, autopilot, follow, and the
  terminal toggle.
- A split pane on the left is where the embedded terminal will go. Collapsed by
  default, and empty when opened: Wake's runtime is Bun, whose built-in PTY is
  what will fill it (docs/research-stack.md section 2).

## Startup

`?daemon=<url>`, default `http://127.0.0.1:7777`.

The splash is up from the first paint and every stage of it is real work:
`daemon` (GET /health), `read` (GET /map), then the map's own `layout`,
`roads`, `labels`, `highlighter` and `tokens`. Nothing advances on a timer.

Once the document is on the map the app opens the WebSocket at `/live` and
feeds every frame straight into the map handle: `hello`, `snapshot`, `event`,
`node`, `invalidate`, `edges`, `session`. A `snapshot` replaces the log rather
than adding to it, which is what makes a reconnect safe. File text and diffs
come from the daemon's `/file` and `/diff`.

If the socket drops, the app reconnects with backoff (250 ms doubling to 8 s)
and the console header carries a `daemon offline` chip until it is back.

## Without a daemon

`?data=<export name>` plays a static export from the gitignored
`.wake/exports`, served by the same Vite middleware the renderer spike uses, and
never opens a socket. This is the fallback for a demo, a screenshot, or a
machine with no daemon on it.

## Run it

```
npm install                     # at the repository root, once
npm run dev -w @wake/app        # http://localhost:5200
```

With the real daemon, from the repository root:

```
PATH=$HOME/.bun/bin:$PATH bun run apps/wake-daemon/src/main.ts serve \
  --repo <path to a repository> --port 7777
```

then open `http://localhost:5200/`. With the mock daemon instead:

```
npm run mock-daemon -w @wake/app -- --export <name> --port 7777 --cadence 1500
```

The mock serves a static export as `GET /map`, reads `/file` and `/diff` out of
the repository that export names, and on `/live` sends `hello`, a snapshot of
what it has already emitted, then replays the export's session events at the
cadence before saying the session ended. A client that drops and reconnects
picks up where it was.

## Checks

```
WAKE_EXPORT=<name> npm run verify -w @wake/app
```

Starts the mock daemon, builds the app, serves it, and drives it with
playwright: the splash stages, the file count, the event stream and the console
growing with it, autopilot landing an edit in the reading band, a socket drop
and its recovery, `?data=` with no daemon, 120 fps at every band, and zero page
errors. Screenshots land in `screenshots/`, which is gitignored because every
one of them renders a real repository's names, paths and source.

Useful flags: `HEADED=1` for a visible window, `WAKE_NO_BUILD=1` to reuse
`dist/`, `WAKE_CADENCE=` for the replay speed, `?debug=1` in the URL to bring
back the map package's own debug panels.
