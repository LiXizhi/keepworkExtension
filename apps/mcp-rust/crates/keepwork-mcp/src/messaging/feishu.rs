//! Feishu side: `lark-cli` identity, conversation, send, groups and event normalization.

use super::*;
use super::{cli::*, policy::*};

pub(crate) async fn feishu_identity(
    root: &str,
    profile: Option<&str>,
) -> Result<(String, String), DwsError> {
    let mut args = vec![
        "auth".into(),
        "status".into(),
        "--json".into(),
        "--verify".into(),
    ];
    if let Some(value) = profile {
        args.push("--profile".into());
        args.push(value.split(':').next().unwrap_or("").to_string());
    }
    let value = lark_call(&args, root).await?;
    parse_feishu_identity(&value, profile)
}

pub(crate) fn parse_feishu_identity(
    value: &Value,
    profile: Option<&str>,
) -> Result<(String, String), DwsError> {
    let user = value
        .pointer("/identities/user")
        .cloned()
        .unwrap_or(Value::Null);
    let open_id = user["openId"].as_str().unwrap_or("");
    let app_id = value["appId"].as_str().unwrap_or("");
    if user["status"].as_str() != Some("ready")
        || user["available"].as_bool() != Some(true)
        || user["verified"].as_bool() != Some(true)
        || open_id.is_empty()
        || app_id.is_empty()
    {
        return Err(DwsError {
            uncertain: false,
            message: "Feishu login required".into(),
        });
    }
    let id = format!("{app_id}:{open_id}");
    if let Some(profile) = profile {
        if id != profile {
            return Err(DwsError {
                uncertain: false,
                message: "Feishu identity does not match configured profile".into(),
            });
        }
    }
    Ok((id, open_id.to_string()))
}

pub(crate) async fn feishu_identity_checked(
    root: &str,
    profile: &str,
) -> Result<(String, String), MessageError> {
    feishu_identity(root, Some(profile))
        .await
        .map_err(|error| MessageError::bad(error.message))
}

pub(crate) fn feishu_page(value: &Value) -> Value {
    if value.get("data").is_some_and(Value::is_object) {
        value["data"].clone()
    } else {
        value.clone()
    }
}

/// Node-style `result.result || result.data || result` envelope unwrap.
pub(crate) fn unwrap_envelope(value: &Value) -> &Value {
    for key in ["result", "data"] {
        if let Some(inner) = value.get(key) {
            if inner.is_object() || inner.is_array() {
                return inner;
            }
        }
    }
    value
}

pub(crate) fn iso_ms(time: i64) -> String {
    chrono::DateTime::from_timestamp_millis(time)
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S+00:00").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string())
}

pub(crate) async fn feishu_conversation(
    root: &str,
    profile: &str,
    target: &Incoming,
) -> Result<Vec<Incoming>, MessageError> {
    let (_identity_id, self_id) = feishu_identity_checked(root, profile).await?;
    let read = |selector: Vec<String>| {
        let mut args = vec!["im".to_string()];
        args.extend(selector);
        args.extend(vec![
            "--order".into(),
            "desc".into(),
            "--page-size".into(),
            "50".into(),
            "--no-reactions".into(),
            "--as".into(),
            "user".into(),
            "--profile".into(),
            profile.split(':').next().unwrap_or("").to_string(),
            "--format".into(),
            "json".into(),
        ]);
        args
    };
    let mut rows = {
        let result = lark_call(
            &read(vec![
                "+chat-messages-list".into(),
                "--chat-id".into(),
                target.conversation.clone(),
            ]),
            root,
        )
        .await
        .map_err(|error| MessageError::bad(error.message))?;
        let data = feishu_page(&result);
        data["messages"]
            .as_array()
            .cloned()
            .ok_or_else(|| MessageError::bad("Unexpected Feishu conversation response"))?
    };
    let thread = target.thread.clone().or_else(|| {
        rows.iter()
            .find(|row| row["message_id"].as_str() == Some(target.id.as_str()))
            .and_then(|row| row["thread_id"].as_str().map(str::to_string))
    });
    if let Some(thread) = thread {
        let more = lark_call(
            &read(vec![
                "+threads-messages-list".into(),
                "--thread".into(),
                thread,
            ]),
            root,
        )
        .await
        .map_err(|error| MessageError::bad(error.message))?;
        let data = feishu_page(&more);
        if let Some(messages) = data["messages"].as_array() {
            rows.extend(messages.iter().cloned());
        }
    }
    let mut messages: HashMap<String, Incoming> = HashMap::new();
    for row in &rows {
        let row = json!({
            "message_id": row["message_id"].as_str().unwrap_or_default(),
            "sender": { "id": row.pointer("/sender/id").or_else(|| row.pointer("/sender/open_id")).cloned().unwrap_or(Value::Null) },
            "create_time": row["create_time"].as_i64().unwrap_or(0),
            "msg_type": "text",
            "content": if row["content"].is_string() { row["content"].clone() } else { json!("[非文本消息]") },
            "thread_id": row["thread_id"].clone(),
            "chat_mode": if target.kind == "direct" { "p2p" } else { "group" },
        });
        let normalized =
            feishu_incoming(&row, &json!({ "chat_id": target.conversation }), &self_id);
        if let Some(mut message) = normalized {
            message.automated = automated_sender(&row);
            messages.insert(message.id.clone(), message);
        }
    }
    let mut rows: Vec<Incoming> = messages.into_values().collect();
    rows.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id.cmp(&b.id)));
    Ok(rows)
}

