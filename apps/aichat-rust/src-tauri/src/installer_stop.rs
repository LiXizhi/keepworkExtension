//! Installer-only cleanup, before the desktop supervisor or webview starts.
use std::path::Path;

pub fn parse_parent_identity(value: &str) -> Result<(u32, u64), String> {
    let (pid, created) = value
        .split_once(':')
        .ok_or("更新父进程身份无效，已中止更新")?;
    if !pid.bytes().all(|v| v.is_ascii_digit()) || !created.bytes().all(|v| v.is_ascii_digit()) {
        return Err("更新父进程身份无效，已中止更新".into());
    }
    let pid: u32 = pid.parse().map_err(|_| "更新父进程号无效")?;
    let created: u64 = created.parse().map_err(|_| "更新父进程创建时间无效")?;
    if pid == 0 || created == 0 {
        return Err("更新父进程身份无效，已中止更新".into());
    }
    Ok((pid, created))
}

#[cfg(any(windows, test))]
fn windows_error(context: &str, error: std::io::Error) -> String {
    let reason = match error.raw_os_error() {
        Some(2 | 3) => "程序文件或安装目录不存在，请重新运行完整安装包".to_string(),
        Some(5) => "拒绝访问，可能是应用以管理员身份运行或受到系统保护；请从托盘完全退出 Keepwork，或以管理员身份重试安装/卸载".to_string(),
        Some(6) => "进程句柄无效，请重试安装/卸载".to_string(),
        Some(32 | 33) => "程序文件被其他进程占用，请完全退出 Keepwork 后重试".to_string(),
        Some(87) => "进程已退出或进程参数无效，请重试安装/卸载".to_string(),
        Some(299) => "无法完整读取进程信息，请完全退出 Keepwork 后重试".to_string(),
        _ => format!("{error}；请完全退出 Keepwork 后重试"),
    };
    format!(
        "{context}：{reason}（Windows 错误 {}）",
        error.raw_os_error().unwrap_or(0)
    )
}

/// nsExec decodes pipes with the system code page, not UTF-8. Give Unicode NSIS
/// an explicit UTF-16LE channel so Chinese errors survive English Windows too.
pub fn write_error_file(path: &Path, error: &str) -> std::io::Result<()> {
    let line = error.replace(['\r', '\n', '\0'], " ");
    let mut utf16: Vec<_> = line.encode_utf16().take(900).collect();
    if utf16.last().is_some_and(|v| (0xd800..=0xdbff).contains(v)) {
        utf16.pop();
    }
    let bytes: Vec<u8> = std::iter::once(0xfeffu16)
        .chain(utf16)
        .flat_map(u16::to_le_bytes)
        .collect();
    std::fs::write(path, bytes)
}

