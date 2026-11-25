// A planned leg is powered only while the operator holds the control in the
// foreground Bumi window. Position and heading come from field observations.
use super::{remote_input, Command, Control, GuidedDirection, Request, Snapshot};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};
use tokio::sync::watch;

const RENEW_WITHIN: Duration = Duration::from_millis(450);
const MAX_HOLD: Duration = Duration::from_secs(4);
const EXPIRED: &str = "本段移动已停止。请核对位置，再按住执行。";

#[derive(Default)]
pub(super) struct Lease {
    capture: u64,
    press: u64,
    active: Option<(GuidedDirection, Instant, Instant)>,
    voice_id: Option<u64>,
}

impl Lease {
    pub(super) fn arm(&mut self, capture: u64) {
        *self = Self {
            capture,
            ..Self::default()
        };
    }

    fn current(&self, capture: u64, press: u64) -> bool {
        (self.capture, self.press) == (capture, press)
    }

    fn valid(&self, now: Instant) -> bool {
        self.active.is_some_and(|(_, start, last)| {
            now.duration_since(last) < RENEW_WITHIN && now.duration_since(start) < MAX_HOLD
        })
    }

    fn renew(
        &mut self,
        capture: u64,
        press: u64,
        direction: GuidedDirection,
        voice_id: Option<u64>,
        now: Instant,
    ) -> Result<bool, String> {
        if self.capture != capture || press == 0 || press < self.press {
            return Err(EXPIRED.into());
        }
        if self.current(capture, press) {
            if !self.valid(now)
                || self.active.map(|entry| entry.0) != Some(direction)
                || self.voice_id != voice_id
            {
                return Err(EXPIRED.into());
            }
            self.active.as_mut().unwrap().2 = now;
            return Ok(false);
        }
        if self.active.is_some() {
            return Err("请先松开上一段的执行按钮。".into());
        }
        *self = Self {
            capture,
            press,
            voice_id,
            active: Some((direction, now, now)),
        };
        Ok(true)
    }

    // Remember a release even if IPC delivers it before the first move.
    fn release(&mut self, capture: u64, press: u64) -> bool {
        if self.current(capture, press) {
            return self.active.take().is_some();
        }
        if self.capture == capture && self.active.is_none() && self.press < press {
            *self = Self {
                capture,
                press,
                active: None,
                voice_id: None,
            };
        }
        false
    }
}

fn start_watchdog(window: WebviewWindow, core: Arc<Control>, capture: u64, press: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let idle = remote_input::verify_voice_idle(&window, &core, capture).is_ok();
            let mut lease = core.guide.lock().unwrap();
            if !lease.current(capture, press) || lease.active.is_none() {
                return;
            }
            if !idle || !lease.valid(Instant::now()) {
                lease.active = None;
                // The capture task revokes authorization, then writes zero under the
                // BLE lock even if the renderer stopped processing events.
                remote_input::cancel_drive(&core, capture);
                return;
            }
        }
    });
}

pub(super) async fn request(
    window: &WebviewWindow,
    core: &Arc<Control>,
    lifetime: watch::Receiver<()>,
    capture: u64,
    press: u64,
    direction: Option<GuidedDirection>,
    voice_id: Option<u64>,
) -> Result<Snapshot, String> {
    let Some(direction) = direction else {
        // Revocation must not queue behind the write that it is cancelling.
        let released = core.guide.lock().unwrap().release(capture, press);
        let mut bluetooth = core.bluetooth.lock().await;
        if released && core.guide.lock().unwrap().current(capture, press) {
            if let Err(error) = bluetooth.stop_remote_if_moving(&lifetime, capture).await {
                remote_input::cancel_drive(core, capture);
                return Err(error);
            }
        }
        return Ok(bluetooth.snapshot());
    };

    remote_input::verify_voice_idle(window, core, capture)?;
    let started =
        core.guide
            .lock()
            .unwrap()
            .renew(capture, press, direction, voice_id, Instant::now())?;
    if started {
        start_watchdog(window.clone(), core.clone(), capture, press);
    }
    let verify_lease = || -> Result<(), String> {
        remote_input::verify_voice_idle(window, core, capture)?;
        let lease = core.guide.lock().unwrap();
        if lease.current(capture, press) && lease.valid(Instant::now()) {
            Ok(())
        } else {
            Err(EXPIRED.into())
        }
    };
    // The native action has no variable speed, backward direction or sideways component.
    let (vx, vyaw) = match direction {
        GuidedDirection::Forward => (40, 0),
        GuidedDirection::Left => (0, 40),
        GuidedDirection::Right => (0, -40),
    };
    let mut bluetooth = core.bluetooth.lock().await;
    verify_lease()?;
    let authorize_write = || {
        verify_lease()?;
        match voice_id {
            Some(turn) => remote_input::verify_guided_voice(window, core, capture, turn, started),
            None => Ok(()),
        }
    };
    let result = bluetooth
        .request(
            window.app_handle(),
            Request::Send {
                command: Command::Move { vx, vyaw, vy: 0 },
                remote_capture_id: Some(capture),
                voice_id: None,
            },
            lifetime.clone(),
            lifetime,
            authorize_write,
        )
        .await;
    if result.is_err() && core.guide.lock().unwrap().release(capture, press) {
        remote_input::cancel_drive(core, capture);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_is_final_and_cannot_interrupt_a_later_press() {
        let now = Instant::now();
        let mut lease = Lease::default();
        lease.arm(3);
        lease.renew(3, 1, GuidedDirection::Left, None, now).unwrap();
        lease.arm(4);
        assert!(!lease.release(4, 1));
        assert!(!lease.release(3, 2));
        assert!(lease.renew(3, 3, GuidedDirection::Left, None, now).is_err());
        assert!(lease.renew(4, 1, GuidedDirection::Left, None, now).is_err());
        assert_eq!(
            lease.renew(4, 2, GuidedDirection::Forward, None, now),
            Ok(true)
        );
        assert!(lease
            .renew(4, 2, GuidedDirection::Forward, Some(5), now)
            .is_err());
        assert!(!lease.release(4, 1));
        assert!(lease
            .renew(4, 2, GuidedDirection::Right, None, now)
            .is_err());
        assert!(lease.renew(4, 3, GuidedDirection::Left, None, now).is_err());
        assert!(lease.release(4, 2));
        assert_eq!(
            lease.renew(4, 3, GuidedDirection::Right, None, now),
            Ok(true)
        );
    }

    #[test]
    fn stalled_renderer_cannot_resume_and_repeated_refresh_has_a_deadline() {
        let now = Instant::now();
        let mut lease = Lease::default();
        lease.arm(4);
        lease
            .renew(4, 1, GuidedDirection::Forward, None, now)
            .unwrap();
        assert!(lease
            .renew(4, 1, GuidedDirection::Forward, None, now + RENEW_WITHIN)
            .is_err());
        lease.release(4, 1);
        lease
            .renew(4, 2, GuidedDirection::Right, None, now)
            .unwrap();
        for i in 1..40 {
            assert_eq!(
                lease.renew(
                    4,
                    2,
                    GuidedDirection::Right,
                    None,
                    now + Duration::from_millis(i * 100)
                ),
                Ok(false)
            );
        }
        assert!(lease
            .renew(4, 2, GuidedDirection::Right, None, now + MAX_HOLD)
            .is_err());
    }
}
