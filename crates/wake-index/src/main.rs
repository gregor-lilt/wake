//! wake-index: Spike 5, cheap-tier indexing budget.
//!
//!   wake-index index <repo> [--db PATH] [--max-size BYTES] [--exclude GLOB] [--fork-ts-tags]
//!   wake-index watch <repo> [--db PATH] [--max-size BYTES] [--exclude GLOB] [--fork-ts-tags]

mod lang;
mod merkle;
mod resolve;
mod store;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use lang::{Extractor, Grammars, Lang, Symbol};
use store::Store;

const DEFAULT_MAX_SIZE: u64 = 2 * 1024 * 1024;
const BINARY_SNIFF: usize = 8192;

/// What one worker thread produces: facts for changed files, hashes for all
/// files it touched, and its share of the counters.
type Shard = (Vec<FileFacts>, Vec<(String, String)>, Stats);

pub struct FileFacts {
    pub path: String,
    pub hash: String,
    pub size: i64,
    pub lang: String,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<(String, bool)>,
}

#[derive(Default)]
struct Stats {
    changed: usize,
    unchanged: usize,
    skipped_large: usize,
    skipped_binary: usize,
    read_errors: usize,
    parse_bytes: u64,
}

// ------------------------------------------------------------------- plumbing

fn peak_rss_bytes() -> u64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) } != 0 {
        return 0;
    }
    let v = u.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        v
    } else {
        v * 1024
    }
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn db_path_for(repo: &Path, explicit: Option<PathBuf>) -> PathBuf {
    if let Some(p) = explicit {
        return p;
    }
    // never write inside the indexed repository
    let key = repo.to_string_lossy().replace(['/', ' ', '.'], "_");
    let base = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(base)
        .join(".cache/wake-index")
        .join(format!("{key}.sqlite"))
}

/// Phase 1: gitignore-aware parallel walk. Paths and sizes only, no reads.
fn walk(repo: &Path, max_size: u64, exclude: &[String]) -> (Vec<(String, u64)>, usize) {
    let (tx, rx) = crossbeam_channel::unbounded::<(String, u64)>();
    let too_big = Arc::new(AtomicUsize::new(0));
    let repo = repo.to_path_buf();

    let mut ov = ignore::overrides::OverrideBuilder::new(&repo);
    for g in exclude {
        ov.add(&format!("!{g}")).expect("bad --exclude glob");
    }
    let ov = ov.build().expect("bad --exclude glob");

    ignore::WalkBuilder::new(&repo)
        .overrides(ov)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .follow_links(false)
        .threads(std::thread::available_parallelism().map_or(8, |n| n.get()))
        .build_parallel()
        .run(|| {
            let tx = tx.clone();
            let too_big = too_big.clone();
            let repo = repo.clone();
            Box::new(move |res| {
                if let Ok(entry) = res {
                    if entry.file_type().is_some_and(|t| t.is_file()) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        if size > max_size {
                            too_big.fetch_add(1, Ordering::Relaxed);
                        } else if let Ok(rel) = entry.path().strip_prefix(&repo) {
                            let _ = tx.send((rel.to_string_lossy().replace('\\', "/"), size));
                        }
                    }
                }
                ignore::WalkState::Continue
            })
        });
    drop(tx);

    let mut files: Vec<(String, u64)> = rx.into_iter().collect();
    files.sort_unstable();
    (files, too_big.load(Ordering::Relaxed))
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0)
}

/// Phase 2: read + hash + (if changed and a known language) parse.
fn index_files(
    repo: &Path,
    files: &[(String, u64)],
    prev: &HashMap<String, String>,
    grammars: &Grammars,
    path_set: &HashSet<String>,
) -> Shard {
    let cursor = AtomicUsize::new(0);
    let nthreads = std::thread::available_parallelism().map_or(8, |n| n.get());
    let mut parts: Vec<Shard> = Vec::new();

    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..nthreads {
            handles.push(scope.spawn(|| {
                let mut ex = Extractor::new();
                let mut facts = Vec::new();
                let mut hashes = Vec::new();
                let mut st = Stats::default();
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    let i = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((rel, size)) = files.get(i) else {
                        break;
                    };
                    buf.clear();
                    if std::fs::File::open(repo.join(rel))
                        .and_then(|mut f| std::io::Read::read_to_end(&mut f, &mut buf))
                        .is_err()
                    {
                        st.read_errors += 1;
                        continue;
                    }
                    let hash = blake3::hash(&buf).to_hex().to_string();
                    hashes.push((rel.clone(), hash.clone()));
                    if prev.get(rel) == Some(&hash) {
                        st.unchanged += 1;
                        continue;
                    }
                    st.changed += 1;
                    let l = Lang::detect(Path::new(rel));
                    let (mut symbols, mut imports) = (Vec::new(), Vec::new());
                    if let Some(l) = l {
                        if is_binary(&buf) {
                            st.skipped_binary += 1;
                        } else {
                            st.parse_bytes += buf.len() as u64;
                            symbols = ex.symbols(grammars, l, &buf);
                            imports = ex
                                .imports(grammars, l, &buf)
                                .into_iter()
                                .map(|m| match resolve::resolve(rel, &m, l, path_set) {
                                    Some(p) => (p, true),
                                    None => (m, false),
                                })
                                .collect();
                        }
                    }
                    facts.push(FileFacts {
                        path: rel.clone(),
                        hash,
                        size: *size as i64,
                        lang: l.map_or("other", Lang::name).to_string(),
                        symbols,
                        imports,
                    });
                }
                (facts, hashes, st)
            }));
        }
        for h in handles {
            parts.push(h.join().unwrap());
        }
    });

    let mut facts = Vec::new();
    let mut hashes = Vec::new();
    let mut total = Stats::default();
    for (f, h, s) in parts {
        facts.extend(f);
        hashes.extend(h);
        total.changed += s.changed;
        total.unchanged += s.unchanged;
        total.skipped_binary += s.skipped_binary;
        total.read_errors += s.read_errors;
        total.parse_bytes += s.parse_bytes;
    }
    hashes.sort();
    (facts, hashes, total)
}

