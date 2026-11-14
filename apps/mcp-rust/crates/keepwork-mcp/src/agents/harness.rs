//! Private, shell-free native ACP / Codex JSON-RPC transport.
//!
//! A prompt is sent once. EOF, timeout and process exit never replay a request.
//! The owner/session manager decides which native operations are permitted.

use super::discovery::{child_path, definition, discover, CliLaunch, Protocol};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, watch, Mutex as AsyncMutex, Notify};

const MAX_FRAME: usize = 8_000_000;
const MAX_IN_FLIGHT: usize = 128;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub enum HarnessEvent {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Exit {
        message: String,
    },
    Barrier {
        processed: Arc<Notify>,
    },
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

/// A request whose bytes have reached stdin, with an independently awaited reply.
/// Dropping it unregisters the reply; it never cancels or repeats native work.
pub struct PendingRpc {
    harness: Weak<Harness>,
    id: u64,
    receiver: Option<oneshot::Receiver<Result<Value, String>>>,
    timeout: Duration,
    method: String,
}

impl PendingRpc {
    pub async fn result(mut self) -> Result<Value, String> {
        match tokio::time::timeout(self.timeout,self.receiver.take().expect("native reply")).await {
            Ok(Ok(result))=>result,
            Ok(Err(_))=>Err("Native CLI disconnected; submission outcome is unknown, inspect before retrying".into()),
            Err(_)=>Err(format!("Native CLI {} timed out; submission outcome is unknown, do not resubmit automatically",self.method)),
        }
    }
}
impl Drop for PendingRpc {
    fn drop(&mut self) {
        if let Some(harness) = self.harness.upgrade() {
            harness
                .pending
                .lock()
                .expect("pending lock")
                .remove(&self.id);
        }
    }
}

pub struct Harness {
    antigravity: Option<Arc<super::antigravity::Antigravity>>,
    trae: Option<Arc<super::trae::Trae>>,
    claude: Option<Arc<super::claude::Claude>>,
    backend: String,
    protocol: Protocol,
    launch: CliLaunch,
    capabilities: Mutex<Value>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<Pending>,
    events: broadcast::Sender<HarnessEvent>,
    shutdown: watch::Sender<bool>,
    alive: AtomicBool,
    terminated: AtomicBool,
    stopped: Notify,
    generation: String,
    next_id: AtomicU64,
}

impl Harness {
    pub async fn submit(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<PendingRpc, String> {
        if let Some(trae) = &self.trae {
            let result = trae.call(method, params, timeout).await?;
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(Ok(result));
            return Ok(PendingRpc {
                harness: Weak::new(),
                id: 0,
                receiver: Some(receiver),
                timeout,
                method: method.into(),
            });
        }
        if let Some(antigravity) = &self.antigravity {
            let result = Box::pin(antigravity.call(method, params, timeout)).await?;
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(Ok(result));
            return Ok(PendingRpc {
                harness: Weak::new(),
                id: 0,
                receiver: Some(receiver),
                timeout,
                method: method.into(),
            });
        }
        if let Some(claude) = &self.claude {
            let result = Box::pin(claude.call(method, params, timeout)).await?;
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(Ok(result));
            return Ok(PendingRpc {
                harness: Weak::new(),
                id: 0,
                receiver: Some(receiver),
                timeout,
                method: method.into(),
            });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending lock");
            if pending.len() >= MAX_IN_FLIGHT {
                return Err("Native CLI request concurrency limit exceeded".into());
            }
            if !self.alive() {
                return Err("Native CLI disconnected; prompts were not rerun".into());
            }
            pending.insert(id, sender);
        }
        let call = PendingRpc {
            harness: Arc::downgrade(self),
            id,
            receiver: Some(receiver),
            timeout,
            method: method.into(),
        };
        let mut message = json!({"id":id,"method":method,"params":params});
        if self.protocol == Protocol::Acp {
            message["jsonrpc"] = json!("2.0");
        }
        self.write(message).await?;
        Ok(call)
    }
    pub async fn start(backend: &str, cwd: &Path) -> Result<Arc<Self>, String> {
        let spec = definition(backend).ok_or_else(|| "Unsupported agent backend".to_string())?;
        if !spec.protocol.supported() {
            return Err(format!(
                "{} native protocol is not yet available in Rust MCP (UNSUPPORTED_FEATURE)",
                spec.name
            ));
        }
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("Existing absolute local folder required".to_string());
        }
        let launch = discover(backend)?;
        Self::start_launch(backend, spec.protocol, launch, cwd).await
    }

    async fn start_launch(
        backend: &str,
        protocol: Protocol,
        launch: CliLaunch,
        cwd: &Path,
    ) -> Result<Arc<Self>, String> {
        if matches!(
            protocol,
            Protocol::Claude | Protocol::Antigravity | Protocol::Trae
        ) {
            let (events, _) = broadcast::channel(128);
            let (shutdown, _) = watch::channel(false);
            let claude = (protocol == Protocol::Claude)
                .then(|| super::claude::Claude::new(launch.clone(), cwd, events.clone()));
            let antigravity = (protocol == Protocol::Antigravity)
                .then(|| super::antigravity::Antigravity::new(launch.clone(), cwd, events.clone()));
            let trae = (protocol == Protocol::Trae)
                .then(|| super::trae::Trae::new(launch.clone(), cwd, events.clone()));
            return Ok(Arc::new(Self {
                trae,
                antigravity,
                claude,
                backend: backend.into(),
                protocol,
                launch,
                capabilities: Mutex::new(json!({})),
                stdin: AsyncMutex::new(None),
                pending: Mutex::new(HashMap::new()),
                events,
                shutdown,
                alive: AtomicBool::new(true),
                terminated: AtomicBool::new(false),
                stopped: Notify::new(),
                generation: format!(
                    "{}-{}-{}",
                    protocol.as_str(),
                    std::process::id(),
                    chrono_generation()
                ),
                next_id: AtomicU64::new(0),
            }));
        }
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.args)
            .current_dir(cwd)
            .env(
                if cfg!(windows) { "Path" } else { "PATH" },
                child_path(&launch),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "{} CLI could not start ({}); check its native executable and login in a terminal",
                backend,
                error.kind()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "CLI stdin unavailable".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CLI stdout unavailable".to_string())?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "CLI stderr unavailable".to_string())?;
        let (events, _) = broadcast::channel(128);
        let (shutdown, mut stop) = watch::channel(false);
        let harness = Arc::new(Self {
            antigravity: None,
            trae: None,
            claude: None,
            backend: backend.to_string(),
            protocol,
            launch,
            capabilities: Mutex::new(json!({})),
            stdin: AsyncMutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            events,
            shutdown,
            alive: AtomicBool::new(true),
            terminated: AtomicBool::new(false),
            stopped: Notify::new(),
            generation: format!(
                "{}-{}-{}",
                std::process::id(),
                chrono_generation(),
                child.id().unwrap_or(0)
            ),
            next_id: AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&harness);
        let stdout_task = tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            let mut buffer = Vec::new();
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) => {
                        if let Some(harness) = weak.upgrade() {
                            harness.fail("Native CLI output closed; inspect the session before retrying. Prompts were not rerun.");
                        }
                        break;
                    }
                    Ok(size) => {
                        // Process by line without permitting read_line to allocate an
                        // unbounded buffer for a malicious or broken native process.
                        for part in chunk[..size].split_inclusive(|byte| *byte == b'\n') {
                            if buffer.len() + part.len() > MAX_FRAME {
                                if let Some(harness) = weak.upgrade() {
                                    harness.fail("Native CLI protocol output limit exceeded");
                                }
                                return;
                            }
                            buffer.extend_from_slice(part);
                            if part.last() == Some(&b'\n') {
                                if buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
                                    let message = serde_json::from_slice::<Value>(&buffer);
                                    let Some(harness) = weak.upgrade() else {
                                        return;
                                    };
                                    match message {
                                        Ok(message) if message.is_object() => {
                                            if let Err(error) = harness.message(message).await {
                                                harness.fail(&error);
                                                return;
                                            }
                                        }
                                        _ => {
                                            harness.fail("Invalid native CLI JSON-RPC output");
                                            return;
                                        }
                                    }
                                }
                                buffer.clear();
                            }
                        }
                    }
                    Err(_) => {
                        if let Some(harness) = weak.upgrade() {
                            harness.fail("Native CLI output disconnected; prompts were not rerun");
                        }
                        break;
                    }
                }
            }
        });
        // Diagnostics can contain credentials or prompt text. Drain without logging
        // or accumulating them, including while initialization is in flight.
        let stderr_task = tokio::spawn(async move {
            let mut buffer = [0u8; 8192];
            while matches!(stderr.read(&mut buffer).await, Ok(size) if size > 0) {}
        });
        let weak = Arc::downgrade(&harness);
        tokio::spawn(async move {
            let message = tokio::select! {
                status = child.wait() => {
                    format!("Native CLI exited ({}); interrupted prompts were not rerun", status.map(|status| status.to_string()).unwrap_or_else(|_| "unknown status".to_string()))
                },
                _ = stop.changed() => {
                    stop_child(&mut child).await;
                    "Native CLI closed; prompts were not rerun".to_string()
                }
            };
            stdout_task.abort();
            stderr_task.abort();
            if let Some(harness) = weak.upgrade() {
                harness.fail(&message);
                harness.stdin.lock().await.take();
                harness.terminated.store(true, Ordering::Release);
                harness.stopped.notify_waiters();
            }
        });

        let initialized = match protocol {
            Protocol::Acp => harness.call("initialize", json!({
                "protocolVersion": 1, "clientCapabilities": {},
                "clientInfo": { "name": "keepwork-aichat", "version": "1.0.0" },
            }), RPC_TIMEOUT).await.and_then(|result| {
                if result["protocolVersion"] != 1 { return Err("Unsupported ACP protocol version".to_string()); }
                *harness.capabilities.lock().expect("capabilities lock") = result.get("agentCapabilities").cloned().unwrap_or_else(|| json!({}));
                Ok(())
            }),
            Protocol::Codex => match harness.call("initialize", json!({
                "clientInfo": { "name": "keepwork_aichat", "title": "AIChat", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true },
            }), RPC_TIMEOUT).await {
                Ok(result) if result["userAgent"].is_string() => {
                    *harness.capabilities.lock().expect("capabilities lock") = result;
                    harness.notify("initialized", json!({})).await
                }
                Ok(_) => Err("Incompatible Codex App Server handshake; update the native CLI and reconnect".to_string()),
                Err(error) => Err(error),
            },
            _ => unreachable!("unsupported protocols rejected before spawn"),
        };
        if let Err(error) = initialized {
            harness.close();
            return Err(error);
        }
        Ok(harness)
    }

    pub fn protocol(&self) -> Protocol {
        self.protocol
    }
    pub fn backend(&self) -> &str {
        &self.backend
    }
    pub fn cli_info(&self) -> Value {
        self.launch.info()
    }
    pub fn capabilities(&self) -> Value {
        self.capabilities.lock().expect("capabilities lock").clone()
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn subscribe(&self) -> broadcast::Receiver<HarnessEvent> {
        self.events.subscribe()
    }

    /// Reconcile all notifications emitted before a native RPC reply before
    /// publishing the manager's terminal snapshot. No timer-based ordering.
    pub async fn flush_events(&self) -> Result<(), String> {
        let processed = Arc::new(Notify::new());
        let notified = processed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        self.events
            .send(HarnessEvent::Barrier {
                processed: Arc::clone(&processed),
            })
            .map_err(|_| {
                "Native CLI event consumer disconnected; inspect session state before retrying"
                    .to_string()
            })?;
        tokio::time::timeout(Duration::from_secs(5), notified)
            .await
            .map_err(|_| {
                "Native CLI event reconciliation timed out; inspect session state before retrying"
                    .to_string()
            })
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        if !self.alive() {
            return Err(
                "Native CLI disconnected; inspect session state before retrying".to_string(),
            );
        }
        let mut bytes =
            serde_json::to_vec(&message).map_err(|_| "Invalid native CLI request".to_string())?;
        if bytes.len() > MAX_FRAME {
            return Err("Native CLI input limit exceeded".to_string());
        }
        bytes.push(b'\n');
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let mut guard = self.stdin.lock().await;
            let input = guard
                .as_mut()
                .ok_or_else(|| "Native CLI input closed".to_string())?;
            input.write_all(&bytes).await.map_err(|_| {
                "Native CLI input disconnected; inspect session state before retrying".to_string()
            })
        })
        .await
        .map_err(|_| "Native CLI input timed out; submission outcome is unknown".to_string())
        .and_then(|result| result);
        if result.is_err() {
            self.fail(
                "Native CLI input disconnected; pending operations are not automatically replayed",
            );
        }
        result
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if let Some(trae) = &self.trae {
            return trae.call(method, params, timeout).await;
        }
        if let Some(antigravity) = &self.antigravity {
            return Box::pin(antigravity.call(method, params, timeout)).await;
        }
        if let Some(claude) = &self.claude {
            return Box::pin(claude.call(method, params, timeout)).await;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending lock");
            if pending.len() >= MAX_IN_FLIGHT {
                return Err("Native CLI request concurrency limit exceeded".to_string());
            }
            if !self.alive() {
                return Err("Native CLI disconnected; prompts were not rerun".to_string());
            }
            pending.insert(id, sender);
        }
        let _guard = PendingGuard {
            id,
            pending: &self.pending,
        };
        let mut message = json!({ "id": id, "method": method, "params": params });
        if self.protocol == Protocol::Acp {
            message["jsonrpc"] = json!("2.0");
        }
        self.write(message).await?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Native CLI disconnected; submission outcome is unknown, inspect before retrying".to_string()),
            Err(_) => Err(format!("Native CLI {method} timed out; submission outcome is unknown, do not resubmit automatically")),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let mut message = json!({ "method": method, "params": params });
        if self.protocol == Protocol::Acp {
            message["jsonrpc"] = json!("2.0");
        }
        self.write(message).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        if self.trae.is_some() {
            return Err("Native RPC rejected: UNSUPPORTED_FEATURE: Trae Agent has no interactive approval API".into());
        }
        if let Some(antigravity) = &self.antigravity {
            return antigravity.respond().await;
        }
        if let Some(claude) = &self.claude {
            return claude.respond(id, result).await;
        }
        let mut message = json!({ "id": id, "result": result });
        if self.protocol == Protocol::Acp {
            message["jsonrpc"] = json!("2.0");
        }
        self.write(message).await
    }

    pub async fn reject(&self, id: Value, code: i64, message: &str) -> Result<(), String> {
        if self.trae.is_some() {
            return Err("Native RPC rejected: UNSUPPORTED_FEATURE: Trae Agent has no interactive approval API".into());
        }
        if let Some(antigravity) = &self.antigravity {
            return antigravity.respond().await;
        }
        if let Some(claude) = &self.claude {
            return claude.reject(id, message).await;
        }
        let mut result = json!({ "id": id, "error": { "code": code, "message": message } });
        if self.protocol == Protocol::Acp {
            result["jsonrpc"] = json!("2.0");
        }
        self.write(result).await
    }

    async fn message(&self, message: Value) -> Result<(), String> {
        if let Some(method) = message["method"].as_str() {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            if let Some(id) = message.get("id") {
                if !id.is_string() && !id.is_number() {
                    return Err("Invalid native CLI request ID".to_string());
                }
                // Unsupported client RPCs fail promptly, including files/terminal
                // operations the initialize handshake never advertised.
                let supported = match self.protocol {
                    Protocol::Acp => [
                        "session/request_permission",
                        "cursor/ask_question",
                        "cursor/create_plan",
                    ]
                    .contains(&method),
                    Protocol::Codex => [
                        "item/commandExecution/requestApproval",
                        "item/fileChange/requestApproval",
                        "item/permissions/requestApproval",
                        "item/tool/requestUserInput",
                        "execCommandApproval",
                        "applyPatchApproval",
                    ]
                    .contains(&method),
                    _ => false,
                };
                if !supported {
                    return self
                        .reject(id.clone(), -32601, "Client method unsupported")
                        .await;
                }
                if self
                    .events
                    .send(HarnessEvent::Request {
                        id: id.clone(),
                        method: method.to_string(),
                        params,
                    })
                    .is_err()
                {
                    self.reject(
                        id.clone(),
                        -32601,
                        "No active session can answer this request",
                    )
                    .await?;
                }
            } else {
                let _ = self.events.send(HarnessEvent::Notification {
                    method: method.to_string(),
                    params,
                });
            }
            return Ok(());
        }
        let Some(id) = message["id"].as_u64() else {
            return Err("Invalid native CLI response ID".to_string());
        };
        let sender = self.pending.lock().expect("pending lock").remove(&id);
        if let Some(sender) = sender {
            let result = if let Some(error) = message.get("error").filter(|error| !error.is_null())
            {
                Err(format!(
                    "Native RPC rejected: {}",
                    bounded_message(error["message"].as_str().unwrap_or("unknown native error"))
                ))
            } else if let Some(result) = message.get("result") {
                Ok(result.clone())
            } else {
                Err("Native CLI response omitted result".to_string())
            };
            let _ = sender.send(result);
        }
        Ok(())
    }

    fn fail(&self, message: &str) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        let message = bounded_message(message);
        for (_, pending) in self.pending.lock().expect("pending lock").drain() {
            let _ = pending.send(Err(message.clone()));
        }
        let _ = self.events.send(HarnessEvent::Exit { message });
        let _ = self.shutdown.send(true);
    }

    pub fn close(&self) {
        if let Some(trae) = &self.trae {
            trae.close();
        }
        if let Some(antigravity) = &self.antigravity {
            antigravity.close();
        }
        if let Some(claude) = &self.claude {
            claude.close();
        }
        self.fail("Native CLI closed; prompts were not rerun");
    }

    /// Reap owned children before the daemon's Tokio runtime exits. Browser
    /// stream disconnection must never call this operation.
    pub async fn shutdown(&self) {
        if let Some(trae) = &self.trae {
            self.alive.store(false, Ordering::Release);
            trae.shutdown().await;
            return;
        }
        if let Some(antigravity) = &self.antigravity {
            self.alive.store(false, Ordering::Release);
            antigravity.shutdown().await;
            return;
        }
        if let Some(claude) = &self.claude {
            self.alive.store(false, Ordering::Release);
            claude.shutdown().await;
            return;
        }
        self.close();
        let _ = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                let notified = self.stopped.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.terminated.load(Ordering::Acquire) {
                    break;
                }
                notified.await;
            }
        })
        .await;
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(trae) = &self.trae {
            trae.close();
        }
        if let Some(antigravity) = &self.antigravity {
            antigravity.close();
        }
        if let Some(claude) = &self.claude {
            claude.close();
        }
        let _ = self.shutdown.send(true);
    }
}

