//! Keepwork model calls: request building, SSE parsing, single-shot answers.

use super::*;
use super::{naming::*, store::*};

/// Prompt/model pair for messaging auto answers (`personaLookup` equivalent).
pub(crate) struct ModelReply {
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) model: String,
}

/// Keepwork single-shot answer used by the messaging pump; the run machinery
/// cancels via `cancel`, the messaging path runs without a cancel channel.
pub(crate) async fn keepwork_answer(
    client: AichatClient,
    system: String,
    history: Vec<(String, String)>,
    text: String,
    model: String,
) -> Result<String, String> {
    let prepared = ModelRequest {
        system,
        history,
        text,
        model,
    };
    let (_cancel_tx, mut cancel) = tokio::sync::watch::channel(false);
    call_model(client, prepared, &mut cancel).await
}

pub(crate) async fn call_model(
    client: AichatClient,
    prepared: ModelRequest,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    if *cancel.borrow() {
        return Err("已取消".into());
    }
    let url = keepwork_chat_url(&client.base_url)?;
    let token = client.token;
    let mut messages = vec![json!({ "role": "system", "content": prepared.system })];
    for (role, content) in &prepared.history {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({ "role": "user", "content": prepared.text }));
    let payload = json!({
        "model": prepared.model,
        "messages": messages,
        "stream": true,
        "reasoning": false,
        "max_tokens": 4000,
    })
    .to_string();
    let mut request = tokio::spawn(async move {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.to_string())?;
        let response = http
            .post(url)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .header(header::AUTHORIZATION.as_str(), format!("Bearer {token}"))
            .body(payload)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("需要重新登录 AIChat".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Keepwork model request failed ({}); not retried",
                status.as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Keepwork model stream exceeds limit".into());
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        parse_model_output(&content_type, &body)
    });
    tokio::select! {
        _ = cancel.changed() => {
            request.abort();
            Err("已取消".into())
        }
        result = &mut request => match result {
            Ok(inner) => inner,
            Err(_) => Err("已取消".into()),
        }
    }
}

pub(crate) fn parse_model_output(content_type: &str, body: &str) -> Result<String, String> {
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        return parse_sse(body);
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Keepwork model returned an invalid response".to_string())?;
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Keepwork model returned an invalid response".into());
    }
    if let Some(text) = value.get("result").and_then(Value::as_str) {
        return Ok(text.to_string());
    }
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Ok(text.to_string());
    }
    Err("执行器未返回答案".into())
}

pub(crate) fn parse_sse(body: &str) -> Result<String, String> {
    if body.len() > 8 * 1024 * 1024 {
        return Err("Keepwork model stream exceeds limit".into());
    }
    let mut normalized = body.replace("\r\n", "\n");
    let mut text = String::new();
    let mut finished = false;
    while let Some(boundary) = normalized.find("\n\n") {
        let frame = normalized[..boundary].to_string();
        normalized = normalized[boundary + 2..].to_string();
        consume_frame(&frame, &mut text, &mut finished)?;
    }
    if !normalized.trim().is_empty() {
        return Err("Keepwork model stream ended inside a frame; execution skipped".into());
    }
    if !finished {
        return Err("Keepwork model stream ended without completion; execution skipped".into());
    }
    Ok(text)
}

pub(crate) fn consume_frame(
    raw: &str,
    text: &mut String,
    finished: &mut bool,
) -> Result<(), String> {
    let data = raw
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| line[5..].trim_start())
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(());
    }
    if data.trim() == "[DONE]" {
        *finished = true;
        return Ok(());
    }
    let event: Value = serde_json::from_str(&data)
        .map_err(|_| "Invalid Keepwork model stream frame".to_string())?;
    if !event.is_object() || event.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Keepwork model stream returned an error".into());
    }
    let reason = event
        .get("stop_reason")
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
        });
    if reason == Some("length") || reason == Some("content_filter") {
        return Err("Keepwork model stream incomplete; execution skipped".into());
    }
    if reason == Some("tool_calls")
        || reason == Some("function_call")
        || event.pointer("/choices/0/delta/tool_calls").is_some()
        || event.pointer("/choices/0/delta/function_call").is_some()
    {
        return Err("本机 Rust 分身尚不支持工具调用，操作未执行。".into());
    }
    if let Some(content) = event.get("result").and_then(Value::as_str) {
        text.push_str(content);
    } else if let Some(content) = event
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        text.push_str(content);
    }
    if reason == Some("stop") || event.get("is_end") == Some(&json!(true)) {
        *finished = true;
    }
    Ok(())
}
