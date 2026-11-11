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
    /// The service's complete, validated tool-call snapshot was received.
    finalized_tool_calls: bool,
    /// Streamed tool-call deltas were seen; only a snapshot may finish them.
    delta_tool_calls: bool,
    /// Legacy `delta.function_call` frames carried one call in full.
    legacy_function_call: bool,
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
        post_model(client, prepared.model, messages, None, cancel, None).await?;
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
    output: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<ModelTurn, String> {
    if *cancel.borrow() {
        return Err("已取消".into());
    }
    let (content_type, body) = post_model(client, model, messages, tools, cancel, output).await?;
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
    output: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<(String, String), String> {
    let url = keepwork_chat_url(&client.base_url)?;
    let token = client.token;
    let payload = model_payload(model, messages, tools);
    let payload = payload.to_string();
    let request = async move {
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
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("需要重新登录 AIChat".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Keepwork model request failed ({}); not retried",
                status.as_u16()
            ));
        }
        read_model_body(response, output).await
    };
    tokio::pin!(request);
    tokio::select! {
        _ = cancel.changed() => {
            Err("已取消".into())
        }
        result = &mut request => result,
    }
}

async fn read_model_body(
    mut response: reqwest::Response,
    mut output: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<(String, String), String> {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let streaming = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream");
    let mut preview = StreamPreview::default();
    let mut bytes = Vec::new();
    let mut published = String::new();
    let mut emitted = false;
    let mut ticks = tokio::time::interval(Duration::from_millis(100));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(|error| error.to_string())?,
            _ = ticks.tick(), if streaming && output.is_some() => {
                let text = preview.text();
                if text != published {
                    if let Some(output) = output.as_mut() {
                        output(&text);
                        published = text;
                        emitted = true;
                    }
                }
                continue;
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Keepwork model stream exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk);
        if streaming {
            preview.push(&chunk)?;
            // Publish the first prose immediately; ticks flush subsequent text
            // even when the upstream pauses without sending another chunk.
            if !emitted {
                if let Some(output) = output.as_mut() {
                    let text = preview.text();
                    if text != published {
                        output(&text);
                        published = text;
                        emitted = true;
                        ticks.reset();
                    }
                }
            }
        }
    }
    if streaming {
        let text = preview.text();
        if text != published {
            if let Some(output) = output.as_mut() {
                output(&text);
            }
        }
    }
    Ok((content_type, String::from_utf8_lossy(&bytes).into_owned()))
}

/// Parses only complete SSE frames, so UTF-8 and CRLF delimiters may span
/// arbitrary HTTP chunks. Preview text is provisional and never executes tools.
#[derive(Default)]
struct StreamPreview {
    buffer: Vec<u8>,
    turn: ModelTurn,
    pending: HashMap<usize, ToolCall>,
    finished: bool,
}

impl StreamPreview {
    fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.buffer.extend_from_slice(bytes);
        loop {
            let boundary = self.buffer.iter().enumerate().find_map(|(index, byte)| {
                if *byte != b'\n' {
                    return None;
                }
                if self.buffer.get(index + 1) == Some(&b'\n') {
                    Some((index, index + 2))
                } else if self.buffer.get(index + 1..index + 3) == Some(b"\r\n".as_slice()) {
                    Some((index, index + 3))
                } else {
                    None
                }
            });
            let Some((end, consumed)) = boundary else {
                break;
            };
            if end > 2 * 1024 * 1024 {
                return Err("Keepwork model stream frame exceeds limit".into());
            }
            let frame = String::from_utf8_lossy(&self.buffer[..end]);
            consume_turn_frame(
                &frame,
                &mut self.turn,
                &mut self.pending,
                &mut self.finished,
            )?;
            self.buffer.drain(..consumed);
        }
        if self.buffer.len() > 2 * 1024 * 1024 {
            return Err("Keepwork model stream frame exceeds limit".into());
        }
        Ok(())
    }

    fn text(&self) -> String {
        // DSML embeds tool arguments in content. Hide everything from its first
        // marker and hold a split marker suffix until it is known to be prose.
        let mut end = self.turn.content.len();
        for marker in ["<｜｜DSML｜｜", "</｜｜DSML｜｜"] {
            if let Some(index) = self.turn.content.find(marker) {
                end = end.min(index);
            }
            for (index, _) in marker.char_indices().skip(1) {
                if self.turn.content.ends_with(&marker[..index]) {
                    end = end.min(self.turn.content.len() - index);
                }
            }
        }
        self.turn.content[..end].chars().take(60_000).collect()
    }
}

