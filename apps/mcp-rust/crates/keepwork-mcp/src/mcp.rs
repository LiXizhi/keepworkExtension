//! MCP Streamable HTTP transport: sessions, JSON/SSE negotiation, tools.
//!
//! Hand-rolled instead of `rmcp` because the daemon decides per session whether
//! replies are JSON or SSE (`capabilities.experimental["keepwork/streamedResponses"]`)
//! and injects `notifications/keepwork/*` on the GET stream.

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::http::{
    empty_response, json_response, mcp_json_response, now_iso, sse_response, AppState,
};
use crate::tools::{self, ToolContext};
use crate::{SERVER_NAME, SERVER_VERSION};

const HISTORY_MAX: usize = 200;
const HISTORY_PAGE_DEFAULT: usize = 25;
const HISTORY_PAGE_MAX: usize = 200;

#[derive(Debug, Clone)]
pub struct ClientSession {
    pub session_id: String,
    pub origin: String,
    pub user_agent: String,
    pub connected_at: String,
    pub last_seen_at: String,
    pub call_count: u32,
    pub closed: Arc<AtomicBool>,
}

impl ClientSession {
    pub fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "origin": self.origin,
            "userAgent": self.user_agent,
            "connectedAt": self.connected_at,
            "lastSeenAt": self.last_seen_at,
            "callCount": self.call_count,
        })
    }
}

#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub time: String,
    pub session_id: String,
    pub origin: String,
    pub tool: String,
    pub summary: String,
    pub ok: bool,
    pub error: Option<String>,
    pub duration_ms: u64,
}

impl HistoryRow {
    pub fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("time".into(), json!(self.time));
        obj.insert("sessionId".into(), json!(self.session_id));
        obj.insert("origin".into(), json!(self.origin));
        obj.insert("tool".into(), json!(self.tool));
        obj.insert("summary".into(), json!(self.summary));
        obj.insert("ok".into(), json!(self.ok));
        if let Some(err) = &self.error {
            obj.insert("error".into(), json!(err));
        }
        obj.insert("durationMs".into(), json!(self.duration_ms));
        Value::Object(obj)
    }
}

#[derive(Default)]
pub struct SessionStore {
    pub sessions: BTreeMap<String, ClientSession>,
    pub active_streams: HashSet<String>,
    pub history: VecDeque<HistoryRow>,
}

impl SessionStore {
    pub fn list_history(&self, offset: Option<usize>, limit: Option<usize>) -> Value {
        let total = self.history.len();
        let off = offset.unwrap_or(0).min(total);
        let lim = limit
            .filter(|&l| l > 0)
            .unwrap_or(HISTORY_PAGE_DEFAULT)
            .clamp(1, HISTORY_PAGE_MAX);
        let mut items = Vec::new();
        if total > off {
            let newest = total - 1 - off;
            for i in 0..lim {
                if let Some(idx) = newest.checked_sub(i) {
                    if let Some(row) = self.history.get(idx) {
                        items.push(row.to_json());
                    }
                } else {
                    break;
                }
            }
        }
        let has_more = off + items.len() < total;
        json!({
            "ok": true,
            "history": items,
            "total": total,
            "offset": off,
            "limit": lim,
            "hasMore": has_more,
        })
    }
}

fn summarize_args(tool: &str, args: &Value) -> String {
    let raw = match tool {
        "run_terminal" => args
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "grep_files" => args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "web_search" => args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "fetch_url" => args
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => serde_json::to_string(args).unwrap_or_default(),
    };
    raw.chars().take(200).collect()
}

fn header_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string()
}