struct PendingGuard<'a> {
    id: u64,
    pending: &'a Mutex<Pending>,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().expect("pending lock").remove(&self.id);
    }
}

fn bounded_message(message: &str) -> String {
    message.chars().take(2000).collect()
}

fn chrono_generation() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub(super) async fn stop_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        {
            // This is the process group created above for our own child only.
            // No user-supplied command or PID reaches this invocation.
            let _ = Command::new("/bin/kill")
                .args(["-TERM", "--", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

pub fn option_values(option: &Value) -> Vec<Value> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry["options"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![entry.clone()])
        })
        .take(1000)
        .collect()
}

pub fn model_option(session: &Value) -> Option<&Value> {
    session["configOptions"].as_array()?.iter().find(|option| {
        (!option["type"].is_string() || option["type"] == "select")
            && (option["category"] == "model" || option["id"] == "model")
    })
}

pub fn effort_option(session: &Value) -> Option<&Value> {
    session["configOptions"].as_array()?.iter().find(|option| {
        (!option["type"].is_string() || option["type"] == "select")
            && (option["category"] == "thought_level"
                || matches!(
                    option["id"].as_str(),
                    Some(
                        "reasoning_effort"
                            | "reasoning-effort"
                            | "effort"
                            | "thinking_level"
                            | "thinking-level"
                    )
                ))
    })
}

