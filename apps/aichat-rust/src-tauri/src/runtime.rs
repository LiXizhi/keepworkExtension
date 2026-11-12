use crate::files::{atomic_json_write, inside, validate_relative_path};
use flate2::write::DeflateEncoder;
use flate2::Compression;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MCP_PORT: u16 = 8089;
pub const LOCAL_MODEL_PORT: u16 = 18089;
pub const DEFAULT_MCP_FEED_BASE: &str = "https://cdn.keepwork.com/keepwork/mcp-stable";

/// Automatic restarts after a Rust MCP launch fails. The 60s runtime heartbeat
/// is the timer; calls that arrive sooner do not consume an attempt.
const RUST_MCP_MAX_START_ATTEMPTS: u32 = 5;
const RUST_MCP_RETRY_INTERVAL: Duration = Duration::from_secs(60);
const RUST_MCP_PRODUCT: &str = "keepwork-mcp-runtime";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RustStartRetry {
    Allow,
    Wait,
    Stop,
}

/// `failures` is how many Rust launches have already failed.
/// The next launch is allowed only after `RUST_MCP_RETRY_INTERVAL`, and never after the cap.
fn rust_start_retry(failures: u32, since_last_failure: Option<Duration>) -> RustStartRetry {
    if failures >= RUST_MCP_MAX_START_ATTEMPTS {
        return RustStartRetry::Stop;
    }
    if failures == 0 {
        return RustStartRetry::Allow;
    }
    match since_last_failure {
        Some(elapsed) if elapsed >= RUST_MCP_RETRY_INTERVAL => RustStartRetry::Allow,
        _ => RustStartRetry::Wait,
    }
}

fn rust_start_retry_suffix(attempts: u32) -> String {
    if attempts >= RUST_MCP_MAX_START_ATTEMPTS {
        format!("（已尝试 {attempts} 次，停止自动重试）")
    } else {
        format!("（{attempts}/{RUST_MCP_MAX_START_ATTEMPTS}，1 分钟后重试）")
    }
}

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
    if manifest.schema_version != 1 {
        return Err(format!(
            "Unsupported update manifest schemaVersion: {}",
            manifest.schema_version
        ));
    }
    if manifest.product != expected_product {
        return Err(format!("Unexpected update product: {}", manifest.product));
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
    if !manifest.url.starts_with("https://") && !manifest.url.starts_with("http://127.0.0.1:") {
        return Err(format!("Untrusted update URL: {}", manifest.url));
    }
    Ok(())
}

/// Pure-Rust ZIP extractor with path traversal confinement.
///
/// Zip64 and data descriptors are handled in-process without shell tools.
pub fn extract_zip_archive(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    let bytes = fs::read(zip_path).map_err(|e| format!("Failed to read zip archive: {e}"))?;
    extract_zip_central_directory(&bytes, dest_dir)
}

/// Central-directory pass for Zip64 archives and entries carrying data
/// descriptors, using the archive central directory.
fn extract_zip_central_directory(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    let canonical_root = dunce::canonicalize(dest_dir).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Failed to read ZIP central directory: {e}"))?;
    let mut extracted_any = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read ZIP entry {index}: {e}"))?;
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("ZIP symbolic links are not supported".into());
        }
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("ZIP entry escapes destination directory".to_string());
        };
        let clean_rel = validate_relative_path(&enclosed.to_string_lossy())?;
        if clean_rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest_dir.join(&clean_rel);
        if !inside(dest_dir, &out_path) {
            return Err("ZIP entry escapes destination directory".to_string());
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {e}"))?;
            let parent = dunce::canonicalize(parent).map_err(|e| e.to_string())?;
            if !parent.starts_with(&canonical_root) {
                return Err("ZIP entry parent escapes destination directory".into());
            }
        }
        if fs::symlink_metadata(&out_path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("ZIP output cannot replace a symbolic link".into());
        }
        let mut decompressed = Vec::new();
        entry
            .read_to_end(&mut decompressed)
            .map_err(|e| format!("ZIP entry decompression failed: {e}"))?;
        fs::write(&out_path, &decompressed)
            .map_err(|e| format!("Failed to write extracted file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = out_path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|name| name == "node" || name == "keepwork-mcp" || name.ends_with(".sh"))
                .unwrap_or(false);
            let mut mode = entry
                .unix_mode()
                .unwrap_or(if executable { 0o755 } else { 0o644 })
                & 0o777;
            // DOS ZIPs can report synthesized non-executable Unix modes.
            if executable {
                mode |= 0o111;
            }
            fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                .map_err(|e| format!("Failed to restore ZIP permissions: {e}"))?;
        }
        extracted_any = true;
    }
    if !extracted_any {
        return Err("ZIP archive contained no files".to_string());
    }
    Ok(())
}

pub fn extract_zip_bytes(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    extract_zip_central_directory(bytes, dest_dir)
}
/// Pure-Rust helper to build a valid ZIP archive from a directory (used in tests and smoke suites).
pub fn create_zip_from_dir(src_dir: &Path, zip_file: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_files_recursive(src_dir, src_dir, &mut entries)?;

    let mut out = Vec::new();
    let mut central_dir = Vec::new();

    for (rel_slash, full_path) in entries {
        let raw_data = fs::read(&full_path).map_err(|e| e.to_string())?;
        let crc = crc32_ieee(&raw_data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw_data).map_err(|e| e.to_string())?;
        let comp_data = encoder.finish().map_err(|e| e.to_string())?;

        let local_offset = out.len() as u32;
        let name_bytes = rel_slash.as_bytes();

        // Local file header
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        out.extend_from_slice(&0u16.to_le_bytes()); // mod time
        out.extend_from_slice(&0u16.to_le_bytes()); // mod date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(comp_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(raw_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&comp_data);

        // Central directory header
        central_dir.extend_from_slice(b"PK\x01\x02");
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_dir.extend_from_slice(&8u16.to_le_bytes()); // method = deflate
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod date
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&(comp_data.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(raw_data.len() as u32).to_le_bytes());
        central_dir.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // int attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // ext attrs
        central_dir.extend_from_slice(&local_offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central_dir.len() as u32;
    let count = out.windows(4).filter(|w| *w == b"PK\x03\x04").count() as u16;
    out.extend_from_slice(&central_dir);

    // End of central directory
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());

    if let Some(parent) = zip_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(zip_file, out).map_err(|e| e.to_string())
}

fn collect_files_recursive(
    base: &Path,
    current: &Path,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let rd = fs::read_dir(current).map_err(|e| e.to_string())?;
    for item in rd {
        let item = item.map_err(|e| e.to_string())?;
        let p = item.path();
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            collect_files_recursive(base, &p, out)?;
        } else if meta.is_file() {
            let rel = p
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, p));
        }
    }
    Ok(())
}

