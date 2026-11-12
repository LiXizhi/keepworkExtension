use super::item_stream::{apply_delta, is_item_delta, merge_item, visible_reasoning};
use super::*;

impl AgentManager {
    pub(super) async fn on_event(self: &Arc<Self>, harness: &Arc<Harness>, event: HarnessEvent) {
        match event {
            HarnessEvent::Barrier { processed } => {
                processed.notify_one();
            }
            HarnessEvent::Exit { message } => {
                let ids = self
                    .sessions
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, s)| s.harness.as_ref().is_some_and(|h| Arc::ptr_eq(h, harness)))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in ids {
                    let _ = self.edit(&id, |s| {
                        s.harness = None;
                        s.pending.clear();
                        s.data["pending"] = json!([]);
                        if ACTIVE.contains(&s.data["status"].as_str().unwrap_or("")) {
                            s.data["status"] = json!("interrupted");
                            s.data["error"] = json!(message);
                        }
                        Ok(())
                    });
                }
            }
            HarnessEvent::Notification { method, params } => {
                let Some(session_id) = self.find_native(harness, &params) else {
                    return;
                };
                if harness.protocol() == Protocol::Acp && method == "session/update" {
                    self.acp_update(&session_id, &params["update"]);
                } else if matches!(
                    harness.protocol(),
                    Protocol::Codex | Protocol::Claude | Protocol::Antigravity
                ) {
                    self.codex_update(&session_id, &method, &params);
                }
            }
            HarnessEvent::Request { id, method, params } => {
                self.native_request(harness, id, &method, &params).await
            }
        }
    }
    fn find_native(&self, harness: &Arc<Harness>, params: &Value) -> Option<String> {
        let thread = params
            .get("sessionId")
            .or_else(|| params.get("threadId"))
            .or_else(|| params.get("conversationId"))
            .or_else(|| params.get("thread").and_then(|t| t.get("id")))?;
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| {
                s.data["threadId"] == *thread
                    && s.harness.as_ref().is_some_and(|h| Arc::ptr_eq(h, harness))
            })
            .map(|(id, _)| id.clone())
    }
    fn acp_update(&self, session_id: &str, update: &Value) {
        // session/load replays the native transcript. Only configuration belongs
        // to the restored session; text and tools are already in local history.
        if !matches!(
            update["sessionUpdate"].as_str(),
            Some("config_option_update" | "current_mode_update")
        ) && self.sessions.lock().unwrap()[session_id].restoring
        {
            return;
        }
        let _ = self.edit(session_id, |s| {
            let kind = update["sessionUpdate"].as_str().unwrap_or("");
            let turn = s.data["turnId"].as_str().unwrap_or("unknown").to_string();
            if s.native["_textTurn"] != turn {
                s.native["_textTurn"] = json!(turn);
                s.native["_textSegment"] = json!(0);
            }
            match kind {
                "agent_message_chunk" | "agent_thought_chunk" => {
                    let Some(text) = update["content"]["text"].as_str() else { return Ok(()) };
                    let segment = s.native["_textSegment"].as_u64().unwrap_or(0);
                    let item_type = if kind == "agent_thought_chunk" { "reasoning" } else { "agentMessage" };
                    let item_id = format!("{turn}-{item_type}-{segment}");
                    let items = s.data["items"].as_array_mut().unwrap();
                    if let Some(item) = items.iter_mut().find(|item| item["id"] == item_id) {
                        append(item, "text", text);
                    } else {
                        let mut item = json!({"id":item_id,"type":item_type,"text":""});
                        append(&mut item, "text", text);
                        items.push(item);
                    }
                }
                "tool_call" | "tool_call_update" => {
                    // Text after a tool belongs after that tool in the transcript.
                    s.native["_textSegment"] = json!(s.native["_textSegment"].as_u64().unwrap_or(0).saturating_add(1));
                    let native_id = update["toolCallId"].as_str().unwrap_or("unknown");
                    let item_id = format!("{turn}-tool-{native_id}");
                    let items = s.data["items"].as_array_mut().unwrap();
                    let index = match items.iter().position(|item| item["id"] == item_id) {
                        Some(index) => index,
                        None => {
                            items.push(json!({"id":item_id,"nativeToolCallId":native_id,"type":"mcpToolCall","tool":update["title"],"status":"inProgress","arguments":{},"result":{},"content":[]}));
                            items.len() - 1
                        }
                    };
                    let item = &mut items[index];
                    let tool_kind = update["kind"].as_str().unwrap_or("");
                    if let Some(title) = update.get("title") { item["tool"] = title.clone(); item["command"] = title.clone(); }
                    if tool_kind == "execute" {
                        item["type"] = json!("commandExecution");
                        if let Some(command) = update["rawInput"].get("command") { item["command"] = command.clone(); }
                    } else if ["edit", "delete", "move"].contains(&tool_kind) {
                        item["type"] = json!("fileChange");
                        if let Some(locations) = update.get("locations") { item["changes"] = locations.clone(); }
                    }
                    if let Some(input) = update.get("rawInput") { item["arguments"] = scrub(input, 0, &mut 500_000); }
                    if let Some(status) = update["status"].as_str() {
                        item["status"] = json!(match status { "completed" => "completed", "failed" => "failed", _ => "inProgress" });
                    }
                    if let Some(content) = update.get("content") {
                        let bounded = scrub(content, 0, &mut 500_000);
                        item["content"] = bounded.clone(); item["result"] = bounded;
                        let output = tool_text(content);
                        if !output.is_empty() { item["aggregatedOutput"] = json!(output); }
                    }
                    if let Some(output) = update.get("rawOutput") {
                        let bounded = scrub(output, 0, &mut 500_000);
                        item["result"] = bounded.clone(); item["output"] = bounded;
                        if let Some(text) = output.as_str().or_else(|| output["text"].as_str()).or_else(|| output["stdout"].as_str()) {
                            item["aggregatedOutput"] = json!(text.chars().take(131_072).collect::<String>());
                        }
                        if let Some(code) = output.get("exitCode") { item["exitCode"] = code.clone(); }
                    }
                }
                "config_option_update" => {
                    if let Some(options) = update.get("configOptions") { s.native["configOptions"] = options.clone(); }
                }
                "current_mode_update" => { s.native["modes"]["currentModeId"] = update["currentModeId"].clone(); }
                _ => {}
            }
            Ok(())
        });
    }
    fn codex_update(&self, session_id: &str, method: &str, params: &Value) {
        let _ = self.edit(session_id, |s| {
            match method {
                "turn/started" => {
                    s.data["turnId"] = params["turn"]["id"].clone();
                    s.data["status"] = json!("running");
                }
                "turn/completed" => {
                    s.data["status"] = params["turn"]
                        .get("status")
                        .cloned()
                        .unwrap_or(json!("completed"));
                    s.data["pending"] = json!([]);
                    s.pending.clear();
                    s.data["error"] = params["turn"]["error"]
                        .get("message")
                        .cloned()
                        .unwrap_or(json!(""));
                }
                "error" => {
                    s.data["retrying"] = json!(params["willRetry"] == true);
                    s.data["status"] = json!(if params["willRetry"] == true {
                        "running"
                    } else {
                        "failed"
                    });
                    s.data["error"] = params["error"]["message"].clone();
                }
                "item/started" | "item/completed" => {
                    let mut item = scrub(&params["item"], 0, &mut 1_500_000);
                    if item["type"] == "userMessage" {
                        if let Some(content) = item["content"].as_array_mut() {
                            for part in content {
                                if let Some(text) = part["text"].as_str() {
                                    if let Some((_, visible)) = text
                                        .split_once("\n</aichat_context>\n<aichat_user_message>\n")
                                    {
                                        part["text"] = json!(visible);
                                    }
                                }
                            }
                        }
                    }
                    if let Some(id) = item["id"].as_str() {
                        let item_id = id.to_string();
                        let items = s.data["items"].as_array_mut().unwrap();
                        if item["type"] == "userMessage" {
                            items.retain(|old| {
                                !old["id"].as_str().unwrap_or("").starts_with("local-user-")
                            });
                        }
                        if let Some(old) = items.iter_mut().find(|old| old["id"] == item_id) {
                            merge_item(old, item);
                        } else {
                            visible_reasoning(&mut item);
                            items.push(item);
                        }
                    }
                }
                "serverRequest/resolved" => {
                    let native_id = &params["requestId"];
                    let ids = s
                        .pending
                        .iter()
                        .filter(|(_, (id, _))| id == native_id)
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    for id in ids {
                        s.pending.remove(&id);
                        s.data["pending"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|p| p["id"] != id);
                    }
                }
                _ if is_item_delta(method) || method == "item/reasoning/summaryPartAdded" => {
                    apply_delta(s.data["items"].as_array_mut().unwrap(), method, params);
                }
                _ => {}
            }
            Ok(())
        });
    }

    async fn native_request(
        self: &Arc<Self>,
        harness: &Arc<Harness>,
        native_id: Value,
        method: &str,
        params: &Value,
    ) {
        let Some(session_id) = self.find_native(harness, params) else {
            let _ = harness
                .reject(native_id, -32602, "No owned active native session")
                .await;
            return;
        };
        let (data, pending_count, restoring) = {
            let sessions = self.sessions.lock().unwrap();
            (
                sessions[&session_id].data.clone(),
                sessions[&session_id].pending.len(),
                sessions[&session_id].restoring,
            )
        };
        if restoring {
            let _ = harness
                .reject(
                    native_id,
                    -32602,
                    "Actions are unavailable during history replay",
                )
                .await;
            return;
        }
        if pending_count >= 32 || !ACTIVE.contains(&data["status"].as_str().unwrap_or("")) {
            let _ = harness
                .reject(
                    native_id,
                    -32602,
                    "No active owned turn or too many requests",
                )
                .await;
            return;
        }
        let acp = harness.protocol() == Protocol::Acp;
        let normalized = if method == "session/request_permission" {
            let kind = params["toolCall"]["kind"].as_str().unwrap_or("");
            if ["edit", "delete", "move"].contains(&kind) {
                "item/fileChange/requestApproval"
            } else {
                "item/commandExecution/requestApproval"
            }
        } else {
            match method {
                "cursor/ask_question" => "item/tool/requestUserInput",
                "cursor/create_plan" => "item/commandExecution/requestApproval",
                "execCommandApproval" => "item/commandExecution/requestApproval",
                "applyPatchApproval" => "item/fileChange/requestApproval",
                value => value,
            }
        };
        if ![
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput",
        ]
        .contains(&normalized)
        {
            let _ = harness
                .reject(native_id, -32601, "Interactive method unsupported")
                .await;
            return;
        }
        let requires_decision = normalized == "item/tool/requestUserInput"
            || method == "cursor/create_plan"
            || params["requiresUserDecision"] == true;
        let read_only = params["readOnly"] == true
            || ["read", "search", "fetch"]
                .contains(&params["toolCall"]["kind"].as_str().unwrap_or(""));
        let automatic = if data["mode"] == "plan" && normalized != "item/tool/requestUserInput" {
            Some(if read_only && !requires_decision {
                "accept"
            } else {
                "decline"
            })
        } else if requires_decision {
            None
        } else if data["mode"] == "craft" {
            Some("accept")
        } else {
            None
        };
        let native = json!({"method":method,"params":params,"acp":acp});
        if let Some(decision) = automatic {
            let result = permission_result(&native, &json!({"decision":decision}));
            match result {
                Ok(result) => {
                    let _ = harness.respond(native_id, result).await;
                }
                Err(error) => {
                    // A provider can advertise only a subset of approvals. Do
                    // not widen the grant or leave its request hanging.
                    let _ = harness.reject(native_id, -32602, &error).await;
                }
            }
            return;
        }
        let pending_id = id();
        let mut visible = params.clone();
        visible["threadId"] = data["threadId"].clone();
        visible["turnId"] = data["turnId"].clone();
        if acp {
            visible["command"] = params["toolCall"]["rawInput"]
                .get("command")
                .cloned()
                .unwrap_or_else(|| params["toolCall"]["title"].clone());
            visible["reason"] = params["toolCall"]["title"].clone();
            visible["availableDecisions"] = json!(["accept", "decline", "cancel"]);
        }
        if method == "session/request_permission" {
            let mut choices = vec![json!("decline"), json!("cancel")];
            if let Some(options) = params["options"].as_array() {
                if options.iter().any(|option| option["kind"] == "allow_once") {
                    choices.insert(0, json!("accept"));
                }
                if options
                    .iter()
                    .any(|option| option["kind"] == "allow_always")
                {
                    choices.push(json!("acceptForSession"));
                }
            }
            visible["availableDecisions"] = json!(choices);
        }
        if method == "cursor/ask_question" {
            match cursor_questions(params) {
                Ok(questions) => {
                    visible["questions"] = questions;
                }
                Err(error) => {
                    let _ = harness.reject(native_id, -32602, &error).await;
                    return;
                }
            }
        } else if method == "cursor/create_plan" {
            visible["command"] = params
                .get("plan")
                .or_else(|| params.get("overview"))
                .cloned()
                .unwrap_or(json!("Approve Cursor plan"));
            visible["requiresUserDecision"] = json!(true);
        }
        if method == "item/tool/requestUserInput" {
            let valid = params["questions"].as_array().is_some_and(|questions| {
                !questions.is_empty()
                    && questions.len() <= 32
                    && questions.iter().all(|question| {
                        question["id"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty() && id.len() <= 160)
                            && question["question"]
                                .as_str()
                                .is_some_and(|text| text.len() <= 10_000)
                    })
            });
            if !valid {
                let _ = harness
                    .reject(native_id, -32602, "Native question schema unavailable")
                    .await;
                return;
            }
        }
        let automatic_offered = !requires_decision
            && visible["availableDecisions"]
                .as_array()
                .is_none_or(|options| options.iter().any(|option| option == "accept"));
        let rejected_id = native_id.clone();
        let inserted = self.edit(&session_id,|s|{
            s.pending.insert(pending_id.clone(),(native_id,native));
            s.data["pending"].as_array_mut().unwrap().push(json!({"id":pending_id,"method":normalized,"params":scrub(&visible,0,&mut 500_000),"decisionCapabilities":{"execpolicyAmendment":false,"autoApproval":automatic_offered}}));
            s.data["status"]=json!("waiting");Ok(())
        });
        if let Err(error) = inserted {
            if let Some(session) = self.sessions.lock().unwrap().get_mut(&session_id) {
                session.pending.remove(&pending_id);
            }
            let _ = harness.reject(rejected_id, -32603, &error).await;
        }
    }

    pub(super) async fn respond(
        self: &Arc<Self>,
        session_id: &str,
        owner: &str,
        input: &Value,
    ) -> Result<Value, String> {
        self.view(session_id, owner)?;
        let pending_id = input["id"].as_str().ok_or("Request ID required")?;
        // Remove the capability before I/O so simultaneous clicks cannot answer twice.
        let (native_id, native, harness) = {
            let mut sessions = self.sessions.lock().unwrap();
            let s = sessions.get_mut(session_id).unwrap();
            let pending = s
                .pending
                .get(pending_id)
                .ok_or("Request expired or already answered")?;
            permission_result(&pending.1, input)?;
            let pair = s.pending.remove(pending_id).unwrap();
            (
                pair.0,
                pair.1,
                s.harness.clone().ok_or("Native CLI disconnected")?,
            )
        };
        let result = permission_result(&native, input)?;
        if let Err(error) = harness.respond(native_id, result).await {
            let _ = self.edit(session_id, |s| {
                s.data["pending"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|p| p["id"] != pending_id);
                s.data["status"] = json!("uncertain");
                s.data["error"] =
                    json!("Native approval outcome is unknown; inspect state before continuing");
                Ok(())
            });
            return Err(format!("SUBMISSION_UNKNOWN:{error}"));
        }
        self.edit(session_id, |s| {
            s.data["pending"]
                .as_array_mut()
                .unwrap()
                .retain(|p| p["id"] != pending_id);
            if s.data["status"] == "waiting" {
                s.data["status"] = json!(if s.pending.is_empty() {
                    "running"
                } else {
                    "waiting"
                });
            }
            Ok(())
        })
    }
}

