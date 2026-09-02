# Research: code graph extraction (symbols, imports, references)

Raw research report, 2026-09-02. Produced by a research agent with live API
verification of versions, stars, licenses and last-push dates. Synthesis and
decisions live in ../research-stack.md.

## 1. Headline findings

1. GitHub stack-graphs is dead. Archived 2025-09-09, crates frozen Dec 2024.
   Rule out for v1.
2. SCIP moved to open governance (scip-code org, Jan-Mar 2026). Safer long-term
   bet, but no SCIP indexer supports incremental indexing. All full-repo batch.
3. ast-grep rewrote tree-sitter's core in Rust and deliberately deleted
   incremental reparsing (+29.7% parser throughput). Their reasoning: AI coding
   agent tools operate on complete file snapshots. Implication for Wake:
   sub-second updates come from change detection plus whole-file reparse of the
   changed files, not from ts_tree_edit plumbing.
4. Two open-source projects already ship Wake's cheap tier with numbers:
   colbymchenry/codegraph (69.2k stars, MIT) and DeusData/codebase-memory-mcp
   (41.8k stars, MIT). Both tree-sitter to SQLite with a file watcher, local
   only, MCP-served. Neither ships a map.
5. aider is effectively unmaintained (last commit 2026-05-22). Copy the
   repo-map design (tree-sitter tags plus personalized PageRank plus token
   budget). Do not depend on the code.

## 2. tree-sitter

- Core healthy: v0.27.0 released 2026-08-30, 26.8k stars, MIT.
- `tree-sitter-tags` crate 0.27.0 versions in lockstep with core. Standard
  captures: `@definition.class/function/interface/method/module`,
  `@reference.call/class/implementation`, `@name`, `@doc`.
- `queries/tags.scm` confirmed present for python, typescript, javascript, go,
  java, rust, c-sharp, ruby, php, cpp, c.
- Grammar repos lag core (tree-sitter-python last push 2025-09-15). Pin them.
- tags.scm does NOT capture imports. Wake needs its own imports.scm per
  language. aider forked tags.scm for the same reason.
- Node bindings vs WASM: native `tree-sitter` npm at 0.25.1 (lags core by two
  minors, per-arch native build, ABI rebuilds). `web-tree-sitter` 0.27.0 in
  lockstep, slower. v0.27 added synchronous language loading.
- v0.27 has breaking Rust API changes (child_count u32, query iterator
  lifetimes, allocator redesign). Pin exact versions.
- Memory: a 1.6MB JSON file parses in ~1.2s and two retained trees cost ~300MB.
  Design rule: extract facts from the tree and drop it immediately. Never retain
  trees across files.

## 3. Precise tier options

### SCIP indexers

| Indexer | Basis | Home | Stars | License | Last push | Speed |
|---|---|---|---|---|---|---|
| scip-typescript | TS compiler | sourcegraph | 112 | Apache-2.0 | 2026-09-02 | 1k-5k LOC/s, Sentry 1.2M LOC <12 min |
| scip-python | fork of pyright | sourcegraph | 98 | NOASSERTION | 2026-09-01 | Django 10k LOC in 23s |
| scip-java | javac/bazel/gradle | scip-code | 133 | Apache-2.0 | 2026-09-02 | n/a |
| scip-go | go/packages | scip-code | 69 | Apache-2.0 | 2026-09-01 | n/a |
| scip-rust | rust-analyzer wrapper | scip-code | 11 | Apache-2.0 | 2026-07-02 | n/a |
| rust-analyzer scip CLI | Salsa | rust-lang | 16.8k | Apache-2.0 | 2026-09-02 | full output |
| scip-clang | clang | sourcegraph | 95 | Apache-2.0 | 2026-08-30 | n/a |
| `scip` protobuf crate | | scip-code | 763 | Apache-2.0 | 2026-09-01 | 0.9.0, 2.4M downloads |

Shared: precise, full-repo batch only, no incremental, OOM-prone (READMEs lead
with 8-16GB heap workarounds). scip-python needs an activated venv. Consuming
side is cheap: the `scip` Rust crate reads the protobuf directly, so importing a
CI-generated index is days of work.

### Driving LSP servers directly

- Serena (28.7k stars, MIT) proved the pattern on Microsoft's multilspy (606
  stars, MIT, Python, Rust, Java, Go, JS, Ruby, C#, Dart).
- Memory: gopls 8-10GB steady on large monorepos, up to 60GB pathological.
  rust-analyzer ~2.5GB. jdtls slow startup. pyright: no clean figure found.
