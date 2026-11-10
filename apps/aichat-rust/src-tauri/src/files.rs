use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use uuid::Uuid;

pub const PPT_MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;
pub const PDF_MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_LIST_ENTRIES: usize = 5000;
pub const DEFAULT_LIST_ENTRIES: usize = 1000;
pub const MAX_SCAN_ENTRIES: usize = 8000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderGrant {
    pub id: String,
    pub path: String,
    pub name: String,
}

pub fn max_file_bytes_for_path(path_or_name: &str) -> u64 {
    let lower = path_or_name.trim().to_ascii_lowercase();
    if lower.ends_with(".ppt") || lower.ends_with(".pptx") {
        PPT_MAX_FILE_BYTES
    } else if lower.ends_with(".pdf") {
        PDF_MAX_FILE_BYTES
    } else {
        MAX_FILE_BYTES
    }
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
        }
    }
    out
}

pub fn inside(root: &Path, candidate: &Path) -> bool {
    let norm_root = normalize_lexical(root);
    let norm_cand = normalize_lexical(candidate);
    norm_cand.starts_with(&norm_root)
}

pub fn validate_relative_path(rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') || rel.contains(':') {
        return Err("Invalid relative path".to_string());
    }
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("Absolute path is not allowed".to_string());
    }
    let mut clean = PathBuf::new();
    for part in trimmed.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("Parent directory traversal is not allowed".to_string());
        }
        clean.push(part);
    }
    Ok(clean)
}

pub fn to_slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn atomic_json_write<T: Serialize>(file_path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    let tmp_name = format!(
        ".{}.{}.{}.tmp",
        file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("state"),
        std::process::id(),
        Uuid::new_v4()
    );
    let tmp_path = file_path.with_file_name(tmp_name);
    let payload =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to serialize JSON: {e}"))?;

    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("Failed to open temporary file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(&payload)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Failed to write temporary file: {e}"))?;
    }

    fs::rename(&tmp_path, file_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to commit atomic JSON file: {e}")
    })
}

pub fn is_symlink_or_junction(path: &Path) -> bool {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return true;
        }
    }
    #[cfg(windows)]
    {
        if junction::exists(path).unwrap_or(false) {
            return true;
        }
    }
    false
}

pub struct NativeFiles {
    store_path: PathBuf,
    grants: Mutex<Vec<FolderGrant>>,
}

impl NativeFiles {
    pub fn new(store_path: PathBuf) -> Self {
        let grants = Self::load_from_disk(&store_path);
        Self {
            store_path,
            grants: Mutex::new(grants),
        }
    }

    fn load_from_disk(path: &Path) -> Vec<FolderGrant> {
        let Ok(raw) = fs::read_to_string(path) else {
            return Vec::new();
        };
        serde_json::from_str::<Vec<FolderGrant>>(&raw).unwrap_or_default()
    }

    fn save_locked(&self, grants: &[FolderGrant]) -> Result<(), String> {
        atomic_json_write(&self.store_path, &grants)
    }

    pub fn roots(&self) -> Vec<FolderGrant> {
        self.grants.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn grant(&self, target_dir: &Path) -> Result<FolderGrant, String> {
        let meta = fs::metadata(target_dir)
            .map_err(|e| format!("Cannot access folder {}: {e}", target_dir.display()))?;
        if !meta.is_dir() {
            return Err("Selected path is not a directory".to_string());
        }
        let real = dunce::canonicalize(target_dir)
            .map_err(|e| format!("Cannot resolve folder {}: {e}", target_dir.display()))?;
        let real_str = real.to_string_lossy().into_owned();
        let name = real
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| real_str.clone());

        let mut guard = self
            .grants
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        if let Some(existing) = guard.iter().find(|item| item.path == real_str) {
            return Ok(existing.clone());
        }
        let grant = FolderGrant {
            id: Uuid::new_v4().to_string(),
            path: real_str,
            name,
        };
        guard.push(grant.clone());
        self.save_locked(&guard)?;
        Ok(grant)
    }

