use crate::files::atomic_json_write;
use crate::security::trusted_page;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use url::Url;

pub const ALLOWED_MEDIA_PERMISSIONS: &[&str] = &[
    "audio",
    "video",
    "microphone",
    "camera",
    "clipboard-sanitized-write",
    "clipboard-write",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoredMediaGrants {
    #[serde(default)]
    pub grants: HashMap<String, Vec<String>>,
}

pub fn normalize_permission_kind(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "audio" | "microphone" => Some("audio"),
        "video" | "camera" => Some("video"),
        "clipboard-sanitized-write" | "clipboard-write" => Some("clipboard-sanitized-write"),
        _ => None,
    }
}

pub fn page_scope_key(raw_url: &str, dev_url: Option<&str>) -> Option<String> {
    if !trusted_page(raw_url, dev_url) {
        return None;
    }
    let parsed = Url::parse(raw_url).ok()?;
    let port_part = parsed
        .port()
        .map(|p| format!(":{p}"))
        .unwrap_or_default();
    Some(format!(
        "{}://{}{}{}",
        parsed.scheme(),
        parsed.host_str()?,
        port_part,
        parsed.path()
    ))
}

pub struct MediaGrants {
    store_path: PathBuf,
    allowed: Mutex<HashMap<String, HashSet<String>>>,
}

impl MediaGrants {
    pub fn new(store_path: PathBuf) -> Self {
        let allowed = Self::load_from_disk(&store_path);
        Self {
            store_path,
            allowed: Mutex::new(allowed),
        }
    }

    fn load_from_disk(path: &Path) -> HashMap<String, HashSet<String>> {
        let Ok(raw) = fs::read_to_string(path) else {
            return HashMap::new();
        };
        let Ok(parsed) = serde_json::from_str::<StoredMediaGrants>(&raw) else {
            return HashMap::new();
        };
        let mut out = HashMap::new();
        for (scope, list) in parsed.grants {
            let mut set = HashSet::new();
            for item in list {
                if let Some(norm) = normalize_permission_kind(&item) {
                    set.insert(norm.to_string());
                }
            }
            if !set.is_empty() {
                out.insert(scope, set);
            }
        }
        out
    }

    fn save_locked(&self, map: &HashMap<String, HashSet<String>>) -> Result<(), String> {
        let mut grants = HashMap::new();
        for (scope, set) in map {
            let mut list: Vec<String> = set.iter().cloned().collect();
            list.sort();
            grants.insert(scope.clone(), list);
        }
        atomic_json_write(&self.store_path, &StoredMediaGrants { grants })
    }

    pub fn is_granted(&self, raw_url: &str, dev_url: Option<&str>, kind: &str) -> bool {
        let Some(scope) = page_scope_key(raw_url, dev_url) else {
            return false;
        };
        let Some(norm_kind) = normalize_permission_kind(kind) else {
            return false;
        };
        self.allowed
            .lock()
            .ok()
            .and_then(|map| map.get(&scope).map(|set| set.contains(norm_kind)))
            .unwrap_or(false)
    }

    pub fn request_with_prompt<F, R>(
        &self,
        is_main_frame: bool,
        raw_url: &str,
        dev_url: Option<&str>,
        kinds: &[&str],
        mut prompt_fn: F,
        mut restore_focus_fn: R,
    ) -> bool
    where
        F: FnMut(&str, &[&str]) -> bool,
        R: FnMut(),
    {
        if !is_main_frame {
            return false;
        }
        let Some(scope) = page_scope_key(raw_url, dev_url) else {
            return false;
        };
        let mut normalized = Vec::new();
        for k in kinds {
            let Some(nk) = normalize_permission_kind(k) else {
                // Unknown or clipboard-read permission is always denied
                return false;
            };
            if !normalized.contains(&nk) {
                normalized.push(nk);
            }
        }
        if normalized.is_empty() {
            return false;
        }

        let missing: Vec<&str> = {
            let Ok(guard) = self.allowed.lock() else {
                return false;
            };
            let existing = guard.get(&scope);
            normalized
                .iter()
                .copied()
                .filter(|k| !existing.map(|s| s.contains(*k)).unwrap_or(false))
                .collect()
        };

        if missing.is_empty() {
            return true;
        }

        let approved = prompt_fn(&scope, &missing);
        if !approved {
            // Denials are not persisted so user can retry on next explicit action
            return false;
        }

        if let Ok(mut guard) = self.allowed.lock() {
            let entry = guard.entry(scope).or_default();
            for k in &missing {
                entry.insert((*k).to_string());
            }
            let _ = self.save_locked(&guard);
        }

        if missing.contains(&"clipboard-sanitized-write") {
            restore_focus_fn();
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn persists_approved_permissions_per_page_scope_and_never_persists_denials() {
        let root = std::env::temp_dir().join(format!("aichat-rust-perms-{}", Uuid::new_v4()));
        let store = root.join("media-grants.json");
        let grants = MediaGrants::new(store.clone());

        let mut prompts = 0usize;
        let mut focused = 0usize;

        // Deny first: not persisted
        let denied = grants.request_with_prompt(
            true,
            "https://keepwork.com/chat",
            None,
            &["audio"],
            |_scope, _missing| {
                prompts += 1;
                false
            },
            || focused += 1,
        );
        assert!(!denied);
        assert_eq!(prompts, 1);
        assert!(!grants.is_granted("https://keepwork.com/chat", None, "audio"));

        // Approve next: persisted & focus restored on clipboard write
        let approved = grants.request_with_prompt(
            true,
            "https://keepwork.com/chat?tab=1",
            None,
            &["audio", "clipboard-sanitized-write"],
            |_scope, _missing| {
                prompts += 1;
                true
            },
            || focused += 1,
        );
        assert!(approved);
        assert_eq!(prompts, 2);
        assert_eq!(focused, 1);

        // Reloaded instance remembers grant without prompting again
        let reloaded = MediaGrants::new(store);
        let cached = reloaded.request_with_prompt(
            true,
            "https://keepwork.com/chat",
            None,
            &["microphone", "clipboard-write"],
            |_scope, _missing| {
                prompts += 1;
                false
            },
            || {},
        );
        assert!(cached);
        assert_eq!(prompts, 2);

        // Subframe or clipboard-read is always rejected without prompting
        assert!(!reloaded.request_with_prompt(
            false,
            "https://keepwork.com/chat",
            None,
            &["audio"],
            |_, _| {
                prompts += 1;
                true
            },
            || {},
        ));
        assert!(!reloaded.request_with_prompt(
            true,
            "https://keepwork.com/chat",
            None,
            &["clipboard-read"],
            |_, _| {
                prompts += 1;
                true
            },
            || {},
        ));
        assert_eq!(prompts, 2);

        let _ = fs::remove_dir_all(&root);
    }
}
