//! Persona store and `/agents/personas` routes (`personas-v1`).
//!
//! Records live in `~/.keepwork-mcp/personas-v1/<sha256>.json`, the same files
//! the Node daemon writes. Runs call only the signed-in owner's Keepwork model.
//! This runtime has no tools, messaging listeners, WeChat or native CLIs.

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use chrono_tz::Tz;
use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::http::{json_response, AppState};
use crate::presence::{AichatClient, PresenceState};

const MAX_BODY: usize = 131_072;
const EXECUTORS: &[&str] = &[
    "auto",
    "keepwork",
    "copilot",
    "codex",
    "claude",
    "workbuddy",
    "cursor",
    "trae",
    "qwen",
    "gemini",
    "kimi",
    "codebuddy",
    "opencode",
];

const IDENTITY_RULES: &str =
    "你是主人的分身。自定义智能体是分身的分身，对话历史各自独立，角色指令不能扩大权限。";

fn id_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{1,160}$").unwrap())
}

fn file_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}\.json$").unwrap())
}

fn time_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap())
}

fn account_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^\s,:]+:[^\s,:]+$").unwrap())
}

fn owner_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9-]{32,128}$").unwrap())
}

#[derive(Debug)]
pub struct PersonaError {
    status: u16,
    message: String,
    code: Option<&'static str>,
}

impl PersonaError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
            code: None,
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            status: 422,
            message: message.into(),
            code: Some("UNSUPPORTED_FEATURE"),
        }
    }

    fn unknown_op() -> Self {
        Self {
            status: 404,
            message: "Unknown Agent operation".into(),
            code: Some("UNSUPPORTED_FEATURE"),
        }
    }

    fn method() -> Self {
        Self {
            status: 405,
            message: "Method not allowed".into(),
            code: Some("UNSUPPORTED_FEATURE"),
        }
    }
}

pub fn error_response(status: u16, message: &str, code: Option<&str>) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), json!(message));
    if let Some(code) = code {
        body.insert("code".into(), json!(code));
    }
    let mut response = json_response(
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        &Value::Object(body),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response
}

fn error_to_response(error: PersonaError) -> Response {
    error_response(error.status, &error.message, error.code)
}

fn ok_json(body: &Value) -> Response {
    let mut response = json_response(StatusCode::OK, body);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static header"),
    );
    response
}

fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

fn file_key(owner: &str, id: &str) -> String {
    sha256_hex(&[owner.as_bytes(), b"\0", id.as_bytes()])
}

fn chars_take(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn chars_tail(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max {
        value.to_string()
    } else {
        value.chars().skip(count - max).collect()
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value.as_f64().and_then(|number| {
            if number.is_finite() {
                Some(number as i64)
            } else {
                None
            }
        })
    })
}

