//! A visual cue for ordinary dictation. System paste still uses the current focus at delivery.
use super::{RecordingFeedback, RecordingPhase};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "windows")]
#[path = "highlight_windows.rs"]
mod platform;

#[cfg(target_os = "macos")]
mod platform {
    extern "C" {
        fn keepwork_voice_highlight_start(id: u64);
        fn keepwork_voice_highlight_transcribing(id: u64);
        fn keepwork_voice_highlight_end(id: u64);
        fn keepwork_voice_highlight_preview(id: u64, bytes: *const u8, length: usize);
    }

    pub(super) fn start(id: u64) {
        unsafe { keepwork_voice_highlight_start(id) }
    }

    pub(super) fn preview(id: u64, text: &str) {
        unsafe { keepwork_voice_highlight_preview(id, text.as_ptr(), text.len()) }
    }

    pub(super) fn end(id: u64) {
        unsafe { keepwork_voice_highlight_end(id) }
    }

    pub(super) fn transcribing(id: u64) {
        unsafe { keepwork_voice_highlight_transcribing(id) }
    }
}

pub(super) fn start() -> RecordingFeedback {
    static NEXT_PRESS: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_PRESS.fetch_add(1, Ordering::Relaxed);
    platform::start(id);
    RecordingFeedback {
        focus: None,
        notify: Box::new(move |phase| match phase {
            RecordingPhase::Recording => {}
            RecordingPhase::Preview(text) => platform::preview(id, super::preview_tail(&text)),
            RecordingPhase::Transcribing => platform::transcribing(id),
            RecordingPhase::End => platform::end(id),
        }),
    }
}
