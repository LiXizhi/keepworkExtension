//! Main document lifecycle, connection recovery and local source navigation.

use super::pet_audio_host::stop_pet_audio;
use super::sender::verify_main_sender;
use super::state::{AppCore, DesktopStatus};
use crate::dev_server::DevServer;
use crate::page_connection::{Phase, LOAD_TIMEOUT_SECONDS};
use crate::pet::PetController;
use crate::security::{self, ENTRY};
use crate::terminal::TerminalSessionManager;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{webview::PageLoadEvent, AppHandle, Manager, WebviewWindow};

pub(super) fn handle_main_page_load(
    event: PageLoadEvent,
    terminals: &TerminalSessionManager,
    pet: &PetController,
) -> bool {
    if event != PageLoadEvent::Started {
        return false;
    }
    terminals.close_all();
    pet.reset_state();
    true
}

pub fn show_main_window(app: &AppHandle, core: &AppCore) {
    stop_pet_audio(app, core, None, "已打开主窗口，语音输入已停止", false);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(pet_win) = app.get_webview_window("pet") {
        let _ = pet_win.hide();
    }
}

pub(super) fn current_entry_url(core: &Arc<AppCore>) -> String {
    core.entry_url
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| ENTRY.to_string())
}

pub(super) fn reload_main_window(app: &AppHandle, core: &Arc<AppCore>) {
    let ready = core.page_connection.lock().unwrap().snapshot("").phase == Phase::Ready;
    let target = if ready {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(url) = window.url() {
                // Same-origin documents outside the chat entry retain their
                // historical explicit-refresh behavior, without recovery IPC.
                if !security::trusted_page(url.as_str(), core.current_dev_url().as_deref()) {
                    let _ = window.reload();
                    return;
                }
                Some(url.to_string())
            } else {
                None
            }
        } else {
            None
        }
    } else {
        let connection = core.page_connection.lock().unwrap();
        (!connection.target().is_empty()).then(|| connection.target().to_string())
    }
    .unwrap_or_else(|| current_entry_url(core));
    start_page_connection(app, core, &target, false);
}

fn navigate_main_window(app: &AppHandle, core: &Arc<AppCore>, url: &str) {
    start_page_connection(app, core, url, false);
}

fn show_connection_failure(app: &AppHandle, core: &AppCore, generation: u64, reason: &str) {
    if core.quitting.load(Ordering::Relaxed) {
        return;
    }
    let shell = {
        let mut connection = core.page_connection.lock().unwrap();
        if !connection.fail(generation, reason) {
            return;
        }
        connection.shell_url.clone()
    };
    if let (Some(window), Some(shell)) = (app.get_webview_window("main"), shell) {
        let _ = window.navigate(shell);
    }
}

fn start_page_connection(app: &AppHandle, core: &Arc<AppCore>, target: &str, automatic: bool) {
    if core.quitting.load(Ordering::Relaxed) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(generation) = core
        .page_connection
        .lock()
        .unwrap()
        .begin(target, automatic)
    else {
        return;
    };
    // The URL is always chosen by the host; recovery IPC cannot supply a URL.
    let url = target
        .parse::<tauri::Url>()
        .ok()
        .filter(|_| security::trusted_page(target, core.current_dev_url().as_deref()));
    let Some(url) = url else {
        show_connection_failure(
            app,
            core,
            generation,
            "配置的页面地址不可用，请检查入口设置或重新选择本地源码目录。",
        );
        return;
    };
    if window.navigate(url).is_err() {
        show_connection_failure(
            app,
            core,
            generation,
            "无法打开页面，请检查网络连接或页面服务后重试。",
        );
        return;
    }
    let app = app.clone();
    let core = Arc::clone(core);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(LOAD_TIMEOUT_SECONDS)).await;
        let dispatcher = app.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            show_connection_failure(
                &app,
                &core,
                generation,
                "页面未在 20 秒内就绪，请检查网络连接或页面服务后重试。",
            );
        });
    });
}

