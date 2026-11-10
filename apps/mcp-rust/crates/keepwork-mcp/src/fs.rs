//! `/fs/*` routes: the AIChat local-disk file API.
//!
//! Mirrors `src/core/fsServe.ts` field for field (status codes, error strings,
//! MIME types and size caps) so the browser client cannot tell the engines
//! apart.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths::{self, CoreError};

pub const FS_API: &str = "workspace";

const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PPT_BYTES: u64 = 500 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_LIST_MAX: usize = 1000;
const MAX_LIST_MAX: usize = 5000;
const SEARCH_SCAN_CAP: usize = 8000;

const SEARCH_SKIP_DIRS: &[&str] = &[
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

fn mime_for(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    match ext.as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".tga" => "image/x-tga",
        ".dds" => "image/vnd-ms.dds",
        ".ogg" => "audio/ogg",
        ".wav" => "audio/wav",
        ".mp3" => "audio/mpeg",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".lua" | ".npl" | ".txt" | ".table" | ".fx" => "text/plain",
        ".md" => "text/markdown",
        ".csv" => "text/csv",
        ".xml" => "application/xml",
        ".html" | ".htm" | ".page" | ".mcml" => "text/html",
        ".js" | ".mjs" => "text/javascript",
        ".css" => "text/css",
        ".json" => "application/json",
        ".wasm" => "application/wasm",
        ".pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// PPT/PPTX cap 500 MiB, PDF 100 MiB, everything else 1 GiB.
pub fn local_file_size_limit(filename: &str) -> u64 {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".ppt") || lower.ends_with(".pptx") {
        return MAX_PPT_BYTES;
    }
    if lower.ends_with(".pdf") {
        return MAX_DOCUMENT_BYTES;
    }
    MAX_FILE_BYTES
}

fn assert_file_size(filename: &str, size: u64) -> Result<(), CoreError> {
    let max = local_file_size_limit(filename);
    if size > max {
        return Err(CoreError::new(format!(
            "file too large (max {} MiB): {filename}",
            max / 1024 / 1024
        )));
    }
    Ok(())
}

fn truthy(value: Option<&String>, extra: &[&str]) -> bool {
    let raw = value
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    raw == "1" || raw == "true" || extra.contains(&raw.as_str())
}

fn wants_base64(query: &BTreeMap<String, String>) -> bool {
    truthy(query.get("base64"), &[])
}

fn wants_links(query: &BTreeMap<String, String>) -> bool {
    truthy(query.get("links"), &["include"])
}

fn wants_recursive(query: &BTreeMap<String, String>) -> bool {
    truthy(query.get("recursive"), &[])
}

fn parse_max(query: &BTreeMap<String, String>) -> usize {
    match query.get("max").and_then(|value| value.parse::<f64>().ok()) {
        Some(value) if value.is_finite() && value >= 1.0 => {
            (value.floor() as usize).min(MAX_LIST_MAX)
        }
        _ => DEFAULT_LIST_MAX,
    }
}

fn resolve_root(raw: &str) -> Result<String, CoreError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(CoreError::new("root is required"));
    }
    if !paths::is_abs_disk_path(value) {
        return Err(CoreError::new("root must be an absolute disk path"));
    }
    let info = paths::inspect_disk_path(value);
    if !info.exists || !info.is_directory {
        return Err(CoreError::new(format!("root is not a directory: {value}")));
    }
    Ok(info.resolved)
}

fn resolve_under_root(root: &str, rel: &str, include_links: bool) -> Result<PathBuf, CoreError> {
    let normalized = paths::normalize_rel(rel);
    if normalized.is_empty() {
        return Err(CoreError::new("path is required"));
    }
    if normalized.split('/').any(|part| part == "..") {
        return Err(CoreError::escape(format!("Path escapes root: {rel}")));
    }
    if include_links {
        paths::confine_lexical(root, &normalized)
    } else {
        paths::confine_path(root, &normalized)
    }
}

