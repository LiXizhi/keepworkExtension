//! Installer-only cleanup, before the desktop supervisor or webview starts.
use std::path::Path;

pub fn parse_parent_identity(value: &str) -> Result<(u32, u64), String> {
    let (pid, created) = value
        .split_once(':')
        .ok_or("Invalid update parent identity")?;
    if !pid.bytes().all(|v| v.is_ascii_digit()) || !created.bytes().all(|v| v.is_ascii_digit()) {
        return Err("Invalid update parent identity".into());
    }
    let pid: u32 = pid.parse().map_err(|_| "Invalid parent PID")?;
    let created: u64 = created
        .parse()
        .map_err(|_| "Invalid parent creation time")?;
    if pid == 0 || created == 0 {
        return Err("Invalid update parent identity".into());
    }
    Ok((pid, created))
}

#[cfg(windows)]
mod desktop {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE,
            },
        },
    };
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn created(process: HANDLE) -> Result<u64, String> {
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err("Cannot verify update parent creation time".into());
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
    fn image(process: HANDLE) -> Result<std::path::PathBuf, String> {
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
            return Err("Cannot verify desktop executable path".into());
        }
        dunce::canonicalize(std::path::PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..len as usize],
        )))
        .map_err(|e| format!("Cannot verify desktop executable path: {e}"))
    }
    fn same_path(a: &Path, b: &Path) -> bool {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }
    pub(super) fn identity() -> Result<String, String> {
        Ok(format!(
            "{}:{}",
            unsafe { GetCurrentProcessId() },
            created(unsafe { GetCurrentProcess() })?
        ))
    }
    pub(super) fn wait(identity: &str, executable: &Path) -> Result<(), String> {
        let (pid, creation) = parse_parent_identity(identity)?;
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            // Only ERROR_INVALID_PARAMETER proves that this PID no longer exists.
            return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
                Ok(())
            } else {
                Err("Cannot open update parent; update cancelled".into())
            };
        }
        let process = Handle(raw);
        let expected = dunce::canonicalize(executable).map_err(|e| e.to_string())?;
        if created(process.0)? != creation || !same_path(&image(process.0)?, &expected) {
            return Err("Update parent identity changed; update cancelled".into());
        }
        // The same verified handle is retained through the wait, never re-opened
        // by PID and never used with PROCESS_TERMINATE.
        if unsafe { WaitForSingleObject(process.0, 60_000) } != WAIT_OBJECT_0 {
            return Err("Desktop did not exit within 60 seconds; update retained for retry".into());
        }
        Ok(())
    }
    pub(super) fn idle(executable: &Path) -> Result<(), String> {
        if !executable.exists() {
            return Ok(());
        }
        let expected = dunce::canonicalize(executable).map_err(|e| e.to_string())?;
        let expected_name = expected
            .file_name()
            .ok_or("Invalid installed desktop path")?
            .to_string_lossy();
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err("Cannot enumerate desktop processes".into());
        }
        let snapshot = Handle(raw);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        while more != 0 {
            let len = entry
                .szExeFile
                .iter()
                .position(|v| *v == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len])
                .eq_ignore_ascii_case(&expected_name)
            {
                let raw = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        entry.th32ProcessID,
                    )
                };
                if raw.is_null() {
                    if std::io::Error::last_os_error().raw_os_error() != Some(87) {
                        return Err("Cannot verify active desktop process".into());
                    }
                } else {
                    let process = Handle(raw);
                    if unsafe { WaitForSingleObject(process.0, 0) } != WAIT_OBJECT_0
                        && same_path(&image(process.0)?, &expected)
                    {
                        return Err(
                            "Keepwork is still running in this installation. Quit it and retry."
                                .into(),
                        );
                    }
                }
            }
            more = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(18) {
            return Err("Cannot finish process enumeration; update cancelled".into());
        }
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn live_parent_identity_mismatch_is_rejected_without_termination() {
            let executable = std::env::current_exe().unwrap();
            let (pid, time) = parse_parent_identity(&identity().unwrap()).unwrap();
            assert!(wait(&format!("{pid}:{}", time + 1), &executable)
                .unwrap_err()
                .contains("identity changed"));
            assert!(idle(&executable).unwrap_err().contains("still running"));
            assert!(wait(
                &format!("{pid}:{time}"),
                Path::new("C:/definitely-missing-keepwork.exe")
            )
            .is_err());
        }
    }
}

#[cfg(windows)]
pub fn current_parent_identity() -> Result<String, String> {
    desktop::identity()
}

pub fn wait_for_desktop(identity: &str, executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        desktop::wait(identity, executable)
    }
    #[cfg(not(windows))]
    {
        let _ = (identity, executable);
        Err("Windows installer command only".into())
    }
}

pub fn check_desktop_stopped(executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        desktop::idle(executable)
    }
    #[cfg(not(windows))]
    {
        let _ = executable;
        Err("Windows installer command only".into())
    }
}

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
        if std::io::Error::last_os_error().raw_os_error() != Some(18) {
            return Err("Cannot finish process enumeration; installer stopped".into());
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
