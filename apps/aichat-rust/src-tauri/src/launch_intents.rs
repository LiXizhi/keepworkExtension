//! Additive Bridge v1 launch intents. URLs carry an action only; document-bound
//! tickets never contain filesystem paths, login data or executable arguments.

use crate::files::atomic_json_write;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchUrl {
    Open,
    Onboarding,
}

pub fn parse_launch_url(value: &str) -> Option<LaunchUrl> {
    match value {
        "keepwork-secondbrain://open" | "keepwork-secondbrain://open/" => Some(LaunchUrl::Open),
        "keepwork-secondbrain://onboarding" | "keepwork-secondbrain://onboarding/" => {
            Some(LaunchUrl::Onboarding)
        }
        _ => None,
    }
}

pub fn launch_url_from_args(args: impl IntoIterator<Item = String>) -> Option<LaunchUrl> {
    let mut selected = None;
    for action in args.into_iter().filter_map(|arg| parse_launch_url(&arg)) {
        if selected != Some(LaunchUrl::Onboarding) {
            selected = Some(action);
        }
    }
    selected
}

pub fn protocol_launch_action(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<LaunchUrl> {
    let mut args = args.into_iter();
    let argument = args.next()?;
    if args.next().is_some() {
        return None;
    }
    parse_launch_url(argument.to_str()?)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LaunchIntent {
    pub id: String,
    pub kind: String,
}

struct Pending {
    ticket: LaunchIntent,
    origin: Option<String>,
}

pub struct LaunchIntents {
    capability: String,
    settings_path: PathBuf,
    offered: bool,
    pending: Option<Pending>,
    document: Option<(String, String)>,
    revoked_documents: VecDeque<String>,
}

impl LaunchIntents {
    pub fn new(settings_path: PathBuf) -> Self {
        let offered = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|settings| settings["onboardingOffered"] == true);
        Self {
            capability: Uuid::new_v4().to_string(),
            settings_path,
            offered,
            pending: None,
            document: None,
            revoked_documents: VecDeque::new(),
        }
    }

    pub fn capability(&self) -> &str {
        &self.capability
    }

    pub fn authenticate(&self, capability: &str) -> Result<(), String> {
        if self.capability == capability {
            Ok(())
        } else {
            Err("Unauthorized launch document".to_string())
        }
    }

    fn offer(&mut self, kind: &str) {
        let origin = self.document.as_ref().map(|(_, origin)| origin.clone());
        if self.pending.as_ref().is_some_and(|pending| {
            (pending.ticket.kind == kind && pending.origin == origin)
                || (kind == "first-launch" && pending.ticket.kind == "onboarding")
        }) {
            return;
        }
        self.pending = Some(Pending {
            ticket: LaunchIntent {
                id: Uuid::new_v4().to_string(),
                kind: kind.to_string(),
            },
            origin,
        });
    }

    pub fn offer_onboarding(&mut self) {
        self.offer("onboarding");
    }

    pub fn is_ready(&self) -> bool {
        self.document.is_some()
    }

    pub fn invalidate_document(&mut self) {
        if let Some((document, _)) = self.document.take() {
            self.revoked_documents.push_back(document);
            while self.revoked_documents.len() > 32 {
                self.revoked_documents.pop_front();
            }
        }
        if let Some(pending) = &mut self.pending {
            pending.ticket.id = Uuid::new_v4().to_string();
        }
    }

    /// Reading marks only this trusted main document ready. A pending ticket
    /// read by one origin never moves to another local-source/published origin.
    pub fn read(&mut self, document: &str, origin: &str) -> Result<Option<LaunchIntent>, String> {
        if Uuid::parse_str(document).is_err() || origin.is_empty() {
            return Err("Invalid launch document".to_string());
        }
        if self.revoked_documents.iter().any(|old| old == document) {
            return Err("Launch document is no longer active".to_string());
        }
        if self.document.as_ref().map(|(id, _)| id.as_str()) != Some(document) {
            self.invalidate_document();
            self.document = Some((document.to_string(), origin.to_string()));
        } else if self.document.as_ref().map(|(_, value)| value.as_str()) != Some(origin) {
            return Err("Launch document origin changed".to_string());
        }
        if self.pending.is_none() && !self.offered {
            self.offer("first-launch");
        }
        let Some(pending) = &mut self.pending else {
            return Ok(None);
        };
        let scope = pending.origin.get_or_insert_with(|| origin.to_string());
        Ok((scope == origin).then(|| pending.ticket.clone()))
    }

    /// Persist the offered marker before consuming. A failed write or a stale
    /// document/ticket leaves the intent available for an explicit retry.
    pub fn acknowledge(&mut self, document: &str, origin: &str, id: &str) -> Result<bool, String> {
        if self
            .document
            .as_ref()
            .map(|(doc, scope)| (doc.as_str(), scope.as_str()))
            != Some((document, origin))
            || !self.pending.as_ref().is_some_and(|pending| {
                pending.ticket.id == id && pending.origin.as_deref() == Some(origin)
            })
        {
            return Ok(false);
        }
        let mut settings = match std::fs::read(&self.settings_path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| "Cannot read desktop settings")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(_) => return Err("Cannot read desktop settings".to_string()),
        };
        let object = settings.as_object_mut().ok_or("Invalid desktop settings")?;
        object.insert("onboardingOffered".to_string(), serde_json::json!(true));
        atomic_json_write(&self.settings_path, &settings)?;
        self.offered = true;
        self.pending = None;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (PathBuf, LaunchIntents) {
        let root = std::env::temp_dir().join(format!("keepwork-launch-{}", Uuid::new_v4()));
        let state = LaunchIntents::new(root.join("settings.json"));
        (root, state)
    }

    #[test]
    fn only_exact_action_urls_are_accepted_without_decoding_or_shell_interpretation() {
        assert_eq!(
            parse_launch_url("keepwork-secondbrain://open"),
            Some(LaunchUrl::Open)
        );
        assert_eq!(
            parse_launch_url("keepwork-secondbrain://onboarding/"),
            Some(LaunchUrl::Onboarding)
        );
        for value in [
            "keepwork-secondbrain://open?token=x",
            "keepwork-secondbrain://open#x",
            "keepwork-secondbrain://user@open",
            "keepwork-secondbrain://open:80",
            "keepwork-secondbrain://open/path",
            "keepwork-secondbrain://%6fpen",
            "keepwork-secondbrain://open//",
            "keepwork-secondbrain://OPEN",
            "KEEPWORK-SECONDBRAIN://open",
            " keepwork-secondbrain://open",
            "keepwork-secondbrain://open\n",
            "keepwork-secondbrain://open && echo x",
            "keepwork-secondbrain://open/中文",
            "https://keepwork.com/onboarding",
        ] {
            assert_eq!(parse_launch_url(value), None, "{value}");
        }
        assert_eq!(
            launch_url_from_args([
                "Keepwork 安装目录/Keepwork.exe".to_string(),
                "keepwork-secondbrain://onboarding".to_string(),
                "keepwork-secondbrain://open".to_string(),
            ]),
            Some(LaunchUrl::Onboarding)
        );
        assert_eq!(
            protocol_launch_action(["keepwork-secondbrain://open".into()]),
            Some(LaunchUrl::Open)
        );
        assert_eq!(
            protocol_launch_action([
                "keepwork-secondbrain://open".into(),
                "--user-data-dir=C:\\用户\\other".into(),
            ]),
            None
        );
        assert_eq!(
            protocol_launch_action(["keepwork-secondbrain://open\" --replace".into()]),
            None
        );
    }

    #[test]
    fn first_launch_persists_only_after_matching_ack_and_explicit_intents_remain_available() {
        let (root, mut state) = state();
        let document = Uuid::new_v4().to_string();
        let origin = "https://keepwork.com";
        assert!(!state.is_ready());
        assert!(state.authenticate("renderer-invented-token").is_err());
        assert!(state.authenticate(state.capability()).is_ok());
        let first = state.read(&document, origin).unwrap().unwrap();
        assert_eq!(first.kind, "first-launch");
        assert_eq!(state.read(&document, origin).unwrap(), Some(first.clone()));
        assert!(!state.acknowledge(&document, origin, "wrong").unwrap());
        state.offer_onboarding();
        let explicit = state.read(&document, origin).unwrap().unwrap();
        assert_eq!(explicit.kind, "onboarding");
        assert_ne!(first.id, explicit.id);
        state.offer_onboarding();
        assert_eq!(
            state.read(&document, origin).unwrap(),
            Some(explicit.clone())
        );
        assert!(!state.acknowledge(&document, origin, &first.id).unwrap());
        assert!(state.acknowledge(&document, origin, &explicit.id).unwrap());
        assert_eq!(state.read(&document, origin).unwrap(), None);
        let mut reopened = LaunchIntents::new(root.join("settings.json"));
        assert_eq!(
            reopened.read(&Uuid::new_v4().to_string(), origin).unwrap(),
            None
        );
        reopened.offer_onboarding();
        assert_eq!(
            reopened
                .read(&Uuid::new_v4().to_string(), origin)
                .unwrap()
                .unwrap()
                .kind,
            "onboarding"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn navigation_rotates_tickets_rejects_old_documents_and_preserves_origin_scope() {
        let (root, mut state) = state();
        let old_doc = Uuid::new_v4().to_string();
        let new_doc = Uuid::new_v4().to_string();
        let first = state
            .read(&old_doc, "http://127.0.0.1:3001")
            .unwrap()
            .unwrap();
        state.invalidate_document();
        assert!(!state
            .acknowledge(&old_doc, "http://127.0.0.1:3001", &first.id)
            .unwrap());
        assert!(state.read(&old_doc, "http://127.0.0.1:3001").is_err());
        assert_eq!(state.read(&new_doc, "https://keepwork.com").unwrap(), None);
        let latest = state
            .read(&Uuid::new_v4().to_string(), "http://127.0.0.1:3001")
            .unwrap()
            .unwrap();
        assert_ne!(latest.id, first.id);
        assert_eq!(latest.kind, "first-launch");
        state.offer_onboarding();
        let explicit = state
            .read(&Uuid::new_v4().to_string(), "https://keepwork.com")
            .unwrap();
        assert_eq!(explicit, None, "old-origin intent is not moved implicitly");
        state.offer_onboarding();
        assert_eq!(
            state
                .read(&Uuid::new_v4().to_string(), "https://keepwork.com")
                .unwrap()
                .unwrap()
                .kind,
            "onboarding",
            "new explicit action can target the current origin"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_persistence_does_not_acknowledge_or_drop_the_intent() {
        let (root, mut state) = state();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir(root.join("settings.json")).unwrap();
        let document = Uuid::new_v4().to_string();
        let ticket = state
            .read(&document, "https://keepwork.com")
            .unwrap()
            .unwrap();
        assert!(state
            .acknowledge(&document, "https://keepwork.com", &ticket.id)
            .is_err());
        assert_eq!(
            state.read(&document, "https://keepwork.com").unwrap(),
            Some(ticket)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_offered_marker_and_unrelated_settings_survive_acknowledgment() {
        let (root, _) = state();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        std::fs::write(
            &path,
            r#"{"onboardingOffered":true,"openAtLogin":false,"future":{"keep":1}}"#,
        )
        .unwrap();
        let mut state = LaunchIntents::new(path.clone());
        let document = Uuid::new_v4().to_string();
        assert_eq!(state.read(&document, "https://keepwork.com").unwrap(), None);
        state.offer_onboarding();
        let ticket = state
            .read(&document, "https://keepwork.com")
            .unwrap()
            .unwrap();
        assert!(state
            .acknowledge(&document, "https://keepwork.com", &ticket.id)
            .unwrap());
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["future"]["keep"], 1);
        assert_eq!(saved["openAtLogin"], false);
        std::fs::remove_dir_all(root).unwrap();
    }
}
