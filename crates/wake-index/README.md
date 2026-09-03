# wake-index — Spike 5: indexer speed

Proves the cheap-tier (tier 0) indexing budget from
`docs/research/03-code-graph-extraction.md` section 8:

1. gitignore-aware parallel walk (`ignore`)
2. blake3 per file, rolled up into a per-directory Merkle tree, persisted so a
   later run can name the changed subtrees
3. tree-sitter parse, symbols via `tree-sitter-tags` and each grammar's
   `tags.scm`; facts extracted and **the tree dropped before the function
   returns** — no tree is ever retained across files
4. hand-written import queries per language (tags.scm does not capture imports)
5. SQLite via `rusqlite` (bundled), WAL, built in memory and flushed once
6. `notify` watch mode with a 1s debounce, reparsing only changed files

Roughly 900 lines of Rust. A spike, not a product.

## Build

```
cd /Users/gregor/repos/wake
cargo build --release          # binary at target/release/wake-index
```

`rustup update stable` **was required**: `tree-sitter` 0.27.0 and
`tree-sitter-tags` 0.27.0 declare `rust-version = 1.90`, and `ignore` 0.4.33
declares 1.88. The box had 1.82.0. Updated to **rustc/cargo 1.98.0**
(2026-08-18); everything then compiled with zero warnings.

## Run

```
wake-index index <repo> [--db PATH] [--max-size BYTES] [--exclude GLOB] [--fork-ts-tags]
wake-index watch <repo> [--db PATH] [--max-size BYTES] [--fork-ts-tags]
```

- `index` prints file / symbol / import counts, how many definitions span more
  than one line and how many have a parent, resolved vs unresolved imports,
  Merkle dir count and changed-subtree count, a wall-time breakdown, and peak
  RSS from `getrusage(RUSAGE_SELF)`. Wrap it in `/usr/bin/time -l` to
  cross-check the RSS number (the two agree to within ~5%).
- `watch` prints per-file update time for every reparse and a per-batch total.
- The database defaults to `~/.cache/wake-index/<mangled-repo-path>.sqlite`.
  **Nothing is ever written inside the indexed repository.**
- `--max-size` defaults to 2 MiB; larger files are skipped and counted.
  Files whose first 8 KiB contain a NUL byte are counted as binary and hashed
  but not parsed.
- `--exclude GLOB` adds an ignore override (used below to take `venv/` out of
  repo B's checkout, which has a committed-but-not-gitignored venv).
- `--fork-ts-tags` appends a forked TypeScript tags query. See
  "grammar problems" — the upstream one is close to unusable.

Schema (`PRAGMA user_version` = **2**):

```sql
files(path, hash, size, lang)                       -- path is repo-relative
dirs(path, hash)                                    -- Merkle rollup, root = ''
symbols(id INTEGER PRIMARY KEY,
        file, name, kind,                           -- kind 'ref:*' = reference
        start_line, end_line,                       -- 1-based, both inclusive
        start_col,                                  -- 0-based indentation
        parent_id)                                  -- symbols.id, or NULL
imports(from_file, to_file_or_module, resolved)
```

The database is a pure cache of the repository, so there is no migration path:
`Store::open` compares `user_version` against `store::SCHEMA_VERSION`, and on a
mismatch drops every table and lets the next run rebuild. Version 2 is version
1 plus `id`, a real `end_line`, `start_col` and `parent_id` on `symbols`.

### Symbol spans

A definition row spans the **whole definition**, not its name:
`start_line`/`end_line` are the first and last line of the `function_definition`
/ `class_definition` / `class_declaration` / `method_definition` /
`variable_declarator`-of-an-arrow-function node, and `end_line >= start_line`.
Nothing is re-parsed to get this. `tree_sitter_tags::Tag` already carries two
ranges — `name_range`, the identifier, and `range`, the byte range of the node
the pattern's `@definition.*` capture sat on — and in every tags query used
here (upstream Python, upstream TypeScript, and the `--fork-ts-tags` fork) that
capture *is* the definition node. A per-file table of line-start offsets — one
linear scan over the bytes, orders of magnitude cheaper than the parse it rides
along with — turns those offsets into lines and columns. A trailing newline inside a node's range
(Python `block` nodes usually have one) does not extend `end_line`.

**Reference rows keep the name range**, so `start_line == end_line` for them: a
call site is a point, not a body.

`start_col` is the **indentation** of the definition's first line, the column of
that line's first non-whitespace byte, not the captured node's own column. The
node is not always the first thing on its line: `export class Foo` captures
`class_declaration`, which begins at `class`, and `const f = () => {}` captures
`variable_declarator`, which begins at `f`. Indentation is what a renderer
wants, and it is never to the right of the node.

`parent_id` is the innermost definition whose span **strictly contains** this
one — a method's class, a nested function's function — computed in one sorted
stack pass per file over the definitions already extracted, so it costs nothing
beyond the pass itself. It is always a symbol in the same file, `NULL` at top
level and on every reference. Two patterns matching the exact same node (an
arrow function is both a declarator and a value) are twins, not parent and
child; the pass skips over them.

Two known gaps, both grammar-level rather than span-level:

- Python's upstream `tags.scm` emits `function` for methods (there is no class
  context in the pattern), so `parent_id` pointing at a `class` row is what
  identifies a method in a Python file.
