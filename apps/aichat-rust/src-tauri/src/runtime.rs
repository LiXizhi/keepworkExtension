//! Supervision and safe ownership of the desktop application's local runtimes.

mod archive;
mod manifest;
mod staged_update;

pub use archive::{create_zip_from_dir, extract_zip_archive, extract_zip_bytes, sha256_hex};
pub use manifest::{
    current_runtime_arch, current_runtime_platform, is_valid_hex, is_version_newer,
    mcp_feed_platform, parse_semver, validate_runtime_dir, validate_runtime_dir_any,
    validate_staged_runtime, validate_update_manifest, validate_update_url, ActiveRuntimeRecord,
    RuntimeManifest, RuntimeStatusSnapshot, RuntimeUpdateManifest,
};

use crate::files::atomic_json_write;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MCP_PORT: u16 = 8089;
pub const LOCAL_MODEL_PORT: u16 = 18089;
pub const DEFAULT_MCP_FEED_BASE: &str = "https://cdn.keepwork.com/keepwork/mcp-stable";
pub const DEFAULT_RUST_MCP_FEED_BASE: &str = "https://cdn.keepwork.com/keepwork/mcp-stable-rs";

pub fn default_mcp_feed_url(rust: bool) -> String {
    let base = if rust {
        DEFAULT_RUST_MCP_FEED_BASE
    } else {
        DEFAULT_MCP_FEED_BASE
    };
    format!(
        "{base}/{}-{}.json",
        mcp_feed_platform(),
        current_runtime_arch()
    )
}

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
    pub runtime_commit: String,
    pub runtime_built_at: String,
    pub runtime_engine: String,
    pub host_kind: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingPolicy {
    Ignore,
    UpgradeOnly,
    Explicit,
}

enum RuntimeStartError {
    PortUnavailable(String),
    CandidateFailed(String),
}

pub struct RuntimeSupervisor {
    config: RuntimeConfig,
    status: Arc<Mutex<RuntimeStatusSnapshot>>,
    child: Mutex<Option<Child>>,
    lifecycle: tokio::sync::Mutex<()>,
    update_operation: tokio::sync::Mutex<()>,
    /// Consecutive Rust MCP launch failures since the last healthy start or manual restart.
    rust_start_failures: AtomicU32,
    rust_start_failed_at: Mutex<Option<Instant>>,
}

impl RuntimeSupervisor {
    pub fn new(config: RuntimeConfig) -> Self {
        let mut snap = RuntimeStatusSnapshot::initial(&config.id, config.port);
        snap.engine = if config.product() == RUST_MCP_PRODUCT {
            "rust"
        } else {
            "node"
        }
        .into();
        let record = Self::load_active_record(&config.store_dir);
        if let Some(v) = record.latest_version {
            snap.latest_version = v;
        }
        if let Some(b) = record.latest_built_at {
            snap.latest_built_at = b;
        }
        let supervisor = Self {
            config,
            status: Arc::new(Mutex::new(snap)),
            child: Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            update_operation: tokio::sync::Mutex::new(()),
            rust_start_failures: AtomicU32::new(0),
            rust_start_failed_at: Mutex::new(None),
        };
        if let Some(hash) = record.pending.as_deref() {
            let mut status = supervisor.status.lock().unwrap();
            match supervisor.cached_runtime(hash) {
                Ok(manifest) if record.failed.as_deref() != Some(hash) => {
                    status.pending_version = manifest.version;
                    status.update_state = "staged".into();
                }
                Err(error) => {
                    status.update_state = "error".into();
                    status.update_error = format!("待更新运行时校验失败，已保留可用版本：{error}");
                }
                _ => {}
            }
        }
        supervisor
    }

    fn configured_rust_mcp(&self) -> bool {
        self.config.id == "mcp" && self.config.product() == RUST_MCP_PRODUCT
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
        self.select_local_runtime(if promote_pending {
            PendingPolicy::UpgradeOnly
        } else {
            PendingPolicy::Ignore
        })
    }

    fn selected_runtime(&self, directory: &Path) -> Result<RuntimeManifest, String> {
        let manifest = validate_runtime_dir(directory, self.config.product())?;
        let expected_engine = if self.config.product() == RUST_MCP_PRODUCT {
            "rust"
        } else {
            "node"
        };
        if self.config.id == "mcp" && !manifest.engine.eq_ignore_ascii_case(expected_engine) {
            return Err("Runtime engine does not match the selected product".into());
        }
        Ok(manifest)
    }

