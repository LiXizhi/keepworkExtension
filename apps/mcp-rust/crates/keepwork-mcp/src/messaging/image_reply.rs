//! Explicit user-operated image attachments. Image bytes never enter the inbox store.
use super::*;
use super::{policy::Incoming, service::Inner};
use base64::{engine::general_purpose::STANDARD, Engine};

const MAX_IMAGE: usize = 5 * 1024 * 1024;
const TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

pub(crate) fn capability() -> Value {
    json!({"version":1,"transport":"file","maxBytes":MAX_IMAGE,"mimeTypes":TYPES})
}

struct Image {
    name: String,
    mime: String,
    extension: &'static str,
    bytes: Vec<u8>,
    digest: String,
}

impl Image {
    fn parse(input: &Value) -> Result<Self, MessageError> {
        let name = input["name"].as_str().unwrap_or("");
        let mime = input["mimeType"].as_str().unwrap_or("");
        let encoded = input["base64"].as_str().unwrap_or("");
        if name.trim().is_empty()
            || name.chars().count() > 160
            || matches!(name, "." | "..")
            || name
                .chars()
                .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
            || !TYPES.contains(&mime)
        {
            return Err(MessageError::bad(
                "请选择 PNG、JPEG、GIF 或 WebP 图片，文件名不能包含路径",
            ));
        }
        if encoded.is_empty() || encoded.len() > MAX_IMAGE.div_ceil(3) * 4 {
            return Err(MessageError::bad("图片不能为空且不能超过 5 MiB"));
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| MessageError::bad("图片数据无效"))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE {
            return Err(MessageError::bad("图片不能为空且不能超过 5 MiB"));
        }
        let extension = match mime {
            "image/png"
                if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    && bytes.len() >= 24
                    && &bytes[12..16] == b"IHDR" =>
            {
                "png"
            }
            "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") && bytes.len() >= 4 => "jpg",
            "image/gif"
                if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
                    && bytes.len() >= 13 =>
            {
                "gif"
            }
            "image/webp"
                if bytes.len() >= 20 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" =>
            {
                "webp"
            }
            _ => return Err(MessageError::bad("图片内容与类型不符或图片已损坏")),
        };
        let digest = format!("{:x}", Sha256::digest(&bytes));
        Ok(Self {
            name: name.into(),
            mime: mime.into(),
            extension,
            bytes,
            digest,
        })
    }

    fn metadata(&self) -> Value {
        json!({"name":self.name,"mimeType":self.mime,"size":self.bytes.len(),
            "sha256":self.digest,"transport":"file"})
    }
}

/// Server-generated directory, never a client-supplied local path. DWS confines --file to cwd.
struct StagedImage(PathBuf);
impl StagedImage {
    fn create(root: &str, image: &Image) -> Result<(Self, String), MessageError> {
        let relative = format!(".keepwork-reply-{}", uuid::Uuid::new_v4());
        let directory = Path::new(root).join(&relative);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| MessageError::bad("无法准备图片附件，请检查工作目录权限"))?;
        let staged = Self(directory);
        let filename = format!("image.{}", image.extension);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(staged.0.join(&filename))
            .map_err(|_| MessageError::bad("无法准备图片附件"))?;
        file.write_all(&image.bytes)
            .map_err(|_| MessageError::bad("无法准备图片附件"))?;
        Ok((staged, format!("{relative}/{filename}")))
    }
}
impl Drop for StagedImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn receipt(value: &Value, depth: usize) -> bool {
    if depth > 8 || !receipt_confirmed(value) {
        return false;
    }
    if ["openTaskId", "openMessageId", "messageId"]
        .iter()
        .any(|key| value[key].as_str().is_some_and(|s| !s.trim().is_empty()))
    {
        return true;
    }
    ["result", "data"]
        .iter()
        .any(|key| value.get(key).is_some_and(|v| receipt(v, depth + 1)))
}

fn receipt_confirmed(value: &Value) -> bool {
    value.is_object()
        && value["success"] != false
        && value.get("error").is_none_or(Value::is_null)
        && ![
            "pending",
            "sending",
            "queued",
            "processing",
            "failed",
            "failure",
            "cancelled",
            "canceled",
            "rejected",
        ]
        .contains(
            &value["status"]
                .as_str()
                .or_else(|| value["state"].as_str())
                .unwrap_or("")
                .to_lowercase()
                .as_str(),
        )
}

