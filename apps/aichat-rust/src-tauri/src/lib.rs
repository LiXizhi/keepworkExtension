pub mod brain_folder;
pub mod bridge;
pub mod deployment;
pub mod desktop_identity;
pub mod desktop_lock;
pub mod dev_server;
pub mod files;
pub mod git_setup;
pub mod login_startup;
pub mod menu;
pub mod permissions;
pub mod pet;
pub mod runtime;
pub mod security;
pub mod terminal;
pub mod tray_channels;
pub mod updates;

use crate::brain_folder::{default_brain_folder, BrainFolderInfo};
use crate::bridge::build_main_window_init_script;
use crate::deployment::{open_deployment, resolve_local_aichat_source_dir};
use crate::desktop_identity::{default_mcp_home, remember_desktop_client};
use crate::desktop_lock::DesktopLock;
use crate::dev_server::DevServer;
use crate::files::{FolderGrant, NativeFiles};
use crate::git_setup::{check_git, install_git, GitInstallResult, GitStatus};
use crate::login_startup::{load_settings, save_settings, DesktopSettings, LoginStartup};
use crate::menu::{is_allowed_host_command, menu_payload, MenuContextState};
use crate::permissions::MediaGrants;
use crate::pet::{PetController, WorkArea};
use crate::runtime::{
    current_runtime_arch, current_runtime_platform, RuntimeConfig, RuntimeStatusSnapshot,
    RuntimeSupervisor, DEFAULT_MCP_FEED_BASE, LOCAL_MODEL_PORT, MCP_PORT,
};
use crate::security::{assert_sender, external_url, trusted_page, ENTRY};
use crate::terminal::TerminalSessionManager;
use crate::tray_channels::{channel_states, describe, fetch_tray_channels, ChannelStatus};
use crate::updates::{default_desktop_feed_url, UpdateManager, UpdatesSnapshot};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    pub dev_server: Mutex<Option<DevServer>>,
    pub entry_url: Mutex<String>,
    pub local_source_enabled: AtomicBool,
    pub signed_in: AtomicBool,
    pub quitting: AtomicBool,
    pub channels: Mutex<Vec<ChannelStatus>>,
    pub lock: Mutex<Option<DesktopLock>>,
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
            entry_url,
            local_source: self.local_source_enabled.load(Ordering::Relaxed),
            mcp,
            local_model,
            updates,
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

pub fn open_in_system_browser(raw_url: &str) -> Result<(), String> {
    let valid = external_url(raw_url).ok_or_else(|| format!("Invalid external URL: {raw_url}"))?;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&valid)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &valid])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(&valid)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn reveal_path_in_os(target: &Path, mode: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        match mode {
            "open" => {
                cmd.arg(target);
            }
            "dir" => {
                let dir = if target.is_dir() {
                    target
                } else {
                    target.parent().unwrap_or(target)
                };
                cmd.arg(dir);
            }
            _ => {
                cmd.arg("-R").arg(target);
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        match mode {
            "open" => {
                Command::new("explorer.exe")
                    .arg(target)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "dir" => {
                let dir = if target.is_dir() {
                    target
                } else {
                    target.parent().unwrap_or(target)
                };
                Command::new("explorer.exe")
                    .arg(dir)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                Command::new("explorer.exe")
                    .arg(format!("/select,{}", target.to_string_lossy()))
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn verify_main_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "main", true, &url, dev_url.as_deref())
}

fn verify_pet_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "pet", true, &url, dev_url.as_deref())
}

fn verify_updates_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "updates", true, &url, dev_url.as_deref())
}

fn broadcast_to_main(app: &AppHandle, event_name: &str, payload: &Value) {
    let _ = app.emit(&format!("aichat-desktop:{event_name}"), payload);
    if let Some(main_win) = app.get_webview_window("main") {
        let detail = json!({
            "event": event_name,
            "payload": payload,
        });
        let js = format!(
            "window.dispatchEvent(new CustomEvent('__aichat_desktop_event__', {{ detail: {detail} }}));"
        );
        let _ = main_win.eval(&js);
    }
}

fn broadcast_pet_state(app: &AppHandle, core: &AppCore) {
    let snap = core.pet.snapshot();
    let _ = app.emit("aichat-desktop:pet-state", &snap);
}

fn broadcast_update_status(app: &AppHandle, core: &AppCore) {
    let snap = core.updates.snapshot(&core.mcp_supervisor.snapshot());
    broadcast_to_main(app, "update-status", &json!(snap));
    let _ = app.emit("aichat-desktop:update-status", &snap);
}