- Rust client: `async-lsp` 0.2.4 (2026-04-24). `lsp-types` last updated
  2024-06, `tower-lsp` 2023-08 (server-side anyway). Node: `vscode-jsonrpc`
  9.0.2, `vscode-languageserver-protocol` 3.18.3, both current.
- arXiv 2604.18413 (TypeScript Repository Indexing for Code Agent Retrieval,
  April 2026) abandoned "AST parser plus language server" because LSP needs a
  JSON-RPC call per symbol lookup, went to the TS Compiler API instead. Lesson:
  LSP is fine for "resolve this one symbol the user clicked", not for bulk edge
  resolution.

## 4. The 2025-2026 AI-agent code graph wave

| Tool | Stars | License | Last push | Extraction | Store | Speed / incremental |
|---|---|---|---|---|---|---|
| colbymchenry/codegraph | 69,214 | MIT | 2026-08-31 | Rust kernel, tree-sitter grammars compiled in, 20 native + 33 langs | SQLite + FTS5 | Swift compiler 27k files ~100s. Linux kernel 70k files <12 min on 2-core VPS. Single-file edit 0.3-0.4s. Watcher + 2s debounce, staleness banners |
| DeusData/codebase-memory-mcp | 41,807 | MIT | 2026-09-01 | tree-sitter 162 langs + hybrid LSP for 12, single static C binary | in-memory SQLite, WAL, zstd | Django ~6s. Linux kernel 75k files ~3 min (~155k LOC/s). Incremental ~1.2s. Cypher traversal <1ms |
| GitNexus | 46,873 | PolyForm NC | 2026-09-01 | tree-sitter WASM + KuzuDB WASM, browser-only | KuzuDB WASM | full re-index |
| Serena | 28,737 | MIT | 2026-09-01 | LSP over MCP | live LSP | no index |
| CodeGraphContext | 4,149 | MIT | 2026-08-26 | pluggable graph DB | | re-index |
| code-graph-rag | 4,918 | MIT | 2026-09-02 | tree-sitter | graph DB | re-index |
| potpie | 5,709 | Apache-2.0 | 2026-09-02 | | | |
| Nuanced | 128 | MIT | ARCHIVED 2025-06 | Python call graphs | | dead |
| kodit | 123 | Apache-2.0 | 2026-08-03 | | | |
| aider | 48,665 | Apache-2.0 | 2026-05-22 stale | tree-sitter tags + PageRank | in-memory | design reference |
| Cursor | closed | | | Merkle tree of SHA-256 hashes, AST chunking, embeddings, Turbopuffer | remote | Merkle diff |
| Augment | closed | | | dep graph + history + embeddings | | real-time |
| Greptile | closed | | | semantic code graph | | continuous |
| Claude Code | closed | | | grep, no index | none | n/a |

Most reusable artifact: arXiv 2603.27277 (Codebase-Memory) publishes a
call-resolution cascade with confidence weights:

1. Import-map lookup, 0.95
2. Import-map suffix match, 0.85
3. Same-module prefix, 0.90
4. Unique name project-wide, 0.75
5. Suffix + import-distance scoring, 0.55
6. Fuzzy string similarity, 0.30-0.40

Strategies 1-3 resolve ~80% of calls in well-structured codebases. Limitations:
macros invisible to tree-sitter (C quality 0.58 vs 1.00), no runtime dispatch.
Emitting a confidence score per edge is the single most important design idea
from this wave.

## 5. Lighter tools and heavyweights

| Tool | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| ast-grep | 15,726 | MIT | 2026-09-02 | Query engine, not indexer (dropped incremental reparse) |
| universal-ctags | 7,273 | GPL-2.0 | 2026-09-01 | Fastest symbol extraction: Linux kernel 65k files / 37.1M lines in 66s. JSON Lines output. Subprocess only, never link |
| Semgrep | 16,469 | LGPL-2.1 | 2026-09-01 | Rule engine, wrong shape |
| srcML | 159 | GPL-3.0 | 2026-08-31 | No |
| Joern | 3,466 | Apache-2.0 | 2026-09-02 | JVM CPG, security-oriented, no |
| CodeQL | | NOASSERTION | 2026-08-26 | Licensing blocker for private repos. Rule out |
| Glean (Meta) | 1,397 | NOASSERTION | 2026-09-02 | Server-scale, no |
| Kythe (Google) | 2,150 | Apache-2.0 | 2026-07-16 | Bazel build integration, no |
| Sourcetrail | 16,487 | GPL-3.0 | ARCHIVED 2021-12 | Mine UI ideas only |
| Emerge | 1,140 | MIT | 2026-08-07 | Reference for cheap-tier scope |
| dependency-cruiser | 7,128 | MIT | 2026-08-29 | Best JS/TS import graph, resolves tsconfig paths and aliases. Study for TS module resolution |
| madge | 10,164 | MIT | 2026-01-21 | JS only, quiet |
| pydeps | 2,109 | BSD-2 | 2026-09-01 | module-level only |
| import-linter | 1,152 | BSD-2 | 2026-08-28 | contract checker |
| zoekt | 1,858 | Apache-2.0 | 2026-08-27 | trigram search, complements |

