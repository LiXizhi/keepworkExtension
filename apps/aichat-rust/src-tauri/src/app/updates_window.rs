//! Update status delivery, update window and installation commands.

use super::events::broadcast_to_main;
use super::sender::{verify_main_sender, verify_updates_sender};
use super::state::AppCore;
use crate::updates::UpdatesSnapshot;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(super) fn broadcast_update_status(app: &AppHandle, core: &AppCore) {
    let snap = core.updates.snapshot(&core.mcp_supervisor.snapshot());
    broadcast_to_main(app, "update-status", &json!(snap));
    let _ = app.emit("aichat-desktop:update-status", &snap);
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
pub(super) async fn desktop_check_updates(
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
pub(super) async fn desktop_install_update(
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
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        if !app
            .dialog()
            .message("退出并更新桌面应用？应用将关闭并打开新版本安装向导。")
            .title("更新桌面应用")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "退出并更新".into(),
                "取消".into(),
            ))
            .blocking_show()
        {
            return Ok(json!(snap));
        }
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
pub(super) fn updates_window_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<UpdatesSnapshot, String> {
    verify_updates_sender(&window, &state)?;
    Ok(state.updates.snapshot(&state.mcp_supervisor.snapshot()))
}

#[tauri::command]
pub(super) async fn updates_window_check(
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
pub(super) async fn updates_window_apply_mcp(
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
pub(super) async fn updates_window_apply_desktop(
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