#[cfg(windows)]
mod desktop {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
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
            return Err(windows_error(
                "无法核对进程创建时间",
                std::io::Error::last_os_error(),
            ));
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
    fn image(process: HANDLE) -> Result<std::path::PathBuf, String> {
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
            return Err(windows_error(
                "无法核对程序完整路径",
                std::io::Error::last_os_error(),
            ));
        }
        dunce::canonicalize(std::path::PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..len as usize],
        )))
        .map_err(|e| windows_error("无法核对程序完整路径", e))
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
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(87) {
                Ok(())
            } else {
                Err(windows_error(
                    &format!("无法打开更新父进程（进程号 {pid}）"),
                    error,
                ))
            };
        }
        let process = Handle(raw);
        let expected = dunce::canonicalize(executable)
            .map_err(|e| windows_error(&format!("无法核对更新程序路径（进程号 {pid}）"), e))?;
        if created(process.0)? != creation || !same_path(&image(process.0)?, &expected) {
            return Err(format!(
                "更新父进程身份已变化（进程号 {pid}），为避免结束其他程序，已中止更新"
            ));
        }
        // The same verified handle is retained through the wait, never re-opened
        // by PID and never used with PROCESS_TERMINATE.
        let status = unsafe { WaitForSingleObject(process.0, 60_000) };
        if status == WAIT_FAILED {
            return Err(windows_error(
                &format!("等待更新父进程退出失败（进程号 {pid}）"),
                std::io::Error::last_os_error(),
            ));
        }
        if status != WAIT_OBJECT_0 {
            return Err(format!("Keepwork 在 60 秒内未退出（进程号 {pid}）；请从托盘完全退出应用后重试，更新包已保留"));
        }
        Ok(())
    }
    fn processes(mut visit: impl FnMut(u32, &str) -> Result<(), String>) -> Result<(), String> {
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(windows_error(
                "无法枚举运行中的程序",
                std::io::Error::last_os_error(),
            ));
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
            visit(
                entry.th32ProcessID,
                &String::from_utf16_lossy(&entry.szExeFile[..len]),
            )?;
            more = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(18) {
            return Err(windows_error(
                "进程枚举未能完成，已中止安装或卸载",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn running(process: HANDLE, context: &str) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(process, 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_FAILED => Err(windows_error(context, std::io::Error::last_os_error())),
            _ => Ok(true),
        }
    }

    fn inspect(pid: u32, name: &str) -> Result<Option<(Handle, std::path::PathBuf)>, String> {
        // Query first, without termination access: another installation may be
        // elevated, yet its readable path lets us exclude it safely.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(87) {
                Ok(None)
            } else {
                Err(windows_error(
                    &format!("无法核对 {name}（进程号 {pid}）"),
                    error,
                ))
            };
        }
        let process = Handle(raw);
        let context = format!("无法检查 {name} 的退出状态（进程号 {pid}）");
        if !running(process.0, &context)? {
            return Ok(None);
        }
        match image(process.0) {
            Ok(path) => Ok(Some((process, path))),
            Err(_) if !running(process.0, &context)? => Ok(None),
            Err(error) => Err(format!("{name}（进程号 {pid}）：{error}")),
        }
    }

    fn terminate(process: &Handle, path: &Path, pid: u32, name: &str) -> Result<(), String> {
        let context = format!("无法结束 {name}（进程号 {pid}）");
        if !running(process.0, &context)? {
            return Ok(());
        }
        if pid == unsafe { GetCurrentProcessId() } {
            return Err(format!(
                "{context}：安装辅助程序不能结束自身，请重新运行安装包"
            ));
        }
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(87) || !running(process.0, &context)? {
                Ok(())
            } else {
                Err(windows_error(&context, error))
            };
        }
        let target = Handle(raw);
        if !running(target.0, &context)? {
            return Ok(());
        }
        // Revalidate the new handle before terminating it; retain that exact
        // handle through termination and wait so PID reuse cannot redirect us.
        let verified = (|| -> Result<bool, String> {
            Ok(created(target.0)? == created(process.0)? && same_path(&image(target.0)?, path))
        })();
        let verified = match verified {
            Ok(value) => value,
            Err(_) if !running(target.0, &context)? => return Ok(()),
            Err(error) => return Err(format!("{context}：{error}")),
        };
        if !verified {
            return Err(format!(
                "{context}：进程身份已变化，为避免结束其他程序，已中止操作"
            ));
        }
        if unsafe { TerminateProcess(target.0, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if running(target.0, &context)? {
                return Err(windows_error(&context, error));
            }
        }
        match unsafe { WaitForSingleObject(target.0, 10_000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_FAILED => Err(windows_error(&context, std::io::Error::last_os_error())),
            _ => Err(format!("{context}：已请求强制结束，但等待 10 秒后仍未退出；请在任务管理器中结束该进程后重试")),
        }
    }

    fn desktop(executable: &Path, stop: bool) -> Result<(), String> {
        if !executable
            .try_exists()
            .map_err(|e| windows_error("无法检查安装路径", e))?
        {
            return Ok(());
        }
        let expected =
            dunce::canonicalize(executable).map_err(|e| windows_error("无法核对安装路径", e))?;
        let expected_name = expected
            .file_name()
            .ok_or("安装程序路径无效")?
            .to_string_lossy();
        if stop
            && !["keepwork.exe", "aichat-rust.exe"]
                .contains(&expected_name.to_ascii_lowercase().as_str())
        {
            return Err("只能结束已安装的 Keepwork.exe 或 aichat-rust.exe".into());
        }
        processes(|pid, name| {
            if !name.eq_ignore_ascii_case(&expected_name) {
                return Ok(());
            }
            if let Some((process, path)) = inspect(pid, name)? {
                if same_path(&path, &expected) {
                    if stop {
                        terminate(&process, &path, pid, name)?;
                    } else {
                        return Err(format!("{name} 仍在此安装目录中运行（进程号 {pid}）；请从托盘完全退出 Keepwork 后重试"));
                    }
                }
            }
            Ok(())
        })
    }

    pub(super) fn idle(executable: &Path) -> Result<(), String> {
        desktop(executable, false)
    }
    pub(super) fn stop(executable: &Path) -> Result<(), String> {
        desktop(executable, true)?;
        // A supervisor or user may restart it during enumeration. Do not
        // proceed to bundled service cleanup unless this path is now idle.
        desktop(executable, false)
    }

    pub(super) fn stop_mcp(install_dir: &Path) -> Result<(), String> {
        if !install_dir
            .try_exists()
            .map_err(|e| windows_error("无法检查 MCP 安装目录", e))?
        {
            return Ok(());
        }
        let root = dunce::canonicalize(install_dir)
            .map_err(|e| windows_error("无法核对 MCP 安装目录", e))?;
        processes(|pid, name| {
            if !["keepwork-mcp.exe", "keepworkmcp.exe"]
                .iter()
                .any(|v| name.eq_ignore_ascii_case(v))
            {
                return Ok(());
            }
            if let Some((process, path)) = inspect(pid, name)? {
                if belongs_to_install(&root, &path) {
                    terminate(&process, &path, pid, name)?;
                }
            }
            Ok(())
        })
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
                .contains("身份已变化"));
            assert!(idle(&executable)
                .unwrap_err()
                .contains("仍在此安装目录中运行"));
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
        Err("此安装辅助命令仅适用于 Windows".into())
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
        Err("此安装辅助命令仅适用于 Windows".into())
    }
}

