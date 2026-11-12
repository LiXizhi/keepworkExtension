// Pure production policy: no Tauri app, paired-device query, BLE or OS input.
#[path = "../../src-tauri/src/remote_voice/auto_start.rs"]
mod auto_start;

#[cfg(test)]
mod tests {
    use super::auto_start::AutoPolicy;

    #[test]
    fn preference_off_and_running_state_reject_an_otherwise_current_probe() {
        let policy = AutoPolicy::default();
        let ticket = policy.ticket(true, false).unwrap();
        assert!(policy.accepts(ticket, true, false));
        assert!(!policy.accepts(ticket, false, false));
        assert!(!policy.accepts(ticket, true, true));
        assert!(!policy.accepts(ticket, false, true));
    }

    #[test]
    fn off_then_on_never_accepts_the_probe_from_before_the_toggle() {
        let mut policy = AutoPolicy::default();
        let before_off = policy.ticket(true, false).unwrap();
        policy.pause();
        assert!(policy.ticket(false, false).is_none());
        assert!(!policy.accepts(before_off, false, false));
        policy.explicit_start();
        let after_on = policy.ticket(true, false).unwrap();
        assert_ne!(before_off, after_on);
        assert!(!policy.accepts(before_off, true, false));
        assert!(policy.accepts(after_on, true, false));
    }

    #[test]
    fn manual_session_cannot_be_overridden_after_it_finishes_by_an_older_probe() {
        let mut policy = AutoPolicy::default();
        let automatic_probe = policy.ticket(true, false).unwrap();
        policy.explicit_start();
        assert!(!policy.accepts(automatic_probe, true, true));
        assert!(!policy.accepts(automatic_probe, true, false));
        policy.pause();
        for _tick in 0..100 {
            assert!(policy.ticket(true, false).is_none());
        }
    }

    #[test]
    fn every_probe_epoch_stays_invalid_after_stop_block_and_explicit_recovery() {
        let mut policy = AutoPolicy::default();
        let first = policy.ticket(true, false).unwrap();
        policy.pause();
        policy.explicit_start();
        let second = policy.ticket(true, false).unwrap();
        policy.block();
        for _tick in 0..100 {
            assert!(policy.ticket(true, false).is_none());
        }
        policy.explicit_start();
        let third = policy.ticket(true, false).unwrap();
        assert!(!policy.accepts(first, true, false));
        assert!(!policy.accepts(second, true, false));
        assert!(policy.accepts(third, true, false));
    }

    #[test]
    fn shutdown_is_terminal_even_after_multiple_enable_or_start_intents() {
        let mut policy = AutoPolicy::default();
        let ticket = policy.ticket(true, false).unwrap();
        policy.close();
        for _intent in 0..10 {
            policy.explicit_start();
            assert!(policy.shutdown);
            assert!(policy.ticket(true, false).is_none());
            assert!(!policy.accepts(ticket, true, false));
        }
    }
}