fn append(item: &mut Value, key: &str, delta: &str) {
    let mut text = item[key].as_str().unwrap_or("").to_string();
    text.push_str(delta);
    if text.len() > 131_072 {
        let cut = text.len() - 131_072;
        let boundary = (cut..text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(text.len());
        text = text[boundary..].to_string();
    }
    item[key] = json!(text);
}
fn tool_text(content: &Value) -> String {
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["content"]["text"].as_str().or(part["text"].as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn permission_result(native: &Value, input: &Value) -> Result<Value, String> {
    let method = native["method"].as_str().unwrap_or("");
    let params = &native["params"];
    if method == "cursor/ask_question" {
        cursor_questions(params)?;
        let mut answers = vec![];
        for question in params["questions"].as_array().unwrap() {
            let question_id = question["id"]
                .as_str()
                .ok_or("Invalid native question ID")?;
            let answer = input["answers"][question_id]
                .as_str()
                .filter(|answer| answer.len() <= 10_000)
                .ok_or("Answer required")?;
            let selected = question["options"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == answer || option["label"] == answer)
                .ok_or("Choose one of the native Cursor question options")?;
            answers.push(json!({"questionId":question_id,"selectedOptionIds":[selected["id"]]}));
        }
        return Ok(json!({"outcome":{"outcome":"answered","answers":answers}}));
    }
    if method == "item/tool/requestUserInput" {
        let mut answers = serde_json::Map::new();
        for question in params["questions"]
            .as_array()
            .ok_or("Question schema unavailable")?
        {
            let key = question["id"].as_str().ok_or("Invalid question ID")?;
            let answer = input["answers"][key]
                .as_str()
                .filter(|a| a.len() <= 10000)
                .ok_or("Answer required")?;
            answers.insert(key.into(), json!({"answers":[answer]}));
        }
        return Ok(json!({"answers":answers}));
    }
    let decision = input["decision"]
        .as_str()
        .filter(|d| ["accept", "acceptForSession", "decline", "cancel"].contains(d))
        .ok_or("Invalid approval decision")?;
    if method == "session/request_permission" {
        let kind = match decision {
            "accept" => "allow_once",
            "acceptForSession" => "allow_always",
            _ => "reject_once",
        };
        let options = params["options"]
            .as_array()
            .ok_or("Native approval options unavailable")?;
        let option = options.iter().find(|o| o["kind"] == kind);
        if ["accept", "acceptForSession"].contains(&decision) && option.is_none() {
            return Err("Approval decision was not offered by the native CLI".into());
        }
        return Ok(
            json!({"outcome":option.map(|o|json!({"outcome":"selected","optionId":o["optionId"]})).unwrap_or(json!({"outcome":"cancelled"}))}),
        );
    }
    if method == "cursor/create_plan" {
        return Ok(
            json!({"outcome":{"outcome":if ["accept","acceptForSession"].contains(&decision){"accepted"}else{"rejected"}}}),
        );
    }
    if method == "item/permissions/requestApproval" {
        if decision == "acceptForSession" {
            return Err(
                "Permission grants support only this turn; choose accept, decline or cancel".into(),
            );
        }
        return Ok(
            json!({"permissions":if decision=="accept"{params["permissions"].clone()}else{json!({})},"scope":"turn"}),
        );
    }
    if let Some(options) = params["availableDecisions"].as_array() {
        if ["accept", "acceptForSession"].contains(&decision)
            && !options.iter().any(|o| o == decision)
        {
            return Err("Approval decision was not offered".into());
        }
    }
    Ok(json!({"decision":decision}))
}

fn cursor_questions(params: &Value) -> Result<Value, String> {
    let questions = params["questions"]
        .as_array()
        .filter(|questions| !questions.is_empty() && questions.len() <= 32)
        .ok_or("Native Cursor question schema unavailable")?;
    let mut normalized = vec![];
    for question in questions {
        let key = question["id"]
            .as_str()
            .filter(|key| !key.is_empty() && key.len() <= 160)
            .ok_or("Invalid native question ID")?;
        let prompt = question["prompt"]
            .as_str()
            .filter(|prompt| prompt.len() <= 10_000)
            .ok_or("Invalid native question prompt")?;
        let options = question["options"]
            .as_array()
            .filter(|options| !options.is_empty() && options.len() <= 100)
            .ok_or("Native Cursor question options unavailable")?;
        let mut choices = vec![];
        for option in options {
            let id = option["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 1000)
                .ok_or("Invalid native question option")?;
            let label = option["label"]
                .as_str()
                .filter(|label| !label.is_empty() && label.len() <= 10_000)
                .ok_or("Invalid native question option label")?;
            choices.push(json!({"label":label,"description":id}));
        }
        normalized.push(json!({"id":key,"question":prompt,"options":choices}));
    }
    Ok(json!(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn codex_reasoning_and_reply_are_visible_in_multiple_running_stream_frames() {
        use futures_util::StreamExt;
        let directory = std::env::temp_dir().join(format!("keepwork-codex-stream-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        let manager = AgentManager::open(directory.join("sessions.json"), 0);
        let data = json!({"id":"session","owner":"fixture","threadId":"native","turnId":"turn","backend":"codex","roots":[directory],"conversationId":"fixture","status":"running","cursor":0,"items":[],"pending":[],"submissions":{},"aichatContext":false});
        let (events, _) = watch::channel(json!({"cursor":0,"session":snapshot(&data)}));
        manager.sessions.lock().unwrap().insert(
            "session".into(),
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
        assert!(manager.stream("session", "another-owner").is_err());
        let mut stream = manager
            .stream("session", "fixture")
            .unwrap()
            .into_body()
            .into_data_stream();
        stream.next().await.unwrap().unwrap();
        for (method, params, expected) in [
            (
                "item/reasoning/summaryTextDelta",
                json!({"itemId":"thinking","summaryIndex":0,"delta":"先思"}),
                "先思",
            ),
            (
                "item/reasoning/summaryTextDelta",
                json!({"itemId":"thinking","summaryIndex":0,"delta":"考中文🙂"}),
                "先思考中文🙂",
            ),
            (
                "item/started",
                json!({"item":{"id":"thinking","type":"reasoning","summary":[],"content":[]}}),
                "先思考中文🙂",
            ),
            (
                "item/reasoning/summaryPartAdded",
                json!({"itemId":"thinking","summaryIndex":1}),
                "先思考中文🙂",
            ),
            (
                "item/reasoning/summaryTextDelta",
                json!({"itemId":"thinking","summaryIndex":1,"delta":"再回答"}),
                "先思考中文🙂\n\n再回答",
            ),
            (
                "item/completed",
                json!({"item":{"id":"thinking","type":"reasoning","summary":["最终思考"],"content":[]}}),
                "最终思考",
            ),
            (
                "item/agentMessage/delta",
                json!({"itemId":"reply","delta":"持续"}),
                "持续",
            ),
            (
                "item/agentMessage/delta",
                json!({"itemId":"reply","delta":"输出🙂"}),
                "持续输出🙂",
            ),
            (
                "item/started",
                json!({"item":{"id":"reply","type":"agentMessage","text":""}}),
                "持续输出🙂",
            ),
            (
                "item/completed",
                json!({"item":{"id":"reply","type":"agentMessage"}}),
                "持续输出🙂",
            ),
            (
                "item/reasoning/textDelta",
                json!({"itemId":"raw","contentIndex":0,"delta":"原生"}),
                "原生",
            ),
            (
                "item/reasoning/textDelta",
                json!({"itemId":"raw","contentIndex":0,"delta":"推理"}),
                "原生推理",
            ),
        ] {
            manager.codex_update("session", method, &params);
            let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let frame: Value = serde_json::from_slice(&frame).unwrap();
            assert_eq!(frame["session"]["status"], "running");
            let item_id = params.get("itemId").unwrap_or(&params["item"]["id"]);
            let item = frame["session"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == *item_id)
                .expect("a streamed item must exist before completion");
            assert_eq!(item["text"], expected, "{method}");
        }
        manager.codex_update(
            "session",
            "turn/completed",
            &json!({"turn":{"status":"completed"}}),
        );
        let frame = stream.next().await.unwrap().unwrap();
        let frame: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(frame["session"]["status"], "completed");
        drop(stream);
        drop(manager);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_approval_options_never_silently_widen_a_one_turn_grant() {
        let native = json!({"method":"session/request_permission","params":{"options":[{"kind":"allow_always","optionId":"persistent"}]}});
        assert!(permission_result(&native, &json!({"decision":"accept"})).is_err());
        assert_eq!(
            permission_result(&native, &json!({"decision":"acceptForSession"})).unwrap()["outcome"]
                ["optionId"],
            "persistent"
        );
        assert_eq!(
            permission_result(&native, &json!({"decision":"decline"})).unwrap()["outcome"]
                ["outcome"],
            "cancelled"
        );
        let native = json!({"method":"item/permissions/requestApproval","params":{"permissions":{"network":{"enabled":true}}}});
        assert_eq!(
            permission_result(&native, &json!({"decision":"accept"})).unwrap(),
            json!({"permissions":{"network":{"enabled":true}},"scope":"turn"})
        );
        assert!(permission_result(&native, &json!({"decision":"acceptForSession"})).is_err());
    }

    #[test]
    fn cursor_questions_forward_only_native_option_ids() {
        let native = json!({"method":"cursor/ask_question","params":{"questions":[{"id":"choice","prompt":"Which one?","options":[{"id":"option-one","label":"One"},{"id":"option-two","label":"Two"}]}]}});
        assert_eq!(
            cursor_questions(&native["params"]).unwrap()[0]["question"],
            "Which one?"
        );
        assert_eq!(
            permission_result(&native, &json!({"answers":{"choice":"Two"}})).unwrap(),
            json!({"outcome":{"outcome":"answered","answers":[{"questionId":"choice","selectedOptionIds":["option-two"]}]}})
        );
        assert!(
            permission_result(&native, &json!({"answers":{"choice":"arbitrary option"}})).is_err()
        );
        assert!(cursor_questions(
            &json!({"questions":[{"id":"choice","prompt":"missing choices"}]})
        )
        .is_err());
    }

    #[test]
    fn acp_tool_roundtrip_preserves_trace_order_and_native_arguments_results() {
        let directory =
            std::env::temp_dir().join(format!("keepwork-agent-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let manager = AgentManager::open(directory.join("sessions.json"), 0);
        let data = json!({"id":"session","owner":"fixture","threadId":"native","turnId":"turn","backend":"workbuddy","roots":[directory],"conversationId":"fixture","status":"running","cursor":0,"items":[],"pending":[],"submissions":{},"aichatContext":false});
        let (events, _) = watch::channel(json!({}));
        manager.sessions.lock().unwrap().insert(
            "session".into(),
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
        manager.acp_update("session", &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"before"}}));
        manager.acp_update("session", &json!({"sessionUpdate":"tool_call","toolCallId":"tool","kind":"read","title":"Read native fixture","status":"completed","rawInput":{"path":"fixture.txt"},"rawOutput":{"text":"result","exitCode":0}}));
        manager.acp_update("session", &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"after"}}));
        let sessions = manager.sessions.lock().unwrap();
        let items = sessions["session"].data["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["text"], "before");
        assert_eq!(items[1]["arguments"]["path"], "fixture.txt");
        assert_eq!(items[1]["result"]["text"], "result");
        assert_eq!(items[1]["exitCode"], 0);
        assert_eq!(items[2]["text"], "after");
        drop(sessions);
        drop(manager);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
