//! DingTalk side: `dws` login, the ndjson event listener child, subscription args and DingTalk data calls.

use super::*;
use super::{cli::*, feishu::*, policy::*};

/// Explicit interactive authorization; output (credentials) is discarded.
pub(crate) async fn login_dws(root: &str, profile: Option<&str>) -> Result<(), MessageError> {
    let program = resolve_dws().map_err(|error| MessageError::bad(error.message.clone()))?;
    let mut args = vec!["auth".to_string(), "login".to_string()];
    if let Some(profile) = profile {
        args.push("--profile".into());
        args.push(profile.to_string());
    }
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(if root.is_empty() { "." } else { root })
        .env(path_env_key(), cli_child_path(Some(&program)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| MessageError::bad("DingTalk authorization could not start"))?;
    let outcome = tokio::time::timeout(
        std::time::Duration::from_millis(LOGIN_TIMEOUT_MS),
        child.wait(),
    )
    .await;
    match outcome {
        Ok(Ok(status)) if status.code() == Some(0) => Ok(()),
        Ok(_) => Err(MessageError::bad(
            "DingTalk authorization was cancelled or failed",
        )),
        Err(_) => {
            let _ = child.kill().await;
            Err(MessageError::bad(
                "DingTalk authorization timed out; retry authorization",
            ))
        }
    }
}

/// Per-key `event consume` argument sets (`listenerArgs`).
/// Per-key `event consume` argument sets (`listenerArgs`). Group subscriptions
/// follow Node: an available agent listens to every group, otherwise keywords
/// listen per configured group, otherwise only the base at/o2o stream.
pub fn listener_args(config: &MessageConfig, all_groups: bool) -> Vec<Vec<String>> {
    let mut sets: Vec<Vec<String>> = vec![vec![
        "event".into(),
        "consume".into(),
        "user_im_message_receive_at".into(),
        "user_im_message_receive_o2o_all".into(),
    ]];
    if all_groups {
        sets.push(vec![
            "event".into(),
            "consume".into(),
            "user_im_message_receive_group_all".into(),
        ]);
    } else if !config.keywords.is_empty() {
        for group in &config.groups {
            sets.push(vec![
                "event".into(),
                "consume".into(),
                "user_im_message_receive_group".into(),
                "--group".into(),
                group.clone(),
            ]);
        }
    }
    for set in &mut sets {
        set.push("--flatten".into());
        set.push("-f".into());
        set.push("ndjson".into());
    }
    sets
}

pub(crate) fn subscription_key(config: &MessageConfig, all_groups: bool) -> String {
    json!([config.groups, !config.keywords.is_empty(), all_groups]).to_string()
}

// ---------------------------------------------------------------------------
// DingTalk listener
// ---------------------------------------------------------------------------

pub(crate) async fn wait_listener_ready(
    stderr: &mut (impl AsyncReadExt + Unpin),
) -> Result<(), DwsError> {
    let mut diagnostics = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(CLI_TIMEOUT_MS);
    let mut buffer = [0u8; 8192];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(DwsError::rejected("DWS listener not ready"));
        }
        let read = tokio::select! {
            chunk = stderr.read(&mut buffer) => chunk,
            _ = tokio::time::sleep(remaining) => {
                return Err(DwsError::rejected("DWS listener not ready"));
            }
        };
        match read {
            Ok(0) => {
                if diagnostics.contains("[event] ready") {
                    return Ok(());
                }
                if regex_is_match(
                    r"(?i)unknown.{0,30}(event|rule)|unsupported|not supported|invalid.{0,10}event",
                    &diagnostics,
                ) {
                    return Err(DwsError::rejected(
                        "DWS CLI update required for message subscriptions",
                    ));
                }
                if regex_is_match(
                    r"(?i)invalid.?grant|token.*expired|unauthorized|\b401\b|auth login|未登录|请.*登录",
                    &diagnostics,
                ) {
                    return Err(DwsError::rejected("DingTalk login required"));
                }
                return Err(DwsError::rejected("DWS listener exited before ready"));
            }
            Ok(size) => {
                diagnostics.push_str(&String::from_utf8_lossy(&buffer[..size]));
                // A single read can contain ready followed by a full log burst.
                // Observe the marker before bounding the diagnostic tail.
                if diagnostics.contains("[event] ready") {
                    return Ok(());
                }
                let mut keep_from = diagnostics.len().saturating_sub(4000);
                while !diagnostics.is_char_boundary(keep_from) {
                    keep_from += 1;
                }
                diagnostics = diagnostics.split_off(keep_from);
            }
            Err(_) => {
                return Err(DwsError::rejected("DWS listener could not start"));
            }
        }
    }
}

