//! Binding and runtime types, persistence, dashboard views and the background pump.

use super::policy::*;
use super::*;

#[derive(Clone, Debug, Default)]
pub struct Binding {
    pub channel: String,
    pub id: String,
    pub root: String,
    pub profile: String,
    pub enabled: bool,
    pub agent_owner: Option<String>,
    pub agent_id: Option<String>,
    pub peers: Vec<Value>,
    pub rules_dir: Option<String>,
    pub agent_prompt: Option<String>,
}

impl Binding {
    pub(crate) fn from_json(value: &Value) -> Binding {
        let channel = value["channel"].as_str().unwrap_or("dingtalk").to_string();
        let peers = value["peers"].as_array().cloned().unwrap_or_default();
        Binding {
            channel,
            id: value["id"].as_str().unwrap_or("").to_string(),
            root: value["root"].as_str().unwrap_or("").to_string(),
            profile: value["profile"].as_str().unwrap_or("").to_string(),
            enabled: value["enabled"].as_bool().unwrap_or(false),
            agent_owner: value["agentOwner"].as_str().map(str::to_string),
            agent_id: value["agentId"].as_str().map(str::to_string),
            peers,
            rules_dir: value["rulesDir"].as_str().map(str::to_string),
            agent_prompt: value["agentPrompt"].as_str().map(str::to_string),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut binding = json!({
            "channel": self.channel,
            "id": self.id,
            "root": self.root,
            "profile": self.profile,
            "enabled": self.enabled,
        });
        if let Some(owner) = &self.agent_owner {
            binding["agentOwner"] = json!(owner);
        }
        if let Some(agent_id) = &self.agent_id {
            binding["agentId"] = json!(agent_id);
        }
        if !self.peers.is_empty() {
            binding["peers"] = json!(self.peers);
        }
        if let Some(dir) = &self.rules_dir {
            binding["rulesDir"] = json!(dir);
        }
        if let Some(prompt) = &self.agent_prompt {
            binding["agentPrompt"] = json!(prompt);
        }
        binding
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MessageJob {
    pub(crate) message: Incoming,
    pub(crate) receipt_id: String,
}

pub(crate) struct Runtime {
    pub(crate) binding: Binding,
    pub(crate) status: String,
    pub(crate) error: String,
    pub(crate) identity: String,
    pub(crate) owns_identity: bool,
    pub(crate) self_id: String,
    pub(crate) since: i64,
    pub(crate) subscriptions: String,
    pub(crate) stop: Option<tokio::sync::watch::Sender<bool>>,
    pub(crate) generation: u64,
    pub(crate) listener_done: Option<tokio::sync::watch::Receiver<bool>>,
    pub(crate) retrying: bool,
    pub(crate) next_retry_at: Option<i64>,
    pub(crate) starting: bool,
    pub(crate) queues: HashMap<String, VecDeque<MessageJob>>,
    pub(crate) active: HashSet<String>,
    pub(crate) receipts: Vec<Value>,
    pub(crate) seen: Vec<String>,
    pub(crate) last_poll_at: Option<i64>,
    pub(crate) wake: HashMap<String, i64>,
    pub(crate) history: HashMap<String, Vec<(String, String)>>,
}

#[derive(Default)]
pub(crate) struct InboxStore {
    pub(crate) messages: Vec<Value>,
    pub(crate) paused: Vec<String>,
    pub(crate) read: HashMap<String, i64>,
    pub(crate) read_future: HashMap<String, Vec<String>>,
    pub(crate) sends: HashMap<String, String>,
    pub(crate) auto_reply_times: HashMap<String, Vec<i64>>,
}

impl InboxStore {
    pub(crate) fn from_json(value: &Value) -> InboxStore {
        InboxStore {
            messages: value["messages"].as_array().cloned().unwrap_or_default(),
            paused: value["paused"]
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            read: value["read"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_i64().map(|t| (k.clone(), t)))
                        .collect()
                })
                .unwrap_or_default(),
            read_future: value["readFutureIds"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| {
                            v.as_array().map(|rows| {
                                (
                                    k.clone(),
                                    rows.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect(),
                                )
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            sends: value["sends"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            auto_reply_times: value["autoReplyTimes"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| {
                            v.as_array().map(|rows| {
                                (k.clone(), rows.iter().filter_map(Value::as_i64).collect())
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({
            "messages": self.messages,
            "paused": self.paused,
            "read": self.read,
            "readFutureIds": self.read_future,
            "sends": self.sends,
            "autoReplyTimes": self.auto_reply_times,
        })
    }
}

pub(crate) struct Inner {
    pub(crate) runs: HashMap<String, Runtime>,
    pub(crate) inbox: HashMap<String, InboxStore>,
    pub(crate) channel_paths: HashMap<String, String>,
    pub(crate) switching: HashSet<String>,
    pub(crate) identities: HashSet<String>,
    pub(crate) closed: bool,
    pub(crate) group_names: HashMap<String, (String, i64)>,
    pub(crate) sender_names: HashMap<String, (String, i64)>,
    pub(crate) metadata_reads: HashSet<String>,
}

pub struct MessagingService {
    pub(crate) home: PathBuf,
    pub(crate) personas: Arc<PersonaStore>,
    pub(crate) presence: Arc<PresenceState>,
    pub(crate) inner: Mutex<Inner>,
    pub(crate) login_gate: tokio::sync::Mutex<()>,
    pub(crate) start_gate: tokio::sync::Mutex<()>,
    pub(crate) metadata_gate: tokio::sync::Semaphore,
    pub(crate) refresh_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Bumped on every persistence write; `/messaging/events` frames full
    /// views per change like Node's `persist()` watcher fan-out.
    pub(crate) events: tokio::sync::watch::Sender<u64>,
}

pub(crate) struct FeishuCheckpoint {
    pub(crate) since: i64,
    pub(crate) window: Option<Value>,
}

impl MessagingService {
    pub fn open(
        home: PathBuf,
        personas: Arc<PersonaStore>,
        presence: Arc<PresenceState>,
    ) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&home);
        let mut runs: HashMap<String, Runtime> = HashMap::new();
        let mut inbox: HashMap<String, InboxStore> = HashMap::new();
        let mut channel_paths: HashMap<String, String> = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(home.join("inbox.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(map) = value.as_object() {
                    for (key, rows) in map {
                        let mut box_ = InboxStore::from_json(rows);
                        for row in &mut box_.messages {
                            if row["state"].as_str() == Some("sending") {
                                row["state"] = json!("unknown");
                            }
                        }
                        inbox.insert(key.clone(), box_);
                    }
                }
            }
        }
        if let Ok(text) = std::fs::read_to_string(home.join("bindings.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(rows) = value.as_array() {
                    for row in rows {
                        let binding = Binding::from_json(row);
                        if binding.id.is_empty() {
                            continue;
                        }
                        let (mut receipts, mut seen) = (Vec::new(), Vec::new());
                        if let Ok(data) =
                            std::fs::read_to_string(home.join(format!("{}.json", binding.id)))
                        {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&data) {
                                receipts =
                                    parsed["receipts"].as_array().cloned().unwrap_or_default();
                                seen = parsed["seen"]
                                    .as_array()
                                    .map(|rows| {
                                        rows.iter()
                                            .filter_map(Value::as_str)
                                            .map(str::to_string)
                                            .collect()
                                    })
                                    .unwrap_or_default();
                            }
                        }
                        for receipt in &mut receipts {
                            if matches!(
                                receipt["state"].as_str(),
                                Some("queued" | "running" | "sending")
                            ) {
                                receipt["state"] = json!("unknown");
                                receipt["reason"] = json!("Service restarted; not replayed");
                            }
                        }
                        runs.insert(
                            binding.id.clone(),
                            Runtime {
                                binding,
                                status: "stopped".into(),
                                error: String::new(),
                                identity: String::new(),
                                owns_identity: false,
                                self_id: String::new(),
                                since: now_ms(),
                                subscriptions: String::new(),
                                stop: None,
                                generation: 0,
                                listener_done: None,
                                retrying: false,
                                next_retry_at: None,
                                starting: false,
                                queues: HashMap::new(),
                                active: HashSet::new(),
                                receipts,
                                seen,
                                last_poll_at: None,
                                wake: HashMap::new(),
                                history: HashMap::new(),
                            },
                        );
                    }
                }
            }
        }
        if let Ok(text) = std::fs::read_to_string(home.join("channel-roots.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                for channel in ["dingtalk", "feishu"] {
                    if let Some(root) = value[channel].as_str() {
                        if Path::new(root).is_absolute() {
                            channel_paths.insert(channel.to_string(), root.to_string());
                        }
                    }
                }
            }
        }
        let mut restored: HashSet<String> = HashSet::new();
        for run in runs.values_mut() {
            if !run.binding.enabled {
                continue;
            }
            let channel = run.binding.channel.clone();
            if !channel_paths.contains_key(&channel) {
                match valid_root(&run.binding.root) {
                    Ok(root) => {
                        channel_paths.insert(channel.clone(), root);
                    }
                    Err(_) => run.binding.enabled = false,
                }
            }
            if channel_paths.get(&channel).map(|p| p.as_str()) != Some(run.binding.root.as_str())
                || restored.contains(&channel)
            {
                run.binding.enabled = false;
            }
            if run.binding.enabled {
                restored.insert(channel);
            }
        }
        write_json_private(&home.join("channel-roots.json"), &json!(channel_paths));
        let service = Arc::new(Self {
            home,
            personas,
            presence,
            inner: Mutex::new(Inner {
                runs,
                inbox,
                channel_paths,
                switching: HashSet::new(),
                identities: HashSet::new(),
                closed: false,
                group_names: HashMap::new(),
                sender_names: HashMap::new(),
                metadata_reads: HashSet::new(),
            }),
            login_gate: tokio::sync::Mutex::new(()),
            start_gate: tokio::sync::Mutex::new(()),
            metadata_gate: tokio::sync::Semaphore::new(4),
            refresh_gates: Mutex::new(HashMap::new()),
            events: tokio::sync::watch::channel(0u64).0,
        });
        service.persist_all();
        service
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `availableAgents`: agent personas (excluding the default persona and
    /// empty prompts) rooted at the binding root whose owner is the bound
    /// agent's owner or one of the binding peers. Deduplicated by id.
    pub(crate) fn available_agents(&self, binding: &Binding) -> Vec<String> {
        let mut owners: Vec<String> = Vec::new();
        if let Some(owner) = &binding.agent_owner {
            owners.push(owner.clone());
        }
        for peer in &binding.peers {
            if let Some(owner) = peer["owner"].as_str() {
                owners.push(owner.to_string());
            }
        }
        owners.sort();
        owners.dedup();
        let mut seen: HashSet<String> = HashSet::new();
        let mut available: Vec<String> = Vec::new();
        for owner in &owners {
            let agents = self.personas.list(owner)["agents"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for agent in agents {
                let id = agent["id"].as_str().unwrap_or("");
                if id == "default-persona" || seen.contains(id) {
                    continue;
                }
                let prompt = agent["prompt"].as_str().unwrap_or("").trim();
                let root = agent["root"].as_str().unwrap_or("");
                if prompt.is_empty() || root != binding.root {
                    continue;
                }
                seen.insert(id.to_string());
                available.push(id.to_string());
            }
        }
        available
    }

    pub(crate) fn persist_bindings(&self, inner: &Inner) {
        let bindings: Vec<Value> = inner
            .runs
            .values()
            .map(|run| run.binding.to_json())
            .collect();
        write_json_private(&self.home.join("bindings.json"), &json!(bindings));
        self.bump_events();
    }

    /// Every persistence write fires one watcher update, like Node `persist`.
    pub(crate) fn bump_events(&self) {
        self.events.send_modify(|count| *count += 1);
    }

    pub fn subscribe_events(&self) -> tokio::sync::watch::Receiver<u64> {
        self.events.subscribe()
    }

    pub(crate) fn persist_run(&self, run: &Runtime) {
        write_json_private(
            &self.home.join(format!("{}.json", run.binding.id)),
            &json!({ "receipts": run.receipts.iter().rev().take(200).rev().collect::<Vec<_>>(), "seen": run.seen.iter().rev().take(10_000).rev().collect::<Vec<_>>() }),
        );
        self.bump_events();
    }

    pub(crate) fn save_inbox(&self, inner: &Inner) {
        let mut map = serde_json::Map::new();
        for (key, box_) in inner.inbox.iter() {
            map.insert(key.clone(), box_.to_json());
        }
        write_json_private(&self.home.join("inbox.json"), &Value::Object(map));
    }

    pub(crate) fn persist_all(&self) {
        let inner = self.lock();
        self.persist_bindings(&inner);
        self.save_inbox(&inner);
        for run in inner.runs.values() {
            self.persist_run(run);
        }
    }

    /// Pump loop + resume: call once from `main` with the shared `Arc`.
    pub async fn run_background(self: Arc<Self>) {
        let sweeper = Arc::clone(&self);
        tokio::spawn(async move {
            pump_loop(sweeper).await;
        });
        self.resume().await;
    }

    pub async fn resume(self: &Arc<Self>) {
        let ids: Vec<String> = {
            let inner = self.lock();
            inner
                .runs
                .values()
                .filter(|run| run.binding.enabled)
                .map(|run| run.binding.id.clone())
                .collect()
        };
        for id in ids {
            let _ = self.start(&id).await;
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    pub fn view(&self, id: &str) -> Result<Value, MessageError> {
        let inner = self.lock();
        let run = inner
            .runs
            .get(id)
            .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
        Ok(Self::view_run(run))
    }

    /// Full binding view (`messaging.ts view()`): status, queues, receipts and
    /// the serving summary for dashboards and `/messaging/*`.
    pub(crate) fn view_run(run: &Runtime) -> Value {
        let total: usize = run.queues.values().map(|queue| queue.len()).sum();
        let mut view = run.binding.to_json();
        view["nicknameErrors"] = json!([]);
        view["transitioning"] = json!(run.starting);
        view["transport"] = json!(if run.binding.channel == "feishu" {
            "polling"
        } else {
            "events"
        });
        if run.binding.channel == "feishu" {
            view["pollIntervalMs"] = json!(POLL_INTERVAL);
        } else if run.binding.channel == "dingtalk" {
            view["inboxRefreshVersion"] = json!(1);
        }
        view["lastPollAt"] = json!(run.last_poll_at);
        view["status"] = json!(run.status);
        view["error"] = json!(run.error);
        view["nextRetryAt"] = json!(run.next_retry_at);
        view["needsRepair"] = json!(run.status == "error");
        view["active"] = json!(run.active.len());
        view["queued"] = json!(total);
        view["recent"] = json!(run.receipts.iter().rev().take(40).collect::<Vec<_>>());
        view["accountConnected"] = json!(!run.identity.is_empty());
        view["listening"] = json!(run.status == "listening");
        let executor = run
            .receipts
            .iter()
            .rev()
            .find(|receipt| receipt["executor"].is_string())
            .and_then(|receipt| receipt["executor"].as_str().map(str::to_string));
        view["executor"] = json!(executor.unwrap_or_default());
        view["serving"] = json!({
            "server": "client",
            "executor": "keepwork",
            "model": "keepwork-pro",
            "active": run.receipts.iter().rev().any(|receipt| matches!(receipt["state"].as_str(), Some("queued" | "running" | "sending")) && receipt["server"].is_string()),
        });
        view["autoReply"] = json!(run.binding.enabled);
        view
    }

    pub fn list_views(&self) -> Vec<Value> {
        let inner = self.lock();
        let mut views = Vec::new();
        for run in inner.runs.values() {
            views.push(Self::view_run(run));
        }
        // HashMap order is unstable; Node keeps insertion order, so sort for a
        // deterministic listing.
        views.sort_by(|a, b| {
            let key = |row: &Value| {
                (
                    row["root"].as_str().unwrap_or("").to_string(),
                    row["profile"].as_str().unwrap_or("").to_string(),
                    row["id"].as_str().unwrap_or("").to_string(),
                )
            };
            key(a).cmp(&key(b))
        });
        views
    }

    /// `/admin/channels` row shape (all bindings, status + poll info).
    pub fn list_binding_rows(&self) -> Vec<Value> {
        let inner = self.lock();
        let mut rows = Vec::new();
        for run in inner.runs.values() {
            let mut row = run.binding.to_json();
            row["transitioning"] = json!(run.starting);
            row["status"] = json!(run.status);
            row["error"] = json!(run.error);
            row["lastPollAt"] = json!(run.last_poll_at);
            row["serving"] =
                json!({"server": "client", "executor": "keepwork-pro", "model": "keepwork-pro"});
            rows.push(row);
        }
        rows
    }

    /// Claimed channel roots (`messaging.channelRoots()`).
    pub fn channel_roots(&self) -> Value {
        let inner = self.lock();
        json!(inner.channel_paths)
    }
}
pub(crate) async fn pump_loop(service: Arc<MessagingService>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        service.pump_due().await;
    }
}

// ---------------------------------------------------------------------------
// `/messaging/*` HTTP surface (mirrors `src/mcp/messagingHttp.ts`)
// ---------------------------------------------------------------------------
