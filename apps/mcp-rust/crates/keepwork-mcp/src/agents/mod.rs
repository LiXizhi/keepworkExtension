//! Native CLI sessions. The browser receives normalized snapshots, never a raw
//! RPC tunnel or a choice of executable. Credentials and tool grants stay in RAM.
mod antigravity;
mod claude;
pub mod context;
pub mod discovery;
mod events;
pub mod harness;
mod history;
mod images;
mod item_stream;
mod native;
mod sessions;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use discovery::{definition, discover, Protocol, BACKENDS};
use harness::{Harness, HarnessEvent};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{watch, Mutex as AsyncMutex};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 1000;
const ACTIVE: &[&str] = &["starting", "running", "waiting", "uncertain"];

struct Session {
    data: Value,
    harness: Option<Arc<Harness>>,
    native: Value,
    pending: HashMap<String, (Value, Value)>,
    events: watch::Sender<Value>,
    viewers: Arc<AtomicUsize>,
    configuration: Arc<AsyncMutex<()>>,
    context_marker: Option<String>,
    restoring: bool,
    needs_native_history: bool,
}

pub struct AgentManager {
    file: PathBuf,
    port: u16,
    sessions: Mutex<HashMap<String, Session>>,
    harnesses: AsyncMutex<HashMap<String, Arc<Harness>>>,
    catalogs: AsyncMutex<HashMap<String, Value>>,
    creation: AsyncMutex<()>,
    load_error: Option<String>,
    closing: AtomicBool,
    #[cfg(test)]
    persist_calls: AtomicUsize,
    pub context: Arc<context::ContextManager>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn optional_text(input: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.contains('\0') && text.len() <= max => {
            Ok(if text.is_empty() {
                None
            } else {
                Some(text.clone())
            })
        }
        _ => Err(format!("Invalid {key}")),
    }
}
fn valid_record(data: &Value) -> bool {
    data.is_object()
        && data["id"].as_str().is_some_and(valid_id)
        && data["owner"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        && data["threadId"].as_str().is_some_and(valid_id)
        && data["conversationId"].as_str().is_some_and(valid_id)
        && data["roots"].as_array().is_some_and(|r| {
            !r.is_empty()
                && r.len() <= 16
                && r.iter()
                    .all(|v| v.as_str().is_some_and(|s| Path::new(s).is_absolute()))
        })
        && data
            .get("backend")
            .is_none_or(|v| v.as_str().is_some_and(valid_id))
        && data.get("items").is_none_or(Value::is_array)
        && data.get("submissions").is_none_or(|v| {
            v.as_object().is_some_and(|m| {
                m.iter()
                    .all(|(id, r)| valid_id(id) && r.is_object() && r["state"].is_string())
            })
        })
}
fn mode(input: Option<&Value>, fallback: &str) -> Result<String, String> {
    let selected = input.map(|v| v.as_str().unwrap_or("")).unwrap_or(fallback);
    if !["craft", "ask", "plan"].contains(&selected) {
        return Err("Unsupported agent mode".into());
    }
    Ok(selected.to_string())
}
fn canonical_root(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Existing absolute local folder required".into());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "Existing absolute local folder required")?;
    #[cfg(windows)]
    {
        let raw = canonical.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(canonical)
}
fn checked_roots(data: &Value) -> Result<Vec<String>, String> {
    let roots = data["roots"]
        .as_array()
        .ok_or("Select 1–16 local workspace folders")?;
    if roots.is_empty() || roots.len() > 16 {
        return Err("Select 1–16 local workspace folders".into());
    }
    let mut result = vec![];
    for value in roots {
        let root = canonical_root(
            value
                .as_str()
                .ok_or("Existing absolute local folder required")?,
        )?
        .to_string_lossy()
        .into_owned();
        if !result.contains(&root) {
            result.push(root);
        }
    }
    Ok(result)
}
fn owner(headers: &HeaderMap) -> Result<String, String> {
    let raw = headers
        .get("x-agent-owner")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(32..=128).contains(&raw.len())
        || !raw.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Agent owner key required".into());
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    Ok(format!(
        "{:x}",
        Sha256::digest([origin.as_bytes(), b"\0", raw.as_bytes()].concat())
    ))
}
fn snapshot(data: &Value) -> Value {
    let mut out = data.clone();
    let obj = out.as_object_mut().expect("session object");
    for key in [
        "owner",
        "submissions",
        "worktrees",
        "sandboxPolicy",
        "nativeMetadata",
        "lastRequestId",
    ] {
        obj.remove(key);
    }
    let last = data["lastRequestId"]
        .as_str()
        .and_then(|id| data["submissions"].get(id).map(|v| (id, v)))
        .or_else(|| {
            data["submissions"]
                .as_object()
                .and_then(|m| m.iter().next_back())
                .map(|(k, v)| (k.as_str(), v))
        });
    obj.insert(
        "lastSubmission".into(),
        last.filter(|(_, value)| value.is_object())
            .map(|(key, value)| {
                let mut value = value.clone();
                value["requestId"] = json!(key);
                value
            })
            .unwrap_or(Value::Null),
    );
    scrub(&out, 0, &mut 2_500_000)
}
fn scrub(value: &Value, depth: usize, budget: &mut usize) -> Value {
    if images::is_inline(value) {
        return json!({"type":"image"});
    }
    if depth > 24 || *budget < 16 {
        return Value::Null;
    }
    *budget -= 16;
    match value {
        Value::String(text) => {
            let limit = (*budget).min(131_072);
            let bounded = text.chars().take(limit).collect::<String>();
            *budget = budget.saturating_sub(bounded.len());
            json!(bounded)
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(2000)
                .map(|v| scrub(v, depth + 1, budget))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .filter(|(key, _)| {
                    let k = key.to_ascii_lowercase();
                    !["token", "password", "secret", "authorization", "cookie"]
                        .iter()
                        .any(|s| k.contains(s))
                })
                .take(2000)
                .map(|(key, v)| (key.clone(), scrub(v, depth + 1, budget)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

impl AgentManager {
    pub fn open(file: PathBuf, port: u16) -> Arc<Self> {
        let mut load_error = None;
        let rows = match std::fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<Vec<Value>>(&bytes) {
                Ok(rows) => rows,
                Err(_) => {
                    load_error = Some("Agent registry is unreadable; preserve it and repair it before creating sessions".into());
                    vec![]
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(_) => {
                load_error = Some("Agent registry could not be read".into());
                vec![]
            }
        };
        let mut sessions = HashMap::new();
        let mut ids = std::collections::HashSet::new();
        if rows.len() > 10_000
            || rows.iter().any(|row| {
                !valid_record(row) || !ids.insert(row["id"].as_str().unwrap_or("").to_string())
            })
        {
            load_error=Some("Agent registry contains incompatible or duplicate records; original data was preserved and the registry is read-only".into());
        }
        for mut data in rows {
            if !valid_record(&data) || sessions.contains_key(data["id"].as_str().unwrap_or("")) {
                continue;
            }
            if data["backend"].is_null() {
                data["backend"] = json!("codex");
            }
            if !data["worktrees"].is_array() {
                data["worktrees"] = data["roots"].clone();
            }
            if ACTIVE.contains(&data["status"].as_str().unwrap_or("")) {
                data["status"] = json!("interrupted");
            }
            data["pending"] = json!([]);
            let needs_native_history = data["backend"] == "codex" && !data["items"].is_array();
            if !data["items"].is_array()
                || (data["backend"] == "gemini" && !data["nativeMetadata"]["nativeId"].is_string())
            {
                let loaded = history::load(
                    &file,
                    data["backend"].as_str().unwrap_or("codex"),
                    data["threadId"].as_str().unwrap_or(""),
                );
                match loaded {
                    Ok(Some(mut thread)) => {
                        if !data["items"].is_array() {
                            data["items"] = json!(thread["turns"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .flat_map(|t| t["items"].as_array().into_iter().flatten().cloned())
                                .collect::<Vec<_>>());
                        }
                        thread["sessionId"] = data["threadId"].clone();
                        data["nativeMetadata"] = thread;
                    }
                    Ok(None) => {
                        if !data["items"].is_array() {
                            data["items"] = json!([]);
                        }
                    }
                    Err(error) => {
                        if !data["items"].is_array() {
                            data["items"] = json!([]);
                        }
                        data["error"] = json!(error);
                    }
                }
            }
            if !data["submissions"].is_object() {
                data["submissions"] = json!({});
            }
            for receipt in data["submissions"].as_object_mut().unwrap().values_mut() {
                if receipt["state"] == "starting" {
                    receipt["state"] = json!("unknown");
                }
            }
            let (events, _) =
                watch::channel(json!({"cursor":data["cursor"],"session":snapshot(&data)}));
            let native = data["nativeMetadata"].clone();
            sessions.insert(
                data["id"].as_str().unwrap().to_string(),
                Session {
                    data,
                    harness: None,
                    native,
                    pending: HashMap::new(),
                    events,
                    viewers: Arc::new(AtomicUsize::new(0)),
                    configuration: Arc::new(AsyncMutex::new(())),
                    context_marker: None,
                    restoring: false,
                    needs_native_history,
                },
            );
        }
        Arc::new(Self {
            file,
            port,
            sessions: Mutex::new(sessions),
            harnesses: AsyncMutex::new(HashMap::new()),
            catalogs: AsyncMutex::new(HashMap::new()),
            creation: AsyncMutex::new(()),
            load_error,
            closing: AtomicBool::new(false),
            #[cfg(test)]
            persist_calls: AtomicUsize::new(0),
            context: Arc::new(context::ContextManager::new()),
        })
    }

    fn persist(&self, sessions: &HashMap<String, Session>) -> Result<(), String> {
        #[cfg(test)]
        self.persist_calls.fetch_add(1, Ordering::Relaxed);
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let parent = self.file.parent().ok_or("Invalid agent registry")?;
        std::fs::create_dir_all(parent).map_err(|_| "Could not persist agent registry")?;
        let mut rows = Vec::with_capacity(sessions.len());
        for session in sessions.values() {
            history::save(&self.file, &session.data, &session.native)?;
            let mut data = session.data.clone();
            // Node Codex history lives in the CLI. Preserve its unresolved
            // absence across unrelated registry saves and shutdown.
            if session.needs_native_history {
                data.as_object_mut().unwrap().remove("items");
            }
            let mut metadata = serde_json::Map::new();
            for key in [
                "sessionId",
                "models",
                "modes",
                "configOptions",
                "driver",
                "nativeId",
            ] {
                if let Some(value) = session.native.get(key) {
                    metadata.insert(key.into(), value.clone());
                }
            }
            data["nativeMetadata"] = Value::Object(metadata);
            rows.push(data);
        }
        let temporary = self.file.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not persist agent registry")?;
        file.write_all(&serde_json::to_vec(&rows).map_err(|_| "Could not persist agent registry")?)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not persist agent registry")?;
        std::fs::rename(temporary, &self.file)
            .map_err(|_| "Could not persist agent registry".into())
    }

    fn view(&self, session_id: &str, owner: &str) -> Result<Value, String> {
        let sessions = self.sessions.lock().expect("agent sessions");
        let s = sessions
            .get(session_id)
            .filter(|s| s.data["owner"] == owner && s.data["removed"] != true)
            .ok_or("Agent session not found")?;
        Ok(self.render(&s.data))
    }
    fn render(&self, data: &Value) -> Value {
        let mut view = snapshot(data);
        if data["aichatContext"] == true {
            view["context"] = self.context.snapshot(
                data["owner"].as_str().unwrap_or(""),
                data["conversationId"].as_str().unwrap_or(""),
            );
        }
        view
    }
    fn edit<F>(&self, session_id: &str, edit: F) -> Result<Value, String>
    where
        F: FnOnce(&mut Session) -> Result<(), String>,
    {
        let mut sessions = self.sessions.lock().expect("agent sessions");
        let session = sessions
            .get_mut(session_id)
            .ok_or("Agent session not found")?;
        let original = session.data.clone();
        if let Err(error) = edit(session) {
            session.data = original;
            return Err(error);
        }
        session.data["updatedAt"] = json!(now());
        session.data["cursor"] = json!(session.data["cursor"].as_u64().unwrap_or(0) + 1);
        if let Some(items) = session.data["items"].as_array_mut() {
            while items.len() > 2000
                || (items.len() > 1
                    && serde_json::to_vec(items).map(|b| b.len()).unwrap_or(0) > 2_000_000)
            {
                items.remove(0);
            }
        }
        if let Err(error) = self.persist(&sessions) {
            sessions.get_mut(session_id).unwrap().data = original;
            return Err(error);
        }
        let session = &sessions[session_id];
        let result = self.render(&session.data);
        session
            .events
            .send_replace(json!({"cursor":result["cursor"],"session":result}));
        Ok(result)
    }

    async fn harness(self: &Arc<Self>, backend: &str, cwd: &Path) -> Result<Arc<Harness>, String> {
        self.harness_for(backend, cwd, false).await
    }

    async fn harness_for(
        self: &Arc<Self>,
        backend: &str,
        cwd: &Path,
        metadata_only: bool,
    ) -> Result<Arc<Harness>, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Agent service is stopping".into());
        }
        let key = if metadata_only {
            format!("metadata\0{backend}\0{}", cwd.display())
        } else {
            format!("{backend}\0{}", cwd.display())
        };
        let mut harnesses = self.harnesses.lock().await;
        if let Some(harness) = harnesses.get(&key).filter(|h| h.alive()) {
            return Ok(Arc::clone(harness));
        }
        if harnesses.len() >= 32 {
            harnesses.retain(|_, h| h.alive());
            if harnesses.len() >= 32 {
                return Err("Native CLI process limit reached".into());
            }
        }
        let harness = Harness::start(backend, cwd).await?;
        let mut events = harness.subscribe();
        let weak = Arc::downgrade(self);
        let child = Arc::clone(&harness);
        tokio::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        child.close();
                        HarnessEvent::Exit {
                            message:
                                "Native CLI event limit exceeded; inspect state before retrying"
                                    .into(),
                        }
                    }
                    Err(_) => break,
                };
                let done = matches!(event, HarnessEvent::Exit { .. });
                if let Some(manager) = weak.upgrade() {
                    manager.on_event(&child, event).await;
                } else {
                    child.close();
                    break;
                }
                if done {
                    break;
                }
            }
        });
        harnesses.insert(key, harness.clone());
        Ok(harness)
    }

    pub async fn close(&self) {
        self.closing.store(true, Ordering::Release);
        self.context.close();
        for child in self.harnesses.lock().await.values() {
            child.shutdown().await;
        }
        let mut sessions = self.sessions.lock().expect("agent sessions");
        for s in sessions.values_mut() {
            if ACTIVE.contains(&s.data["status"].as_str().unwrap_or("")) {
                s.data["status"] = json!("interrupted");
            }
            s.data["pending"] = json!([]);
            s.pending.clear();
            s.events.send_replace(json!({"closed":true}));
        }
        let _ = self.persist(&sessions);
    }

    fn stream(&self, session_id: &str, owner: &str) -> Result<Response, String> {
        self.view(session_id, owner)?;
        let sessions = self.sessions.lock().expect("agent sessions");
        let s = &sessions[session_id];
        if s.viewers.fetch_add(1, Ordering::AcqRel) >= 8 {
            s.viewers.fetch_sub(1, Ordering::AcqRel);
            return Err("Too many session viewers".into());
        }
        struct Viewer(Arc<AtomicUsize>);
        impl Drop for Viewer {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let state = (s.events.subscribe(), true, Viewer(s.viewers.clone()));
        let stream = futures_util::stream::unfold(state, |(mut rx, first, viewer)| async move {
            let value = if first {
                rx.borrow_and_update().clone()
            } else {
                match tokio::time::timeout(Duration::from_secs(20), rx.changed()).await {
                    Ok(Ok(())) => rx.borrow_and_update().clone(),
                    Ok(Err(_)) => return None,
                    Err(_) => {
                        return Some((
                            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"\n")),
                            (rx, false, viewer),
                        ))
                    }
                }
            };
            if value["closed"] == true {
                return None;
            }
            Some((Ok(Bytes::from(format!("{value}\n"))), (rx, false, viewer)))
        });
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/x-ndjson")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from_stream(stream))
            .unwrap())
    }
}

