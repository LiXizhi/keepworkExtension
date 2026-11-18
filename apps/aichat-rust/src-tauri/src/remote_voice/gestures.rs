//! ATVV can report both a key-down and a stream-start for one physical press.
use std::time::{Duration, Instant};

const TAP: Duration = Duration::from_millis(300);
const GAP: Duration = Duration::from_millis(400);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Press {
    Dictate,
    Second,
    DialogueRecord,
    Duplicate,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Release {
    Tap,
    Enter,
    Dictation,
    Consumed,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Edge {
    Down(Press),
    Up(Release),
    Other,
}

#[derive(Default)]
pub(super) struct RecordGesture {
    down: Option<(Instant, bool, bool)>,
    first: Option<Instant>,
}
impl RecordGesture {
    pub(super) fn control(&mut self, data: &[u8], now: Instant, dialogue: bool) -> Edge {
        if data.len() > 256 {
            return Edge::Other;
        }
        match data {
            [0x08 | 0x10, ..] | [0x04 | 0x11, _, 2, _, ..] => Edge::Down(self.down(now, dialogue)),
            [0x00 | 0x13, ..] => Edge::Up(self.up(now)),
            _ => Edge::Other,
        }
    }
    pub(super) fn down(&mut self, now: Instant, dialogue: bool) -> Press {
        if self.down.is_some() {
            return Press::Duplicate;
        }
        let second = self
            .first
            .take()
            .is_some_and(|up| now.duration_since(up) <= GAP);
        self.down = Some((now, second, dialogue));
        if dialogue {
            Press::DialogueRecord
        } else if second {
            Press::Second
        } else {
            Press::Dictate
        }
    }
    pub(super) fn up(&mut self, now: Instant) -> Release {
        let Some((down, second, consumed)) = self.down.take() else {
            return Release::Consumed;
        };
        if consumed {
            return Release::Consumed;
        }
        if now.duration_since(down) > TAP {
            return Release::Dictation;
        }
        if second {
            return Release::Enter;
        }
        self.first = Some(now);
        Release::Tap
    }
    pub(super) fn defer_result(&self, now: Instant) -> bool {
        self.first.is_some_and(|up| now.duration_since(up) <= GAP)
    }
}
