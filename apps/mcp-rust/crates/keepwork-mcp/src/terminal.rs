//! Terminal policy shared by model-operated commands and optional user PTYs.
//!
//! The Windows 7/8 edition has no ConPTY backend. Excluding it at compile time also
//! prevents its Windows-10-only entry points from entering the legacy binary.

pub const TERMINAL_API: &str = "pty-session-v1";
pub const GLOBAL_TERMINAL_CAP: usize = 4;
pub const OUTPUT_CHAR_CAP: usize = 24_000;

pub const fn supported() -> bool {
    !cfg!(any(target_vendor = "win7", feature = "win7-compat"))
}

#[cfg(not(any(target_vendor = "win7", feature = "win7-compat")))]
#[path = "terminal/pty.rs"]
mod backend;
#[cfg(any(target_vendor = "win7", feature = "win7-compat"))]
#[path = "terminal/unsupported.rs"]
mod backend;
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