/// The send task and remote message have different namespaces. Traverse only reviewed envelopes.
fn receipt_ids(
    value: &Value,
    conversation: &str,
    require_conversation: bool,
    depth: usize,
    allow_remote_conversation: bool,
) -> (Option<String>, Option<String>, Option<String>) {
    if depth > 8 || !receipt_confirmed(value) {
        return (None, None, None);
    }
    let id = |key: &str| {
        value[key]
            .as_str()
            .filter(|id| !id.trim().is_empty() && id.len() <= 2048)
            .map(str::to_string)
    };
    let mut task = id("openTaskId");
    let cid = id("openConversationId").or_else(|| id("conversationId"));
    if cid.as_deref().is_some_and(|cid| cid != conversation) && !allow_remote_conversation {
        return (task, None, None);
    }
    let mut message = if !require_conversation || cid.is_some() {
        id("openMessageId").or_else(|| id("messageId"))
    } else {
        None
    };
    let mut remote_conversation = message
        .as_ref()
        .and_then(|_| cid.filter(|cid| cid != conversation));
    for key in ["result", "data"] {
        let (nested_task, nested_message, nested_conversation) = receipt_ids(
            &value[key],
            conversation,
            require_conversation,
            depth + 1,
            allow_remote_conversation,
        );
        task = task.or(nested_task);
        if message.is_none() && nested_message.is_some() {
            message = nested_message;
            remote_conversation = nested_conversation;
        }
    }
    (task, message, remote_conversation)
}

pub(crate) fn coalesce_image_echoes(messages: &mut Vec<Value>) {
    let mut aliases: HashSet<(String, String)> = HashSet::new();
    for row in messages
        .iter()
        .filter(|row| row["direction"] == "out" && row["image"].is_object())
    {
        if let Some(message) = row["remoteMessageId"].as_str() {
            for key in ["conversation", "remoteConversationId"] {
                if let Some(cid) = row[key].as_str() {
                    aliases.insert((cid.into(), message.into()));
                }
            }
        }
    }
    messages.retain(|row| {
        row["direction"] != "out"
            || row["image"].is_object()
            || !(matches!(row["state"].as_str(), Some("synced" | "recovered"))
                || row["remoteEvent"] == true)
            || !aliases.contains(&(
                row["conversation"].as_str().unwrap_or("").into(),
                row["id"].as_str().unwrap_or("").into(),
            ))
    });
}

async fn task_message_id(
    root: &str,
    profile: &str,
    task: &str,
    conversation: &str,
    allow_remote_conversation: bool,
) -> Option<(String, Option<String>)> {
    let args = vec![
        "chat".into(),
        "message".into(),
        "query-send-status".into(),
        "--open-task-id".into(),
        task.into(),
        "--profile".into(),
        profile.into(),
        "--format".into(),
        "json".into(),
        "--timeout".into(),
        "4".into(),
    ];
    let value = tokio::time::timeout(std::time::Duration::from_secs(5), dws_call(&args, root))
        .await
        .ok()?
        .ok()?;
    let (_, message, cid) = receipt_ids(&value, conversation, true, 0, allow_remote_conversation);
    Some((message?, cid))
}