pub fn normalize_models(session: &Value) -> Vec<Value> {
    let model = model_option(session);
    let effort = effort_option(session);
    let current = model
        .and_then(|option| option.get("currentValue"))
        .unwrap_or(&session["models"]["currentModelId"]);
    let models = model.map(|option| option_values(option).into_iter().map(|value| json!({
        "id": value["value"], "displayName": value["name"], "description": value["description"],
    })).collect::<Vec<_>>()).unwrap_or_else(|| session["models"]["availableModels"].as_array().into_iter().flatten().map(|value| json!({
        "id": value["modelId"], "displayName": value["name"], "description": value["description"],
    })).collect());
    models.into_iter().filter(|model| model["id"].as_str().is_some_and(|id| !id.is_empty() && id.len() <= 512)).take(1000).map(|mut model| {
        model["isDefault"] = json!(model["id"] == *current);
        if model["id"] == *current {
            if let Some(effort) = effort {
                model["defaultReasoningEffort"] = effort["currentValue"].clone();
                model["supportedReasoningEfforts"] = json!(option_values(effort).into_iter().map(|option| json!({
                    "reasoningEffort": option["value"], "displayName": option["name"], "description": option["description"],
                })).collect::<Vec<_>>());
            }
        }
        model
    }).collect()
}