pub(crate) async fn discard_stream(stream: impl AsyncReadExt + Unpin) {
    let mut stream = stream;
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

pub(crate) fn spawn_listener_child(
    program: &Path,
    args: &[String],
    profile: &str,
    root: &str,
) -> Result<Child, MessageError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .arg("--profile")
        .arg(profile)
        .current_dir(if root.is_empty() { "." } else { root })
        .env(path_env_key(), cli_child_path(Some(program)))
        // DWS treats EOF on a held pipe as host shutdown. A null stdin cannot
        // convey parent death and leaves consumers behind after a daemon crash.
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    command
        .spawn()
        .map_err(|_| MessageError::bad("DWS listener could not start"))
}

pub(crate) async fn listener_stopped(stop: &mut tokio::sync::watch::Receiver<bool>) {
    while !*stop.borrow() {
        if stop.changed().await.is_err() {
            break;
        }
    }
}

async fn close_listener_child(child: &mut Child) {
    drop(child.stdin.take());
    // Give DWS time to unregister its consumers and cancel its own subscriptions.
    // Only this Child handle may be force-reaped if graceful exit is unresponsive.
    if !matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    ) {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

pub(crate) async fn reap_listener_children(mut children: Vec<Child>) {
    // Close every pipe before waiting so sibling subscriptions shut down together.
    for child in &mut children {
        drop(child.stdin.take());
    }
    let mut cleanup = tokio::task::JoinSet::new();
    for mut child in children {
        cleanup.spawn(async move { close_listener_child(&mut child).await });
    }
    while cleanup.join_next().await.is_some() {}
}

/// Every child stays owned through ready and is reaped on partial failure.
pub(crate) async fn start_listener_children(
    program: &Path,
    sets: &[Vec<String>],
    profile: &str,
    root: &str,
    stop: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<Child>, MessageError> {
    let mut children = Vec::new();
    let outcome = async {
        for args in sets {
            if *stop.borrow() {
                return Err(MessageError::bad("Start cancelled"));
            }
            children.push(spawn_listener_child(program, args, profile, root)?);
            let child = children.last_mut().unwrap();
            let mut stderr = child
                .stderr
                .take()
                .ok_or_else(|| MessageError::bad("DWS listener could not start"))?;
            let ready = tokio::select! {
                biased;
                _ = listener_stopped(stop) => Err(DwsError::rejected("Start cancelled")),
                ready = wait_listener_ready(&mut stderr) => ready,
            };
            // Keep draining the same pipe after ready; taking it a second time
            // would lose it and eventually block the CLI on its own logs.
            child.stderr = Some(stderr);
            ready.map_err(|error| MessageError::bad(error.message))?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = outcome {
        reap_listener_children(children).await;
        return Err(error);
    }
    Ok(children)
}

async fn read_listener_events(
    service: &Arc<MessagingService>,
    id: &str,
    generation: u64,
    mut stdout: tokio::process::ChildStdout,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                buffer.extend_from_slice(&chunk[..size]);
                if buffer.len() > 1_000_000 {
                    break;
                }
                while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=end).collect();
                    if let Ok(event) = serde_json::from_slice::<Value>(&line) {
                        service.receive_event(id, generation, event).await;
                    }
                }
            }
        }
    }
}

