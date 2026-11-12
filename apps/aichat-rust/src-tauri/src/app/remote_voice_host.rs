//! Only the local settings window can start/stop native cloud dictation.
use super::state::AppCore;
use crate::remote_voice::{VoiceConfig, VoiceSnapshot};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
    let _ = WebviewWindowBuilder::new(
        app,
        "remote-voice",
        WebviewUrl::App("remote-voice.html".into()),
    )
    .title("遥控器语音输入")
    .inner_size(620.0, 560.0)
    .min_inner_size(480.0, 480.0)
    .on_navigation(|url| trusted_voice_settings("remote-voice", url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build();
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