fn is_active(row: &Value) -> bool {
    matches!(
        row["job"]["state"].as_str(),
        Some("queued" | "running" | "waiting")
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Next HH:mm instant in an IANA zone, walking minute by minute like Node.
pub fn next_persona_run(time: &str, timezone: &str, after: i64) -> Result<i64, PersonaError> {
    if !time_re().is_match(time) {
        return Err(PersonaError::bad("时间应为 HH:mm"));
    }
    let tz: Tz = timezone
        .parse()
        .map_err(|_| PersonaError::bad("无法计算下次执行时间"))?;
    let mut cursor = after.div_euclid(60_000) * 60_000 + 60_000;
    let end = cursor + 49 * 3_600_000;
    while cursor < end {
        let Some(utc) = chrono::DateTime::from_timestamp_millis(cursor) else {
            return Err(PersonaError::bad("无法计算下次执行时间"));
        };
        if utc.with_timezone(&tz).format("%H:%M").to_string() == time {
            return Ok(cursor);
        }
        cursor += 60_000;
    }
    Err(PersonaError::bad("无法计算下次执行时间"))
}

fn zone_date(timezone: &str, now: i64) -> Result<String, ()> {
    let tz: Tz = timezone.parse().map_err(|_| ())?;
    let utc = chrono::DateTime::from_timestamp_millis(now).ok_or(())?;
    Ok(utc.with_timezone(&tz).format("%Y-%m-%d").to_string())
}

fn canonical_root(input: &str) -> Result<String, PersonaError> {
    if input.is_empty() {
        return Ok(String::new());
    }
    let path = Path::new(input);
    if !path.is_absolute() {
        return Err(PersonaError::bad("请选择现有本机第二大脑目录"));
    }
    let meta =
        std::fs::metadata(path).map_err(|_| PersonaError::bad("请选择现有本机第二大脑目录"))?;
    if !meta.is_dir() {
        return Err(PersonaError::bad("请选择现有本机第二大脑目录"));
    }
    let real =
        std::fs::canonicalize(path).map_err(|_| PersonaError::bad("请选择现有本机第二大脑目录"))?;
    let mut text = real.to_string_lossy().into_owned();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        text = stripped.to_string();
    }
    Ok(text)
}

fn forbidden_name(name: &str, amp: bool) -> bool {
    name.chars().any(|ch| {
        (ch as u32) <= 0x1f || ch == '【' || ch == '】' || (amp && (ch == '&' || ch == '＆'))
    })
}

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn agent_messaging(value: &Value) -> Result<Value, PersonaError> {
    let groups_in = value.get("groups").and_then(Value::as_array);
    let enabled = value.get("enabled").and_then(Value::as_bool);
    if value.get("version").and_then(Value::as_i64) != Some(1)
        || enabled.is_none()
        || groups_in.map(|rows| rows.len() > 100).unwrap_or(true)
    {
        return Err(PersonaError::bad("Invalid agent messaging configuration"));
    }
    let enabled = enabled.unwrap();
    let mut groups = Vec::new();
    let mut seen = HashSet::new();
    for row in groups_in.unwrap() {
        let channel = row["channel"].as_str().unwrap_or("");
        let account = row["account"].as_str().unwrap_or("");
        if (channel != "dingtalk" && channel != "feishu")
            || account.len() > 256
            || !account_re().is_match(account)
        {
            return Err(PersonaError::bad("Select a stable channel account"));
        }
        let group_id = row["id"].as_str().unwrap_or("");
        let group_name = row["name"].as_str().unwrap_or("");
        for (label, field) in [("id", group_id), ("name", group_name)] {
            if field.trim().is_empty()
                || field.chars().count() > 256
                || field.chars().any(|ch| (ch as u32) <= 0x1f)
            {
                return Err(PersonaError::bad(format!("Invalid group {label}")));
            }
        }
        let key = format!("{channel}\0{account}\0{}", group_id.trim());
        if seen.insert(key) {
            groups.push(json!({
                "channel": channel,
                "account": account,
                "id": group_id.trim(),
                "name": group_name.trim(),
            }));
        }
    }
    if enabled && groups.is_empty() {
        return Err(PersonaError::bad("请先选择至少一个主要群聊"));
    }
    Ok(json!({ "version": 1, "enabled": enabled, "groups": groups }))
}

fn shares_account(left: &Value, right: &Value) -> bool {
    let Some(a) = left["messaging"]["groups"].as_array() else {
        return false;
    };
    let Some(b) = right["messaging"]["groups"].as_array() else {
        return false;
    };
    a.iter().any(|group| {
        b.iter().any(|other| {
            group["channel"] == other["channel"] && group["account"] == other["account"]
        })
    })
}

fn assert_names(candidate: &Value, others: &[Value]) -> Result<(), PersonaError> {
    let id = candidate["id"].as_str().unwrap_or("");
    let name = candidate["name"].as_str().unwrap_or("");
    let prompt = candidate["prompt"].as_str().unwrap_or("");
    let messaging_on = candidate["messaging"]["enabled"] == json!(true);
    if id != "default-persona" && !prompt.trim().is_empty() && forbidden_name(name, true) {
        return Err(PersonaError::bad("智能体名称不能包含控制字符、【】或 &"));
    }
    if !messaging_on {
        return Ok(());
    }
    if prompt.trim().is_empty() {
        return Err(PersonaError::bad("请填写角色与技能指令"));
    }
    if forbidden_name(name, false) {
        return Err(PersonaError::bad("智能体名称不能包含控制字符或【】"));
    }
    let needle = normalize_name(name);
    for other in others {
        if other["id"].as_str() == Some(id) || other["messaging"]["enabled"] != json!(true) {
            continue;
        }
        if normalize_name(other["name"].as_str().unwrap_or("")) != needle {
            continue;
        }
        if shares_account(candidate, other) {
            return Err(PersonaError::bad("同一消息账号的智能体名称必须唯一"));
        }
    }
    Ok(())
}

fn keepwork_chat_url(base_url: &str) -> Result<String, String> {
    let raw = if base_url.trim().is_empty() {
        "https://api.keepwork.com/core/v0"
    } else {
        base_url.trim()
    };
    let url = url::Url::parse(raw).map_err(|_| "Unsupported Keepwork API origin".to_string())?;
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_end_matches('/');
    if url.scheme() != "https"
        || !matches!(
            host,
            "api.keepwork.com" | "keepwork.com" | "api-dev.kp-para.cn"
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || path != "/core/v0"
    {
        return Err("Unsupported Keepwork API origin".into());
    }
    let origin = match url.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    };
    Ok(format!("{origin}/core/v0/gpt/chat"))
}

fn agents_md(root: &str) -> String {
    if root.is_empty() {
        return String::new();
    }
    let root_path = Path::new(root);
    let file = root_path.join("AGENTS.md");
    let Ok(meta) = std::fs::metadata(&file) else {
        return String::new();
    };
    if !meta.is_file() || meta.len() > 16 * 1024 {
        return String::new();
    }
    let (Ok(real_root), Ok(real_file)) = (
        std::fs::canonicalize(root_path),
        std::fs::canonicalize(&file),
    ) else {
        return String::new();
    };
    if !real_file.starts_with(&real_root) {
        return String::new();
    }
    std::fs::read_to_string(real_file)
        .map(|text| chars_take(&text, 16_000))
        .unwrap_or_default()
}

type PersonaWatcher = (
    String,
    tokio::sync::mpsc::UnboundedSender<Result<Bytes, std::io::Error>>,
);

struct Inner {
    rows: HashMap<String, Value>,
    watchers: Vec<Option<PersonaWatcher>>,
    cancels: HashMap<String, tokio::sync::watch::Sender<bool>>,
}

struct Due {
    owner: String,
    id: String,
    request_id: String,
    prompt: String,
}

struct RunSpec {
    key: String,
    owner: String,
    request_id: String,
    text: String,
    context_mode: String,
}

struct ModelRequest {
    system: String,
    history: Vec<(String, String)>,
    text: String,
    model: String,
}

pub struct PersonaStore {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl PersonaStore {
    pub fn open(dir: PathBuf) -> Arc<Self> {
        if let Err(error) = std::fs::create_dir_all(&dir) {
            eprintln!(
                "keepwork-mcp: cannot create persona directory {}: {error}",
                dir.display()
            );
        }
        let store = Arc::new(Self {
            dir,
            inner: Mutex::new(Inner {
                rows: HashMap::new(),
                watchers: Vec::new(),
                cancels: HashMap::new(),
            }),
        });
        store.load();
        store
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn load(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut inner = self.lock();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !file_re().is_match(name) {
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut row) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(owner) = row["owner"].as_str().map(str::to_string) else {
                continue;
            };
            let Some(id) = row["id"].as_str().map(str::to_string) else {
                continue;
            };
            if !id_re().is_match(&id) {
                continue;
            }
            let key = file_key(&owner, &id);
            if format!("{key}.json") != name {
                continue;
            }
            if row.get("messaging").is_some() && !row["messaging"].is_null() {
                match agent_messaging(&row["messaging"]) {
                    Ok(messaging) => row["messaging"] = messaging,
                    Err(_) => continue,
                }
            }
            normalize_loaded(&mut row);
            self.write_file(&key, &row);
            inner.rows.insert(key, row);
        }
    }

    fn write_file(&self, key: &str, value: &Value) {
        if let Err(error) = self.write_file_checked(key, value) {
            eprintln!("keepwork-mcp: {}", error.message);
        }
    }

    fn write_file_checked(&self, key: &str, value: &Value) -> Result<(), PersonaError> {
        let path = self.dir.join(format!("{key}.json"));
        let tmp = self.dir.join(format!("{key}.json.tmp"));
        let failure = || PersonaError {
            status: 500,
            message: "无法保存分身记录，消息未发送，请检查本机存储。".into(),
            code: Some("PERSISTENCE_ERROR"),
        };
        let text = serde_json::to_string(value).map_err(|_| failure())?;
        std::fs::write(&tmp, text).map_err(|_| failure())?;
        restrict_file(&tmp);
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err(failure());
        }
        Ok(())
    }

    fn save(&self, inner: &Inner, key: &str) {
        if let Some(value) = inner.rows.get(key) {
            self.write_file(key, value);
        }
    }

    fn notify(&self, owner: &str) {
        let mut inner = self.lock();
        let frame = Bytes::from_static(b"event: changed\ndata: {}\n\n");
        for slot in &mut inner.watchers {
            let Some((watched, tx)) = slot else {
                continue;
            };
            if watched != owner {
                continue;
            }
            if tx.send(Ok(frame.clone())).is_err() {
                *slot = None;
            }
        }
    }

    pub fn list(&self, owner: &str) -> Value {
        let inner = self.lock();
        let mut agents: Vec<Value> = inner
            .rows
            .values()
            .filter(|row| row["owner"].as_str() == Some(owner))
            .map(|row| project_view(row, None))
            .collect();
        agents.sort_by(|a, b| {
            a["order"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&b["order"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        json!({
            "agents": agents,
        })
    }

    fn require<'a>(
        &self,
        inner: &'a Inner,
        owner: &str,
        id: &str,
    ) -> Result<&'a Value, PersonaError> {
        inner
            .rows
            .get(&file_key(owner, id))
            .ok_or_else(|| PersonaError::bad("分身不存在"))
    }

    pub fn read(&self, owner: &str, id: &str, before: i64) -> Result<Value, PersonaError> {
        let inner = self.lock();
        let row = self.require(&inner, owner, id)?;
        let peers = peer_count(&inner, owner, id);
        Ok(project_view(row, Some(Detail { before, peers })))
    }

    pub fn upsert(
        &self,
        presence: &PresenceState,
        owner: &str,
        input: &Value,
    ) -> Result<Value, PersonaError> {
        let id = input["id"].as_str().unwrap_or("");
        if !id_re().is_match(id) {
            return Err(PersonaError::bad("Invalid Agent ID"));
        }
        let key = file_key(owner, id);
        let mut inner = self.lock();
        let old = inner.rows.get(&key).cloned();
        if old.as_ref().is_some_and(is_active) {
            return Err(PersonaError::bad("请先等待或取消当前任务再修改分身"));
        }
        let name = chars_take(input["name"].as_str().unwrap_or("").trim(), 80);
        if name.is_empty() {
            return Err(PersonaError::bad("请输入分身名称"));
        }
        let root_raw = if input.get("root").is_none() {
            if let Some(old) = &old {
                old["root"].as_str().unwrap_or("").to_string()
            } else if let Some(default_row) = inner.rows.get(&file_key(owner, "default-persona")) {
                default_row["root"].as_str().unwrap_or("").to_string()
            } else {
                presence.brain_root(owner)
            }
        } else {
            input["root"].as_str().unwrap_or("").to_string()
        };
        let root = canonical_root(&root_raw)?;
        let executor = {
            let value = input["executor"].as_str().unwrap_or("auto");
            if value.is_empty() {
                "auto"
            } else {
                value
            }
        };
        if !EXECUTORS.contains(&executor) {
            return Err(PersonaError::bad("Invalid executor"));
        }
        let avatar_raw = input["avatar"].as_str().unwrap_or("");
        let avatar = if avatar_raw.is_empty() {
            "🧠".to_string()
        } else {
            chars_take(avatar_raw, 16)
        };
        let prompt = chars_take(input["prompt"].as_str().unwrap_or(""), 16_000);
        let model = chars_take(input["model"].as_str().unwrap_or(""), 256);
        let pinned = input.get("pinned").and_then(Value::as_bool) != Some(false);
        let order = input
            .get("order")
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
            .unwrap_or(now_ms() as f64);
        let mut row = old.unwrap_or_else(|| {
            json!({
                "owner": owner,
                "id": id,
                "messages": [],
                "requests": {},
                "schedules": [],
                "summary": "",
                "readAt": 0,
            })
        });
        row["owner"] = json!(owner);
        row["id"] = json!(id);
        row["name"] = json!(name);
        row["avatar"] = json!(avatar);
        row["prompt"] = json!(prompt);
        row["root"] = json!(root);
        row["executor"] = json!(executor);
        row["model"] = json!(model);
        row["pinned"] = json!(pinned);
        row["order"] = json!(order);
        if input.get("messaging").is_some() {
            row["messaging"] = agent_messaging(&input["messaging"])?;
            if id != "default-persona" && row["prompt"].as_str().unwrap_or("").trim().is_empty() {
                return Err(PersonaError::bad("请填写角色与技能指令"));
            }
        }
        if id == "default-persona" && row["messaging"]["enabled"] == json!(true) {
            return Err(PersonaError::bad("默认分身沿用原消息规则"));
        }
        let others: Vec<Value> = inner
            .rows
            .values()
            .filter(|other| {
                other["owner"].as_str() == Some(owner)
                    || other["root"].as_str() == Some(root.as_str())
            })
            .cloned()
            .collect();
        assert_names(&row, &others)?;
        if row.get("messaging").map(Value::is_null).unwrap_or(false) {
            row.as_object_mut().map(|object| object.remove("messaging"));
        }
        let view = project_view(&row, None);
        inner.rows.insert(key.clone(), row);
        self.save(&inner, &key);
        drop(inner);
        self.notify(owner);
        Ok(view)
    }

    pub fn mark_read(&self, owner: &str, id: &str) -> Result<Value, PersonaError> {
        let key = file_key(owner, id);
        let mut inner = self.lock();
        {
            let row = inner
                .rows
                .get_mut(&key)
                .ok_or_else(|| PersonaError::bad("分身不存在"))?;
            let last = row["messages"]
                .as_array()
                .and_then(|messages| messages.last())
                .and_then(|message| json_i64(&message["time"]))
                .unwrap_or(0);
            row["readAt"] = json!(now_ms().max(last));
        }
        self.save(&inner, &key);
        let view = project_view(inner.rows.get(&key).unwrap(), None);
        drop(inner);
        self.notify(owner);
        Ok(view)
    }

    pub fn clear(&self, owner: &str, id: &str) -> Result<Value, PersonaError> {
        let key = file_key(owner, id);
        let mut inner = self.lock();
        {
            let row = inner
                .rows
                .get_mut(&key)
                .ok_or_else(|| PersonaError::bad("分身不存在"))?;
            if is_active(row) {
                return Err(PersonaError::bad("请先等待或取消当前任务再清空上下文"));
            }
            row["messages"] = json!([]);
            row["summary"] = json!("");
            row["readAt"] = json!(0);
            row.as_object_mut().map(|object| object.remove("job"));
        }
        self.save(&inner, &key);
        let peers = peer_count(&inner, owner, id);
        let view = project_view(
            inner.rows.get(&key).unwrap(),
            Some(Detail {
                before: i64::MAX,
                peers,
            }),
        );
        drop(inner);
        self.notify(owner);
        Ok(view)
    }

    pub fn cancel(&self, owner: &str, id: &str) -> Result<Value, PersonaError> {
        let key = file_key(owner, id);
        let mut inner = self.lock();
        if !inner.rows.contains_key(&key) {
            return Err(PersonaError::bad("分身不存在"));
        }
        if let Some(tx) = inner.cancels.get(&key) {
            let _ = tx.send(true);
        }
        if let Some(row) = inner.rows.get_mut(&key) {
            if row.get("job").is_some() && !row["job"].is_null() {
                row["job"]["state"] = json!("cancelled");
                row["job"]["pending"] = json!([]);
            }
        }
        self.save(&inner, &key);
        let view = project_view(inner.rows.get(&key).unwrap(), None);
        drop(inner);
        self.notify(owner);
        Ok(view)
    }

    pub fn remove(&self, owner: &str, id: &str) -> Result<Value, PersonaError> {
        let key = file_key(owner, id);
        let mut inner = self.lock();
        if inner.rows.remove(&key).is_none() {
            return Err(PersonaError::bad("分身不存在"));
        }
        if let Some(tx) = inner.cancels.remove(&key) {
            let _ = tx.send(true);
        }
        drop(inner);
        let _ = std::fs::remove_file(self.dir.join(format!("{key}.json")));
        self.notify(owner);
        Ok(json!({ "ok": true }))
    }

    pub fn schedule(&self, owner: &str, id: &str, input: &Value) -> Result<Value, PersonaError> {
        let schedule_id = input["id"].as_str().unwrap_or("");
        if !id_re().is_match(schedule_id) {
            return Err(PersonaError::bad("Invalid schedule ID"));
        }
        let key = file_key(owner, id);
        let mut inner = self.lock();
        if !inner.rows.contains_key(&key) {
            return Err(PersonaError::bad("分身不存在"));
        }
        if input.get("remove").and_then(Value::as_bool) == Some(true) {
            {
                let row = inner.rows.get_mut(&key).unwrap();
                if let Some(schedules) = row["schedules"].as_array_mut() {
                    schedules.retain(|item| item["id"].as_str() != Some(schedule_id));
                }
            }
            self.save(&inner, &key);
            let view = project_view(inner.rows.get(&key).unwrap(), None);
            drop(inner);
            self.notify(owner);
            return Ok(view);
        }
        if matches!(input.get("target"), Some(Value::Object(_))) {
            return Err(PersonaError::bad("外部发送目标尚未在 Rust 运行时支持"));
        }
        let prompt = chars_take(input["prompt"].as_str().unwrap_or(""), 20_000);
        if prompt.trim().is_empty() {
            return Err(PersonaError::bad("请输入任务内容"));
        }
        let time = input["time"].as_str().unwrap_or("").to_string();
        let timezone = input["timezone"].as_str().unwrap_or("").to_string();
        let next = next_persona_run(&time, &timezone, now_ms())?;
        let title_raw = input["title"].as_str().unwrap_or("");
        let title = if title_raw.is_empty() {
            "定时任务".to_string()
        } else {
            chars_take(title_raw, 80)
        };
        {
            let row = inner.rows.get_mut(&key).unwrap();
            if !row["schedules"].is_array() {
                row["schedules"] = json!([]);
            }
            let previous = row["schedules"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item["id"].as_str() == Some(schedule_id))
                })
                .cloned();
            let mut schedule = json!({
                "id": schedule_id,
                "title": title,
                "prompt": prompt,
                "time": time,
                "timezone": timezone,
                "enabled": input.get("enabled").and_then(Value::as_bool) == Some(true),
                "next": next,
            });
            if let Some(previous) = previous {
                if let Some(last) = previous.get("last").filter(|value| !value.is_null()) {
                    schedule["last"] = last.clone();
                }
                if let Some(last_date) = previous.get("lastDate").filter(|value| !value.is_null()) {
                    schedule["lastDate"] = last_date.clone();
                }
            }
            let schedules = row["schedules"].as_array_mut().unwrap();
            schedules.retain(|item| item["id"].as_str() != Some(schedule_id));
            schedules.push(schedule);
        }
        self.save(&inner, &key);
        let view = project_view(inner.rows.get(&key).unwrap(), None);
        drop(inner);
        self.notify(owner);
        Ok(view)
    }

    pub fn submit(
        self: &Arc<Self>,
        presence: &Arc<PresenceState>,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Value, PersonaError> {
        let request_id = input["requestId"].as_str().unwrap_or("");
        if !id_re().is_match(request_id) {
            return Err(PersonaError::bad("requestId required"));
        }
        let key = file_key(owner, id);
        let (view, cancel) = {
            let mut inner = self.lock();
            if !inner.rows.contains_key(&key) {
                return Err(PersonaError::bad("分身不存在"));
            }
            if has_request(inner.rows.get(&key).unwrap(), request_id) {
                return Ok(project_view(inner.rows.get(&key).unwrap(), None));
            }
            if is_active(inner.rows.get(&key).unwrap()) {
                return Err(PersonaError::bad("分身正在处理上一项任务"));
            }
            let text = input["text"].as_str().unwrap_or("").trim().to_string();
            if text.is_empty() || text.chars().count() > 20_000 {
                return Err(PersonaError::bad("消息长度应为 1–20000 字符"));
            }
            if let Some(mode) = input.get("contextMode").filter(|value| !value.is_null()) {
                if mode.as_str() != Some("conversation") && mode.as_str() != Some("isolated") {
                    return Err(PersonaError::unsupported("Unsupported contextMode"));
                }
            }
            let context_mode = input["contextMode"]
                .as_str()
                .unwrap_or("conversation")
                .to_string();
            if text.starts_with("/协作") {
                return Err(PersonaError::unsupported("本机 Rust 服务尚未提供分身协作"));
            }
            let previous = inner.rows.get(&key).unwrap().clone();
            let view = {
                let row = inner.rows.get_mut(&key).unwrap();
                if !row["requests"].is_object() {
                    row["requests"] = json!({});
                }
                row["requests"][request_id] = json!("accepted");
                row["job"] = json!({
                    "id": request_id,
                    "state": "queued",
                    "contextMode": context_mode,
                    "pending": [],
                });
                if !row["messages"].is_array() {
                    row["messages"] = json!([]);
                }
                let time = next_message_time(row);
                row["messages"].as_array_mut().unwrap().push(json!({
                    "id": request_id,
                    "role": "user",
                    "text": text,
                    "time": time,
                }));
                if let Some(executor) = presence
                    .owner_client(owner)
                    .and_then(|client| client.default_executor)
                {
                    row["preference"] = executor;
                }
                project_view(row, None)
            };
            if let Err(error) = self.write_file_checked(&key, inner.rows.get(&key).unwrap()) {
                inner.rows.insert(key.clone(), previous);
                return Err(error);
            }
            let (tx, rx) = tokio::sync::watch::channel(false);
            inner.cancels.insert(key.clone(), tx);
            (view, rx)
        };
        let spec = RunSpec {
            key,
            owner: owner.to_string(),
            request_id: request_id.to_string(),
            text: input["text"].as_str().unwrap_or("").trim().to_string(),
            context_mode: input["contextMode"]
                .as_str()
                .unwrap_or("conversation")
                .to_string(),
        };
        let store = Arc::clone(self);
        let presence = Arc::clone(presence);
        tokio::spawn(async move {
            store.run(presence, spec, cancel).await;
        });
        self.notify(owner);
        Ok(view)
    }

    pub fn tick(self: &Arc<Self>, presence: &Arc<PresenceState>, now: i64) {
        let due = self.collect_due(now);
        for item in due {
            let input = json!({
                "requestId": item.request_id,
                "text": item.prompt,
                "contextMode": "conversation",
            });
            if let Err(error) = self.submit(presence, &item.owner, &item.id, &input) {
                self.note_schedule(&item.owner, &item.id, &item.request_id, &error.message);
            }
        }
    }

    fn note_schedule(&self, owner: &str, id: &str, request_id: &str, message: &str) {
        let key = file_key(owner, id);
        let mut inner = self.lock();
        {
            let Some(row) = inner.rows.get_mut(&key) else {
                return;
            };
            if let Some(schedules) = row["schedules"].as_array_mut() {
                for schedule in schedules {
                    if schedule["last"].as_str() == Some(request_id) {
                        schedule["last"] = json!(message);
                    }
                }
            }
        }
        self.save(&inner, &key);
    }

    fn collect_due(&self, now: i64) -> Vec<Due> {
        let mut due = Vec::new();
        let mut owners = HashSet::new();
        let mut inner = self.lock();
        let keys: Vec<String> = inner.rows.keys().cloned().collect();
        for key in keys {
            let Some(mut row) = inner.rows.get(&key).cloned() else {
                continue;
            };
            let owner = row["owner"].as_str().unwrap_or("").to_string();
            let id = row["id"].as_str().unwrap_or("").to_string();
            let active = is_active(&row);
            let Some(schedules) = row.get_mut("schedules").and_then(Value::as_array_mut) else {
                continue;
            };
            let mut changed = false;
            let mut firing = false;
            let mut row_due = Vec::new();
            for schedule in schedules.iter_mut() {
                if schedule["enabled"] != json!(true) {
                    continue;
                }
                let next_at = json_i64(&schedule["next"]).unwrap_or(0);
                if next_at > now {
                    continue;
                }
                let time = schedule["time"].as_str().unwrap_or("").to_string();
                let timezone = schedule["timezone"].as_str().unwrap_or("").to_string();
                match next_persona_run(&time, &timezone, now) {
                    Ok(next) => schedule["next"] = json!(next),
                    Err(error) => {
                        schedule["enabled"] = json!(false);
                        schedule["last"] = json!(error.message);
                        changed = true;
                        continue;
                    }
                }
                let date = match zone_date(&timezone, now) {
                    Ok(date) => date,
                    Err(()) => {
                        schedule["enabled"] = json!(false);
                        schedule["last"] = json!("无法计算下次执行时间");
                        changed = true;
                        continue;
                    }
                };
                if schedule["lastDate"].as_str() == Some(date.as_str()) {
                    changed = true;
                    continue;
                }
                schedule["lastDate"] = json!(date);
                let targeted = matches!(schedule.get("target"), Some(Value::Object(_)));
                if now.saturating_sub(next_at) > 60_000 || active || firing || targeted {
                    schedule["last"] = json!(if targeted {
                        "外部发送目标尚未在 Rust 运行时支持"
                    } else {
                        "已跳过：离线或分身忙碌"
                    });
                    changed = true;
                    continue;
                }
                let schedule_id = schedule["id"].as_str().unwrap_or("");
                let request_id = format!("schedule-{schedule_id}-{next_at}");
                if !id_re().is_match(&request_id) {
                    schedule["last"] = json!("requestId required");
                    changed = true;
                    continue;
                }
                let prompt = schedule["prompt"].as_str().unwrap_or("").to_string();
                schedule["last"] = json!(request_id.clone());
                changed = true;
                firing = true;
                row_due.push(Due {
                    owner: owner.clone(),
                    id: id.clone(),
                    request_id,
                    prompt,
                });
            }
            if changed {
                self.write_file(&key, &row);
                inner.rows.insert(key, row);
                owners.insert(owner);
                due.extend(row_due);
            }
        }
        drop(inner);
        for owner in owners {
            self.notify(&owner);
        }
        due
    }

    async fn run(
        self: Arc<Self>,
        presence: Arc<PresenceState>,
        spec: RunSpec,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) {
        if *cancel.borrow() {
            self.finish(&spec, Err("已取消".into()), true);
            self.notify(&spec.owner);
            return;
        }
        let Some(prepared) = self.begin_run(&spec) else {
            return;
        };
        self.notify(&spec.owner);
        let outcome = if *cancel.borrow() {
            Err("已取消".into())
        } else {
            match presence.owner_client(&spec.owner) {
                Some(client) if !client.token.is_empty() => {
                    call_model(client, prepared, &mut cancel).await
                }
                _ => Err("需要登录 AIChat".into()),
            }
        };
        let cancelled = *cancel.borrow();
        self.finish(&spec, outcome, cancelled);
        self.notify(&spec.owner);
    }

    fn begin_run(&self, spec: &RunSpec) -> Option<ModelRequest> {
        let mut inner = self.lock();
        let (owner_hash, persona_hint) = {
            let row = inner.rows.get(&spec.key)?;
            if row["job"]["id"].as_str() != Some(spec.request_id.as_str()) {
                return None;
            }
            (
                row["owner"].as_str().unwrap_or("").to_string(),
                row["id"].as_str().unwrap_or("").to_string(),
            )
        };
        let peers = peer_names(&inner, &owner_hash, &persona_hint);
        let (prompt, persona_id, root, summary, history, model) = {
            let row = inner.rows.get_mut(&spec.key)?;
            row["job"]["state"] = json!("running");
            let isolated = spec.context_mode == "isolated";
            let messages = row["messages"].as_array().cloned().unwrap_or_default();
            let summary = if isolated {
                String::new()
            } else {
                summarize(&messages)
            };
            row["summary"] = json!(summary.clone());
            let history = if isolated {
                Vec::new()
            } else {
                history_of(&messages)
            };
            (
                row["prompt"].as_str().unwrap_or("").to_string(),
                row["id"].as_str().unwrap_or("").to_string(),
                row["root"].as_str().unwrap_or("").to_string(),
                summary,
                history,
                resolve_model(row),
            )
        };
        self.save(&inner, &spec.key);
        drop(inner);
        let knowledge = agents_md(&root);
        let mut system = format!(
            "{IDENTITY_RULES}\n当前分身 ID：{persona_id}\n本运行时没有工具，不能发消息、不能改文件、不能操作钉钉、飞书或微信。未实际执行时必须说明未执行，不得编造已发送、已修改或已完成。\n{prompt}\n较早对话摘要：\n{summary}\n同账号其他分身：{peers}"
        );
        if !knowledge.is_empty() {
            system.push_str("\n# AGENTS.md\n");
            system.push_str(&knowledge);
        }
        Some(ModelRequest {
            system,
            history,
            text: spec.text.clone(),
            model,
        })
    }

    fn finish(&self, spec: &RunSpec, outcome: Result<String, String>, cancelled: bool) {
        let mut inner = self.lock();
        let applied = {
            let Some(row) = inner.rows.get_mut(&spec.key) else {
                return;
            };
            if row["job"]["id"].as_str() != Some(spec.request_id.as_str()) {
                return;
            }
            let (state, error) = if cancelled {
                ("cancelled".to_string(), Some("已取消".to_string()))
            } else {
                match outcome {
                    Ok(answer) if !answer.trim().is_empty() => {
                        let time = next_message_time(row);
                        if !row["messages"].is_array() {
                            row["messages"] = json!([]);
                        }
                        row["messages"].as_array_mut().unwrap().push(json!({
                            "id": format!("{}-answer", spec.request_id),
                            "role": "assistant",
                            "text": chars_take(&answer, 60_000),
                            "time": time,
                            "execution": { "source": "keepwork-runtime", "requested": 0, "returned": 0 },
                        }));
                        ("done".into(), None)
                    }
                    Ok(_) => ("error".into(), Some("执行器未返回答案".into())),
                    Err(message) => classify_failure(&message),
                }
            };
            row["job"]["state"] = json!(state);
            row["job"]["pending"] = json!([]);
            if let Some(error) = error {
                row["job"]["error"] = json!(error);
            } else if let Some(job) = row["job"].as_object_mut() {
                job.remove("error");
            }
            if !row["requests"].is_object() {
                row["requests"] = json!({});
            }
            row["requests"][&spec.request_id] = json!(state);
            true
        };
        if applied {
            inner.cancels.remove(&spec.key);
            self.save(&inner, &spec.key);
        }
    }

    pub fn admin_snapshot(&self) -> Value {
        let inner = self.lock();
        let personas: Vec<Value> = inner
            .rows
            .values()
            .map(|row| {
                let messages = row["messages"].as_array().map(Vec::len).unwrap_or(0);
                let unread = unread_count(row);
                let schedules = row["schedules"].as_array();
                let schedule_count = schedules.map(Vec::len).unwrap_or(0);
                let enabled = schedules
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| item["enabled"] == json!(true))
                            .count()
                    })
                    .unwrap_or(0);
                json!({
                    "id": row["id"].as_str().unwrap_or(""),
                    "name": row["name"].as_str().unwrap_or(""),
                    "state": row["job"]["state"].as_str().unwrap_or("idle"),
                    "executor": "keepwork",
                    "messages": messages,
                    "unread": unread,
                    "enabledSchedules": enabled,
                    "schedules": schedule_count,
                    "channels": 0,
                })
            })
            .collect();
        let active = personas
            .iter()
            .filter(|row| {
                matches!(
                    row["state"].as_str(),
                    Some("queued" | "running" | "waiting")
                )
            })
            .count();
        let message_total: u64 = personas
            .iter()
            .map(|row| row["messages"].as_u64().unwrap_or(0))
            .sum();
        let enabled_total: u64 = personas
            .iter()
            .map(|row| row["enabledSchedules"].as_u64().unwrap_or(0))
            .sum();
        let sessions: Vec<Value> = personas
            .iter()
            .map(|row| {
                json!({
                    "persona": row["name"].as_str().unwrap_or(""),
                    "id": row["id"].as_str().unwrap_or(""),
                    "kind": "Conversation",
                    "state": row["state"].as_str().unwrap_or("idle"),
                })
            })
            .collect();
        json!({
            "stats": {
                "total": personas.len(),
                "active": active,
                "messages": message_total,
                "enabledSchedules": enabled_total,
                "sessions": sessions.len(),
            },
            "personas": personas,
            "sessions": sessions,
            "recentMessages": [],
        })
    }
}

