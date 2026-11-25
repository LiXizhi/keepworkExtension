use super::*;
use crate::remote_voice::dialogue::{Dialogue, Surface, TEST_OWNER_LOCK};
use std::sync::{Arc, Mutex};

struct Remote {
    now: Instant,
    dialogue: Arc<Dialogue>,
    gesture: RecordGesture,
    ptt: Ptt,
    recognition: Option<Recognition>,
    bumi: bool,
}

impl Remote {
    fn packet(&mut self, time: u64, bytes: &[u8]) -> Vec<Action> {
        handle_record_control(
            bytes,
            self.now + Duration::from_millis(time),
            &self.dialogue,
            self.bumi,
            &mut self.gesture,
            &mut self.ptt,
            &mut self.recognition,
        )
        .unwrap()
    }
}

#[tokio::test]
async fn remote_dialogue_atvv_taps_discard_ready_cloud_results_and_mode_controls_never_send_physical_audio(
) {
    let _exclusive = TEST_OWNER_LOCK.lock().await;
    let dialogue = Arc::new(Dialogue::default());
    let routed = Arc::new(Mutex::new(Vec::new()));
    let events = routed.clone();
    dialogue.install(move |_| {
        let events = events.clone();
        Some(Surface {
            label: "pet",
            send: Box::new(move |action, _, _| {
                events.lock().unwrap().push(action.to_owned());
                let (reply, result) = tokio::sync::oneshot::channel();
                let _ = reply.send(true);
                Ok(result)
            }),
        })
    });
    let mut remote = Remote {
        now: Instant::now(),
        dialogue,
        gesture: RecordGesture::default(),
        ptt: Ptt::new(Caps {
            version: 0x100,
            frame_size: 120,
        }),
        recognition: None,
        bumi: false,
    };

    assert!(matches!(
        remote.packet(0, &[8]).as_slice(),
        [Action::OpenMic(_)]
    ));
    assert_eq!(
        &*routed.lock().unwrap(),
        &["interrupt"],
        "playback stops before PCM or ASR"
    );
    assert!(matches!(
        remote.packet(7, &[4, 0, 2, 1]).as_slice(),
        [Action::State("recording")]
    ));
    remote.ptt.audio(&[0x77; 1200]).unwrap();
    let mut job = Recognition::with_transcriber(Ok(None), |_, _| {
        Box::pin(async { Ok("old dictation".into()) })
    });
    assert!(matches!(
        remote.packet(130, &[0]).as_slice(),
        [Action::Recognize { .. }]
    ));
    job.release();
    job.result = Some(job.work.as_mut().await);
    remote.recognition = Some(job);
    assert!(remote.ptt.busy);
    assert!(remote
        .gesture
        .defer_result(remote.now + Duration::from_millis(131)));

    assert!(matches!(
        remote.packet(210, &[8]).as_slice(),
        [Action::OpenMic(_)]
    ));
    assert!(
        remote.recognition.is_none(),
        "the first tap's ready result must never reach the current input"
    );
    assert!(
        !remote.ptt.busy,
        "the short first capture must not swallow the second tap"
    );
    let second = Recognition::with_transcriber(Ok(None), |_, _| Box::pin(std::future::pending()));
    remote.recognition = Some(second);
    assert!(matches!(
        remote.packet(220, &[4, 0, 2, 2]).as_slice(),
        [Action::State("recording")]
    ));
    assert!(remote.packet(230, &[4, 0, 2, 2]).is_empty());
    assert!(remote.packet(278, &[0]).is_empty());
    assert!(remote.recognition.is_none());
    assert!(remote.dialogue.active());
    assert_eq!(&*routed.lock().unwrap(), &["interrupt", "enter"]);

    assert!(matches!(
        remote.packet(340, &[8]).as_slice(),
        [Action::AcknowledgePress(data)] if data == &[12, 0]
    ));
    assert!(remote.packet(345, &[4, 0, 2, 3]).is_empty());
    remote.ptt.audio(&[0x77; 1200]).unwrap();
    assert!(remote.ptt.take_chunk().is_none());
    assert!(remote.packet(429, &[0]).is_empty());
    assert_eq!(&*routed.lock().unwrap(), &["interrupt", "enter", "record"]);
    remote.bumi = true;
    for (at, stream) in [(450, 4), (570, 5)] {
        assert!(matches!(remote.packet(at, &[8]).as_slice(), [Action::OpenMic(_)]));
        assert!(matches!(remote.packet(at + 10, &[4, 0, 2, stream]).as_slice(), [Action::State("recording")]));
        remote.ptt.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(remote.packet(at + 60, &[0]).as_slice(), [Action::Recognize { .. }]));
        assert!(!remote.gesture.defer_result(remote.now + Duration::from_millis(at + 61)));
        remote.ptt.busy = false; // Simulate completion before the next physical press.
    }
    assert_eq!(&*routed.lock().unwrap(), &["interrupt", "enter", "record"]);
    remote.bumi = false;
    assert!(remote.dialogue.exit("back"));
    assert!(matches!(
        remote.packet(650, &[8]).as_slice(),
        [Action::OpenMic(_)]
    ));
    assert_eq!(
        &*routed.lock().unwrap(),
        &["interrupt", "enter", "record", "exit", "interrupt"]
    );
}
