//! Runtime metadata, compatibility defaults, and manifest validation.

use crate::files::{inside, validate_relative_path};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

fn default_runtime_engine() -> String {
    "node".to_string()
}

fn default_runtime_node() -> String {
    if cfg!(target_os = "windows") {
        "bin/node.exe".to_string()
    } else {
        "bin/node".to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub product: String,
    /// `node` (bundled Node runtime) or `rust` (native daemon). Older manifests omit it.
    #[serde(default = "default_runtime_engine")]
    pub engine: String,
    pub platform: String,
    pub arch: String,
    pub version: String,
    pub commit: String,
    #[serde(default)]
    pub built_at: String,
    #[serde(default = "default_runtime_node")]
    pub node: String,
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

impl RuntimeManifest {
    pub fn is_rust(&self) -> bool {
        self.engine.eq_ignore_ascii_case("rust")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateManifest {
    pub schema_version: u32,
    pub product: String,
    /// Absent in the legacy Node feed. Rust updates require an explicit engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub platform: String,
    pub arch: String,
    pub version: String,
    pub commit: String,
    #[serde(default)]
    pub built_at: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRuntimeRecord {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub pending: Option<String>,
    pub failed: Option<String>,
    pub notified: Option<String>,
    pub latest_version: Option<String>,
    pub latest_built_at: Option<String>,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusSnapshot {
    pub id: String,
    pub engine: String,
    pub port: u16,
    pub state: String,
    pub owner: String,
    pub pid: u32,
    pub version: String,
    pub commit: String,
    pub built_at: String,
    pub error: String,
    pub update_state: String,
    pub update_progress: Option<u8>,
    pub update_error: String,
    pub latest_version: String,
    pub latest_built_at: String,
    pub pending_version: String,
}

impl RuntimeStatusSnapshot {
    pub fn initial(id: &str, port: u16) -> Self {
        Self {
            id: id.to_string(),
            engine: String::new(),
            port,
            state: "stopped".to_string(),
            owner: String::new(),
            pid: 0,
            version: String::new(),
            commit: String::new(),
            built_at: String::new(),
            error: String::new(),
            update_state: "idle".to_string(),
            update_progress: None,
            update_error: String::new(),
            latest_version: String::new(),
            latest_built_at: String::new(),
            pending_version: String::new(),
        }
    }
}

pub fn current_runtime_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// Platform name used by published MCP runtime manifests and the CDN feed
/// (`macos-arm64.json`, `windows-x64.json`). The desktop client feed keeps the
/// Rust target-style names returned by [`current_runtime_platform`].
pub fn mcp_feed_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub fn current_runtime_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

pub fn is_valid_hex(s: &str, expected_len: usize) -> bool {
    s.len() == expected_len && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn parse_semver(raw: &str) -> Option<Version> {
    let trimmed = raw.trim().trim_start_matches('v');
    Version::parse(trimmed).ok()
}

pub fn is_version_newer(candidate: &str, baseline: &str) -> bool {
    match (parse_semver(candidate), parse_semver(baseline)) {
        (Some(c), Some(b)) => c > b,
        _ => false,
    }
}

pub fn validate_runtime_dir(dir: &Path, expected_product: &str) -> Result<RuntimeManifest, String> {
    validate_runtime_dir_any(dir, &[expected_product])
}

/// Accepts any of `expected_products`; used while Node and Rust runtimes coexist.
pub fn validate_runtime_dir_any(
    dir: &Path,
    expected_products: &[&str],
) -> Result<RuntimeManifest, String> {
    let manifest_path = dir.join("runtime.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Missing runtime.json in {}: {e}", dir.display()))?;
    let manifest: RuntimeManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid runtime.json in {}: {e}", dir.display()))?;

    if !expected_products
        .iter()
        .any(|product| *product == manifest.product)
    {
        return Err(format!(
            "Runtime product mismatch: expected {}, got {}",
            expected_products.join(" or "),
            manifest.product
        ));
    }
    if parse_semver(&manifest.version).is_none() {
        return Err(format!("Invalid runtime semver: {}", manifest.version));
    }
    if !is_valid_hex(&manifest.commit, 40) {
        return Err("Invalid 40-char commit in runtime.json".to_string());
    }

    let entry_rel = validate_relative_path(&manifest.entry)?;
    let entry_path = dir.join(entry_rel);
    if !inside(dir, &entry_path) {
        return Err("Runtime executable or entry escapes runtime directory".to_string());
    }
    if !manifest.is_rust() {
        let node_rel = validate_relative_path(&manifest.node)?;
        let node_path = dir.join(node_rel);
        if !inside(dir, &node_path) {
            return Err("Runtime executable or entry escapes runtime directory".to_string());
        }
        if !node_path.is_file() {
            return Err(format!(
                "Missing runtime node binary: {}",
                node_path.display()
            ));
        }
    }
    if !entry_path.is_file() {
        return Err(format!(
            "Missing runtime entry script: {}",
            entry_path.display()
        ));
    }
    Ok(manifest)
}

pub fn validate_update_manifest(
    manifest: &RuntimeUpdateManifest,
    expected_product: &str,
    expected_platform: &str,
    expected_arch: &str,
) -> Result<(), String> {
    let rust = expected_product == "keepwork-mcp-runtime";
    let schema = if rust { 2 } else { 1 };
    if manifest.schema_version != schema {
        return Err(format!(
            "Unsupported update manifest schemaVersion: {}",
            manifest.schema_version
        ));
    }
    if manifest.product != expected_product {
        return Err(format!("Unexpected update product: {}", manifest.product));
    }
    if (rust && manifest.engine.as_deref() != Some("rust"))
        || (!rust
            && manifest
                .engine
                .as_deref()
                .is_some_and(|engine| engine != "node"))
    {
        return Err("Update engine does not match the selected runtime".to_string());
    }
    if manifest.platform != expected_platform || manifest.arch != expected_arch {
        return Err(format!(
            "Update target mismatch: got {}-{}, expected {expected_platform}-{expected_arch}",
            manifest.platform, manifest.arch
        ));
    }
    if parse_semver(&manifest.version).is_none() {
        return Err(format!("Invalid update version: {}", manifest.version));
    }
    if !is_valid_hex(&manifest.commit, 40) {
        return Err("Invalid update commit hash".to_string());
    }
    if !is_valid_hex(&manifest.sha256, 64) {
        return Err("Invalid update sha256 digest".to_string());
    }
    if manifest.size == 0 || manifest.size > 500 * 1024 * 1024 {
        return Err(format!("Invalid update archive size: {}", manifest.size));
    }
    validate_update_url(&manifest.url)?;
    Ok(())
}

pub fn validate_update_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid update URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Update URL must not contain credentials or a fragment".into());
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && url.host_str() == Some("127.0.0.1")) {
        return Err("Update URL requires HTTPS or an explicit loopback fixture".into());
    }
    Ok(())
}

/// Check the archive itself, including its native binary identity, before making
/// it eligible for activation. A valid outer digest alone cannot select an engine.
pub fn validate_staged_runtime(
    dir: &Path,
    feed: &RuntimeUpdateManifest,
) -> Result<RuntimeManifest, String> {
    let runtime = validate_runtime_dir(dir, &feed.product)?;
    if runtime.version != feed.version
        || runtime.commit != feed.commit
        || runtime.platform != feed.platform
        || runtime.arch != feed.arch
        || runtime.is_rust() != (feed.product == "keepwork-mcp-runtime")
    {
        return Err("Archive runtime identity does not match the update manifest".into());
    }
    if runtime.is_rust() {
        validate_native_runtime_identity(dir, &runtime)?;
    }
    Ok(runtime)
}

pub(super) fn validate_native_runtime_identity(
    dir: &Path,
    runtime: &RuntimeManifest,
) -> Result<(), String> {
    let raw: serde_json::Value = serde_json::from_slice(
        &fs::read(dir.join("runtime.json")).map_err(|_| "Missing runtime manifest")?,
    )
    .map_err(|_| "Invalid runtime manifest")?;
    let entry = if runtime.platform == "windows" {
        "bin/keepwork-mcp.exe"
    } else {
        "bin/keepwork-mcp"
    };
    if raw["schemaVersion"] != 2 || runtime.engine != "rust" || runtime.entry != entry {
        return Err("Rust updates require a v2 native runtime manifest".into());
    }
    let bytes = fs::read(dir.join(entry)).map_err(|_| "Could not read staged binary")?;
    let start_marker = b"{\"marker\":\"keepwork-mcp-build-v1\",";
    let end_marker = b"\"endMarker\":\"keepwork-mcp-build-end\"}";
    let start = bytes
        .windows(start_marker.len())
        .position(|part| part == start_marker)
        .ok_or("Staged Rust binary has no compiled identity")?;
    let end = bytes[start..]
        .windows(end_marker.len())
        .position(|part| part == end_marker)
        .map(|offset| start + offset + end_marker.len())
        .ok_or("Invalid compiled identity")?;
    if end - start > 16_384 {
        return Err("Compiled identity is too large".into());
    }
    let info: serde_json::Value =
        serde_json::from_slice(&bytes[start..end]).map_err(|_| "Invalid compiled identity")?;
    let target = match (runtime.platform.as_str(), runtime.arch.as_str()) {
        ("macos", "arm64") => "aarch64-apple-darwin",
        ("macos", "x64") => "x86_64-apple-darwin",
        ("windows", "arm64") => "aarch64-pc-windows-msvc",
        ("windows", "x64") => "x86_64-pc-windows-msvc",
        ("linux", "arm64") => "aarch64-unknown-linux-gnu",
        ("linux", "x64") => "x86_64-unknown-linux-gnu",
        _ => return Err("Unsupported Rust update target".into()),
    };
    if info["product"] != runtime.product
        || info["engine"] != "rust"
        || info["version"] != runtime.version
        || info["commit"] != runtime.commit
        || info["target"] != target
        || !info["sourceHash"]
            .as_str()
            .is_some_and(|hash| is_valid_hex(hash, 64))
        || (raw.get("sourceHash").is_some() && raw["sourceHash"] != info["sourceHash"])
    {
        return Err("Staged Rust binary identity does not match runtime.json".into());
    }
    Ok(())
}
