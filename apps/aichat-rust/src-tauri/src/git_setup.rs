use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub installed: bool,
    pub version: String,
    pub path: String,
    pub platform: String,
    pub can_install: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallResult {
    pub started: bool,
    pub installed: bool,
    pub method: String,
    pub message: String,
}

fn current_platform_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn candidate_git_binaries() -> Vec<PathBuf> {
    let mut list = vec![PathBuf::from("git")];
    #[cfg(target_os = "macos")]
    {
        list.push(PathBuf::from("/opt/homebrew/bin/git"));
        list.push(PathBuf::from("/usr/local/bin/git"));
        list.push(PathBuf::from("/usr/bin/git"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            list.push(PathBuf::from(&pf).join("Git").join("cmd").join("git.exe"));
            list.push(PathBuf::from(&pf).join("Git").join("bin").join("git.exe"));
        }
        if let Ok(local) = std::env::var("LocalAppData") {
            list.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("Git")
                    .join("cmd")
                    .join("git.exe"),
            );
        }
    }
    list
}

pub fn check_git_with<F>(mut runner: F, platform: &str) -> GitStatus
where
    F: FnMut(&str, &[&str]) -> Result<String, String>,
{
    for candidate in candidate_git_binaries() {
        let bin = candidate.to_string_lossy().into_owned();
        if let Ok(out) = runner(&bin, &["--version"]) {
            let trimmed = out.trim();
            // On macOS, a stub `/usr/bin/git` without CLT outputs "xcode-select: note: No developer tools were found"
            if trimmed.starts_with("git version") {
                let version = trimmed
                    .trim_start_matches("git version")
                    .trim()
                    .to_string();
                return GitStatus {
                    installed: true,
                    version,
                    path: bin,
                    platform: platform.to_string(),
                    can_install: matches!(platform, "darwin" | "win32"),
                };
            }
        }
    }
    GitStatus {
        installed: false,
        version: String::new(),
        path: String::new(),
        platform: platform.to_string(),
        can_install: matches!(platform, "darwin" | "win32"),
    }
}

pub fn check_git() -> GitStatus {
    check_git_with(
        |bin, args| {
            let output = Command::new(bin)
                .args(args)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err("non-zero exit".to_string());
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        },
        current_platform_label(),
    )
}

pub fn install_git() -> GitInstallResult {
    let status = check_git();
    if status.installed {
        return GitInstallResult {
            started: false,
            installed: true,
            method: "already-installed".to_string(),
            message: format!("Git 已安装（{}）", status.version),
        };
    }

    #[cfg(target_os = "macos")]
    {
        match Command::new("xcode-select").arg("--install").spawn() {
            Ok(_) => GitInstallResult {
                started: true,
                installed: false,
                method: "xcode-select".to_string(),
                message: "已启动 macOS 命令行开发者工具安装引导，请在弹出窗口中确认安装。".to_string(),
            },
            Err(e) => GitInstallResult {
                started: false,
                installed: false,
                method: "xcode-select".to_string(),
                message: format!("无法启动 Git 安装引导：{e}"),
            },
        }
    }

    #[cfg(target_os = "windows")]
    {
        match Command::new("winget")
            .args([
                "install",
                "--id",
                "Git.Git",
                "-e",
                "--source",
                "winget",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .spawn()
        {
            Ok(_) => GitInstallResult {
                started: true,
                installed: false,
                method: "winget".to_string(),
                message: "已启动 winget 安装 Git.Git，请等待安装完成。".to_string(),
            },
            Err(e) => GitInstallResult {
                started: false,
                installed: false,
                method: "winget".to_string(),
                message: format!("无法通过 winget 启动 Git 安装：{e}"),
            },
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        GitInstallResult {
            started: false,
            installed: false,
            method: "manual".to_string(),
            message: "请使用系统包管理器安装 git。".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_git_version_and_handles_missing_git() {
        let found = check_git_with(
            |_bin, _args| Ok("git version 2.45.1\n".to_string()),
            "darwin",
        );
        assert!(found.installed);
        assert_eq!(found.version, "2.45.1");
        assert!(found.can_install);

        let missing = check_git_with(|_bin, _args| Err("ENOENT".to_string()), "win32");
        assert!(!missing.installed);
        assert_eq!(missing.version, "");
        assert!(missing.can_install);
    }
}
