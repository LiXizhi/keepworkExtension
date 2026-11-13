use crate::security::{has_credentials, same_origin_and_path};
use serde::Serialize;
use url::Url;

pub const LOAD_TIMEOUT_SECONDS: u64 = 20;
pub const MAX_AUTO_RETRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Connecting,
    Unavailable,
    Ready,
}

/// Window visibility is a host decision, independent of navigation callbacks.
/// In particular, a late ready receipt must never undo close-to-tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presentation {
    Hidden,
    Startup,
    Main,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub phase: Phase,
    pub entry_origin: String,
    pub local_entry: bool,
    pub auto_retries: u32,
    pub max_auto_retries: u32,
    pub error: String,
}

pub struct PageConnection {
    pub shell_url: Option<Url>,
    pub token: String,
    target: String,
    generation: u64,
    phase: Phase,
    auto_retries: u32,
    error: String,
    foreground: bool,
}

impl Default for PageConnection {
    fn default() -> Self {
        Self {
            shell_url: None,
            token: uuid::Uuid::new_v4().to_string(),
            target: String::new(),
            generation: 0,
            phase: Phase::Idle,
            auto_retries: 0,
            error: String::new(),
            foreground: false,
        }
    }
}

impl PageConnection {
    pub fn set_foreground(&mut self, foreground: bool) {
        self.foreground = foreground;
    }

    pub fn presentation(&self) -> Presentation {
        if !self.foreground {
            Presentation::Hidden
        } else if self.phase == Phase::Ready {
            Presentation::Main
        } else {
            Presentation::Startup
        }
    }

    pub fn is_shell(&self, url: &Url) -> bool {
        self.shell_url.as_ref() == Some(url)
    }

    /// Only explicit navigation/reload and the local recovery page start attempts.
    /// Normal online/offline events in an already opened chat never reach here.
    pub fn begin(&mut self, target: &str, automatic: bool) -> Option<u64> {
        if self.phase == Phase::Connecting && self.target == target {
            return None;
        }
        if automatic {
            if self.phase != Phase::Unavailable
                || self.auto_retries >= MAX_AUTO_RETRIES
                || self.target != target
            {
                return None;
            }
            self.auto_retries += 1;
        } else {
            self.auto_retries = 0;
        }
        self.target = target.to_string();
        self.generation += 1;
        self.phase = Phase::Connecting;
        self.error.clear();
        Some(self.generation)
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn attempt(&self, url: &Url) -> Option<u64> {
        let target = Url::parse(&self.target).ok()?;
        (self.phase == Phase::Connecting
            && same_origin_and_path(&target, url)
            && !has_credentials(url))
        .then_some(self.generation)
    }

    pub fn document_ready(&mut self, generation: u64, url: &Url) -> bool {
        let Ok(target) = Url::parse(&self.target) else {
            return false;
        };
        if self.generation != generation
            || self.phase != Phase::Connecting
            || has_credentials(url)
            || !same_origin_and_path(&target, url)
        {
            return false;
        }
        self.phase = Phase::Ready;
        self.error.clear();
        true
    }

    pub fn fail(&mut self, generation: u64, message: &str) -> bool {
        if self.generation != generation || self.phase != Phase::Connecting {
            return false;
        }
        self.phase = Phase::Unavailable;
        self.error = message.to_string();
        true
    }

    pub fn snapshot(&self, entry: &str) -> ConnectionSnapshot {
        let url = Url::parse(entry).ok();
        ConnectionSnapshot {
            phase: self.phase,
            entry_origin: url
                .as_ref()
                .map(|u| u.origin().ascii_serialization())
                .unwrap_or_default(),
            local_entry: url
                .as_ref()
                .is_some_and(|u| matches!(u.host_str(), Some("127.0.0.1" | "localhost"))),
            auto_retries: self.auto_retries,
            max_auto_retries: MAX_AUTO_RETRIES,
            error: self.error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_wake_during_background_bootstrap_survives_initial_navigation() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat").unwrap();
        state.set_foreground(false);
        assert_eq!(state.presentation(), Presentation::Hidden);
        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Startup);
        let generation = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Startup);
        assert!(state.document_ready(generation, &url));
        assert_eq!(state.presentation(), Presentation::Main);

        let mut closed = PageConnection::default();
        closed.set_foreground(false);
        closed.set_foreground(true);
        closed.set_foreground(false);
        let generation = closed.begin(url.as_str(), false).unwrap();
        assert!(closed.document_ready(generation, &url));
        assert_eq!(closed.presentation(), Presentation::Hidden);
    }