fn normalize_loaded(row: &mut Value) {
    if is_active(row) {
        row["job"]["state"] = json!("unknown");
        row["job"]["error"] = json!("服务已重启，任务未重放");
        row["job"]["pending"] = json!([]);
    }
    let now = now_ms();
    if let Some(schedules) = row.get_mut("schedules").and_then(Value::as_array_mut) {
        for schedule in schedules {
            if schedule["enabled"] != json!(true) {
                continue;
            }
            let time = schedule["time"].as_str().unwrap_or("");
            let timezone = schedule["timezone"].as_str().unwrap_or("");
            match next_persona_run(time, timezone, now) {
                Ok(next) => schedule["next"] = json!(next),
                Err(error) => {
                    schedule["enabled"] = json!(false);
                    schedule["last"] = json!(error.message);
                }
            }
        }
    }
}

fn peer_count(inner: &Inner, owner: &str, id: &str) -> usize {
    inner
        .rows
        .values()
        .filter(|row| row["owner"].as_str() == Some(owner) && row["id"].as_str() != Some(id))
        .count()
}

fn peer_names(inner: &Inner, owner: &str, id: &str) -> Value {
    let peers: Vec<Value> = inner
        .rows
        .values()
        .filter(|row| row["owner"].as_str() == Some(owner) && row["id"].as_str() != Some(id))
        .map(|row| json!({ "id": row["id"].as_str().unwrap_or(""), "name": row["name"].as_str().unwrap_or("") }))
        .collect();
    Value::Array(peers)
}