fn resolve_dir(root_raw: &str, rel_raw: &str) -> Result<(String, String, PathBuf), CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    let abs = if rel.is_empty() {
        PathBuf::from(&root)
    } else {
        paths::confine_lexical(&root, &rel)?
    };
    match fs::metadata(&abs) {
        Ok(meta) if meta.is_dir() => Ok((root, rel, abs)),
        Ok(_) => Err(CoreError::new("path is not a directory")),
        Err(_) => Err(CoreError::new(format!(
            "file not found: {}",
            if rel.is_empty() { "." } else { rel.as_str() }
        ))),
    }
}

fn classify(dir: &Path, name: &str, file_type: &fs::FileType) -> (String, bool) {
    let symlink = file_type.is_symlink();
    let is_dir = if symlink {
        fs::metadata(dir.join(name))
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
    } else {
        file_type.is_dir()
    };
    let kind = if is_dir { "directory" } else { "file" };
    (kind.to_string(), symlink)
}

fn real_key(abs: &Path) -> String {
    fs::canonicalize(abs)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| abs.to_string_lossy().into_owned())
}

fn read_dir_classified(dir: &Path) -> Vec<(String, String, bool)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let (kind, symlink) = classify(dir, &name, &file_type);
        out.push((name, kind, symlink));
    }
    out
}

fn list_dir(root_raw: &str, rel_raw: &str, max: usize) -> Result<Value, CoreError> {
    let (_root, rel, abs) = resolve_dir(root_raw, rel_raw)?;
    let mut entries: Vec<(String, String, bool)> = Vec::new();
    let mut truncated = false;
    for item in read_dir_classified(&abs) {
        if entries.len() >= max {
            truncated = true;
            break;
        }
        entries.push(item);
    }
    entries.sort_by(|a, b| {
        if a.1 != b.1 {
            return if a.1 == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    });
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, kind, symlink)| json!({ "name": name, "kind": kind, "symlink": symlink }))
        .collect();
    Ok(json!({ "path": rel, "entries": entries, "truncated": truncated }))
}

fn list_files_recursive(root_raw: &str, rel_raw: &str, max: usize) -> Result<Value, CoreError> {
    let (_root, rel, abs) = resolve_dir(root_raw, rel_raw)?;
    let mut files: Vec<String> = Vec::new();
    let mut queue: VecDeque<(PathBuf, String)> = VecDeque::new();
    queue.push_back((abs.clone(), rel.clone()));
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(real_key(&abs));
    let mut truncated = false;
    let mut seen_count = 0usize;

    while let Some((dir, prefix)) = queue.pop_front() {
        if truncated {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if seen_count >= max {
                truncated = true;
                break;
            }
            seen_count += 1;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = dir.join(&name);
            let child_rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let (kind, _symlink) = classify(&dir, &name, &file_type);
            if kind == "directory" {
                let key = real_key(&child);
                if !seen.insert(key) {
                    continue;
                }
                queue.push_back((child, child_rel));
            } else {
                files.push(child_rel);
            }
        }
    }
    Ok(json!({ "path": rel, "files": files, "truncated": truncated }))
}

fn search_files_by_name(
    root_raw: &str,
    rel_raw: &str,
    query: &str,
    max: usize,
) -> Result<Value, CoreError> {
    let (_root, rel, abs) = resolve_dir(root_raw, rel_raw)?;
    let needle = query.to_lowercase();
    let mut files: Vec<String> = Vec::new();
    let mut queue: VecDeque<(PathBuf, String)> = VecDeque::new();
    queue.push_back((abs.clone(), rel.clone()));
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(real_key(&abs));
    let mut truncated = false;
    let mut scanned = 0usize;

    while let Some((dir, prefix)) = queue.pop_front() {
        if files.len() >= max || truncated {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if scanned >= SEARCH_SCAN_CAP {
                truncated = true;
                break;
            }
            scanned += 1;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = dir.join(&name);
            let child_rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let (kind, _symlink) = classify(&dir, &name, &file_type);
            if kind == "directory" {
                if SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let key = real_key(&child);
                if !seen.insert(key) {
                    continue;
                }
                queue.push_back((child, child_rel));
            } else if needle.is_empty()
                || child_rel.to_lowercase().contains(&needle)
                || name.to_lowercase().contains(&needle)
            {
                files.push(child_rel);
                if files.len() >= max {
                    break;
                }
            }
        }
    }
    Ok(json!({
        "path": rel,
        "query": query,
        "files": files,
        "truncated": truncated || files.len() >= max,
    }))
}

