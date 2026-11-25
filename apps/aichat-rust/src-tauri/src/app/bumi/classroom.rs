// One foreground task owns one connection. Native timing starts immediately
// before the GATT write and does not depend on its acknowledgement or the UI.
use super::{ClassroomAction as Action, ClassroomPulseProfile as Profile};
use super::{
    bluetooth::Bluetooth, remote_input, Command, Control, LocomotionMode, Request, Snapshot,
};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use tokio::sync::watch;
use tokio::time::{sleep_until, Instant};

const REFRESH_MS: u64 = 100;

#[derive(Clone, Copy)]
struct Pulse {
    axis: i8,
    duration: Duration,
    repeat: bool,
}

impl Pulse {
    fn for_profile(profile: Option<Profile>) -> Self {
        let (axis, millis) = match profile {
            Some(Profile::Strong) => (80, 1000),
            Some(Profile::Standard) => (64, 800),
            Some(Profile::Gentle) | None => (40, 400),
        };
        Self {
            axis,
            duration: Duration::from_millis(millis),
            repeat: profile.is_some(),
        }
    }
}
const EXPIRED: &str = "课堂任务已停止，请重新发送指令。";

impl Action {
    fn command(self, axis: i8) -> Command {
        let (vx, vyaw) = match self {
            Self::Forward => (axis, 0),
            Self::Backward => (-axis, 0),
            Self::Left => (0, axis),
            Self::Right => (0, -axis),
            Self::Handshake => return Command::Handshake,
            Self::Wave => return Command::Wave,
            Self::AskDoorOrLectern => return Command::Speak { text: "靠门的那位，还是靠讲台的那位？".into() },
            Self::AskWhich => return Command::Speak { text: "您指的是哪一位？".into() },
            Self::Greet => {
                return Command::Speak {
                    text: "你好呀！".into(),
                }
            }
        };
        Command::Move { vx, vyaw, vy: 0 }
    }
}

struct Task {
    id: String,
    pulse: Pulse,
    connection: String,
    capture: Option<u64>,
    voice_session: Option<watch::Receiver<bool>>,
    owner: watch::Sender<()>,
    sequence: u32,
}

#[derive(Default)]
pub(super) struct Sessions {
    active: Option<Task>,
    // The renderer allocates pageNonce-counter IDs. One watermark per opened
    // document rejects a delayed begin even when end arrived first.
    latest: HashMap<String, u64>,
}

fn task_number(id: &str) -> Result<(&str, u64), String> {
    let (page, counter) = id.rsplit_once('-').ok_or(EXPIRED)?;
    let number: u64 = counter.parse().map_err(|_| EXPIRED)?;
    if page.is_empty()
        || id.len() > 100
        || number == 0
        || !page.bytes().all(|b| b.is_ascii_alphanumeric())
        || number.to_string() != counter
    {
        return Err(EXPIRED.into());
    }
    Ok((page, number))
}

impl Sessions {
    fn interrupt(&mut self, id: &str, sequence: u32) -> bool {
        let Some(task) = self
            .active
            .as_mut()
            .filter(|t| t.id == id && sequence >= t.sequence)
        else {
            return false;
        };
        task.sequence = sequence;
        task.owner.send_replace(());
        true
    }

    fn remember(&mut self, id: &str) -> Result<(), String> {
        let (page, number) = task_number(id)?;
        let latest = self.latest.entry(page.to_owned()).or_default();
        if number <= *latest {
            return Err(EXPIRED.into());
        }
        *latest = number;
        Ok(())
    }

    fn end(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            let _ = self.remember(id);
        }
        if self
            .active
            .as_ref()
            .is_some_and(|task| id.is_none_or(|id| task.id == id))
        {
            self.active = None;
        }
    }
}

pub(super) fn end(core: &Control, id: Option<&str>) {
    core.classroom.lock().unwrap().end(id);
}

pub(super) fn end_window(core: &Control, lifetime: &watch::Receiver<()>) {
    let owner = core.window.lock().unwrap();
    if owner
        .as_ref()
        .is_some_and(|w| w.subscribe().same_channel(lifetime))
    {
        end(core, None);
    }
}

fn foreground(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false)
}

