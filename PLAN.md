# Wake

Air traffic control for your coding agents.

Wake is an open-source companion for Claude Code. It draws the software project
as a live, navigable map and shows every running agent on it: where each one is,
where it has been, where it is heading, and when it needs you. You stop watching
a scrolling log, walk away, and come back when Wake calls. After the session
Wake hands you a recap you can review in two minutes and share in one click.

## 1. Problem

- Agentic coding tools edit many files in seconds. The engineer gets a linear
  text log of tool calls and a diff at the end.
- The log answers "what was typed". It does not answer where in the project the
  agent is, why it went there, what it read before it wrote, or whether it is
  drifting out of scope.
- Engineers now run several agents at once, in parallel worktrees. Each one has
  its own log in its own terminal tab. Nobody sees that two of them are
  rewriting the same module until the merge fails.
- Watching an agent costs the attention the agent was supposed to save. Not
  watching it means finding out an hour later that it went wrong in minute
  three.
- Review happens after the fact, file by file, in whatever order the diff tool
  picks. Nobody explains the change in the order it should be understood.
- The result: engineers either rubber-stamp agent PRs or slow the agent down to
  human speed. Neither is what we want.

## 2. Thesis

- Code is spatial. Agents work spatially (jump between files, follow
  dependencies). Humans think spatially (mental map of the repo). Only the
  interface between them is linear text.
- A stable map of the project, animated with agent activity, restores the
  missing dimension. Position, direction, scope and collisions become visible
  at a glance.
- The map is also the right place for alarms. A warning that says "the agent
  edited code whose dependency it never read" is only actionable if it lands
  you on that spot, with the context around it.
- A stable map turns every session into data on the same coordinates. Over
  weeks it becomes a record of where agents struggle in this codebase, which
  no log can show.
- Everything Wake shows is derived from data Claude Code already produces:
  tool calls with timestamps, edits, plans, permission requests, transcripts,
  and the git diff. No new agent, no fork.

## 3. Positioning

- The current wave of "codebase map" tools builds maps for the agent, to cut
  tokens and improve retrieval. Wake builds the map for the human, to supervise
  agents. Nobody occupies that spot today.
- Wake is a supervisor, not an IDE. It is a panel: map, alarms, and the real
  chat. The editor stays the editor.
- Many agents is the default case, not an edge case. One map, many cursors.
- Every session leaves an artifact worth sharing: a recap video and a tour.
  That artifact is also how people discover Wake.
- Wake is built for Claude Code first. Other agents are a later concern, if
  ever.
- Wake runs the user's own, unmodified Claude Code under the user's own login.
  It never drives the agent through a programmatic interface with borrowed
  credentials. A Claude subscription is enough to use Wake.

## 4. Metaphors that drive the design

- Wake. The agent leaves a visible trail. Reads, edits, and test runs fade over
  time like the wake behind a boat. You can always see where it has been.
- Air traffic control. Several agents share one airspace. The controller does
  not fly the planes. The controller sees all of them, separates them, and
  speaks up before two of them meet.
- Autopilot. The agent drives the camera. The user grabs the wheel by panning or
  zooming and the camera stays with the user until they hand it back.
- Pair programming. The agent is the driver, the user is the navigator. The
  navigator watches the road ahead, calls out wrong turns, and does not type.
- Tour. Review is a guided walk through the change in the order it should be
  understood, narrated by the agent, played on the map.
- Transport network. The code is a country with regions, cities and roads.
  Places never move. The agent's work is traffic on the roads. Where the
  traffic flows, and between which regions, is the story of a session.

## 5. Design principles

- Attention is the scarce resource. Wake earns a glance only when something
  needs the human. Everything else is ambient.
- Spatial memory is the product. The layout must be stable across sessions and
  across small changes to the code. A file added tomorrow must not move
  everything else. The same coordinates hold every session ever recorded.
- Semantic zoom, not scaled pictures. Each zoom level changes representation:
  directories, then files, then a file's structure, then code. The user never
  sees an illegible thumbnail of code.
