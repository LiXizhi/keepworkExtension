//! Claude's bidirectional stream-json protocol. Each native thread owns its
//! process; neither prompt-free discovery nor a failed thread can reuse another
//! conversation's native state. Prompts are written once, never replayed.

use super::discovery::{child_path, CliLaunch};
use super::harness::HarnessEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, watch, Mutex as AsyncMutex, Notify};

const MAX_FRAME: usize = 8_000_000;
const MAX_CONNECTIONS: usize = 16;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
type Reply = oneshot::Sender<Result<Value, String>>;

pub(super) struct Claude {
    launch: CliLaunch,
    cwd: PathBuf,
    events: broadcast::Sender<HarnessEvent>,
    connections: AsyncMutex<HashMap<String, Arc<Connection>>>,
    closing: AtomicBool,
}

struct Run {
    id: String,
    items: HashMap<String, Value>,
    item_bytes: usize,
    message: String,
    cancelled: bool,
    timeout: Option<tokio::task::AbortHandle>,
}

struct Connection {
    thread: String,
    config: Value,
    initialized: Mutex<Value>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Reply>>,
    permissions: Mutex<HashMap<String, (String, Value)>>,
    run: Mutex<Option<Run>>,
    events: broadcast::Sender<HarnessEvent>,
    stop: watch::Sender<bool>,
    alive: AtomicBool,
    native: AtomicBool,
    terminated: AtomicBool,
    stopped: Notify,
}

fn rejected(message: &str) -> String {
    format!(
        "Native RPC rejected: {}",
        message.chars().take(2000).collect::<String>()
    )
}

