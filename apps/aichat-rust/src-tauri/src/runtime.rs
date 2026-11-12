//! Supervision and safe ownership of the desktop application's local runtimes.

mod archive;
mod manifest;
mod staged_update;

pub use archive::{create_zip_from_dir, extract_zip_archive, extract_zip_bytes, sha256_hex};
pub use manifest::{
    current_runtime_arch, current_runtime_platform, is_valid_hex, is_version_newer,
    mcp_feed_platform, parse_semver, validate_runtime_dir, validate_runtime_dir_any,
    validate_update_manifest, ActiveRuntimeRecord, RuntimeManifest, RuntimeStatusSnapshot,
    RuntimeUpdateManifest,
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
