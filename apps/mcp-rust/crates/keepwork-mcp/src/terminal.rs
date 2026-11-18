//! Terminal policy shared by model-operated commands and optional user PTYs.
//!
//! The compatibility edition retains verified WinPTY on old systems and selects
//! existing system ConPTY APIs on newer hosts. Fixed assets remain mandatory.

pub const TERMINAL_API: &str = "pty-session-v1";
pub const GLOBAL_TERMINAL_CAP: usize = 4;
pub const OUTPUT_CHAR_CAP: usize = 24_000;

#[derive(Clone, Copy, Debug)]
pub struct TerminalHealth {
    pub ready: bool,
    pub status: &'static str,
    pub reason: Option<&'static str>,
}

pub fn health() -> TerminalHealth {
    #[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
    return winpty::health();
    #[cfg(all(not(windows), any(target_vendor = "win7", feature = "win7-compat")))]
    return TerminalHealth {
        ready: false,
        status: "unavailable",
        reason: Some("The Windows compatibility terminal backend is unavailable on this platform."),
    };
    #[cfg(not(any(target_vendor = "win7", feature = "win7-compat")))]
    return TerminalHealth {
        ready: true,
        status: "ready",
        reason: None,
    };
}

pub fn supported() -> bool {
    health().ready
}

/// Ready backend selection for a future session, not proof of shell startup.
/// Successful session snapshots separately record their actual opened backend.
pub fn backend_name() -> Option<&'static str> {
    if !health().ready {
        return None;
    }
    #[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
    return match selection::choose_backend(true, system_conpty::export_presence()) {
        Some(selection::Backend::Conpty) => Some("conpty"),
        Some(selection::Backend::Winpty) => Some("winpty"),
        None => None,
    };
    #[cfg(all(windows, not(any(target_vendor = "win7", feature = "win7-compat"))))]
    return Some("conpty");
    #[cfg(not(windows))]
    None
}

#[cfg(any(
    test,
    all(windows, any(target_vendor = "win7", feature = "win7-compat"))
))]
#[path = "terminal/selection.rs"]
mod selection;

#[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
#[path = "terminal/system_conpty.rs"]
mod system_conpty;

#[cfg(any(
    test,
    all(windows, any(target_vendor = "win7", feature = "win7-compat"))
))]
#[path = "terminal/readiness.rs"]
mod readiness;

#[cfg(any(not(any(target_vendor = "win7", feature = "win7-compat")), windows))]
#[path = "terminal/pty.rs"]
mod backend;
#[cfg(all(not(windows), any(target_vendor = "win7", feature = "win7-compat")))]
#[path = "terminal/unsupported.rs"]
mod backend;
#[cfg(any(not(any(target_vendor = "win7", feature = "win7-compat")), windows))]
#[path = "terminal/native.rs"]
mod native;
#[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
#[path = "terminal/winpty.rs"]
mod winpty;
pub use backend::{route, TerminalManager};

/// Same deny-list as `src/core/terminal.ts`. Never weaken it.
const DENY_PATTERNS: &[&str] = &[
    r"(?i)\bformat\s+[a-z]:",
    r"(?i)\bshutdown\b",
    r"(?i)\brm\s+(-[a-z]*f[a-z]*\s+)*\/(\s|$)",
    r"(?i)\bdel\s+\/s\s+\/q\s+[c-z]:\\",
    r"(?i)\bmkfs\b",
    r"(?i)\bdd\s+if=",
    r"(?i)\bcipher\s+\/w",
    r"(?i)\breg\s+delete\s+hklm\b",
    r"(?i)\bRemove-Item\s+.*-Recurse.*[c-z]:\\",
];

pub fn assert_allowed_command(command: &str) -> Result<String, String> {
    let text = command.trim().to_string();
    if text.is_empty() {
        return Err("command is required".to_string());
    }
    for pattern in DENY_PATTERNS {
        let re = regex::Regex::new(pattern).expect("static deny pattern");
        if re.is_match(&text) {
            return Err(format!(
                "Command blocked by deny-list: {}",
                text.chars().take(80).collect::<String>()
            ));
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_policy_is_kept_when_user_ptys_are_unavailable() {
        for command in ["rm -rf /", "shutdown -h now", "mkfs.ext4 /dev/sda1", ""] {
            assert!(assert_allowed_command(command).is_err());
        }
        assert_eq!(
            assert_allowed_command("echo compatible").unwrap(),
            "echo compatible"
        );
    }
}
