//! In-memory intent guards for passive pairing detection. A stale device probe
//! must never override Stop, a changed setting, a manual Start or app shutdown.
#[derive(Default)]
pub(super) struct AutoPolicy {
    pub monitor_started: bool,
    pub suppressed: bool,
    pub blocked: bool,
    pub shutdown: bool,
    bluetooth_prompt_requested: bool,
    sleeping: Option<bool>,
    revision: u64,
}

impl AutoPolicy {
    pub fn ticket(&self, enabled: bool, running: bool) -> Option<u64> {
        (enabled && !running && !self.asleep() && !self.suppressed && !self.blocked && !self.shutdown)
            .then_some(self.revision)
    }
    pub fn accepts(&self, ticket: u64, enabled: bool, running: bool) -> bool {
        self.ticket(enabled, running) == Some(ticket)
    }
    pub fn request_bluetooth(&mut self, ticket: u64, enabled: bool, running: bool, foreground: bool) -> bool {
        if !foreground || self.bluetooth_prompt_requested || !self.accepts(ticket, enabled, running) {
            return false;
        }
        self.bluetooth_prompt_requested = true;
        true
    }
    pub fn asleep(&self) -> bool {
        self.sleeping == Some(true)
    }
    pub fn power_changed(&mut self, sleeping: bool) -> bool {
        if self.shutdown || self.sleeping == Some(sleeping) { return false; }
        self.sleeping = Some(sleeping);
        self.revision = self.revision.wrapping_add(1);
        true
    }
    pub fn explicit_start(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.suppressed = false;
        self.blocked = false;
    }
    pub fn pause(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.suppressed = true;
    }
    pub fn block(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.blocked = true;
    }
    pub fn close(&mut self) {
        self.pause();
        self.shutdown = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_only_probes_when_enabled_and_idle() {
        let policy = AutoPolicy::default();
        assert!(policy.ticket(true, false).is_some());
        assert!(policy.ticket(false, false).is_none());
        assert!(policy.ticket(true, true).is_none());
    }
    #[test]
    fn bluetooth_consent_requires_current_foreground_intent_and_is_requested_once() {
        let mut policy = AutoPolicy::default();
        let ticket = policy.ticket(true, false).unwrap();
        assert!(!policy.request_bluetooth(ticket, true, false, false));
        assert!(!policy.request_bluetooth(ticket, false, false, true));
        assert!(!policy.request_bluetooth(ticket, true, true, true));
        assert!(policy.request_bluetooth(ticket, true, false, true));
        assert!(!policy.request_bluetooth(ticket, true, false, true));
        policy.explicit_start();
        let ticket = policy.ticket(true, false).unwrap();
        assert!(!policy.request_bluetooth(ticket, true, false, true));
    }
    #[test]
    fn stopped_changed_sleeping_or_exiting_intents_cannot_request_bluetooth_consent() {
        for intent in 0..5 {
            let mut policy = AutoPolicy::default();
            let ticket = policy.ticket(true, false).unwrap();
            match intent {
                0 => policy.pause(),
                1 => policy.block(),
                2 => policy.close(),
                3 => { policy.power_changed(true); },
                _ => policy.explicit_start(),
            }
            assert!(!policy.request_bluetooth(ticket, true, false, true));
        }
    }
    #[test]
    fn manual_stop_suppresses_every_later_poll_until_an_explicit_start() {
        let mut policy = AutoPolicy::default();
        let old = policy.ticket(true, false).unwrap();
        policy.pause();
        assert!(!policy.accepts(old, true, false));
        assert!(policy.ticket(true, false).is_none());
        policy.explicit_start();
        assert!(!policy.accepts(old, true, false));
        assert!(policy.ticket(true, false).is_some());
    }
    #[test]
    fn manual_intents_errors_and_exit_invalidate_inflight_results() {
        for action in 0..4 {
            let mut policy = AutoPolicy::default();
            let old = policy.ticket(true, false).unwrap();
            match action {
                0 => policy.explicit_start(),
                1 => policy.pause(),
                2 => policy.block(),
                _ => policy.close(),
            }
            assert!(!policy.accepts(old, true, false));
        }
    }
    #[test]
    fn permission_errors_do_not_repeat_and_shutdown_cannot_be_reopened() {
        let mut policy = AutoPolicy::default();
        policy.block();
        assert!(policy.ticket(true, false).is_none());
        policy.explicit_start();
        assert!(policy.ticket(true, false).is_some());
        policy.close();
        policy.explicit_start();
        assert!(policy.ticket(true, false).is_none());
    }
}
