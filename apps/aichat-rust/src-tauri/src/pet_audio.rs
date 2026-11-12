//! In-memory, one-shot microphone leases created only by a validated pet click.
//! Audio stays on the owning main frame; no credentials or recordings are stored.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use uuid::Uuid;

pub const VERSION: u64 = 1;
pub const SAMPLE_RATE: u64 = 16_000;
pub const MAX_CHUNK_SAMPLES: usize = 4096;
const MAX_PENDING_CHUNKS: usize = 16;
const MAX_SAMPLES_PER_SECOND: usize = 64_000;
pub const START_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIO_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const ACK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Issued,
    Starting,
    Ready,
    Activating,
    Active,
}

struct Lease {
    id: String,
    context: String,
    request_id: String,
    generation: u64,
    phase: Phase,
    created: Instant,
    last_audio: Instant,
    rate_window: Instant,
    rate_samples: usize,
    next_seq: u64,
    last_ack: u64,
    pending: Vec<(u64, Instant)>,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    document: Option<String>,
    claimed: bool,
}

#[derive(Default)]
struct State {
    context: String,
    document: Option<String>,
    generation: u64,
    supported: bool,
    lease: Option<Lease>,
}

#[derive(Default)]
pub struct PetAudioRelay {
    state: Mutex<State>,
}

pub enum PetAudioEvent {
    Claim,
    Ready,
    Active,
    Audio(Value),
    Error(String),
    Ended(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureIdentity {
    pub id: String,
    pub document: Option<String>,
}

fn identity(mut lease: Lease) -> CaptureIdentity {
    cancelled(&mut lease);
    CaptureIdentity {
        id: lease.id,
        document: lease.document,
    }
}

fn cancelled(lease: &mut Lease) {
    if let Some(ready) = lease.ready.take() {
        let _ = ready.send(Err("语音输入已停止".to_string()));
    }
}

impl PetAudioRelay {
    /// A page's capability is optional and belongs to its current owner context.
    pub fn set_page(
        &self,
        context: &str,
        supported: bool,
        document: Option<&str>,
    ) -> Option<CaptureIdentity> {
        let mut state = self.state.lock().ok()?;
        let document = document
            .filter(|document| Uuid::parse_str(document).is_ok())
            .map(str::to_string);
        let supported = supported && document.is_some();
        let removed = if state.context != context || state.document != document || !supported {
            state.lease.take().map(identity)
        } else {
            None
        };
        state.context = context.to_string();
        state.document = document;
        state.supported = supported;
        removed
    }

    pub fn reset_page(&self) -> Option<CaptureIdentity> {
        let mut state = self.state.lock().ok()?;
        state.generation = state.generation.wrapping_add(1);
        state.context.clear();
        state.document = None;
        state.supported = false;
        state.lease.take().map(identity)
    }

    pub fn supported(&self, context: &str) -> bool {
        self.state
            .lock()
            .map(|state| state.supported && state.context == context)
            .unwrap_or(false)
    }

    pub fn issue(
        &self,
        context: &str,
        request_id: &str,
    ) -> Result<(String, Option<CaptureIdentity>), String> {
        let mut state = self.state.lock().map_err(|_| "录音状态不可用，请重试")?;
        if !state.supported
            || context.is_empty()
            || state.context != context
            || request_id.is_empty()
            || request_id.len() > 64
        {
            return Err("当前页面不支持宠物语音采集".to_string());
        }
        let previous = state.lease.take().map(identity);
        let id = Uuid::new_v4().to_string();
        let now = Instant::now();
        state.lease = Some(Lease {
            id: id.clone(),
            context: context.to_string(),
            request_id: request_id.to_string(),
            generation: state.generation,
            phase: Phase::Issued,
            created: now,
            last_audio: now,
            rate_window: now,
            rate_samples: 0,
            next_seq: 1,
            last_ack: 0,
            pending: Vec::new(),
            ready: None,
            document: state.document.clone(),
            claimed: false,
        });
        Ok((id, previous))
    }

    fn owned<'a>(state: &'a mut State, id: &str, context: &str) -> Result<&'a mut Lease, String> {
        let lease = state
            .lease
            .as_mut()
            .ok_or("录音请求已结束，请重新点击语音输入")?;
        if lease.id != id
            || lease.context != context
            || lease.generation != state.generation
            || state.context != context
            || !state.supported
        {
            return Err("录音请求已过期，请重新点击语音输入".to_string());
        }
        Ok(lease)
    }