// ------------------------------------------------------------------ commands

fn cmd_index(
    repo: &Path,
    db: &Path,
    max_size: u64,
    exclude: &[String],
    fork: bool,
) -> Result<(), String> {
    let t0 = Instant::now();
    let grammars = Grammars::new(fork)?;
    let mut store = Store::open(db).map_err(|e| e.to_string())?;
    let prev_files = store.file_hashes().map_err(|e| e.to_string())?;
    let prev_dirs = store.dir_hashes().map_err(|e| e.to_string())?;
    let t_setup = t0.elapsed();

    let (files, skipped_large) = walk(repo, max_size, exclude);
    let t_walk = t0.elapsed();
    let path_set: HashSet<String> = files.iter().map(|(p, _)| p.clone()).collect();

    let (facts, hashes, mut stats) = index_files(repo, &files, &prev_files, &grammars, &path_set);
    stats.skipped_large = skipped_large;
    let t_parse = t0.elapsed();

    let dirs = merkle::rollup(&hashes);
    let root_hash = dirs
        .iter()
        .find(|(p, _)| p.is_empty())
        .map(|(_, h)| h.clone())
        .unwrap_or_default();

    let dir_set: HashSet<&str> = dirs.iter().map(|(p, _)| p.as_str()).collect();
    let changed_dir_rows: Vec<(String, String)> = dirs
        .iter()
        .filter(|(p, h)| prev_dirs.get(p) != Some(h))
        .cloned()
        .collect();
    let removed_dirs: Vec<String> = prev_dirs
        .keys()
        .filter(|p| !dir_set.contains(p.as_str()))
        .cloned()
        .collect();
    let removed_files: Vec<String> = prev_files
        .keys()
        .filter(|p| !path_set.contains(p.as_str()))
        .cloned()
        .collect();
    store
        .flush(&facts, &removed_files, &changed_dir_rows, &removed_dirs)
        .map_err(|e| e.to_string())?;
    let t_flush = t0.elapsed();
    let (n_files, n_defs, n_refs, n_res, n_unres) = store.counts().map_err(|e| e.to_string())?;
    let wall = t0.elapsed();

    let n_imports = n_res + n_unres;
    let unres_pct = if n_imports > 0 {
        100.0 * n_unres as f64 / n_imports as f64
    } else {
        0.0
    };
    println!("repo              {}", repo.display());
    println!(
        "db                {} (schema v{})",
        db.display(),
        store::SCHEMA_VERSION
    );
    println!("files indexed     {n_files}");
    println!(
        "  changed         {}  unchanged {}",
        stats.changed, stats.unchanged
    );
    println!(
        "  skipped         {} too large (>{} MiB), {} binary, {} read errors",
        stats.skipped_large,
        max_size / (1024 * 1024),
        stats.skipped_binary,
        stats.read_errors
    );
    let (n_spans, n_parents) = store.span_counts().map_err(|e| e.to_string())?;
    println!("symbols           {n_defs} definitions, {n_refs} references");
    println!(
        "  spans           {n_spans} definitions span more than one line, {n_parents} have a parent symbol"
    );
    println!(
        "imports           {n_imports} ({n_res} resolved, {n_unres} unresolved = {unres_pct:.1}%)"
    );
    println!(
        "merkle            {} dirs, {} changed subtrees, {} removed, root {}",
        dirs.len(),
        changed_dir_rows.len(),
        removed_dirs.len(),
        &root_hash[..root_hash.len().min(12)]
    );
    println!("parsed bytes      {:.1} MiB", mib(stats.parse_bytes));
    println!(
        "time              {:.2}s total (setup {:.2}s, walk {:.2}s, hash+parse {:.2}s, merkle+flush {:.2}s, count {:.2}s)",
        wall.as_secs_f64(),
        t_setup.as_secs_f64(),
        (t_walk - t_setup).as_secs_f64(),
        (t_parse - t_walk).as_secs_f64(),
        (t_flush - t_parse).as_secs_f64(),
        (wall - t_flush).as_secs_f64()
    );
    println!(
        "peak rss          {:.1} MiB (getrusage)",
        mib(peak_rss_bytes())
    );
    Ok(())
}