    fn cached_runtime(&self, hash: &str) -> Result<RuntimeManifest, String> {
        let directory = self.config.store_dir.join(hash);
        let manifest = self.selected_runtime(&directory)?;
        if manifest.is_rust() {
            let receipt = directory.join(".update-manifest.json");
            if receipt.exists() {
                let saved: Value = serde_json::from_slice(
                    &fs::read(receipt).map_err(|_| "Could not read cached update identity")?,
                )
                .map_err(|_| "Invalid cached update identity")?;
                let feed: RuntimeUpdateManifest = serde_json::from_value(saved.clone())
                    .map_err(|_| "Invalid cached update identity")?;
                validate_update_manifest(
                    &feed,
                    self.config.product(),
                    mcp_feed_platform(),
                    current_runtime_arch(),
                )?;
                if !feed.sha256.eq_ignore_ascii_case(hash) {
                    return Err("Cached update identity does not match its directory".into());
                }
                let digest = saved["binarySha256"]
                    .as_str()
                    .filter(|digest| is_valid_hex(digest, 64))
                    .ok_or("Cached native update has no verified binary digest")?;
                if !sha256_hex(
                    &fs::read(directory.join(&manifest.entry))
                        .map_err(|_| "Could not read cached native binary")?,
                )
                .eq_ignore_ascii_case(digest)
                {
                    return Err("Cached native binary SHA-256 verification failed".into());
                }
                return validate_staged_runtime(&directory, &feed);
            }
            let raw: Value = serde_json::from_slice(
                &fs::read(directory.join("runtime.json")).map_err(|_| "Missing cached runtime")?,
            )
            .map_err(|_| "Invalid cached runtime")?;
            // Earlier Node and legacy native caches have no new receipt. Their
            // historical format remains usable; v2 native metadata can still
            // verify the compiled binary instead of trusting its filename.
            if raw["schemaVersion"] == 2 {
                manifest::validate_native_runtime_identity(&directory, &manifest)?;
            }
        }
        Ok(manifest)
    }

    fn select_local_runtime(
        &self,
        pending_policy: PendingPolicy,
    ) -> Option<(PathBuf, RuntimeManifest, Option<String>)> {
        let record = Self::load_active_record(&self.config.store_dir);
        let mut best = self
            .selected_runtime(&self.config.bundled_dir)
            .ok()
            .map(|manifest| (self.config.bundled_dir.clone(), manifest, None));
        if let Some(current_hash) = record.current.clone() {
            if record.failed.as_deref() != Some(current_hash.as_str()) {
                if let Ok(manifest) = self.cached_runtime(&current_hash) {
                    if best.as_ref().is_none_or(|(_, current, _)| {
                        !is_version_newer(&current.version, &manifest.version)
                    }) {
                        best = Some((
                            self.config.store_dir.join(&current_hash),
                            manifest,
                            Some(current_hash),
                        ));
                    }
                }
            }
        }
        if pending_policy != PendingPolicy::Ignore {
            if let Some(hash) = record
                .pending
                .filter(|hash| record.failed.as_ref() != Some(hash))
            {
                match self.cached_runtime(&hash) {
                    Ok(manifest) => {
                        let eligible = best.as_ref().is_none_or(|(_, current, _)| {
                            is_version_newer(&manifest.version, &current.version)
                                || (pending_policy == PendingPolicy::Explicit
                                    && parse_semver(&manifest.version)
                                        == parse_semver(&current.version))
                        });
                        if eligible {
                            best = Some((self.config.store_dir.join(&hash), manifest, Some(hash)));
                        }
                    }
                    Err(error) => {
                        if let Ok(mut status) = self.status.lock() {
                            status.update_state = "error".into();
                            status.update_error =
                                format!("待更新运行时校验失败，已保留可用版本：{error}");
                        }
                    }
                }
            }
        }
        best
    }