    pub fn start(
        &self,
        id: &str,
        context: &str,
        document: &str,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        if Uuid::parse_str(document).is_err() {
            return Err("录音页面身份无效，请重新打开页面".to_string());
        }
        let mut state = self.state.lock().map_err(|_| "录音状态不可用，请重试")?;
        let lease = Self::owned(&mut state, id, context)?;
        if lease.document.as_deref() != Some(document) {
            return Err("录音页面已改变，请重新点击语音输入".to_string());
        }
        if lease.phase != Phase::Issued {
            return Err("录音请求已经开始，不能重复启动".to_string());
        }
        let (send, receive) = oneshot::channel();
        lease.phase = Phase::Starting;
        lease.ready = Some(send);
        Ok(receive)
    }

    pub fn document(&self, id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()?
            .lease
            .as_ref()
            .filter(|lease| lease.id == id)?
            .document
            .clone()
    }

    pub fn verify_document(&self, id: &str, document: &str) -> bool {
        self.document(id).as_deref() == Some(document)
    }

    pub fn activate(
        &self,
        id: &str,
        context: &str,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let mut state = self.state.lock().map_err(|_| "录音状态不可用，请重试")?;
        let lease = Self::owned(&mut state, id, context)?;
        let (send, receive) = oneshot::channel();
        if lease.phase == Phase::Active {
            let _ = send.send(Ok(()));
            return Ok(receive);
        }
        if lease.phase != Phase::Ready {
            return Err("麦克风尚未准备就绪".to_string());
        }
        lease.phase = Phase::Activating;
        lease.ready = Some(send);
        Ok(receive)
    }

