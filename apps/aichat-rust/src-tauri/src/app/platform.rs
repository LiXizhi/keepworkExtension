//! System browser and file manager integration.

use crate::security::external_url;
#[cfg(target_os = "macos")]
use serde_json::Value;
use std::path::Path;
use std::process::Command;
#[cfg(target_os = "macos")]
use std::{
    process::Stdio,
    time::{Duration, Instant},
};

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
            // Let a native menu finish tracking before dispatching the URL.
            std::thread::sleep(Duration::from_millis(200));
            let bundle_id = default_browser_bundle_id();
            if let Err(err) = open_macos_url(&url, bundle_id.as_deref(), run_browser_command) {
                eprintln!("open browser failed: {err}");
            }
        })
        .map(|_| ())
        .map_err(|e| format!("无法打开 {url_for_err}：{e}"))
}

#[cfg(target_os = "macos")]
fn open_macos_url(
    url: &str,
    bundle_id: Option<&str>,
    mut run: impl FnMut(&mut Command, Duration) -> Result<(), String>,
) -> Result<(), String> {
    let timeout = Duration::from_secs(3);
    let mut primary_error = None;
    if let Some(bundle_id) = bundle_id {
        if bundle_id.is_empty()
            || !bundle_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err("浏览器标识无效".to_string());
        }
        let mut command = Command::new("/usr/bin/osascript");
        command.args([
            "-e",
            "on run argv\ntell application id (item 1 of argv) to open location (item 2 of argv)\nend run",
            bundle_id,
            url,
        ]);
        match run(&mut command, timeout) {
            Ok(()) => return Ok(()),
            Err(error) => primary_error = Some(error),
        }
    }

    // AppleScript can be denied or wait indefinitely for Automation consent.
    // LaunchServices does not need that permission; opening this read-only URL
    // again is safe even if the first request reached the browser before timeout.
    let mut fallback = Command::new("/usr/bin/open");
    fallback.args(["--", url]);
    run(&mut fallback, timeout).map_err(|error| match primary_error {
        Some(primary) => format!("AppleScript: {primary}; LaunchServices: {error}"),
        None => error,
    })
}

#[cfg(target_os = "macos")]
fn run_browser_command(command: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("{status}"))
                }
            }
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(25))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => error.to_string(),
                    _ => "打开浏览器超时".to_string(),
                });
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "platform_tests.rs"]
mod tests;

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
