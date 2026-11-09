use crate::files::{atomic_json_write, inside, validate_relative_path};
use flate2::read::DeflateDecoder;
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
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MCP_PORT: u16 = 8089;
pub const LOCAL_MODEL_PORT: u16 = 18089;
pub const DEFAULT_MCP_FEED_BASE: &str = "https://cdn.keepwork.com/keepwork/mcp-stable";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub product: String,
    pub platform: String,
    pub arch: String,
    pub version: String,
    pub commit: String,
    #[serde(default)]
    pub built_at: String,
    pub node: String,
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
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
    let manifest_path = dir.join("runtime.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Missing runtime.json in {}: {e}", dir.display()))?;
    let manifest: RuntimeManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid runtime.json in {}: {e}", dir.display()))?;

    if manifest.product != expected_product {
        return Err(format!(
            "Runtime product mismatch: expected {expected_product}, got {}",
            manifest.product
        ));
    }
    if parse_semver(&manifest.version).is_none() {
        return Err(format!("Invalid runtime semver: {}", manifest.version));
    }
    if !is_valid_hex(&manifest.commit, 40) {
        return Err("Invalid 40-char commit in runtime.json".to_string());
    }

    let node_rel = validate_relative_path(&manifest.node)?;
    let entry_rel = validate_relative_path(&manifest.entry)?;
    let node_path = dir.join(node_rel);
    let entry_path = dir.join(entry_rel);
    if !inside(dir, &node_path) || !inside(dir, &entry_path) {
        return Err("Runtime executable or entry escapes runtime directory".to_string());
    }
    if !node_path.is_file() {
        return Err(format!("Missing runtime node binary: {}", node_path.display()));
    }
    if !entry_path.is_file() {
        return Err(format!("Missing runtime entry script: {}", entry_path.display()));
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

/// Pure-Rust ZIP extractor supporting Stored (0) and Deflate (8) entries with path traversal confinement,
/// plus system `unzip` / `Expand-Archive` fallback.
pub fn extract_zip_archive(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    let bytes = fs::read(zip_path).map_err(|e| format!("Failed to read zip archive: {e}"))?;
    if extract_zip_bytes(&bytes, dest_dir).is_ok() {
        return Ok(());
    }

    // Fallback to OS tools if the archive uses Zip64 or data descriptors
    #[cfg(target_os = "windows")]
    {
        let zip_escaped = zip_path.to_string_lossy().replace('\'', "''");
        let dest_escaped = dest_dir.to_string_lossy().replace('\'', "''");
        let status = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{zip_escaped}' -DestinationPath '{dest_escaped}' -Force"
                ),
            ])
            .status()
            .map_err(|e| format!("Failed to run Expand-Archive: {e}"))?;
        if !status.success() {
            return Err("Expand-Archive failed to extract update ZIP".to_string());
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("unzip")
            .args([
                "-oq",
                &zip_path.to_string_lossy(),
                "-d",
                &dest_dir.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("Failed to run unzip: {e}"))?;
        if !status.success() {
            return Err("unzip failed to extract update ZIP".to_string());
        }
        Ok(())
    }
}

