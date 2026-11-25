//! A connection owns its notification reader, including during GATT writes.
//! Never carry a partial stream or pending microphone command across reconnects.
use super::{Caps, Failure, AUDIO, CONTROL};
use btleplug::api::ValueNotification;
use futures_util::{Stream, StreamExt};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::{sync::mpsc, task::JoinHandle};

const MAX_EVENTS: usize = 1024;
const MAX_PACKET_BYTES: usize = 8192;
const MAX_STARTUP_BYTES: usize = 256 * 1024;

fn overrun() -> Failure {
    Failure::temporary("遥控器音频接收积压，无法确认本次录音完整。请在重新连接后按住语音键重试。")
}

pub(super) struct TimedNotification {
    pub packet: ValueNotification,
    pub at: Instant,
}

pub(super) struct NotificationInbox {
    receiver: mpsc::Receiver<TimedNotification>,
    reader: JoinHandle<()>,
    overflow: Arc<AtomicBool>,
}

impl NotificationInbox {
    pub fn new(stream: impl Stream<Item = ValueNotification> + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::channel(MAX_EVENTS);
        let overflow = Arc::new(AtomicBool::new(false));
        let failed = overflow.clone();
        let reader = tokio::spawn(async move {
            tokio::pin!(stream);
            while let Some(packet) = stream.next().await {
                if packet.service_uuid != super::SERVICE
                    || (packet.uuid != CONTROL && packet.uuid != AUDIO)
                {
                    continue;
                }
                if packet.value.len() > MAX_PACKET_BYTES
                    || sender
                        .try_send(TimedNotification {
                            packet,
                            at: Instant::now(),
                        })
                        .is_err()
                {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        });
        Self {
            receiver,
            reader,
            overflow,
        }
    }

    // Inspect already received controls before writing MIC_OPEN. A released press
    // can still supply its captured audio, but must never reopen the hardware.
    pub fn drain_available(&mut self, queue: &mut StartupQueue) -> Result<(), Failure> {
        while let Ok(item) = self.receiver.try_recv() {
            queue.push(item)?;
        }
        if self.overflow.load(Ordering::Acquire) {
            return Err(overrun());
        }
        Ok(())
    }

    pub async fn next(&mut self) -> Result<TimedNotification, Failure> {
        let item = self.receiver.recv().await;
        if self.overflow.load(Ordering::Acquire) {
            return Err(overrun());
        }
        item.ok_or_else(|| Failure::temporary("遥控器音频连接已结束。"))
    }
}

impl Drop for NotificationInbox {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

#[derive(Default)]
pub(super) struct StartupQueue {
    items: VecDeque<TimedNotification>,
    bytes: usize,
}

impl StartupQueue {
    pub fn push(&mut self, item: TimedNotification) -> Result<(), Failure> {
        let size = item.packet.value.len();
        if self.items.len() >= MAX_EVENTS || size > MAX_STARTUP_BYTES - self.bytes {
            return Err(overrun());
        }
        self.bytes += size;
        self.items.push_back(item);
        Ok(())
    }
    pub fn pop(&mut self) -> Option<TimedNotification> {
        let item = self.items.pop_front()?;
        self.bytes -= item.packet.value.len();
        Some(item)
    }
    pub fn mic_open_obsolete(&self) -> bool {
        self.items.iter().any(|item| {
            item.packet.uuid == CONTROL
                && matches!(item.packet.value.first(), Some(0x00 | 0x13 | 0x04 | 0x11))
        })
    }
}

pub(super) async fn negotiate(
    inbox: &mut NotificationInbox,
    setup: impl std::future::Future<Output = Result<(), Failure>>,
    mut on_first_press: impl FnMut(Instant),
) -> Result<(Caps, StartupQueue), Failure> {
    tokio::pin!(setup);
    let mut caps = None;
    let mut configured = false;
    let mut first_press = true;
    let mut queue = StartupQueue::default();
    let response_timeout = tokio::time::sleep(std::time::Duration::from_secs(5));
    tokio::pin!(response_timeout);
    loop {
        tokio::select! {
            biased;
            result = &mut setup, if !configured => {
                result?;
                configured = true;
                response_timeout.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_secs(5));
            }
            _ = &mut response_timeout, if configured => {
                return Err(Failure::temporary("ATVV 能力协商超时，请唤醒遥控器后重试。"));
            }
            received = inbox.next() => {
                let received = received?;
                let packet = &received.packet;
                if packet.uuid == CONTROL && packet.value.first() == Some(&0x0b) {
                    caps = Some(Caps::parse(&packet.value).map_err(|message| Failure::permanent(&message))?);
                } else {
                    if first_press && packet.uuid == CONTROL && packet.value.len() <= 256 &&
                        matches!(packet.value.as_slice(), [0x08 | 0x10, ..] | [0x04 | 0x11, _, 2, _, ..]) {
                        on_first_press(received.at);
                        first_press = false;
                    }
                    queue.push(received)?;
                }
            }
        }
        if configured {
            if let Some(caps) = caps {
                return Ok((caps, queue));
            }
        }
    }
}
