//! Persona store and `/agents/personas` routes (`personas-v1`).
//!
//! Records live in `~/.keepwork-mcp/personas-v1/<sha256>.json`, the same files
//! the Node daemon writes. Runs call only the signed-in owner's Keepwork model.
//! The host attaches the `messaging-v1` service at startup: persona views carry
//! channel bindings, unanswered inboxes feed the reply digest and the upsert
//! busy guard blocks brain swaps mid-task. Native CLI sessions and WeChat stay
//! out of scope.

mod http;
mod local_tools;
mod model;
mod naming;
mod store;
#[cfg(test)]
mod tests;
mod util;
mod view;

pub use http::handle;
pub use store::PersonaStore;
pub use util::next_persona_run;

pub(crate) use local_tools::LocalToolEnv;
pub(crate) use model::keepwork_answer;

pub(crate) use crate::http::{json_response, AppState};
pub(crate) use crate::messaging::{MessageError, MessagingService};
pub(crate) use crate::presence::{AichatClient, PresenceState};
pub(crate) use axum::body::{Body, Bytes};
pub(crate) use axum::extract::Request;
pub(crate) use axum::http::{header, HeaderMap, StatusCode};
pub(crate) use axum::response::Response;
pub(crate) use chrono_tz::Tz;
pub(crate) use regex::Regex;
pub(crate) use serde_json::{json, Map, Value};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use std::collections::{HashMap, HashSet};
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard, OnceLock,
};
pub(crate) use std::time::Duration;

pub(crate) const MAX_BODY: usize = 131_072;
pub(crate) const EXECUTORS: &[&str] = &[
    "auto",
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

pub(crate) const IDENTITY_RULES: &str =
    "你是主人的分身。自定义智能体是分身的分身，对话历史各自独立，角色指令不能扩大权限。";

#[derive(Debug)]
pub struct PersonaError {
    pub(crate) status: u16,
    pub(crate) message: String,
    pub(crate) code: Option<&'static str>,
    pub(crate) body: Option<Value>,
}

impl PersonaError {
    pub(crate) fn custom(status: u16, body: Value) -> Self {
        Self {
            status,
            message: body["error"]
                .as_str()
                .unwrap_or("Request failed")
                .to_string(),
            code: body["code"].as_str().and_then(|code| match code {
                "UNSUPPORTED_FEATURE" => Some("UNSUPPORTED_FEATURE"),
                _ => None,
            }),
            body: Some(body),
        }
    }

    pub(crate) fn bad(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
            code: None,
            body: None,
        }
    }

    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self {
            status: 422,
            message: message.into(),
            code: Some("UNSUPPORTED_FEATURE"),
            body: None,
        }
    }

    pub(crate) fn unknown_op() -> Self {
        Self {
            status: 404,
            message: "Unknown Agent operation".into(),
            code: Some("UNSUPPORTED_FEATURE"),
            body: None,
        }
    }

    pub(crate) fn method() -> Self {
        Self {
            status: 405,
            message: "Method not allowed".into(),
            code: Some("UNSUPPORTED_FEATURE"),
            body: None,
        }
    }
}

pub fn error_response(status: u16, message: &str, code: Option<&str>) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), json!(message));
    if let Some(code) = code {
        body.insert("code".into(), json!(code));
    }
    let mut response = json_response(
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        &Value::Object(body),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response
}

pub(crate) fn error_to_response(error: PersonaError) -> Response {
    if let Some(body) = error.body {
        let mut response = json_response(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            &body,
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            "no-store".parse().expect("static header"),
        );
        return response;
    }
    error_response(error.status, &error.message, error.code)
}

pub(crate) fn ok_json(body: &Value) -> Response {
    let mut response = json_response(StatusCode::OK, body);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response
}