fn has_request(row: &Value, request_id: &str) -> bool {
    matches!(row["requests"].get(request_id), Some(value) if !value.is_null())
}

fn next_message_time(row: &Value) -> i64 {
    let last = row["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| json_i64(&message["time"]))
        .unwrap_or(0);
    now_ms().max(last + 1)
}

fn unread_count(row: &Value) -> i64 {
    let read_at = json_i64(&row["readAt"]).unwrap_or(0);
    row["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message["role"] == json!("assistant")
                        && json_i64(&message["time"]).unwrap_or(0) > read_at
                })
                .count() as i64
        })
        .unwrap_or(0)
}

fn summarize(messages: &[Value]) -> String {
    if messages.len() <= 1 {
        return String::new();
    }
    let end = messages.len() - 1;
    let history_start = end.saturating_sub(16);
    let earlier = &messages[..history_start];
    let start = earlier.len().saturating_sub(40);
    chars_tail(
        &earlier[start..]
            .iter()
            .map(|message| {
                format!(
                    "{}: {}",
                    message["role"].as_str().unwrap_or(""),
                    chars_take(message["text"].as_str().unwrap_or(""), 300)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        12_000,
    )
}

fn history_of(messages: &[Value]) -> Vec<(String, String)> {
    if messages.len() <= 1 {
        return Vec::new();
    }
    let end = messages.len() - 1;
    let start = end.saturating_sub(16);
    messages[start..end]
        .iter()
        .filter_map(|message| {
            let role = message["role"].as_str()?;
            if role != "user" && role != "assistant" {
                return None;
            }
            Some((
                role.to_string(),
                chars_take(message["text"].as_str().unwrap_or(""), 8_000),
            ))
        })
        .collect()
}

fn resolve_model(row: &Value) -> String {
    let executor = row["executor"].as_str().unwrap_or("auto");
    let backend = if executor == "auto" {
        row["preference"]["backend"].as_str().unwrap_or("keepwork")
    } else {
        executor
    };
    if backend != "keepwork" {
        return "keepwork-pro".into();
    }
    let model = row["model"].as_str().unwrap_or("").trim();
    if !model.is_empty() {
        return model.to_string();
    }
    let preferred = if row["preference"]["backend"] == "keepwork" {
        row["preference"]["model"].as_str().unwrap_or("").trim()
    } else {
        ""
    };
    if !preferred.is_empty() {
        return preferred.to_string();
    }
    "keepwork-pro".into()
}

fn classify_failure(message: &str) -> (String, Option<String>) {
    if message == "已取消" {
        return ("cancelled".into(), Some(message.to_string()));
    }
    let lower = message.to_lowercase();
    if message.contains('登') && message.contains('录') || lower.contains("login") {
        ("needs-login".into(), Some(message.to_string()))
    } else {
        ("error".into(), Some(message.to_string()))
    }
}

struct Detail {
    before: i64,
    peers: usize,
}

fn project_view(row: &Value, detail: Option<Detail>) -> Value {
    let unread = unread_count(row);
    let execution = answer_execution(row);
    let mut view = row.clone();
    if let Some(object) = view.as_object_mut() {
        for key in [
            "owner",
            "messages",
            "requests",
            "summary",
            "cliApprovalGrant",
            "sales",
        ] {
            object.remove(key);
        }
    }
    if view.get("messaging").map(Value::is_null).unwrap_or(false) {
        view.as_object_mut()
            .map(|object| object.remove("messaging"));
    }
    if !view["schedules"].is_array() {
        view["schedules"] = json!([]);
    }
    if !view["pinned"].is_boolean() {
        view["pinned"] = json!(true);
    }
    view["wechatStatus"] = json!("未绑定");
    view["sales"] = Value::Null;
    view["taskContextVersion"] = json!(1);
    view["groupWorkActive"] = json!(false);
    view["nicknameSync"] = json!({ "pending": false, "warnings": [] });
    view["cliApproval"] = json!({ "scope": "ask" });
    view["channels"] = json!([]);
    view["unread"] = json!(unread);
    if view.get("job").map(|job| job.is_object()).unwrap_or(false) {
        if !view["job"]["pending"].is_array() {
            view["job"]["pending"] = json!([]);
        }
        if let Some(execution) = execution {
            view["job"]["execution"] = execution;
        }
    } else {
        view.as_object_mut().map(|object| object.remove("job"));
    }
    if let Some(detail) = detail {
        let (messages, before) = detail_messages(row, detail.before);
        view["messages"] = Value::Array(messages);
        view["before"] = before.map(Value::from).unwrap_or(Value::Null);
        view["peerCount"] = json!(detail.peers);
    }
    view
}

fn answer_execution(row: &Value) -> Option<Value> {
    let job_id = row["job"]["id"].as_str()?;
    let answer_id = format!("{job_id}-answer");
    row["messages"].as_array().and_then(|messages| {
        messages
            .iter()
            .find(|message| message["id"].as_str() == Some(answer_id.as_str()))
            .and_then(|message| message.get("execution").cloned())
    })
}

fn detail_messages(row: &Value, before: i64) -> (Vec<Value>, Option<i64>) {
    let mut rows: Vec<Value> = row["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|message| json_i64(&message["time"]).unwrap_or(0) < before)
        .collect();
    if rows.len() > 50 {
        rows = rows.split_off(rows.len() - 50);
    }
    let cursor = if rows.len() == 50 {
        json_i64(&rows[0]["time"])
    } else {
        None
    };
    (rows, cursor)
}

#[cfg(unix)]
fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) {}

async fn call_model(
    client: AichatClient,
    prepared: ModelRequest,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    if *cancel.borrow() {
        return Err("已取消".into());
    }
    let url = keepwork_chat_url(&client.base_url)?;
    let token = client.token;
    let mut messages = vec![json!({ "role": "system", "content": prepared.system })];
    for (role, content) in &prepared.history {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({ "role": "user", "content": prepared.text }));
    let payload = json!({
        "model": prepared.model,
        "messages": messages,
        "stream": true,
        "reasoning": false,
        "max_tokens": 4000,
    })
    .to_string();
    let mut request = tokio::spawn(async move {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.to_string())?;
        let response = http
            .post(url)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .header(header::AUTHORIZATION.as_str(), format!("Bearer {token}"))
            .body(payload)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("需要重新登录 AIChat".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Keepwork model request failed ({}); not retried",
                status.as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Keepwork model stream exceeds limit".into());
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        parse_model_output(&content_type, &body)
    });
    tokio::select! {
        _ = cancel.changed() => {
            request.abort();
            Err("已取消".into())
        }
        result = &mut request => match result {
            Ok(inner) => inner,
            Err(_) => Err("已取消".into()),
        }
    }
}

fn parse_model_output(content_type: &str, body: &str) -> Result<String, String> {
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        return parse_sse(body);
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "Keepwork model returned an invalid response".to_string())?;
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Keepwork model returned an invalid response".into());
    }
    if let Some(text) = value.get("result").and_then(Value::as_str) {
        return Ok(text.to_string());
    }
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Ok(text.to_string());
    }
    Err("执行器未返回答案".into())
}

