//! Local pet settings stay available even when the retained chat is offline.
use crate::pet::{PetPreferences, ALLOWED_SCALES};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, WebviewWindow};

pub const PREFIX: &str = "pet-menu:";
pub const APPEARANCE_URL: &str =
    "https://keepwork.com/api/raw/official/apps/MagicHaqi/release/MagicHaqi_v1.html";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    Scale(f64),
    Appearance(&'static str),
    ChooseAppearance,
    Open,
    Hide,
    RequestExit,
}

/// IDs are fixed native choices, never arbitrary URLs, commands or float input.
pub fn action(id: &str) -> Option<Action> {
    match id.strip_prefix(PREFIX)? {
        "scale:0" => Some(Action::Scale(ALLOWED_SCALES[0])),
        "scale:1" => Some(Action::Scale(ALLOWED_SCALES[1])),
        "scale:2" => Some(Action::Scale(ALLOWED_SCALES[2])),
        "scale:3" => Some(Action::Scale(ALLOWED_SCALES[3])),
        "scale:4" => Some(Action::Scale(ALLOWED_SCALES[4])),
        "scale:5" => Some(Action::Scale(ALLOWED_SCALES[5])),
        "appearance:follow" => Some(Action::Appearance("follow")),
        "appearance:dragon" => Some(Action::Appearance("dragon")),
        "appearance:choose" => Some(Action::ChooseAppearance),
        "open" => Some(Action::Open),
        "hide" => Some(Action::Hide),
        "exit-request" => Some(Action::RequestExit),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Title(String),
    Action {
        id: String,
        label: String,
        checked: Option<bool>,
    },
    Submenu {
        label: &'static str,
        entries: Vec<Entry>,
    },
    Separator,
}

fn item(id: &str, label: &str, checked: Option<bool>) -> Entry {
    Entry::Action {
        id: format!("{PREFIX}{id}"),
        label: label.to_string(),
        checked,
    }
}

pub fn entries(preferences: &PetPreferences, snapshot: &Value) -> Vec<Entry> {
    let name = if preferences.appearance == "dragon" {
        "抱抱龙"
    } else {
        snapshot["pet"]["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("桌面宠物")
    };
    vec![
        Entry::Title(name.chars().take(160).collect()),
        Entry::Submenu {
            label: "大小",
            entries: ALLOWED_SCALES
                .iter()
                .enumerate()
                .map(|(index, scale)| {
                    item(
                        &format!("scale:{index}"),
                        &format!("{scale}×{}", if *scale == 1.0 { "（默认）" } else { "" }),
                        Some(preferences.scale == *scale),
                    )
                })
                .collect(),
        },
        Entry::Submenu {
            label: "外观",
            entries: vec![
                item(
                    "appearance:follow",
                    "跟随 AIChat 宠物",
                    Some(preferences.appearance == "follow"),
                ),
                item(
                    "appearance:dragon",
                    "抱抱龙",
                    Some(preferences.appearance == "dragon"),
                ),
                Entry::Separator,
                item("appearance:choose", "在哈奇星球更换宠物…", None),
            ],
        },
        Entry::Separator,
        item("open", "打开桌面", None),
        item("hide", "隐藏桌面宠物", None),
        Entry::Separator,
        item("exit-request", "完全退出…", None),
    ]
}

fn native_item(app: &AppHandle, entry: &Entry) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(match entry {
        Entry::Title(label) => {
            MenuItemKind::MenuItem(MenuItem::new(app, label, false, None::<&str>)?)
        }
        Entry::Action {
            id,
            label,
            checked: Some(checked),
        } => MenuItemKind::Check(CheckMenuItem::with_id(
            app,
            id,
            label,
            true,
            *checked,
            None::<&str>,
        )?),
        Entry::Action {
            id,
            label,
            checked: None,
        } => MenuItemKind::MenuItem(MenuItem::with_id(app, id, label, true, None::<&str>)?),
        Entry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        Entry::Submenu { label, entries } => {
            let submenu = Submenu::new(app, label, true)?;
            for entry in entries {
                submenu.append(&native_item(app, entry)?)?;
            }
            MenuItemKind::Submenu(submenu)
        }
    })
}

pub fn build(
    app: &AppHandle,
    preferences: &PetPreferences,
    snapshot: &Value,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for entry in entries(preferences, snapshot) {
        menu.append(&native_item(app, &entry)?)?;
    }
    Ok(menu)
}

/// Keep the popup alive on GTK, where showing is asynchronous. Native GTK grabs
/// its own input; macOS/Windows keep `showing` true throughout menu tracking.
#[derive(Default)]
pub struct Session {
    showing: AtomicBool,
    retained: Mutex<Option<Menu<tauri::Wry>>>,
}

struct Showing<'a>(&'a AtomicBool);
impl Drop for Showing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Session {
    pub fn is_showing(&self) -> bool {
        self.showing.load(Ordering::Acquire)
    }