pub(crate) async fn supervise_listeners(
    service: Arc<MessagingService>,
    id: String,
    generation: u64,
    children: Vec<Child>,
    stop: tokio::sync::watch::Sender<bool>,
    done: tokio::sync::watch::Sender<bool>,
) {
    let mut tasks = tokio::task::JoinSet::new();
    for mut child in children {
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let mut cancelled = stop.subscribe();
        let service = Arc::clone(&service);
        let id = id.clone();
        tasks.spawn(async move {
            let events = async {
                if let Some(stdout) = stdout {
                    read_listener_events(&service, &id, generation, stdout).await;
                }
            };
            let diagnostics = async {
                if let Some(stderr) = stderr {
                    discard_stream(stderr).await;
                }
                std::future::pending::<()>().await;
            };
            // Child::wait closes stdin itself. Keep the host-lifetime pipe out
            // of Child while supervising, otherwise a ready CLI sees EOF at once.
            let lifetime_stdin = child.stdin.take();
            let unexpected = tokio::select! {
                biased;
                _ = listener_stopped(&mut cancelled) => false,
                _ = child.wait() => true,
                _ = events => true,
                _ = diagnostics => unreachable!(),
            };
            drop(lifetime_stdin);
            close_listener_child(&mut child).await;
            unexpected
        });
    }
    let mut unexpected = false;
    while let Some(result) = tasks.join_next().await {
        if !matches!(result, Ok(false)) {
            unexpected = true;
            stop.send_replace(true);
        }
    }
    // Waiters may create the replacement only after every owned PID is gone.
    let _ = done.send(true);
    if unexpected {
        service
            .disconnected_generation(&id, "Listener disconnected", Some(generation))
            .await;
    }
}

// ---------------------------------------------------------------------------
// Feishu helpers
// ---------------------------------------------------------------------------

pub(crate) async fn dingtalk_call_checked(
    root: &str,
    args: &[String],
) -> Result<Value, MessageError> {
    dws_call(args, root)
        .await
        .map_err(|error| MessageError::bad(error.message))
}

pub(crate) async fn dingtalk_status(root: &str, profile: &str) -> Result<Value, MessageError> {
    let args = vec![
        "event".to_string(),
        "status".to_string(),
        "--profile".into(),
        profile.to_string(),
        "-f".into(),
        "json".into(),
    ];
    dingtalk_call_checked(root, &args).await
}

pub(crate) fn dingtalk_identity_matches(value: &Value, profile: &str) -> bool {
    let corp = value
        .pointer("/identity/corp_id")
        .or_else(|| value.pointer("/identity/corpId"));
    let user = value
        .pointer("/identity/user_id")
        .or_else(|| value.pointer("/identity/userId"));
    match (corp.and_then(Value::as_str), user.and_then(Value::as_str)) {
        (Some(corp), Some(user)) => format!("{corp}:{user}") == profile,
        _ => false,
    }
}