fn parse_sse(body: &str) -> Result<String, String> {
    if body.len() > 8 * 1024 * 1024 {
        return Err("Keepwork model stream exceeds limit".into());
    }
    let mut normalized = body.replace("\r\n", "\n");
    let mut text = String::new();
    let mut finished = false;
    while let Some(boundary) = normalized.find("\n\n") {
        let frame = normalized[..boundary].to_string();
        normalized = normalized[boundary + 2..].to_string();
        consume_frame(&frame, &mut text, &mut finished)?;
    }
    if !normalized.trim().is_empty() {
        return Err("Keepwork model stream ended inside a frame; execution skipped".into());
    }
    if !finished {
        return Err("Keepwork model stream ended without completion; execution skipped".into());
    }
    Ok(text)
}

fn consume_frame(raw: &str, text: &mut String, finished: &mut bool) -> Result<(), String> {
    let data = raw
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| line[5..].trim_start())
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(());
    }
    if data.trim() == "[DONE]" {
        *finished = true;
        return Ok(());
    }
    let event: Value = serde_json::from_str(&data)
        .map_err(|_| "Invalid Keepwork model stream frame".to_string())?;
    if !event.is_object() || event.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Keepwork model stream returned an error".into());
    }
    let reason = event
        .get("stop_reason")
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
        });
    if reason == Some("length") || reason == Some("content_filter") {
        return Err("Keepwork model stream incomplete; execution skipped".into());
    }
    if reason == Some("tool_calls")
        || reason == Some("function_call")
        || event.pointer("/choices/0/delta/tool_calls").is_some()
        || event.pointer("/choices/0/delta/function_call").is_some()
    {
        return Err("本机 Rust 分身尚不支持工具调用，操作未执行。".into());
    }
    if let Some(content) = event.get("result").and_then(Value::as_str) {
        text.push_str(content);
    } else if let Some(content) = event
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        text.push_str(content);
    }
    if reason == Some("stop") || event.get("is_end") == Some(&json!(true)) {
        *finished = true;
    }
    Ok(())
}

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

