//! Per-directory Merkle rollup over file content hashes.
//!
//! dir_hash = blake3(name \0 child_hash \n ... ) over entries sorted by name.
//! Persisted so a later run can tell which subtrees moved without reparsing.

use std::collections::BTreeMap;

/// Input: (repo-relative file path with `/`, file content hash).
/// Output: (directory path, directory hash); the repo root is `""`.
pub fn rollup(files: &[(String, String)]) -> Vec<(String, String)> {
    // dir -> (child name -> hash)
    let mut entries: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    entries.insert(String::new(), BTreeMap::new());

    for (path, hash) in files {
        let (dir, name) = match path.rfind('/') {
            Some(i) => (&path[..i], &path[i + 1..]),
            None => ("", path.as_str()),
        };
        entries
            .entry(dir.to_string())
            .or_default()
            .insert(name.to_string(), hash.clone());
        // make sure every ancestor directory exists as a node
        let mut cur = dir;
        while !cur.is_empty() {
            let p = match cur.rfind('/') {
                Some(i) => &cur[..i],
                None => "",
            };
            entries.entry(p.to_string()).or_default();
            entries.entry(cur.to_string()).or_default();
            cur = p;
        }
    }

    // deepest first, so a directory's children are final before it is hashed
    let mut dirs: Vec<String> = entries.keys().cloned().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count() + usize::from(!d.is_empty())));

    let mut out = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let mut h = blake3::Hasher::new();
        for (name, hash) in entries.get(&dir).map(|m| m.iter()).into_iter().flatten() {
            h.update(name.as_bytes());
            h.update(b"\0");
            h.update(hash.as_bytes());
            h.update(b"\n");
        }
        let dir_hash = h.finalize().to_hex().to_string();
        if !dir.is_empty() {
            let (p, name) = match dir.rfind('/') {
                Some(i) => (dir[..i].to_string(), dir[i + 1..].to_string()),
                None => (String::new(), dir.clone()),
            };
            entries.entry(p).or_default().insert(name, dir_hash.clone());
        }
        out.push((dir, dir_hash));
    }
    out
}
