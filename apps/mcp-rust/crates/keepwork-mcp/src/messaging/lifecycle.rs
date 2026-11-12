//! Binding lifecycle: channel claims, configure/connect/login/start/stop, reconnects and persona wiring.

use super::*;
use super::{cli::*, dingtalk::*, feishu::*, inbox::*, policy::*, service::*};

impl MessagingService {
    pub(crate) fn assert_exists(inner: &Inner, id: &str) -> Result<(), MessageError> {
        if inner.runs.contains_key(id) {
            Ok(())
        } else {
            Err(MessageError::bad("Messaging configuration not found"))
        }
    }

    // -----------------------------------------------------------------------
    // Channel claims
    // -----------------------------------------------------------------------

    /// Per channel the CLI identity occupies exactly one brain directory;
    /// ordinary connects never rebind — only an explicit switch does.
    pub(crate) fn claim_channel(
        &self,
        inner: &mut Inner,
        channel: &str,
        value: &str,
    ) -> Result<String, MessageError> {
        let root = valid_root(value)?;
        if inner.switching.contains(channel) {
            return Err(MessageError::bad(
                "Channel switch in progress; retry after completion",
            ));
        }
        if let Some(occupied) = inner.channel_paths.get(channel) {
            if occupied != &root {
                return Err(MessageError::occupied(channel_conflict(
                    channel, occupied, root,
                )));
            }
            return Ok(root);
        }
        inner
            .channel_paths
            .insert(channel.to_string(), root.clone());
        self.save_channel_roots(inner);
        Ok(root)
    }

    pub(crate) fn save_channel_roots(&self, inner: &Inner) {
        write_json_private(
            &self.home.join("channel-roots.json"),
            &json!(inner.channel_paths),
        );
    }

    pub async fn switch_channel(
        &self,
        channel: &str,
        value: &str,
        expected_root: &str,
    ) -> Result<(), MessageError> {
        if channel != "dingtalk" && channel != "feishu" {
            return Err(MessageError::bad("Unknown channel"));
        }
        let root = valid_root(value)?;
        {
            let mut inner = self.lock();
            let occupied = inner
                .channel_paths
                .get(channel)
                .cloned()
                .unwrap_or_default();
            if occupied.is_empty() || occupied != expected_root {
                return Err(MessageError::occupied(channel_conflict(
                    channel,
                    &occupied,
                    root.clone(),
                )));
            }
            if inner.switching.contains(channel) {
                return Err(MessageError::bad(
                    "Channel switch in progress; retry after completion",
                ));
            }
            if root == occupied {
                return Ok(());
            }
            inner.switching.insert(channel.to_string());
        }
        let result = async {
            let stopping: Vec<String> = {
                let inner = self.lock();
                inner
                    .runs
                    .values()
                    .filter(|run| run.binding.channel == channel)
                    .map(|run| run.binding.id.clone())
                    .collect()
            };
            for id in stopping {
                self.stop(&id);
            }
            {
                let mut inner = self.lock();
                if inner.closed {
                    return Err(MessageError::bad("Service closed"));
                }
                inner
                    .channel_paths
                    .insert(channel.to_string(), root.clone());
                self.save_channel_roots(&inner);
            }
            Ok(())
        }
        .await;
        let mut inner = self.lock();
        inner.switching.remove(channel);
        result
    }

    pub(crate) fn channel_conflict_message(channel: &str, occupied: &str, root: &str) -> String {
        let label = if channel == "feishu" {
            "Feishu"
        } else {
            "DingTalk"
        };
        if occupied == root {
            format!("{label} CLI is already occupied by {occupied}. Stop its current listener before connecting another account.")
        } else {
            format!("{label} CLI is already occupied by {occupied}. Switch to {root}?")
        }
    }

    // -----------------------------------------------------------------------
    // Persona ownership
    // -----------------------------------------------------------------------

    /// Persona brain root for ownership checks. Only called while no messaging
    /// guard is held: the personas lock sits above the messaging lock. The
    /// personas store may itself hold that lock when it calls into messaging,
    /// in which case `agent_root_try` yields `None` and ownership falls back
    /// to the binding's agent fields.
    pub(crate) fn persona_root_of(&self, owner: &str, agent_id: &str) -> Option<String> {
        self.personas
            .agent_root_try(owner, agent_id)
            .and_then(|root| valid_root(&root).ok())
    }

    /// Pure part of Node `hasAgent`: a valid persona root decides by equality;
    /// without one fall back to binding ownership/peers.
    pub(crate) fn has_agent_with(
        binding: &Binding,
        persona_root: Option<&str>,
        owner: &str,
        agent_id: &str,
    ) -> bool {
        if let Some(root) = persona_root {
            return root == binding.root;
        }
        binding.agent_owner.as_deref() == Some(owner)
            && binding.agent_id.as_deref() == Some(agent_id)
            || binding.peers.iter().any(|peer| {
                peer["owner"].as_str() == Some(owner) && peer["agentId"].as_str() == Some(agent_id)
            })
    }

    pub fn assert_agent_binding(
        &self,
        owner: &str,
        agent_id: &str,
        id: &str,
    ) -> Result<(), MessageError> {
        let persona_root = self.persona_root_of(owner, agent_id);
        let inner = self.lock();
        let run = inner
            .runs
            .get(id)
            .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
        if !Self::has_agent_with(&run.binding, persona_root.as_deref(), owner, agent_id) {
            return Err(MessageError::bad("渠道不属于此分身"));
        }
        Ok(())
    }

    pub(crate) fn peer_present(binding: &Binding, owner: &str, agent_id: &str) -> bool {
        binding.peers.iter().any(|peer| {
            peer["owner"].as_str() == Some(owner) && peer["agentId"].as_str() == Some(agent_id)
        })
    }