impl MessagingService {
    /// Optional read-only task metadata, capped at four concurrent lookups per refresh.
    pub(crate) async fn resolve_image_tasks(&self, binding: &super::service::Binding) {
        let rows: Vec<(String, String, String, bool)> = {
            let inner = self.lock();
            inner
                .inbox
                .get(&binding.id)
                .into_iter()
                .flat_map(|box_| box_.messages.iter().rev())
                .filter(|row| {
                    row["direction"] == "out"
                        && row["image"].is_object()
                        && row["remoteMessageId"].as_str().is_none()
                })
                .filter_map(|row| {
                    Some((
                        row["id"].as_str()?.into(),
                        row["conversation"].as_str()?.into(),
                        row["remoteTaskId"].as_str()?.into(),
                        row["kind"] == "direct" && row["conversation"] == row["sender"],
                    ))
                })
                .take(4)
                .collect()
        };
        let mut lookups = tokio::task::JoinSet::new();
        for (id, conversation, task, allow_remote_conversation) in rows {
            let root = binding.root.clone();
            let profile = binding.profile.clone();
            lookups.spawn(async move {
                let message = task_message_id(
                    &root,
                    &profile,
                    &task,
                    &conversation,
                    allow_remote_conversation,
                )
                .await;
                (id, conversation, task, message)
            });
        }
        while let Some(outcome) = lookups.join_next().await {
            let Ok((id, conversation, task, Some((message, cid)))) = outcome else {
                continue;
            };
            let mut inner = self.lock();
            if inner.closed
                || !inner.runs.get(&binding.id).is_some_and(|run| {
                    run.binding.root == binding.root
                        && run.binding.profile == binding.profile
                        && run.binding.channel == "dingtalk"
                        && run.binding.agent_owner == binding.agent_owner
                        && run.binding.agent_id == binding.agent_id
                        && run.binding.peers == binding.peers
                })
            {
                return;
            }
            if let Some(box_) = inner.inbox.get_mut(&binding.id) {
                if let Some(row) = box_.messages.iter_mut().find(|row| {
                    row["id"] == id
                        && row["conversation"] == conversation
                        && row["remoteTaskId"] == task
                        && row["direction"] == "out"
                        && row["image"].is_object()
                }) {
                    row["remoteMessageId"] = json!(message);
                    if let Some(cid) = cid {
                        row["remoteConversationId"] = json!(cid);
                    }
                }
                coalesce_image_echoes(&mut box_.messages);
            }
            self.save_inbox(&inner);
        }
    }
    /// Persist the no-replay ledger before invoking any external mutation.
    fn save_image_ledger(&self, inner: &Inner) -> Result<(), MessageError> {
        let map: serde_json::Map<String, Value> = inner
            .inbox
            .iter()
            .map(|(id, box_)| (id.clone(), box_.to_json()))
            .collect();
        let path = self.home.join("inbox.json");
        let tmp = self
            .home
            .join(format!("inbox-image-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(Value::Object(map).to_string().as_bytes())?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&tmp, &path)
        })();
        let _ = std::fs::remove_file(tmp);
        result.map_err(|_| MessageError::bad("无法保存发送状态，图片尚未发送"))
    }

