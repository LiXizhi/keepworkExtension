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

pub(super) fn verify_pet_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "pet", true, &url, dev_url.as_deref())
}

pub(super) fn verify_updates_sender(window: &WebviewWindow, core: &AppCore) -> Result<(), String> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    let dev_url = core.current_dev_url();
    assert_sender(window.label(), "updates", true, &url, dev_url.as_deref())
}
