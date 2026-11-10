//! `grep_files` (mirrors `src/core/grep.ts`): ripgrep when available, a
//! loop-aware walker otherwise.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths;

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "dist",
    "out",
    ".cursor",
    ".vscode-test",
    "bin",
    "obj",
    ".next",
    "coverage",
];

const BINARY_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mov", ".avi", ".zip", ".7z",
    ".rar", ".gz", ".exe", ".dll", ".so", ".dylib", ".wasm", ".pdf", ".woff", ".woff2", ".ttf",
    ".eot", ".class", ".pdb", ".bin",
];

#[derive(Debug, Clone)]
pub struct GrepHit {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug)]
pub struct GrepResult {
    pub ok: bool,
    pub engine: &'static str,
    pub pattern: String,
    pub path: String,
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub error: Option<String>,
}

impl GrepResult {
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "engine": self.engine,
            "pattern": self.pattern,
            "path": self.path,
            "hits": self.hits.iter().map(|hit| json!({
                "file": hit.file,
                "line": hit.line,
                "text": hit.text,
            })).collect::<Vec<_>>(),
            "truncated": self.truncated,
            "error": self.error,
        })
    }

    pub fn format(&self) -> String {
        if !self.ok {
            return format!(
                "grep failed ({}): {}",
                self.engine,
                self.error.as_deref().unwrap_or("unknown error")
            );
        }
        if self.hits.is_empty() {
            return format!(
                "No matches for /{}/ under {} ({})",
                self.pattern, self.path, self.engine
            );
        }
        let mut text = self
            .hits
            .iter()
            .map(|hit| format!("{}:{}:{}", hit.file, hit.line, hit.text))
            .collect::<Vec<_>>()
            .join("\n");
        if text.chars().count() > crate::terminal::OUTPUT_CHAR_CAP {
            text = text
                .chars()
                .take(crate::terminal::OUTPUT_CHAR_CAP)
                .collect::<String>()
                + "\n…truncated";
        }
        if self.truncated {
            text.push_str("\n…max matches reached");
        }
        text
    }
}

fn has_ripgrep() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        dir.join(if cfg!(windows) { "rg.exe" } else { "rg" })
            .is_file()
    })
}

fn relative(root: &Path, path: &Path) -> String {
    paths::relative_to_root(&root.to_string_lossy(), path)
}

fn glob_to_regex(glob: &str) -> Option<regex::Regex> {
    let trimmed = glob.trim();
    if trimmed.is_empty() || trimmed == "**/*" || trimmed == "*" {
        return None;
    }
    let mut out = String::from("^");
    let mut chars = trimmed.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    out.push_str(".*");
                } else {
                    out.push_str("[^/\\\\]*");
                }
            }
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '[' | ']' | '\\' | '|' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out.push('$');
    regex::RegexBuilder::new(&out)
        .case_insensitive(true)
        .build()
        .ok()
}

fn grep_with_rg(
    pattern: &str,
    search_path: &Path,
    glob: Option<&str>,
    max_matches: usize,
    root: &Path,
) -> GrepResult {
    let mut command = Command::new("rg");
    command.args([
        "--json",
        "-n",
        "--follow",
        "--max-count",
        &max_matches.to_string(),
        "--hidden",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
    ]);
    if let Some(glob) = glob {
        command.arg("--glob").arg(glob);
    }
    command
        .arg("--")
        .arg(pattern)
        .arg(search_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(mut child) = command.spawn() else {
        return GrepResult {
            ok: false,
            engine: "rg",
            pattern: pattern.to_string(),
            path: relative(root, search_path),
            hits: Vec::new(),
            truncated: false,
            error: Some("failed to spawn rg".to_string()),
        };
    };
    let mut hits = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if event.get("type").and_then(Value::as_str) != Some("match") {
                continue;
            }
            let Some(data) = event.get("data") else {
                continue;
            };
            let file_abs = data
                .get("path")
                .and_then(|path| path.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            hits.push(GrepHit {
                file: relative(root, Path::new(file_abs)),
                line: data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize,
                text: data
                    .get("lines")
                    .and_then(|lines| lines.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string(),
            });
            if hits.len() >= max_matches {
                break;
            }
        }
    }
    let mut stderr = String::new();
    if let Some(pipe) = child.stderr.take() {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            stderr.push_str(&line);
            stderr.push('\n');
        }
    }
    let _ = child.wait();
    GrepResult {
        ok: true,
        engine: "rg",
        pattern: pattern.to_string(),
        path: relative(root, search_path),
        truncated: hits.len() >= max_matches,
        hits,
        error: if stderr.trim().is_empty() {
            None
        } else {
            Some(stderr.trim().to_string())
        },
    }
}

