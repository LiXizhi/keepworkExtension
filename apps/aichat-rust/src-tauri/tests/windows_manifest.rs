//! A real Windows loader regression, without opening windows or native dialogs.
//! Both this test and the library's unit harness must carry the v6 activation
//! context; otherwise Tauri's TaskDialogIndirect import fails before main.

#[cfg(all(windows, target_env = "msvc"))]
#[test]
fn windows_test_harness_activates_common_controls_v6() {
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    // Keep the application library in the integration test's link graph too.
    assert!(matches!(
        aichat_rust_lib::runtime::current_runtime_arch(),
        "x64" | "arm64"
    ));
    let name: Vec<u16> = "comctl32.dll".encode_utf16().chain(Some(0)).collect();
    let library = unsafe { LoadLibraryW(name.as_ptr()) };
    assert!(!library.is_null(), "Common Controls must load");
    let task_dialog = unsafe { GetProcAddress(library, c"TaskDialogIndirect".as_ptr().cast()) };
    unsafe { FreeLibrary(library) };
    assert!(
        task_dialog.is_some(),
        "test manifest must activate Common Controls v6 before the harness starts"
    );
}