#[cfg(test)]
pub(super) struct FixtureFile(std::path::PathBuf);
#[cfg(test)]
impl Drop for FixtureFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
pub(super) async fn fixture(source: &str, protocol: Protocol) -> (Arc<Harness>, FixtureFile) {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "keepwork-native-harness-{}-{}.cjs",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, source).unwrap();
    let node = super::discovery::search_dirs()
        .into_iter()
        .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|path| path.is_file())
        .expect("Node.js is required for the isolated native CLI fixture");
    let launch = CliLaunch {
        executable: node,
        args: vec![path.to_string_lossy().into_owned()],
        path: path.clone(),
        source: "fixture".to_string(),
    };
    let harness = Harness::start_launch("fixture", protocol, launch, &std::env::temp_dir())
        .await
        .unwrap();
    (harness, FixtureFile(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_process_stream_permissions_cancel_and_shutdown() {
        let (harness, _file) = fixture(
            include_str!("../../../../../../scripts/contract/fixtures/agent-cli.cjs"),
            Protocol::Acp,
        )
        .await;
        let metadata = harness
            .call(
                "session/new",
                json!({"cwd":std::env::temp_dir(),"mcpServers":[]}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        let models = normalize_models(&metadata);
        assert!(models.iter().any(|model| model["id"] == "fixture-model"));
        assert!(models.iter().any(|model| model["id"] == "fixture-other"));
        let id = metadata["sessionId"].clone();
        let mut events = harness.subscribe();
        let prompt = {
            let harness = Arc::clone(&harness);
            let id = id.clone();
            tokio::spawn(async move {
                harness.call("session/prompt", json!({"sessionId":id,"prompt":[{"type":"text","text":"FIXTURE_PERMISSION"}]}), Duration::from_secs(5)).await
            })
        };
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        let HarnessEvent::Request {
            id: request_id,
            method,
            ..
        } = event
        else {
            panic!("expected native permission request")
        };
        assert_eq!(method, "session/request_permission");
        assert!(request_id.is_string());
        harness
            .respond(
                request_id,
                json!({"outcome":{"outcome":"selected","optionId":"allow"}}),
            )
            .await
            .unwrap();
        assert_eq!(prompt.await.unwrap().unwrap()["stopReason"], "end_turn");
        let event = events.recv().await.unwrap();
        let HarnessEvent::Notification { params, .. } = event else {
            panic!("expected streamed native text")
        };
        assert_eq!(params["update"]["content"]["text"], "permission:allowed");

        let prompt = {
            let harness = Arc::clone(&harness);
            let id = id.clone();
            tokio::spawn(async move {
                harness
                    .call(
                        "session/prompt",
                        json!({"sessionId":id,"prompt":[{"type":"text","text":"FIXTURE_SLOW"}]}),
                        Duration::from_secs(5),
                    )
                    .await
            })
        };
        let _ = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        harness
            .notify("session/cancel", json!({"sessionId":id}))
            .await
            .unwrap();
        assert_eq!(prompt.await.unwrap().unwrap()["stopReason"], "cancelled");
        harness.close();
        assert!(!harness.alive());
        harness.shutdown().await;
        assert!(harness.terminated.load(Ordering::Acquire));
        assert!(harness
            .call("session/new", json!({}), Duration::from_secs(1))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn uncertain_timeouts_are_not_replayed_and_exit_releases_pending() {
        let (harness, _file) = fixture(
            include_str!("../../../../../../scripts/contract/fixtures/agent-cli.cjs"),
            Protocol::Acp,
        )
        .await;
        let metadata = harness
            .call(
                "session/new",
                json!({"cwd":std::env::temp_dir(),"mcpServers":[]}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        let error = harness.call("session/prompt", json!({"sessionId":metadata["sessionId"],"prompt":[{"type":"text","text":"FIXTURE_SLOW"}]}), Duration::from_millis(80)).await.unwrap_err();
        assert!(error.contains("outcome is unknown"));
        assert!(harness.pending.lock().unwrap().is_empty());
        let error = harness.call("session/prompt", json!({"sessionId":metadata["sessionId"],"prompt":[{"type":"text","text":"FIXTURE_EXIT"}]}), Duration::from_secs(3)).await.unwrap_err();
        assert!(!error.contains("timed out"));
        assert!(!harness.alive());
        assert!(harness.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unsupported_client_methods_receive_errors_instead_of_hanging() {
        let source = r#"const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
 else if(m.method==='fixture/unsupported'){global.waiting=m.id;send({id:'native-unknown',method:'fs/write_text_file',params:{path:'/must-not-write'}})}
 else if(m.id==='native-unknown')send({id:global.waiting,result:{code:m.error?.code}});
});"#;
        let (harness, _file) = fixture(source, Protocol::Acp).await;
        let result = harness
            .call("fixture/unsupported", json!({}), Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(result["code"], -32601);
        harness.close();
    }

    #[tokio::test]
    async fn broken_native_protocol_is_bounded_and_reaps_its_child() {
        let source = r#"const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{protocolVersion:1}})+'\n');
 else if(m.method==='fixture/flood')process.stdout.write('x'.repeat(9000000));
});"#;
        let (harness, _file) = fixture(source, Protocol::Acp).await;
        let result = harness
            .call("fixture/flood", json!({}), Duration::from_secs(3))
            .await;
        assert!(result.unwrap_err().contains("output limit exceeded"));
        harness.shutdown().await;
        assert!(harness.terminated.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn rpc_completion_barrier_waits_until_prior_output_is_reconciled() {
        let (harness, _file) = fixture(
            include_str!("../../../../../../scripts/contract/fixtures/agent-cli.cjs"),
            Protocol::Acp,
        )
        .await;
        let metadata = harness
            .call(
                "session/new",
                json!({"cwd":std::env::temp_dir(),"mcpServers":[]}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        let mut events = harness.subscribe();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handled = Arc::clone(&count);
        let consumer = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                match event {
                    HarnessEvent::Notification { .. } => {
                        // Simulate a manager persisting snapshots slower than
                        // the native process emits them.
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        handled.fetch_add(1, Ordering::Relaxed);
                    }
                    HarnessEvent::Barrier { processed } => {
                        processed.notify_one();
                    }
                    HarnessEvent::Exit { .. } => break,
                    _ => {}
                }
            }
        });
        harness.call("session/prompt", json!({"sessionId":metadata["sessionId"],"prompt":[{"type":"text","text":"normal fixture"}]}), Duration::from_secs(3)).await.unwrap();
        harness.flush_events().await.unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 3);
        harness.shutdown().await;
        consumer.await.unwrap();
    }

    #[tokio::test]
    async fn codex_initializes_and_preserves_permission_request_ids() {
        let source = r#"const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'codex-fixture/1'}});
 else if(m.method==='fixture/permission'){global.waiting=m.id;send({id:41,method:'item/permissions/requestApproval',params:{threadId:'fixture-thread',permissions:{network:{enabled:true}}}})}
 else if(m.id===41)send({id:global.waiting,result:m.result});
});"#;
        let (harness, _file) = fixture(source, Protocol::Codex).await;
        let mut events = harness.subscribe();
        let call = {
            let harness = Arc::clone(&harness);
            tokio::spawn(async move {
                harness
                    .call("fixture/permission", json!({}), Duration::from_secs(3))
                    .await
            })
        };
        let HarnessEvent::Request { id, method, params } = events.recv().await.unwrap() else {
            panic!("expected permission")
        };
        assert_eq!(id, 41);
        assert_eq!(method, "item/permissions/requestApproval");
        assert_eq!(params["threadId"], "fixture-thread");
        harness
            .respond(id, json!({"permissions":{},"scope":"turn"}))
            .await
            .unwrap();
        assert_eq!(call.await.unwrap().unwrap()["scope"], "turn");
        harness.close();
    }

    #[test]
    fn grouped_configuration_preserves_native_models_and_current_efforts() {
        let models = normalize_models(&json!({"configOptions":[
            {"id":"model", "category":"model", "currentValue":"m2", "options":[{"group":"Models", "options":[{"value":"m1","name":"One"},{"value":"m2","name":"Two"}]}]},
            {"id":"thinking", "category":"thought_level", "currentValue":"high", "options":[{"value":"high","name":"High"},{"value":"enabled","name":"Enabled"}]}
        ]}));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "m1");
        assert!(models[0].get("supportedReasoningEfforts").is_none());
        assert_eq!(models[1]["isDefault"], true);
        assert_eq!(models[1]["defaultReasoningEffort"], "high");
        assert_eq!(
            models[1]["supportedReasoningEfforts"][1]["reasoningEffort"],
            "enabled"
        );
    }

    #[test]
    fn legacy_catalogue_does_not_invent_effort_options() {
        let models = normalize_models(
            &json!({"models":{"currentModelId":"m1","availableModels":[{"modelId":"m1","name":"Native One"}]}}),
        );
        assert_eq!(models[0]["displayName"], "Native One");
        assert_eq!(models[0]["isDefault"], true);
        assert!(models[0].get("supportedReasoningEfforts").is_none());
    }
}
