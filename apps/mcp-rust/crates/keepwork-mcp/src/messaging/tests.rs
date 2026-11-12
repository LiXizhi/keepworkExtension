use super::*;
use super::{dingtalk::*, feishu::*, lifecycle::*, policy::*};

#[test]
fn feishu_identity_requires_verified_personal_login() {
    let ready = json!({
        "appId": "cli-app",
        "identities": { "user": {
            "status": "ready", "available": true, "verified": true, "openId": "ou-user"
        }, "bot": { "status": "ready" } }
    });
    assert_eq!(
        parse_feishu_identity(&ready, Some("cli-app:ou-user")).unwrap(),
        ("cli-app:ou-user".into(), "ou-user".into())
    );
    for pointer in [
        "/identities/user",
        "/identities/user/status",
        "/identities/user/available",
        "/identities/user/verified",
        "/identities/user/openId",
        "/appId",
    ] {
        let mut invalid = ready.clone();
        *invalid.pointer_mut(pointer).unwrap() = Value::Null;
        let error = parse_feishu_identity(&invalid, None).unwrap_err();
        assert_eq!(error.message, "Feishu login required", "{pointer}");
        assert!(!error.uncertain);
        assert!(needs_login_text(&error.message));
    }
    let mismatch = parse_feishu_identity(&ready, Some("other-app:ou-user")).unwrap_err();
    assert_eq!(
        mismatch.message,
        "Feishu identity does not match configured profile"
    );
    assert!(!needs_login_text(&mismatch.message));
}

#[test]
fn channel_cli_login_errors_keep_their_platform_and_hide_diagnostics() {
    for diagnostic in ["expired token: private-value", "run auth login", "未登录"] {
        let feishu = cli::classify_cli_error("", diagnostic, true);
        assert_eq!(feishu.message, "Feishu login required");
        assert!(!feishu.uncertain);
        assert!(needs_login_text(&feishu.message));
        let dingtalk = cli::classify_cli_error("", diagnostic, false);
        assert_eq!(dingtalk.message, "DingTalk login required");
        assert!(!dingtalk.uncertain);
    }
    let permission = cli::classify_cli_error("", "missing scope for private-value", true);
    assert!(permission.message.starts_with("Feishu permission denied;"));
    assert!(!needs_login_text(&permission.message));
    assert!(!permission.message.contains("private-value"));
}

fn message(id: &str, conversation: &str, text: &str, kind: &str) -> Incoming {
    Incoming {
        id: id.into(),
        conversation: conversation.into(),
        sender: "sender-1".into(),
        text: text.into(),
        time: now_ms(),
        kind: kind.into(),
        thread: None,
        automated: false,
        mentioned_self: false,
        recovered: false,
    }
}

#[test]
fn config_rejects_wrong_version() {
    assert!(config_value(&json!({"version": 2})).is_err());
}

#[test]
fn config_accepts_v1_and_dedupes() {
    let value = json!({"version": 1, "keywords": ["a", "a"], "groups": [], "knowledge": ["docs"], "executor": "auto", "model": ""});
    let config = config_value(&value).unwrap();
    assert_eq!(config.keywords, vec!["a".to_string()]);
    assert_eq!(config.knowledge, vec!["docs".to_string()]);
}

#[test]
fn config_rejects_unknown_executor() {
    let value = json!({"version": 1, "keywords": [], "groups": [], "knowledge": [], "executor": "evil", "model": ""});
    assert!(config_value(&value).is_err());
}

#[test]
fn safe_relative_rejects_escape() {
    assert!(safe_relative("docs/a").is_ok());
    assert!(safe_relative("docs/../account").is_err());
    assert!(safe_relative("/abs").is_err());
    assert!(safe_relative(".").is_err());
}

#[test]
fn split_reply_respects_char_boundaries() {
    let text = "您好，这是一段较长的中文回复，用于验证按字符切分不会切进多字节符号里。".repeat(200);
    for part in split_reply(&text, 6000) {
        assert!(part.len() <= 6000);
    }
    let total: String = split_reply(&text, 6000).concat();
    assert_eq!(total, text);
}