    pub fn revoke(&self, root_id: &str) -> Result<bool, String> {
        let mut guard = self
            .grants
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        let before = guard.len();
        guard.retain(|item| item.id != root_id);
        let changed = guard.len() != before;
        if changed {
            self.save_locked(&guard)?;
        }
        Ok(changed)
    }

    fn verify_root(&self, root_id: &str) -> Result<(FolderGrant, PathBuf, Vec<PathBuf>), String> {
        let grants = self.roots();
        let grant = grants
            .iter()
            .find(|g| g.id == root_id)
            .cloned()
            .ok_or_else(|| "Folder access has not been granted".to_string())?;

        let root_path = PathBuf::from(&grant.path);
        let root_meta = fs::symlink_metadata(&root_path)
            .map_err(|_| "Granted folder no longer exists".to_string())?;
        if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
            return Err("Granted folder was replaced or is not a directory".to_string());
        }
        let canonical_root = dunce::canonicalize(&root_path)
            .map_err(|_| "Granted folder cannot be resolved".to_string())?;
        if canonical_root != root_path {
            return Err("Granted folder path changed unexpectedly".to_string());
        }
        let all_roots = grants
            .iter()
            .filter_map(|g| dunce::canonicalize(&g.path).ok())
            .collect::<Vec<_>>();
        Ok((grant, canonical_root, all_roots))
    }

    pub fn resolve(
        &self,
        root_id: &str,
        rel: &str,
        follow_links: bool,
        allow_missing: bool,
    ) -> Result<(FolderGrant, PathBuf, String), String> {
        let (grant, root_path, all_roots) = self.verify_root(root_id)?;
        let rel_buf = validate_relative_path(rel)?;
        let rel_slash = to_slash_path(&rel_buf);
        let lexical_target = if rel_buf.as_os_str().is_empty() {
            root_path.clone()
        } else {
            root_path.join(&rel_buf)
        };
        if !inside(&root_path, &lexical_target) {
            return Err("Path escapes granted folder".to_string());
        }

        // Walk ancestors inside root to ensure no intermediate symlink escapes when follow_links == false
        if !follow_links {
            let target_real = dunce::canonicalize(&lexical_target).map_err(|e| {
                if allow_missing && e.kind() == std::io::ErrorKind::NotFound {
                    "Target directory does not exist".to_string()
                } else {
                    format!("Cannot resolve target path: {e}")
                }
            })?;
            let allowed = all_roots.iter().any(|r| inside(r, &target_real));
            if !allowed {
                return Err("链接目标不在已授权文件夹内，请先打开目标文件夹授权".to_string());
            }
            return Ok((grant, target_real, rel_slash));
        }

        // When follow_links == true (workspace file ops), check if it's a broken symlink when allow_missing == false
        if let Ok(sym_meta) = fs::symlink_metadata(&lexical_target) {
            if sym_meta.file_type().is_symlink()
                && fs::metadata(&lexical_target).is_err()
                && !allow_missing
            {
                return Err("Broken symbolic link".to_string());
            }
        }
        Ok((grant, lexical_target, rel_slash))
    }

    pub fn handle(&self, op: &str, args: &Value) -> Result<Value, String> {
        let root_id = args.get("rootId").and_then(|v| v.as_str()).unwrap_or("");
        let rel = args
            .get("path")
            .or_else(|| args.get("rel"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match op {
            "stat" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                match fs::symlink_metadata(&target) {
                    Ok(sym_meta) => {
                        let symlink = is_symlink_or_junction(&target);
                        if let Ok(meta) = fs::metadata(&target) {
                            let mtime_ms = meta
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            Ok(json!({
                                "exists": true,
                                "isFile": meta.is_file(),
                                "isDirectory": meta.is_dir(),
                                "symlink": symlink,
                                "size": if meta.is_file() { meta.len() } else { 0 },
                                "mtimeMs": mtime_ms,
                                "rel": rel_slash,
                            }))
                        } else {
                            let _ = sym_meta;
                            Ok(json!({
                                "exists": false,
                                "isFile": false,
                                "isDirectory": false,
                                "symlink": symlink,
                                "brokenSymlink": symlink,
                                "size": 0,
                                "rel": rel_slash,
                            }))
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({
                        "exists": false,
                        "isFile": false,
                        "isDirectory": false,
                        "symlink": false,
                        "size": 0,
                        "rel": rel_slash,
                    })),
                    Err(e) => Err(format!("Failed to stat {}: {e}", rel_slash)),
                }
            }
            "read" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                let meta = match fs::metadata(&target) {
                    Ok(m) => m,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        if is_symlink_or_junction(&target) {
                            return Err("Broken symbolic link".to_string());
                        }
                        return Ok(Value::Null);
                    }
                    Err(e) => return Err(format!("Failed to read {}: {e}", rel_slash)),
                };
                if meta.is_dir() {
                    return Err("Cannot read a directory as a file".to_string());
                }
                let limit = max_file_bytes_for_path(&rel_slash);
                if meta.len() > limit {
                    return Err(format!(
                        "File exceeds maximum allowed size ({} > {} bytes)",
                        meta.len(),
                        limit
                    ));
                }
                let bytes =
                    fs::read(&target).map_err(|e| format!("Failed to read {}: {e}", rel_slash))?;
                let encoding = args
                    .get("encoding")
                    .and_then(|v| v.as_str())
                    .unwrap_or("utf8");
                let base64_flag = args
                    .get("base64")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || encoding.eq_ignore_ascii_case("base64");
                if base64_flag {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    Ok(json!({
                        "ok": true,
                        "rel": rel_slash,
                        "size": bytes.len(),
                        "encoding": "base64",
                        "base64": b64,
                        "content": b64,
                    }))
                } else {
                    // The web client reads `bytes` (as Electron does); non-UTF-8
                    // files must still be readable, so only add `content` when
                    // the text decodes cleanly.
                    let size = bytes.len();
                    let content = String::from_utf8(bytes.clone()).ok();
                    let mut result = json!({
                        "ok": true,
                        "rel": rel_slash,
                        "size": size,
                        "encoding": "utf8",
                        "bytes": bytes,
                    });
                    if let Some(text) = content {
                        result["content"] = json!(text);
                    }
                    Ok(result)
                }
            }
            "write" => {
                if rel.trim().is_empty() {
                    return Err("File path is required".to_string());
                }
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                let encoding = args
                    .get("encoding")
                    .and_then(|v| v.as_str())
                    .unwrap_or("utf8");
                let bytes =
                    if encoding.eq_ignore_ascii_case("base64") || args.get("base64").is_some() {
                        let raw_b64 = args
                            .get("base64")
                            .or_else(|| args.get("content"))
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| "Missing base64 content".to_string())?;
                        base64::engine::general_purpose::STANDARD
                            .decode(raw_b64)
                            .map_err(|e| format!("Invalid base64 payload: {e}"))?
                    } else if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
                        // The web client sends `{ text }` (see keepworkWriteText).
                        text.as_bytes().to_vec()
                    } else if let Some(content) = args.get("content").and_then(|v| v.as_str()) {
                        content.as_bytes().to_vec()
                    } else if let Some(items) = args.get("bytes").and_then(|v| v.as_array()) {
                        // keepworkWriteBlob sends `{ bytes: Uint8Array }`, which
                        // arrives as a JSON array of byte values.
                        let mut buffer = Vec::with_capacity(items.len());
                        for item in items {
                            let value = item
                                .as_u64()
                                .filter(|n| *n <= u8::MAX as u64)
                                .ok_or_else(|| "Invalid byte value".to_string())?;
                            buffer.push(value as u8);
                        }
                        buffer
                    } else {
                        // Match the Electron bridge: no content/key writes an empty file.
                        Vec::new()
                    };
                let limit = max_file_bytes_for_path(&rel_slash);
                if (bytes.len() as u64) > limit {
                    return Err(format!(
                        "Content exceeds maximum allowed size ({} > {} bytes)",
                        bytes.len(),
                        limit
                    ));
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent directory: {e}"))?;
                }
                fs::write(&target, &bytes)
                    .map_err(|e| format!("Failed to write {}: {e}", rel_slash))?;
                Ok(json!({
                    "ok": true,
                    "rel": rel_slash,
                    "size": bytes.len(),
                }))
            }
            "mkdir" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                fs::create_dir_all(&target)
                    .map_err(|e| format!("Failed to create directory {}: {e}", rel_slash))?;
                Ok(json!({
                    "ok": true,
                    "created": true,
                    "rel": rel_slash,
                }))
            }
            "delete" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, false)?;
                if rel_slash.is_empty() {
                    return Err("Cannot delete the granted root folder itself".to_string());
                }
                let recursive = args
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let is_link = is_symlink_or_junction(&target);
                if is_link {
                    // Remove only the link/junction itself, never its target contents
                    if fs::remove_file(&target).is_err() {
                        fs::remove_dir(&target)
                            .map_err(|e| format!("Failed to remove link {}: {e}", rel_slash))?;
                    }
                } else {
                    let meta = fs::symlink_metadata(&target)
                        .map_err(|e| format!("Cannot access {}: {e}", rel_slash))?;
                    if meta.is_dir() {
                        if recursive {
                            fs::remove_dir_all(&target).map_err(|e| {
                                format!("Failed to remove directory {}: {e}", rel_slash)
                            })?;
                        } else {
                            fs::remove_dir(&target).map_err(|e| {
                                format!("Failed to remove directory {}: {e}", rel_slash)
                            })?;
                        }
                    } else {
                        fs::remove_file(&target)
                            .map_err(|e| format!("Failed to remove file {}: {e}", rel_slash))?;
                    }
                }
                Ok(json!({
                    "ok": true,
                    "deleted": true,
                    "rel": rel_slash,
                }))
            }
            "list" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                let recursive = args
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let max = args
                    .get("max")
                    .and_then(|v| v.as_u64())
                    .map(|n| (n as usize).clamp(1, MAX_LIST_ENTRIES))
                    .unwrap_or(DEFAULT_LIST_ENTRIES);

                match fs::metadata(&target) {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => return Err("Target path is not a directory".to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(json!({ "entries": [], "files": [], "truncated": false }));
                    }
                    Err(e) => return Err(format!("Failed to list {}: {e}", rel_slash)),
                }

                if !recursive {
                    let mut entries = Vec::new();
                    let read_dir = fs::read_dir(&target)
                        .map_err(|e| format!("Failed to read directory {}: {e}", rel_slash))?;
                    for item in read_dir {
                        let item = item.map_err(|e| format!("Directory entry error: {e}"))?;
                        let name = item.file_name().to_string_lossy().into_owned();
                        let child_path = item.path();
                        let symlink = is_symlink_or_junction(&child_path);
                        let Ok(meta) = fs::metadata(&child_path) else {
                            // Broken symlink: skip
                            continue;
                        };
                        let child_rel = if rel_slash.is_empty() {
                            name.clone()
                        } else {
                            format!("{rel_slash}/{name}")
                        };
                        entries.push(json!({
                            "name": name,
                            "path": child_rel,
                            "kind": if meta.is_dir() { "directory" } else { "file" },
                            "type": if meta.is_dir() { "directory" } else { "file" },
                            "isDirectory": meta.is_dir(),
                            "isFile": meta.is_file(),
                            "symlink": symlink,
                            "size": if meta.is_file() { meta.len() } else { 0 },
                        }));
                        if entries.len() >= max {
                            break;
                        }
                    }
                    entries.sort_by(|a, b| {
                        let a_name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let b_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        a_name.cmp(b_name)
                    });
                    Ok(json!({
                        "entries": entries,
                        "truncated": entries.len() >= max,
                    }))
                } else {
                    let mut files = Vec::new();
                    let mut visited = HashSet::new();
                    if let Ok(canon) = dunce::canonicalize(&target) {
                        visited.insert(canon);
                    }
                    let mut queue = VecDeque::new();
                    queue.push_back((target, rel_slash));
                    let mut scanned = 0usize;

                    while let Some((dir_path, dir_rel)) = queue.pop_front() {
                        if files.len() >= max || scanned >= MAX_SCAN_ENTRIES {
                            break;
                        }
                        let Ok(rd) = fs::read_dir(&dir_path) else {
                            continue;
                        };
                        let mut dir_items = rd.filter_map(|e| e.ok()).collect::<Vec<_>>();
                        dir_items.sort_by_key(|e| e.file_name());
                        for item in dir_items {
                            if files.len() >= max || scanned >= MAX_SCAN_ENTRIES {
                                break;
                            }
                            scanned += 1;
                            let name = item.file_name().to_string_lossy().into_owned();
                            if name == ".git" || name == "node_modules" {
                                continue;
                            }
                            let child_path = item.path();
                            let Ok(meta) = fs::metadata(&child_path) else {
                                continue;
                            };
                            let child_rel = if dir_rel.is_empty() {
                                name.clone()
                            } else {
                                format!("{dir_rel}/{name}")
                            };
                            if meta.is_dir() {
                                if let Ok(canon) = dunce::canonicalize(&child_path) {
                                    if visited.insert(canon) {
                                        queue.push_back((child_path, child_rel));
                                    }
                                }
                            } else if meta.is_file() {
                                files.push(child_rel);
                            }
                        }
                    }
                    Ok(json!({
                        "files": files,
                        "entries": files,
                        "truncated": files.len() >= max || scanned >= MAX_SCAN_ENTRIES,
                    }))
                }
            }
            "search" => {
                let (_grant, target, rel_slash) = self.resolve(root_id, rel, true, true)?;
                let query = args
                    .get("q")
                    .or_else(|| args.get("query"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                let max = args
                    .get("max")
                    .and_then(|v| v.as_u64())
                    .map(|n| (n as usize).clamp(1, MAX_LIST_ENTRIES))
                    .unwrap_or(200);
                if query.is_empty() {
                    return Ok(json!({ "matches": [], "files": [] }));
                }

                match fs::metadata(&target) {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => return Err("Target path is not a directory".to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(json!({ "matches": [], "files": [] }));
                    }
                    Err(e) => return Err(format!("Failed to search {}: {e}", rel_slash)),
                }

                let mut matches = Vec::new();
                let mut visited = HashSet::new();
                if let Ok(canon) = dunce::canonicalize(&target) {
                    visited.insert(canon);
                }
                let mut queue = VecDeque::new();
                queue.push_back((target, rel_slash));
                let mut scanned = 0usize;

                while let Some((dir_path, dir_rel)) = queue.pop_front() {
                    if matches.len() >= max || scanned >= MAX_SCAN_ENTRIES {
                        break;
                    }
                    let Ok(rd) = fs::read_dir(&dir_path) else {
                        continue;
                    };
                    let mut dir_items = rd.filter_map(|e| e.ok()).collect::<Vec<_>>();
                    dir_items.sort_by_key(|e| e.file_name());
                    for item in dir_items {
                        if matches.len() >= max || scanned >= MAX_SCAN_ENTRIES {
                            break;
                        }
                        scanned += 1;
                        let name = item.file_name().to_string_lossy().into_owned();
                        if name == ".git" || name == "node_modules" {
                            continue;
                        }
                        let child_path = item.path();
                        let symlink = is_symlink_or_junction(&child_path);
                        let Ok(meta) = fs::metadata(&child_path) else {
                            continue;
                        };
                        let child_rel = if dir_rel.is_empty() {
                            name.clone()
                        } else {
                            format!("{dir_rel}/{name}")
                        };
                        if name.to_lowercase().contains(&query) {
                            matches.push(json!({
                                "name": name,
                                "path": child_rel,
                                "type": if meta.is_dir() { "directory" } else { "file" },
                                "symlink": symlink,
                            }));
                        }
                        if meta.is_dir() {
                            if let Ok(canon) = dunce::canonicalize(&child_path) {
                                if visited.insert(canon) {
                                    queue.push_back((child_path, child_rel));
                                }
                            }
                        }
                    }
                }
                Ok(json!({
                    "matches": matches,
                    "truncated": matches.len() >= max || scanned >= MAX_SCAN_ENTRIES,
                }))
            }
            _ => Err(format!("Unsupported file operation: {op}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_grant_confinement_size_limits_and_symlink_safety() {
        let tmp = std::env::temp_dir().join(format!("aichat-rust-files-{}", Uuid::new_v4()));
        let workspace = tmp.join("workspace");
        let outside = tmp.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top-secret").unwrap();

        let files = NativeFiles::new(tmp.join("folder-grants.json"));
        let grant = files.grant(&workspace).unwrap();
        assert_eq!(files.roots().len(), 1);

        // Traversal is rejected
        assert!(files
            .handle(
                "read",
                &json!({ "rootId": grant.id, "path": "../outside/secret.txt" })
            )
            .is_err());

        // Write and read UTF-8
        files
            .handle(
                "write",
                &json!({ "rootId": grant.id, "path": "notes/hello.md", "content": "# Hello" }),
            )
            .unwrap();
        let read_res = files
            .handle(
                "read",
                &json!({ "rootId": grant.id, "path": "notes/hello.md" }),
            )
            .unwrap();
        assert_eq!(read_res["content"], "# Hello");
        assert_eq!(read_res["bytes"], json!("# Hello".as_bytes()));

        // Missing directory list/search returns empty without error
        let missing_list = files
            .handle(
                "list",
                &json!({ "rootId": grant.id, "path": "_wiki", "recursive": true }),
            )
            .unwrap();
        assert_eq!(missing_list["files"], json!([]));

        // The web client writes `{ text }` and `{ bytes }`, not `{ content }`.
        files
            .handle(
                "write",
                &json!({ "rootId": grant.id, "rel": "_wiki/index.md", "text": "# Index" }),
            )
            .unwrap();
        let text_res = files
            .handle(
                "read",
                &json!({ "rootId": grant.id, "rel": "_wiki/index.md" }),
            )
            .unwrap();
        assert_eq!(text_res["content"], "# Index");
        files
            .handle(
                "write",
                &json!({ "rootId": grant.id, "rel": "media/raw.bin", "bytes": [0, 255, 7] }),
            )
            .unwrap();
        let bin_res = files
            .handle(
                "read",
                &json!({ "rootId": grant.id, "path": "media/raw.bin" }),
            )
            .unwrap();
        assert_eq!(bin_res["bytes"], json!([0, 255, 7]));
        assert!(bin_res.get("content").is_none());

        // Folder listings must expose `kind` so clients mark directories.
        let root_list = files
            .handle("list", &json!({ "rootId": grant.id, "path": "" }))
            .unwrap();
        let wiki_entry = root_list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "_wiki")
            .cloned()
            .expect("_wiki entry");
        assert_eq!(wiki_entry["kind"], "directory");

        // Symlink to outside directory is followed for workspace file read, but deleting the symlink preserves outside target!
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, workspace.join("linked_out")).unwrap();
            // Terminal cwd resolution (follow_links = false) rejects ungranted outside symlink target
            assert!(files
                .resolve(&grant.id, "linked_out", false, false)
                .is_err());
            // Deleting the symlink only deletes the link, not `outside/secret.txt`
            files
                .handle(
                    "delete",
                    &json!({ "rootId": grant.id, "path": "linked_out", "recursive": true }),
                )
                .unwrap();
            assert!(outside.join("secret.txt").exists());
        }

        assert_eq!(max_file_bytes_for_path("slides.pptx"), PPT_MAX_FILE_BYTES);
        assert_eq!(max_file_bytes_for_path("paper.pdf"), PDF_MAX_FILE_BYTES);
        assert_eq!(max_file_bytes_for_path("archive.bin"), MAX_FILE_BYTES);

        let _ = fs::remove_dir_all(&tmp);
    }
}