    pub fn bind_agent(
        &self,
        owner: &str,
        agent_id: &str,
        id: &str,
        share_root: bool,
    ) -> Result<Value, MessageError> {
        if !regex_is_match(r"^[a-zA-Z0-9_-]{1,160}$", agent_id) {
            return Err(MessageError::bad("Invalid Agent ID"));
        }
        let mut inner = self.lock();
        let run = inner
            .runs
            .get_mut(id)
            .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
        if let (Some(existing_owner), Some(existing_agent)) = (
            &run.binding.agent_owner.clone(),
            &run.binding.agent_id.clone(),
        ) {
            if existing_owner != owner || existing_agent != agent_id {
                if !share_root {
                    return Err(MessageError::bad("该身份已由其他分身使用"));
                }
                let channel = run.binding.channel.clone();
                let root = run.binding.root.clone();
                self.claim_channel(&mut inner, &channel, &root)?;
                let run = inner.runs.get_mut(id).unwrap();
                if !Self::peer_present(&run.binding, owner, agent_id) {
                    run.binding
                        .peers
                        .push(json!({ "owner": owner, "agentId": agent_id }));
                }
                let owners = self.persist_run_and_notify(&mut inner, id);
                drop(inner);
                self.bump_owners(owners);
                return self.view(id);
            }
        }
        // First binding for a persona: create the scoped skill directory.
        if run.binding.agent_id.is_none() {
            let binding_snapshot = run.binding.clone();
            // Keep the full config shape; a 3-field projection would fail the
            // later `read_rules` version check and silently reset to defaults.
            let (config, prompt) = read_rules_raw(
                &binding_snapshot.root,
                binding_snapshot.rules_dir.as_deref(),
            )
            .or_else(|_| rules_defaults(&binding_snapshot.root))?;
            let directory = format!(
                "{}/agents/{}{}",
                RULE_DIR,
                agent_id,
                if run.binding.channel == "feishu" {
                    "/feishu"
                } else {
                    ""
                }
            );
            let mut dir = PathBuf::from(&binding_snapshot.root);
            for part in directory.split('/') {
                dir.push(part);
                if !dir.exists() {
                    std::fs::create_dir_all(&dir)
                        .map_err(|_| MessageError::bad("无法创建消息技能目录"))?;
                }
            }
            let config_text = serde_json::to_string_pretty(
                &serde_json::to_value(&config).unwrap_or(default_config()),
            )
            .unwrap_or_else(|_| "{}".into());
            for (name, data) in [("config.json", config_text), ("SKILL.md", prompt)] {
                let file = dir.join(name);
                if !file.exists() {
                    std::fs::write(&file, data)
                        .map_err(|_| MessageError::bad("无法写入消息技能目录"))?;
                }
            }
            run.binding.rules_dir = Some(directory);
        }
        run.binding.agent_owner = Some(owner.to_string());
        run.binding.agent_id = Some(agent_id.to_string());
        let owners = self.persist_run_and_notify(&mut inner, id);
        drop(inner);
        self.bump_owners(owners);
        self.view(id)
    }

    /// Persists the run and the binding list and returns the owner hashes to
    /// wake. Callers drop the messaging guard before `bump_owners`, so the
    /// personas lock is never taken under the messaging lock.
    pub(crate) fn persist_run_and_notify(&self, inner: &mut Inner, id: &str) -> Vec<String> {
        if let Some(run) = inner.runs.get(id) {
            self.persist_run(run);
        }
        self.persist_bindings(inner);
        binding_owners(inner, id)
    }

    pub(crate) fn bump_owners(&self, owners: Vec<String>) {
        for owner in owners {
            self.personas.bump(&owner);
        }
    }

    pub fn set_agent_prompt(&self, owner: &str, agent_id: &str, prompt: &str) {
        let mut inner = self.lock();
        let touched: Vec<String> = inner
            .runs
            .values()
            .filter(|run| {
                run.binding.agent_owner.as_deref() == Some(owner)
                    && run.binding.agent_id.as_deref() == Some(agent_id)
            })
            .map(|run| run.binding.id.clone())
            .collect();
        for id in &touched {
            inner.runs.get_mut(id).unwrap().binding.agent_prompt = Some(prompt.to_string());
            if let Some(run) = inner.runs.get(id) {
                self.persist_run(run);
            }
        }
        self.persist_bindings(&inner);
        let mut owners: Vec<String> = touched
            .iter()
            .flat_map(|id| binding_owners(&inner, id))
            .collect();
        owners.sort();
        owners.dedup();
        drop(inner);
        self.bump_owners(owners);
    }

    /// Node `isAgentBusy`: a persona with queued inbound work is busy. Group
    /// work stays Node-only in this slice, so the per-agent work counter is
    /// always empty here and only queued jobs count.
    pub fn is_agent_busy(&self, owner: &str, agent_id: &str) -> bool {
        let inner = self.lock();
        inner.runs.values().any(|run| {
            run.binding.agent_owner.as_deref() == Some(owner)
                && run.binding.agent_id.as_deref() == Some(agent_id)
                && run.queues.values().any(|queue| !queue.is_empty())
        })
    }

    pub fn detach_agent(&self, owner: &str, agent_id: &str) {
        let ids: Vec<String> = {
            let inner = self.lock();
            inner.runs.keys().cloned().collect()
        };
        for id in ids {
            let dropped = {
                let mut inner = self.lock();
                let Some(run) = inner.runs.get_mut(&id) else {
                    continue;
                };
                run.binding.peers.retain(|peer| {
                    !(peer["owner"].as_str() == Some(owner)
                        && peer["agentId"].as_str() == Some(agent_id))
                });
                run.binding.agent_owner.as_deref() == Some(owner)
                    && run.binding.agent_id.as_deref() == Some(agent_id)
            };
            if dropped {
                self.stop(&id);
                let mut inner = self.lock();
                if let Some(run) = inner.runs.get_mut(&id) {
                    run.binding.agent_owner = None;
                    run.binding.agent_id = None;
                    run.binding.agent_prompt = None;
                }
                inner.inbox.remove(&id);
                self.persist_run_and_notify(&mut inner, &id);
                self.save_inbox(&inner);
            }
        }
    }

