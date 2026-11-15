//! Bounded WinPTY readiness retries, independent of Windows and wall-clock sleeps.
//! Health callers only reserve work; a single background worker owns the probe.
use super::TerminalHealth;
use std::time::Duration;

const VERIFY_INTERVAL: Duration = Duration::from_secs(30);
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(30),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Work {
    Probe,
    Verify,
}

pub(super) enum Failure {
    Permanent(&'static str),
    Transient(&'static str),
}

#[derive(Default)]
pub(super) struct Readiness {
    ready: bool,
    working: bool,
    permanent: bool,
    failures: usize,
    next_check: Duration,
    reason: Option<&'static str>,
}

impl Readiness {
    pub(super) fn begin(&mut self, now: Duration) -> Option<Work> {
        if self.working || self.permanent || now < self.next_check {
            return None;
        }
        self.working = true;
        Some(if self.ready {
            Work::Verify
        } else {
            Work::Probe
        })
    }

    pub(super) fn finish(&mut self, now: Duration, result: Result<(), Failure>) {
        self.working = false;
        match result {
            Ok(()) => {
                self.ready = true;
                self.failures = 0;
                self.reason = None;
                self.next_check = now + VERIFY_INTERVAL;
            }
            Err(failure) => {
                self.ready = false;
                let reason = match failure {
                    Failure::Permanent(reason) => {
                        self.permanent = true;
                        reason
                    }
                    Failure::Transient(reason) => {
                        self.next_check = now + RETRY_DELAYS[self.failures.min(2)];
                        self.failures = (self.failures + 1).min(3);
                        reason
                    }
                };
                self.reason = Some(reason);
            }
        }
    }

    pub(super) fn health(&self) -> TerminalHealth {
        TerminalHealth {
            ready: self.ready,
            status: if self.ready {
                "ready"
            } else if self.working || self.reason.is_none() {
                "initializing"
            } else {
                "unavailable"
            },
            reason: if self.ready || self.working {
                None
            } else {
                self.reason
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TIMEOUT: &str = "Terminal backend startup timed out; it will retry automatically.";

    #[test]
    fn first_timeout_recovers_in_the_same_process_after_a_bounded_cooldown() {
        let mut state = Readiness::default();
        assert_eq!(state.begin(Duration::ZERO), Some(Work::Probe));
        assert_eq!(state.health().status, "initializing");
        assert!(!state.health().ready);
        state.finish(
            Duration::from_millis(1500),
            Err(Failure::Transient(TIMEOUT)),
        );
        assert_eq!(state.health().status, "unavailable");
        assert_eq!(state.health().reason, Some(TIMEOUT));
        assert_eq!(state.begin(Duration::from_millis(2499)), None);
        assert_eq!(state.begin(Duration::from_millis(2500)), Some(Work::Probe));
        state.finish(Duration::from_millis(2600), Ok(()));
        assert!(state.health().ready);
        assert_eq!(state.health().status, "ready");
        assert!(state.health().reason.is_none());
    }

    #[test]
    fn parallel_health_calls_reserve_one_worker_and_never_restart_a_running_probe() {
        let mut state = Readiness::default();
        assert_eq!(state.begin(Duration::ZERO), Some(Work::Probe));
        for _ in 0..1000 {
            assert_eq!(state.begin(Duration::from_secs(600)), None);
            assert_eq!(state.health().status, "initializing");
        }
        state.finish(Duration::from_secs(600), Ok(()));
        assert_eq!(state.begin(Duration::from_secs(629)), None);
        assert_eq!(state.begin(Duration::from_secs(630)), Some(Work::Verify));
        // A periodic integrity check does not temporarily withdraw a ready API.
        assert!(state.health().ready);
        assert_eq!(state.begin(Duration::from_secs(631)), None);
    }

    #[test]
    fn repeated_transient_failures_back_off_without_permanently_caching_failure() {
        let mut state = Readiness::default();
        let mut now = Duration::ZERO;
        for delay in [1, 5, 30, 30, 30] {
            assert_eq!(state.begin(now), Some(Work::Probe));
            state.finish(now, Err(Failure::Transient(TIMEOUT)));
            assert_eq!(state.begin(now + Duration::from_millis(999)), None);
            now += Duration::from_secs(delay);
        }
        assert_eq!(state.begin(now), Some(Work::Probe));
        state.finish(now, Ok(()));
        assert!(state.health().ready);
    }

    #[test]
    fn modified_assets_remain_unavailable_without_repeated_loads_or_probes() {
        let mut state = Readiness::default();
        state.begin(Duration::ZERO);
        state.finish(Duration::ZERO, Ok(()));
        assert_eq!(state.begin(VERIFY_INTERVAL), Some(Work::Verify));
        state.finish(VERIFY_INTERVAL, Err(Failure::Permanent("Bundled terminal agent integrity check failed; reinstall and restart the local service.")));
        assert!(!state.health().ready);
        assert_eq!(state.health().status, "unavailable");
        assert_eq!(state.begin(Duration::from_secs(86400)), None);
        assert!(state.health().reason.unwrap().len() <= 512);
    }
}
