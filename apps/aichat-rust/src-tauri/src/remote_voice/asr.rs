//! Keepwork's shared `/speech` contract, implemented without a JS runtime.
//!
//! Mirrors keepworksdk SpeechRTC.transport: wait for `ready`, send binary
//! PCM16LE, then `asr_end`, and use the latest cumulative ASR text at `done`.
//! The proxy supplies its own credentials; this client stores no API key.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

#[path = "asr_connect.rs"]
mod connect;

const ENDPOINT: &str = "wss://speechrtc.keepwork.com/speech?asr_format=pcm&asr_rate=16000";
const MAX_SAMPLES: usize = 16_000 * 600;
const CHUNK_SAMPLES: usize = 3200;
const MAX_TEXT: usize = 16000;
const MAX_MESSAGES: usize = 4096;
const CANCELLED: &str = "语音输入已停止。";
const CLOSED: &str = "云端语音连接已中断；本段录音不会自动重传，请重新按住语音键。";

#[derive(Clone, Copy)]
struct Deadlines {
    connect: Duration,
    ready: Duration,
    upload: Duration,
    result: Duration,
}
impl Default for Deadlines {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            ready: Duration::from_secs(15),
            upload: Duration::from_secs(30),
            result: Duration::from_secs(30),
        }
    }
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return; // The owning native session disappeared.
        }
    }
}

#[derive(Debug, PartialEq)]
enum Event {
    Ready,
    Asr { text: Option<String>, done: bool },
    Other,
}

fn event(message: Message) -> Result<Event, String> {
    let Message::Text(text) = message else {
        return match message {
            Message::Close(_) => Err(CLOSED.into()),
            _ => Ok(Event::Other), // WebSocket ping/pong and optional shared TTS audio.
        };
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| "云端语音响应格式无效；本段录音不会自动重传。".to_string())?;
    match value["type"].as_str() {
        Some("ready") => Ok(Event::Ready),
        Some("error") => {
            Err("云端语音识别失败；请检查网络或稍后重试，本段录音不会自动重传。".into())
        }
        Some("asr") => {
            if value["event"].as_str() == Some("error") || value["ok"].as_bool() == Some(false) {
                return Err("云端语音识别失败；本段录音不会自动重传，请稍后重试。".into());
            }
            let text = match value.get("text") {
                None | Some(Value::Null) => None,
                Some(Value::String(text)) if text.chars().count() <= MAX_TEXT => Some(text.clone()),
                _ => return Err("云端语音识别结果格式或长度无效。".into()),
            };
            Ok(Event::Asr {
                text,
                done: value["event"].as_str() == Some("done"),
            })
        }
        _ => Ok(Event::Other), // Additive server fields/events remain compatible.
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Connected {
    socket: Socket,
    opened: Instant,
}

// Same idle and lifetime defaults as keepworksdk SpeechRTC.transport.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_LIFETIME: Duration = Duration::from_secs(600);
type Checkout = tokio::sync::oneshot::Sender<Connected>;

#[derive(Default)]
pub(crate) struct SpeechConnection {
    // A physical remote has one active utterance. No other press can borrow its connection.
    active: tokio::sync::Mutex<()>,
    idle: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Checkout>>>,
}

impl SpeechConnection {
    pub(crate) async fn transcribe(
        &self,
        audio: tokio::sync::mpsc::Receiver<Vec<i16>>,
        cancel: watch::Receiver<bool>,
        preview: impl FnMut(&str),
    ) -> Result<String, String> {
        self.transcribe_to(audio, cancel, preview, ENDPOINT, Deadlines::default())
            .await
    }

    async fn transcribe_to(
        &self,
        audio: tokio::sync::mpsc::Receiver<Vec<i16>>,
        mut cancel: watch::Receiver<bool>,
        preview: impl FnMut(&str),
        endpoint: &str,
        deadlines: Deadlines,
    ) -> Result<String, String> {
        let _active = self
            .active
            .try_lock()
            .map_err(|_| "遥控器语音识别正在进行。".to_owned())?;
        let work = async {
            let mut connected = match self.take_idle().await {
                Some(connection) => connection,
                None => connect_ready(endpoint, deadlines).await?,
            };
            let text = stream_press(&mut connected.socket, audio, preview, deadlines).await?;
            // Only a completed asr_end/done round trip may re-enter the pool.
            self.park(connected);
            Ok(text)
        };
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => Err(CANCELLED.into()),
            result = work => result,
        }
    }

    async fn take_idle(&self) -> Option<Connected> {
        let checkout = self.idle.lock().unwrap().take()?;
        let (reply, socket) = tokio::sync::oneshot::channel();
        checkout.send(reply).ok()?;
        socket.await.ok()
    }

    fn park(&self, mut connection: Connected) {
        let expires = (connection.opened + MAX_LIFETIME).min(Instant::now() + IDLE_TIMEOUT);
        if expires <= Instant::now() {
            return;
        }
        let (checkout, mut request) = tokio::sync::oneshot::channel::<Checkout>();
        *self.idle.lock().unwrap() = Some(checkout);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = sleep_until(expires) => break,
                    // Consume a queued peer close or stale ASR before another press gets this socket.
                    incoming = connection.socket.next() => {
                        let Some(Ok(message)) = incoming else { break; };
                        if !matches!(event(message), Ok(Event::Other)) { break; }
                    },
                    checkout = &mut request => {
                        if let Ok(reply) = checkout { let _ = reply.send(connection); }
                        return;
                    }
                }
            }
            let _ = timeout(Duration::from_secs(1), connection.socket.close(None)).await;
        });
    }
}

