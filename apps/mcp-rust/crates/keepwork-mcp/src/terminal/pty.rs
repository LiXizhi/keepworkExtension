//! PTY-backed terminal sessions (mirrors `src/core/terminalSessions.ts`).
//!
//! Same routes, owner rules, cursor replay and output cap as the Node daemon;
//! `portable-pty` replaces `node-pty`.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::{assert_allowed_command, GLOBAL_TERMINAL_CAP, OUTPUT_CHAR_CAP};
use crate::http::json_response;

const TERMINAL_IDLE_MS: i64 = 30 * 60 * 1000;
const MAX_INPUT_LENGTH: usize = 64_000;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;

#[derive(Clone, serde::Serialize)]
pub struct TerminalOutputEvent {
    pub cursor: usize,
    pub reset: bool,
    pub output: String,
    pub closed: bool,
}

struct TerminalSession {
    id: String,
    owner: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    output: Mutex<String>,
    base_cursor: AtomicU64,
    closed: AtomicBool,
    created_at: i64,
    touched_at: AtomicI64,
    cols: AtomicU64,
    rows: AtomicU64,
    listeners: Mutex<Vec<tokio::sync::mpsc::UnboundedSender<TerminalOutputEvent>>>,
}

impl TerminalSession {
    fn snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "cwd": self.cwd,
            "createdAt": iso_from_millis(self.created_at),
            "runningCommand": !self.closed.load(Ordering::SeqCst),
            "closed": self.closed.load(Ordering::SeqCst),
            "cols": self.cols.load(Ordering::SeqCst),
            "rows": self.rows.load(Ordering::SeqCst),
        })
    }

    fn append(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let (event, base) = {
            let mut output = self.output.lock().expect("terminal output");
            output.push_str(text);
            // Cursors count UTF-16 code units, exactly like `string.length` in
            // the Node daemon, so emoji advance by two in both engines.
            let units = utf16_len(&output);
            if units > OUTPUT_CHAR_CAP {
                let overflow = units - OUTPUT_CHAR_CAP;
                let cut = char_index_at_utf16(&output, overflow);
                output.drain(..cut);
                let _ = self
                    .base_cursor
                    .fetch_add(overflow as u64, Ordering::SeqCst);
            }
            (
                TerminalOutputEvent {
                    cursor: 0,
                    reset: false,
                    output: text.to_string(),
                    closed: self.closed.load(Ordering::SeqCst),
                },
                self.base_cursor.load(Ordering::SeqCst),
            )
        };
        let units = utf16_len(&self.output.lock().expect("terminal output"));
        let event = TerminalOutputEvent {
            cursor: base as usize + units,
            ..event
        };
        let listeners = self.listeners.lock().expect("terminal listeners");
        for listener in listeners.iter() {
            let _ = listener.send(event.clone());
        }
    }

    fn output_since(&self, cursor: usize) -> Value {
        self.touched_at.store(now_millis(), Ordering::SeqCst);
        let base = self.base_cursor.load(Ordering::SeqCst) as usize;
        let output = self.output.lock().expect("terminal output");
        let reset = cursor < base;
        let start = if reset {
            0
        } else {
            char_index_at_utf16(&output, cursor.saturating_sub(base))
        };
        let text: String = output.chars().skip(start).collect();
        let mut body = self.snapshot();
        if let Value::Object(fields) = &mut body {
            fields.insert("cursor".into(), json!(base + utf16_len(&output)));
            fields.insert("reset".into(), json!(reset));
            fields.insert("output".into(), json!(text));
        }
        body
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<BTreeMap<String, Arc<TerminalSession>>>,
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Converts a UTF-16 offset into a UTF-8 char index, clamping to a char
/// boundary the way a browser client would when it replays from a cursor.
fn char_index_at_utf16(value: &str, offset: usize) -> usize {
    let mut units = 0usize;
    for (index, ch) in value.chars().enumerate() {
        if units >= offset {
            return index;
        }
        units += ch.len_utf16();
    }
    value.chars().count()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn iso_from_millis(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn clamp_dimension(value: Option<f64>, fallback: u16, min: u16, max: u16) -> u16 {
    match value {
        Some(raw) if raw.is_finite() => (raw.floor() as i64).clamp(min as i64, max as i64) as u16,
        _ => fallback,
    }
}

fn shell_spec() -> (String, Vec<String>) {
    if cfg!(windows) {
        let spec = std::env::var("ComSpec").unwrap_or_default();
        let command = if !spec.is_empty()
            && !regex::Regex::new(r"(?i)cmd(?:\.exe)?$")
                .unwrap()
                .is_match(&spec)
        {
            spec
        } else {
            "powershell.exe".to_string()
        };
        let init = POWERSHELL_UTF8_INIT;
        let encoded = base64_utf16le(init);
        return (
            command,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NoExit".to_string(),
                "-EncodedCommand".to_string(),
                encoded,
            ],
        );
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    (shell, Vec::new())
}

const POWERSHELL_UTF8_INIT: &str = "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'; $PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8'";

fn base64_utf16le(text: &str) -> String {
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    crate::fs::encode_base64(&bytes)
}

impl TerminalManager {
    pub fn create(
        &self,
        root: &std::path::Path,
        cwd: Option<&str>,
        owner: &str,
        cols_raw: Option<f64>,
        rows_raw: Option<f64>,
    ) -> Result<Value, String> {
        let count = self.sessions.lock().expect("terminals").len();
        if count >= GLOBAL_TERMINAL_CAP {
            return Err(format!(
                "terminal session limit reached ({GLOBAL_TERMINAL_CAP})"
            ));
        }
        let resolved_cwd = crate::paths::resolve_workdir(&root.to_string_lossy(), cwd)
            .map_err(|error| error.message)?;
        let cwd_text = resolved_cwd.to_string_lossy().into_owned();
        if !resolved_cwd.exists() {
            std::fs::create_dir_all(&resolved_cwd).map_err(|error| error.to_string())?;
        }
        let cols = clamp_dimension(cols_raw, DEFAULT_COLS, MIN_COLS, MAX_COLS);
        let rows = clamp_dimension(rows_raw, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
        let (shell, args) = shell_spec();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(shell);
        for arg in &args {
            command.arg(arg);
        }
        command.cwd(&resolved_cwd);
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;

        let now = now_millis();
        let session = Arc::new(TerminalSession {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner.to_string(),
            cwd: cwd_text,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            output: Mutex::new(String::new()),
            base_cursor: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            created_at: now,
            touched_at: AtomicI64::new(now),
            cols: AtomicU64::new(cols as u64),
            rows: AtomicU64::new(rows as u64),
            listeners: Mutex::new(Vec::new()),
        });
        let snapshot = session.snapshot();
        self.sessions
            .lock()
            .expect("terminals")
            .insert(session.id.clone(), Arc::clone(&session));

        let reader_session = Arc::clone(&session);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                        reader_session.append(&text);
                    }
                    Err(_) => break,
                }
            }
            if !reader_session.closed.swap(true, Ordering::SeqCst) {
                let exit_note = "\r\n[terminal exited 0]\r\n".to_string();
                reader_session.append(&exit_note);
            }
        });

        Ok(snapshot)
    }

    pub fn write(&self, id: &str, owner: &str, data: &str) -> Result<(), String> {
        let session = self.get(id, owner)?;
        if data.chars().count() > MAX_INPUT_LENGTH {
            return Err("terminal input is too long".to_string());
        }
        if session.closed.load(Ordering::SeqCst) {
            return Err("terminal session is closed".to_string());
        }
        session.touched_at.store(now_millis(), Ordering::SeqCst);
        session
            .writer
            .lock()
            .expect("terminal writer")
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn send(&self, id: &str, owner: &str, command: &str) -> Result<(), String> {
        let text = assert_allowed_command(command)?;
        self.write(id, owner, &format!("{text}\r"))
    }

    pub fn resize(
        &self,
        id: &str,
        owner: &str,
        cols: Option<f64>,
        rows: Option<f64>,
    ) -> Result<Value, String> {
        let session = self.get(id, owner)?;
        if session.closed.load(Ordering::SeqCst) {
            return Err("terminal session is closed".to_string());
        }
        let next_cols = clamp_dimension(
            cols,
            session.cols.load(Ordering::SeqCst) as u16,
            MIN_COLS,
            MAX_COLS,
        );
        let next_rows = clamp_dimension(
            rows,
            session.rows.load(Ordering::SeqCst) as u16,
            MIN_ROWS,
            MAX_ROWS,
        );
        session
            .master
            .lock()
            .expect("terminal master")
            .resize(PtySize {
                rows: next_rows,
                cols: next_cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        session.cols.store(next_cols as u64, Ordering::SeqCst);
        session.rows.store(next_rows as u64, Ordering::SeqCst);
        session.touched_at.store(now_millis(), Ordering::SeqCst);
        Ok(session.snapshot())
    }

    pub fn output(&self, id: &str, owner: &str, cursor: usize) -> Result<Value, String> {
        let session = self.get(id, owner)?;
        Ok(session.output_since(cursor))
    }

    pub fn subscribe(
        &self,
        id: &str,
        owner: &str,
        cursor: usize,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<TerminalOutputEvent>, String> {
        let session = self.get(id, owner)?;
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let initial = session.output_since(cursor);
        let event = TerminalOutputEvent {
            cursor: initial["cursor"].as_u64().unwrap_or(0) as usize,
            reset: initial["reset"].as_bool().unwrap_or(false),
            output: initial["output"].as_str().unwrap_or("").to_string(),
            closed: initial["closed"].as_bool().unwrap_or(false),
        };
        // Replay first, then live output, through one ordered channel.
        let _ = sender.send(event);
        session
            .listeners
            .lock()
            .expect("terminal listeners")
            .push(sender);
        Ok(receiver)
    }

    pub fn interrupt(&self, id: &str, owner: &str) -> Result<(), String> {
        self.write(id, owner, "\x03")
    }

    pub fn close(&self, id: &str, owner: &str) -> Result<(), String> {
        let session = self.get(id, owner)?;
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
        self.sessions.lock().expect("terminals").remove(id);
        Ok(())
    }

    pub fn prune(&self) {
        let now = now_millis();
        let mut sessions = self.sessions.lock().expect("terminals");
        let stale: Vec<String> = sessions
            .values()
            .filter(|session| now - session.touched_at.load(Ordering::SeqCst) > TERMINAL_IDLE_MS)
            .map(|session| session.id.clone())
            .collect();
        for id in stale {
            if let Some(session) = sessions.remove(&id) {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
            }
        }
    }

    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock().expect("terminals");
        for session in sessions.values() {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
        }
        sessions.clear();
    }

    fn get(&self, id: &str, owner: &str) -> Result<Arc<TerminalSession>, String> {
        let sessions = self.sessions.lock().expect("terminals");
        match sessions.get(id) {
            Some(session) if session.owner == owner => Ok(Arc::clone(session)),
            _ => Err("terminal session not found".to_string()),
        }
    }
}

fn terminal_error_status(message: &str) -> u16 {
    if message.contains("not found") {
        return 404;
    }
    let lower = message.to_ascii_lowercase();
    for needle in [
        "required",
        "too long",
        "already running",
        "closed",
        "blocked",
        "does not exist",
        "not a directory",
        "limit reached",
    ] {
        if lower.contains(needle) {
            return 400;
        }
    }
    500
}

fn terminal_owner(headers: &HeaderMap) -> String {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("local-no-origin")
        .to_string()
}

fn error_body(message: &str) -> Response {
    json_response(
        StatusCode::from_u16(terminal_error_status(message))
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &json!({ "ok": false, "error": message }),
    )
}

fn ok_body(status: StatusCode, body: Value) -> Response {
    let mut map = serde_json::Map::new();
    map.insert("ok".into(), json!(true));
    if let Value::Object(fields) = body {
        map.extend(fields);
    }
    json_response(status, &Value::Object(map))
}

async fn json_body(req: Request) -> Value {
    let bytes = axum::body::to_bytes(req.into_body(), 2_000_000)
        .await
        .unwrap_or_default();
    if bytes.is_empty() {
        return json!({});
    }
    serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// Handles `/terminal/*`. Returns `None` for unrelated paths.
pub async fn route(
    manager: &TerminalManager,
    root: &std::path::Path,
    req: Request,
    path: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
) -> Option<Response> {
    let method = req.method().clone();
    if path == "/terminal/sessions" && method == Method::POST {
        let owner = terminal_owner(headers);
        let body = json_body(req).await;
        let cwd = body.get("cwd").and_then(Value::as_str);
        let cols = as_number(body.get("cols"));
        let rows = as_number(body.get("rows"));
        return Some(match manager.create(root, cwd, &owner, cols, rows) {
            Ok(snapshot) => ok_body(StatusCode::CREATED, snapshot),
            Err(message) => error_body(&message),
        });
    }

    let rest = path.strip_prefix("/terminal/sessions/")?;
    let (raw_id, action) = match rest.split_once('/') {
        Some((id, action)) => (id, action),
        None => (rest, ""),
    };
    let id = percent_encoding::percent_decode_str(raw_id)
        .decode_utf8_lossy()
        .into_owned();
    let owner = terminal_owner(headers);

    let result: Result<Response, String> = match (action, method.clone()) {
        ("commands", Method::POST) => {
            let body = json_body(req).await;
            let command = body
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            manager
                .send(&id, &owner, &command)
                .map(|_| ok_body(StatusCode::ACCEPTED, json!({ "accepted": true })))
        }
        ("input", Method::POST) => {
            let body = json_body(req).await;
            let data = body
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            manager
                .write(&id, &owner, &data)
                .map(|_| ok_body(StatusCode::ACCEPTED, json!({ "accepted": true })))
        }
        ("output", Method::GET) => {
            let cursor = query
                .get("cursor")
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.floor() as usize)
                .unwrap_or(0);
            manager
                .output(&id, &owner, cursor)
                .map(|body| ok_body(StatusCode::OK, body))
        }
        ("stream", Method::GET) => {
            let cursor = query
                .get("cursor")
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.floor() as usize)
                .unwrap_or(0);
            return Some(match manager.subscribe(&id, &owner, cursor) {
                Ok(receiver) => stream_response(receiver),
                Err(message) => error_body(&message),
            });
        }
        ("interrupt", Method::POST) => manager
            .interrupt(&id, &owner)
            .map(|_| ok_body(StatusCode::OK, json!({}))),
        ("resize", Method::POST) => {
            let body = json_body(req).await;
            let cols = as_number(body.get("cols"));
            let rows = as_number(body.get("rows"));
            manager
                .resize(&id, &owner, cols, rows)
                .map(|snapshot| ok_body(StatusCode::OK, snapshot))
        }
        ("", Method::DELETE) => manager
            .close(&id, &owner)
            .map(|_| ok_body(StatusCode::OK, json!({}))),
        _ => Err("method not allowed".to_string()),
    };

    Some(match result {
        Ok(response) => response,
        Err(message) if message == "method not allowed" => json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            &json!({ "ok": false, "error": "method not allowed" }),
        ),
        Err(message) => error_body(&message),
    })
}

