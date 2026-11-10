//! MCP Streamable HTTP transport: sessions, JSON/SSE negotiation, tools.
//!
//! Hand-rolled instead of `rmcp` because the daemon decides per session whether
//! replies are JSON or SSE (`capabilities.experimental["keepwork/streamedResponses"]`)
//! and injects `notifications/keepwork/*` on the GET stream.

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::http::{
    empty_response, json_response, mcp_json_response, now_iso, sse_response, AppState,
};
use crate::tools::{self, ToolContext};
use crate::{SERVER_NAME, SERVER_VERSION};

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

#[derive(Default)]
pub struct SessionStore {
    pub sessions: BTreeMap<String, ClientSession>,
    pub active_streams: HashSet<String>,
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
                StatusCode::NOT_FOUND,
                &json!({ "error": "Session not found" }),
            );
        }
        if method == "notifications/initialized" || id.is_none() {
            touch(state, &session_id);
            return empty_response(StatusCode::ACCEPTED, Some(&session_id));
        }
        touch(state, &session_id);
        let response = dispatch_message(state, &session_id, &method, id, parsed.get("params"));
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
                &json!({ "error": "invalid session" }),
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
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let delay = if first { 100 } else { 25_000 };
            first = false;
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            if closed.load(Ordering::SeqCst) {
                break;
            }
            let payload = format!("event: message\ndata: {frame}\n\n");
            if sender.send(Ok(Bytes::from(payload))).await.is_err() {
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

fn dispatch_message(
    state: &Arc<AppState>,
    session_id: &str,
    method: &str,
    id: Option<Value>,
    params: Option<&Value>,
) -> Value {
    let id = id.unwrap_or(Value::Null);
    match method {
        "ping" => json!({ "result": {}, "jsonrpc": "2.0", "id": id }),
        "tools/list" => json!({
            "result": { "tools": tools::list() },
            "jsonrpc": "2.0",
            "id": id,
        }),
        "tools/call" => {
            let name = params
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let ctx = ToolContext {
                port: state.port,
                root: &state.root,
                started_at: &state.started_at,
                require_auth: state.require_auth,
            };
            let result = tools::call(name, &ctx);
            if let Ok(mut store) = state.sessions.lock() {
                if let Some(session) = store.sessions.get_mut(session_id) {
                    session.call_count += 1;
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