async fn connect_ready(endpoint: &str, deadlines: Deadlines) -> Result<Connected, String> {
    let config = WebSocketConfig {
        write_buffer_size: 8192,
        max_write_buffer_size: 65536,
        max_message_size: Some(65536),
        max_frame_size: Some(65536),
        ..Default::default()
    };
    let (mut socket, _) = timeout(
        deadlines.connect,
        connect::websocket(endpoint, config),
    )
    .await
    .map_err(|_| "连接云端语音服务超时，请检查网络后重试。".to_string())?
    .map_err(|_| "无法连接 Keepwork 云端语音服务，请检查网络后重试。".to_string())?;
    let opened = Instant::now();
    let ready = async {
        for _ in 0..MAX_MESSAGES {
            let message = socket
                .next()
                .await
                .ok_or_else(|| CLOSED.to_string())?
                .map_err(|_| CLOSED.to_string())?;
            match event(message)? {
                Event::Ready => return Ok(Connected { socket, opened }),
                Event::Other => {}
                Event::Asr { .. } => return Err("云端语音服务尚未就绪便返回了识别结果。".into()),
            }
        }
        Err("云端语音响应数量超出限制。".into())
    };
    timeout(deadlines.ready, ready)
        .await
        .map_err(|_| "云端语音服务未及时就绪，请稍后重试。".to_owned())?
}

