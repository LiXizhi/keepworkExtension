use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const LAUNCH_AGENT_LABEL: &str = "com.keepwork.aichat-desktop";
pub const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const WINDOWS_RUN_VALUE_NAME: &str = "KeepworkAIChatDesktop";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default = "default_true")]
    pub pet_visible: bool,
    pub open_at_login: Option<bool>,
}

fn default_true() -> bool {
    true
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            pet_visible: true,
            open_at_login: None,
        }
    }
}

pub fn load_settings(settings_file: &Path) -> DesktopSettings {
    fs::read_to_string(settings_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopSettings>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(settings_file: &Path, settings: &DesktopSettings) -> Result<(), String> {
    atomic_json_write(settings_file, settings)
}

pub fn build_macos_launch_agent_plist(exe_path: &Path) -> String {
    let exe_escaped = exe_path
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe_escaped}</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
}

pub fn build_windows_run_command(exe_path: &Path) -> String {
    format!("\"{}\" --background", exe_path.to_string_lossy())
}

pub struct LoginStartup {
    settings_path: PathBuf,
    launch_agents_dir: PathBuf,
    executable_path: PathBuf,
    packaged: bool,
}

impl LoginStartup {
    pub fn new(
        settings_path: PathBuf,
        launch_agents_dir: PathBuf,
        executable_path: PathBuf,
        packaged: bool,
    ) -> Self {
        Self {
            settings_path,
            launch_agents_dir,
            executable_path,
            packaged,
        }
    }

    pub fn plist_path(&self) -> PathBuf {
        self.launch_agents_dir
            .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
    }

    pub fn ensure_default(&self) -> bool {
        let mut settings = load_settings(&self.settings_path);
        let enabled = match settings.open_at_login {
            Some(val) => val,
            None => {
                let default_val = self.packaged;
                settings.open_at_login = Some(default_val);
                let _ = save_settings(&self.settings_path, &settings);
                default_val
            }
        };
        if self.packaged {
            let _ = self.apply_os_registration(enabled);
        }
        enabled
    }

    pub fn is_enabled(&self) -> bool {
        load_settings(&self.settings_path)
            .open_at_login
            .unwrap_or(self.packaged)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<bool, String> {
        let mut settings = load_settings(&self.settings_path);
        settings.open_at_login = Some(enabled);
        save_settings(&self.settings_path, &settings)?;
        if self.packaged {
            self.apply_os_registration(enabled)?;
        }
        Ok(enabled)
    }

    pub fn apply_os_registration(&self, enabled: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let plist = self.plist_path();
            if enabled {
                fs::create_dir_all(&self.launch_agents_dir)
                    .map_err(|e| format!("Failed to create LaunchAgents directory: {e}"))?;
                let content = build_macos_launch_agent_plist(&self.executable_path);
                fs::write(&plist, content)
                    .map_err(|e| format!("Failed to write LaunchAgent plist: {e}"))?;
            } else if plist.exists() {
                let _ = fs::remove_file(&plist);
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            if enabled {
                let value = build_windows_run_command(&self.executable_path);
                let mut cmd = Command::new("reg.exe");
                cmd.args([
                    "add",
                    WINDOWS_RUN_KEY,
                    "/v",
                    WINDOWS_RUN_VALUE_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                let status = cmd
                    .status()
                    .map_err(|e| format!("Failed to execute reg.exe: {e}"))?;
                if !status.success() {
                    return Err("reg.exe failed to register login startup".to_string());
                }
            } else {
                let mut cmd = Command::new("reg.exe");
                cmd.args([
                    "delete",
                    WINDOWS_RUN_KEY,
                    "/v",
                    WINDOWS_RUN_VALUE_NAME,
                    "/f",
                ]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                let _ = cmd.status();
            }
            return Ok(());
        }

        #[allow(unreachable_code)]
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn defaults_to_enabled_on_first_packaged_install_and_respects_saved_preference() {
        let root = std::env::temp_dir().join(format!("aichat-rust-login-{}", Uuid::new_v4()));
        let settings_file = root.join("settings.json");
        let agents_dir = root.join("LaunchAgents");
        let exe = root.join("Keepwork.app/Contents/MacOS/aichat-rust");

        let startup =
            LoginStartup::new(settings_file.clone(), agents_dir.clone(), exe.clone(), true);
        assert!(startup.ensure_default());
        #[cfg(target_os = "macos")]
        {
            let plist = fs::read_to_string(startup.plist_path()).unwrap();
            assert!(plist.contains("--background"));
        }

        startup.set_enabled(false).unwrap();
        assert!(!startup.is_enabled());

        // Subsequent ensure_default preserves false
        assert!(!startup.ensure_default());

        let _ = fs::remove_dir_all(&root);
    }
}
