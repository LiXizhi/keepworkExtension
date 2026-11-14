//! Open-source Trae Agent's one-shot CLI. A wrapper conversation supplies text
//! context; it does not claim to resume a native CLI session or replay work.
use super::discovery::{child_path, CliLaunch};
use super::harness::HarnessEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{broadcast, watch, Notify};

const MAX_TRAJECTORY: u64 = 16 * 1024 * 1024;
pub(super) struct Trae {
    launch: CliLaunch,
    cwd: PathBuf,
    events: broadcast::Sender<HarnessEvent>,
    threads: Mutex<HashMap<String, Value>>,
    running: Mutex<HashMap<String, Arc<Run>>>,
    closing: AtomicBool,
}
struct Run {
    id: String,
    stop: watch::Sender<bool>,
    stopped: Notify,
    terminated: AtomicBool,
}
fn rejected(message: &str) -> String {
    format!("Native RPC rejected: {message}")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn validate(params: &Value) -> Result<(), String> {
    if !params["mcpServers"].is_null()
        && !params["mcpServers"]
            .as_array()
            .is_some_and(|s| s.is_empty())
    {
        return Err(rejected("UNSUPPORTED_FEATURE: Trae Agent does not support the scoped AIChat MCP connection. Use a plain local workspace session."));
    }
    if params["mode"]
        .as_str()
        .is_some_and(|m| !m.is_empty() && m != "craft")
    {
        return Err(rejected("UNSUPPORTED_FEATURE: Trae Agent cannot enforce Ask or Plan mode; select Craft or another agent."));
    }
    if params["effort"].as_str().is_some_and(|e| !e.is_empty()) {
        return Err(rejected(
            "UNSUPPORTED_FEATURE: Trae Agent has no reasoning effort selection.",
        ));
    }
    if params["sandbox"] == "read-only"
        || params["sandboxPolicy"]["type"]
            .as_str()
            .is_some_and(|s| matches!(s, "readOnly" | "read-only" | "read_only"))
    {
        return Err(rejected(
            "UNSUPPORTED_FEATURE: Trae Agent cannot enforce read-only execution.",
        ));
    }
    Ok(())
}
fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut f| f.write_all(data))
        .map_err(|_| rejected("Trae Agent task file unavailable; no prompt was submitted"))
}