## 6. Git integration and file watching

- Hunks to symbols: `git diff -U0` for exact line ranges, intersect with symbol
  byte spans Wake already stores. No structural differ needed.
- difftastic (25.9k, MIT) and diffsitter (2.4k, MIT) are references for the
  mapping, too heavy to embed. GumTree is LGPL and JVM, no.
- Change detection: copy Cursor's public mechanism. Content hash per file
  (blake3), rolled up per directory into a Merkle tree, walk only divergent
  branches. codegraph and codebase-memory both converged on hash plus watcher.
- Watchers: Rust `notify` 9.0.0-rc.5 (147M downloads, check license field),
  `ignore` crate (166M downloads, parallel gitignore-aware walker, the right
  initial-scan walker). Node: `@parcel/watcher` (C++), chokidar (polling
  fallbacks expensive at 50k files). watchman overkill.
- Debounce is not optional. codegraph defaults to 2s and shows staleness
  banners. An agent editing 30 files in 4 seconds is Wake's normal case.
- Git libs: `gix` 0.87.1 (pure Rust, faster) or `git2` 0.21.0 (more complete).

## 7. Rust vs Node for the indexer

Recommendation: Rust core, napi-rs to the JS UI.

- Both 40k-plus-star prior-art projects chose compiled native cores.
- `tree-sitter-tags` exists in Rust in lockstep with core, no Node equivalent.
- `ignore`, `notify`, `petgraph` (489M downloads), `rusqlite`, `gix`, `scip`,
  `async-lsp` map 1:1 onto Wake's needs.
- npm native binding lag (0.25.1 vs 0.27.0) is exactly the risk a Rust core
  avoids.
- napi-rs (7.9k stars) packaging: per-platform native packages plus a
  wasm32-wasip1-threads fallback, loader tries native first. WASI is not
  equivalent to native, treat strictly as fallback. Browser build would need
  SharedArrayBuffer and cross-origin isolation, do not promise it.

## 8. Recommended two-tier architecture

### Tier 0: cheap syntactic, always on

Budget calibrated against prior art: 50k files in 2-4 min cold, 0.3-0.5s per
changed file warm.

1. Walk with `ignore` (gitignore-aware, parallel).
2. Hash every file with blake3, roll up into a per-directory Merkle tree,
   persist. Change-detection substrate for watcher events and checkout jumps.
3. Parse with tree-sitter 0.27.x, pinned grammars. One parse per file, extract
   and drop the tree. No ts_tree_edit.
4. Symbols via `tree-sitter-tags`, standard capture vocabulary. Fork tags.scm
   per language where thin.
5. Imports via hand-written imports.scm per language. Net-new work. Study
   dependency-cruiser for TS path-alias and tsconfig resolution, the largest
   correctness trap.
6. Reference edges via the Codebase-Memory 6-strategy cascade, confidence
   score on every edge.
7. Store in SQLite via `rusqlite`, WAL mode, FTS5 for name search. Build in
   memory during cold index, flush once. Keep a `petgraph` projection in memory
   for PageRank ranking.
8. Watch with `notify`, debounce 1-2s, expose staleness to the UI.

Language order: Python and TS/JS first, then Go, Java, Rust.

### Tier 1: precise semantic, lazy, per-symbol

Triggered only by explicit user action.

