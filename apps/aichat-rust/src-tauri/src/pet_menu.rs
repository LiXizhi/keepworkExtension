//! Local pet settings stay available even when the retained chat is offline.
use crate::pet::{PetAppearanceMode, PetPreferences, ALLOWED_SCALES};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, WebviewWindow};

pub const PREFIX: &str = "pet-menu:";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    Scale(f64),
    Appearance(&'static str),
    AppearanceMode(PetAppearanceMode),
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
        "appearance-mode:model" | "appearance:follow-model" => Some(Action::AppearanceMode(PetAppearanceMode::Model)),
        "appearance-mode:manual" => Some(Action::AppearanceMode(PetAppearanceMode::Manual)),
        "appearance:follow" => Some(Action::Appearance("follow")),
        "appearance:dragon" => Some(Action::Appearance("dragon")),
        "open" => Some(Action::Open),
        "hide" => Some(Action::Hide),
        "exit-request" => Some(Action::RequestExit),
        candidate => candidate.strip_prefix("appearance:")
            .and_then(crate::pet_appearance::experiment)
            .map(|(id, _)| Action::Appearance(id)),
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
    let appearance = snapshot["effectiveAppearance"].as_str().unwrap_or(&preferences.appearance);
    let name = if appearance == "dragon" {
        "抱抱龙"
    } else if let Some((_, name)) = crate::pet_appearance::experiment(appearance) {
        name
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
            label: "外观模式",
            entries: vec![
                item("appearance-mode:model", "跟随当前模型（默认）", Some(preferences.appearance_mode == PetAppearanceMode::Model)),
                item("appearance-mode:manual", "始终使用自选宠物", Some(preferences.appearance_mode == PetAppearanceMode::Manual)),
            ],
        },
        Entry::Submenu {
            label: "自选宠物",
            entries: {
                let mut choices = vec![item(
                    "appearance:follow-model", "跟随模型", None,
                )];
                let experiments = crate::pet_appearance::EXPERIMENTS;
                choices.extend(experiments.iter()
                    .filter(|(id, _)| *id == "ainiang:deepseek")
                    .chain(experiments.iter().filter(|(id, _)| *id != "ainiang:deepseek"))
                    .map(|(id, label)| {
                        item(&format!("appearance:{id}"), label, Some(preferences.appearance == *id))
                    }));
                choices.push(item("appearance:dragon", "抱抱龙", Some(preferences.appearance == "dragon")));
                choices
            },
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

// Record the override only after the native operation succeeds. Cached
// platforms then restore pass-through even if it was already cached before
// opening the menu. The injected operation also exposes this policy to tests.
fn activate_menu_pointer(
    pet: &crate::pet::PetController,
    activate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    activate()?;
    pet.record_pointer_interactive(true);
    Ok(())
}

impl Session {
    pub fn is_showing(&self) -> bool {
        self.showing.load(Ordering::Acquire)
    }

    pub fn popup(
        &self,
        window: &WebviewWindow,
        pet: &crate::pet::PetController,
        menu: Menu<tauri::Wry>,
    ) -> Result<(), String> {
        if self
            .showing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        let _showing = Showing(&self.showing);
        *self.retained.lock().map_err(|_| "宠物菜单不可用，请重试")? = Some(menu.clone());
        activate_menu_pointer(pet, || crate::pet_pointer::set_interactive(window, true))?;
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
                assert_eq!(choices.len(), 22);
                let checked: Vec<_> = choices
                    .iter()
                    .filter(|(_, checked)| *checked == Some(true))
                    .collect();
                assert_eq!(checked.len(), if appearance == "dragon" { 3 } else { 2 });
                assert!(checked
                    .iter()
                    .any(|(id, _)| action(id) == Some(Action::Scale(*scale))));
                if appearance == "dragon" {
                    assert!(checked.iter().any(|(id, _)| action(id) == Some(Action::Appearance(appearance))));
                }
                assert_eq!(action("pet-menu:appearance:follow"), Some(Action::Appearance("follow")));
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
            "pet-menu:appearance:choose",
            "pet-menu:appearance-mode:unknown",
            "pet-menu:appearance:https://evil.invalid",
            "pet-menu:appearance:ainiang:unknown",
            "pet-menu:appearance:ainiang:claude/../gpt",
        ] {
            assert_eq!(action(id), None, "{id}");
        }
    }

    #[test]
    fn experimental_choice_is_local_and_has_exactly_one_selected_appearance() {
        for (id, label) in crate::pet_appearance::EXPERIMENTS {
            let prefs = PetPreferences { appearance: id.to_string(), ..Default::default() };
            let menu = entries(&prefs, &json!({"target":"persona","title":"Unchanged persona","pet":{"name":"Web pet"}}));
            assert_eq!(menu[0], Entry::Title(label.to_string()));
            let choices = menu.iter().find_map(|entry| match entry {
                Entry::Submenu { label, entries } if label.starts_with("自选宠物") => Some(entries),
                _ => None,
            }).unwrap();
            assert!(choices.iter().all(|entry| matches!(entry, Entry::Action { .. })));
            let labels: Vec<_> = choices.iter().filter_map(|entry| match entry {
                Entry::Action { label, .. } => Some(label.as_str()), _ => None,
            }).collect();
            assert_eq!(labels, ["跟随模型", "大肥鱼 · DeepSeek", "圣女果 · Claude", "小龙女 · GPT",
                "哈基米 · Gemini", "大小姐 · Grok", "千金金 · Qwen", "小狐狸 · Kimi",
                "嘎拉吗 · GLM", "小田螺 · MiniMax", "抱抱龙"]);
            assert_eq!(action("pet-menu:appearance:follow-model"), Some(Action::AppearanceMode(PetAppearanceMode::Model)));
            assert!(choices.iter().any(|entry| matches!(entry,
                Entry::Action { id: choice, checked: Some(true), .. }
                    if choice == &format!("{PREFIX}appearance:{id}"))));
            let checked: Vec<_> = actions(&menu).into_iter().filter(|(key, checked)| matches!(action(key), Some(Action::Appearance(_))) && *checked == Some(true)).collect();
            assert_eq!(checked.len(), 1);
            assert_eq!(action(checked[0].0), Some(Action::Appearance(id)));
        }
    }

    #[test]
    fn mode_checks_are_independent_of_the_user_fallback_and_title_uses_effective_art() {
        let prefs = PetPreferences { appearance: "ainiang:kimi".into(), ..Default::default() };
        let menu = entries(&prefs, &json!({"effectiveAppearance":"ainiang:claude"}));
        assert_eq!(menu[0], Entry::Title("圣女果 · Claude".into()));
        let choices = actions(&menu);
        assert!(choices.contains(&("pet-menu:appearance-mode:model", Some(true))));
        assert!(choices.contains(&("pet-menu:appearance-mode:manual", Some(false))));
        assert!(choices.contains(&("pet-menu:appearance:ainiang:kimi", Some(true))));
        let manual = PetPreferences { appearance_mode: PetAppearanceMode::Manual, ..prefs };
        let menu = entries(&manual, &json!({"effectiveAppearance":"ainiang:kimi"}));
        assert!(actions(&menu).contains(&("pet-menu:appearance-mode:manual", Some(true))));
    }

    #[test]
    fn menu_override_invalidates_cached_pass_through_only_after_native_success() {
        let pet = crate::pet::PetController::new(
            std::env::temp_dir().join("keepwork-pet-menu-pointer-test-missing.json"),
        );
        pet.record_pointer_interactive(false);
        assert!(!pet.pointer_needs_update(false));
        let actual_interactive = std::cell::Cell::new(false);
        activate_menu_pointer(&pet, || {
            actual_interactive.set(true);
            Ok(())
        }).unwrap();
        assert!(actual_interactive.get());
        assert!(pet.pointer_needs_update(false), "dismissal must restore the native override");
        pet.record_pointer_interactive(false);
        assert!(activate_menu_pointer(&pet, || Err("native failure".into())).is_err());
        assert!(!pet.pointer_needs_update(false), "failed native changes must not be acknowledged");
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