- Motion means something. Every animation maps to a real event. No decoration.
- Show attention, not just edits. The reads are the "why" of the writes.
- Wow in ten seconds. The first run needs no setup, no hooks, and no live
  agent. It plays back a session the user already had.
- Beautiful enough to share. A recap is a product surface, not a debug view.
  If people do not post it, it is not done.
- The chat stays, and it is the real one. Wake embeds the actual Claude Code
  terminal session rather than rebuilding a chat client on top of it. The map
  gives that conversation a place to point at.

## 6. The map

Wake's map is a geographic map, not a diagram. It borrows its rules from
cartography and transport networks: places have fixed positions, borders nest,
the network is drawn on top of the places and routed around them, and zooming
reveals detail by importance. Nothing on the map is ever positioned by a
physics simulation. No force layouts, no hairballs.

### Vocabulary

| Geography | Wake |
|---|---|
| Country, state, municipality | Directory, package, module (nested regions with borders) |
| City, town, village | File. The unit developers navigate, and the unit of the map |
| Buildings, streets | The structure inside a file: classes, functions, blocks. Visible only when zoomed into that file, never as separate map objects |
| Local road | Dependency between files inside one region |
| Motorway | Heavy, bundled dependency between regions, thickness by weight |
| Traffic | The agents' activity moving over the network |
| Link volume | How often sessions traversed a connection |

### Geography: what fixes a position

Code has no terrain, so something has to play its role. The base geography is
the directory tree. It is deterministic, it matches how the agent addresses
code (every read, search and edit names a path), and it is the mental model
the user already has of the repository.

- Regions nest by directory. Sibling regions are ordered by coupling, computed
  once and frozen, so directories that depend on each other tend to border
  each other. New siblings are inserted, existing ones do not move.
- Cities sit inside their region on a quantized grid, with deliberate slack
  around them. A region grows in discrete steps only when its slack is used
  up, and growth is announced rather than hidden. Most insertions move
  nothing.
- Files are the atomic unit of the map. Developers navigate files, tools
  address files, diffs are per file. Symbols are not placed on the map, they
  are what a file looks like from close up.
- Inside a city, code follows source order. It is the ordering the user
  already knows and it needs no algorithm.
- Whitespace is a feature. Cities are not packed edge to edge. The terrain
  between them gives the road network room and makes the map read as a map.
- Languages that define module boundaries (packages, workspaces, crates) may
  override the raw folder tree as the region hierarchy.

### The network: which relationship is the road

- Roads are dependencies between files: imports, weighted by how many symbols
  cross them.
- Roads are routed, not drawn straight. Between regions they are bundled
  along the region hierarchy, so a hundred dependencies from one package to
  another become one motorway. Inside a region they are routed around cities.
  Routing never moves a city.
- Hovering a city unbundles its roads and shows the individual connections.
  Bundles are for the overview, single roads are for the detail.

### Zoom levels

Zoom is semantic. Each level changes what is drawn, not how large it is drawn.

- Continent: top-level regions as colored territories with borders, motorways
  between them, region names only.
- Country: sub-regions and the larger cities, motorway network, city names for
  the most important cities.
- City: every file as a city with its name and local roads. A city large
  enough on screen shows its schematic: the file's structure as colored token
  bars in source order, the way an editor minimap shows a file from afar.
- Street: the real source of one file, syntax highlighted, with the current
  diff inline. The transition from schematic to source is a crossfade at the
  same position, so the user never loses the place.

Labels are ranked once by structural importance (region above city above
building, then by fan-in and size) and appear at the zoom where they fit.
Recency of agent activity never changes label rank. It changes color and
motion instead.

### Layout stability, stated as a requirement

- The same repository at the same commit produces the same map, on any
  machine, with no persisted state. Every source of nondeterminism is a bug.
- Between two commits, movement is limited to what the change forces. A file
  added to one directory moves nothing outside that directory's slack, and
  usually nothing inside it either.
