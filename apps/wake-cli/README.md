# wake (the front door)

```sh
cd any/repository/you/used/claude/in
wake
```

Plays back the most recent Claude Code session that worked in this
repository, on the map, in a browser tab. No hooks, no config, no daemon.
About one second on a small repository once the app is built.

```sh
wake --live
```

Watches that session as it happens instead: the daemon tails the transcript
(no hooks needed, so it works on a session that is already running) and the
map follows every read, edit and command as Claude Code makes them.

What it does:

1. Finds the repository root (`git rev-parse --show-toplevel`).
2. Scans the newest transcripts under `~/.claude/projects` (400 at most) for
   the first one whose records ran with a cwd inside the repository and made a
   tool call. The cwd is per record, so a session started in another
   directory that moved into this one counts.
3. Builds `wake-index` once if it is missing, then runs `packages/export` in
   worktree mode with that transcript. The export lands in the gitignored
   `.wake/exports/<repo>-replay.json`.
4. Builds `apps/wake` if its sources are newer than `dist/`, serves it with
   `vite preview` on loopback, and opens `?data=<repo>-replay&autopilot=1`.

| flag | |
| --- | --- |
| `--repo <path>` | another repository than the one around the cwd |
| `--session <file>` | a specific transcript instead of the latest |
| `--list` | the ten most recent sessions that worked here, with their first prompt |
| `--live` | watch the session as it happens: the daemon (Bun) tails the transcript |
| `--session-id <id>` | the session with that id, wherever it was started |
| `--detach` | with `--live`: run in the background, print the URL, return. A second call for the same session reuses it, one for another session replaces it |
| `--stop` | stop the background instance for this repository |
| `--port <n>` | default 5300, the next free one if taken |
| `--no-open` | print the URL, do not open a browser |

The replay has a timeline along the bottom: click or drag to scrub, space to
pause, shift+arrows to step, the speed chip cycles 1x, 2x, 4x, 8x.

Install on the PATH with `npm link` at the repository root. Node 23.6 or
newer (type stripping and `node:sqlite`). Publishing as `npx wake` needs
prebuilt `wake-index` binaries and a prebuilt app, which is not done yet.