fn crc32_ieee(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub struct RuntimeConfig {
    pub id: String,
    /// Accepted runtime products; the first one is canonical for feed updates.
    pub products: Vec<String>,
    pub port: u16,
    pub health_path: String,
    pub updates_enabled: bool,
    pub bundled_dir: PathBuf,
    pub store_dir: PathBuf,
    pub feed_url: String,
}

impl RuntimeConfig {
    pub fn product(&self) -> &str {
        self.products.first().map(String::as_str).unwrap_or("")
    }
}

#[derive(Debug, Clone)]
pub struct HealthProbeResult {
    pub compatible: bool,
    pub pid: u32,
    pub runtime_version: String,
    pub runtime_engine: String,
    pub host_kind: String,
}

pub struct RuntimeSupervisor {
    config: RuntimeConfig,
    status: Arc<Mutex<RuntimeStatusSnapshot>>,
    child: Mutex<Option<Child>>,
    lifecycle: tokio::sync::Mutex<()>,
    /// Consecutive Rust MCP launch failures since the last healthy start or manual restart.
    rust_start_failures: AtomicU32,
    rust_start_failed_at: Mutex<Option<Instant>>,
}

impl RuntimeSupervisor {
    pub fn new(config: RuntimeConfig) -> Self {
        let mut snap = RuntimeStatusSnapshot::initial(&config.id, config.port);
        let record = Self::load_active_record(&config.store_dir);
        if let Some(v) = record.latest_version {
            snap.latest_version = v;
        }
        if let Some(b) = record.latest_built_at {
            snap.latest_built_at = b;
        }
        if let Some(pending_hash) = record.pending.as_deref() {
            if let Ok(m) = validate_runtime_dir_any(
                &config.store_dir.join(pending_hash),
                &config
                    .products
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            ) {
                snap.pending_version = m.version;
                snap.update_state = "staged".to_string();
            }
        }
        Self {
            config,
            status: Arc::new(Mutex::new(snap)),
            child: Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            rust_start_failures: AtomicU32::new(0),
            rust_start_failed_at: Mutex::new(None),
        }
    }

    fn configured_rust_mcp(&self) -> bool {
        self.config.id == "mcp"
            && self
                .config
                .products
                .iter()
                .any(|product| product == RUST_MCP_PRODUCT)
            && self
                .config
                .products
                .iter()
                .all(|product| !product.contains("node"))
    }

    fn rust_start_retry_state(&self) -> RustStartRetry {
        let failures = self.rust_start_failures.load(Ordering::Relaxed);
        let elapsed = self
            .rust_start_failed_at
            .lock()
            .ok()
            .and_then(|slot| slot.map(|at| at.elapsed()));
        rust_start_retry(failures, elapsed)
    }

    fn record_rust_start_failure(&self, err: &str) -> String {
        if let Ok(mut slot) = self.rust_start_failed_at.lock() {
            *slot = Some(Instant::now());
        }
        let attempts = self.rust_start_failures.fetch_add(1, Ordering::Relaxed) + 1;
        let message = format!("{err}{}", rust_start_retry_suffix(attempts));
        eprintln!("keepwork-mcp: {message}");
        message
    }

    fn clear_rust_start_retries(&self) {
        self.rust_start_failures.store(0, Ordering::Relaxed);
        if let Ok(mut slot) = self.rust_start_failed_at.lock() {
            *slot = None;
        }
    }

    pub fn snapshot(&self) -> RuntimeStatusSnapshot {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|_| RuntimeStatusSnapshot::initial(&self.config.id, self.config.port))
    }

    fn active_record_path(store_dir: &Path) -> PathBuf {
        store_dir.join("active.json")
    }

    pub fn load_active_record(store_dir: &Path) -> ActiveRuntimeRecord {
        fs::read_to_string(Self::active_record_path(store_dir))
            .ok()
            .and_then(|raw| serde_json::from_str::<ActiveRuntimeRecord>(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save_active_record(&self, record: &ActiveRuntimeRecord) -> Result<(), String> {
        atomic_json_write(&Self::active_record_path(&self.config.store_dir), record)
    }

    /// Selects the candidate runtime directory to launch (staged `pending`, `current`, or `bundled_dir`).
    pub fn select_best_local_runtime(
        &self,
        promote_pending: bool,
    ) -> Option<(PathBuf, RuntimeManifest, Option<String>)> {
        let mut record = Self::load_active_record(&self.config.store_dir);
        let bundled = validate_runtime_dir_any(
            &self.config.bundled_dir,
            &self
                .config
                .products
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
        .ok();

        if promote_pending {
            if let Some(pending_hash) = record.pending.clone() {
                if record.failed.as_deref() != Some(pending_hash.as_str()) {
                    let pending_dir = self.config.store_dir.join(&pending_hash);
                    if let Ok(m) = validate_runtime_dir_any(
                        &pending_dir,
                        &self
                            .config
                            .products
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                    ) {
                        let beats_bundled = bundled
                            .as_ref()
                            .map(|b| !is_version_newer(&b.version, &m.version))
                            .unwrap_or(true);
                        if beats_bundled {
                            record.current = Some(pending_hash.clone());
                            record.pending = None;
                            let _ = self.save_active_record(&record);
                            return Some((pending_dir, m, Some(pending_hash)));
                        }
                    }
                }
            }
        }

        if let Some(current_hash) = record.current.clone() {
            if record.failed.as_deref() != Some(current_hash.as_str()) {
                let current_dir = self.config.store_dir.join(&current_hash);
                if let Ok(m) = validate_runtime_dir_any(
                    &current_dir,
                    &self
                        .config
                        .products
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                ) {
                    let beats_bundled = bundled
                        .as_ref()
                        .map(|b| !is_version_newer(&b.version, &m.version))
                        .unwrap_or(true);
                    if beats_bundled {
                        return Some((current_dir, m, Some(current_hash)));
                    }
                }
            }
        }

        bundled.map(|m| (self.config.bundled_dir.clone(), m, None))
    }

    pub fn newest_local_version(&self) -> Option<String> {
        let record = Self::load_active_record(&self.config.store_dir);
        let mut best: Option<String> = None;
        let mut consider = |v: &str| {
            if parse_semver(v).is_some() {
                if best
                    .as_deref()
                    .map(|b| is_version_newer(v, b))
                    .unwrap_or(true)
                {
                    best = Some(v.to_string());
                }
            }
        };
        if let Ok(m) = validate_runtime_dir_any(
            &self.config.bundled_dir,
            &self
                .config
                .products
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ) {
            consider(&m.version);
        }
        for hash in [record.current.as_deref(), record.pending.as_deref()]
            .into_iter()
            .flatten()
        {
            if record.failed.as_deref() != Some(hash) {
                if let Ok(m) = validate_runtime_dir_any(
                    &self.config.store_dir.join(hash),
                    &self
                        .config
                        .products
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                ) {
                    consider(&m.version);
                }
            }
        }
        best
    }

    pub async fn probe_health(&self) -> Option<HealthProbeResult> {
        let client = reqwest::Client::builder()
            // This URL is always loopback. A system proxy can return a gateway
            // error for a healthy local daemon and cause a false startup timeout.
            .no_proxy()
            .timeout(Duration::from_millis(1200))
            .build()
            .ok()?;
        let url = format!(
            "http://127.0.0.1:{}{}",
            self.config.port, self.config.health_path
        );
        let resp = client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body = resp.json::<Value>().await.ok()?;
        let compatible = if self.config.id == "mcp" {
            // Missing `fsApi` means "capability unknown", not a broken peer: the
            // Rust runtime adds surfaces phase by phase.
            body.get("name").and_then(|v| v.as_str()) == Some("keepwork-mcp")
                && body
                    .get("fsApi")
                    .and_then(|v| v.as_str())
                    .map(|value| value == "workspace")
                    .unwrap_or(true)
        } else {
            body.get("service").and_then(|v| v.as_str()) == Some("keepwork-local-model")
                && body.get("protocolVersion").and_then(|v| v.as_str()) == Some("1.0.0")
        };
        let pid = body.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let runtime_version = body
            .get("runtimeVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let runtime_engine = body
            .get("runtimeEngine")
            .and_then(|v| v.as_str())
            .unwrap_or("node")
            .to_string();
        let host_kind = body
            .get("hostKind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Some(HealthProbeResult {
            compatible,
            pid,
            runtime_version,
            runtime_engine,
            host_kind,
        })
    }

    fn classify_owner(host_kind: &str) -> &'static str {
        match host_kind {
            "rust-node-runtime" | "tauri-node-runtime" | "electron-node-runtime" | "desktop" => {
                "desktop"
            }
            "vscode-extension" => "vscode-extension",
            "local-helper" => "local-helper",
            _ => "external",
        }
    }

    fn kill_pid(pid: u32) {
        if pid == 0 || pid == std::process::id() {
            return;
        }
        #[cfg(unix)]
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.status();
        }
    }

    pub async fn ensure_started(&self, promote_pending: bool) -> RuntimeStatusSnapshot {
        let _operation = self.lifecycle.lock().await;
        self.ensure_started_inner(promote_pending).await
    }

    async fn ensure_started_inner(&self, promote_pending: bool) -> RuntimeStatusSnapshot {
        // 1. Probe existing listener on port
        if let Some(probe) = self.probe_health().await {
            if !probe.compatible {
                if let Ok(mut st) = self.status.lock() {
                    st.state = "conflict".to_string();
                    st.owner = "external".to_string();
                    st.error = format!("端口 {} 已被其他不兼容服务占用", self.config.port);
                }
                return self.snapshot();
            }

            // Check if we should replace an older compatible MCP runtime on startup
            let local_runtime = self.select_best_local_runtime(false);
            let engine_switch = local_runtime
                .as_ref()
                .map(|(_, m, _)| {
                    let target_engine = if m.is_rust() { "rust" } else { "node" };
                    Self::classify_owner(&probe.host_kind) == "desktop"
                        && !probe.runtime_engine.eq_ignore_ascii_case(target_engine)
                })
                .unwrap_or(false);
            let version_upgrade = !probe.runtime_version.is_empty()
                && local_runtime
                    .as_ref()
                    .map(|(_, m, _)| {
                        let target_engine = if m.is_rust() { "rust" } else { "node" };
                        probe.runtime_engine.eq_ignore_ascii_case(target_engine)
                            && is_version_newer(&m.version, &probe.runtime_version)
                    })
                    .unwrap_or(false);
            let retry = self.rust_start_retry_state();
            let wants_takeover =
                self.config.id == "mcp" && probe.pid > 0 && (engine_switch || version_upgrade);
            // Do not kill a live daemon while a Rust replacement is backing off
            // or has already used its five automatic attempts.
            let should_takeover = wants_takeover && retry == RustStartRetry::Allow;

            if should_takeover {
                // Re-verify identity & PID before killing
                if let Some(recheck) = self.probe_health().await {
                    if recheck.compatible && recheck.pid == probe.pid {
                        Self::kill_pid(probe.pid);
                        for _ in 0..25 {
                            if self.probe_health().await.is_none() {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(80)).await;
                        }
                    }
                }
            } else {
                let owner = Self::classify_owner(&probe.host_kind);
                if let Ok(mut st) = self.status.lock() {
                    st.state = if owner == "desktop" {
                        "running"
                    } else {
                        "attached"
                    }
                    .to_string();
                    st.owner = owner.to_string();
                    st.pid = probe.pid;
                    if !probe.runtime_version.is_empty() {
                        st.version = probe.runtime_version;
                    } else if st.version.is_empty() {
                        if let Some((_, m, _)) = self.select_best_local_runtime(false) {
                            st.version = m.version;
                            st.commit = m.commit;
                            st.built_at = m.built_at;
                        }
                    }
                    st.error.clear();
                }
                if !wants_takeover || retry == RustStartRetry::Allow {
                    self.clear_rust_start_retries();
                }
                return self.snapshot();
            }
        }

        // Rust MCP launch failures are retried by the 60s heartbeat, at most 5 times.
        // A call that arrives inside the minute must not burn another attempt.
        if self.rust_start_retry_state() != RustStartRetry::Allow {
            return self.snapshot();
        }

        // 2. Spawn our local runtime
        let Some((runtime_dir, manifest, staged_hash)) =
            self.select_best_local_runtime(promote_pending)
        else {
            let base = format!("未找到可用的本地运行时（{}）", self.config.product());
            if let Ok(mut st) = self.status.lock() {
                st.state = "error".to_string();
                st.error = if self.configured_rust_mcp() {
                    self.record_rust_start_failure(&base)
                } else {
                    base
                };
            }
            return self.snapshot();
        };

        match self.spawn_and_verify(&runtime_dir, &manifest).await {
            Ok(pid) => {
                if let Ok(mut st) = self.status.lock() {
                    st.state = "running".to_string();
                    st.owner = "desktop".to_string();
                    st.pid = pid;
                    st.version = manifest.version;
                    st.commit = manifest.commit;
                    st.built_at = manifest.built_at;
                    st.error.clear();
                    if promote_pending {
                        st.pending_version.clear();
                        if st.update_state == "staged" {
                            st.update_state = "idle".to_string();
                        }
                    }
                }
                self.clear_rust_start_retries();
                self.snapshot()
            }
            Err(err) => {
                // If a promoted staged runtime failed to start, mark it failed and roll back to bundled
                let mut tried_rust = manifest.is_rust();
                if let Some(failed_hash) = staged_hash {
                    let mut record = Self::load_active_record(&self.config.store_dir);
                    record.failed = Some(failed_hash);
                    record.current = None;
                    let _ = self.save_active_record(&record);
                    if let Ok(bundled_manifest) = validate_runtime_dir_any(
                        &self.config.bundled_dir,
                        &self
                            .config
                            .products
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                    ) {
                        tried_rust = tried_rust || bundled_manifest.is_rust();
                        if let Ok(pid) = self
                            .spawn_and_verify(&self.config.bundled_dir, &bundled_manifest)
                            .await
                        {
                            if let Ok(mut st) = self.status.lock() {
                                st.state = "running".to_string();
                                st.owner = "desktop".to_string();
                                st.pid = pid;
                                st.version = bundled_manifest.version;
                                st.commit = bundled_manifest.commit;
                                st.built_at = bundled_manifest.built_at;
                                st.update_error = format!("更新版本启动失败，已自动回退：{err}");
                            }
                            self.clear_rust_start_retries();
                            return self.snapshot();
                        }
                    }
                }
                if let Ok(mut st) = self.status.lock() {
                    st.state = "error".to_string();
                    st.error = if tried_rust {
                        self.record_rust_start_failure(&err)
                    } else {
                        err
                    };
                }
                self.snapshot()
            }
        }
    }

    async fn spawn_and_verify(
        &self,
        runtime_dir: &Path,
        manifest: &RuntimeManifest,
    ) -> Result<u32, String> {
        self.stop_owned_process();

        let entry_path = runtime_dir.join(&manifest.entry);
        // A Rust runtime ships a self-contained executable as `entry`; a Node
        // runtime ships `bin/node` plus an entry script.
        let (program, pass_entry) = if manifest.is_rust() {
            (entry_path.clone(), false)
        } else {
            (runtime_dir.join(&manifest.node), true)
        };
        let mut cmd = Command::new(&program);
        cmd.current_dir(runtime_dir);
        if pass_entry {
            cmd.arg(&entry_path);
        }
        cmd.args(&manifest.args)
            .envs(&manifest.env)
            .env("KEEPWORK_MCP_HOST_KIND", "rust-node-runtime")
            .env("KEEPWORK_MCP_HOST_VERSION", env!("CARGO_PKG_VERSION"))
            .env("KEEPWORK_MCP_RUNTIME_VERSION", &manifest.version)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn {}: {e}", program.display()))?;
        let pid = child.id();
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }

        for _ in 0..40 {
            if let Some(probe) = self.probe_health().await {
                if probe.compatible {
                    return Ok(if probe.pid > 0 { probe.pid } else { pid });
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        self.stop_owned_process();
        Err(format!(
            "运行时启动超时（端口 {} 未通过健康检查）",
            self.config.port
        ))
    }

    pub fn stop_owned_process(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                // A wedged child can stay in an uninterruptible state, so
                // child.wait() may never return. Poll try_wait briefly; if the
                // process is still alive, hand it to a detached thread so the
                // caller never blocks.
                for _ in 0..20 {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                        Err(_) => return,
                    }
                }
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
    }

    pub fn stop(&self) {
        let is_desktop_owner = self
            .status
            .lock()
            .map(|s| s.owner == "desktop")
            .unwrap_or(false);
        if is_desktop_owner {
            self.stop_owned_process();
            if let Ok(mut st) = self.status.lock() {
                st.state = "stopped".to_string();
                st.pid = 0;
            }
        }
    }

    async fn stop_for_restart(&self) -> Result<(), String> {
        let before = self.probe_health().await;
        if let Some(probe) = &before {
            let owned_pid = self
                .child
                .lock()
                .ok()
                .and_then(|c| c.as_ref().map(Child::id));
            if !probe.compatible
                || (Self::classify_owner(&probe.host_kind) != "desktop"
                    && owned_pid != Some(probe.pid))
            {
                return Err(format!(
                    "当前本地服务由 {} 管理，请在该应用中重启",
                    Self::classify_owner(&probe.host_kind)
                ));
            }
            if probe.pid == 0 || probe.pid == std::process::id() {
                return Err("本地服务未提供有效 PID，无法安全重启".to_string());
            }
            // An earlier desktop process may have left this listener running.
            // In that case we have no Child handle; recheck the live identity
            // before terminating it, rather than silently attaching again.
            if owned_pid != Some(probe.pid) {
                let current = self.probe_health().await;
                match current {
                    Some(current)
                        if current.compatible
                            && current.pid == probe.pid
                            && Self::classify_owner(&current.host_kind) == "desktop" =>
                    {
                        Self::kill_pid(probe.pid);
                    }
                    None => {}
                    _ => return Err("本地服务实例已改变，请重新尝试重启".to_string()),
                }
            }
        }
        self.stop_owned_process();
        for _ in 0..40 {
            match self.probe_health().await {
                None => return Ok(()),
                Some(current) if before.as_ref().map(|p| p.pid) != Some(current.pid) => {
                    return Err("本地服务实例已改变，请重新尝试重启".to_string());
                }
                _ => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
        Err("本地服务未能停止，未执行重启".to_string())
    }

    pub async fn restart(&self) -> Result<RuntimeStatusSnapshot, String> {
        let _operation = self.lifecycle.lock().await;
        self.stop_for_restart().await?;
        self.clear_rust_start_retries();
        let status = self.ensure_started_inner(false).await;
        if status.state != "running" && status.state != "attached" {
            return Err(if status.error.is_empty() {
                "本地服务启动失败".to_string()
            } else {
                status.error
            });
        }
        Ok(status)
    }

    pub async fn apply_staged_update(&self) -> Result<RuntimeStatusSnapshot, String> {
        let _operation = self.lifecycle.lock().await;
        let record = Self::load_active_record(&self.config.store_dir);
        if record.pending.is_none() {
            return Err("当前没有待应用的 MCP 更新".to_string());
        }
        self.stop_for_restart().await?;
        self.clear_rust_start_retries();
        let status = self.ensure_started_inner(true).await;
        if status.state != "running" && status.state != "attached" {
            return Err(if status.error.is_empty() {
                "本地服务启动失败".to_string()
            } else {
                status.error
            });
        }
        Ok(status)
    }

    /// Checks remote MCP manifest, downloads & verifies ZIP if newer, stages it, and returns `(snapshot, newly_staged)`.
    pub async fn check_for_update(&self) -> (RuntimeStatusSnapshot, bool) {
        if !self.config.updates_enabled {
            return (self.snapshot(), false);
        }
        if let Ok(mut st) = self.status.lock() {
            st.update_state = "checking".to_string();
            st.update_error.clear();
        }

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = e.to_string();
                }
                return (self.snapshot(), false);
            }
        };

        let resp = match client.get(&self.config.feed_url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("检查更新失败（HTTP {}）", r.status().as_u16());
                }
                return (self.snapshot(), false);
            }
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("网络请求失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let remote: RuntimeUpdateManifest = match resp.json().await {
            Ok(m) => m,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("更新清单格式错误：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let expected_platform = mcp_feed_platform();
        let expected_arch = current_runtime_arch();
        if let Err(err) = validate_update_manifest(
            &remote,
            self.config.product(),
            expected_platform,
            expected_arch,
        ) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = err;
            }
            return (self.snapshot(), false);
        }

        let mut record = Self::load_active_record(&self.config.store_dir);
        record.latest_version = Some(remote.version.clone());
        record.latest_built_at = Some(remote.built_at.clone());
        let _ = self.save_active_record(&record);

        let cur_snap = self.snapshot();
        let installed_ver = if !cur_snap.version.is_empty() {
            cur_snap.version.clone()
        } else {
            self.newest_local_version().unwrap_or_default()
        };
        let installed_commit = cur_snap.commit.clone();

        let is_newer = is_version_newer(&remote.version, &installed_ver)
            || (remote.version == installed_ver
                && !installed_commit.is_empty()
                && remote.commit != installed_commit);

        if !is_newer || record.failed.as_deref() == Some(remote.sha256.as_str()) {
            if let Ok(mut st) = self.status.lock() {
                st.latest_version = remote.version;
                st.latest_built_at = remote.built_at;
                st.update_state = if record.pending.is_some() {
                    "staged".to_string()
                } else {
                    "idle".to_string()
                };
            }
            return (self.snapshot(), false);
        }

        // If already staged with the same sha256, no need to re-download
        if record.pending.as_deref() == Some(remote.sha256.as_str())
            && validate_runtime_dir(
                &self.config.store_dir.join(&remote.sha256),
                self.config.product(),
            )
            .is_ok()
        {
            if let Ok(mut st) = self.status.lock() {
                st.latest_version = remote.version.clone();
                st.latest_built_at = remote.built_at;
                st.pending_version = remote.version;
                st.update_state = "staged".to_string();
                st.update_progress = Some(100);
            }
            return (self.snapshot(), false);
        }

        if let Ok(mut st) = self.status.lock() {
            st.latest_version = remote.version.clone();
            st.latest_built_at = remote.built_at.clone();
            st.update_state = "downloading".to_string();
            st.update_progress = Some(0);
        }

        // Download archive
        let dl_resp = match client.get(&remote.url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("下载更新包失败（HTTP {}）", r.status().as_u16());
                }
                return (self.snapshot(), false);
            }
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("下载失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        let archive_bytes = match dl_resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = format!("读取更新包流失败：{e}");
                }
                return (self.snapshot(), false);
            }
        };

        if archive_bytes.len() as u64 != remote.size {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!(
                    "更新包大小不匹配（实际 {}，预期 {}）",
                    archive_bytes.len(),
                    remote.size
                );
            }
            return (self.snapshot(), false);
        }

        let actual_sha = sha256_hex(&archive_bytes);
        if !actual_sha.eq_ignore_ascii_case(&remote.sha256) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = "更新包 SHA-256 校验失败".to_string();
            }
            return (self.snapshot(), false);
        }

        let _ = fs::create_dir_all(&self.config.store_dir);
        let zip_file = self
            .config
            .store_dir
            .join(format!("download-{}.zip", remote.sha256));
        let staging_dir = self
            .config
            .store_dir
            .join(format!("staging-{}", remote.sha256));
        let final_dir = self.config.store_dir.join(&remote.sha256);

        let _ = fs::remove_dir_all(&staging_dir);
        if let Err(e) = fs::write(&zip_file, &archive_bytes) {
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!("写入临时更新包失败：{e}");
            }
            return (self.snapshot(), false);
        }

        let extract_res = extract_zip_archive(&zip_file, &staging_dir);
        let _ = fs::remove_file(&zip_file);
        if let Err(e) = extract_res {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = e;
            }
            return (self.snapshot(), false);
        }

        let extracted_manifest = match validate_runtime_dir_any(
            &staging_dir,
            &self
                .config
                .products
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ) {
            Ok(m) => m,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging_dir);
                if let Ok(mut st) = self.status.lock() {
                    st.update_state = "error".to_string();
                    st.update_error = e;
                }
                return (self.snapshot(), false);
            }
        };

        if extracted_manifest.commit != remote.commit
            || extracted_manifest.version != remote.version
        {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = "解压后的 runtime.json 版本或 commit 与清单不一致".to_string();
            }
            return (self.snapshot(), false);
        }

        let _ = fs::remove_dir_all(&final_dir);
        if let Err(e) = fs::rename(&staging_dir, &final_dir) {
            let _ = fs::remove_dir_all(&staging_dir);
            if let Ok(mut st) = self.status.lock() {
                st.update_state = "error".to_string();
                st.update_error = format!("提交更新目录失败：{e}");
            }
            return (self.snapshot(), false);
        }

        let newly_staged = record.notified.as_deref() != Some(remote.sha256.as_str());
        record.pending = Some(remote.sha256.clone());
        record.notified = Some(remote.sha256.clone());
        let _ = self.save_active_record(&record);

        if let Ok(mut st) = self.status.lock() {
            st.pending_version = remote.version;
            st.update_state = "staged".to_string();
            st.update_progress = Some(100);
            st.update_error.clear();
        }
        (self.snapshot(), newly_staged)
    }

    pub fn to_json(&self) -> Value {
        json!(self.snapshot())
    }
}