fn verify_connection_token(
    window: &WebviewWindow,
    core: &AppCore,
    token: &str,
    shell_only: bool,
) -> Result<tauri::Url, String> {
    verify_main_sender(window, core)?;
    let url = window.url().map_err(|_| "无法确认页面地址")?;
    let connection = core.page_connection.lock().unwrap();
    if connection.token != token || (shell_only && !connection.is_shell(&url)) {
        return Err("Unauthorized connection page".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub(super) fn desktop_page_connection_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    token: String,
) -> Result<DesktopStatus, String> {
    verify_connection_token(&window, &state, &token, true)?;
    Ok(state.status_snapshot())
}

#[tauri::command]
pub(super) fn desktop_retry_page_connection(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    token: String,
    automatic: bool,
) -> Result<(), String> {
    verify_connection_token(&window, &state, &token, true)?;
    let target = {
        let connection = state.page_connection.lock().unwrap();
        connection.target().to_string()
    };
    let target = if target.is_empty() {
        current_entry_url(&state)
    } else {
        target
    };
    start_page_connection(&app, &state, &target, automatic);
    Ok(())
}

#[tauri::command]
pub(super) fn desktop_page_connection_attempt(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    token: String,
    url: String,
) -> Result<Option<u64>, String> {
    let actual = verify_connection_token(&window, &state, &token, false)?;
    if actual.as_str() != url {
        return Ok(None);
    }
    Ok(state.page_connection.lock().unwrap().attempt(&actual))
}

#[tauri::command]
pub(super) fn desktop_main_document_ready(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    token: String,
    url: String,
    generation: u64,
) -> Result<bool, String> {
    let actual = verify_connection_token(&window, &state, &token, false)?;
    if actual.as_str() != url {
        return Ok(false);
    }
    Ok(state
        .page_connection
        .lock()
        .unwrap()
        .document_ready(generation, &actual))
}

/// 按比例步进缩放（Tauri 2.12 无 zoom 读取接口，用 `AppCore::zoom` 记账）。
pub(super) fn step_zoom(app: &AppHandle, core: &Arc<AppCore>, factor: f64) -> Result<(), String> {
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

pub(super) fn reset_zoom(app: &AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
    if let Ok(mut guard) = core.zoom.lock() {
        *guard = 1.0;
    }
    if let Some(win) = app.get_webview_window("main") {
        win.set_zoom(1.0).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启动本地 AIChat 源码服务器（需要目录内存在 `AIChat.html`）。取消选择不改状态。
pub(super) fn start_local_source(app: &AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
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
    let url = {
        let mut guard = core
            .dev_server
            .lock()
            .map_err(|_| "Local source server lock poisoned")?;
        DevServer::select_source(
            &mut guard,
            &src_dir,
            "AIChat.html",
            &core.profile_dir.join("source-ports.json"),
        )?
    };
    if let Ok(mut entry) = core.entry_url.lock() {
        *entry = url.clone();
    }
    core.local_source_enabled.store(true, Ordering::Relaxed);
    navigate_main_window(app, core, &url);
    Ok(())
}

/// 切回线上入口：关闭本地 dev server 并重新加载主窗口。
pub(super) fn use_published_site(app: &AppHandle, core: &Arc<AppCore>) {
    if let Ok(mut guard) = core.dev_server.lock() {
        if let Some(mut previous) = guard.take() {
            previous.stop();
        }
    }
    if let Ok(mut entry) = core.entry_url.lock() {
        *entry = ENTRY.to_string();
    }
    core.local_source_enabled.store(false, Ordering::Relaxed);
    navigate_main_window(app, core, ENTRY);
}

#[cfg(test)]
mod main_page_lifecycle_tests {
    use super::*;
    use crate::files::NativeFiles;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    #[tokio::test]
    async fn only_replacing_the_main_document_invalidates_pet_commands_and_terminals() {
        let root = std::env::temp_dir().join(format!("aichat-page-load-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let files = NativeFiles::new(root.join("grants.json"));
        let terminals = TerminalSessionManager::new(root.join("workspaces"));
        let pet = PetController::new(root.join("pet-prefs.json"));
        let online = json!({
            "version": 1, "context": "old-page", "target": "chat",
            "title": "语音会话", "ready": true, "canCall": true,
            "draft": "保留草稿", "voice": { "active": true, "state": "listening" }
        });
        pet.update_raw_state(online);
        let before = pet.snapshot();
        let session = terminals
            .handle(
                "desktop:main",
                &files,
                "create",
                &json!({ "workspace": "voice-test" }),
            )
            .unwrap();
        let id = session["id"].as_str().unwrap();
        let (command, receiver) = pet
            .begin_command("mute", &json!({ "context": "old-page" }))
            .unwrap();

        // Page completion may follow a valid snapshot/command from the new
        // document; it must not disconnect voice or destroy a live terminal.
        assert!(!handle_main_page_load(
            PageLoadEvent::Finished,
            &terminals,
            &pet
        ));
        assert_eq!(pet.snapshot(), before);
        assert!(terminals
            .handle("desktop:main", &files, "output", &json!({ "id": id }))
            .is_ok());
        assert!(pet.resolve_command(&json!({ "requestId": command["requestId"], "ok": true })));
        pet.wait_for_command(
            command["requestId"].as_str().unwrap(),
            receiver,
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        let (old_command, old_receiver) = pet
            .begin_command("mute", &json!({ "context": "old-page" }))
            .unwrap();
        assert!(handle_main_page_load(
            PageLoadEvent::Started,
            &terminals,
            &pet
        ));
        let offline = pet.snapshot();
        assert_eq!(offline["ready"], false);
        assert_ne!(offline["context"], before["context"]);
        assert_eq!(offline["draft"], "");
        assert_ne!(offline["voice"]["active"], true);
        assert!(terminals
            .handle("desktop:main", &files, "output", &json!({ "id": id }))
            .is_err());
        assert!(pet
            .wait_for_command(
                old_command["requestId"].as_str().unwrap(),
                old_receiver,
                Duration::from_secs(1)
            )
            .await
            .is_err());
        assert!(!pet.resolve_command(&json!({ "requestId": old_command["requestId"], "ok": true })));
        assert!(pet
            .begin_command("call", &json!({ "context": "old-page" }))
            .is_err());

        // Existing Bridge v1 pages restore the pet without any new handshake
        // or server capability. A subsequent Finished must preserve that state.
        pet.update_raw_state(
            json!({ "version": 1, "context": "new-page", "ready": true, "canCall": true }),
        );
        assert!(!handle_main_page_load(
            PageLoadEvent::Finished,
            &terminals,
            &pet
        ));
        assert_eq!(pet.snapshot()["ready"], true);
        assert!(pet
            .begin_command("dictation", &json!({ "context": "new-page" }))
            .is_ok());
        assert!(pet
            .begin_command("call", &json!({ "context": "new-page" }))
            .is_ok());

        terminals.close_all();
        fs::remove_dir_all(root).unwrap();
    }
}
