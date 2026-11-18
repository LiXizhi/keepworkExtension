//! Synchronous AppKit cursor mode. This module deliberately has no Tauri types
//! so its actual NSWindow readback can also run in a small native smoke probe.
use std::ffi::{c_char, c_void};

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

unsafe fn boolean(receiver: *mut c_void, selector: &std::ffi::CStr) -> bool {
    // AppKit BOOL is one byte on both supported macOS ABIs. Accept any nonzero
    // getter result rather than requiring Rust's stricter bool representation.
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i8 =
        std::mem::transmute(objc_msgSend as *const ());
    send(receiver, sel_registerName(selector.as_ptr())) != 0
}

pub(crate) fn is_main_thread() -> bool {
    unsafe {
        let class = objc_getClass(c"NSThread".as_ptr());
        !class.is_null() && boolean(class, c"isMainThread")
    }
}

/// The caller owns a live NSWindow for the duration of this call. AppKit must
/// be accessed on its main thread; no asynchronous setter is used here.
pub(crate) unsafe fn set_interactive(native: *mut c_void, interactive: bool) -> Result<(), String> {
    if !is_main_thread() || native.is_null() {
        return Err("宠物鼠标穿透更新需要有效的主线程窗口".into());
    }
    let ignore = !interactive;
    if boolean(native, c"ignoresMouseEvents") == ignore {
        return Ok(());
    }
    let set: unsafe extern "C" fn(*mut c_void, *mut c_void, i8) =
        std::mem::transmute(objc_msgSend as *const ());
    let selector = sel_registerName(c"setIgnoresMouseEvents:".as_ptr());
    set(native, selector, i8::from(ignore));
    if boolean(native, c"ignoresMouseEvents") != ignore {
        // Do not leave an unverified full-screen canvas taking mouse input.
        set(native, selector, 1);
        return Err("宠物鼠标穿透状态未生效".into());
    }
    Ok(())
}
