//! Keepwork model calls: request building, SSE parsing, single-shot answers,
//! and tool-call turns for persona runs.

use super::*;
use super::{naming::*, store::*};

/// Prompt/model pair for messaging auto answers (`personaLookup` equivalent).
pub(crate) struct ModelReply {
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) model: String,
}

/// One tool call accumulated from a streamed model turn.
#[derive(Debug, Clone)]
pub(crate) struct ToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

/// One model turn: visible text plus any tool calls the model requested.
#[derive(Debug, Default, Clone)]
pub(crate) struct ModelTurn {
    pub(crate) content: String,
    pub(crate) tool_calls: Vec<ToolCall>,
    /// Stream ended with `finish_reason: "tool_calls"`.
    pub(crate) tool_stop: bool,
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
    let mut messages = vec![json!({ "role": "system", "content": prepared.system })];
    for (role, content) in &prepared.history {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({ "role": "user", "content": prepared.text }));
    let (content_type, body) =
        post_model(client, prepared.model, messages, None, cancel).await?;
    // The messaging pump has no executor loop; tool calls stay rejected there.
    parse_model_output(&content_type, &body)
}

/// One model turn with an optional `tools` payload; returns text plus tool
/// calls. Persona runs loop over this until the model answers in plain text.
pub(crate) async fn call_model_turn(
    client: AichatClient,
    model: String,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<ModelTurn, String> {
    if *cancel.borrow() {
        return Err("已取消".into());
    }
    let (content_type, body) = post_model(client, model, messages, tools, cancel).await?;
    parse_model_turn(&content_type, &body)
}

/// Posts one chat-completions request and returns `(content_type, body)`.
/// Cancel aborts the in-flight request.
async fn post_model(
    client: AichatClient,
    model: String,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(String, String), String> {
    let url = keepwork_chat_url(&client.base_url)?;
    let token = client.token;
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "reasoning": false,
        "max_tokens": 4000,
    });
    if let Some(tools) = tools {
        payload["tools"] = json!(tools);
    }
    let payload = payload.to_string();
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
        Ok((content_type, body))
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

/// Legacy text-only parse kept for the messaging pump path: tool calls are an
/// error, never silently dropped.
pub(crate) fn parse_model_output(content_type: &str, body: &str) -> Result<String, String> {
    let turn = parse_model_turn(content_type, body)?;
    if !turn.tool_calls.is_empty() || turn.tool_stop {
        return Err("本机 Rust 分身尚不支持工具调用，操作未执行。".into());
    }
    Ok(turn.content)
}

/// Grok-family chat endpoints stream tool calls as DSML markup inside the
/// plain content instead of `tool_calls` deltas. Extracts those blocks into
/// real tool calls so the persona executor can run them.
fn extract_dsml_tool_calls(turn: &mut ModelTurn) {
    let content = turn.content.clone();
    if !content.contains("<｜｜DSML｜｜") {
        return;
    }
    let invoke_re = regex::Regex::new(
        r#"<｜｜DSML｜｜ invoke name="([^"]*)">([\s\S]*?)</｜｜DSML｜｜ invoke>"#,
    )
    .expect("static dsml regex");
    let param_re = regex::Regex::new(
        r#"<｜｜DSML｜｜ parameter name="([^"]+)"[^<>]*>([\s\S]*?)</｜｜DSML｜｜ parameter>"#,
    )
    .expect("static dsml regex");
    let mut calls: Vec<ToolCall> = Vec::new();
    for (index, cap) in invoke_re.captures_iter(&content).enumerate() {
        let name = cap.get(1).map_or("", |m| m.as_str()).to_string();
        let body = cap.get(2).map(|m| m.as_str()).unwrap_or_default().to_string();
        let mut arguments = serde_json::Map::new();
        for param in param_re.captures_iter(&body) {
            let pname = param.get(1).map_or("", |p| p.as_str());
            let value = param.get(2).map(|p| p.as_str()).unwrap_or_default();
            arguments.insert(pname.to_string(), json!(value));
        }
        calls.push(ToolCall {
            id: format!("dsml-{index}"),
            name,
            arguments: Value::Object(arguments).to_string(),
        });
    }
    if calls.is_empty() {
        return;
    }
    turn.tool_calls.extend(calls);
    turn.content = invoke_re.replace_all(&content, "").to_string();
    let tag_re = regex::Regex::new(r#"<｜｜DSML｜｜ [^<>]*>|</｜｜DSML｜｜ [^<>]*>"#)
        .expect("static dsml regex");
    turn.content = tag_re.replace_all(turn.content.as_str(), "").trim().to_string();
}

pub(crate) fn parse_model_turn(content_type: &str, body: &str) -> Result<ModelTurn, String> {
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        let mut turn = parse_sse_turn(body)?;
        extract_dsml_tool_calls(&mut turn);
        return Ok(turn);
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Keepwork model returned an invalid response".to_string())?;
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Keepwork model returned an invalid response".into());
    }
    let mut turn = ModelTurn::default();
    if let Some(text) = value.get("result").and_then(Value::as_str) {
        turn.content.push_str(text);
    }
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        turn.content.push_str(text);
    }
    if let Some(calls) = value
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
    {
        for call in calls {
            push_message_tool_call(&mut turn, call);
        }
    }
    extract_dsml_tool_calls(&mut turn);
    if turn.content.is_empty() && turn.tool_calls.is_empty() {
        return Err("执行器未返回答案".into());
    }
    Ok(turn)
}

