use super::startup::StartupQueue;
use super::*;
use btleplug::api::ValueNotification;

fn packet(uuid: Uuid, value: &[u8]) -> ValueNotification {
    ValueNotification {
        uuid,
        service_uuid: SERVICE,
        value: value.to_vec(),
    }
}

fn timed(at: Instant, uuid: Uuid, value: &[u8]) -> TimedNotification {
    TimedNotification {
        packet: packet(uuid, value),
        at,
    }
}

#[test]
fn released_cold_start_press_recovers_the_original_audio_in_order_once() {
    let first = Instant::now();
    let mut startup = StartupQueue::default();
    // This model reports its stream start and sends audio even before CAPS.
    // A delayed MIC_OPEN for this press would open an already released mic.
    let stream = [
        (0, CONTROL, vec![0x08]),
        (8, CONTROL, vec![0x04, 0, 2, 1]),
        (25, AUDIO, vec![0x77; 600]),
        (100, AUDIO, vec![0x99; 600]),
        (650, CONTROL, vec![0x00]),
    ];
    for (ms, uuid, value) in &stream {
        startup
            .push(timed(first + Duration::from_millis(*ms), *uuid, value))
            .unwrap();
    }

    let caps = Caps::parse(&[0x0b, 1, 0, 2, 0, 0, 120]).unwrap();
    let mut ptt = Ptt::new(caps);
    let mut gesture = RecordGesture::default();
    let mut pcm = Vec::new();
    let mut releases = 0;
    for (ms, uuid, value) in stream {
        let buffered = startup.pop().unwrap();
        assert_eq!(buffered.at, first + Duration::from_millis(ms));
        assert_eq!(buffered.packet, packet(uuid, &value));
        let value = &buffered.packet.value;
        if uuid == AUDIO {
            ptt.audio(value).unwrap();
            while let Some(chunk) = ptt.take_chunk() {
                pcm.extend(chunk);
            }
        } else {
            let edge = gesture.control(value, buffered.at, false);
            if value[0] == 0x08 {
                assert!(startup.mic_open_obsolete());
            }
            if value[0] == 0x00 {
                assert_eq!(edge, Edge::Up(Release::Dictation));
            }
            for action in ptt.control(value).unwrap() {
                if let Action::Recognize { samples } = action {
                    releases += 1;
                    pcm.extend(samples);
                }
            }
        }
    }
    assert_eq!(releases, 1);
    assert_eq!(pcm.len(), 2400);
    assert_eq!(pcm[1199], i16::MAX);
    assert!(
        pcm[1200] < pcm[1199],
        "the second audio block must follow the first"
    );
    assert!(startup.pop().is_none());
}

#[test]
fn held_request_survives_setup_and_a_released_request_does_not_reopen_the_mic() {
    let now = Instant::now();
    for (tail, obsolete) in [
        (vec![], false),
        (vec![vec![0x10]], false),
        (vec![vec![0x13]], true),
        (vec![vec![0x10], vec![0x11, 0, 2, 7]], true),
    ] {
        let mut queue = StartupQueue::default();
        queue.push(timed(now, CONTROL, &[0x10])).unwrap();
        for bytes in tail {
            queue.push(timed(now, CONTROL, &bytes)).unwrap();
        }
        assert_eq!(queue.pop().unwrap().packet.value, [0x10]);
        assert_eq!(queue.mic_open_obsolete(), obsolete);
    }
}

#[test]
fn setup_backlog_is_bounded_and_does_not_carry_over_to_a_fresh_connection() {
    let mut previous = StartupQueue::default();
    let now = Instant::now();
    let overflow = (0..4096).find_map(|_| previous.push(timed(now, CONTROL, &[0x08])).err());
    assert!(
        overflow.is_some(),
        "a never-ending negotiation must not grow the startup queue indefinitely"
    );
    drop(previous);
    let mut next = StartupQueue::default();
    assert!(next.pop().is_none());
    next.push(timed(now, CONTROL, &[0x10])).unwrap();
    assert_eq!(next.pop().unwrap().packet.value, [0x10]);
    assert!(!next.mic_open_obsolete());
}

#[tokio::test]
async fn notification_inbox_drains_a_short_lived_stream_before_reporting_disconnect() {
    let packets = vec![
        packet(CONTROL, &[8]),
        packet(AUDIO, &[0x77; 120]),
        packet(CONTROL, &[0]),
    ];
    let mut inbox = NotificationInbox::new(futures_util::stream::iter(packets.clone()));
    for expected in packets {
        assert_eq!(inbox.next().await.unwrap().packet, expected);
    }
    assert!(inbox.next().await.is_err());
}

