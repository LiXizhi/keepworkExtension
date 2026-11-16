//! Window identity and origin validation for desktop IPC.

use super::state::AppCore;
use crate::security::assert_sender;
use tauri::WebviewWindow;

pub(super) fn verify_main_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    if window.label() == "main"
        && core
            .page_connection
            .lock()
            .unwrap()
            .shell_url
            .as_ref()
            .is_some_and(|shell| shell.as_str() == url)
    {
        return Ok(());
    }
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "main", true, &url, dev_url.as_deref())
}

// A newly presented WKWebView can still have a nil URL until its first
// navigation commits. Query WebKit on the UI thread before routing hardware input.
pub(super) fn loaded_page_url(window: &WebviewWindow) -> Result<Option<url::Url>, String> {
    #[cfg(target_os = "macos")]
    {
        let (send, result) = std::sync::mpsc::sync_channel(1);
        window.with_webview(move |view| {
            extern "C" {
                fn keepwork_webview_url(view: *mut std::ffi::c_void, buffer: *mut std::ffi::c_char, size: usize) -> bool;
            }
            let mut buffer = [0; 4096];
            let url = unsafe {
                keepwork_webview_url(view.inner(), buffer.as_mut_ptr(), buffer.len()).then(|| {
                    std::ffi::CStr::from_ptr(buffer.as_ptr()).to_str().ok().and_then(|raw| url::Url::parse(raw).ok())
                }).flatten()
            };
            let _ = send.send(url);
        }).map_err(|e| e.to_string())?;
        result.recv_timeout(std::time::Duration::from_secs(1)).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { window.url().map(Some).map_err(|e| e.to_string()) }
}

pub(super) fn verify_pet_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = loaded_page_url(window)?.map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "pet", true, &url, dev_url.as_deref())
}

pub(super) fn verify_updates_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "updates", true, &url, dev_url.as_deref())
}
