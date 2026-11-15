//! PTY-backed terminal sessions (mirrors `src/core/terminalSessions.ts`).
//!
//! Same routes, owner rules, cursor replay and output cap as the Node daemon;
//! Native adapters use portable-pty on current systems and WinPTY on Win7/8.

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

use super::native::{spawn_shell, ChildControl, PtyControl, PtySize};

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
    master: Mutex<Option<Box<dyn PtyControl>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Option<Box<dyn ChildControl>>>,
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
        let mut listeners = self.listeners.lock().expect("terminal listeners");
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        self.broadcast(text, false, &mut listeners);
    }

    fn broadcast(
        &self,
        text: &str,
        closed: bool,
        listeners: &mut Vec<tokio::sync::mpsc::UnboundedSender<TerminalOutputEvent>>,
    ) {
        let event = {
            let mut output = self.output.lock().expect("terminal output");
            output.push_str(text);
            // Cursors count UTF-16 code units, exactly like `string.length` in
            // the Node daemon, so emoji advance by two in both engines.
            let removed = trim_output(&mut output);
            let base =
                self.base_cursor.fetch_add(removed as u64, Ordering::SeqCst) as usize + removed;
            TerminalOutputEvent {
                cursor: base + utf16_len(&output),
                reset: false,
                output: text.to_string(),
                closed,
            }
        };
        listeners.retain(|listener| listener.send(event.clone()).is_ok());
    }

    fn finish(&self) {
        let mut listeners = self.listeners.lock().expect("terminal listeners");
        if !self.closed.swap(true, Ordering::SeqCst) {
            // Neither EOF nor an explicit close supplies a verified exit code.
            self.broadcast("\r\n[terminal closed]\r\n", true, &mut listeners);
        }
        listeners.clear();
    }

    fn terminate(&self) {
        self.finish();
        let child = self.child.lock().expect("terminal child").take();
        // A reader holds an Arc to this session. Release native ownership now
        // instead of waiting for that Arc to drop after EOF. In particular,
        // ConPTY may keep output open until its master is closed. No locks are
        // held while killing/dropping; the reader keeps draining late output.
        if let Some(mut child) = child {
            let _ = child.kill();
        }
        // Closing the master also releases a pipe write that is blocked on a
        // child which stopped consuming input. Never wait for the writer lock
        // before shutting down that native endpoint.
        let master = self.master.lock().expect("terminal master").take();
        drop(master);
        let writer = self.writer.lock().expect("terminal writer").take();
        drop(writer);
    }

    fn output_since(&self, cursor: usize) -> Value {
        self.touched_at.store(now_millis(), Ordering::SeqCst);
        let output = self.output.lock().expect("terminal output");
        let base = self.base_cursor.load(Ordering::SeqCst) as usize;
        let reset = cursor < base;
        let start = if reset {
            0
        } else {
            byte_index_at_utf16(&output, cursor.saturating_sub(base))
        };
        let text = output[start..].to_string();
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

/// Converts a UTF-16 offset into a UTF-8 byte index, clamping to a char
/// boundary the way a browser client would when it replays from a cursor.
fn byte_index_at_utf16(value: &str, offset: usize) -> usize {
    let mut units = 0usize;
    for (index, ch) in value.char_indices() {
        if units >= offset {
            return index;
        }
        units += ch.len_utf16();
    }
    value.len()
}

fn trim_output(output: &mut String) -> usize {
    let overflow = utf16_len(output).saturating_sub(OUTPUT_CHAR_CAP);
    let cut = byte_index_at_utf16(output, overflow);
    let removed = utf16_len(&output[..cut]);
    output.drain(..cut);
    removed
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

// New-Object also works in Windows 7's inbox PowerShell 2.0. The ::new syntax
// and PSDefaultParameterValues were introduced in later PowerShell versions.
const POWERSHELL_UTF8_INIT: &str = "$utf8 = New-Object System.Text.UTF8Encoding; [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; if ($PSDefaultParameterValues) { $PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'; $PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8' }";

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
        // Hold the reservation until insertion; concurrent HTTP creates must
        // not each pass the same pre-spawn count and exceed the global cap.
        let mut sessions = self.sessions.lock().expect("terminals");
        if sessions.len() >= GLOBAL_TERMINAL_CAP {
            return Err(format!(
                "terminal session limit reached ({GLOBAL_TERMINAL_CAP})"
            ));
        }
        let raw_cwd = cwd.unwrap_or(".").trim();
        let absolute = crate::paths::is_abs_disk_path(raw_cwd);
        if !absolute
            && raw_cwd
                .replace('\\', "/")
                .split('/')
                .any(|part| part == "..")
        {
            return Err("Path escapes workspace root".into());
        }
        let resolved_cwd = crate::paths::resolve_workdir(&root.to_string_lossy(), cwd)
            .map_err(|error| error.message)?;
        if !absolute {
            // A missing leaf cannot be canonicalized. Verify the closest
            // existing ancestor before creating it so a symlink/junction
            // followed by a missing child cannot escape the workspace.
            let base = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
            let ancestor = resolved_cwd
                .ancestors()
                .find(|path| path.exists())
                .ok_or("terminal working directory has no existing ancestor")?;
            let ancestor = std::fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
            if !ancestor.starts_with(&base) {
                return Err("Path escapes workspace root".into());
            }
        }
        let cwd_text = resolved_cwd.to_string_lossy().into_owned();
        if !resolved_cwd.exists() {
            std::fs::create_dir_all(&resolved_cwd).map_err(|error| error.to_string())?;
        }
        let cols = clamp_dimension(cols_raw, DEFAULT_COLS, MIN_COLS, MAX_COLS);
        let rows = clamp_dimension(rows_raw, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
        let (shell, args) = shell_spec();
        let opened = spawn_shell(&shell, &args, &resolved_cwd, PtySize { rows, cols })?;
        let mut reader = opened.reader;

        let now = now_millis();
        let session = Arc::new(TerminalSession {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner.to_string(),
            cwd: cwd_text,
            master: Mutex::new(Some(opened.master)),
            writer: Mutex::new(Some(opened.writer)),
            child: Mutex::new(Some(opened.child)),
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
        sessions.insert(session.id.clone(), Arc::clone(&session));
        drop(sessions);

        let reader_session = Arc::clone(&session);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let mut text = String::with_capacity(read * 3 + 4);
                        let _ = decoder.decode_to_string(&buffer[..read], &mut text, false);
                        reader_session.append(&text);
                    }
                    Err(_) => break,
                }
            }
            let mut final_text = String::with_capacity(4);
            let _ = decoder.decode_to_string(&[], &mut final_text, true);
            reader_session.append(&final_text);
            drop(reader);
            reader_session.terminate();
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
            .as_mut()
            .ok_or("terminal session is closed")?
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
            .as_ref()
            .ok_or("terminal session is closed")?
            .resize(PtySize {
                rows: next_rows,
                cols: next_cols,
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
        let mut listeners = session.listeners.lock().expect("terminal listeners");
        let initial = session.output_since(cursor);
        let event = TerminalOutputEvent {
            cursor: initial["cursor"].as_u64().unwrap_or(0) as usize,
            reset: initial["reset"].as_bool().unwrap_or(false),
            output: initial["output"].as_str().unwrap_or("").to_string(),
            closed: initial["closed"].as_bool().unwrap_or(false),
        };
        // Replay first, then live output, through one ordered channel.
        let _ = sender.send(event);
        listeners.retain(|listener| !listener.is_closed());
        if !session.closed.load(Ordering::SeqCst) {
            listeners.push(sender);
        }
        Ok(receiver)
    }

    pub fn interrupt(&self, id: &str, owner: &str) -> Result<(), String> {
        self.write(id, owner, "\x03")
    }

    pub fn close(&self, id: &str, owner: &str) -> Result<(), String> {
        let session = self.get(id, owner)?;
        self.sessions.lock().expect("terminals").remove(id);
        session.terminate();
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
        let removed: Vec<_> = stale
            .into_iter()
            .filter_map(|id| sessions.remove(&id))
            .collect();
        drop(sessions);
        for session in removed {
            session.terminate();
        }
    }

    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().expect("terminals"));
        for session in sessions.into_values() {
            session.terminate();
        }
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
        "escapes workspace",
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
    if path == "/terminal/sessions" || path.starts_with("/terminal/sessions/") {
        let terminal = super::health();
        if !terminal.ready {
            let reason = terminal
                .reason
                .unwrap_or("Terminal backend is initializing; retry shortly.");
            return Some(json_response(
                StatusCode::NOT_IMPLEMENTED,
                &json!({
                    "ok": false, "code": "UNSUPPORTED_FEATURE", "feature": "pty-session-v1",
                    "terminalStatus": terminal.status, "terminalReason": reason,
                    "error": reason,
                }),
            ));
        }
    }
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
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Barrier, Condvar, Weak};

    #[cfg(all(windows, not(any(target_vendor = "win7", feature = "win7-compat"))))]
    #[test]
    #[ignore = "manual Windows PTY differential diagnostic; not release acceptance"]
    fn windows_pty_startup_differential_diagnostic() {
        super::super::native::diagnose_windows_startup(shell_spec(), POWERSHELL_UTF8_INIT);
    }

    struct NativeOwnership {
        manager: Weak<TerminalManager>,
        master_drops: AtomicUsize,
        writer_drops: AtomicUsize,
        child_drops: AtomicUsize,
        child_kills: AtomicUsize,
        writes: AtomicUsize,
        resizes: AtomicUsize,
        check_manager_lock: AtomicBool,
        teardown_held_manager_lock: AtomicBool,
    }

    impl NativeOwnership {
        fn observe_teardown(&self) {
            if !self.check_manager_lock.load(Ordering::SeqCst) {
                return;
            }
            if let Some(manager) = self.manager.upgrade() {
                if manager.sessions.try_lock().is_err() {
                    self.teardown_held_manager_lock
                        .store(true, Ordering::SeqCst);
                }
            }
        }

        fn assert_counts(&self, expected: usize) {
            assert_eq!(self.master_drops.load(Ordering::SeqCst), expected);
            assert_eq!(self.writer_drops.load(Ordering::SeqCst), expected);
            assert_eq!(self.child_drops.load(Ordering::SeqCst), expected);
            assert_eq!(self.child_kills.load(Ordering::SeqCst), expected);
            assert!(
                !self.teardown_held_manager_lock.load(Ordering::SeqCst),
                "native teardown must not hold the manager's session-map lock"
            );
        }
    }

    struct HeldMaster(Arc<NativeOwnership>);
    impl PtyControl for HeldMaster {
        fn resize(&self, _size: PtySize) -> Result<(), String> {
            self.0.resizes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    impl Drop for HeldMaster {
        fn drop(&mut self) {
            self.0.observe_teardown();
            self.0.master_drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct HeldWriter(Arc<NativeOwnership>);
    impl Write for HeldWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.writes.fetch_add(1, Ordering::SeqCst);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for HeldWriter {
        fn drop(&mut self) {
            self.0.observe_teardown();
            self.0.writer_drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct HeldChild(Arc<NativeOwnership>);
    impl ChildControl for HeldChild {
        fn kill(&mut self) -> Result<(), String> {
            self.0.observe_teardown();
            self.0.child_kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    impl Drop for HeldChild {
        fn drop(&mut self) {
            self.0.observe_teardown();
            self.0.child_drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct BlockedInput {
        released: Mutex<bool>,
        wake: Condvar,
        kills_when_master_closed: AtomicUsize,
    }
    impl BlockedInput {
        fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.wake.notify_all();
        }
    }

    struct BlockingMaster {
        master: HeldMaster,
        input: Arc<BlockedInput>,
    }
    impl PtyControl for BlockingMaster {
        fn resize(&self, size: PtySize) -> Result<(), String> {
            self.master.resize(size)
        }
    }
    impl Drop for BlockingMaster {
        fn drop(&mut self) {
            self.input.kills_when_master_closed.store(
                self.master.0.child_kills.load(Ordering::SeqCst),
                Ordering::SeqCst,
            );
            // Killing a child need not unblock a ConPTY input pipe. This fake
            // writer remains blocked until ownership of its master is released.
            self.input.release();
        }
    }

    struct BlockingWriter {
        writer: HeldWriter,
        input: Arc<BlockedInput>,
        entered: std::sync::mpsc::Sender<()>,
    }
    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let mut released = self.input.released.lock().unwrap();
            while !*released {
                released = self.input.wake.wait(released).unwrap();
            }
            self.writer.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.writer.flush()
        }
    }

    const TEST_OWNER: &str = "https://keepwork.com";
    const CLOSED_TEXT: &str = "\r\n[terminal closed]\r\n";
    type OutputReceiver = tokio::sync::mpsc::UnboundedReceiver<TerminalOutputEvent>;

    fn held_reader_session(
        manager: &Arc<TerminalManager>,
        id: &str,
    ) -> (Arc<TerminalSession>, Arc<NativeOwnership>) {
        held_reader_session_with_blocked_input(manager, id, None)
    }

    fn held_reader_session_with_blocked_input(
        manager: &Arc<TerminalManager>,
        id: &str,
        blocked: Option<(Arc<BlockedInput>, std::sync::mpsc::Sender<()>)>,
    ) -> (Arc<TerminalSession>, Arc<NativeOwnership>) {
        let native = Arc::new(NativeOwnership {
            manager: Arc::downgrade(manager),
            master_drops: AtomicUsize::new(0),
            writer_drops: AtomicUsize::new(0),
            child_drops: AtomicUsize::new(0),
            child_kills: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            resizes: AtomicUsize::new(0),
            check_manager_lock: AtomicBool::new(true),
            teardown_held_manager_lock: AtomicBool::new(false),
        });
        let master: Box<dyn PtyControl> = if let Some((input, _)) = &blocked {
            Box::new(BlockingMaster {
                master: HeldMaster(Arc::clone(&native)),
                input: Arc::clone(input),
            })
        } else {
            Box::new(HeldMaster(Arc::clone(&native)))
        };
        let writer: Box<dyn Write + Send> = if let Some((input, entered)) = blocked {
            Box::new(BlockingWriter {
                writer: HeldWriter(Arc::clone(&native)),
                input,
                entered,
            })
        } else {
            Box::new(HeldWriter(Arc::clone(&native)))
        };
        let now = now_millis();
        let reader = Arc::new(TerminalSession {
            id: id.into(),
            owner: TEST_OWNER.into(),
            cwd: "isolated fixture".into(),
            master: Mutex::new(Some(master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(Box::new(HeldChild(Arc::clone(&native))))),
            output: Mutex::new(String::new()),
            base_cursor: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            created_at: now,
            touched_at: AtomicI64::new(now),
            cols: AtomicU64::new(80),
            rows: AtomicU64::new(24),
            listeners: Mutex::new(Vec::new()),
        });
        manager
            .sessions
            .lock()
            .unwrap()
            .insert(id.into(), Arc::clone(&reader));
        // This Arc stands in for a blocked native reader. It stays alive and
        // never supplies EOF; removing the map entry must still release every
        // native owner and finish an already-subscribed output stream.
        (reader, native)
    }

    fn assert_closed_stream(receiver: &mut OutputReceiver, prefix: &str) {
        let mut events = Vec::new();
        loop {
            match receiver.try_recv() {
                Ok(event) => events.push(event),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    panic!("the final event must release all output channel senders")
                }
            }
        }
        assert_eq!(events.iter().filter(|event| event.closed).count(), 1);
        assert!(events.last().unwrap().closed);
        let mut combined = String::new();
        for event in events {
            combined.push_str(&event.output);
            assert_eq!(event.cursor, combined.encode_utf16().count());
            assert!(!event.reset);
        }
        assert_eq!(combined, format!("{prefix}{CLOSED_TEXT}"));
    }

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
        assert_eq!(byte_index_at_utf16("a😀b", 1), 1);
        assert_eq!(byte_index_at_utf16("a😀b", 3), 5);
    }

    #[test]
    fn unicode_output_cap_preserves_boundaries_and_actual_utf16_cursor() {
        let mut text = format!("😀{}", "中".repeat(OUTPUT_CHAR_CAP - 1));
        assert_eq!(trim_output(&mut text), 2);
        assert_eq!(text, "中".repeat(OUTPUT_CHAR_CAP - 1));
        assert_eq!(byte_index_at_utf16("中文😀abc", 4), "中文😀".len());
    }

    #[test]
    fn dimensions_clamp() {
        assert_eq!(clamp_dimension(Some(0.0), 80, 2, 500), 2);
        assert_eq!(clamp_dimension(Some(9999.0), 80, 2, 500), 500);
        assert_eq!(clamp_dimension(None, 24, 1, 200), 24);
    }

    #[test]
    fn close_releases_native_owners_before_reader_eof_and_preserves_foreign_ownership() {
        let manager = Arc::new(TerminalManager::default());
        let (reader, native) = held_reader_session(&manager, "owned");
        let mut receiver = manager.subscribe("owned", TEST_OWNER, 0).unwrap();
        reader.append("中文😀");
        assert!(Arc::strong_count(&reader) > 1);

        assert!(manager.close("owned", "http://localhost:3001").is_err());
        native.assert_counts(0);
        assert!(!reader.closed.load(Ordering::SeqCst));
        assert!(manager.get("owned", TEST_OWNER).is_ok());

        manager.close("owned", TEST_OWNER).unwrap();
        native.assert_counts(1);
        assert!(manager.get("owned", TEST_OWNER).is_err());
        assert_closed_stream(&mut receiver, "中文😀");
        let finished = reader.output_since(0);
        reader.append("late reader bytes must not follow closure");
        reader.finish();
        reader.terminate();
        assert_eq!(reader.output_since(0), finished);
        native.assert_counts(1);
    }

    #[test]
    fn idle_prune_releases_stale_native_owners_and_keeps_a_fresh_terminal_usable() {
        let manager = Arc::new(TerminalManager::default());
        let (stale_reader, stale_native) = held_reader_session(&manager, "stale");
        let (fresh_reader, fresh_native) = held_reader_session(&manager, "fresh");
        let mut stale_stream = manager.subscribe("stale", TEST_OWNER, 0).unwrap();
        let mut fresh_stream = manager.subscribe("fresh", TEST_OWNER, 0).unwrap();
        stale_reader.append("过期😀");
        stale_reader
            .touched_at
            .store(now_millis() - TERMINAL_IDLE_MS - 1_000, Ordering::SeqCst);

        manager.prune();
        stale_native.assert_counts(1);
        fresh_native.assert_counts(0);
        assert!(manager.get("stale", TEST_OWNER).is_err());
        assert_closed_stream(&mut stale_stream, "过期😀");
        manager.write("fresh", TEST_OWNER, "still usable").unwrap();
        manager
            .resize("fresh", TEST_OWNER, Some(101.0), Some(31.0))
            .unwrap();
        assert_eq!(fresh_native.writes.load(Ordering::SeqCst), 1);
        assert_eq!(fresh_native.resizes.load(Ordering::SeqCst), 1);
        assert!(!fresh_reader.closed.load(Ordering::SeqCst));

        manager.close_all();
        fresh_native.assert_counts(1);
        stale_native.assert_counts(1);
        assert_closed_stream(&mut fresh_stream, "");
    }

    #[test]
    fn close_all_releases_every_native_owner_while_all_reader_arcs_remain_alive() {
        let manager = Arc::new(TerminalManager::default());
        let sessions: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|id| {
                let (reader, native) = held_reader_session(&manager, id);
                let stream = manager.subscribe(id, TEST_OWNER, 0).unwrap();
                reader.append(id);
                (reader, native, stream, id)
            })
            .collect();

        manager.close_all();
        manager.close_all();
        assert!(manager.sessions.lock().unwrap().is_empty());
        for (reader, native, mut stream, prefix) in sessions {
            native.assert_counts(1);
            assert_closed_stream(&mut stream, prefix);
            reader.append("late output");
            reader.terminate();
            native.assert_counts(1);
        }
    }

    #[test]
    fn eof_and_explicit_termination_share_one_final_event_and_reject_late_output() {
        let manager = Arc::new(TerminalManager::default());
        let (reader, native) = held_reader_session(&manager, "eof-race");
        let mut stream = manager.subscribe("eof-race", TEST_OWNER, 0).unwrap();
        reader.append("先前😀");
        let barrier = Arc::new(Barrier::new(3));
        std::thread::scope(|scope| {
            for eof in [true, false] {
                let reader = Arc::clone(&reader);
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    if eof {
                        reader.finish();
                        reader.append("late EOF decoder tail");
                    } else {
                        reader.terminate();
                    }
                });
            }
            barrier.wait();
        });
        native.assert_counts(1);
        assert_closed_stream(&mut stream, "先前😀");
        assert!(manager.write("eof-race", TEST_OWNER, "late input").is_err());
        assert!(manager
            .resize("eof-race", TEST_OWNER, Some(90.0), Some(25.0))
            .is_err());

        // A subscriber arriving after native EOF receives one closed replay
        // and no sender remains waiting for another reader callback.
        let mut replay = manager.subscribe("eof-race", TEST_OWNER, 0).unwrap();
        assert_closed_stream(&mut replay, "先前😀");
        assert!(reader.listeners.lock().unwrap().is_empty());
        manager.close("eof-race", TEST_OWNER).unwrap();
        native.assert_counts(1);
    }

    #[test]
    fn concurrent_subscription_and_close_cannot_leave_an_open_output_channel() {
        for _ in 0..16 {
            let manager = Arc::new(TerminalManager::default());
            let (reader, native) = held_reader_session(&manager, "subscribe-race");
            // The concurrent subscriber may briefly hold the map lock on a
            // different thread. Sequential teardown tests check lock ownership;
            // this race checks that every possible subscription still closes.
            native.check_manager_lock.store(false, Ordering::SeqCst);
            reader.append("回放😀");
            let barrier = Arc::new(Barrier::new(2));
            let subscriber_manager = Arc::clone(&manager);
            let subscriber_barrier = Arc::clone(&barrier);
            let subscriber = std::thread::spawn(move || {
                subscriber_barrier.wait();
                subscriber_manager.subscribe("subscribe-race", TEST_OWNER, 0)
            });
            barrier.wait();
            manager.close("subscribe-race", TEST_OWNER).unwrap();
            match subscriber.join().unwrap() {
                Ok(mut stream) => assert_closed_stream(&mut stream, "回放😀"),
                Err(error) => assert_eq!(error, "terminal session not found"),
            }
            native.assert_counts(1);
            assert!(reader.listeners.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn close_releases_the_master_before_waiting_for_a_blocked_input_writer() {
        let manager = Arc::new(TerminalManager::default());
        let input = Arc::new(BlockedInput::default());
        let (entered, entered_receiver) = std::sync::mpsc::channel();
        let (reader, native) = held_reader_session_with_blocked_input(
            &manager,
            "blocked-input",
            Some((Arc::clone(&input), entered)),
        );
        let mut stream = manager.subscribe("blocked-input", TEST_OWNER, 0).unwrap();
        reader.append("阻塞😀");
        let writing_manager = Arc::clone(&manager);
        let writing = std::thread::spawn(move || {
            writing_manager.write(
                "blocked-input",
                TEST_OWNER,
                "input waiting for the native pipe",
            )
        });
        let entered = entered_receiver.recv_timeout(std::time::Duration::from_secs(2));
        if entered.is_err() {
            input.release();
            writing.join().unwrap().unwrap();
            panic!("the fake input must be blocked before closing its terminal");
        }
        let closing_manager = Arc::clone(&manager);
        let (closed, closed_receiver) = std::sync::mpsc::channel();
        let closing = std::thread::spawn(move || {
            let _ = closed.send(closing_manager.close("blocked-input", TEST_OWNER));
        });
        let result = closed_receiver.recv_timeout(std::time::Duration::from_secs(2));
        // A failing implementation must not leave a stuck test process. Only
        // after recording failure may the harness release the blocked write.
        if result.is_err() {
            input.release();
        }
        writing.join().unwrap().unwrap();
        closing.join().unwrap();
        result
            .expect("close must release the native master before waiting for its writer lock")
            .unwrap();
        assert_eq!(input.kills_when_master_closed.load(Ordering::SeqCst), 1);
        native.assert_counts(1);
        assert_closed_stream(&mut stream, "阻塞😀");
    }
}
