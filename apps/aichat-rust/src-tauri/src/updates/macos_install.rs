//! Same-volume macOS bundle replacement from an already verified DMG.
//!
//! All preflight work happens before the desktop exits. A fixed, detached helper
//! then waits for that process, swaps directory names and optionally relaunches.
//! The prior bundle is retained; launching is not a full application health test.
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BUNDLE_ID: &str = "com.keepwork.aichat-desktop";
const PREFIX: &str = ".keepwork-update-";
const HELPER: &str = include_str!("macos_install.sh");

#[derive(Serialize, Deserialize)]
struct Transaction {
    target: PathBuf,
    expected_version: String,
    transaction: PathBuf,
}

/// A helper failure is reported on the next launch; successful launch is not
/// claimed as application health, and the previous bundle remains recoverable.
pub fn read_failure(downloads: &Path, expected_version: &str) -> Option<String> {
    let bytes = fs::read(downloads.join("macos-install.json")).ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    let record: Transaction = serde_json::from_slice(&bytes).ok()?;
    if record.expected_version != expected_version {
        return None;
    }
    let directory = &record.transaction;
    if directory.parent() != record.target.parent()
        || !directory.file_name()?.to_str()?.starts_with(PREFIX)
        || fs::symlink_metadata(directory)
            .ok()?
            .file_type()
            .is_symlink()
    {
        return None;
    }
    let status = fs::read_to_string(directory.join("status")).ok()?;
    if status.starts_with("failed:") {
        Some(format!(
            "上次自动更新未完成，原应用或备份仍保留：{}；详情：{}",
            status.trim(),
            downloads.join("macos-install.log").display()
        ))
    } else {
        None
    }
}

pub fn launch(
    package: &Path,
    expected_version: &str,
    relaunch: bool,
    profile_dir: &Path,
) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = installed_bundle(&executable)?;
    launch_for_bundle(
        package,
        expected_version,
        relaunch,
        &target,
        std::process::id(),
        profile_dir,
    )
}

fn installed_bundle(executable: &Path) -> Result<PathBuf, String> {
    let executable = executable.canonicalize().map_err(|e| e.to_string())?;
    let macos = executable.parent().ok_or("当前程序不在 macOS 应用包内")?;
    let contents = macos.parent().ok_or("当前程序不在 macOS 应用包内")?;
    let bundle = contents.parent().ok_or("当前程序不在 macOS 应用包内")?;
    if macos.file_name().is_none_or(|p| p != "MacOS")
        || contents.file_name().is_none_or(|p| p != "Contents")
        || bundle.extension().is_none_or(|p| p != "app")
    {
        return Err("请先将 Keepwork 安装到可写的应用目录，再使用自动更新".into());
    }
    if bundle.starts_with("/Volumes")
        || bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return Err(
            "请先将 Keepwork 从磁盘映像拖入应用程序目录，然后重新打开以启用自动更新".into(),
        );
    }
    let info = bundle_info(bundle)?;
    if info.identifier != BUNDLE_ID
        || bundle.join("Contents/MacOS").join(&info.executable) != executable
    {
        return Err("当前应用身份无效，已停止自动覆盖".into());
    }
    Ok(bundle.to_path_buf())
}

struct Mount(PathBuf);
impl Drop for Mount {
    fn drop(&mut self) {
        let _ = bounded_command(
            Command::new("/usr/bin/hdiutil")
                .args(["detach", "-quiet"])
                .arg(&self.0),
            Duration::from_secs(30),
        );
    }
}

fn launch_for_bundle(
    package: &Path,
    expected_version: &str,
    relaunch: bool,
    target: &Path,
    pid: u32,
    profile_dir: &Path,
) -> Result<(), String> {
    let profile_dir = profile_dir
        .canonicalize()
        .map_err(|e| format!("无法确定原应用配置目录：{e}"))?;
    if !profile_dir.is_dir() {
        return Err("原应用配置路径不是目录，已停止自动更新".into());
    }
    let version = semver::Version::parse(expected_version).map_err(|_| "更新版本无效")?;
    let current = bundle_info(target)?;
    if current.identifier != BUNDLE_ID
        || version <= semver::Version::parse(&current.version).map_err(|_| "当前应用版本无效")?
    {
        return Err("更新包必须属于当前应用且版本高于已安装版本".into());
    }
    if fs::symlink_metadata(target)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("自动更新不支持符号链接应用路径".into());
    }
    let parent = target.parent().ok_or("应用目录无效")?;
    let transaction = parent.join(format!("{PREFIX}{}", uuid::Uuid::new_v4()));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&transaction)
        .map_err(|e| {
            format!("无法写入应用所在目录，请将 Keepwork 移到当前用户可写的应用目录：{e}")
        })?;
    let result = stage_and_spawn(
        package,
        expected_version,
        relaunch,
        target,
        pid,
        &transaction,
        &profile_dir,
    );
    if result.is_err() {
        let _ = fs::remove_dir_all(&transaction);
    }
    result
}