impl Drop for RuntimeSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn restart_supervisor(root: &Path, port: u16) -> RuntimeSupervisor {
        RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec!["keepwork-mcp-runtime".into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        })
    }

    #[test]
    fn restart_reclaims_orphan_desktop_process_and_preserves_foreign_owners() {
        const CHILD_ENV: &str = "AICHAT_TEST_RESTART_HEALTH_CHILD";
        if let Some(ready_path) = std::env::var_os(CHILD_ENV) {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let host = std::env::var("AICHAT_TEST_RESTART_HEALTH_HOST").unwrap();
            let ready_path = PathBuf::from(ready_path);
            let ready_temp = ready_path.with_extension("tmp");
            fs::write(
                &ready_temp,
                listener.local_addr().unwrap().port().to_string(),
            )
            .unwrap();
            fs::rename(ready_temp, ready_path).unwrap();
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let mut body = serde_json::json!({
                    "name": "keepwork-mcp", "pid": std::process::id(),
                    "hostKind": host, "runtimeVersion": "0.1.0", "runtimeEngine": "rust"
                });
                if host == "legacy-owned" {
                    body.as_object_mut().unwrap().remove("hostKind");
                }
                let body = body.to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = stream.write_all(response.as_bytes());
            }
            return;
        }

        struct FixtureChild(Option<Child>);
        impl Drop for FixtureChild {
            fn drop(&mut self) {
                if let Some(child) = self.0.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for host in ["rust-node-runtime", "legacy-owned", "vscode-extension", "local-helper", "unknown-host"] {
                let root = std::env::temp_dir().join(format!("aichat-restart-{}", Uuid::new_v4()));
                fs::create_dir_all(&root).unwrap();
                let ready_path = root.join("ready-port");
                let mut command = Command::new(std::env::current_exe().unwrap());
                command.args([
                    "--exact",
                    "runtime::tests::restart_reclaims_orphan_desktop_process_and_preserves_foreign_owners",
                    "--nocapture",
                ]).env(CHILD_ENV, &ready_path)
                    .env("AICHAT_TEST_RESTART_HEALTH_HOST", host)
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let mut child = FixtureChild(Some(command.spawn().unwrap()));
                let deadline = Instant::now() + Duration::from_secs(10);
                while !ready_path.exists() {
                    assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none(), "health fixture exited before readiness");
                    assert!(Instant::now() < deadline, "health fixture did not become ready");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let port = fs::read_to_string(&ready_path).unwrap().parse::<u16>().unwrap();
                let supervisor = restart_supervisor(&root, port);
                assert!(supervisor.child.lock().unwrap().is_none());
                let child_pid = child.0.as_ref().unwrap().id();
                assert_eq!(supervisor.probe_health().await.unwrap().pid, child_pid);
                if host == "legacy-owned" {
                    assert!(supervisor.probe_health().await.unwrap().host_kind.is_empty());
                    *supervisor.child.lock().unwrap() = child.0.take();
                }
                let stopped = supervisor.stop_for_restart().await;
                if host == "rust-node-runtime" || host == "legacy-owned" {
                    stopped.expect("a verified orphan desktop runtime must be stopped");
                    let deadline = Instant::now() + Duration::from_secs(3);
                    if let Some(child) = child.0.as_mut() {
                        while child.try_wait().unwrap().is_none() {
                            assert!(Instant::now() < deadline, "orphan runtime remains alive");
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    }
                    assert!(supervisor.child.lock().unwrap().is_none());
                    assert!(supervisor.probe_health().await.is_none());
                    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(), "restart must release the listening port");
                } else {
                    assert!(stopped.is_err(), "external ownership must reject restart: {host}");
                    assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none(), "foreign runtime must stay alive: {host}");
                    assert_eq!(supervisor.probe_health().await.unwrap().pid, child_pid);
                }
                drop(child);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn restart_reports_failed_start_instead_of_success_when_runtime_is_missing() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root =
                std::env::temp_dir().join(format!("aichat-restart-missing-{}", Uuid::new_v4()));
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let supervisor = restart_supervisor(&root, port);
            let error = supervisor
                .restart()
                .await
                .expect_err("missing runtime must fail restart");
            assert!(!error.is_empty());
            assert_eq!(supervisor.snapshot().state, "error");
        });
    }

    #[test]
    fn loopback_health_ignores_proxy_environment() {
        const CHILD_ENV: &str = "AICHAT_TEST_HEALTH_PROXY_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = listener.local_addr().unwrap().port();
                let health = tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = [0u8; 4096];
                    stream.read(&mut request).await.unwrap();
                    let body = r#"{"name":"keepwork-mcp","pid":123,"runtimeVersion":"fixture","hostKind":"vscode-extension"}"#;
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
                // Prove this process really has a proxy that would reject health checks.
                if std::env::var(CHILD_ENV).unwrap() == "proxy" {
                    let ordinary = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
                    let rejected = ordinary.get(format!("http://127.0.0.1:{port}/health")).send().await.unwrap();
                    assert_eq!(rejected.status(), reqwest::StatusCode::BAD_GATEWAY);
                }
                let root = std::env::temp_dir().join(format!("aichat-health-{}", Uuid::new_v4()));
                let supervisor = RuntimeSupervisor::new(RuntimeConfig {
                    id: "mcp".into(), products: vec!["keepwork-mcp-runtime".into()],
                    port, health_path: "/health".into(), updates_enabled: false,
                    bundled_dir: root.join("bundle"), store_dir: root.join("store"), feed_url: String::new(),
                });
                let probe = supervisor.probe_health().await.expect("loopback health must bypass the rejecting proxy");
                assert!(probe.compatible, "legacy health without optional fsApi remains supported");
                assert_eq!(probe.pid, 123);
                assert_eq!(probe.runtime_version, "fixture");
                assert_eq!(probe.host_kind, "vscode-extension");
                health.await.unwrap();
                assert!(supervisor.probe_health().await.is_none(), "a stopped daemon remains offline even with a proxy configured");
            });
            return;
        }

        // Give only the child process hostile proxy settings; parallel tests keep
        // their original environment and never share process-global mutations.
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicBool, Ordering};
        let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        proxy.set_nonblocking(true).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let proxy_done = Arc::clone(&done);
        let proxy_thread = std::thread::spawn(move || {
            while !proxy_done.load(Ordering::Relaxed) {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        // Accepted sockets inherit O_NONBLOCK on BSD, so the
                        // request would be dropped before the 502 is written.
                        let _ = stream.set_nonblocking(false);
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0u8; 4096];
                        // Drain the complete request headers before closing;
                        // unread TCP data can turn the fixture's 502 into a reset.
                        let mut used = 0;
                        while used < request.len() {
                            match stream.read(&mut request[used..]) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => used += n,
                            }
                            if request[..used].windows(4).any(|v| v == b"\r\n\r\n") {
                                break;
                            }
                        }
                        let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("proxy fixture failed: {e}"),
                }
            }
        });
        let mut results = Vec::new();
        for mode in ["proxy", "direct"] {
            let mut child = Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "runtime::tests::loopback_health_ignores_proxy_environment",
                    "--nocapture",
                ])
                .env(CHILD_ENV, mode)
                .env("NO_PROXY", if mode == "direct" { "*" } else { "" })
                .env("no_proxy", if mode == "direct" { "*" } else { "" });
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                if mode == "proxy" {
                    child.env(key, &proxy_url);
                } else {
                    child.env_remove(key);
                }
            }
            results.push((mode, child.output()));
        }
        done.store(true, Ordering::Relaxed);
        proxy_thread.join().unwrap();
        for (mode, output) in results {
            let output = output.unwrap();
            assert!(
                output.status.success(),
                "isolated {mode} health check failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "the child must actually execute the regression test"
            );
        }
    }

    #[test]
    fn staged_node_bundle_is_readable_by_rust_on_macos_and_windows() {
        let root = std::env::temp_dir().join(format!("node-stage-contract-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bundler =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/bundle-mcp-runtime.cjs");
        // Consume the actual JS bundler's artifact, rather than duplicating its
        // normalized manifest in a Rust-only fixture. No runtime is launched.
        let output = Command::new("node")
            .args(["-e", r#"
const fs=require('node:fs'),path=require('node:path');
const bundler=require(process.argv[1]),base=process.argv[2];
const {createRuntimeManifest}=require(path.resolve(path.dirname(process.argv[1]),'../../mcp-runtime/scripts/stage-runtime.cjs'));
for(const [target,platform,arch,node] of [
 ['aarch64-apple-darwin','macos','arm64','bin/node'],
 ['x86_64-pc-windows-msvc','windows','x64','node.exe']
]){
 const root=path.join(base,platform),stage=path.join(root,'staging',platform+'-'+arch);
 for(const file of [node,'app/cli.cjs']){fs.mkdirSync(path.dirname(path.join(stage,file)),{recursive:true});fs.writeFileSync(path.join(stage,file),'fixture');}
 fs.writeFileSync(path.join(stage,'app/package.json'),JSON.stringify({version:'0.1.52',commit:'a'.repeat(40)}));
 const canonical=path.join(root,'canonical');fs.cpSync(stage,canonical,{recursive:true});
 fs.writeFileSync(path.join(canonical,'runtime.json'),JSON.stringify(createRuntimeManifest({runtimePackage:{version:'0.1.52',commit:'a'.repeat(40)},nodeVersion:'22.23.2',target:{platform,arch}})));
 fs.writeFileSync(path.join(stage,'runtime.json'),JSON.stringify({schemaVersion:1,product:'keepwork-mcp-node-runtime',version:'0.1.52',platform,arch,entry:'app/cli.cjs'}));
 bundler.bundle({root:path.join(root,'staging'),out:path.join(root,'out'),target,require:true,sourceChanged:()=>false});
}
"#])
            .arg(&bundler)
            .arg(&root)
            .env_remove("AICHAT_MCP_RUNTIME_DIR")
            .output()
            .expect("Node is required for the staged-runtime artifact regression");
        assert!(
            output.status.success(),
            "JS artifact generation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        for (platform, arch, node) in [
            ("macos", "arm64", "bin/node"),
            ("windows", "x64", "node.exe"),
        ] {
            let staged = root.join(platform).join("canonical");
            let fresh = validate_runtime_dir(&staged, "keepwork-mcp-node-runtime").unwrap();
            assert_eq!(fresh.commit, "a".repeat(40));
            assert_eq!(fresh.node, node);
            assert_eq!(fresh.engine, "node");
            let bundled = root.join(platform).join("out").join(arch);
            let parsed = validate_runtime_dir(&bundled, "keepwork-mcp-node-runtime").unwrap();
            assert_eq!(parsed.commit, "a".repeat(40));
            assert_eq!(parsed.engine, "node");
            assert_eq!(parsed.node, node);
            assert!(!parsed.is_rust());
            let manifest_file = bundled.join("runtime.json");
            let mut missing: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&manifest_file).unwrap()).unwrap();
            missing.as_object_mut().unwrap().remove("commit");
            fs::write(&manifest_file, serde_json::to_vec(&missing).unwrap()).unwrap();
            assert!(validate_runtime_dir(&bundled, "keepwork-mcp-node-runtime")
                .unwrap_err()
                .contains("commit"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_a_rust_runtime_manifest_without_a_node_binary() {
        let root = std::env::temp_dir().join(format!("aichat-rust-rt-rust-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/keepwork-mcp"), b"bin").unwrap();
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "product": "keepwork-mcp-runtime",
            "engine": "rust",
            "version": "0.1.0",
            "commit": "b".repeat(40),
            "platform": "macos",
            "arch": "arm64",
            "entry": "bin/keepwork-mcp",
            "args": ["--port", "8089"],
            "env": {},
        });
        fs::write(
            root.join("runtime.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let parsed = validate_runtime_dir_any(&root, &["keepwork-mcp-runtime"]).unwrap();
        assert!(parsed.is_rust());
        assert_eq!(parsed.entry, "bin/keepwork-mcp");
        // The Node product must not accept a Rust runtime, and vice versa.
        assert!(validate_runtime_dir(&root, "keepwork-mcp-node-runtime").is_err());
        assert!(validate_runtime_dir_any(
            &root,
            &["keepwork-mcp-runtime", "keepwork-mcp-node-runtime"]
        )
        .is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip64_and_descriptor_archives_extract_without_shell_tools() {
        for descriptor in [false, true] {
            let root = std::env::temp_dir().join(format!("zip-contract-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o755)
                .large_file(!descriptor);
            writer.start_file("bin/keepwork-mcp", options).unwrap();
            writer.write_all(b"runtime fixture").unwrap();
            let mut bytes = writer.finish().unwrap().into_inner();
            if descriptor {
                let cd = bytes.windows(4).position(|v| v == b"PK\x01\x02").unwrap();
                let mut data_descriptor = b"PK\x07\x08".to_vec();
                data_descriptor.extend_from_slice(&bytes[14..26]);
                bytes[6] |= 8;
                bytes[14..26].fill(0);
                bytes[cd + 8] |= 8;
                bytes.splice(cd..cd, data_descriptor);
                let end = bytes.len() - 22;
                bytes[end + 16..end + 20].copy_from_slice(&((cd + 16) as u32).to_le_bytes());
            }
            let archive = root.join("runtime.zip");
            fs::write(&archive, bytes).unwrap();
            extract_zip_archive(&archive, &root.join("out")).unwrap();
            let binary = root.join("out/bin/keepwork-mcp");
            assert_eq!(fs::read(&binary).unwrap(), b"runtime fixture");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn zip_paths_cannot_escape_extraction_root() {
        let root = std::env::temp_dir().join(format!("zip-paths-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"outside").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        fs::write(root.join("bad.zip"), bytes).unwrap();
        assert!(extract_zip_archive(&root.join("bad.zip"), &root.join("out")).is_err());
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_and_extracts_zip_and_validates_runtime_manifest() {
        let root = std::env::temp_dir().join(format!("aichat-rust-rt-{}", Uuid::new_v4()));
        let src_dir = root.join("src_rt");
        fs::create_dir_all(src_dir.join("bin")).unwrap();
        fs::write(src_dir.join("bin/node"), "#!/bin/sh\n").unwrap();
        fs::write(src_dir.join("cli.js"), "console.log('ok');\n").unwrap();

        let commit = "a".repeat(40);
        let manifest = RuntimeManifest {
            product: "keepwork-mcp-node-runtime".to_string(),
            engine: "node".to_string(),
            platform: current_runtime_platform().to_string(),
            arch: current_runtime_arch().to_string(),
            version: "0.2.88".to_string(),
            commit: commit.clone(),
            built_at: "2026-11-09T00:00:00Z".to_string(),
            node: "bin/node".to_string(),
            entry: "cli.js".to_string(),
            args: vec![],
            env: Default::default(),
        };
        fs::write(
            src_dir.join("runtime.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let zip_path = root.join("package.zip");
        create_zip_from_dir(&src_dir, &zip_path).unwrap();

        let out_dir = root.join("extracted");
        extract_zip_archive(&zip_path, &out_dir).unwrap();

        let validated = validate_runtime_dir(&out_dir, "keepwork-mcp-node-runtime").unwrap();
        assert_eq!(validated.version, "0.2.88");
        assert_eq!(validated.commit, commit);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn runtime_manifest_defaults_missing_node_to_bundled_node_binary() {
        let raw = r#"{
            "product": "keepwork-mcp-node-runtime",
            "platform": "macos",
            "arch": "arm64",
            "version": "0.1.44",
            "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "entry": "app/cli.cjs"
        }"#;
        let manifest: RuntimeManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(
            manifest.node,
            if cfg!(target_os = "windows") {
                "bin/node.exe"
            } else {
                "bin/node"
            }
        );
    }

    #[test]
    fn mcp_feed_platform_uses_published_artifact_names() {
        #[cfg(target_os = "macos")]
        {
            assert_eq!(current_runtime_platform(), "darwin");
            assert_eq!(mcp_feed_platform(), "macos");
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(current_runtime_platform(), "win32");
            assert_eq!(mcp_feed_platform(), "windows");
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(mcp_feed_platform(), "linux");
    }

    #[test]
    fn update_manifest_accepts_published_mcp_platform() {
        let manifest = RuntimeUpdateManifest {
            schema_version: 1,
            product: "keepwork-mcp-node-runtime".to_string(),
            platform: mcp_feed_platform().to_string(),
            arch: current_runtime_arch().to_string(),
            version: "0.1.44".to_string(),
            commit: "a".repeat(40),
            built_at: "2026-11-09T00:00:00Z".to_string(),
            url: "https://cdn.keepwork.com/keepwork/mcp-stable/0.1.44/macos-arm64.zip".to_string(),
            sha256: "b".repeat(64),
            size: 1024,
        };
        assert!(validate_update_manifest(
            &manifest,
            "keepwork-mcp-node-runtime",
            mcp_feed_platform(),
            current_runtime_arch(),
        )
        .is_ok());

        #[cfg(target_os = "macos")]
        {
            let mut wrong = manifest.clone();
            wrong.platform = current_runtime_platform().to_string();
            assert!(validate_update_manifest(
                &wrong,
                "keepwork-mcp-node-runtime",
                mcp_feed_platform(),
                current_runtime_arch(),
            )
            .is_err());
        }
    }

    #[test]
    fn rust_mcp_start_waits_one_minute_and_stops_after_five_attempts() {
        assert_eq!(rust_start_retry(0, None), RustStartRetry::Allow);
        assert_eq!(
            rust_start_retry(1, Some(Duration::from_secs(59))),
            RustStartRetry::Wait
        );
        assert_eq!(
            rust_start_retry(1, Some(Duration::from_secs(60))),
            RustStartRetry::Allow
        );
        assert_eq!(
            rust_start_retry(4, Some(Duration::from_secs(60))),
            RustStartRetry::Allow
        );
        assert_eq!(
            rust_start_retry(5, Some(Duration::from_secs(60))),
            RustStartRetry::Stop
        );
        assert_eq!(rust_start_retry(5, None), RustStartRetry::Stop);
        assert!(rust_start_retry_suffix(1).contains("1/5"));
        assert!(rust_start_retry_suffix(4).contains("4/5"));
        assert!(rust_start_retry_suffix(5).contains("停止自动重试"));

        let root = std::env::temp_dir().join(format!("aichat-rust-mcp-retry-{}", Uuid::new_v4()));
        // A port that was just released refuses the health probe immediately.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec!["keepwork-mcp-runtime".into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("missing"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let first = supervisor.ensure_started(false).await;
            assert_eq!(first.state, "error");
            assert!(
                first.error.contains("1/5"),
                "first rust start failure should schedule one retry: {}",
                first.error
            );
            let second = supervisor.ensure_started(false).await;
            assert_eq!(
                second.error, first.error,
                "a second call inside the same minute must not consume another attempt"
            );
            assert_eq!(supervisor.rust_start_failures.load(Ordering::Relaxed), 1);

            supervisor
                .rust_start_failures
                .store(RUST_MCP_MAX_START_ATTEMPTS, Ordering::Relaxed);
            let stopped = supervisor.ensure_started(false).await;
            assert_eq!(stopped.error, first.error);
            assert_eq!(
                supervisor.rust_start_failures.load(Ordering::Relaxed),
                RUST_MCP_MAX_START_ATTEMPTS
            );

            supervisor.clear_rust_start_retries();
            let restarted = supervisor.ensure_started(false).await;
            assert!(
                restarted.error.contains("1/5"),
                "a manual retry clears the cap: {}",
                restarted.error
            );
        });

        let node = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec!["keepwork-mcp-node-runtime".into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("missing-node"),
            store_dir: root.join("store-node"),
            feed_url: String::new(),
        });
        runtime.block_on(async {
            let failed = node.ensure_started(false).await;
            assert_eq!(failed.state, "error");
            assert!(
                !failed.error.contains("1/5"),
                "node runtime keeps the existing restart policy: {}",
                failed.error
            );
            assert_eq!(node.rust_start_failures.load(Ordering::Relaxed), 0);
        });
        let _ = std::fs::remove_dir_all(&root);
    }
}
