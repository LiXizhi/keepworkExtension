//! `/messaging/*` HTTP routes: config, profiles, groups, status, start/stop and the SSE event stream.

use super::*;
use super::{dingtalk::*, policy::*, service::*};

impl MessagingService {
    pub(crate) fn is_closed(&self) -> bool {
        self.lock().closed
    }

    // -----------------------------------------------------------------------
    // `/messaging/*` handlers (`src/mcp/messagingHttp.ts`)
    // -----------------------------------------------------------------------

    /// GET /messaging/config — bindings carry their on-disk rules; roots with
    /// unreadable rules surface the error instead of hiding the binding.
    pub(crate) fn http_config(&self, root: &str) -> Result<Value, MessageError> {
        let (config, prompt) = if root.is_empty() {
            (default_config(), DEFAULT_PROMPT.to_string())
        } else {
            rules_defaults(root)?
        };
        let mut rows = Vec::new();
        for view in self.list_views() {
            let mut row = view;
            match read_rules_raw(row["root"].as_str().unwrap_or(""), row["rulesDir"].as_str()) {
                Ok((value, prompt)) => {
                    row["config"] = value;
                    row["prompt"] = json!(prompt);
                }
                Err(error) => {
                    row["error"] = json!(error.message);
                }
            }
            rows.push(row);
        }
        Ok(json!({
            "bindings": rows,
            "defaults": { "config": config, "prompt": prompt },
        }))
    }

    /// POST /messaging/config — Node `configure()`; configure never claims the
    /// channel, only rejects a different occupied root.
    pub(crate) fn http_configure(self: &Arc<Self>, input: &Value) -> Result<Value, MessageError> {
        let channel = match input.get("channel") {
            Some(Value::String(text)) if !text.is_empty() => text.clone(),
            _ => "dingtalk".to_string(),
        };
        let root = input["root"].as_str().unwrap_or("").to_string();
        let profile = input["profile"].as_str().unwrap_or("").to_string();
        let prompt = input["prompt"].as_str().unwrap_or("").to_string();
        let (id, woke) = {
            let mut inner = self.lock();
            self.configure(
                &mut inner,
                &channel,
                &root,
                &profile,
                input["config"].clone(),
                &prompt,
            )?
        };
        self.bump_owners(woke);
        self.view(&id)
    }

    /// POST /messaging/profiles — Node `profiles()`: claim the dingtalk root,
    /// retry the CLI listing at 1s/2s, then project `corpId:userId` only.
    pub(crate) async fn http_profiles(
        self: &Arc<Self>,
        input: &Value,
    ) -> Result<Value, MessageError> {
        let root = input["root"].as_str().unwrap_or("").to_string();
        if !Path::new(&root).is_absolute()
            || !std::fs::metadata(&root)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        {
            return Err(MessageError::bad("Local second-brain directory required"));
        }
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, "dingtalk", &root)?;
        }
        let mut attempt = 0;
        loop {
            match dingtalk_profiles(&root).await {
                Ok(result) => {
                    if self.is_closed() {
                        return Err(MessageError::bad("Service closed"));
                    }
                    return Ok(result);
                }
                Err(error) => {
                    if self.is_closed() || needs_repair_text(&error.message) || attempt >= 2 {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1000u64 << attempt)).await;
                    attempt += 1;
                }
            }
        }
    }

    /// POST /messaging/groups — Node `groups()`: profile validation, claim,
    /// then a single `dws chat` search or list call.
    pub(crate) async fn http_groups(
        self: &Arc<Self>,
        input: &Value,
    ) -> Result<Value, MessageError> {
        let root = input["root"].as_str().unwrap_or("").to_string();
        let profile = input["profile"].as_str().unwrap_or("").to_string();
        let query = input["query"].as_str().unwrap_or("").to_string();
        if !Path::new(&root).is_absolute()
            || !std::fs::metadata(&root)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        {
            return Err(MessageError::bad("Local second-brain directory required"));
        }
        if !regex_is_match(r"^[^\s,:]+:[^\s,:]+$", &profile) {
            return Err(MessageError::bad("Select a stable corpId:userId profile"));
        }
        if query.chars().count() > 200 {
            return Err(MessageError::bad("Group query too long"));
        }
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, "dingtalk", &root)?;
        }
        dingtalk_groups(&root, &profile, &query).await
    }

    /// GET /messaging/status.
    pub(crate) fn http_status(&self) -> Value {
        json!({ "bindings": self.list_views() })
    }

    /// POST /messaging/start — optional `switchFromRoot`, channel claim, then
    /// `start()`; unknown ids fail before any state changes.
    pub(crate) async fn http_start(self: &Arc<Self>, input: &Value) -> Result<Value, MessageError> {
        let id = input["id"].as_str().unwrap_or("").to_string();
        let (channel, root) = {
            let inner = self.lock();
            match inner.runs.get(&id) {
                Some(run) => (run.binding.channel.clone(), run.binding.root.clone()),
                None => return Err(MessageError::bad("Messaging configuration not found")),
            }
        };
        if let Some(expected) = input.get("switchFromRoot") {
            let expected = match expected.as_str() {
                Some(text) => text.to_string(),
                None => format!("{expected}"),
            };
            self.switch_channel(&channel, &root, &expected).await?;
        }
        {
            let mut inner = self.lock();
            self.claim_channel(&mut inner, &channel, &root)?;
        }
        self.start(&id).await?;
        self.view(&id)
    }

    /// POST /messaging/stop — `stop()` is a no-op for unknown ids and the
    /// following view lookup turns that into the 400 Node reports.
    pub(crate) fn http_stop(&self, input: &Value) -> Result<Value, MessageError> {
        let id = input["id"].as_str().unwrap_or("").to_string();
        self.stop(&id);
        self.view(&id)
    }
}
/// Node reads the whole body before `JSON.parse(data || '{}')`: an empty body
/// is `{}` and anything past 128 KiB fails with `Request too large`.
pub(crate) async fn read_messaging_body(req: Request) -> Result<Value, MessageError> {
    let bytes = match axum::body::to_bytes(req.into_body(), 131_072).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(MessageError::bad("Request too large")),
    };
    if bytes.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(&bytes).map_err(|error| MessageError::bad(error.to_string()))
}