pub(crate) async fn feishu_send(
    root: &str,
    profile: &str,
    target: &Incoming,
    id: &str,
    text: &str,
) -> Result<(), MessageError> {
    feishu_identity_checked(root, profile).await?;
    let marker = marker_tag(text);
    let body = if marker.is_empty() {
        text
    } else {
        &text[marker.len()..]
    };
    let parts = if marker.is_empty() {
        split_reply(body, 6000)
    } else {
        let budget = 6000 - marker.len();
        split_reply(body, budget)
            .into_iter()
            .map(|part| format!("{marker}{part}"))
            .collect::<Vec<_>>()
    };
    for (index, part) in parts.iter().enumerate() {
        let key = format!("{}:{}", id, index);
        let digest = sha256_hex(&[key.as_bytes()])[..48].to_string();
        let args = vec![
            "im".to_string(),
            "+messages-reply".to_string(),
            "--as".into(),
            "user".into(),
            "--profile".into(),
            profile.split(':').next().unwrap_or("").to_string(),
            "--message-id".into(),
            target.id.clone(),
            "--text".into(),
            part.clone(),
            "--idempotency-key".into(),
            digest,
            "--format".into(),
            "json".into(),
        ];
        lark_call(&args, root)
            .await
            .map_err(|error| MessageError::bad(error.message))?;
    }
    Ok(())
}

/// Marker tag like `【XX · AI】` / `【AI 代答】` at the start of a reply.
pub(crate) fn marker_tag(text: &str) -> String {
    let trimmed = text.trim_start();
    let end = match trimmed.find('】') {
        Some(end) => end,
        None => return String::new(),
    };
    // The tag ends at the closing bracket plus its byte length.
    let closing = "】".len();
    let full = &trimmed[..end + closing];
    if regex_is_match(r"^【[^【】\r\n]{1,80}\s*·\s*AI】$", full) {
        return full.to_string();
    }
    if full == "【AI 代答】" {
        return full.to_string();
    }
    String::new()
}

pub(crate) async fn feishu_groups(
    root: &str,
    profile: &str,
    query: &str,
) -> Result<Value, MessageError> {
    if query.chars().count() > 64 {
        return Err(MessageError::bad("飞书群名搜索最多 64 个字符"));
    }
    feishu_identity_checked(root, profile).await?;
    let mut args = vec!["im".to_string()];
    if query.is_empty() {
        args.extend(vec!["+chat-list".into(), "--types".into(), "group".into()]);
    } else {
        args.extend(vec![
            "+chat-search".into(),
            "--query".into(),
            query.to_string(),
            "--disable-search-by-user".into(),
            "--search-types".into(),
            "private,external,public_joined".into(),
            "--chat-modes".into(),
            "group".into(),
        ]);
    }
    args.extend(vec![
        "--page-size".into(),
        "50".into(),
        "--as".into(),
        "user".into(),
        "--profile".into(),
        profile.split(':').next().unwrap_or("").to_string(),
        "--format".into(),
        "json".into(),
    ]);
    let result = lark_call(&args, root)
        .await
        .map_err(|error| MessageError::bad(error.message))?;
    let data = feishu_page(&result);
    let rows = data["chats"]
        .as_array()
        .ok_or_else(|| MessageError::bad("Unexpected Feishu group response"))?;
    let chats: Vec<Value> = rows
        .iter()
        .filter(|g| g["chat_id"].is_string() && g["chat_status"].as_str() != Some("dissolved") && g["chat_mode"].as_str() != Some("p2p"))
        .take(50)
        .map(|g| json!({ "id": g["chat_id"].as_str().unwrap_or(""), "name": g["name"].as_str().unwrap_or(g["chat_id"].as_str().unwrap_or("")).to_string() }))
        .collect();
    Ok(json!({ "groups": chats }))
}

