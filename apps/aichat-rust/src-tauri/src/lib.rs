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
use crate::menu::{
    canonical_host_command, is_allowed_host_command, is_allowed_page_command, menu_payload,
    MenuContextState,
};
use crate::permissions::MediaGrants;
use crate::pet::{PetController, WorkArea};
use crate::runtime::{
    current_runtime_arch, current_runtime_platform, mcp_feed_platform, RuntimeConfig,
    RuntimeStatusSnapshot, RuntimeSupervisor, DEFAULT_MCP_FEED_BASE, LOCAL_MODEL_PORT, MCP_PORT,
};
use crate::security::{
    allowed_in_app_popup, allowed_navigation, assert_sender, external_url, ENTRY,
};
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
    webview::NewWindowResponse,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "macos")]
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn sel_registerName(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn objc_msgSend();
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

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
    /// 当前 WebView 缩放比例（Tauri 2.12 没有 zoom 读取接口，需要自己记账）。
    pub zoom: Mutex<f64>,
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

fn primary_button_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let class = objc_getClass(c"NSEvent".as_ptr());
            let sel = sel_registerName(c"pressedMouseButtons".as_ptr());
            if class.is_null() || sel.is_null() {
                return true;
            }
            let send: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> usize =
                std::mem::transmute(objc_msgSend as *const ());
            (send(class, sel) & 1) != 0
        }
    }
    #[cfg(target_os = "windows")]
    {
        unsafe { (GetAsyncKeyState(0x01) as u16) & 0x8000 != 0 }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        true
    }
}

fn logical_work_area(monitor: &tauri::Monitor) -> Option<WorkArea> {
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    // Monitor geometry is already in one logical point space. Convert with each
    // display's own scale so mixed-DPI layouts stay in that shared space.
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let width = size.width.round();
    let height = size.height.round();
    if !pos.x.is_finite() || !pos.y.is_finite() || width < 32.0 || height < 32.0 {
        return None;
    }
    Some(WorkArea {
        x: pos.x.round() as i32,
        y: pos.y.round() as i32,
        width: width as i32,
        height: height as i32,
    })
}

fn logical_monitors(app: &AppHandle) -> Vec<WorkArea> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .filter_map(logical_work_area)
        .collect()
}

fn logical_cursor(app: &AppHandle) -> Option<(i32, i32)> {
    // Tao scales the flipped cursor by the primary display, then we divide by
    // that same scale to get the shared point space used by monitor positions.
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    let cursor = app.cursor_position().ok()?;
    let logical = cursor.to_logical::<f64>(scale);
    if !logical.x.is_finite() || !logical.y.is_finite() {
        return None;
    }
    Some((logical.x.round() as i32, logical.y.round() as i32))
}