async fn stop_owned_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    let group = child.id();
    super::harness::stop_child(child).await;
    #[cfg(unix)]
    if let Some(group) = group {
        // A tool may outlive the CLI or ignore SIGTERM. Finish stopping the
        // process group created for this one owned task before publishing Stop.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{group}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

impl Trae {
    pub fn new(
        launch: CliLaunch,
        cwd: &Path,
        events: broadcast::Sender<HarnessEvent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            launch,
            cwd: cwd.into(),
            events,
            threads: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
        })
    }
    fn notify(&self, method: &str, thread: &str, params: Value) {
        let mut params = params;
        params["threadId"] = json!(thread);
        let _ = self.events.send(HarnessEvent::Notification {
            method: method.into(),
            params,
        });
    }
    pub async fn call(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        _timeout: Duration,
    ) -> Result<Value, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err(rejected("Trae Agent service is stopping"));
        }
        match method {
            "account/read" => return Ok(json!({"authUnknown":true,"probe":"executable"})),
            "model/list" => return Ok(json!({"data":[]})),
            "account/login/start" => return Err(rejected("Trae Agent uses provider API keys in its native configuration; it has no account login command.")),
            "thread/start" | "thread/resume" => {
                validate(&params)?;
                if method == "thread/resume" && params["driver"] != "trae-agent-v1" {
                    return Err(rejected("This is saved TraeCode ACP history. Its history is preserved; start a new Trae Agent conversation to continue."));
                }
                let id = if method == "thread/start" { uuid::Uuid::new_v4().to_string() } else {
                    params["threadId"].as_str().filter(|id| valid_id(id)).ok_or_else(|| rejected("Invalid Trae Agent thread ID"))?.into()
                };
                let mut config = params.clone(); config["cwd"] = params.get("cwd").cloned().unwrap_or_else(|| json!(self.cwd));
                self.threads.lock().unwrap().insert(id.clone(), config);
                return Ok(json!({"thread":{"id":id},"driver":"trae-agent-v1"}));
            }
            "thread/list" | "thread/native/list" | "thread/native/read" => return Err(rejected("UNSUPPORTED_FEATURE: Trae Agent has no native session catalog or load API.")),
            _ => {}
        }
        let thread = params["threadId"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| rejected("Invalid Trae Agent thread ID"))?;
        if method == "turn/interrupt" || method == "thread/archive" {
            if let Some(run) = self.running.lock().unwrap().get(thread) {
                run.stop.send_replace(true);
            }
            return Ok(json!({}));
        }
        let config = self
            .threads
            .lock()
            .unwrap()
            .get(thread)
            .cloned()
            .ok_or_else(|| rejected("Trae Agent session must be restored before sending"))?;
        if method != "turn/start" {
            return Err(rejected("Unsupported Trae Agent harness method"));
        }
        validate(&params)?;
        validate(&config)?;
        let input = params["input"]
            .as_array()
            .filter(|parts| {
                !parts.is_empty()
                    && parts
                        .iter()
                        .all(|p| p["type"] == "text" && p["text"].is_string())
            })
            .ok_or_else(|| rejected("UNSUPPORTED_FEATURE: Trae Agent supports text input only."))?;
        let task = input
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        if task.len() > 1_048_576 {
            return Err(rejected("Trae Agent task limit exceeded"));
        }
        let cwd = config["cwd"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.is_absolute() && p.is_dir())
            .ok_or_else(|| rejected("Existing absolute Trae Agent workspace required"))?;
        let mut running = self.running.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return Err(rejected("Trae Agent service is stopping"));
        }
        if running.contains_key(thread) {
            return Err(rejected("Trae Agent session already running"));
        }
        if running.len() >= 4 {
            return Err(rejected("Trae Agent concurrent session limit reached"));
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let directory = std::env::temp_dir().join(format!("keepwork-trae-{run_id}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| rejected("Trae Agent temporary workspace unavailable"))?;
        let task_file = directory.join("task.txt");
        let trajectory = directory.join("trajectory.json");
        if let Err(error) = write_private(&task_file, task.as_bytes()) {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
        let mut command = Command::new(&self.launch.executable);
        command
            .args(&self.launch.args)
            .args(["run", "--file"])
            .arg(&task_file)
            .arg("--working-dir")
            .arg(cwd)
            .arg("--trajectory-file")
            .arg(&trajectory)
            .args(["--console-type", "simple"]);
        if let Some(model) = params["model"]
            .as_str()
            .or(config["model"].as_str())
            .filter(|m| !m.is_empty())
        {
            command.arg("--model").arg(model);
        }
        command
            .current_dir(cwd)
            .env(
                if cfg!(windows) { "Path" } else { "PATH" },
                child_path(&self.launch),
            )
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::null())
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
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(rejected("Trae Agent CLI could not start; check trae-cli installation and native configuration."));
            }
        };
        let (stop, mut stopped) = watch::channel(false);
        let run = Arc::new(Run {
            id: run_id.clone(),
            stop,
            stopped: Notify::new(),
            terminated: AtomicBool::new(false),
        });
        running.insert(thread.into(), run.clone());
        drop(running);
        self.notify("turn/started", thread, json!({"turn":{"id":run_id}}));
        self.notify("item/completed", thread, json!({"item":{"id":format!("{run_id}:execution"),"type":"agentMessage","text":"Trae Agent starts an independent native task for each turn; native conversation state is not resumed."}}));
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        // Never send native diagnostics or configuration output to the browser.
        let mut output = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_TRAJECTORY + 1)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes.len() as u64 <= MAX_TRAJECTORY)
        });
        let mut diagnostics = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(MAX_TRAJECTORY + 1)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes.len() as u64 <= MAX_TRAJECTORY)
        });
        let this = self.clone();
        let thread = thread.to_string();
        tokio::spawn(async move {
            let mut seen = HashMap::<String, Value>::new();
            let mut poll = tokio::time::interval(Duration::from_millis(250));
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let deadline = tokio::time::sleep(Duration::from_secs(30 * 60));
            tokio::pin!(deadline);
            let (status, error, items) = loop {
                tokio::select! {
                    result = child.wait() => {
                        let output_ok = matches!(tokio::time::timeout(Duration::from_secs(2), &mut output).await, Ok(Ok(Ok(true)))) && matches!(tokio::time::timeout(Duration::from_secs(2), &mut diagnostics).await, Ok(Ok(Ok(true))));
                        output.abort(); diagnostics.abort();
                        break if !output_ok { ("failed", Some("Trae Agent output limit exceeded; inspect the workspace before retrying.".into()), vec![]) }
                        else { trajectory_result(&trajectory, result.is_ok_and(|s| s.success()), &run.id) };
                    },
                    _ = stopped.changed() => { stop_owned_child(&mut child).await; output.abort(); diagnostics.abort(); break ("interrupted", None, vec![]); },
                    _ = &mut deadline => { stop_owned_child(&mut child).await; output.abort(); diagnostics.abort(); break ("failed", Some("Trae Agent timed out; inspect the workspace before retrying. The task was not rerun.".into()), vec![]); },
                    _ = poll.tick() => {
                        if let Some(value) = read_trajectory(&trajectory) {
                            for item in project_trajectory(&value, &run.id) {
                                let key = item["id"].as_str().unwrap().to_string();
                                if seen.get(&key) != Some(&item) { this.notify("item/completed", &thread, json!({"item":item})); seen.insert(key,item); }
                            }
                        }
                    }
                }
            };
            let mut budget = 2_000_000;
            for item in items {
                let bytes = item.to_string().len();
                if bytes > budget {
                    break;
                }
                budget -= bytes;
                if seen.get(item["id"].as_str().unwrap()) != Some(&item) {
                    this.notify("item/completed", &thread, json!({"item":item}));
                }
            }
            this.running.lock().unwrap().remove(&thread);
            this.notify("turn/completed", &thread, json!({"turn":{"id":run.id,"status":status,"error":error.map(|message| json!({"message":message}))}}));
            let _ = std::fs::remove_dir_all(directory);
            run.terminated.store(true, Ordering::Release);
            run.stopped.notify_waiters();
        });
        Ok(json!({"turn":{"id":run_id}}))
    }
    pub fn close(&self) {
        self.closing.store(true, Ordering::Release);
        for run in self.running.lock().unwrap().values() {
            run.stop.send_replace(true);
        }
    }
    pub async fn shutdown(&self) {
        self.close();
        let runs = self
            .running
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for run in runs {
            let _ = tokio::time::timeout(Duration::from_secs(6), async {
                while !run.terminated.load(Ordering::Acquire) {
                    let notified = run.stopped.notified();
                    if run.terminated.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
            })
            .await;
        }
    }
}