/// Mirror of Node `dingtalkSenderName`: direct chats supply the single-chat
/// title, group chats resolve the member record for the exact sender open ID.
pub(crate) async fn dingtalk_sender_name(
    root: &str,
    profile: &str,
    conversation: &str,
    sender: &str,
    kind: &str,
) -> Result<String, MessageError> {
    let status = dingtalk_status(root, profile).await?;
    if !dingtalk_identity_matches(&status, profile) {
        return Err(MessageError::bad(
            "DWS identity does not match configured profile",
        ));
    }
    let name = if kind == "direct" {
        let result = dingtalk_call_checked(
            root,
            &[
                "chat".to_string(),
                "+conversation-info".to_string(),
                "--open-dingtalk-id".into(),
                sender.to_string(),
                "--profile".into(),
                profile.to_string(),
                "-f".into(),
                "json".into(),
            ],
        )
        .await?;
        let data = unwrap_envelope(&result);
        let info = &data["conversationInfo"];
        // Only the single-chat title for this exact sender can supply their name.
        let title = if info["singleChat"].as_bool() == Some(true) {
            info["title"].as_str()
        } else {
            None
        };
        match title {
            Some(title) if title.trim() != sender => title.trim().chars().take(256).collect(),
            _ => String::new(),
        }
    } else {
        let result = dingtalk_call_checked(
            root,
            &[
                "chat".to_string(),
                "+chat-members-get".to_string(),
                "--id".into(),
                conversation.to_string(),
                "--users".into(),
                sender.to_string(),
                "--profile".into(),
                profile.to_string(),
                "-f".into(),
                "json".into(),
            ],
        )
        .await?;
        let data = unwrap_envelope(&result);
        let rows = data
            .as_array()
            .or_else(|| data["members"].as_array())
            .or_else(|| data["list"].as_array());
        let member = rows.and_then(|rows| {
            rows.iter()
                .find(|row| row["openDingtalkId"].as_str() == Some(sender))
        });
        let name = member.and_then(|member| {
            [
                "memberEmpName",
                "nick",
                "memberNick",
                "groupNick",
                "memberGroupNick",
            ]
            .iter()
            .find_map(|key| member[*key].as_str().filter(|name| !name.is_empty()))
        });
        match name {
            Some(name) if name.trim() != sender => name.trim().chars().take(256).collect(),
            _ => String::new(),
        }
    };
    Ok(name)
}

pub(crate) async fn dingtalk_conversation(
    root: &str,
    profile: &str,
    target: &Incoming,
    self_open_id: &str,
) -> Result<Vec<Incoming>, MessageError> {
    let status = dingtalk_status(root, profile).await?;
    if !dingtalk_identity_matches(&status, profile) {
        return Err(MessageError::bad(
            "DWS identity does not match configured profile",
        ));
    }
    let identity = status["identity"].clone();
    let user_id = identity["user_id"]
        .as_str()
        .or(identity["userId"].as_str())
        .unwrap_or("");
    let open_id = identity["open_dingtalk_id"].as_str().unwrap_or("");
    let read = |selector: Vec<String>| {
        let mut args = vec!["chat".to_string()];
        args.extend(selector);
        args.extend(vec![
            "--limit".into(),
            "50".into(),
            "--order".into(),
            "desc".into(),
            "--no-reactions".into(),
            "--profile".into(),
            profile.to_string(),
            "--format".into(),
            "json".into(),
        ]);
        args
    };
    let base = if target.kind == "direct" {
        vec![
            "+chat-messages".to_string(),
            "--open-dingtalk-id".to_string(),
            target.sender.clone(),
        ]
    } else {
        vec![
            "+chat-messages".to_string(),
            "--group".to_string(),
            target.conversation.clone(),
        ]
    };
    let mut rows = {
        let result = dingtalk_call_checked(root, &read(base)).await?;
        validate_message_list(&result)?;
        result["messages"].as_array().cloned().unwrap_or_default()
    };
    let thread = target.thread.clone().or_else(|| {
        rows.iter()
            .find(|row| row["messageId"].as_str() == Some(target.id.as_str()))
            .and_then(|row| row["threadId"].as_str().map(str::to_string))
    });
    let conversation = rows
        .iter()
        .find(|row| row["messageId"].as_str() == Some(target.id.as_str()))
        .and_then(|row| row["conversationId"].as_str().map(str::to_string));
    if let Some(thread) = thread {
        let group = conversation
            .clone()
            .unwrap_or_else(|| target.conversation.clone());
        let result = dingtalk_call_checked(
            root,
            &read(vec![
                "+thread-replies".to_string(),
                "--group".to_string(),
                group,
                "--thread-id".to_string(),
                thread,
            ]),
        )
        .await?;
        validate_message_list(&result)?;
        if let Some(messages) = result["messages"].as_array() {
            rows.extend(messages.iter().cloned());
        }
    }
    let mut messages: HashMap<String, Incoming> = HashMap::new();
    for row in &rows {
        let raw_time = row["createTime"].as_i64().or_else(|| {
            row["createTime"]
                .as_str()
                .and_then(|t| t.parse::<i64>().ok())
        });
        let time = raw_time.map(parse_message_time);
        let Some(time) = time else {
            return Err(MessageError::bad("钉钉消息缺少身份或时间"));
        };
        let (Some(message_id), Some(sender_id)) = (
            row["messageId"].as_str().map(str::to_string),
            row["senderId"].as_str().map(str::to_string),
        ) else {
            return Err(MessageError::bad("钉钉消息缺少身份或时间"));
        };
        if time <= 0 {
            return Err(MessageError::bad("钉钉消息缺少身份或时间"));
        }
        if let Some(row_conversation) = row["conversationId"].as_str() {
            if conversation.is_some() && row_conversation != conversation.as_deref().unwrap_or("") {
                return Err(MessageError::bad("钉钉会话上下文不匹配"));
            }
        }
        let text = row["text"].as_str().unwrap_or("[非文本消息]").to_string();
        let automated = automated_sender(row) || automated_text(&text);
        let sender = if sender_id == user_id {
            if open_id.is_empty() && self_open_id.is_empty() {
                sender_id.clone()
            } else {
                open_id.to_string()
            }
        } else {
            sender_id.clone()
        };
        messages.insert(
            message_id.clone(),
            Incoming {
                id: message_id,
                conversation: target.conversation.clone(),
                sender,
                text,
                time,
                kind: target.kind.clone(),
                thread: row["threadId"].as_str().map(str::to_string),
                automated,
                mentioned_self: false,
                recovered: false,
            },
        );
    }
    let mut rows: Vec<Incoming> = messages.into_values().collect();
    rows.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.id.cmp(&b.id)));
    Ok(rows)
}

