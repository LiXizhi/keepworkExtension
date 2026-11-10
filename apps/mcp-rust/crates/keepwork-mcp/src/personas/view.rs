//! Persona row projections: views, summaries and message details.

use super::*;
use super::{store::*, util::*};

pub(crate) fn normalize_loaded(row: &mut Value) {
    if is_active(row) {
        row["job"]["state"] = json!("unknown");
        row["job"]["error"] = json!("服务已重启，任务未重放");
        row["job"]["pending"] = json!([]);
    }
    let now = now_ms();
    if let Some(schedules) = row.get_mut("schedules").and_then(Value::as_array_mut) {
        for schedule in schedules {
            if schedule["enabled"] != json!(true) {
                continue;
            }
            let time = schedule["time"].as_str().unwrap_or("");
            let timezone = schedule["timezone"].as_str().unwrap_or("");
            match next_persona_run(time, timezone, now) {
                Ok(next) => schedule["next"] = json!(next),
                Err(error) => {
                    schedule["enabled"] = json!(false);
                    schedule["last"] = json!(error.message);
                }
            }
        }
    }
}

pub(crate) fn peer_count(inner: &Inner, owner: &str, id: &str) -> usize {
    inner
        .rows
        .values()
        .filter(|row| row["owner"].as_str() == Some(owner) && row["id"].as_str() != Some(id))
        .count()
}

pub(crate) fn peer_names(inner: &Inner, owner: &str, id: &str) -> Value {
    let peers: Vec<Value> = inner
        .rows
        .values()
        .filter(|row| row["owner"].as_str() == Some(owner) && row["id"].as_str() != Some(id))
        .map(|row| json!({ "id": row["id"].as_str().unwrap_or(""), "name": row["name"].as_str().unwrap_or("") }))
        .collect();
    Value::Array(peers)
}

pub(crate) fn has_request(row: &Value, request_id: &str) -> bool {
    matches!(row["requests"].get(request_id), Some(value) if !value.is_null())
}

pub(crate) fn next_message_time(row: &Value) -> i64 {
    let last = row["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| json_i64(&message["time"]))
        .unwrap_or(0);
    now_ms().max(last + 1)
}

pub(crate) fn unread_count(row: &Value) -> i64 {
    let read_at = json_i64(&row["readAt"]).unwrap_or(0);
    row["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message["role"] == json!("assistant")
                        && json_i64(&message["time"]).unwrap_or(0) > read_at
                })
                .count() as i64
        })
        .unwrap_or(0)
}

