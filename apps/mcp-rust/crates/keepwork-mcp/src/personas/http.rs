//! `/agents/personas` HTTP surface: routing, actions and SSE streams.

use super::*;
use super::{store::*, util::*};

pub async fn handle(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    query: &std::collections::BTreeMap<String, String>,
    headers: &HeaderMap,
    req: Request,
) -> Response {
    match handle_inner(state, method, path, query, headers, req).await {
        Ok(response) => response,
        Err(error) => error_to_response(error),
    }
}

pub(crate) async fn handle_inner(
    state: Arc<AppState>,
    method: &str,
    path: &str,
    query: &std::collections::BTreeMap<String, String>,
    headers: &HeaderMap,
    req: Request,
) -> Result<Response, PersonaError> {
    let owner = owner_hash(headers)?;
    let input = if method == "POST" {
        read_json(headers, req).await?
    } else {
        Value::Null
    };
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let _agents = parts.next();
    let _personas = parts.next();
    let id = parts.next();
    let action = parts.next();
    let store = &state.personas;
    match (method, id, action) {
        ("GET", None, None) => Ok(ok_json(&store.list(&owner))),
        ("POST", None, None) => {
            let mut view = store.upsert(&state.presence, &owner, &input)?;
            if input.get("syncGroupNicknames").and_then(Value::as_bool) == Some(true) {
                view["messagingWarning"] = json!("本机 Rust 服务尚未同步群昵称");
            }
            Ok(ok_json(&view))
        }
        ("GET", Some("events"), None) => Ok(event_stream(Arc::clone(store), &owner)),
        ("GET", Some("messaging-computers"), None) => Ok(ok_json(&json!({
            "version": 1,
            "owner": owner,
            "enabled": false,
            "outagePolicy": "availability-first",
            "error": "",
            "channels": [],
        }))),
        (_, Some("messaging-computers"), None) => {
            Err(PersonaError::unsupported("本机 Rust 服务尚未提供消息协同"))
        }
        (_, Some("circles"), _) => Err(PersonaError::unsupported("Rust 运行时尚未提供圈子接口")),
        ("GET", Some(id), None) => {
            let before = query
                .get("before")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(i64::MAX);
            Ok(ok_json(&store.read(&owner, id, before)?))
        }
        ("GET", Some(id), Some("wechat")) => {
            store.read(&owner, id, i64::MAX)?;
            Ok(ok_json(&json!({
                "enabled": false,
                "status": "未绑定",
                "machine": gethostname::gethostname().to_string_lossy(),
            })))
        }
        ("GET", Some(id), Some("messaging-options")) => {
            store.read(&owner, id, i64::MAX)?;
            Ok(ok_json(&state.messaging.messaging_options(&owner, id)))
        }
        ("GET", Some(id), Some("inbox")) => {
            store.read(&owner, id, i64::MAX)?;
            let binding = query.get("binding").cloned().unwrap_or_default();
            let conversation = query.get("conversation").cloned().unwrap_or_default();
            let before = query
                .get("before")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(i64::MAX);
            state
                .messaging
                .named_inbox_view(&owner, id, &binding, &conversation, before)
                .await
                .map(|view| ok_json(&view))
                .map_err(|error| error.into_persona_error())
        }
        ("POST", Some(id), Some(action)) => {
            store.read(&owner, id, i64::MAX)?;
            let state = Arc::clone(&state);
            Ok(ok_json(
                &post_action(state, &owner, id, action, &input).await?,
            ))
        }
        (_, Some(id), Some(_)) => {
            store.read(&owner, id, i64::MAX)?;
            Err(PersonaError::method())
        }
        _ => Err(PersonaError::unknown_op()),
    }
}