fn stage_and_spawn(
    package: &Path,
    expected_version: &str,
    relaunch: bool,
    target: &Path,
    pid: u32,
    transaction: &Path,
    profile_dir: &Path,
) -> Result<(), String> {
    let mount = transaction.join("volume");
    fs::create_dir(&mount).map_err(|e| e.to_string())?;
    // Attach can mount successfully before its process fails/times out.
    let mounted = Mount(mount.clone());
    bounded_command(
        Command::new("/usr/bin/hdiutil")
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(&mount)
            .arg(package),
        Duration::from_secs(120),
    )?;
    let candidates: Vec<_> = fs::read_dir(&mount)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "app"))
        .map(|entry| entry.path())
        .collect();
    if candidates.len() != 1 {
        return Err("更新磁盘映像必须包含且仅包含一个应用包".into());
    }
    validate_candidate(&candidates[0], expected_version)?;
    let staged = transaction.join("next.app");
    bounded_command(
        Command::new("/usr/bin/ditto")
            .arg(&candidates[0])
            .arg(&staged),
        Duration::from_secs(180),
    )?;
    validate_candidate(&staged, expected_version)?;
    drop(mounted);
    fs::remove_dir(&mount).map_err(|e| format!("更新磁盘映像尚未卸载：{e}"))?;

    let record = Transaction {
        target: target.to_path_buf(),
        expected_version: expected_version.into(),
        transaction: transaction.to_path_buf(),
    };
    fs::write(
        transaction.join("transaction.json"),
        serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let log_path = package
        .parent()
        .ok_or("更新下载目录无效")?
        .join("macos-install.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    // Retain the transaction path for diagnostics even after the old app exits.
    fs::write(
        package.parent().unwrap().join("macos-install.json"),
        serde_json::to_vec_pretty(&record).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let previous = previous_transactions(target, transaction);
    let staged_metadata = fs::metadata(&staged).map_err(|e| e.to_string())?;
    let staged_identity = format!("{}:{}", staged_metadata.dev(), staged_metadata.ino());
    let metadata = fs::metadata(target).map_err(|e| e.to_string())?;
    let identity = format!("{}:{}", metadata.dev(), metadata.ino());
    let script = transaction.join("apply.sh");
    fs::write(&script, HELPER).map_err(|e| e.to_string())?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let mut command = Command::new("/bin/sh");
    command
        .arg(&script)
        .arg(pid.to_string())
        .arg(target)
        .arg(transaction)
        .arg(if relaunch { "1" } else { "0" })
        .arg(expected_version)
        .arg(identity)
        .arg(staged_identity)
        .arg(profile_dir)
        .args(previous)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动自动更新助手：{e}"))?;
    // Acknowledge before the caller quits; shell setup failures cannot close the app.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if transaction.join("ready").is_file() {
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "自动更新助手启动失败（{status}），日志：{}",
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("自动更新助手未能就绪，当前应用保持运行".into())
}

fn previous_transactions(target: &Path, current: &Path) -> Vec<std::ffi::OsString> {
    let Some(parent) = target.parent() else {
        return Vec::new();
    };
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path == current
                || !entry.file_name().to_string_lossy().starts_with(PREFIX)
                || !entry.file_type().ok()?.is_dir()
                || !path.join("installed").is_file()
            {
                return None;
            }
            let record: Transaction =
                serde_json::from_slice(&fs::read(path.join("transaction.json")).ok()?).ok()?;
            if record.target != target
                || record.transaction != path
                || bundle_info(&path.join("previous.app")).ok()?.identifier != BUNDLE_ID
            {
                return None;
            }
            let metadata = fs::metadata(&path).ok()?;
            Some(vec![
                path.into_os_string(),
                format!("{}:{}", metadata.dev(), metadata.ino()).into(),
            ])
        })
        .flatten()
        .collect()
}

struct BundleInfo {
    identifier: String,
    version: String,
    executable: String,
}
fn bundle_info(bundle: &Path) -> Result<BundleInfo, String> {
    let plist = bundle.join("Contents/Info.plist");
    let metadata = fs::metadata(&plist).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("应用属性文件类型或大小无效".into());
    }
    if fs::symlink_metadata(bundle)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || plist
            .canonicalize()
            .map_err(|e| e.to_string())?
            .strip_prefix(bundle.canonicalize().map_err(|e| e.to_string())?)
            .is_err()
    {
        return Err("应用包路径包含外部符号链接".into());
    }
    let read = |key: &str| -> Result<String, String> {
        let output = Command::new("/usr/libexec/PlistBuddy")
            .arg("-c")
            .arg(format!("Print :{key}"))
            .arg(&plist)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("应用包缺少 {key}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let executable = read("CFBundleExecutable")?;
    if executable.is_empty()
        || Path::new(&executable).components().count() != 1
        || executable == "."
        || executable == ".."
        || executable.contains('/')
    {
        return Err("应用可执行文件名无效".into());
    }
    let executable_path = bundle.join("Contents/MacOS").join(&executable);
    if !executable_path.is_file()
        || !executable_path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(bundle.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("应用可执行文件越出应用包".into());
    }
    Ok(BundleInfo {
        identifier: read("CFBundleIdentifier")?,
        version: read("CFBundleShortVersionString")?,
        executable,
    })
}

fn validate_candidate(bundle: &Path, expected_version: &str) -> Result<(), String> {
    let info = bundle_info(bundle)?;
    if info.identifier != BUNDLE_ID || info.version != expected_version {
        return Err("更新应用的标识或版本与清单不符".into());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => return Err("不支持当前处理器架构".into()),
    };
    bounded_command(
        Command::new("/usr/bin/lipo")
            .arg(bundle.join("Contents/MacOS").join(info.executable))
            .args(["-verify_arch", arch]),
        Duration::from_secs(10),
    )?;
    // Preserve platform signature validation; do not strip quarantine or resign.
    bounded_command(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle),
        Duration::from_secs(30),
    )
}

fn bounded_command(command: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("macOS 更新预检失败：{status}")),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("macOS 更新预检超时".into());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
#[path = "macos_install_tests.rs"]
mod tests;