pub(crate) fn summarize(messages: &[Value]) -> String {
    if messages.len() <= 1 {
        return String::new();
    }
    let end = messages.len() - 1;
    let history_start = end.saturating_sub(16);
    let earlier = &messages[..history_start];
    let start = earlier.len().saturating_sub(40);
    chars_tail(
        &earlier[start..]
            .iter()
            .map(|message| {
                format!(
                    "{}: {}",
                    message["role"].as_str().unwrap_or(""),
                    chars_take(message["text"].as_str().unwrap_or(""), 300)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        12_000,
    )
}

pub(crate) fn history_of(messages: &[Value]) -> Vec<(String, String)> {
    if messages.len() <= 1 {
        return Vec::new();
    }
    let end = messages.len() - 1;
    let start = end.saturating_sub(16);
    messages[start..end]
        .iter()
        .filter_map(|message| {
            let role = message["role"].as_str()?;
            if role != "user" && role != "assistant" {
                return None;
            }
            Some((
                role.to_string(),
                chars_take(message["text"].as_str().unwrap_or(""), 8_000),
            ))
        })
        .collect()
}

pub(crate) fn resolve_model(row: &Value) -> String {
    let executor = row["executor"].as_str().unwrap_or("auto");
    let backend = if executor == "auto" {
        row["preference"]["backend"].as_str().unwrap_or("keepwork")
    } else {
        executor
    };
    if backend != "keepwork" {
        return "keepwork-pro".into();
    }
    let model = row["model"].as_str().unwrap_or("").trim();
    if !model.is_empty() {
        return model.to_string();
    }
    let preferred = if row["preference"]["backend"] == "keepwork" {
        row["preference"]["model"].as_str().unwrap_or("").trim()
    } else {
        ""
    };
    if !preferred.is_empty() {
        return preferred.to_string();
    }
    "keepwork-pro".into()
}

pub(crate) fn classify_failure(message: &str) -> (String, Option<String>) {
    if message == "已取消" {
        return ("cancelled".into(), Some(message.to_string()));
    }
    let lower = message.to_lowercase();
    if message.contains('登') && message.contains('录') || lower.contains("login") {
        ("needs-login".into(), Some(message.to_string()))
    } else {
        ("error".into(), Some(message.to_string()))
    }
}

pub(crate) struct Detail {
    pub(crate) before: i64,
    pub(crate) peers: usize,
}

pub(crate) fn digest_gate() -> &'static Regex {
    static GATE: OnceLock<Regex> = OnceLock::new();
    GATE.get_or_init(|| Regex::new("(?i)消息|收件|钉钉|未读|inbox").expect("static regex"))
}

pub(crate) fn project_view(row: &Value, detail: Option<Detail>) -> Value {
    let unread = unread_count(row);
    let execution = answer_execution(row);
    let mut view = row.clone();
    if let Some(object) = view.as_object_mut() {
        for key in [
            "owner",
            "messages",
            "requests",
            "summary",
            "cliApprovalGrant",
            "sales",
        ] {
            object.remove(key);
        }
    }
    if view.get("messaging").map(Value::is_null).unwrap_or(false) {
        view.as_object_mut()
            .map(|object| object.remove("messaging"));
    }
    if !view["schedules"].is_array() {
        view["schedules"] = json!([]);
    }
    if !view["pinned"].is_boolean() {
        view["pinned"] = json!(true);
    }
    view["wechatStatus"] = json!("未绑定");
    view["sales"] = Value::Null;
    view["taskContextVersion"] = json!(1);
    view["groupWorkActive"] = json!(false);
    view["nicknameSync"] = json!({ "pending": false, "warnings": [] });
    view["cliApproval"] = json!({ "scope": "ask" });
    view["channels"] = json!([]);
    view["unread"] = json!(unread);
    if view.get("job").map(|job| job.is_object()).unwrap_or(false) {
        if !view["job"]["pending"].is_array() {
            view["job"]["pending"] = json!([]);
        }
        if let Some(execution) = execution {
            view["job"]["execution"] = execution;
        }
    } else {
        view.as_object_mut().map(|object| object.remove("job"));
    }
    if let Some(detail) = detail {
        let (messages, before) = detail_messages(row, detail.before);
        view["messages"] = Value::Array(messages);
        view["before"] = before.map(Value::from).unwrap_or(Value::Null);
        view["peerCount"] = json!(detail.peers);
    }
    view
}

pub(crate) fn answer_execution(row: &Value) -> Option<Value> {
    let job_id = row["job"]["id"].as_str()?;
    let answer_id = format!("{job_id}-answer");
    row["messages"].as_array().and_then(|messages| {
        messages
            .iter()
            .find(|message| message["id"].as_str() == Some(answer_id.as_str()))
            .and_then(|message| message.get("execution").cloned())
    })
}

pub(crate) fn detail_messages(row: &Value, before: i64) -> (Vec<Value>, Option<i64>) {
    let mut rows: Vec<Value> = row["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|message| json_i64(&message["time"]).unwrap_or(0) < before)
        .collect();
    if rows.len() > 50 {
        rows = rows.split_off(rows.len() - 50);
    }
    let cursor = if rows.len() == 50 {
        json_i64(&rows[0]["time"])
    } else {
        None
    };
    (rows, cursor)
}

#[cfg(unix)]
pub(crate) fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub(crate) fn restrict_file(_path: &Path) {}