    pub fn newest_local_version(&self) -> Option<String> {
        self.select_local_runtime(PendingPolicy::UpgradeOnly)
            .map(|(_, manifest, _)| manifest.version)
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
        let pid = body
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .unwrap_or(0);
        let runtime_version = body
            .get("runtimeVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let runtime_engine = body
            .get("runtimeEngine")
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
            runtime_commit: body
                .get("runtimeCommit")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            runtime_built_at: body
                .get("runtimeBuiltAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
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

    fn observe_peer(&self, probe: HealthProbeResult) -> RuntimeStatusSnapshot {
        let owner = if probe.compatible {
            Self::classify_owner(&probe.host_kind)
        } else {
            "external"
        };
        if let Ok(mut status) = self.status.lock() {
            status.state = if !probe.compatible {
                "conflict"
            } else if owner == "desktop" {
                "running"
            } else {
                "attached"
            }
            .into();
            status.owner = owner.into();
            status.pid = probe.pid;
            // These fields describe only this observation, never a previous
            // PID, an installed bundle, or an assumed legacy engine.
            status.engine = probe.runtime_engine;
            status.version = probe.runtime_version;
            status.commit = probe.runtime_commit;
            status.built_at = probe.runtime_built_at;
            status.error = if probe.compatible {
                String::new()
            } else {
                format!("端口 {} 已被其他不兼容服务占用", self.config.port)
            };
        }
        self.snapshot()
    }

    async fn require_vacant_port(&self) -> Result<(), String> {
        match tokio::time::timeout(
            Duration::from_millis(1200),
            tokio::net::TcpStream::connect(("127.0.0.1", self.config.port)),
        )
        .await
        {
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
            Ok(Ok(_)) => Err(format!(
                "端口 {} 仍有服务监听，健康状态无法确认，未启动替换服务",
                self.config.port
            )),
            Ok(Err(error)) => Err(format!(
                "无法确认端口 {} 是否空闲：{error}",
                self.config.port
            )),
            Err(_) => Err(format!(
                "确认端口 {} 是否空闲超时，未启动替换服务",
                self.config.port
            )),
        }
    }

    fn report_unknown_listener(&self, error: String) -> RuntimeStatusSnapshot {
        if let Ok(mut status) = self.status.lock() {
            status.state = "conflict".into();
            status.owner = "external".into();
            status.pid = 0;
            status.engine.clear();
            status.version.clear();
            status.commit.clear();
            status.built_at.clear();
            status.error = error;
        }
        self.snapshot()
    }

    async fn observe_busy_port(&self) -> Option<RuntimeStatusSnapshot> {
        let error = self.require_vacant_port().await.err()?;
        Some(if let Some(probe) = self.probe_health().await {
            self.observe_peer(probe)
        } else {
            self.report_unknown_listener(error)
        })
    }

    pub async fn ensure_started(&self, promote_pending: bool) -> RuntimeStatusSnapshot {
        let _operation = self.lifecycle.lock().await;
        self.ensure_started_inner(promote_pending).await
    }

    async fn ensure_started_inner(&self, promote_pending: bool) -> RuntimeStatusSnapshot {
        self.ensure_started_with_policy(if promote_pending {
            PendingPolicy::UpgradeOnly
        } else {
            PendingPolicy::Ignore
        })
        .await
    }

    async fn ensure_started_with_policy(&self, policy: PendingPolicy) -> RuntimeStatusSnapshot {
        let promote_pending = policy != PendingPolicy::Ignore;
        // 1. Probe existing listener on port
        if let Some(probe) = self.probe_health().await {
            if !probe.compatible {
                return self.observe_peer(probe);
            }

            // Check if we should replace an older compatible MCP runtime on startup
            let local_runtime = self.select_best_local_runtime(false);
            let engine_switch = local_runtime
                .as_ref()
                .map(|(_, m, _)| {
                    let target_engine = if m.is_rust() { "rust" } else { "node" };
                    Self::classify_owner(&probe.host_kind) == "desktop"
                        && ["rust", "node"]
                            .iter()
                            .any(|engine| probe.runtime_engine.eq_ignore_ascii_case(engine))
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
            let wants_takeover = self.config.id == "mcp"
                && probe.pid > 0
                && Self::classify_owner(&probe.host_kind) == "desktop"
                && (engine_switch || version_upgrade);
            // Do not kill a live daemon while a Rust replacement is backing off
            // or has already used its five automatic attempts.
            let should_takeover = wants_takeover && retry == RustStartRetry::Allow;

            if should_takeover {
                // Re-verify identity & PID before killing
                if let Some(recheck) = self.probe_health().await {
                    let same_peer = recheck.compatible
                        && recheck.pid == probe.pid
                        && Self::classify_owner(&recheck.host_kind) == "desktop"
                        && recheck
                            .runtime_engine
                            .eq_ignore_ascii_case(&probe.runtime_engine)
                        && recheck.runtime_version == probe.runtime_version
                        && recheck.runtime_commit == probe.runtime_commit;
                    if !same_peer || recheck.pid == std::process::id() {
                        // A different listener now owns the port. Neither kill
                        // it nor start a second instance using the stale probe.
                        return self.observe_peer(recheck);
                    }
                    Self::kill_pid(probe.pid);
                    let mut remaining = None;
                    for _ in 0..25 {
                        remaining = self.probe_health().await;
                        if remaining.is_none() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                    if let Some(remaining) = remaining {
                        self.observe_peer(remaining);
                        if let Ok(mut status) = self.status.lock() {
                            status.error = "现有服务仍在运行，未启动替换服务".into();
                        }
                        return self.snapshot();
                    }
                }
            } else {
                if !wants_takeover || retry == RustStartRetry::Allow {
                    self.clear_rust_start_retries();
                }
                return self.observe_peer(probe);
            }
        }

        // Rust MCP launch failures are retried by the 60s heartbeat, at most 5 times.
        // A call that arrives inside the minute must not burn another attempt.
        if self.rust_start_retry_state() != RustStartRetry::Allow {
            return self.snapshot();
        }

        // A failed HTTP probe does not prove the port is free. Preserve an
        // unhealthy, slow, or newly replaced listener instead of spawning a
        // second daemon using an uncertain observation.
        if let Some(status) = self.observe_busy_port().await {
            return status;
        }

        // 2. Spawn our local runtime
        let Some((runtime_dir, manifest, staged_hash)) = self.select_local_runtime(policy) else {
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
                let mut activation_error = None;
                let mut activated_pending = false;
                if promote_pending {
                    if let Some(hash) = staged_hash.as_ref() {
                        let mut record = Self::load_active_record(&self.config.store_dir);
                        // A normal startup also selects current. It must not
                        // consume another pending update or erase rollback history.
                        if record.pending.as_ref() == Some(hash) {
                            if record.current.as_ref() != Some(hash) {
                                record.previous = record.current.take();
                            }
                            record.current = Some(hash.clone());
                            record.pending = None;
                            if let Err(error) = self.save_active_record(&record) {
                                activation_error =
                                    Some(format!("更新已启动但激活记录保存失败：{error}"));
                            } else {
                                activated_pending = true;
                            }
                        }
                    }
                }
                if let Ok(mut st) = self.status.lock() {
                    st.state = "running".to_string();
                    st.owner = "desktop".to_string();
                    st.pid = pid;
                    st.engine = manifest.engine.clone();
                    st.version = manifest.version;
                    st.commit = manifest.commit;
                    st.built_at = manifest.built_at;
                    st.error.clear();
                    if let Some(error) = activation_error {
                        st.update_error = error;
                        st.update_state = "error".into();
                    } else if activated_pending {
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
                let (err, port_unavailable) = match err {
                    RuntimeStartError::PortUnavailable(error) => (error, true),
                    RuntimeStartError::CandidateFailed(error) => (error, false),
                };
                // A competing listener makes the candidate outcome uncertain.
                // Keep its pending identity rather than marking it failed or
                // starting rollback over the service now owning the port.
                if self.observe_busy_port().await.is_some() {
                    if let Ok(mut status) = self.status.lock() {
                        status.update_error =
                            format!("更新候选未通过验证，已保留现有监听服务：{err}");
                    }
                    return self.snapshot();
                }
                if port_unavailable {
                    // The listener may have disappeared after the guard. No
                    // candidate was attempted, so leave pending/current intact
                    // and allow a later heartbeat to retry normally.
                    return self.report_unknown_listener(err);
                }
                // Preserve the last verified same-engine runtime for rollback.
                let mut tried_rust = manifest.is_rust();
                if let Some(failed_hash) = staged_hash {
                    let mut record = Self::load_active_record(&self.config.store_dir);
                    record.failed = Some(failed_hash.clone());
                    if record.pending.as_ref() == Some(&failed_hash) {
                        record.pending = None;
                    }
                    if record.current.as_ref() == Some(&failed_hash) {
                        record.current = record.previous.take();
                    }
                    let _ = self.save_active_record(&record);
                    if let Some((rollback_dir, bundled_manifest, _)) =
                        self.select_best_local_runtime(false)
                    {
                        tried_rust = tried_rust || bundled_manifest.is_rust();
                        if let Ok(pid) = self
                            .spawn_and_verify(&rollback_dir, &bundled_manifest)
                            .await
                        {
                            if let Ok(mut st) = self.status.lock() {
                                st.state = "running".to_string();
                                st.owner = "desktop".to_string();
                                st.pid = pid;
                                st.engine = bundled_manifest.engine.clone();
                                st.version = bundled_manifest.version;
                                st.commit = bundled_manifest.commit;
                                st.built_at = bundled_manifest.built_at;
                                st.update_error = format!("更新版本启动失败，已自动回退：{err}");
                                st.pending_version.clear();
                                st.update_state = "error".into();
                            }
                            self.clear_rust_start_retries();
                            return self.snapshot();
                        }
                        if self.observe_busy_port().await.is_some() {
                            if let Ok(mut status) = self.status.lock() {
                                status.update_error =
                                    format!("回退未能启动，已保留现有监听服务：{err}");
                            }
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
    ) -> Result<u32, RuntimeStartError> {
        // Cover every launch path, including rollback after a failed candidate.
        self.require_vacant_port()
            .await
            .map_err(RuntimeStartError::PortUnavailable)?;
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

        let child = cmd.spawn().map_err(|e| {
            RuntimeStartError::CandidateFailed(format!(
                "Failed to spawn {}: {e}",
                program.display()
            ))
        })?;
        let pid = child.id();
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }

        for _ in 0..40 {
            if let Some(probe) = self.probe_health().await {
                // The independently shipped local-model health contract omits
                // PID and MCP build fields. Strict candidate identity is MCP-only.
                let candidate_matches = self.config.id != "mcp"
                    || (probe.pid == pid
                        && ((probe.runtime_engine.is_empty()
                            && manifest.engine.eq_ignore_ascii_case("node"))
                            || probe.runtime_engine.eq_ignore_ascii_case(&manifest.engine))
                        && (probe.runtime_version.is_empty()
                            || probe.runtime_version == manifest.version)
                        && (probe.runtime_commit.is_empty()
                            || probe.runtime_commit == manifest.commit));
                let child_alive = self.child.lock().ok().is_some_and(|mut child| {
                    child.as_mut().is_some_and(|child| {
                        child.id() == pid && matches!(child.try_wait(), Ok(None))
                    })
                });
                if probe.compatible && candidate_matches && child_alive {
                    return Ok(pid);
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        self.stop_owned_process();
        Err(RuntimeStartError::CandidateFailed(format!(
            "运行时启动超时（端口 {} 未通过健康检查）",
            self.config.port
        )))
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
        let pending = record.pending.as_ref().ok_or("当前没有待应用的 MCP 更新")?;
        if record.failed.as_ref() == Some(pending) {
            return Err("该更新此前启动失败，未停止当前服务".into());
        }
        // Validate before interrupting a healthy listener. A stale/missing
        // candidate must never turn an update into an implicit downgrade.
        let candidate = self.cached_runtime(pending)?;
        if self
            .newest_local_version()
            .as_deref()
            .is_some_and(|version| is_version_newer(version, &candidate.version))
        {
            return Err("待应用更新早于本机可用版本，未停止当前服务".into());
        }
        if let Some(live) = self.probe_health().await {
            if live.runtime_engine.eq_ignore_ascii_case(&candidate.engine)
                && is_version_newer(&live.runtime_version, &candidate.version)
            {
                return Err("运行中的服务版本更新，未执行降级或停止服务".into());
            }
        }
        self.stop_for_restart().await?;
        self.clear_rust_start_retries();
        let status = self
            .ensure_started_with_policy(PendingPolicy::Explicit)
            .await;
        if status.state != "running" && status.state != "attached" {
            return Err(if status.error.is_empty() {
                "本地服务启动失败".to_string()
            } else {
                status.error
            });
        }
        Ok(status)
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
mod tests;
#[cfg(test)]
mod update_tests;
