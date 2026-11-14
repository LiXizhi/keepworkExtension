//! Native Known Folder lookup for Win7/8. PowerShell 2 on stock Win7 has no
//! ConvertTo-Json. Use the shell's configured locations without creating them.
use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetKnownFolderPath(
        id: *const Guid,
        flags: u32,
        token: *mut c_void,
        path: *mut *mut u16,
    ) -> i32;
}
// Bind to ole32 explicitly. Modern windows-sys bindings route this function to
// combase.dll, which is absent on Windows 7 even though the API itself is older.
#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(value: *mut c_void);
    fn CoInitializeEx(reserved: *mut c_void, model: u32) -> i32;
    fn CoUninitialize();
}

fn query(id: &Guid) -> Option<String> {
    let mut pointer = std::ptr::null_mut();
    // Flags=0: query the existing configuration, never KF_FLAG_CREATE.
    let status = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut pointer) };
    struct Allocation(*mut u16);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(self.0.cast()) };
        }
    }
    let allocation = Allocation(pointer);
    if status < 0 || allocation.0.is_null() {
        return None;
    }
    // The Shell API owns and NUL-terminates this UTF-16 allocation.
    let mut length = 0;
    while length < 32768 && unsafe { *allocation.0.add(length) } != 0 {
        length += 1;
    }
    if length == 0 || length == 32768 {
        return None;
    }
    let value = OsString::from_wide(unsafe { std::slice::from_raw_parts(allocation.0, length) });
    Some(value.to_string_lossy().into_owned())
}

pub(super) fn user_folders() -> Vec<(String, String, String)> {
    // Known Folder APIs require COM on this calling thread. Tokio worker
    // threads do not initialize it themselves. Balance S_OK/S_FALSE only;
    // RPC_E_CHANGED_MODE means another caller already chose a valid apartment.
    let status = unsafe { CoInitializeEx(std::ptr::null_mut(), 0) };
    if status < 0 && status as u32 != 0x80010106 {
        return Vec::new();
    }
    struct ComApartment(bool);
    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let _apartment = ComApartment(status >= 0);
    // FOLDERID values from the Windows SDK's KnownFolders.h. These APIs and
    // identifiers are present on the minimum Windows 7 SP1 target.
    let folders = [
        (
            "Desktop",
            Guid {
                data1: 0xb4bfcc3a,
                data2: 0xdb2c,
                data3: 0x424c,
                data4: [0xb0, 0x29, 0x7f, 0xe9, 0x9a, 0x87, 0xc6, 0x41],
            },
        ),
        (
            "Documents",
            Guid {
                data1: 0xfdd39ad0,
                data2: 0x238f,
                data3: 0x46af,
                data4: [0xad, 0xb4, 0x6c, 0x85, 0x48, 0x03, 0x69, 0xc7],
            },
        ),
        (
            "Downloads",
            Guid {
                data1: 0x374de290,
                data2: 0x123f,
                data3: 0x4565,
                data4: [0x91, 0x64, 0x39, 0xc4, 0x92, 0x5e, 0x46, 0x7b],
            },
        ),
        (
            "Pictures",
            Guid {
                data1: 0x33e28130,
                data2: 0x4e1e,
                data3: 0x4676,
                data4: [0x83, 0x5a, 0x98, 0x39, 0x5c, 0x3b, 0xc3, 0xbb],
            },
        ),
        (
            "Music",
            Guid {
                data1: 0x4bd8d571,
                data2: 0x6d19,
                data3: 0x48d3,
                data4: [0xbe, 0x97, 0x42, 0x22, 0x20, 0x08, 0x0e, 0x43],
            },
        ),
        (
            "Videos",
            Guid {
                data1: 0x18989b1d,
                data2: 0x99b5,
                data3: 0x455b,
                data4: [0x84, 0x1c, 0xab, 0x7c, 0x74, 0xe4, 0xdd, 0xfc],
            },
        ),
    ];
    folders
        .iter()
        .filter_map(|(name, id)| {
            query(id).map(|path| (name.to_string(), name.to_ascii_lowercase(), path))
        })
        .collect()
}
