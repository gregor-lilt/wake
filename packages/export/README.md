# @wake/export — one real repository plus one real session, as one JSON file

Produces the fixture the renderer loads instead of synthetic data: a repository
at `HEAD` as a Wake map (tree, stable rects, symbols, dependency roads) plus a
real Claude Code session as traffic over that map.

**schemaVersion 3**: symbol nodes carry a real `lineEnd` — the last line of the
definition's body, not a copy of `lineStart` — plus an optional `col`
(indentation) and `parentId` (the enclosing definition), so the renderer can
compute the enclosing scope of any line. Version 2's file-node fields
(`effectiveLines`, `folded`) and length-proportional rects are unchanged. See
"Schema" below and the [layout README](../layout/README.md) for the tile
geometry.

Three sources, no new machinery:

- [`@wake/layout`](../layout) for the tree and the rects. `git ls-tree -r -l HEAD`
  only, nothing is checked out.
- [`wake-index`](../../crates/wake-index) for symbols and imports, read back out
  of its SQLite through `node:sqlite`.
- `~/.claude/projects/<slug>/<session>.jsonl` for the session.

**What leaves the analysed repository:** paths, symbol names, line numbers,
blob sizes and aggregate counts. Nothing else. No source text, no
`oldString`/`newString`, no `structuredPatch` line content, no prompts, no
assistant prose, no shell command arguments. The output lands in
`<wake>/.wake/exports/<repo-basename>.json`, which is gitignored, and is never
committed.

## Run it

```sh
npm install                                   # typescript 5.9.2, @types/node 22.15.3
npm run typecheck                             # tsc --noEmit, strict
npm run export -- --repo /path/to/repo        # or: WAKE_TEST_REPO=/path/to/repo npm run export
```

Node 23 with `--experimental-strip-types` and `--experimental-sqlite`. No build
step, no bundler, no runtime dependencies.

There is deliberately **no default repository**: the target path comes from
`--repo` or `WAKE_TEST_REPO`, and the Claude Code project directory slug is
derived from that path (every non-alphanumeric character becomes `-`).

| flag | default |
| --- | --- |
| `--repo PATH` | `$WAKE_TEST_REPO`, else fail |
| `--out PATH` | `<wake>/.wake/exports/<repo-basename>.json` |
| `--index-binary PATH` | `<wake>/target/release/wake-index` |
| `--db PATH` | wake-index's own cache path for that repo |
| `--session PATH` | the highest-scoring transcript (see below) |
| `--projects PATH` | `~/.claude/projects` |
| `--skip-index` | off; reuse the existing index database |
| `--worktree` | off; see "working-tree mode" |

The run also writes `<out basename>.summary.txt` next to the JSON: the same
summary block printed to stdout.

## Schema (`schemaVersion: 3`)

Version 3 is version 2 plus two optional fields on symbol nodes and a real
value in a field that was already there. Nothing was removed or renamed.

```jsonc
{
  "schemaVersion": 3,
  "repo": { "name": "...", "path": "...", "commit": "<sha>", "generatedAt": "<iso>" },
  "nodes": [
    { "id": 0, "kind": "dir" | "file" | "symbol",
      "name": "<basename, or symbol name>",
      "path": "<repo-relative path; for a symbol, the file it lives in>",
      "parent": 0,            // null only for the root dir
      "size": 0,              // bytes for dir (subtree sum) and file, lines for symbol
      "lang": "py",           // null for dirs and unknown extensions
      "symbolKind": null,     // class | function | method | module | constant | other
      "lineStart": null,
      "lineEnd": null,        // symbols: last line of the definition, >= lineStart
      "col": 4,               // v3, symbols only: indentation of the first line
      "parentId": 812,        // v3, symbols only, and only when nested in another symbol
      "effectiveLines": 214,  // v2, files only: lines, long lines wrapped at 100 columns
      "folded": true }        // v2, files only, and only when effectiveLines > 400
  ],
  "rects": [[7, 12, 40, 5, 24]],                       // [id, x, y, w, h], layout CELLS
  "edges": [{ "from": 1, "to": 2, "kind": "import", "weight": 1 }],
  "symbolEdges": [{ "from": 3, "to": 4, "kind": "call", "weight": 1 }],
  "session": {
    "sessionId": "<uuid>", "transcriptPath": "<path>",
    "startedAt": "<iso>", "endedAt": "<iso>",
    "events": [
      { "t": 0,                       // ms since the first event
        "kind": "read" | "edit" | "write" | "search" | "run" | "message" | "other",
        "tool": "Read",
        "nodeId": null,               // a file node, or null
        "path": null,                 // repo-relative, or null
        "lineStart": null, "lineEnd": null,
        "summary": "Read some/file.py",
        "agentId": "a1b2c3" }        // optional, present only on subagent events
    ]
  }
}
```

