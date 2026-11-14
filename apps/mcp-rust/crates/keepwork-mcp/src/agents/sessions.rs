use super::*;

impl AgentManager {
    pub(super) fn accounts(&self) -> Value {
        let quote = |word: &str| {
            if cfg!(windows) {
                format!("'{}'", word.replace('\'', "''"))
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        };
        let mut catalog = serde_json::Map::new();
        for backend in BACKENDS {
            let spec = definition(backend).unwrap();
            let mut item = json!({"name":spec.name,"available":false,"actions":{}});
            match discover(backend) {
                Err(error) => item["error"] = json!(error),
                Ok(launch) => {
                    item["available"] = json!(true);
                    item["cli"] = launch.info();
                    let (login, logout, input): (Vec<&str>, Option<Vec<&str>>, Option<&str>) =
                        match *backend {
                            "codex" | "cursor" => (vec!["login"], Some(vec!["logout"]), None),
                            "claude" | "opencode" => {
                                (vec!["auth", "login"], Some(vec!["auth", "logout"]), None)
                            }
                            "workbuddy" | "codebuddy" => {
                                (vec!["/login"], Some(vec![]), Some("/logout"))
                            }
                            "kimi" | "copilot" => (vec!["login"], Some(vec![]), Some("/logout")),
                            "qwen" => (vec![], None, Some("/auth")),
                            "deepseek" => (vec!["web"], None, None),
                            "trae" => (vec!["--help"], None, None),
                            _ => (vec![], Some(vec![]), Some("/logout")),
                        };
                    let command = |args: Vec<&str>| {
                        let prefix_len = launch.args.len().saturating_sub(spec.args.len());
                        let mut words = vec![quote(&launch.executable.to_string_lossy())];
                        words.extend(launch.args[..prefix_len].iter().map(|a| quote(a)));
                        words.extend(args.iter().map(|a| quote(a)));
                        format!(
                            "{}{}",
                            if cfg!(windows) { "& " } else { "" },
                            words.join(" ")
                        )
                    };
                    item["actions"]["login"] = json!({"label":"登录","command":command(login)});
                    if *backend == "trae" {
                        item["actions"]["login"]["label"] = json!("配置模型提供商");
                    }
                    if *backend == "qwen" {
                        item["actions"]["login"]["input"] = json!(input);
                    }
                    if let Some(args) = logout {
                        item["actions"]["logout"] = json!({"label":"登出","command":command(args)});
                        if let Some(input) = input {
                            item["actions"]["logout"]["input"] = json!(input);
                        }
                    }
                }
            }
            catalog.insert(backend.to_string(), item);
        }
        Value::Object(catalog)
    }
    pub(super) fn list(
        &self,
        owner: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, String> {
        let offset = query
            .get("cursor")
            .map(|s| s.parse::<usize>())
            .transpose()
            .map_err(|_| "Invalid list cursor")?
            .unwrap_or(0);
        if offset > 10_000 {
            return Err("Invalid list cursor".into());
        }
        let mut sessions = self.sessions.lock().expect("agent sessions");
        let recovering: std::collections::HashSet<_> = sessions
            .iter()
            .filter(|(_, s)| {
                s.data["owner"] == owner
                    && s.data["removed"] != true
                    && s.data.get(NATIVE_PERSISTENCE_ERROR).is_some()
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !recovering.is_empty() {
            let _ = self.persist_with_histories(&mut sessions, |id| recovering.contains(id));
        }
        let mut rows = sessions
            .values()
            .filter(|s| s.data["owner"] == owner && s.data["removed"] != true)
            .map(|s| {
                let mut view = snapshot(&s.data);
                view["items"] = json!([]);
                view["pending"] = json!([]);
                view
            })
            .collect::<Vec<_>>();
        rows.sort_by_key(|s| std::cmp::Reverse(s["updatedAt"].as_i64().unwrap_or(0)));
        let rows = rows.into_iter().skip(offset).take(100).collect::<Vec<_>>();
        Ok(
            json!({"nextCursor":if rows.len()==100 {json!(offset+100)}else{Value::Null},"sessions":rows}),
        )
    }

    pub(super) async fn backends(
        self: &Arc<Self>,
        owner: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, String> {
        let selected = query.get("backend").map(String::as_str);
        if selected.is_some_and(|id| definition(id).is_none()) {
            return Err("Unsupported agent backend".into());
        }
        let mut result = serde_json::Map::new();
        for backend in BACKENDS
            .iter()
            .copied()
            .filter(|id| selected.is_none_or(|selected| selected == *id))
        {
            let spec = definition(backend).unwrap();
            let launch = discover(backend);
            let mut value = json!({"name":spec.name,"protocol":spec.protocol.as_str(),"protocolSupported":spec.protocol.supported(),"installUrl":spec.install_url,"available":launch.is_ok(),"authenticated":null,"authState":"unknown","probe":"executable","models":[]});
            if backend == "trae" {
                value["aichatContext"] = json!(false);
                value["executionMode"] = json!("one-shot");
                value["supportedModes"] = json!(["craft"]);
            }
            if backend == "codex" {
                value["approvalModes"] = json!(approval::MODES);
            }
            match launch {
                Ok(launch) => value["cli"] = launch.info(),
                Err(error) => {
                    value["error"] = json!(error);
                    result.insert(backend.into(), value);
                    continue;
                }
            }
            if query.get("probe").map(String::as_str) == Some("executable") {
                result.insert(backend.into(), value);
                continue;
            }
            if !spec.protocol.supported() {
                // Finding a CLI and supporting its session protocol are separate
                // observations. Preserve executable evidence and classify this
                // boundary so setup can inspect/reuse the installation without
                // treating an unavailable adapter as an installer failure.
                value["available"] = json!(false);
                value["setup"] = json!("unsupported");
                value["code"] = json!("UNSUPPORTED_FEATURE");
                value["error"] = json!(format!(
                    "UNSUPPORTED_FEATURE: {} native protocol is not yet available in Rust MCP",
                    spec.name
                ));
                result.insert(backend.into(), value);
                continue;
            }
            let scoped = if let Some(session_id) = query.get("sessionId") {
                let data = self.view(session_id, owner)?;
                if data["backend"] != backend {
                    return Err("Agent backend mismatch".into());
                }
                Some(data)
            } else {
                None
            };
            if let Some(conversation) = query.get("conversationId") {
                if !valid_id(conversation) {
                    return Err("Invalid conversation ID".into());
                }
            }
            let cwd = if let Some(data) = &scoped {
                canonical_root(data["roots"][0].as_str().ok_or("Workspace unavailable")?)?
            } else if let Some(cwd) = query.get("cwd") {
                canonical_root(cwd)?
            } else {
                let cwd = self
                    .file
                    .parent()
                    .unwrap()
                    .join("agent-workspaces/model-discovery");
                std::fs::create_dir_all(&cwd)
                    .map_err(|_| "Model discovery workspace unavailable")?;
                canonical_root(&cwd.to_string_lossy())?
            };
            let status: Result<Value, String> = async {
                // Cursor caches the native login state at process startup. Keep
                // prompt-free previews separate so a rejected preview can be
                // retired without interrupting an owned or in-flight session.
                let cursor_preview = backend == "cursor" && scoped.is_none();
                // Acquire the preview under the catalog lock as well: a queued
                // probe must not retain a process retired by an earlier probe.
                let mut preview_catalog = if cursor_preview {
                    Some(self.catalogs.lock().await)
                } else {
                    None
                };
                let harness = self.harness_for(backend, &cwd, cursor_preview).await?;
                value["probe"] = json!("protocol");
                value["cli"] = harness.cli_info();
                if matches!(spec.protocol, Protocol::Codex | Protocol::Claude | Protocol::Antigravity | Protocol::Trae) {
                    let account = harness
                        .call("account/read", json!({"refreshToken":false,"refresh":query.get("refresh").map(String::as_str)==Some("1")}), RPC_TIMEOUT)
                        .await?;
                    if let Some(probe) = account.get("probe") { value["probe"] = probe.clone(); }
                    if account["authUnknown"] == true {
                        value["authenticated"] = Value::Null;
                        value["authState"] = json!("unknown");
                    } else {
                        let authenticated =
                            account["account"].is_object() || account["requiresOpenaiAuth"] == false;
                        value["authenticated"] = json!(authenticated);
                        value["authState"] = json!(if authenticated { "verified" } else { "required" });
                    }
                    if let Some(account) = account["account"].as_object() {
                        let mut display = serde_json::Map::new();
                        for key in ["type", "email", "username", "name", "planType"] {
                            if let Some(v) = account.get(key) {
                                display.insert(key.into(), v.clone());
                            }
                        }
                        value["account"] = Value::Object(display);
                    }
                    match harness
                        .call("model/list", json!({"limit":100,"refresh":spec.protocol != Protocol::Antigravity && query.get("refresh").map(String::as_str)==Some("1")}), RPC_TIMEOUT)
                        .await
                    {
                        Ok(models) => {
                            value["models"] = models.get("data").cloned().unwrap_or(json!([]))
                        }
                        Err(error) => value["modelsError"] = json!(error),
                    }
                } else {
                    // Metadata sessions never receive a prompt, tools or an owner grant.
                    let key = format!(
                        "{backend}\0{}\0{}",
                        cwd.display(),
                        query.get("model").map(String::as_str).unwrap_or("")
                    );
                    let mut cache = match preview_catalog.take() {
                        Some(cache) => cache,
                        None => self.catalogs.lock().await,
                    };
                    if query.get("refresh").map(String::as_str) == Some("1") {
                        cache.remove(&key);
                    }
                    let metadata = if let Some(data) = &scoped {
                        let sessions = self.sessions.lock().unwrap();
                        let session = &sessions[data["id"].as_str().unwrap()];
                        if session
                            .harness
                            .as_ref()
                            .is_some_and(|old| Arc::ptr_eq(old, &harness))
                            && !session.native.is_null()
                        {
                            Some(session.native.clone())
                        } else {
                            None
                        }
                    } else {
                        cache
                            .get(&key)
                            .cloned()
                            .filter(|entry| entry["_pidGeneration"] == harness.generation())
                    };
                    let mut metadata = if let Some(data) = metadata {
                        data
                    } else {
                        match harness
                            .call(
                                "session/new",
                                json!({"cwd":cwd,"mcpServers":[]}),
                                RPC_TIMEOUT,
                            )
                            .await
                        {
                            Ok(mut native) => {
                                if let Some(model) = query.get("model") {
                                    // Discovery receives a saved preference, which may
                                    // outlive a provider's catalog. Keep explicit
                                    // create/turn model requests strict.
                                    let models = harness::normalize_models(&native);
                                    if scoped.is_some()
                                        || models.is_empty()
                                        || models.iter().any(|m| m["id"] == *model)
                                    {
                                        self.set_acp_model(&harness, &mut native, model).await?;
                                    }
                                }
                                native["_pidGeneration"] = json!(harness.generation());
                                if cache.len() >= 64 {
                                    cache.clear();
                                }
                                cache.insert(key, native.clone());
                                native
                            }
                            Err(error) => {
                                if cursor_preview
                                    && error == "Native RPC rejected: Authentication required"
                                {
                                    // Do not replay this request or start browser
                                    // authentication. The next probe reads the
                                    // login completed in the user's terminal.
                                    harness.close();
                                }
                                value["modelsError"] = json!(error);
                                json!({})
                            }
                        }
                    };
                    if let Some(data) = &scoped {
                        let gate = self.sessions.lock().unwrap()[data["id"].as_str().unwrap()]
                            .configuration
                            .clone();
                        let _guard = gate.lock().await;
                        let current = self.view(data["id"].as_str().unwrap(), owner)?;
                        let loaded = self.sessions.lock().unwrap()[data["id"].as_str().unwrap()]
                            .harness
                            .as_ref()
                            .is_some_and(|old| Arc::ptr_eq(old, &harness));
                        if loaded
                            && current["archived"] != true
                            && !ACTIVE.contains(&current["status"].as_str().unwrap_or(""))
                        {
                            if let Some(model) = query.get("model") {
                                if metadata["sessionId"].is_string() {
                                    self.set_acp_model(&harness, &mut metadata, model).await?;
                                    self.sessions
                                        .lock()
                                        .unwrap()
                                        .get_mut(data["id"].as_str().unwrap())
                                        .unwrap()
                                        .native = metadata.clone();
                                }
                            }
                        }
                    }
                    value["models"] = json!(harness::normalize_models(&metadata));
                    if value["modelsError"]
                        .as_str()
                        .is_some_and(|e| e.to_ascii_lowercase().contains("authentication required"))
                    {
                        value["authenticated"] = json!(false);
                        value["authState"] = json!("required");
                    }
                }
                Ok(value.clone())
            }
            .await;
            match status {
                Ok(ready) => value = ready,
                Err(error) => {
                    value["available"] = json!(false);
                    value["error"] = json!(error);
                }
            }
            result.insert(backend.into(), value);
        }
        Ok(Value::Object(result))
    }

    pub(super) async fn login(self: &Arc<Self>, input: &Value) -> Result<Value, String> {
        let backend = input["backend"].as_str().unwrap_or("codex");
        let spec = definition(backend).ok_or("Unsupported agent backend")?;
        if backend == "trae" {
            return Ok(
                json!({"command":"trae-cli --help","message":"Configure your provider API key and model in Trae Agent’s native trae_config.yaml or environment, then reconnect. Trae Agent has no account login command."}),
            );
        }
        if backend != "codex" {
            return Ok(
                json!({"command":spec.login,"message":"Run this command in your terminal to sign in, then reconnect."}),
            );
        }
        let cwd = self
            .file
            .parent()
            .unwrap()
            .join("agent-workspaces/model-discovery");
        std::fs::create_dir_all(&cwd).map_err(|_| "Workspace unavailable")?;
        let result = self
            .harness(backend, &cwd)
            .await?
            .call(
                "account/login/start",
                json!({"type":"chatgpt"}),
                RPC_TIMEOUT,
            )
            .await?;
        let url = result["authUrl"]
            .as_str()
            .filter(|url| url.starts_with("https://"))
            .ok_or("CLI did not return an HTTPS login URL")?;
        Ok(json!({"url":url}))
    }

    pub(super) async fn create(
        self: &Arc<Self>,
        owner: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let _guard = self.creation.lock().await;
        let conversation = input["conversationId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("Conversation ID required")?;
        let backend = optional_text(input, "backend", 160)?.unwrap_or_else(|| "codex".into());
        let backend = backend.as_str();
        let spec = definition(backend).ok_or("Unsupported agent backend")?;
        let requested_model = optional_text(input, "model", 1024)?;
        if optional_text(input, "effort", 256)?.is_some() {
            return Err(
                "UNSUPPORTED_FEATURE: Select reasoning effort on the session's next turn".into(),
            );
        }
        let contextual = match input.get("contextVersion") {
            None => false,
            Some(value) if *value == 1 => true,
            _ => return Err("UNSUPPORTED_FEATURE: Unsupported AIChat context version".into()),
        };
        if input.get("cloudPrimary").is_some_and(|v| !v.is_boolean()) {
            return Err("Invalid cloudPrimary".into());
        }
        if input["cloudPrimary"] == true && !contextual {
            return Err(
                "UNSUPPORTED_FEATURE: Cloud primary requires a registered AIChat context".into(),
            );
        }
        if input.get("roots").is_some_and(|v| !v.is_array()) {
            return Err("Workspace roots must be an array".into());
        }
        if input.get("rootNames").is_some_and(|v| {
            !v.as_array()
                .is_some_and(|names| names.len() <= 16 && names.iter().all(Value::is_string))
        }) {
            return Err("Invalid workspace names".into());
        }
        let selected_mode = mode(input.get("mode"), "craft")?;
        let selected_approval = approval::selected(input.get("approvalMode"), backend, None)?;
        if !spec.protocol.supported() {
            return Err(
                "UNSUPPORTED_FEATURE: This native CLI protocol is not yet available in Rust MCP"
                    .into(),
            );
        }
        if backend == "copilot" && contextual {
            return Err("UNSUPPORTED_FEATURE: This Copilot CLI requires process-scoped MCP configuration, which this Rust adapter does not yet provide; its native session cannot claim AIChat tools".into());
        }
        {
            let sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.values().find(|s| {
                s.data["owner"] == owner
                    && s.data["conversationId"] == conversation
                    && s.data["backend"] == backend
                    && s.data["removed"] != true
            }) {
                if contextual && s.data["aichatContext"] != true {
                    return Err("UNSUPPORTED_FEATURE: This existing session has no AIChat context; start a new conversation".into());
                }
                if requested_model
                    .as_deref()
                    .is_some_and(|model| s.data["model"].as_str() != Some(model))
                {
                    return Err(
                        "Existing session model differs; select the model on its next turn".into(),
                    );
                }
                if input["cloudPrimary"] == true {
                    let temporary = self
                        .file
                        .parent()
                        .unwrap()
                        .join("agent-workspaces")
                        .join(owner)
                        .join(conversation);
                    let temporary = path_identity::normalize(temporary);
                    if s.data["roots"][0].as_str() != Some(temporary.to_string_lossy().as_ref()) {
                        return Err(
                            "Existing session primary workspace differs; start a new conversation"
                                .into(),
                        );
                    }
                }
                if let Some(mode) = input.get("mode") {
                    if *mode != s.data["mode"] {
                        return Err(
                            "Existing session mode differs; select the mode on its next turn"
                                .into(),
                        );
                    }
                }
                if let Some(roots) = input["roots"].as_array() {
                    let expected = roots
                        .iter()
                        .map(|v| {
                            canonical_root(v.as_str().ok_or("Invalid workspace root")?)
                                .map(|p| json!(p))
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    let temporary = self
                        .file
                        .parent()
                        .unwrap()
                        .join("agent-workspaces")
                        .join(owner)
                        .join(conversation);
                    let temporary = path_identity::normalize(temporary);
                    let stored = s.data["roots"].as_array().unwrap();
                    let stored = if stored
                        .first()
                        .is_some_and(|v| v.as_str() == Some(temporary.to_string_lossy().as_ref()))
                    {
                        &stored[1..]
                    } else {
                        stored.as_slice()
                    };
                    if expected != stored {
                        return Err(
                            "Existing session workspace differs; start a new conversation".into(),
                        );
                    }
                }
                return Ok(self.render(&s.data));
            }
        }
        if self.load_error.is_some() {
            return Err(self.load_error.clone().unwrap());
        }
        if self.sessions.lock().unwrap().len() >= MAX_SESSIONS {
            return Err("Agent session limit reached".into());
        }
        if contextual {
            self.context.context(owner, conversation)?;
        }
        let mut root_input = input.clone();
        if contextual
            && (input["roots"].as_array().is_some_and(|r| r.is_empty())
                || input["roots"].is_null()
                || input["cloudPrimary"] == true)
        {
            let cwd = self
                .file
                .parent()
                .unwrap()
                .join("agent-workspaces")
                .join(owner)
                .join(conversation);
            std::fs::create_dir_all(&cwd).map_err(|_| "Workspace unavailable")?;
            let mut roots = vec![json!(cwd)];
            if let Some(extra) = input["roots"].as_array() {
                roots.extend(extra.iter().cloned());
            }
            root_input["roots"] = json!(roots);
            let mut names = vec![json!("CLI temporary runtime")];
            if let Some(extra) = input["rootNames"].as_array() {
                names.extend(extra.iter().cloned());
            }
            root_input["rootNames"] = json!(names);
        }
        let roots = checked_roots(&root_input)?;
        let root_names = roots
            .iter()
            .enumerate()
            .map(|(i, root)| {
                root_input["rootNames"][i]
                    .as_str()
                    .map(|s| {
                        s.chars()
                            .filter(|c| *c != '\n' && *c != '\r')
                            .take(200)
                            .collect::<String>()
                    })
                    .unwrap_or_else(|| {
                        Path::new(root)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    })
            })
            .collect::<Vec<_>>();
        let harness = self.harness(backend, Path::new(&roots[0])).await?;
        self.context.set_mode(owner, conversation, &selected_mode);
        self.context
            .set_approval_mode(owner, conversation, selected_approval.as_deref());
        let (server, context_marker) = if contextual {
            let (descriptor, marker) =
                self.context
                    .descriptor_with_marker(owner, conversation, self.port)?;
            (Some(descriptor), Some(marker))
        } else {
            (None, None)
        };
        let mut parameters =
            json!({"cwd":roots[0],"mcpServers":server.clone().into_iter().collect::<Vec<_>>()});
        if spec.protocol == Protocol::Codex {
            let access =
                approval::access(&selected_mode, selected_approval.as_deref(), &json!(roots));
            parameters =
                json!({"cwd":roots[0],"sandbox":access.sandbox,"approvalPolicy":access.policy});
            if access.sandbox == "workspace-write" {
                parameters["config"] = json!({"sandbox_workspace_write":{"writable_roots":roots,"network_access":false}});
            }
            if let Some(server) = server {
                parameters["config"]["mcp_servers"] = codex_server(&server)["mcp_servers"].clone();
                parameters["developerInstructions"]=json!("Use keepwork_aichat tools and the versioned aichat_context supplied each turn. Preserve native instructions.");
            }
        } else if matches!(
            spec.protocol,
            Protocol::Claude | Protocol::Antigravity | Protocol::Trae
        ) {
            parameters["roots"] = json!(roots);
            parameters["mode"] = json!(selected_mode);
            if contextual {
                parameters["aichatInstructions"] = json!("Use keepwork_aichat tools and the versioned aichat_context supplied each turn. Preserve native instructions.");
            }
        }
        if matches!(
            spec.protocol,
            Protocol::Codex | Protocol::Claude | Protocol::Antigravity | Protocol::Trae
        ) {
            if let Some(model) = &requested_model {
                parameters["model"] = json!(model);
            }
        }
        let mut native = harness
            .call(
                if spec.protocol == Protocol::Acp {
                    "session/new"
                } else {
                    "thread/start"
                },
                parameters,
                RPC_TIMEOUT,
            )
            .await?;
        let thread = if spec.protocol == Protocol::Acp {
            native["sessionId"].as_str()
        } else {
            native["thread"]["id"].as_str()
        }
        .filter(|s| valid_id(s))
        .ok_or("CLI did not return a valid native session ID")?
        .to_string();
        if spec.protocol == Protocol::Acp {
            if let Some(model) = &requested_model {
                self.set_acp_model(&harness, &mut native, model).await?;
            }
        }
        if contextual && self.context.marker(owner, conversation).ok() != context_marker {
            return Err("AIChat page changed while creating the native tool bridge; reconnect before sending".into());
        }
        let session_id = id();
        let mut data = json!({"id":session_id,"owner":owner,"backend":backend,"conversationId":conversation,"threadId":thread,"title":spec.name,"roots":roots,"worktrees":roots,"rootNames":root_names,"model":input["model"],"archived":false,"removed":false,"status":"idle","mode":selected_mode,"cursor":0,"items":[],"pending":[],"submissions":{},"updatedAt":now(),"aichatContext":contextual,"nativeMetadata":native});
        if let Some(approval) = selected_approval {
            data["approvalMode"] = json!(approval);
        }
        let (events, _) = watch::channel(json!({"cursor":0,"session":snapshot(&data)}));
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                session_id.clone(),
                Session {
                    data,
                    harness: Some(harness),
                    native,
                    pending: HashMap::new(),
                    events,
                    viewers: Arc::new(AtomicUsize::new(0)),
                    configuration: Arc::new(AsyncMutex::new(())),
                    context_marker,
                    restoring: false,
                    needs_native_history: false,
                },
            );
            if let Err(error) = self.persist_changed(&mut sessions, &session_id) {
                sessions.remove(&session_id);
                return Err(error);
            }
        }
        self.view(&session_id, owner)
    }

    /// Imported Codex threads refresh with read-only thread/read. Legacy Node
    /// records hydrate once; ordinary Rust-managed history remains local.
    pub(super) async fn read_owned(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
    ) -> Result<Value, String> {
        let data = self.view(session_id, owner)?;
        if data["native"] == true
            && data["backend"] == "codex"
            && !self.sessions.lock().unwrap()[session_id].needs_native_history
        {
            return self.refresh_native(session_id, owner).await;
        }
        let gate = {
            let sessions = self.sessions.lock().unwrap();
            let session = &sessions[session_id];
            if !session.needs_native_history {
                return Ok(self.render(&session.data));
            }
            session.configuration.clone()
        };
        let _guard = gate.lock().await;
        let data = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(session_id)
                .filter(|s| s.data["owner"] == owner && s.data["removed"] != true)
                .ok_or("Agent session not found")?;
            if !session.needs_native_history {
                return Ok(self.render(&session.data));
            }
            session.data.clone()
        };
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let cwd = self
            .file
            .parent()
            .ok_or("Invalid agent registry")?
            .join("agent-workspaces/model-discovery");
        std::fs::create_dir_all(&cwd)
            .map_err(|_| "Legacy Codex history query workspace unavailable")?;
        let harness = self
            .harness("codex", &canonical_root(&cwd.to_string_lossy())?)
            .await
            .map_err(|error| {
                format!(
                    "Legacy Codex history is unavailable; original registry was preserved: {error}"
                )
            })?;
        let response=harness.call("thread/read",json!({"threadId":data["threadId"],"includeTurns":true}),RPC_TIMEOUT).await.map_err(|error|format!("Legacy Codex history could not be read; original registry was preserved: {error}"))?;
        let mut items =
            native::thread_items(&response["thread"], data["threadId"].as_str().unwrap())
                .map_err(|error| format!("{error}; original registry was preserved"))?;
        let restored = self.edit(session_id, |session| {
            // A native turn may emit while this read is in flight. Keep its
            // newer normalized items when merging the recovered transcript.
            for present in session.data["items"].as_array().into_iter().flatten() {
                let existing = present["id"]
                    .as_str()
                    .and_then(|id| items.iter_mut().find(|item| item["id"] == id));
                if let Some(existing) = existing {
                    if let (Some(before), Some(after)) =
                        (existing.as_object_mut(), present.as_object())
                    {
                        for (key, value) in after {
                            before.insert(key.clone(), value.clone());
                        }
                    }
                } else {
                    items.push(present.clone());
                }
            }
            session.data["items"] = json!(items);
            if session.data["native"] == true {
                session.data["externalBusy"] =
                    json!(response["thread"]["status"]["type"] == "active");
            }
            session.needs_native_history = false;
            Ok(())
        });
        if restored.is_err() {
            if let Some(session) = self.sessions.lock().unwrap().get_mut(session_id) {
                session.needs_native_history = true;
            }
        }
        restored
    }

    pub(super) fn update(
        &self,
        session_id: &str,
        owner: &str,
        input: &Value,
    ) -> Result<Value, String> {
        self.view(session_id, owner)?;
        self.edit(session_id, |s| {
            if ACTIVE.contains(&s.data["status"].as_str().unwrap_or(""))
                && (input.get("archived").is_some() || input["remove"] == true)
            {
                return Err("Cannot archive an active session".into());
            }
            if let Some(title) = input.get("title") {
                s.data["title"] = json!(title
                    .as_str()
                    .ok_or("Invalid title")?
                    .chars()
                    .take(160)
                    .collect::<String>());
            }
            if let Some(archived) = input.get("archived") {
                s.data["archived"] = json!(archived.as_bool().ok_or("Invalid archived flag")?);
            }
            if input["remove"] == true {
                s.data["removed"] = json!(true);
                s.data["archived"] = json!(true);
            }
            Ok(())
        })
    }

    async fn load(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
        request_id: &str,
    ) -> Result<Arc<Harness>, String> {
        let data = self.view(session_id, owner)?;
        for value in data["roots"].as_array().ok_or("Workspace unavailable")? {
            let root = value.as_str().ok_or("Workspace unavailable")?;
            if canonical_root(root)?.to_string_lossy() != root {
                return Err("Workspace root changed; reconnect the original local folder".into());
            }
        }
        let harness = self
            .harness(
                data["backend"].as_str().unwrap(),
                Path::new(data["roots"][0].as_str().unwrap()),
            )
            .await?;
        let contextual = data["aichatContext"] == true;
        let conversation = data["conversationId"].as_str().unwrap();
        let current_marker = if contextual {
            Some(self.context.marker(owner, conversation)?)
        } else {
            None
        };
        let loaded = {
            let sessions = self.sessions.lock().unwrap();
            sessions[session_id]
                .harness
                .as_ref()
                .is_some_and(|old| Arc::ptr_eq(old, &harness))
                && sessions[session_id].context_marker == current_marker
                && !sessions[session_id].restoring
        };
        if !loaded {
            let (server, context_marker) = if contextual {
                let (descriptor, marker) =
                    self.context
                        .descriptor_with_marker(owner, conversation, self.port)?;
                (Some(descriptor), Some(marker))
            } else {
                (None, None)
            };
            let parameters = if harness.protocol() == Protocol::Acp {
                if harness.capabilities()["agentCapabilities"]["loadSession"] != true
                    && harness.capabilities()["loadSession"] != true
                {
                    return Err("UNSUPPORTED_FEATURE: This CLI cannot resume its previous native session; start a new conversation".into());
                }
                json!({"sessionId":data["threadId"],"cwd":data["roots"][0],"mcpServers":server.into_iter().collect::<Vec<_>>()})
            } else if matches!(
                harness.protocol(),
                Protocol::Claude | Protocol::Antigravity | Protocol::Trae
            ) {
                // Public snapshots omit receipts. Read the owned raw record so
                // a restored conversation retains its existing native identity.
                let resume = self.sessions.lock().unwrap()[session_id].data["submissions"]
                    .as_object()
                    .is_some_and(|receipts| {
                        receipts.values().any(|receipt| {
                            receipt["state"] != "rejected" && receipt["state"] != "starting"
                        })
                    });
                let mut params = json!({"threadId":data["threadId"],"cwd":data["roots"][0],"roots":data["roots"],"model":data["model"],"mode":data["mode"],"resume":resume,"mcpServers":server.into_iter().collect::<Vec<_>>()});
                if harness.protocol() == Protocol::Trae {
                    params["driver"] =
                        self.sessions.lock().unwrap()[session_id].native["driver"].clone();
                }
                if harness.protocol() == Protocol::Antigravity {
                    let sessions = self.sessions.lock().unwrap();
                    let session = &sessions[session_id];
                    let native = &session.native;
                    params["driver"] = native["driver"].clone();
                    params["nativeId"] = native["nativeId"].clone();
                    params["effort"] = data["effort"].clone();
                    // Node creates its wrapper before starting agy. Only a
                    // positively empty native history with no uncertain prior
                    // submission may initialize its first conversation here.
                    params["allowEmpty"] = json!(
                        native["driver"] == "antigravity-v1"
                            && (native["nativeId"].is_null() || native["nativeId"] == "")
                            && native["turns"].as_array().is_some_and(|t| t.is_empty())
                            && session.data["submissions"].as_object().is_some_and(|r| r
                                .iter()
                                .all(|(id, receipt)| receipt["state"] == "rejected"
                                    || (id == request_id && receipt["state"] == "starting")))
                    );
                }
                if contextual {
                    params["aichatInstructions"] = json!("Use keepwork_aichat tools and the versioned aichat_context supplied each turn. Preserve native instructions.");
                }
                params
            } else {
                let access = approval::access(
                    data["mode"].as_str().unwrap_or("craft"),
                    data["approvalMode"].as_str(),
                    &data["roots"],
                );
                let mut params = json!({"threadId":data["threadId"],"cwd":data["roots"][0],"sandbox":access.sandbox,"approvalPolicy":access.policy});
                if access.sandbox == "workspace-write" {
                    params["config"] = json!({"sandbox_workspace_write":{"writable_roots":data["roots"],"network_access":false}});
                }
                if let Some(server) = server {
                    params["config"]["mcp_servers"] = codex_server(&server)["mcp_servers"].clone();
                }
                params
            };
            let acp = harness.protocol() == Protocol::Acp;
            if acp {
                let mut sessions = self.sessions.lock().unwrap();
                let session = sessions
                    .get_mut(session_id)
                    .ok_or("Agent session not found")?;
                session.restoring = true;
                session.harness = Some(harness.clone());
                session.context_marker = None;
            }
            let result = harness
                .call(
                    if harness.protocol() == Protocol::Acp {
                        "session/load"
                    } else {
                        "thread/resume"
                    },
                    parameters,
                    RPC_TIMEOUT,
                )
                .await;
            // RPC replies and notifications have separate consumers. Keep the
            // replay guard until every queued update/request has been handled,
            // including on failure, before a new prompt can begin.
            let drained = if acp {
                harness.flush_events().await
            } else {
                Ok(())
            };
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get_mut(session_id)
                .ok_or("Agent session not found")?;
            session.restoring = false;
            let mut native = match result.and_then(|native| drained.map(|_| native)) {
                Ok(native) => native,
                Err(error) => {
                    if acp {
                        session.harness = None;
                    }
                    return Err(error);
                }
            };
            if acp {
                native["sessionId"] = data["threadId"].clone();
                for key in ["configOptions", "models", "modes"] {
                    if native.get(key).is_none() && session.native.get(key).is_some() {
                        native[key] = session.native[key].clone();
                    }
                }
            }
            if contextual && self.context.marker(owner, conversation).ok() != context_marker {
                if acp {
                    session.harness = None;
                }
                return Err("AIChat page changed while restoring the native tool bridge; reconnect before resubmitting".into());
            }
            session.native = native;
            session.harness = Some(harness.clone());
            session.context_marker = context_marker;
        }
        Ok(harness)
    }

    pub(super) async fn turn(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let data = self.view(session_id, owner)?;
        let request_id = input["requestId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("requestId required")?
            .to_string();
        // Receipts are inspected before text/config changes, including after restart.
        {
            let sessions = self.sessions.lock().unwrap();
            if let Some(receipt) = sessions[session_id].data["submissions"].get(&request_id) {
                return Ok(
                    json!({"submission":receipt,"session":snapshot(&sessions[session_id].data)}),
                );
            }
        }
        match input.get("contextVersion") {
            Some(value) if *value != 1 => {
                return Err("UNSUPPORTED_FEATURE: Unsupported AIChat context version".into())
            }
            Some(_) if data["aichatContext"] != true => return Err(
                "UNSUPPORTED_FEATURE: This session has no AIChat context; start a new conversation"
                    .into(),
            ),
            _ => {}
        }
        let images = images::parse(input.get("images"))?;
        let text = input["text"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 200_000)
            .ok_or("Text required (maximum 200000 characters)")?;
        let requested_model = optional_text(input, "model", 1024)?;
        let requested_effort = optional_text(input, "effort", 256)?;
        let selected_mode = mode(input.get("mode"), data["mode"].as_str().unwrap_or("craft"))?;
        let selected_approval = approval::selected(
            input.get("approvalMode"),
            data["backend"].as_str().unwrap_or("codex"),
            data.get("approvalMode"),
        )?;
        let mut native_text = if data["aichatContext"] == true {
            let (instructions, revision) = self
                .context
                .context(owner, data["conversationId"].as_str().unwrap())?;
            format!("<aichat_context revision=\"{revision}\">\n{instructions}\n</aichat_context>\n<aichat_user_message>\n{text}")
        } else {
            workspace_prompt(text, &data)?
        };
        if selected_mode == "plan" {
            let instructions="AIChat Plan mode: research and propose a detailed implementation plan with validation steps. Do not implement the task, modify files, or perform side effects. Ask questions when needed and wait for the user to select Craft before executing.";
            native_text = if data["aichatContext"] == true {
                native_text.replacen(
                    "\n</aichat_context>",
                    &format!("\n{instructions}\n</aichat_context>"),
                    1,
                )
            } else {
                format!("{instructions}\n{native_text}")
            };
        }
        let mut claimed = false;
        self.edit(session_id, |s| {
            if s.data["submissions"].get(&request_id).is_some() {
                return Ok(());
            }
            if s.data["archived"] == true
                || s.data["externalBusy"] == true
                || ACTIVE.contains(&s.data["status"].as_str().unwrap_or(""))
            {
                return Err("Session is archived or already running".into());
            }
            s.data["status"] = json!("starting");
            s.data["mode"] = json!(selected_mode);
            if let Some(approval) = &selected_approval {
                s.data["approvalMode"] = json!(approval);
            } else {
                s.data.as_object_mut().unwrap().remove("approvalMode");
            }
            s.data["error"] = json!("");
            s.data["turnId"] = Value::Null;
            s.data["submissions"][&request_id] = json!({"state":"starting"});
            s.data["lastRequestId"] = json!(request_id);
            claimed = true;
            Ok(())
        })?;
        if !claimed {
            let sessions = self.sessions.lock().unwrap();
            let s = &sessions[session_id];
            return Ok(
                json!({"submission":s.data["submissions"][&request_id],"session":self.render(&s.data)}),
            );
        }
        self.context.set_mode(
            owner,
            data["conversationId"].as_str().unwrap(),
            &selected_mode,
        );
        self.context.set_approval_mode(
            owner,
            data["conversationId"].as_str().unwrap(),
            selected_approval.as_deref(),
        );
        // Concurrent requests can only observe this persisted claim, never dispatch it again.
        let configured: Result<Arc<Harness>, String> = async {
            let gate = self.sessions.lock().unwrap()[session_id]
                .configuration
                .clone();
            let _guard = gate.lock().await;
            let harness = self.load(session_id, owner, &request_id).await?;
            if harness.protocol() == Protocol::Trae {
                if !images.is_empty() || selected_mode != "craft" || requested_effort.is_some() { return Err("UNSUPPORTED_FEATURE: Trae Agent supports text-only Craft tasks with no reasoning effort selection.".into()); }
            }
            if harness.protocol() == Protocol::Antigravity && !images.is_empty() {
                return Err("UNSUPPORTED_FEATURE: Antigravity supports text input only. Remove the images or switch agents.".into());
            }
            if harness.protocol() == Protocol::Acp {
                if !images.is_empty()
                    && harness.capabilities()["promptCapabilities"]["image"] != true
                {
                    return Err("UNSUPPORTED_FEATURE: This ACP agent does not advertise image input. Remove the images or switch agents.".into());
                }
                let mut native = { self.sessions.lock().unwrap()[session_id].native.clone() };
                if let Some(model) = requested_model
                    .as_deref()
                    .or(data["model"].as_str().filter(|s| !s.is_empty()))
                {
                    self.set_acp_model(&harness, &mut native, model).await?;
                }
                if let Some(effort) = requested_effort.as_deref() {
                    self.set_acp_effort(&harness, &mut native, effort).await?;
                }
                set_acp_mode(&harness, &mut native, &data["threadId"], &selected_mode).await?;
                let mut sessions = self.sessions.lock().unwrap();
                sessions.get_mut(session_id).unwrap().native = native;
            }
            self.context.set_mode(
                owner,
                data["conversationId"].as_str().unwrap(),
                &selected_mode,
            );
            self.context.set_approval_mode(owner, data["conversationId"].as_str().unwrap(), selected_approval.as_deref());
            Ok(harness)
        }
        .await;
        let harness = match configured {
            Ok(harness) => harness,
            Err(error) => {
                self.reject_submission(session_id, &request_id, &error, false);
                return Err(error);
            }
        };
        let native_content = images::content(&native_text, &images, harness.protocol());
        let mut visible_content = vec![json!({"type":"text", "text":text})];
        visible_content.extend(images.iter().map(|_| json!({"type":"image"})));
        let turn_id = id();
        self.edit(session_id,|s|{
            s.data["turnId"]=json!(turn_id);
            s.data["items"].as_array_mut().unwrap().push(json!({"id":format!("local-user-{}",id()),"type":"userMessage","content":visible_content}));
            if let Some(model)=&requested_model{
                if harness.protocol()==Protocol::Claude && s.data["model"]!=*model && requested_effort.is_none(){s.data["effort"]=Value::Null;}
                s.data["model"]=json!(model);
            }
            if let Some(effort)=&requested_effort{s.data["effort"]=json!(effort);}
            if harness.protocol() == Protocol::Antigravity {
                for key in ["model", "effort", "roots"] { s.native[key] = s.data[key].clone(); }
                s.native["mode"] = json!(selected_mode);
            }
            Ok(())
        })?;
        if harness.protocol() == Protocol::Acp {
            let dispatched = match harness
                .submit(
                    "session/prompt",
                    json!({"sessionId":data["threadId"],"prompt":native_content}),
                    Duration::from_secs(30 * 60),
                )
                .await
            {
                Ok(reply) => reply,
                Err(error) => {
                    self.reject_submission(session_id, &request_id, &error, true);
                    return Err(format!("SUBMISSION_UNKNOWN:{error}"));
                }
            };
            self.edit(session_id, |s| {
                if s.data["status"] == "starting" {
                    s.data["status"] = json!("running");
                }
                s.data["submissions"][&request_id] = json!({"state":"accepted","turnId":turn_id});
                Ok(())
            })?;
            let manager = Arc::clone(self);
            let session_id = session_id.to_string();
            let request_id = request_id.clone();
            let turn_id = turn_id.clone();
            tokio::spawn(async move {
                let result = dispatched.result().await;
                let _ = harness.flush_events().await;
                match result {
                    Ok(result) => {
                        let status = match result["stopReason"].as_str() {
                            Some("end_turn") => "completed",
                            Some("cancelled") => "interrupted",
                            _ => "failed",
                        };
                        manager.finish(
                            &session_id,
                            &turn_id,
                            status,
                            if status == "failed" {
                                Some(
                                    result["stopReason"]
                                        .as_str()
                                        .unwrap_or("CLI stopped without completing")
                                        .to_string(),
                                )
                            } else {
                                None
                            },
                        );
                    }
                    Err(error) => {
                        let unknown = !error.starts_with("Native RPC rejected:");
                        manager.reject_submission(&session_id, &request_id, &error, unknown);
                    }
                }
            });
        } else {
            let access =
                approval::access(&selected_mode, selected_approval.as_deref(), &data["roots"]);
            let mut params = json!({"threadId":data["threadId"],"cwd":data["roots"][0],"input":native_content,"sandboxPolicy":access.sandbox_policy,"approvalPolicy":access.policy});
            if matches!(
                harness.protocol(),
                Protocol::Claude | Protocol::Antigravity | Protocol::Trae
            ) {
                params.as_object_mut().unwrap().remove("sandboxPolicy");
                params.as_object_mut().unwrap().remove("approvalPolicy");
                params["mode"] = json!(selected_mode);
                // An omitted setting preserves this conversation's selection,
                // including after the daemon has restored its native process.
                if let Some(model) = data["model"].as_str().filter(|m| !m.is_empty()) {
                    params["model"] = json!(model);
                }
                if requested_model.is_none() || requested_model.as_deref() == data["model"].as_str()
                {
                    if let Some(effort) = data["effort"].as_str().filter(|e| !e.is_empty()) {
                        params["effort"] = json!(effort);
                    }
                }
            }
            if let Some(model) = requested_model {
                params["model"] = json!(model);
            }
            if let Some(effort) = requested_effort {
                params["effort"] = json!(effort);
            }
            let result = harness.call("turn/start", params, RPC_TIMEOUT).await;
            let _ = harness.flush_events().await;
            match result {
                Ok(result) => {
                    let native_id = result["turn"]["id"].clone();
                    self.edit(session_id, |s| {
                        if !native_id.is_null() {
                            s.data["turnId"] = native_id.clone();
                        }
                        s.data["submissions"][&request_id] =
                            json!({"state":"accepted","turnId":s.data["turnId"]});
                        if s.data["status"] == "starting" {
                            s.data["status"] = json!("running");
                        }
                        Ok(())
                    })?;
                }
                Err(error) => {
                    let unknown = !error.starts_with("Native RPC rejected:");
                    self.reject_submission(session_id, &request_id, &error, unknown);
                    return Err(if unknown {
                        format!("SUBMISSION_UNKNOWN:{error}")
                    } else {
                        error
                    });
                }
            }
        }
        let sessions = self.sessions.lock().unwrap();
        let s = &sessions[session_id];
        Ok(
            json!({"submission":s.data["submissions"][&request_id],"session":snapshot(&s.data),"warnings":[]}),
        )
    }

    fn reject_submission(&self, session_id: &str, request_id: &str, error: &str, unknown: bool) {
        let _ = self.edit_native(session_id, None, |s| {
            s.data["submissions"][request_id]["state"] =
                json!(if unknown { "unknown" } else { "rejected" });
            s.data["status"] = json!(if unknown { "uncertain" } else { "error" });
            s.data["error"] = json!(error);
            s.data["pending"] = json!([]);
            s.pending.clear();
            Ok(())
        });
    }
    pub(super) fn finish(
        &self,
        session_id: &str,
        turn_id: &str,
        status: &str,
        error: Option<String>,
    ) {
        let _ = self.edit_native(session_id, Some(turn_id), |s| {
            s.data["status"] = json!(status);
            s.data["pending"] = json!([]);
            s.pending.clear();
            if let Some(error) = error {
                s.data["error"] = json!(error);
            }
            Ok(())
        });
    }

    pub(super) async fn interrupt(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
    ) -> Result<Value, String> {
        let data = self.view(session_id, owner)?;
        if data["status"] == "starting" {
            return Err("Turn is starting; retry Stop shortly".into());
        }
        self.context
            .cancel(owner, data["conversationId"].as_str().unwrap_or(""));
        if !ACTIVE.contains(&data["status"].as_str().unwrap_or("")) {
            return Ok(data);
        }
        let harness = { self.sessions.lock().unwrap()[session_id].harness.clone() }
            .ok_or("Native CLI is disconnected")?;
        if harness.protocol() == Protocol::Acp {
            harness
                .notify("session/cancel", json!({"sessionId":data["threadId"]}))
                .await?;
        } else {
            harness
                .call(
                    "turn/interrupt",
                    json!({"threadId":data["threadId"],"turnId":data["turnId"]}),
                    RPC_TIMEOUT,
                )
                .await?;
        }
        self.view(session_id, owner)
    }

    async fn set_acp_model(
        &self,
        harness: &Harness,
        native: &mut Value,
        model: &str,
    ) -> Result<(), String> {
        let session_id = native["sessionId"].clone();
        if let Some(option) = select_option(native, "model") {
            set_option(harness, native, &session_id, &option, model).await
        } else {
            if native["models"]["currentModelId"] == model {
                return Ok(());
            }
            if let Some(options) = native["models"]["availableModels"].as_array() {
                if !options.iter().any(|m| m["modelId"] == model) {
                    return Err("Unsupported native model".into());
                }
            }
            harness
                .call(
                    "session/set_model",
                    json!({"sessionId":session_id,"modelId":model}),
                    RPC_TIMEOUT,
                )
                .await?;
            native["models"]["currentModelId"] = json!(model);
            Ok(())
        }
    }
    async fn set_acp_effort(
        &self,
        harness: &Harness,
        native: &mut Value,
        effort: &str,
    ) -> Result<(), String> {
        let option = select_option(native, "effort")
            .ok_or("UNSUPPORTED_FEATURE: This native model does not expose reasoning effort")?;
        let session_id = native["sessionId"].clone();
        set_option(harness, native, &session_id, &option, effort).await
    }
}

fn select_option(native: &Value, category: &str) -> Option<Value> {
    native["configOptions"]
        .as_array()?
        .iter()
        .find(|o| {
            let id = o["id"].as_str().unwrap_or("");
            if category == "effort" {
                o["category"] == "thought_level"
                    || [
                        "effort",
                        "reasoning_effort",
                        "reasoning-effort",
                        "thinking_level",
                    ]
                    .contains(&id)
            } else {
                o["category"] == category || id == category
            }
        })
        .cloned()
}
fn option_values(option: &Value) -> Vec<Value> {
    option["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .flat_map(|o| {
                    o["options"]
                        .as_array()
                        .cloned()
                        .unwrap_or_else(|| vec![o.clone()])
                })
                .collect()
        })
        .unwrap_or_default()
}
async fn set_option(
    harness: &Harness,
    native: &mut Value,
    session_id: &Value,
    option: &Value,
    value: &str,
) -> Result<(), String> {
    if !option_values(option).iter().any(|o| o["value"] == value) {
        return Err("Unsupported native configuration value".into());
    }
    if option["currentValue"] == value {
        return Ok(());
    }
    let result = harness
        .call(
            "session/set_config_option",
            json!({"sessionId":session_id,"configId":option["id"],"value":value}),
            RPC_TIMEOUT,
        )
        .await?;
    if result["configOptions"].is_array() {
        native["configOptions"] = result["configOptions"].clone();
    } else if let Some(options) = native["configOptions"].as_array_mut() {
        if let Some(stored) = options.iter_mut().find(|o| o["id"] == option["id"]) {
            stored["currentValue"] = json!(value);
        }
    }
    Ok(())
}
async fn set_acp_mode(
    harness: &Harness,
    native: &mut Value,
    thread: &Value,
    mode: &str,
) -> Result<(), String> {
    let option = select_option(native, "mode");
    let modes = if let Some(option) = &option {
        option_values(option)
            .into_iter()
            .map(|v| json!({"id":v["value"],"name":v["name"]}))
            .collect::<Vec<_>>()
    } else {
        native["modes"]["availableModes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let current = option
        .as_ref()
        .map(|o| o["currentValue"].clone())
        .unwrap_or_else(|| native["modes"]["currentModeId"].clone());
    let unsafe_mode = |v: &Value| {
        [
            "bypass",
            "yolo",
            "full-access",
            "auto-approve",
            "acceptEdits",
        ]
        .iter()
        .any(|p| v.as_str().unwrap_or("").contains(p))
    };
    let selected = if mode == "plan" {
        modes.iter().find(|m| {
            ["plan", "plan-mode", "plan_mode", "architect"]
                .contains(&m["id"].as_str().unwrap_or(""))
        })
    } else {
        let preferred = if mode == "craft" {
            vec![
                "bypassPermissions",
                "yolo",
                "full-access",
                "code",
                "build",
                "agent",
                "default",
                "ask",
            ]
        } else {
            vec!["ask", "default", "code", "build", "agent"]
        };
        preferred
            .iter()
            .find_map(|id| modes.iter().find(|m| m["id"] == *id))
    };
    if mode == "plan" && selected.is_none() {
        return Err(
            "UNSUPPORTED_FEATURE: This CLI does not advertise a native read-only planning mode"
                .into(),
        );
    }
    if mode != "plan"
        && selected.is_none()
        && ["plan", "plan-mode", "plan_mode", "architect"].contains(&current.as_str().unwrap_or(""))
    {
        return Err("UNSUPPORTED_FEATURE: This CLI does not advertise a mode to leave Plan".into());
    }
    if mode == "ask" && selected.is_none() && (unsafe_mode(&current) || !modes.is_empty()) {
        return Err(
            "UNSUPPORTED_FEATURE: This CLI does not advertise an interactive approval mode".into(),
        );
    }
    if let Some(selected) = selected.filter(|s| s["id"] != current) {
        let value = selected["id"].as_str().ok_or("Invalid native mode")?;
        if let Some(option) = option {
            set_option(harness, native, thread, &option, value).await?;
        } else {
            harness
                .call(
                    "session/set_mode",
                    json!({"sessionId":thread,"modeId":value}),
                    RPC_TIMEOUT,
                )
                .await?;
            native["modes"]["currentModeId"] = json!(value);
        }
    }
    Ok(())
}
fn codex_server(server: &Value) -> Value {
    let mut env = serde_json::Map::new();
    if let Some(values) = server["env"].as_array() {
        for value in values {
            if let Some(name) = value["name"].as_str() {
                env.insert(name.into(), value["value"].clone());
            }
        }
    }
    json!({"mcp_servers":{"keepwork_aichat":{"command":server["command"],"args":server["args"],"env":env}}})
}
fn workspace_prompt(text: &str, data: &Value) -> Result<String, String> {
    // Resolve references once and require their real path under a granted root.
    let roots = data["roots"].as_array().ok_or("Workspace unavailable")?;
    let pattern = regex::Regex::new(r"\[#ref\s+([^\]]+?)\]").unwrap();
    let mut output = String::new();
    let mut offset = 0;
    for capture in pattern.captures_iter(text) {
        let matched = capture.get(0).unwrap();
        output.push_str(&text[offset..matched.start()]);
        let raw = capture[1].trim().replace('\\', "/");
        if [".brain", ".calendar", ".paraworld"]
            .iter()
            .any(|a| raw.trim_start_matches('/').starts_with(a))
        {
            return Err("Global workspace aliases are not available in legacy CLI sessions".into());
        }
        let candidate = if Path::new(&raw).is_absolute() && !raw.starts_with("//") {
            PathBuf::from(&raw)
        } else {
            let relative = raw.trim_start_matches("//");
            let (name, tail) = relative.split_once('/').unwrap_or(("", relative));
            let matches = data["rootNames"]
                .as_array()
                .map(|names| {
                    names
                        .iter()
                        .enumerate()
                        .filter(|(_, v)| v.as_str() == Some(name))
                        .map(|(i, _)| i)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if matches.len() > 1 {
                return Err("Ambiguous workspace file reference".into());
            }
            let root = matches.first().copied().unwrap_or(0);
            Path::new(roots[root].as_str().unwrap()).join(if matches.is_empty() {
                relative
            } else {
                tail
            })
        };
        let real =
            std::fs::canonicalize(candidate).map_err(|_| "Referenced local file is unavailable")?;
        let identity = path_identity::normalize(real.clone());
        if !roots
            .iter()
            .any(|root| identity.starts_with(root.as_str().unwrap_or("")))
        {
            return Err("File reference is outside the session workspace roots".into());
        }
        output.push_str(&format!("[#ref {}]", real.display()));
        offset = matched.end();
    }
    output.push_str(&text[offset..]);
    Ok(format!(
        "Workspace folders (primary first):\n{}\n\n{output}",
        roots
            .iter()
            .enumerate()
            .map(|(i, r)| format!("{}. {}", i + 1, r.as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn workspace_file_references_accept_real_files_and_reject_sibling_and_link_escapes() {
        let directory = std::env::temp_dir().join(format!("kp-reference-paths-{}", id()));
        let folder = directory.join("MixedCaseWorkspace");
        let outside = directory.join("MixedCaseWorkspace-sibling");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(folder.join("Notes.txt"), b"inside").unwrap();
        std::fs::write(outside.join("Notes.txt"), b"outside").unwrap();
        let root = canonical_root(folder.to_str().unwrap()).unwrap();
        let data = json!({"roots":[root],"rootNames":["work"]});
        let prompt = workspace_prompt("read [#ref //work/Notes.txt]", &data).unwrap();
        assert!(prompt.contains("Notes.txt"));
        let escaped = format!("read [#ref {}]", outside.join("Notes.txt").display());
        assert!(workspace_prompt(&escaped, &data)
            .unwrap_err()
            .contains("outside"));

        let link = folder.join("outside-link");
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            workspace_prompt("read [#ref //work/outside-link/Notes.txt]", &data)
                .unwrap_err()
                .contains("outside")
        );
        // Replacing the previously canonical root with a link must still fail
        // the live identity check used by load(), even for old Rust records.
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&folder)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &folder).unwrap();
        assert_ne!(canonical_root(root.to_str().unwrap()).unwrap(), root);
        #[cfg(windows)]
        std::fs::remove_dir(&folder).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&folder).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
