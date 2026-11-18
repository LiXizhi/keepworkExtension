//! User-home state: `~/.keepwork-mcp/{config.json,token,instance.json}`.
//!
//! Precedence and defaults mirror `src/core/config.ts` exactly so a machine can
//! run either engine against the same profile.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8089;
pub const BIND_HOST: &str = "127.0.0.1";
pub const DEFAULT_WORKSPACE_SLOT: &str = "default";
pub const FS_API: &str = "workspace";
pub const FOLDER_BROWSER_API: &str = "folders-v1";

#[derive(Debug, Default, Deserialize)]
pub struct ConfigFile {
    #[serde(rename = "workspaceRoot")]
    pub workspace_root: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "requireAuth")]
    pub require_auth: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceInfo {
    pub pid: u32,
    pub port: u16,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub name: String,
}

/// Same lookup as Node `os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere.
///
/// `dirs::home_dir()` asks Windows for the profile folder and ignores
/// `USERPROFILE`, so a process started with an isolated profile (the contract
/// harness sets one) would write its token outside the directory the client reads.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(dir) = non_empty_env_path("USERPROFILE") {
            return Some(dir);
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            let drive = drive.trim();
            let path = path.trim();
            if !drive.is_empty() && !path.is_empty() {
                return Some(PathBuf::from(format!("{drive}{path}")));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(dir) = non_empty_env_path("HOME") {
            return Some(dir);
        }
    }
    os_home_dir()
}

/// Native profile lookup. New windows-sys bindings used by dirs 6 import
/// CoTaskMemFree from combase.dll, which does not exist on Windows 7.
/// SHGetFolderPathW provides the same profile-folder lookup on the legacy target.
pub(crate) fn os_home_dir() -> Option<PathBuf> {
    #[cfg(not(target_vendor = "win7"))]
    {
        dirs::home_dir()
    }
    #[cfg(target_vendor = "win7")]
    {
        use std::os::windows::ffi::OsStringExt;
        #[link(name = "shell32")]
        extern "system" {
            fn SHGetFolderPathW(
                hwnd: *mut std::ffi::c_void,
                csidl: i32,
                token: *mut std::ffi::c_void,
                flags: u32,
                path: *mut u16,
            ) -> i32;
        }
        let mut path = [0u16; 260];
        let result = unsafe {
            SHGetFolderPathW(
                std::ptr::null_mut(),
                0x0028, // CSIDL_PROFILE; do not create or change a profile.
                std::ptr::null_mut(),
                0,
                path.as_mut_ptr(),
            )
        };
        if result < 0 {
            return None;
        }
        let length = path.iter().position(|unit| *unit == 0)?;
        if length == 0 {
            return None;
        }
        Some(std::ffi::OsString::from_wide(&path[..length]).into())
    }
}

fn non_empty_env_path(key: &str) -> Option<PathBuf> {
    let value = std::env::var(key).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

pub fn mcp_home_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".keepwork-mcp")
}

pub fn default_user_workspace() -> PathBuf {
    mcp_home_dir().join("workspace")
}

pub fn config_path() -> PathBuf {
    mcp_home_dir().join("config.json")
}

pub fn token_path() -> PathBuf {
    mcp_home_dir().join("token")
}

pub fn instance_path() -> PathBuf {
    mcp_home_dir().join("instance.json")
}

pub fn ensure_mcp_home() -> std::io::Result<PathBuf> {
    let dir = mcp_home_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn read_config_file() -> ConfigFile {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// `--port` > `KEEPWORK_MCP_PORT` > `config.json.port` > 8089.
pub fn resolve_port(override_port: Option<u16>) -> u16 {
    if let Some(port) = override_port.filter(|port| *port > 0) {
        return port;
    }
    if let Ok(raw) = std::env::var("KEEPWORK_MCP_PORT") {
        if let Ok(port) = raw.trim().parse::<u16>() {
            if port > 0 {
                return port;
            }
        }
    }
    read_config_file()
        .port
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT)
}

/// `--require-auth` > `KEEPWORK_MCP_REQUIRE_AUTH` > `config.json.requireAuth` > open.
pub fn resolve_require_auth(override_auth: Option<bool>) -> bool {
    if let Some(value) = override_auth {
        return value;
    }
    if let Ok(raw) = std::env::var("KEEPWORK_MCP_REQUIRE_AUTH") {
        let value = raw.trim().to_ascii_lowercase();
        if value == "1" || matches!(value.as_str(), "true" | "yes" | "on") {
            return true;
        }
        if value == "0" || matches!(value.as_str(), "false" | "no" | "off") {
            return false;
        }
    }
    read_config_file().require_auth.unwrap_or(false)
}

/// Reads `~/.keepwork-mcp/token`, creating a 24-byte hex token (0600) when absent.
pub fn read_or_create_token() -> std::io::Result<String> {
    ensure_mcp_home()?;
    let path = token_path();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    fs::write(&path, &token)?;
    set_private_mode(&path);
    Ok(token)
}

#[cfg(unix)]
fn set_private_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path) {}

pub fn write_instance(info: &InstanceInfo) -> std::io::Result<()> {
    ensure_mcp_home()?;
    let body = serde_json::to_string_pretty(info).unwrap_or_default();
    fs::write(instance_path(), body)
}

pub fn clear_instance() {
    let _ = fs::remove_file(instance_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_precedence_uses_override_first() {
        assert_eq!(resolve_port(Some(9100)), 9100);
        assert!(resolve_port(None) > 0);
    }

    #[test]
    fn require_auth_defaults_to_open() {
        assert!(!resolve_require_auth(Some(false)));
        assert!(resolve_require_auth(Some(true)));
    }

    #[test]
    fn instance_json_shape_matches_node() {
        let info = InstanceInfo {
            pid: 1,
            port: 8089,
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
            name: "keepwork-mcp".to_string(),
        };
        let text = serde_json::to_string_pretty(&info).unwrap();
        assert!(text.contains("\"startedAt\""));
        assert!(text.contains("\"name\": \"keepwork-mcp\""));
    }
}
