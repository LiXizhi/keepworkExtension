use crate::files::NativeFiles;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const GLOBAL_TERMINAL_CAP: usize = 4;
pub const MAX_INPUT_CHARS: usize = 64_000;
pub const OUTPUT_CHAR_CAP: usize = 120_000;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub id: String,
    pub output: String,
    pub cursor: usize,
    pub reset: bool,
    pub closed: bool,
    pub exit_code: Option<i32>,
}

struct SessionBuffer {
    buffer: String,
    base_cursor: usize,
    closed: bool,
    exit_code: Option<i32>,
    last_active: Instant,
}

impl SessionBuffer {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            base_cursor: 0,
            closed: false,
            exit_code: None,
            last_active: Instant::now(),
        }
    }

    fn append(&mut self, text: &str) {
        self.last_active = Instant::now();
        self.buffer.push_str(text);
        let char_count = self.buffer.chars().count();
        if char_count > OUTPUT_CHAR_CAP {
            let drop_chars = char_count - OUTPUT_CHAR_CAP;
            let byte_idx = self
                .buffer
                .char_indices()
                .nth(drop_chars)
                .map(|(idx, _)| idx)
                .unwrap_or(0);
            if byte_idx > 0 {
                self.buffer.drain(..byte_idx);
                self.base_cursor += drop_chars;
            }
        }
    }

    fn read_from(&self, requested_cursor: usize) -> (String, usize, bool) {
        let total_chars = self.buffer.chars().count();
        let end_cursor = self.base_cursor + total_chars;
        if requested_cursor < self.base_cursor {
            return (self.buffer.clone(), end_cursor, true);
        }
        let skip = requested_cursor.saturating_sub(self.base_cursor);
        if skip >= total_chars {
            return (String::new(), end_cursor, false);
        }
        let byte_idx = self
            .buffer
            .char_indices()
            .nth(skip)
            .map(|(idx, _)| idx)
            .unwrap_or(self.buffer.len());
        (self.buffer[byte_idx..].to_string(), end_cursor, false)
    }
}

struct SessionEntry {
    #[allow(dead_code)]
    id: String,
    owner: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    writer: Mutex<Option<File>>,
    #[cfg(unix)]
    master_fd: Option<i32>,
    child: Mutex<Child>,
    state: Arc<Mutex<SessionBuffer>>,
}

impl SessionEntry {
    fn write_input(&self, data: &str) -> Result<(), String> {
        if data.chars().count() > MAX_INPUT_CHARS {
            return Err("Terminal input exceeds maximum allowed length".to_string());
        }
        if let Ok(mut st) = self.state.lock() {
            st.last_active = Instant::now();
            if st.closed {
                return Err("Terminal session is closed".to_string());
            }
        }
        let mut guard = self.writer.lock().map_err(|_| "Lock poisoned".to_string())?;
        let Some(file) = guard.as_mut() else {
            return Err("Terminal input stream is closed".to_string());
        };
        file.write_all(data.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|e| format!("Failed to write to terminal: {e}"))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.clamp(20, 400);
        let rows = rows.clamp(5, 200);
        self.cols = cols;
        self.rows = rows;
        #[cfg(unix)]
        if let Some(fd) = self.master_fd {
            unsafe {
                let ws = libc::winsize {
                    ws_row: rows,
                    ws_col: cols,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                };
                let _ = libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
            }
        }
        Ok(())
    }

    fn terminate(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            *writer = None;
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut st) = self.state.lock() {
            st.closed = true;
        }
    }
}

