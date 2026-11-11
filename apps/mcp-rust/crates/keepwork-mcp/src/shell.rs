//! `run_terminal` (mirrors `src/core/terminal.ts`).
//!
//! Deny-list, cwd resolution, global concurrency cap, per-session serialisation
//! and output cap are identical; the child process is spawned with `sh -c` /
//! `cmd.exe /d /s /c` instead of Node's `shell: true`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};

use crate::messaging::shell_child_path;
use crate::paths;
use crate::terminal::{assert_allowed_command, GLOBAL_TERMINAL_CAP, OUTPUT_CHAR_CAP};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug)]
pub struct TerminalResult {
    pub ok: bool,
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

impl TerminalResult {
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "command": self.command,
            "cwd": self.cwd,
            "exitCode": self.exit_code,
            "signal": self.signal,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timedOut": self.timed_out,
            "truncated": self.truncated,
            "via": "spawn",
        })
    }

    pub fn format(&self) -> String {
        let mut lines = vec![
            format!("cwd: {}", self.cwd),
            format!(
                "exit: {}",
                if self.timed_out {
                    "timeout".to_string()
                } else {
                    self.exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "null".to_string())
                }
            ),
            "via: spawn".to_string(),
        ];
        if self.truncated {
            lines.push("output: truncated".to_string());
        }
        lines.push(if self.stdout.is_empty() {
            "--- stdout ---\n(empty)".to_string()
        } else {
            format!("--- stdout ---\n{}", self.stdout)
        });
        if !self.stderr.is_empty() {
            lines.push(format!("--- stderr ---\n{}", self.stderr));
        }
        lines.join("\n")
    }
}

#[derive(Default)]
pub struct ShellRunner {
    permits: std::sync::OnceLock<Arc<Semaphore>>,
    session_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl ShellRunner {
    fn semaphore(&self) -> Arc<Semaphore> {
        Arc::clone(
            self.permits
                .get_or_init(|| Arc::new(Semaphore::new(GLOBAL_TERMINAL_CAP))),
        )
    }

    fn session_lock(&self, session: &str) -> Arc<AsyncMutex<()>> {
        let key = if session.is_empty() { "_anon" } else { session };
        let mut locks = self.session_locks.lock().expect("session locks");
        Arc::clone(locks.entry(key.to_string()).or_default())
    }

    pub async fn run(
        &self,
        session: &str,
        command: &str,
        cwd: Option<&str>,
        timeout_ms: Option<f64>,
        root: &Path,
    ) -> Result<TerminalResult, String> {
        let command = assert_allowed_command(command)?;
        let root_text = root.to_string_lossy().into_owned();
        let cwd_path = paths::resolve_workdir(&root_text, cwd).map_err(|error| {
            if error.escape {
                error.message
            } else {
                format!("Invalid cwd: {}", cwd.unwrap_or("."))
            }
        })?;
        if !cwd_path.exists() {
            std::fs::create_dir_all(&cwd_path).map_err(|error| {
                format!(
                    "Working directory missing and could not be created ({}): {error}",
                    cwd_path.display()
                )
            })?;
        } else if !cwd_path.is_dir() {
            return Err(format!("cwd is not a directory: {}", cwd_path.display()));
        }
        let mut timeout = timeout_ms
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.floor() as u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        timeout = timeout.clamp(1_000, MAX_TIMEOUT_MS);

        let lock = self.session_lock(session);
        let _serial = lock.lock().await;
        let permit: OwnedSemaphorePermit = self
            .semaphore()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;

        let cwd_display = cwd_path.to_string_lossy().into_owned();
        let result = run_spawn(&command, &cwd_path, timeout).await;
        drop(permit);
        Ok(TerminalResult {
            command,
            cwd: cwd_display,
            ..result
        })
    }
}

async fn run_spawn(command: &str, cwd: &Path, timeout_ms: u64) -> TerminalResult {
    let mut builder = if cfg!(windows) {
        let mut builder = Command::new("cmd.exe");
        builder
            .arg("/d")
            .arg("/s")
            .arg("/c")
            .arg(format!("chcp 65001 >nul && {command}"));
        builder
    } else {
        let mut builder = Command::new("sh");
        builder.arg("-c").arg(command);
        builder.env("PWD", cwd);
        builder
    };
    builder
        .env(
            if cfg!(windows) { "Path" } else { "PATH" },
            shell_child_path(),
        )
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match builder.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::NotFound {
                format!("{error}\n(working directory must exist: {})", cwd.display())
            } else {
                error.to_string()
            };
            return TerminalResult {
                ok: false,
                command: command.to_string(),
                cwd: cwd.to_string_lossy().into_owned(),
                exit_code: Some(1),
                signal: None,
                stdout: String::new(),
                stderr: message,
                timed_out: false,
                truncated: false,
            };
        }
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer).await;
        }
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer).await;
        }
        buffer
    });

    let wait =
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), child.wait()).await;
    let (status, timed_out) = match wait {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            let _ = child.start_kill();
            let status = child.wait().await.ok();
            (status, true)
        }
    };
    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stderr_bytes = stderr_task.await.unwrap_or_default();
    let mut stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let mut stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let mut truncated = false;
    let total = stdout.chars().count() + stderr.chars().count();
    if total > OUTPUT_CHAR_CAP {
        truncated = true;
        let overflow = total - OUTPUT_CHAR_CAP;
        let stderr_chars = stderr.chars().count();
        if stderr_chars >= overflow {
            stderr = stderr.chars().take(stderr_chars - overflow).collect();
        } else {
            let keep = stdout
                .chars()
                .count()
                .saturating_sub(overflow - stderr_chars);
            stdout = stdout.chars().take(keep).collect();
            stderr.clear();
        }
    }

    let exit_code = status.as_ref().and_then(|status| status.code());
    TerminalResult {
        ok: !timed_out && exit_code == Some(0),
        command: command.to_string(),
        cwd: cwd.to_string_lossy().into_owned(),
        exit_code,
        signal: None,
        stdout,
        stderr,
        timed_out,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_a_simple_command() {
        let root = std::env::temp_dir();
        let runner = ShellRunner::default();
        let result = runner
            .run("s1", "echo hello", None, Some(5000.0), &root)
            .await
            .expect("command runs");
        assert!(result.ok);
        assert!(result.stdout.contains("hello"));
        assert_eq!(result.exit_code, Some(0));
    }

    #[tokio::test]
    async fn rejects_denied_commands() {
        let root = std::env::temp_dir();
        let runner = ShellRunner::default();
        let error = runner
            .run("s1", "shutdown now", None, None, &root)
            .await
            .unwrap_err();
        assert!(error.contains("deny-list"));
    }

    #[tokio::test]
    async fn reports_nonzero_exit() {
        let root = std::env::temp_dir();
        let runner = ShellRunner::default();
        let result = runner
            .run("s1", "exit 3", None, Some(5000.0), &root)
            .await
            .unwrap();
        assert!(!result.ok);
        assert_eq!(result.exit_code, Some(3));
    }
}