    /// A cumulative acknowledgement tolerates IPC scheduling reordering.
    pub fn acknowledge(&self, id: &str, context: &str, seq: u64) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "录音状态不可用，请重试")?;
        let lease = Self::owned(&mut state, id, context)?;
        if lease.phase != Phase::Active || seq >= lease.next_seq {
            return Err("音频确认序号无效".to_string());
        }
        if seq <= lease.last_ack {
            return Ok(());
        }
        lease.last_ack = seq;
        lease.pending.retain(|(sent, _)| *sent > seq);
        Ok(())
    }

    pub fn event(&self, id: &str, context: &str, event: &Value) -> Result<PetAudioEvent, String> {
        let mut state = self.state.lock().map_err(|_| "录音状态不可用，请重试")?;
        let lease = Self::owned(&mut state, id, context)?;
        match event["type"].as_str() {
            Some("claim") => {
                if lease.phase != Phase::Starting || lease.claimed {
                    return Err("录音采集请求已领取或已结束".to_string());
                }
                lease.claimed = true;
                Ok(PetAudioEvent::Claim)
            }
            Some("ready") => {
                if lease.phase != Phase::Starting || !lease.claimed {
                    return Err("麦克风准备事件已过期".to_string());
                }
                if event["sampleRate"].as_u64() != Some(SAMPLE_RATE)
                    || event["channels"].as_u64() != Some(1)
                    || event["format"].as_str() != Some("pcm16")
                {
                    return Err("麦克风音频格式不受支持".to_string());
                }
                lease.phase = Phase::Ready;
                if let Some(ready) = lease.ready.take() {
                    let _ = ready.send(Ok(()));
                }
                Ok(PetAudioEvent::Ready)
            }
            Some("active") => {
                if lease.phase != Phase::Activating {
                    return Err("录音激活事件已过期".to_string());
                }
                lease.phase = Phase::Active;
                lease.last_audio = Instant::now();
                if let Some(ready) = lease.ready.take() {
                    let _ = ready.send(Ok(()));
                }
                Ok(PetAudioEvent::Active)
            }
            Some("error") => {
                let message: String = event["message"]
                    .as_str()
                    .unwrap_or("宠物麦克风采集失败")
                    .chars()
                    .take(240)
                    .collect();
                Ok(PetAudioEvent::Error(message))
            }
            Some("ended") => {
                let reason = event["message"]
                    .as_str()
                    .unwrap_or("语音输入已停止")
                    .chars()
                    .take(240)
                    .collect();
                Ok(PetAudioEvent::Ended(reason))
            }
            Some("audio") => {
                if lease.phase != Phase::Active {
                    return Err("录音尚未激活，不能发送音频".to_string());
                }
                let samples = event["samples"].as_array().ok_or("音频数据无效")?;
                let seq = event["seq"].as_u64().ok_or("音频序号无效")?;
                if samples.is_empty()
                    || samples.len() > MAX_CHUNK_SAMPLES
                    || samples.iter().any(|sample| {
                        sample.as_i64().is_none_or(|sample| {
                            !(i16::MIN as i64..=i16::MAX as i64).contains(&sample)
                        })
                    })
                {
                    return Err("音频块超出允许范围".to_string());
                }
                if seq != lease.next_seq {
                    return Err("音频块顺序已中断，请重新开始语音输入".to_string());
                }
                if lease.pending.len() >= MAX_PENDING_CHUNKS {
                    return Err("音频传输繁忙，请重新开始语音输入".to_string());
                }
                let now = Instant::now();
                if now.duration_since(lease.rate_window) >= Duration::from_secs(1) {
                    lease.rate_window = now;
                    lease.rate_samples = 0;
                }
                lease.rate_samples += samples.len();
                if lease.rate_samples > MAX_SAMPLES_PER_SECOND {
                    return Err("音频发送速度异常，请重新开始语音输入".to_string());
                }
                lease.pending.push((seq, now));
                lease.next_seq += 1;
                lease.last_audio = now;
                Ok(PetAudioEvent::Audio(
                    json!({ "id": id, "type": "audio", "samples": samples, "seq": seq, "sampleRate": SAMPLE_RATE }),
                ))
            }
            _ => Err("不支持的宠物录音事件".to_string()),
        }
    }

    pub fn stop(&self, id: Option<&str>) -> Option<CaptureIdentity> {
        self.stop_with_error(id, "语音输入已停止")
    }

    /// A validated pet Stop click owns its current context, not another target.
    pub fn stop_in_context(&self, context: &str) -> Option<CaptureIdentity> {
        let mut state = self.state.lock().ok()?;
        if state.context != context
            || state
                .lease
                .as_ref()
                .is_none_or(|lease| lease.context != context)
        {
            return None;
        }
        state.lease.take().map(identity)
    }

    pub fn stop_with_error(&self, id: Option<&str>, reason: &str) -> Option<CaptureIdentity> {
        let mut state = self.state.lock().ok()?;
        if id.is_some_and(|id| state.lease.as_ref().is_none_or(|lease| lease.id != id)) {
            return None;
        }
        state.lease.take().map(|mut lease| {
            if let Some(ready) = lease.ready.take() {
                let _ = ready.send(Err(reason.to_string()));
            }
            identity(lease)
        })
    }

    pub fn capture_for_request(&self, request_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()?
            .lease
            .as_ref()
            .filter(|lease| lease.request_id == request_id)
            .map(|lease| lease.id.clone())
    }

    pub fn is_current(&self, id: &str) -> bool {
        self.state
            .lock()
            .map(|state| state.lease.as_ref().is_some_and(|lease| lease.id == id))
            .unwrap_or(false)
    }

    pub fn expired_reason(&self, id: &str) -> Option<&'static str> {
        let state = self.state.lock().ok()?;
        let lease = state.lease.as_ref().filter(|lease| lease.id == id)?;
        let now = Instant::now();
        if lease.phase != Phase::Active && now.duration_since(lease.created) >= START_TIMEOUT {
            Some("麦克风准备超时，请重新点击语音输入并完成系统授权")
        } else if lease.phase == Phase::Active
            && now.duration_since(lease.last_audio) >= AUDIO_IDLE_TIMEOUT
        {
            Some("音频采集已中断，请重新开始语音输入")
        } else if lease
            .pending
            .first()
            .is_some_and(|(_, sent)| now.duration_since(*sent) >= ACK_TIMEOUT)
        {
            Some("音频接收页面没有响应，请重新开始语音输入")
        } else {
            None
        }
    }
}

