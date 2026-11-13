//! Main-window Bridge v1 commands for files, terminals and desktop chrome.

use super::events::broadcast_to_main;
use super::host_menu::execute_host_command;
use super::platform::{open_in_system_browser, reveal_path_in_os};
use super::sender::verify_main_sender;
use super::state::{AppCore, DesktopStatus};
use crate::brain_folder::{default_brain_folder, BrainFolderInfo};
use crate::deployment::resolve_local_aichat_source_dir;
use crate::files::FolderGrant;
use crate::git_setup::{check_git, install_git, GitInstallResult, GitStatus};
use crate::menu::{
    canonical_host_command, is_allowed_host_command, is_allowed_page_command, menu_payload,
    MenuContextState,
};
use crate::security::ENTRY;
use crate::theme::DesktopTheme;
use crate::APP_VERSION;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub(super) fn desktop_report_startup_signin(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    signed_in: bool,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    state.signed_in.store(signed_in, Ordering::Relaxed);
    Ok(signed_in)
}

#[tauri::command]
pub(super) fn desktop_check_git(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<GitStatus, String> {
    verify_main_sender(&window, &state)?;
    Ok(check_git())
}

#[tauri::command]
pub(super) fn desktop_install_git(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<GitInstallResult, String> {
    verify_main_sender(&window, &state)?;
    Ok(install_git())
}

#[tauri::command]
pub(super) fn desktop_roots(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<Vec<FolderGrant>, String> {
    verify_main_sender(&window, &state)?;
    Ok(state.files.roots())
}

#[tauri::command]
pub(super) async fn desktop_pick_folder(
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
pub(super) fn desktop_default_brain_folder(
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
pub(super) fn desktop_revoke_folder(
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
pub(super) fn desktop_file(
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
pub(super) fn desktop_terminal(
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
pub(super) fn desktop_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<DesktopStatus, String> {
    verify_main_sender(&window, &state)?;
    Ok(state.status_snapshot())
}

#[tauri::command]
pub(super) async fn desktop_run_menu_command(
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

fn menu_context(state: &AppCore) -> MenuContextState {
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
    MenuContextState {
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
    }
}

#[tauri::command]
pub(super) async fn desktop_open_menu(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    menu_id: String,
    left: i32,
    bottom: i32,
    render_mode: Option<String>,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    if render_mode.as_deref().is_some_and(|mode| mode != "shell") {
        return Err("Unsupported menu render mode".to_string());
    }
    let ctx = menu_context(&state);
    let mut payload =
        menu_payload(&menu_id, &ctx).ok_or_else(|| format!("Unsupported menu: {menu_id}"))?;
    payload["anchor"] = json!({ "left": left, "bottom": bottom });
    payload["x"] = json!(left);
    payload["y"] = json!(bottom);
    if render_mode.as_deref() == Some("shell") {
        // The desktop owns its popup. Do not ask a remote/older page to draw a
        // second menu. Page commands still use aichat.desktop-menu.v1 below.
        return Ok(payload);
    }
    // Keep the legacy web menu request/response for older injected renderers.
    broadcast_to_main(&app, "menu-message", &payload);
    Ok(json!(true))
}

#[tauri::command]
pub(super) fn desktop_titlebar_action(
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
        "minimize" => {
            window.minimize().map_err(|e| e.to_string())?;
        }
        "close" => {
            // Preserve CloseRequested handling: hide the window and show the pet.
            window.close().map_err(|e| e.to_string())?;
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
pub(super) fn desktop_sync_theme(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    dark: bool,
    _color: Option<String>,
    _symbol_color: Option<String>,
    confirmed: Option<bool>,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let url = window.url().map_err(|error| error.to_string())?;
    let shell = state.page_connection.lock().unwrap().is_shell(&url);
    let theme = if shell || confirmed == Some(false) {
        state.theme.current()
    } else {
        let theme = DesktopTheme::from_dark(dark);
        let _ = state.theme.remember(theme);
        theme
    };
    let _ = window.set_theme(Some(theme.native()));
    let _ = window.set_background_color(Some(theme.background()));
    Ok(true)
}
