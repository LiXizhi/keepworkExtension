//! The desktop startup appearance belongs to the profile, independently of
//! the OS preference and each web origin's own theme storage.

use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopTheme {
    #[default]
    Light,
    Dark,
}

impl DesktopTheme {
    pub fn from_dark(dark: bool) -> Self {
        if dark {
            Self::Dark
        } else {
            Self::Light
        }
    }

    pub fn native(self) -> tauri::Theme {
        match self {
            Self::Light => tauri::Theme::Light,
            Self::Dark => tauri::Theme::Dark,
        }
    }

    pub fn background(self) -> tauri::window::Color {
        match self {
            Self::Light => tauri::window::Color(247, 248, 251, 255),
            Self::Dark => tauri::window::Color(24, 24, 31, 255),
        }
    }
}

pub struct ThemePreference {
    path: PathBuf,
    current: Mutex<DesktopTheme>,
}

impl ThemePreference {
    pub fn new(path: PathBuf) -> Self {
        let current = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn current(&self) -> DesktopTheme {
        *self.current.lock().unwrap()
    }

    pub fn remember(&self, theme: DesktopTheme) -> Result<(), String> {
        let mut current = self.current.lock().unwrap();
        if *current == theme {
            return Ok(());
        }
        // A failed disk write must not revert the current window or the next
        // connection-recovery page to an older appearance.
        *current = theme;
        atomic_json_write(&self.path, &theme)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Profile(PathBuf);

    impl Profile {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "keepwork-desktop-theme-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn theme_path(&self) -> PathBuf {
            self.0.join("desktop-theme.json")
        }
    }

    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_and_invalid_preferences_default_to_light_without_rewriting_user_data() {
        let profile = Profile::new();
        let path = profile.theme_path();
        assert_eq!(
            ThemePreference::new(path.clone()).current(),
            DesktopTheme::Light
        );
        assert!(
            !path.exists(),
            "reading a missing preference must not create a file"
        );
        for bytes in [
            b"".as_slice(),
            b"not-json".as_slice(),
            br#""unknown""#.as_slice(),
            br#"{"theme":"dark"}"#.as_slice(),
            b"null".as_slice(),
            b"\xff\xfe".as_slice(),
        ] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                ThemePreference::new(path.clone()).current(),
                DesktopTheme::Light
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                bytes,
                "fallback reads preserve the original file"
            );
        }
    }

    #[test]
    fn saved_light_and_dark_themes_round_trip_independently_of_system_preferences() {
        let profile = Profile::new();
        let path = profile.theme_path();
        for (encoded, theme) in [
            (r#""light""#, DesktopTheme::Light),
            (r#""dark""#, DesktopTheme::Dark),
        ] {
            fs::write(&path, encoded).unwrap();
            assert_eq!(ThemePreference::new(path.clone()).current(), theme);
            assert_eq!(serde_json::to_string(&theme).unwrap(), encoded);
        }
    }

    #[test]
    fn actual_chat_theme_changes_are_available_to_recovery_and_the_next_launch() {
        let profile = Profile::new();
        let path = profile.theme_path();
        let preference = ThemePreference::new(path.clone());
        assert_eq!(preference.current(), DesktopTheme::Light);
        for theme in [DesktopTheme::Dark, DesktopTheme::Light] {
            preference.remember(theme).unwrap();
            assert_eq!(
                preference.current(),
                theme,
                "same-process recovery uses the latest theme"
            );
            assert_eq!(
                ThemePreference::new(path.clone()).current(),
                theme,
                "a new launch uses the saved theme"
            );
        }
    }

    #[test]
    fn theme_updates_preserve_existing_profile_settings_and_other_profiles() {
        let first = Profile::new();
        let other = Profile::new();
        let settings_path = first.0.join("settings.json");
        let settings = br#"{"petVisible":false,"openAtLogin":true,"futureField":{"keep":1}}"#;
        fs::write(&settings_path, settings).unwrap();
        ThemePreference::new(first.theme_path())
            .remember(DesktopTheme::Dark)
            .unwrap();
        assert_eq!(fs::read(&settings_path).unwrap(), settings);
        assert_eq!(
            ThemePreference::new(first.theme_path()).current(),
            DesktopTheme::Dark
        );
        assert_eq!(
            ThemePreference::new(other.theme_path()).current(),
            DesktopTheme::Light
        );
        assert!(!other.theme_path().exists());
    }

    #[test]
    fn a_failed_write_keeps_the_current_theme_for_same_process_recovery() {
        let profile = Profile::new();
        let blocked_parent = profile.0.join("not-a-directory");
        fs::write(&blocked_parent, b"existing-file").unwrap();
        let preference = ThemePreference::new(blocked_parent.join("desktop-theme.json"));
        assert!(preference.remember(DesktopTheme::Dark).is_err());
        assert_eq!(preference.current(), DesktopTheme::Dark);
        assert_eq!(fs::read(&blocked_parent).unwrap(), b"existing-file");
    }

    #[test]
    fn native_appearance_and_opaque_backdrop_use_the_same_resolved_palette() {
        for (dark, theme, native, rgba) in [
            (
                false,
                DesktopTheme::Light,
                tauri::Theme::Light,
                (247, 248, 251, 255),
            ),
            (
                true,
                DesktopTheme::Dark,
                tauri::Theme::Dark,
                (24, 24, 31, 255),
            ),
        ] {
            assert_eq!(DesktopTheme::from_dark(dark), theme);
            assert_eq!(theme.native(), native);
            let tauri::window::Color(r, g, b, a) = theme.background();
            assert_eq!((r, g, b, a), rgba);
        }
    }
}