impl Claude {
    pub fn new(
        launch: CliLaunch,
        cwd: &Path,
        events: broadcast::Sender<HarnessEvent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            launch,
            cwd: cwd.into(),
            events,
            connections: AsyncMutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
        })
    }

    async fn boot(
        &self,
        thread: &str,
        mut config: Value,
        resume: bool,
    ) -> Result<Arc<Connection>, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Claude service is stopping".into());
        }
        let mut connections = self.connections.lock().await;
        let mut resume = resume;
        if let Some(existing) = connections.get(thread) {
            if existing.alive.load(Ordering::Acquire) && existing.config == config {
                return Ok(existing.clone());
            }
            if existing.run.lock().unwrap().is_some() {
                return Err(rejected("Cannot replace an active Claude connection"));
            }
            resume = existing.native.load(Ordering::Acquire);
            existing.close("Claude connection configuration changed; prompts were not rerun");
        }
        connections.remove(thread);
        if connections
            .values()
            .filter(|c| c.alive.load(Ordering::Acquire))
            .count()
            >= MAX_CONNECTIONS
        {
            let idle = connections
                .iter()
                .find(|(_, c)| {
                    c.alive.load(Ordering::Acquire)
                        && c.run.lock().unwrap().is_none()
                        && c.pending.lock().unwrap().is_empty()
                })
                .map(|(key, _)| key.clone());
            if let Some(idle) = idle {
                if let Some(c) = connections.get(&idle) {
                    c.close("Idle Claude connection retired");
                }
            } else {
                return Err(rejected("Claude concurrent session limit reached"));
            }
        }
        if config["cwd"].is_null() {
            config["cwd"] = json!(self.cwd);
        }
        let connection =
            Connection::start(&self.launch, thread, config, resume, self.events.clone()).await?;
        connections.insert(thread.into(), connection.clone());
        Ok(connection)
    }

    async fn connection(&self, thread: &str) -> Result<Arc<Connection>, String> {
        let old = self
            .connections
            .lock()
            .await
            .get(thread)
            .cloned()
            .ok_or_else(|| rejected("Claude session must be restored before sending"))?;
        if old.alive.load(Ordering::Acquire) {
            return Ok(old);
        }
        self.boot(
            thread,
            old.config.clone(),
            old.native.load(Ordering::Acquire),
        )
        .await
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value, String> {
        match method {
            "account/read" => return self.account().await,
            "model/list" => {
                let config = json!({"cwd":self.cwd});
                let thread = {
                    let connections = self.connections.lock().await;
                    connections
                        .get("metadata")
                        .map(|c| c.thread.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
                };
                // The metadata process receives initialize only, never a user turn.
                let mut connections = self.connections.lock().await;
                if params["refresh"] == true {
                    if let Some(previous) = connections.remove("metadata") {
                        previous.close(
                            "Claude metadata refreshed; conversation processes remain active",
                        );
                    }
                }
                let current = connections
                    .get("metadata")
                    .filter(|c| c.alive.load(Ordering::Acquire))
                    .cloned();
                let c = if let Some(c) = current {
                    c
                } else {
                    if connections
                        .values()
                        .filter(|c| c.alive.load(Ordering::Acquire))
                        .count()
                        >= MAX_CONNECTIONS
                    {
                        let idle = connections
                            .values()
                            .find(|c| {
                                c.alive.load(Ordering::Acquire)
                                    && c.run.lock().unwrap().is_none()
                                    && c.pending.lock().unwrap().is_empty()
                            })
                            .cloned()
                            .ok_or_else(|| rejected("Claude concurrent session limit reached"))?;
                        idle.close("Idle Claude connection retired for metadata discovery");
                    }
                    let c = Connection::start(
                        &self.launch,
                        &thread,
                        config,
                        false,
                        self.events.clone(),
                    )
                    .await?;
                    connections.insert("metadata".into(), c.clone());
                    c
                };
                let data = normalize_models(&c.initialized.lock().unwrap()["models"]);
                return Ok(json!({"data":data}));
            }
            "thread/start" | "thread/resume" => {
                let thread = if method == "thread/start" {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    params["threadId"]
                        .as_str()
                        .filter(|id| {
                            !id.is_empty()
                                && id.len() <= 160
                                && id
                                    .chars()
                                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                        })
                        .ok_or_else(|| rejected("Invalid Claude thread ID"))?
                        .into()
                };
                let resume = params["resume"]
                    .as_bool()
                    .unwrap_or(method == "thread/resume");
                let c = self.boot(&thread, params, resume).await?;
                return Ok(
                    json!({"thread":{"id":thread},"models":normalize_models(&c.initialized.lock().unwrap()["models"])}),
                );
            }
            _ => {}
        }
        let thread = params["threadId"]
            .as_str()
            .ok_or_else(|| rejected("Claude thread ID required"))?;
        let c = self.connection(thread).await?;
        match method {
            "thread/mode/set" => {
                c.mode(params["mode"].as_str().unwrap_or("craft")).await?;
                Ok(json!({"nativePlan":params["mode"] == "plan"}))
            }
            "turn/interrupt" => {
                if let Some(run) = c.run.lock().unwrap().as_mut() {
                    run.cancelled = true;
                }
                c.control(json!({"subtype":"interrupt"})).await?;
                Ok(json!({}))
            }
            "turn/start" => c.turn(params).await,
            _ => Err(rejected("Unsupported Claude harness method")),
        }
    }

    async fn account(&self) -> Result<Value, String> {
        let mut command = command(&self.launch, &self.cwd);
        command.args(["auth", "status"]);
        let mut child = command
            .spawn()
            .map_err(|_| "Claude auth status could not start".to_string())?;
        child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or("Claude status output unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Claude status diagnostics unavailable")?;
        let drain = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            while matches!(stderr.read(&mut chunk).await, Ok(n) if n > 0) {}
        });
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            let mut bytes = Vec::new();
            stdout
                .take(65_537)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| ())?;
            if bytes.len() > 65_536 {
                return Err(());
            }
            let status = child.wait().await.map_err(|_| ())?;
            if !status.success() && status.code() != Some(1) {
                return Err(());
            }
            serde_json::from_slice::<Value>(&bytes).map_err(|_| ())
        })
        .await;
        // Auth output is never included in logs/errors or retained. Unsupported
        // old CLI auth/status is unknown, not signed out or a missing executable.
        if child.id().is_some() {
            super::harness::stop_child(&mut child).await;
        }
        drain.abort();
        match result {
            Ok(Ok(status)) if status["loggedIn"] == false => {
                Ok(json!({"account":null,"probe":"native-auth"}))
            }
            Ok(Ok(status)) if status["loggedIn"] == true => {
                let mut account = json!({"type":if matches!(status["authMethod"].as_str(),Some("api_key"|"api_key_helper")){"apiKey"}else{"cli"}});
                if let Some(email) = status["email"]
                    .as_str()
                    .filter(|s| s.len() <= 320 && !s.chars().any(char::is_control))
                {
                    account["email"] = json!(email);
                }
                Ok(json!({"account":account,"probe":"native-auth"}))
            }
            _ => Ok(json!({"account":null,"authUnknown":true,"probe":"executable"})),
        }
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let key = id
            .as_str()
            .ok_or_else(|| rejected("Invalid Claude request ID"))?;
        let connections = self
            .connections
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for c in connections {
            let request = c.permissions.lock().unwrap().remove(key);
            let Some((native_id, request)) = request else {
                continue;
            };
            let mut input = request["input"].clone();
            let questions = request["tool_name"] == "AskUserQuestion";
            let allow = if questions {
                result["answers"].is_object()
            } else {
                result["decision"] == "accept"
            };
            if questions && allow {
                let mut answers = serde_json::Map::new();
                for (index, question) in input["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let key = question["question"]
                        .as_str()
                        .ok_or_else(|| rejected("Invalid Claude question"))?;
                    answers.insert(
                        key.into(),
                        result["answers"][index.to_string()]["answers"][0].clone(),
                    );
                }
                input["answers"] = json!(answers);
            }
            return c.write(json!({"type":"control_response","response":{"subtype":"success","request_id":native_id,"response":if allow{json!({"behavior":"allow","updatedInput":input})}else{json!({"behavior":"deny","message":"User declined permission"})}}})).await;
        }
        Err(rejected("Claude request expired"))
    }

    pub async fn reject(&self, id: Value, message: &str) -> Result<(), String> {
        let key = id
            .as_str()
            .ok_or_else(|| rejected("Invalid Claude request ID"))?;
        let connections = self
            .connections
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for c in connections {
            let request = c.permissions.lock().unwrap().remove(key);
            if let Some((native_id, _)) = request {
                return c.write(json!({"type":"control_response","response":{"subtype":"success","request_id":native_id,"response":{"behavior":"deny","message":message}}})).await;
            }
        }
        Err(rejected("Claude request expired"))
    }

    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        let connections = self
            .connections
            .lock()
            .await
            .drain()
            .map(|(_, c)| c)
            .collect::<Vec<_>>();
        for c in &connections {
            c.close("Claude closed; prompts were not rerun");
        }
        for c in connections {
            let _ = tokio::time::timeout(Duration::from_secs(6), async {
                loop {
                    let notified = c.stopped.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if c.terminated.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
            })
            .await;
        }
    }

    pub fn close(&self) {
        self.closing.store(true, Ordering::Release);
        // Connection shutdown is also signaled by each owned connection's Drop.
        if let Ok(connections) = self.connections.try_lock() {
            for c in connections.values() {
                c.close("Claude closed; prompts were not rerun");
            }
        }
    }
}

