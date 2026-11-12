//! Revocable, owner-scoped AIChat context and native MCP stdio bridge.
//! Browser credentials never enter CLI environments or persisted snapshots.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const MAX_BODY: usize = 2_000_000;
const MAX_RESULT: usize = 12_000_000;
type StreamSender = mpsc::Sender<Result<String, Infallible>>;

struct Pending {
    page: String,
    generation: String,
    sender: oneshot::Sender<Value>,
    native_request: Option<String>,
}

struct Binding {
    page: String,
    generation: String,
    instructions: String,
    revision: String,
    tools: Vec<Value>,
    capability: String,
    binding_epoch: String,
    stream: Option<(String, StreamSender)>,
    pending: HashMap<String, Pending>,
    mode: String,
    spaces: Vec<Value>,
    primary: String,
    username: String,
    reads: HashMap<String, String>,
    cancelled_requests: std::collections::HashSet<String>,
}

pub struct ContextManager {
    bindings: Mutex<HashMap<(String, String), Binding>>,
    overlay_directory: PathBuf,
}

impl Default for ContextManager {
    fn default() -> Self {
        Self {
            bindings: Mutex::new(HashMap::new()),
            overlay_directory: crate::config::mcp_home_dir().join("agent-git-drafts"),
        }
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn tool_error(message: &str) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":message}]})
}

fn tool_result(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}]})
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn reply(status: StatusCode, value: Value) -> Response {
    let mut response = crate::http::json_response(status, &value);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

fn failed(message: String) -> Response {
    reply(StatusCode::BAD_REQUEST, json!({"error":message}))
}

fn disconnect(binding: &mut Binding) {
    binding.stream = None;
    for (_, pending) in binding.pending.drain() {
        let _ = pending.sender.send(tool_error("web_result_unknown: page disconnected after dispatch; inspect any mutation before retrying"));
    }
}

fn readable_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "list_dir" | "search_files" | "web_search" | "fetch_url" | "grep_files"
    )
}

fn workspace_tool() -> Value {
    json!({"name":"workspace_file","description":"File operations in explicitly granted local AIChat spaces. Remote and cloud spaces require the original online page's read_file/list_dir tools; offline cloud/Git file execution is not available in this runtime.","execution":"backend","online":true,"inputSchema":{"type":"object","properties":{"operation":{"type":"string","enum":["list","search","read","write","replace","delete","rename"]},"path":{"type":"string"},"content":{"type":"string"},"oldString":{"type":"string"},"newString":{"type":"string"},"newPath":{"type":"string"},"query":{"type":"string"},"expectedContent":{"type":["string","null"]},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}},"required":["operation","path"],"additionalProperties":false}})
}