pub(crate) fn validate_message_list(result: &Value) -> Result<(), MessageError> {
    let complete_ok =
        result["complete"].as_bool() != Some(false) || result["hasMore"].as_bool() == Some(true);
    if result["contractVersion"].as_str() != Some("im.message-list.v1")
        || !result["messages"].is_array()
        || result["partial"].as_bool() == Some(true)
        || result["failedCount"].as_i64().unwrap_or(0) != 0
        || result["failures"]
            .as_array()
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        || !complete_ok
    {
        return Err(MessageError::bad("钉钉会话上下文读取不完整"));
    }
    Ok(())
}

pub(crate) fn parse_message_time(raw: i64) -> i64 {
    if raw > 0 && raw < 1_000_000_000_000 {
        raw * 1000
    } else {
        raw
    }
}

pub(crate) async fn dingtalk_send(
    root: &str,
    profile: &str,
    target: &Incoming,
    id: &str,
    text: &str,
) -> Result<(), MessageError> {
    let marker = if marker_tag(text).is_empty() {
        "【AI 代答】".to_string()
    } else {
        marker_tag(text)
    };
    let body = if marker_tag(text).is_empty() {
        text
    } else {
        &text[marker.len()..]
    };
    let parts = if marker_tag(text).is_empty() {
        split_reply(body, 6000)
    } else {
        let budget = 6000 - marker.len();
        split_reply(body, budget)
            .into_iter()
            .map(|part| format!("{marker}{part}"))
            .collect::<Vec<_>>()
    };
    for (index, part) in parts.iter().enumerate() {
        let args = if target.kind == "direct" {
            vec![
                "chat".to_string(),
                "+messages-send".to_string(),
                "--as".into(),
                "user".into(),
                "--open-dingtalk-id".into(),
                target.sender.clone(),
                "--text".into(),
                part.clone(),
                "--idempotency-key".into(),
                format!("{id}-{index}"),
                "--profile".into(),
                profile.to_string(),
                "-f".into(),
                "json".into(),
                "--yes".into(),
            ]
        } else {
            vec![
                "chat".to_string(),
                "+messages-send".to_string(),
                "--as".into(),
                "user".into(),
                "--group".into(),
                target.conversation.clone(),
                "--text".into(),
                part.clone(),
                "--idempotency-key".into(),
                format!("{id}-{index}"),
                "--profile".into(),
                profile.to_string(),
                "-f".into(),
                "json".into(),
                "--yes".into(),
            ]
        };
        dingtalk_call_checked(root, &args).await?;
    }
    Ok(())
}

