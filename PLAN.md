# Wake

The map for the human behind the coding agent.

Wake is an open-source companion for Claude Code. It shows a live, navigable map
of the software project and animates what the agent reads, edits, and plans on
that map. The user watches the agent's wake, takes over when needed, and gets a
guided tour of the changes afterwards.

## 1. Problem

- Agentic coding tools (Claude Code, Codex and others) edit many files in
  seconds. The engineer gets a linear text log of tool calls and a diff at the
  end.
- The log answers "what was typed". It does not answer where in the project the
  agent is, why it went there, what it read before it wrote, or whether it is
  drifting out of scope.
- Review happens after the fact, file by file, in whatever order the diff tool
  picks. Nobody explains the change in the order it should be understood.
- The result: engineers either rubber-stamp agent PRs or slow the agent down to
  human speed. Neither is what we want.

## 2. Thesis

- Code is spatial. Agents work spatially (jump between files, follow
  dependencies). Humans think spatially (mental map of the repo). Only the
  interface between them is linear text.
- A stable, navigable map of the project, animated with the agent's activity,
  restores the missing dimension. The user sees position, direction, and scope
  at a glance and zooms in only when something looks off.
- Everything the map shows is derived from data Claude Code already produces:
  tool calls with timestamps, edits, plans, permission requests, and the git
  diff. No new agent, no fork.

## 3. Positioning

- The current wave of "codebase map" tools builds maps for the agent, to cut
  tokens and improve retrieval. Wake builds the map for the human, to watch and
  steer the agent. Nobody occupies that spot today.
- Wake is not an IDE and not an editor. It is a panel: map plus chat. The editor
  stays the editor.
- Wake is explicitly built for Claude Code first. Other agents are a later
  concern, if ever.
- Wake runs the user's own, unmodified Claude Code under the user's own login.
  It never drives the agent through a programmatic interface with borrowed
  credentials. A Claude subscription is enough to use Wake.

## 4. Metaphors that drive the design

- Wake. The agent leaves a visible trail. Reads, edits, and test runs fade over
  time like the wake behind a boat. You can always see where it has been.
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

- Spatial memory is the product. The layout must be stable across sessions and
  across small changes to the code. A file added tomorrow must not move
  everything else. Layout is persisted with the project.
- Semantic zoom, not scaled pictures. Each zoom level changes representation:
  directories, then files, then a file's structure, then code. The user never sees an
  illegible thumbnail of code.
- Motion means something. Every animation maps to a real event. No decoration.
- Show attention, not just edits. The reads are the "why" of the writes.
- Cheap to start, deep when needed. Import edges and symbols come from fast
  syntax parsing. Precise reference edges are computed lazily for what is on
  screen.
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
| Airway | Long-distance cross-cutting dependency, drawn as an arc at low zoom |
| Traffic | The agent's activity moving over the network |
| Link volume | How often a session traversed a connection |

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
  This costs compactness, and the cost is accepted.
- Languages that define module boundaries (packages, workspaces, crates) may
  override the raw folder tree as the region hierarchy.

Alternate projections are toggles, never the home map: a topic map where
position comes from vocabulary similarity, and a dependency projection where
strongly coupled code is drawn adjacent. Nodes fly to the alternate positions
and back, so the user always returns to a place they know.

### The network: which relationship is the road

Geography has one notion of distance. Code has several relationships. One of
them is the road network, the others are overlay layers.

- Roads are dependencies between files: imports, weighted by how many symbols
  cross them. At street zoom the individual references inside a file are shown
  as the file's own detail, not as roads.
- Roads are routed, not drawn straight. Between regions they are bundled
  along the region hierarchy, so a hundred dependencies from one package to
  another become one motorway. Inside a region they are routed around cities.
  Routing never moves a city.
- Inheritance, test coverage, and ownership are overlays the user toggles,
  like a rail network or a power grid layer on a real map.
- Hovering a city unbundles its roads and shows the individual connections.
  Bundles are for the overview, single roads are for the detail.

### Zoom levels

Zoom is semantic. Each level changes what is drawn, not how large it is drawn.

- Continent: top-level regions as colored territories with borders, motorways
  and airways between them, region names only.
- Country: sub-regions and the larger cities, motorway network, city names for
  the most important cities.
- City: every file as a city with its name and local roads. A city large
  enough on screen shows its schematic: the file's structure as colored token
  bars in source order, the way an editor minimap shows a file from afar.
  Classes and functions read as blocks.
- Street: the real source of one file, syntax highlighted, with the current
  diff inline. Changed lines are marked, removed code blends out, new code
  blends in. The transition from schematic to source is a crossfade at the
  same position, so the user never loses the place.

