//! Loopback HTTP surface. Routing order, CORS headers and auth boundaries copy
//! `src/mcp/http.ts` so the browser client cannot tell the engines apart.

use axum::body::Body;
use axum::extract::Request;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::identity::Identity;
use crate::mcp::{self, SessionStore};
use crate::paths;
use crate::shell::ShellRunner;
use crate::terminal::TerminalManager;
use crate::{ENGINE, RUNTIME_PRODUCT, SERVER_NAME, SERVER_VERSION};

pub struct AppState {
    pub port: u16,
    pub root: PathBuf,
    pub require_auth: bool,
    pub token: String,
    pub started_at: String,
    pub identity: Identity,
    pub sessions: Mutex<SessionStore>,
    pub terminals: TerminalManager,
    pub shell: ShellRunner,
    pub presence: Arc<crate::presence::PresenceState>,
}

impl AppState {
    pub fn new(
        port: u16,
        root: PathBuf,
        require_auth: bool,
        token: String,
        identity: Identity,
    ) -> Self {
        Self {
            port,
            root,
            require_auth,
            token,
            started_at: now_iso(),
            identity,
            sessions: Mutex::new(SessionStore::default()),
            terminals: TerminalManager::default(),
            shell: ShellRunner::default(),
            presence: Arc::new(crate::presence::PresenceState::new()),
        }
    }

    pub fn health_capabilities(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut caps = serde_json::Map::new();
        caps.insert("requireAuth".into(), serde_json::json!(self.require_auth));
        caps.insert(
            "workspaceRoot".into(),
            serde_json::json!(self.root.to_string_lossy()),
        );
        caps.insert("fsApi".into(), serde_json::json!(crate::fs::FS_API));
        caps.insert(
            "folderBrowserApi".into(),
            serde_json::json!(crate::folders::FOLDER_BROWSER_API),
        );
        caps.insert(
            "terminalApi".into(),
            serde_json::json!(crate::terminal::TERMINAL_API),
        );
        caps.insert("aichatPresenceApi".into(), serde_json::json!("post-sse-v1"));
        // Only surfaces this build actually serves. Unimplemented routes stay
        // unadvertised so AIChat degrades instead of calling a 404.
        caps
    }

    pub fn client_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|store| store.sessions.len())
            .unwrap_or(0)
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn query_params(raw: Option<&str>) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for pair in raw.unwrap_or("").split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.entry(percent_decode(key))
            .or_insert_with(|| percent_decode(value));
    }
    map
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
                out.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

pub fn origin_allowed(origin: &str) -> bool {
    if origin.is_empty() {
        return true;
    }
    let Ok(parsed) = url_parts(origin) else {
        return false;
    };
    let host = parsed.host.as_str();
    host == "keepwork.com"
        || host.ends_with(".keepwork.com")
        || matches!(host, "cdn.keepwork.com" | "localhost" | "127.0.0.1")
}

struct UrlParts {
    host: String,
}

fn url_parts(raw: &str) -> Result<UrlParts, ()> {
    let rest = raw.split_once("://").ok_or(())?.1;
    let authority = rest.split('/').next().ok_or(())?;
    let host_port = authority.rsplit('@').next().ok_or(())?;
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next().ok_or(())?.to_string()
    } else {
        host_port.split(':').next().ok_or(())?.to_string()
    };
    if host.is_empty() {
        return Err(());
    }
    Ok(UrlParts {
        host: host.to_ascii_lowercase(),
    })
}

pub async fn cors_layer(req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let private_network = req
        .headers()
        .get("access-control-request-private-network")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let mut response = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    apply_cors(&mut response, &origin, private_network);
    response
}

fn apply_cors(response: &mut Response, origin: &str, private_network: bool) {
    let headers = response.headers_mut();
    if !origin.is_empty() && origin_allowed(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.parse().unwrap());
        headers.insert(header::VARY, "Origin".parse().unwrap());
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            "true".parse().unwrap(),
        );
    } else if origin.is_empty() {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, PATCH, PUT, DELETE, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Agent-Owner, X-DashScope-Api-Key"
            .parse()
            .unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        "Mcp-Session-Id, MCP-Protocol-Version, Retry-After"
            .parse()
            .unwrap(),
    );
    if private_network {
        headers.insert(
            "Access-Control-Allow-Private-Network",
            "true".parse().unwrap(),
        );
    }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn extract_token(headers: &HeaderMap, query: &BTreeMap<String, String>) -> String {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(rest) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
        {
            return rest.trim().to_string();
        }
    }
    query
        .get("token")
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
) -> Option<Response> {
    if !state.require_auth {
        return None;
    }
    if extract_token(headers, query) == state.token {
        return None;
    }
    Some(json_response(
        StatusCode::UNAUTHORIZED,
        &serde_json::json!({
            "error": "unauthorized",
            "hint": "Pass Authorization: Bearer <token> from ~/.keepwork-mcp/token",
        }),
    ))
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

pub fn json_response(status: StatusCode, body: &serde_json::Value) -> Response {
    let text = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(text))
        .expect("valid JSON response")
}