- Stability is measured, not assumed. Real commit histories are replayed
  through the layout and excess movement beyond the forced minimum is tracked
  as a regression metric.
- Stability is what makes history (section 12) possible. A session from last
  month lands on the same streets as one from today.

### Layers (toggleable overlays)

- Traffic: reads, searches, edits and test runs as movement and volume on the
  network, fading over time, one color per agent.
- Diff: added, modified, deleted, colored on the city or building.
- Context: which files are in an agent's context right now.
- Plan: current to-do items pinned to the regions they concern.
- Tests: last test results mapped to the files they cover or that failed.
- Scope: user-drawn or inferred boundary of where this change should live.
- Heat: history across all recorded sessions (section 12).

## 7. What the map shows during a session

- Position. Where each agent is right now (last tool call), always visible,
  camera following the one that needs attention most.
- Traffic. A read followed by an edit is a trip from one city to another,
  drawn as movement along the roads between them. Repeated trips raise the
  link volume and the road brightens and widens. Volumes decay over time.
- Edits. Nodes pulse on edit, then keep a color for the diff state. At project
  zoom, an edited file shows a one-line summary derived from the agent's own
  message that preceded the edit.
- Context fog. Files the agent has never loaded are dimmed.
- Plan. To-do items appear on the map where they will land. The user sees
  where the agent is heading, not just where it is.
- Tests. When the agent runs tests, failures light up the affected files. The
  edit, run, fail, fix loop becomes visible as a story.
- Waiting. When the agent is thinking, the camera does not move and the map
  shows it is waiting. Silence is information.

## 8. Alarms: Wake tells you when to look

The core promise: you can stop watching. Wake turns what it sees into a short
list of alarms, each anchored to a place on the map.

| Alarm | Trigger |
|---|---|
| Needs you | A permission request is pending, or the agent asked a question and is idle |
| Blind edit | The agent edits a symbol whose dependency it never read |
| Drift | An edit lands outside the scope boundary |
| Loop | The same lines are edited and reverted, or the same test fails, N times |
| Regression | A test that was green is now red |
| Burn | Token or tool-call rate in one region spikes far above the session baseline |
| Collision | Two agents edit the same file or the same symbol (section 9) |
| Done | The session finished, the recap is ready |

- Each alarm carries a map snapshot: the place, the trail that led there, the
  agent's last message. Clicking it flies the camera to the spot with steering
  controls ready.
- Delivery escalates: on the map, then a desktop notification, then a push to
  the phone through a channel the user configures (ntfy or similar, self
  hosted friendly). The user picks the level per alarm.
- Alarms are few and specific on purpose. A noisy alarm gets muted and then
  Wake is a screensaver. Every alarm type ships with a precision target and is
  tuned on recorded sessions before it is on by default.
- Alarms that need a decision (permission, drift, collision) offer the
  decision inline: approve, deny, stop, or send a message.

## 9. Fleet: many agents, one map

- Every Claude Code session in the repository and its worktrees shows up on the
  same map with its own color, cursor, and trail. Subagents nest under their
  parent's color.
- Worktrees share the base map. An agent working in a worktree is drawn on the
  same city it would touch in the main tree, so overlaps are visible before
  they become merge conflicts.
- Collision warnings fire when two agents edit the same file, the same symbol,
  or a file and its direct dependency within a short window.
- The fleet strip lists every agent with state (working, waiting on you,
  thinking, done), current region, elapsed time, and token spend. Click to fly
  to it, double click to focus its terminal.
- Focus mode dims every agent except one. Overview mode shows them all with
  trails shortened so the picture stays readable.

## 10. Steering

- Stop. One click halts generation by sending the interrupt keystroke to the
  embedded Claude Code session.
- Camera takeover. Pan or zoom and the camera is yours. A single control hands
  it back to the agent.
- Fences. Mark a region as off limits. Edits inside it are denied before they
  happen and the agent is told why. Fences apply to every agent in the fleet.