    pub fn agent_bindings(&self, owner: &str, agent_id: &str) -> Vec<Value> {
        let persona_root = self.persona_root_of(owner, agent_id);
        let inner = self.lock();
        let mut rows: Vec<Value> = Vec::new();
        for run in inner.runs.values() {
            if !Self::has_agent_with(&run.binding, persona_root.as_deref(), owner, agent_id) {
                continue;
            }
            let mut view = self.binding_status_view(&inner, run);
            view["unreadScope"] = json!("all");
            view["groups"] = json!([]);
            view["unread"] = json!(inner
                .inbox
                .get(&run.binding.id)
                .map(|box_| box_
                    .messages
                    .iter()
                    .filter(|row| inbox_unread(
                        Some(box_),
                        row["conversation"].as_str().unwrap_or(""),
                        row
                    ))
                    .count())
                .unwrap_or(0));
            rows.push(view);
        }
        rows.sort_by_key(|view| match view["listening"].as_bool() {
            Some(true) => 0,
            Some(_) if view["enabled"].as_bool() == Some(true) => 1,
            _ => 2,
        });
        rows
    }

    pub(crate) fn binding_status_view(&self, inner: &Inner, run: &Runtime) -> Value {
        let mut view = run.binding.to_json();
        view["nicknameErrors"] = json!([]);
        view["transitioning"] = json!(run.starting);
        view["status"] = json!(run.status);
        view["error"] = json!(run.error);
        view["nextRetryAt"] = json!(run.next_retry_at);
        view["needsRepair"] = json!(run.status == "error");
        view["accountConnected"] = json!(!run.identity.is_empty());
        view["listening"] = json!(run.status == "listening");
        view["autoReply"] = json!(run.binding.enabled);
        let _ = inner;
        view
    }

    // -----------------------------------------------------------------------
    // Lifecycle: configure / connect / login
    // -----------------------------------------------------------------------

    pub(crate) fn configure_binding(
        &self,
        inner: &mut Inner,
        channel: &str,
        root: &str,
        profile: &str,
    ) -> Result<String, MessageError> {
        // Persona connects reuse the brain's saved rules; a valid root without
        // readable rules falls back to the defaults. New bindings never stop an
        // existing run, so the wake list stays empty here — persona flows wake
        // owners through their own save path.
        let (config, prompt) = rules_defaults(root).or_else(|error| {
            if !Path::new(root).is_absolute()
                || !std::fs::metadata(root).map(|m| m.is_dir()).unwrap_or(false)
            {
                Err(error)
            } else {
                Ok((default_config(), DEFAULT_PROMPT.to_string()))
            }
        })?;
        let (id, woke) = self.configure(inner, channel, root, profile, config, &prompt)?;
        debug_assert!(woke.is_empty());
        let _ = woke;
        Ok(id)
    }