pub fn mcp_json_response(
    status: StatusCode,
    body: &serde_json::Value,
    session_id: Option<&str>,
) -> Response {
    let text = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(session) = session_id {
        builder = builder.header("mcp-session-id", session);
    }
    builder.body(Body::from(text)).expect("valid MCP response")
}

pub fn empty_response(status: StatusCode, session_id: Option<&str>) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(session) = session_id {
        builder = builder.header("mcp-session-id", session);
    }
    builder.body(Body::empty()).expect("valid empty response")
}

pub fn sse_response(body: Body, session_id: &str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header("x-accel-buffering", "no")
        .header("mcp-session-id", session_id)
        .body(body)
        .expect("valid SSE response")
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn dispatch(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = normalize_path(req.uri().path());
    let query = query_params(req.uri().query());
    let headers = req.headers().clone();

    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => health(&state),
        ("GET", "/exists") => exists(&query),
        ("GET", "/fs/locations") | ("GET", "/fs/browse") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !origin_allowed(origin) {
                return json_response(
                    StatusCode::FORBIDDEN,
                    &serde_json::json!({ "error": "origin not allowed" }),
                );
            }
            if let Some(denied) = authorize(&state, &headers, &query) {
                return denied;
            }
            let body = if path == "/fs/locations" {
                Ok(crate::folders::folder_locations())
            } else {
                crate::folders::browse_folders(
                    query.get("path").map(String::as_str).unwrap_or(""),
                    query
                        .get("hidden")
                        .map(|value| value == "1")
                        .unwrap_or(false),
                    query.get("filter").map(String::as_str).unwrap_or(""),
                    query
                        .get("offset")
                        .and_then(|value| value.parse::<f64>().ok()),
                    query
                        .get("limit")
                        .and_then(|value| value.parse::<f64>().ok()),
                )
            };
            let mut response = match body {
                Ok(value) => {
                    let mut map = serde_json::Map::new();
                    map.insert("ok".into(), serde_json::json!(true));
                    if let serde_json::Value::Object(fields) = value {
                        map.extend(fields);
                    }
                    json_response(StatusCode::OK, &serde_json::Value::Object(map))
                }
                Err(message) => json_response(
                    StatusCode::BAD_REQUEST,
                    &serde_json::json!({ "ok": false, "error": message }),
                ),
            };
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                "no-store".parse().expect("static header"),
            );
            response
        }
        (_, path) if path.starts_with("/fs") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !origin_allowed(origin) {
                return json_response(
                    StatusCode::FORBIDDEN,
                    &serde_json::json!({ "error": "origin not allowed" }),
                );
            }
            if let Some(denied) = authorize(&state, &headers, &query) {
                return denied;
            }
            crate::fs::route(req, path, &query, &headers)
                .await
                .unwrap_or_else(|| {
                    json_response(
                        StatusCode::NOT_FOUND,
                        &serde_json::json!({ "error": "not found" }),
                    )
                })
        }
        (_, path) if path.starts_with("/terminal/") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !origin_allowed(origin) {
                return json_response(
                    StatusCode::FORBIDDEN,
                    &serde_json::json!({ "ok": false, "error": "origin not allowed" }),
                );
            }
            if let Some(denied) = authorize(&state, &headers, &query) {
                return denied;
            }
            match crate::terminal::route(&state.terminals, &state.root, req, path, &query, &headers)
                .await
            {
                Some(response) => response,
                None => json_response(
                    StatusCode::NOT_FOUND,
                    &serde_json::json!({ "error": "not found" }),
                ),
            }
        }
        ("GET", "/admin/status") => match authorize(&state, req.headers(), &query) {
            Some(denied) => denied,
            None => admin_status(&state),
        },
        ("POST", "/admin/stop") => match authorize(&state, req.headers(), &query) {
            Some(denied) => denied,
            None => {
                state.terminals.close_all();
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    std::process::exit(0);
                });
                json_response(
                    StatusCode::OK,
                    &serde_json::json!({ "ok": true, "stopping": true }),
                )
            }
        },
        (_, "/aichat/presence") => {
            crate::presence::handle_presence_http(&state, req, &query, &headers).await
        }
        (_, "/mcp") => mcp_dispatch(state, req).await,
        _ => json_response(
            StatusCode::NOT_FOUND,
            &serde_json::json!({ "error": "not found" }),
        ),
    }
}

