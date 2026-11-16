//! Present the retained WebKit document to its microphone permission UI throughout
//! an explicitly requested pet call, including microphone reacquisition. Other platforms use the retained page directly.
#[cfg(target_os = "macos")]
use super::{
    sender::{verify_main_sender, verify_pet_sender},
    state::AppCore,
};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
pub(super) fn sync(app: &AppHandle) {
    use std::ffi::c_void;
    extern "C" {
        fn keepwork_attach_phone_view(
            main: *mut c_void,
            pet: *mut c_void,
            view: *mut c_void,
        ) -> i32;
        fn keepwork_restore_phone_view(main: *mut c_void);
    }
    let handle = app.clone();
    // AppKit can synchronously redraw Tao windows while reparenting a view.
    // Perform the transition on the window queue and re-read current intent.
    let _ = super::main_window::run_on_window_thread(app, move || {
        let Some(main) = handle.get_webview_window("main") else {
            return;
        };
        let Ok(main_window) = main.ns_window() else {
            return;
        };
        let core = handle.state::<Arc<AppCore>>();
        let id = core.pet.active_phone_id();
        let pet = handle.get_webview_window("pet").filter(|pet| {
            id.as_deref()
                .is_some_and(|id| core.remote_voice.dialogue.owns("main", id))
                && verify_main_sender(&main, &core).is_ok()
                && verify_pet_sender(pet, &core).is_ok()
                && super::pet_host::pet_is_active(pet).unwrap_or(false)
                && core.page_connection.lock().unwrap().presentation()
                    == crate::page_connection::Presentation::Hidden
        });
        if let Some(pet_window) = pet.and_then(|window| window.ns_window().ok()) {
            // with_webview runs inline on this UI thread. Resolve Tauri handles
            // beforehand; querying main again in the callback would re-enter its lock.
            let main_ptr = main_window as usize;
            let pet_ptr = pet_window as usize;
            let _ = main.with_webview(move |view| {
                if unsafe { keepwork_attach_phone_view(main_ptr as _, pet_ptr as _, view.inner()) }
                    == 0
                {
                    use tauri_plugin_dialog::DialogExt;
                    handle
                        .dialog()
                        .message("请打开 AIChat 主窗口以使用通话麦克风。")
                        .title("AIChat")
                        .show(|_| {});
                }
            });
        } else {
            unsafe { keepwork_restore_phone_view(main_window) };
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(super) fn sync(_app: &AppHandle) {}