pub async fn handle_post(state: &Arc<AppState>, headers: &HeaderMap, body: &[u8]) -> Response {
    let session_id = header_value(headers, "mcp-session-id");
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return mcp_json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "jsonrpc": "2.0", "error": { "code": -32700, "message": "Parse error" }, "id": null }),
                None,
            )
        }
    };
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let id = parsed.get("id").cloned();

    if !session_id.is_empty() {
        let known = state
            .sessions
            .lock()
            .map(|store| store.sessions.contains_key(&session_id))
            .unwrap_or(false);
        if !known {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({
                    "error": "invalid session",
                    "hint": "POST initialize without Mcp-Session-Id to start a session",
                }),
            );
        }
        if method == "notifications/initialized" || id.is_none() {
            touch(state, &session_id);
            return empty_response(StatusCode::ACCEPTED, Some(&session_id));
        }
        touch(state, &session_id);
        let origin = header_value(headers, "origin");
        let response = dispatch_message(
            state,
            &session_id,
            &origin,
            &method,
            id,
            parsed.get("params"),
        )
        .await;
        return mcp_json_response(StatusCode::OK, &response, Some(&session_id));
    }

    if method != "initialize" {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({
                "error": "invalid session",
                "hint": "POST initialize without Mcp-Session-Id to start a session",
            }),
        );
    }

    let created = {
        let now = now_iso();
        let mut store = state.sessions.lock().expect("session store");
        let session_id = uuid::Uuid::new_v4().to_string();
        store.sessions.insert(
            session_id.clone(),
            ClientSession {
                session_id: session_id.clone(),
                origin: header_value(headers, "origin"),
                user_agent: header_value(headers, "user-agent"),
                connected_at: now.clone(),
                last_seen_at: now,
                call_count: 0,
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        session_id
    };

    let result = initialize_result(parsed.get("params"));
    let body = json!({
        "result": result,
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
    });

    if wants_streamed_replies(parsed.get("params")) {
        let frame = format!("event: message\ndata: {body}\n\n");
        return sse_response(Body::from(frame), &created);
    }
    mcp_json_response(StatusCode::OK, &body, Some(&created))
}

pub fn handle_get(state: &Arc<AppState>, headers: &HeaderMap) -> Response {
    let session_id = header_value(headers, "mcp-session-id");
    if session_id.is_empty() {
        let accept = header_value(headers, "accept").to_ascii_lowercase();
        if accept.contains("text/html") && !accept.contains("text/event-stream") {
            return Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "/dashboard")
                .body(Body::empty())
                .expect("valid redirect response");
        }
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({
                "error": "invalid session",
                "hint": "POST initialize without Mcp-Session-Id to start a session",
            }),
        );
    }

    let closed = {
        let mut store = state.sessions.lock().expect("session store");
        if !store.sessions.contains_key(&session_id) {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({
                    "error": "invalid session",
                    "hint": "POST initialize without Mcp-Session-Id to start a session",
                }),
            );
        }
        if store.active_streams.contains(&session_id) {
            return json_response(
                StatusCode::CONFLICT,
                &json!({ "error": "MCP stream already open" }),
            );
        }
        store.active_streams.insert(session_id.clone());
        let session = store.sessions.get_mut(&session_id).expect("checked above");
        session.last_seen_at = now_iso();
        Arc::clone(&session.closed)
    };

    let health = {
        let mut caps = state.health_capabilities();
        caps.insert("runtimeEngine".into(), json!(crate::ENGINE));
        Value::Object(caps)
    };
    let frame = json!({
        "jsonrpc": "2.0",
        "method": "notifications/keepwork/alive",
        "params": { "health": health },
    })
    .to_string();

    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let state_clone = Arc::clone(state);
    let session_for_task = session_id.clone();
    let personas = Arc::clone(&state.personas);
    tokio::spawn(async move {
        // Persona data changes are pushed as `personas_changed`; the browser
        // client filters them by owner and re-reads the snapshot, so one frame
        // per wake-up is enough and bursts coalesce without losing the update.
        let alive_frame = format!("event: message\ndata: {frame}\n\n");
        let changed_frame = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/keepwork/personas_changed\"}\n\n";
        let mut changes = personas.changed.subscribe();
        let mut alive = tokio::time::interval(std::time::Duration::from_secs(25));
        alive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        alive.tick().await;
        loop {
            let push = tokio::select! {
                _ = sender.closed() => break,
                _ = alive.tick() => alive_frame.as_str(),
                received = changes.recv() => match received {
                    Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => changed_frame,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            };
            if closed.load(Ordering::SeqCst) {
                break;
            }
            if sender
                .send(Ok(Bytes::from(push.to_string())))
                .await
                .is_err()
            {
                break;
            }
        }
        if let Ok(mut store) = state_clone.sessions.lock() {
            store.active_streams.remove(&session_for_task);
        }
    });

    sse_response(
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver)),
        &session_id,
    )
}

pub fn handle_delete(state: &Arc<AppState>, headers: &HeaderMap) -> Response {
    let session_id = header_value(headers, "mcp-session-id");
    let removed = {
        let mut store = state.sessions.lock().expect("session store");
        let Some(session) = store.sessions.remove(&session_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "Session not found" }),
            );
        };
        session.closed.store(true, Ordering::SeqCst);
        store.active_streams.remove(&session_id);
        true
    };
    if removed {
        state.presence.note_session_closed(&session_id);
        empty_response(StatusCode::OK, None)
    } else {
        json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "Session not found" }),
        )
    }
}

fn touch(state: &Arc<AppState>, session_id: &str) {
    if let Ok(mut store) = state.sessions.lock() {
        if let Some(session) = store.sessions.get_mut(session_id) {
            session.last_seen_at = now_iso();
        }
    }
    state.presence.touch(session_id);
}