#[test]
fn next_auto_reply_at_bootstraps_from_empty() {
    let now = now_ms();
    assert_eq!(next_auto_reply_at(&[], now), now);
}

#[test]
fn next_auto_reply_at_spreads_bursts() {
    let now = 10_000_000_000i64;
    let times: Vec<i64> = (0..12)
        .map(|index| now - 120_000 + index * 10_000)
        .collect();
    let wake = next_auto_reply_at(&times, now);
    assert!(wake > now);
}

#[test]
fn trigger_follows_groups_and_keywords() {
    let config = MessageConfig {
        keywords: vec!["发布".into()],
        groups: vec!["oc_group".into()],
        knowledge: vec![],
    };
    let _now = now_ms();
    assert_eq!(
        trigger(
            &message("m1", "oc_group", "版本发布了吗", "group"),
            &config,
            0,
            "self-1"
        ),
        "reply"
    );
    assert_eq!(
        trigger(
            &message("m2", "oc_group", "随便聊聊", "group"),
            &config,
            0,
            "self-1"
        ),
        "not-triggered"
    );
    assert_eq!(
        trigger(
            &message("m3", "other", "版本发布了吗", "group"),
            &config,
            0,
            "self-1"
        ),
        "not-triggered"
    );
    assert_eq!(
        trigger(&message("m4", "c", "hi", "direct"), &config, 0, "self-1"),
        "reply"
    );
    let mut mine = message("m5", "c", "hi", "direct");
    mine.sender = "self-1".into();
    assert_eq!(trigger(&mine, &config, 0, "self-1"), "self");
    let mut echo = message("m6", "c", "【AI 代答】hi", "direct");
    echo.automated = true;
    assert_eq!(trigger(&echo, &config, 0, "self-1"), "echo");
    assert_eq!(
        trigger(
            &message("m7", "c", "hi", "direct"),
            &config,
            now_ms() + 1_000,
            "self-1"
        ),
        "old"
    );
}

#[test]
fn marker_tag_matches_node_markers() {
    assert_eq!(marker_tag("【小助手 · AI】你好"), "【小助手 · AI】");
    assert_eq!(marker_tag("【AI 代答】你好"), "【AI 代答】");
    assert_eq!(marker_tag("你好"), "");
    assert_eq!(marker_tag("【其他】你好"), "");
}

#[test]
fn dingtalk_ndjson_event_normalizes() {
    let event = json!({
        "type": "user_im_message_receive_o2o_all",
        "message_id": "mid-1",
        "conversation_id": "cid-1",
        "sender_open_dingtalk_id": "sender-1",
        "content": "你好",
        "create_time": 1_700_000_000_000i64,
    });
    let message = incoming_from_event(&event).unwrap();
    assert_eq!(message.kind, "direct");
    assert_eq!(message.id, "mid-1");
    assert_eq!(message.conversation, "cid-1");
    assert_eq!(message.time, 1_700_000_000_000);
}

#[test]
fn feishu_row_normalizes_mentions() {
    let run_row = json!({
        "message_id": "om-1",
        "sender": { "id": "ou_sender" },
        "create_time": 1_700_000_000_000i64,
        "msg_type": "text",
        "content": "{\"text\":\"帮我看看\"}",
        "mentions": [{"id": {"open_id": "ou_self"}}],
        "chat_type": "group",
    });
    let message = feishu_incoming(
        &run_row,
        &json!({ "chat_id": "oc_1", "chat_mode": "group" }),
        "ou_self",
    )
    .unwrap();
    assert_eq!(message.kind, "mention");
    assert!(message.mentioned_self);
    assert_eq!(message.text, "帮我看看");
}