    pub(crate) fn new_runtime(binding: Binding) -> Runtime {
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
            receipts: Vec::new(),
            seen: Vec::new(),
            last_poll_at: None,
            wake: HashMap::new(),
            history: HashMap::new(),
        }
    }

    /// Node `configure`: validate and persist one binding's rules, stopping a
    /// matching run first. Returns the binding id plus the persona owner hashes
    /// to wake when an existing run was stopped. Unlike Node `start`/`profiles`
    /// this never claims the channel path — it only rejects a foreign occupant.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn configure(
        &self,
        inner: &mut Inner,
        channel: &str,
        root_value: &str,
        profile: &str,
        config: Value,
        prompt: &str,
    ) -> Result<(String, Vec<String>), MessageError> {
        let root = valid_root(root_value)?;
        // Node checks the occupied path before the channel whitelist.
        if let Some(occupied) = inner.channel_paths.get(channel) {
            if occupied != &root {
                return Err(MessageError::occupied(channel_conflict(
                    channel,
                    occupied,
                    root.clone(),
                )));
            }
        }
        if channel != "dingtalk" && channel != "feishu" {
            return Err(MessageError::bad("Unknown channel"));
        }
        if !regex_is_match(r"^[^\s,:]+:[^\s,:]+$", profile) {
            return Err(MessageError::bad("Select a stable corpId:userId profile"));
        }
        let config = normalize_config(&config)?;
        if prompt.trim().is_empty() || prompt.chars().count() > 32_768 {
            return Err(MessageError::bad("Reply prompt required"));
        }
        for dir in config["knowledge"].as_array().cloned().unwrap_or_default() {
            if let Some(dir) = dir.as_str() {
                knowledge_directory_checked(&root, dir)?;
            }
        }
        let id = sha256_hex(&[
            root.as_bytes(),
            b"\0",
            if channel == "feishu" { b"feishu:" } else { b"" },
            profile.as_bytes(),
        ])[..32]
            .to_string();
        // Node stops an existing run before rewriting its rules and commits
        // that stop immediately.
        let woke = match inner.runs.get_mut(&id) {
            Some(existing) => {
                existing.binding.enabled = false;
                let released = if existing.owns_identity {
                    Some(existing.identity.clone())
                } else {
                    None
                };
                existing.identity = String::new();
                existing.owns_identity = false;
                halt_runtime(existing);
                if let Some(identity) = released {
                    inner.identities.remove(&identity);
                }
                self.persist_run_and_notify(inner, &id);
                binding_owners(inner, &id)
            }
            None => Vec::new(),
        };
        let directory = if channel == "feishu" {
            format!("{RULE_DIR}/feishu")
        } else {
            RULE_DIR.to_string()
        };
        let rules_dir = inner
            .runs
            .get(&id)
            .and_then(|run| run.binding.rules_dir.clone())
            .unwrap_or_else(|| directory.clone());
        // Check every existing ancestor before creating a missing skill directory.
        let mut dir = PathBuf::from(&root);
        for part in rules_dir.split('/') {
            dir.push(part);
            if dir.exists() {
                let relative = dir
                    .strip_prefix(&root)
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                confined(&root, &relative)?;
            } else {
                std::fs::create_dir_all(&dir)
                    .map_err(|_| MessageError::bad("无法创建消息技能目录"))?;
            }
        }
        let config_text = serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".into());
        for (name, data) in [
            ("config.json", format!("{config_text}\n")),
            ("SKILL.md", prompt.to_string()),
        ] {
            let file = dir.join(name);
            if file.exists() {
                let relative = file
                    .strip_prefix(&root)
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                confined(&root, &relative)?;
            }
            write_private_file(&file, &data)?;
        }
        if !inner.runs.contains_key(&id) {
            let binding = Binding {
                channel: channel.to_string(),
                id: id.clone(),
                root: root.to_string(),
                profile: profile.to_string(),
                enabled: false,
                agent_owner: None,
                agent_id: None,
                peers: Vec::new(),
                rules_dir: if channel == "feishu" {
                    Some(directory)
                } else {
                    None
                },
                agent_prompt: None,
            };
            inner.runs.insert(id.clone(), Self::new_runtime(binding));
        }
        if let Some(run) = inner.runs.get_mut(&id) {
            run.history.clear();
        }
        self.persist_run_and_notify(inner, &id);
        Ok((id, woke))
    }

    pub(crate) async fn reuse_channel(
        self: &Arc<Self>,
        channel: &str,
        owner: &str,
        agent_id: &str,
        root: &str,
        prompt: &str,
    ) -> Option<Value> {
        let shared = {
            let inner = self.lock();
            inner
                .runs
                .values()
                .find(|run| {
                    run.binding.channel == channel
                        && run.binding.root == root
                        && run.binding.agent_id.is_some()
                })
                .map(|run| run.binding.id.clone())
        }?;
        let _ = self.bind_agent(owner, agent_id, &shared, true).ok()?;
        self.set_agent_prompt(owner, agent_id, prompt);
        if let Err(error) = self.start(&shared).await {
            let inner = self.lock();
            let reconnecting = inner
                .runs
                .get(&shared)
                .map(|run| run.status == "reconnecting")
                .unwrap_or(false);
            drop(inner);
            if !reconnecting {
                let _ = error;
                return None;
            }
        }
        self.view(&shared).ok()
    }

    pub async fn connect_agent(
        self: &Arc<Self>,
        owner: &str,
        agent_id: &str,
        root: &str,
        prompt: &str,
    ) -> Result<Value, MessageError> {
        let root = valid_root(root)?;
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, "dingtalk", &root)?;
        }
        if let Some(shared) = self
            .reuse_channel("dingtalk", owner, agent_id, &root, prompt)
            .await
        {
            return Ok(shared);
        }
        let binding_id = {
            let persona_root = self.persona_root_of(owner, agent_id);
            let inner = self.lock();
            let existing = inner
                .runs
                .values()
                .filter(|run| {
                    Self::has_agent_with(&run.binding, persona_root.as_deref(), owner, agent_id)
                        && run.binding.root == root
                        && run.binding.channel == "dingtalk"
                })
                .map(|run| run.binding.id.clone())
                .collect::<Vec<_>>();
            drop(inner);
            if existing.len() > 1 {
                return Err(MessageError::bad(
                    "Multiple DingTalk bindings; select the account in settings",
                ));
            }
            existing.into_iter().next()
        };
        let binding_id = match binding_id {
            Some(existing) => existing,
            None => {
                let profiles = dingtalk_profiles(&root).await?;
                let selected = select_profile(&profiles).ok_or_else(|| {
                    MessageError::bad("Select a current DingTalk CLI account before connecting")
                })?;
                let occupied = {
                    let inner = self.lock();
                    inner.runs.values().any(|run| {
                        run.binding.root == root
                            && run.binding.channel == "dingtalk"
                            && run.binding.profile == selected
                            && run.binding.agent_id.is_some()
                            && (run.binding.agent_owner.as_deref() != Some(owner)
                                || run.binding.agent_id.as_deref() != Some(agent_id))
                    })
                };
                if occupied {
                    if let Some(shared) = self
                        .reuse_channel("dingtalk", owner, agent_id, &root, prompt)
                        .await
                    {
                        return Ok(shared);
                    }
                }
                let mut inner = self.lock();
                let existing_same = inner
                    .runs
                    .values()
                    .find(|run| {
                        run.binding.root == root
                            && run.binding.profile == selected
                            && run.binding.channel == "dingtalk"
                    })
                    .map(|run| run.binding.id.clone());
                let _ = self.claim_channel(&mut inner, "dingtalk", &root)?;
                let binding_id = if let Some(existing_same) = existing_same {
                    existing_same
                } else {
                    self.configure_binding(&mut inner, "dingtalk", &root, &selected)?
                };
                drop(inner);
                let _ = self.bind_agent(owner, agent_id, &binding_id, true)?;
                binding_id
            }
        };
        self.set_agent_prompt(owner, agent_id, prompt);
        if let Err(error) = self.start(&binding_id).await {
            let inner = self.lock();
            let reconnecting = inner
                .runs
                .get(&binding_id)
                .map(|run| run.status == "reconnecting")
                .unwrap_or(false);
            drop(inner);
            if !reconnecting {
                return Err(error);
            }
        }
        self.view(&binding_id)
    }

    pub async fn connect_feishu_agent(
        self: &Arc<Self>,
        owner: &str,
        agent_id: &str,
        root: &str,
        prompt: &str,
    ) -> Result<Value, MessageError> {
        let root = valid_root(root)?;
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, "feishu", &root)?;
        }
        if let Some(shared) = self
            .reuse_channel("feishu", owner, agent_id, &root, prompt)
            .await
        {
            return Ok(shared);
        }
        let binding_id = {
            let existing = {
                let inner = self.lock();
                inner
                    .runs
                    .values()
                    .find(|run| {
                        run.binding.channel == "feishu"
                            && run.binding.agent_owner.as_deref() == Some(owner)
                            && run.binding.agent_id.as_deref() == Some(agent_id)
                            && run.binding.root == root
                    })
                    .map(|run| run.binding.id.clone())
            };
            let binding_id = match existing {
                Some(existing) => existing,
                None => {
                    let (id, _self) = feishu_identity(&root, None)
                        .await
                        .map_err(|error| MessageError::bad(error.message))?;
                    let mut inner = self.lock();
                    let same = inner
                        .runs
                        .values()
                        .find(|run| {
                            run.binding.channel == "feishu"
                                && run.binding.root == root
                                && run.binding.profile == id
                        })
                        .map(|run| run.binding.id.clone());
                    let _ = self.claim_channel(&mut inner, "feishu", &root)?;
                    if let Some(same) = same {
                        same
                    } else {
                        self.configure_binding(&mut inner, "feishu", &root, &id)?
                    }
                }
            };
            let _ = self.bind_agent(owner, agent_id, &binding_id, true)?;
            binding_id
        };
        self.set_agent_prompt(owner, agent_id, prompt);
        if let Err(error) = self.start(&binding_id).await {
            let inner = self.lock();
            let reconnecting = inner
                .runs
                .get(&binding_id)
                .map(|run| run.status == "reconnecting")
                .unwrap_or(false);
            drop(inner);
            if !reconnecting {
                return Err(error);
            }
        }
        self.view(&binding_id)
    }

    pub async fn login_agent(
        self: &Arc<Self>,
        owner: &str,
        agent_id: &str,
        root: &str,
        prompt: &str,
    ) -> Result<Value, MessageError> {
        let root = valid_root(root)?;
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, "dingtalk", &root)?;
        }
        let _gate = self.login_gate.lock().await;
        let profile = {
            let persona_root = self.persona_root_of(owner, agent_id);
            let inner = self.lock();
            let existing = inner
                .runs
                .values()
                .filter(|run| {
                    Self::has_agent_with(&run.binding, persona_root.as_deref(), owner, agent_id)
                        && run.binding.root == root
                        && run.binding.channel == "dingtalk"
                })
                .map(|run| run.binding.profile.clone())
                .collect::<Vec<_>>();
            drop(inner);
            if existing.len() > 1 {
                return Err(MessageError::bad(
                    "Multiple DingTalk bindings; select the account in settings",
                ));
            }
            existing.into_iter().next()
        };
        login_dws(&root, profile.as_deref()).await?;
        self.connect_agent(owner, agent_id, &root, prompt).await
    }

    // -----------------------------------------------------------------------
    // Lifecycle: start / stop / reconnect / listeners
    // -----------------------------------------------------------------------

    pub async fn start(self: &Arc<Self>, id: &str) -> Result<(), MessageError> {
        self.start_generation(id, None).await
    }

    async fn start_generation(
        self: &Arc<Self>,
        id: &str,
        expected: Option<u64>,
    ) -> Result<(), MessageError> {
        // A replacement must wait for the previous consumers to be reaped.
        // stop() remains synchronous and can cancel a start waiting for ready.
        let _start = self.start_gate.lock().await;
        let (generation, previous) = {
            let mut inner = self.lock();
            if inner.closed {
                return Err(MessageError::bad("Service closed"));
            }
            let (channel, root) = match inner.runs.get(id) {
                Some(run) => {
                    if expected.is_some_and(|generation| generation != run.generation) {
                        return Ok(());
                    }
                    if run.starting || run.status == "listening" {
                        return Ok(());
                    }
                    (run.binding.channel.clone(), run.binding.root.clone())
                }
                None => return Err(MessageError::bad("Messaging configuration not found")),
            };
            if let Some(other) = inner
                .runs
                .values()
                .find(|other| {
                    other.binding.id != *id
                        && other.binding.channel == channel
                        && (other.binding.enabled || other.starting)
                })
                .map(|other| other.binding.root.clone())
            {
                let conflict = channel_conflict(&channel, &other, root.clone());
                if let Some(run) = inner.runs.get_mut(id) {
                    run.starting = false;
                }
                self.persist_bindings(&inner);
                return Err(MessageError::occupied(conflict));
            }
            let (generation, previous) = if let Some(run) = inner.runs.get_mut(id) {
                run.generation = run.generation.wrapping_add(1);
                run.retrying = false;
                run.next_retry_at = None;
                run.binding.enabled = true;
                run.starting = true;
                run.status = "connecting".into();
                run.error = String::new();
                (run.generation, run.listener_done.take())
            } else {
                unreachable!()
            };
            let mut completions: Vec<_> = inner
                .runs
                .values()
                .filter(|run| run.binding.channel == channel)
                .filter_map(|run| run.listener_done.clone())
                .collect();
            completions.extend(previous);
            self.persist_bindings(&inner);
            (generation, completions)
        };
        for mut done in previous {
            loop {
                let finished = *done.borrow();
                if finished || done.changed().await.is_err() {
                    break;
                }
            }
        }
        self.persist_all_snapshot();
        let result = self.start_run(id, generation).await;
        let mut inner = self.lock();
        if let Some(run) = inner.runs.get_mut(id) {
            if run.generation != generation {
                run.starting = false;
                return Ok(());
            }
            run.starting = false;
        }
        if let Err(error) = result {
            let closed = inner.closed;
            let needs_repair = needs_repair_text(&error.message)
                || inner.runs.get(id).is_some_and(|run| {
                    read_rules(&run.binding.root, run.binding.rules_dir.as_deref()).is_err()
                });
            let mut released = None;
            if let Some(run) = inner.runs.get_mut(id) {
                if !run.binding.enabled || closed {
                    return Ok(());
                }
                if run.owns_identity {
                    released = Some(run.identity.clone());
                }
                run.identity = String::new();
                run.owns_identity = false;
                run.error = error.message.clone();
                if needs_repair {
                    run.status = "error".into();
                }
            }
            if let Some(identity) = released {
                inner.identities.remove(&identity);
            }
            if !needs_repair {
                drop(inner);
                self.schedule_reconnect(id);
                return Err(error);
            }
            let owners = self.persist_run_and_notify(&mut inner, id);
            drop(inner);
            self.bump_owners(owners);
            return Err(error);
        }
        let owners = self.persist_run_and_notify(&mut inner, id);
        drop(inner);
        self.bump_owners(owners);
        Ok(())
    }

    pub(crate) fn persist_all_snapshot(&self) {
        let inner = self.lock();
        self.persist_bindings(&inner);
    }

    pub(crate) async fn start_run(
        self: &Arc<Self>,
        id: &str,
        generation: u64,
    ) -> Result<(), MessageError> {
        let (binding, rules) = {
            let inner = self.lock();
            Self::assert_exists(&inner, id)?;
            let run = inner.runs.get(id).unwrap();
            if inner.closed || !run.binding.enabled || run.generation != generation {
                return Ok(());
            }
            (
                run.binding.clone(),
                Some(read_rules(
                    &run.binding.root,
                    run.binding.rules_dir.as_deref(),
                )?),
            )
        };
        let binding_id = binding.id.clone();
        let all_groups = !self.available_agents(&binding).is_empty();
        if binding.channel == "feishu" {
            let (identity, self_open_id) =
                feishu_identity_checked(&binding.root, &binding.profile).await?;
            {
                let mut inner = self.lock();
                let run = inner.runs.get(&binding_id).unwrap();
                if !run.binding.enabled || inner.closed || run.generation != generation {
                    return Ok(());
                }
                let identity_key = format!("feishu:{identity}");
                if inner.identities.contains(&identity_key) {
                    return Err(MessageError::bad("This account already has a listener"));
                }
                inner.identities.insert(identity_key.clone());
                let run = inner.runs.get_mut(&binding_id).unwrap();
                run.identity = identity_key;
                run.owns_identity = true;
                run.self_id = self_open_id;
                run.since = 0;
                if let Some(rules) = &rules {
                    run.subscriptions = subscription_key(&rules.0, all_groups);
                }
                run.status = "connecting".into();
            }
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            {
                let mut inner = self.lock();
                if let Some(run) = inner.runs.get_mut(&binding_id) {
                    run.stop = Some(stop_tx);
                    run.status = "listening".into();
                    run.retrying = false;
                    run.error = String::new();
                }
            }
            let owners = {
                let mut inner = self.lock();
                self.persist_run_and_notify(&mut inner, id)
            };
            self.bump_owners(owners);
            tokio::spawn(feishu_poll_task(self.clone(), binding_id.clone(), stop_rx));
            return Ok(());
        }

        // DingTalk: verify identity, then spawn the ndjson listener farm.
        let status = dingtalk_status(&binding.root, &binding.profile).await?;
        if !dingtalk_identity_matches(&status, &binding.profile) {
            let _ = &status;
            return Err(MessageError::bad(
                "DWS identity does not match configured profile",
            ));
        }
        let identity = status["identity"].clone();
        let open_id = identity["open_dingtalk_id"]
            .as_str()
            .or(identity["openDingTalkId"].as_str())
            .unwrap_or("");
        let consumers = status
            .pointer("/bus/live/consumers")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        let subscriptions = status["subscriptions"]
            .as_array()
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if consumers || subscriptions {
            return Err(MessageError::bad(
                "已有个人消息桥正在监听此身份，或存在个人事件订阅；等待占用释放后自动连接，不会抢占或删除订阅",
            ));
        }
        {
            let mut guard = self.lock();
            let inner: &mut Inner = &mut guard;
            let run = inner.runs.get(&binding_id).unwrap();
            if !run.binding.enabled || inner.closed || run.generation != generation {
                return Ok(());
            }
            if inner.identities.contains(&binding.profile) {
                return Err(MessageError::bad("This account already has a listener"));
            }
            let run = inner.runs.get_mut(&binding_id).unwrap();
            inner.identities.insert(binding.profile.clone());
            run.owns_identity = true;
            run.identity = binding.profile.clone();
            run.self_id = open_id.to_string();
            run.since = now_ms();
            if let Some(rules) = &rules {
                run.subscriptions = subscription_key(&rules.0, all_groups);
            }
            run.status = "connecting".into();
        }
        let config = rules.map(|(config, _prompt)| config).unwrap_or_default();
        let program = resolve_dws().map_err(|error| MessageError::bad(error.message.clone()))?;
        let sets = listener_args(&config, all_groups);
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        {
            let mut inner = self.lock();
            if inner.closed {
                return Ok(());
            }
            let run = inner.runs.get_mut(id).unwrap();
            if run.generation != generation || !run.binding.enabled {
                return Ok(());
            }
            run.stop = Some(stop_tx.clone());
            run.listener_done = Some(done_rx);
        }
        let children = match start_listener_children(
            &program,
            &sets,
            &binding.profile,
            &binding.root,
            &mut stop_rx,
        )
        .await
        {
            Ok(children) => children,
            Err(error) => {
                let _ = done_tx.send(true);
                return Err(error);
            }
        };
        {
            let outcome = {
                let mut guard = self.lock();
                let inner: &mut Inner = &mut guard;
                match inner.runs.get_mut(&binding_id) {
                    None => Some(()),
                    Some(run) => {
                        if !run.binding.enabled || inner.closed || run.generation != generation {
                            Some(())
                        } else {
                            run.status = "listening".into();
                            run.retrying = false;
                            run.error = String::new();
                            None
                        }
                    }
                }
            };
            if let Some(()) = outcome {
                reap_listener_children(children).await;
                let _ = done_tx.send(true);
                return Ok(());
            }
        }
        let owners = {
            let mut inner = self.lock();
            self.persist_run_and_notify(&mut inner, &binding_id)
        };
        self.bump_owners(owners);
        tokio::spawn(supervise_listeners(
            Arc::clone(self),
            binding_id,
            generation,
            children,
            stop_tx,
            done_tx,
        ));
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        let mut inner = self.lock();
        let Some(run) = inner.runs.get_mut(id) else {
            return;
        };
        run.binding.enabled = false;
        let released = if run.owns_identity {
            Some(run.identity.clone())
        } else {
            None
        };
        run.identity = String::new();
        run.owns_identity = false;
        halt_runtime(run);
        if let Some(identity) = released {
            inner.identities.remove(&identity);
        }
        let owners = self.persist_run_and_notify(&mut inner, id);
        drop(inner);
        self.bump_owners(owners);
    }

    pub async fn disconnected(self: &Arc<Self>, id: &str, error: &str) {
        self.disconnected_generation(id, error, None).await;
    }

    pub(crate) async fn disconnected_generation(
        self: &Arc<Self>,
        id: &str,
        error: &str,
        generation: Option<u64>,
    ) {
        let current_generation = {
            let mut guard = self.lock();
            let inner: &mut Inner = &mut guard;
            if inner.closed {
                return;
            }
            let Some(run) = inner.runs.get_mut(id) else {
                return;
            };
            if !run.binding.enabled || generation.is_some_and(|value| value != run.generation) {
                return;
            }
            if run.owns_identity {
                inner.identities.remove(&run.identity);
            }
            if let Some(stop) = run.stop.take() {
                stop.send_replace(true);
            }
            run.identity = String::new();
            run.owns_identity = false;
            run.error = error.to_string();
            run.generation
        };
        self.schedule_reconnect_generation(id, Some(current_generation));
    }

    /// Shutdown preserves the saved auto-reply preference, while ensuring no
    /// owned DingTalk consumer survives a graceful daemon exit.
    pub async fn close(&self) {
        {
            let mut inner = self.lock();
            inner.closed = true;
            for run in inner.runs.values_mut() {
                halt_runtime(run);
            }
        }
        let _start = self.start_gate.lock().await;
        let completions: Vec<_> = self
            .lock()
            .runs
            .values()
            .filter_map(|run| run.listener_done.clone())
            .collect();
        for mut done in completions {
            loop {
                let finished = *done.borrow();
                if finished || done.changed().await.is_err() {
                    break;
                }
            }
        }
    }

    pub(crate) fn schedule_reconnect(self: &Arc<Self>, id: &str) {
        self.schedule_reconnect_generation(id, None);
    }

    fn schedule_reconnect_generation(self: &Arc<Self>, id: &str, expected: Option<u64>) {
        let generation = {
            let mut inner = self.lock();
            if inner.closed {
                return;
            }
            let Some(run) = inner.runs.get_mut(id) else {
                return;
            };
            if !run.binding.enabled
                || run.retrying
                || expected.is_some_and(|generation| generation != run.generation)
            {
                return;
            }
            run.retrying = true;
            run.status = "reconnecting".into();
            run.next_retry_at = Some(now_ms() + RECONNECT_DELAY);
            run.generation
        };
        tokio::spawn(reconnect_task(Arc::clone(self), id.to_string(), generation));
        let mut inner = self.lock();
        let owners = self.persist_run_and_notify(&mut inner, id);
        drop(inner);
        self.bump_owners(owners);
    }
} // end impl MessagingService (Part 7/8)

