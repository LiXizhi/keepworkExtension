//! System browser and file manager integration.

use crate::security::external_url;
#[cfg(target_os = "macos")]
use serde_json::Value;
use std::path::Path;
use std::process::Command;
#[cfg(target_os = "macos")]
use std::{process::Stdio, time::Duration};

pub fn open_in_system_browser(raw_url: &str) -> Result<(), String> {
    let valid = external_url(raw_url).ok_or_else(|| format!("Invalid external URL: {raw_url}"))?;
    #[cfg(target_os = "macos")]
    {
        spawn_macos_open(&valid)
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &valid])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(&valid)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn spawn_macos_open(url: &str) -> Result<(), String> {
    let url = url.to_string();
    let url_for_err = url.clone();
    std::thread::Builder::new()
        .name("open-url".into())
        .spawn(move || {
            // The status-item menu is still tracking when this is requested.
            // `open` and NSWorkspace only activate Chrome in that state and drop
            // the URL (Chrome is often already running with --no-startup-window).
            // AppleScript `open location` is what actually creates the tab.
            std::thread::sleep(Duration::from_millis(200));
            if let Some(bundle_id) = default_browser_bundle_id() {
                // Do not fall back to `open` after this fails. That command
                // brings Chrome forward and still does not load the URL.
                if let Err(err) = browser_open_location(&bundle_id, &url) {
                    eprintln!("mcp-dashboard: {err}");
                }
                return;
            }
            let _ = Command::new("/usr/bin/open")
                .arg("--")
                .arg(&url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        })
        .map(|_| ())
        .map_err(|e| format!("无法打开 {url_for_err}：{e}"))
}

#[cfg(target_os = "macos")]
fn browser_open_location(bundle_id: &str, url: &str) -> Result<(), String> {
    if !bundle_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!("浏览器标识无效：{bundle_id}"));
    }
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(
            "on run argv\ntell application id (item 1 of argv) to open location (item 2 of argv)\nend run",
        )
        .arg(bundle_id)
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript {} {}", output.status, detail.trim()))
    }
}

#[cfg(target_os = "macos")]
fn default_browser_bundle_id() -> Option<String> {
    let path = dirs::home_dir()?
        .join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    let output = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    let handlers = value.get("LSHandlers")?.as_array()?;
    let mut https_id = None;
    let mut web_browser = None;
    for handler in handlers {
        let role = handler
            .get("LSHandlerRoleAll")
            .and_then(Value::as_str)
            .map(str::to_string);
        let scheme = handler.get("LSHandlerURLScheme").and_then(Value::as_str);
        if scheme == Some("http") {
            return role;
        }
        if scheme == Some("https") {
            https_id = role.clone();
        }
        if handler.get("LSHandlerContentType").and_then(Value::as_str)
            == Some("com.apple.default-app.web-browser")
        {
            web_browser = role;
        }
    }
    https_id.or(web_browser)
}

pub fn reveal_path_in_os(target: &Path, mode: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        match mode {
            "open" => {
                cmd.arg(target);
            }
            "dir" => {
                let dir = if target.is_dir() {
                    target
                } else {
                    target.parent().unwrap_or(target)
                };
                cmd.arg(dir);
            }
            _ => {
                cmd.arg("-R").arg(target);
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        match mode {
            "open" => {
                Command::new("explorer.exe")
                    .arg(target)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "dir" => {
                let dir = if target.is_dir() {
                    target
                } else {
                    target.parent().unwrap_or(target)
                };
                Command::new("explorer.exe")
                    .arg(dir)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                Command::new("explorer.exe")
                    .arg(format!("/select,{}", target.to_string_lossy()))
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