pub fn show_main_window(app: &AppHandle, core: &AppCore) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(pet_win) = app.get_webview_window("pet") {
        let _ = pet_win.hide();
    }
    let _ = core;
}

pub fn ensure_pet_window(app: &AppHandle, core: &Arc<AppCore>, show_now: bool) {
    if let Some(existing) = app.get_webview_window("pet") {
        if show_now {
            let _ = existing.show();
        }
        broadcast_pet_state(app, core);
        return;
    }

    let area = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            let size = m.size().to_logical::<i32>(scale);
            let pos = m.position().to_logical::<i32>(scale);
            WorkArea {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .unwrap_or_default();
    core.pet.set_work_area(area);

    if let Ok(builder) = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("桌面宠物")
        .position(area.x as f64, area.y as f64)
        .inner_size(area.width as f64, area.height as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(show_now)
        .build()
    {
        let _ = builder.set_ignore_cursor_events(true);
        broadcast_pet_state(app, core);
    }
}

pub fn open_updates_window(app: &AppHandle, core: &Arc<AppCore>) {
    if let Some(existing) = app.get_webview_window("updates") {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        broadcast_update_status(app, core);
        return;
    }

    if let Ok(win) =
        WebviewWindowBuilder::new(app, "updates", WebviewUrl::App("updates.html".into()))
            .title("检查更新")
            .inner_size(680.0, 660.0)
            .min_inner_size(560.0, 480.0)
            .resizable(true)
            .visible(true)
            .build()
    {
        let _ = win.set_focus();
        broadcast_update_status(app, core);
    }
}

#[tauri::command]
fn desktop_report_startup_signin(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    signed_in: bool,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    state.signed_in.store(signed_in, Ordering::Relaxed);
    Ok(signed_in)
}

#[tauri::command]
fn desktop_publish_pet_state(
    app: AppHandle,
    window: WebviewWindow,
    state_mgr: tauri::State<'_, Arc<AppCore>>,
    state: Option<Value>,
) -> Result<bool, String> {
    verify_main_sender(&window, &state_mgr)?;
    let incoming = state.unwrap_or_else(|| json!({}));
    state_mgr.pet.update_raw_state(incoming);
    broadcast_pet_state(&app, &state_mgr);
    Ok(true)
}

#[tauri::command]
fn desktop_pet_result(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    result: Value,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    if result.get("type").and_then(|v| v.as_str()) == Some("exit-info") {
        state.pet.resolve_exit_info(&result);
        broadcast_pet_state(&app, &state);
    }
    Ok(true)
}

#[tauri::command]
fn desktop_check_git(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<GitStatus, String> {
    verify_main_sender(&window, &state)?;
    Ok(check_git())
}

#[tauri::command]
fn desktop_install_git(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<GitInstallResult, String> {
    verify_main_sender(&window, &state)?;
    Ok(install_git())
}

#[tauri::command]
fn desktop_roots(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<Vec<FolderGrant>, String> {
    verify_main_sender(&window, &state)?;
    Ok(state.files.roots())
}

#[tauri::command]
async fn desktop_pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<Option<FolderGrant>, String> {
    verify_main_sender(&window, &state)?;
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path_buf = file_path
        .into_path()
        .map_err(|e| format!("Invalid folder path: {e}"))?;
    let grant = state.files.grant(&path_buf)?;
    broadcast_to_main(&app, "folder-selected", &json!(grant));
    Ok(Some(grant))
}

#[tauri::command]
fn desktop_default_brain_folder(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    prepare: bool,
) -> Result<BrainFolderInfo, String> {
    verify_main_sender(&window, &state)?;
    let docs = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| state.profile_dir.clone());
    default_brain_folder(&state.files, &docs, prepare)
}

#[tauri::command]
fn desktop_revoke_folder(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    root_id: String,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let removed = state.files.revoke(&root_id)?;
    if removed {
        state.terminals.close_all();
    }
    Ok(removed)
}

#[tauri::command]
fn desktop_file(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    op: String,
    args: Value,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    if op == "reveal" {
        let root_id = args.get("rootId").and_then(|v| v.as_str()).unwrap_or("");
        let rel = args
            .get("path")
            .or_else(|| args.get("rel"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mode = args
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("reveal");
        let (_grant, target, rel_slash) = state.files.resolve(root_id, rel, true, false)?;
        if mode == "open" {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            let file_name = target
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel_slash.clone());
            let confirmed = app
                .dialog()
                .message(format!("使用系统默认应用打开「{file_name}」吗？"))
                .title("打开文件确认")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "打开".to_string(),
                    "取消".to_string(),
                ))
                .blocking_show();
            if !confirmed {
                return Ok(json!({ "ok": false, "cancelled": true }));
            }
        }
        reveal_path_in_os(&target, mode)?;
        return Ok(json!({ "ok": true, "rel": rel_slash, "mode": mode }));
    }
    state.files.handle(&op, &args)
}

#[tauri::command]
fn desktop_terminal(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    op: String,
    args: Value,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    state
        .terminals
        .handle("desktop:main", &state.files, &op, &args)
}

#[tauri::command]
fn desktop_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<DesktopStatus, String> {
    verify_main_sender(&window, &state)?;
    Ok(state.status_snapshot())
}

#[tauri::command]
async fn desktop_check_updates(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_main_sender(&window, &state)?;
    let (snap, _newly_staged) = state.updates.check_all(&state.mcp_supervisor).await;
    broadcast_update_status(&app, &state);
    Ok(snap)
}

#[tauri::command]
async fn desktop_install_update(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    let snap = state.updates.snapshot(&state.mcp_supervisor.snapshot());
    if snap.mcp.can_apply {
        let next_mcp = state.mcp_supervisor.apply_staged_update().await?;
        let next_snap = state.updates.snapshot(&next_mcp);
        broadcast_update_status(&app, &state);
        return Ok(json!(next_snap));
    }
    if snap.desktop.can_apply {
        let pkg = state.updates.prepare_desktop_install()?;
        state.updates.launch_desktop_installer(&pkg)?;
        state.quitting.store(true, Ordering::Relaxed);
        app.exit(0);
        return Ok(json!({ "ok": true, "restarting": true }));
    }
    open_updates_window(&app, &state);
    Ok(json!(snap))
}

#[tauri::command]
async fn desktop_run_menu_command(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    id: String,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    if !is_allowed_host_command(&id) {
        return Err(format!("Unsupported menu command: {id}"));
    }
    execute_host_command(&app, &state, &id).await?;
    Ok(true)
}

#[tauri::command]
fn desktop_open_menu(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    menu_id: String,
    left: i32,
    bottom: i32,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let settings = state.settings();
    let ctx = MenuContextState {
        local_source_available: resolve_local_aichat_source_dir().is_some(),
        local_source_enabled: state.local_source_enabled.load(Ordering::Relaxed),
        pet_visible: settings.pet_visible,
        open_at_login: state.login_startup.is_enabled(),
        mcp_version: state.mcp_supervisor.snapshot().version,
        desktop_version: APP_VERSION.to_string(),
    };
    if let Some(mut payload) = menu_payload(&menu_id, &ctx) {
        payload["anchor"] = json!({ "left": left, "bottom": bottom });
        broadcast_to_main(&app, "menu-message", &payload);
    }
    Ok(true)
}

#[tauri::command]
fn desktop_titlebar_action(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    action: String,
    url: Option<String>,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    match action.as_str() {
        "reload" => {
            let _ = window.eval("window.location.reload()");
        }
        "open-external" => {
            let target = url.unwrap_or_else(|| {
                state
                    .entry_url
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_else(|_| ENTRY.to_string())
            });
            open_in_system_browser(&target)?;
        }
        "drag" => {
            let _ = window.start_dragging();
        }
        "toggle-maximize" => {
            if let Ok(is_max) = window.is_maximized() {
                if is_max {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        _ => {}
    }
    Ok(true)
}

#[tauri::command]
fn desktop_sync_theme(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    dark: bool,
    _color: Option<String>,
    _symbol_color: Option<String>,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let _ = window.set_theme(Some(if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }));
    Ok(true)
}

#[tauri::command]
async fn desktop_pet_action(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    verify_pet_sender(&window, &state)?;
    match name.as_str() {
        "state" => Ok(state.pet.snapshot()),
        "expand" => {
            let expanded = args
                .get("expanded")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let snap = state.pet.set_expanded(expanded);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "open" => {
            show_main_window(&app, &state);
            Ok(state.pet.snapshot())
        }
        "hit-test" => {
            let interactive = args
                .get("interactive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let _ = window.set_ignore_cursor_events(!interactive);
            Ok(json!({ "ok": true }))
        }
        "drag-start" => {
            let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            state.pet.start_drag(x, y);
            Ok(state.pet.snapshot())
        }
        "drag" => {
            let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let snap = state.pet.update_drag(x, y);
            Ok(snap)
        }
        "drag-end" => {
            let snap = state.pet.end_drag();
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "exit-request" => {
            let shared = state.mcp_supervisor.snapshot().owner != "desktop";
            let (_id, snap) = state.pet.begin_exit_prompt(shared);
            broadcast_to_main(&app, "pet-command", &json!({ "action": "exit-info" }));
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "exit-cancel" => {
            let snap = state.pet.cancel_exit_prompt();
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "exit-confirm" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            state.pet.verify_exit_confirm(id)?;
            state.quitting.store(true, Ordering::Relaxed);
            state.terminals.close_all();
            state.mcp_supervisor.stop();
            state.local_model_supervisor.stop();
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        "permission-choice" => {
            let _ = window.hide();
            let snap = state.pet.set_permission_prompt(None);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "input" | "send" | "stop" | "dictation" | "call" | "mute" | "voice-start"
        | "voice-stop" | "record-start" | "record-stop" | "toggle-target" => {
            if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
                if text.chars().count() > crate::pet::MAX_PET_INPUT_CHARS {
                    return Err("输入内容过长，请在桌面主窗口中编辑".to_string());
                }
            }
            let mut payload = args.clone();
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("action".to_string(), json!(name));
            }
            broadcast_to_main(&app, "pet-command", &payload);
            Ok(state.pet.snapshot())
        }
        _ => Ok(state.pet.snapshot()),
    }
}

#[tauri::command]
fn updates_window_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_updates_sender(&window, &state)?;
    Ok(state.updates.snapshot(&state.mcp_supervisor.snapshot()))
}

#[tauri::command]
async fn updates_window_check(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_updates_sender(&window, &state)?;
    let (snap, _) = state.updates.check_all(&state.mcp_supervisor).await;
    broadcast_update_status(&app, &state);
    Ok(snap)
}

#[tauri::command]
async fn updates_window_apply_mcp(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_updates_sender(&window, &state)?;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let confirmed = app
        .dialog()
        .message("更新本地 MCP 服务会中断当前正在执行的 MCP 工具调用并重启服务。是否立即更新？")
        .title("更新 Keepwork MCP 服务")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".to_string(),
            "稍后".to_string(),
        ))
        .blocking_show();
    if confirmed {
        let _ = state.mcp_supervisor.apply_staged_update().await?;
    }
    let snap = state.updates.snapshot(&state.mcp_supervisor.snapshot());
    broadcast_update_status(&app, &state);
    Ok(snap)
}

#[tauri::command]
async fn updates_window_apply_desktop(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_updates_sender(&window, &state)?;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let confirmed = app
        .dialog()
        .message("退出并更新桌面应用？应用将关闭并启动新版本安装。")
        .title("更新桌面应用")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "退出并更新".to_string(),
            "取消".to_string(),
        ))
        .blocking_show();
    if confirmed {
        let pkg = state.updates.prepare_desktop_install()?;
        state.updates.launch_desktop_installer(&pkg)?;
        state.quitting.store(true, Ordering::Relaxed);
        app.exit(0);
    }
    Ok(state.updates.snapshot(&state.mcp_supervisor.snapshot()))
}

pub async fn execute_host_command(
    app: &AppHandle,
    core: &Arc<AppCore>,
    id: &str,
) -> Result<(), String> {
    match id {
        "file:open-folder" => {
            use tauri_plugin_dialog::DialogExt;
            if let Some(folder) = app.dialog().file().blocking_pick_folder() {
                if let Ok(path) = folder.into_path() {
                    let grant = core.files.grant(&path)?;
                    broadcast_to_main(app, "folder-selected", &json!(grant));
                }
            }
        }
        "file:close-window" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
                if core.settings().pet_visible {
                    ensure_pet_window(app, core, true);
                }
            }
        }
        "view:reload" | "view:force-reload" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.location.reload()");
            }
        }
        "view:toggle-fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                let cur = win.is_fullscreen().unwrap_or(false);
                let _ = win.set_fullscreen(!cur);
            }
        }
        "view:toggle-pet" => {
            let next = core.update_settings(|s| {
                s.pet_visible = !s.pet_visible;
            });
            if !next.pet_visible {
                if let Some(pet_win) = app.get_webview_window("pet") {
                    let _ = pet_win.hide();
                }
                // Stop dictation/call/wakeword when pet is hidden, without cancelling normal text tasks
                broadcast_to_main(app, "pet-command", &json!({ "action": "hide" }));
            } else {
                let main_visible = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(true);
                if !main_visible {
                    ensure_pet_window(app, core, true);
                }
            }
        }
        "view:toggle-login-startup" => {
            let cur = core.login_startup.is_enabled();
            let _ = core.login_startup.set_enabled(!cur);
        }
        "view:toggle-source" => {
            let enable = !core.local_source_enabled.load(Ordering::Relaxed);
            if enable {
                if let Some(src_dir) = resolve_local_aichat_source_dir() {
                    let srv = DevServer::start(&src_dir, "AIChat.html")?;
                    let url = srv.url();
                    if let Ok(mut guard) = core.dev_server.lock() {
                        *guard = Some(srv);
                    }
                    if let Ok(mut entry) = core.entry_url.lock() {
                        *entry = url.clone();
                    }
                    core.local_source_enabled.store(true, Ordering::Relaxed);
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval(&format!("window.location.replace({})", json!(url)));
                    }
                }
            } else {
                if let Ok(mut guard) = core.dev_server.lock() {
                    *guard = None;
                }
                if let Ok(mut entry) = core.entry_url.lock() {
                    *entry = ENTRY.to_string();
                }
                core.local_source_enabled.store(false, Ordering::Relaxed);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval(&format!("window.location.replace({})", json!(ENTRY)));
                }
            }
        }
        "help:mcp-dashboard" => {
            open_in_system_browser(&format!("http://127.0.0.1:{MCP_PORT}/dashboard"))?;
        }
        "help:restart-mcp" => {
            let _ = core.mcp_supervisor.restart().await?;
            broadcast_update_status(app, core);
        }
        "help:check-updates" => {
            open_updates_window(app, core);
            let app_clone = app.clone();
            let core_clone = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let _ = core_clone.updates.check_all(&core_clone.mcp_supervisor).await;
                broadcast_update_status(&app_clone, &core_clone);
            });
        }
        "help:open-keepwork" => {
            open_in_system_browser("https://keepwork.com")?;
        }
        _ => {
            broadcast_to_main(
                app,
                "menu-message",
                &json!({ "type": "command", "id": id }),
            );
        }
    }
    Ok(())
}