pub fn stop_desktop(executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        desktop::stop(executable)
    }
    #[cfg(not(windows))]
    {
        let _ = executable;
        Err("此安装辅助命令仅适用于 Windows".into())
    }
}

pub fn stop_bundled_mcp(install_dir: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        desktop::stop_mcp(install_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = install_dir;
        Err("此安装辅助命令仅适用于 Windows".into())
    }
}

#[cfg(any(windows, test))]
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
    fn access_denied_explains_permissions_in_chinese_with_pid_and_windows_code() {
        let message = windows_error(
            "无法结束 Keepwork.exe（进程号 1234）",
            std::io::Error::from_raw_os_error(5),
        );
        for expected in ["拒绝访问", "管理员", "完全退出", "1234", "Windows 错误 5"] {
            assert!(message.contains(expected), "{message}");
        }
        let other = windows_error("无法枚举进程", std::io::Error::from_raw_os_error(12345));
        assert!(other.contains("无法枚举进程"));
        assert!(other.contains("Windows 错误 12345"));
    }

    #[test]
    fn nsis_error_channel_preserves_chinese_without_console_encoding() {
        let path =
            std::env::temp_dir().join(format!("keepwork-error-{}.txt", uuid::Uuid::new_v4()));
        let error = "无法结束 Keepwork.exe（进程号 1234）：拒绝访问（Windows 错误 5）";
        write_error_file(&path, error).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        let units: Vec<_> = bytes[2..]
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes([v[0], v[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), error);
        write_error_file(&path, &format!("{}😀\n", "中".repeat(899))).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let units: Vec<_> = bytes[2..]
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes([v[0], v[1]]))
            .collect();
        assert!(units.len() <= 900);
        assert!(String::from_utf16(&units).is_ok());
        std::fs::remove_file(path).unwrap();
    }

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
