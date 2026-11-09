use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopClientIdentity {
    pub product: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub executable: String,
}

pub fn normalize_platform(raw: &str) -> &'static str {
    match raw {
        "macos" | "darwin" => "macos",
        "windows" | "win32" => "windows",
        _ => "linux",
    }
}

pub fn normalize_arch(raw: &str) -> &'static str {
    match raw {
        "aarch64" | "arm64" => "arm64",
        "x86_64" | "x64" => "x64",
        _ => "x64",
    }
}

pub fn default_mcp_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".keepwork-mcp")
}

pub fn remember_desktop_client(
    mcp_home: &Path,
    version: &str,
    executable: &Path,
    packaged: bool,
) -> Result<Option<DesktopClientIdentity>, String> {
    if !packaged {
        return Ok(None);
    }
    if !executable.is_file() {
        return Ok(None);
    }
    let identity = DesktopClientIdentity {
        product: "aichat-desktop".to_string(),
        version: version.trim().to_string(),
        platform: normalize_platform(std::env::consts::OS).to_string(),
        arch: normalize_arch(std::env::consts::ARCH).to_string(),
        executable: executable.to_string_lossy().into_owned(),
    };
    let file_path = mcp_home.join("desktop-client.json");
    atomic_json_write(&file_path, &identity)?;
    Ok(Some(identity))
}

pub fn read_desktop_client(mcp_home: &Path) -> Option<DesktopClientIdentity> {
    let file_path = mcp_home.join("desktop-client.json");
    let raw = fs::read_to_string(file_path).ok()?;
    let identity = serde_json::from_str::<DesktopClientIdentity>(&raw).ok()?;
    if identity.product != "aichat-desktop" || identity.version.is_empty() {
        return None;
    }
    if !Path::new(&identity.executable).is_file() {
        return None;
    }
    Some(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn records_packaged_desktop_identity_and_omits_when_executable_missing() {
        let root = std::env::temp_dir().join(format!("aichat-rust-id-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let exe = root.join("Keepwork");
        fs::write(&exe, "binary").unwrap();

        // Unpackaged call does not write identity
        assert!(remember_desktop_client(&root, "0.2.0", &exe, false)
            .unwrap()
            .is_none());
        assert!(read_desktop_client(&root).is_none());

        // Packaged call writes and reads back
        let saved = remember_desktop_client(&root, "0.2.0", &exe, true)
            .unwrap()
            .unwrap();
        assert_eq!(saved.product, "aichat-desktop");
        assert_eq!(saved.version, "0.2.0");
        assert_eq!(read_desktop_client(&root), Some(saved));

        // Removing executable omits stale identity
        fs::remove_file(&exe).unwrap();
        assert!(read_desktop_client(&root).is_none());

        let _ = fs::remove_dir_all(&root);
    }
}
