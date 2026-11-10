//! AIChat presence and client registration (mirrors `src/core/aichatPresence.ts`
//! and `src/mcp/aichatPresence.ts`).
//!
//! Exposes `POST /aichat/presence` (both standard JSON reply and `?stream=1` SSE)
//! and the MCP JSON-RPC method `keepwork/presence`.

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::http::{json_response, sse_response, AppState};

const MAX_PRESENCE_BODY_BYTES: u64 = 16_384;
const BACKENDS: &[&str] = &[
    "keepwork",
    "copilot",
    "codex",
    "claude",
    "workbuddy",
    "cursor",
    "trae",
    "qwen",
    "gemini",
    "kimi",
    "codebuddy",
    "opencode",
];

pub fn presence_origin_allowed(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.origin().ascii_serialization() != origin {
        return false;
    }
    match url.scheme() {
        "https" => matches!(
            url.host_str(),
            Some("keepwork.com") | Some("cdn.keepwork.com")
        ),
        "http" => matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

pub fn sanitize_client_url(value: &str) -> Result<String, &'static str> {
    let mut parsed = url::Url::parse(value).map_err(|_| "AIChat page must be http(s)")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("AIChat page must be http(s)");
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_fragment(None);

    let secret_re =
        regex::Regex::new(r"(?i)token|password|secret|authorization|api[_-]?key|cookie")
            .expect("secret regex");

    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| !secret_re.is_match(key))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    if pairs.is_empty() {
        parsed.set_query(None);
    } else {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in pairs {
            serializer.append_pair(&k, &v);
        }
        parsed.set_query(Some(&serializer.finish()));
    }
    Ok(parsed.to_string())
}

fn sanitize_base_url(value: Option<&str>) -> Result<String, &'static str> {
    let Some(raw) = value else {
        return Ok(String::new());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Invalid AIChat base URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Invalid AIChat base URL");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Invalid AIChat base URL");
    }
    let origin = parsed.origin().ascii_serialization();
    let path = parsed.path().trim_end_matches('/');
    Ok(format!("{origin}{path}"))
}

fn sanitize_default_executor(val: Option<&Value>) -> Option<Value> {
    let obj = val?.as_object()?;
    let backend = obj.get("backend")?.as_str()?;
    if !BACKENDS.contains(&backend) {
        return None;
    }
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .map(|m| if m.len() > 256 { &m[..256] } else { m })
        .unwrap_or("");
    Some(json!({
        "backend": backend,
        "model": model,
    }))
}

fn valid_brain_path(val: Option<&str>) -> Option<String> {
    let raw = val?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = std::path::Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    if path.is_dir() {
        std::fs::canonicalize(path)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AichatClient {
    pub url: String,
    pub token: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "seenAt")]
    pub seen_at: i64,
    #[serde(rename = "defaultExecutor", skip_serializing_if = "Option::is_none")]
    pub default_executor: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct StoredClient {
    pub session_id: String,
    pub client: AichatClient,
}

pub struct RememberClientInput<'a> {
    pub session_id: &'a str,
    pub url: &'a str,
    pub token: &'a str,
    pub base_url: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub origin: &'a str,
    pub handler: bool,
    pub brain_root: Option<&'a str>,
    pub default_executor: Option<&'a Value>,
}

pub struct PresenceState {
    current: Mutex<Option<StoredClient>>,
    owners: Mutex<HashMap<String, StoredClient>>,
    connection_order: Mutex<HashMap<String, u64>>,
    next_connection: AtomicU64,
    brain: Mutex<(u64, String)>,
    owner_brains: Mutex<HashMap<String, (u64, String)>>,
    active_streams: Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Bytes>>>,
}

impl Default for PresenceState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            owners: Mutex::new(HashMap::new()),
            connection_order: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
            brain: Mutex::new((0, String::new())),
            owner_brains: Mutex::new(HashMap::new()),
            active_streams: Mutex::new(HashMap::new()),
        }
    }
}

