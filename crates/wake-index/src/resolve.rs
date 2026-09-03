//! Import resolution, spike-grade. No tsconfig `paths`, no package.json
//! `exports`, no node_modules walk. Relative specifiers only; everything else
//! is stored as a raw module string and counted as unresolved.

use std::collections::HashSet;

use crate::lang::Lang;

const TS_EXTS: [&str; 8] = [
    ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json",
];
const TS_INDEX: [&str; 4] = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/// Collapse `.` and `..` segments. Returns None if it escapes the repo root.
fn normalize(parts: &[&str]) -> Option<String> {
    let mut out: Vec<&str> = Vec::with_capacity(parts.len());
    for p in parts {
        match *p {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

pub fn resolve(from: &str, module: &str, lang: Lang, files: &HashSet<String>) -> Option<String> {
    match lang {
        Lang::Python => resolve_python(from, module, files),
        _ => resolve_ts(from, module, files),
    }
}

fn resolve_python(from: &str, module: &str, files: &HashSet<String>) -> Option<String> {
    let dots = module.chars().take_while(|c| *c == '.').count();
    let rest = &module[dots..];
    let base = if dots == 0 {
        String::new() // absolute: try repo root
    } else {
        // `.x` is the current package, `..x` one above, and so on.
        let mut segs: Vec<&str> = parent(from).split('/').filter(|s| !s.is_empty()).collect();
        for _ in 1..dots {
            segs.pop()?;
        }
        segs.join("/")
    };

    let mut segs: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    segs.extend(rest.split('.').filter(|s| !s.is_empty()));
    let joined = normalize(&segs)?;
    if joined.is_empty() {
        return None;
    }
    [
        format!("{joined}.py"),
        format!("{joined}/__init__.py"),
        format!("{joined}.pyi"),
    ]
    .into_iter()
    .find(|c| files.contains(c))
}

fn resolve_ts(from: &str, module: &str, files: &HashSet<String>) -> Option<String> {
    if !module.starts_with('.') {
        return None; // bare specifier: package, or a tsconfig alias we skip
    }
    let mut segs: Vec<&str> = parent(from).split('/').filter(|s| !s.is_empty()).collect();
    segs.extend(module.split('/'));
    let joined = normalize(&segs)?;
    if joined.is_empty() {
        return None;
    }
    if files.contains(&joined) {
        return Some(joined);
    }
    for suffix in TS_EXTS.iter().chain(TS_INDEX.iter()) {
        let cand = format!("{joined}{suffix}");
        if files.contains(&cand) {
            return Some(cand);
        }
    }
    // `./foo.js` in ESM TypeScript usually means `./foo.ts`
    if let Some(stem) = joined.strip_suffix(".js") {
        for suffix in [".ts", ".tsx"] {
            let cand = format!("{stem}{suffix}");
            if files.contains(&cand) {
                return Some(cand);
            }
        }
    }
    None
}