- Scope boundary. Draw where the change should live. Drift raises an alarm,
  optionally a hard stop.
- Go here. Click or lasso a region, type an intent. The message lands in the
  agent's terminal with the paths and line ranges attached.
- Not this way. Drag the plan's stops on the map to reorder them, or strike one
  out. The change is sent to the agent as a message.
- Spatial comments. Attach a note to a node. It reaches the agent as a message
  with file and line context.
- Approval in place. When the agent asks permission for an edit, the map shows
  the edit where it will land. Approve or reject there.

## 11. Recap and review

Every session ends with something worth looking at and worth sharing.

- Recap. A 15 to 30 second time-lapse rendered from the session: the agent's
  trail over the map at high speed, then the tour stops, then a one-screen
  summary (files touched, regions crossed, tests, tokens, time). Generated
  automatically when a session ends.
- Export formats: MP4 and GIF for chat and social posts, a self-contained HTML
  page that replays the session interactively with no Wake install, and a
  Markdown block for the PR description with the tour as numbered stops.
- Recaps contain repository names and code. Export always shows a preview with
  a redaction toggle (blur source, rename regions to letters) before anything
  leaves the machine.
- The tour. An ordered list of stops, each with a location on the map, a range
  of code, and a short narration of what changed there and why it matters.
  The map plays the tour, the user pauses, asks questions in the chat, and
  resumes.
- Architectural diff. At project zoom, review shows the change to the graph
  itself: new or removed dependencies between modules, new public symbols,
  deleted ones.
- Order comes from structure, not from the file system. Default order follows
  the dependency graph bottom up. The agent can override it when the story
  demands a different order.

## 12. Replay and history

- Replay. Every event is timestamped. A time scrubber rewinds and replays a
  session at any speed, live or finished. "I looked away for ten minutes, what
  happened" is answered in thirty seconds.
- History. All recorded sessions in a repository are stacked on the same
  stable map. The heat layer shows, per region:
  - where agents spend the most tokens and time
  - where they re-read the most before they edit
  - where their edits get reverted, by them or by humans
  - where alarms fire most often
- That is a map of where the codebase is hostile to agents. It tells the team
  where a CLAUDE.md, better docs, a test harness, or a refactor will pay off.
- Cost per region. Token spend summed by region over a time range. Useful for
  teams that want to know what agent work on a given module costs.
- History is local. It is built from transcripts already on disk and stored
  next to the project, never uploaded.

## 13. Integration with Claude Code

Conceptual surfaces, in order of increasing coupling. All exist today.

- Session transcripts. Every tool call, result, and message on disk with
  timestamps. Enough for replay, recap and history with zero integration.
- Hooks. Called before and after each tool use. Enough for the live map, the
  fleet, and most alarms. A pre-edit hook can deny, which gives fences.
- The terminal itself. Wake hosts the interactive Claude Code session in an
  embedded terminal. Keystrokes give interrupt and message injection. The
  terminal is the chat pane, never the data source.
- Editor integration. Claude Code connects to an editor over a local socket
  for in-place diffs, selection context, and file-and-line mentions. Wake can
  present itself as that editor. This is the surface for approval in place
  and anchored comments.
- Permission callbacks. Claude Code can ask an external process before a tool
  runs. This is approval in place and inline alarm decisions.
- Not used: driving Claude Code as a subprocess through the programmatic
  agent interface. Anthropic's terms expect API-key billing for third-party
  products on that path, which would exclude subscription users.
- Skills. Guided review is a skill Claude Code can already run in text form.
  Wake gives that skill a structured output format (the tour) and a renderer.

## 14. Conceptual architecture

- Event stream. One normalized stream of session events per agent: read,
  search, edit, run, message, plan update, permission request, subagent start
  and stop. Fed by transcripts and hooks.
- Code graph. Symbols, files, directories, and edges, built by fast syntax
  parsing of the working tree and kept in sync with edits.
