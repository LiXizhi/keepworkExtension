//! Path resolution and workspace confinement (mirrors `src/core/paths.ts` and
//! the `statPath` part of `src/core/fsServe.ts`).

use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::config::{default_user_workspace, read_config_file, DEFAULT_WORKSPACE_SLOT};

#[derive(Debug)]
pub struct CoreError {
    pub message: String,
    pub escape: bool,
}

impl CoreError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            escape: false,
        }
    }

    fn escape(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            escape: true,
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn expand_user_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "~" {
        return dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return dirs::home_dir()
            .map(|home| home.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string());
    }
    trimmed.to_string()
}

pub fn is_abs_disk_path(raw: &str) -> bool {
    let value = expand_user_path(raw);
    let bytes = value.as_bytes();
    value.starts_with('/')
        || value.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

#[derive(Debug, Clone)]
pub struct DiskInfo {
    pub exists: bool,
    pub is_directory: bool,
    pub resolved: String,
}

fn real_or_resolve(path: &Path) -> String {
    fs::canonicalize(path)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| {
            if path.is_absolute() {
                path.to_string_lossy().into_owned()
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(path).to_string_lossy().into_owned())
                    .unwrap_or_else(|_| path.to_string_lossy().into_owned())
            }
        })
}

pub fn inspect_disk_path(raw: &str) -> DiskInfo {
    let expanded = expand_user_path(raw);
    if expanded.is_empty() {
        return DiskInfo {
            exists: false,
            is_directory: false,
            resolved: String::new(),
        };
    }
    let path = PathBuf::from(&expanded);
    match fs::metadata(&path) {
        Ok(meta) => DiskInfo {
            exists: true,
            is_directory: meta.is_dir(),
            resolved: real_or_resolve(&path),
        },
        Err(_) => DiskInfo {
            exists: false,
            is_directory: false,
            resolved: real_or_resolve(&path),
        },
    }
}

/// `--root` > `KEEPWORK_MCP_ROOT` > `config.json.workspaceRoot` > `~/.keepwork-mcp/workspace`.
pub fn resolve_workspace_root(override_root: Option<&str>) -> PathBuf {
    let config_root = read_config_file().workspace_root;
    let env_root = std::env::var("KEEPWORK_MCP_ROOT").ok();
    let candidates = [
        override_root.map(str::to_string),
        env_root,
        config_root,
        Some(default_user_workspace().to_string_lossy().into_owned()),
    ];
    for raw in candidates.into_iter().flatten() {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        let _ = fs::create_dir_all(&path);
        let _ = fs::create_dir_all(path.join(DEFAULT_WORKSPACE_SLOT));
        return fs::canonicalize(&path).unwrap_or(path);
    }
    let fallback = default_user_workspace();
    let _ = fs::create_dir_all(&fallback);
    let _ = fs::create_dir_all(fallback.join(DEFAULT_WORKSPACE_SLOT));
    fallback
}

pub fn normalize_rel(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

fn lexical_join(base: &Path, rel: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in rel
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        out.push(part);
    }
    out
}

/// Joins `rel` under a verified directory without following symlink targets.
pub fn confine_lexical(root: &str, rel: &str) -> Result<PathBuf, CoreError> {
    let info = inspect_disk_path(root);
    if !info.exists || !info.is_directory {
        return Err(CoreError::new(format!("root is not a directory: {root}")));
    }
    let base = PathBuf::from(&info.resolved);
    let normalized = normalize_rel(rel);
    if normalized.is_empty() {
        return Ok(base);
    }
    if normalized
        .split('/')
        .any(|part| part == ".." || part == ".")
    {
        return Err(CoreError::escape(format!("Path escapes root: {rel}")));
    }
    Ok(lexical_join(&base, &normalized))
}

fn resolve_root(raw: &str) -> Result<String, CoreError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(CoreError::new("root is required"));
    }
    if !is_abs_disk_path(value) {
        return Err(CoreError::new("root must be an absolute disk path"));
    }
    let info = inspect_disk_path(value);
    if !info.exists || !info.is_directory {
        return Err(CoreError::new(format!("root is not a directory: {value}")));
    }
    Ok(info.resolved)
}

/// `/fs/stat` body (without the leading `ok`).
pub fn stat_path(root_raw: &str, rel_raw: &str) -> Result<Value, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = normalize_rel(rel_raw);
    if rel.is_empty() {
        return Ok(json!({
            "exists": true,
            "isFile": false,
            "isDirectory": true,
            "symlink": false,
            "size": 0,
            "rel": "",
        }));
    }
    let abs = confine_lexical(&root, &rel)?;
    let Ok(link_meta) = fs::symlink_metadata(&abs) else {
        return Ok(json!({
            "exists": false,
            "isFile": false,
            "isDirectory": false,
            "symlink": false,
            "size": 0,
            "rel": rel,
        }));
    };
    let symlink = link_meta.file_type().is_symlink();
    let meta = if symlink {
        fs::metadata(&abs).unwrap_or(link_meta)
    } else {
        link_meta
    };
    Ok(json!({
        "exists": true,
        "isFile": meta.is_file(),
        "isDirectory": meta.is_dir(),
        "symlink": symlink,
        "size": if meta.is_file() { meta.len() } else { 0 },
        "rel": rel,
    }))
}

/// Node's `fsStatus`: escape/validation errors are 400, "not found" is 404.
pub fn fs_status(error: &CoreError) -> u16 {
    if error.escape {
        return 400;
    }
    let message = error.message.as_str();
    if message.contains("required")
        || message.contains("must be")
        || message.contains("not a directory")
        || message.contains("not allowed")
        || message.contains("too large")
        || message.contains("path is a directory")
    {
        return 400;
    }
    if message.contains("not found") {
        return 404;
    }
    400
}

/// Rejects traversal in a normalised path component list (used by later routes).
pub fn assert_no_parent(rel: &str) -> Result<(), CoreError> {
    if Path::new(rel)
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(CoreError::escape(format!("Path escapes root: {rel}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_and_detects_absolute_paths() {
        assert!(is_abs_disk_path("/tmp"));
        assert!(is_abs_disk_path("C:\\tmp"));
        assert!(is_abs_disk_path("~/Desktop"));
        assert!(!is_abs_disk_path("relative/dir"));
    }

    #[test]
    fn lexical_confinement_rejects_parent_traversal() {
        let dir = std::env::temp_dir();
        let info = inspect_disk_path(dir.to_string_lossy().as_ref());
        let err = confine_lexical(&info.resolved, "../etc/passwd").unwrap_err();
        assert!(err.escape);
        assert!(confine_lexical(&info.resolved, "a/b")
            .unwrap()
            .ends_with("a/b"));
    }

    #[test]
    fn stat_shape_matches_node() {
        let dir = std::env::temp_dir();
        let root = inspect_disk_path(dir.to_string_lossy().as_ref()).resolved;
        let value = stat_path(&root, "").unwrap();
        assert_eq!(value["exists"], true);
        assert_eq!(value["isDirectory"], true);
        assert_eq!(value["rel"], "");

        let missing = stat_path(&root, "definitely-missing-kp").unwrap();
        assert_eq!(missing["exists"], false);
        assert_eq!(missing["size"], 0);
    }
}
