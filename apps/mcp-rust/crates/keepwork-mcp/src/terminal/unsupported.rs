//! Bounded compatibility response. Never initializes a native PTY implementation.

use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct TerminalManager;

impl TerminalManager {
    pub fn prune(&self) {}
    pub fn close_all(&self) {}
}

pub async fn route(
    _manager: &TerminalManager,
    _root: &std::path::Path,
    _req: Request,
    path: &str,
    _query: &BTreeMap<String, String>,
    _headers: &HeaderMap,
) -> Option<Response> {
    if path != "/terminal/sessions" && !path.starts_with("/terminal/sessions/") {
        return None;
    }
    Some(crate::http::json_response(
        StatusCode::NOT_IMPLEMENTED,
        &serde_json::json!({
            "ok": false,
            "code": "UNSUPPORTED_FEATURE",
            "feature": "pty-session-v1",
            "error": "Interactive terminals are unavailable in the Windows 7/8 compatibility runtime. Ordinary run_terminal commands remain available.",
        }),
    ))
}
