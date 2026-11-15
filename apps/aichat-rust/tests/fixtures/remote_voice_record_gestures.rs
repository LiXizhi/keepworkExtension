#[path = "../../src-tauri/src/remote_voice/gestures.rs"]
mod gestures;

use gestures::{Edge, Press, RecordGesture, Release};
use std::time::{Duration, Instant};

fn after(start: Instant, ms: u64) -> Instant {
    start + Duration::from_millis(ms)
}

#[test]
fn two_completed_short_taps_enter_once_and_discard_the_first_pending_result() {
    let mut gesture = RecordGesture::default();
    let now = Instant::now();
    assert_eq!(gesture.down(now, false), Press::Dictate);
    assert_eq!(gesture.down(after(now, 16), false), Press::Duplicate);
    assert_eq!(gesture.up(after(now, 60)), Release::Tap);
    assert!(gesture.defer_result(after(now, 61)));
    assert_eq!(gesture.down(after(now, 220), false), Press::Second);
    assert_eq!(gesture.down(after(now, 230), false), Press::Duplicate);
    assert_eq!(gesture.up(after(now, 285)), Release::Enter);
    assert!(!gesture.defer_result(after(now, 286)));
    assert_eq!(gesture.down(after(now, 360), true), Press::DialogueRecord);
    assert_eq!(gesture.up(after(now, 400)), Release::Consumed);
    assert_eq!(gesture.down(after(now, 440), false), Press::Dictate);
}

#[test]
fn slow_second_click_and_held_presses_preserve_normal_remote_audio() {
    let mut gesture = RecordGesture::default();
    let now = Instant::now();
    assert_eq!(gesture.down(now, false), Press::Dictate);
    assert_eq!(gesture.up(after(now, 600)), Release::Dictation);
    assert!(!gesture.defer_result(after(now, 610)));
    assert_eq!(gesture.down(after(now, 650), false), Press::Dictate);
    assert_eq!(gesture.up(after(now, 690)), Release::Tap);
    assert!(!gesture.defer_result(after(now, 1100)));
    assert_eq!(gesture.down(after(now, 1120), false), Press::Dictate);
    assert_eq!(gesture.up(after(now, 1170)), Release::Tap);
    assert_eq!(gesture.down(after(now, 1230), false), Press::Second);
    assert_eq!(gesture.up(after(now, 1800)), Release::Dictation);
    assert!(!gesture.defer_result(after(now, 1810)));
}

#[test]
fn packet_sequences_detect_fast_taps_before_audio_and_stream_start_only_firmware() {
    let now = Instant::now();
    for (press, start, release) in [(0x08, 0x04, 0x00), (0x10, 0x11, 0x13)] {
        let mut g = RecordGesture::default();
        assert!(matches!(g.control(&[], now, false), Edge::Other));
        assert!(matches!(g.control(&[start, 0], now, false), Edge::Other));
        assert!(matches!(
            g.control(&[start, 0, 3, 1], now, false),
            Edge::Other
        ));
        assert!(matches!(
            g.control(&[press], now, false),
            Edge::Down(Press::Dictate)
        ));
        // No STREAM_START / PCM on a sufficiently quick first press.
        assert!(matches!(
            g.control(&[release], after(now, 45), false),
            Edge::Up(Release::Tap)
        ));
        assert!(g.defer_result(after(now, 46)));
        // Duplicate physical key-up does not count as a tap or forget the first one.
        assert!(matches!(
            g.control(&[release], after(now, 47), false),
            Edge::Up(Release::Consumed)
        ));
        assert!(g.defer_result(after(now, 48)));
        // Without the key-down notification, STREAM_START is the usable second down.
        let begin = [start, 0, 2, 9];
        assert!(matches!(
            g.control(&begin, after(now, 100), false),
            Edge::Down(Press::Second)
        ));
        assert!(matches!(
            g.control(&begin, after(now, 101), false),
            Edge::Down(Press::Duplicate)
        ));
        assert!(matches!(
            g.control(&[release], after(now, 145), false),
            Edge::Up(Release::Enter)
        ));
        assert!(matches!(
            g.control(&[press], after(now, 180), true),
            Edge::Down(Press::DialogueRecord)
        ));
        assert!(matches!(
            g.control(&begin, after(now, 185), true),
            Edge::Down(Press::Duplicate)
        ));
        assert!(matches!(
            g.control(&[release], after(now, 240), true),
            Edge::Up(Release::Consumed)
        ));
    }
}
