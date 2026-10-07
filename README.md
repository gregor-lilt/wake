# Wake

Air traffic control for your coding agents.

A live map of your project with every Claude Code session on it. Wake shows
where each agent is and where it is heading, calls you when one needs you, and
hands you a shareable recap when the work is done.

See [PLAN.md](PLAN.md) for the product plan, [docs/design.md](docs/design.md)
for how the map has to look and behave, and [docs/protocol.md](docs/protocol.md)
for the contract between the daemon and the map.

## Running the app

The app needs a daemon watching a repository, and a browser.

```
npm install                          # once, at the root; this is a workspace
```

Start the daemon on the repository you want to watch, then the app:

```
bun run apps/wake-daemon/src/main.ts serve --repo <path> --port 7777
npm run dev -w @wake/app             # http://localhost:5200
```

The app reads `?daemon=<url>` and defaults to `http://127.0.0.1:7777`. It shows
a splash while it fetches the map document, mounts it, and connects the
WebSocket, then plays the session as it happens.

Without a daemon, `?data=<name>` plays a static export from the gitignored
`.wake/exports` directory produced by `packages/export`. There is also a mock
daemon for development, which replays an export's session over the real
protocol:

```
npm run mock-daemon -w @wake/app -- --export <name> --port 7777
```

Bun 1.4 for the daemon, Node for the app's toolchain.

## Layout

| | |
|---|---|
| `apps/wake` | The app: the shell around the map, the daemon connection, the terminal pane |
| `apps/wake-daemon` | The daemon: Claude Code hooks, the indexer, `/map` and `/live` |
| `packages/map` | The map itself, and everything that belongs to it: jump bar, labels, agent console, splash |
| `packages/export` | The static export format, schemaVersion 3 |
| `packages/layout` | The layout engine and its stability harness |
| `crates/` | The Rust indexer sidecar |
| `apps/spike-renderer` | Where the map grew. Still its regression suite |