- One LSP server per language, spawned on first use, killed after idle timeout.
  `async-lsp` from Rust. textDocument/references, callHierarchy/*,
  documentSymbol, workspace/symbol.
- Hard memory caps and explicit opt-in for gopls and rust-analyzer.
- Use the cheap tier to narrow the query first. LSP confirms candidates.
- Write confirmed results back as confidence-1.0 edges, invalidated by file
  hash. The precise tier is a cache warmer, not a separate system.

### Tier 2 (optional): SCIP import

"Point Wake at a SCIP index" button via the `scip` crate. Batch enrichment for
teams that already run scip-java or scip-go in CI.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Two MIT projects at 69k and 42k stars already do the cheap tier | Highest, product risk | Wake's differentiator is the live map and the agent feedback loop, not extraction |
| tags.scm quality varies, no imports | High | Fork and maintain per-language queries |
| TS/JS module resolution (tsconfig paths, aliases, workspaces, barrels) | High | Steal dependency-cruiser's rules |
| tree-sitter 0.27 breaking Rust API | Medium | Pin exact versions |
| Node native binding lag | Medium | Rust core plus napi-rs |
| Parse-tree memory | Medium | Extract-and-drop, size threshold |
| LSP memory blowup | Medium | Lazy spawn, idle kill, hard cap, opt-in |
| GPL/AGPL contamination | Medium | ctags and srcML subprocess only. GitNexus is PolyForm NC, do not read its code |
| stack-graphs, tree-sitter-graph | Fatal | Excluded |
| CodeQL | Fatal | Excluded |
| Macros, codegen, reflection | Inherent | Per-language confidence, do not overclaim |

## 10. Sources

- https://github.com/github/stack-graphs (archived 2025-09-09)
- https://github.blog/open-source/introducing-stack-graphs/
- https://github.com/tree-sitter/tree-sitter
- https://github.com/tree-sitter/tree-sitter/releases/tag/v0.27.0
- https://tree-sitter.github.io/tree-sitter/4-code-navigation.html
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md
- https://github.com/tree-sitter/tree-sitter/issues/222 and /issues/1277
- https://crates.io/crates/tree-sitter-tags
- https://crates.io/crates/tree-sitter-graph
- https://crates.io/crates/stack-graphs
- https://www.npmjs.com/package/web-tree-sitter
- https://pypi.org/project/tree-sitter-language-pack/
- https://scip-code.org/ and https://scip-code.org/governance.html
- https://github.com/scip-code/scip
- https://github.com/sourcegraph/scip-typescript
- https://github.com/sourcegraph/scip-python
- https://sourcegraph.com/blog/announcing-scip-typescript
- https://sourcegraph.com/blog/scip-python
- https://rust-lang.github.io/rust-analyzer/rust_analyzer/cli/scip/index.html
- https://ast-grep.github.io/blog/tree-sitter-rust-rewrite
- https://ast-grep.github.io/blog/typed-napi.html
- https://github.com/ast-grep/ast-grep
- https://github.com/colbymchenry/codegraph
- https://github.com/DeusData/codebase-memory-mcp
- https://arxiv.org/abs/2603.27277 (Codebase-Memory)
- https://arxiv.org/abs/2604.18413 (TypeScript Repository Indexing for Code Agent Retrieval)
- https://github.com/abhigyanpatwari/GitNexus
- https://rywalker.com/research/code-intelligence-tools
- https://github.com/oraios/serena
- https://github.com/microsoft/multilspy
- https://aider.chat/2023/10/22/repomap.html
- https://github.com/Aider-AI/aider
- https://cursor.com/blog/secure-codebase-indexing
- https://docs.augmentcode.com/context-services/mcp/overview
- https://napi.rs/docs/concepts/webassembly
- https://github.com/napi-rs/napi-rs
- https://docs.ctags.io/en/latest/man/ctags-json-output.5.html
- https://github.com/universal-ctags/ctags
- https://github.com/Wilfred/difftastic
- https://github.com/afnanenayet/diffsitter
- https://github.com/GumTreeDiff/gumtree
- https://git-scm.com/docs/diff-context-options
- https://github.com/notify-rs/notify, https://crates.io/crates/ignore, https://crates.io/crates/petgraph, https://crates.io/crates/gix, https://crates.io/crates/async-lsp, https://crates.io/crates/scip
- https://github.com/parcel-bundler/watcher, https://github.com/paulmillr/chokidar, https://github.com/facebook/watchman
- https://github.com/sverweij/dependency-cruiser, https://github.com/pahen/madge, https://github.com/thebjorn/pydeps, https://github.com/seddonym/import-linter
- https://github.com/joernio/joern, https://github.com/semgrep/semgrep, https://github.com/srcML/srcML
- https://github.com/facebookincubator/Glean, https://github.com/kythe/kythe
- https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/about-the-codeql-cli
- https://github.com/CoatiSoftware/Sourcetrail, https://github.com/glato/emerge
- https://github.com/nuanced-dev/nuanced-py
- https://github.com/golang/go/issues/37670 (gopls memory)
- https://users.rust-lang.org/t/rust-analyzer-ram-consumption/50420