fn wants_streamed_replies(params: Option<&Value>) -> bool {
    params
        .and_then(|params| params.get("capabilities"))
        .and_then(|capabilities| capabilities.get("experimental"))
        .and_then(|experimental| experimental.get("keepwork/streamedResponses"))
        .and_then(|preference| preference.get("version"))
        .and_then(Value::as_i64)
        == Some(1)
}

fn initialize_result(params: Option<&Value>) -> Value {
    let protocol = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": protocol,
        "capabilities": {
            "tools": { "listChanged": true },
            "resources": { "listChanged": true },
            "experimental": { "keepwork/events": { "version": 1, "presence": "mcp-v1" } },
        },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
    })
}

async fn dispatch_message(
    state: &Arc<AppState>,
    session_id: &str,
    origin: &str,
    method: &str,
    id: Option<Value>,
    params: Option<&Value>,
) -> Value {
    let id = id.unwrap_or(Value::Null);
    match method {
        "ping" => json!({ "result": {}, "jsonrpc": "2.0", "id": id }),
        "keepwork/presence" => {
            if !crate::presence::presence_origin_allowed(origin) {
                return json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32600, "message": "AIChat presence rejected" },
                });
            }
            let is_live = state
                .sessions
                .lock()
                .map(|s| s.sessions.contains_key(session_id))
                .unwrap_or(false);
            if !is_live {
                return json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32600, "message": "AIChat presence rejected" },
                });
            }
            match state.presence.handle_mcp_params(session_id, origin, params) {
                Ok(_) => json!({
                    "result": { "remembered": true },
                    "jsonrpc": "2.0",
                    "id": id,
                }),
                Err(_) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32600, "message": "AIChat presence rejected" },
                }),
            }
        }
        "tools/list" => json!({
            "result": { "tools": tools::list() },
            "jsonrpc": "2.0",
            "id": id,
        }),
        "tools/call" => {
            let name = params
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params
                .and_then(|params| params.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let summary = summarize_args(&name, &args);
            let ctx = ToolContext {
                port: state.port,
                root: &state.root,
                started_at: &state.started_at,
                require_auth: state.require_auth,
                session: session_id,
            };
            let started = Instant::now();
            let result = tools::call(&name, &args, &ctx, &state.shell).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            let is_err = result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let err_msg = if is_err {
                result
                    .get("content")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.first())
                    .and_then(|item| item.get("text"))
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(200).collect::<String>())
            } else {
                None
            };
            if let Ok(mut store) = state.sessions.lock() {
                if let Some(session) = store.sessions.get_mut(session_id) {
                    session.call_count += 1;
                    session.last_seen_at = now_iso();
                    if !origin.is_empty() {
                        session.origin = origin.to_string();
                    }
                }
                store.history.push_back(HistoryRow {
                    time: now_iso(),
                    session_id: session_id.to_string(),
                    origin: origin.to_string(),
                    tool: name,
                    summary,
                    ok: !is_err,
                    error: err_msg,
                    duration_ms,
                });
                while store.history.len() > HISTORY_MAX {
                    store.history.pop_front();
                }
            }
            json!({ "result": result, "jsonrpc": "2.0", "id": id })
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") },
        }),
    }
}

/// Drops sessions idle beyond the 30-minute window unless a GET stream is live.
pub fn prune_idle(state: &Arc<AppState>) {
    let Ok(mut store) = state.sessions.lock() else {
        return;
    };
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(30);
    let stale: Vec<String> = store
        .sessions
        .iter()
        .filter(|(id, session)| {
            !store.active_streams.contains(*id)
                && chrono::DateTime::parse_from_rfc3339(&session.last_seen_at)
                    .map(|seen| seen.with_timezone(&chrono::Utc) < cutoff)
                    .unwrap_or(false)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        if let Some(session) = store.sessions.remove(&id) {
            session.closed.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_replies_require_version_one() {
        let opted = json!({ "capabilities": { "experimental": { "keepwork/streamedResponses": { "version": 1 } } } });
        let legacy = json!({ "capabilities": {} });
        assert!(wants_streamed_replies(Some(&opted)));
        assert!(!wants_streamed_replies(Some(&legacy)));
        assert!(!wants_streamed_replies(None));
    }

    #[test]
    fn initialize_capabilities_match_node() {
        let result = initialize_result(Some(&json!({ "protocolVersion": "2024-11-05" })));
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["capabilities"]["tools"]["listChanged"], true);
        assert_eq!(
            result["capabilities"]["experimental"]["keepwork/events"]["presence"],
            "mcp-v1"
        );
        assert_eq!(result["serverInfo"]["name"], "keepwork-mcp");
        assert_eq!(result["serverInfo"]["version"], "0.1.2");
    }
}