pub fn extract_zip_bytes(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    let mut pos = 0usize;
    let mut extracted_any = false;
    while pos + 4 <= bytes.len() {
        let sig = &bytes[pos..pos + 4];
        if sig == b"PK\x01\x02" || sig == b"PK\x05\x06" {
            break;
        }
        if sig != b"PK\x03\x04" {
            return Err("Invalid ZIP local file header signature".to_string());
        }
        if pos + 30 > bytes.len() {
            return Err("Truncated ZIP local file header".to_string());
        }
        let flags = u16::from_le_bytes([bytes[pos + 6], bytes[pos + 7]]);
        if (flags & 0x08) != 0 {
            return Err("ZIP data descriptor requires fallback extractor".to_string());
        }
        let method = u16::from_le_bytes([bytes[pos + 8], bytes[pos + 9]]);
        let comp_size = u32::from_le_bytes([
            bytes[pos + 18],
            bytes[pos + 19],
            bytes[pos + 20],
            bytes[pos + 21],
        ]) as usize;
        let name_len = u16::from_le_bytes([bytes[pos + 26], bytes[pos + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[pos + 28], bytes[pos + 29]]) as usize;
        let header_end = pos + 30 + name_len + extra_len;
        let data_end = header_end + comp_size;
        if data_end > bytes.len() {
            return Err("Truncated ZIP entry payload".to_string());
        }
        let raw_name = std::str::from_utf8(&bytes[pos + 30..pos + 30 + name_len])
            .map_err(|_| "Non-UTF8 ZIP entry name".to_string())?;
        let is_dir = raw_name.ends_with('/') || raw_name.ends_with('\\');
        let clean_rel = validate_relative_path(raw_name.trim_end_matches(['/', '\\']))?;
        if !clean_rel.as_os_str().is_empty() {
            let out_path = dest_dir.join(&clean_rel);
            if !inside(dest_dir, &out_path) {
                return Err("ZIP entry escapes destination directory".to_string());
            }
            if is_dir {
                fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Failed to create directory: {e}"))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent dir: {e}"))?;
                }
                let comp_data = &bytes[header_end..data_end];
                let decompressed = match method {
                    0 => comp_data.to_vec(),
                    8 => {
                        let mut decoder = DeflateDecoder::new(Cursor::new(comp_data));
                        let mut out = Vec::new();
                        decoder
                            .read_to_end(&mut out)
                            .map_err(|e| format!("Deflate decompression failed: {e}"))?;
                        out
                    }
                    _ => return Err(format!("Unsupported ZIP compression method: {method}")),
                };
                fs::write(&out_path, &decompressed)
                    .map_err(|e| format!("Failed to write extracted file: {e}"))?;
                #[cfg(unix)]
                {
                    if out_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|n| n == "node" || n.ends_with(".sh"))
                        .unwrap_or(false)
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755));
                    }
                }
                extracted_any = true;
            }
        }
        pos = data_end;
    }
    if !extracted_any {
        return Err("ZIP archive contained no files".to_string());
    }
    Ok(())
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
    pub product: String,
    pub port: u16,
    pub health_path: String,
    pub updates_enabled: bool,
    pub bundled_dir: PathBuf,
    pub store_dir: PathBuf,
    pub feed_url: String,
}

#[derive(Debug, Clone)]
pub struct HealthProbeResult {
    pub compatible: bool,
    pub pid: u32,
    pub runtime_version: String,
    pub host_kind: String,
}