- A definition whose tags pattern captures only the *name* would fall back to
  the name range. None of the three queries in use does this; if a future
  `tags.scm` fork adds such a pattern, its rows would silently go back to
  `end_line == start_line`.

## Versions used

| crate | version | note |
| --- | --- | --- |
| `tree-sitter` | =0.27.0 | latest, MSRV 1.90 |
| `tree-sitter-tags` | =0.27.0 | lockstep with core |
| `tree-sitter-python` | =0.25.0 | newest published; grammar repo lags core |
| `tree-sitter-typescript` | =0.23.2 | newest published; lags core by 4 minors |
| `ignore` | =0.4.33 | |
| `notify` | =8.2.0 | latest stable (9.0.0 is still `-rc.5`) |
| `blake3` | =1.8.7 | |
| `rusqlite` | =0.40.2 | `bundled` |
| `crossbeam-channel` | =0.5.15 | walk collection + watcher events |
| `libc` | =0.2.189 | `getrusage` only |

All versions pinned exactly (`=x.y.z`). The old grammar crates link cleanly
against core 0.27 because both go through `tree-sitter-language` 0.1, so the
lag the research doc flagged did **not** bite at the ABI level — only at query
quality (below).

## Results

Apple M3, 8 cores, 16 GiB, macOS 26.6.2. Release build. Cold = empty database.
Warm = immediate second run, nothing changed. Single-file = one file's stored
hash invalidated so exactly one file reparses (this keeps the test repositories
read-only; it exercises the same code path as a real edit).

Upstream `tags.scm`, unmodified:

| repo | files | MiB | symbols (def / ref) | imports | unresolved | cold | warm | 1 file | peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ts-mono (microsoft/TypeScript) | 65 938 | 185 | 46 615 / 72 201 | 18 497 | 97.3% | **11.6 s** | 9.3 s | 9.1 s | **166 MiB** |
| repo B, Python (incl. committed `venv/`) | 52 071 | 758 | 515 548 / 2 201 228 | 202 259 | 82.7% | **30.8 s** | 12.4 s | 11.0 s | **479 MiB** |
| repo A, TypeScript | 8 605 | 52 | 1 972 / 20 327 | 35 108 | 71.3% | 2.9 s | 1.3 s | 1.3 s | 70 MiB |
| repo C, mixed | 3 977 | 65 | 191 / 795 | 100 | 100% | 0.7 s | 0.6 s | 0.6 s | 38 MiB |
| repo B (`--exclude venv`) | 1 397 | 17 | 7 809 / 33 908 | 6 164 | 48.4% | 0.6 s | 0.08 s | 0.09 s | 42 MiB |

With `--fork-ts-tags` (the two TypeScript repos):

