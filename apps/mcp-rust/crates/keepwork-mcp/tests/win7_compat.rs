//! Exercise the legacy wire contract on the host without pretending it is a
//! Windows 7/8 runtime test. The actual target excludes the native PTY dependency.
#![cfg(any(target_vendor = "win7", feature = "win7-compat"))]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kp-win7-contract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        Self(root)
    }
    fn state(&self, auth: bool) -> Arc<AppState> {
        Arc::new(AppState::new_at(
            31337,
            self.0.join("workspace"),
            auth,
            "win7-fixture-token".into(),
            Identity::from_env(Some("win7-win8-launcher".into()), None),
            self.0.join("profile/personas-v1"),
        ))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn send(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, Vec<u8>) {
    let response = router(Arc::clone(state)).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, bytes)
}

#[tokio::test]
async fn legacy_clients_cannot_create_or_access_a_pty_and_other_routes_keep_working() {
    let fixture = Fixture::new();
    let state = fixture.state(false);
    assert!(!keepwork_mcp::terminal::supported());
    for (method, path) in [
        ("POST", "/terminal/sessions"),
        ("POST", "/terminal/sessions/unknown/input"),
        ("GET", "/terminal/sessions/unknown/output?cursor=0"),
        ("GET", "/terminal/sessions/unknown/stream?cursor=0"),
        ("POST", "/terminal/sessions/unknown/interrupt"),
        ("POST", "/terminal/sessions/unknown/resize"),
        ("DELETE", "/terminal/sessions/unknown"),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", "https://keepwork.com")
            .header("Content-Type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let (status, bytes) = send(&state, request).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{method} {path}");
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "UNSUPPORTED_FEATURE");
        assert_eq!(body["feature"], "pty-session-v1");
        assert!(bytes.len() < 1024);
    }
    let (status, bytes) = send(
        &state,
        Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let health: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(health.get("terminalApi").is_none());
    assert_eq!(health["runtimeVariant"], "win7-win8");
    assert_eq!(health["minWindows"], json!([6, 1, 7601]));
    assert_eq!(health["fsApi"], "workspace");

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("root", state.root.to_str().unwrap())
        .append_pair("path", "中文 note.txt")
        .finish();
    let write = Request::builder()
        .method("PUT")
        .uri(format!("/fs/file?{query}"))
        .header("Origin", "https://keepwork.com")
        .body(Body::from("legacy filesystem survives"))
        .unwrap();
    assert_eq!(send(&state, write).await.0, StatusCode::OK);
    let read = Request::builder()
        .uri(format!("/fs/file?{query}"))
        .header("Origin", "https://keepwork.com")
        .body(Body::empty())
        .unwrap();
    let (status, bytes) = send(&state, read).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"legacy filesystem survives");

    let command = state
        .shell
        .run(
            "win7-test",
            "echo WIN7_PIPE_OK",
            None,
            Some(5000.0),
            &state.root,
        )
        .await
        .unwrap();
    assert!(command.ok);
    assert!(command.stdout.contains("WIN7_PIPE_OK"));
    assert!(state
        .shell
        .run("win7-test", "shutdown -h now", None, None, &state.root)
        .await
        .is_err());
}

#[tokio::test]
async fn unsupported_pty_routes_still_enforce_origin_and_authentication_first() {
    let fixture = Fixture::new();
    let state = fixture.state(true);
    for (origin, token, expected) in [
        (
            "https://evil.example",
            Some("win7-fixture-token"),
            StatusCode::FORBIDDEN,
        ),
        ("https://keepwork.com", None, StatusCode::UNAUTHORIZED),
        (
            "https://keepwork.com",
            Some("bad-token"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "https://keepwork.com",
            Some("win7-fixture-token"),
            StatusCode::NOT_IMPLEMENTED,
        ),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/terminal/sessions")
            .header("Origin", origin);
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        assert_eq!(
            send(&state, request.body(Body::from("{}")).unwrap())
                .await
                .0,
            expected
        );
    }
}