    pub async fn manual_image_reply(
        &self,
        owner: &str,
        agent_id: &str,
        id: &str,
        conversation: &str,
        request_id: &str,
        input: &Value,
    ) -> Result<Value, MessageError> {
        self.assert_agent_binding(owner, agent_id, id)?;
        let assigned_groups = self.personas.persona_messaging_groups(owner, agent_id);
        if request_id.is_empty()
            || request_id.len() > 160
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || conversation.is_empty()
        {
            return Err(MessageError::bad("Invalid image reply"));
        }
        let image = Image::parse(input)?;
        let (root, profile) = {
            let inner = self.lock();
            let run = inner
                .runs
                .get(id)
                .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
            if run.binding.channel != "dingtalk" {
                return Err(MessageError::unsupported(
                    "此渠道尚不支持图片附件，文字仍可发送",
                ));
            }
            (run.binding.root.clone(), run.binding.profile.clone())
        };
        let (staged, relative) = StagedImage::create(&root, &image)?;
        let (target, initial) = {
            let mut inner = self.lock();
            if inner.closed {
                return Err(MessageError::bad("消息服务已停止"));
            }
            let run = inner
                .runs
                .get(id)
                .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
            if run.binding.root != root
                || run.binding.profile != profile
                || run.binding.channel != "dingtalk"
            {
                return Err(MessageError::bad("渠道已切换，请重新打开此会话"));
            }
            let assigned = assigned_groups.iter().any(|group| {
                group["id"] == conversation
                    && group["account"] == profile
                    && group["channel"].as_str().unwrap_or("dingtalk") == "dingtalk"
            });
            if agent_id != "default-persona" && !assigned {
                return Err(MessageError::bad("群聊未分配给此智能体"));
            }
            if let Some(previous) = inner.inbox.get(id).and_then(|box_| {
                box_.messages
                    .iter()
                    .find(|row| row["id"].as_str() == Some(request_id) && row["direction"] == "out")
            }) {
                if previous["conversation"] != conversation || previous["image"] != image.metadata()
                {
                    return Err(MessageError::bad("此请求编号已用于其他内容，请勿重复发送"));
                }
                let mut previous = previous.clone();
                if previous["state"] == "sending" {
                    previous["state"] = json!("unknown");
                }
                return Ok(previous);
            }
            if inner
                .inbox
                .get(id)
                .is_some_and(|box_| box_.sends.contains_key(request_id))
            {
                return Err(MessageError::bad("此请求编号已使用，请在钉钉核实发送结果"));
            }
            let active = inner
                .inbox
                .values()
                .flat_map(|box_| &box_.messages)
                .filter(|row| row["state"] == "sending" && row.get("image").is_some())
                .count();
            if active >= 4 {
                return Err(MessageError::bad("图片发送繁忙，请稍后重试"));
            }
            let box_ = inner.inbox.entry(id.to_string()).or_default();
            let target_row = box_
                .messages
                .iter()
                .rev()
                .find(|row| row["conversation"] == conversation && row["direction"] == "in");
            if target_row.is_none() && !(agent_id != "default-persona" && assigned) {
                return Err(MessageError::bad("请选择已有会话"));
            }
            let target = Incoming {
                id: request_id.into(),
                conversation: conversation.into(),
                sender: target_row
                    .and_then(|row| row["sender"].as_str())
                    .unwrap_or("")
                    .into(),
                text: String::new(),
                time: super::policy::now_ms(),
                kind: target_row
                    .and_then(|row| row["kind"].as_str())
                    .unwrap_or("group")
                    .into(),
                thread: None,
                automated: false,
                mentioned_self: false,
                recovered: false,
            };
            if target.kind == "direct" && target.sender.is_empty() {
                return Err(MessageError::bad("此会话缺少收件人，图片尚未发送"));
            }
            let row = json!({"id":request_id,"conversation":conversation,"sender":target.sender,
                "text":format!("[图片附件] {}",image.name),"time":target.time,"kind":target.kind,
                "direction":"out","state":"sending","image":image.metadata()});
            let already_paused = box_.paused.iter().any(|key| key == conversation);
            if !already_paused {
                box_.paused.push(conversation.into());
            }
            box_.messages.push(row.clone());
            box_.sends.insert(request_id.into(), "unknown".into());
            if let Err(error) = self.save_image_ledger(&inner) {
                let box_ = inner.inbox.get_mut(id).unwrap();
                box_.messages
                    .retain(|m| m["id"] != request_id || m["direction"] != "out");
                box_.sends.remove(request_id);
                if !already_paused {
                    box_.paused.retain(|key| key != conversation);
                }
                return Err(error);
            }
            if let Some(run) = inner.runs.get_mut(id) {
                if let Some(queue) = run.queues.remove(conversation) {
                    for job in queue {
                        if let Some(receipt) = run
                            .receipts
                            .iter_mut()
                            .find(|row| row["id"].as_str() == Some(job.receipt_id.as_str()))
                        {
                            receipt["state"] = json!("cancelled");
                        }
                    }
                }
                self.persist_run(run);
            }
            (target, row)
        };
        let args = vec![
            "chat".into(),
            "+messages-send".into(),
            "--as".into(),
            "user".into(),
            if target.kind == "direct" {
                "--open-dingtalk-id".into()
            } else {
                "--group".into()
            },
            if target.kind == "direct" {
                target.sender
            } else {
                target.conversation
            },
            "--msg-type".into(),
            "file".into(),
            "--file".into(),
            relative,
            "--idempotency-key".into(),
            format!("{request_id}-image"),
            "--profile".into(),
            profile.clone(),
            "-f".into(),
            "json".into(),
            "--yes".into(),
        ];
        let outcome = dws_call(&args, &root).await;
        drop(staged);
        let (state, error) = match &outcome {
            Ok(value) if receipt(value, 0) => ("sent", None),
            Err(error) if !error.uncertain => (
                "failed",
                Some("钉钉拒绝发送图片附件，请检查登录与权限后重试"),
            ),
            _ => ("unknown", Some("发送结果未知，请在钉钉核实，勿重复发送")),
        };
        let mut result = initial;
        result["state"] = json!(state);
        if let Ok(value) = &outcome {
            let (task, message, cid) = receipt_ids(
                value,
                conversation,
                false,
                0,
                result["kind"] == "direct" && result["sender"] == conversation,
            );
            if let Some(task) = task {
                result["remoteTaskId"] = json!(task);
            }
            if let Some(message) = message {
                result["remoteMessageId"] = json!(message);
            }
            if let Some(cid) = cid {
                result["remoteConversationId"] = json!(cid);
            }
        }
        if let Some(error) = error {
            result["error"] = json!(error);
        }
        {
            // Preserve the exact task before optional lookup so a restart can finish correlation without resending.
            let mut inner = self.lock();
            if let Some(box_) = inner.inbox.get_mut(id) {
                if let Some(row) = box_
                    .messages
                    .iter_mut()
                    .find(|row| row["id"] == request_id && row["direction"] == "out")
                {
                    *row = result.clone();
                }
            }
            let _ = self.save_image_ledger(&inner);
        }
        if result["remoteMessageId"].as_str().is_none() {
            if let Some(task) = result["remoteTaskId"].as_str() {
                if let Some((message, cid)) = task_message_id(
                    &root,
                    &profile,
                    task,
                    conversation,
                    result["kind"] == "direct" && result["sender"] == conversation,
                )
                .await
                {
                    result["remoteMessageId"] = json!(message);
                    if let Some(cid) = cid {
                        result["remoteConversationId"] = json!(cid);
                    }
                }
            }
        }
        let mut inner = self.lock();
        let box_ = inner.inbox.entry(id.into()).or_default();
        box_.sends.insert(request_id.into(), state.into());
        if let Some(row) = box_
            .messages
            .iter_mut()
            .find(|row| row["id"] == request_id && row["direction"] == "out")
        {
            *row = result.clone();
        }
        coalesce_image_echoes(&mut box_.messages);
        // The pre-send unknown ledger remains safe even if this final save fails.
        self.save_inbox(&inner);
        let owners = self.persist_run_and_notify(&mut inner, id);
        drop(inner);
        self.bump_owners(owners);
        Ok(result)
    }
}