impl ContextManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        owner: &str,
        conversation: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let page = text(input, "pageId");
        let generation = text(input, "generation");
        if !identifier(conversation) || !identifier(page) || !identifier(generation) {
            return Err("Invalid page binding".into());
        }
        let instructions = input
            .get("instructions")
            .and_then(Value::as_str)
            .ok_or("Invalid context")?;
        let revision = input
            .get("revision")
            .and_then(Value::as_str)
            .ok_or("Invalid context revision")?;
        if instructions.len() > 180_000 || revision.len() > 200 {
            return Err("Context too large".into());
        }
        let tools = input
            .get("tools")
            .and_then(Value::as_array)
            .ok_or("Invalid tools")?;
        if tools.len() > 200 {
            return Err("Too many tools".into());
        }
        let mut names = std::collections::HashSet::new();
        let mut definitions = Vec::new();
        for tool in tools {
            let name = text(tool, "name");
            if name.is_empty()
                || name.len() > 160
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                || !names.insert(name)
            {
                return Err("Invalid or duplicate tool name".into());
            }
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .ok_or("Invalid tool description")?;
            if description.len() > 16_000 || !tool["inputSchema"].is_object() {
                return Err("Invalid tool definition".into());
            }
            definitions.push(json!({"name":name,"description":description,"inputSchema":tool["inputSchema"],"execution":"web"}));
        }
        let mut bindings = self.bindings.lock().unwrap();
        if bindings.len() >= 1000 && !bindings.contains_key(&(owner.into(), conversation.into())) {
            return Err("Context limit reached".into());
        }
        let binding = bindings
            .entry((owner.into(), conversation.into()))
            .or_insert_with(|| Binding {
                page: page.into(),
                generation: generation.into(),
                instructions: String::new(),
                revision: String::new(),
                tools: vec![],
                capability: Uuid::new_v4().to_string(),
                binding_epoch: Uuid::new_v4().to_string(),
                stream: None,
                pending: HashMap::new(),
                mode: "craft".into(),
                spaces: vec![],
                primary: String::new(),
                username: String::new(),
                reads: HashMap::new(),
                cancelled_requests: std::collections::HashSet::new(),
            });
        if binding.page != page || binding.generation != generation {
            if binding
                .stream
                .as_ref()
                .is_some_and(|(_, sender)| !sender.is_closed())
            {
                return Err(
                    "Conversation tools are owned by another live page; close that page first"
                        .into(),
                );
            }
            disconnect(binding);
            binding.capability = Uuid::new_v4().to_string();
            binding.binding_epoch = Uuid::new_v4().to_string();
            // A replacement browser must explicitly re-authorize local roots.
            binding.spaces.clear();
            binding.reads.clear();
            binding.cancelled_requests.clear();
            binding.primary.clear();
            binding.username.clear();
        }
        binding.page = page.into();
        binding.generation = generation.into();
        binding.instructions = instructions.into();
        binding.revision = revision.into();
        binding.tools = definitions;
        Ok(json!({"version":1,"revision":revision}))
    }

    pub fn credentials(
        &self,
        owner: &str,
        conversation: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let username = text(input, "username");
        if username.is_empty()
            || username.len() > 160
            || !username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err("Invalid workspace grant".into());
        }
        let base = input
            .get("baseURL")
            .and_then(Value::as_str)
            .unwrap_or("https://api.keepwork.com/core/v0");
        let url = url::Url::parse(base).map_err(|_| "Invalid Keepwork API origin")?;
        if url.scheme() != "https"
            || !matches!(url.host_str(), Some("api.keepwork.com" | "keepwork.com"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port().is_some_and(|p| p != 443)
        {
            return Err("Invalid Keepwork API origin".into());
        }
        let spaces = input
            .get("spaces")
            .and_then(Value::as_array)
            .ok_or("Invalid workspace descriptors")?;
        if spaces.len() > 100 {
            return Err("Too many spaces".into());
        }
        let mut safe = Vec::new();
        for space in spaces {
            if text(space, "id").is_empty()
                || text(space, "id").len() > 200
                || !matches!(
                    text(space, "type"),
                    "local" | "project" | "git" | "url" | "cdn"
                )
                || !space["aliases"].is_array()
            {
                return Err("Invalid workspace descriptor".into());
            }
            let mut row = serde_json::Map::new();
            for key in [
                "id",
                "type",
                "name",
                "mountPrefix",
                "root",
                "workspace",
                "sitePath",
                "folderPath",
                "baseUrl",
                "provider",
                "host",
                "owner",
                "repo",
                "branch",
                "subPath",
                "sharePermission",
            ] {
                if let Some(value) = space.get(key).and_then(Value::as_str) {
                    if value.len() > 4096 {
                        return Err("Workspace descriptor too large".into());
                    }
                    row.insert(key.into(), json!(value));
                }
            }
            let aliases: Vec<_> = space["aliases"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .filter(|a| !a.is_empty() && a.len() <= 200 && !a.contains('/'))
                .take(200)
                .map(str::to_owned)
                .collect();
            row.insert("aliases".into(), json!(aliases));
            if text(space, "type") == "local" {
                let root = Path::new(text(space, "root"));
                if !root.is_absolute() || !root.is_dir() {
                    return Err("Existing absolute local root required".into());
                }
                row.insert(
                    "root".into(),
                    json!(root
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()),
                );
            }
            row.insert(
                "backendAvailable".into(),
                json!(text(space, "type") == "local"),
            );
            safe.push(Value::Object(row));
        }
        let mut bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get_mut(&(owner.into(), conversation.into()))
            .ok_or("Register context first")?;
        binding.spaces = safe;
        binding.primary = text(input, "primaryId").into();
        binding.username = username.into();
        // This slice uses only explicit local grants. Do not retain cloud or Git credentials.
        Ok(
            json!({"ok":true,"backendWorkspaceTypes":["local"],"remoteWorkspace":"online-page-required"}),
        )
    }

    pub fn context(&self, owner: &str, conversation: &str) -> Result<(String, String), String> {
        let bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get(&(owner.into(), conversation.into()))
            .ok_or("Reconnect AIChat to restore tool context")?;
        let instructions = format!("{}\n\nRuntime capability boundary: background workspace_file supports explicitly granted LOCAL spaces only. Remote/cloud/Git spaces require the original online AIChat page's discovered read_file/list_dir and editing tools. Never treat the temporary CLI cwd as a cloud Primary workspace. If the original page is offline, report the remote operation unavailable; do not improvise paths or retry uncertain mutations.\n",binding.instructions);
        Ok((instructions, binding.revision.clone()))
    }

    pub fn set_mode(&self, owner: &str, conversation: &str, mode: &str) {
        if let Some(binding) = self
            .bindings
            .lock()
            .unwrap()
            .get_mut(&(owner.into(), conversation.into()))
        {
            binding.mode = mode.into();
        }
    }

    pub fn snapshot(&self, owner: &str, conversation: &str) -> Value {
        let bindings = self.bindings.lock().unwrap();
        let Some(binding) = bindings.get(&(owner.into(), conversation.into())) else {
            return json!({"version":1,"online":false,"reconnectRequired":true});
        };
        let online = binding.stream.as_ref().is_some_and(|(_, s)| !s.is_closed());
        let mut capabilities: Vec<Value> = binding
            .tools
            .iter()
            .filter(|tool| binding.mode != "plan" || readable_tool(text(tool, "name")))
            .map(|tool| json!({"name":tool["name"],"execution":"web","online":online}))
            .collect();
        if !binding.spaces.is_empty() {
            capabilities.push(json!({"name":"workspace_file","execution":"backend","online":true}));
        }
        json!({"version":1,"revision":binding.revision,"pageId":binding.page,"generation":binding.generation,"online":online,"capabilities":capabilities,"workspace":{"authorized":!binding.username.is_empty(),"primaryId":binding.primary,"spaces":binding.spaces,"backendWorkspaceTypes":["local"]}})
    }

    pub fn descriptor(&self, owner: &str, conversation: &str, port: u16) -> Result<Value, String> {
        self.descriptor_with_marker(owner, conversation, port)
            .map(|(descriptor, _)| descriptor)
    }

    /// Page identity plus a non-authorizing incarnation ID. Never a bearer.
    pub fn marker(&self, owner: &str, conversation: &str) -> Result<String, String> {
        let bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get(&(owner.into(), conversation.into()))
            .ok_or("Reconnect AIChat to restore tool context")?;
        Ok(format!(
            "{}\0{}\0{}",
            binding.page, binding.generation, binding.binding_epoch
        ))
    }

    /// Capture descriptor and identity together, so replacement cannot pair a
    /// new identity with an old native capability.
    pub fn descriptor_with_marker(
        &self,
        owner: &str,
        conversation: &str,
        port: u16,
    ) -> Result<(Value, String), String> {
        let bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get(&(owner.into(), conversation.into()))
            .ok_or("Register AIChat context first")?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let marker = format!(
            "{}\0{}\0{}",
            binding.page, binding.generation, binding.binding_epoch
        );
        Ok((
            json!({"name":"keepwork_aichat","command":executable,"args":["--agent-tool-proxy",format!("http://127.0.0.1:{port}/agents/tool-proxy")],"env":[{"name":"KEEPWORK_AICHAT_CAPABILITY","value":binding.capability}]}),
            marker,
        ))
    }

    pub fn cancel(&self, owner: &str, conversation: &str) {
        if let Some(binding) = self
            .bindings
            .lock()
            .unwrap()
            .get_mut(&(owner.into(), conversation.into()))
        {
            for (call_id, pending) in binding.pending.drain() {
                if let Some((_, stream)) = &binding.stream {
                    let _ = stream.try_send(Ok(format!("event: cancel\ndata: {}\n\n",json!({"callId":call_id,"pageId":binding.page,"generation":binding.generation}))));
                }
                let _ = pending.sender.send(tool_error("web_result_unknown: CLI cancelled after dispatch; inspect any mutation before retrying"));
            }
        }
    }

    pub fn revoke(&self, owner: &str) {
        self.bindings
            .lock()
            .unwrap()
            .retain(|(stored, _), binding| {
                if stored == owner {
                    disconnect(binding);
                    false
                } else {
                    true
                }
            });
    }

    pub fn close(&self) {
        let mut bindings = self.bindings.lock().unwrap();
        for binding in bindings.values_mut() {
            disconnect(binding);
        }
        bindings.clear();
    }

    #[cfg(test)]
    fn tools(&self, owner: &str, conversation: &str) -> Result<Value, String> {
        self.tools_scoped(owner, conversation, None)
    }

    fn tools_scoped(
        &self,
        owner: &str,
        conversation: &str,
        capability: Option<&str>,
    ) -> Result<Value, String> {
        let bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get(&(owner.into(), conversation.into()))
            .ok_or("Context expired")?;
        if capability.is_some_and(|capability| capability != binding.capability) {
            return Err("Tool capability expired".into());
        }
        let online = binding.stream.as_ref().is_some_and(|(_, s)| !s.is_closed());
        let mut tools = binding
            .tools
            .iter()
            .filter(|tool| {
                text(tool, "name") != "workspace_file"
                    && (binding.mode != "plan" || readable_tool(text(tool, "name")))
            })
            .cloned()
            .map(|mut tool| {
                tool["online"] = json!(online);
                tool
            })
            .collect::<Vec<_>>();
        if !binding.spaces.is_empty() {
            tools.insert(0, workspace_tool());
        }
        Ok(json!({"revision":binding.revision,"tools":tools}))
    }

    #[cfg(test)]
    async fn invoke(&self, owner: &str, conversation: &str, name: &str, args: &Value) -> Value {
        self.invoke_scoped(owner, conversation, name, args, None, None)
            .await
    }

    async fn invoke_scoped(
        &self,
        owner: &str,
        conversation: &str,
        name: &str,
        args: &Value,
        capability: Option<&str>,
        native_request: Option<String>,
    ) -> Value {
        if name == "workspace_file" {
            return match self.local_file_scoped(
                owner,
                conversation,
                args,
                capability,
                native_request.as_deref(),
            ) {
                Ok(value) => tool_result(value),
                Err(error) => tool_error(&error),
            };
        }
        let call_id = Uuid::new_v4().to_string();
        let receiver = {
            let mut bindings = self.bindings.lock().unwrap();
            let Some(binding) = bindings.get_mut(&(owner.into(), conversation.into())) else {
                return tool_error("AIChat context expired");
            };
            if capability.is_some_and(|capability| capability != binding.capability) {
                return tool_error("Tool capability expired; reconnect the original page");
            }
            if native_request
                .as_ref()
                .is_some_and(|id| binding.cancelled_requests.contains(id))
            {
                return tool_error("Tool call cancelled before dispatch");
            }
            if binding.mode == "plan" && !readable_tool(name) {
                return tool_error("Tool is unavailable in Plan mode");
            }
            let Some(definition) = binding.tools.iter().find(|tool| text(tool, "name") == name)
            else {
                return tool_error("Tool not registered for this conversation");
            };
            if let Err(error) = validate_arguments(&definition["inputSchema"], args) {
                return tool_error(&error);
            }
            let Some((_, stream)) = &binding.stream else {
                return tool_error("web_offline: reopen the original AIChat conversation and tool");
            };
            if binding.pending.len() >= 16 {
                return tool_error("Too many pending webpage calls");
            }
            let (sender, receiver) = oneshot::channel();
            let event = json!({"callId":call_id,"pageId":binding.page,"generation":binding.generation,"conversationId":conversation,"name":name,"arguments":args});
            if stream
                .try_send(Ok(format!("event: tool\ndata: {event}\n\n")))
                .is_err()
            {
                disconnect(binding);
                return tool_error("web_offline: original page disconnected before dispatch");
            }
            binding.pending.insert(
                call_id.clone(),
                Pending {
                    page: binding.page.clone(),
                    generation: binding.generation.clone(),
                    sender,
                    native_request,
                },
            );
            receiver
        };
        let result = tokio::time::timeout(Duration::from_secs(120), receiver).await;
        self.bindings
            .lock()
            .unwrap()
            .get_mut(&(owner.into(), conversation.into()))
            .map(|b| b.pending.remove(&call_id));
        match result { Ok(Ok(value))=>value,_=>tool_error("web_result_unknown: tool disconnected or timed out after dispatch; do not repeat automatically") }
    }

    fn result(&self, owner: &str, conversation: &str, input: &Value) -> Result<Value, String> {
        validate_result(&input["result"])?;
        let mut bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get_mut(&(owner.into(), conversation.into()))
            .ok_or("Context expired")?;
        let call_id = text(input, "callId");
        let pending = binding.pending.get(call_id).ok_or("Expired tool call")?;
        if pending.page != text(input, "pageId") || pending.generation != text(input, "generation")
        {
            return Err("Stale tool result".into());
        }
        if let Some(pending) = binding.pending.remove(call_id) {
            let _ = pending.sender.send(input["result"].clone());
        }
        Ok(json!({"ok":true}))
    }

    fn stream(
        self: &Arc<Self>,
        owner: &str,
        conversation: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Response, String> {
        let (sender, receiver) = mpsc::channel(32);
        let stream_id = Uuid::new_v4().to_string();
        {
            let mut bindings = self.bindings.lock().unwrap();
            let binding = bindings
                .get_mut(&(owner.into(), conversation.into()))
                .ok_or("Register context first")?;
            if query.get("pageId").map(String::as_str) != Some(binding.page.as_str())
                || query.get("generation").map(String::as_str) != Some(binding.generation.as_str())
            {
                return Err("Stale page binding".into());
            }
            if binding.stream.as_ref().is_some_and(|(_, s)| !s.is_closed()) {
                return Err("Tool stream already connected".into());
            }
            let _ = sender.try_send(Ok("event: ready\ndata: {}\n\n".into()));
            binding.stream = Some((stream_id.clone(), sender));
        }
        let guard = StreamGuard {
            manager: Arc::clone(self),
            owner: owner.into(),
            conversation: conversation.into(),
            stream_id,
        };
        let stream = futures_util::stream::unfold(
            (receiver, guard),
            |(mut receiver, guard)| async move {
                tokio::select! {
                    item = receiver.recv() => item.map(|item|(item,(receiver,guard))),
                    _ = tokio::time::sleep(Duration::from_secs(20)) => Some((Ok(": heartbeat\n\n".to_string()),(receiver,guard))),
                }
            },
        );
        Ok(Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Accel-Buffering", "no")
            .body(Body::from_stream(stream))
            .unwrap())
    }

    pub async fn handle(
        self: Arc<Self>,
        owner: &str,
        method: &str,
        path: &str,
        query: &BTreeMap<String, String>,
        req: Request,
    ) -> Response {
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        let Some(conversation) = parts.get(2) else {
            return failed("Conversation required".into());
        };
        let action = parts.get(3).copied().unwrap_or("");
        if method == "GET" && action == "events" {
            return self
                .stream(owner, conversation, query)
                .unwrap_or_else(failed);
        }
        if method != "POST" {
            return reply(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"error":"Method not allowed"}),
            );
        }
        let input = match read_json(
            req,
            if action == "result" {
                MAX_RESULT + 500_000
            } else {
                MAX_BODY
            },
        )
        .await
        {
            Ok(value) => value,
            Err(error) => return failed(error),
        };
        let result = match (*conversation, action) {
            ("revoke", "") => {
                self.revoke(owner);
                Ok(json!({"ok":true}))
            }
            (_, "") => self.register(owner, conversation, &input),
            (_, "credentials") => self.credentials(owner, conversation, &input),
            (_, "result") => self.result(owner, conversation, &input),
            (_, "file") => self.local_file(owner, conversation, &input),
            (_, "overlay") => self.overlay(owner, conversation, &input),
            _ => {
                return reply(
                    StatusCode::NOT_FOUND,
                    json!({"error":"Unknown context operation"}),
                )
            }
        };
        match result {
            Ok(value) => reply(StatusCode::OK, value),
            Err(error) => failed(error),
        }
    }

    pub fn handle_proxy_boxed(
        self: Arc<Self>,
        req: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send>> {
        Box::pin(self.handle_proxy(req))
    }

    pub async fn handle_proxy(self: Arc<Self>, req: Request) -> Response {
        if req.method() != "POST" || req.headers().contains_key(header::ORIGIN) {
            return reply(
                StatusCode::FORBIDDEN,
                json!({"error":"Tool proxy access rejected"}),
            );
        }
        let authorization = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let identity = {
            let bindings = self.bindings.lock().unwrap();
            bindings
                .iter()
                .find(|(_, binding)| authorization == format!("Bearer {}", binding.capability))
                .map(|(key, _)| key.clone())
        };
        let Some((owner, conversation)) = identity else {
            return reply(
                StatusCode::FORBIDDEN,
                json!({"error":"Tool capability expired"}),
            );
        };
        let input = match read_json(req, MAX_BODY).await {
            Ok(value) => value,
            Err(error) => return failed(error),
        };
        let result = match text(&input, "method") {
            "tools/list" => {
                json!({"tools":[{"name":"aichat_list_tools","description":"Discover only this bound AIChat conversation's current tools, schemas and online state.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},{"name":"aichat_call_tool","description":"Call one discovered conversation tool. Web tools require the original page online. Never automatically repeat an uncertain mutation.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"}},"required":["name","arguments"],"additionalProperties":false}}]})
            }
            "tools/call" if text(&input["params"], "name") == "aichat_list_tools" => {
                match self.tools_scoped(
                    &owner,
                    &conversation,
                    authorization.strip_prefix("Bearer "),
                ) {
                    Ok(value) => tool_result(value),
                    Err(error) => tool_error(&error),
                }
            }
            "tools/call" if text(&input["params"], "name") == "aichat_call_tool" => {
                let args = &input["params"]["arguments"];
                if !args["arguments"].is_object() {
                    tool_error("Tool arguments must be an object")
                } else {
                    self.invoke_scoped(
                        &owner,
                        &conversation,
                        text(args, "name"),
                        &args["arguments"],
                        authorization.strip_prefix("Bearer "),
                        input.get("_proxyRequestId").map(Value::to_string),
                    )
                    .await
                }
            }
            "cancel" => match self.cancel_request(
                &owner,
                &conversation,
                authorization.strip_prefix("Bearer ").unwrap_or(""),
                &input["requestId"],
            ) {
                Ok(value) => value,
                Err(error) => tool_error(&error),
            },
            _ => tool_error("Unknown tool bridge operation"),
        };
        reply(StatusCode::OK, result)
    }

    fn cancel_request(
        &self,
        owner: &str,
        conversation: &str,
        capability: &str,
        request_id: &Value,
    ) -> Result<Value, String> {
        if !request_id.is_string() && !request_id.is_number() {
            return Err("Invalid cancellation request".into());
        }
        let mut bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get_mut(&(owner.into(), conversation.into()))
            .ok_or("Context expired")?;
        if capability != binding.capability {
            return Err("Tool capability expired".into());
        }
        if binding.cancelled_requests.len() >= 256 {
            binding.cancelled_requests.clear();
        }
        let request_id = request_id.to_string();
        binding.cancelled_requests.insert(request_id.clone());
        let pending_ids = binding
            .pending
            .iter()
            .filter(|(_, pending)| pending.native_request.as_ref() == Some(&request_id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for call_id in pending_ids {
            if let Some((_, stream)) = &binding.stream {
                let _ = stream.try_send(Ok(format!(
                    "event: cancel\ndata: {}\n\n",
                    json!({"callId":call_id,"pageId":binding.page,"generation":binding.generation})
                )));
            }
            if let Some(pending) = binding.pending.remove(&call_id) {
                let _=pending.sender.send(tool_error("web_result_unknown: native caller cancelled after dispatch; inspect any mutation before retrying"));
            }
        }
        Ok(json!({"ok":true}))
    }

    fn overlay(&self, owner: &str, conversation: &str, input: &Value) -> Result<Value, String> {
        // Preserve browser Git drafts before it acknowledges migration. This is
        // storage only: remote comparison/commit never becomes a fake success.
        let bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get(&(owner.into(), conversation.into()))
            .ok_or("Workspace authorization expired")?;
        let space = binding
            .spaces
            .iter()
            .find(|space| {
                text(space, "id") == text(input, "spaceId") && text(space, "type") == "git"
            })
            .ok_or("Git space unavailable")?;
        let key = format!(
            "{owner}:{}:{}/{}/{}:{}:{}",
            binding.username,
            text(space, "host"),
            text(space, "owner"),
            text(space, "repo"),
            text(space, "branch"),
            text(space, "subPath")
        );
        let directory = self.overlay_directory.clone();
        let path = directory.join(format!("{}.json", digest(&key)));
        let mut overlay = match std::fs::read_to_string(&path) {
            Ok(raw) => {
                if raw.len() > MAX_RESULT {
                    return Err("Git draft store too large".into());
                }
                let value: Value = serde_json::from_str(&raw)
                    .map_err(|_| "Git draft store is unreadable; original data was preserved")?;
                if !value["files"].is_object() || !value["revision"].is_u64() {
                    return Err("Invalid Git draft store; original data was preserved".into());
                }
                value
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                json!({"revision":0,"files":{}})
            }
            Err(error) => return Err(error.to_string()),
        };
        match text(input,"operation") {
            "get" => return Ok(overlay),
            "import" => {
                let files = input["files"].as_object().ok_or("Invalid Git draft import")?;
                if files.len() > 1000 {return Err("Too many Git draft files".into());}
                if text(space,"sharePermission") == "read" && !files.is_empty() {return Err("Workspace is read-only".into());}
                for (name,entry) in files {
                    let file = relative(name)?;
                    let content = entry["content"].as_str().ok_or("Only text Git drafts can be transferred")?;
                    if file.is_empty() || content.len() > MAX_BODY {return Err("Invalid Git draft file".into());}
                    if let Some(existing) = overlay["files"].get(&file) {
                        if existing["content"] != entry["content"] || existing["deleted"].as_bool().unwrap_or(false) != entry["deleted"].as_bool().unwrap_or(false) {return Err("Git draft conflict; preserve both drafts before connecting".into());}
                    } else {
                        let mut draft = json!({"content":content,"updatedAt":entry["updatedAt"].as_i64().unwrap_or_else(||chrono::Utc::now().timestamp_millis()),"baseHash":entry["baseHash"].as_str().unwrap_or("rust-unverified-remote-base"),"remoteBaseUnknown":true});
                        if entry["deleted"] == true {draft["deleted"] = json!(true);}
                        overlay["files"][&file] = draft;
                    }
                }
            },
            "drop" => {
                if input["revision"] != overlay["revision"] {return Err("Git draft changed; refresh before discarding".into());}
                if text(input,"path").is_empty() {overlay["files"] = json!({});} else {overlay["files"].as_object_mut().unwrap().remove(&relative(text(input,"path"))?);}
            },
            "ack" => {
                let files = input["files"].as_object().ok_or("Invalid Git acknowledgement")?;
                for (name,entry) in files {
                    let matches = overlay["files"].get(name).is_some_and(|current| current["content"] == entry["content"] && current["updatedAt"] == entry["updatedAt"] && current["deleted"].as_bool().unwrap_or(false) == entry["deleted"].as_bool().unwrap_or(false));
                    if matches {overlay["files"].as_object_mut().unwrap().remove(name);}
                }
            },
            "check" | "stageValidatedDeck" => return Err("UNSUPPORTED_FEATURE: Rust cannot verify the remote Git base or stage protected decks; keep the draft and use the original online page".into()),
            _ => return Err("Unknown overlay operation".into()),
        }
        overlay["revision"] = json!(overlay["revision"].as_u64().unwrap_or(0).saturating_add(1));
        let raw = serde_json::to_vec(&overlay).map_err(|e| e.to_string())?;
        if raw.len() > MAX_RESULT {
            return Err("Git draft store too large".into());
        }
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary).map_err(|e| e.to_string())?;
        output
            .write_all(&raw)
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        Ok(overlay)
    }

    fn local_file(&self, owner: &str, conversation: &str, args: &Value) -> Result<Value, String> {
        self.local_file_scoped(owner, conversation, args, None, None)
    }

    fn local_file_scoped(
        &self,
        owner: &str,
        conversation: &str,
        args: &Value,
        capability: Option<&str>,
        native_request: Option<&str>,
    ) -> Result<Value, String> {
        let mut bindings = self.bindings.lock().unwrap();
        let binding = bindings
            .get_mut(&(owner.into(), conversation.into()))
            .ok_or("Workspace authorization expired; reconnect AIChat")?;
        if capability.is_some_and(|capability| capability != binding.capability) {
            return Err("Tool capability expired; reconnect the original page".into());
        }
        if native_request.is_some_and(|id| binding.cancelled_requests.contains(id)) {
            return Err("Tool call cancelled before dispatch".into());
        }
        let operation = text(args, "operation");
        let mutation = matches!(operation, "write" | "replace" | "delete" | "rename");
        if binding.mode != "craft" && mutation {
            return Err("Background workspace mutation requires Craft mode; use the original online page for an approved edit".into());
        }
        let (space, file) = route_space(binding, text(args, "path"))?;
        if text(&space, "type") != "local" {
            return Err("UNSUPPORTED_FEATURE: background remote/cloud/Git files are unavailable; use the original online page's discovered file tools".into());
        }
        if mutation && text(&space, "sharePermission") == "read" {
            return Err("Workspace is read-only".into());
        }
        if mutation
            && (file.starts_with("whiteboard/lessons/")
                || [
                    "whiteboard/qa-artifacts.json",
                    "whiteboard/teach-artifacts.json",
                    "whiteboard/scenario-artifacts.json",
                ]
                .contains(&file.as_str()))
        {
            return Err("Use online saveWhiteboardDeck for protected whiteboard files".into());
        }
        let root = PathBuf::from(text(&space, "root"));
        let target = confined(&root, &file, mutation)?;
        if matches!(operation, "list" | "search") {
            let mut queue = std::collections::VecDeque::from([(target, file.clone())]);
            let mut result = Vec::new();
            let mut scanned = 0;
            while let Some((directory, prefix)) = queue.pop_front() {
                let mut entries = std::fs::read_dir(&directory)
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .collect::<Vec<_>>();
                entries.sort_by_key(|e| e.file_name());
                for entry in entries {
                    scanned += 1;
                    if scanned > 1000 {
                        break;
                    }
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let relative = if prefix.is_empty() {
                        name.clone()
                    } else {
                        format!("{prefix}/{name}")
                    };
                    let kind = entry.file_type().map_err(|e| e.to_string())?;
                    if operation == "search" {
                        if kind.is_dir() && name != ".git" && name != "node_modules" {
                            queue.push_back((entry.path(), relative));
                        } else if kind.is_file()
                            && relative
                                .to_lowercase()
                                .contains(&text(args, "query").to_lowercase())
                            && result.len() < 200
                        {
                            result.push(relative);
                        }
                    } else {
                        result.push(format!("{name}{}", if kind.is_dir() { "/" } else { "" }));
                    }
                }
                if operation == "list" || scanned > 1000 {
                    break;
                }
            }
            return if operation == "search" {
                Ok(json!({"matches":result,"truncated":scanned>1000||!queue.is_empty()}))
            } else {
                Ok(json!(result))
            };
        }
        if file.is_empty() {
            return Err("File path required".into());
        }
        let current = read_local(&target)?;
        if let Some(expected) = args.get("expectedContent") {
            if expected != &json!(current) {
                return Err("File changed; read again before editing".into());
            }
        }
        let read_key = format!("{}:{file}", text(&space, "id"));
        if mutation && operation != "replace" && args.get("expectedContent").is_none() {
            if let Some(content) = &current {
                if binding.reads.get(&read_key) != Some(&digest(content)) {
                    return Err(
                        "File changed or not read in this session; read before editing".into(),
                    );
                }
            }
        }
        let result = match operation {
            "read" => {
                let content = current.ok_or("File not found")?;
                binding.reads.insert(read_key.clone(), digest(&content));
                let lines = content.split('\n').collect::<Vec<_>>();
                let start = args["startLine"].as_u64().unwrap_or(1).max(1) as usize;
                let end = (args["endLine"].as_u64().unwrap_or((start + 199) as u64) as usize)
                    .min(lines.len())
                    .min(start + 999);
                let shown = if start > lines.len() || end < start {
                    String::new()
                } else {
                    lines[start - 1..end].join("\n")
                };
                return Ok(
                    json!({"content":shown,"startLine":start,"endLine":end,"totalLines":lines.len()}),
                );
            }
            "write" | "replace" => {
                let content = if operation == "write" {
                    args["content"]
                        .as_str()
                        .ok_or("content required")?
                        .to_string()
                } else {
                    let current = current.ok_or("File not found")?;
                    let old = text(args, "oldString");
                    let new = args["newString"].as_str().ok_or("newString required")?;
                    if old.is_empty() || current.matches(old).count() != 1 {
                        return Err("oldString must match exactly once".into());
                    }
                    current.replacen(old, new, 1)
                };
                if content.len() > MAX_BODY {
                    return Err("File too large".into());
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                // Recheck after creating parents; do not follow a newly replaced root/link.
                let verified = confined(&root, &file, true)?;
                std::fs::write(verified, content.as_bytes()).map_err(|e| e.to_string())?;
                binding.reads.insert(read_key.clone(), digest(&content));
                json!({"written":true,"staged":false})
            }
            "delete" => {
                if current.is_none() {
                    return Err("File not found".into());
                }
                std::fs::remove_file(target).map_err(|e| e.to_string())?;
                binding.reads.remove(&read_key);
                json!({"deleted":true,"staged":false})
            }
            "rename" => {
                if current.is_none() {
                    return Err("File not found".into());
                }
                let new_path = text(args, "newPath");
                let new_file = if new_path.starts_with("//") {
                    let (other, file) = route_space(binding, new_path)?;
                    if other["id"] != space["id"] {
                        return Err("Rename must stay within one space".into());
                    }
                    file
                } else {
                    relative(new_path)?
                };
                if new_file.is_empty() || new_file == file {
                    return Err("Distinct rename destination required".into());
                }
                if new_file.starts_with("whiteboard/lessons/")
                    || [
                        "whiteboard/qa-artifacts.json",
                        "whiteboard/teach-artifacts.json",
                        "whiteboard/scenario-artifacts.json",
                    ]
                    .contains(&new_file.as_str())
                {
                    return Err(
                        "Use online saveWhiteboardDeck for protected whiteboard files".into(),
                    );
                }
                let destination = confined(&root, &new_file, true)?;
                if destination.exists() {
                    return Err("Destination already exists".into());
                }
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::rename(target, confined(&root, &new_file, true)?)
                    .map_err(|e| e.to_string())?;
                binding.reads.remove(&read_key);
                json!({"renamed":true,"staged":false})
            }
            _ => return Err("Unknown file operation".into()),
        };
        Ok(result)
    }
}

struct StreamGuard {
    manager: Arc<ContextManager>,
    owner: String,
    conversation: String,
    stream_id: String,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Ok(mut bindings) = self.manager.bindings.lock() {
            if let Some(binding) =
                bindings.get_mut(&(self.owner.clone(), self.conversation.clone()))
            {
                if binding
                    .stream
                    .as_ref()
                    .is_some_and(|(id, _)| id == &self.stream_id)
                {
                    disconnect(binding);
                }
            }
        }
    }
}

async fn read_json(req: Request, limit: usize) -> Result<Value, String> {
    if !req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .starts_with("application/json")
    {
        return Err("JSON required".into());
    }
    let bytes = axum::body::to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| "Request too large")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON".into())
}

fn validate_result(value: &Value) -> Result<(), String> {
    let content = value["content"]
        .as_array()
        .ok_or("Invalid MCP tool result")?;
    if content.len() > 64 || value.to_string().len() > MAX_RESULT {
        return Err("Tool result too large".into());
    }
    for part in content {
        match text(part, "type") {
            "text" if part["text"].is_string() => {}
            "image"
                if matches!(
                    text(part, "mimeType"),
                    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                ) && part["data"].as_str().is_some_and(|s| {
                    s.len() <= 8_000_000
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                }) => {}
            _ => return Err("Unsupported MCP tool result content".into()),
        }
    }
    Ok(())
}

fn validate_arguments(schema: &Value, args: &Value) -> Result<(), String> {
    let object = args.as_object().ok_or("Tool arguments must be an object")?;
    if let Some(required) = schema["required"].as_array() {
        for name in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(name) {
                return Err(format!("Missing required tool argument: {name}"));
            }
        }
    }
    if schema["additionalProperties"] == false {
        for name in object.keys() {
            if schema["properties"].get(name).is_none() {
                return Err(format!("Unknown tool argument: {name}"));
            }
        }
    }
    for (name, value) in object {
        let definition = &schema["properties"][name];
        let accepted = match definition["type"].as_str() {
            Some("string") => value.is_string(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("boolean") => value.is_boolean(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("number") => value.is_number(),
            _ => true,
        };
        if !accepted {
            return Err(format!("Invalid tool argument type: {name}"));
        }
        if let Some(values) = definition["enum"].as_array() {
            if !values.contains(value) {
                return Err(format!("Invalid tool argument value: {name}"));
            }
        }
    }
    Ok(())
}

fn relative(value: &str) -> Result<String, String> {
    let raw = value.replace('\\', "/");
    if raw == "." || raw == "/" {
        return Ok(String::new());
    }
    if raw.starts_with('/')
        || raw.bytes().any(|b| b < 32 || b == b':')
        || raw.split('/').any(|p| {
            p == ".."
                || ["%2e", "%2f", "%5c"]
                    .iter()
                    .any(|s| p.to_lowercase().contains(s))
        })
    {
        return Err("Invalid relative workspace path".into());
    }
    Ok(raw
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

fn route_space(binding: &Binding, path: &str) -> Result<(Value, String), String> {
    if let Some(raw) = path.strip_prefix("//") {
        let (alias, file) = raw.split_once('/').unwrap_or((raw, ""));
        let alias = percent_encoding::percent_decode_str(alias)
            .decode_utf8()
            .map_err(|_| "Invalid workspace alias")?;
        let exact = binding
            .spaces
            .iter()
            .filter(|s| {
                s["aliases"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(alias.as_ref())))
            })
            .collect::<Vec<_>>();
        let spaces = if exact.is_empty() {
            binding
                .spaces
                .iter()
                .filter(|s| {
                    s["aliases"].as_array().is_some_and(|a| {
                        a.iter()
                            .any(|v| v.as_str().is_some_and(|v| v.eq_ignore_ascii_case(&alias)))
                    })
                })
                .collect::<Vec<_>>()
        } else {
            exact
        };
        if spaces.len() != 1 {
            return Err("Workspace alias unavailable or ambiguous".into());
        }
        Ok((spaces[0].clone(), relative(file)?))
    } else {
        for space in &binding.spaces {
            let prefix = text(space, "mountPrefix");
            if !prefix.is_empty() && (path == prefix || path.starts_with(&format!("{prefix}/"))) {
                return Ok((
                    space.clone(),
                    relative(path.strip_prefix(prefix).unwrap().trim_start_matches('/'))?,
                ));
            }
        }
        let space = binding
            .spaces
            .iter()
            .find(|s| text(s, "id") == binding.primary)
            .ok_or("Primary workspace unavailable")?;
        Ok((space.clone(), relative(path)?))
    }
}

fn confined(root: &Path, file: &str, writing: bool) -> Result<PathBuf, String> {
    let current = root.canonicalize().map_err(|e| e.to_string())?;
    if current != root {
        return Err("Workspace root changed; reconnect AIChat".into());
    }
    let path = root.join(file);
    if Path::new(file)
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("Workspace path outside root".into());
    }
    let mut probe = path.clone();
    loop {
        match probe.canonicalize() {
            Ok(real) => {
                if !real.starts_with(root) {
                    return Err("Workspace link outside root".into());
                }
                break;
            }
            Err(error) if writing && error.kind() == std::io::ErrorKind::NotFound => {
                if !probe.pop() {
                    return Err("Workspace path unavailable".into());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}

fn read_local(path: &Path) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > MAX_BODY as u64 {
                return Err("Expected bounded text file".into());
            }
            std::fs::read_to_string(path)
                .map(Some)
                .map_err(|e| e.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Internal process mode used by native agents. No shell, daemon, or Node process.
pub async fn proxy_main(endpoint: &str) -> Result<(), String> {
    let url = url::Url::parse(endpoint).map_err(|_| "Invalid tool bridge endpoint")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/agents/tool-proxy"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid tool bridge endpoint".into());
    }
    let capability =
        std::env::var("KEEPWORK_AICHAT_CAPABILITY").map_err(|_| "Tool capability missing")?;
    if Uuid::parse_str(&capability).is_err() {
        return Err("Invalid tool capability".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(125))
        .build()
        .map_err(|e| e.to_string())?;
    let (sender, mut receiver) = mpsc::channel::<String>(32);
    std::thread::spawn(move || {
        let input = std::io::stdin();
        let mut input = input.lock();
        loop {
            let mut line = String::new();
            let mut bounded = std::io::Read::take(&mut input, (MAX_BODY + 1) as u64);
            let Ok(bytes) = bounded.read_line(&mut line) else {
                break;
            };
            if bytes == 0 || bytes > MAX_BODY {
                break;
            }
            if sender.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    let output = Arc::new(Mutex::new(()));
    while let Some(line) = receiver.recv().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if text(&message, "method") == "notifications/cancelled" {
            let client = client.clone();
            let endpoint = endpoint.to_string();
            let capability = capability.clone();
            if tasks.len() < 32 {
                tasks.spawn(async move {
                    let _ = client
                        .post(endpoint)
                        .bearer_auth(capability)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(
                            json!({"method":"cancel","requestId":message["params"]["requestId"]})
                                .to_string(),
                        )
                        .send()
                        .await;
                });
            }
            continue;
        }
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        if tasks.len() >= 32 {
            tasks.abort_all();
            return Err("Too many tool bridge requests".into());
        }
        let client = client.clone();
        let endpoint = endpoint.to_string();
        let capability = capability.clone();
        let output = Arc::clone(&output);
        tasks.spawn(async move{
            let result=match text(&message,"method"){
                "initialize"=>Ok(json!({"protocolVersion":message["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"keepwork-aichat","version":"1.0.0"}})),
                "ping"=>Ok(json!({})),
                "tools/list"|"tools/call"=>match client.post(endpoint).bearer_auth(capability).header(header::CONTENT_TYPE,"application/json").body(json!({"method":message["method"],"params":message["params"],"_proxyRequestId":id}).to_string()).send().await{
                    Ok(response) if response.status().is_success()=>{
                        if response.content_length().is_some_and(|s|s>MAX_RESULT as u64){Err("Tool result too large".to_string())}else{response.text().await.map_err(|_|"Tool bridge disconnected".to_string()).and_then(|body|if body.len()>MAX_RESULT{Err("Tool result too large".into())}else{serde_json::from_str::<Value>(&body).map_err(|_|"Invalid tool result".into())})}
                    },
                    _=>Err("AIChat bridge unavailable; operation was not retried".into()),
                },
                _=>Err("Unsupported tool bridge method".into()),
            };
            let response=match result{Ok(value)=>json!({"jsonrpc":"2.0","id":id,"result":value}),Err(message)=>json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})};
            if let Ok(_guard)=output.lock(){let mut stdout=std::io::stdout().lock();let _=writeln!(stdout,"{response}");let _=stdout.flush();}
        });
        while tasks.try_join_next().is_some() {}
    }
    // EOF revokes this transport immediately rather than leaving invisible work alive.
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    fn registration() -> Value {
        json!({"pageId":"page-a","generation":"generation-a","instructions":"Follow the selected skill.","revision":"abc123","tools":[{"name":"fixture_echo","description":"Fixture only","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}},{"name":"read_file","description":"Read a granted file","inputSchema":{"type":"object"}},{"name":"delete_file","description":"Delete one file","inputSchema":{"type":"object"}}]})
    }

    fn query() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("pageId".into(), "page-a".into()),
            ("generation".into(), "generation-a".into()),
        ])
    }

    #[test]
    fn context_credentials_and_capabilities_stay_private_and_scoped() {
        let manager = ContextManager::new();
        manager
            .register("owner-a", "conversation", &registration())
            .unwrap();
        manager
            .register("owner-b", "conversation", &registration())
            .unwrap();
        let a = manager.descriptor("owner-a", "conversation", 8123).unwrap();
        let b = manager.descriptor("owner-b", "conversation", 8123).unwrap();
        assert_ne!(a["env"], b["env"]);
        assert_eq!(a["args"][0], "--agent-tool-proxy");
        assert_eq!(a["args"][1], "http://127.0.0.1:8123/agents/tool-proxy");
        manager.credentials("owner-a","conversation",&json!({"username":"test-user","token":"private-cloud-token","git":{"github.com":"private-git-token"},"primaryId":"cloud","spaces":[{"id":"cloud","type":"project","aliases":[".brain"]}]})).unwrap();
        let snapshot = manager.snapshot("owner-a", "conversation").to_string();
        assert!(!snapshot.contains("private-cloud-token"));
        assert!(!snapshot.contains("private-git-token"));
        assert!(!snapshot.contains(a["env"][0]["value"].as_str().unwrap()));
        assert_eq!(
            manager.snapshot("owner-a", "conversation")["workspace"]["spaces"][0]
                ["backendAvailable"],
            false
        );
        assert!(manager.context("unknown-owner", "conversation").is_err());
        assert!(manager
            .context("owner-a", "conversation")
            .unwrap()
            .0
            .contains("LOCAL spaces only"));
        manager.revoke("owner-a");
        assert!(manager.descriptor("owner-a", "conversation", 8123).is_err());
        assert!(manager.descriptor("owner-b", "conversation", 8123).is_ok());
    }

    #[tokio::test]
    async fn page_tool_round_trip_rejects_other_owners_and_stale_generations() {
        let manager = Arc::new(ContextManager::new());
        manager
            .register("owner-a", "conversation", &registration())
            .unwrap();
        manager
            .register("owner-b", "conversation", &registration())
            .unwrap();
        let response = manager.stream("owner-a", "conversation", &query()).unwrap();
        let mut stream = response.into_body().into_data_stream();
        assert!(
            String::from_utf8_lossy(&stream.next().await.unwrap().unwrap())
                .contains("event: ready")
        );
        let running = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            running
                .invoke(
                    "owner-a",
                    "conversation",
                    "fixture_echo",
                    &json!({"text":"hello 中文"}),
                )
                .await
        });
        let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: Value = serde_json::from_str(
            String::from_utf8_lossy(&frame)
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(event["arguments"]["text"], "hello 中文");
        let mut result = json!({"pageId":"page-a","generation":"generation-a","callId":event["callId"],"result":{"content":[{"type":"text","text":"confirmed"}]}});
        assert!(manager.result("owner-b", "conversation", &result).is_err());
        result["generation"] = json!("stale-generation");
        assert!(manager.result("owner-a", "conversation", &result).is_err());
        result["generation"] = json!("generation-a");
        manager.result("owner-a", "conversation", &result).unwrap();
        assert_eq!(task.await.unwrap()["content"][0]["text"], "confirmed");
        assert!(manager.result("owner-a", "conversation", &result).is_err());
        let mut replacement = registration();
        replacement["pageId"] = json!("other-page");
        assert!(manager
            .register("owner-a", "conversation", &replacement)
            .is_err());
        drop(stream);
        manager
            .register("owner-a", "conversation", &replacement)
            .unwrap();
        assert!(manager.stream("owner-a", "conversation", &query()).is_err());
    }

    #[tokio::test]
    async fn tool_stream_disconnect_preserves_unknown_mutation_outcomes_without_replay() {
        let manager = Arc::new(ContextManager::new());
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        let response = manager.stream("owner", "conversation", &query()).unwrap();
        let mut stream = response.into_body().into_data_stream();
        stream.next().await.unwrap().unwrap();
        let running = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            running
                .invoke("owner", "conversation", "delete_file", &json!({}))
                .await
        });
        let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&frame).contains("delete_file"));
        drop(stream);
        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["isError"], true);
        assert!(text(&result["content"][0], "text").contains("web_result_unknown"));
        let response = manager.stream("owner", "conversation", &query()).unwrap();
        let mut stream = response.into_body().into_data_stream();
        assert!(
            String::from_utf8_lossy(&stream.next().await.unwrap().unwrap())
                .contains("event: ready")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), stream.next())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn plan_filters_mutating_tools_and_invalid_calls_never_dispatch() {
        let manager = ContextManager::new();
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        let invalid = manager
            .invoke("owner", "conversation", "fixture_echo", &json!({"text":3}))
            .await;
        assert_eq!(invalid["isError"], true);
        assert!(text(&invalid["content"][0], "text").contains("Invalid tool argument type"));
        manager.set_mode("owner", "conversation", "plan");
        let tools = manager.tools("owner", "conversation").unwrap();
        assert_eq!(tools["tools"].as_array().unwrap().len(), 1);
        assert_eq!(tools["tools"][0]["name"], "read_file");
        let denied = manager
            .invoke("owner", "conversation", "delete_file", &json!({}))
            .await;
        assert!(text(&denied["content"][0], "text").contains("Plan mode"));
        let offline = manager
            .invoke("owner", "conversation", "read_file", &json!({}))
            .await;
        assert!(text(&offline["content"][0], "text").contains("web_offline"));
    }

    #[test]
    fn local_workspace_enforces_grants_read_before_write_and_mode_policy() {
        let directory = std::env::temp_dir().join(format!("kp-context-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let root = directory.canonicalize().unwrap();
        std::fs::write(root.join("file.txt"), "original\nline two").unwrap();
        let manager = ContextManager::new();
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        manager.credentials("owner","conversation",&json!({"username":"tester","primaryId":"local","spaces":[{"id":"local","type":"local","root":root,"aliases":["local",".brain"]}]})).unwrap();
        assert!(manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"write","path":"file.txt","content":"changed"})
            )
            .is_err());
        let read = manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"read","path":"//.brain/file.txt"}),
            )
            .unwrap();
        assert_eq!(read["content"], "original\nline two");
        std::fs::write(root.join("file.txt"), "external edit").unwrap();
        assert!(manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"write","path":"file.txt","content":"changed"})
            )
            .is_err());
        manager.local_file("owner","conversation",&json!({"operation":"write","path":"file.txt","content":"changed","expectedContent":"external edit"})).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("file.txt")).unwrap(),
            "changed"
        );
        assert!(manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"read","path":"../file.txt"})
            )
            .is_err());
        assert!(manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"write","path":"%2e%2e/file.txt","content":"escape"})
            )
            .is_err());
        assert!(manager.local_file("owner","conversation",&json!({"operation":"rename","path":"file.txt","newPath":"whiteboard/qa-artifacts.json","expectedContent":"changed"})).is_err());
        manager.set_mode("owner", "conversation", "ask");
        assert!(manager
            .local_file(
                "owner",
                "conversation",
                &json!({"operation":"write","path":"new.txt","content":"forbidden"})
            )
            .is_err());
        assert!(!root.join("new.txt").exists());
        #[cfg(unix)]
        {
            let outside =
                std::env::temp_dir().join(format!("kp-context-outside-{}", Uuid::new_v4()));
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("secret.txt"), "private").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(manager
                .local_file(
                    "owner",
                    "conversation",
                    &json!({"operation":"read","path":"link/secret.txt"})
                )
                .is_err());
            std::fs::remove_dir_all(outside).unwrap();
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn proxy_rejects_nonloopback_origins_and_unknown_capabilities() {
        let manager = Arc::new(ContextManager::new());
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        let descriptor = manager.descriptor("owner", "conversation", 8123).unwrap();
        let capability = descriptor["env"][0]["value"].as_str().unwrap();
        let request = Request::builder()
            .method("POST")
            .header("origin", "http://127.0.0.1:8123")
            .header("authorization", format!("Bearer {capability}"))
            .header("content-type", "application/json")
            .body(Body::from("{\"method\":\"tools/list\"}"))
            .unwrap();
        assert_eq!(
            Arc::clone(&manager).handle_proxy(request).await.status(),
            StatusCode::FORBIDDEN
        );
        let request = Request::builder()
            .method("POST")
            .header("authorization", "Bearer unknown")
            .header("content-type", "application/json")
            .body(Body::from("{\"method\":\"tools/list\"}"))
            .unwrap();
        assert_eq!(
            manager.handle_proxy(request).await.status(),
            StatusCode::FORBIDDEN
        );
        assert!(proxy_main("https://example.com/agents/tool-proxy")
            .await
            .is_err());
        assert!(proxy_main("http://127.0.0.1:8123/other").await.is_err());
    }

    #[test]
    fn git_draft_registration_preserves_data_without_claiming_remote_validation() {
        let directory = std::env::temp_dir().join(format!("kp-context-overlay-{}", Uuid::new_v4()));
        let manager = ContextManager {
            overlay_directory: directory.clone(),
            ..ContextManager::default()
        };
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        manager.credentials("owner","conversation",&json!({"username":"tester","primaryId":"git","spaces":[{"id":"git","type":"git","aliases":["git"],"host":"github.com","owner":"test-owner","repo":"test-repo","branch":"main"}]})).unwrap();
        let imported=manager.overlay("owner","conversation",&json!({"operation":"import","spaceId":"git","files":{"draft.md":{"content":"keep this draft","updatedAt":12345},"gone.md":{"content":"","updatedAt":1,"deleted":true,"baseHash":"existing-base"}}})).unwrap();
        assert_eq!(imported["files"]["draft.md"]["content"], "keep this draft");
        assert_eq!(imported["files"]["draft.md"]["remoteBaseUnknown"], true);
        assert_eq!(imported["files"]["gone.md"]["deleted"], true);
        assert_eq!(imported["files"]["gone.md"]["baseHash"], "existing-base");
        assert!(manager
            .overlay(
                "owner",
                "conversation",
                &json!({"operation":"check","spaceId":"git","files":imported["files"]})
            )
            .is_err());
        assert!(manager.overlay("owner","conversation",&json!({"operation":"import","spaceId":"git","files":{"draft.md":{"content":"conflicting draft"}}})).is_err());
        assert!(manager
            .overlay(
                "owner",
                "conversation",
                &json!({"operation":"drop","spaceId":"git","revision":0})
            )
            .is_err());
        let restored = ContextManager {
            overlay_directory: directory.clone(),
            ..ContextManager::default()
        };
        restored
            .register("owner", "conversation", &registration())
            .unwrap();
        restored.credentials("owner","conversation",&json!({"username":"tester","primaryId":"git","spaces":[{"id":"git","type":"git","aliases":["git"],"host":"github.com","owner":"test-owner","repo":"test-repo","branch":"main"}]})).unwrap();
        let persisted = restored
            .overlay(
                "owner",
                "conversation",
                &json!({"operation":"get","spaceId":"git"}),
            )
            .unwrap();
        assert_eq!(persisted, imported);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn page_replacement_revokes_old_native_capability_and_local_grants() {
        let manager = ContextManager::new();
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        let descriptor = manager.descriptor("owner", "conversation", 8123).unwrap();
        let old = descriptor["env"][0]["value"].as_str().unwrap();
        manager.credentials("owner","conversation",&json!({"username":"tester","primaryId":"cloud","spaces":[{"id":"cloud","type":"project","aliases":["cloud"]}]})).unwrap();
        let mut replacement = registration();
        replacement["generation"] = json!("replacement-generation");
        manager
            .register("owner", "conversation", &replacement)
            .unwrap();
        assert_eq!(
            manager.snapshot("owner", "conversation")["workspace"]["authorized"],
            false
        );
        let result = manager
            .invoke_scoped(
                "owner",
                "conversation",
                "fixture_echo",
                &json!({"text":"stale"}),
                Some(old),
                None,
            )
            .await;
        assert!(text(&result["content"][0], "text").contains("capability expired"));
        let result = manager
            .invoke_scoped(
                "owner",
                "conversation",
                "workspace_file",
                &json!({"operation":"write","path":"stale.txt","content":"stale"}),
                Some(old),
                None,
            )
            .await;
        assert!(text(&result["content"][0], "text").contains("capability expired"));
    }

    #[tokio::test]
    async fn native_cancellation_handles_pre_dispatch_and_in_flight_calls() {
        let manager = Arc::new(ContextManager::new());
        manager
            .register("owner", "conversation", &registration())
            .unwrap();
        let descriptor = manager.descriptor("owner", "conversation", 8123).unwrap();
        let capability = descriptor["env"][0]["value"].as_str().unwrap();
        manager
            .cancel_request("owner", "conversation", capability, &json!(1))
            .unwrap();
        let before = manager
            .invoke_scoped(
                "owner",
                "conversation",
                "delete_file",
                &json!({}),
                Some(capability),
                Some("1".into()),
            )
            .await;
        assert!(text(&before["content"][0], "text").contains("cancelled before dispatch"));
        let response = manager.stream("owner", "conversation", &query()).unwrap();
        let mut stream = response.into_body().into_data_stream();
        stream.next().await.unwrap().unwrap();
        let running = Arc::clone(&manager);
        let token = capability.to_string();
        let task = tokio::spawn(async move {
            running
                .invoke_scoped(
                    "owner",
                    "conversation",
                    "delete_file",
                    &json!({}),
                    Some(&token),
                    Some("2".into()),
                )
                .await
        });
        let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&frame).contains("event: tool"));
        manager
            .cancel_request("owner", "conversation", capability, &json!(2))
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&frame).contains("event: cancel"));
        let result = task.await.unwrap();
        assert_eq!(result["isError"], true);
        assert!(text(&result["content"][0], "text").contains("web_result_unknown"));
    }
}
