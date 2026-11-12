//! Unit tests for the personas module.

use super::*;
use super::{model::*, naming::*, store::*, util::*, view::*};

#[test]
fn streamed_output_never_becomes_history_or_a_success_receipt_until_finished() {
    let dir = std::env::temp_dir().join(format!("kp-persona-output-{}", uuid::Uuid::new_v4()));
    let store = PersonaStore::open(dir.clone());
    let owner = "ab".repeat(32);
    let spec = RunSpec {
        key: file_key(&owner, "default-persona"),
        owner: owner.clone(),
        id: "default-persona".into(),
        request_id: "request".into(),
        text: "question".into(),
        context_mode: "conversation".into(),
    };
    store.lock().rows.insert(
        spec.key.clone(),
        json!({
            "owner": owner, "id":"default-persona", "name":"我的分身", "readAt":0,
            "messages":[{"id":"request","role":"user","text":"question","time":1}],
            "job":{"id":"request","state":"running"}, "requests":{"request":"accepted"},
        }),
    );
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    store.lock().watchers.push(Some((owner.clone(), tx)));
    store.update_output(&spec, "partial answer");
    assert!(rx.try_recv().is_ok());
    let view = store.read(&owner, "default-persona", i64::MAX).unwrap();
    assert_eq!(view["job"]["output"]["text"], "partial answer");
    assert_eq!(view["messages"].as_array().unwrap().len(), 1);
    assert_eq!(view["unread"], 0);
    assert!(history_of(view["messages"].as_array().unwrap()).is_empty());
    store.finish(&spec, Err("connection lost".into()), false, 0, 0);
    store.update_output(&spec, "late answer");
    let failed = store.read(&owner, "default-persona", i64::MAX).unwrap();
    assert_eq!(failed["job"]["state"], "error");
    assert_eq!(failed["job"]["output"]["text"], "partial answer");
    assert_eq!(failed["messages"].as_array().unwrap().len(), 1);

    store.lock().rows.get_mut(&spec.key).unwrap()["job"] = json!({"id":"next","state":"running"});
    store.update_output(&spec, "stale answer");
    assert!(
        store.read(&owner, "default-persona", i64::MAX).unwrap()["job"]
            .get("output")
            .is_none()
    );
    let next = RunSpec {
        request_id: "next".into(),
        ..spec
    };
    store.update_output(&next, "fresh partial");
    store.finish(&next, Ok("complete answer".into()), false, 1, 1);
    let done = store.read(&owner, "default-persona", i64::MAX).unwrap();
    assert!(done["job"].get("output").is_none());
    assert_eq!(done["messages"].as_array().unwrap().len(), 2);
    assert_eq!(done["messages"][1]["text"], "complete answer");
    assert_eq!(done["messages"][1]["execution"]["requested"], 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cancellation_retains_visible_partial_but_ignores_late_stream_updates() {
    let dir = std::env::temp_dir().join(format!("kp-persona-stop-output-{}", uuid::Uuid::new_v4()));
    let store = PersonaStore::open(dir.clone());
    let owner = "cd".repeat(32);
    let spec = RunSpec {
        key: file_key(&owner, "default-persona"),
        owner: owner.clone(),
        id: "default-persona".into(),
        request_id: "stop".into(),
        text: "question".into(),
        context_mode: "conversation".into(),
    };
    store.lock().rows.insert(
        spec.key.clone(),
        json!({
            "owner":owner,"id":"default-persona","messages":[],"requests":{},
            "job":{"id":"stop","state":"running"},
        }),
    );
    store.update_output(&spec, "visible partial");
    store.cancel(&owner, "default-persona").unwrap();
    store.update_output(&spec, "late");
    store.finish(&spec, Ok("late complete".into()), true, 0, 0);
    let stopped = store.read(&owner, "default-persona", i64::MAX).unwrap();
    assert_eq!(stopped["job"]["state"], "cancelled");
    assert_eq!(stopped["job"]["output"]["text"], "visible partial");
    assert!(stopped["messages"].as_array().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn native_cli_model_preferences_never_reach_keepwork() {
    assert_eq!(
        resolve_model(
            &json!({"executor":"auto","preference":{"backend":"codex","model":"gpt-5-codex"}})
        ),
        "keepwork-pro"
    );
    assert_eq!(
        resolve_model(
            &json!({"executor":"keepwork","preference":{"backend":"claude","model":"sonnet"}})
        ),
        "keepwork-pro"
    );
    assert_eq!(
        resolve_model(
            &json!({"executor":"auto","preference":{"backend":"keepwork","model":"keepwork-fast"}})
        ),
        "keepwork-fast"
    );
    assert_eq!(
        resolve_model(&json!({"executor":"keepwork","model":"keepwork-pro"})),
        "keepwork-pro"
    );
}

#[test]
fn snapshots_do_not_advertise_unimplemented_execution_capabilities() {
    let view = project_view(&json!({"id":"role","prompt":"write files"}), None);
    assert_eq!(view["taskContextVersion"], 1);
    for field in [
        "peerMessagingVersion",
        "roleWriteVersion",
        "wechatVersion",
        "salesRuntimeVersion",
        "messagingVersion",
        "writePolicy",
    ] {
        assert!(
            view.get(field).is_none(),
            "unimplemented capability {field}"
        );
    }
}

#[test]
fn unimplemented_tools_or_truncated_streams_do_not_become_successful_answers() {
    let success = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n";
    assert_eq!(
        parse_model_output("text/event-stream", success).unwrap(),
        "你好"
    );
    assert!(parse_model_output(
        "text/event-stream",
        "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n"
    )
    .is_err());
    assert!(parse_model_output(
        "text/event-stream",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\ndata: [DONE]\n\n"
    )
    .is_err());
    assert!(parse_model_output("text/event-stream", "data: {\"result\":\"partial\"}\n\n").is_err());
}

#[tokio::test]
async fn persistence_failure_does_not_accept_or_execute_a_message() {
    let dir = std::env::temp_dir().join(format!("kp-persona-storage-{}", uuid::Uuid::new_v4()));
    let backup = dir.with_extension("backup");
    let store = PersonaStore::open(dir.clone());
    let presence = Arc::new(PresenceState::new());
    let owner = "ab".repeat(32);
    store
        .upsert(
            &presence,
            &owner,
            &json!({"id":"default-persona","name":"我的分身","root":""}),
        )
        .unwrap();
    std::fs::rename(&dir, &backup).unwrap();
    std::fs::write(&dir, "storage unavailable").unwrap();
    let error = store
        .submit(
            &presence,
            &owner,
            "default-persona",
            &json!({"requestId":"retain-draft","text":"HI"}),
        )
        .unwrap_err();
    assert_eq!(error.status, 500);
    assert_eq!(error.code, Some("PERSISTENCE_ERROR"));
    let row = store.read(&owner, "default-persona", i64::MAX).unwrap();
    assert_eq!(row["messages"].as_array().unwrap().len(), 0);
    assert!(row.get("job").is_none());
    assert!(store.lock().cancels.is_empty());
    std::fs::remove_file(dir).unwrap();
    std::fs::remove_dir_all(backup).unwrap();
}

#[test]
fn next_run_matches_the_zone_clock() {
    let now = chrono::Utc::now().timestamp_millis();
    let next = next_persona_run("08:30", "Asia/Shanghai", now)
        .unwrap_or_else(|error| panic!("{}", error.message));
    let tz: Tz = "Asia/Shanghai".parse().unwrap();
    let formatted = chrono::DateTime::from_timestamp_millis(next)
        .unwrap()
        .with_timezone(&tz)
        .format("%H:%M")
        .to_string();
    assert_eq!(formatted, "08:30");
    assert!(next > now);
    assert!(next_persona_run("24:00", "UTC", now).is_err());
    assert!(next_persona_run("09:00", "Not/AZone", now).is_err());
}

#[test]
fn messaging_requires_a_group_when_enabled() {
    let error = agent_messaging(&json!({
        "version": 1,
        "enabled": true,
        "groups": [],
    }))
    .unwrap_err();
    assert_eq!(error.message, "请先选择至少一个主要群聊");
    let ok = agent_messaging(&json!({
        "version": 1,
        "enabled": true,
        "groups": [{ "channel": "dingtalk", "account": "corp:user", "id": "g1", "name": "群" }],
    }))
    .unwrap();
    assert_eq!(ok["groups"].as_array().unwrap().len(), 1);
}

#[test]
fn chat_url_stays_on_keepwork() {
    assert!(keepwork_chat_url("https://api.keepwork.com/core/v0")
        .unwrap()
        .ends_with("/gpt/chat"));
    assert!(keepwork_chat_url("http://api.keepwork.com/core/v0").is_err());
    assert!(keepwork_chat_url("https://evil.example/core/v0").is_err());
}

#[test]
fn upsert_round_trips_without_the_owner_field() {
    let dir = std::env::temp_dir().join(format!(
        "kp-persona-unit-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let store = PersonaStore::open(dir.clone());
    let presence = PresenceState::new();
    let owner = "ab".repeat(32);
    let view = store
        .upsert(
            &presence,
            &owner,
            &json!({
                "id": "default-persona",
                "name": "我的分身",
                "avatar": "🧠",
                "prompt": "hi",
                "executor": "auto",
                "model": "",
                "pinned": true,
                "order": 0,
                "root": "",
            }),
        )
        .unwrap();
    assert_eq!(view["name"], "我的分身");
    assert!(view.get("owner").is_none());
    assert!(view.get("messages").is_none());
    assert_eq!(view["wechatStatus"], "未绑定");
    assert_eq!(store.list(&owner)["agents"].as_array().unwrap().len(), 1);
    let saved = std::fs::read_dir(&dir).unwrap().any(|entry| {
        entry
            .ok()
            .and_then(|entry| entry.path().extension().map(|ext| ext == "json"))
            .unwrap_or(false)
    });
    assert!(saved);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn admin_snapshot_distinguishes_owner_groups_without_exposing_owner_keys() {
    let dir = std::env::temp_dir().join(format!("kp-persona-admin-{}", uuid::Uuid::new_v4()));
    let brain = dir.join("brain");
    std::fs::create_dir_all(&brain).unwrap();
    // The store records roots in their normalized form, which drops the
    // Windows verbatim prefix that `fs::canonicalize` adds.
    let root = canonical_root(brain.to_str().unwrap()).unwrap();
    let store = PersonaStore::open(dir.join("personas"));
    let presence = PresenceState::new();
    let request_owner = "48ee1a39-7015-4dfd-97db-12c656379f83";
    let origin_a = "http://127.0.0.1:3001";
    let origin_b = "https://keepwork.com";
    let owner_a = sha256_hex(&[origin_a.as_bytes(), b"\0", request_owner.as_bytes()]);
    let owner_b = sha256_hex(&[origin_b.as_bytes(), b"\0", request_owner.as_bytes()]);
    let config = json!({"id":"default-persona", "name":"我的分身", "root":root.clone()});
    store.upsert(&presence, &owner_a, &config).unwrap();
    store.upsert(&presence, &owner_b, &config).unwrap();
    store
        .upsert(
            &presence,
            &owner_a,
            &json!({"id":"bot", "name":"BOT1", "root":root.clone()}),
        )
        .unwrap();

    let snapshot = store.admin_snapshot();
    assert_eq!(snapshot["stats"]["total"], 3);
    assert_eq!(snapshot["stats"]["ownerGroups"], 2);
    let rows = snapshot["personas"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for (owner, id) in [
        (&owner_a, "default-persona"),
        (&owner_b, "default-persona"),
        (&owner_a, "bot"),
    ] {
        let key = file_key(owner, id);
        let row = rows.iter().find(|row| row["key"] == key).unwrap();
        assert_eq!(row["id"], id);
        assert_eq!(row["ownerGroup"], sha256_hex(&[owner.as_bytes()]));
        assert_eq!(row["root"], root);
        assert!(row.get("owner").is_none());
        for legacy in [
            "name",
            "state",
            "executor",
            "messages",
            "unread",
            "enabledSchedules",
            "schedules",
            "channels",
        ] {
            assert!(
                row.get(legacy).is_some(),
                "legacy field {legacy} is retained"
            );
        }
    }
    let serialized = snapshot.to_string();
    for private in [&owner_a[..], &owner_b[..], request_owner] {
        assert!(!serialized.contains(private));
    }

    let reloaded = PersonaStore::open(dir.join("personas"));
    let reloaded = reloaded.admin_snapshot();
    assert_eq!(reloaded["stats"]["total"], 3);
    assert_eq!(reloaded["stats"]["ownerGroups"], 2);
    let reloaded_rows = reloaded["personas"].as_array().unwrap();
    for row in rows {
        let restored = reloaded_rows
            .iter()
            .find(|restored| restored["key"] == row["key"])
            .unwrap();
        assert_eq!(restored["ownerGroup"], row["ownerGroup"]);
        assert_eq!(restored["root"], row["root"]);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn repeated_upserts_and_reload_preserve_history_and_owner_isolation() {
    let dir = std::env::temp_dir().join(format!("kp-persona-repeat-{}", uuid::Uuid::new_v4()));
    let store = PersonaStore::open(dir.clone());
    let presence = PresenceState::new();
    let owner_a = "ab".repeat(32);
    let owner_b = "cd".repeat(32);
    let config = json!({"id":"default-persona", "name":"我的分身", "root":""});
    store.upsert(&presence, &owner_a, &config).unwrap();
    let key = file_key(&owner_a, "default-persona");
    let messages = json!([
        {"id":"saved-request", "role":"user", "text":"saved question", "time":1},
        {"id":"saved-answer", "role":"assistant", "text":"saved answer", "time":2},
    ]);
    let receipts = json!({"saved-request":"done"});
    {
        let mut inner = store.lock();
        let row = inner.rows.get_mut(&key).unwrap();
        row["messages"] = messages.clone();
        row["requests"] = receipts.clone();
        store.save(&inner, &key);
    }

    for _ in 0..3 {
        store.upsert(&presence, &owner_a, &config).unwrap();
    }
    store.upsert(&presence, &owner_b, &config).unwrap();
    assert_eq!(store.lock().rows.len(), 2);
    for owner in [&owner_a, &owner_b] {
        assert_eq!(store.list(owner)["agents"].as_array().unwrap().len(), 1);
    }
    assert_eq!(
        store.read(&owner_a, "default-persona", i64::MAX).unwrap()["messages"],
        messages
    );
    assert!(
        store.read(&owner_b, "default-persona", i64::MAX).unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(store
        .read(&"ef".repeat(32), "default-persona", i64::MAX)
        .is_err());
    drop(store);

    let reloaded = PersonaStore::open(dir.clone());
    reloaded.upsert(&presence, &owner_a, &config).unwrap();
    reloaded.upsert(&presence, &owner_b, &config).unwrap();
    assert_eq!(reloaded.lock().rows.len(), 2);
    assert_eq!(
        reloaded
            .read(&owner_a, "default-persona", i64::MAX)
            .unwrap()["messages"],
        messages
    );
    assert_eq!(reloaded.lock().rows[&key]["requests"], receipts);
    let file_count = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .count();
    assert_eq!(file_count, 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn loading_unchanged_records_does_not_rewrite_them() {
    let dir = std::env::temp_dir().join(format!("kp-persona-reload-{}", uuid::Uuid::new_v4()));
    let owner = "ef".repeat(32);
    let store = PersonaStore::open(dir.clone());
    store
        .upsert(
            &PresenceState::new(),
            &owner,
            &json!({
                "id":"default-persona", "name":"My persona", "root":"",
            }),
        )
        .unwrap();
    let path = dir.join(format!("{}.json", file_key(&owner, "default-persona")));
    let bytes = std::fs::read(&path).unwrap();
    let modified = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(60);
    // Windows requires FILE_WRITE_ATTRIBUTES to change a timestamp, so the
    // handle has to be opened for writing rather than read-only.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    drop(store);
    let reloaded = PersonaStore::open(dir.clone());
    assert_eq!(reloaded.list(&owner)["agents"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    std::fs::remove_dir_all(dir).unwrap();
}