pub(crate) async fn dingtalk_groups(
    root: &str,
    profile: &str,
    query: &str,
) -> Result<Value, MessageError> {
    if query.chars().count() > 200 {
        return Err(MessageError::bad("Group query too long"));
    }
    let args = if query.is_empty() {
        vec![
            "chat".to_string(),
            "+chat-list".to_string(),
            "--types".into(),
            "group".into(),
            "--page-size".into(),
            "50".into(),
            "--profile".into(),
            profile.to_string(),
            "-f".into(),
            "json".into(),
        ]
    } else {
        vec![
            "chat".to_string(),
            "+chat-search".to_string(),
            "--query".into(),
            query.to_string(),
            "--limit".into(),
            "50".into(),
            "--profile".into(),
            profile.to_string(),
            "-f".into(),
            "json".into(),
        ]
    };
    let result = dingtalk_call_checked(root, &args).await?;
    let mut groups: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    walk_group_ids(&result, &mut groups, &mut seen);
    groups.truncate(50);
    Ok(json!({ "groups": groups }))
}

pub(crate) fn walk_group_ids(value: &Value, groups: &mut Vec<Value>, seen: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            let id = map
                .get("openConversationId")
                .or_else(|| map.get("open_conversation_id"))
                .or_else(|| map.get("conversation_id"))
                .and_then(Value::as_str);
            if let Some(id) = id {
                if seen.insert(id.to_string()) {
                    let name = map
                        .get("name")
                        .or_else(|| map.get("title"))
                        .or_else(|| map.get("conversationName"))
                        .and_then(Value::as_str)
                        .unwrap_or(id);
                    groups.push(json!({ "id": id, "name": name }));
                }
            }
            for child in map.values() {
                walk_group_ids(child, groups, seen);
            }
        }
        Value::Array(rows) => {
            for row in rows {
                walk_group_ids(row, groups, seen);
            }
        }
        _ => {}
    }
}

pub(crate) async fn dingtalk_profiles(root: &str) -> Result<Value, MessageError> {
    let args = vec![
        "profile".to_string(),
        "list".to_string(),
        "-f".into(),
        "json".into(),
    ];
    let result = dws_call(&args, root)
        .await
        .map_err(|error| MessageError::bad(error.message))?;
    let mut found: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let current = result["currentProfile"].as_str().unwrap_or("").to_string();
    walk_profiles(&result, &current, &mut found, &mut seen);
    Ok(json!({ "profiles": found }))
}

pub(crate) fn walk_profiles(
    value: &Value,
    current: &str,
    found: &mut Vec<Value>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Object(map) => {
            let corp = map
                .get("corpId")
                .or_else(|| map.get("corp_id"))
                .and_then(Value::as_str);
            let user = map
                .get("userId")
                .or_else(|| map.get("user_id"))
                .and_then(Value::as_str);
            if let (Some(corp), Some(user)) = (corp, user) {
                let id = format!("{corp}:{user}");
                if seen.insert(id.clone()) {
                    let corp_name = map
                        .get("corpName")
                        .or_else(|| map.get("corp_name"))
                        .and_then(Value::as_str)
                        .unwrap_or(corp);
                    let user_name = map
                        .get("userName")
                        .or_else(|| map.get("user_name"))
                        .and_then(Value::as_str)
                        .unwrap_or(user);
                    found.push(json!({
                        "id": id,
                        "name": format!("{corp_name} / {user_name}"),
                        "current": map.get("isCurrent").and_then(Value::as_bool).unwrap_or(false) || current == id,
                    }));
                }
            }
            for child in map.values() {
                walk_profiles(child, current, found, seen);
            }
        }
        Value::Array(rows) => {
            for row in rows {
                walk_profiles(row, current, found, seen);
            }
        }
        _ => {}
    }
}

