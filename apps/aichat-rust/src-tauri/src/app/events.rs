//! Desktop event delivery to the retained main document.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn broadcast_to_main(app: &AppHandle, event_name: &str, payload: &Value) {
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