Labels are ranked once by structural importance (region above city above
building, then by fan-in and size) and appear at the zoom where they fit, like
the names of major places staying readable on a real map. Recency of agent
activity never changes label rank. It changes color and motion instead.

### Layout stability, stated as a requirement

- The same repository at the same commit produces the same map, on any
  machine, with no persisted state. Every source of nondeterminism is a bug.
- Between two commits, movement is limited to what the change forces. A file
  added to one directory moves nothing outside that directory's slack, and
  usually nothing inside it either.
- Stability is measured, not assumed. Real commit histories are replayed
  through the layout and excess movement beyond the forced minimum is tracked
  as a regression metric.
- Users can nudge regions and cities by hand. A nudge is a grid constraint,
  persisted with the project, and re-applied after every automatic layout.

### Layers (toggleable overlays)

- Traffic: the agent's reads, searches, edits and test runs as movement and
  volume on the network, fading over time.
- Diff: added, modified, deleted, colored on the city or building.
- Context: which files are in the agent's context right now.
- Plan: current to-do items pinned to the regions they concern.
- Tests: last test results mapped to the files they cover or that failed.
- Git: blame age, churn, ownership.
- Scope: user-drawn or inferred boundary of where this change should live.
- Structure overlays: inheritance, test coverage, ownership, as described
  above.

## 7. What the map shows during a session

- Position. Where the agent is right now (last tool call), always visible,
  camera following.
- Traffic. The agent's activity is traffic on the network. A read followed by
  an edit is a trip from one city to another, drawn as movement along the
  roads between them. Repeated trips raise the link volume and the road
  brightens and widens. Volumes decay over time, so the map shows where the
  agent has been working recently, and the motorway between two regions
  glowing is the fastest way to see that a change spans them.
- Trip table. Every trip is recorded with origin, destination, time and
  purpose (read, search, edit, run). The session can be summarized as a flow
  map: which regions exchanged the most traffic, in which order.
- Edits. Nodes pulse on edit, then keep a color for the diff state. At project
  zoom, an edited file shows a one-line summary derived from the agent's own
  message that preceded the edit.
- Context fog. Files the agent has never loaded are dimmed. Flag the case that
  matters: the agent is editing a symbol whose dependency it never read.
- Scope drift. Any edit outside the scope boundary flashes and raises a
  notification. This is the earliest reliable signal that a session is going
  wrong.
- Plan. To-do items appear on the map where they will land. The user sees where
  the agent is heading, not just where it is.
- Tests. When the agent runs tests, failures light up the affected files. The
  edit, run, fail, fix loop becomes visible as a story.
- Subagents. Each parallel agent gets its own cursor and color. Worktrees are
  shown as translucent copies of the region they touch.
- Waiting. When the agent is thinking, the camera does not move and the map
  shows it is waiting. Silence is information.

## 8. Steering

- Stop. One click halts generation by sending the interrupt keystroke to the
  embedded Claude Code session. The chat is ready for a message.
- Camera takeover. Pan or zoom and the camera is yours. A single control hands
  it back to the agent.
- Fences. Mark a region as off limits. Edits inside it are denied before they
  happen and the agent is told why.
- Scope boundary. Draw where the change should live. Drift produces a warning,
  optionally a hard stop.
- Spatial comments. Attach a note to a node. It reaches the agent as a message
  with file and line context, typed into the embedded session or delivered
  through the editor integration surface. The chat is linear, the code is not.
- Approval in place. When the agent asks permission for an edit, the map shows
  the edit where it will land. Approve or reject there.
- Point. Click a node to add it to the next message as context.

## 9. Review mode

- The tour. After a session, or on any diff, the agent produces a tour: an
  ordered list of stops, each with a location on the map, a range of code, and
  a short narration of what changed there and why it matters. The map plays the
  tour, zooming and panning from stop to stop. The user pauses, asks questions
  in the chat, and resumes.
- Architectural diff. At project zoom, review shows the change to the graph
  itself: new or removed dependencies between modules, new public symbols,
  deleted ones, changed inheritance. Text diffs are for the code zoom level.
- Order comes from structure, not from the file system. Default order follows
  the dependency graph bottom up. The agent can override it when the story
  demands a different order.
- Export. The tour can be written into the PR description as a numbered list of
  file locations and narration, so reviewers without Wake still benefit.

## 10. Replay

- Every event in a session is timestamped. A time scrubber lets the user rewind
  and replay the session on the map at any speed.
- Replay answers "I looked away for two minutes, what happened" and "how did it
  end up touching that file".
- Replay also works on finished sessions from the transcript, without a live
  agent. This is the first thing Wake will do.