fn initial_pet_work_area(app: &AppHandle, pet: &crate::pet::PetController) -> WorkArea {
    let monitors = logical_monitors(app);
    let prefs = pet.preferences();
    if let (Some(x), Some(y)) = (prefs.monitor_x, prefs.monitor_y) {
        if let Some(monitor) = monitors
            .into_iter()
            .find(|area| (area.x - x).abs() <= 4 && (area.y - y).abs() <= 4)
        {
            return monitor;
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .and_then(logical_work_area)
        .unwrap_or_default()
}

fn sync_pet_canvas(window: &WebviewWindow, area: WorkArea) {
    // A transparent window shadow is the pet's alpha mask. Moving the window
    // leaves that mask behind as a white outline.
    let _ = window.set_shadow(false);
    let _ = window.set_position(Position::Logical(LogicalPosition::new(
        area.x as f64,
        area.y as f64,
    )));
    let _ = window.set_size(Size::Logical(LogicalSize::new(
        area.width.max(1) as f64,
        area.height.max(1) as f64,
    )));
    let _ = window.set_shadow(false);
}

fn drag_snapshot(pet: &crate::pet::PetController) -> Value {
    let mut snap = pet.snapshot();
    if let Some(obj) = snap.as_object_mut() {
        obj.insert("dragging".to_string(), json!(pet.is_dragging()));
    }
    snap
}

fn move_with_global_cursor(app: &AppHandle, pet: &crate::pet::PetController) {
    let Some((x, y)) = logical_cursor(app) else {
        return;
    };
    let mut monitors = logical_monitors(app);
    if monitors.is_empty() {
        monitors.push(pet.work_area());
    }
    let Some(area) = pet.drag_global(x, y, &monitors) else {
        return;
    };
    if let Some(window) = app.get_webview_window("pet") {
        sync_pet_canvas(&window, area);
    }
}

fn apply_pet_drag(
    app: &AppHandle,
    pet: &crate::pet::PetController,
    args: &Value,
    force_end: bool,
) -> Value {
    // drag-end with the button still down is a click: do not nudge the sprite.
    // A tracked drag keeps committing the global cursor, including the frame
    // where the button goes up, so the pet lands on the monitor under the cursor.
    let ending = force_end || !primary_button_down();
    if pet.is_global_dragging() && !force_end {
        move_with_global_cursor(app, pet);
    } else if !ending {
        let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        pet.update_drag(x, y);
    }
    if ending {
        pet.end_drag();
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.set_shadow(false);
            // The drag held the full canvas. Accept clicks again so the sprite
            // can be pressed; the page turns click-through back on after it moves off.
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    drag_snapshot(pet)
}

pub fn ensure_pet_window(app: &AppHandle, core: &Arc<AppCore>, show_now: bool) {
    if let Some(existing) = app.get_webview_window("pet") {
        if show_now {
            let _ = existing.show();
        }
        broadcast_pet_state(app, core);
        return;
    }

    let area = initial_pet_work_area(app, &core.pet);
    core.pet.set_work_area(area);
    core.pet.note_canvas(area);

    if let Ok(builder) = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("桌面宠物")
        .position(area.x as f64, area.y as f64)
        .inner_size(area.width as f64, area.height as f64)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(show_now)
        .build()
    {
        let _ = builder.set_shadow(false);
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
    // 页面动作（含旧 id 别名映射到的新页面 id）只投递给 AIChat 页面。
    let canonical = canonical_host_command(&id)
        .unwrap_or(id.as_str())
        .to_string();
    if is_allowed_page_command(&id) || is_allowed_page_command(&canonical) {
        broadcast_to_main(
            &app,
            "menu-message",
            &json!({ "type": "command", "id": canonical }),
        );
        return Ok(true);
    }
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
    let mcp = state.mcp_supervisor.snapshot();
    let updates = state.updates.snapshot(&mcp);
    let entry_url = state
        .entry_url
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| ENTRY.to_string());
    let update_label = if !mcp.pending_version.trim().is_empty() {
        "MCP 更新将在退出并重新打开后生效".to_string()
    } else {
        format!("桌面更新：{}", updates.desktop.state)
    };
    let ctx = MenuContextState {
        local_source_available: resolve_local_aichat_source_dir().is_some(),
        local_source_enabled: state.local_source_enabled.load(Ordering::Relaxed),
        pet_visible: settings.pet_visible,
        open_at_login: state.login_startup.is_enabled(),
        mcp_state: mcp.state,
        mcp_owner: mcp.owner,
        mcp_error: mcp.error,
        mcp_version: mcp.version,
        desktop_version: APP_VERSION.to_string(),
        entry_url,
        update_label,
        update_error: updates.desktop.error,
    };
    if let Some(mut payload) = menu_payload(&menu_id, &ctx) {
        payload["anchor"] = json!({ "left": left, "bottom": bottom });
        payload["x"] = json!(left);
        payload["y"] = json!(bottom);
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
            if let Some((x, y)) = logical_cursor(&app) {
                state.pet.begin_global_drag(x, y);
            } else {
                let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                state.pet.start_drag(x, y);
            }
            Ok(drag_snapshot(&state.pet))
        }
        "drag" => {
            let was_dragging = state.pet.is_dragging();
            let snap = apply_pet_drag(&app, &state.pet, &args, false);
            if was_dragging && !state.pet.is_dragging() {
                broadcast_pet_state(&app, &state);
            }
            Ok(snap)
        }
        "drag-end" => {
            let snap = apply_pet_drag(&app, &state.pet, &args, true);
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

/// 退出桌面端：关闭原生终端、停止两个受管 Runtime 后退出进程
/// （托盘「完全退出」与菜单「退出」共用）。
fn quit_desktop(app: &AppHandle, core: &Arc<AppCore>) {
    core.quitting.store(true, Ordering::Relaxed);
    core.terminals.close_all();
    core.mcp_supervisor.stop();
    core.local_model_supervisor.stop();
    app.exit(0);
}

fn current_entry_url(core: &Arc<AppCore>) -> String {
    core.entry_url
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| ENTRY.to_string())
}

fn reload_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.reload()");
    }
}

fn navigate_main_window(app: &AppHandle, url: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(&format!("window.location.replace({})", json!(url)));
    }
}

/// 按比例步进缩放（Tauri 2.12 无 zoom 读取接口，用 `AppCore::zoom` 记账）。
fn step_zoom(app: &AppHandle, core: &Arc<AppCore>, factor: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let mut guard = core
        .zoom
        .lock()
        .map_err(|_| "Zoom state is unavailable".to_string())?;
    let next = (*guard * factor).clamp(0.5, 3.0);
    *guard = next;
    win.set_zoom(next).map_err(|e| e.to_string())
}

fn reset_zoom(app: &AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
    if let Ok(mut guard) = core.zoom.lock() {
        *guard = 1.0;
    }
    if let Some(win) = app.get_webview_window("main") {
        win.set_zoom(1.0).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启动本地 AIChat 源码服务器（需要目录内存在 `AIChat.html`）。取消选择不改状态。
fn start_local_source(app: &AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(folder) = picked else {
        return Ok(());
    };
    let src_dir = folder.into_path().map_err(|e| e.to_string())?;
    if !src_dir.join("AIChat.html").is_file() {
        app.dialog()
            .message(format!(
                "所选文件夹不包含 AIChat.html：{}",
                src_dir.display()
            ))
            .title("无法使用本地源码服务器")
            .kind(MessageDialogKind::Warning)
            .blocking_show();
        return Err(format!(
            "Missing AIChat entry file: {}",
            src_dir.join("AIChat.html").display()
        ));
    }
    let srv = DevServer::start(&src_dir, "AIChat.html")?;
    let url = srv.url();
    if let Ok(mut guard) = core.dev_server.lock() {
        if let Some(mut previous) = guard.take() {
            previous.stop();
        }
        *guard = Some(srv);
    }
    if let Ok(mut entry) = core.entry_url.lock() {
        *entry = url.clone();
    }
    core.local_source_enabled.store(true, Ordering::Relaxed);
    navigate_main_window(app, &url);
    Ok(())
}

/// 切回线上入口：关闭本地 dev server 并重新加载主窗口。
fn use_published_site(app: &AppHandle, core: &Arc<AppCore>) {
    if let Ok(mut guard) = core.dev_server.lock() {
        if let Some(mut previous) = guard.take() {
            previous.stop();
        }
    }
    if let Ok(mut entry) = core.entry_url.lock() {
        *entry = ENTRY.to_string();
    }
    core.local_source_enabled.store(false, Ordering::Relaxed);
    navigate_main_window(app, ENTRY);
}

/// 读取本机 MCP `/admin/status`（2 秒超时）；服务未运行时返回 None。
async fn fetch_mcp_admin_status() -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{MCP_PORT}/admin/status"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

fn json_text(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 「查看状态…」：优先展示本机 `/admin/status` 实时信息，失败时回退到 supervisor 快照。
async fn show_mcp_status(app: &AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let snap = core.mcp_supervisor.snapshot();
    let live = fetch_mcp_admin_status().await;

    let mut state = snap.state.clone();
    let mut owner = snap.owner.clone();
    let mut version = snap.version.clone();
    let mut pid = snap.pid.to_string();
    let mut port = snap.port.to_string();
    let mut workspace = String::new();
    let error = snap.error.clone();
    if let Some(live) = live.as_ref() {
        if let Some(v) = json_text(live, "version") {
            version = v;
        }
        if let Some(v) = json_text(live, "pid") {
            pid = v;
        }
        if let Some(v) = json_text(live, "port") {
            port = v;
        }
        if let Some(v) = json_text(live, "workspaceRoot") {
            workspace = v;
        }
        if let Some(v) = json_text(live, "hostKind") {
            owner = v;
        }
        if state.trim().is_empty() || state == "stopped" {
            state = "running".to_string();
        }
    }

    let mut lines = vec![
        format!("状态：{state}"),
        format!("管理者：{owner}"),
        format!("版本：{version}"),
        format!("PID：{pid}"),
        format!("端口：{port}"),
    ];
    if !workspace.trim().is_empty() {
        lines.push(format!("工作目录：{workspace}"));
    }
    if !error.trim().is_empty() {
        lines.push(format!("错误：{}", clip_text(&error, 200)));
    }
    if live.is_none() && state != "running" {
        lines.push("提示：本机 MCP 服务未运行。".to_string());
    }

    let open_dashboard = app
        .dialog()
        .message(lines.join("\n"))
        .title("Keepwork MCP 状态")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "打开 Dashboard".to_string(),
            "关闭".to_string(),
        ))
        .blocking_show();
    if open_dashboard {
        open_in_system_browser(&format!("http://127.0.0.1:{MCP_PORT}/dashboard"))?;
    }
    Ok(())
}

fn clip_text(raw: &str, max_chars: usize) -> String {
    raw.trim().chars().take(max_chars).collect()
}

/// 执行主机命令。`id` 允许是旧 id（会先规范化为新 id）。
pub async fn execute_host_command(
    app: &AppHandle,
    core: &Arc<AppCore>,
    id: &str,
) -> Result<(), String> {
    let id = canonical_host_command(id).unwrap_or(id);
    // 原生菜单/托盘也可能投递页面命令，这里统一转发给 AIChat 页面。
    if is_allowed_page_command(id) {
        broadcast_to_main(app, "menu-message", &json!({ "type": "command", "id": id }));
        return Ok(());
    }
    match id {
        "open-folder" => {
            use tauri_plugin_dialog::DialogExt;
            if let Some(folder) = app.dialog().file().blocking_pick_folder() {
                if let Ok(path) = folder.into_path() {
                    let grant = core.files.grant(&path)?;
                    broadcast_to_main(app, "folder-selected", &json!(grant));
                }
            }
        }
        "close-window" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
                if core.settings().pet_visible {
                    ensure_pet_window(app, core, true);
                }
            }
        }
        "reload" => reload_main_window(app),
        "fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                let cur = win.is_fullscreen().unwrap_or(false);
                let _ = win.set_fullscreen(!cur);
            }
        }
        "zoom-in" => step_zoom(app, core, 1.1)?,
        "zoom-out" => step_zoom(app, core, 1.0 / 1.1)?,
        "zoom-reset" => reset_zoom(app, core)?,
        "toggle-pet" => {
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
        "toggle-login" => {
            let cur = core.login_startup.is_enabled();
            let _ = core.login_startup.set_enabled(!cur);
        }
        "local-source" => start_local_source(app, core)?,
        "published-site" => use_published_site(app, core),
        "quit" => quit_desktop(app, core),
        "mcp-dashboard" => {
            open_in_system_browser(&format!("http://127.0.0.1:{MCP_PORT}/dashboard"))?;
        }
        "mcp-restart" => {
            let _ = core.mcp_supervisor.restart().await?;
            broadcast_update_status(app, core);
        }
        "mcp-status" => show_mcp_status(app, core).await?,
        "open-browser" => {
            let target = current_entry_url(core);
            open_in_system_browser(&target)?;
        }
        "check-updates" => {
            open_updates_window(app, core);
            let app_clone = app.clone();
            let core_clone = Arc::clone(core);
            tauri::async_runtime::spawn(async move {
                let _ = core_clone
                    .updates
                    .check_all(&core_clone.mcp_supervisor)
                    .await;
                broadcast_update_status(&app_clone, &core_clone);
            });
        }
        "open-keepwork" => {
            open_in_system_browser("https://keepwork.com")?;
        }
        // 编辑区动作：在受信任主框架里执行浏览器内置编辑命令（不拼接外部输入）。
        "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" => {
            let Some(win) = app.get_webview_window("main") else {
                return Ok(());
            };
            let script = match id {
                "undo" => "document.execCommand('undo')",
                "redo" => "document.execCommand('redo')",
                "cut" => "document.execCommand('cut')",
                "copy" => "document.execCommand('copy')",
                "paste" => "document.execCommand('paste')",
                _ => "document.execCommand('selectAll')",
            };
            // `paste` 常因系统剪贴板权限失败，静默忽略，避免弹出无意义错误。
            if id == "paste" {
                let _ = win.eval(script);
            } else {
                win.eval(script).map_err(|e| e.to_string())?;
            }
        }
        "version" | "app:version" | "tray:version" | "help:version" | "help:desktop-version" => {
            return Ok(());
        }
        other => return Err(format!("Unsupported menu command: {other}")),
    }
    Ok(())
}

