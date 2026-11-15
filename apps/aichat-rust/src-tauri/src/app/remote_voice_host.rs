//! Only the local settings window can start/stop native cloud dictation.
use super::state::AppCore;
use crate::remote_voice::{RecordingFocus, VoiceConfig, VoiceSnapshot};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PREPARE_COMPOSER: &str = include_str!("remote_voice_composer.js");

enum ComposerOwner {
    Document,
    Restored,
    Other,
    // On Windows a focused descendant HWND could belong to either WebView2 controller.
    #[cfg(not(target_os = "macos"))]
    CheckDocument,
    Blocked,
}

#[cfg(target_os = "macos")]
fn composer_owner(view: &tauri::webview::PlatformWebview) -> ComposerOwner {
    extern "C" { fn keepwork_voice_prepare_document(owner: *mut std::ffi::c_void) -> i32; }
    match unsafe { keepwork_voice_prepare_document(view.inner()) } {
        2 => ComposerOwner::Restored,
        1 => ComposerOwner::Document,
        0 => ComposerOwner::Other,
        _ => ComposerOwner::Blocked,
    }
}

#[cfg(windows)]
fn composer_owner(view: &tauri::webview::PlatformWebview) -> ComposerOwner {
    use windows::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;

    let controller = view.controller();
    let mut parent = HWND::default();
    unsafe {
        if controller.ParentWindow(&mut parent).is_err() { return ComposerOwner::Blocked; }
        let root = GetAncestor(parent.0, GA_ROOT);
        if root.is_null() || GetForegroundWindow() != root { return ComposerOwner::Other; }
        let mut info = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if GetGUIThreadInfo(0, &mut info) == 0 { return ComposerOwner::Blocked; }
        if info.hwndActive != root || info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE | GUI_INMOVESIZE) != 0 {
            return ComposerOwner::Other;
        }
        if info.hwndFocus.is_null() || info.hwndFocus == root || info.hwndFocus == parent.0 {
            // Only empty native chrome: never redirect another child control's focus.
            return if controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC).is_ok() {
                ComposerOwner::Restored
            } else {
                ComposerOwner::Blocked
            };
        }
        ComposerOwner::CheckDocument
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn composer_owner(_view: &tauri::webview::PlatformWebview) -> ComposerOwner {
    ComposerOwner::CheckDocument
}

/// Preserve another app or native control. Only repair the owner of an already-active main window.
pub(super) fn prepare_main_composer(app: &AppHandle) -> RecordingFocus {
    let Some(main) = app.get_webview_window("main") else { return Ok(None); };
    if !main.is_focused().unwrap_or(false) { return Ok(None); }
    let core = app.state::<Arc<AppCore>>();
    if !main.url().is_ok_and(|url| crate::security::trusted_page(url.as_str(), core.current_dev_url().as_deref())) {
        return Ok(None);
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let document = main.clone();
    main.with_webview(move |view| {
        let script = match composer_owner(&view) {
            ComposerOwner::Other => { let _ = send.send(true); return; }
            ComposerOwner::Blocked => { let _ = send.send(false); return; }
            ComposerOwner::Document => PREPARE_COMPOSER.to_owned(),
            ComposerOwner::Restored => {
                tauri::async_runtime::spawn(async move {
                    // Native first-responder changes reach the WebKit content process asynchronously.
                    // Only recheck ownership; never activate a window or issue a second focus repair.
                    for _ in 0..6 {
                        if send.is_closed() { return; }
                        if !document.is_focused().unwrap_or(false) { let _ = send.send(true); return; }
                        let (reply, state) = tokio::sync::oneshot::channel();
                        let reply = std::sync::Mutex::new(Some(reply));
                        let script = format!("document.hasFocus() ? ({PREPARE_COMPOSER}) : null");
                        if document.eval_with_callback(script, move |result| {
                            if let Some(reply) = reply.lock().unwrap().take() {
                                let _ = reply.send(result);
                            }
                        }).is_err() { break; }
                        let Ok(Ok(result)) = tokio::time::timeout(std::time::Duration::from_millis(150), state).await else { break; };
                        match result.as_str() {
                            "true" => { let _ = send.send(true); return; }
                            "null" => tokio::time::sleep(std::time::Duration::from_millis(16)).await,
                            _ => break,
                        }
                    }
                    let _ = send.send(false);
                });
                return;
            }
            #[cfg(not(target_os = "macos"))]
            ComposerOwner::CheckDocument => format!("!document.hasFocus() || ({PREPARE_COMPOSER})"),
        };
        let send = std::sync::Mutex::new(Some(send));
        // A dropped callback also fails closed through the existing per-press acknowledgement.
        let _ = document.eval_with_callback(script, move |result| {
            if let Some(send) = send.lock().unwrap().take() {
                let _ = send.send(result == "true");
            }
        });
    }).map_err(|_| "无法聚焦 AIChat 输入框。".to_owned())?;
    Ok(Some(receive))
}

/// Called on the remote worker after the pet declines Back. A positive result
/// consumes this press. Only an untouched target may fall through to native AX.
#[cfg(target_os = "macos")]
pub(super) fn clear_main_composer(
    app: &AppHandle,
    pressed: std::time::Instant,
    is_current: impl FnOnce() -> bool + Send + 'static,
) -> Result<bool, String> {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    const SCRIPT: &str = include_str!("remote_voice_clear_composer.js");
    const STALE: &str = "输入目标已改变。";
    const BLOCKED: &str = "无法清空当前聊天输入框。";
    let Some(main) = app.get_webview_window("main") else { return Ok(false); };
    if !main.is_focused().map_err(|e| e.to_string())? { return Ok(false); }
    let Some(url) = super::sender::loaded_page_url(&main)? else { return Err(STALE.into()); };
    let core = app.state::<Arc<AppCore>>();
    if !crate::security::trusted_page(url.as_str(), core.current_dev_url().as_deref()) { return Ok(false); }
    let remaining = || Duration::from_secs(1).checked_sub(pressed.elapsed()).ok_or(STALE);
    let expires = (SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| STALE)? + remaining()?).as_millis();
    let page = serde_json::json!(url.as_str());
    let script = format!("(location.href === {page} && Date.now() <= {expires}) ? ({SCRIPT}) : -1");
    let (send, reply) = std::sync::mpsc::sync_channel(1);
    let document = main.clone();
    main.with_webview(move |view| {
        extern "C" {
            fn keepwork_voice_document_has_input(view: *mut std::ffi::c_void) -> bool;
            fn keepwork_voice_input_modifiers() -> bool;
        }
        if !is_current() ||
            pressed.elapsed() >= Duration::from_secs(1) || unsafe { keepwork_voice_input_modifiers() } {
            let _ = send.send(-1);
            return;
        }
        if !unsafe { keepwork_voice_document_has_input(view.inner()) } {
            let _ = send.send(0);
            return;
        }
        let _ = document.eval_with_callback(script, move |result| {
            let _ = send.send(result.parse::<i8>().unwrap_or(-1));
        });
    }).map_err(|e| e.to_string())?;
    match reply.recv_timeout(remaining()?).map_err(|_| STALE)? {
        1 => Ok(true),
        0 if main.is_focused().unwrap_or(false) => Ok(false),
        _ => Err(BLOCKED.into()),
    }
}