pub struct ReadFile {
    pub rel: String,
    pub content_type: String,
    pub body: Vec<u8>,
}

fn read_search_file(
    root_raw: &str,
    rel_raw: &str,
    include_links: bool,
) -> Result<ReadFile, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    let abs = resolve_under_root(&root, &rel, include_links)?;
    let meta = fs::metadata(&abs).map_err(|_| CoreError::new(format!("file not found: {rel}")))?;
    if meta.is_dir() {
        return Err(CoreError::new("path is a directory"));
    }
    if !meta.is_file() {
        return Err(CoreError::new(format!("not a file: {rel}")));
    }
    assert_file_size(&rel, meta.len())?;
    let mut body = Vec::new();
    let mut file =
        fs::File::open(&abs).map_err(|_| CoreError::new(format!("file not found: {rel}")))?;
    file.read_to_end(&mut body)
        .map_err(|error| CoreError::new(error.to_string()))?;
    let reported_rel = if include_links {
        rel.clone()
    } else {
        paths::relative_to_root(&root, &abs)
    };
    Ok(ReadFile {
        rel: reported_rel,
        content_type: mime_for(&abs.to_string_lossy()).to_string(),
        body,
    })
}

fn write_search_file(root_raw: &str, rel_raw: &str, body: &[u8]) -> Result<Value, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    let abs = resolve_under_root(&root, &rel, true)?;
    assert_file_size(&rel, body.len() as u64)?;
    if let Some(parent) = abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&abs, body).map_err(|error| CoreError::new(error.to_string()))?;
    Ok(json!({ "rel": rel, "size": body.len() }))
}

fn create_directory(root_raw: &str, rel_raw: &str) -> Result<Value, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    if rel.is_empty() {
        return Ok(json!({ "rel": "", "created": false }));
    }
    let abs = resolve_under_root(&root, &rel, true)?;
    let mut created = false;
    match fs::metadata(&abs) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(CoreError::new("path is not a directory")),
        Err(_) => {
            fs::create_dir_all(&abs).map_err(|error| CoreError::new(error.to_string()))?;
            created = true;
        }
    }
    Ok(json!({ "rel": rel, "created": created }))
}

fn delete_path(root_raw: &str, rel_raw: &str, folder: bool) -> Result<Value, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    if rel.is_empty() {
        return Err(CoreError::new("path is required"));
    }
    let abs = resolve_under_root(&root, &rel, true)?;
    let link_meta =
        fs::symlink_metadata(&abs).map_err(|_| CoreError::new(format!("file not found: {rel}")))?;
    let file_type = link_meta.file_type();
    if folder {
        if !file_type.is_dir() && !file_type.is_symlink() {
            return Err(CoreError::new("path is not a directory"));
        }
        fs::remove_dir_all(&abs).map_err(|error| CoreError::new(error.to_string()))?;
    } else {
        if file_type.is_dir() && !file_type.is_symlink() {
            return Err(CoreError::new("path is a directory"));
        }
        fs::remove_file(&abs).map_err(|error| CoreError::new(error.to_string()))?;
    }
    Ok(json!({ "rel": rel }))
}

fn spawn_detached(command: &str, args: &[String]) {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let _ = cmd.spawn();
}

