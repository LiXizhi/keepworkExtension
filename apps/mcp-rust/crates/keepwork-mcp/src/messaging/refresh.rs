//! Explicit, receive-only DingTalk history refresh. Ordinary inbox reads stay local.

use super::dingtalk::{dingtalk_call_checked, dingtalk_identity_matches, dingtalk_status};
use super::policy::{automated_text, now_ms};
use super::service::{Binding, Inner};
use super::*;
use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

const DAY: i64 = 86_400_000;
const OVERLAP: i64 = 600_000;

#[derive(Clone, Serialize, Deserialize)]
struct Checkpoint {
    since: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<Window>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Window {
    start: i64,
    end: i64,
    cursor: String,
    #[serde(default)]
    visited: Vec<String>,
}

fn atomic_json(path: &Path, value: &Value) -> Result<(), MessageError> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(value.to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(MessageError::bad("钉钉刷新记录保存失败，未跳过补收位置"));
    }
    Ok(())
}

fn checkpoint(path: &Path, seed: i64) -> Result<Checkpoint, MessageError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let state: Checkpoint = serde_json::from_slice(&bytes)
                .map_err(|_| MessageError::bad("钉钉补收记录无法读取，未跳过历史消息"))?;
            if state.since <= 0
                || state.pending.as_ref().is_some_and(|window| {
                    window.start <= 0
                        || window.end <= window.start
                        || window.end - window.start > DAY
                        || window.cursor.is_empty()
                        || window.cursor.len() > 16_384
                        || window.visited.len() > 10_000
                })
            {
                return Err(MessageError::bad("钉钉补收记录无法读取，未跳过历史消息"));
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Checkpoint {
            since: (seed / 1000 * 1000).max(1),
            pending: None,
        }),
        Err(_) => Err(MessageError::bad("钉钉补收记录无法读取，未跳过历史消息")),
    }
}