fn trajectory_result(
    path: &Path,
    exit_ok: bool,
    run: &str,
) -> (&'static str, Option<String>, Vec<Value>) {
    let invalid = || {
        ("failed", Some("Trae Agent returned no valid completed trajectory; inspect the workspace before retrying. The task was not rerun.".into()), vec![])
    };
    let Some(value) = read_trajectory(path) else {
        return invalid();
    };
    if !value["success"].is_boolean() || !value["end_time"].as_str().is_some_and(|s| !s.is_empty())
    {
        return invalid();
    }
    let items = project_trajectory(&value, run);
    if exit_ok && value["success"] == true {
        ("completed", None, items)
    } else {
        ("failed", Some("Trae Agent did not complete successfully. Check its native provider configuration and inspect the workspace before retrying.".into()), items)
    }
}

fn read_trajectory(path: &Path) -> Option<Value> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_TRAJECTORY {
        return None;
    }
    // Native Trae rewrites this file in place. A partial JSON read is skipped
    // until the next poll and can never establish completion.
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, MAX_TRAJECTORY + 1),
        &mut bytes,
    )
    .ok()?;
    if bytes.len() as u64 > MAX_TRAJECTORY {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn project_trajectory(value: &Value, run: &str) -> Vec<Value> {
    let mut items = Vec::new();
    if let Some(steps) = value["agent_steps"].as_array() {
        for (i, step) in steps.iter().take(1000).enumerate() {
            if let Some(text) = step["llm_response"]["content"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                items.push(json!({"id":format!("{run}:step:{i}"),"type":"agentMessage","text":text.chars().take(131072).collect::<String>()}));
            }
            if let Some(calls) = step["tool_calls"].as_array() {
                for (j, call) in calls.iter().take(50).enumerate() {
                    let result = step["tool_results"].as_array().and_then(|results| {
                        results.iter().find(|r| r["call_id"] == call["call_id"])
                    });
                    // The trajectory contains model prompts/configuration as well;
                    // project only explicit tool names and bounded results.
                    items.push(json!({"id":format!("{run}:tool:{i}:{j}"),"type":"mcpToolCall","command":super::scrub(&call["name"],0,&mut 1024),"arguments":super::scrub(&call["arguments"],0,&mut 65536),"result":result.map(|r|super::scrub(&r["result"],0,&mut 65536)),"status":match result.map(|r| r["success"].as_bool()) {Some(Some(true))=>"completed",Some(Some(false))=>"failed",_=>"unknown"}}));
                    if items.len() >= 1500 {
                        break;
                    }
                }
            }
            if items.len() >= 1500 {
                break;
            }
        }
    }
    if let Some(text) = value["final_result"].as_str().filter(|s| !s.is_empty()) {
        items.push(json!({"id":format!("{run}:reply"),"type":"agentMessage","text":text.chars().take(131072).collect::<String>()}));
    }
    let mut budget = 2_000_000;
    items
        .into_iter()
        .take_while(|item| {
            let bytes = item.to_string().len();
            if bytes > budget {
                false
            } else {
                budget -= bytes;
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::discovery::Protocol;
    use super::super::harness;
    use super::*;

    async fn completed(events: &mut broadcast::Receiver<HarnessEvent>) -> (Value, Vec<Value>) {
        let mut items = vec![];
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let HarnessEvent::Notification { method, params } = events.recv().await.unwrap()
                {
                    if method == "item/completed" {
                        items.push(params["item"].clone());
                    }
                    if method == "turn/completed" {
                        return (params["turn"].clone(), items);
                    }
                }
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn native_cli_tasks_are_independent_and_private_with_cancellable_children() {
        let (harness, _fixture) = harness::fixture(
            include_str!("../../../../../../scripts/fixtures/fake-trae.cjs"),
            Protocol::Trae,
        )
        .await;
        let account = harness
            .call("account/read", json!({}), Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(account["authUnknown"], true);
        assert_eq!(
            harness
                .call("model/list", json!({}), Duration::from_secs(3))
                .await
                .unwrap()["data"],
            json!([])
        );
        assert!(harness
            .call(
                "thread/resume",
                json!({"threadId":"legacy"}),
                Duration::from_secs(3)
            )
            .await
            .unwrap_err()
            .contains("history is preserved"));
        let started = harness
            .call(
                "thread/start",
                json!({"cwd":std::env::temp_dir(),"mode":"craft"}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        let thread = &started["thread"]["id"];
        let mut events = harness.subscribe();
        for (task, status) in [
            ("你好 😀", "completed"),
            ("FIXTURE_FAILED", "failed"),
            ("FIXTURE_NONZERO", "failed"),
            ("FIXTURE_INCOMPLETE", "failed"),
            ("FIXTURE_MISSING", "failed"),
            ("FIXTURE_MALFORMED", "failed"),
        ] {
            harness
                .call(
                    "turn/start",
                    json!({"threadId":thread,"input":[{"type":"text","text":task}],"mode":"craft"}),
                    Duration::from_secs(3),
                )
                .await
                .unwrap();
            let (turn, items) = completed(&mut events).await;
            assert_eq!(turn["status"], status);
            assert!(items.iter().any(|i| i["text"]
                .as_str()
                .is_some_and(|s| s.contains("independent native task"))));
            let raw = json!(items).to_string();
            assert!(
                !raw.contains("RAW_STDOUT_PRIVATE_TOKEN")
                    && !raw.contains("RAW_STDERR_PRIVATE_TOKEN")
                    && !raw.contains("RAW_LLM_PRIVATE_TOKEN")
            );
            if status == "completed" {
                assert!(raw.contains("中文😀") && raw.contains("read_file"));
            }
        }
        for semantic in [
            json!({"mode":"ask"}),
            json!({"effort":"high"}),
            json!({"input":[{"type":"image","data":"fake"}]}),
        ] {
            let mut request =
                json!({"threadId":thread,"input":[{"type":"text","text":"must not execute"}]});
            for (key, value) in semantic.as_object().unwrap() {
                request[key] = value.clone();
            }
            assert!(harness
                .call("turn/start", request, Duration::from_secs(3))
                .await
                .unwrap_err()
                .contains("UNSUPPORTED_FEATURE"));
        }
        harness
            .call(
                "turn/start",
                json!({"threadId":thread,"input":[{"type":"text","text":"FIXTURE_WAIT"}]}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        harness
            .call(
                "turn/interrupt",
                json!({"threadId":thread}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        assert_eq!(completed(&mut events).await.0["status"], "interrupted");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn manager_preserves_owned_history_receipts_and_additive_inventory() {
        use super::super::{canonical_root, AgentManager};
        let directory =
            std::env::temp_dir().join(format!("kp-trae-manager-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let root = canonical_root(&directory.to_string_lossy()).unwrap();
        let registry = root.join("sessions.json");
        let owner = "a".repeat(64);
        let manager = AgentManager::open(registry.clone(), 0);
        let inventory = manager
            .backends(
                &owner,
                &[
                    ("backend".into(), "trae".into()),
                    ("probe".into(), "executable".into()),
                ]
                .into_iter()
                .collect(),
            )
            .await
            .unwrap();
        assert_eq!(inventory["trae"]["aichatContext"], false);
        assert_eq!(inventory["trae"]["executionMode"], "one-shot");
        assert_eq!(inventory["trae"]["supportedModes"], json!(["craft"]));
        assert_eq!(inventory["trae"]["authenticated"], Value::Null);
        let (child, _fixture) = harness::fixture(
            include_str!("../../../../../../scripts/fixtures/fake-trae.cjs"),
            Protocol::Trae,
        )
        .await;
        manager
            .harnesses
            .lock()
            .await
            .insert(format!("trae\0{}", root.display()), child.clone());
        let mut events = child.subscribe();
        let consumer = {
            let manager = manager.clone();
            let child = child.clone();
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    manager.on_event(&child, event).await;
                }
            })
        };
        let session = manager.create(&owner, &json!({"conversationId":"trae-managed","backend":"trae","roots":[root],"mode":"craft"})).await.unwrap();
        let sid = session["id"].as_str().unwrap();
        assert!(manager.view(sid, &"b".repeat(64)).is_err());
        let input = json!({"requestId":"one-explicit-task","text":"你好 😀"});
        let receipt = manager.turn(sid, &owner, &input).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.view(sid, &owner).unwrap()["status"] != "completed" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let view = manager.view(sid, &owner).unwrap();
        let raw = view.to_string();
        assert!(
            raw.contains("read result") && raw.contains("fixture.txt") && raw.contains("中文😀")
        );
        assert!(!raw.contains("RAW_LLM_PRIVATE_TOKEN"));
        assert_eq!(
            manager.turn(sid, &owner, &input).await.unwrap()["submission"],
            receipt["submission"]
        );
        child.shutdown().await;
        consumer.abort();
        drop(manager);
        let restarted = AgentManager::open(registry, 0);
        assert_eq!(restarted.view(sid, &owner).unwrap()["items"], view["items"]);
        assert!(restarted.harnesses.lock().await.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn trajectory_steps_are_visible_before_native_exit() {
        let source = r#"const fs=require('node:fs'),a=process.argv.slice(2),p=a[a.indexOf('--trajectory-file')+1]; fs.writeFileSync(p,JSON.stringify({success:false,end_time:'',agent_steps:[{llm_response:{content:'visible before exit'},tool_calls:[{call_id:'x',name:'read',arguments:{path:'a',api_token:'private'}}],tool_results:[{call_id:'x',success:true,result:'streamed tool result'}]}]})); setInterval(()=>{},1000);"#;
        let (harness, _fixture) = harness::fixture(source, Protocol::Trae).await;
        let thread = harness
            .call(
                "thread/start",
                json!({"cwd":std::env::temp_dir()}),
                Duration::from_secs(3),
            )
            .await
            .unwrap()["thread"]["id"]
            .clone();
        let mut events = harness.subscribe();
        harness
            .call(
                "turn/start",
                json!({"threadId":thread,"input":[{"type":"text","text":"task"}]}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let HarnessEvent::Notification { method, params } = events.recv().await.unwrap()
                {
                    assert_ne!(method, "turn/completed");
                    if params["item"]["result"] == "streamed tool result" {
                        assert_eq!(params["item"]["arguments"]["path"], "a");
                        assert!(params["item"]["arguments"].get("api_token").is_none());
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        harness
            .call(
                "turn/interrupt",
                json!({"threadId":thread}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        assert_eq!(completed(&mut events).await.0["status"], "interrupted");
        harness.shutdown().await;
    }

    #[test]
    fn unsupported_semantics_fail_before_launch() {
        for input in [
            json!({"mcpServers":[{}]}),
            json!({"mode":"ask"}),
            json!({"mode":"plan"}),
            json!({"effort":"high"}),
            json!({"sandbox":"read-only"}),
            json!({"sandboxPolicy":{"type":"readOnly"}}),
        ] {
            assert!(validate(&input)
                .unwrap_err()
                .contains("UNSUPPORTED_FEATURE"));
        }
        assert!(validate(&json!({"mode":"craft","mcpServers":[]})).is_ok());
    }
    #[test]
    fn successful_exit_requires_finalized_successful_trajectory() {
        let dir = std::env::temp_dir().join(format!("keepwork-trae-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("trajectory.json");
        for (data, exit_ok, expected) in [
            (json!({"success":true}), true, "failed"),
            (json!({"success":false,"end_time":"done"}), true, "failed"),
            (
                json!({"success":true,"end_time":"done","final_result":"answer"}),
                false,
                "failed",
            ),
            (
                json!({"success":true,"end_time":"done","final_result":"answer"}),
                true,
                "completed",
            ),
        ] {
            std::fs::write(&path, data.to_string()).unwrap();
            assert_eq!(trajectory_result(&path, exit_ok, "run").0, expected);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
