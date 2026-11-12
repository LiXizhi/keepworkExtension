//! Native agy NDJSON. Conversation processes and scoped MCP configuration are
//! owned by this host; uncertain prompts are never automatically submitted again.
use super::discovery::{child_path, definition, CliLaunch};
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
type Ready = oneshot::Sender<Result<String, String>>;

pub(super) struct Antigravity {
    launch: CliLaunch,
    cwd: PathBuf,
    events: broadcast::Sender<HarnessEvent>,
    connections: AsyncMutex<HashMap<String, Arc<Connection>>>,
    models: AsyncMutex<Option<Value>>,
    stop: watch::Sender<bool>,
    closing: AtomicBool,
}

struct Run {
    id: String,
    items: HashMap<String, Value>,
    bytes: usize,
    timeout: Option<tokio::task::AbortHandle>,
}

struct Connection {
    thread: String,
    config: Value,
    native: Mutex<Option<String>>,
    ready: Mutex<Option<Ready>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    run: Mutex<Option<Run>>,
    events: broadcast::Sender<HarnessEvent>,
    stop: watch::Sender<bool>,
    alive: AtomicBool,
    terminated: AtomicBool,
    stopped: Notify,
    runtime: Option<PathBuf>,
}

fn rejected(message: &str) -> String {
    format!(
        "Native RPC rejected: {}",
        message.chars().take(2000).collect::<String>()
    )
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

fn command(launch: &CliLaunch, cwd: &Path) -> Command {
    let mut command = Command::new(&launch.executable);
    let flags = definition("gemini").unwrap().args;
    let args = if launch
        .args
        .ends_with(&flags.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    {
        &launch.args[..launch.args.len() - flags.len()]
    } else {
        &launch.args[..]
    };
    command
        .args(args)
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

impl Antigravity {
    pub fn new(
        launch: CliLaunch,
        cwd: &Path,
        events: broadcast::Sender<HarnessEvent>,
    ) -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            launch,
            cwd: cwd.into(),
            events,
            connections: AsyncMutex::new(HashMap::new()),
            models: AsyncMutex::new(None),
            stop,
            closing: AtomicBool::new(false),
        })
    }

    async fn models(&self, refresh: bool) -> Result<Value, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err(rejected("Antigravity service is stopping"));
        }
        let mut stopped = self.stop.subscribe();
        let mut cache = self.models.lock().await;
        if !refresh {
            if let Some(models) = &*cache {
                return Ok(models.clone());
            }
        }
        *cache = None;
        let mut cmd = command(&self.launch, &self.cwd);
        cmd.arg("models");
        let mut child = cmd.spawn().map_err(|_| {
            rejected("Antigravity models could not start; run agy to check installation and login")
        })?;
        child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or("Antigravity model output unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Antigravity diagnostics unavailable")?;
        let drain = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            while matches!(stderr.read(&mut chunk).await, Ok(n) if n > 0) {}
        });
        let query = tokio::time::timeout(Duration::from_secs(60), async {
            let mut bytes = Vec::new();
            stdout
                .take(1_048_577)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| rejected("Antigravity model output disconnected"))?;
            if bytes.len() > 1_048_576 {
                return Err(rejected("Antigravity model output limit exceeded"));
            }
            let status = child
                .wait()
                .await
                .map_err(|_| rejected("Antigravity models disconnected"))?;
            if !status.success() {
                return Err(rejected("Antigravity model query failed. Run agy in a terminal to check login, then reconnect."));
            }
            let text = String::from_utf8(bytes)
                .map_err(|_| rejected("Invalid Antigravity model output"))?;
            let ansi = regex::Regex::new(r"\x1b\[[0-9;]*m").unwrap();
            let row = regex::Regex::new(r"^([\w][\w./:-]*)\t+(.+)$").unwrap();
            let text = ansi.replace_all(&text, "");
            let data = text
                .lines()
                .filter_map(|line| row.captures(line.trim()))
                .take(1000)
                .map(|m| json!({"id":&m[1],"displayName":&m[2],"supportedReasoningEfforts":[]}))
                .collect::<Vec<_>>();
            if data.is_empty() {
                return Err(rejected(
                    "Antigravity returned no models. Run agy to sign in, then reconnect.",
                ));
            }
            Ok(json!({"data":data}))
        });
        let result = tokio::select! {
            result = query => result.unwrap_or_else(|_| Err(rejected("Antigravity model query timed out; no prompt was submitted"))),
            _ = stopped.changed() => Err(rejected("Antigravity model discovery stopped; no prompt was submitted")),
        };
        if child.id().is_some() {
            super::harness::stop_child(&mut child).await;
        }
        drain.abort();
        if let Ok(models) = &result {
            *cache = Some(models.clone());
        }
        result
    }

    async fn boot(
        &self,
        thread: &str,
        config: Value,
        native: Option<String>,
    ) -> Result<Arc<Connection>, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err(rejected("Antigravity service is stopping"));
        }
        let mut connections = self.connections.lock().await;
        let mut native = native;
        if let Some(old) = connections.get(thread) {
            if old.alive.load(Ordering::Acquire) && old.config == config {
                return Ok(old.clone());
            }
            if old.run.lock().unwrap().is_some() {
                return Err(rejected("Antigravity session already running"));
            }
            native = old.native.lock().unwrap().clone().or(native);
            old.close("Antigravity configuration changed; prompts were not rerun");
        }
        if connections
            .values()
            .filter(|c| c.alive.load(Ordering::Acquire))
            .count()
            >= 16
        {
            let idle = connections
                .values()
                .find(|c| c.alive.load(Ordering::Acquire) && c.run.lock().unwrap().is_none())
                .cloned()
                .ok_or_else(|| rejected("Antigravity concurrent session limit reached"))?;
            idle.close("Idle Antigravity connection retired");
        }
        let c = Connection::start(
            &self.launch,
            thread,
            config,
            native,
            self.events.clone(),
            self.stop.subscribe(),
        )
        .await?;
        // Retain identity/config for retired conversations so explicit continuation
        // always resumes the exact native conversation rather than creating one.
        connections.insert(thread.into(), c.clone());
        Ok(c)
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value, String> {
        match method {
            "model/list" => return self.models(params["refresh"] == true).await,
            "account/read" => {
                self.models(params["refresh"] == true).await?;
                return Ok(json!({"account":{"type":"cli"}}));
            }
            "thread/start" | "thread/resume" => {
                let thread = if method == "thread/start" {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    params["threadId"]
                        .as_str()
                        .filter(|id| valid_id(id))
                        .ok_or_else(|| rejected("Invalid Antigravity thread ID"))?
                        .into()
                };
                if method == "thread/resume" && params["driver"] != "antigravity-v1" {
                    return Err(rejected("This is a saved Gemini CLI conversation. Its history is preserved; start a new Antigravity chat to continue."));
                }
                let native = params["nativeId"]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .map(str::to_owned);
                if method == "thread/resume" && native.is_none() && params["allowEmpty"] != true {
                    return Err(rejected("Antigravity conversation identity is unavailable; preserve history and start a new chat."));
                }
                let mut config = json!({"cwd":self.cwd,"roots":[self.cwd]});
                for key in ["cwd", "roots", "mode", "model", "effort", "mcpServers"] {
                    if let Some(value) = params.get(key) {
                        config[key] = value.clone();
                    }
                }
                let c = self
                    .boot(&thread, config, native)
                    .await
                    .map_err(|error| rejected(&error))?;
                let mut metadata = json!({"thread":{"id":thread},"driver":"antigravity-v1","nativeId":c.native.lock().unwrap().clone()});
                for key in ["cwd", "roots", "mode", "model", "effort"] {
                    if let Some(value) = c.config.get(key) {
                        metadata[key] = value.clone();
                    }
                }
                return Ok(metadata);
            }
            _ => {}
        }
        let thread = params["threadId"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| rejected("Invalid Antigravity thread ID"))?;
        let old = self
            .connections
            .lock()
            .await
            .get(thread)
            .cloned()
            .ok_or_else(|| rejected("Antigravity session must be restored before sending"))?;
        if method == "turn/interrupt" {
            old.finish("interrupted", None);
            old.close("Antigravity interrupted; prompts were not rerun");
            return Ok(json!({}));
        }
        if method != "turn/start" {
            return Err(rejected("Unsupported Antigravity harness method"));
        }
        let input = params["input"]
            .as_array()
            .filter(|input| {
                !input.is_empty()
                    && input
                        .iter()
                        .all(|part| part["type"] == "text" && part["text"].is_string())
            })
            .ok_or_else(|| rejected("Antigravity supports text input only"))?;
        let mut config = old.config.clone();
        for key in ["model", "effort", "mode"] {
            if let Some(value) = params.get(key) {
                config[key] = value.clone();
            }
        }
        if config["effort"].as_str().is_some_and(|e| {
            !e.is_empty() && !["low", "medium", "high", "xhigh", "max"].contains(&e)
        }) {
            return Err(rejected("Unsupported Antigravity effort"));
        }
        let native = old.native.lock().unwrap().clone();
        let c = self
            .boot(thread, config, native)
            .await
            .map_err(|error| rejected(&error))?;
        let text = input
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        c.turn(text).await
    }

    pub async fn respond(&self) -> Result<(), String> {
        Err(rejected("Antigravity headless mode does not support interactive permission responses; use agy native /permissions settings."))
    }
    pub fn close(&self) {
        self.closing.store(true, Ordering::Release);
        // Every child observes this independently of the connection-map lock,
        // including while another conversation is still waiting for init.
        self.stop.send_replace(true);
        if let Ok(connections) = self.connections.try_lock() {
            for c in connections.values() {
                c.close("Antigravity closed; prompts were not rerun");
            }
        }
    }
    pub async fn shutdown(&self) {
        self.close();
        let connections = self
            .connections
            .lock()
            .await
            .drain()
            .map(|(_, c)| c)
            .collect::<Vec<_>>();
        for c in &connections {
            c.close("Antigravity closed; prompts were not rerun");
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
}

impl Connection {
    async fn start(
        launch: &CliLaunch,
        thread: &str,
        config: Value,
        native: Option<String>,
        events: broadcast::Sender<HarnessEvent>,
        mut owner_stop: watch::Receiver<bool>,
    ) -> Result<Arc<Self>, String> {
        if *owner_stop.borrow_and_update() {
            return Err(rejected("Antigravity service is stopping"));
        }
        let workspace = config["cwd"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.is_absolute() && p.is_dir())
            .ok_or_else(|| rejected("Existing absolute Antigravity workspace required"))?;
        let scoped = config["mcpServers"]
            .as_array()
            .is_some_and(|s| !s.is_empty());
        let runtime = if scoped {
            let dir = std::env::temp_dir().join(format!("keepwork-agy-{}", uuid::Uuid::new_v4()));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&dir)
                .map_err(|_| rejected("Antigravity scoped workspace unavailable"))?;
            Some(dir)
        } else {
            None
        };
        let (ready, receiver) = oneshot::channel();
        let (stop, mut stopped) = watch::channel(false);
        let c = Arc::new(Self {
            thread: thread.into(),
            config: config.clone(),
            native: Mutex::new(native.clone()),
            ready: Mutex::new(Some(ready)),
            stdin: AsyncMutex::new(None),
            run: Mutex::new(None),
            events,
            stop,
            alive: AtomicBool::new(true),
            terminated: AtomicBool::new(false),
            stopped: Notify::new(),
            runtime,
        });
        let cwd = c.runtime.as_deref().unwrap_or(workspace);
        let mut cmd = command(launch, cwd);
        cmd.args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--disable-slash-commands",
        ]);
        if let Some(native) = native {
            cmd.args(["--conversation", &native]);
        }
        let roots = config["roots"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![json!(workspace)]);
        for root in &roots {
            if let Some(root) = root.as_str().filter(|root| Path::new(root) != cwd) {
                cmd.args(["--add-dir", root]);
            }
        }
        for (key, flag) in [("model", "--model"), ("effort", "--effort")] {
            if let Some(value) = config[key].as_str().filter(|v| !v.is_empty()) {
                cmd.args([flag, value]);
            }
        }
        if matches!(config["mode"].as_str(), Some("ask" | "plan")) {
            cmd.args(["--mode", "plan"]);
        }
        if scoped {
            let mut servers = serde_json::Map::new();
            for server in config["mcpServers"].as_array().unwrap() {
                let name = server["name"]
                    .as_str()
                    .ok_or_else(|| rejected("Invalid Antigravity MCP descriptor"))?;
                for entry in server["env"].as_array().into_iter().flatten() {
                    cmd.env(
                        entry["name"]
                            .as_str()
                            .ok_or_else(|| rejected("Invalid Antigravity MCP environment"))?,
                        entry["value"]
                            .as_str()
                            .ok_or_else(|| rejected("Invalid Antigravity MCP environment"))?,
                    );
                }
                servers.insert(
                    name.into(),
                    json!({"command":server["command"],"args":server["args"]}),
                );
            }
            let dir = cwd.join(".agents");
            std::fs::create_dir(&dir)
                .map_err(|_| rejected("Antigravity scoped MCP directory unavailable"))?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            options
                .open(dir.join("mcp_config.json"))
                .and_then(|mut file| {
                    file.write_all(json!({"mcpServers":servers}).to_string().as_bytes())
                })
                .map_err(|_| rejected("Antigravity scoped MCP configuration unavailable"))?;
        }
        let mut child = cmd.spawn().map_err(|_| {
            rejected("Antigravity CLI could not start; check installation and native login")
        })?;
        *c.stdin.lock().await = child.stdin.take();
        let mut stdout = child
            .stdout
            .take()
            .ok_or("Antigravity output unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or("Antigravity diagnostics unavailable")?;
        let weak = Arc::downgrade(&c);
        let mut output = tokio::spawn(async move {
            let mut chunk = [0; 8192];
            let mut buffer = Vec::new();
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        if let Some(c) = weak.upgrade() {
                            c.close("Antigravity output disconnected; inspect outcome before retrying. Prompts were not rerun.");
                        }
                        break;
                    }
                    Ok(n) => {
                        for part in chunk[..n].split_inclusive(|b| *b == b'\n') {
                            let Some(c) = weak.upgrade() else {
                                return;
                            };
                            if buffer.len() + part.len() > MAX_FRAME {
                                c.close(
                                    "Antigravity output limit exceeded; prompts were not rerun",
                                );
                                return;
                            }
                            buffer.extend_from_slice(part);
                            if part.last() == Some(&b'\n') {
                                if buffer.iter().any(|b| !b.is_ascii_whitespace()) {
                                    let result = serde_json::from_slice::<Value>(&buffer)
                                        .map_err(|_| "Invalid Antigravity protocol output".into())
                                        .and_then(|m| c.message(m));
                                    if let Err(error) = result {
                                        c.close(&error);
                                        return;
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
            while matches!(stderr.read(&mut chunk).await, Ok(n) if n > 0) {}
        });
        let weak = Arc::downgrade(&c);
        tokio::spawn(async move {
            let message = tokio::select! { result = child.wait() => format!("Antigravity exited ({}); prompts were not rerun", result.map(|s| s.to_string()).unwrap_or_else(|_| "unknown".into())), _ = stopped.changed() => { super::harness::stop_child(&mut child).await; "Antigravity closed; prompts were not rerun".into() }, _ = owner_stop.changed() => { super::harness::stop_child(&mut child).await; "Antigravity service closed; prompts were not rerun".into() } };
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
        match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(Ok(_))) => Ok(c),
            other => {
                let error = match other {
                    Ok(Ok(Err(e))) => e,
                    _ => "Antigravity startup timed out or disconnected; no prompt was submitted"
                        .into(),
                };
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
    fn message(&self, message: Value) -> Result<(), String> {
        if !message.is_object() {
            return Err("Invalid Antigravity protocol output".into());
        }
        if message["event"] == "init" {
            let native = message["conversation_id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("Invalid Antigravity conversation identity")?;
            let mut current = self.native.lock().unwrap();
            if current.as_ref().is_some_and(|id| id != native) {
                return Err("Antigravity session identity mismatch".into());
            }
            *current = Some(native.into());
            if let Some(ready) = self.ready.lock().unwrap().take() {
                let _ = ready.send(Ok(native.into()));
            }
            return Ok(());
        }
        let event = message["event"].as_str().unwrap_or("");
        if !["step_update", "result"].contains(&event) {
            return Ok(());
        }
        let data = &message[event];
        if event == "result" && self.ready.lock().unwrap().is_some() {
            return Err(rejected(
                "Antigravity authentication or startup failed. Run agy to check login.",
            ));
        }
        let native = self.native.lock().unwrap().clone();
        if data["conversation_id"].as_str() != native.as_deref() || native.is_none() {
            return Err("Antigravity event identity mismatch".into());
        }
        let mut guard = self.run.lock().unwrap();
        let Some(run) = guard.as_mut() else {
            return Ok(());
        };
        if event == "step_update" {
            let index = data["step_index"]
                .as_u64()
                .ok_or("Invalid Antigravity step index")?;
            let id = format!("{}:{index}", run.id);
            if data["step_type"] == "agent_response" {
                if let Some(delta) = data["text_delta"].as_str() {
                    let previous = run
                        .items
                        .get(&id)
                        .and_then(|i| i["text"].as_str())
                        .unwrap_or("");
                    let text = format!("{previous}{delta}")
                        .chars()
                        .take(131_072)
                        .collect::<String>();
                    self.item(run, json!({"id":id,"type":"agentMessage","text":text}))?;
                }
            } else if data["step_type"] == "tool" {
                self.item(run, json!({"id":id,"type":"mcpToolCall","command":data.get("tool_name").unwrap_or(&data["tool_info"]["name"]),"arguments":data["tool_info"]["parameters"],"result":data["tool_info"]["output"],"status":if !data["tool_info"]["error"].is_null() && data["tool_info"]["error"] != false { "failed" } else if data["state"] == "DONE" { "completed" } else { "inProgress" }}))?;
            }
        } else {
            if !run.items.values().any(|i| i["type"] == "agentMessage") {
                if let Some(response) = data["response"].as_str() {
                    self.item(run, json!({"id":format!("{}:reply",run.id),"type":"agentMessage","text":response}))?;
                }
            }
            let denied = data["denied_actions"]
                .as_array()
                .is_some_and(|v| !v.is_empty());
            let success = data["status"] == "SUCCESS" && !denied;
            let status = if success {
                "completed"
            } else if !denied && matches!(data["status"].as_str(), Some("CANCELED" | "INTERRUPTED"))
            {
                "interrupted"
            } else {
                "failed"
            };
            let error = if denied {
                Some("Antigravity denied a tool under its native permissions. Open agy and use /permissions to allow the intended tool, then retry explicitly.".into())
            } else if success {
                None
            } else {
                Some(
                    data["error"]
                        .as_str()
                        .or_else(|| data["status"].as_str())
                        .unwrap_or("Antigravity turn failed")
                        .chars()
                        .take(2000)
                        .collect(),
                )
            };
            drop(guard);
            self.finish(status, error);
        }
        Ok(())
    }
    fn item(&self, run: &mut Run, item: Value) -> Result<(), String> {
        let item = super::scrub(&item, 0, &mut 500_000);
        let id = item["id"]
            .as_str()
            .ok_or("Invalid Antigravity item")?
            .to_string();
        let bytes = item.to_string().len();
        let total = run
            .bytes
            .saturating_sub(run.items.get(&id).map(|i| i.to_string().len()).unwrap_or(0))
            .saturating_add(bytes);
        if total > 2_000_000 || (!run.items.contains_key(&id) && run.items.len() >= 2000) {
            return Err("Antigravity turn output limit exceeded".into());
        }
        run.bytes = total;
        run.items.insert(id, item.clone());
        self.notify("item/completed", json!({"item":item}));
        Ok(())
    }
    async fn turn(self: &Arc<Self>, text: String) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut run = self.run.lock().unwrap();
            if run.is_some() {
                return Err(rejected("Antigravity session already running"));
            }
            *run = Some(Run {
                id: id.clone(),
                items: HashMap::new(),
                bytes: 0,
                timeout: None,
            });
        }
        self.notify("turn/started", json!({"turn":{"id":id}}));
        let context = if self.runtime.is_some() {
            format!("Primary workspace: {}\nAdditional roots: {}\nThe launch directory is host-owned; work in the primary workspace.\n\n", self.config["cwd"].as_str().unwrap_or(""), self.config["roots"].as_array().into_iter().flatten().skip(1).filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
        } else {
            String::new()
        };
        let mut bytes = serde_json::to_vec(
            &json!({"event":"user","message":{"content":format!("{context}{text}")}}),
        )
        .map_err(|_| rejected("Invalid Antigravity message"))?;
        if bytes.len() > MAX_FRAME {
            self.finish("failed", Some("Antigravity input limit exceeded".into()));
            return Err(rejected("Antigravity input limit exceeded"));
        }
        bytes.push(b'\n');
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            self.stdin
                .lock()
                .await
                .as_mut()
                .ok_or("Antigravity input closed".to_string())?
                .write_all(&bytes)
                .await
                .map_err(|_| {
                    "Antigravity input disconnected; submission outcome is unknown".to_string()
                })
        })
        .await
        .map_err(|_| "Antigravity input timed out; submission outcome is unknown".to_string())
        .and_then(|r| r);
        if let Err(error) = result {
            self.close(&error);
            return Err(error);
        }
        let weak = Arc::downgrade(self);
        let turn = id.clone();
        let timeout = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
            if let Some(c) = weak.upgrade() {
                if c.run.lock().unwrap().as_ref().is_some_and(|r| r.id == turn) {
                    c.close("Antigravity turn timed out; prompts were not rerun");
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
    fn finish(&self, status: &str, error: Option<String>) {
        if let Some(run) = self.run.lock().unwrap().take() {
            if let Some(timeout) = run.timeout {
                timeout.abort();
            }
            self.notify("turn/completed", json!({"turn":{"id":run.id,"status":status,"error":error.map(|message| json!({"message":message}))}}));
        }
    }
    fn close(&self, message: &str) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Some(ready) = self.ready.lock().unwrap().take() {
            let _ = ready.send(Err(message.into()));
        }
        self.finish("failed", Some(message.into()));
        let _ = self.stop.send(true);
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(dir) = &self.runtime {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closing_during_init_stops_existing_and_starting_conversations() {
        let dir = std::env::temp_dir().join(format!("kp-agy-lifecycle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("agy.cjs");
        std::fs::write(&script, r#"const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('slow')) fs.writeFileSync(args[0],String(process.pid));
else console.log(JSON.stringify({event:'init',conversation_id:require('node:crypto').randomUUID()}));
process.stdin.resume();"#).unwrap();
        let marker = dir.join("slow-started");
        let node = super::super::discovery::search_dirs()
            .into_iter()
            .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|path| path.is_file())
            .expect("Node.js is required for native fixtures");
        let launch = CliLaunch {
            executable: node,
            args: vec![
                script.to_string_lossy().into_owned(),
                marker.to_string_lossy().into_owned(),
            ],
            path: script,
            source: "fixture".into(),
        };
        let (events, _) = broadcast::channel(128);
        let adapter = Antigravity::new(launch, &dir, events);
        let thread = adapter
            .call("thread/start", json!({"cwd":dir}), Duration::from_secs(3))
            .await
            .unwrap();
        let first =
            adapter.connections.lock().await[thread["thread"]["id"].as_str().unwrap()].clone();
        let starting = {
            let adapter = adapter.clone();
            let dir = dir.clone();
            tokio::spawn(async move {
                adapter
                    .call(
                        "thread/start",
                        json!({"cwd":dir,"model":"slow"}),
                        Duration::from_secs(3),
                    )
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        // boot currently holds the map lock waiting for init. Closing must still
        // signal both children without waiting for the startup timeout.
        adapter.close();
        assert!(tokio::time::timeout(Duration::from_secs(3), starting)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        adapter.shutdown().await;
        assert!(!first.alive.load(Ordering::Acquire));
        assert!(first.terminated.load(Ordering::Acquire));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