fn command(launch: &CliLaunch, cwd: &Path) -> Command {
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .current_dir(cwd)
        .env(
            if cfg!(windows) { "Path" } else { "PATH" },
            child_path(launch),
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
    command
}

impl Connection {
    async fn start(
        launch: &CliLaunch,
        thread: &str,
        config: Value,
        resume: bool,
        events: broadcast::Sender<HarnessEvent>,
    ) -> Result<Arc<Self>, String> {
        let cwd = config["cwd"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.is_absolute() && p.is_dir())
            .ok_or_else(|| rejected("Existing absolute Claude workspace required"))?;
        let mut command = command(launch, cwd);
        command.args([
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ]);
        command.arg(format!(
            "{}={thread}",
            if resume { "--resume" } else { "--session-id" }
        ));
        for root in config["roots"].as_array().into_iter().flatten().skip(1) {
            if let Some(root) = root.as_str() {
                command.args(["--add-dir", root]);
            }
        }
        if let Some(model) = config["model"].as_str().filter(|m| !m.is_empty()) {
            command.args(["--model", model]);
        }
        if config["mode"] == "plan" {
            command.args(["--permission-mode", "plan"]);
        }
        let mut servers = serde_json::Map::new();
        for server in config["mcpServers"].as_array().into_iter().flatten() {
            let name = server["name"]
                .as_str()
                .ok_or_else(|| rejected("Invalid Claude MCP descriptor"))?;
            let mut env = serde_json::Map::new();
            for entry in server["env"].as_array().into_iter().flatten() {
                let name = entry["name"]
                    .as_str()
                    .ok_or_else(|| rejected("Invalid Claude MCP environment"))?;
                let value = entry["value"]
                    .as_str()
                    .ok_or_else(|| rejected("Invalid Claude MCP environment"))?;
                command.env(name, value);
                env.insert(name.into(), json!(format!("${{{name}}}")));
            }
            servers.insert(
                name.into(),
                json!({"command":server["command"],"args":server["args"],"env":env}),
            );
        }
        if !servers.is_empty() {
            command.args(["--mcp-config", &json!({"mcpServers":servers}).to_string()]);
        }
        if let Some(instructions) = config["aichatInstructions"].as_str() {
            command.args(["--append-system-prompt", instructions]);
        }
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Claude CLI could not start ({}); inspect installation and native login",
                error.kind()
            )
        })?;
        let stdin = child.stdin.take().ok_or("Claude input unavailable")?;
        let mut stdout = child.stdout.take().ok_or("Claude output unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Claude diagnostics unavailable")?;
        let (stop, mut stopped) = watch::channel(false);
        let c = Arc::new(Self {
            thread: thread.into(),
            config,
            initialized: Mutex::new(json!({})),
            stdin: AsyncMutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            run: Mutex::new(None),
            events,
            stop,
            alive: AtomicBool::new(true),
            native: AtomicBool::new(resume),
            terminated: AtomicBool::new(false),
            stopped: Notify::new(),
        });
        let weak = Arc::downgrade(&c);
        let mut output = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            let mut buffer = Vec::new();
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        if let Some(c) = weak.upgrade() {
                            c.close("Claude output disconnected; inspect outcome before retrying. Prompts were not rerun.");
                        }
                        break;
                    }
                    Ok(size) => {
                        for part in chunk[..size].split_inclusive(|byte| *byte == b'\n') {
                            let Some(c) = weak.upgrade() else {
                                return;
                            };
                            if buffer.len() + part.len() > MAX_FRAME {
                                c.close("Claude output limit exceeded; prompts were not rerun");
                                return;
                            }
                            buffer.extend_from_slice(part);
                            if part.last() == Some(&b'\n') {
                                if buffer.iter().any(|b| !b.is_ascii_whitespace()) {
                                    match serde_json::from_slice::<Value>(&buffer) {
                                        Ok(message) if message.is_object() => {
                                            if let Err(error) = c.message(message).await {
                                                c.close(&error);
                                                return;
                                            }
                                        }
                                        _ => {
                                            c.close("Invalid Claude protocol output; prompts were not rerun");
                                            return;
                                        }
                                    }
                                }
                                buffer.clear();
                            }
                        }
                    }
                }
            }
        });
        let diagnostics = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            while matches!(stderr.read(&mut chunk).await,Ok(n) if n>0) {}
        });
        let weak = Arc::downgrade(&c);
        tokio::spawn(async move {
            let message = tokio::select! { result=child.wait()=>format!("Claude exited ({}); inspect outcome before retrying; prompts were not rerun",result.map(|s|s.to_string()).unwrap_or_else(|_|"unknown".into())), _=stopped.changed()=>{super::harness::stop_child(&mut child).await;"Claude closed; prompts were not rerun".into()} };
            // Drain complete frames before marking exit; a final result can be
            // written immediately before the process exits.
            if tokio::time::timeout(Duration::from_millis(100), &mut output)
                .await
                .is_err()
            {
                output.abort();
            }
            diagnostics.abort();
            if let Some(c) = weak.upgrade() {
                c.close(&message);
                c.stdin.lock().await.take();
                c.terminated.store(true, Ordering::Release);
                c.stopped.notify_waiters();
            }
        });
        match c.control(json!({"subtype":"initialize","hooks":{}})).await {
            Ok(initialized) => {
                *c.initialized.lock().unwrap() = initialized;
                Ok(c)
            }
            Err(error) => {
                c.close(&error);
                Err(error)
            }
        }
    }

    fn notify(&self, method: &str, mut params: Value) {
        params["threadId"] = json!(self.thread);
        let _ = self.events.send(HarnessEvent::Notification {
            method: method.into(),
            params,
        });
    }
    async fn write(&self, message: Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Claude disconnected; inspect outcome before retrying".into());
        }
        let mut bytes =
            serde_json::to_vec(&message).map_err(|_| rejected("Invalid Claude message"))?;
        if bytes.len() > MAX_FRAME {
            return Err(rejected("Claude input limit exceeded"));
        }
        bytes.push(b'\n');
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            self.stdin
                .lock()
                .await
                .as_mut()
                .ok_or("Claude input closed".to_string())?
                .write_all(&bytes)
                .await
                .map_err(|_| "Claude input disconnected; submission outcome is unknown".to_string())
        })
        .await
        .map_err(|_| "Claude input timed out; submission outcome is unknown".to_string())
        .and_then(|r| r);
        if result.is_err() {
            self.close("Claude input disconnected; prompts were not rerun");
        }
        result
    }
    async fn control(&self, request: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 128 {
                return Err(rejected("Claude control concurrency limit reached"));
            }
            pending.insert(id.clone(), sender);
        }
        let result = async {
            self.write(json!({"type":"control_request","request_id":id,"request":request}))
                .await?;
            tokio::time::timeout(CONTROL_TIMEOUT, receiver)
                .await
                .map_err(|_| {
                    "Claude control timed out; inspect outcome before retrying".to_string()
                })?
                .map_err(|_| {
                    "Claude control disconnected; inspect outcome before retrying".to_string()
                })?
        }
        .await;
        self.pending.lock().unwrap().remove(&id);
        result
    }
    async fn mode(&self, mode: &str) -> Result<(), String> {
        self.control(
            json!({"subtype":"set_permission_mode","mode":if mode=="plan"{"plan"}else{"default"}}),
        )
        .await?;
        Ok(())
    }
    async fn turn(self: &Arc<Self>, params: Value) -> Result<Value, String> {
        if self.run.lock().unwrap().is_some() {
            return Err(rejected("Claude session already running"));
        }
        if let Some(model) = params["model"].as_str().filter(|m| !m.is_empty()) {
            self.control(json!({"subtype":"set_model","model":model}))
                .await?;
            self.initialized.lock().unwrap()["_currentModel"] = json!(model);
        }
        if let Some(effort) = params["effort"].as_str() {
            let initialized = self.initialized.lock().unwrap().clone();
            let models = normalize_models(&initialized["models"]);
            let selected = params["model"]
                .as_str()
                .or_else(|| initialized["_currentModel"].as_str())
                .or_else(|| self.config["model"].as_str());
            let model = selected
                .and_then(|selected| models.iter().find(|model| model["id"] == selected))
                .or_else(|| {
                    if selected.is_none() {
                        models.iter().find(|model| model["isDefault"] == true)
                    } else {
                        None
                    }
                });
            let supported = model.is_some_and(|model| {
                model["supportedReasoningEfforts"]
                    .as_array()
                    .is_some_and(|efforts| efforts.iter().any(|e| e["reasoningEffort"] == effort))
            });
            if effort.is_empty() {
                self.control(
                    json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":null}),
                )
                .await?;
            } else {
                if !supported {
                    return Err(rejected(
                        "This Claude model does not advertise the requested reasoning effort",
                    ));
                }
                let tokens = match effort {
                    "low" => 4000,
                    "medium" => 10000,
                    "high" => 20000,
                    "xhigh" | "max" => 31999,
                    _ => return Err(rejected("Unsupported Claude reasoning effort")),
                };
                self.control(
                    json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":tokens}),
                )
                .await?;
            }
        }
        self.mode(params["mode"].as_str().unwrap_or("craft"))
            .await?;
        let input = params["input"]
            .as_array()
            .filter(|input| {
                !input.is_empty()
                    && input.iter().all(|part| {
                        (part["type"] == "text" && part["text"].is_string())
                            || (part["type"] == "image"
                                && part["source"]["type"] == "base64"
                                && matches!(
                                    part["source"]["media_type"].as_str(),
                                    Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
                                )
                                && part["source"]["data"].is_string())
                    })
            })
            .ok_or_else(|| rejected("Claude text or base64 raster image input required"))?;
        let id = uuid::Uuid::new_v4().to_string();
        *self.run.lock().unwrap() = Some(Run {
            id: id.clone(),
            items: HashMap::new(),
            item_bytes: 0,
            message: id.clone(),
            cancelled: false,
            timeout: None,
        });
        self.native.store(true, Ordering::Release);
        self.notify("turn/started", json!({"turn":{"id":id}}));
        self.write(json!({"type":"user","session_id":self.thread,"message":{"role":"user","content":input},"parent_tool_use_id":null})).await?;
        let weak = Arc::downgrade(self);
        let turn = id.clone();
        let timeout = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
            if let Some(c) = weak.upgrade() {
                let active = c
                    .run
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|run| run.id == turn);
                if active {
                    c.close("Claude turn timed out; inspect outcome before retrying; prompts were not rerun");
                }
            }
        });
        if let Some(run) = self.run.lock().unwrap().as_mut() {
            run.timeout = Some(timeout.abort_handle());
        } else {
            timeout.abort();
        }
        Ok(json!({"turn":{"id":id}}))
    }
    fn item(&self, mut item: Value) {
        item = super::scrub(&item, 0, &mut 500_000);
        let mut guard = self.run.lock().unwrap();
        let Some(run) = guard.as_mut() else {
            return;
        };
        let id = format!("{}:{}", run.id, item["id"].as_str().unwrap_or("unknown"));
        item["id"] = json!(id);
        let old_bytes = run
            .items
            .get(&id)
            .map(|item| item.to_string().len())
            .unwrap_or(0);
        if let Some(existing) = run.items.get(&id) {
            let mut merged = existing.clone();
            if let Some(fields) = item.as_object() {
                for (k, v) in fields {
                    merged[k] = v.clone();
                }
            }
            item = merged;
        }
        let item_bytes = item.to_string().len();
        let total = run
            .item_bytes
            .saturating_sub(old_bytes)
            .saturating_add(item_bytes);
        if total > 2_000_000 || (old_bytes == 0 && run.items.len() >= 2000) {
            drop(guard);
            self.close("Claude turn output limit exceeded; inspect outcome before retrying; prompts were not rerun");
            return;
        }
        run.item_bytes = total;
        run.items.insert(id, item.clone());
        drop(guard);
        self.notify("item/completed", json!({"item":item}));
    }
    fn block(&self, block: &Value, index: usize, message: &str, parent: Option<&str>) {
        let mut item = match block["type"].as_str() {
            Some("text" | "thinking") => {
                json!({"id":format!("{}{}:{index}",parent.map(|p|format!("{p}:")).unwrap_or_default(),message),"type":if block["type"]=="text"{"agentMessage"}else{"reasoning"},"text":block.get("text").or_else(||block.get("thinking")).cloned().unwrap_or(json!(""))})
            }
            Some("tool_use") => {
                json!({"id":block["id"],"type":if matches!(block["name"].as_str(),Some("Task"|"Agent")){"collabToolCall"}else{"mcpToolCall"},"command":block["name"],"tool":block["name"],"arguments":block["input"],"status":"inProgress"})
            }
            Some("tool_result") => {
                json!({"id":block["tool_use_id"],"result":block["content"],"status":if block["is_error"]==true{"failed"}else{"completed"}})
            }
            _ => return,
        };
        if let Some(parent) = parent {
            item["parentToolUseId"] = json!(parent);
        }
        self.item(item);
    }
    async fn message(&self, message: Value) -> Result<(), String> {
        match message["type"].as_str() {
            Some("control_response") => {
                let response = &message["response"];
                let id = response["request_id"]
                    .as_str()
                    .ok_or("Invalid Claude control response ID")?;
                if let Some(pending) = self.pending.lock().unwrap().remove(id) {
                    let _ = pending.send(if response["subtype"] == "error" {
                        Err(rejected(
                            response["error"]
                                .as_str()
                                .unwrap_or("Claude rejected control request"),
                        ))
                    } else {
                        Ok(response.get("response").cloned().unwrap_or(json!({})))
                    });
                }
                return Ok(());
            }
            Some("control_request") => {
                let native_id = message["request_id"]
                    .as_str()
                    .filter(|id| id.len() <= 1024)
                    .ok_or("Invalid Claude request ID")?;
                let request = &message["request"];
                let key = format!("{}:{native_id}", self.thread);
                if request["subtype"] != "can_use_tool" || self.run.lock().unwrap().is_none() {
                    return self.write(json!({"type":"control_response","response":{"subtype":"error","request_id":native_id,"error":"Client control method unsupported"}})).await;
                }
                let questions = request["tool_name"] == "AskUserQuestion";
                let visible_input = super::scrub(&request["input"], 0, &mut 500_000);
                let mut params = json!({"threadId":self.thread,"command":format!("{}\n{}",request["tool_name"].as_str().unwrap_or("Tool"),visible_input),"readOnly":matches!(request["tool_name"].as_str(),Some("Read"|"Glob"|"Grep"|"WebSearch"|"WebFetch")),"requiresUserDecision":request["tool_name"]=="ExitPlanMode","availableDecisions":["accept","decline","cancel"]});
                if questions {
                    let mut normalized = vec![];
                    let questions = request["input"]["questions"]
                        .as_array()
                        .filter(|questions| !questions.is_empty() && questions.len() <= 32)
                        .ok_or("Invalid Claude question count")?;
                    for (index, q) in questions.iter().enumerate() {
                        let mut q = q.clone();
                        q["id"] = json!(index.to_string());
                        normalized.push(q);
                    }
                    params["questions"] = json!(normalized);
                }
                {
                    let mut permissions = self.permissions.lock().unwrap();
                    if permissions.len() >= 32 {
                        return Err("Claude approval limit exceeded".into());
                    }
                    permissions.insert(key.clone(), (native_id.into(), request.clone()));
                }
                if self
                    .events
                    .send(HarnessEvent::Request {
                        id: json!(key),
                        method: if questions {
                            "item/tool/requestUserInput"
                        } else {
                            "item/commandExecution/requestApproval"
                        }
                        .into(),
                        params,
                    })
                    .is_err()
                {
                    return Err("Claude event consumer disconnected".into());
                }
                return Ok(());
            }
            Some("control_cancel_request") => {
                if let Some(native_id) = message["request_id"].as_str() {
                    let id = format!("{}:{native_id}", self.thread);
                    self.permissions.lock().unwrap().remove(&id);
                    self.notify("serverRequest/resolved", json!({"requestId":id}));
                }
                return Ok(());
            }
            Some("system") if message["subtype"] == "init" => {
                if message["session_id"]
                    .as_str()
                    .is_some_and(|id| id != self.thread)
                {
                    return Err("Claude session identity mismatch".into());
                }
                return Ok(());
            }
            _ => {}
        }
        if self.run.lock().unwrap().is_none() {
            if message["type"] == "result"
                && (message["is_error"] == true || message["subtype"] != "success")
            {
                let error = rejected(
                    message["result"]
                        .as_str()
                        .unwrap_or("Claude startup failed"),
                );
                for (_, pending) in self.pending.lock().unwrap().drain() {
                    let _ = pending.send(Err(error.clone()));
                }
            }
            return Ok(());
        }
        let parent = message["parent_tool_use_id"]
            .as_str()
            .filter(|p| !p.is_empty());
        match message["type"].as_str() {
            Some("assistant" | "user") => {
                let id = message["message"]["id"]
                    .as_str()
                    .or_else(|| message["uuid"].as_str())
                    .unwrap_or("message");
                let blocks = message["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                for (index, block) in blocks.iter().enumerate() {
                    if message["type"] == "assistant" || block["type"] == "tool_result" {
                        // Native complete messages can contain only one block
                        // even when streaming used a nonzero content index.
                        // Reconcile by message, block type and final text.
                        let index = if blocks.len() == 1
                            && matches!(block["type"].as_str(), Some("text" | "thinking"))
                        {
                            let kind = if block["type"] == "text" {
                                "agentMessage"
                            } else {
                                "reasoning"
                            };
                            let text = block["text"]
                                .as_str()
                                .or_else(|| block["thinking"].as_str())
                                .unwrap_or("");
                            let run = self.run.lock().unwrap();
                            run.as_ref()
                                .and_then(|run| {
                                    let prefix = format!(
                                        "{}:{}{}:",
                                        run.id,
                                        parent.map(|p| format!("{p}:")).unwrap_or_default(),
                                        id
                                    );
                                    let candidates = run
                                        .items
                                        .iter()
                                        .filter(|(key, item)| {
                                            key.starts_with(&prefix) && item["type"] == kind
                                        })
                                        .collect::<Vec<_>>();
                                    let matching = candidates
                                        .iter()
                                        .find(|(_, item)| item["text"] == text)
                                        .copied()
                                        .or_else(|| {
                                            if candidates.len() == 1 {
                                                candidates.first().copied()
                                            } else {
                                                None
                                            }
                                        });
                                    matching.and_then(|(key, _)| {
                                        key.rsplit(':').next()?.parse::<usize>().ok()
                                    })
                                })
                                .unwrap_or(index)
                        } else {
                            index
                        };
                        self.block(block, index, id, parent);
                    }
                }
            }
            Some("stream_event") => {
                let event = &message["event"];
                if event["type"] == "message_start" {
                    if let Some(id) = event["message"]["id"].as_str() {
                        if let Some(run) = self.run.lock().unwrap().as_mut() {
                            run.message = id.into();
                        }
                    }
                }
                let message_id = self
                    .run
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|run| run.message.clone())
                    .unwrap_or_default();
                let index = event["index"].as_u64().unwrap_or(0) as usize;
                if event["type"] == "content_block_start" {
                    self.block(&event["content_block"], index, &message_id, parent);
                }
                if event["type"] == "content_block_delta"
                    && matches!(
                        event["delta"]["type"].as_str(),
                        Some("text_delta" | "thinking_delta")
                    )
                {
                    let id = format!(
                        "{}{}:{index}",
                        parent.map(|p| format!("{p}:")).unwrap_or_default(),
                        message_id
                    );
                    let old = {
                        let run = self.run.lock().unwrap();
                        run.as_ref()
                            .and_then(|run| run.items.get(&format!("{}:{id}", run.id)))
                            .and_then(|item| item["text"].as_str())
                            .unwrap_or("")
                            .to_string()
                    };
                    let delta = event["delta"]["text"]
                        .as_str()
                        .or_else(|| event["delta"]["thinking"].as_str())
                        .unwrap_or("");
                    let text = format!("{old}{delta}");
                    let text = text
                        .chars()
                        .rev()
                        .take(131072)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>();
                    let mut item = json!({"id":id,"type":if event["delta"]["type"]=="text_delta"{"agentMessage"}else{"reasoning"},"text":text});
                    if let Some(parent) = parent {
                        item["parentToolUseId"] = json!(parent);
                    }
                    self.item(item);
                }
            }
            Some("result") => {
                let has_text = self.run.lock().unwrap().as_ref().is_some_and(|run| {
                    run.items
                        .values()
                        .any(|item| item["type"] == "agentMessage")
                });
                if !has_text {
                    if let Some(text) = message["result"].as_str() {
                        self.item(json!({"id":"result","type":"agentMessage","text":text}));
                    }
                }
                let failed = message["is_error"] == true
                    || message["subtype"] != "success"
                    || message["permission_denials"]
                        .as_array()
                        .is_some_and(|p| !p.is_empty());
                let error = if failed {
                    Some(
                        message["result"]
                            .as_str()
                            .unwrap_or("Claude turn failed or tool permission denied")
                            .to_string(),
                    )
                } else {
                    None
                };
                self.finish(if failed { "failed" } else { "completed" }, error);
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(&self, status: &str, error: Option<String>) {
        let Some(run) = self.run.lock().unwrap().take() else {
            return;
        };
        if let Some(timeout) = run.timeout {
            timeout.abort();
        }
        let mut turn = json!({"id":run.id,"status":if run.cancelled{"interrupted"}else{status}});
        if let Some(error) = error {
            turn["error"] = json!({"message":error.chars().take(2000).collect::<String>()});
        }
        self.permissions.lock().unwrap().clear();
        self.notify("turn/completed", json!({"turn":turn}));
    }
    fn close(&self, message: &str) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        for (_, pending) in self.pending.lock().unwrap().drain() {
            let _ = pending.send(Err(message.chars().take(2000).collect()));
        }
        self.finish("failed", Some(message.into()));
        let _ = self.stop.send(true);
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

fn normalize_models(raw: &Value) -> Vec<Value> {
    raw.as_array().into_iter().flatten().filter_map(|model| {
        let id = model["value"].as_str().or_else(|| model["id"].as_str())
            .filter(|id| !id.is_empty() && id.len() <= 512)?;
        let mut normalized = json!({"id":id,"displayName":model["displayName"].as_str().or_else(||model["name"].as_str()).unwrap_or(id)});
        if let Some(description) = model["description"].as_str() {
            normalized["description"] = json!(description);
        }
        if let Some(default) = model["isDefault"].as_bool() {
            normalized["isDefault"] = json!(default);
        }
        if model["supportsEffort"] != false {
            let efforts = model["supportedReasoningEfforts"].as_array()
                .or_else(|| model["supportedEffortLevels"].as_array())
                .into_iter().flatten().filter_map(|effort| {
                    let id = effort.as_str().or_else(|| effort["reasoningEffort"].as_str())
                        .or_else(|| effort["value"].as_str())?;
                    // These are the native levels this adapter can apply through
                    // set_max_thinking_tokens. Unknown native levels stay hidden.
                    if !["low", "medium", "high", "xhigh", "max"].contains(&id) { return None; }
                    Some(json!({"reasoningEffort":id,"displayName":effort["displayName"].as_str().or_else(||effort["name"].as_str()).unwrap_or(id)}))
                }).take(32).collect::<Vec<_>>();
            if !efforts.is_empty() {
                if let Some(default) = model["defaultReasoningEffort"].as_str()
                    .or_else(||model["defaultEffort"].as_str())
                    .filter(|default|efforts.iter().any(|effort|effort["reasoningEffort"] == *default)) {
                    normalized["defaultReasoningEffort"] = json!(default);
                }
                normalized["supportedReasoningEfforts"] = json!(efforts);
            }
        }
        Some(normalized)
    }).take(1000).collect()
}