fn push_message_tool_call(turn: &mut ModelTurn, call: &Value) {
    let function = &call["function"];
    turn.tool_calls.push(ToolCall {
        id: call["id"].as_str().unwrap_or("").to_string(),
        name: function["name"].as_str().unwrap_or("").to_string(),
        arguments: function["arguments"].as_str().unwrap_or("").to_string(),
    });
}

/// SSE parse for one turn. Accumulates streamed `delta.tool_calls` by index;
/// `finish_reason: "tool_calls"` counts as a completed frame sequence.
pub(crate) fn parse_sse_turn(body: &str) -> Result<ModelTurn, String> {
    if body.len() > 8 * 1024 * 1024 {
        return Err("Keepwork model stream exceeds limit".into());
    }
    let mut normalized = body.replace("\r\n", "\n");
    let mut turn = ModelTurn::default();
    let mut pending: HashMap<usize, ToolCall> = HashMap::new();
    let mut finished = false;
    while let Some(boundary) = normalized.find("\n\n") {
        let frame = normalized[..boundary].to_string();
        normalized = normalized[boundary + 2..].to_string();
        consume_turn_frame(&frame, &mut turn, &mut pending, &mut finished)?;
    }
    if !normalized.trim().is_empty() {
        return Err("Keepwork model stream ended inside a frame; execution skipped".into());
    }
    if !finished {
        return Err("Keepwork model stream ended without completion; execution skipped".into());
    }
    let mut indexes: Vec<usize> = pending.keys().copied().collect();
    indexes.sort_unstable();
    for index in indexes {
        turn.tool_calls.push(pending.remove(&index).expect("checked"));
    }
    Ok(turn)
}

pub(crate) fn consume_turn_frame(
    raw: &str,
    turn: &mut ModelTurn,
    pending: &mut HashMap<usize, ToolCall>,
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
    if let Some(calls) = event
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    {
        for call in calls {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(pending.len() as u64) as usize;
            let slot = pending.entry(index).or_insert_with(|| ToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                if !name.is_empty() {
                    slot.name = name.to_string();
                }
            }
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                slot.arguments.push_str(arguments);
            }
        }
    }
    // Legacy single `function_call` delta: one call accumulated across frames.
    if let Some(function) = event.pointer("/choices/0/delta/function_call") {
        let slot = pending.entry(usize::MAX).or_insert_with(|| ToolCall {
            id: String::from("call_0"),
            name: String::new(),
            arguments: String::new(),
        });
        if let Some(name) = function.get("name").and_then(Value::as_str) {
            if !name.is_empty() {
                slot.name = name.to_string();
            }
        }
        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
            slot.arguments.push_str(arguments);
        }
    }
    if let Some(content) = event.get("result").and_then(Value::as_str) {
        turn.content.push_str(content);
    } else if let Some(content) = event
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        turn.content.push_str(content);
    }
    if reason == Some("stop")
        || reason == Some("tool_calls")
        || reason == Some("function_call")
        || event.get("is_end") == Some(&json!(true))
    {
        if reason != Some("stop") {
            turn.tool_stop = true;
        }
        *finished = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_tool_calls_accumulate_by_index() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{\\\"command\\\":\\\"dws\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" auth status\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let turn = parse_sse_turn(body).unwrap();
        assert_eq!(turn.content, "");
        assert_eq!(turn.tool_calls.len(), 1);
        let call = &turn.tool_calls[0];
        assert_eq!(call.id, "call_a");
        assert_eq!(call.name, "run_terminal");
        assert_eq!(call.arguments, "{\"command\":\"dws auth status\"}");
    }

    #[test]
    fn non_stream_tool_calls_parse_from_message() {
        let body = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_b",
                        "type": "function",
                        "function": { "name": "web_search", "arguments": "{\"query\":\"rust\"}" }
                    }]
                }
            }]
        })
        .to_string();
        let turn = parse_model_turn("application/json", &body).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "web_search");
    }

    #[test]
    fn dsml_tool_calls_extract_from_content() {
        let dsml = concat!(
            "我先查一下登录状态。\n",
            "<｜｜DSML｜｜ calls>\n",
            "<｜｜DSML｜｜ invoke name=\"run_terminal\">\n",
            "<｜｜DSML｜｜ parameter name=\"command\" string=\"true\">dws auth status</｜｜DSML｜｜ parameter>\n",
            "</｜｜DSML｜｜ invoke>\n",
            "</｜｜DSML｜｜ calls>"
        );
        let body = json!({
            "choices": [{
                "message": { "content": dsml }
            }]
        })
        .to_string();
        let turn = parse_model_turn("application/json", &body).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].id, "dsml-0");
        assert_eq!(turn.tool_calls[0].name, "run_terminal");
        assert_eq!(
            turn.tool_calls[0].arguments,
            "{\"command\":\"dws auth status\"}"
        );
        assert!(turn.content.contains("我先查一下登录状态。"));
        assert!(!turn.content.contains("DSML"));
    }

    #[test]
    fn parse_model_output_still_rejects_tool_calls() {
        let body = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_b",
                        "function": { "name": "run_terminal", "arguments": "{}" }
                    }]
                }
            }]
        })
        .to_string();
        assert!(parse_model_output("application/json", &body).is_err());
        assert!(
            parse_model_output("text/event-stream", "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n").is_err()
        );
    }

    #[test]
    fn plain_turns_keep_stream_semantics() {
        let success = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n";
        assert_eq!(parse_sse_turn(success).unwrap().content, "你好");
        assert!(parse_sse_turn("data: {\"result\":\"partial\"}\n\n").is_err());
        assert!(
            parse_sse_turn("data: {\"choices\":[{\"finish_reason\":\"length\"}]}\n\n").is_err()
        );
    }
}
