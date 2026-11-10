//! Black-box contract tests for the P0 surface. These assert the exact wire
//! contract the Node daemon exposes so hosts and the browser client cannot tell
//! which engine answered.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state(require_auth: bool) -> Arc<AppState> {
    Arc::new(AppState::new(
        8099,
        std::env::temp_dir(),
        require_auth,
        "test-token".to_string(),
        Identity::from_env(Some("standalone".to_string()), None),
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
) -> (StatusCode, axum::http::HeaderMap) {
    let response = router(Arc::clone(state))
        .oneshot(request)
        .await
        .expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    drop(response);
    (status, headers)
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
    assert!(value.get("agentSessionApi").is_none());
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
    let (status, headers) = send_headers(&state, stream).await;
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

    let delete = Request::builder()
        .method("DELETE")
        .uri("/mcp")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&state, delete).await;
    assert_eq!(status, StatusCode::OK);
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

    let (status, _, body) = send(&state, get("/fs/list?root=/tmp")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ok"], true);

    let (status, _, body) = send(&state, get("/fs/nope?root=/tmp")).await;
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