pub(crate) async fn feishu_group_name(
    root: &str,
    profile: &str,
    group: &str,
) -> Result<String, MessageError> {
    feishu_identity_checked(root, profile).await?;
    let result = lark_call(
        &[
            "im".into(),
            "chats".into(),
            "get".into(),
            "--chat-id".into(),
            group.to_string(),
            "--as".into(),
            "user".into(),
            "--profile".into(),
            profile.split(':').next().unwrap_or("").to_string(),
            "--format".into(),
            "json".into(),
        ],
        root,
    )
    .await
    .map_err(|error| MessageError::bad(error.message))?;
    let data = feishu_page(&result);
    if (data["chat_id"].is_string() && data["chat_id"].as_str() != Some(group))
        || !data["name"].is_string()
        || data["name"].as_str().unwrap_or("").trim().is_empty()
    {
        return Err(MessageError::bad("Group name unavailable"));
    }
    Ok(data["name"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(256)
        .collect())
}

/// Mirror of Node `feishuSenderName`: resolve a sender's display name through
/// the personal access token, returning an empty string when the directory
/// cannot confirm a name different from the open ID.
pub(crate) async fn feishu_sender_name(
    root: &str,
    profile: &str,
    sender: &str,
) -> Result<String, MessageError> {
    feishu_identity_checked(root, profile).await?;
    let args = vec![
        "contact".to_string(),
        "+search-user".to_string(),
        "--user-ids".into(),
        sender.to_string(),
        "--as".into(),
        "user".into(),
        "--profile".into(),
        profile.split(':').next().unwrap_or("").to_string(),
        "--format".into(),
        "json".into(),
    ];
    let result = lark_call(&args, root)
        .await
        .map_err(|error| MessageError::bad(error.message))?;
    let data = feishu_page(&result);
    let user = data["users"].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["open_id"].as_str() == Some(sender))
    });
    let name = user.and_then(|user| user["localized_name"].as_str());
    Ok(match name {
        Some(name) if name.trim() != sender => name.trim().chars().take(256).collect(),
        _ => String::new(),
    })
}

// ---------------------------------------------------------------------------
// DingTalk context / delivery helpers
// ---------------------------------------------------------------------------

/// Feishu search / message rows → Incoming.
pub fn feishu_incoming(row: &Value, chat: &Value, self_id: &str) -> Option<Incoming> {
    let sender = row
        .pointer("/sender/id")
        .or_else(|| row.pointer("/sender/open_id"))
        .and_then(Value::as_str)?;
    let time = parse_message_time_value(row.get("create_time")?)?;
    let msg_type = row["msg_type"]
        .as_str()
        .or_else(|| row["message_type"].as_str())
        .unwrap_or("");
    let content = row["content"].as_str()?;
    if row["deleted"].as_bool() == Some(true)
        || row["message_id"].as_str().is_none()
        || time == 0
        || !(msg_type == "text" || msg_type == "post")
    {
        return None;
    }
    if automated_sender(row) {
        return None;
    }
    let mut content = content.to_string();
    if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
        if let Some(text) = parsed["text"].as_str() {
            content = text.to_string();
        }
    }
    let mentioned_self = !self_id.is_empty()
        && row["mentions"]
            .as_array()
            .map(|rows| {
                rows.iter().any(|m| {
                    m["id"].as_str().map(|id| id == self_id).unwrap_or(false)
                        || m.pointer("/id/open_id")
                            .and_then(Value::as_str)
                            .map(|id| id == self_id)
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
    let chat_mode = chat["chat_mode"]
        .as_str()
        .unwrap_or(row["chat_type"].as_str().unwrap_or(""));
    let kind = if chat_mode == "p2p" {
        "direct"
    } else if mentioned_self {
        "mention"
    } else {
        "group"
    };
    let automated = automated_text(&content);
    Some(Incoming {
        id: row["message_id"].as_str().unwrap_or("").to_string(),
        conversation: chat["chat_id"].as_str().unwrap_or("").to_string(),
        sender: sender.to_string(),
        text: content,
        time,
        kind: kind.to_string(),
        thread: row["thread_id"].as_str().map(str::to_string),
        automated,
        mentioned_self,
        recovered: false,
    })
}