#[test]
fn listener_args_match_node_shape() {
    let config = MessageConfig {
        keywords: vec![],
        groups: vec!["oc_g1".into()],
        knowledge: vec![],
    };
    let sets = listener_args(&config, false);
    assert_eq!(sets.len(), 1);
    assert_eq!(
        sets[0],
        vec![
            "event".to_string(),
            "consume".to_string(),
            "user_im_message_receive_at".to_string(),
            "user_im_message_receive_o2o_all".to_string(),
            "--flatten".to_string(),
            "-f".to_string(),
            "ndjson".to_string(),
        ]
    );
    // Keywords drive per-group subscriptions; group lists alone do not.
    let keyword_config = MessageConfig {
        keywords: vec!["帮".into()],
        groups: vec!["oc_g1".into()],
        knowledge: vec![],
    };
    let keyword_sets = listener_args(&keyword_config, false);
    assert_eq!(keyword_sets.len(), 2);
    assert!(keyword_sets[1].contains(&"--group".to_string()));
    assert!(keyword_sets[1].contains(&"oc_g1".to_string()));
    assert!(keyword_sets[1].contains(&"user_im_message_receive_group".to_string()));
    // An available agent subscribes to every group instead.
    let all_sets = listener_args(&config, true);
    assert_eq!(all_sets.len(), 2);
    assert!(all_sets[1].contains(&"user_im_message_receive_group_all".to_string()));
}

#[test]
fn subscription_key_captures_groups_and_keywords() {
    let config = MessageConfig {
        keywords: vec!["k".into()],
        groups: vec!["g".into()],
        knowledge: vec![],
    };
    assert_eq!(
        subscription_key(&config, false),
        json!([["g"], true, false]).to_string()
    );
    assert_eq!(
        subscription_key(&config, true),
        json!([["g"], true, true]).to_string()
    );
    assert_ne!(
        subscription_key(&config, false),
        subscription_key(&MessageConfig::default(), false)
    );
}

#[test]
fn conflict_message_matches_node_wording() {
    let conflict = channel_conflict("dingtalk", "/root/a", "/root/b".into());
    assert_eq!(conflict["code"], "CHANNEL_OCCUPIED");
    assert_eq!(
        conflict["error"],
        "DingTalk CLI is already occupied by /root/a. Switch to /root/b?"
    );
    let same = channel_conflict("feishu", "/root/a", "/root/a".into());
    assert_eq!(
            same["error"],
            "Feishu CLI is already occupied by /root/a. Stop its current listener before connecting another account."
        );
    assert_eq!(same["confirmationRequired"], false);
}

struct LifecycleFixture {
    home: PathBuf,
    service: Arc<MessagingService>,
}

#[cfg(unix)]
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl LifecycleFixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("kp-messaging-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        std::fs::create_dir_all(&root).unwrap();
        let rules = root.join(RULE_DIR);
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::write(rules.join("config.json"), default_config().to_string()).unwrap();
        std::fs::write(rules.join("SKILL.md"), DEFAULT_PROMPT).unwrap();
        let service = MessagingService::open(
            home.join("messaging"),
            PersonaStore::open(home.join("personas")),
            Arc::new(PresenceState::new()),
        );
        let mut run = MessagingService::new_runtime(super::service::Binding {
            id: "binding".into(),
            channel: "dingtalk".into(),
            root: root.to_string_lossy().into_owned(),
            profile: "corp:user".into(),
            enabled: true,
            ..Default::default()
        });
        run.status = "listening".into();
        run.identity = "corp:user".into();
        run.owns_identity = true;
        {
            let mut inner = service.lock();
            inner.identities.insert(run.identity.clone());
            inner.runs.insert("binding".into(), run);
        }
        Self { home, service }
    }
}