async fn handle_inner(
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
            let mut warnings = Vec::new();
            if input.get("activateMessaging").and_then(Value::as_bool) == Some(true) {
                warnings.push("本机 Rust 服务尚未托管钉钉/飞书消息");
            }
            if input.get("syncGroupNicknames").and_then(Value::as_bool) == Some(true) {
                warnings.push("本机 Rust 服务尚未同步群昵称");
            }
            if !warnings.is_empty() {
                view["messagingWarning"] = json!(warnings.join("；"));
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
            Ok(ok_json(&json!({
                "version": 1,
                "channels": [],
            })))
        }
        ("GET", Some(id), Some("inbox")) => {
            store.read(&owner, id, i64::MAX)?;
            Ok(ok_json(&json!({
                "name": "",
                "messages": [],
                "conversations": [],
                "before": null,
                "paused": false,
            })))
        }
        ("POST", Some(id), Some(action)) => {
            store.read(&owner, id, i64::MAX)?;
            Ok(ok_json(&post_action(&state, &owner, id, action, &input)?))
        }
        (_, Some(id), Some(_)) => {
            store.read(&owner, id, i64::MAX)?;
            Err(PersonaError::method())
        }
        _ => Err(PersonaError::unknown_op()),
    }
}

fn post_action(
    state: &AppState,
    owner: &str,
    id: &str,
    action: &str,
    input: &Value,
) -> Result<Value, PersonaError> {
    let store = &state.personas;
    match action {
        "messages" => store.submit(&state.presence, owner, id, input),
        "clear" => store.clear(owner, id),
        "read" => store.mark_read(owner, id),
        "cancel" => store.cancel(owner, id),
        "approval-revoke" => store.read(owner, id, i64::MAX),
        "respond" => Err(PersonaError::bad("没有待处理请求")),
        "schedules" => store.schedule(owner, id, input),
        "remove" => store.remove(owner, id),
        "messaging-groups" => Ok(json!({ "groups": [] })),
        "wechat" => Err(PersonaError::unsupported("本机 Rust 服务尚未托管微信")),
        "sales" => Err(PersonaError::unsupported("本机 Rust 服务尚未提供自主销售")),
        "channel-connect" | "channel-login" | "channel-start" | "channel-stop" | "bind"
        | "reply" | "inbox" => Err(PersonaError::unsupported(
            "本机 Rust 服务尚未托管钉钉/飞书消息",
        )),
        _ => Err(PersonaError::unknown_op()),
    }
}

