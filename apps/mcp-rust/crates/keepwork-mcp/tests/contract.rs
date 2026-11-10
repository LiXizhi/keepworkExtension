//! Black-box contract tests for the P0 surface. These assert the exact wire
//! contract the Node daemon exposes so hosts and the browser client cannot tell
//! which engine answered.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tower::ServiceExt;

fn test_state(require_auth: bool) -> Arc<AppState> {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let persona_dir =
        std::env::temp_dir().join(format!("kp-persona-contract-{}-{}", std::process::id(), n));
    Arc::new(AppState::new_at(
        8099,
        std::env::temp_dir(),
        require_auth,
        "test-token".to_string(),
        Identity::from_env(Some("standalone".to_string()), None),
        persona_dir,
    ))
}

async fn send(
    state: &Arc<AppState>,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = router(Arc::clone(state))
        .oneshot(request)
        .await
        .expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

/// Returns without draining the body: used for the endless SSE GET stream.
async fn send_headers(
    state: &Arc<AppState>,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Body) {
    let response = router(Arc::clone(state))
        .oneshot(request)
        .await
        .expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body();
    (status, headers, body)
}

fn get(path: &str) -> Request<Body> {
    Request::builder().uri(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn health_reports_identity_and_only_served_capabilities() {
    let state = test_state(false);
    let (status, headers, body) = send(&state, get("/health")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("application/json; charset=utf-8"));
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");

    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["name"], "keepwork-mcp");
    assert_eq!(value["version"], "0.1.2");
    assert_eq!(value["hostKind"], "standalone");
    assert_eq!(value["port"], 8099);
    assert_eq!(value["requireAuth"], false);
    assert_eq!(value["runtimeEngine"], "rust");
    assert_eq!(value["runtimeProduct"], "keepwork-mcp-runtime");
    assert!(value.get("workspaceRoot").is_some());
    // P1 advertises the local surface it serves and nothing further.
    assert_eq!(value["fsApi"], "workspace");
    assert_eq!(value["terminalApi"], "pty-session-v1");
    assert_eq!(value["personasApi"], "personas-v1");
    assert!(value.get("agentSessionApi").is_none());
    assert_eq!(value["messagingApi"], "messaging-v1");
}

#[tokio::test]
async fn cors_preflight_and_allowed_origins_match_node() {
    let state = test_state(false);
    let preflight = Request::builder()
        .method("OPTIONS")
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = send(&state, preflight).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        headers[header::ACCESS_CONTROL_ALLOW_METHODS],
        "GET, POST, PATCH, PUT, DELETE, OPTIONS"
    );
    assert_eq!(
        headers[header::ACCESS_CONTROL_EXPOSE_HEADERS],
        "Mcp-Session-Id, MCP-Protocol-Version, Retry-After"
    );

    let with_origin = Request::builder()
        .uri("/health")
        .header(header::ORIGIN, "https://keepwork.com")
        .body(Body::empty())
        .unwrap();
    let (_, headers, _) = send(&state, with_origin).await;
    assert_eq!(
        headers[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://keepwork.com"
    );
    assert_eq!(headers[header::VARY], "Origin");
    assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");
}

#[tokio::test]
async fn mcp_initialize_lists_only_implemented_tools() {
    let state = test_state(false);
    let init = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}"#,
        ))
        .unwrap();
    let (status, headers, body) = send(&state, init).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    let session = headers["mcp-session-id"].to_str().unwrap().to_string();

    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(value["result"]["serverInfo"]["name"], "keepwork-mcp");
    assert_eq!(
        value["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    assert_eq!(
        value["result"]["capabilities"]["experimental"]["keepwork/events"]["version"],
        1
    );

    let list = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .header("mcp-session-id", &session)
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ))
        .unwrap();
    let (status, _, body) = send(&state, list).await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&body).unwrap();
    let tools = value["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 5);
    assert_eq!(tools[0]["name"], "mcp_status");
    assert_eq!(tools[1]["name"], "run_terminal");
    assert_eq!(
        tools[0]["inputSchema"],
        serde_json::json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {},
        })
    );
    assert_eq!(tools[0]["execution"]["taskSupport"], "forbidden");

    let call = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .header("mcp-session-id", &session)
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mcp_status","arguments":{}}}"#,
        ))
        .unwrap();
    let (status, _, body) = send(&state, call).await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["result"]["isError"], false);
    let text = value["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("# Keepwork local MCP\n\n- name: keepwork-mcp 0.1.2"));
    assert!(text.contains("- port: 8099"));
    assert!(text.ends_with("Tools: run_terminal, grep_files, mcp_status, web_search, fetch_url"));
}