fn cmd_watch(repo: &Path, db: &Path, max_size: u64, fork: bool) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};

    let grammars = Grammars::new(fork)?;
    let mut store = Store::open(db).map_err(|e| e.to_string())?;
    let mut hashes = store.file_hashes().map_err(|e| e.to_string())?;
    let path_set: HashSet<String> = hashes.keys().cloned().collect();
    let mut ex = Extractor::new();

    let (tx, rx) = crossbeam_channel::unbounded();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(repo, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    println!(
        "watching {} ({} known files), 1s debounce; ctrl-c to stop",
        repo.display(),
        hashes.len()
    );

    let debounce = Duration::from_millis(1000);
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        // block for the first event, then coalesce for `debounce`
        match rx.recv() {
            Ok(Ok(ev)) => pending.extend(ev.paths),
            Ok(Err(_)) => continue,
            Err(_) => break,
        }
        let deadline = Instant::now() + debounce;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(Ok(ev)) => pending.extend(ev.paths),
                Ok(Err(_)) => {}
                Err(_) => break,
            }
        }

        let batch: Vec<PathBuf> = pending.drain().collect();
        let t_batch = Instant::now();
        let mut updated = 0usize;
        for abs in batch {
            let Ok(rel) = abs.strip_prefix(repo) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.starts_with(".git/") || rel.contains("/.git/") {
                continue;
            }
            let t = Instant::now();
            let meta = std::fs::metadata(&abs);
            if meta.is_err() {
                if hashes.remove(&rel).is_some() {
                    let _ = store
                        .conn
                        .execute("DELETE FROM files WHERE path=?1", [&rel]);
                    let _ = store
                        .conn
                        .execute("DELETE FROM symbols WHERE file=?1", [&rel]);
                    let _ = store
                        .conn
                        .execute("DELETE FROM imports WHERE from_file=?1", [&rel]);
                    println!(
                        "  deleted {rel} in {:.1}ms",
                        t.elapsed().as_secs_f64() * 1e3
                    );
                    updated += 1;
                }
                continue;
            }
            let meta = meta.unwrap();
            if !meta.is_file() || meta.len() > max_size {
                continue;
            }
            let Ok(buf) = std::fs::read(&abs) else {
                continue;
            };
            let hash = blake3::hash(&buf).to_hex().to_string();
            if hashes.get(&rel) == Some(&hash) {
                continue;
            }
            let l = Lang::detect(Path::new(&rel));
            let (mut symbols, mut imports) = (Vec::new(), Vec::new());
            if let Some(l) = l {
                if !is_binary(&buf) {
                    symbols = ex.symbols(&grammars, l, &buf);
                    imports = ex
                        .imports(&grammars, l, &buf)
                        .into_iter()
                        .map(|m| match resolve::resolve(&rel, &m, l, &path_set) {
                            Some(p) => (p, true),
                            None => (m, false),
                        })
                        .collect();
                }
            }
            let n_sym = symbols.len();
            let n_imp = imports.len();
            let facts = vec![FileFacts {
                path: rel.clone(),
                hash: hash.clone(),
                size: meta.len() as i64,
                lang: l.map_or("other", Lang::name).to_string(),
                symbols,
                imports,
            }];
            store
                .flush(&facts, &[], &[], &[])
                .map_err(|e| e.to_string())?;
            hashes.insert(rel.clone(), hash);
            updated += 1;
            println!(
                "  {rel}: {n_sym} symbols, {n_imp} imports in {:.1}ms",
                t.elapsed().as_secs_f64() * 1e3
            );
        }
        if updated > 0 {
            println!(
                "batch of {updated} file(s) in {:.1}ms, peak rss {:.1} MiB",
                t_batch.elapsed().as_secs_f64() * 1e3,
                mib(peak_rss_bytes())
            );
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: wake-index <index|watch> <repo> [--db PATH] [--max-size BYTES] [--exclude GLOB] [--fork-ts-tags]";
    if args.len() < 3 {
        eprintln!("{usage}");
        std::process::exit(2);
    }
    let cmd = args[1].clone();
    let repo = match std::fs::canonicalize(&args[2]) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}: {e}", args[2]);
            std::process::exit(2);
        }
    };
    let mut db = None;
    let mut max_size = DEFAULT_MAX_SIZE;
    let mut exclude: Vec<String> = Vec::new();
    let mut fork = false;
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--db" if i + 1 < args.len() => {
                db = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--fork-ts-tags" => {
                fork = true;
                i += 1;
            }
            "--exclude" if i + 1 < args.len() => {
                exclude.push(args[i + 1].clone());
                i += 2;
            }
            "--max-size" if i + 1 < args.len() => {
                max_size = args[i + 1].parse().unwrap_or(DEFAULT_MAX_SIZE);
                i += 2;
            }
            other => {
                eprintln!("unknown argument {other}\n{usage}");
                std::process::exit(2);
            }
        }
    }
    let db = db_path_for(&repo, db);

    let r = match cmd.as_str() {
        "index" => cmd_index(&repo, &db, max_size, &exclude, fork),
        "watch" => cmd_watch(&repo, &db, max_size, fork),
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