fn real_key(path: &Path) -> String {
    std::fs::canonicalize(path)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

#[allow(clippy::too_many_arguments)]
fn grep_with_walker(
    pattern: &str,
    search_path: &Path,
    glob: Option<&str>,
    max_matches: usize,
    root: &Path,
) -> GrepResult {
    let regex = regex::Regex::new(pattern)
        .unwrap_or_else(|_| regex::Regex::new(&regex::escape(pattern)).expect("escaped pattern"));
    let glob_regex = glob.and_then(glob_to_regex);
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(real_key(search_path));

    fn walk(
        dir: &Path,
        root: &Path,
        regex: &regex::Regex,
        glob_regex: Option<&regex::Regex>,
        max_matches: usize,
        hits: &mut Vec<GrepHit>,
        seen: &mut HashSet<String>,
    ) {
        if hits.len() >= max_matches {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if hits.len() >= max_matches {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let abs: PathBuf = entry.path();
            let Ok(meta) = std::fs::metadata(&abs) else {
                continue;
            };
            if meta.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let key = real_key(&abs);
                if !seen.insert(key) {
                    continue;
                }
                walk(&abs, root, regex, glob_regex, max_matches, hits, seen);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let ext = abs
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{}", value.to_ascii_lowercase()))
                .unwrap_or_default();
            if BINARY_EXT.contains(&ext.as_str()) {
                continue;
            }
            let rel = relative(root, &abs);
            if let Some(glob_regex) = glob_regex {
                if !glob_regex.is_match(&rel) && !glob_regex.is_match(&name) {
                    continue;
                }
            }
            if meta.len() > 1_000_000 {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&abs) else {
                continue;
            };
            if content.contains('\0') {
                continue;
            }
            for (index, line) in content.lines().enumerate() {
                if !regex.is_match(line) {
                    continue;
                }
                hits.push(GrepHit {
                    file: rel.clone(),
                    line: index + 1,
                    text: line.chars().take(400).collect(),
                });
                if hits.len() >= max_matches {
                    return;
                }
            }
        }
    }

    walk(
        search_path,
        root,
        &regex,
        glob_regex.as_ref(),
        max_matches,
        &mut hits,
        &mut seen,
    );
    GrepResult {
        ok: true,
        engine: "node",
        pattern: pattern.to_string(),
        path: relative(root, search_path),
        truncated: hits.len() >= max_matches,
        hits,
        error: None,
    }
}

pub fn grep_files(
    pattern: &str,
    path: Option<&str>,
    glob: Option<&str>,
    max_matches: Option<f64>,
    root: &Path,
) -> Result<GrepResult, String> {
    if pattern.is_empty() {
        return Err("pattern is required".to_string());
    }
    let search_path =
        paths::resolve_workdir(&root.to_string_lossy(), path).map_err(|error| error.message)?;
    let mut limit = max_matches
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor() as i64)
        .unwrap_or(50);
    limit = limit.clamp(1, 200);
    let max = limit as usize;

    if has_ripgrep() {
        return Ok(grep_with_rg(pattern, &search_path, glob, max, root));
    }
    Ok(grep_with_walker(pattern, &search_path, glob, max, root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walker_finds_matches_and_skips_git() {
        let dir = std::env::temp_dir().join(format!("kp-grep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello world\n").unwrap();
        std::fs::write(dir.join(".git").join("config"), b"hello world\n").unwrap();
        // Node applies SKIP_DIRS only in its walker; ripgrep may still report
        // VCS internals, so this asserts the walker branch explicitly.
        let result = grep_with_walker("hello", &dir, None, 50, &dir);
        assert!(result.ok);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].file, "a.txt");
        assert_eq!(result.hits[0].line, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn glob_filter_applies() {
        let dir = std::env::temp_dir().join(format!("kp-grep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("a.ts"), b"needle\n").unwrap();
        std::fs::write(dir.join("b.md"), b"needle\n").unwrap();
        // `**/*.ts` requires a separator, exactly like Node's globToRegExp.
        let result = grep_with_walker("needle", &dir, Some("**/*.ts"), 50, &dir);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].file, "sub/a.ts");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