pub(super) fn begin(
    window: &WebviewWindow,
    core: &Control,
    id: String,
    connection: String,
    capture: Option<u64>,
    voice: Option<u64>,
    pulse_profile: Option<Profile>,
    lifetime: &watch::Receiver<()>,
) -> Result<Snapshot, String> {
    task_number(&id)?;
    if capture.is_some() != voice.is_some() || !foreground(window) {
        return Err("请保持控制窗口在前台，用当前控制会话开始课堂任务。".into());
    }
    let bluetooth = core
        .bluetooth
        .try_lock()
        .map_err(|_| "请先等机器人停稳。")?;
    let snapshot = bluetooth.snapshot();
    if !bluetooth.owned_by(lifetime)
        || snapshot.connection_id.as_deref() != Some(&connection)
        || snapshot.moving
        || snapshot.teach_recording
        || snapshot.locomotion_mode != Some(LocomotionMode::Walk)
    {
        return Err("请先连接机器人，进入行走模式并等它站稳。".into());
    }
    // No synchronous Tauri window query while the classroom mutex is held:
    // the event loop can itself be delivering a blur that revokes this task.
    let voice_session = match (capture, voice) {
        (Some(capture), Some(voice)) => {
            Some(remote_input::claim_voice(window, core, capture, voice)?)
        }
        _ => None,
    };
    let window_owner = core.window.lock().unwrap();
    if !window_owner
        .as_ref()
        .is_some_and(|w| w.subscribe().same_channel(lifetime))
    {
        return Err(EXPIRED.into());
    }
    let mut sessions = core.classroom.lock().unwrap();
    if sessions.active.is_some() || remote_input::current_capture(core) != capture {
        return Err("请先结束当前任务或方向键遥控。".into());
    }
    sessions.remember(&id)?;
    sessions.active = Some(Task {
        id,
        pulse: Pulse::for_profile(pulse_profile),
        connection,
        capture,
        voice_session,
        owner: watch::channel(()).0,
        sequence: 0,
    });
    Ok(snapshot)
}

async fn write(
    bluetooth: &mut Bluetooth,
    window: &WebviewWindow,
    lifetime: &watch::Receiver<()>,
    capture: Option<u64>,
    voice_session: Option<watch::Receiver<bool>>,
    command: Command,
    verify: impl Fn() -> Result<(), String>,
) -> Result<Snapshot, String> {
    bluetooth
        .request(
            window.app_handle(),
            Request::Send {
                command,
                remote_capture_id: capture,
                voice_id: None,
            },
            lifetime.clone(),
            lifetime.clone(),
            voice_session,
            verify,
        )
        .await
}

pub(super) async fn stop(
    window: &WebviewWindow,
    core: &Control,
    lifetime: watch::Receiver<()>,
    id: &str,
    sequence: u32,
) -> Result<Snapshot, String> {
    // Interrupt an in-flight GATT operation without first taking its BLE lock.
    let accepted = core.classroom.lock().unwrap().interrupt(id, sequence);
    let mut bluetooth = core.bluetooth.lock().await;
    let snapshot = bluetooth.snapshot();
    let matches = accepted
        && bluetooth.owned_by(&lifetime)
        && core
            .classroom
            .lock()
            .unwrap()
            .active
            .as_ref()
            .is_some_and(|t| {
                t.id == id
                    && sequence == t.sequence
                    && snapshot.connection_id.as_ref() == Some(&t.connection)
            });
    if !matches {
        // Native focus loss can revoke a settled task before its renderer receives
        // blur. Return the idle snapshot without touching another task. The
        // renderer verifies the connection; an explicit chat Stop has its own write.
        if !snapshot.moving && bluetooth.owned_by(&lifetime) && core.classroom.lock().unwrap().active.is_none() {
            return Ok(snapshot);
        }
        return Err("原课堂会话或机器人连接已改变，未能确认停步。".into());
    }
    write(
        &mut bluetooth,
        window,
        &lifetime,
        None,
        None,
        Command::STOP,
        || Ok(()),
    )
    .await
}

// A single physical pulse can require several joystick keepalives. Use the
// original write time for both the refresh slots and hard deadline. A slow
// BLE acknowledgement skips missed slots; it never creates a queue of writes.
struct PulseClock {
    pulse: Pulse,
    started: watch::Sender<Option<Instant>>,
}

impl PulseClock {
    fn new(pulse: Pulse) -> Self {
        Self {
            pulse,
            started: watch::channel(None).0,
        }
    }

    fn before_write(&self) -> Result<(), String> {
        let now = Instant::now();
        let at = *self.started.borrow();
        match at {
            Some(at) if now >= at + self.pulse.duration => Err("本次点动已到时限。".into()),
            Some(_) => Ok(()),
            None => {
                self.started.send_replace(Some(now));
                Ok(())
            }
        }
    }

    async fn wait_for_refresh(&self) -> Result<bool, String> {
        let at = (*self.started.borrow()).ok_or(EXPIRED)?;
        let slot = at.elapsed().as_millis() as u64 / REFRESH_MS + 1;
        let next = at + Duration::from_millis(slot * REFRESH_MS);
        if !self.pulse.repeat || next >= at + self.pulse.duration {
            return Ok(false);
        }
        sleep_until(next).await;
        Ok(Instant::now() < at + self.pulse.duration)
    }

