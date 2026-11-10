use super::*;
use super::{dingtalk::*, feishu::*, lifecycle::*, policy::*};

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
