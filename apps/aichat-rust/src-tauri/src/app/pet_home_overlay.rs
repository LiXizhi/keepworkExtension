//! Xiaomi Home presentation over a screen-filling macOS window.
use super::{pet_host, state::AppCore};
use crate::{pet::WorkArea, pet_canvas};
use std::{ffi::c_void, sync::Arc};
use tauri::{AppHandle, Manager, WebviewWindow};

extern "C" {
    fn keepwork_pet_overlay_target(
        x: *mut i32,
        y: *mut i32,
        width: *mut i32,
        height: *mut i32,
    ) -> bool;
    fn keepwork_pet_overlay_show(pet: *mut c_void) -> bool;
    fn keepwork_pet_overlay_finish(pet: *mut c_void, hide: bool);
}

/// Restore the retained window's original Space membership on its UI thread.
pub(super) fn finish(pet: &WebviewWindow, core: &AppCore) {
    if core.pet_home_overlay.lock().unwrap().take().is_none() {
        return;
    }
    let window = pet.clone();
    let _ = pet.run_on_main_thread(move || {
        if window
            .state::<Arc<AppCore>>()
            .pet_home_overlay
            .lock()
            .unwrap()
            .is_none()
        {
            if let Ok(native) = window.ns_window() {
                unsafe { keepwork_pet_overlay_finish(native, false) };
            }
        }
    });
}

fn dismiss(pet: &WebviewWindow, core: &AppCore) {
    if pet_host::dismiss_pet_view(pet).is_ok() {
        pet_host::finish_pet_hide(pet.app_handle(), core);
    }
}

/// Called on the main thread. Once we recognize a screen-filling window,
/// consume Home even if AppKit cannot show the overlay in this Space.
pub(super) fn handle_home(app: &AppHandle, core: &Arc<AppCore>, main: &WebviewWindow) -> bool {
    let pet = app.get_webview_window("pet");
    let presented = *core.pet_home_overlay.lock().unwrap();
    if let Some(window) = pet.as_ref() {
        if presented.is_some() && window.is_focused().unwrap_or(false) {
            dismiss(window, core);
            return true;
        }
    }
    let mut area = WorkArea::default();
    if !unsafe {
        keepwork_pet_overlay_target(
            &mut area.x,
            &mut area.y,
            &mut area.width,
            &mut area.height,
        )
    } {
        return false;
    }
    if !core.settings().pet_visible {
        return true;
    }
    if let Some(window) = pet.as_ref() {
        if presented == Some(area) && window.is_visible().unwrap_or(false) {
            dismiss(window, core);
            return true;
        }
    } else {
        // Build offscreen. The ordinary Tauri show path can activate the chat app.
        pet_host::ensure_pet_window(app, core, false);
    }
    let Some(window) = app.get_webview_window("pet") else {
        return true;
    };
    let Ok(native) = window.ns_window() else {
        return true;
    };
    if let Err(error) = pet_canvas::sync_pet_canvas(&window, area) {
        eprintln!("[desktop] Cannot position the Home pet: {error}");
        return true;
    }
    // The overlay can span Spaces and displays. Retire the chat even if it
    // currently sits behind the presentation, so switching apps cannot expose both.
    super::main_window::hide_main_window(app, core);
    if main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false) {
        return true;
    }
    if unsafe { keepwork_pet_overlay_show(native) } {
        core.pet.set_work_area(area);
        core.pet.note_canvas(area);
        *core.pet_home_overlay.lock().unwrap() = Some(area);
        super::remote_phone_view::sync(app);
        pet_host::broadcast_pet_state(app, core);
    }
    true
}