pub(super) fn trusted_voice_settings(label: &str, url: &url::Url) -> bool {
    if label != "remote-voice"
        || url.path() != "/remote-voice.html"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1430);
    bundled || development
}
fn verify(window: &WebviewWindow) -> Result<(), String> {
    if window
        .url()
        .is_ok_and(|url| trusted_voice_settings(window.label(), &url))
    {
        Ok(())
    } else {
        Err("遥控器设置只允许本地设置窗口操作。".into())
    }
}

pub(super) fn open_remote_voice_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("remote-voice") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = build_voice_settings(app, true);
}

/// First-use setup is only presented beside a focused main window. A hidden
/// client or another foreground application keeps its focus.
pub(super) fn show_voice_setup_if_focused(app: &AppHandle) -> bool {
    if app.get_webview_window("remote-voice").is_some() { return true; }
    if !app.get_webview_window("main").is_some_and(|w| w.is_focused().unwrap_or(false)) {
        return false;
    }
    let core = app.state::<Arc<AppCore>>();
    if core.remote_voice.snapshot().state != "needs-permission" { return false; }
    build_voice_settings(app, false).is_ok()
}

fn build_voice_settings(app: &AppHandle, focus: bool) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "remote-voice",
        WebviewUrl::App("remote-voice.html".into()),
    )
    .focused(focus)
    .title("遥控器语音输入")
    .inner_size(620.0, 560.0)
    .min_inner_size(480.0, 480.0)
    .on_navigation(|url| trusted_voice_settings("remote-voice", url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()
}

#[tauri::command]
pub(super) fn remote_voice_status(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<VoiceSnapshot, String> {
    verify(&window)?;
    Ok(state.remote_voice.snapshot())
}
#[tauri::command]
pub(super) fn remote_voice_start(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    config: VoiceConfig,
) -> Result<VoiceSnapshot, String> {
    verify(&window)?;
    state.remote_voice.start(config)
}
#[tauri::command]
pub(super) fn remote_voice_stop(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<VoiceSnapshot, String> {
    verify(&window)?;
    Ok(state.remote_voice.stop())
}

#[tauri::command]
pub(super) fn remote_voice_set_auto_start(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    enabled: bool,
) -> Result<VoiceSnapshot, String> {
    verify(&window)?;
    state.remote_voice.set_auto_start(enabled)
}

/// Explicit settings action: bring the chat back without replaying a key or
/// attempting to restore a previously observed application/selection.
#[tauri::command]
pub(super) fn remote_voice_begin_input(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, Arc<AppCore>>,
) -> Result<(), String> {
    verify(&window)?;
    super::main_window::show_main_window(&app, &state);
    if let Some(main) = app.get_webview_window("main") {
        if main.url().is_ok_and(|url| crate::security::trusted_page(url.as_str(), state.current_dev_url().as_deref())) {
            main.eval("document.getElementById('chatInput')?.focus();").map_err(|e| e.to_string())?;
        }
    }
    window.hide().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_exact_local_settings_document_can_manage_voice() {
        for url in [
            "tauri://localhost/remote-voice.html",
            "http://tauri.localhost/remote-voice.html",
        ] {
            assert!(trusted_voice_settings(
                "remote-voice",
                &url.parse().unwrap()
            ));
            assert!(!trusted_voice_settings("main", &url.parse().unwrap()));
            assert!(!trusted_voice_settings("pet", &url.parse().unwrap()));
        }
        for url in [
            "https://keepwork.com/chat",
            "https://cdn.keepwork.com/remote-voice.html",
            "http://127.0.0.1:3001/remote-voice.html",
            "tauri://localhost/updates.html",
            "tauri://localhost/remote-voice.html?token=x",
            "tauri://user@localhost/remote-voice.html",
        ] {
            assert!(
                !trusted_voice_settings("remote-voice", &url.parse().unwrap()),
                "{url}"
            );
        }
    }
}
