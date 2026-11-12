use crate::pet::WorkArea;
use tauri::WebviewWindow;

/// Commit one monitor's canvas before acknowledging it to the drag controller.
pub fn sync_pet_canvas(window: &WebviewWindow, area: WorkArea) -> Result<(), String> {
    let _ = window.set_shadow(false);
    #[cfg(target_os = "macos")]
    {
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let applied = macos::set_canvas_frame(&target, area);
                let _ = completed.send(applied);
            })
            .map_err(|error| error.to_string())?;
        result
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "宠物窗口位置更新超时".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Size first: resizing a native window can change its top-left origin.
        window
            .set_size(tauri::LogicalSize::new(
                area.width as f64,
                area.height as f64,
            ))
            .and_then(|_| {
                window.set_position(tauri::LogicalPosition::new(area.x as f64, area.y as f64))
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_void};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        origin: Point,
        size: Size,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> Rect;
    }
    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    pub(super) fn set_canvas_frame(window: &WebviewWindow, area: WorkArea) -> Result<(), String> {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        if native.is_null() || area.width <= 0 || area.height <= 0 {
            return Err("宠物窗口或屏幕范围不可用".to_string());
        }
        unsafe {
            // Quartz/Tauri use a top-left origin; AppKit uses a bottom-left
            // origin in the same logical point space, including mixed DPI.
            let primary = CGDisplayBounds(CGMainDisplayID());
            let frame = Rect {
                origin: Point {
                    x: area.x as f64,
                    y: primary.size.height - area.y as f64 - area.height as f64,
                },
                size: Size {
                    width: area.width as f64,
                    height: area.height as f64,
                },
            };
            // A separate setFrameTopLeftPoint then setContentSize preserves the
            // old bottom edge on resize, shifting the canvas after a crossing.
            let set_frame: unsafe extern "C" fn(*mut c_void, *mut c_void, Rect, bool) =
                std::mem::transmute(objc_msgSend as *const ());
            set_frame(
                native,
                sel_registerName(c"setFrame:display:".as_ptr()),
                frame,
                false,
            );
        }
        Ok(())
    }
}