pub(crate) async fn post_action(
    state: Arc<AppState>,
    owner: &str,
    id: &str,
    action: &str,
    input: &Value,
) -> Result<Value, PersonaError> {
    let store = &state.personas;
    let messaging = &state.messaging;
    let agent_root = || store.agent_root(owner, id).unwrap_or_default();
    let agent_prompt = || store.persona_prompt(owner, id).unwrap_or_default();
    match action {
        "messages" => store.submit(&state.presence, owner, id, input),
        "clear" => store.clear(owner, id),
        "read" => store.mark_read(owner, id),
        "cancel" => store.cancel(owner, id),
        "approval-revoke" => store.read(owner, id, i64::MAX),
        "respond" => Err(PersonaError::bad("没有待处理请求")),
        "schedules" => store.schedule(owner, id, input),
        "remove" => store.remove(owner, id),
        "messaging-groups" => {
            let binding = input["binding"].as_str().unwrap_or("");
            let query = input["query"].as_str().unwrap_or("");
            messaging
                .agent_groups(owner, id, binding, query)
                .await
                .map_err(|error| error.into_persona_error())
        }
        "channel-connect" => {
            let channel = input["channel"].as_str().unwrap_or("dingtalk");
            if !(channel == "dingtalk" || channel == "feishu") {
                return Err(PersonaError::bad("Unknown channel"));
            }
            let root = input["root"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(agent_root);
            let prompt = agent_prompt();
            let result = async {
                if let Some(switch_from_root) = input.get("switchFromRoot") {
                    messaging
                        .switch_channel(channel, &root, switch_from_root.as_str().unwrap_or(""))
                        .await?;
                }
                if channel == "feishu" {
                    messaging
                        .connect_feishu_agent(owner, id, &root, &prompt)
                        .await
                } else {
                    messaging.connect_agent(owner, id, &root, &prompt).await
                }
            }
            .await;
            match result {
                Ok(view) => Ok(view),
                Err(error) if MessageError::needs_login(&error) => Ok(json!({
                    "status": "needs-login",
                    "listening": false,
                    "needsLogin": true,
                })),
                Err(error) => Err(error.into_persona_error()),
            }
        }
        "channel-login" => {
            let root = input["root"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(agent_root);
            let prompt = agent_prompt();
            if let Some(switch_from_root) = input.get("switchFromRoot") {
                messaging
                    .switch_channel("dingtalk", &root, switch_from_root.as_str().unwrap_or(""))
                    .await
                    .map_err(|error| error.into_persona_error())?;
            }
            messaging
                .login_agent(owner, id, &root, &prompt)
                .await
                .map_err(|error| error.into_persona_error())
        }
        "bind" => {
            let binding = input["binding"].as_str().unwrap_or("");
            messaging
                .bind_agent(owner, id, binding, true)
                .map_err(|error| error.into_persona_error())?;
            messaging.set_agent_prompt(owner, id, &agent_prompt());
            Ok(store.read(owner, id, i64::MAX)?)
        }
        "inbox" => {
            let binding = input["binding"].as_str().unwrap_or("");
            let conversation = input["conversation"].as_str().unwrap_or("");
            let inbox_action = input["action"].as_str().unwrap_or("");
            messaging
                .inbox_action(owner, id, binding, conversation, inbox_action)
                .map_err(|error| error.into_persona_error())
        }
        "reply" => {
            let binding = input["binding"].as_str().unwrap_or("");
            let conversation = input["conversation"].as_str().unwrap_or("");
            let request_id = input["requestId"].as_str().unwrap_or("");
            let text = input["text"].as_str().unwrap_or("");
            messaging
                .manual_reply(owner, id, binding, conversation, request_id, text)
                .await
                .map_err(|error| error.into_persona_error())
        }
        "channel-start" => {
            let binding = input["binding"].as_str().unwrap_or("");
            messaging
                .assert_agent_binding(owner, id, binding)
                .map_err(|error| error.into_persona_error())?;
            messaging
                .start(binding)
                .await
                .map_err(|error| error.into_persona_error())?;
            Ok(json!({ "ok": true }))
        }
        "channel-stop" => {
            let binding = input["binding"].as_str().unwrap_or("");
            messaging
                .assert_agent_binding(owner, id, binding)
                .map_err(|error| error.into_persona_error())?;
            messaging.stop(binding);
            Ok(json!({ "ok": true }))
        }
        "wechat" => Err(PersonaError::unsupported("本机 Rust 服务尚未托管微信")),
        "sales" => Err(PersonaError::unsupported("本机 Rust 服务尚未提供自主销售")),
        _ => Err(PersonaError::unknown_op()),
    }
}

pub(crate) fn owner_hash(headers: &HeaderMap) -> Result<String, PersonaError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let owner = headers
        .get("x-agent-owner")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !owner_re().is_match(owner) {
        return Err(PersonaError::bad("Agent owner key required"));
    }
    Ok(sha256_hex(&[origin.as_bytes(), b"\0", owner.as_bytes()]))
}

pub(crate) async fn read_json(headers: &HeaderMap, req: Request) -> Result<Value, PersonaError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("application/json") {
        return Err(PersonaError::bad("JSON required"));
    }
    let bytes = axum::body::to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| PersonaError::bad("Request too large"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| PersonaError::bad("Invalid JSON"))
}

pub(crate) fn event_stream(store: Arc<PersonaStore>, owner: &str) -> Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let slot_index = {
        let mut inner = store.lock();
        inner.watchers.push(Some((owner.to_string(), tx.clone())));
        inner.watchers.len() - 1
    };
    let _ = tx.send(Ok(Bytes::from_static(b"event: changed\ndata: {}\n\n")));
    let store_for_alive = Arc::clone(&store);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(25));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            if tx.send(Ok(Bytes::from_static(b": alive\n\n"))).is_err() {
                let mut inner = store_for_alive.lock();
                if let Some(slot) = inner.watchers.get_mut(slot_index) {
                    *slot = None;
                }
                break;
            }
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(
            tokio_stream::wrappers::UnboundedReceiverStream::new(rx),
        ))
        .expect("persona event stream")
}
