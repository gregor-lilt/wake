# Spike 4 runbook

Twenty minutes at the keyboard. Everything below runs locally, nothing leaves
the machine. The pass criteria are the ones in `docs/spikes.md`, spike 4.

Verified environment: Claude Code 2.1.258, Node 23.9.0, macOS.

## 0. Before you start

```sh
cd /Users/gregor/repos/wake/apps/spike-hooks
npm run selftest          # 44 assertions, must be green before you go live
```

Make sure no `scratch-project/.claude/settings.local.json` exists yet (step 5
puts it there). `git status` in the wake repo should be clean apart from this
app.

## 1. Start the server

Terminal A:

```sh
cd /Users/gregor/repos/wake/apps/spike-hooks
npm run start
```

It prints the endpoint, the events file and the current fences
(`["protected/**"]` on a fresh run). Leave it running, this terminal is your
log.

## 2. Open the page

http://127.0.0.1:7777/ in a browser next to the terminal. Header should say
`live`. Left pane is the event stream, right pane is approvals, the fence
editor and the stop gate.

## 3. Start Claude Code in the scratch project

Terminal B:

```sh
cd /Users/gregor/repos/wake/apps/spike-hooks/scratch-project
claude
```

Do not pass `--permission-mode`. Default mode is what makes PermissionRequest
fire.

Watch the page: a `SessionStart` row should appear immediately. Note whether it
does, the headless probe never produced one.

## 4. The multi-file edit

Paste this prompt:

```
Do three things, one Edit each, no other tools:
1. In src/greet.ts change the greeting word to "Hallo".
2. In src/math.ts change double() to multiply by 3 instead of 2.
3. In protected/config.ts change retries to 5.
```

Then, in order:

1. **First approval, plain approve.** A pending card appears for
   `src/greet.ts` with the old string in red and the new string in green.
   Terminal B should be sitting still, spinner saying
   `Wake: waiting for approval in the browser`. Click **Approve**. The agent
   moves on.
   - Watch for: how long the terminal waits, and whether the terminal prompt
     also appears (it should not, or if it does, note it).
2. **Second approval, rewrite.** For `src/math.ts`, click **Rewrite…**, change
   the text in the textarea (for example make it multiply by 10), then click
   **Rewrite then approve**. Afterwards check the file on disk:

   ```sh
   cat src/math.ts        # must show YOUR text, not the agent's
   ```
3. **Third edit, the fence.** `protected/config.ts` should never reach an
   approval card. The PreToolUse hook denies it first, the row shows up red
   with `fence deny (protected/**)`, and the agent reports being blocked.
4. **Reject one.** Ask for one more edit, for example
   `In README.md, replace the Notes section body with "rejected test".`
   When the card appears, click **Reject**. The agent should report the denial
   and the file should be unchanged.

## 5. Hot reload of deny rules, mid-session

Leave the session running. Terminal C:

```sh
cd /Users/gregor/repos/wake/apps/spike-hooks/scratch-project
cp .claude/settings.local.json.example .claude/settings.local.json
```

Now, to test the settings deny rule rather than the Wake fence, clear the Wake
fence first: empty the fence textarea on the page and click **Save fences**
(the terminal logs `fences updated: []`).

Then ask the session again:

```
Now change retries to 5 in protected/config.ts.
```

Expected: still denied, this time by Claude Code's own deny rule, without
restarting the session. The page should show a `PermissionDenied`-shaped
absence, meaning no PermissionRequest card at all. Record what you see.

Then put the Wake fence back: type `protected/**` into the textarea, save, and
ask once more. Now the deny should come from the Wake hook (red row).

## 6. The batch gate

On the page, click **Stop after this batch**. The header shows
`ARMED, next PostToolBatch stops the loop`.

In terminal B, ask for something that needs several steps:

```
Read every file under src/ one at a time and then summarize them.
```

Expected: the loop stops after the first batch of tool calls, the terminal
shows a stop, and the row in the event list is marked
`batch gate: continue=false`. The gate disarms itself, so the next turn runs
normally.

## 7. Timeout behaviour (optional, 5 minutes of waiting)

Trigger an edit and do not click anything. After `WAKE_PERMISSION_TIMEOUT`
seconds (300 by default) the server responds with no decision and the normal
terminal prompt should take over. To make this quick, restart the server with
`WAKE_PERMISSION_TIMEOUT=10 npm run start`.

## 8. Evidence

```sh
wc -l events.jsonl
node -e 'for (const l of require("fs").readFileSync("events.jsonl","utf8").trim().split("\n")) { const o = JSON.parse(l); console.log(o.hook_event_name, o.tool_name ?? "", Object.keys(o).join(",")); }'
```

Keep `events.jsonl` for the writeup, it is the raw record of what Claude Code
actually sent.

## Checklist against the spike 4 pass criteria

| # | Criterion (docs/spikes.md) | How you saw it | Pass? |
|---|---|---|---|
| 1 | Every tool call arrives with `tool_input` and `tool_response` | PostToolUse rows show `resp`, and `events.jsonl` has `tool_response.structuredPatch` | |
| 2 | Approval holds the agent until the click | Terminal B idle while the card is pending in step 4.1 | |
| 3 | The rewritten edit is what lands on disk | `cat src/math.ts` after step 4.2 | |
| 4 | The fence denies without restart | Step 4.3 (Wake hook) and step 5 (settings.local.json) | |
| 5 | The batch gate stops the loop | Step 6 | |
| Extra | `SessionStart` fires for an interactive session | Step 3 | |
| Extra | Reject is reported to the agent, file untouched | Step 4.4 | |
| Extra | Timeout falls back to the terminal prompt | Step 7 | |

## Verdicts

Fill this in and copy the summary into the Verdicts section of
`docs/spikes.md`.

```
Date:
Claude Code version:            (claude --version)
Node version:

1. tool_input / tool_response   PASS / FAIL   notes:
2. approval holds               PASS / FAIL   notes:
3. rewrite lands on disk        PASS / FAIL   notes:
4. fence without restart        PASS / FAIL   notes:
   4a. Wake PreToolUse hook     PASS / FAIL
   4b. settings.local.json      PASS / FAIL
5. batch gate stops the loop    PASS / FAIL   notes:

SessionStart on interactive:    YES / NO
Reject path:                    PASS / FAIL
Timeout fallback:               PASS / FAIL

Schema surprises found (add to README.md section "Schema notes"):

Steering features to downgrade in PLAN.md, if any:

Overall verdict:
```

## Cleanup

```sh
rm -f scratch-project/.claude/settings.local.json
git -C /Users/gregor/repos/wake checkout -- apps/spike-hooks/scratch-project   # if the agent edited the toy files
```