// ---------------------------------------------------------------------------
// Background tasks: reconnect, Feishu polling, pump
// ---------------------------------------------------------------------------

pub(crate) async fn reconnect_task(service: Arc<MessagingService>, id: String, generation: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(RECONNECT_DELAY as u64)).await;
    {
        let mut inner = service.lock();
        let Some(run) = inner.runs.get_mut(&id) else {
            return;
        };
        if run.generation != generation {
            return;
        }
        run.retrying = false;
        run.next_retry_at = None;
        if !run.binding.enabled {
            return;
        }
    }
    let _ = service.start_generation(&id, Some(generation)).await;
}

pub(crate) fn channel_conflict(channel: &str, occupied: &str, root: String) -> Value {
    let confirmation_required = occupied != root;
    json!({
        "error": MessagingService::channel_conflict_message(channel, occupied, &root),
        "code": "CHANNEL_OCCUPIED",
        "channel": channel,
        "occupiedRoot": occupied,
        "requestedRoot": root,
        "confirmationRequired": confirmation_required,
    })
}

pub(crate) fn select_profile(value: &Value) -> Option<String> {
    let rows = value["profiles"].as_array()?;
    let current: Vec<&Value> = rows
        .iter()
        .filter(|row| row["current"].as_bool() == Some(true))
        .collect();
    if current.len() == 1 {
        return current[0]["id"].as_str().map(str::to_string);
    }
    if rows.len() == 1 {
        return rows[0]["id"].as_str().map(str::to_string);
    }
    None
}