#[tokio::test]
async fn mcp_unknown_tool_is_a_tool_error() {
    let state = test_state(false);
    let init = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#,
        ))
        .unwrap();
    let (_, headers, _) = send(&state, init).await;
    let session = headers["mcp-session-id"].to_str().unwrap().to_string();
    let call = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .header("mcp-session-id", &session)
        .body(Body::from(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#))
        .unwrap();
    let (_, _, body) = send(&state, call).await;
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["result"]["isError"], true);
    assert_eq!(
        value["result"]["content"][0]["text"],
        "MCP error -32602: Tool nope not found"
    );
}

#[tokio::test]
async fn streamed_replies_use_sse_framing() {
    let state = test_state(false);
    let init = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{"experimental":{"keepwork/streamedResponses":{"version":1}}},"clientInfo":{"name":"probe","version":"1"}}}"#,
        ))
        .unwrap();
    let (status, headers, body) = send(&state, init).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache, no-transform");
    assert_eq!(headers["x-accel-buffering"], "no");
    let text = String::from_utf8(body).unwrap();
    assert!(
        text.starts_with("event: message\ndata: {\"result\":{\"protocolVersion\":\"2025-03-26\"")
    );
    assert!(text.ends_with("\n\n"));
}

#[tokio::test]
async fn duplicate_get_stream_is_rejected_and_delete_closes() {
    let state = test_state(false);
    let init = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#,
        ))
        .unwrap();
    let (_, headers, _) = send(&state, init).await;
    let session = headers["mcp-session-id"].to_str().unwrap().to_string();

    let stream = Request::builder()
        .uri("/mcp")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let (status, headers, stream_body) = send_headers(&state, stream).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");

    let duplicate = Request::builder()
        .uri("/mcp")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&state, duplicate).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "MCP stream already open"
    );

    // Dropping the first stream immediately releases active_streams so reconnect succeeds.
    drop(stream_body);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let reconnect = Request::builder()
        .uri("/mcp")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let (status, _, reconnect_body) = send_headers(&state, reconnect).await;
    assert_eq!(status, StatusCode::OK);
    drop(reconnect_body);

    let delete = Request::builder()
        .method("DELETE")
        .uri("/mcp")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&state, delete).await;
    assert_eq!(status, StatusCode::OK);

    // Expired/deleted session on POST /mcp returns 400 invalid session so AIChat re-initializes.
    let expired_post = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::CONTENT_TYPE, "application/json")
        .header("mcp-session-id", &session)
        .body(Body::from(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ))
        .unwrap();
    let (status, _, body) = send(&state, expired_post).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "invalid session"
    );
}

