//! Apply the pet window's real OS cursor mode, not an enqueue-success cache.
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
#[path = "pet_pointer_macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn apply(window: &WebviewWindow, interactive: bool) -> Result<(), String> {
    let native = window.ns_window().map_err(|error| error.to_string())?;
    // The WebviewWindow keeps this NSWindow alive and callers below ensure the
    // main thread. The native helper verifies the actual flag before returning.
    unsafe { macos::set_interactive(native, interactive) }
}

pub(crate) fn set_interactive(window: &WebviewWindow, interactive: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if macos::is_main_thread() {
            return apply(window, interactive);
        }
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let applied = apply(&target, interactive);
                if completed.send(applied).is_err() {
                    // An abandoned menu request must not enable the canvas later.
                    let _ = apply(&target, false);
                }
            })
            .map_err(|error| error.to_string())?;
        result
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "宠物鼠标穿透更新超时".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_ignore_cursor_events(!interactive)
            .map_err(|error| error.to_string())
    }
}