pub(crate) async fn feishu_poll_task(
    service: Arc<MessagingService>,
    binding_id: String,
    stop: tokio::sync::watch::Receiver<bool>,
) {
    let cursor_path = {
        let inner = service.lock();
        match inner.runs.get(&binding_id) {
            Some(run) => service.home.join(format!("{}.cursor.json", run.binding.id)),
            None => return,
        }
    };
    let mut checkpoint = {
        let mut parsed = FeishuCheckpoint {
            since: now_ms(),
            window: None,
        };
        if let Ok(text) = std::fs::read_to_string(&cursor_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(since) = value["since"].as_i64() {
                    parsed.since = since;
                }
                parsed.window = value.get("window").cloned().filter(Value::is_object);
            }
        }
        write_json_private(
            &cursor_path,
            &json!({ "since": parsed.since, "window": parsed.window }),
        );
        parsed
    };
    let mut stop = stop;
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if *stop.borrow() {
                    break;
                }
                let _ = changed;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL as u64)) => {}
        }
        if *stop.borrow() {
            break;
        }
        let (root, profile) = {
            let inner = service.lock();
            match inner.runs.get(&binding_id) {
                Some(run) => (run.binding.root.clone(), run.binding.profile.clone()),
                None => break,
            }
        };
        let outcome = feishu_sweep(
            &service,
            &binding_id,
            &root,
            &profile,
            &mut checkpoint,
            &cursor_path,
        )
        .await;
        match outcome {
            Ok(()) => {}
            Err(message) => {
                if *stop.borrow() {
                    break;
                }
                if needs_repair_text(&message) {
                    let mut guard = service.lock();
                    let inner: &mut Inner = &mut guard;
                    let (identity, owns) = match inner.runs.get(&binding_id) {
                        Some(run) => (run.identity.clone(), run.owns_identity),
                        None => break,
                    };
                    if let Some(run) = inner.runs.get_mut(&binding_id) {
                        run.status = "error".into();
                        run.error = message.clone();
                        run.owns_identity = false;
                        run.identity = String::new();
                    }
                    if owns {
                        inner.identities.remove(&identity);
                    }
                    let owners = service.persist_run_and_notify(&mut guard, &binding_id);
                    drop(guard);
                    service.bump_owners(owners);
                    break;
                }
                {
                    let mut inner = service.lock();
                    if let Some(run) = inner.runs.get_mut(&binding_id) {
                        run.status = "listening-tick".into();
                    }
                }
                service
                    .disconnected(&binding_id, "Listener disconnected")
                    .await;
                break;
            }
        }
    }
    let mut inner = service.lock();
    if let Some(run) = inner.runs.get_mut(&binding_id) {
        run.stop = None;
        if run.status == "listening" || run.status == "listening-tick" {
            run.status = "stopped".into();
        }
    }
}