fn reveal_in_os(abs: &Path, folder: bool) {
    let target = abs.to_string_lossy().into_owned();
    if cfg!(windows) {
        let args = if folder {
            vec![target]
        } else {
            vec![format!("/select,{target}")]
        };
        spawn_detached("explorer.exe", &args);
        return;
    }
    if cfg!(target_os = "macos") {
        let args = if folder {
            vec![target]
        } else {
            vec!["-R".to_string(), target]
        };
        spawn_detached("open", &args);
        return;
    }
    let dir = if folder {
        target
    } else {
        abs.parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or(target)
    };
    spawn_detached("xdg-open", &[dir]);
}

fn open_in_os(abs: &Path) {
    let target = abs.to_string_lossy().into_owned();
    if cfg!(windows) {
        spawn_detached(
            "cmd",
            &["/c".to_string(), "start".to_string(), String::new(), target],
        );
        return;
    }
    if cfg!(target_os = "macos") {
        spawn_detached("open", &[target]);
        return;
    }
    spawn_detached("xdg-open", &[target]);
}

fn reveal_mode(query: &BTreeMap<String, String>) -> &'static str {
    match query
        .get("mode")
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("open") => "open",
        Some("dir") => "dir",
        Some("reveal") => "reveal",
        _ => {
            if truthy(query.get("open"), &[]) {
                "open"
            } else if truthy(query.get("dir"), &[]) {
                "dir"
            } else {
                "reveal"
            }
        }
    }
}

fn reveal_path(root_raw: &str, rel_raw: &str, mode: &str) -> Result<Value, CoreError> {
    let root = resolve_root(root_raw)?;
    let rel = paths::normalize_rel(rel_raw);
    let abs = if rel.is_empty() {
        PathBuf::from(&root)
    } else {
        paths::confine_lexical(&root, &rel)?
    };
    let meta = fs::metadata(&abs).map_err(|_| {
        CoreError::new(format!(
            "file not found: {}",
            if rel.is_empty() { "." } else { rel.as_str() }
        ))
    })?;
    let folder = meta.is_dir();
    match mode {
        "open" => {
            open_in_os(&abs);
            Ok(json!({ "rel": rel, "via": "os", "mode": "open" }))
        }
        "dir" => {
            let dir = if folder {
                abs.clone()
            } else {
                abs.parent().map(Path::to_path_buf).unwrap_or(abs.clone())
            };
            // The VS Code terminal bridge does not exist in the Rust daemon.
            reveal_in_os(&dir, true);
            Ok(json!({ "rel": rel, "via": "os", "mode": "dir" }))
        }
        _ => {
            reveal_in_os(&abs, folder);
            Ok(json!({ "rel": rel, "via": "os", "mode": "reveal" }))
        }
    }
}

fn error_response(error: &CoreError) -> Response {
    crate::http::json_response(
        StatusCode::from_u16(paths::fs_status(error)).unwrap_or(StatusCode::BAD_REQUEST),
        &json!({ "ok": false, "error": error.message }),
    )
}

fn ok_response(body: Value) -> Response {
    let mut map = serde_json::Map::new();
    map.insert("ok".into(), json!(true));
    if let Value::Object(fields) = body {
        map.extend(fields);
    }
    crate::http::json_response(StatusCode::OK, &Value::Object(map))
}

/// `encodeURIComponent` semantics: `-_.!~*'()` stay literal.
fn encode_component(raw: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(raw, SET).to_string()
}

