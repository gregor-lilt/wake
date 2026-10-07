---
name: wake
description: Open Wake, the live map of this Claude Code session, in the browser. `/wake` watches this session live, `/wake replay` plays it back with a timeline, `/wake stop` stops the background instance.
disable-model-invocation: true
argument-hint: "[replay | stop]"
allowed-tools: Bash(wake:*)
---

Open Wake for this session. Requested mode: `$ARGUMENTS` (empty means live).

1. Pick the repository: the git repository this session has been working in.
   If the current directory is inside it, no flag is needed. If it is not
   (the session started somewhere else and works in another repository),
   pass `--repo <that repository's root>`.
2. Run exactly one command with Bash, from the current directory:
   - live (empty arguments): `wake --live --detach --session-id ${CLAUDE_SESSION_ID} [--repo <root>]`
   - `replay`: `wake --session-id ${CLAUDE_SESSION_ID} [--repo <root>]` with `run_in_background: true`,
     then read its output once it prints `ready`
   - `stop`: `wake --stop [--repo <root>]`

   If `${CLAUDE_SESSION_ID}` above was not replaced with an id, leave out
   `--session-id`: Wake then picks the newest session that worked in the
   repository, which is this one.
3. Reply in one or two lines: the URL it printed, and that the map follows
   every read, edit and command from here on. Do nothing else. Do not start
   debugging Wake unless the command failed, and if it failed, show the error
   and the log path it printed.

`wake` comes from `npm link` in the Wake repository. If the command is not
found, say so and stop.
