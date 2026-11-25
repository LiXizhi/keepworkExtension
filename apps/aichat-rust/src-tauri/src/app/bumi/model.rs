//! Authenticated Keepwork inference used by Bumi camera observations and spoken commands.
use super::super::state::AppCore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

pub(super) const CHAT_URL: &str = "https://api.keepwork.com/core/v0/gpt/chat";
const LOGIN_REQUIRED: &str = "请先在 AIChat 主窗口登录 Keepwork。";
const MAX_RESPONSE_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct ResponseTiming {
    pub(super) headers: u64,
    pub(super) body: u64,
}
pub(super) async fn current_login(app: &AppHandle) -> Result<String, String> {
    let main = app.get_webview_window("main").ok_or(LOGIN_REQUIRED)?;
    let core = app.state::<Arc<AppCore>>();
    let document = main.url().map_err(|_| LOGIN_REQUIRED)?;
    if !matches!(document.scheme(), "http" | "https")
        || !crate::security::trusted_page(document.as_str(), core.current_dev_url().as_deref())
    {
        return Err(LOGIN_REQUIRED.into());
    }
    // Check the committed top-level origin and path again inside the evaluated
    // document. Do not embed URL queries, hashes or credentials in the script.
    let origin = serde_json::json!(document.origin().ascii_serialization());
    let path = serde_json::json!(document.path());
    let script = format!(
        r#"(() => {{
        if (window !== window.top || location.origin !== {origin} || location.pathname !== {path})
            return null;
        const sdk = window.keepwork;
        if (!sdk || typeof sdk.token !== "string" || !sdk.token || sdk.token.length > 8192)
            return null;
        const realm = new URL(sdk.baseURL, location.href).href.replace(/\/$/, "");
        if (realm !== "https://api.keepwork.com/core/v0" && realm !== "https://keepwork.com/core/v0")
            return null;
        return sdk.token;
    }})()"#
    );
    let (reply, result) = oneshot::channel();
    let reply = Mutex::new(Some(reply));
    main.eval_with_callback(script, move |value| {
        if let Some(reply) = reply.lock().unwrap().take() {
            let _ = reply.send(value);
        }
    })
    .map_err(|_| LOGIN_REQUIRED)?;
    let raw = tokio::time::timeout(Duration::from_secs(2), result)
        .await
        .map_err(|_| LOGIN_REQUIRED)?
        .map_err(|_| LOGIN_REQUIRED)?;
    if main.url().ok().as_ref() != Some(&document) {
        return Err(LOGIN_REQUIRED.into());
    }
    serde_json::from_str::<String>(&raw)
        .ok()
        .filter(|token| {
            !token.is_empty() && token.len() <= 8192 && token.bytes().all(|b| b.is_ascii_graphic())
        })
        .ok_or_else(|| LOGIN_REQUIRED.into())
}

fn append_model_text(raw: &str, output: &mut String) -> Result<bool, String> {
    let event: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Keepwork 模型响应格式无效。")?;
    let data = event
        .get("data")
        .filter(|data| data.is_object())
        .unwrap_or(&event);
    if !event.is_object()
        || [event.get("error"), data.get("error")]
            .into_iter()
            .flatten()
            .any(|e| !e.is_null())
    {
        return Err("Keepwork 模型返回错误。".into());
    }
    let mut finished = data["is_end"] == true;
    for reason in [
        data.get("stop_reason"),
        data.get("finish_reason"),
        data.pointer("/choices/0/finish_reason"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|reason| reason.as_str())
    .filter(|r| !r.is_empty())
    {
        if !matches!(reason, "stop" | "end_turn" | "completed") {
            return Err("Keepwork 模型未完整返回结果。".into());
        }
        finished = true;
    }
    if data["truncated"] == true
        || matches!(
            data["status"].as_str(),
            Some("incomplete" | "failed" | "cancelled")
        )
    {
        return Err("Keepwork 模型未完整返回结果。".into());
    }
    if let Some(text) = [
        data.get("result"),
        data.pointer("/choices/0/delta/content"),
        data.pointer("/choices/0/message/content"),
        data.get("content"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|field| field.as_str())
    .find(|text| !text.is_empty())
    {
        output.push_str(text);
    }
    Ok(finished)
}

fn append_sse_data(bytes: &[u8], text: &mut String) -> Result<bool, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "Keepwork 模型响应编码无效。")?;
    let mut complete = false;
    for part in raw
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
    {
        if part == "[DONE]" {
            complete = true;
        } else if !part.is_empty() {
            complete |= append_model_text(part, text)?;
        }
    }
    Ok(complete)
}

#[derive(Default)]
struct ModelResponse {
    body: Vec<u8>,
    event_start: usize,
    text: String,
    complete: bool,
}

impl ModelResponse {
    // A gateway may keep the HTTP body open after its terminal SSE event.
    // Consume all complete events in this chunk, including any reported error.
    fn push(&mut self, chunk: &[u8], streaming: bool) -> Result<bool, String> {
        let start = self.body.len();
        if chunk.len() > MAX_RESPONSE_BYTES - start {
            return Err("Keepwork 模型响应过大。".into());
        }
        self.body.extend_from_slice(chunk);
        if streaming {
            for index in start..self.body.len() {
                if self.body[index] != b'\n' {
                    continue;
                }
                let prefix = &self.body[..=index];
                if prefix.ends_with(b"\n\n") || prefix.ends_with(b"\n\r\n") {
                    self.complete |=
                        append_sse_data(&self.body[self.event_start..=index], &mut self.text)?;
                    self.event_start = index + 1;
                }
            }
        }
        Ok(self.complete && self.event_start == self.body.len())
    }

