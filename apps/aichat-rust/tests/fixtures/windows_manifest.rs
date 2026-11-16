#[path = "../../src-tauri/build_support/windows_manifest.rs"]
mod windows_manifest;

fn main() {
    let manifest = std::path::PathBuf::from(std::env::args_os().nth(1).expect("manifest"));
    let target_env = if cfg!(target_env = "msvc") {
        "msvc"
    } else {
        "gnu"
    };
    if let Some(args) = windows_manifest::linker_args(std::env::consts::OS, target_env, &manifest) {
        for arg in args {
            println!("{arg}");
        }
    }
}

#[test]
fn manifest_flags_follow_the_target_instead_of_the_build_host() {
    let manifest = std::path::Path::new("C:/fixture with spaces/app.xml");
    assert_eq!(
        windows_manifest::linker_args("windows", "msvc", manifest),
        Some([
            "/MANIFEST:EMBED".into(),
            "/MANIFESTINPUT:C:/fixture with spaces/app.xml".into(),
        ])
    );
    for (os, env) in [("macos", ""), ("linux", "gnu"), ("windows", "gnu")] {
        assert_eq!(windows_manifest::linker_args(os, env, manifest), None);
    }
}

#[cfg(all(windows, target_env = "msvc"))]
#[test]
fn common_controls_v6_loads_before_the_test_harness() {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
    }
    #[link(name = "comctl32")]
    extern "system" {
        fn DefSubclassProc(hwnd: *mut std::ffi::c_void, msg: u32, wp: usize, lp: isize) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
        fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
    }
    // This v6 named import reproduces the original load-time failure without
    // creating a UI or requiring a WebView, desktop session or device consent.
    assert_ne!(
        std::hint::black_box(DefSubclassProc as *const () as usize),
        0
    );
    // DllGetVersion has no import library; query it on the loaded module.
    let name: Vec<u16> = "comctl32.dll\0".encode_utf16().collect();
    let module = unsafe { GetModuleHandleW(name.as_ptr()) };
    assert!(!module.is_null());
    let address = unsafe { GetProcAddress(module, b"DllGetVersion\0".as_ptr()) };
    assert!(!address.is_null());
    let query_version: unsafe extern "system" fn(*mut Version) -> i32 =
        unsafe { std::mem::transmute(address) };
    let mut version = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
    };
    assert_eq!(unsafe { query_version(&mut version) }, 0);
    assert!(version.major >= 6, "Common Controls v6 must be active");
}