pub(crate) async fn dingtalk_group_name(
    root: &str,
    profile: &str,
    group: &str,
) -> Result<String, MessageError> {
    dingtalk_status(root, profile).await?;
    let result = dingtalk_call_checked(
        root,
        &[
            "chat".to_string(),
            "+conversation-info".to_string(),
            "--group".into(),
            group.to_string(),
            "--profile".into(),
            profile.to_string(),
            "-f".into(),
            "json".into(),
        ],
    )
    .await?;
    let names: Vec<String> = Vec::new();
    let mut collected = names;
    collect_conversation_name(&result, group, &mut collected, 0);
    if collected.len() != 1 {
        return Err(MessageError::bad("Group name unavailable"));
    }
    Ok(collected
        .into_iter()
        .next()
        .unwrap_or_else(|| group.to_string()))
}

pub(crate) fn collect_conversation_name(
    value: &Value,
    group: &str,
    names: &mut Vec<String>,
    depth: usize,
) {
    if depth > 5 {
        return;
    }
    match value {
        Value::Object(map) => {
            let id = map
                .get("openConversationId")
                .or_else(|| map.get("open_conversation_id"))
                .or_else(|| map.get("conversationId"))
                .or_else(|| map.get("conversation_id"))
                .and_then(Value::as_str);
            if id.map(|id| id != group).unwrap_or(false) {
                return;
            }
            let name = map
                .get("title")
                .or_else(|| map.get("name"))
                .or_else(|| map.get("conversationName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let Some(name) = name {
                names.push(name.chars().take(256).collect());
            } else {
                for child in map.values() {
                    collect_conversation_name(child, group, names, depth + 1);
                }
            }
        }
        Value::Array(rows) => {
            for row in rows {
                collect_conversation_name(row, group, names, depth + 1);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Incoming message model and trigger policy
// ---------------------------------------------------------------------------

/// ndjson event → Incoming for DingTalk listeners.
pub fn incoming_from_event(event: &Value) -> Option<Incoming> {
    let event_type = event["type"]
        .as_str()
        .or_else(|| event["event_type"].as_str())
        .unwrap_or("");
    let kind = if event_type == "user_im_message_receive_at" {
        "mention"
    } else if event_type == "user_im_message_receive_o2o_all"
        || event_type == "user_im_message_receive_o2o"
    {
        "direct"
    } else if event_type == "user_im_message_receive_group_all"
        || event_type == "user_im_message_receive_group"
    {
        "group"
    } else {
        return None;
    };
    let content = event["content"].as_str()?;
    if content.trim().is_empty() {
        return None;
    }
    let raw_time = event
        .get("create_time")
        .or_else(|| event.get("event_time"))
        .or_else(|| event.get("timestamp"))?;
    let time = parse_message_time_value(raw_time)?;
    let id = event["message_id"]
        .as_str()
        .or_else(|| event["event_id"].as_str())?;
    let sender = event["sender_open_dingtalk_id"].as_str()?;
    if kind != "direct" && event["conversation_id"].as_str().is_none() {
        return None;
    }
    let conversation = event["conversation_id"].as_str().unwrap_or(sender);
    Some(Incoming {
        id: id.to_string(),
        conversation: conversation.to_string(),
        sender: sender.to_string(),
        text: content.chars().take(16_000).collect(),
        time,
        kind: kind.to_string(),
        thread: event["thread_id"].as_str().map(str::to_string),
        automated: automated_sender(event)
            || automated_text(content)
            || regex_is_match(
                r"(?i)^(interactivecard|card)$",
                event["msg_type"]
                    .as_str()
                    .unwrap_or(event["message_type"].as_str().unwrap_or("")),
            ),
        mentioned_self: false,
        recovered: false,
    })
}
