use super::{tests::command_controller, *};

#[test]
fn remote_phone_owner_and_captions_follow_only_the_current_call() {
    let pet = command_controller();
    let id = Uuid::new_v4().to_string();
    let mut state = json!({ "remotePhoneVersion": 1, "remotePhoneCaptionVersion": 1, "remoteDialogue": {
        "id": id, "caption": {"role": "user", "text": "讲".repeat(550)}
    }});
    for phase in ["starting", "listening", "speaking", "thinking", "paused"] {
        state["remoteDialogue"]["state"] = json!(phase);
        let snap = pet.update_raw_state(state.clone());
        assert_eq!(snap["remoteDialogue"]["caption"]["text"].as_str().unwrap().chars().count(), 512);
        assert_eq!(pet.active_phone_id().as_deref(), Some(id.as_str()));
    }
    for version in [Value::Null, json!(2)] {
        state["remotePhoneCaptionVersion"] = version;
        let snap = pet.update_raw_state(state.clone());
        assert_eq!(snap["remoteDialogue"]["state"], "paused");
        assert!(snap["remoteDialogue"].get("caption").is_none());
    }
    state["remotePhoneCaptionVersion"] = json!(1);
    state["remoteDialogue"]["caption"]["role"] = json!("tool");
    assert!(pet.update_raw_state(state.clone())["remoteDialogue"].get("caption").is_none());
    state["remoteDialogue"]["state"] = json!("stopping");
    pet.update_raw_state(state.clone());
    assert!(pet.active_phone_id().is_none());
    for version in [Value::Null, json!(2)] {
        state["remotePhoneVersion"] = version;
        assert!(pet.update_raw_state(state.clone())["remoteDialogue"].is_null());
    }
    assert!(pet.update_raw_state(json!({"remotePhoneVersion":1}))["remoteDialogue"].is_null());
    assert!(pet.active_phone_id().is_none());
}

#[test]
fn manual_phone_captions_require_a_negotiated_active_call_and_valid_speaker() {
    let pet = command_controller();
    let mut raw = json!({
        "phoneState": "listening", "remotePhoneVersion": 1, "remotePhoneCaptionVersion": 1,
        "phoneCaption": {"role": "user", "text": "讲".repeat(600)}, "draft": "keep"
    });
    let snapshot = pet.update_raw_state(raw.clone());
    assert_eq!(snapshot["phoneCaption"]["text"].as_str().unwrap().chars().count(), 512);
    for (field, unsupported) in [
        ("phoneState", Value::Null), ("remotePhoneCaptionVersion", json!(2)),
        ("remotePhoneVersion", json!(2)), ("remoteDialogue", json!({"state":"starting"})),
        ("phoneCaption", json!({"role": "tool", "text": "hi"}))
    ] {
        let mut legacy = raw.clone();
        legacy[field] = unsupported;
        let snapshot = pet.update_raw_state(legacy);
        assert!(snapshot["phoneCaption"].is_null());
        assert_eq!(snapshot["draft"], "keep");
    }
    raw["phoneCaption"] = json!({"role":"assistant","text":" 回复 "});
    assert_eq!(pet.update_raw_state(raw)["phoneCaption"]["text"], "回复");
}

#[test]
fn phone_tool_activity_requires_negotiated_thinking_and_resets_on_downgrade() {
    let pet = command_controller();
    let mut raw = json!({
        "context": "session:one", "remotePhoneVersion": 1, "phoneState": "thinking",
        "draft": "keep", "remotePhoneActivityVersion": 1, "phoneActivity": "tool"
    });
    let manual = pet.update_raw_state(raw.clone());
    assert_eq!(manual["phoneActivity"], "tool");
    assert_eq!(manual["phoneState"], "thinking");

    let id = Uuid::new_v4().to_string();
    raw["remoteDialogue"] = json!({"id": id, "state": "thinking"});
    let remote = pet.update_raw_state(raw.clone());
    assert_eq!(remote["phoneActivity"], "tool");
    assert_eq!(remote["remoteDialogue"]["id"], id);
    for (key, value) in [
        ("remotePhoneActivityVersion", Value::Null),
        ("remotePhoneActivityVersion", json!(2)),
        ("remotePhoneActivityVersion", json!("1")),
        ("remotePhoneVersion", Value::Null),
        ("remotePhoneVersion", json!(2)),
        ("phoneState", Value::Null),
        ("phoneState", json!("speaking")),
        ("phoneState", json!("listening")),
        ("phoneState", json!("stopping")),
        ("phoneActivity", json!("unknown")),
        ("phoneActivity", json!({"name": "private tool metadata"})),
    ] {
        let mut unsupported = raw.clone();
        unsupported[key] = value;
        let snap = pet.update_raw_state(unsupported);
        assert!(snap["phoneActivity"].is_null(), "{key}");
        assert_eq!(snap["draft"], "keep");
        if key != "remotePhoneVersion" && key != "phoneState" {
            assert_eq!(snap["phoneState"], "thinking");
            assert_eq!(snap["remoteDialogue"]["id"], id);
        }
    }
    let legacy = pet.update_raw_state(json!({"remotePhoneVersion": 1, "phoneState": "thinking"}));
    assert_eq!(legacy["phoneState"], "thinking");
    assert!(legacy["phoneActivity"].is_null());
    assert!(pet.update_raw_state(json!({}))["phoneActivity"].is_null());
}

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