impl PresenceState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remember_client(&self, input: &RememberClientInput<'_>) -> Result<(), &'static str> {
        if input.handler {
            return Ok(());
        }
        let token = input.token.trim();
        if input.session_id.is_empty() || token.is_empty() || token.len() > 8192 {
            return Err("AIChat login required");
        }
        let sanitized_url = sanitize_client_url(input.url)?;
        let sanitized_base = sanitize_base_url(input.base_url)?;
        let sanitized_executor = sanitize_default_executor(input.default_executor);
        let now = chrono::Utc::now().timestamp_millis();
        let stored = StoredClient {
            session_id: input.session_id.to_string(),
            client: AichatClient {
                url: sanitized_url,
                token: token.to_string(),
                base_url: sanitized_base,
                seen_at: now,
                default_executor: sanitized_executor,
            },
        };

        let order = {
            let mut conn_map = self.connection_order.lock().unwrap();
            *conn_map
                .entry(input.session_id.to_string())
                .or_insert_with(|| self.next_connection.fetch_add(1, Ordering::SeqCst) + 1)
        };

        if let Some(root) = valid_brain_path(input.brain_root) {
            let mut b = self.brain.lock().unwrap();
            if order >= b.0 {
                *b = (order, root);
            }
        }

        let owner_regex = regex::Regex::new(r"^[a-zA-Z0-9-]{32,128}$").unwrap();
        if let Some(o) = input.owner.filter(|o| owner_regex.is_match(o)) {
            if !input.origin.is_empty() {
                let mut hasher = Sha256::new();
                hasher.update(input.origin.as_bytes());
                hasher.update(b"\0");
                hasher.update(o.as_bytes());
                let owner_hash = format!("{:x}", hasher.finalize());

                let mut owners = self.owners.lock().unwrap();
                owners.insert(owner_hash.clone(), stored.clone());

                let root = valid_brain_path(input.brain_root).unwrap_or_default();
                if !root.is_empty() || input.brain_root == Some("") {
                    let mut ob = self.owner_brains.lock().unwrap();
                    let current_order = ob.get(&owner_hash).map(|t| t.0).unwrap_or(0);
                    if order >= current_order {
                        ob.insert(owner_hash, (order, root));
                    }
                }
            }
        }

        let mut curr = self.current.lock().unwrap();
        *curr = Some(stored);
        Ok(())
    }

    pub fn touch(&self, session_id: &str) {
        let now = chrono::Utc::now().timestamp_millis();
        let mut curr = self.current.lock().unwrap();
        if let Some(c) = curr.as_mut() {
            if c.session_id == session_id {
                c.client.seen_at = now;
            }
        }
        let mut owners = self.owners.lock().unwrap();
        for c in owners.values_mut() {
            if c.session_id == session_id {
                c.client.seen_at = now;
            }
        }
    }

    pub fn note_session_closed(&self, session_id: &str) {
        let mut conn_map = self.connection_order.lock().unwrap();
        conn_map.remove(session_id);
        let mut streams = self.active_streams.lock().unwrap();
        streams.remove(session_id);
    }

    pub fn has_remembered(&self) -> bool {
        let curr = self.current.lock().unwrap();
        curr.as_ref()
            .map(|c| !c.client.token.is_empty())
            .unwrap_or(false)
    }

    pub fn latest_client(&self, owner: Option<&str>) -> Option<AichatClient> {
        if let Some(o) = owner {
            let owners = self.owners.lock().unwrap();
            if let Some(stored) = owners.get(o) {
                return Some(stored.client.clone());
            }
        }
        let curr = self.current.lock().unwrap();
        curr.as_ref().map(|c| c.client.clone())
    }

    /// Owner-scoped AIChat login. Persona runs must not fall back to another account.
    pub fn owner_client(&self, owner_hash: &str) -> Option<AichatClient> {
        self.owners
            .lock()
            .ok()
            .and_then(|owners| owners.get(owner_hash).map(|stored| stored.client.clone()))
    }

    /// Second-brain path last reported by this owner. Empty when none was sent.
    pub fn brain_root(&self, owner_hash: &str) -> String {
        self.owner_brains
            .lock()
            .ok()
            .and_then(|brains| brains.get(owner_hash).map(|(_, root)| root.clone()))
            .unwrap_or_default()
    }

    pub fn handle_mcp_params(
        &self,
        session_id: &str,
        origin: &str,
        params: Option<&Value>,
    ) -> Result<(), &'static str> {
        let params = params.ok_or("AIChat presence rejected")?;
        let raw = serde_json::to_string(params).map_err(|_| "AIChat presence rejected")?;
        if raw.len() > 16_384 {
            return Err("Request too large");
        }
        let url = params.get("url").and_then(Value::as_str).unwrap_or("");
        let token = params.get("token").and_then(Value::as_str).unwrap_or("");
        let base_url = params.get("baseURL").and_then(Value::as_str);
        let owner = params.get("owner").and_then(Value::as_str);
        let handler = params
            .get("handler")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let brain_root = params.get("brainRoot").and_then(Value::as_str);
        let default_executor = params.get("defaultExecutor");

        self.remember_client(&RememberClientInput {
            session_id,
            url,
            token,
            base_url,
            owner,
            origin,
            handler,
            brain_root,
            default_executor,
        })
    }
}