pub struct RuntimeSupervisor {
    config: RuntimeConfig,
    status: Arc<Mutex<RuntimeStatusSnapshot>>,
    child: Mutex<Option<Child>>,
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
            if let Ok(m) = validate_runtime_dir(&config.store_dir.join(pending_hash), &config.product) {
                snap.pending_version = m.version;
                snap.update_state = "staged".to_string();
            }
        }
        Self {
            config,
            status: Arc::new(Mutex::new(snap)),
            child: Mutex::new(None),
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
    pub fn select_best_local_runtime(&self, promote_pending: bool) -> Option<(PathBuf, RuntimeManifest, Option<String>)> {
        let mut record = Self::load_active_record(&self.config.store_dir);
        let bundled = validate_runtime_dir(&self.config.bundled_dir, &self.config.product).ok();

        if promote_pending {
            if let Some(pending_hash) = record.pending.clone() {
                if record.failed.as_deref() != Some(pending_hash.as_str()) {
                    let pending_dir = self.config.store_dir.join(&pending_hash);
                    if let Ok(m) = validate_runtime_dir(&pending_dir, &self.config.product) {
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
                if let Ok(m) = validate_runtime_dir(&current_dir, &self.config.product) {
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
                if best.as_deref().map(|b| is_version_newer(v, b)).unwrap_or(true) {
                    best = Some(v.to_string());
                }
            }
        };
        if let Ok(m) = validate_runtime_dir(&self.config.bundled_dir, &self.config.product) {
            consider(&m.version);
        }
        for hash in [record.current.as_deref(), record.pending.as_deref()]
            .into_iter()
            .flatten()
        {
            if record.failed.as_deref() != Some(hash) {
                if let Ok(m) = validate_runtime_dir(&self.config.store_dir.join(hash), &self.config.product) {
                    consider(&m.version);
                }
            }
        }
        best
    }

    pub async fn probe_health(&self) -> Option<HealthProbeResult> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1200))
            .build()
            .ok()?;
        let url = format!("http://127.0.0.1:{}{}", self.config.port, self.config.health_path);
        let resp = client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body = resp.json::<Value>().await.ok()?;
        let compatible = if self.config.id == "mcp" {
            body.get("name").and_then(|v| v.as_str()) == Some("keepwork-mcp")
                && body.get("fsApi").and_then(|v| v.as_str()) == Some("workspace")
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
        let host_kind = body
            .get("hostKind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Some(HealthProbeResult {
            compatible,
            pid,
            runtime_version,
            host_kind,
        })
    }

    fn classify_owner(host_kind: &str) -> &'static str {
        match host_kind {
            "rust-node-runtime" | "tauri-node-runtime" | "electron-node-runtime" | "desktop" => "desktop",
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
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }
    }

    pub async fn ensure_started(&self, promote_pending: bool) -> RuntimeStatusSnapshot {
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
            let should_takeover = self.config.id == "mcp"
                && probe.pid > 0
                && !probe.runtime_version.is_empty()
                && self
                    .newest_local_version()
                    .as_deref()
                    .map(|local_v| is_version_newer(local_v, &probe.runtime_version))
                    .unwrap_or(false);

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
                    st.state = if owner == "desktop" { "running" } else { "attached" }.to_string();
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
                return self.snapshot();
            }
        }

        // 2. Spawn our local runtime
        let Some((runtime_dir, manifest, staged_hash)) =
            self.select_best_local_runtime(promote_pending)
        else {
            if let Ok(mut st) = self.status.lock() {
                st.state = "error".to_string();
                st.error = format!("未找到可用的本地运行时（{}）", self.config.product);
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
                self.snapshot()
            }
            Err(err) => {
                // If a promoted staged runtime failed to start, mark it failed and roll back to bundled
                if let Some(failed_hash) = staged_hash {
                    let mut record = Self::load_active_record(&self.config.store_dir);
                    record.failed = Some(failed_hash);
                    record.current = None;
                    let _ = self.save_active_record(&record);
                    if let Ok(bundled_manifest) =
                        validate_runtime_dir(&self.config.bundled_dir, &self.config.product)
                    {
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
                            return self.snapshot();
                        }
                    }
                }
                if let Ok(mut st) = self.status.lock() {
                    st.state = "error".to_string();
                    st.error = err;
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

        let node_path = runtime_dir.join(&manifest.node);
        let entry_path = runtime_dir.join(&manifest.entry);
        let mut cmd = Command::new(&node_path);
        cmd.current_dir(runtime_dir)
            .arg(&entry_path)
            .args(&manifest.args)
            .envs(&manifest.env)
            .env("KEEPWORK_MCP_HOST_KIND", "rust-node-runtime")
            .env("KEEPWORK_MCP_RUNTIME_VERSION", &manifest.version)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn {}: {e}", node_path.display()))?;
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
                let _ = child.wait();
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

    pub async fn restart(&self) -> Result<RuntimeStatusSnapshot, String> {
        let snap = self.snapshot();
        if snap.state == "attached" && snap.owner != "desktop" {
            return Err(format!(
                "当前本地服务由 {} 管理，桌面端不能直接重启它",
                snap.owner
            ));
        }
        self.stop_owned_process();
        Ok(self.ensure_started(false).await)
    }

    pub async fn apply_staged_update(&self) -> Result<RuntimeStatusSnapshot, String> {
        let snap = self.snapshot();
        if snap.state == "attached" && snap.owner != "desktop" {
            return Err(format!(
                "当前本地 MCP 服务由 {} 管理，请先关闭外部服务后再应用更新",
                snap.owner
            ));
        }
        let record = Self::load_active_record(&self.config.store_dir);
        if record.pending.is_none() {
            return Err("当前没有待应用的 MCP 更新".to_string());
        }
        self.stop_owned_process();
        Ok(self.ensure_started(true).await)
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

        let expected_platform = current_runtime_platform();
        let expected_arch = current_runtime_arch();
        if let Err(err) = validate_update_manifest(
            &remote,
            &self.config.product,
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
                &self.config.product,
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

        let extracted_manifest = match validate_runtime_dir(&staging_dir, &self.config.product) {
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

        if extracted_manifest.commit != remote.commit || extracted_manifest.version != remote.version
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
}
