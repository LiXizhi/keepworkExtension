//! RC003 movement controls have their own bounded queue. A capture can claim
//! the Menu button for Bumi while dictation keeps receiving its other keys.
use super::{platform, shared_listener};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;
use tokio::sync::broadcast;

#[derive(Clone, Default)]
pub(crate) struct Directions {
    pub(crate) keys: Vec<String>,
    pub(crate) revision: u64,
    pub(crate) strafe: bool,
    menu_switch: bool,
    conflicted: bool,
    revoked: bool,
}

impl Directions {
    fn update(&mut self, keys: &[String]) -> bool {
        let directions: Vec<_> = keys
            .iter()
            .filter(|k| {
                matches!(k.as_str(), "up" | "down" | "left" | "right")
                    || (self.menu_switch && k.as_str() == "menu")
            })
            .cloned()
            .collect();
        if directions == self.keys {
            return false;
        }
        self.conflicted = directions.len() > 1 || (self.conflicted && !directions.is_empty());
        if self.keys.is_empty() && keys.len() == 1 && directions == ["menu"] {
            self.strafe = !self.strafe;
        }
        self.keys = directions;
        self.revision += 1;
        true
    }

    pub(crate) fn permits(&self, direction: &str) -> bool {
        !self.revoked
            && !self.conflicted
            && self.keys.len() == 1
            && self.keys[0] == direction
            && direction != "menu"
    }
}

struct Feed {
    state: Mutex<Directions>,
    sender: broadcast::Sender<(Instant, Directions)>,
}

static ACTIVE: Mutex<Weak<Feed>> = Mutex::new(Weak::new());

/// Returns whether this report belongs to a capture that owns the Menu key.
pub(super) fn record(keys: &[String]) -> bool {
    if let Some(feed) = ACTIVE.lock().unwrap().upgrade() {
        let mut state = feed.state.lock().unwrap();
        if state.update(keys) {
            let _ = feed.sender.send((Instant::now(), state.clone()));
        }
        return state.menu_switch && !state.revoked;
    }
    false
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
    pub(crate) fn open(menu_switch: bool) -> Result<(Self, Edges), String> {
        let listener = shared_listener().map_err(|error| format!("无法读取遥控方向键。{error}"))?;
        let (sender, edges) = broadcast::channel(32);
        let feed = Arc::new(Feed {
            state: Mutex::new(Directions {
                menu_switch,
                ..Directions::default()
            }),
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
        if !platform::directions_released(&listener, menu_switch) || !edges.is_empty() {
            let buttons = if menu_switch {
                "方向键和菜单键"
            } else {
                "方向键"
            };
            return Err(format!(
                "请只连接一只 RC003，松开全部{buttons}，再重新启用。"
            ));
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

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn menu_switches_once_per_press_only_when_requested() {
        let mut state = Directions {
            menu_switch: true,
            ..Directions::default()
        };
        let menu = keys(&["menu"]);
        assert!(!state.strafe);
        assert!(state.update(&menu));
        assert!(state.strafe);
        assert!(!state.permits("menu"));
        assert!(!state.update(&menu));
        assert!(state.update(&[]));
        assert!(state.strafe);
        assert!(state.update(&menu));
        assert!(!state.strafe);
        assert_eq!(state.revision, 3);

        let mut legacy = Directions::default();
        assert!(!legacy.update(&menu));
        assert!(legacy.update(&keys(&["menu", "left"])));
        assert!(legacy.permits("left"));
        assert!(!legacy.strafe);
    }

    #[test]
    fn menu_direction_chords_block_motion_until_all_controls_are_released() {
        for remaining in ["left", "menu"] {
            let left = keys(&["left"]);
            let mut state = Directions {
                menu_switch: true,
                ..Directions::default()
            };
            state.update(&left);
            assert!(state.permits("left"));
            state.update(&keys(&["menu", "left"]));
            assert!(!state.permits("left"));
            state.update(&keys(&[remaining]));
            assert!(!state.permits(remaining));
            assert!(!state.strafe);
            state.update(&[]);
            state.update(&left);
            assert!(state.permits("left"));
        }
    }

    #[test]
    fn simultaneous_directions_require_full_release_before_another_move() {
        let mut state = Directions::default();
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
