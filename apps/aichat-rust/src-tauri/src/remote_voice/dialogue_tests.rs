use super::*;

#[tokio::test]
async fn remote_dialogue_buttons_and_late_start_acknowledgments_stay_with_their_owner() {
    let _exclusive = TEST_OWNER_LOCK.lock().await;
    let dialogue = Arc::new(Dialogue::default());
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let surface = Arc::new(Mutex::new("pet"));
    let selected = surface.clone();
    let selections = Arc::new(Mutex::new(Vec::new()));
    let captured = selections.clone();
    dialogue.install(move |include_background| {
        captured.lock().unwrap().push(include_background);
        let label = *selected.lock().unwrap();
        let events = events.clone();
        Some(Surface {
            label,
            send: Box::new(move |action, id, reason| {
                let (answer, result) = oneshot::channel();
                events
                    .send((
                        label,
                        action.to_owned(),
                        id.to_owned(),
                        reason.to_owned(),
                        answer,
                    ))
                    .unwrap();
                Ok(result)
            }),
        })
    });

    dialogue.interrupt();
    let (label, action, id, _, _) = received.recv().await.unwrap();
    assert_eq!(
        (label, action.as_str(), id.as_str()),
        ("pet", "interrupt", "")
    );
    assert!(!dialogue.active());
    #[cfg(target_os = "macos")]
    assert!(!keepwork_remote_dialogue_ok_edge(true), "a hidden pet leaves this press with the OS");
    dialogue.enter();
    #[cfg(target_os = "macos")]
    {
        assert!(!keepwork_remote_dialogue_ok_edge(true), "held native Return cannot become a new dialogue press");
        assert!(!keepwork_remote_dialogue_ok_edge(false));
        assert!(!take_ok());
    }
    let (label, action, first, _, late) = received.recv().await.unwrap();
    assert_eq!((label, action.as_str()), ("pet", "enter"));
    assert!(uuid::Uuid::parse_str(&first).is_ok());
    assert!(!dialogue.closed("main", &first));
    assert!(dialogue.active());
    #[cfg(target_os = "macos")]
    {
        assert!(keepwork_remote_dialogue_ok_edge(true));
        assert!(keepwork_remote_dialogue_ok_edge(true));
        assert!(take_ok());
        assert!(!take_ok(), "key repeat cannot exit a second dialogue");
    }
    assert!(dialogue.exit("ok"));
    let (label, action, id, reason, _) = received.recv().await.unwrap();
    assert_eq!(
        (label, action.as_str(), id.as_str(), reason.as_str()),
        ("pet", "exit", first.as_str(), "ok")
    );
    #[cfg(target_os = "macos")]
    {
        assert!(
            keepwork_remote_dialogue_ok_edge(false),
            "the exiting OK release stays consumed"
        );
        assert!(!keepwork_remote_dialogue_ok_edge(true));
        assert!(!keepwork_remote_dialogue_ok_edge(false));
    }

    *surface.lock().unwrap() = "main";
    dialogue.enter();
    let (label, action, second, _, accepted) = received.recv().await.unwrap();
    assert_eq!((label, action.as_str()), ("main", "enter"));
    assert_ne!(second, first);
    accepted.send(true).unwrap();
    late.send(false).unwrap();
    assert!(!dialogue.closed("pet", &first));
    *surface.lock().unwrap() = "pet";
    dialogue.record();
    let (label, action, id, _, response) = received.recv().await.unwrap();
    assert_eq!(
        (label, action.as_str(), id.as_str()),
        ("main", "record", second.as_str())
    );
    response.send(true).unwrap();
    assert!(dialogue.exit("back"));
    let (label, action, id, reason, _) = received.recv().await.unwrap();
    assert_eq!(
        (label, action.as_str(), id.as_str(), reason.as_str()),
        ("main", "exit", second.as_str(), "back")
    );
    assert!(!dialogue.exit("back"));
    assert!(!dialogue.active());
    assert!(received.try_recv().is_err());
    assert_eq!(&*selections.lock().unwrap(), &[true, false, false]);
}