/// Every messaging response carries no-store and no-referrer like the Node
/// handler's top-of-function headers.
pub(crate) fn messaging_json(status: u16, body: &Value) -> Response {
    let text = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from(text))
        .expect("valid JSON response")
}

/// Node's catch: conflicts keep their structured payload at 409, everything
/// else reports `{ error }` at the mapped status without a code field.
pub(crate) fn messaging_result(result: Result<Value, MessageError>) -> Response {
    match result {
        Ok(value) => messaging_json(200, &value),
        Err(error) => {
            if let Some(conflict) = error.conflict {
                messaging_json(409, &conflict)
            } else {
                messaging_json(error.status, &json!({ "error": error.message }))
            }
        }
    }
}

pub(crate) fn messaging_status_frame(bindings: Vec<Value>) -> Result<Bytes, std::io::Error> {
    let body = serde_json::to_string(&json!({ "bindings": bindings }))
        .unwrap_or_else(|_| "{\"bindings\":[]}".to_string());
    Ok(Bytes::from(format!("event: status\ndata: {body}\n\n")))
}

/// GET /messaging/events — an initial `status` frame, a frame per persistence
/// write (the watch channel bumps on every persist) and a 25s comment
/// heartbeat; the fan-out task exits once the client disconnects.
pub(crate) async fn messaging_events(service: Arc<MessagingService>) -> Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    if tx
        .send(messaging_status_frame(service.list_views()))
        .is_ok()
    {
        let mut watcher = service.subscribe_events();
        let pump = Arc::clone(&service);
        tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(25));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat.tick().await;
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        if tx.send(Ok(Bytes::from_static(b": messaging\n\n"))).is_err() {
                            break;
                        }
                    }
                    changed = watcher.changed() => {
                        if changed.is_err()
                            || tx
                                .send(messaging_status_frame(pump.list_views()))
                                .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(
            tokio_stream::wrappers::UnboundedReceiverStream::new(rx),
        ))
        .expect("messaging event stream")
}

/// Route table copy of `handleMessagingHttp`. Bodies are read inside each POST
/// arm so unknown POST routes fail with 404 without consuming the body.
pub async fn handle_messaging_http(
    service: Arc<MessagingService>,
    method: &str,
    path: &str,
    query: &std::collections::BTreeMap<String, String>,
    req: Request,
) -> Response {
    match (method, path) {
        ("GET", "/messaging/events") => messaging_events(service).await,
        ("GET", "/messaging/config") => {
            let root = query.get("root").cloned().unwrap_or_default();
            messaging_result(service.http_config(&root))
        }
        ("POST", "/messaging/config") => match read_messaging_body(req).await {
            Ok(body) => messaging_result(service.http_configure(&body)),
            Err(error) => messaging_result(Err(error)),
        },
        ("POST", "/messaging/profiles") => match read_messaging_body(req).await {
            Ok(body) => messaging_result(service.http_profiles(&body).await),
            Err(error) => messaging_result(Err(error)),
        },
        ("POST", "/messaging/groups") => match read_messaging_body(req).await {
            Ok(body) => messaging_result(service.http_groups(&body).await),
            Err(error) => messaging_result(Err(error)),
        },
        ("GET", "/messaging/status") => messaging_result(Ok(service.http_status())),
        ("POST", "/messaging/start") => match read_messaging_body(req).await {
            Ok(body) => messaging_result(service.http_start(&body).await),
            Err(error) => messaging_result(Err(error)),
        },
        ("POST", "/messaging/stop") => match read_messaging_body(req).await {
            Ok(body) => messaging_result(service.http_stop(&body)),
            Err(error) => messaging_result(Err(error)),
        },
        _ => messaging_json(404, &json!({ "error": "Messaging route not found" })),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
