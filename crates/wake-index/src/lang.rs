//! Language detection, tree-sitter-tags configs and import queries.
//!
//! One parse per query pass; every tree is dropped before the function returns.

use std::path::Path;

use tree_sitter::{Language, Parser, Query, QueryCursor, StreamingIterator};
use tree_sitter_tags::{TagsConfiguration, TagsContext};

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Lang {
    Python,
    /// .ts / .mts / .cts
    TypeScript,
    /// .tsx / .jsx / .js / .mjs / .cjs (the tsx grammar is a superset)
    Tsx,
}

impl Lang {
    pub fn name(self) -> &'static str {
        match self {
            Lang::Python => "python",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
        }
    }

    pub fn detect(path: &Path) -> Option<Lang> {
        match path.extension()?.to_str()? {
            "py" | "pyi" => Some(Lang::Python),
            "ts" | "mts" | "cts" => Some(Lang::TypeScript),
            "tsx" | "jsx" | "js" | "mjs" | "cjs" => Some(Lang::Tsx),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- imports.scm

// tags.scm never captures imports (see docs/research/03, section 2), so these
// are ours. Deliberately shallow: no tsconfig paths, no package.json exports.
const PY_IMPORTS: &str = r#"
(import_statement name: (dotted_name) @mod)
(import_statement name: (aliased_import name: (dotted_name) @mod))
(import_from_statement module_name: (dotted_name) @mod)
(import_from_statement module_name: (relative_import) @mod)
"#;

const TS_IMPORTS: &str = r#"
(import_statement source: (string (string_fragment) @mod))
(export_statement source: (string (string_fragment) @mod))
(import_require_clause source: (string (string_fragment) @mod))
((call_expression
   function: (identifier) @_fn
   arguments: (arguments (string (string_fragment) @mod)))
 (#eq? @_fn "require"))
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @mod)))
"#;

/// Upstream tree-sitter-typescript `tags.scm` only covers TypeScript-specific
/// declaration forms (signatures, abstract classes, interfaces, modules). It
/// does not include the JavaScript patterns, so plain `class`/`function`
/// declarations, methods, `const f = () => {}` and every call reference are
/// invisible. This is the fork the research doc anticipated; `--fork-ts-tags`
/// turns it on so the spike can measure both.
const TS_TAGS_FORK: &str = r#"
(class_declaration name: (type_identifier) @name) @definition.class
(class name: (type_identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(type_alias_declaration name: (type_identifier) @name) @definition.type
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(public_field_definition
  name: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.method
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function
(assignment_expression
  left: [(identifier) @name (member_expression property: (property_identifier) @name)]
  right: [(arrow_function) (function_expression)]) @definition.function
(call_expression function: (identifier) @name) @reference.call
(call_expression
  function: (member_expression property: (property_identifier) @name)) @reference.call
"#;

/// Compiled once per process, shared across worker threads.
pub struct Grammars {
    py_tags: TagsConfiguration,
    ts_tags: TagsConfiguration,
    tsx_tags: TagsConfiguration,
    py_imports: Query,
    ts_imports: Query,
    tsx_imports: Query,
}

impl Grammars {
    pub fn new(fork_ts_tags: bool) -> Result<Self, String> {
        let py: Language = tree_sitter_python::LANGUAGE.into();
        let ts: Language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        let tsx: Language = tree_sitter_typescript::LANGUAGE_TSX.into();

        let tags = |l: &Language, q: &str, locals: &str| {
            TagsConfiguration::new(l.clone(), q, locals).map_err(|e| format!("tags query: {e}"))
        };
        let query =
            |l: &Language, q: &str| Query::new(l, q).map_err(|e| format!("imports query: {e}"));

        let ts_q = if fork_ts_tags {
            format!("{}{TS_TAGS_FORK}", tree_sitter_typescript::TAGS_QUERY)
        } else {
            tree_sitter_typescript::TAGS_QUERY.to_string()
        };

        Ok(Self {
            py_tags: tags(&py, tree_sitter_python::TAGS_QUERY, "")?,
            ts_tags: tags(&ts, &ts_q, "")?,
            tsx_tags: tags(&tsx, &ts_q, "")?,
            py_imports: query(&py, PY_IMPORTS)?,
            ts_imports: query(&ts, TS_IMPORTS)?,
            tsx_imports: query(&tsx, TS_IMPORTS)?,
        })
    }

    fn tags_for(&self, l: Lang) -> &TagsConfiguration {
        match l {
            Lang::Python => &self.py_tags,
            Lang::TypeScript => &self.ts_tags,
            Lang::Tsx => &self.tsx_tags,
        }
    }

    fn imports_for(&self, l: Lang) -> (&Query, Language) {
        match l {
            Lang::Python => (&self.py_imports, tree_sitter_python::LANGUAGE.into()),
            Lang::TypeScript => (
                &self.ts_imports,
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            ),
            Lang::Tsx => (
                &self.tsx_imports,
                tree_sitter_typescript::LANGUAGE_TSX.into(),
            ),
        }
    }
}

// ------------------------------------------------------------------ extractor

#[derive(Debug)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    /// 1-based. For a definition this is the first line of the whole
    /// definition node, not of its name.
    pub start_line: u32,
    /// 1-based, inclusive. Equal to `start_line` only for one-line
    /// definitions and for references (a reference is a name, not a body).
    pub end_line: u32,
    /// 0-based byte column the definition starts at, i.e. its indentation.
    pub start_col: u32,
    /// Index, within the same file's symbol vector, of the innermost
    /// definition whose span strictly contains this one. `None` at top level
    /// and on every reference.
    pub parent: Option<u32>,
}

/// Per-thread scratch. Reuses one parser and one query cursor across files.
pub struct Extractor {
    tags: TagsContext,
    parser: Parser,
    cursor: QueryCursor,
}

impl Extractor {
    pub fn new() -> Self {
        Self {
            tags: TagsContext::new(),
            parser: Parser::new(),
            cursor: QueryCursor::new(),
        }
    }

    /// Definitions and references via tags.scm.
    ///
    /// A `Tag` carries two ranges: `name_range`/`span`, the identifier, and
    /// `range`, the byte range of the node the pattern's `@definition.*` /
    /// `@reference.*` capture sat on. For every definition pattern in every
    /// tags query we use, that capture *is* the definition node
    /// (`function_definition`, `class_definition`, `class_declaration`,
    /// `method_definition`, the `variable_declarator` of an arrow function,
    /// ...), so the full span is already in hand and nothing has to be
    /// re-parsed or walked. References keep the name span: a call site is a
    /// point, not a body.
    pub fn symbols(&mut self, g: &Grammars, lang: Lang, src: &[u8]) -> Vec<Symbol> {
        let cfg = g.tags_for(lang);
        let mut out = Vec::new();
        // `generate_tags` owns the tree internally and drops it with the iterator.
        let Ok((iter, _failed)) = self.tags.generate_tags(cfg, src, None) else {
            return out;
        };
        let lines = line_starts(src);
        // (index into `out`, start byte, end byte) for definitions only.
        let mut defs: Vec<(u32, usize, usize)> = Vec::new();
        for tag in iter.flatten() {
            let Some(name) = src.get(tag.name_range.clone()) else {
                continue;
            };
            let kind = cfg.syntax_type_name(tag.syntax_type_id);
            let is_def = tag.is_definition;
            // `Tag::ignored` sets `range` to usize::MAX..usize::MAX; any other
            // out-of-bounds range would be a grammar bug. Fall back to the name.
            let full = is_def && tag.range.start <= tag.range.end && tag.range.end <= src.len();
            let (start, end) = if full {
                (tag.range.start, tag.range.end)
            } else {
                (tag.name_range.start, tag.name_range.end)
            };
            let (start_row, start_col) = indent_of(&lines, src, start);
            let end_row = end_row_of(&lines, src, start, end);
            if is_def {
                defs.push((out.len() as u32, start, end));
            }
            out.push(Symbol {
                name: String::from_utf8_lossy(name).into_owned(),
                kind: if is_def {
                    kind.to_string()
                } else {
                    format!("ref:{kind}")
                },
                start_line: start_row + 1,
                end_line: end_row + 1,
                start_col,
                parent: None,
            });
        }
        assign_parents(&mut out, &mut defs);
        out
    }

    /// Raw import module strings, in source order.
    pub fn imports(&mut self, g: &Grammars, lang: Lang, src: &[u8]) -> Vec<String> {
        let (query, language) = g.imports_for(lang);
        if self.parser.set_language(&language).is_err() {
            return Vec::new();
        }
        let Some(tree) = self.parser.parse(src, None) else {
            return Vec::new();
        };
        let idx = query.capture_index_for_name("mod").unwrap_or(0);
        let mut out = Vec::new();
        {
            let mut it = self.cursor.matches(query, tree.root_node(), src);
            while let Some(m) = it.next() {
                for c in m.captures().iter().filter(|c| c.index == idx) {
                    if let Ok(t) = c.node.utf8_text(src) {
                        out.push(t.trim_matches(['"', '\'', '`']).to_string());
                    }
                }
            }
        }
        drop(tree); // never retain trees
        out
    }
}

// ------------------------------------------------------------- spans, parents

/// Byte offset of every line start. One linear scan over the file, orders of
/// magnitude cheaper than the parse it rides along with, and it makes both the
/// line and the column of any byte offset a binary search.
fn line_starts(src: &[u8]) -> Vec<u32> {
    let mut v = Vec::with_capacity(src.len() / 32 + 1);
    v.push(0u32);
    for (i, b) in src.iter().enumerate() {
        if *b == b'\n' {
            v.push(i as u32 + 1);
        }
    }
    v
}

fn row_of(lines: &[u32], byte: usize) -> u32 {
    let byte = byte as u32;
    match lines.binary_search(&byte) {
        Ok(i) => i as u32,
        Err(i) => i as u32 - 1, // i >= 1: lines[0] is 0 and byte >= 0
    }
}

/// 0-based (row, indentation column) for the line a byte offset falls on.
///
/// The column is the first non-whitespace byte of that line rather than the
/// captured node's own column, because the node is not always the first thing
/// on its line: `export class Foo` captures `class_declaration`, which starts
/// at `class`, and `const f = () => {}` captures `variable_declarator`, which
/// starts at `f`. Indentation is what a renderer wants, and it is never to the
/// right of the node, so the two agree wherever the definition does start the
/// line.
fn indent_of(lines: &[u32], src: &[u8], byte: usize) -> (u32, u32) {
    let row = row_of(lines, byte);
    let line_start = lines[row as usize] as usize;
    let mut col = line_start;
    while col < byte && matches!(src.get(col), Some(b' ' | b'\t')) {
        col += 1;
    }
    (row, (col - line_start) as u32)
}

/// 0-based row of the last line a `start..end` span actually covers. `end` is
/// exclusive, and a node whose text ends with a newline (a Python `block`
/// often does) must not claim the empty line after it.
fn end_row_of(lines: &[u32], src: &[u8], start: usize, end: usize) -> u32 {
    let mut e = end.min(src.len());
    while e > start + 1 && matches!(src.get(e - 1), Some(b'\n' | b'\r' | b' ' | b'\t')) {
        e -= 1;
    }
    row_of(lines, e.saturating_sub(1).max(start))
}

/// Innermost enclosing definition for every definition, by span containment,
/// in one sorted pass per file (methods get their class, nested functions get
/// their function). `defs` is (index into `out`, start byte, end byte).
fn assign_parents(out: &mut [Symbol], defs: &mut [(u32, usize, usize)]) {
    // Outermost first at the same start; tags arrive in roughly this order
    // already, so the sort is nearly free.
    defs.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)));
    let mut stack: Vec<(u32, usize, usize)> = Vec::new();
    for &(idx, start, end) in defs.iter() {
        while stack
            .last()
            .is_some_and(|&(_, _, top_end)| top_end <= start)
        {
            stack.pop();
        }
        // Strict containment only: two patterns can match the same node (an
        // arrow function is both a declarator and a value), and neither is
        // the other's parent, so such a twin is skipped over.
        for &(top_idx, top_start, top_end) in stack.iter().rev() {
            if (top_start, top_end) != (start, end) {
                out[idx as usize].parent = Some(top_idx);
                break;
            }
        }
        stack.push((idx, start, end));
    }
}