| repo | files | symbols (def / ref) | cold | warm | 1 file | peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| ts-mono | 65 938 | 168 091 / 209 957 | **10.7 s** | 9.0 s | 9.5 s | **214 MiB** |
| repo A, TypeScript | 8 605 | 18 404 / 278 456 | 4.1 s | 1.3 s | 1.3 s | 97 MiB |

Watch mode, `ts-mono` (65 938 known files, 1s debounce, forked TS tags off):

| event | symbols found | update time |
| --- | --- | --- |
| 8 KiB `.ts` edited | 22 | **7.8 ms** |
| 540 KiB `.ts` edited (`parser.ts`) | 805 | **100.4 ms** |
| new 10-line `.py` file | 7 | **2.0 ms** |
| 30 appends to a 488 KiB `.ts` in a tight loop | 4 195 | **94.5 ms, one reparse** |

Watcher steady-state RSS: 62 MiB (it holds 66k path→hash pairs). The 30-edit
burst is the case the research doc called Wake's normal case; the 1s debounce
collapsed it into a single reparse, as intended.

repo C is not a Python/TS repository (23 `.py` files out of 3 977) and is here
only as a walk/hash datapoint.

## Verdict against the Spike 5 pass criteria

| criterion | result |
| --- | --- |
| 50k files under 4 min cold | **PASS by ~20x.** 65 938 files in 11.6 s; 52 071 files with 758 MiB of content and 2.7 M symbols in 30.8 s. |
| single-file update under 0.5 s | **PASS.** 2–8 ms typical, 100 ms worst case measured (a 540 KiB single file). |
| peak memory under 1 GB | **PASS.** 166–214 MiB on the 66k repo; 479 MiB worst case, and that peak is the in-memory *facts* buffer (2.7 M symbol rows), not parse trees. Chunked flushing would cap it. |
| grammar quality | **CONDITIONAL FAIL for TypeScript.** See below. tags.scm forks *are* needed before M0, for TS/JS only. |

Overall: the cheap tier is far cheaper than the budget assumed. The binding
constraint on this spike is query quality, not speed or memory.

### Where the time actually goes

- Cold: parse dominates (`hash+parse` is 85–95% of wall time), and it is fully
  parallel across 8 cores (73 s user / 31 s wall on repo B).
- Warm no-change: **bound by per-file `open`+`read`, not by hashing or
  parsing.** A full rescan costs a flat ~0.14 ms/file on APFS with a cold page
  cache, so 66k files re-verify in ~9 s no matter what changed. This is why the
  Merkle full-rescan number and the watch number differ by two orders of
  magnitude. The obvious fix, deliberately left out of the spike: an
  (mtime, size) pre-filter so unchanged files are never read, with the content
  hash still the arbiter for candidates. The full rescan then becomes the
  "verify after a checkout jump" path rather than the steady-state path.
- Merkle rollup and the SQLite flush are noise (0.5–0.8 s on 66k files) once
  the flush only touches changed rows. An earlier version re-pruned the whole
  database every run and cost 9 s per warm run on repo B; incremental
  upsert-and-diff is what makes warm runs cheap.

## Grammar and query problems

### tree-sitter-typescript's `tags.scm` is close to unusable

The whole file is 8 patterns, and it covers only *TypeScript-specific*
declaration forms. It does **not** include the JavaScript patterns, so on real
TypeScript the following are all invisible:

| construct | upstream | forked |
| --- | --- | --- |
| `class Foo {}` (`class_declaration`) | 50 (abstract classes only) | 485 |
| `function foo() {}`, `const f = () => {}` | 14 (`function_signature` only) | 10 501 |
| `method_definition` in a class body | 231 (`method_signature` only) | 2 506 |
| `enum E {}` | 0 | 246 |
| `type X = ...` (`type_alias_declaration`) | 0 | 2 989 |
| call references (`foo()`, `a.b()`) | **0** | 258 129 |

(counts are repo A, 7 263 TS/TSX files)

Upstream finds 1 972 definitions in 7 263 TypeScript files — 0.27 per file.
The fork finds 18 404, and adds the call-reference edges that the reference
cascade in section 8.6 needs to exist at all. `--fork-ts-tags` in `lang.rs`
(`TS_TAGS_FORK`) is ~15 patterns lifted from the JavaScript grammar's
`tags.scm` plus `enum_declaration` and `type_alias_declaration`. Cost of the
fork: none measurable (10.7 s vs 11.6 s cold on ts-mono, +48 MiB RSS).

