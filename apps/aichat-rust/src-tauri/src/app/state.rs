//! Shared application state and desktop status snapshots.

use crate::desktop_lock::DesktopLock;
use crate::dev_server::DevServer;
use crate::files::NativeFiles;
use crate::login_startup::{load_settings, save_settings, DesktopSettings, LoginStartup};
use crate::page_connection::{self, PageConnection};
use crate::permissions::MediaGrants;
use crate::pet::PetController;
use crate::runtime::{
    current_runtime_arch, current_runtime_platform, RuntimeStatusSnapshot, RuntimeSupervisor,
};
use crate::security::ENTRY;
use crate::terminal::TerminalSessionManager;
use crate::tray_channels::ChannelStatus;
use crate::updates::{UpdateManager, UpdatesSnapshot};
use crate::APP_VERSION;
use crate::{pet_audio, pet_menu};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub entry_url: String,
    pub local_source: bool,
    pub mcp: RuntimeStatusSnapshot,
    pub local_model: RuntimeStatusSnapshot,
    pub updates: UpdatesSnapshot,
    pub page_connection: page_connection::ConnectionSnapshot,
}

pub struct AppCore {
    pub profile_dir: PathBuf,
    pub settings_path: PathBuf,
    pub mcp_home: PathBuf,
    pub files: NativeFiles,
    pub terminals: TerminalSessionManager,
    pub media_grants: MediaGrants,
    pub login_startup: LoginStartup,
    pub mcp_supervisor: Arc<RuntimeSupervisor>,
    pub local_model_supervisor: Arc<RuntimeSupervisor>,
    pub updates: Arc<UpdateManager>,
    pub pet: Arc<PetController>,
    pub pet_audio: Arc<pet_audio::PetAudioRelay>,
    pub pet_menu: pet_menu::Session,
    pub dev_server: Mutex<Option<DevServer>>,
    pub entry_url: Mutex<String>,
    pub local_source_enabled: AtomicBool,
    /// 当前 WebView 缩放比例（Tauri 2.12 没有 zoom 读取接口，需要自己记账）。
    pub zoom: Mutex<f64>,
    pub signed_in: AtomicBool,
    pub quitting: AtomicBool,
    pub channels: Mutex<Vec<ChannelStatus>>,
    pub lock: Mutex<Option<DesktopLock>>,
    pub page_connection: Mutex<PageConnection>,
}

impl AppCore {
    pub fn current_dev_url(&self) -> Option<String> {
        let entry = self.entry_url.lock().ok().map(|s| s.clone())?;
        if entry != ENTRY {
            Some(entry)
        } else {
            None
        }
    }

    pub fn settings(&self) -> DesktopSettings {
        load_settings(&self.settings_path)
    }

    pub fn update_settings<F>(&self, mutator: F) -> DesktopSettings
    where
        F: FnOnce(&mut DesktopSettings),
    {
        let mut s = self.settings();
        mutator(&mut s);
        let _ = save_settings(&self.settings_path, &s);
        s
    }

    pub fn status_snapshot(&self) -> DesktopStatus {
        let mcp = self.mcp_supervisor.snapshot();
        let local_model = self.local_model_supervisor.snapshot();
        let updates = self.updates.snapshot(&mcp);
        let entry_url = self
            .entry_url
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| ENTRY.to_string());
        DesktopStatus {
            version: APP_VERSION.to_string(),
            platform: current_runtime_platform().to_string(),
            arch: current_runtime_arch().to_string(),
            entry_url: entry_url.clone(),
            local_source: self.local_source_enabled.load(Ordering::Relaxed),
            mcp,
            local_model,
            updates,
            page_connection: self.page_connection.lock().unwrap().snapshot(&entry_url),
        }
    }
}

pub fn resolve_profile_dir(packaged: bool) -> PathBuf {
    for arg in std::env::args() {
        if let Some(dir) = arg.strip_prefix("--user-data-dir=") {
            if !dir.trim().is_empty() {
                return PathBuf::from(dir.trim());
            }
        }
    }
    if let Ok(custom) = std::env::var("AICHAT_DESKTOP_USER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom.trim());
        }
    }
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    if packaged {
        base.join("AIChat Desktop")
    } else {
        base.join("aichat-desktop")
    }
}
