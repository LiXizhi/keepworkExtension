use super::{tests::command_controller, *};

#[test]
fn shared_phone_snapshots_only_expose_status_and_never_request_a_pet_microphone() {
    let pet = command_controller();
    let id = "97f4a4c8-63a0-4607-9bcd-142aeef952b4";
    let mut page = json!({ "context": "one", "ready": false, "draft": "keep",
        "remoteDialogue": { "id": id, "state": "speaking", "text": "private transcript" },
        "phoneState": "speaking", "phoneError": "字".repeat(310) });
    for version in [Value::Null, json!(2), json!("1")] {
        page["remotePhoneVersion"] = version;
        let snapshot = pet.update_raw_state(page.clone());
        for field in ["remotePhoneVersion", "phoneState", "phoneError", "remoteDialogue"] {
            assert!(snapshot[field].is_null(), "{field}");
        }
    }
    page["remotePhoneVersion"] = json!(1);
    for state in ["starting", "listening", "thinking", "speaking", "paused"] {
        page["phoneState"] = json!(state);
        page["remoteDialogue"]["state"] = json!(state);
        let snapshot = pet.update_raw_state(page.clone());
        assert_eq!(snapshot["remoteDialogue"], json!({ "id": id, "state": state }));
        assert_eq!(snapshot["phoneState"], state);
        assert_eq!(snapshot["phoneError"].as_str().unwrap().chars().count(), 300);
        assert_eq!(snapshot["draft"], "keep");
        assert!(!uses_pet_audio(&snapshot, "dialogue-start"));
        assert!(!starts_media_capture(&snapshot, "dialogue-start"));
    }
    page["phoneState"] = json!("future");
    for invalid in [json!({ "id": "broken", "state": "listening" }), json!({ "id": id, "state": "future" })] {
        page["remoteDialogue"] = invalid;
        let snapshot = pet.update_raw_state(page.clone());
        assert!(snapshot["remoteDialogue"].is_null());
        assert!(snapshot["phoneState"].is_null());
    }
    page["phoneState"] = json!("listening");
    page["remoteDialogue"] = Value::Null;
    let manual = pet.update_raw_state(page);
    assert_eq!(manual["phoneState"], "listening");
    assert!(manual["remoteDialogue"].is_null());
}

#[test]
fn streaming_speech_snapshots_require_negotiation_and_only_carry_bounded_prose() {
    let pet = command_controller();
    let mut raw = json!({
        "context": "alice", "ready": true, "draft": "still editable",
        "petReplyPresentationVersion": 1, "petStreamingSpeechVersion": 1,
        "petSpeech": { "requestId": "turn", "state": "speaking", "text": "界".repeat(8001),
                       "provider": "private backend detail" }
    });
    for state in ["waiting", "speaking", "paused", "ended", "unavailable"] {
        raw["petSpeech"]["state"] = json!(state);
        let snapshot = pet.update_raw_state(raw.clone());
        assert_eq!(snapshot["petStreamingSpeechVersion"], 1);
        assert_eq!(snapshot["petSpeech"], json!({
            "requestId": "turn", "state": state, "text": "界".repeat(8000)
        }));
    }
    for (field, value) in [
        ("requestId", json!("")), ("requestId", json!("x".repeat(129))),
        ("state", json!("future-or-malformed")), ("state", json!(123)),
    ] {
        let mut invalid = raw.clone();
        invalid["petSpeech"][field] = value;
        let snapshot = pet.update_raw_state(invalid);
        assert!(snapshot["petSpeech"].is_null());
        assert_eq!(snapshot["draft"], "still editable");
    }
    for key in ["petReplyPresentationVersion", "petStreamingSpeechVersion"] {
        for version in [Value::Null, json!(2), json!("1")] {
            let mut legacy = raw.clone();
            legacy[key] = version;
            let snapshot = pet.update_raw_state(legacy);
            assert!(snapshot["petSpeech"].is_null());
            assert!(snapshot["petStreamingSpeechVersion"].is_null());
            assert_eq!(snapshot["draft"], "still editable");
        }
    }
}

#[test]
fn streaming_speech_controls_only_address_the_latest_native_pet_send() {
    let pet = command_controller();
    let page = json!({
        "context": "alice", "ready": true, "petStreamingSpeechVersion": 1,
        "petReplyPresentationVersion": 1,
        "petSpeech": { "requestId": "unowned", "state": "speaking", "text": "External reply" }
    });
    pet.update_raw_state(page.clone());
    let args = |id: &Value| json!({ "context": "alice", "speechRequestId": id });
    assert!(pet.begin_command("pause-speech", &args(&json!("unowned"))).is_err());

    let (first, _rx) = pet.begin_command("send", &json!({ "context": "alice" })).unwrap();
    let (second, _rx) = pet.begin_command("send", &json!({ "context": "alice" })).unwrap();
    let current = &second["requestId"];
    for action in ["pause-speech", "resume-speech", "cancel-speech"] {
        assert!(pet.begin_command(action, &args(&first["requestId"])).is_err());
        assert!(pet.begin_command(action, &json!({ "context": "bob", "speechRequestId": current })).is_err());
        let (control, _rx) = pet.begin_command(action, &args(current)).unwrap();
        assert_eq!(control["action"], action);
        assert_eq!(control["speechRequestId"], *current);
        assert_ne!(control["requestId"], *current);
    }
    assert!(pet.take_speech_cancellation(first["requestId"].as_str()).is_none());
    let hidden = pet.take_speech_cancellation(None).unwrap();
    assert_eq!(hidden["action"], "cancel-speech");
    assert_eq!(hidden["context"], "alice");
    assert_eq!(hidden["speechRequestId"], *current);
    assert_ne!(hidden["requestId"], *current);
    assert!(pet.take_speech_cancellation(None).is_none());
    assert!(pet.begin_command("resume-speech", &args(current)).is_err());

    for next in [json!({ "context": "bob", "ready": true }),
                 json!({ "context": "alice", "ready": true, "petReplyPresentationVersion": 1 })] {
        pet.update_raw_state(page.clone());
        let (send, _rx) = pet.begin_command("send", &json!({ "context": "alice" })).unwrap();
        pet.update_raw_state(next);
        assert!(pet.take_speech_cancellation(None).is_none());
        assert!(pet.begin_command("cancel-speech", &args(&send["requestId"])).is_err());
    }
}