    fn into_text(mut self, streaming: bool) -> Result<String, String> {
        let remaining = &self.body[self.event_start..];
        if streaming {
            // Older gateways can close after the final data line without a blank line.
            self.complete |= append_sse_data(remaining, &mut self.text)?;
            if !self.complete {
                return Err("Keepwork 模型响应中断，请重新识别。".into());
            }
        } else {
            let raw = std::str::from_utf8(remaining).map_err(|_| "Keepwork 模型响应编码无效。")?;
            append_model_text(raw, &mut self.text)?;
        }
        if self.text.trim().is_empty() {
            return Err("模型未返回识别结果。".into());
        }
        Ok(self.text)
    }
}

fn network_error(stage: &str, error: reqwest::Error) -> String {
    let failure = if error.is_timeout() {
        "超时"
    } else {
        "失败"
    };
    let detail = crate::update_network::describe_request_error(error);
    format!("{stage}{failure}。{detail}")
}

pub(super) async fn request_model(
    token: &str,
    url: &str,
    body: &serde_json::Value,
    timeout: Duration,
    task: &str,
) -> Result<(String, ResponseTiming), String> {
    // Share the transport across observations. Credentials belong to this request.
    static CLIENT: tokio::sync::OnceCell<reqwest::Client> = tokio::sync::OnceCell::const_new();
    let client = CLIENT
        .get_or_try_init(|| async {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
        })
        .await
        .map_err(|e| network_error("初始化 Keepwork 模型客户端", e))?;
    let request = client
        .post(url)
        .timeout(timeout)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(body);
    let started = Instant::now();
    let mut response = request.send().await.map_err(|e| {
        let stage = if e.is_connect() {
            "连接 Keepwork 模型服务".to_string()
        } else {
            format!("向 Keepwork 发送{task}请求或等待响应头")
        };
        network_error(&stage, e)
    })?;
    let headers_received = Instant::now();
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Keepwork 登录已失效，请在 AIChat 主窗口重新登录。".into());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("当前 Keepwork 账号没有使用该模型的权限。".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Keepwork {task}请求失败（HTTP {}）。",
            status.as_u16()
        ));
    }
    let streaming = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("")
        .starts_with("text/event-stream");
    let mut model = ModelResponse::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| network_error(&format!("接收 Keepwork {task}结果"), e))?
    {
        if model.push(&chunk, streaming)? {
            break;
        }
    }
    let body_received = Instant::now();
    let text = model.into_text(streaming)?;
    Ok((
        text,
        ResponseTiming {
            headers: headers_received.duration_since(started).as_millis() as u64,
            body: body_received.duration_since(headers_received).as_millis() as u64,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_completed_keepwork_results_and_rejects_partial_or_failed_responses() {
        fn read_model_text(raw: &str, streaming: bool) -> Result<String, String> {
            let mut response = ModelResponse::default();
            response.push(raw.as_bytes(), streaming)?;
            response.into_text(streaming)
        }
        let complete = serde_json::json!({"data": {"result": "model result"}});
        assert_eq!(
            read_model_text(&complete.to_string(), false).unwrap(),
            "model result"
        );
        let partial = format!("data: {complete}\n\n");
        assert!(read_model_text(&partial, true).is_err());
        assert!(read_model_text(
            &(partial.clone() + "data: {\"error\":\"secret\"}\n\n"),
            true
        )
        .is_err());
        assert!(read_model_text(
            &(partial.clone() + "data: {\"stop_reason\":\"length\"}\n\ndata: [DONE]\n"),
            true
        )
        .is_err());
        let reason_only = serde_json::json!({"reasoning_content": "model result", "is_end":true});
        assert!(read_model_text(&format!("data: {reason_only}\n"), true).is_err());
    }

    #[test]
    fn only_complete_terminal_events_finish_chunked_sse() {
        let data = "data: {\"result\":\"中文\"}\r\n\r\n";
        for terminal in [
            "data: [DONE]\n\n",
            "data: {\"is_end\":true}\r\n\r\n",
            "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n",
        ] {
            let mut model = ModelResponse::default();
            let wire = [data, terminal].concat();
            for (i, byte) in wire.as_bytes().chunks(1).enumerate() {
                assert_eq!(model.push(byte, true).unwrap(), i + 1 == wire.len());
            }
            assert_eq!(model.into_text(true).unwrap(), "中文");
        }
        let mut model = ModelResponse::default();
        assert!(!model.push(data.as_bytes(), true).unwrap());
        // A following error started in this same read must be handled too.
        assert!(!model.push(b"data: [DONE]\n\ndata: {\"er", true).unwrap());
        assert!(model.push(b"ror\":{}}\n\n", true).is_err());
        let mut model = ModelResponse::default();
        assert!(model
            .push(b"data: [DONE]\n\ndata: {\"truncated\":true}\n\n", true)
            .is_err());
        assert!(ModelResponse::default()
            .push(&vec![0; MAX_RESPONSE_BYTES + 1], true)
            .is_err());
    }
}