fn wall_time(time: i64) -> Result<String, MessageError> {
    DateTime::<Utc>::from_timestamp_millis(time)
        .map(|time| {
            (time + chrono::Duration::hours(8))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .ok_or_else(|| MessageError::bad("Invalid DingTalk history time"))
}

fn message_time(value: &Value) -> Option<i64> {
    let time = if let Some(time) = value.as_i64() {
        if time < 1_000_000_000_000 {
            time.checked_mul(1000)?
        } else {
            time
        }
    } else {
        let text = value.as_str()?;
        DateTime::parse_from_rfc3339(text)
            .map(|time| time.timestamp_millis())
            .ok()
            .or_else(|| {
                let wall = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").ok()?;
                FixedOffset::east_opt(8 * 3600)?
                    .from_local_datetime(&wall)
                    .single()
                    .map(|time| time.timestamp_millis())
            })?
    };
    (time > 0).then_some(time)
}

fn history_page(
    value: &Value,
    self_id: &str,
    user_id: &str,
) -> Result<(Vec<Value>, String), MessageError> {
    let incomplete = || MessageError::bad("钉钉历史消息读取不完整，保留补收位置");
    let result = &value["result"];
    if value["success"] != true
        || value["partial"].as_bool() == Some(true)
        || value["failures"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    {
        return Err(incomplete());
    }
    let has_more = result["hasMore"].as_bool().ok_or_else(incomplete)?;
    let chats = result["conversationMessagesList"]
        .as_array()
        .ok_or_else(incomplete)?;
    let mut messages = Vec::new();
    for chat in chats {
        let direct = chat["singleChat"].as_bool().ok_or_else(incomplete)?;
        for row in chat["messages"].as_array().ok_or_else(incomplete)? {
            let id = row["openMessageId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(incomplete)?;
            let conversation = row["openConversationId"]
                .as_str()
                .or_else(|| chat["openConversationId"].as_str())
                .filter(|id| !id.is_empty())
                .ok_or_else(incomplete)?;
            let sender = row["senderOpenDingTalkId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(incomplete)?;
            let time = message_time(&row["createTime"]).ok_or_else(incomplete)?;
            let text = row["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .unwrap_or("[非文本消息]");
            let automated = row["sendType"].as_str().is_some_and(|kind| {
                ["robot", "bot", "app"]
                    .iter()
                    .any(|v| kind.eq_ignore_ascii_case(v))
            }) || text == "[非文本消息]"
                || automated_text(text);
            messages.push(json!({
                "id":id,"conversation":conversation,"sender":sender,"time":time,
                "text":text.chars().take(16_000).collect::<String>(),"kind":if direct {"direct"} else {"group"},
                "direction":if sender == self_id || sender == user_id || row["sender"].as_str() == Some(user_id) {"out"} else {"in"},
                "automated":automated,"state":"synced",
            }));
        }
    }
    let next = if has_more {
        match &result["nextCursor"] {
            Value::String(cursor) => cursor.clone(),
            Value::Number(cursor) => cursor.to_string(),
            _ => String::new(),
        }
    } else {
        String::new()
    };
    if has_more && (next.is_empty() || next == "0" || next.len() > 16_384) {
        return Err(incomplete());
    }
    Ok((messages, next))
}

async fn history_self(root: &str, profile: &str, status: &Value) -> Result<String, MessageError> {
    if let Some(id) = status["identity"]["open_dingtalk_id"]
        .as_str()
        .filter(|id| !id.is_empty())
    {
        return Ok(id.to_string());
    }
    let user = profile.split(':').nth(1).unwrap_or("");
    let value = dingtalk_call_checked(
        root,
        &[
            "chat".into(),
            "+search-msg".into(),
            "--senders".into(),
            user.into(),
            "--limit".into(),
            "1".into(),
            "--no-reactions".into(),
            "--profile".into(),
            profile.into(),
            "--format".into(),
            "json".into(),
        ],
    )
    .await?;
    let sender = value["resolvedFilters"]["senders"]
        .as_array()
        .filter(|rows| rows.len() == 1)
        .map(|rows| &rows[0]);
    sender
        .filter(|row| {
            row["status"] == "resolved"
                && row["profile"] == profile
                && row["selected"]["userId"] == user
        })
        .and_then(|row| row["selected"]["openDingTalkId"].as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| MessageError::bad("无法核实本人钉钉身份，暂不补收"))
}

fn still_current(inner: &Inner, binding: &Binding, generation: u64) -> bool {
    !inner.closed
        && inner.runs.get(&binding.id).is_some_and(|run| {
            run.generation == generation
                && run.binding.profile == binding.profile
                && run.binding.root == binding.root
                && run.binding.channel == binding.channel
                && run.binding.agent_owner == binding.agent_owner
                && run.binding.agent_id == binding.agent_id
                && run.binding.peers == binding.peers
        })
}

impl MessagingService {
    /// One persisted page, without admitting any automatic reply or touching read/paused state.
    pub async fn inbox_refresh(
        self: &Arc<Self>,
        owner: &str,
        agent_id: &str,
        id: &str,
    ) -> Result<Value, MessageError> {
        self.assert_agent_binding(owner, agent_id, id)?;
        let gate = self
            .refresh_gates
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _guard = gate.try_lock_owned().map_err(|_| MessageError {
            status: 409,
            message: "正在刷新钉钉消息，请稍后重试".into(),
            code: None,
            conflict: None,
        })?;
        let (binding, generation) = {
            let inner = self.lock();
            let run = inner
                .runs
                .get(id)
                .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
            if inner.closed {
                return Err(MessageError::bad("Service closed"));
            }
            if run.binding.channel != "dingtalk" {
                return Err(MessageError::unsupported(
                    "This channel does not support explicit inbox refresh",
                ));
            }
            (run.binding.clone(), run.generation)
        };
        let status = dingtalk_status(&binding.root, &binding.profile).await?;
        if !dingtalk_identity_matches(&status, &binding.profile) {
            return Err(MessageError::bad(
                "DWS identity does not match configured profile",
            ));
        }
        let self_id = history_self(&binding.root, &binding.profile, &status).await?;
        self.assert_agent_binding(owner, agent_id, id)?;
        let path = self.home.join(format!("{id}.refresh-cursor.json"));
        let now = now_ms() / 1000 * 1000;
        let (mut state, window) = {
            let inner = self.lock();
            if !still_current(&inner, &binding, generation) {
                return Err(MessageError::bad("DingTalk refresh cancelled"));
            }
            // Seed and endpoint share one clock sample so slow identity checks
            // cannot turn the first page into an artificial backlog window.
            let mut state = checkpoint(&path, now - DAY + OVERLAP)?;
            if state.pending.is_none() {
                let start = (state.since - OVERLAP).max(1);
                let end = now.min(start.saturating_add(DAY));
                if end <= state.since {
                    return Ok(json!({"status":"current","since":state.since,"imported":0}));
                }
                state.pending = Some(Window {
                    start,
                    end,
                    cursor: "0".into(),
                    visited: Vec::new(),
                });
                atomic_json(&path, &serde_json::to_value(&state).unwrap())?;
            }
            let window = state.pending.clone().unwrap();
            (state, window)
        };
        let value = dingtalk_call_checked(
            &binding.root,
            &[
                "chat".into(),
                "message".into(),
                "list-all".into(),
                "--start".into(),
                wall_time(window.start)?,
                "--end".into(),
                wall_time(window.end)?,
                "--cursor".into(),
                window.cursor.clone(),
                "--limit".into(),
                "100".into(),
                "--profile".into(),
                binding.profile.clone(),
                "--format".into(),
                "json".into(),
            ],
        )
        .await?;
        let (rows, next) = history_page(
            &value,
            &self_id,
            binding.profile.split(':').nth(1).unwrap_or(""),
        )?;
        if !next.is_empty() && (next == window.cursor || window.visited.contains(&next)) {
            return Err(MessageError::bad("钉钉历史消息分页没有前进"));
        }
        self.assert_agent_binding(owner, agent_id, id)?;
        let owners;
        let imported;
        {
            let mut inner = self.lock();
            if !still_current(&inner, &binding, generation) {
                return Err(MessageError::bad("DingTalk refresh cancelled"));
            }
            let mut snapshot: serde_json::Map<String, Value> = inner
                .inbox
                .iter()
                .map(|(id, b)| (id.clone(), b.to_json()))
                .collect();
            let mut box_value = inner
                .inbox
                .get(id)
                .map(|b| b.to_json())
                .unwrap_or_else(|| json!({"messages":[],"paused":[],"read":{}}));
            let messages = box_value["messages"].as_array_mut().unwrap();
            let mut keys: HashSet<(String, String)> = messages
                .iter()
                .map(|row| {
                    (
                        row["conversation"].as_str().unwrap_or("").into(),
                        row["id"].as_str().unwrap_or("").into(),
                    )
                })
                .collect();
            imported = rows
                .into_iter()
                .filter(|row| {
                    row["time"]
                        .as_i64()
                        .is_some_and(|time| time >= window.start && time <= window.end)
                })
                .filter(|row| {
                    keys.insert((
                        row["conversation"].as_str().unwrap().into(),
                        row["id"].as_str().unwrap().into(),
                    ))
                })
                .map(|row| {
                    messages.push(row);
                    1usize
                })
                .sum::<usize>();
            messages.sort_by(|a, b| {
                a["time"]
                    .as_i64()
                    .cmp(&b["time"].as_i64())
                    .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            });
            snapshot.insert(id.to_string(), box_value.clone());
            atomic_json(&self.home.join("inbox.json"), &Value::Object(snapshot))?;
            inner.inbox.insert(
                id.to_string(),
                super::service::InboxStore::from_json(&box_value),
            );
            if next.is_empty() {
                state = Checkpoint {
                    since: window.end,
                    pending: None,
                };
            } else {
                let mut pending = window.clone();
                pending.visited.push(pending.cursor.clone());
                pending.cursor = next.clone();
                state.pending = Some(pending);
            }
            atomic_json(&path, &serde_json::to_value(&state).unwrap())?;
            owners = binding
                .agent_owner
                .iter()
                .cloned()
                .chain(
                    binding
                        .peers
                        .iter()
                        .filter_map(|peer| peer["owner"].as_str().map(str::to_string)),
                )
                .collect();
        }
        self.bump_events();
        self.bump_owners(owners);
        Ok(
            json!({"status":if !next.is_empty() || window.end < now {"syncing"} else {"current"},"since":state.since,"imported":imported}),
        )
    }
}