pub async fn handle_presence_http(
    state: &Arc<AppState>,
    req: Request,
    query: &std::collections::BTreeMap<String, String>,
    headers: &HeaderMap,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if !presence_origin_allowed(origin) {
        let mut resp = json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "Explicit allowed Origin required" }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    let session_id = headers
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();

    let session_live = if !session_id.is_empty() {
        state
            .sessions
            .lock()
            .map(|s| s.sessions.contains_key(session_id))
            .unwrap_or(false)
    } else {
        false
    };

    if !session_live {
        let mut resp = json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "Live AIChat session required" }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    if req.method() != Method::POST {
        let mut resp = json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            &json!({ "error": "Method not allowed" }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if !content_type
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        let mut resp = json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "AIChat presence rejected" }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    let body_bytes =
        match axum::body::to_bytes(req.into_body(), MAX_PRESENCE_BODY_BYTES as usize).await {
            Ok(bytes) => bytes,
            Err(_) => {
                let mut resp = json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "AIChat presence rejected" }),
                );
                resp.headers_mut().insert(
                    header::CACHE_CONTROL,
                    "no-store".parse().expect("static header"),
                );
                return resp;
            }
        };

    let parsed: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(_) => {
            let mut resp = json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "AIChat presence rejected" }),
            );
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                "no-store".parse().expect("static header"),
            );
            return resp;
        }
    };

    let url = parsed.get("url").and_then(Value::as_str).unwrap_or("");
    let token = parsed.get("token").and_then(Value::as_str).unwrap_or("");
    let base_url = parsed.get("baseURL").and_then(Value::as_str);
    let owner = parsed.get("owner").and_then(Value::as_str);
    let handler = parsed
        .get("handler")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let brain_root = parsed.get("brainRoot").and_then(Value::as_str);
    let default_executor = parsed.get("defaultExecutor");

    if state
        .presence
        .remember_client(&RememberClientInput {
            session_id,
            url,
            token,
            base_url,
            owner,
            origin,
            handler,
            brain_root,
            default_executor,
        })
        .is_err()
    {
        let mut resp = json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "AIChat presence rejected" }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    let wants_stream = query.get("stream").map(String::as_str) == Some("1");
    if !wants_stream {
        let mut resp = json_response(
            StatusCode::OK,
            &json!({ "remembered": state.presence.has_remembered() }),
        );
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return resp;
    }

    let (sender, receiver) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    {
        let mut streams = state.presence.active_streams.lock().unwrap();
        // Disconnect previous stream for this session
        streams.remove(session_id);
        let byte_sender = {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
            let sender_clone = sender.clone();
            tokio::spawn(async move {
                while let Some(bytes) = rx.recv().await {
                    if sender_clone.send(Ok(bytes)).is_err() {
                        break;
                    }
                }
            });
            tx
        };
        streams.insert(session_id.to_string(), byte_sender);
    }

    let _ = sender.send(Ok(Bytes::from("event: ready\ndata: {}\n\n")));

    let state_clone = Arc::clone(state);
    let session_for_task = session_id.to_string();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(25_000));
        interval.tick().await; // first immediate tick
        loop {
            interval.tick().await;
            let is_live = state_clone
                .sessions
                .lock()
                .map(|s| s.sessions.contains_key(&session_for_task))
                .unwrap_or(false);
            if !is_live {
                break;
            }
            if !handler {
                state_clone.presence.touch(&session_for_task);
            }
            if sender.send(Ok(Bytes::from(": presence\n\n"))).is_err() {
                break;
            }
        }
        let mut streams = state_clone.presence.active_streams.lock().unwrap();
        streams.remove(&session_for_task);
    });

    let mut resp = sse_response(
        Body::from_stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
            receiver,
        )),
        session_id,
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_validation_rules() {
        assert!(presence_origin_allowed("https://keepwork.com"));
        assert!(presence_origin_allowed("https://cdn.keepwork.com"));
        assert!(presence_origin_allowed("http://localhost:3000"));
        assert!(presence_origin_allowed("http://127.0.0.1:8089"));
        assert!(!presence_origin_allowed("https://evil.example"));
        assert!(!presence_origin_allowed("http://keepwork.com"));
        assert!(!presence_origin_allowed("https://keepwork.com/sub"));
    }

    #[test]
    fn sanitize_url_strips_secrets() {
        let raw = "https://keepwork.com/chat?token=secret123&layout=thin&PASSWORD=xyz";
        let cleaned = sanitize_client_url(raw).unwrap();
        assert_eq!(cleaned, "https://keepwork.com/chat?layout=thin");

        assert!(sanitize_client_url("ftp://example.com").is_err());
    }

    #[test]
    fn sanitize_base_url_rules() {
        assert_eq!(
            sanitize_base_url(Some("https://keepwork.com/api//")).unwrap(),
            "https://keepwork.com/api"
        );
        assert!(sanitize_base_url(Some("https://user:pass@keepwork.com")).is_err());
    }
}
