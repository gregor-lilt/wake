//! SQLite persistence. Built in memory during a run, flushed once.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection};

use crate::FileFacts;

/// Bumped whenever the shape of a table changes. The database is a cache
/// derived entirely from the repository, so a mismatch drops every table and
/// the next run rebuilds from scratch — there is nothing to migrate.
///
/// 1: files/dirs/symbols/imports as first written (implicit, `user_version` 0
///    on databases from before this constant existed).
/// 2: `symbols` gains `id`, real `end_line`, `start_col` and `parent_id`.
pub const SCHEMA_VERSION: i64 = 2;

pub struct Store {
    pub conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        let found: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if found != SCHEMA_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS files;
                 DROP TABLE IF EXISTS dirs;
                 DROP TABLE IF EXISTS symbols;
                 DROP TABLE IF EXISTS imports;",
            )?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files(
                 path TEXT PRIMARY KEY, hash TEXT NOT NULL,
                 size INTEGER NOT NULL, lang TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS dirs(
                 path TEXT PRIMARY KEY, hash TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS symbols(
                 id INTEGER PRIMARY KEY,
                 file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
                 start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
                 start_col INTEGER NOT NULL, parent_id INTEGER);
             CREATE TABLE IF NOT EXISTS imports(
                 from_file TEXT NOT NULL, to_file_or_module TEXT NOT NULL,
                 resolved INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
             CREATE INDEX IF NOT EXISTS imports_file ON imports(from_file);",
        )?;
        Ok(Self { conn })
    }

    pub fn file_hashes(&self) -> rusqlite::Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT path, hash FROM files")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn dir_hashes(&self) -> rusqlite::Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT path, hash FROM dirs")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// One transaction: upsert the changed files' facts, upsert the changed
    /// directory hashes, drop rows for paths that disappeared.
    pub fn flush(
        &mut self,
        facts: &[FileFacts],
        removed_files: &[String],
        changed_dirs: &[(String, String)],
        removed_dirs: &[String],
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut del_sym = tx.prepare("DELETE FROM symbols WHERE file = ?1")?;
            let mut del_imp = tx.prepare("DELETE FROM imports WHERE from_file = ?1")?;
            let mut del_file = tx.prepare("DELETE FROM files WHERE path = ?1")?;
            let mut ins_file = tx.prepare(
                "INSERT INTO files(path, hash, size, lang) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(path) DO UPDATE SET hash=?2, size=?3, lang=?4",
            )?;
            let mut ins_sym = tx.prepare(
                "INSERT INTO symbols(file, name, kind, start_line, end_line, start_col)
                 VALUES (?1,?2,?3,?4,?5,?6)",
            )?;
            let mut set_parent = tx.prepare("UPDATE symbols SET parent_id=?2 WHERE id=?1")?;
            let mut ins_imp = tx.prepare(
                "INSERT INTO imports(from_file, to_file_or_module, resolved)
                 VALUES (?1,?2,?3)",
            )?;
            for f in facts {
                del_sym.execute([&f.path])?;
                del_imp.execute([&f.path])?;
                ins_file.execute(params![f.path, f.hash, f.size, f.lang])?;
                // Two passes: the parent's row id only exists once it is in.
                // `ids` is indexed exactly like `f.symbols`, which is what
                // `Symbol::parent` points into.
                let mut ids: Vec<i64> = Vec::with_capacity(f.symbols.len());
                for s in &f.symbols {
                    ins_sym.execute(params![
                        f.path,
                        s.name,
                        s.kind,
                        s.start_line,
                        s.end_line,
                        s.start_col
                    ])?;
                    ids.push(tx.last_insert_rowid());
                }
                for (i, s) in f.symbols.iter().enumerate() {
                    if let Some(p) = s.parent {
                        set_parent.execute(params![ids[i], ids[p as usize]])?;
                    }
                }
                for (target, resolved) in &f.imports {
                    ins_imp.execute(params![f.path, target, *resolved as i32])?;
                }
            }
            for p in removed_files {
                del_sym.execute([p])?;
                del_imp.execute([p])?;
                del_file.execute([p])?;
            }
            let mut ins_dir = tx.prepare(
                "INSERT INTO dirs(path, hash) VALUES (?1,?2)
                 ON CONFLICT(path) DO UPDATE SET hash=?2",
            )?;
            for (p, h) in changed_dirs {
                ins_dir.execute(params![p, h])?;
            }
            let mut del_dir = tx.prepare("DELETE FROM dirs WHERE path = ?1")?;
            for p in removed_dirs {
                del_dir.execute([p])?;
            }
        }
        tx.commit()
    }

    /// (definitions whose span is more than one line, definitions with a
    /// parent). Both are definitions only; references never have either.
    pub fn span_counts(&self) -> rusqlite::Result<(i64, i64)> {
        let q = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0));
        Ok((
            q("SELECT COUNT(*) FROM symbols
               WHERE kind NOT LIKE 'ref:%' AND end_line > start_line")?,
            q("SELECT COUNT(*) FROM symbols
               WHERE kind NOT LIKE 'ref:%' AND parent_id IS NOT NULL")?,
        ))
    }

    pub fn counts(&self) -> rusqlite::Result<(i64, i64, i64, i64, i64)> {
        let q = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0));
        Ok((
            q("SELECT COUNT(*) FROM files")?,
            q("SELECT COUNT(*) FROM symbols WHERE kind NOT LIKE 'ref:%'")?,
            q("SELECT COUNT(*) FROM symbols WHERE kind LIKE 'ref:%'")?,
            q("SELECT COUNT(*) FROM imports WHERE resolved = 1")?,
            q("SELECT COUNT(*) FROM imports WHERE resolved = 0")?,
        ))
    }
}