#[cfg(test)]
mod correlation_tests {
    use super::*;

    #[test]
    fn failed_or_pending_envelopes_never_identify_a_message_to_merge() {
        for value in [
            json!({"success":false,"openMessageId":"remote"}),
            json!({"error":{"code":"failed"},"result":{"openMessageId":"remote"}}),
            json!({"result":{"status":"pending","openMessageId":"remote"}}),
            json!({"result":{"state":"sending","openMessageId":"remote"}}),
        ] {
            assert!(!receipt(&value, 0));
            assert_eq!(
                receipt_ids(&value, "group", false, 0, false),
                (None, None, None)
            );
        }
        assert_eq!(
            receipt_ids(&json!({"openTaskId":"task"}), "group", false, 0, false),
            (Some("task".into()), None, None)
        );
        assert_eq!(
            receipt_ids(
                &json!({"openMessageId":"remote","openConversationId":"wrong"}),
                "group",
                true,
                0,
                false
            ),
            (None, None, None)
        );
        assert_eq!(
            receipt_ids(
                &json!({"openMessageId":"top","result":{"openMessageId":"nested","openConversationId":"other-cid"}}),
                "peer",
                false,
                0,
                true
            ),
            (None, Some("top".into()), None)
        );
        let mut messages = vec![
            json!({"id":"local-image","conversation":"group","direction":"out","image":{"name":"image.png"},"remoteMessageId":"remote"}),
            json!({"id":"remote","conversation":"group","direction":"out","state":"synced"}),
            json!({"id":"remote","conversation":"group","direction":"out","state":"sent","text":"independent local request"}),
        ];
        coalesce_image_echoes(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["text"], "independent local request");
    }
}