#[tokio::test]
async fn auth_guards_admin_but_not_health() {
    let state = test_state(true);
    let (status, _, body) = send(&state, get("/admin/status")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "unauthorized"
    );

    let authorized = Request::builder()
        .uri("/admin/status")
        .header(header::AUTHORIZATION, "Bearer test-token")
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&state, authorized).await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["requireAuth"], true);
    assert_eq!(value["clients"].as_array().unwrap().len(), 0);

    let (status, _, _) = send(&state, get("/health")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn exists_and_fs_stat_keep_node_shapes() {
    let state = test_state(false);
    let temp = std::env::temp_dir();
    let exists = get(&format!(
        "/exists?path={}",
        temp.to_string_lossy().replace(' ', "%20")
    ));
    let (status, _, body) = send(&state, exists).await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["exists"], true);
    assert_eq!(value["isDirectory"], true);

    let (status, _, body) = send(&state, get("/exists")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "path is required"
    );

    let root = temp.to_string_lossy().replace(' ', "%20");
    let (status, _, body) = send(
        &state,
        get(&format!("/fs/stat?root={root}&path=missing-kp")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["exists"], false);
    assert_eq!(value["rel"], "missing-kp");

    let (status, _, body) = send(&state, get("/fs/stat?path=x")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "root is required"
    );
}

#[tokio::test]
async fn unknown_routes_answer_like_node() {
    let state = test_state(false);
    let (status, _, body) = send(&state, get("/nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "not found"
    );

    let root = std::env::temp_dir().to_string_lossy().replace(' ', "%20");
    let (status, _, body) = send(&state, get(&format!("/fs/list?root={root}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ok"], true);

    let (status, _, body) = send(&state, get(&format!("/fs/nope?root={root}"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ok"], false);

    let method = Request::builder()
        .method("POST")
        .uri("/fs/stat")
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&state, method).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

fn persona(method: &str, path: &str, body: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, "http://127.0.0.1:64533")
        .header("x-agent-owner", "a".repeat(32));
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    builder
        .body(Body::from(body.unwrap_or("").to_string()))
        .unwrap()
}

#[tokio::test]
async fn personas_round_trip_without_a_login() {
    let state = test_state(false);
    let (status, _, _) = send(&state, get("/agents/personas")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, body) = send(
        &state,
        Request::builder()
            .uri("/agents/personas")
            .header(header::ORIGIN, "http://127.0.0.1:64533")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "Agent owner key required"
    );

    let (status, _, body) = send(
        &state,
        persona(
            "POST",
            "/agents/personas",
            Some(
                r#"{"id":"default-persona","name":"我的分身","avatar":"🧠","prompt":"hi","executor":"auto","model":"","pinned":true,"order":0,"root":""}"#,
            ),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let created: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(created["name"], "我的分身");
    assert!(created.get("owner").is_none());

    let (status, _, body) = send(&state, persona("GET", "/agents/personas", None)).await;
    assert_eq!(status, StatusCode::OK);
    let listed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(listed["agents"].as_array().unwrap().len(), 1);

    let (status, _, body) = send(
        &state,
        persona(
            "POST",
            "/agents/personas/default-persona/messages",
            Some(r#"{"requestId":"m-bad","text":"hello","contextMode":"nope"}"#),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["code"],
        "UNSUPPORTED_FEATURE"
    );

    let (status, _, body) = send(
        &state,
        persona(
            "POST",
            "/agents/personas/default-persona/messages",
            Some(r#"{"requestId":"m1","text":"hello","contextMode":"conversation","ownerComposer":true}"#),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["job"]["state"],
        "queued"
    );

    let mut detail = Value::Null;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let (status, _, body) = send(
            &state,
            persona("GET", "/agents/personas/default-persona", None),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        detail = serde_json::from_slice(&body).unwrap();
        if detail["job"]["state"] == "needs-login" {
            break;
        }
    }
    assert_eq!(detail["job"]["state"], "needs-login");
    assert_eq!(detail["messages"].as_array().unwrap().len(), 1);

    let (status, _, _) = send(
        &state,
        persona(
            "POST",
            "/agents/personas/default-persona/messages",
            Some(r#"{"requestId":"m1","text":"hello again","contextMode":"conversation"}"#),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = send(
        &state,
        persona("GET", "/agents/personas/default-persona", None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let detail: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(detail["messages"].as_array().unwrap().len(), 1);

    let (status, _, body) = send(
        &state,
        persona("POST", "/agents/personas/default-persona/clear", Some("{}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(serde_json::from_slice::<Value>(&body).unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());

    let (status, _, body) = send(&state, persona("GET", "/admin/personas", None)).await;
    assert_eq!(status, StatusCode::OK);
    let admin: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(admin["personas"][0]["name"], "我的分身");

    let (status, _, body) = send(&state, get("/dashboard")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(body).unwrap();
    assert!(html.contains("分身"));
    assert!(html.contains("view-chat"));

    let (status, headers, mut stream) =
        send_headers(&state, persona("GET", "/agents/personas/events", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/event-stream");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), stream.frame())
        .await
        .expect("sse timed out")
        .expect("sse frame")
        .expect("sse data")
        .into_data()
        .unwrap();
    assert!(String::from_utf8_lossy(&frame).contains("event: changed"));
}
