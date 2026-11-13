//! Native menu/tray construction and host command dispatch.

use super::events::broadcast_to_main;
use super::main_window::{
    current_entry_url, hide_main_window, reload_main_window, reset_zoom, show_main_window,
    start_local_source, step_zoom, use_published_site,
};
use super::pet_audio_host::stop_pet_audio;
use super::pet_host::{ensure_pet_window, hide_pet_window};
use super::platform::open_in_system_browser;
use super::state::AppCore;
use super::updates_window::{broadcast_update_status, open_updates_window};
use crate::menu::{canonical_host_command, is_allowed_page_command};
use crate::pet_menu;
use crate::runtime::MCP_PORT;
use crate::APP_VERSION;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

/// 退出桌面端：关闭原生终端、停止两个受管 Runtime 后退出进程
/// （托盘「完全退出」与菜单「退出」共用）。
fn quit_desktop(app: &AppHandle, core: &Arc<AppCore>) {
    core.remote_voice.shutdown();
    stop_pet_audio(app, core, None, "应用正在退出", false);
    core.quitting.store(true, Ordering::Relaxed);
    core.terminals.close_all();
    core.mcp_supervisor.stop();
    core.local_model_supervisor.stop();
    app.exit(0);
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
            hide_main_window(app, core);
            if core.settings().pet_visible {
                ensure_pet_window(app, core, true);
            }
        }
        "reload" => reload_main_window(app, core),
        "remote-voice" => super::remote_voice_host::open_remote_voice_window(app),
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
                hide_pet_window(app, core);
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

pub(super) fn setup_native_menu_and_tray(
    app: &AppHandle,
    core: &Arc<AppCore>,
) -> tauri::Result<()> {
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
    let remote_voice = MenuItem::with_id(app, "remote-voice", "遥控器语音输入…", true, None::<&str>)?;
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
            &remote_voice,
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
                &PredefinedMenuItem::separator(app)?,
                &remote_voice,
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

    #[cfg(target_os = "windows")]
    let tray_icon_bytes: &[u8] = include_bytes!("../../icons/titlebar-k.png");
    #[cfg(not(target_os = "windows"))]
    let tray_icon_bytes: &[u8] = include_bytes!("../../icons/32x32.png");
    let icon = Image::from_bytes(tray_icon_bytes)
        .unwrap_or_else(|_| app.default_window_icon().cloned().unwrap());

    let core_for_menu = Arc::clone(core);
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("KeepWork 第二大脑")
        .menu(&tray_menu)
        .on_menu_event(move |app_handle, event| {
            let id = event.id().as_ref().to_string();
            if id.starts_with(pet_menu::PREFIX) {
                return;
            }
            if id == "tray:open-chat" {
                show_main_window(app_handle, &core_for_menu);
                return;
            }
            if id == "tray:quit" {
                quit_desktop(app_handle, &core_for_menu);
                return;
            }
            if canonical_host_command(&id).unwrap_or(id.as_str()) == "mcp-dashboard" {
                let app_clone = app_handle.clone();
                let url = format!("http://127.0.0.1:{MCP_PORT}/dashboard");
                if let Err(err) = open_in_system_browser(&url) {
                    eprintln!("mcp-dashboard: {err}");
                    show_host_error(&app_clone, &err);
                }
                return;
            }
            let app_clone = app_handle.clone();
            let core_clone = Arc::clone(&core_for_menu);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = execute_host_command(&app_clone, &core_clone, &id).await {
                    if !err.starts_with("Unsupported menu command:") {
                        eprintln!("menu command {id} failed: {err}");
                        show_host_error(&app_clone, &err);
                    }
                }
            });
        })
        .build(app)?;

    Ok(())
}

fn show_host_error(app: &AppHandle, message: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(message)
        .title("Keepwork")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}