Contract details the renderer can rely on:

- `nodes` is ordered: the root dir first, then a depth-first walk with dirs
  before files and each group sorted by name, then every symbol grouped by file
  in source order. `id` equals the array index.
- Every `dir` and `file` node has exactly one rect. **Symbols get no rect**:
  the renderer lays them out inside their file's rect in source order.
- Rect units are layout cells. **A cell is no longer one file** (that was
  version 1): a cell is 20 glyphs wide and 10 lines tall, and a file tile is
  always **5 cells wide** (the sheet's 100 columns) by one cell per 10 effective
  lines, quantized to 40-line steps and capped at 400 lines. A stub is 5 x 4, a
  200-line file 5 x 20, a folded file 5 x 40. Footprint is still decoupled from
  BYTE size, so a directory of huge generated blobs cannot distort the geography
  — a 17 MB binary counts as one line and gets the smallest tile.
- Every footprint carries a one-cell gap on its right and bottom edge, which is
  the 20 %-of-tile-width gap docs/design.md asks for. The rect is the drawn
  tile, gap excluded, so two neighbouring tiles differ by 6 cells in x.
- `effectiveLines` is present on every `file` node — a binary or unreadable
  file reports 1 — and absent on dirs and symbols. `folded` is present, and
  always `true`, only on a file past the 400-line cap; it is absent otherwise,
  so `'folded' in node` is the test. A renderer that ignores both fields draws
  version-1 semantics on version-2 rects: still parseable, just blind to length.
- A symbol's `lineStart`..`lineEnd` is its whole definition, both ends
  inclusive, `lineEnd >= lineStart` always, and it never runs past the end of
  its file. `size` is that span in lines (it was always 1 before version 3).
  One-line definitions — a module-level constant, a one-line `def` — are the
  only rows where the two are equal.
- `col` is present on every symbol node and is the 0-based indentation of the
  definition's first line, so `export class Foo` and `const f = () => {}`
  report the column of `export` / `const`, not of the captured node.
- `parentId` is the innermost **symbol** node whose span contains this one, and
  is always a symbol in the same file: a method's class, a nested function's
  function. It is absent, not null, on a top-level definition, so
  `'parentId' in node` is the test. `parent` still points at the FILE node, on
  nested and top-level symbols alike — the two fields are independent.
  Containment is asserted before the file is written.
- `edges` endpoints are always `file` nodes, `symbolEdges` endpoints always
  `symbol` nodes, `event.nodeId` is always a `file` node or `null`. All three
  are asserted before the file is written; a failure prints and exits non-zero.
- `weight` is the number of aggregated occurrences of that (from, to) pair.

### What a version-2 renderer has to change

Nothing but the version gate. Verified by running the renderer's own
`buildFixture` (`apps/spike-renderer/src/exportmap.ts`, unmodified) over the
version-3 demo export: identical dirs, files, symbols, edges and `448x512`
extent, the same `[id, x, y, w, h]` rects and the same dense id space, and
every `symLineStart` / `symLineEnd` an integer with no row where the end
precedes the start. The one blocker is `fetchExport`, which rejects anything
but `schemaVersion === 2` — that constant has to become 3.

What changes *numerically* for a reader that already looked at these fields:
`lineEnd` on a symbol is now a real end line rather than a copy of `lineStart`,
and a symbol node's `size` is its span in lines rather than always 1. A
renderer that drew a symbol as a single row will now find a range. Nothing else
moved: `rects`, node order, `parent`, `edges` and `symbolEdges` are all
byte-identical to what version 2 produced from the same commit.

### What a version-1 renderer has to change

The payload is additive, and the loader in `apps/spike-renderer` parses all of
it unchanged except for one line: `fetchExport` rejects anything but
`schemaVersion === 1`. Verified on the demo export:

- `rects` are still `[id, x, y, w, h]`, five numbers, and the loader reads them
  positionally.
- `nodes` still has `id === array index`, the root dir first, then a depth-first
  walk, then symbols grouped by file. Every dir and file has exactly one rect;
  symbols have none.
- The two new node fields are optional and unknown to a v1 loader, which ignores
  them.
- What *does* change semantically is the numbers inside `rects`: the extent is
  roughly twenty times larger in each direction, tiles are 5 cells wide and 4 to
  40 cells tall, and a renderer that assumed "one cell is one file" will draw
  the map at the wrong scale even though it parses.

### Deviations from the schema as first specified

1. `symbolKind` also takes `constant` and `other`. The Python grammar's
   `tags.scm` emits `constant`, and it emits `function` for methods too (no
   class context), so `method` and `module` never appear for Python. Since
   version 3 a Python method is still recognisable: it is a `function` whose
   `parentId` names a `class`.
2. `run` events may carry a `path` and `nodeId`. See "shell traffic" below.
3. `edges` includes imports that the exporter resolved itself, not only the ones
   wake-index marked `resolved = 1`. See "import resolution" below.
4. `effectiveLines` counts a line that is longer than the sheet as several
   lines, so it is not the file's line count and is not comparable with
   `wc -l`. A binary or unreadable file counts as 1, and so does an empty one.
5. Events carry an optional `agentId`. It is **absent**, not null, on
   main-session events, so `'agentId' in event` is the test for subagent
   traffic. `write` events also carry a line range when the tool result had a
   `structuredPatch` (a new file's full extent); only `edit` events are counted
   as "edits with a line range" in the summary.

## What the exporter does beyond reading the two tools

### Import resolution

wake-index resolves relative specifiers only, so in a Python codebase every
intra-repo *absolute* import (`pkg.mod.sub`) lands in the unresolved bucket even
though it names a file in the same repository. Exporting only the indexer's
resolved edges left the map with almost no road network at all.

The exporter therefore builds a dotted-module map with the standard rule (walk
up from a module file while the directory has an `__init__.py`; the first
directory without one is the package root), then resolves each unresolved
specifier against it, stripping trailing components to cover
`from pkg.mod import Name`. Everything that still misses is a third-party
import and stays out of the graph.

### Symbol call edges

A reference row is a call site: file plus line, with no enclosing scope of its
own. The caller is approximated by the **nearest preceding definition** in the
same file, preferring a function over a class and never a constant. Definitions
carry real body spans as of version 3, so exact containment is now available
and is the obvious replacement for this heuristic; it is deliberately not taken
here, so that `symbolEdges` stays byte-identical to version 2 and the span
change can be judged on its own. The callee is resolved
by name in three tiers: a name with exactly one definition in the repository;
otherwise exactly one candidate in the same file; otherwise exactly one
candidate in a file this file actually imports. Anything still ambiguous is
dropped rather than guessed.

### Effective lines (schemaVersion 2)

A tile's height is proportional to its **effective** line count, not its byte
size and not its raw line count: docs/design.md fixes the sheet at 100 columns,
so a 250-column line is three lines on the page.

    effectiveLines = sum over lines of ceil(max(1, length) / 100)

- Working-tree mode reads the file from disk, so a file the agent just edited is
  drawn at its current length. HEAD mode reads the blobs through one
  `git cat-file --batch`, keyed by blob sha.
- Binary (a NUL byte in the first 8 KB) or unreadable: 1.
- A blob larger than `400 * 101` bytes cannot have fewer than 400 effective
  lines, so it is folded whatever its exact count and is never read at all. If
  its extension is not a known text extension it counts as 1 instead. This is
  what keeps a repository full of multi-megabyte generated assets cheap.
  **Such a file reports `effectiveLines: 401`, which is a floor, not a count**:
  it says "more than the cap" and nothing else. The tile height is the cap
  either way, so the layout is unaffected; a renderer that wants to caption a
  fold with a real hidden-line count has to read the file itself.
- Only the integer count leaves the counting module. No line, no fragment of
  content, and no length distribution is exported.
- Files above the cap get `folded: true` and a tile of exactly the cap's height.
  The renderer draws the sheet as a budget of windows separated by fold markers
  (docs/design.md section 3); the exporter says only *that* it is folded.

### Working-tree mode (`--worktree`)

Without the flag the node tree is exactly `git ls-tree -r -l HEAD`. With it, the
tree is the union of `HEAD` and the current working tree, which is what a live
session needs: an agent that just created a file must have a city to light up.

- a tracked file present on disk contributes its **on-disk** size, so a modified
  file is drawn at its current size
- a tracked file deleted in the working tree keeps its `HEAD` blob size, so a
  deletion never silently removes a city mid-session
- untracked, non-ignored files (`git ls-files --others --exclude-standard`)
  become file nodes

Entries are sorted by path before the tree is built, so the layout stays
deterministic and byte-identical across runs. It works in a linked worktree on a
detached `HEAD` (`commit` is whatever `git rev-parse HEAD` returns there), and
wake-index indexes the working tree, so a new file's symbols come along.

### Session choice

Every transcript under `~/.claude/projects` is scanned and scored. A transcript
whose `cwd` **equals the target path exactly** wins outright: that is the
session the caller means. Everything else falls back to the activity score,
which counts tool calls naming a file inside the target repository
(read/edit/write/search first, then any file-naming call, then records whose
`cwd` is anywhere inside the repository). The target's own project slug is not
sufficient on its own: a session that started in another directory and then
worked in this repository is stored under the other directory's slug.

Events are ordered by timestamp, never by walking `parentUuid`: compaction
rewrites the parent chain (`logicalParentUuid`). `isSidechain` is dead: subagent
transcripts live in `<session>/subagents/agent-<id>.jsonl`. Those are **merged
into the parent session's timeline** by timestamp and tagged with `agentId`
(the `<id>` from the filename), so parallel agents interleave on one clock and
the renderer can give each its own cursor. A subagent transcript is never ranked
as a session of its own.

Edit line ranges come from the `toolUseResult.structuredPatch` on the matching
user record (`tool_use_id` join): the minimum `newStart` and the maximum
`newStart + newLines - 1` across hunks. Only those two integers are read. Read
events carry `offset`/`limit` as a line range when present.

### Shell traffic

A `run` event whose command contains an exact match for a tracked file path gets
that file's `nodeId` and `path`. Without it a shell-driven session has no
position on the map at all, and in the measured session shell commands were 61%
of all events. The `summary` still holds only the first word of the command,
reduced to its basename, and never an argument.

## Measured run

Target: the target repository (a private Python codebase used as local test
data), at one commit. Apple M3, macOS 26.6.2. Whole export, including a cold
index: **1.7 s wall**, of which the indexer is 0.15 s. Output 0.9 MB of JSON.

| | |
| --- | --- |
| dirs | 90 |
| files (tracked at HEAD) | 356 |
| rects | 446 (every dir and file) |
| layout extent | 480 x 512 cells (schemaVersion 2 cells; it was 40 x 48 in v1) |
| effective lines | 66 237 over 356 files, longest 962 |
| ... folded above the 400 cap | 53 |
| ... binary or unreadable, counted as 1 | 27 |
| symbols | 3 009 (2 223 function, 523 class, 263 constant) |
| nodes total | 3 455 |
| file import edges | 581, aggregated from 1 494 import rows |
| ... resolved by wake-index | 92 |
| ... resolved by the exporter's module map | 531 |
| **unresolved imports** | **871** (all third-party; 0 point at a file in the repo) |
| symbol call edges | 3 569, from 4 466 resolved references |
| ... unique name / same file / via an import | 3 819 / 407 / 240 |
| references dropped as ambiguous | 729 |
| references with no definition in the repository | 5 753 of 10 948 rows |
| files indexed vs tracked | 320 of 356 (36 are tracked but gitignored, so the indexer's walk skips them) |

Session, one real Claude Code session picked by the ranking above (175
transcripts scanned):

| | |
| --- | --- |
| events | 131 |
| by kind | 80 run, 19 message, 11 read, 11 edit, 4 write, 6 other |
| events mapped to a file node | 38 (9 direct file tools + 29 shell commands) |
| edits with a `structuredPatch` line range | 11 of 11 |
| paths outside the target repository | 17 (dropped to `null`) |
| in-repo paths with no node at `HEAD` | 0 |
| duration | 44.2 h wall, with 2 idle gaps over an hour |
| validation | ok |

The 44-hour wall clock is real: the session was resumed across two days. A
renderer that plays back `t` linearly will sit still through those gaps and
should compress or skip idle time.

## Measured run, working-tree mode

Second fixture: a linked git worktree of the same commit, detached `HEAD`, with
3 modified files and 1 new untracked test file, and one session recorded in it.
Run with `--worktree`.

| | |
| --- | --- |
| dirs | 90 |
| files | 357 (356 tracked + 1 untracked) |
| rects | 447 |
| layout extent | 448 x 512 cells (the union's extra file changed the packing) |
| effective lines | 66 739 over 357 files, longest 962 |
| ... folded above the 400 cap | 54 |
| ... binary or unreadable, counted as 1 | 26 |
| file tiles | all 5 cells wide; heights 4 to 40 cells (88 stubs at 4, 58 at the 40-cell cap) |
| working-tree deltas | +1 untracked file node, 3 sizes taken from disk, 0 tracked files absent |
| symbols | 3 021 (+12 in the new file: 9 function, 2 class, and one more elsewhere) |
| ... spanning more than one line | **2 775 (91.9%)**; the remaining 246 are 215 module-level constants and 31 genuinely one-line `def`s |
| ... carrying a `parentId` | **1 722 (57.0%)**, of which 1 460 are Python methods (a `function` whose parent is a `class`) and 198 nest two deep or more |
| spans past the end of their file | 0 of 3 021, checked against the on-disk line count of every file |
| file import edges | 582 from 1 498 rows (92 + 532 resolved, **874 unresolved**, all third-party) |
| symbol call edges | 3 578 |
| events | 36 |
| by kind | 23 run, 5 edit, 4 read, 2 write, 1 message, 1 other |
| events mapped to a file node | 25 (11 direct file tools + 14 shell commands) |
| edits with a `structuredPatch` line range | 5 of 5 |
| subagent transcripts merged | 0 (this session spawned none) |
| duration | 3 min 42 s |
| validation | ok |

The session was selected by the exact-`cwd` rule (233 records against 11
file-tool calls; the runner-up had 10 exact-`cwd` records and no file calls).
The new untracked file is a file node with its own rect and 11 symbols, and it
appears in the timeline as a `write` event followed by three `run` events that
name it.

The subagent merge was verified separately against a session that does spawn
them: 17 subagent transcripts merged into one monotonic timeline, 1 375 of
1 491 events tagged with one of 17 distinct `agentId` values, interleaved with
the main session's own events.
