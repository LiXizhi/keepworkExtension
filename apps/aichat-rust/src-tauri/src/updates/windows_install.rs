//! NSIS update handoff. The installer waits for this exact process to exit;
//! it never terminates the desktop to make replacement succeed.
use std::path::Path;

pub(super) fn validate_install(executable: &Path) -> Result<(), String> {
    let directory = executable.parent().ok_or("安装目录无效")?;
    if !directory.join("uninstall.exe").is_file() {
        return Err("请先安装 Keepwork；开发版或便携版不支持自动覆盖安装".into());
    }
    if executable
        .file_name()
        .is_some_and(|v| v.eq_ignore_ascii_case("aichat-rust.exe"))
        && directory.join("Keepwork.exe").is_file()
    {
        return Err("兼容 Launcher 版本需要通过独立的兼容安装包更新".into());
    }
    Ok(())
}

pub(super) fn parameters(
    executable: &Path,
    parent: &str,
    relaunch: bool,
    profile: &Path,
) -> Result<String, String> {
    let name = executable
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("应用路径无效")?;
    if !["keepwork.exe", "aichat-rust.exe"].contains(&name.to_ascii_lowercase().as_str()) {
        return Err("只有已安装的 Keepwork 桌面应用可以自动更新".into());
    }
    crate::installer_stop::parse_parent_identity(parent)?;
    let directory = executable
        .parent()
        .and_then(|v| v.to_str())
        .ok_or("安装目录无效")?;
    // NSIS /D consumes everything to the end, unquoted. No shell is involved.
    // Extended paths are not supported by NSIS; dunce removes that prefix.
    if directory.is_empty()
        || directory
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\n' | '"'))
    {
        return Err("安装目录包含不支持的字符".into());
    }
    let restart = if relaunch {
        let profile = profile.to_str().ok_or("用户配置目录无效")?;
        if profile.is_empty()
            || profile
                .chars()
                .any(|c| matches!(c, '\0' | '\r' | '\n' | '"'))
        {
            return Err("用户配置目录包含不支持的字符".into());
        }
        // NSIS GetOptions strips quotes only around the complete /ARGS value.
        // Keep its first character '-' so the inner Windows argument quotes
        // survive. Double trailing backslashes before the closing quote.
        let trailing = profile.chars().rev().take_while(|c| *c == '\\').count();
        format!(
            " /R /ARGS --user-data-dir=\"{profile}{}\"",
            "\\".repeat(trailing)
        )
    } else {
        String::new()
    };
    Ok(format!(
        "/S /UPDATE /KEEPWORK_PARENT={parent} /KEEPWORK_EXE={name}{restart} /D={directory}"
    ))
}

fn receipt_state(package: &Path) -> Option<String> {
    let receipt = package.with_file_name(format!("{}.result.json", package.file_name()?.to_str()?));
    if std::fs::metadata(&receipt).ok()?.len() > 65536 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(receipt).ok()?).ok()?;
    value["state"].as_str().map(str::to_owned)
}

pub(super) fn installation_succeeded(package: &Path) -> bool {
    receipt_state(package).as_deref() == Some("installed")
}

pub(super) fn read_failure(package: &Path) -> Option<String> {
    match receipt_state(package)?.as_str() {
        "failed" => Some(format!(
            "上次自动覆盖安装失败；原下载包已保留，请重新运行安装包修复：{}",
            package.display()
        )),
        "installing" => Some(format!(
            "上次自动安装尚未确认完成；请等待安装器结束，若已退出可重新运行安装包修复：{}",
            package.display()
        )),
        _ => None,
    }
}

#[cfg(windows)]
pub(super) fn launch(package: &Path, relaunch: bool, profile: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let executable = dunce::canonicalize(std::env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| format!("无法确定当前安装目录：{e}"))?;
    validate_install(&executable)?;
    let parent = crate::installer_stop::current_parent_identity()?;
    let args = parameters(&executable, &parent, relaunch, profile)?;
    let file: Vec<u16> = package.as_os_str().encode_wide().chain(Some(0)).collect();
    let args: Vec<u16> = args.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result > 32 {
        Ok(())
    } else {
        Err(format!(
            "启动自动更新失败（Windows {result}）；更新包已保留"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installer_receipts_report_failure_without_claiming_install_success() {
        let dir = std::env::temp_dir().join(format!("keepwork-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let package = dir.join("installer.exe");
        let receipt = dir.join("installer.exe.result.json");
        assert!(read_failure(&package).is_none());
        for status in ["failed", "installing", "installed"] {
            std::fs::write(
                &receipt,
                serde_json::to_vec(&serde_json::json!({"state":status})).unwrap(),
            )
            .unwrap();
            assert_eq!(read_failure(&package).is_some(), status != "installed");
        }
        std::fs::write(&receipt, "invalid").unwrap();
        assert!(read_failure(&package).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn quiet_update_preserves_custom_directory_and_only_restarts_when_requested() {
        let executable = Path::new("C:/Users/测试/My Keepwork/Keepwork.exe");
        let quiet = parameters(
            executable,
            "123:456",
            false,
            Path::new("C:/private profile"),
        )
        .unwrap();
        assert_eq!(quiet, "/S /UPDATE /KEEPWORK_PARENT=123:456 /KEEPWORK_EXE=Keepwork.exe /D=C:/Users/测试/My Keepwork");
        assert_eq!(
            parameters(executable, "123:456", true, Path::new("C:/private profile")).unwrap(),
            quiet.replacen(
                " /D=",
                " /R /ARGS --user-data-dir=\"C:/private profile\" /D=",
                1
            )
        );
        assert!(parameters(
            executable,
            "123:456 /R",
            false,
            Path::new("C:/private profile")
        )
        .is_err());
        assert!(parameters(
            Path::new("C:/bad\"/Keepwork.exe"),
            "123:456",
            false,
            Path::new("C:/private profile")
        )
        .is_err());
        assert!(parameters(
            Path::new("C:/App/other.exe"),
            "123:456",
            false,
            Path::new("C:/private profile")
        )
        .is_err());
    }
    #[test]
    fn dev_portable_and_compatibility_layouts_cannot_be_overwritten() {
        let dir =
            std::env::temp_dir().join(format!("keepwork-install-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("aichat-rust.exe");
        std::fs::write(&executable, b"desktop").unwrap();
        assert!(validate_install(&executable).is_err());
        std::fs::write(dir.join("uninstall.exe"), b"uninstaller").unwrap();
        assert!(validate_install(&executable).is_ok());
        std::fs::write(dir.join("Keepwork.exe"), b"wrapper").unwrap();
        assert!(validate_install(&executable)
            .unwrap_err()
            .contains("Launcher"));
        assert!(validate_install(&dir.join("Keepwork.exe")).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