pub fn descriptor() -> Value {
    json!({ "sampleRate": SAMPLE_RATE, "channels": 1, "format": "pcm16" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay() -> PetAudioRelay {
        let relay = PetAudioRelay::default();
        relay.set_page("owner", true, Some("00000000-0000-4000-8000-000000000001"));
        relay
    }
    fn active(relay: &PetAudioRelay) -> String {
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        let mut ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        relay.event(&id, "owner", &json!({"type":"claim"})).unwrap();
        relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"}),
            )
            .unwrap();
        assert_eq!(ready.try_recv().unwrap(), Ok(()));
        relay.activate(&id, "owner").unwrap();
        relay
            .event(&id, "owner", &json!({"type":"active"}))
            .unwrap();
        id
    }

    #[test]
    fn capture_is_one_shot_context_bound_and_does_not_replay_after_cancel() {
        let relay = relay();
        assert!(relay.issue("other", "pet-click").is_err());
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        let mut ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert!(relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .is_err());
        assert_eq!(
            relay.stop(Some(&id)).map(|lease| lease.id),
            Some(id.clone())
        );
        assert!(ready.try_recv().unwrap().is_err());
        assert!(relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"})
            )
            .is_err());
        assert!(relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .is_err());
    }

    #[test]
    fn audio_requires_activation_bounded_pcm_and_ordered_sequence() {
        let relay = relay();
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        let audio = json!({"type":"audio","seq":1,"samples":[-32768,0,32767]});
        assert!(relay.event(&id, "owner", &audio).is_err());
        let _ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        relay.event(&id, "owner", &json!({"type":"claim"})).unwrap();
        relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"}),
            )
            .unwrap();
        relay.activate(&id, "owner").unwrap();
        relay
            .event(&id, "owner", &json!({"type":"active"}))
            .unwrap();
        assert!(matches!(
            relay.event(&id, "owner", &audio).unwrap(),
            PetAudioEvent::Audio(_)
        ));
        assert!(relay.event(&id, "owner", &audio).is_err());
        assert!(relay
            .event(
                &id,
                "owner",
                &json!({"type":"audio","seq":2,"samples":[32768]})
            )
            .is_err());
        assert!(relay
            .event(
                &id,
                "owner",
                &json!({"type":"audio","seq":2,"samples":vec![0;MAX_CHUNK_SAMPLES+1]})
            )
            .is_err());
    }

    #[test]
    fn acknowledgements_bound_backpressure_and_tolerate_reordering() {
        let relay = relay();
        let id = active(&relay);
        for seq in 1..=16 {
            relay
                .event(
                    &id,
                    "owner",
                    &json!({"type":"audio","seq":seq,"samples":[1]}),
                )
                .unwrap();
        }
        assert!(relay
            .event(
                &id,
                "owner",
                &json!({"type":"audio","seq":17,"samples":[1]})
            )
            .is_err());
        relay.acknowledge(&id, "owner", 3).unwrap();
        relay.acknowledge(&id, "owner", 2).unwrap();
        relay
            .event(
                &id,
                "owner",
                &json!({"type":"audio","seq":17,"samples":[1]}),
            )
            .unwrap();
        assert!(relay.acknowledge(&id, "owner", 18).is_err());
    }

    #[test]
    fn page_changes_new_capture_and_navigation_revoke_old_ids() {
        let relay = relay();
        let old = active(&relay);
        let (new, replaced) = relay.issue("owner", "pet-click").unwrap();
        assert_eq!(replaced.map(|lease| lease.id), Some(old.clone()));
        assert_eq!(relay.stop(Some(&old)), None);
        assert!(relay.is_current(&new));
        assert_eq!(
            relay
                .set_page(
                    "new-owner",
                    true,
                    Some("00000000-0000-4000-8000-000000000001")
                )
                .map(|lease| lease.id),
            Some(new.clone())
        );
        assert!(!relay.is_current(&new));
        let (id, _) = relay.issue("new-owner", "pet-click-new").unwrap();
        assert_eq!(relay.reset_page().map(|lease| lease.id), Some(id.clone()));
        assert!(relay
            .start(&id, "new-owner", "00000000-0000-4000-8000-000000000001")
            .is_err());
        assert!(!relay.supported("new-owner"));
    }

    #[test]
    fn microphone_claim_and_active_ack_are_required_once_per_native_request() {
        let relay = relay();
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        assert!(relay.event(&id, "owner", &json!({"type":"claim"})).is_err());
        let mut ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert!(relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"})
            )
            .is_err());
        assert!(relay
            .event(&id, "owner", &json!({"type":"active"}))
            .is_err());
        relay.event(&id, "owner", &json!({"type":"claim"})).unwrap();
        assert!(relay.event(&id, "owner", &json!({"type":"claim"})).is_err());
        relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"}),
            )
            .unwrap();
        assert_eq!(ready.try_recv().unwrap(), Ok(()));
        let mut active = relay.activate(&id, "owner").unwrap();
        assert!(active.try_recv().is_err());
        assert!(relay
            .event(&id, "owner", &json!({"type":"audio","seq":1,"samples":[1]}))
            .is_err());
        relay
            .event(&id, "owner", &json!({"type":"active"}))
            .unwrap();
        assert_eq!(active.try_recv().unwrap(), Ok(()));
        assert!(relay
            .event(&id, "owner", &json!({"type":"active"}))
            .is_err());
        assert!(relay
            .event("forged", "owner", &json!({"type":"claim"}))
            .is_err());
        assert!(relay.is_current(&id));
    }

    #[test]
    fn missing_or_changed_document_cannot_capture_or_receive_previous_audio() {
        let relay = PetAudioRelay::default();
        relay.set_page("owner", true, None);
        assert!(!relay.supported("owner"));
        assert!(relay.issue("owner", "legacy-no-document").is_err());
        relay.set_page("owner", true, Some("invalid"));
        assert!(!relay.supported("owner"));
        relay.set_page("owner", true, Some("00000000-0000-4000-8000-000000000001"));
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        assert!(relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000002")
            .is_err());
        assert!(relay.verify_document(&id, "00000000-0000-4000-8000-000000000001"));
        assert_eq!(
            relay
                .set_page("owner", true, Some("00000000-0000-4000-8000-000000000002"))
                .map(|identity| identity.id),
            Some(id.clone())
        );
        assert!(!relay.verify_document(&id, "00000000-0000-4000-8000-000000000001"));
        assert!(!relay.is_current(&id));
    }

    #[test]
    fn stopping_during_activation_settles_waiter_and_late_permission_cannot_reopen() {
        let relay = relay();
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        let _ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        relay.event(&id, "owner", &json!({"type":"claim"})).unwrap();
        relay
            .event(
                &id,
                "owner",
                &json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"}),
            )
            .unwrap();
        let mut active = relay.activate(&id, "owner").unwrap();
        relay.stop(Some(&id));
        assert_eq!(
            active.try_recv().unwrap(),
            Err("语音输入已停止".to_string())
        );
        for event in [
            json!({"type":"ready","sampleRate":16000,"channels":1,"format":"pcm16"}),
            json!({"type":"active"}),
            json!({"type":"audio","seq":1,"samples":[1]}),
        ] {
            assert!(relay.event(&id, "owner", &event).is_err());
        }
    }

    #[test]
    fn pet_stop_cancels_its_owned_capture_without_replaying_a_dictation_toggle() {
        let relay = relay();
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        let mut ready = relay
            .start(&id, "owner", "00000000-0000-4000-8000-000000000001")
            .unwrap();
        assert_eq!(relay.stop_in_context("other-owner"), None);
        assert!(relay.is_current(&id));
        assert_eq!(
            relay.stop_in_context("owner").map(|identity| identity.id),
            Some(id.clone())
        );
        assert_eq!(ready.try_recv().unwrap(), Err("语音输入已停止".to_string()));
        assert!(!relay.is_current(&id));
        assert_eq!(relay.stop_in_context("owner"), None);
        assert!(relay.event(&id, "owner", &json!({"type":"claim"})).is_err());
    }

    #[test]
    fn watchdog_bounds_authorization_idle_audio_and_unacknowledged_delivery() {
        let relay = relay();
        let (id, _) = relay.issue("owner", "pet-click").unwrap();
        relay.state.lock().unwrap().lease.as_mut().unwrap().created =
            Instant::now() - START_TIMEOUT;
        assert!(relay.expired_reason(&id).unwrap().contains("准备超时"));
        relay.stop(Some(&id));
        let id = active(&relay);
        relay
            .state
            .lock()
            .unwrap()
            .lease
            .as_mut()
            .unwrap()
            .last_audio = Instant::now() - AUDIO_IDLE_TIMEOUT;
        assert!(relay.expired_reason(&id).unwrap().contains("采集已中断"));
        relay
            .state
            .lock()
            .unwrap()
            .lease
            .as_mut()
            .unwrap()
            .last_audio = Instant::now();
        relay
            .event(&id, "owner", &json!({"type":"audio","seq":1,"samples":[1]}))
            .unwrap();
        relay.state.lock().unwrap().lease.as_mut().unwrap().pending[0].1 =
            Instant::now() - ACK_TIMEOUT;
        assert!(relay.expired_reason(&id).unwrap().contains("没有响应"));
        relay.acknowledge(&id, "owner", 1).unwrap();
        assert_eq!(relay.expired_reason(&id), None);
    }
}