fn stream_response(
    receiver: tokio::sync::mpsc::UnboundedReceiver<TerminalOutputEvent>,
) -> Response {
    let stream =
        futures_util::stream::unfold((receiver, false), |(mut receiver, done)| async move {
            if done {
                return None;
            }
            let event = receiver.recv().await?;
            let closed = event.closed;
            let mut line = serde_json::to_string(&event).unwrap_or_default();
            line.push('\n');
            Some((Ok::<_, std::io::Error>(line), (receiver, closed)))
        });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .expect("valid NDJSON stream")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_list_blocks_destructive_commands() {
        assert!(assert_allowed_command("rm -rf /").is_err());
        assert!(assert_allowed_command("shutdown -h now").is_err());
        assert!(assert_allowed_command("mkfs.ext4 /dev/sda1").is_err());
        assert!(assert_allowed_command("").is_err());
        assert!(assert_allowed_command("ls -la").is_ok());
    }

    #[test]
    fn error_status_matches_node() {
        assert_eq!(terminal_error_status("terminal session not found"), 404);
        assert_eq!(terminal_error_status("terminal session is closed"), 400);
        assert_eq!(terminal_error_status("boom"), 500);
    }

    #[test]
    fn cursors_count_utf16_units() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("你好"), 2);
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(char_index_at_utf16("a😀b", 1), 1);
        assert_eq!(char_index_at_utf16("a😀b", 3), 2);
    }

    #[test]
    fn dimensions_clamp() {
        assert_eq!(clamp_dimension(Some(0.0), 80, 2, 500), 2);
        assert_eq!(clamp_dimension(Some(9999.0), 80, 2, 500), 500);
        assert_eq!(clamp_dimension(None, 24, 1, 200), 24);
    }
}
