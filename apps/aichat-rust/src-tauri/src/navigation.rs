//! Keep embedded browser navigations out of the main window's external-link guard.

#[cfg(target_os = "macos")]
pub fn install_frame_navigation(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        extern "C" {
            fn keepwork_install_frame_navigation(webview: *mut std::ffi::c_void) -> bool;
        }
        // Tauri runs this closure on the native webview thread. WebKit's weak
        // navigation delegate is retained by an association on this webview.
        if !unsafe { keepwork_install_frame_navigation(webview.inner()) } {
            eprintln!("Could not install embedded browser navigation policy");
        }
    })
}

#[cfg(target_os = "macos")]
#[no_mangle]
unsafe extern "C" fn keepwork_allowed_subframe_navigation(
    raw_url: *const std::ffi::c_char,
) -> bool {
    if raw_url.is_null() {
        return false;
    }
    std::ffi::CStr::from_ptr(raw_url)
        .to_str()
        .is_ok_and(crate::security::allowed_subframe_navigation)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::keepwork_allowed_subframe_navigation;

    #[test]
    fn native_subframe_policy_rejects_missing_and_invalid_urls() {
        unsafe {
            assert!(!keepwork_allowed_subframe_navigation(std::ptr::null()));
            assert!(!keepwork_allowed_subframe_navigation(c"".as_ptr()));
            assert!(!keepwork_allowed_subframe_navigation(c"\xff".as_ptr()));
            assert!(!keepwork_allowed_subframe_navigation(
                c"file:///etc/passwd".as_ptr()
            ));
            assert!(keepwork_allowed_subframe_navigation(
                c"https://www.baidu.com/".as_ptr()
            ));
        }
    }
}