fn owner_hash(headers: &HeaderMap) -> Result<String, PersonaError> {
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

async fn read_json(headers: &HeaderMap, req: Request) -> Result<Value, PersonaError> {
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

fn event_stream(store: Arc<PersonaStore>, owner: &str) -> Response {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_cli_model_preferences_never_reach_keepwork() {
        assert_eq!(
            resolve_model(
                &json!({"executor":"auto","preference":{"backend":"codex","model":"gpt-5-codex"}})
            ),
            "keepwork-pro"
        );
        assert_eq!(
            resolve_model(
                &json!({"executor":"keepwork","preference":{"backend":"claude","model":"sonnet"}})
            ),
            "keepwork-pro"
        );
        assert_eq!(
            resolve_model(
                &json!({"executor":"auto","preference":{"backend":"keepwork","model":"keepwork-fast"}})
            ),
            "keepwork-fast"
        );
        assert_eq!(
            resolve_model(&json!({"executor":"keepwork","model":"keepwork-pro"})),
            "keepwork-pro"
        );
    }

    #[test]
    fn snapshots_do_not_advertise_unimplemented_execution_capabilities() {
        let view = project_view(&json!({"id":"role","prompt":"write files"}), None);
        assert_eq!(view["taskContextVersion"], 1);
        for field in [
            "peerMessagingVersion",
            "roleWriteVersion",
            "wechatVersion",
            "salesRuntimeVersion",
            "messagingVersion",
            "writePolicy",
        ] {
            assert!(
                view.get(field).is_none(),
                "unimplemented capability {field}"
            );
        }
    }

    #[test]
    fn unimplemented_tools_or_truncated_streams_do_not_become_successful_answers() {
        let success =
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n";
        assert_eq!(
            parse_model_output("text/event-stream", success).unwrap(),
            "你好"
        );
        assert!(parse_model_output(
            "text/event-stream",
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n"
        )
        .is_err());
        assert!(parse_model_output(
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\ndata: [DONE]\n\n"
        )
        .is_err());
        assert!(
            parse_model_output("text/event-stream", "data: {\"result\":\"partial\"}\n\n").is_err()
        );
    }

    #[tokio::test]
    async fn persistence_failure_does_not_accept_or_execute_a_message() {
        let dir = std::env::temp_dir().join(format!("kp-persona-storage-{}", uuid::Uuid::new_v4()));
        let backup = dir.with_extension("backup");
        let store = PersonaStore::open(dir.clone());
        let presence = Arc::new(PresenceState::new());
        let owner = "ab".repeat(32);
        store
            .upsert(
                &presence,
                &owner,
                &json!({"id":"default-persona","name":"我的分身","root":""}),
            )
            .unwrap();
        std::fs::rename(&dir, &backup).unwrap();
        std::fs::write(&dir, "storage unavailable").unwrap();
        let error = store
            .submit(
                &presence,
                &owner,
                "default-persona",
                &json!({"requestId":"retain-draft","text":"HI"}),
            )
            .unwrap_err();
        assert_eq!(error.status, 500);
        assert_eq!(error.code, Some("PERSISTENCE_ERROR"));
        let row = store.read(&owner, "default-persona", i64::MAX).unwrap();
        assert_eq!(row["messages"].as_array().unwrap().len(), 0);
        assert!(row.get("job").is_none());
        assert!(store.lock().cancels.is_empty());
        std::fs::remove_file(dir).unwrap();
        std::fs::remove_dir_all(backup).unwrap();
    }

    #[test]
    fn next_run_matches_the_zone_clock() {
        let now = chrono::Utc::now().timestamp_millis();
        let next = next_persona_run("08:30", "Asia/Shanghai", now)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        let formatted = chrono::DateTime::from_timestamp_millis(next)
            .unwrap()
            .with_timezone(&tz)
            .format("%H:%M")
            .to_string();
        assert_eq!(formatted, "08:30");
        assert!(next > now);
        assert!(next_persona_run("24:00", "UTC", now).is_err());
        assert!(next_persona_run("09:00", "Not/AZone", now).is_err());
    }

    #[test]
    fn messaging_requires_a_group_when_enabled() {
        let error = agent_messaging(&json!({
            "version": 1,
            "enabled": true,
            "groups": [],
        }))
        .unwrap_err();
        assert_eq!(error.message, "请先选择至少一个主要群聊");
        let ok = agent_messaging(&json!({
            "version": 1,
            "enabled": true,
            "groups": [{ "channel": "dingtalk", "account": "corp:user", "id": "g1", "name": "群" }],
        }))
        .unwrap();
        assert_eq!(ok["groups"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn chat_url_stays_on_keepwork() {
        assert!(keepwork_chat_url("https://api.keepwork.com/core/v0")
            .unwrap()
            .ends_with("/gpt/chat"));
        assert!(keepwork_chat_url("http://api.keepwork.com/core/v0").is_err());
        assert!(keepwork_chat_url("https://evil.example/core/v0").is_err());
    }

    #[test]
    fn upsert_round_trips_without_the_owner_field() {
        let dir = std::env::temp_dir().join(format!(
            "kp-persona-unit-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = PersonaStore::open(dir.clone());
        let presence = PresenceState::new();
        let owner = "ab".repeat(32);
        let view = store
            .upsert(
                &presence,
                &owner,
                &json!({
                    "id": "default-persona",
                    "name": "我的分身",
                    "avatar": "🧠",
                    "prompt": "hi",
                    "executor": "auto",
                    "model": "",
                    "pinned": true,
                    "order": 0,
                    "root": "",
                }),
            )
            .unwrap();
        assert_eq!(view["name"], "我的分身");
        assert!(view.get("owner").is_none());
        assert!(view.get("messages").is_none());
        assert_eq!(view["wechatStatus"], "未绑定");
        assert_eq!(store.list(&owner)["agents"].as_array().unwrap().len(), 1);
        let saved = std::fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .ok()
                .and_then(|entry| entry.path().extension().map(|ext| ext == "json"))
                .unwrap_or(false)
        });
        assert!(saved);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