/// Build the Keepwork chat payload. `localTools` is the public contract used
/// by AIChat's shared runtime; `tools` is an OpenAI-shaped field but is not
/// consumed by this endpoint.
fn model_payload(model: String, messages: Vec<Value>, tools: Option<Vec<Value>>) -> Value {
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "reasoning": false,
        "max_tokens": 4000,
    });
    if let Some(tools) = tools {
        payload["localTools"] = json!(tools);
    }
    payload
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
    // A validated snapshot is authoritative; DSML is only the fallback shape.
    if !turn.tool_calls.is_empty() {
        return;
    }
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
        let body = cap
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
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
    turn.content = tag_re
        .replace_all(turn.content.as_str(), "")
        .trim()
        .to_string();
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
        if boundary > 2 * 1024 * 1024 {
            return Err("Keepwork model stream frame exceeds limit".into());
        }
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
    if turn.finalized_tool_calls {
        if turn.tool_stop && turn.tool_calls.is_empty() {
            return Err("Keepwork model omitted finalized tool calls; execution skipped".into());
        }
    } else if turn.delta_tool_calls || (turn.tool_stop && !turn.legacy_function_call) {
        return Err("Keepwork model omitted finalized tool calls; execution skipped".into());
    } else if let Some(call) = pending.remove(&usize::MAX) {
        // Only the legacy single `function_call` shape may execute without a
        // snapshot; its arguments arrived in full before the stream finished.
        turn.tool_calls.push(call);
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
    // Delta tool frames carry partial arguments; the snapshot is the only
    // place a complete call may come from.
    if [
        event.get("tool_calls_delta"),
        event.pointer("/choices/0/delta/tool_calls"),
        event.pointer("/choices/0/message/tool_calls"),
    ]
    .iter()
    .any(|value| {
        value
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty())
    }) {
        turn.delta_tool_calls = true;
    }
    if let Some(value) = event.get("tool_calls").filter(|value| !value.is_null()) {
        let calls = value
            .as_array()
            .ok_or_else(|| "Invalid finalized tool calls; execution skipped".to_string())?;
        let mut finalized = Vec::with_capacity(calls.len());
        for (index, call) in calls.iter().enumerate() {
            let function = &call["function"];
            let name = function["name"].as_str().unwrap_or("");
            if name.is_empty() {
                return Err("Invalid finalized tool calls; execution skipped".into());
            }
            let id = call["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{index}"));
            let arguments = match &function["arguments"] {
                Value::String(arguments) if !arguments.trim().is_empty() => arguments.clone(),
                _ => "{}".to_string(),
            };
            finalized.push(ToolCall {
                id,
                name: name.to_string(),
                arguments,
            });
        }
        turn.tool_calls = finalized;
        turn.finalized_tool_calls = true;
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
        turn.legacy_function_call = true;
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
        // `is_end` alone only ends the stream; it never promises tool calls.
        if reason == Some("tool_calls") || reason == Some("function_call") {
            turn.tool_stop = true;
        }
        *finished = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn http_stream_publishes_trailing_text_while_upstream_is_idle() {
        use http_body_util::BodyExt;
        use tokio_stream::StreamExt;
        let (frames, incoming) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(incoming)
            .then(|bytes| async move { http_body_util::Full::new(bytes).frame().await.unwrap() });
        let body = reqwest::Body::wrap(http_body_util::StreamBody::new(stream));
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(body)
                .unwrap(),
        );
        let (updates, mut output) = tokio::sync::mpsc::unbounded_channel();
        let consumer = tokio::spawn(async move {
            let mut publish = move |text: &str| {
                let _ = updates.send(text.to_string());
            };
            read_model_body(response, Some(&mut publish)).await.unwrap()
        });
        frames
            .send(Bytes::from_static(b"data: {\"result\":\"hello\"}\n\n"))
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(1), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first, "hello");
        tokio::time::sleep(Duration::from_millis(20)).await;
        frames
            .send(Bytes::from_static(b"data: {\"result\":\" world\"}\n\n"))
            .unwrap();
        // Leave the connection open and idle: the update must not depend on a
        // further network chunk or EOF to leave the throttle buffer.
        let second = tokio::time::timeout(Duration::from_millis(500), output.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second, "hello world");
        assert!(!consumer.is_finished());
        frames
            .send(Bytes::from_static(b"data: [DONE]\n\n"))
            .unwrap();
        drop(frames);
        let (content_type, body) = consumer.await.unwrap();
        assert_eq!(
            parse_model_turn(&content_type, &body).unwrap().content,
            "hello world"
        );
    }

    #[test]
    fn preview_arrives_before_completion_across_utf8_and_crlf_chunks() {
        let body = "data: {\"result\":\"你好\"}\r\n\r\n";
        let mut preview = StreamPreview::default();
        for byte in body.as_bytes() {
            preview.push(&[*byte]).unwrap();
        }
        assert_eq!(preview.text(), "你好");
        assert!(!preview.finished);
        assert!(parse_model_turn("text/event-stream", body).is_err());
        preview.push(b"data: [DONE]\r\n\r\n").unwrap();
        assert!(preview.finished);
        assert_eq!(preview.text(), "你好");
    }

    #[test]
    fn preview_hides_tool_arguments_and_split_dsml_markers() {
        let mut preview = StreamPreview::default();
        for text in [
            "正在检查",
            "<",
            "｜｜DS",
            "ML｜｜ invoke name=\"run_terminal\">",
            "private-argument",
        ] {
            let frame = format!("data: {}\n\n", json!({"result": text}));
            preview.push(frame.as_bytes()).unwrap();
            assert_eq!(preview.text(), "正在检查");
        }
        let mut tools = StreamPreview::default();
        tools
            .push(b"data: {\"tool_calls_delta\":[{\"function\":{\"arguments\":\"secret\"}}]}\n\n")
            .unwrap();
        assert_eq!(tools.text(), "");
        assert!(parse_sse_turn("data: {\"tool_calls_delta\":[{\"function\":{\"arguments\":\"secret\"}}]}\n\ndata: [DONE]\n\n").is_err());
    }

    #[test]
    fn preview_rejects_oversized_frames_before_completion() {
        let mut preview = StreamPreview::default();
        assert!(preview
            .push(&vec![b'x'; 2 * 1024 * 1024 + 1])
            .unwrap_err()
            .contains("frame exceeds"));
    }

    #[test]
    fn streamed_tool_calls_accumulate_by_index() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{\\\"command\\\":\\\"dws\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" auth status\\\"}\"}}]}}]}\n\n",
            "data: {\"tool_calls\":[{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{\\\"command\\\":\\\"dws auth status\\\"}\"}}],\"stop_reason\":\"tool_calls\"}\n\n",
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
    fn delta_only_tool_calls_fail_closed() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let error = parse_sse_turn(body).unwrap_err();
        assert!(error.contains("finalized tool calls"));
    }

    #[test]
    fn tool_calls_delta_without_snapshot_fails_closed() {
        let body = concat!(
            "data: {\"tool_calls_delta\":[{\"index\":0,\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{}\"}}]}\n\n",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let error = parse_sse_turn(body).unwrap_err();
        assert!(error.contains("finalized tool calls"));
    }

    #[test]
    fn legacy_function_call_stream_executes_without_snapshot() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"run_terminal\",\"arguments\":\"{\\\"command\\\":\\\"dws\"}}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"function_call\":{\"arguments\":\" auth status\\\"}\"}}}]}\n\n",
            "data: {\"choices\":[{\"finish_reason\":\"function_call\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let turn = parse_sse_turn(body).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "run_terminal");
        assert_eq!(
            turn.tool_calls[0].arguments,
            "{\"command\":\"dws auth status\"}"
        );
    }

    #[test]
    fn is_end_without_a_tool_reason_is_a_plain_answer() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
            "data: {\"is_end\":true}\n\n"
        );
        let turn = parse_sse_turn(body).unwrap();
        assert_eq!(turn.content, "你好");
        assert!(turn.tool_calls.is_empty());
    }

    #[test]
    fn finalized_snapshot_supplies_id_and_empty_arguments() {
        let body = concat!(
            "data: {\"tool_calls\":[{\"function\":{\"name\":\"run_terminal\",\"arguments\":\"\"}}],\"stop_reason\":\"tool_calls\"}\n\n",
            "data: [DONE]\n\n"
        );
        let turn = parse_sse_turn(body).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].id, "call_0");
        assert_eq!(turn.tool_calls[0].arguments, "{}");
        assert_eq!(turn.tool_calls[0].name, "run_terminal");
    }

    #[test]
    fn model_payload_uses_keepwork_local_tools_contract() {
        let tools = vec![json!({"type":"function","function":{"name":"run_terminal"}})];
        let payload = model_payload(
            "keepwork-pro".into(),
            vec![json!({"role":"user","content":"hi"})],
            Some(tools),
        );
        assert!(payload.get("localTools").is_some());
        assert!(payload.get("tools").is_none());
    }

    #[test]
    fn finalized_snapshot_wins_over_dsml_markup() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"<｜｜DSML｜｜ invoke name=\\\"run_terminal\\\"><｜｜DSML｜｜ parameter name=\\\"command\\\" string=\\\"true\\\">rm -rf /tmp/x</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>\"}}]}\n\n",
            "data: {\"tool_calls\":[{\"id\":\"call_a\",\"function\":{\"name\":\"run_terminal\",\"arguments\":\"{\\\"command\\\":\\\"dws auth status\\\"}\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let turn = parse_model_turn("text/event-stream", body).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "run_terminal");
        assert_eq!(
            turn.tool_calls[0].arguments,
            "{\"command\":\"dws auth status\"}"
        );
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
        assert!(parse_model_output(
            "text/event-stream",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n"
        )
        .is_err());
    }

    #[test]
    fn plain_turns_keep_stream_semantics() {
        let success =
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n";
        assert_eq!(parse_sse_turn(success).unwrap().content, "你好");
        assert!(parse_sse_turn("data: {\"result\":\"partial\"}\n\n").is_err());
        assert!(
            parse_sse_turn("data: {\"choices\":[{\"finish_reason\":\"length\"}]}\n\n").is_err()
        );
    }
}
