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
    pub shell: Arc<ShellRunner>,
    pub presence: Arc<crate::presence::PresenceState>,
    pub personas: Arc<crate::personas::PersonaStore>,
    pub messaging: Arc<crate::messaging::MessagingService>,
}

impl AppState {
    pub fn new(
        port: u16,
        root: PathBuf,
        require_auth: bool,
        token: String,
        identity: Identity,
    ) -> Self {
        Self::new_at(
            port,
            root,
            require_auth,
            token,
            identity,
            crate::config::mcp_home_dir().join("personas-v1"),
        )
    }

    /// `persona_dir` is separate so tests never rewrite `~/.keepwork-mcp/personas-v1`.
    pub fn new_at(
        port: u16,
        root: PathBuf,
        require_auth: bool,
        token: String,
        identity: Identity,
        persona_dir: PathBuf,
    ) -> Self {
        let personas = crate::personas::PersonaStore::open(persona_dir.clone());
        let presence = Arc::new(crate::presence::PresenceState::new());
        let messaging_home = persona_dir
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or_else(crate::config::mcp_home_dir)
            .join(crate::messaging::MESSAGING_HOME);
        let messaging = crate::messaging::MessagingService::open(
            messaging_home,
            Arc::clone(&personas),
            Arc::clone(&presence),
        );
        personas.attach_messaging(Arc::clone(&messaging));
        let started_at = now_iso();
        let shell = Arc::new(ShellRunner::default());
        personas.attach_tools(Arc::new(crate::personas::LocalToolEnv {
            port,
            root: root.clone(),
            started_at: started_at.clone(),
            require_auth,
            shell: Arc::clone(&shell),
        }));
        Self {
            port,
            root,
            require_auth,
            token,
            started_at,
            identity,
            sessions: Mutex::new(SessionStore::default()),
            terminals: TerminalManager::default(),
            shell,
            presence: Arc::clone(&presence),
            messaging,
            personas,
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
        caps.insert("fsDirApi".into(), serde_json::json!("mkdir-v1"));
        caps.insert("aichatPresenceApi".into(), serde_json::json!("post-sse-v1"));
        caps.insert("personasApi".into(), serde_json::json!("personas-v1"));
        caps.insert(
            "messagingApi".into(),
            serde_json::json!(crate::messaging::MESSAGING_API),
        );
        // Native agent sessions and WeChat stay unadvertised.
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
        ("GET", "/") | ("GET", "/dashboard") => crate::dashboard::serve_dashboard(),
        ("GET", "/dashboard/skills/keepwork-mcp-assistant/SKILL.md") => {
            crate::dashboard::serve_skill(
                state.port,
                query.get("channel").map(String::as_str).unwrap_or(""),
            )
        }
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
        (_, path) if path.starts_with("/admin/") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !origin_allowed(origin) {
                let mut resp = json_response(
                    StatusCode::FORBIDDEN,
                    &serde_json::json!({ "error": "origin not allowed" }),
                );
                resp.headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                return resp;
            }
            if let Some(mut denied) = authorize(&state, req.headers(), &query) {
                denied
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                return denied;
            }
            let mut resp = match (method.as_str(), path) {
                ("GET", "/admin/status") => admin_status(&state),
                ("GET", "/admin/history") => {
                    let offset = query.get("offset").and_then(|v| v.parse::<usize>().ok());
                    let limit = query.get("limit").and_then(|v| v.parse::<usize>().ok());
                    let payload = state
                        .sessions
                        .lock()
                        .map(|store| store.list_history(offset, limit))
                        .unwrap_or_else(|_| {
                            serde_json::json!({
                                "ok": true,
                                "history": [],
                                "total": 0,
                                "offset": 0,
                                "limit": 25,
                                "hasMore": false,
                            })
                        });
                    json_response(StatusCode::OK, &payload)
                }
                ("GET", "/admin/api-docs") => crate::dashboard::api_docs(&state),
                ("GET", "/admin/screenshot-permission") => json_response(
                    StatusCode::OK,
                    &serde_json::json!({ "alwaysAllowScreenshots": false }),
                ),
                ("GET", "/admin/channels") => {
                    let rows = state.messaging.list_binding_rows();
                    if query.get("view").map(String::as_str) == Some("tray") {
                        let channels = ["dingtalk", "feishu"]
                            .iter()
                            .map(|channel| {
                                let bindings = rows
                                    .iter()
                                    .filter(|binding| binding["channel"].as_str() == Some(*channel))
                                    .map(|binding| serde_json::json!({ "status": binding["status"] }))
                                    .collect::<Vec<_>>();
                                serde_json::json!({ "channel": channel, "bindings": bindings })
                            })
                            .collect::<Vec<_>>();
                        json_response(
                            StatusCode::OK,
                            &serde_json::json!({
                                "channels": channels,
                                "wechat": { "status": "off" },
                            }),
                        )
                    } else {
                        let channels = ["dingtalk", "feishu"]
                            .iter()
                            .map(|channel| {
                                let root = state
                                    .messaging
                                    .channel_roots()
                                    .get(*channel)
                                    .cloned()
                                    .unwrap_or(serde_json::json!(""));
                                let bindings = rows
                                    .iter()
                                    .filter(|binding| binding["channel"].as_str() == Some(*channel))
                                    .map(|binding| {
                                        serde_json::json!({
                                            "id": binding["id"],
                                            "root": binding["root"],
                                            "transitioning": binding["transitioning"],
                                            "profile": binding["profile"],
                                            "enabled": binding["enabled"],
                                            "status": binding["status"],
                                            "lastPollAt": binding.get("lastPollAt").cloned().unwrap_or(serde_json::json!(null)),
                                            "serving": binding.get("serving").cloned().unwrap_or(serde_json::json!(null)),
                                        })
                                    })
                                    .collect::<Vec<_>>();
                                // The Rust slice omits the live CLI auth probe;
                                // the dashboard reads structure and bindings only.
                                serde_json::json!({ "channel": channel, "root": root, "bindings": bindings })
                            })
                            .collect::<Vec<_>>();
                        json_response(
                            StatusCode::OK,
                            &serde_json::json!({
                                "channels": channels,
                                "supervisor": { "enabled": false, "status": "stopped" },
                            }),
                        )
                    }
                }
                ("GET", "/admin/personas") => {
                    json_response(StatusCode::OK, &state.personas.admin_snapshot())
                }
                ("GET", "/admin/messaging-computers") => {
                    json_response(StatusCode::OK, &serde_json::json!({ "accounts": [] }))
                }
                ("POST", "/admin/stop") => {
                    state.terminals.close_all();
                    let messaging = Arc::clone(&state.messaging);
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        messaging.close().await;
                        std::process::exit(0);
                    });
                    json_response(
                        StatusCode::OK,
                        &serde_json::json!({ "ok": true, "stopping": true }),
                    )
                }
                _ => json_response(
                    StatusCode::NOT_FOUND,
                    &serde_json::json!({ "error": "not found" }),
                ),
            };
            resp.headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            resp
        }
        (_, "/aichat/presence") => {
            crate::presence::handle_presence_http(&state, req, &query, &headers).await
        }
        (_, "/mcp") => mcp_dispatch(state, req).await,
        (_, path) if path.starts_with("/messaging/") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            let worker = path == "/messaging/worker" || path.starts_with("/messaging/worker/");
            if worker {
                // Worker pages drive a headless-browser answer harness the
                // Rust runtime does not ship; Node accepts them only from its
                // own loopback origin.
                if !origin.is_empty() && origin != format!("http://127.0.0.1:{}", state.port) {
                    return crate::personas::error_response(403, "Messaging Origin rejected", None);
                }
                return crate::personas::error_response(
                    422,
                    "本机 Rust 服务尚未提供无头消息 worker",
                    Some("UNSUPPORTED_FEATURE"),
                );
            }
            if origin.is_empty() || !origin_allowed(origin) {
                // The whole /messaging/ mount shares one rejection message in
                // Node, unlike the /agents/ mount.
                return crate::personas::error_response(403, "Messaging Origin rejected", None);
            }
            if let Some(mut denied) = authorize(&state, &headers, &query) {
                denied.headers_mut().insert(
                    header::CACHE_CONTROL,
                    "no-store".parse().expect("static header"),
                );
                return denied;
            }
            crate::messaging::handle_messaging_http(
                Arc::clone(&state.messaging),
                method.as_str(),
                path,
                &query,
                req,
            )
            .await
        }
        (_, path) if path == "/agents/personas" || path.starts_with("/agents/personas/") => {
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if origin.is_empty() || !origin_allowed(origin) {
                return crate::personas::error_response(
                    403,
                    "Explicit allowed Origin required",
                    None,
                );
            }
            if let Some(mut denied) = authorize(&state, &headers, &query) {
                denied.headers_mut().insert(
                    header::CACHE_CONTROL,
                    "no-store".parse().expect("static header"),
                );
                return denied;
            }
            crate::personas::handle(state, method.as_str(), path, &query, &headers, req).await
        }
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
    body.insert(
        "aichatClient".into(),
        serde_json::json!(state.presence.has_remembered()),
    );
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
    body.insert(
        "aichatClient".into(),
        serde_json::json!(state.presence.has_remembered()),
    );
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

// TEMP probe: forces the Send bound so rustc reports the offending await path.
#[allow(dead_code)]
fn __dispatch_send_probe<F: std::future::Future + Send>(
    _f: fn(axum::extract::State<std::sync::Arc<AppState>>, Request<axum::body::Body>) -> F,
) {
}
#[allow(dead_code)]
fn __dispatch_send_probe_use() {
    __dispatch_send_probe(dispatch);
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
