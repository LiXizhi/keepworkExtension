use super::{trusted_page, Control};
use crate::remote_voice::asr::SpeechConnection;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tauri::{ipc::{Channel, JavaScriptChannelId}, Webview, WebviewWindow};
use tokio::sync::{mpsc, watch};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::app) enum Request {
    Start { id: String },
    Audio { id: String, samples: Vec<i16> },
    Stop { id: String },
    Cancel { id: String },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event {
    Preview { text: String },
    Done { text: String },
    Error { message: String },
}

struct Active {
    id: String,
    lifetime: watch::Receiver<()>,
    audio: Option<mpsc::Sender<Vec<i16>>>,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
pub(super) struct Sessions {
    active: Option<Active>,
    cancelled: VecDeque<String>,
}

impl Sessions {
    fn begin(
        &mut self,
        id: String,
        lifetime: watch::Receiver<()>,
    ) -> Result<(mpsc::Receiver<Vec<i16>>, watch::Receiver<bool>), String> {
        if self.active.is_some() {
            return Err("上一段语音输入尚未结束。".into());
        }
        if let Some(index) = self.cancelled.iter().position(|cancelled| cancelled == &id) {
            self.cancelled.remove(index);
            return Err("语音输入已停止。".into());
        }
        let (audio, receive) = mpsc::channel(8);
        let (cancel, cancelled) = watch::channel(false);
        self.active = Some(Active {
            id,
            lifetime,
            audio: Some(audio),
            cancel,
        });
        Ok((receive, cancelled))
    }

    fn audio(&mut self, id: &str, samples: &[i16]) -> Result<mpsc::Sender<Vec<i16>>, String> {
        if samples.is_empty() || samples.len() > 4096 {
            return Err("麦克风音频块无效，请重新语音输入。".into());
        }
        self.active
            .as_mut()
            .filter(|active| active.id == id)
            .and_then(|active| active.audio.clone())
            .ok_or("这段语音输入已结束，请重新开始。".into())
    }

    fn finish(&mut self, id: &str, cancel: bool) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.id == id)
        {
            if cancel {
                if let Some(active) = self.active.take() {
                    active.cancel.send_replace(true);
                }
            } else if let Some(active) = self.active.as_mut() {
                active.audio.take();
            }
            return;
        }
        if cancel && !self.cancelled.iter().any(|cancelled| cancelled == id) {
            if self.cancelled.len() == 32 {
                self.cancelled.pop_front();
            }
            self.cancelled.push_back(id.to_owned());
        }
    }

    fn complete(&mut self, id: &str) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.id == id)
        {
            self.active.take();
        }
    }

    pub(super) fn revoke_window(&mut self, lifetime: &watch::Receiver<()>) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.lifetime.same_channel(lifetime))
        {
            if let Some(mut active) = self.active.take() {
                active.audio.take();
                active.cancel.send_replace(true);
            }
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[tauri::command]
pub(in crate::app) async fn bumi_voice_input(
    window: WebviewWindow,
    webview: Webview,
    control: tauri::State<'_, Arc<Control>>,
    request: Request,
    events: Option<JavaScriptChannelId>,
) -> Result<(), String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能在 Bumi 控制窗口使用语音输入。".into());
    }
    let id = match &request {
        Request::Start { id }
        | Request::Audio { id, .. }
        | Request::Stop { id }
        | Request::Cancel { id } => id,
    };
    if !valid_id(id) {
        return Err("语音输入请求 ID 无效。".into());
    }
    match request {
        Request::Audio { id, samples } => {
            let audio = control.voice_input.lock().unwrap().audio(&id, &samples)?;
            audio
                .send(samples)
                .await
                .map_err(|_| "这段语音输入已结束，请重新开始。".into())
        }
        Request::Stop { id } => {
            control.voice_input.lock().unwrap().finish(&id, false);
            Ok(())
        }
        Request::Cancel { id } => {
            control.voice_input.lock().unwrap().finish(&id, true);
            Ok(())
        }
        Request::Start { id } => {
            if !window.is_focused().unwrap_or(false) || !window.is_visible().unwrap_or(false) {
                return Err("请先显示并激活 Bumi 控制窗口。".into());
            }
            let lifetime = control
                .window
                .lock()
                .unwrap()
                .as_ref()
                .ok_or("Bumi 控制窗口已关闭。")?
                .subscribe();
            let (audio, cancelled) = control
                .voice_input
                .lock()
                .unwrap()
                .begin(id.clone(), lifetime.clone())?;
            let events = events.ok_or("缺少语音识别事件通道。")?.channel_on(webview);
            let core = control.inner().clone();
            tauri::async_runtime::spawn(async move {
                recognize(core, id, audio, events, cancelled, lifetime).await;
            });
            Ok(())
        }
    }
}

