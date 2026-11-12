//! Read-only native Codex discovery and owner-scoped history attachment.
//! A wrapper is deliberately left unloaded until an explicit user turn resumes it.
use super::*;

fn codex_only(backend: &str) -> Result<(), String> {
    if backend != "codex" {
        return Err(
            "UNSUPPORTED_FEATURE: Native history import is only available for Codex in Rust MCP"
                .into(),
        );
    }
    Ok(())
}

fn title(thread: &Value) -> String {
    thread["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| thread["preview"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("Codex")
        .chars()
        .take(160)
        .collect()
}

fn timestamp(thread: &Value) -> i64 {
    thread["updatedAt"]
        .as_i64()
        .and_then(|t| t.checked_mul(1000))
        .unwrap_or(0)
}

/// Reuse the legacy migration's visible-item normalization, including removal
/// of private AIChat instructions. Invalid history must not become an empty log.
pub(super) fn thread_items(thread: &Value, thread_id: &str) -> Result<Vec<Value>, String> {
    if thread["id"].as_str() != Some(thread_id) || !thread["turns"].is_array() {
        return Err("Native Codex history response is incompatible".into());
    }
    let mut items = std::collections::VecDeque::new();
    for turn in thread["turns"].as_array().unwrap() {
        if !turn.is_object() || turn.get("items").is_some_and(|v| !v.is_array()) {
            return Err("Native Codex history items are invalid".into());
        }
        for item in turn["items"].as_array().into_iter().flatten() {
            if !item.is_object() {
                return Err("Native Codex history item is invalid".into());
            }
            items.push_back(item);
            if items.len() > 2000 {
                items.pop_front();
            }
        }
    }
    let mut budget = 2_000_000;
    Ok(items
        .into_iter()
        .map(|item| {
            let mut item = scrub(item, 0, &mut budget);
            super::item_stream::visible_reasoning(&mut item);
            if item["type"] == "userMessage" {
                if let Some(content) = item["content"].as_array_mut() {
                    for part in content {
                        if let Some(text) = part["text"]
                            .as_str()
                            .filter(|t| t.starts_with("<aichat_context "))
                        {
                            if let Some((_, visible)) =
                                text.split_once("\n</aichat_context>\n<aichat_user_message>\n")
                            {
                                part["text"] = json!(visible);
                            }
                        }
                    }
                }
            }
            item
        })
        .filter(|item| !item.is_null())
        .collect())
}

impl AgentManager {
    async fn native_harness(self: &Arc<Self>) -> Result<Arc<Harness>, String> {
        let cwd = self
            .file
            .parent()
            .ok_or("Invalid agent registry")?
            .join("agent-workspaces/model-discovery");
        std::fs::create_dir_all(&cwd).map_err(|_| "Native Codex history workspace unavailable")?;
        self.harness("codex", &canonical_root(&cwd.to_string_lossy())?)
            .await
    }

    async fn native_thread(self: &Arc<Self>, thread_id: &str) -> Result<Value, String> {
        let result = self
            .native_harness()
            .await?
            .call(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
                RPC_TIMEOUT,
            )
            .await?;
        Ok(result["thread"].clone())
    }

    pub(super) async fn native_catalog(
        self: &Arc<Self>,
        owner: &str,
        backend: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, String> {
        codex_only(backend)?;
        let mut params = json!({"limit":100,"sortKey":"updated_at","archived":false,
            "modelProviders":[],"sourceKinds":["cli","vscode","exec","appServer"]});
        if let Some(cursor) = query.get("cursor").filter(|s| !s.is_empty()) {
            if cursor.len() > 8192 || cursor.contains('\0') {
                return Err("Invalid native history cursor".into());
            }
            params["cursor"] = json!(cursor);
        }
        let result = self
            .native_harness()
            .await?
            .call("thread/list", params, RPC_TIMEOUT)
            .await?;
        let threads = result["data"]
            .as_array()
            .ok_or("Native Codex history list response is incompatible")?;
        let cursor = match result.get("nextCursor") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(s)) => json!(s),
            _ => return Err("Native Codex history cursor response is incompatible".into()),
        };
        let sessions = self.sessions.lock().unwrap();
        let rows = threads
            .iter()
            .filter(|t| t["id"].as_str().is_some_and(valid_id))
            .filter(|t| {
                !sessions.values().any(|s| {
                    s.data["backend"] == "codex"
                        && s.data["threadId"] == t["id"]
                        && s.data["owner"] != owner
                })
            })
            .take(100)
            .map(|t| {
                let workspace = Path::new(t["cwd"].as_str().unwrap_or(""))
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                json!({"backend":"codex","threadId":t["id"],"title":title(t),
                    "workspace":workspace,"updatedAt":timestamp(t),"busy":t["status"]["type"]=="active"})
            })
            .collect::<Vec<_>>();
        Ok(json!({"sessions":rows,"nextCursor":cursor}))
    }

    pub(super) async fn native_session(
        self: &Arc<Self>,
        owner: &str,
        backend: &str,
        thread_id: &str,
    ) -> Result<Value, String> {
        codex_only(backend)?;
        if !valid_id(thread_id) {
            return Err("Invalid native thread ID".into());
        }
        // Share the creation gate with ordinary sessions. Check ownership before
        // provider I/O and serialize concurrent claims, including different owners.
        let creation = self.creation.lock().await;
        let existing = {
            let sessions = self.sessions.lock().unwrap();
            let existing = sessions
                .values()
                .find(|s| s.data["backend"] == backend && s.data["threadId"] == thread_id);
            match existing {
                Some(s)
                    if s.data["owner"] == owner
                        && s.data["removed"] != true
                        && s.data["native"] == true =>
                {
                    Some(s.data["id"].as_str().unwrap().to_string())
                }
                Some(_) => return Err("Native session unavailable".into()),
                None => None,
            }
        };
        if let Some(existing) = existing {
            drop(creation);
            return self.read_owned(&existing, owner).await;
        }
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        if self.sessions.lock().unwrap().len() >= MAX_SESSIONS {
            return Err("Agent session limit reached".into());
        }
        let thread = self.native_thread(thread_id).await?;
        let items = thread_items(&thread, thread_id)?;
        let root = canonical_root(
            thread["cwd"]
                .as_str()
                .ok_or("Native Codex workspace unavailable")?,
        )?;
        let session_id = id();
        // Keep registry identifiers valid even when a provider uses a maximal
        // thread ID. The common native-codex-<uuid> spelling stays unchanged.
        let conversation = if thread_id.len() <= 147 {
            format!("native-codex-{thread_id}")
        } else {
            format!("native-codex-{:x}", Sha256::digest(thread_id.as_bytes()))
        };
        let data = json!({"id":session_id,"owner":owner,"backend":"codex","native":true,
            "conversationId":conversation,"threadId":thread_id,
            "title":title(&thread),"roots":[root],"worktrees":[root],
            "rootNames":[root.file_name().unwrap_or_default().to_string_lossy()],
            "nativeWorkspace":{"version":1,"roots":[root],"complete":false},
            "model":thread["model"],"archived":false,"removed":false,"status":"idle","mode":"ask",
            "externalBusy":thread["status"]["type"]=="active","cursor":0,"items":items,
            "pending":[],"submissions":{},"updatedAt":if timestamp(&thread)==0 {now()}else{timestamp(&thread)},
            "aichatContext":false});
        let (events, _) = watch::channel(json!({"cursor":0,"session":snapshot(&data)}));
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                session_id.clone(),
                Session {
                    data,
                    harness: None,
                    native: json!({}),
                    pending: HashMap::new(),
                    events,
                    viewers: Arc::new(AtomicUsize::new(0)),
                    configuration: Arc::new(AsyncMutex::new(())),
                    context_marker: None,
                    restoring: false,
                    needs_native_history: false,
                },
            );
            if let Err(error) = self.persist(&sessions) {
                sessions.remove(&session_id);
                return Err(error);
            }
        }
        self.view(&session_id, owner)
    }

    pub(super) async fn refresh_native(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
    ) -> Result<Value, String> {
        let gate = self.sessions.lock().unwrap()[session_id]
            .configuration
            .clone();
        let _guard = gate.lock().await;
        let data = self.view(session_id, owner)?;
        if ACTIVE.contains(&data["status"].as_str().unwrap_or("")) {
            return Ok(data);
        }
        let thread = self
            .native_thread(data["threadId"].as_str().unwrap())
            .await?;
        let items = thread_items(&thread, data["threadId"].as_str().unwrap())?;
        self.edit(session_id, |s| {
            // An explicit turn may claim the session while this read is pending.
            if !ACTIVE.contains(&s.data["status"].as_str().unwrap_or("")) {
                s.data["items"] = json!(items);
                s.data["externalBusy"] = json!(thread["status"]["type"] == "active");
            }
            Ok(())
        })
    }
}