pub fn sanitize_workspace_slot(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

pub struct TerminalSessionManager {
    fallback_workspaces_dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Mutex<SessionEntry>>>>,
}

impl TerminalSessionManager {
    pub fn new(fallback_workspaces_dir: PathBuf) -> Self {
        Self {
            fallback_workspaces_dir,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn cleanup_expired_locked(map: &mut HashMap<String, Arc<Mutex<SessionEntry>>>) {
        let mut to_remove = Vec::new();
        for (id, entry_arc) in map.iter() {
            if let Ok(entry) = entry_arc.lock() {
                if let Ok(mut child) = entry.child.lock() {
                    if let Ok(Some(status)) = child.try_wait() {
                        if let Ok(mut st) = entry.state.lock() {
                            st.closed = true;
                            st.exit_code = status.code();
                        }
                    }
                }
                if let Ok(st) = entry.state.lock() {
                    if st.last_active.elapsed() > IDLE_TIMEOUT {
                        entry.terminate();
                        to_remove.push(id.clone());
                    }
                }
            }
        }
        for id in to_remove {
            map.remove(&id);
        }
    }

    pub fn resolve_cwd(
        &self,
        files: &NativeFiles,
        args: &Value,
    ) -> Result<PathBuf, String> {
        let root_id = args
            .get("rootId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let rel = args
            .get("cwd")
            .or_else(|| args.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if !root_id.is_empty() {
            let (_grant, resolved, _rel_slash) = files.resolve(root_id, rel, false, false)?;
            let meta = fs::metadata(&resolved)
                .map_err(|_| "Terminal working directory does not exist".to_string())?;
            if !meta.is_dir() {
                return Err("Terminal working directory is not a folder".to_string());
            }
            return Ok(resolved);
        }

        let slot = args
            .get("workspace")
            .or_else(|| args.get("slot"))
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let dir = self
            .fallback_workspaces_dir
            .join(sanitize_workspace_slot(slot));
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create fallback terminal workspace: {e}"))?;
        Ok(dir)
    }

    fn spawn_session_entry(
        id: String,
        owner: String,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        custom_shell: Option<&str>,
    ) -> Result<SessionEntry, String> {
        let state = Arc::new(Mutex::new(SessionBuffer::new()));

        #[cfg(unix)]
        {
            use std::os::unix::io::FromRawFd;
            use std::os::unix::process::CommandExt;

            let mut master_fd: libc::c_int = -1;
            let mut slave_fd: libc::c_int = -1;
            let mut ws = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            let rc = unsafe {
                libc::openpty(
                    &mut master_fd,
                    &mut slave_fd,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut ws,
                )
            };
            if rc != 0 || master_fd < 0 || slave_fd < 0 {
                return Err("Failed to allocate pseudo-terminal (openpty)".to_string());
            }

            let shell = custom_shell
                .map(|s| s.to_string())
                .or_else(|| std::env::var("SHELL").ok())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "/bin/zsh".to_string());

            let slave_in = unsafe { Stdio::from_raw_fd(slave_fd) };
            let slave_out_fd = unsafe { libc::dup(slave_fd) };
            let slave_err_fd = unsafe { libc::dup(slave_fd) };
            if slave_out_fd < 0 || slave_err_fd < 0 {
                unsafe {
                    libc::close(master_fd);
                    if slave_out_fd >= 0 {
                        libc::close(slave_out_fd);
                    }
                    if slave_err_fd >= 0 {
                        libc::close(slave_err_fd);
                    }
                }
                return Err("Failed to duplicate PTY slave descriptors".to_string());
            }
            let slave_out = unsafe { Stdio::from_raw_fd(slave_out_fd) };
            let slave_err = unsafe { Stdio::from_raw_fd(slave_err_fd) };

            let mut cmd = Command::new(&shell);
            cmd.current_dir(&cwd)
                .env("TERM", "xterm-256color")
                .env("COLORTERM", "truecolor")
                .stdin(slave_in)
                .stdout(slave_out)
                .stderr(slave_err);

            unsafe {
                cmd.pre_exec(move || {
                    let _ = libc::setsid();
                    let _ = libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                    Ok(())
                });
            }

            let child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    unsafe {
                        libc::close(master_fd);
                    }
                    return Err(format!("Failed to spawn shell {shell}: {e}"));
                }
            };

            let reader_fd = unsafe { libc::dup(master_fd) };
            let writer_file = unsafe { File::from_raw_fd(master_fd) };
            if reader_fd >= 0 {
                let reader_state = Arc::clone(&state);
                thread::spawn(move || {
                    let mut reader = unsafe { File::from_raw_fd(reader_fd) };
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let text = String::from_utf8_lossy(&buf[..n]);
                                if let Ok(mut st) = reader_state.lock() {
                                    st.append(&text);
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                    if let Ok(mut st) = reader_state.lock() {
                        st.closed = true;
                    }
                });
            }

            Ok(SessionEntry {
                id,
                owner,
                cwd,
                cols,
                rows,
                writer: Mutex::new(Some(writer_file)),
                master_fd: Some(master_fd),
                child: Mutex::new(child),
                state,
            })
        }

        #[cfg(not(unix))]
        {
            let shell = custom_shell
                .map(|s| s.to_string())
                .unwrap_or_else(|| "powershell.exe".to_string());
            let mut cmd = Command::new(&shell);
            if shell.to_lowercase().contains("powershell") {
                cmd.args(["-NoLogo", "-NoProfile"]);
            }
            cmd.current_dir(&cwd)
                .env("TERM", "xterm-256color")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn shell {shell}: {e}"))?;

            let stdin = child.stdin.take();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            let (pipe_reader, pipe_writer) = std::io::pipe()
                .map_err(|e| format!("Failed to create input pipe: {e}"))?;
            if let Some(mut child_in) = stdin {
                let mut pr = pipe_reader;
                thread::spawn(move || {
                    let _ = std::io::copy(&mut pr, &mut child_in);
                });
            }

            if let Some(mut out) = stdout {
                let st_clone = Arc::clone(&state);
                thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = out.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut st) = st_clone.lock() {
                            st.append(&text);
                        }
                    }
                    if let Ok(mut st) = st_clone.lock() {
                        st.closed = true;
                    }
                });
            }

            if let Some(mut err) = stderr {
                let st_clone = Arc::clone(&state);
                thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = err.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut st) = st_clone.lock() {
                            st.append(&text);
                        }
                    }
                });
            }

            // Convert PipeWriter into File viaOwnedHandle
            use std::os::windows::io::{FromRawHandle, IntoRawHandle};
            let writer_file = unsafe { File::from_raw_handle(pipe_writer.into_raw_handle()) };

            Ok(SessionEntry {
                id,
                owner,
                cwd,
                cols,
                rows,
                writer: Mutex::new(Some(writer_file)),
                child: Mutex::new(child),
                state,
            })
        }
    }

    pub fn handle(
        &self,
        owner: &str,
        files: &NativeFiles,
        op: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let mut map = self
            .sessions
            .lock()
            .map_err(|_| "Terminal lock poisoned".to_string())?;
        Self::cleanup_expired_locked(&mut map);

        match op {
            "create" => {
                let active_count = map
                    .values()
                    .filter(|entry| {
                        entry
                            .lock()
                            .ok()
                            .and_then(|e| e.state.lock().ok().map(|s| !s.closed))
                            .unwrap_or(false)
                    })
                    .count();
                if active_count >= GLOBAL_TERMINAL_CAP {
                    return Err(format!(
                        "Maximum concurrent terminal sessions reached ({GLOBAL_TERMINAL_CAP})"
                    ));
                }
                let cwd = self.resolve_cwd(files, args)?;
                let cols = args
                    .get("cols")
                    .and_then(|v| v.as_u64())
                    .map(|n| (n as u16).clamp(20, 400))
                    .unwrap_or(80);
                let rows = args
                    .get("rows")
                    .and_then(|v| v.as_u64())
                    .map(|n| (n as u16).clamp(5, 200))
                    .unwrap_or(24);
                let custom_shell = args.get("shell").and_then(|v| v.as_str());
                let id = format!("desktop:{}", Uuid::new_v4());
                let entry = Self::spawn_session_entry(
                    id.clone(),
                    owner.to_string(),
                    cwd.clone(),
                    cols,
                    rows,
                    custom_shell,
                )?;
                map.insert(id.clone(), Arc::new(Mutex::new(entry)));
                Ok(json!({
                    "id": id,
                    "cwd": cwd.to_string_lossy(),
                    "cols": cols,
                    "rows": rows,
                    "cursor": 0,
                }))
            }
            "write" | "input" => {
                let id = args
                    .get("id")
                    .or_else(|| args.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let data = args
                    .get("data")
                    .or_else(|| args.get("input"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let entry_arc = map
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "Terminal session not found".to_string())?;
                let entry = entry_arc.lock().map_err(|_| "Lock poisoned".to_string())?;
                if entry.owner != owner {
                    return Err("Unauthorized terminal session owner".to_string());
                }
                entry.write_input(data)?;
                Ok(json!({ "ok": true, "id": id }))
            }
            "resize" => {
                let id = args
                    .get("id")
                    .or_else(|| args.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let cols = args
                    .get("cols")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(80) as u16;
                let rows = args
                    .get("rows")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(24) as u16;
                let entry_arc = map
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "Terminal session not found".to_string())?;
                let mut entry = entry_arc.lock().map_err(|_| "Lock poisoned".to_string())?;
                if entry.owner != owner {
                    return Err("Unauthorized terminal session owner".to_string());
                }
                entry.resize(cols, rows)?;
                Ok(json!({ "ok": true, "id": id, "cols": entry.cols, "rows": entry.rows }))
            }
            "output" | "read" => {
                let id = args
                    .get("id")
                    .or_else(|| args.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let cursor = args
                    .get("cursor")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let entry_arc = map
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "Terminal session not found".to_string())?;
                let entry = entry_arc.lock().map_err(|_| "Lock poisoned".to_string())?;
                if entry.owner != owner {
                    return Err("Unauthorized terminal session owner".to_string());
                }
                if let Ok(mut child) = entry.child.lock() {
                    if let Ok(Some(status)) = child.try_wait() {
                        if let Ok(mut st) = entry.state.lock() {
                            st.closed = true;
                            st.exit_code = status.code();
                        }
                    }
                }
                let st = entry.state.lock().map_err(|_| "Lock poisoned".to_string())?;
                let (output, next_cursor, reset) = st.read_from(cursor);
                Ok(json!({
                    "id": id,
                    "output": output,
                    "cursor": next_cursor,
                    "reset": reset,
                    "closed": st.closed,
                    "exitCode": st.exit_code,
                    "cwd": entry.cwd.to_string_lossy(),
                }))
            }
            "interrupt" => {
                let id = args
                    .get("id")
                    .or_else(|| args.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let entry_arc = map
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "Terminal session not found".to_string())?;
                let entry = entry_arc.lock().map_err(|_| "Lock poisoned".to_string())?;
                if entry.owner != owner {
                    return Err("Unauthorized terminal session owner".to_string());
                }
                entry.write_input("\x03")?;
                Ok(json!({ "ok": true, "id": id }))
            }
            "close" => {
                let id = args
                    .get("id")
                    .or_else(|| args.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(entry_arc) = map.get(id) {
                    let entry = entry_arc.lock().map_err(|_| "Lock poisoned".to_string())?;
                    if entry.owner != owner {
                        return Err("Unauthorized terminal session owner".to_string());
                    }
                    entry.terminate();
                }
                map.remove(id);
                Ok(json!({ "ok": true, "closed": true, "id": id }))
            }
            "close-all" => {
                self.close_owner_locked(&mut map, owner);
                Ok(json!({ "ok": true }))
            }
            _ => Err(format!("Unsupported terminal operation: {op}")),
        }
    }

    fn close_owner_locked(
        &self,
        map: &mut HashMap<String, Arc<Mutex<SessionEntry>>>,
        owner: &str,
    ) {
        let ids: Vec<String> = map
            .iter()
            .filter_map(|(id, arc)| {
                let ok = arc.lock().map(|e| e.owner == owner).unwrap_or(false);
                if ok {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in ids {
            if let Some(arc) = map.remove(&id) {
                if let Ok(entry) = arc.lock() {
                    entry.terminate();
                }
            }
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, arc) in map.drain() {
                if let Ok(entry) = arc.lock() {
                    entry.terminate();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawns_pty_executes_command_and_streams_cursor_output() {
        let root = std::env::temp_dir().join(format!("aichat-rust-pty-{}", Uuid::new_v4()));
        let files = NativeFiles::new(root.join("grants.json"));
        let manager = TerminalSessionManager::new(root.join("workspaces"));

        let created = manager
            .handle(
                "desktop:main",
                &files,
                "create",
                &json!({ "workspace": "session-1", "cols": 80, "rows": 24 }),
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("desktop:"));

        // Owner isolation check
        assert!(manager
            .handle("other:window", &files, "output", &json!({ "id": id }))
            .is_err());

        manager
            .handle(
                "desktop:main",
                &files,
                "write",
                &json!({ "id": id, "data": "echo KEEPWORK_PTY_OK\n" }),
            )
            .unwrap();

        let mut combined = String::new();
        let mut cursor = 0usize;
        for _ in 0..40 {
            let out = manager
                .handle(
                    "desktop:main",
                    &files,
                    "output",
                    &json!({ "id": id, "cursor": cursor }),
                )
                .unwrap();
            cursor = out["cursor"].as_u64().unwrap() as usize;
            combined.push_str(out["output"].as_str().unwrap_or(""));
            if combined.contains("KEEPWORK_PTY_OK") {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            combined.contains("KEEPWORK_PTY_OK"),
            "Expected PTY output to contain KEEPWORK_PTY_OK, got: {combined}"
        );

        manager
            .handle("desktop:main", &files, "close", &json!({ "id": id }))
            .unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
