//! Run from src-tauri on macOS, on the process main thread (not a test worker):
//! rustc --edition=2021 tests/native/pet_pointer_macos_probe.rs -l framework=AppKit -o /tmp/pet-pointer-probe
//! /tmp/pet-pointer-probe
//! This creates a hidden window only; it never activates an app or sends input.
#[path = "../../src/pet_pointer_macos.rs"]
mod pointer;

use std::ffi::{c_char, c_void, CStr};

#[repr(C)]
#[derive(Clone, Copy)]
struct Point { x: f64, y: f64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Size { width: f64, height: f64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect { origin: Point, size: Size }

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

unsafe fn get(window: *mut c_void, name: &CStr) -> bool {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i8 =
        std::mem::transmute(objc_msgSend as *const ());
    send(window, sel_registerName(name.as_ptr())) != 0
}

unsafe fn set(window: *mut c_void, ignore: bool) {
    let send: unsafe extern "C" fn(*mut c_void, *mut c_void, i8) =
        std::mem::transmute(objc_msgSend as *const ());
    send(window, sel_registerName(c"setIgnoresMouseEvents:".as_ptr()), i8::from(ignore));
}

fn main() {
    unsafe {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        send(objc_getClass(c"NSApplication".as_ptr()), sel_registerName(c"sharedApplication".as_ptr()));
        let raw = send(objc_getClass(c"NSWindow".as_ptr()), sel_registerName(c"alloc".as_ptr()));
        let init: unsafe extern "C" fn(*mut c_void, *mut c_void, Rect, usize, usize, i8) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let window = init(
            raw,
            sel_registerName(c"initWithContentRect:styleMask:backing:defer:".as_ptr()),
            Rect { origin: Point { x: 0., y: 0. }, size: Size { width: 16., height: 16. } },
            0, 2, 0,
        );
        assert!(!window.is_null());
        set(window, false);

        // Reproduce the old stale-cache skip without pretending it changed AppKit.
        let desired_interactive = false;
        let cached_interactive = Some(false);
        if cached_interactive != Some(desired_interactive) {
            set(window, !desired_interactive);
        }
        assert!(!get(window, c"ignoresMouseEvents"), "reproducer must retain the OS/cache mismatch");
        pointer::set_interactive(window, desired_interactive).unwrap();
        assert!(get(window, c"ignoresMouseEvents"), "production helper must repair actual OS state");

        // Real menu override and dismissal, then independent native drift.
        pointer::set_interactive(window, true).unwrap();
        assert!(!get(window, c"ignoresMouseEvents"));
        pointer::set_interactive(window, false).unwrap();
        assert!(get(window, c"ignoresMouseEvents"));
        set(window, false);
        pointer::set_interactive(window, false).unwrap();
        assert!(get(window, c"ignoresMouseEvents"));

        assert!(pointer::set_interactive(std::ptr::null_mut(), false).is_err());
        let raw = window as usize;
        assert!(std::thread::spawn(move || pointer::set_interactive(raw as *mut c_void, true))
            .join().unwrap().is_err());
        assert!(get(window, c"ignoresMouseEvents"), "off-thread rejection must not change OS state");
        println!("PASS: actual AppKit stale-cache repair, menu restore, native drift, null/off-thread rejection");
    }
}