impl Drop for LifecycleFixture {
    fn drop(&mut self) {
        self.service.lock().closed = true;
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn first_verified_feishu_sweep_preserves_messages_while_connecting() {
    let f = LifecycleFixture::new();
    let mut inner = f.service.lock();
    let run = inner.runs.get_mut("binding").unwrap();
    run.binding.channel = "feishu".into();
    run.starting = true;
    run.status = "connecting".into();
    run.subscriptions = subscription_key(&MessageConfig::default(), false);
    assert!(matches!(
        super::inbox::decide_incoming(
            &mut inner,
            "binding",
            &message("first", "conversation", "hello", "direct"),
            false,
            false
        ),
        super::inbox::IncomingDecision::SaveQueue
    ));
    assert_eq!(inner.inbox["binding"].messages[0]["id"], "first");
    let run = inner.runs.get_mut("binding").unwrap();
    run.owns_identity = false;
    assert!(matches!(
        super::inbox::decide_incoming(
            &mut inner,
            "binding",
            &message("unverified", "conversation", "hello", "direct"),
            false,
            false
        ),
        super::inbox::IncomingDecision::Done
    ));
}

#[test]
fn explicitly_synced_message_is_not_admitted_again_when_the_live_event_arrives_late() {
    let f = LifecycleFixture::new();
    let message = message("synced-id", "conversation", "hello", "direct");
    let mut inner = f.service.lock();
    inner
        .inbox
        .entry("binding".into())
        .or_default()
        .messages
        .push(message.to_row("in", Some("synced")));
    assert!(matches!(
        super::inbox::decide_incoming(&mut inner, "binding", &message, false, false),
        super::inbox::IncomingDecision::Done
    ));
    assert_eq!(inner.inbox["binding"].messages.len(), 1);
    assert!(inner.runs["binding"].receipts.is_empty());
    assert!(inner.runs["binding"].queues.is_empty());
}

#[test]
fn live_messages_with_the_same_id_in_different_conversations_are_kept_separately() {
    let f = LifecycleFixture::new();
    let mut inner = f.service.lock();
    inner.runs.get_mut("binding").unwrap().since = 0;
    inner.runs.get_mut("binding").unwrap().subscriptions =
        subscription_key(&MessageConfig::default(), false);
    for conversation in ["first", "second"] {
        let incoming = message("shared-id", conversation, "hello", "direct");
        assert!(matches!(
            super::inbox::decide_incoming(&mut inner, "binding", &incoming, false, false),
            super::inbox::IncomingDecision::SaveQueue
        ));
    }
    assert_eq!(inner.inbox["binding"].messages.len(), 2);
    assert_eq!(inner.inbox["binding"].messages[0]["conversation"], "first");
    assert_eq!(inner.inbox["binding"].messages[1]["conversation"], "second");
}

#[tokio::test]
async fn stopped_feishu_poll_cannot_clear_a_replacement_connection() {
    let f = LifecycleFixture::new();
    let (replacement_stop, replacement_rx) = tokio::sync::watch::channel(false);
    {
        let mut inner = f.service.lock();
        let run = inner.runs.get_mut("binding").unwrap();
        run.generation = 2;
        run.stop = Some(replacement_stop);
    }
    let (old_stop, old_rx) = tokio::sync::watch::channel(false);
    old_stop.send_replace(true);
    let (done, done_rx) = tokio::sync::watch::channel(false);
    feishu_poll_task(
        Arc::clone(&f.service),
        "binding".into(),
        1,
        super::service::FeishuCheckpoint {
            since: now_ms(),
            window: None,
        },
        f.home.join("old-cursor.json"),
        old_rx,
        done,
    )
    .await;
    assert!(*done_rx.borrow());
    let inner = f.service.lock();
    let run = &inner.runs["binding"];
    assert!(run.stop.is_some());
    assert_eq!(run.status, "listening");
    assert!(!*replacement_rx.borrow());
    assert!(!f.home.join("old-cursor.json").exists());
}

#[tokio::test]
async fn disconnected_after_stop_preserves_the_stopped_state() {
    let f = LifecycleFixture::new();
    f.service.stop("binding");
    f.service
        .disconnected("binding", "Listener disconnected")
        .await;
    let view = f.service.view("binding").unwrap();
    assert_eq!(view["status"], "stopped");
    assert_eq!(view["autoReply"], false);
    assert_eq!(view["error"], "");
    assert_eq!(view["nextRetryAt"], Value::Null);
    assert!(f.service.lock().identities.is_empty());
}

#[tokio::test]
async fn disconnected_after_close_does_not_modify_runtime_state() {
    let f = LifecycleFixture::new();
    f.service.lock().closed = true;
    f.service
        .disconnected("binding", "Listener disconnected")
        .await;
    let inner = f.service.lock();
    let run = &inner.runs["binding"];
    assert_eq!(run.error, "");
    assert_eq!(run.identity, "corp:user");
    assert!(run.owns_identity);
    assert!(!run.retrying);
}

#[tokio::test]
async fn disconnected_while_listening_schedules_recovery() {
    let f = LifecycleFixture::new();
    f.service
        .disconnected("binding", "Listener disconnected")
        .await;
    let view = f.service.view("binding").unwrap();
    assert_eq!(view["status"], "reconnecting");
    assert_eq!(view["error"], "Listener disconnected");
    assert!(view["nextRetryAt"].as_i64().unwrap() > now_ms());
    assert!(f.service.lock().identities.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn start_failures_classify_occupied_and_invalid_identities_without_live_cli() {
    use std::os::unix::fs::PermissionsExt;

    let _env_lock = ENV_LOCK.lock().await;
    struct CliOverride(Option<std::ffi::OsString>);
    impl Drop for CliOverride {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => std::env::set_var("KEEPWORK_DWS_PATH", value),
                None => std::env::remove_var("KEEPWORK_DWS_PATH"),
            }
        }
    }
    let _restore = CliOverride(std::env::var_os("KEEPWORK_DWS_PATH"));
    for (name, response, expected) in [
        (
            "occupied",
            json!({"identity":{"corp_id":"corp","user_id":"user"},"bus":{"live":{"consumers":[{"id":"other-listener"}]}}}),
            "reconnecting",
        ),
        (
            "invalid-identity",
            json!({"identity":{"corp_id":"another-corp","user_id":"user"}}),
            "error",
        ),
        (
            "listener-subscription-failure",
            json!({"identity":{"corp_id":"corp","user_id":"user"}}),
            "error",
        ),
        (
            "listener-transient-failure",
            json!({"identity":{"corp_id":"corp","user_id":"user"}}),
            "reconnecting",
        ),
        (
            "invalid-rules",
            json!({"identity":{"corp_id":"corp","user_id":"user"}}),
            "error",
        ),
    ] {
        let f = LifecycleFixture::new();
        f.service.stop("binding");
        let cli = f.home.join(name);
        let diagnostics = if name == "listener-transient-failure" {
            "temporary connection loss"
        } else {
            "unsupported event"
        };
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\nif [ \"$2\" != status ]; then printf '%s\\n' '{}' >&2; exit 1; fi\nprintf '%s\\n' '{}'\n",
                diagnostics, response
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::env::set_var("KEEPWORK_DWS_PATH", &cli);
        if name == "invalid-rules" {
            std::fs::write(f.home.join("brain").join(RULE_DIR).join("config.json"), "{").unwrap();
        }

        let error = f.service.start("binding").await.unwrap_err();
        assert!(!error.message.is_empty());
        let view = f.service.view("binding").unwrap();
        assert_eq!(view["status"], expected, "{name}: {view}");
        assert_eq!(view["autoReply"], true);
        assert_eq!(view["needsRepair"], expected == "error");
        assert_eq!(view["nextRetryAt"].is_number(), expected == "reconnecting");
        assert!(!view["error"].as_str().unwrap().is_empty());
        assert!(f.service.lock().identities.is_empty());
    }

    for stopped in [true, false] {
        let f = LifecycleFixture::new();
        f.service.stop("binding");
        let root = f.home.join("brain");
        let cli = f.home.join("delayed-status");
        std::fs::write(
            &cli,
            "#!/bin/sh\nprintf ready > ready\nwhile [ ! -f release ]; do sleep 0.01; done\nprintf '%s\\n' '{\"identity\":{\"corp_id\":\"another-corp\",\"user_id\":\"user\"}}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::env::set_var("KEEPWORK_DWS_PATH", &cli);
        let service = Arc::clone(&f.service);
        let pending = tokio::spawn(async move { service.start("binding").await });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !root.join("ready").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if stopped {
            f.service.stop("binding");
        } else {
            f.service.lock().closed = true;
        }
        std::fs::write(root.join("release"), "").unwrap();
        pending.await.unwrap().unwrap();
        let view = f.service.view("binding").unwrap();
        assert_eq!(view["error"], "");
        assert_eq!(view["nextRetryAt"], Value::Null);
        if stopped {
            assert_eq!(view["status"], "stopped");
            assert_eq!(view["autoReply"], false);
        }
        assert!(f.service.lock().identities.is_empty());
    }
}