fn setup_native_menu_and_tray(app: &AppHandle, core: &Arc<AppCore>) -> tauri::Result<()> {
    let open_chat = MenuItem::with_id(app, "tray:open-chat", "打开聊天", true, None::<&str>)?;
    // 页面命令也可以从原生托盘投递（`execute_host_command` 会转发给 AIChat 页面）。
    let new_chat = MenuItem::with_id(app, "new-chat", "新建对话", true, None::<&str>)?;
    let open_settings = MenuItem::with_id(app, "open-settings", "设置", true, None::<&str>)?;
    let open_folder = MenuItem::with_id(
        app,
        "file:open-folder",
        "打开文件夹…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
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
    let tray_version = MenuItem::with_id(
        app,
        "tray:version",
        format!("版本 {APP_VERSION}"),
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "完全退出", true, Some("CmdOrCtrl+Q"))?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    let tray_menu = Menu::with_items(
        app,
        &[
            &open_chat,
            &new_chat,
            &open_settings,
            &sep4,
            &open_folder,
            &toggle_pet,
            &toggle_startup,
            &sep1,
            &mcp_dashboard,
            &restart_mcp,
            &check_updates,
            &tray_version,
            &sep2,
            &quit_item,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let mac_check_updates =
            MenuItem::with_id(app, "help:check-updates", "检查更新…", true, None::<&str>)?;
        let mac_version = MenuItem::with_id(
            app,
            "help:version",
            format!("版本 {APP_VERSION}"),
            false,
            None::<&str>,
        )?;
        let mac_quit = MenuItem::with_id(app, "tray:quit", "完全退出", true, Some("CmdOrCtrl+Q"))?;
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
                &mac_version,
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
                &MenuItem::with_id(app, "new-chat", "新建对话", true, Some("CmdOrCtrl+N"))?,
                &mac_open_folder,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "reload", "重新加载", true, Some("CmdOrCtrl+R"))?,
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
                &MenuItem::with_id(app, "zoom-in", "放大", true, Some("CmdOrCtrl+="))?,
                &MenuItem::with_id(app, "zoom-out", "缩小", true, Some("CmdOrCtrl+-"))?,
                &MenuItem::with_id(app, "zoom-reset", "实际大小", true, Some("CmdOrCtrl+0"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "fullscreen", "全屏", true, Some("F11"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "open-settings", "设置", true, None::<&str>)?,
                &MenuItem::with_id(app, "toggle-sidebar", "历史侧栏", true, None::<&str>)?,
                &MenuItem::with_id(app, "toggle-files", "文件面板", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &mac_toggle_pet,
                &mac_toggle_startup,
            ],
        )?;
        let mac_help_version = MenuItem::with_id(
            app,
            "help:desktop-version",
            format!("桌面版本 {APP_VERSION}"),
            false,
            None::<&str>,
        )?;
        let help_sub = Submenu::with_items(
            app,
            "帮助",
            true,
            &[
                &mac_mcp_dashboard,
                &mac_restart_mcp,
                &mac_check_updates,
                &PredefinedMenuItem::separator(app)?,
                &mac_help_version,
            ],
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
                quit_desktop(app_handle, &core_for_menu);
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

/// Products this desktop can launch: the packaged Node runtime and the native
/// Rust daemon (v2 manifest, `engine: "rust"`).
const MCP_PRODUCT_NODE: &str = "keepwork-mcp-node-runtime";
const MCP_PRODUCT_RUST: &str = "keepwork-mcp-runtime";
const LOCAL_MODEL_PRODUCT: &str = "keepwork-local-model-node-runtime";

fn valid_mcp_runtime(dir: &Path, products: &[&str]) -> bool {
    crate::runtime::validate_runtime_dir_any(dir, products).is_ok()
}

/// Reuse the MCP runtime installed by DesktopLauncher when the app bundle does
/// not carry one (A+C bootstrap: bundled > launcher > CDN).
fn launcher_mcp_runtime(products: &[&str]) -> Option<PathBuf> {
    let releases = dirs::data_local_dir()?
        .join("Keepwork")
        .join("DesktopLauncher")
        .join("releases");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(releases).ok()? {
        let Ok(entry) = entry else { continue };
        let dir = entry.path().join("mcp");
        if !valid_mcp_runtime(&dir, products) {
            continue;
        }
        let modified = std::fs::metadata(dir.join("runtime.json"))
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(time, _)| modified > *time) {
            best = Some((modified, dir));
        }
    }
    best.map(|(_, dir)| dir)
}

fn resolve_bundled_mcp_dir(resource_base: &Path, products: &[&str]) -> PathBuf {
    let arch = crate::runtime::current_runtime_arch();
    let roots = [
        resource_base.join("..").join("Resources"),
        resource_base.join("..").join("Resources").join("resources"),
        resource_base.join("resources"),
        resource_base.join("../..").join("resources"),
        resource_base.join("../../..").join("resources"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
    ];
    let mut legacy = None;
    for root in roots {
        // scripts/bundle-mcp-runtime.cjs lays the app's own server out per slice,
        // so a universal macOS build can carry both arm64 and x64 runtimes.
        let per_arch = root.join("mcp-runtime").join(arch);
        if valid_mcp_runtime(&per_arch, products) {
            return per_arch;
        }
        let flat = root.join("mcp-runtime");
        if legacy.is_none() && valid_mcp_runtime(&flat, products) {
            legacy = Some(flat);
        }
    }
    legacy
        .or_else(|| launcher_mcp_runtime(products))
        .unwrap_or_else(|| {
            resource_base
                .join("resources")
                .join("mcp-runtime")
                .join(arch)
        })
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
        .unwrap_or_else(|_| {
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_RUST, MCP_PRODUCT_NODE])
        });
    // The published feed still carries Node runtimes; a Rust build must not
    // download a Node runtime over itself.
    let bundled_mcp_is_rust =
        crate::runtime::validate_runtime_dir(&bundled_mcp_dir, MCP_PRODUCT_RUST).is_ok();
    let bundled_local_model_dir = std::env::var("AICHAT_LOCAL_MODEL_BUNDLED_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| resource_base.join("resources").join("local-model-runtime"));

    let mcp_feed_url = std::env::var("AICHAT_MCP_FEED_URL").unwrap_or_else(|_| {
        format!(
            "{DEFAULT_MCP_FEED_BASE}/{}-{}.json",
            mcp_feed_platform(),
            current_runtime_arch()
        )
    });

    let mcp_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".to_string(),
        products: if bundled_mcp_is_rust {
            vec![MCP_PRODUCT_RUST.to_string()]
        } else {
            vec![MCP_PRODUCT_NODE.to_string(), MCP_PRODUCT_RUST.to_string()]
        },
        port: MCP_PORT,
        health_path: "/health".to_string(),
        updates_enabled: !bundled_mcp_is_rust,
        bundled_dir: bundled_mcp_dir,
        store_dir: mcp_runtimes_dir,
        feed_url: mcp_feed_url,
    }));

    let local_model_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "local-model".to_string(),
        products: vec![LOCAL_MODEL_PRODUCT.to_string()],
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
    let login_startup =
        LoginStartup::new(settings_path.clone(), launch_agents_dir, exe_path, packaged);
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
        zoom: Mutex::new(1.0),
        signed_in: AtomicBool::new(true),
        quitting: AtomicBool::new(false),
        channels: Mutex::new(channel_states(&Value::Null)),
        lock: Mutex::new(None),
    });

    let icon_b64 =
        base64::engine::general_purpose::STANDARD.encode(include_bytes!("../icons/keepwork.png"));
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

            // Bring the MCP daemon up before the webview's first /health probe.
            // A missing runtime fails fast; the update checker stages one for
            // the next launch. Runs after the single-instance lock so a second
            // launch does not start a daemon before exiting.
            let _ = tauri::async_runtime::block_on(
                core_for_setup.mcp_supervisor.ensure_started(true),
            );

            let _ = setup_native_menu_and_tray(&app_handle, &core_for_setup);

            // Configure main window navigation guard, close-to-tray, and initialization script
            let entry_target = core_for_setup
                .entry_url
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| ENTRY.to_string());

            let core_for_nav = Arc::clone(&core_for_setup);
            let core_for_popup = Arc::clone(&core_for_setup);
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
                if allowed_navigation(url_str, dev_url.as_deref()) {
                    // Close active PTY sessions & reset pet state on cross-page top navigation
                    core_for_nav.terminals.close_all();
                    core_for_nav.pet.reset_state();
                    return true;
                }
                let _ = open_in_system_browser(url_str);
                false
            })
            .on_new_window(move |url, _features| {
                let dev_url = core_for_popup.current_dev_url();
                if allowed_in_app_popup(url.as_str(), dev_url.as_deref()) {
                    // Login popups (Google / Feishu / DingTalk) need window.opener
                    // and the /sso callback to complete inside the app.
                    NewWindowResponse::Allow
                } else {
                    let _ = open_in_system_browser(url.as_str());
                    NewWindowResponse::Deny
                }
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

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod pet_drag_host_tests {
    #[test]
    fn primary_button_is_up_without_a_held_click() {
        assert!(
            !super::primary_button_down(),
            "idle primary button must read as up, or every drag frame will end immediately"
        );
    }
}

#[cfg(test)]
mod bundled_runtime_tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn write_runtime(dir: &Path) {
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::write(dir.join("bin").join("node"), b"#!/bin/sh\n").unwrap();
        fs::write(dir.join("dist").join("cli.cjs"), b"// mcp\n").unwrap();
        fs::write(
            dir.join("runtime.json"),
            r#"{"product":"keepwork-mcp-node-runtime","platform":"darwin","arch":"arm64","version":"0.1.45","commit":"0123456789abcdef0123456789abcdef01234567","node":"bin/node","entry":"dist/cli.cjs"}"#,
        )
        .unwrap();
    }

    #[test]
    fn bundled_runtime_is_resolved_per_architecture() {
        let resource_base =
            std::env::temp_dir().join(format!("aichat-rust-bundle-{}", Uuid::new_v4()));
        let arch = crate::runtime::current_runtime_arch();
        let per_arch = resource_base
            .join("resources")
            .join("mcp-runtime")
            .join(arch);
        let legacy = resource_base.join("resources").join("mcp-runtime");
        write_runtime(&per_arch);
        write_runtime(&legacy);
        crate::runtime::validate_runtime_dir(&per_arch, "keepwork-mcp-node-runtime")
            .expect("fixture runtime must validate");

        assert_eq!(
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_NODE]),
            per_arch,
            "the slice bundled by scripts/bundle-mcp-runtime.cjs must win over a flat runtime"
        );
        fs::remove_dir_all(&resource_base).unwrap();
    }

    #[test]
    fn flat_bundled_runtime_still_works_for_older_layouts() {
        let resource_base =
            std::env::temp_dir().join(format!("aichat-rust-flat-{}", Uuid::new_v4()));
        let legacy = resource_base.join("resources").join("mcp-runtime");
        write_runtime(&legacy);

        assert_eq!(
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_NODE]),
            legacy
        );
        fs::remove_dir_all(&resource_base).unwrap();
    }
}
