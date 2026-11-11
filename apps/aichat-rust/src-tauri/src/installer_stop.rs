//! Installer-only cleanup, before the desktop supervisor or webview starts.
use std::path::Path;

#[cfg(windows)]
pub fn stop_bundled_mcp(install_dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            },
        },
    };
    struct Handle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    if !install_dir.exists() {
        return Ok(());
    }
    let root = dunce::canonicalize(install_dir).map_err(|e| e.to_string())?;
    unsafe {
        let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
        if snapshot.0 == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut more = Process32FirstW(snapshot.0, &mut entry);
        while more != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|v| *v == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            if name.eq_ignore_ascii_case("keepwork-mcp.exe")
                || name.eq_ignore_ascii_case("keepworkmcp.exe")
            {
                // Keep this same handle for verification and termination to avoid PID reuse.
                let process = Handle(OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    entry.th32ProcessID,
                ));
                if process.0.is_null() {
                    if std::io::Error::last_os_error().raw_os_error() != Some(87) {
                        return Err(format!("Cannot verify MCP process {}", entry.th32ProcessID));
                    }
                } else {
                    let mut buffer = vec![0u16; 32768];
                    let mut size = buffer.len() as u32;
                    if QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut size) == 0
                    {
                        return Err("Cannot verify MCP executable path".into());
                    }
                    let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(
                        &buffer[..size as usize],
                    ));
                    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
                    if belongs_to_install(&root, &path)
                        && WaitForSingleObject(process.0, 0) != WAIT_OBJECT_0
                    {
                        if TerminateProcess(process.0, 0) == 0
                            && WaitForSingleObject(process.0, 0) != WAIT_OBJECT_0
                        {
                            return Err("Unable to stop bundled MCP".into());
                        }
                        if WaitForSingleObject(process.0, 10000) != WAIT_OBJECT_0 {
                            return Err("Timed out waiting for bundled MCP to stop".into());
                        }
                    }
                }
            }
            more = Process32NextW(snapshot.0, &mut entry);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn stop_bundled_mcp(_: &Path) -> Result<(), String> {
    Err("Windows installer command only".into())
}

fn belongs_to_install(root: &Path, executable: &Path) -> bool {
    // Canonical paths on Windows are compared without case sensitivity; retain
    // path components so Keepwork-other is not a descendant of Keepwork.
    let root = root.to_string_lossy().to_lowercase();
    let executable = executable.to_string_lossy().to_lowercase();
    Path::new(&executable).starts_with(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_installations_are_excluded() {
        let root = Path::new("C:/Apps/Keepwork");
        assert!(belongs_to_install(
            root,
            Path::new("c:/apps/keepwork/resources/keepwork-mcp.exe")
        ));
        assert!(!belongs_to_install(
            root,
            Path::new("C:/Apps/Keepwork-other/keepwork-mcp.exe")
        ));
        assert!(!belongs_to_install(
            root,
            Path::new("C:/Apps/LocalHelper/keepwork-mcp.exe")
        ));
    }
}
