use crate::files::atomic_json_write;
use crate::runtime::{
    current_runtime_arch, current_runtime_platform, is_valid_hex, is_version_newer, parse_semver,
    sha256_hex, RuntimeStatusSnapshot, RuntimeSupervisor,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(target_os = "windows"))]
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_DESKTOP_FEED_BASE: &str = "https://cdn.keepwork.com/keepwork/aichat-desktop";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDesktopUpdateMeta {
    pub latest_version: String,
    pub published_at: String,
    pub checked_at: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub downloaded_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateComponentStatus {
    pub id: String,
    pub title: String,
    pub installed_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub latest_version: String,
    pub published_at: String,
    pub state: String,
    pub progress: Option<u8>,
    pub can_apply: bool,
    pub stale: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesSnapshot {
    pub checking: bool,
    pub checked_at: String,
    pub mcp: UpdateComponentStatus,
    pub desktop: UpdateComponentStatus,
}

#[derive(Debug, Clone)]
struct DesktopUpdateRuntimeState {
    checking: bool,
    state: String,
    progress: Option<u8>,
    stale: bool,
    error: String,
    meta: PersistedDesktopUpdateMeta,
}

pub fn now_iso_string() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

pub fn default_desktop_feed_url() -> String {
    if let Ok(custom) = std::env::var("AICHAT_UPDATE_FEED_URL") {
        if !custom.trim().is_empty() {
            return custom.trim().to_string();
        }
    }
    #[cfg(windows)]
    if std::env::current_exe()
        .map(|exe| exe.with_file_name("Keepwork.exe").is_file())
        .unwrap_or(false)
    {
        // A compatibility install must retain its Win7-capable outer launcher.
        // Never replace it with the ordinary Tauri-only installer feed.
        return format!(
            "https://cdn.keepwork.com/keepwork/aichat-cef/v1/client/windows-{}/latest-client.json",
            current_runtime_arch()
        );
    }
    let target = format!("{}-{}", current_runtime_platform(), current_runtime_arch());
    format!("{DEFAULT_DESKTOP_FEED_BASE}/{target}/latest-client.json")
}

pub struct UpdateManager {
    desktop_version: String,
    metadata_file: PathBuf,
    downloads_dir: PathBuf,
    feed_url: String,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    launcher_exe: Option<PathBuf>,
    desktop_state: Arc<Mutex<DesktopUpdateRuntimeState>>,
}

impl UpdateManager {
    pub fn new(
        desktop_version: String,
        metadata_file: PathBuf,
        downloads_dir: PathBuf,
        feed_url: String,
        launcher_exe: Option<PathBuf>,
    ) -> Self {
        let meta = Self::load_meta(&metadata_file);
        let ready = !meta.downloaded_path.is_empty()
            && Path::new(&meta.downloaded_path).is_file()
            && is_version_newer(&meta.latest_version, &desktop_version);
        let initial_state = if ready {
            "ready"
        } else if !meta.latest_version.is_empty()
            && !is_version_newer(&meta.latest_version, &desktop_version)
        {
            "up-to-date"
        } else {
            "idle"
        };

        Self {
            desktop_version,
            metadata_file,
            downloads_dir,
            feed_url,
            launcher_exe,
            desktop_state: Arc::new(Mutex::new(DesktopUpdateRuntimeState {
                checking: false,
                state: initial_state.to_string(),
                progress: if ready { Some(100) } else { None },
                stale: false,
                error: String::new(),
                meta,
            })),
        }
    }

    fn load_meta(path: &Path) -> PersistedDesktopUpdateMeta {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedDesktopUpdateMeta>(&raw).ok())
            .unwrap_or_default()
    }

    fn save_meta(&self, meta: &PersistedDesktopUpdateMeta) {
        let _ = atomic_json_write(&self.metadata_file, meta);
    }

    pub fn build_mcp_component(mcp: &RuntimeStatusSnapshot) -> UpdateComponentStatus {
        let foreign_owner = !mcp.owner.is_empty() && mcp.owner != "desktop";
        let has_staged = !mcp.pending_version.is_empty() || mcp.update_state == "staged";
        let state = if mcp.update_state == "checking" {
            "checking"
        } else if mcp.update_state == "downloading" {
            "downloading"
        } else if has_staged {
            "ready"
        } else if !mcp.update_error.is_empty() {
            "error"
        } else if !mcp.latest_version.is_empty() {
            "up-to-date"
        } else {
            "idle"
        };

        let mut error = mcp.update_error.clone();
        if foreign_owner && has_staged && error.is_empty() {
            error = format!(
                "当前 MCP 由 {} 运行，请先关闭外部服务或重启应用以激活更新",
                mcp.owner
            );
        }

        UpdateComponentStatus {
            id: "mcp".to_string(),
            title: "Keepwork MCP Server".to_string(),
            installed_version: mcp.version.clone(),
            running_version: if foreign_owner {
                Some(mcp.version.clone())
            } else {
                None
            },
            owner: if !mcp.owner.is_empty() {
                Some(mcp.owner.clone())
            } else {
                None
            },
            latest_version: if !mcp.pending_version.is_empty() {
                mcp.pending_version.clone()
            } else if !mcp.latest_version.is_empty() {
                mcp.latest_version.clone()
            } else {
                mcp.version.clone()
            },
            published_at: mcp.latest_built_at.clone(),
            state: state.to_string(),
            progress: mcp.update_progress,
            can_apply: has_staged && !foreign_owner && mcp.update_state != "downloading",
            stale: !mcp.update_error.is_empty() && !mcp.latest_version.is_empty(),
            error,
            checked_at: None,
        }
    }

    pub fn snapshot(&self, mcp: &RuntimeStatusSnapshot) -> UpdatesSnapshot {
        let mcp_comp = Self::build_mcp_component(mcp);
        let ds = self
            .desktop_state
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| DesktopUpdateRuntimeState {
                checking: false,
                state: "idle".to_string(),
                progress: None,
                stale: false,
                error: String::new(),
                meta: PersistedDesktopUpdateMeta::default(),
            });

        let can_apply_desktop = ds.state == "ready"
            && !ds.meta.downloaded_path.is_empty()
            && Path::new(&ds.meta.downloaded_path).is_file()
            && is_version_newer(&ds.meta.latest_version, &self.desktop_version);

        let desktop_comp = UpdateComponentStatus {
            id: "desktop".to_string(),
            title: "AIChat Desktop".to_string(),
            installed_version: self.desktop_version.clone(),
            running_version: None,
            owner: None,
            latest_version: if !ds.meta.latest_version.is_empty() {
                ds.meta.latest_version.clone()
            } else {
                self.desktop_version.clone()
            },
            published_at: ds.meta.published_at.clone(),
            state: ds.state.clone(),
            progress: ds.progress,
            can_apply: can_apply_desktop,
            stale: ds.stale,
            error: ds.error.clone(),
            checked_at: if ds.meta.checked_at.is_empty() {
                None
            } else {
                Some(ds.meta.checked_at.clone())
            },
        };

        UpdatesSnapshot {
            checking: ds.checking
                || mcp.update_state == "checking"
                || mcp.update_state == "downloading",
            checked_at: ds.meta.checked_at,
            mcp: mcp_comp,
            desktop: desktop_comp,
        }
    }

    pub async fn check_desktop_update(&self) {
        if let Ok(mut ds) = self.desktop_state.lock() {
            if ds.checking {
                return;
            }
            ds.checking = true;
            ds.state = "checking".to_string();
            ds.error.clear();
            ds.stale = false;
        }

        let res = self.fetch_and_stage_desktop_update().await;
        if let Err(err) = res {
            if let Ok(mut ds) = self.desktop_state.lock() {
                ds.checking = false;
                let has_cached = !ds.meta.latest_version.is_empty();
                let has_ready = !ds.meta.downloaded_path.is_empty()
                    && Path::new(&ds.meta.downloaded_path).is_file()
                    && is_version_newer(&ds.meta.latest_version, &self.desktop_version);
                ds.state = if has_ready { "ready" } else { "error" }.to_string();
                ds.stale = has_cached;
                ds.error = err;
            }
        }
    }

    async fn fetch_and_stage_desktop_update(&self) -> Result<(), String> {
        let builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
        #[cfg(test)]
        let builder = builder.no_proxy();
        let client = builder.build().map_err(|e| e.to_string())?;

        let resp = client
            .get(&self.feed_url)
            .send()
            .await
            .map_err(|e| format!("无法连接桌面更新服务器：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "检查桌面更新失败（HTTP {}）",
                resp.status().as_u16()
            ));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("解析桌面更新清单失败：{e}"))?;

        let version = body
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if parse_semver(&version).is_none() {
            return Err(format!("无效的桌面远端版本号：{version}"));
        }

        let published_at = body
            .get("publishedAt")
            .or_else(|| body.get("releaseDate"))
            .or_else(|| body.get("builtAt"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let url = body
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let sha256 = body
            .get("sha256")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let size = body.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let file_name = body
            .get("fileName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.contains('/') && !s.contains('\\') && !s.contains(".."))
            .unwrap_or("KeepWork-SecondBrain.zip")
            .to_string();

        let checked_at = now_iso_string();

        if !is_version_newer(&version, &self.desktop_version) {
            if let Ok(mut ds) = self.desktop_state.lock() {
                ds.checking = false;
                ds.state = "up-to-date".to_string();
                ds.progress = None;
                ds.stale = false;
                ds.error.clear();
                ds.meta.latest_version = version;
                ds.meta.published_at = published_at;
                ds.meta.checked_at = checked_at;
                self.save_meta(&ds.meta);
            }
            return Ok(());
        }

        // Check if already downloaded and verified
        let existing_path = self.downloads_dir.join(format!("{version}-{file_name}"));
        if existing_path.is_file() && !sha256.is_empty() {
            if let Ok(bytes) = fs::read(&existing_path) {
                if sha256_hex(&bytes) == sha256 {
                    if let Ok(mut ds) = self.desktop_state.lock() {
                        ds.checking = false;
                        ds.state = "ready".to_string();
                        ds.progress = Some(100);
                        ds.stale = false;
                        ds.error.clear();
                        ds.meta = PersistedDesktopUpdateMeta {
                            latest_version: version,
                            published_at,
                            checked_at,
                            url,
                            sha256,
                            size: bytes.len() as u64,
                            downloaded_path: existing_path.to_string_lossy().into_owned(),
                        };
                        self.save_meta(&ds.meta);
                    }
                    return Ok(());
                }
            }
        }

        if url.is_empty() || (!url.starts_with("https://") && !url.starts_with("http://127.0.0.1:"))
        {
            return Err(format!("不安全的桌面更新包地址：{url}"));
        }
        if !is_valid_hex(&sha256, 64) {
            return Err("桌面更新清单缺少有效的 64 位 SHA-256 摘要".to_string());
        }

        if let Ok(mut ds) = self.desktop_state.lock() {
            ds.state = "downloading".to_string();
            ds.progress = Some(0);
            ds.meta.latest_version = version.clone();
            ds.meta.published_at = published_at.clone();
            ds.meta.checked_at = checked_at.clone();
        }

        let pkg_resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("下载桌面更新包失败：{e}"))?;
        if !pkg_resp.status().is_success() {
            return Err(format!(
                "下载桌面更新包失败（HTTP {}）",
                pkg_resp.status().as_u16()
            ));
        }
        let pkg_bytes = pkg_resp
            .bytes()
            .await
            .map_err(|e| format!("读取桌面更新包数据失败：{e}"))?;

        if size > 0 && pkg_bytes.len() as u64 != size {
            return Err(format!(
                "桌面更新包大小不匹配（实际 {}，预期 {}）",
                pkg_bytes.len(),
                size
            ));
        }

        let actual_sha = sha256_hex(&pkg_bytes);
        if actual_sha != sha256 {
            return Err("桌面更新包 SHA-256 校验未通过".to_string());
        }

        fs::create_dir_all(&self.downloads_dir)
            .map_err(|e| format!("创建桌面更新缓存目录失败：{e}"))?;
        let tmp_path = existing_path.with_extension("part");
        fs::write(&tmp_path, &pkg_bytes).map_err(|e| format!("保存桌面更新包失败：{e}"))?;
        fs::rename(&tmp_path, &existing_path).map_err(|e| format!("落盘桌面更新包失败：{e}"))?;

        if let Ok(mut ds) = self.desktop_state.lock() {
            ds.checking = false;
            ds.state = "ready".to_string();
            ds.progress = Some(100);
            ds.stale = false;
            ds.error.clear();
            ds.meta = PersistedDesktopUpdateMeta {
                latest_version: version,
                published_at,
                checked_at,
                url,
                sha256,
                size: pkg_bytes.len() as u64,
                downloaded_path: existing_path.to_string_lossy().into_owned(),
            };
            self.save_meta(&ds.meta);
        }
        Ok(())
    }

    pub async fn check_all(&self, mcp_supervisor: &RuntimeSupervisor) -> (UpdatesSnapshot, bool) {
        let (_, newly_staged_mcp) = mcp_supervisor.check_for_update().await;
        self.check_desktop_update().await;
        let snap = self.snapshot(&mcp_supervisor.snapshot());
        (snap, newly_staged_mcp)
    }

    pub fn prepare_desktop_install(&self) -> Result<PathBuf, String> {
        let ds = self
            .desktop_state
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        if ds.state != "ready" || ds.meta.downloaded_path.is_empty() {
            return Err("当前没有已下载就绪的桌面端更新包".to_string());
        }
        let path = PathBuf::from(&ds.meta.downloaded_path);
        if !path.is_file() {
            return Err("桌面端更新安装包不存在，请重新检查更新".to_string());
        }
        let bytes = fs::read(&path).map_err(|e| format!("读取桌面更新包失败：{e}"))?;
        if !ds.meta.sha256.is_empty() && sha256_hex(&bytes) != ds.meta.sha256 {
            return Err("桌面更新包完整性校验失败，请重新下载".to_string());
        }
        Ok(path)
    }

    pub fn launch_desktop_installer(&self, package_path: &Path) -> Result<(), String> {
        // Execute only what this app downloaded: the metadata on disk can be
        // edited, and a path outside the download directory would turn the
        // updater into a "run arbitrary file" primitive.
        let package = package_path
            .canonicalize()
            .map_err(|e| format!("更新包路径无效：{e}"))?;
        let downloads = self
            .downloads_dir
            .canonicalize()
            .map_err(|e| format!("更新下载目录无效：{e}"))?;
        if !crate::files::inside(&downloads, &package) {
            return Err("更新包不在下载目录内，已拒绝执行".to_string());
        }
        let ext = package
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        #[cfg(not(target_os = "windows"))]
        if let Some(launcher) = &self.launcher_exe {
            if launcher.is_file() {
                return spawn_installer(
                    launcher,
                    &[OsStr::new("--apply-update"), package.as_os_str()],
                );
            }
        }

        #[cfg(target_os = "macos")]
        {
            if ext == "dmg" || ext == "pkg" {
                return spawn_installer(Path::new("open"), &[package.as_os_str()]);
            }
            return Err(format!("不支持的更新包类型：{ext}"));
        }

        #[cfg(target_os = "windows")]
        {
            if ext == "exe" {
                // Open the visible installer through the Windows shell, allowing
                // normal elevation/association handling. Never pass silent flags.
                use std::os::windows::ffi::OsStrExt;
                let file: Vec<u16> = package.as_os_str().encode_wide().chain(Some(0)).collect();
                let verb: Vec<u16> = "open\0".encode_utf16().collect();
                let result = unsafe {
                    windows_sys::Win32::UI::Shell::ShellExecuteW(
                        std::ptr::null_mut(),
                        verb.as_ptr(),
                        file.as_ptr(),
                        std::ptr::null(),
                        std::ptr::null(),
                        windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
                    )
                } as isize;
                return if result > 32 {
                    Ok(())
                } else {
                    Err(format!("启动安装器失败（Windows {result}）"))
                };
            }
            return Err(format!("不支持的更新包类型：{ext}"));
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = ext;
            Err("当前平台不支持自动安装更新".to_string())
        }
    }
}

/// Start an interactive platform installer without inheriting terminal handles.
#[cfg(not(target_os = "windows"))]
fn spawn_installer(program: &Path, args: &[&OsStr]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动更新器失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[tokio::test]
    async fn downloads_verifies_desktop_update_and_preserves_stale_cache_on_offline_error() {
        let root = std::env::temp_dir().join(format!("aichat-rust-upd-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let pkg_bytes = b"MOCK_DESKTOP_INSTALLER_PAYLOAD_V0_3_0".to_vec();
        let pkg_sha = sha256_hex(&pkg_bytes);
        let pkg_size = pkg_bytes.len() as u64;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pkg_url = format!("http://127.0.0.1:{port}/KeepWork-SecondBrain.zip");
        let feed_url = format!("http://127.0.0.1:{port}/latest-client.json");

        let manifest_body = serde_json::json!({
            "product": "aichat-desktop",
            "version": "0.3.0",
            "publishedAt": "2026-11-09T10:00:00Z",
            "fileName": "KeepWork-SecondBrain.zip",
            "url": pkg_url,
            "sha256": pkg_sha,
            "size": pkg_size,
        })
        .to_string();

        let srv = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut requests = 0;
            while requests < 2 && std::time::Instant::now() < deadline {
                if let Ok((mut stream, _)) = listener.accept() {
                    requests += 1;
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut buf = [0u8; 2048];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.contains("GET /latest-client.json") {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            manifest_body.len(),
                            manifest_body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    } else {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            pkg_bytes.len()
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.write_all(&pkg_bytes);
                    }
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });

        let manager = UpdateManager::new(
            "0.2.0".to_string(),
            root.join("update-metadata.json"),
            root.join("downloads"),
            feed_url,
            None,
        );

        manager.check_desktop_update().await;
        let _ = srv.join();

        let mcp_snap = RuntimeStatusSnapshot::initial("mcp", 8089);
        let snap = manager.snapshot(&mcp_snap);
        assert_eq!(snap.desktop.state, "ready");
        assert_eq!(snap.desktop.latest_version, "0.3.0");
        assert!(snap.desktop.can_apply);

        let verified_pkg = manager.prepare_desktop_install().unwrap();
        assert!(verified_pkg.is_file());
        let outside = root.join("outside.exe");
        fs::write(&outside, b"never execute").unwrap();
        assert!(manager
            .launch_desktop_installer(&outside)
            .unwrap_err()
            .contains("下载目录"));

        // Now test offline fallback with cached metadata (`stale: true`)
        let offline_manager = UpdateManager::new(
            "0.2.0".to_string(),
            root.join("update-metadata.json"),
            root.join("downloads"),
            "http://127.0.0.1:1/unreachable.json".to_string(),
            None,
        );
        offline_manager.check_desktop_update().await;
        let stale_snap = offline_manager.snapshot(&mcp_snap);
        assert!(stale_snap.desktop.stale);
        assert_eq!(stale_snap.desktop.latest_version, "0.3.0");
        assert!(stale_snap.desktop.can_apply);

        fs::write(&verified_pkg, b"tampered").unwrap();
        assert!(manager
            .prepare_desktop_install()
            .unwrap_err()
            .contains("完整性"));

        let _ = fs::remove_dir_all(&root);
    }
}