- Layout engine. Turns the code graph into stable positions.
- Alarm engine. Rules over the event stream and the code graph. Each rule is
  testable offline against recorded sessions.
- Renderer. Draws the map at the current zoom level with overlays, handles
  camera, animation, and level of detail. Smooth for tens of thousands of
  files and a handful of concurrent agents.
- Recorder. Renders recaps headlessly from the event stream and the map, at a
  fixed frame rate, independent of the live view.
- History store. Per-repository aggregates of all sessions on map coordinates.
- Chat. The user's own Claude Code session in an embedded terminal, one per
  agent.
- Indexer. A native sidecar process that walks, hashes, parses and watches the
  repository and serves the code graph to the rest of the app.

## 15. Roadmap

Each milestone is usable on its own.

- M0. Replay (done as a prototype). Static map plus session playback.
- M1. Live, read only (done). Daemon with hooks and transcript tail, live map,
  autopilot camera.
- M1.5. Front door (done as `wake`, `npx` packaging open). `wake` in any
  repository opens the most recent transcript and plays it with a timeline.
  No hooks, no config. Ten seconds to wow.
- M2. Alarms and the real chat. Embedded Claude Code terminal, stop, fences,
  the alarm engine with Needs you, Blind edit, Drift, Loop, Regression, Done.
  Desktop and phone delivery.
- M3. Fleet. All sessions and worktrees on one map, fleet strip, collision
  alarms, fences across agents.
- M4. Recap and tour. Headless recorder, MP4, GIF and HTML export with
  redaction preview, tour format and player, PR Markdown export.
- M5. History. Heat layer, agent-hostility report, cost per region.
- Later. Go here and Not this way steering, approval in place, architectural
  diff, spatial comments.

## 16. Non-goals

- Not an editor. No typing code in Wake.
- Not a chat client. Wake does not reimplement the conversation UI. It embeds
  the real one.
- Not an agent driver. Wake observes and steers the user's own sessions. It
  does not spawn agents on the user's behalf.
- Not a map for the agent. Wake does not feed context to the model.
- Not agent-agnostic in the first year. Claude Code only.
- Not a hosted service. Runs locally. Recaps leave the machine only when the
  user exports them.
- No 3D. Cities and landscapes look impressive and are hard to read.
- No force-directed layout. Position is never the output of a simulation.
- Not now: alternate projections (topic map, dependency projection), airways,
  git blame and churn overlays, manual layout nudges, precise reference edges.

## 17. Open questions

- Alarm precision. What false-positive rate makes a user mute an alarm, and
  can Blind edit and Drift reach it without per-repository tuning?
- How to infer the scope boundary from the first edits without false drift
  alarms.
- Phone delivery without a hosted service. ntfy works, but is it simple enough
  for the default path?
- Recap pacing. How to compress a 40 minute session into 20 seconds and keep
  the story readable. Probably: skip idle time, speed up reads, slow down on
  edits and alarms.
- Collision granularity. Same file is cheap and noisy, same symbol is precise
  and needs the parser in the loop.
- How much slack to leave around cities.
- How to order sibling regions by coupling without making the order fragile
  to small changes in the dependency graph.
- Whether the tour should be authored by the same session that made the change
  (knows the intent) or by a fresh one (unbiased reviewer).

## 18. What success looks like

- A user with Wake looks away for most of a session and still stops a bad one
  earlier than a user watching the text log. Both halves are measured: time
  looked away, and time from first wrong edit to stop.
- Users running three or more agents in parallel keep Wake open, because it is
  the only place they see all of them.
- Review of an agent PR with the tour takes less time and finds more issues
  than review with the plain diff.
- Recaps get posted by people who did not build Wake.
- Teams change their codebase (docs, CLAUDE.md, refactors) because the history
  map showed them where agents struggle.
- Prior code visualization tools stalled because nobody opened them twice.
  Wake is open for every session because the agents are in it, and it earns
  that by calling you only when it matters.