async fn stream_press(
    socket: &mut Socket,
    mut audio: tokio::sync::mpsc::Receiver<Vec<i16>>,
    mut preview: impl FnMut(&str),
    deadlines: Deadlines,
) -> Result<String, String> {
    let (mut output, mut input) = socket.split();
    let upload = async {
        let mut samples = 0;
        while let Some(frame) = audio.recv().await {
            samples += frame.len();
            if samples > MAX_SAMPLES {
                return Err("单次语音输入不能超过 10 分钟。".to_owned());
            }
            for chunk in frame.chunks(CHUNK_SAMPLES) {
                let bytes = chunk
                    .iter()
                    .flat_map(|sample| sample.to_le_bytes())
                    .collect();
                timeout(deadlines.upload, output.send(Message::Binary(bytes)))
                    .await
                    .map_err(|_| "语音上传超时；本次录音不会自动重传。".to_owned())?
                    .map_err(|_| CLOSED.to_owned())?;
            }
        }
        timeout(
            deadlines.upload,
            output.send(Message::Text(r#"{"type":"asr_end"}"#.into())),
        )
        .await
        .map_err(|_| "语音上传超时；本次录音不会自动重传。".to_owned())?
        .map_err(|_| CLOSED.to_owned())
    };
    tokio::pin!(upload);
    let deadline = tokio::time::sleep(deadlines.result);
    tokio::pin!(deadline);
    let mut ended = false;
    let mut transcript = String::new();
    let mut messages = 0;
    loop {
        tokio::select! {
            biased;
            _ = &mut deadline, if ended => return Err("云端语音识别结果等待超时；本次录音不会自动重传。".into()),
            result = &mut upload, if !ended => {
                result?;
                ended = true;
                deadline.as_mut().reset(Instant::now() + deadlines.result);
            }
            incoming = input.next() => {
                messages += 1;
                if messages > MAX_MESSAGES { return Err("云端语音响应数量超出限制。".into()); }
                let message = incoming.ok_or_else(|| CLOSED.to_string())?.map_err(|_| CLOSED.to_string())?;
                if let Event::Asr { text, done } = event(message)? {
                    if let Some(text) = text {
                        if !done && text != transcript { preview(&text); }
                        transcript = text;
                    }
                    if done {
                        if !ended { return Err("云端语音服务提前结束，录音未完整上传；不会自动重传。".into()); }
                        return Ok(transcript.trim().to_owned());
                    }
                }
            }
        }
    }
}

// Feed an already captured fixture into the same live transport used by the BLE receiver.
#[cfg(test)]
async fn transcribe_to(
    pcm: &[i16],
    cancel: watch::Receiver<bool>,
    endpoint: &str,
    deadlines: Deadlines,
) -> Result<String, String> {
    if pcm.is_empty() {
        return Ok(String::new());
    }
    if pcm.len() > MAX_SAMPLES {
        return Err("单次语音输入不能超过 10 分钟。".into());
    }
    let (send, audio) = tokio::sync::mpsc::channel(1);
    send.try_send(pcm.to_vec()).unwrap();
    drop(send);
    SpeechConnection::default()
        .transcribe_to(audio, cancel, |_| {}, endpoint, deadlines)
        .await
}

#[cfg(test)]
pub(super) async fn transcribe_fixture(
    pcm: &[i16],
    cancel: watch::Receiver<bool>,
    endpoint: &str,
) -> Result<String, String> {
    transcribe_to(
        pcm,
        cancel,
        endpoint,
        Deadlines {
            connect: Duration::from_secs(2),
            ready: Duration::from_secs(2),
            upload: Duration::from_secs(2),
            result: Duration::from_secs(2),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{accept_async, accept_hdr_async, WebSocketStream};

    fn short_deadlines() -> Deadlines {
        Deadlines {
            connect: Duration::from_secs(2),
            ready: Duration::from_secs(2),
            upload: Duration::from_secs(2),
            result: Duration::from_secs(2),
        }
    }
    async fn fixture() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/speech?asr_format=pcm&asr_rate=16000",
            listener.local_addr().unwrap()
        );
        (listener, url)
    }
    async fn receive_audio_end(socket: &mut WebSocketStream<TcpStream>) -> Vec<u8> {
        let mut audio = Vec::new();
        while let Some(message) = socket.next().await {
            match message.unwrap() {
                Message::Binary(bytes) => {
                    assert!(bytes.len() <= CHUNK_SAMPLES * 2);
                    audio.extend(bytes);
                }
                Message::Text(text) => {
                    assert_eq!(
                        serde_json::from_str::<Value>(&text).unwrap(),
                        serde_json::json!({"type":"asr_end"})
                    );
                    return audio;
                }
                Message::Pong(_) => {}
                other => panic!("unexpected client message: {other:?}"),
            }
        }
        panic!("client closed before asr_end")
    }

    #[tokio::test]
    async fn keydown_connects_and_two_presses_stream_partials_on_one_socket() {
        let (listener, endpoint) = fixture().await;
        let (ready, first_ready) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            ready.send(()).unwrap();
            for word in ["first", "second"] {
                assert_eq!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Binary(vec![7, 0])
                );
                for text in [word, "", word] {
                    socket
                        .send(Message::Text(
                            serde_json::json!({"type":"asr","text":text}).to_string(),
                        ))
                        .await
                        .unwrap();
                }
                assert_eq!(receive_audio_end(&mut socket).await, vec![8, 0]);
                socket
                    .send(Message::Text(r#"{"type":"asr","event":"done"}"#.into()))
                    .await
                    .unwrap();
            }
        });
        let connection = SpeechConnection::default();
        let (_owner, cancel) = watch::channel(false);
        let mut first_ready = Some(first_ready);
        for word in ["first", "second"] {
            let (send, pcm) = tokio::sync::mpsc::channel(2);
            let (partial, mut revisions) = tokio::sync::mpsc::unbounded_channel();
            let input = async {
                if let Some(first) = first_ready.take() {
                    first.await.unwrap();
                }
                send.send(vec![7]).await.unwrap();
                for expected in [word, "", word] {
                    assert_eq!(revisions.recv().await.as_deref(), Some(expected));
                }
                send.send(vec![8]).await.unwrap();
                drop(send);
            };
            let (text, ()) = timeout(Duration::from_secs(3), async {
                tokio::join!(
                    connection.transcribe_to(
                        pcm,
                        cancel.clone(),
                        |s| partial.send(s.to_owned()).unwrap(),
                        &endpoint,
                        short_deadlines()
                    ),
                    input
                )
            })
            .await
            .unwrap();
            assert_eq!(text.unwrap(), word);
        }
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn single_utterance_peer_closing_after_done_reconnects_on_next_press() {
        let (listener, endpoint) = fixture().await;
        let connection = SpeechConnection::default();
        let (_owner, cancel) = watch::channel(false);
        let (retired, closed) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut retired = Some(retired);
            for expected in [1, 2] {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(tcp).await.unwrap();
                socket
                    .send(Message::Text(r#"{"type":"ready"}"#.into()))
                    .await
                    .unwrap();
                assert_eq!(receive_audio_end(&mut socket).await, vec![expected, 0]);
                socket
                    .send(Message::Text(
                        r#"{"type":"asr","event":"done","text":"ok"}"#.into(),
                    ))
                    .await
                    .unwrap();
                socket.close(None).await.unwrap();
                if let Some(retired) = retired.take() {
                    // The idle monitor consumes the peer close with no physical press active.
                    let _ = timeout(Duration::from_secs(2), socket.next())
                        .await
                        .unwrap();
                    retired.send(()).unwrap();
                }
            }
        });
        let mut closed = Some(closed);
        for sample in [1, 2] {
            let (send, audio) = tokio::sync::mpsc::channel(1);
            send.send(vec![sample]).await.unwrap();
            drop(send);
            assert_eq!(
                connection
                    .transcribe_to(audio, cancel.clone(), |_| {}, &endpoint, short_deadlines())
                    .await
                    .unwrap(),
                "ok"
            );
            if let Some(closed) = closed.take() {
                closed.await.unwrap();
            }
        }
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn early_done_revokes_socket_without_delivering_or_replaying_audio() {
        let (listener, endpoint) = fixture().await;
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut first = accept_async(tcp).await.unwrap();
            first
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            assert_eq!(
                first.next().await.unwrap().unwrap(),
                Message::Binary(vec![5, 0])
            );
            first
                .send(Message::Text(
                    r#"{"type":"asr","event":"done","text":"stale"}"#.into(),
                ))
                .await
                .unwrap();
            let (tcp, _) = listener.accept().await.unwrap();
            let mut second = accept_async(tcp).await.unwrap();
            second
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            assert_eq!(receive_audio_end(&mut second).await, vec![9, 0]);
            second
                .send(Message::Text(
                    r#"{"type":"asr","event":"done","text":"fresh"}"#.into(),
                ))
                .await
                .unwrap();
        });
        let connection = SpeechConnection::default();
        let (_owner, cancel) = watch::channel(false);
        let (held, pcm) = tokio::sync::mpsc::channel(1);
        held.send(vec![5]).await.unwrap();
        let result = connection
            .transcribe_to(pcm, cancel.clone(), |_| {}, &endpoint, short_deadlines())
            .await;
        assert!(result.unwrap_err().contains("提前结束"));
        drop(held);
        let (send, pcm) = tokio::sync::mpsc::channel(1);
        send.send(vec![9]).await.unwrap();
        drop(send);
        assert_eq!(
            connection
                .transcribe_to(pcm, cancel, |_| {}, &endpoint, short_deadlines())
                .await
                .unwrap(),
            "fresh"
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn real_websocket_fixture_uploads_pcm16le_and_uses_latest_cumulative_result() {
        let (listener, endpoint) = fixture().await;
        let request_uri = Arc::new(Mutex::new(String::new()));
        let captured = Arc::clone(&request_uri);
        let pcm: Vec<i16> = (0..10000).map(|n| (n as i16).wrapping_mul(23)).collect();
        let expected: Vec<u8> = pcm.iter().flat_map(|n| n.to_le_bytes()).collect();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(
                stream,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    *captured.lock().unwrap() = request.uri().to_string();
                    assert!(!request.headers().contains_key("authorization"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
            assert!(
                timeout(Duration::from_millis(20), socket.next())
                    .await
                    .is_err(),
                "neither PCM nor an invented asr_start may precede ready"
            );
            socket.send(Message::Text(r#"{"type":"ready","requestId":"fixture","tts":{"format":"unknown"},"future":true}"#.into())).await.unwrap();
            socket.send(Message::Ping(vec![1, 2, 3])).await.unwrap();
            assert_eq!(receive_audio_end(&mut socket).await, expected);
            for value in [
                r#"{"type":"asr","event":"result","text":"旧文字"}"#,
                r#"{"type":"future","data":true}"#,
                r#"{"type":"asr","event":"result","text":"  完整句子  ","extra":42}"#,
                r#"{"type":"asr","event":"done"}"#,
            ] {
                socket.send(Message::Text(value.into())).await.unwrap();
            }
        });
        let (_owner, cancel) = watch::channel(false);
        assert_eq!(
            transcribe_to(&pcm, cancel, &endpoint, short_deadlines())
                .await
                .unwrap(),
            "完整句子"
        );
        peer.await.unwrap();
        assert_eq!(
            &*request_uri.lock().unwrap(),
            "/speech?asr_format=pcm&asr_rate=16000"
        );
    }

    #[tokio::test]
    async fn terminal_error_does_not_reconnect_or_return_partial_text() {
        for failure in [
            r#"{"type":"error","message":"private provider detail","source":"asr"}"#,
            r#"{"type":"asr","event":"error","text":"private provider detail"}"#,
            r#"{"type":"asr","event":"done","ok":false,"text":"private provider detail"}"#,
        ] {
            let (listener, endpoint) = fixture().await;
            let peer = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                socket
                    .send(Message::Text(r#"{"type":"ready"}"#.into()))
                    .await
                    .unwrap();
                receive_audio_end(&mut socket).await;
                socket
                    .send(Message::Text(
                        r#"{"type":"asr","event":"result","text":"private partial"}"#.into(),
                    ))
                    .await
                    .unwrap();
                socket.send(Message::Text(failure.into())).await.unwrap();
                assert!(
                    timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err(),
                    "no automatic retry"
                );
            });
            let (_owner, cancel) = watch::channel(false);
            let error = transcribe_to(&[1, -1], cancel, &endpoint, short_deadlines())
                .await
                .unwrap_err();
            assert!(!error.contains("private"));
            assert!(error.contains("不会自动重传"));
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn final_empty_snapshot_clears_an_earlier_partial_transcript() {
        let (listener, endpoint) = fixture().await;
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            receive_audio_end(&mut socket).await;
            socket
                .send(Message::Text(
                    r#"{"type":"asr","event":"result","text":"old partial"}"#.into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    r#"{"type":"asr","event":"done","text":""}"#.into(),
                ))
                .await
                .unwrap();
        });
        let (_owner, cancel) = watch::channel(false);
        assert_eq!(
            transcribe_to(&[1], cancel, &endpoint, short_deadlines())
                .await
                .unwrap(),
            ""
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_pending_results_discards_the_recording_result() {
        let (listener, endpoint) = fixture().await;
        let (owner, cancel) = watch::channel(false);
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            receive_audio_end(&mut socket).await;
            owner.send(true).unwrap();
            let _ = socket
                .send(Message::Text(
                    r#"{"type":"asr","event":"done","text":"late text"}"#.into(),
                ))
                .await;
        });
        assert_eq!(
            transcribe_to(&[1, -1], cancel, &endpoint, short_deadlines())
                .await
                .unwrap_err(),
            CANCELLED
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn ready_and_final_result_have_independent_bounded_timeouts() {
        for send_ready in [false, true] {
            let (listener, endpoint) = fixture().await;
            let peer = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                if send_ready {
                    socket
                        .send(Message::Text(r#"{"type":"ready"}"#.into()))
                        .await
                        .unwrap();
                    receive_audio_end(&mut socket).await;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            });
            let (_owner, cancel) = watch::channel(false);
            let mut deadlines = short_deadlines();
            deadlines.ready = Duration::from_millis(80);
            deadlines.result = Duration::from_millis(80);
            let error = transcribe_to(&[1], cancel, &endpoint, deadlines)
                .await
                .unwrap_err();
            assert!(
                error.contains(if send_ready {
                    "等待超时"
                } else {
                    "未及时就绪"
                }),
                "{error}"
            );
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn validation_and_cancelled_ownership_do_not_open_a_socket() {
        let (_owner, cancel) = watch::channel(false);
        assert_eq!(
            transcribe_to(&[], cancel.clone(), "invalid", short_deadlines())
                .await
                .unwrap(),
            ""
        );
        assert!(transcribe_to(
            &vec![0; MAX_SAMPLES + 1],
            cancel,
            "invalid",
            short_deadlines()
        )
        .await
        .unwrap_err()
        .contains("10 分钟"));
        let (owner, cancel) = watch::channel(false);
        owner.send(true).unwrap();
        assert_eq!(
            transcribe_to(&[1], cancel, "invalid", short_deadlines())
                .await
                .unwrap_err(),
            CANCELLED
        );
        let (owner, cancel) = watch::channel(false);
        drop(owner);
        assert_eq!(
            transcribe_to(&[1], cancel, "invalid", short_deadlines())
                .await
                .unwrap_err(),
            CANCELLED
        );
    }

    #[tokio::test]
    #[ignore = "live Keepwork ASR smoke: uploads only 0.5 seconds of generated silence"]
    async fn live_keepwork_speech_accepts_synthetic_silence_without_credentials() {
        let (_owner, cancel) = watch::channel(false);
        // No microphone, Bluetooth device, user text, key or audio file is read.
        // Success proves TLS + ready + PCM + asr_end + done. Empty text is valid.
        let silence = vec![0i16; 8000];
        let text = transcribe_to(&silence, cancel, ENDPOINT, Deadlines::default())
            .await
            .expect("live Keepwork ASR smoke failed");
        assert!(text.chars().count() <= MAX_TEXT);
    }

    #[test]
    fn optional_fields_and_done_text_are_accepted_but_malformed_or_oversized_results_fail() {
        assert_eq!(
            event(Message::Text(
                r#"{"type":"asr","event":"done","text":"final","future":1}"#.into()
            ))
            .unwrap(),
            Event::Asr {
                text: Some("final".into()),
                done: true
            }
        );
        assert_eq!(
            event(Message::Text(
                r#"{"type":"asr","event":"done","text":""}"#.into()
            ))
            .unwrap(),
            Event::Asr {
                text: Some(String::new()),
                done: true
            }
        );
        assert!(event(Message::Text("not json".into())).is_err());
        assert!(event(Message::Text(r#"{"type":"asr","text":12}"#.into())).is_err());
        let oversized =
            serde_json::json!({"type":"asr","text":"中".repeat(MAX_TEXT + 1)}).to_string();
        assert!(event(Message::Text(oversized)).is_err());
        assert!(event(Message::Close(None)).is_err());
        assert_eq!(
            event(Message::Text(r#"{"type":"ready","tts":false}"#.into())).unwrap(),
            Event::Ready
        );
    }
}