async fn recognize(
    control: Arc<Control>,
    id: String,
    audio: mpsc::Receiver<Vec<i16>>,
    events: Channel<Event>,
    cancelled: watch::Receiver<bool>,
    mut lifetime: watch::Receiver<()>,
) {
    let previews = events.clone();
    let speech = SpeechConnection::default();
    let recognition = speech.transcribe(audio, cancelled, move |text| {
        let _ = previews.send(Event::Preview { text: text.to_owned() });
    });
    tokio::pin!(recognition);
    let result = tokio::select! {
        biased;
        _ = lifetime.changed() => Err("Bumi 控制窗口已关闭，语音输入已停止。".into()),
        result = &mut recognition => result,
    };
    control.voice_input.lock().unwrap().complete(&id);
    let event = match result {
        Ok(text) => Event::Done { text },
        Err(message) => Event::Error { message },
    };
    let _ = events.send(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_start_wins_and_cannot_cancel_a_later_turn() {
        let (_window, lifetime) = watch::channel(());
        let mut sessions = Sessions::default();
        sessions.finish("first", true);
        assert!(sessions.begin("first".into(), lifetime.clone()).is_err());
        let (_audio, cancelled) = sessions.begin("second".into(), lifetime).unwrap();
        assert!(!*cancelled.borrow());
        sessions.finish("first", true);
        assert!(!*cancelled.borrow());
        assert!(sessions.audio("second", &[1]).is_ok());
        sessions.finish("second", false);
        assert!(sessions.audio("second", &[1]).is_err());
        sessions.complete("second");
        assert!(sessions.active.is_none());
    }

    #[test]
    fn stopping_closes_audio_after_an_inflight_chunk() {
        let (_window, lifetime) = watch::channel(());
        let mut sessions = Sessions::default();
        let (mut receive, _) = sessions.begin("voice".into(), lifetime).unwrap();
        let sender = sessions.audio("voice", &[7]).unwrap();
        sessions.finish("voice", false);
        sender.try_send(vec![7]).unwrap();
        drop(sender);
        assert_eq!(receive.try_recv().unwrap(), vec![7]);
        assert!(receive.try_recv().is_err());
    }

    #[test]
    fn closing_the_owning_window_cancels_only_its_capture() {
        let (_window, lifetime) = watch::channel(());
        let (_other_window, other_lifetime) = watch::channel(());
        let mut sessions = Sessions::default();
        let (_audio, cancelled) = sessions.begin("voice".into(), lifetime.clone()).unwrap();
        sessions.revoke_window(&other_lifetime);
        assert!(!*cancelled.borrow());
        sessions.revoke_window(&lifetime);
        assert!(*cancelled.borrow());
        assert!(sessions.active.is_none());
    }

    #[test]
    fn request_ids_and_audio_chunks_are_bounded() {
        for valid in ["abc-123", "voice_1"] {
            assert!(valid_id(valid));
        }
        for invalid in ["", "with space", "中文", "a/b"] {
            assert!(!valid_id(invalid));
        }
        assert!(!valid_id(&"a".repeat(65)));
        let (_window, lifetime) = watch::channel(());
        let mut sessions = Sessions::default();
        let (_audio, _) = sessions.begin("voice".into(), lifetime).unwrap();
        assert!(sessions.audio("voice", &[]).is_err());
        assert!(sessions.audio("voice", &vec![0; 4097]).is_err());
    }
}