    #[test]
    fn foreground_launch_exposes_only_native_startup_until_the_current_document_is_ready() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat").unwrap();
        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Startup);

        let generation = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Startup);
        assert_eq!(state.attempt(&url), Some(generation));
        assert_eq!(state.presentation(), Presentation::Startup);

        assert!(!state.document_ready(
            generation,
            &Url::parse("https://keepwork.com/other").unwrap()
        ));
        assert_eq!(state.presentation(), Presentation::Startup);
        assert!(state.document_ready(generation, &url));
        assert_eq!(state.presentation(), Presentation::Main);
    }

    #[test]
    fn background_connection_failure_retry_and_readiness_never_open_a_window() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat?session=preserved#draft").unwrap();
        state.set_foreground(false);
        assert_eq!(state.presentation(), Presentation::Hidden);
        let first = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Hidden);
        assert!(state.fail(first, "offline"));
        assert_eq!(state.presentation(), Presentation::Hidden);
        let retried = state.begin(url.as_str(), true).unwrap();
        assert_eq!(state.presentation(), Presentation::Hidden);
        assert!(state.document_ready(retried, &url));
        assert_eq!(state.presentation(), Presentation::Hidden);
        assert_eq!(state.target(), url.as_str());

        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Main);
        assert_eq!(state.snapshot(url.as_str()).auto_retries, 1);
    }

    #[test]
    fn closing_native_startup_prevents_a_late_success_from_reopening_the_application() {
        let mut state = PageConnection::default();
        let url = Url::parse("http://127.0.0.1:3001/AIChat.html").unwrap();
        state.set_foreground(true);
        let generation = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Startup);

        state.set_foreground(false);
        assert_eq!(state.presentation(), Presentation::Hidden);
        assert!(state.document_ready(generation, &url));
        assert_eq!(state.presentation(), Presentation::Hidden);
        assert!(!state.fail(generation, "late timeout"));
        assert_eq!(state.presentation(), Presentation::Hidden);

        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Main);
        state.set_foreground(false);
        assert_eq!(state.presentation(), Presentation::Hidden);
    }

    #[test]
    fn waking_a_connecting_or_failed_instance_keeps_chat_hidden_and_preserves_the_attempt() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat").unwrap();
        state.set_foreground(false);
        let generation = state.begin(url.as_str(), false).unwrap();

        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Startup);
        assert_eq!(state.attempt(&url), Some(generation));
        assert!(state.begin(url.as_str(), false).is_none());

        state.set_foreground(false);
        assert!(state.fail(generation, "offline"));
        assert_eq!(state.presentation(), Presentation::Hidden);
        state.set_foreground(true);
        assert_eq!(state.presentation(), Presentation::Startup);
        assert_eq!(state.snapshot(url.as_str()).phase, Phase::Unavailable);
        assert_eq!(state.snapshot(url.as_str()).error, "offline");
        assert_eq!(state.snapshot(url.as_str()).auto_retries, 0);
    }

    #[test]
    fn manual_retry_keeps_native_startup_visible_and_clears_only_the_previous_error() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat?session=preserved#draft").unwrap();
        state.set_foreground(true);
        let first = state.begin(url.as_str(), false).unwrap();
        assert!(state.fail(first, "offline"));
        assert_eq!(state.presentation(), Presentation::Startup);
        let automatic = state.begin(url.as_str(), true).unwrap();
        assert!(state.fail(automatic, "still offline"));
        assert_eq!(state.snapshot(url.as_str()).auto_retries, 1);

        let manual = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Startup);
        let snapshot = state.snapshot(url.as_str());
        assert_eq!(snapshot.phase, Phase::Connecting);
        assert_eq!(snapshot.error, "");
        assert_eq!(snapshot.auto_retries, 0);
        assert_eq!(state.target(), url.as_str());
        assert!(!state.document_ready(automatic, &url));
        assert_eq!(state.presentation(), Presentation::Startup);
        assert!(state.document_ready(manual, &url));
        assert_eq!(state.presentation(), Presentation::Main);
    }

    #[test]
    fn replacing_a_ready_entry_returns_to_native_startup_and_rejects_old_readiness() {
        let mut state = PageConnection::default();
        let original = Url::parse("https://keepwork.com/chat").unwrap();
        let replacement = Url::parse("http://127.0.0.1:3001/AIChat.html").unwrap();
        state.set_foreground(true);
        let first = state.begin(original.as_str(), false).unwrap();
        assert!(state.document_ready(first, &original));
        assert_eq!(state.presentation(), Presentation::Main);

        let current = state.begin(replacement.as_str(), false).unwrap();
        assert_eq!(state.presentation(), Presentation::Startup);
        assert!(!state.document_ready(first, &original));
        assert!(!state.document_ready(first, &replacement));
        assert!(!state.fail(first, "old timeout"));
        assert_eq!(state.presentation(), Presentation::Startup);
        assert!(state.document_ready(current, &replacement));
        assert_eq!(state.presentation(), Presentation::Main);
    }

    #[test]
    fn late_timeouts_never_replace_a_ready_or_newer_page() {
        let mut state = PageConnection::default();
        let old = state
            .begin("https://keepwork.com/chat?session=original", false)
            .unwrap();
        assert!(state.document_ready(
            old,
            &Url::parse("https://keepwork.com/chat?session=original").unwrap()
        ));
        assert!(!state.fail(old, "late timeout"));
        let current = state
            .begin("http://127.0.0.1:3001/AIChat.html", false)
            .unwrap();
        assert!(!state.fail(old, "old timeout"));
        assert!(!state.document_ready(old, &Url::parse("https://keepwork.com/chat").unwrap()));
        assert!(!state.document_ready(
            old,
            &Url::parse("http://127.0.0.1:3001/AIChat.html").unwrap()
        ));
        assert!(state.fail(current, "timeout"));
    }

    #[test]
    fn automatic_retries_are_bounded_and_only_manual_retry_resets_budget() {
        let mut state = PageConnection::default();
        let target = "https://keepwork.com/chat?token=private#draft";
        let first = state.begin(target, false).unwrap();
        assert!(state.begin(target, false).is_none());
        assert!(state.begin(target, true).is_none());
        state.fail(first, "timeout");
        for _ in 0..MAX_AUTO_RETRIES {
            let generation = state.begin(target, true).unwrap();
            assert_eq!(state.target(), target);
            assert!(state.begin(target, true).is_none());
            state.fail(generation, "timeout");
        }
        assert!(state.begin(target, true).is_none());
        assert_eq!(state.snapshot(target).entry_origin, "https://keepwork.com");
        assert!(state.begin(target, false).is_some());
        assert_eq!(state.snapshot(target).auto_retries, 0);
    }

    #[test]
    fn retrying_the_same_entry_rejects_previous_document_tickets() {
        let mut state = PageConnection::default();
        let url = Url::parse("https://keepwork.com/chat?session=kept#draft").unwrap();
        let old = state.begin(url.as_str(), false).unwrap();
        assert_eq!(state.attempt(&url), Some(old));
        assert!(state.fail(old, "timeout"));
        let new = state.begin(url.as_str(), true).unwrap();
        assert!(!state.document_ready(old, &url));
        assert!(!state.fail(old, "late error"));
        assert_eq!(state.attempt(&url), Some(new));
        assert!(state.document_ready(new, &url));
        assert!(state.attempt(&url).is_none());
    }

    #[test]
    fn ready_only_accepts_current_entry_and_shell_identity_is_exact() {
        let mut state = PageConnection::default();
        state.shell_url = Some(Url::parse("tauri://localhost/").unwrap());
        assert!(state.is_shell(&Url::parse("tauri://localhost/").unwrap()));
        assert!(!state.is_shell(&Url::parse("tauri://localhost/pet.html").unwrap()));
        assert!(!state.is_shell(&Url::parse("tauri://localhost/?token=x").unwrap()));
        let attempt = state
            .begin("http://127.0.0.1:3001/AIChat.html", false)
            .unwrap();
        for url in [
            "http://127.0.0.1:3002/AIChat.html",
            "http://127.0.0.1:3001/tool.html",
            "http://u:p@127.0.0.1:3001/AIChat.html",
        ] {
            assert!(!state.document_ready(attempt, &Url::parse(url).unwrap()));
        }
        assert!(state.document_ready(
            attempt,
            &Url::parse("http://127.0.0.1:3001/AIChat.html").unwrap()
        ));
        assert!(state
            .begin("http://127.0.0.1:3001/AIChat.html", true)
            .is_none());
    }
}
