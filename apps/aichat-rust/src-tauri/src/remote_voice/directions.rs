//! RC003 direction changes have their own bounded queue. They never consume
//! dictation's Home/Clear taps or the remote settings window's diagram events.
use super::{platform, shared_listener};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;
use tokio::sync::broadcast;

#[derive(Clone, Default)]
pub(crate) struct Directions {
    pub(crate) keys: Vec<String>,
    pub(crate) revision: u64,
    conflicted: bool,
    revoked: bool,
}

impl Directions {
    fn update(&mut self, keys: &[String]) -> bool {
        let directions: Vec<_> = keys
            .iter()
            .filter(|k| matches!(k.as_str(), "up" | "down" | "left" | "right"))
            .cloned()
            .collect();
        if directions == self.keys {
            return false;
        }
        self.conflicted = directions.len() > 1 || (self.conflicted && !directions.is_empty());
        self.keys = directions;
        self.revision += 1;
        true
    }

    pub(crate) fn permits(&self, direction: &str) -> bool {
        !self.revoked && !self.conflicted && self.keys.len() == 1 && self.keys[0] == direction
    }
}

struct Feed {
    state: Mutex<Directions>,
    sender: broadcast::Sender<(Instant, Directions)>,
}

static ACTIVE: Mutex<Weak<Feed>> = Mutex::new(Weak::new());

pub(super) fn record(keys: &[String]) {
    if let Some(feed) = ACTIVE.lock().unwrap().upgrade() {
        let mut state = feed.state.lock().unwrap();
        if state.update(keys) {
            let _ = feed.sender.send((Instant::now(), state.clone()));
        }
    }
}

pub(in super::super) fn source_changed() {
    if let Some(feed) = ACTIVE.lock().unwrap().upgrade() {
        let mut state = feed.state.lock().unwrap();
        state.revoked = true;
        let _ = feed.sender.send((Instant::now(), state.clone()));
    }
}

pub(crate) struct DirectionReader {
    listener: Arc<platform::Listener>,
    feed: Arc<Feed>,
    pub(crate) device: String,
}

type Edges = broadcast::Receiver<(Instant, Directions)>;

impl DirectionReader {
    #[cfg(windows)]
    pub(crate) fn matches_voice_source(&self, source: &str) -> bool {
        self.listener.matches_voice_source(source)
    }
    pub(crate) fn open() -> Result<(Self, Edges), String> {
        let listener = shared_listener().map_err(|error| format!("无法读取遥控方向键。{error}"))?;
        let (sender, edges) = broadcast::channel(32);
        let feed = Arc::new(Feed {
            state: Mutex::new(Directions::default()),
            sender,
        });
        // Install before sampling. Any change during startup makes the caller
        // release and retry instead of replaying a key held at registration.
        *ACTIVE.lock().unwrap() = Arc::downgrade(&feed);
        let status = platform::status(&listener);
        if !status.ready || status.device.is_empty() {
            return Err(
                "未找到可用的唯一 RC003 蓝牙遥控器。请检查配对和输入监控权限，然后重试。".into(),
            );
        }
        if !platform::directions_released(&listener) || !edges.is_empty() {
            return Err("请只连接一只 RC003，松开全部方向键，再重新启用。".into());
        }
        Ok((
            Self {
                device: status.device,
                listener,
                feed,
            },
            edges,
        ))
    }

    pub(crate) fn state(&self) -> Result<Directions, String> {
        let status = platform::status(&self.listener);
        let state = self.feed.state.lock().unwrap().clone();
        if state.revoked || !status.ready || status.device != self.device {
            return Err("遥控器已断开或按键来源已变化，请重新启用。".into());
        }
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_directions_require_full_release_before_another_move() {
        let mut state = Directions::default();
        let keys = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        state.update(&keys(&["voice", "up"]));
        assert!(state.permits("up"));
        assert!(!state.update(&keys(&["up"])));
        state.update(&keys(&["left", "up"]));
        state.update(&keys(&["left"]));
        assert!(!state.permits("left"));
        state.update(&[]);
        state.update(&keys(&["left"]));
        assert!(state.permits("left"));
        state.revoked = true;
        assert!(!state.permits("left"));
    }
}