fn setup_native_menu_and_tray(app: &AppHandle, core: &Arc<AppCore>) -> tauri::Result<()> {
    let open_chat = MenuItem::with_id(app, "tray:open-chat", "打开聊天", true, None::<&str>)?;
    let open_folder =
        MenuItem::with_id(app, "file:open-folder", "打开文件夹…", true, Some("CmdOrCtrl+O"))?;
    let toggle_pet = CheckMenuItem::with_id(
        app,
        "view:toggle-pet",
        "显示桌面宠物",
        true,
        core.settings().pet_visible,
        None::<&str>,
    )?;
    let toggle_startup = CheckMenuItem::with_id(
        app,
        "view:toggle-login-startup",
        "开机自动启动",
        true,
        core.login_startup.is_enabled(),
        None::<&str>,
    )?;
    let mcp_dashboard = MenuItem::with_id(
        app,
        "help:mcp-dashboard",
        "打开本地 MCP 面板",
        true,
        None::<&str>,
    )?;
    let restart_mcp = MenuItem::with_id(
        app,
        "help:restart-mcp",
        "重启本地 MCP 服务",
        true,
        None::<&str>,
    )?;
    let check_updates =
        MenuItem::with_id(app, "help:check-updates", "检查更新…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "完全退出", true, Some("CmdOrCtrl+Q"))?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let tray_menu = Menu::with_items(
        app,
        &[
            &open_chat,
            &sep1,
            &open_folder,
            &toggle_pet,
            &toggle_startup,
            &sep2,
            &mcp_dashboard,
            &restart_mcp,
            &check_updates,
            &sep3,
            &quit_item,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let mac_check_updates =
            MenuItem::with_id(app, "help:check-updates", "检查更新…", true, None::<&str>)?;
        let mac_quit =
            MenuItem::with_id(app, "tray:quit", "完全退出", true, Some("CmdOrCtrl+Q"))?;
        let mac_open_folder = MenuItem::with_id(
            app,
            "file:open-folder",
            "打开文件夹…",
            true,
            Some("CmdOrCtrl+O"),
        )?;
        let mac_toggle_pet = CheckMenuItem::with_id(
            app,
            "view:toggle-pet",
            "显示桌面宠物",
            true,
            core.settings().pet_visible,
            None::<&str>,
        )?;
        let mac_toggle_startup = CheckMenuItem::with_id(
            app,
            "view:toggle-login-startup",
            "开机自动启动",
            true,
            core.login_startup.is_enabled(),
            None::<&str>,
        )?;
        let mac_mcp_dashboard = MenuItem::with_id(
            app,
            "help:mcp-dashboard",
            "打开本地 MCP 面板",
            true,
            None::<&str>,
        )?;
        let mac_restart_mcp = MenuItem::with_id(
            app,
            "help:restart-mcp",
            "重启本地 MCP 服务",
            true,
            None::<&str>,
        )?;

        let app_sub = Submenu::with_items(
            app,
            "Keepwork",
            true,
            &[
                &mac_check_updates,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("隐藏 Keepwork"))?,
                &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
                &PredefinedMenuItem::separator(app)?,
                &mac_quit,
            ],
        )?;
        let file_sub = Submenu::with_items(
            app,
            "文件",
            true,
            &[
                &mac_open_folder,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "file:close-window",
                    "关闭窗口",
                    true,
                    Some("CmdOrCtrl+W"),
                )?,
            ],
        )?;
        let edit_sub = Submenu::with_items(
            app,
            "编辑",
            true,
            &[
                &PredefinedMenuItem::undo(app, Some("撤销"))?,
                &PredefinedMenuItem::redo(app, Some("重做"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, Some("剪切"))?,
                &PredefinedMenuItem::copy(app, Some("复制"))?,
                &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                &PredefinedMenuItem::select_all(app, Some("全选"))?,
            ],
        )?;
        let view_sub = Submenu::with_items(
            app,
            "视图",
            true,
            &[
                &MenuItem::with_id(app, "view:reload", "重新加载", true, Some("CmdOrCtrl+R"))?,
                &PredefinedMenuItem::separator(app)?,
                &mac_toggle_pet,
                &mac_toggle_startup,
            ],
        )?;
        let help_sub = Submenu::with_items(
            app,
            "帮助",
            true,
            &[&mac_mcp_dashboard, &mac_restart_mcp, &mac_check_updates],
        )?;
        let mac_menu =
            Menu::with_items(app, &[&app_sub, &file_sub, &edit_sub, &view_sub, &help_sub])?;
        let _ = app.set_menu(mac_menu);
    }

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .unwrap_or_else(|_| app.default_window_icon().cloned().unwrap());

    let core_for_menu = Arc::clone(core);
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("KeepWork 第二大脑")
        .menu(&tray_menu)
        .on_menu_event(move |app_handle, event| {
            let id = event.id().as_ref().to_string();
            if id == "tray:open-chat" {
                show_main_window(app_handle, &core_for_menu);
                return;
            }
            if id == "tray:quit" {
                core_for_menu.quitting.store(true, Ordering::Relaxed);
                core_for_menu.terminals.close_all();
                core_for_menu.mcp_supervisor.stop();
                core_for_menu.local_model_supervisor.stop();
                app_handle.exit(0);
                return;
            }
            let app_clone = app_handle.clone();
            let core_clone = Arc::clone(&core_for_menu);
            tauri::async_runtime::spawn(async move {
                let _ = execute_host_command(&app_clone, &core_clone, &id).await;
            });
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    let packaged = !cfg!(debug_assertions);
    let background_launch = std::env::args().any(|a| a == "--background");
    let replace_existing = std::env::var("AICHAT_DESKTOP_REPLACE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let profile_dir = resolve_profile_dir(packaged);
    let _ = std::fs::create_dir_all(&profile_dir);

    let mcp_home = default_mcp_home();
    let _ = std::fs::create_dir_all(&mcp_home);

    if let Ok(exe) = std::env::current_exe() {
        let _ = remember_desktop_client(&mcp_home, APP_VERSION, &exe, packaged);
    }

    let settings_path = profile_dir.join("settings.json");
    let grants_path = profile_dir.join("folder-grants.json");
    let media_grants_path = profile_dir.join("media-grants.json");
    let pet_prefs_path = profile_dir.join("pet-preferences.json");
    let update_meta_path = profile_dir.join("update-metadata.json");
    let desktop_updates_dir = profile_dir.join("desktop-updates");
    let terminal_workspaces_dir = profile_dir.join("terminal-workspaces");
    let mcp_runtimes_dir = profile_dir.join("mcp-runtimes");
    let local_model_runtimes_dir = profile_dir.join("local-model-runtimes");

    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("aichat-rust"));
    let resource_base = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| profile_dir.clone());

    let bundled_mcp_dir = std::env::var("AICHAT_MCP_BUNDLED_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| resource_base.join("resources").join("mcp-runtime"));
    let bundled_local_model_dir = std::env::var("AICHAT_LOCAL_MODEL_BUNDLED_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| resource_base.join("resources").join("local-model-runtime"));

    let mcp_feed_url = std::env::var("AICHAT_MCP_FEED_URL").unwrap_or_else(|_| {
        format!(
            "{DEFAULT_MCP_FEED_BASE}/{}-{}.json",
            current_runtime_platform(),
            current_runtime_arch()
        )
    });

    let mcp_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".to_string(),
        product: "keepwork-mcp-node-runtime".to_string(),
        port: MCP_PORT,
        health_path: "/health".to_string(),
        updates_enabled: true,
        bundled_dir: bundled_mcp_dir,
        store_dir: mcp_runtimes_dir,
        feed_url: mcp_feed_url,
    }));

    let local_model_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "local-model".to_string(),
        product: "keepwork-local-model-node-runtime".to_string(),
        port: LOCAL_MODEL_PORT,
        health_path: "/v1/health".to_string(),
        updates_enabled: false,
        bundled_dir: bundled_local_model_dir,
        store_dir: local_model_runtimes_dir,
        feed_url: String::new(),
    }));

    let updates = Arc::new(UpdateManager::new(
        APP_VERSION.to_string(),
        update_meta_path,
        desktop_updates_dir,
        default_desktop_feed_url(),
        None,
    ));

    let launch_agents_dir = dirs::home_dir()
        .unwrap_or_else(|| profile_dir.clone())
        .join("Library")
        .join("LaunchAgents");
    let login_startup = LoginStartup::new(
        settings_path.clone(),
        launch_agents_dir,
        exe_path,
        packaged,
    );
    let _ = login_startup.ensure_default();

    let mut initial_entry = std::env::var("AICHAT_DESKTOP_DEV_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| ENTRY.to_string());
    let mut initial_dev_srv: Option<DevServer> = None;
    let mut initial_local_source = false;

    if std::env::var("AICHAT_DESKTOP_LOCAL_SOURCE").ok().as_deref() == Some("1") {
        if let Some(src_dir) = resolve_local_aichat_source_dir() {
            if let Ok(srv) = DevServer::start(&src_dir, "AIChat.html") {
                initial_entry = srv.url();
                initial_dev_srv = Some(srv);
                initial_local_source = true;
            }
        }
    } else if let Ok((dep_url, dep_srv)) = open_deployment(&profile_dir.join("deployment.json")) {
        if dep_url != ENTRY {
            initial_entry = dep_url;
            initial_dev_srv = dep_srv;
        }
    }

    let core = Arc::new(AppCore {
        profile_dir: profile_dir.clone(),
        settings_path,
        mcp_home,
        files: NativeFiles::new(grants_path),
        terminals: TerminalSessionManager::new(terminal_workspaces_dir),
        media_grants: MediaGrants::new(media_grants_path),
        login_startup,
        mcp_supervisor,
        local_model_supervisor,
        updates,
        pet: Arc::new(PetController::new(pet_prefs_path)),
        dev_server: Mutex::new(initial_dev_srv),
        entry_url: Mutex::new(initial_entry),
        local_source_enabled: AtomicBool::new(initial_local_source),
        signed_in: AtomicBool::new(true),
        quitting: AtomicBool::new(false),
        channels: Mutex::new(channel_states(&Value::Null)),
        lock: Mutex::new(None),
    });

    let icon_b64 = base64::engine::general_purpose::STANDARD
        .encode(include_bytes!("../icons/keepwork.png"));
    let icon_data_url = format!("data:image/png;base64,{icon_b64}");
    let init_script = build_main_window_init_script(current_runtime_platform(), &icon_data_url);

    let core_for_setup = Arc::clone(&core);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::clone(&core))
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Acquire single-instance lock
            let lock_file = core_for_setup.profile_dir.join("desktop-instance.json");
            let app_for_lock = app_handle.clone();
            let core_for_lock = Arc::clone(&core_for_setup);
            match DesktopLock::acquire(
                lock_file,
                background_launch,
                replace_existing,
                move |should_exit| {
                    if should_exit {
                        core_for_lock.quitting.store(true, Ordering::Relaxed);
                        app_for_lock.exit(0);
                    } else {
                        show_main_window(&app_for_lock, &core_for_lock);
                    }
                },
            ) {
                Ok(Some(lock)) => {
                    if let Ok(mut guard) = core_for_setup.lock.lock() {
                        *guard = Some(lock);
                    }
                }
                Ok(None) => {
                    // Another instance is already running and was notified
                    std::process::exit(0);
                }
                Err(_) => {}
            }

            let _ = setup_native_menu_and_tray(&app_handle, &core_for_setup);

            // Configure main window navigation guard, close-to-tray, and initialization script
            let entry_target = core_for_setup
                .entry_url
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| ENTRY.to_string());

            let core_for_nav = Arc::clone(&core_for_setup);
            let parsed_entry: tauri::Url = entry_target
                .parse()
                .unwrap_or_else(|_| ENTRY.parse().unwrap());
            let mut main_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(parsed_entry),
            )
            .title("KeepWork 第二大脑")
            .inner_size(1360.0, 900.0)
            .min_inner_size(640.0, 480.0)
            .resizable(true)
            .visible(!background_launch)
            .initialization_script(&init_script)
            .on_navigation(move |nav_url| {
                let dev_url = core_for_nav.current_dev_url();
                let url_str = nav_url.as_str();
                if trusted_page(url_str, dev_url.as_deref()) {
                    // Close active PTY sessions & reset pet state on cross-page top navigation
                    core_for_nav.terminals.close_all();
                    core_for_nav.pet.reset_state();
                    return true;
                }
                let _ = open_in_system_browser(url_str);
                false
            });

            #[cfg(target_os = "macos")]
            {
                main_builder = main_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                main_builder = main_builder.decorations(false);
            }

            let main_win = main_builder.build()?;

            let app_for_close = app_handle.clone();
            let core_for_close = Arc::clone(&core_for_setup);
            main_win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !core_for_close.quitting.load(Ordering::Relaxed) {
                        api.prevent_close();
                        if let Some(w) = app_for_close.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        if core_for_close.settings().pet_visible {
                            ensure_pet_window(&app_for_close, &core_for_close, true);
                        }
                    }
                }
            });

            // Background runtime supervisor & self-update scheduler
            let app_bg = app_handle.clone();
            let core_bg = Arc::clone(&core_for_setup);
            tauri::async_runtime::spawn(async move {
                // Start Keepwork MCP (:8089) first, promoting any pending update on startup
                let _ = core_bg.mcp_supervisor.ensure_started(true).await;
                let _ = core_bg.local_model_supervisor.ensure_started(false).await;
                broadcast_update_status(&app_bg, &core_bg);

                // Initial update check after 15s, then every 6 hours
                let app_upd = app_bg.clone();
                let core_upd = Arc::clone(&core_bg);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    loop {
                        let (_snap, newly_staged) =
                            core_upd.updates.check_all(&core_upd.mcp_supervisor).await;
                        if newly_staged {
                            use tauri_plugin_notification::NotificationExt;
                            let _ = app_upd
                                .notification()
                                .builder()
                                .title("Keepwork MCP 更新已就绪")
                                .body("本地 MCP 服务新版本已下载完成，可在「检查更新」窗口或下次重启后生效。")
                                .show();
                        }
                        broadcast_update_status(&app_upd, &core_upd);
                        tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                    }
                });

                // 60s heartbeat for runtimes & tray channel status
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let _ = core_bg.mcp_supervisor.ensure_started(false).await;
                    let _ = core_bg.local_model_supervisor.ensure_started(false).await;
                    let channels = fetch_tray_channels(MCP_PORT, &core_bg.mcp_home).await;
                    if let Ok(mut guard) = core_bg.channels.lock() {
                        *guard = channels.clone();
                    }
                    let signed_in = core_bg.signed_in.load(Ordering::Relaxed);
                    let main_vis = app_bg
                        .get_webview_window("main")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(false);
                    let summary = describe(&channels, signed_in, main_vis);
                    if let Some(tray) = app_bg.tray_by_id("main-tray") {
                        let _ = tray.set_tooltip(Some(&summary.tooltip));
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_report_startup_signin,
            desktop_publish_pet_state,
            desktop_pet_result,
            desktop_check_git,
            desktop_install_git,
            desktop_roots,
            desktop_pick_folder,
            desktop_default_brain_folder,
            desktop_revoke_folder,
            desktop_file,
            desktop_terminal,
            desktop_status,
            desktop_check_updates,
            desktop_install_update,
            desktop_run_menu_command,
            desktop_open_menu,
            desktop_titlebar_action,
            desktop_sync_theme,
            desktop_pet_action,
            updates_window_status,
            updates_window_check,
            updates_window_apply_mcp,
            updates_window_apply_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running KeepWork 第二大脑 (aichat-rust)");
}