**Recommendation: Wake ships its own `tags.scm` for typescript and tsx.** Do
not rely on the grammar's.

### tree-sitter-python's `tags.scm` is fine

Spot-checked against grep over 1 397 files: 5 647 `function` definitions vs
5 647 `^\s*(async )?def ` lines (exact), 1 076 `class` vs 1 078 grep lines (the
2 extras are inside strings). Real gaps, all minor:

- methods are tagged `function`, not `method` — no class context, so
  `Foo.bar` and a module-level `bar` are indistinguishable by kind
- `@definition.module` is never emitted, so a Python package has no module node
- `definition.constant` fires only on *module-level* assignments; class-body
  attributes and dataclass fields are missed
- decorators, `@property`, and `TypedDict`/`Protocol` members are undifferentiated

### Import queries (ours, `lang.rs`)

`tags.scm` captures no imports in any grammar, as the research doc said, so
`PY_IMPORTS` and `TS_IMPORTS` are hand-written. Python: `import x`,
`import x as y`, `from x import y`, `from .x import y`. TS/JS:
`import ... from '...'`, `export ... from '...'`, `require('...')`,
`import x = require('...')`, and dynamic `import('...')`. Resolution is
deliberately shallow — relative specifiers only, no tsconfig `paths`, no
`package.json` `exports`, no `node_modules` walk — and everything else is
stored as a raw module string with `resolved = 0`.

Unresolved imports broken down by shape:

| repo | relative (a real resolution miss) | `@scope/...` | bare + subpath | bare package |
| --- | --- | --- | --- | --- |
| repo A, TypeScript | **3** / 25 040 | 1 717 | 16 588 | 6 732 |
| ts-mono | 10 176 | 286 | 2 817 | 4 724 |
| repo B (no venv) | 0 | 0 | 0 | 2 982 |

Findings:

- **Relative resolution is essentially exact** where the target exists: 3
  misses in 25 040 on repo A, 0 on repo B. The extension/`index.*`/`.js`→`.ts`
  candidate ladder is enough.
- **tsconfig `baseUrl` is the single biggest correctness gap**, exactly as
  section 8.5 predicted. On repo A, the unresolved bare-specifier imports (6 858),
  `shared/...` (3 404) and `e2e-tests/...` (237) specifiers all point at real
  files in the repo; ~11 k of 25 k unresolved imports, about 45%, would resolve
  from `baseUrl` + `paths` alone. That is the first thing to build in M0.
- `ts-mono`'s 10 176 relative misses are genuine: they are compiler test
  fixtures under `tsc/testdata` that import modules which intentionally do not
  exist. Not a resolver bug.
- Python's remaining unresolved are all third-party absolute imports
  (`torch`, `numpy`, …). Resolving those needs a site-packages / interpreter
  path, which is tier-1 work.

## Notes and known limitations

- Every file is hashed (for the Merkle tree) but only `.py/.pyi` and
  `.ts/.mts/.cts/.tsx/.jsx/.js/.mjs/.cjs` are parsed; everything else is
  `lang = 'other'`.
- `.js`/`.jsx`/`.mjs`/`.cjs` use the **tsx** grammar (a superset of JS) rather
  than pulling in a separate `tree-sitter-javascript`.
- Two parses per changed file: `tree-sitter-tags` owns its tree internally and
  does not hand it back, so the import query needs its own parse. Halving this
  needs a local reimplementation of the tags pass. It costs ~30% of parse time
  and was not worth it for a spike.
- The facts for all changed files are held in memory until the single flush.
  That is what puts repo B at 479 MiB. Chunked flushing (every N files) is
  the fix if a repo with tens of millions of symbols shows up.
- `symbols` has no FTS5 index yet (section 8.7 wants one for name search).
- No `petgraph` projection, no PageRank, no reference-edge confidence cascade —
  all out of scope for this spike.