pub fn handle<'a>(
    manager: Arc<AgentManager>,
    method: &'a str,
    path: &'a str,
    query: &'a BTreeMap<String, String>,
    headers: &'a HeaderMap,
    req: Request,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send + 'a>> {
    Box::pin(handle_request(manager, method, path, query, headers, req))
}

async fn handle_request(
    manager: Arc<AgentManager>,
    method: &str,
    path: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
    req: Request,
) -> Response {
    let owner = match owner(headers) {
        Ok(owner) => owner,
        Err(error) => return error_response(&error),
    };
    if path.starts_with("/agents/contexts/") {
        return manager
            .context
            .clone()
            .handle(&owner, method, path, query, req)
            .await;
    }
    let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
    let image_turn = matches!(parts.as_slice(), ["agents", "sessions", _, "image-turns"]);
    let input = if ["POST", "PATCH"].contains(&method) {
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("application/json")
        {
            return error_response("JSON required");
        }
        let limit = if image_turn { 7_000_000 } else { 2_000_000 };
        match axum::body::to_bytes(req.into_body(), limit).await {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) if value.is_object() => value,
                _ => return error_response("JSON object required"),
            },
            Err(_) => return error_response("Request too large"),
        }
    } else {
        json!({})
    };
    let result: Result<Value, String> = match (method, parts.as_slice()) {
        ("GET", ["agents", "backends"]) => manager.backends(&owner, query).await,
        ("GET", ["agents", "accounts"]) => Ok(manager.accounts()),
        ("POST", ["agents", "login"]) => manager.login(&input).await,
        ("GET", ["agents", "native-codex"]) => manager.native_catalog(&owner, "codex", query).await,
        ("GET", ["agents", "native-codex", thread_id]) => {
            manager.native_session(&owner, "codex", thread_id).await
        }
        ("GET", ["agents", "native-sessions", backend]) => {
            manager.native_catalog(&owner, backend, query).await
        }
        ("GET", ["agents", "native-sessions", backend, thread_id]) => {
            manager.native_session(&owner, backend, thread_id).await
        }
        ("GET", ["agents", "sessions"]) => manager.list(&owner, query),
        ("POST", ["agents", "sessions"]) => manager.create(&owner, &input).await,
        ("GET", ["agents", "sessions", session_id]) => manager.read_owned(session_id, &owner).await,
        ("PATCH", ["agents", "sessions", session_id]) => manager.update(session_id, &owner, &input),
        ("POST", ["agents", "sessions", session_id, "turns"]) => {
            manager.turn(session_id, &owner, &input).await
        }
        ("POST", ["agents", "sessions", session_id, "image-turns"]) => {
            if !input["images"].is_array() {
                Err("Missing images".into())
            } else {
                manager.turn(session_id, &owner, &input).await
            }
        }
        ("POST", ["agents", "sessions", session_id, "interrupt"]) => {
            manager.interrupt(session_id, &owner).await
        }
        ("POST", ["agents", "sessions", session_id, "respond"]) => {
            manager.respond(session_id, &owner, &input).await
        }
        ("GET", ["agents", "sessions", session_id, "events"]) => {
            return match manager.stream(session_id, &owner) {
                Ok(response) => response,
                Err(error) => error_response(&error),
            }
        }
        _ => Err(
            "UNSUPPORTED_FEATURE: This native CLI operation is not available in Rust MCP".into(),
        ),
    };
    match result {
        Ok(value) => crate::http::json_response(StatusCode::OK, &value),
        Err(error) => error_response(&error),
    }
}

fn error_response(error: &str) -> Response {
    let unsupported = error.contains("UNSUPPORTED_FEATURE") || error.contains("not yet available");
    let unknown = error.starts_with("SUBMISSION_UNKNOWN:");
    let message = error.strip_prefix("SUBMISSION_UNKNOWN:").unwrap_or(error);
    let mut body = json!({"error":message,"acceptanceUnknown":unknown});
    if unsupported {
        body["code"] = json!("UNSUPPORTED_FEATURE");
    }
    crate::http::json_response(
        if unsupported {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::BAD_REQUEST
        },
        &body,
    )
}