    async fn run(&self, frames: impl Future<Output = Result<(), String>>) -> Result<(), String> {
        let mut started = self.started.subscribe();
        let deadline = async {
            let at = (*started.wait_for(Option::is_some).await.map_err(|_| EXPIRED)?)
                .ok_or(EXPIRED)?;
            sleep_until(at + self.pulse.duration).await;
            Ok::<(), String>(())
        };
        tokio::pin!(deadline);
        tokio::select! {
            biased;
            result = frames => { result?; deadline.await }
            result = &mut deadline => { result?; Err("移动写入超时，已请求停止。".into()) }
        }
    }
}

pub(super) async fn step(
    window: &WebviewWindow,
    core: &Arc<Control>,
    lifetime: watch::Receiver<()>,
    id: String,
    sequence: u32,
    action: Action,
) -> Result<Snapshot, String> {
    let mut bluetooth = core
        .bluetooth
        .try_lock()
        .map_err(|_| "蓝牙操作尚未结束。")?;
    let (owner, capture, voice_session, command, settings) = {
        let mut sessions = core.classroom.lock().unwrap();
        let task = sessions
            .active
            .as_mut()
            .filter(|t| t.id == id)
            .ok_or(EXPIRED)?;
        let command = action.command(task.pulse.axis);
        let snapshot = bluetooth.snapshot();
        if !bluetooth.owned_by(&lifetime)
            || task.sequence.checked_add(1) != Some(sequence)
            || snapshot.connection_id.as_deref() != Some(&task.connection)
            || snapshot.moving
            || snapshot.teach_recording
            || (command.motion_active() == Some(true) && snapshot.locomotion_mode != Some(LocomotionMode::Walk))
        {
            return Err(EXPIRED.into());
        }
        task.sequence = sequence;
        (
            task.owner.subscribe(),
            task.capture,
            task.voice_session.clone(),
            command,
            task.pulse,
        )
    };
    let verify = || {
        if !matches!(owner.has_changed(), Ok(false))
            || !foreground(window)
            || voice_session
                .as_ref()
                .is_some_and(|s| *s.borrow() || s.has_changed().is_err())
        {
            return Err(EXPIRED.into());
        }
        if let Some(capture) = capture {
            remote_input::verify_voice_idle(window, core, capture)?;
        } else if remote_input::current_capture(core).is_some() {
            return Err(EXPIRED.into());
        }
        Ok(())
    };
    verify()?;
    let mut cancelled = owner.clone();
    let guard = async {
        loop {
            tokio::select! {
                _ = cancelled.changed() => break,
                _ = tokio::time::sleep(Duration::from_millis(40)) => {
                    if verify().is_err() { break; }
                }
            }
        }
    };
    if command.motion_active() != Some(true) {
        // Keep the originating capture's posture ownership across a greeting.
        // Speech does not select a new gait and needs no posture-status query.
        let posture = if matches!(command, Command::Wave | Command::Handshake) {
            voice_session.clone()
        } else {
            None
        };
        return tokio::select! {
            biased;
            _ = guard => Err(EXPIRED.into()),
            result = write(&mut bluetooth, window, &lifetime, capture, posture, command, verify) => result,
        };
    }
    let clock = PulseClock::new(settings);
    let movement = async {
        loop {
            write(&mut bluetooth, window, &lifetime, capture, None, command.clone(), || {
                verify()?;
                clock.before_write()
            })
            .await?;
            if !clock.wait_for_refresh().await? {
                return Ok(());
            }
        }
    };
    let result = tokio::select! {
        biased;
        _ = guard => Err(EXPIRED.into()),
        result = clock.run(movement) => result,
    };
    // Even a timeout or cancellation can mean the motor received the command.
    let stopped = write(
        &mut bluetooth,
        window,
        &lifetime,
        None,
        None,
        Command::STOP,
        || Ok(()),
    )
    .await
    .map_err(|e| format!("停止指令未确认，请现场确认机器人已停稳。{e}"))?;
    result?;
    Ok(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibrated_pulses_are_single_axis_and_greetings_use_existing_commands() {
        for (action, expected) in [
            (Action::Forward, (40, 0)),
            (Action::Backward, (-40, 0)),
            (Action::Left, (0, 40)),
            (Action::Right, (0, -40)),
        ] {
            assert!(
                matches!(action.command(40), Command::Move { vx, vyaw, vy: 0 } if (vx, vyaw) == expected)
            );
        }
        assert!(matches!(Action::AskDoorOrLectern.command(40), Command::Speak { text } if text == "靠门的那位，还是靠讲台的那位？"));
        assert!(matches!(Action::AskWhich.command(40), Command::Speak { text } if text == "您指的是哪一位？"));
        assert!(matches!(Action::Greet.command(40), Command::Speak { text } if text == "你好呀！"));
    }

    #[test]
    fn late_begin_and_duplicate_ids_cannot_reclaim_the_robot() {
        let mut sessions = Sessions::default();
        sessions.end(Some("page1-4"));
        for id in ["page1-1", "page1-4", "page1-04", "page1-+6"] {
            assert!(sessions.remember(id).is_err());
        }
        sessions.remember("page1-5").unwrap();
        sessions.end(Some("page1-3"));
        assert!(sessions.remember("page1-5").is_err());
        sessions.remember("page2-1").unwrap();
    }

    #[test]
    fn a_stop_invalidates_pending_pulses_and_never_cancels_a_newer_owner() {
        let (owner, active) = watch::channel(());
        let mut sessions = Sessions {
            active: Some(Task {
                id: "lesson-2".into(),
                pulse: Pulse::for_profile(None),
                sequence: 1,
                connection: "robot-2".into(),
                capture: None,
                voice_session: None,
                owner,
            }),
            ..Sessions::default()
        };
        assert!(!sessions.interrupt("lesson-1", 10));
        assert!(!sessions.interrupt("lesson-2", 0));
        sessions.end(Some("lesson-1"));
        assert!(!active.has_changed().unwrap());
        assert!(sessions.interrupt("lesson-2", 3));
        assert!(active.has_changed().unwrap());
        let task = sessions.active.as_ref().unwrap();
        assert_eq!(task.sequence.checked_add(1), Some(4));
        let next = task.owner.subscribe();
        assert!(!next.has_changed().unwrap());
        sessions.end(Some("lesson-2"));
        assert!(next.has_changed().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn one_native_pulse_refreshes_on_schedule_without_extending_the_deadline() {
        for (profile, axis, millis, count) in [
            (None, 40, 400, 1),
            (Some(Profile::Gentle), 40, 400, 4),
            (Some(Profile::Standard), 64, 800, 8),
            (Some(Profile::Strong), 80, 1000, 10),
        ] {
            let pulse = Pulse::for_profile(profile);
            let start = Instant::now();
            let clock = PulseClock::new(pulse);
            let mut writes = Vec::new();
            clock.run(async {
                loop {
                    clock.before_write()?;
                    writes.push(start.elapsed().as_millis());
                    if !clock.wait_for_refresh().await? { return Ok(()); }
                }
            }).await.unwrap();
            assert_eq!(pulse.axis, axis);
            assert_eq!(start.elapsed(), Duration::from_millis(millis));
            assert_eq!(writes, (0..count).map(|i| i * 100).collect::<Vec<_>>());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_transport_skips_refresh_slots() {
        let pulse = Pulse::for_profile(Some(Profile::Standard));
        let start = Instant::now();
        let clock = PulseClock::new(pulse);
        let mut sends = Vec::new();
        clock.run(async {
            loop {
                clock.before_write()?;
                sends.push(start.elapsed().as_millis());
                tokio::time::sleep(Duration::from_millis(140)).await;
                if !clock.wait_for_refresh().await? { return Ok(()); }
            }
        }).await.unwrap();
        assert_eq!(sends, [0, 200, 400, 600]);
        assert_eq!(start.elapsed(), pulse.duration);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_refresh_after_an_acknowledged_frame_expires_at_the_original_deadline() {
        let clock = PulseClock::new(Pulse::for_profile(Some(Profile::Standard)));
        let start = Instant::now();
        let mut writes = 0;
        let result = clock.run(async {
            clock.before_write()?;
            writes += 1;
            assert!(clock.wait_for_refresh().await?);
            clock.before_write()?;
            writes += 1;
            std::future::pending().await
        }).await;
        assert!(result.is_err());
        assert_eq!(writes, 2);
        assert_eq!(start.elapsed(), Duration::from_millis(800));
    }

    #[test]
    fn begin_rejects_an_unknown_requested_profile() {
        let mut begin = serde_json::json!({
            "operation": "beginClassroom", "taskId": "page-1", "connectionId": "test"
        });
        assert!(matches!(serde_json::from_value::<Request>(begin.clone()),
            Ok(Request::BeginClassroom { pulse_profile: None, .. })));
        begin["pulseProfile"] = "strong".into();
        assert!(matches!(serde_json::from_value::<Request>(begin.clone()),
            Ok(Request::BeginClassroom { pulse_profile: Some(Profile::Strong), .. })));
        begin["pulseProfile"] = "unsupported".into();
        assert!(serde_json::from_value::<Request>(begin).is_err());
    }

    #[tokio::test]
    async fn a_stalled_write_cannot_extend_the_native_pulse_deadline() {
        for profile in [None, Some(Profile::Standard)] {
            let pulse = Pulse::for_profile(profile);
            let clock = PulseClock::new(pulse);
            clock.started.send_replace(Some(Instant::now() - pulse.duration));
            assert!(clock.run(std::future::pending()).await.is_err());
            assert!(clock.before_write().is_err());
        }
    }
}