## 11. Integration with Claude Code

Conceptual surfaces, in order of increasing coupling. All exist today.

- Session transcripts. Claude Code writes every tool call, result, and message
  to disk with timestamps. Enough for replay with zero integration.
- Hooks. Claude Code can call out before and after each tool use. Enough for a
  live, read-only map, and for fences (a pre-edit hook can deny).
- The terminal itself. Wake hosts the interactive Claude Code session in an
  embedded terminal. Keystrokes give interrupt and message injection. The
  terminal is the chat pane, never the data source: tool events come from
  hooks and transcripts, not from scraping the screen.
- Editor integration. Claude Code connects to an editor over a local socket
  for in-place diffs, selection context, and file-and-line mentions. Wake can
  present itself as that editor. This is the surface for approval in place
  and anchored comments.
- Permission callbacks. Claude Code can ask an external process before a tool
  runs and accept a rewritten proposal. This is approval in place.
- Not used: driving Claude Code as a subprocess through the programmatic
  agent interface. Anthropic's terms expect API-key billing for third-party
  products on that path, which would exclude subscription users.
- Skills. Guided review is a skill Claude Code can already run in text form.
  Wake gives that skill a structured output format (the tour) and a renderer.

## 12. Conceptual architecture

- Event stream. One normalized stream of session events: read, search, edit,
  run, message, plan update, permission request, subagent start and stop. Fed
  by the transcript (replay), hooks (live), or the programmatic interface
  (steering).
- Code graph. Symbols, files, directories, and edges, built by fast syntax
  parsing of the working tree and kept in sync with edits. Reference edges
  computed lazily.
- Layout engine. Turns the code graph into stable positions. Persists layout and
  user nudges alongside the project.
- Renderer. Draws the map at the current zoom level with overlays, handles
  camera, animation, and level of detail. Must stay smooth for projects with
  tens of thousands of files.
- Chat. The user's own Claude Code session in an embedded terminal, with Wake
  injecting context from map selection and reading the conversation back from
  the transcript.
- Indexer. A native sidecar process that walks, hashes, parses and watches the
  repository and serves the code graph to the rest of the app.
- Tour player. Reads a tour, drives the camera, syncs with the chat.

## 13. Roadmap

Each milestone is usable on its own.

- M0. Replay. Load a finished Claude Code session and a repository, show the
  static map, play the session on it with a time scrubber. Goal: learn whether
  the visualization is legible at all.
- M1. Live, read only. Follow a running session through hooks. Camera autopilot
  with takeover. Attention trail, diff layer, context fog, plan layer.
- M2. Steering. Stop, fences, scope boundary with drift warnings, spatial
  comments, approval in place. Chat panel integrated.
- M3. Review. Tour format, tour player, architectural diff, export to PR
  description.
- M4. Scale and polish. Large monorepos, subagents and worktrees, test overlay,
  git overlays, persisted layout nudges.

## 14. Non-goals

- Not an editor. No typing code in Wake.
- Not a chat client. Wake does not reimplement the conversation UI. It embeds
  the real one.
- Not an agent driver. Wake observes and steers the user's own session. It
  does not spawn agents on the user's behalf.
- Not a map for the agent. Wake does not feed context to the model.
- Not agent-agnostic in the first year. Claude Code only.
- Not a hosted service. Runs locally next to the agent and the repository.
- No 3D. Cities and landscapes look impressive and are hard to read.
- No force-directed layout. Position is never the output of a simulation.

## 15. Open questions

- How much slack to leave around cities. More whitespace reads better and
  gives the router room, less whitespace fits more on screen.
- Whether roads at region zoom should be imports or calls weighted by
  frequency. Imports are cheap and stable, calls carry more meaning.
- How to order sibling regions by coupling without making the order fragile
  to small changes in the dependency graph.
- Language coverage at launch. Syntax parsing exists for most languages, but
  symbol extraction quality varies. Pick two or three well-supported languages
  first.
- How to summarize an edit at project zoom without an extra model call per
  file. The preceding assistant message is the cheap candidate.
- How to infer the scope boundary from the first edits without annoying the
  user with false drift warnings.
- Whether the tour should be authored by the same session that made the change
  (knows the intent) or by a fresh one (unbiased reviewer).

## 16. What success looks like

- A user watching Wake stops a bad session earlier than a user watching the
  text log. This is the core claim and it must be measured.
- Review of an agent PR with the tour takes less time and finds more issues than
  review with the plain diff.
- Users report they learned the shape of an unfamiliar repository by watching
  the agent work on it.
- Prior code visualization tools stalled because nobody opened them twice. Wake
  is open for every session because the agent is in it.
