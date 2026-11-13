//! Native launch dispatch and the optional main-document Bridge v1 contract.

use super::events::broadcast_to_main;
use super::main_window::show_main_window;
use super::sender::verify_main_sender;
use super::state::AppCore;
use crate::launch_intents::{LaunchIntent, LaunchUrl};
use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow};

pub(super) fn accept_launch_action(app: &AppHandle, core: &AppCore, action: LaunchUrl) {
    let ready = {
        let mut intents = core.launch_intents.lock().unwrap();
        if action == LaunchUrl::Onboarding {
            intents.offer_onboarding();
        }
        intents.is_ready()
    };
    show_main_window(app, core);
    if ready {
        // No external URL or intent data is broadcast. The current trusted
        // document explicitly rereads its own document-bound ticket.
        broadcast_to_main(app, "launch-intent", &serde_json::Value::Null);
    }
}

fn launch_origin(window: &WebviewWindow, core: &AppCore) -> Result<String, String> {
    verify_main_sender(window, core)?;
    let url = window.url().map_err(|_| "Cannot verify launch document")?;
    if core.page_connection.lock().unwrap().is_shell(&url)
        || !crate::security::trusted_page(url.as_str(), core.current_dev_url().as_deref())
    {
        return Err("Launch intents require the trusted AIChat main document".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

#[tauri::command]
pub(super) fn desktop_get_launch_intent(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    document: String,
    token: String,
) -> Result<Option<LaunchIntent>, String> {
    let origin = launch_origin(&window, &state)?;
    let mut intents = state.launch_intents.lock().unwrap();
    intents.authenticate(&token)?;
    intents.read(&document, &origin)
}

#[tauri::command]
pub(super) fn desktop_acknowledge_launch_intent(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    document: String,
    id: String,
    token: String,
) -> Result<bool, String> {
    let origin = launch_origin(&window, &state)?;
    let mut intents = state.launch_intents.lock().unwrap();
    intents.authenticate(&token)?;
    intents.acknowledge(&document, &origin, &id)
}