fn file_response(file: ReadFile) -> Response {
    let length = file.body.len();
    let search_path = encode_component(&file.rel);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, file.content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header("x-content-type-options", "nosniff")
        .header("x-search-path", search_path)
        .body(Body::from(file.body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn read_put_body(req: Request, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
    match axum::body::to_bytes(req.into_body(), max_bytes as usize).await {
        Ok(bytes) => Ok(bytes.to_vec()),
        Err(_) => Err(CoreError::new("request too large")),
    }
}

/// Handles every `/fs*` path. Returns `Some` when the path belongs to this API.
pub async fn route(
    req: Request,
    path: &str,
    query: &BTreeMap<String, String>,
    _headers: &HeaderMap,
) -> Option<Response> {
    if !path.starts_with("/fs") {
        return None;
    }
    let method = req.method().clone();
    let root = query.get("root").map(|value| value.trim()).unwrap_or("");
    let rel = query.get("path").map(|value| value.trim()).unwrap_or("");
    let include_links = wants_links(query);

    // `/fs/file` GET streams raw bytes, so it bypasses the JSON envelope.
    if path == "/fs/file" && method == Method::GET {
        return Some(match read_search_file(root, rel, include_links) {
            Ok(file) => {
                if wants_base64(query) {
                    let size = file.body.len();
                    let encoded = encode_base64(&file.body);
                    ok_response(json!({
                        "size": size,
                        "rel": file.rel,
                        "type": file.content_type,
                        "base64": encoded,
                    }))
                } else {
                    file_response(file)
                }
            }
            Err(error) => error_response(&error),
        });
    }

    let outcome: Result<Value, CoreError> = match (path, method.clone()) {
        ("/fs/list", Method::GET) => {
            let max = parse_max(query);
            if wants_recursive(query) {
                list_files_recursive(root, rel, max)
            } else {
                list_dir(root, rel, max)
            }
        }
        ("/fs/search", Method::GET) => {
            let query_text = query
                .get("q")
                .or_else(|| query.get("query"))
                .map(|value| value.trim())
                .unwrap_or("")
                .to_string();
            search_files_by_name(root, rel, &query_text, parse_max(query))
        }
        ("/fs/stat", Method::GET) => paths::stat_path(root, rel),
        ("/fs/file", Method::PUT) => {
            let max = local_file_size_limit(rel);
            match read_put_body(req, max).await {
                Ok(body) => write_search_file(root, rel, &body),
                Err(error) => Err(error),
            }
        }
        ("/fs/file", Method::DELETE) => delete_path(root, rel, false),
        ("/fs/dir", Method::PUT) => create_directory(root, rel),
        ("/fs/dir", Method::DELETE) => delete_path(root, rel, true),
        ("/fs/reveal", Method::POST) | ("/fs/reveal", Method::GET) => {
            reveal_path(root, rel, reveal_mode(query))
        }
        _ => {
            let not_found = matches!(method, Method::GET | Method::PUT | Method::DELETE);
            return Some(crate::http::json_response(
                if not_found {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::METHOD_NOT_ALLOWED
                },
                &json!({
                    "ok": false,
                    "error": if not_found { "not found" } else { "method not allowed" },
                }),
            ));
        }
    };

    Some(match outcome {
        Ok(body) => ok_response(body),
        Err(error) => error_response(&error),
    })
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_limits_match_node() {
        assert_eq!(local_file_size_limit("deck.pptx"), MAX_PPT_BYTES);
        assert_eq!(local_file_size_limit("manual.PDF"), MAX_DOCUMENT_BYTES);
        assert_eq!(local_file_size_limit("notes.md"), MAX_FILE_BYTES);
    }

    #[test]
    fn mime_matches_node() {
        assert_eq!(mime_for("a.PNG"), "image/png");
        assert_eq!(mime_for("main.mcml"), "text/html");
        assert_eq!(mime_for("unknown.bin"), "application/octet-stream");
    }

    #[test]
    fn base64_matches_node_encoding() {
        assert_eq!(encode_base64(b"hi"), "aGk=");
        assert_eq!(encode_base64(b"abc"), "YWJj");
        assert_eq!(encode_base64(b""), "");
    }

    #[test]
    fn listing_sorts_directories_first() {
        let dir = std::env::temp_dir().join(format!("kp-list-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("b-dir")).unwrap();
        fs::write(dir.join("a-file.txt"), b"x").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let value = list_dir(&root, "", 100).unwrap();
        assert_eq!(value["entries"][0]["kind"], "directory");
        assert_eq!(value["entries"][0]["name"], "b-dir");
        assert_eq!(value["entries"][1]["name"], "a-file.txt");
        fs::remove_dir_all(&dir).unwrap();
    }
}