    pub fn popup(&self, window: &WebviewWindow, menu: Menu<tauri::Wry>) -> Result<(), String> {
        if self
            .showing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        let _showing = Showing(&self.showing);
        *self.retained.lock().map_err(|_| "宠物菜单不可用，请重试")? = Some(menu.clone());
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        window.popup_menu(&menu).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn actions(entries: &[Entry]) -> Vec<(&str, Option<bool>)> {
        let mut all = Vec::new();
        for entry in entries {
            match entry {
                Entry::Action { id, checked, .. } => all.push((id.as_str(), *checked)),
                Entry::Submenu { entries, .. } => all.extend(actions(entries)),
                _ => {}
            }
        }
        all
    }

    #[test]
    fn native_menu_has_fixed_local_choices_and_only_current_preferences_checked() {
        for scale in ALLOWED_SCALES {
            for appearance in ["follow", "dragon"] {
                let preferences = PetPreferences {
                    scale: *scale,
                    appearance: appearance.to_string(),
                    ..Default::default()
                };
                let menu = entries(&preferences, &json!({"ready":false,"pet":{"name":"小绿"}}));
                assert_eq!(
                    menu[0],
                    Entry::Title(
                        if appearance == "dragon" {
                            "抱抱龙"
                        } else {
                            "小绿"
                        }
                        .to_string()
                    )
                );
                let choices = actions(&menu);
                assert_eq!(choices.len(), 12);
                let checked: Vec<_> = choices
                    .iter()
                    .filter(|(_, checked)| *checked == Some(true))
                    .collect();
                assert_eq!(checked.len(), 2);
                assert!(checked
                    .iter()
                    .any(|(id, _)| action(id) == Some(Action::Scale(*scale))));
                assert!(checked
                    .iter()
                    .any(|(id, _)| action(id) == Some(Action::Appearance(appearance))));
                assert!(choices.iter().all(|(id, _)| action(id).is_some()));
                assert_eq!(action(choices.last().unwrap().0), Some(Action::RequestExit));
            }
        }
    }

    #[test]
    fn invalid_or_foreign_menu_ids_never_authorize_an_action() {
        for id in [
            "",
            "open",
            "tray:quit",
            "pet-menu:quit",
            "pet-menu:exit-confirm",
            "pet-menu:scale:NaN",
            "pet-menu:scale:6",
            "pet-menu:scale:-1",
            "pet-menu:scale:1.5",
            "pet-menu:appearance:current",
            "pet-menu:appearance:https://evil.invalid",
        ] {
            assert_eq!(action(id), None, "{id}");
        }
        assert!(APPEARANCE_URL.starts_with("https://keepwork.com/"));
    }

    #[test]
    fn offline_title_falls_back_and_menu_tracking_always_releases_on_error() {
        assert_eq!(
            entries(&PetPreferences::default(), &Value::Null)[0],
            Entry::Title("桌面宠物".to_string())
        );
        let session = Session::default();
        assert!(!session.is_showing());
        session.showing.store(true, Ordering::Release);
        {
            let _guard = Showing(&session.showing);
            assert!(session.is_showing());
        }
        assert!(!session.is_showing());
    }
}