/// One bounded poll sweep, mirroring Node `pollFeishu` sweep semantics: a
/// single 50-row search page over the trailing window; `has_more` keeps its
/// token for the next tick instead of bursting through all pages.
pub(crate) async fn feishu_sweep(
    service: &Arc<MessagingService>,
    binding_id: &str,
    root: &str,
    profile: &str,
    checkpoint: &mut FeishuCheckpoint,
    cursor_path: &Path,
) -> Result<(), String> {
    let identity = feishu_identity(root, Some(profile))
        .await
        .map_err(|error| error.message)?;
    let end = now_ms();
    let window = match checkpoint.window.take() {
        Some(window) => window,
        None => {
            json!({ "start": std::cmp::max(checkpoint.since, end - 660_000), "end": end, "token": "" })
        }
    };
    checkpoint.window = Some(window.clone());
    write_json_private(
        cursor_path,
        &json!({ "since": checkpoint.since, "window": checkpoint.window }),
    );
    let start = window["start"].as_i64().unwrap_or(0);
    let end_at = window["end"].as_i64().unwrap_or(end);
    let mut args = vec![
        "im".to_string(),
        "+messages-search".to_string(),
        "--start".to_string(),
        iso_ms(start),
        "--end".to_string(),
        iso_ms(end_at),
        "--page-size".to_string(),
        "50".to_string(),
        "--no-reactions".to_string(),
        "--as".to_string(),
        "user".to_string(),
        "--profile".to_string(),
        profile.split(':').next().unwrap_or(profile).to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    let saved_token = window["token"].as_str().unwrap_or("").to_string();
    if !saved_token.is_empty() {
        args.push("--page-token".into());
        args.push(saved_token.clone());
    }
    let result = lark_call(&args, root)
        .await
        .map_err(|error| error.message)?;
    let data = feishu_page(&result);
    let rows = data["messages"]
        .as_array()
        .cloned()
        .ok_or_else(|| "Unexpected Feishu search response".to_string())?;
    let has_more = data["has_more"].as_bool() == Some(true);
    let token = data["page_token"].as_str().unwrap_or("").to_string();
    if has_more && (token.is_empty() || token == saved_token) {
        return Err("Feishu pagination incomplete".into());
    }
    for row in &rows {
        let chat_id = row["chat_id"].as_str().unwrap_or("");
        let chat_type = row["chat_type"].as_str().unwrap_or("");
        if chat_id.is_empty() || !matches!(chat_type, "p2p" | "group") {
            continue;
        }
        let Some(message) = feishu_incoming(
            row,
            &json!({ "chat_id": chat_id, "chat_mode": chat_type }),
            &identity.1,
        ) else {
            continue;
        };
        if message.time < start || message.time > end_at {
            continue;
        }
        service.handle_incoming(binding_id, message, false).await;
    }
    if has_more {
        let Some(window) = checkpoint.window.as_mut() else {
            return Ok(());
        };
        window["token"] = json!(token);
    } else {
        checkpoint.window = None;
    }
    write_json_private(
        cursor_path,
        &json!({ "since": checkpoint.since, "window": checkpoint.window }),
    );
    let mut inner = service.lock();
    if let Some(run) = inner.runs.get_mut(binding_id) {
        run.last_poll_at = Some(end);
    }
    Ok(())
}

// ---------------------------------------------------------------------------

// Free function so `decide_incoming` can stop a run without borrowing `self`.
pub(crate) fn halt_runtime(run: &mut Runtime) {
    run.generation = run.generation.wrapping_add(1);
    run.retrying = false;
    run.next_retry_at = None;
    if let Some(stop) = run.stop.take() {
        stop.send_replace(true);
        drop(stop);
    }
    for queue in run.queues.values_mut() {
        while let Some(job) = queue.pop_front() {
            if let Some(receipt) = run
                .receipts
                .iter_mut()
                .find(|receipt| receipt["id"].as_str() == Some(job.receipt_id.as_str()))
            {
                receipt["state"] = json!("cancelled");
            }
        }
    }
    run.queues.clear();

    run.active.clear();
    run.status = "stopped".into();
    run.error = String::new();
}

/// Owner hashes attached to a binding: the bound persona owner plus peer
/// owners, deduplicated. The SSE wake list for personas watchers.
pub(crate) fn binding_owners(inner: &Inner, id: &str) -> Vec<String> {
    let mut owners: Vec<String> = Vec::new();
    if let Some(run) = inner.runs.get(id) {
        if let Some(owner) = &run.binding.agent_owner {
            owners.push(owner.clone());
        }
        for peer in &run.binding.peers {
            if let Some(owner) = peer["owner"].as_str() {
                owners.push(owner.to_string());
            }
        }
    }
    owners.sort();
    owners.dedup();
    owners
}