fn health(state: &AppState) -> Response {
    let mut body = serde_json::Map::new();
    body.insert("ok".into(), serde_json::json!(true));
    body.insert("name".into(), serde_json::json!(SERVER_NAME));
    body.insert("version".into(), serde_json::json!(SERVER_VERSION));
    for (key, value) in state.identity.fields() {
        body.insert(key, value);
    }
    body.insert("port".into(), serde_json::json!(state.port));
    body.insert("pid".into(), serde_json::json!(std::process::id()));
    body.insert("clients".into(), serde_json::json!(state.client_count()));
    body.insert("paracraftClients".into(), serde_json::json!(0));
    if let Some(dc) = crate::identity::read_desktop_client() {
        body.insert("desktopClient".into(), dc);
    }
    for (key, value) in state.health_capabilities() {
        body.insert(key, value);
    }
    body.insert("runtimeEngine".into(), serde_json::json!(ENGINE));
    body.insert("runtimeProduct".into(), serde_json::json!(RUNTIME_PRODUCT));
    json_response(StatusCode::OK, &serde_json::Value::Object(body))
}

fn exists(query: &BTreeMap<String, String>) -> Response {
    let raw = query.get("path").map(|value| value.trim()).unwrap_or("");
    if raw.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            &serde_json::json!({ "ok": false, "error": "path is required" }),
        );
    }
    let info = paths::inspect_disk_path(raw);
    json_response(
        StatusCode::OK,
        &serde_json::json!({
            "ok": true,
            "exists": info.exists,
            "isDirectory": info.is_directory,
            "resolved": info.resolved,
        }),
    )
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn admin_status(state: &AppState) -> Response {
    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    let exec_path = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let uptime_ms = chrono::DateTime::parse_from_rfc3339(&state.started_at)
        .map(|started| {
            chrono::Utc::now()
                .signed_duration_since(started)
                .num_milliseconds()
                .max(0)
        })
        .unwrap_or(0);
    let clients: Vec<serde_json::Value> = state
        .sessions
        .lock()
        .map(|store| {
            store
                .sessions
                .values()
                .map(|session| session.to_json())
                .collect()
        })
        .unwrap_or_default();

    let mut body = serde_json::Map::new();
    body.insert("ok".into(), serde_json::json!(true));
    body.insert("name".into(), serde_json::json!(SERVER_NAME));
    body.insert("version".into(), serde_json::json!(SERVER_VERSION));
    for (key, value) in state.identity.fields() {
        body.insert(key, value);
    }
    body.insert("platform".into(), serde_json::json!(node_platform()));
    body.insert("hostname".into(), serde_json::json!(hostname));
    body.insert("arch".into(), serde_json::json!(node_arch()));
    body.insert("execPath".into(), serde_json::json!(exec_path));
    body.insert("pid".into(), serde_json::json!(std::process::id()));
    body.insert("port".into(), serde_json::json!(state.port));
    body.insert("uptimeMs".into(), serde_json::json!(uptime_ms));
    body.insert("startedAt".into(), serde_json::json!(state.started_at));
    body.insert(
        "workspaceRoot".into(),
        serde_json::json!(state.root.to_string_lossy()),
    );
    body.insert("requireAuth".into(), serde_json::json!(state.require_auth));
    body.insert("clients".into(), serde_json::json!(clients));
    body.insert("runtimeEngine".into(), serde_json::json!(ENGINE));
    body.insert("runtimeProduct".into(), serde_json::json!(RUNTIME_PRODUCT));
    json_response(StatusCode::OK, &serde_json::Value::Object(body))
}

async fn mcp_dispatch(state: Arc<AppState>, req: Request) -> Response {
    let method = req.method().clone();
    let query = query_params(req.uri().query());
    let headers = req.headers().clone();

    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !origin.is_empty() && !origin_allowed(&origin) {
        return json_response(
            StatusCode::FORBIDDEN,
            &serde_json::json!({ "error": "origin not allowed" }),
        );
    }
    if let Some(denied) = authorize(&state, &headers, &query) {
        return denied;
    }

    match method {
        Method::POST => {
            let body = match axum::body::to_bytes(req.into_body(), 16_000_000).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    return json_response(
                        StatusCode::BAD_REQUEST,
                        &serde_json::json!({ "error": "request too large" }),
                    )
                }
            };
            mcp::handle_post(&state, &headers, &body).await
        }
        Method::GET => mcp::handle_get(&state, &headers),
        Method::DELETE => mcp::handle_delete(&state, &headers),
        _ => json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            &serde_json::json!({ "error": "method not allowed" }),
        ),
    }
}

/// Public alias used by `main` and tests.
pub fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .fallback(dispatch)
        .layer(axum::middleware::from_fn(cors_layer))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allowlist_matches_node() {
        assert!(origin_allowed(""));
        assert!(origin_allowed("https://keepwork.com"));
        assert!(origin_allowed("https://a.b.keepwork.com"));
        assert!(origin_allowed("http://localhost:3001"));
        assert!(origin_allowed("http://127.0.0.1:8089"));
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://127.0.0.1.evil.com"));
    }

    #[test]
    fn query_decoding_handles_escapes() {
        let map = query_params(Some("path=%2Ftmp%2Fa%20b&x=1"));
        assert_eq!(map.get("path").unwrap(), "/tmp/a b");
    }
}