#[tokio::test]
async fn reader_collects_first_press_while_initialization_is_waiting_for_gatt() {
    let (read_all, drained) = tokio::sync::oneshot::channel();
    let packets = vec![
        packet(TX, &[0xff]),
        packet(CONTROL, &[0x10]),
        packet(CONTROL, &[0x11, 0, 2, 1]),
        packet(AUDIO, &[0x77; 120]),
        packet(CONTROL, &[0x13]),
    ];
    let stream =
        futures_util::stream::iter(packets.clone()).chain(futures_util::stream::poll_fn({
            let mut read_all = Some(read_all);
            move |_| {
                if let Some(read_all) = read_all.take() {
                    let _ = read_all.send(());
                }
                std::task::Poll::Pending
            }
        }));
    let mut inbox = NotificationInbox::new(stream);
    // No calls to inbox.next() while the GATT writes are pending.
    timeout(Duration::from_secs(2), drained)
        .await
        .unwrap()
        .unwrap();
    for expected in &packets[1..] {
        assert_eq!(&inbox.next().await.unwrap().packet, expected);
    }
}

#[tokio::test]
async fn reader_reports_an_oversized_notification_before_exposing_truncated_audio() {
    let packets = vec![
        packet(CONTROL, &[0x04, 0, 2, 1]),
        packet(AUDIO, &[0x77; 8193]),
        packet(CONTROL, &[0]),
    ];
    let mut inbox = NotificationInbox::new(futures_util::stream::iter(packets));
    let failure = inbox
        .next()
        .await
        .err()
        .expect("incomplete audio cannot be recognized");
    assert!(failure.retry);
}

#[tokio::test]
async fn first_press_is_signalled_during_setup_and_both_orders_of_caps_and_write_ack_preserve_it() {
    for caps_before_write_ack in [true, false] {
        let (notify, incoming) = tokio::sync::mpsc::unbounded_channel();
        let stream = futures_util::stream::unfold(incoming, |mut incoming| async move {
            incoming.recv().await.map(|packet| (packet, incoming))
        });
        let mut inbox = NotificationInbox::new(stream);
        let (signal, mut signalled) = tokio::sync::mpsc::unbounded_channel();
        let (gatt_write_complete, ack) = tokio::sync::oneshot::channel();
        let setup = async {
            ack.await.unwrap();
            Ok(())
        };
        let expected = [
            packet(CONTROL, &[0x08]),
            packet(CONTROL, &[0x04, 0, 2, 1]),
            packet(AUDIO, &[0x77; 134]),
            packet(CONTROL, &[0x00]),
        ];
        let run = startup::negotiate(&mut inbox, setup, || signal.send(()).unwrap());
        let peripheral = async {
            let caps = packet(CONTROL, &[0x0b, 0, 4, 0, 2, 0, 0]);
            if caps_before_write_ack {
                // Receipt of the callback below proves CAPS was already processed.
                notify.send(caps.clone()).unwrap();
            }
            notify.send(expected[0].clone()).unwrap();
            // Show immediate feedback even if the native write is still pending.
            timeout(Duration::from_secs(2), signalled.recv())
                .await
                .unwrap()
                .unwrap();
            for p in &expected[1..] {
                notify.send(p.clone()).unwrap();
            }
            gatt_write_complete.send(()).unwrap();
            if !caps_before_write_ack {
                notify.send(caps).unwrap();
            }
        };
        let (result, ()) = tokio::join!(run, peripheral);
        let (caps, mut queued) = result.unwrap();
        assert_eq!((caps.version, caps.frame_size), (4, 128));
        // Depending on scheduling, the release can be in either setup's queue or
        // the already received inbox. The production path drains both in FIFO order.
        inbox.drain_available(&mut queued).unwrap();
        for p in expected {
            assert_eq!(queued.pop().unwrap().packet, p);
        }
        assert!(queued.pop().is_none());
        assert!(
            signalled.try_recv().is_err(),
            "a stream-start after key-down must not focus twice"
        );
    }
}

#[test]
fn clear_while_setup_events_are_buffered_never_starts_recognition_for_the_old_hold() {
    let caps = Caps::parse(&[0x0b, 1, 0, 2, 0, 0, 120]).unwrap();
    let mut ptt = Ptt::new(caps);
    assert!(matches!(
        &ptt.discard_buffered_control(&[0x08]).unwrap()[..],
        [Action::AcknowledgePress(_)]
    ));
    // The stream starts after Clear but still belongs to the original hold.
    assert!(ptt.control(&[0x04, 0, 2, 1]).unwrap().is_empty());
    ptt.audio(&[0x77; 1200]).unwrap();
    assert!(ptt.take_chunk().is_none());
    assert!(ptt.control(&[0x00]).unwrap().is_empty());
    assert!(matches!(
        &ptt.control(&[0x08]).unwrap()[..],
        [Action::OpenMic(_)]
    ));
}
