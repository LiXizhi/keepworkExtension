//! Optional explicit acknowledgement of a single DingTalk conversation red point.

use super::dingtalk::{dingtalk_call_checked, dingtalk_identity_matches, dingtalk_status};
use super::policy::now_ms;
use super::*;

fn failed(value: &Value) -> bool {
    value.get("error").is_some_and(|error| !error.is_null())
        || value["isError"].as_bool() == Some(true)
        || value["success"].as_bool() == Some(false)
        || value.as_bool() == Some(false)
        || value["partial"].as_bool() == Some(true)
        || value["failedCount"].as_u64().is_some_and(|count| count > 0)
        || value["failures"]
            .as_array()
            .is_some_and(|failures| !failures.is_empty())
}

impl MessagingService {
    pub async fn inbox_action_request(
        &self,
        owner: &str,
        agent_id: &str,
        id: &str,
        conversation: &str,
        action: &str,
        sync_remote: bool,
    ) -> Result<Value, MessageError> {
        if !sync_remote {
            return self.inbox_action(owner, agent_id, id, conversation, action);
        }
        if action != "read"
            || conversation.is_empty()
            || conversation.len() > 4096
            || conversation.contains('\0')
        {
            return Err(MessageError::bad("Invalid remote read request"));
        }
        self.assert_agent_binding(owner, agent_id, id)?;
        let (binding, now, future, peer) = {
            let inner = self.lock();
            let run = inner
                .runs
                .get(id)
                .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
            if run.binding.channel != "dingtalk" {
                return Err(MessageError::unsupported("当前渠道不支持同步钉钉红点"));
            }
            let rows = &inner
                .inbox
                .get(id)
                .ok_or_else(|| MessageError::bad("请选择已有会话"))?
                .messages;
            let target = rows
                .iter()
                .rev()
                .find(|row| row["conversation"].as_str() == Some(conversation))
                .ok_or_else(|| MessageError::bad("请选择已有会话"))?;
            let peer = if target["kind"].as_str() == Some("direct") {
                rows.iter()
                    .rev()
                    .find(|row| {
                        row["conversation"].as_str() == Some(conversation)
                            && row["direction"].as_str() == Some("in")
                            && row["kind"].as_str() == Some("direct")
                    })
                    .and_then(|row| row["sender"].as_str())
                    .filter(|peer| !peer.is_empty())
                    .ok_or_else(|| MessageError::bad("无法确认钉钉单聊对象，请同步对方消息后重试"))?
                    .to_string()
            } else {
                String::new()
            };
            let now = now_ms();
            let future: Vec<String> = rows
                .iter()
                .filter(|row| {
                    row["conversation"].as_str() == Some(conversation)
                        && row["direction"].as_str() == Some("in")
                        && row["time"].as_i64().is_some_and(|time| time > now)
                })
                .filter_map(|row| row["id"].as_str().map(str::to_string))
                .collect();
            (run.binding.clone(), now, future, peer)
        };
        let check = || -> Result<(), MessageError> {
            self.assert_agent_binding(owner, agent_id, id)?;
            // Persona access is read outside the messaging lock, matching inbox views.
            let groups = self.personas.persona_messaging_groups(owner, agent_id);
            let inner = self.lock();
            let run = inner
                .runs
                .get(id)
                .ok_or_else(|| MessageError::bad("Messaging configuration not found"))?;
            if inner.closed
                || run.binding.root != binding.root
                || run.binding.profile != binding.profile
                || run.binding.channel != binding.channel
            {
                return Err(MessageError::bad("渠道已切换，请重新打开此会话"));
            }
            if agent_id != "default-persona"
                && !groups.iter().any(|group| {
                    group["channel"] == "dingtalk"
                        && group["account"].as_str() == Some(binding.profile.as_str())
                        && group["id"].as_str() == Some(conversation)
                })
            {
                return Err(MessageError::bad("群聊未分配给此智能体"));
            }
            Ok(())
        };
        check()?;
        let status = dingtalk_status(&binding.root, &binding.profile).await?;
        if failed(&status) || !dingtalk_identity_matches(&status, &binding.profile) {
            return Err(MessageError::bad(
                "DWS identity does not match configured profile",
            ));
        }
        check()?;
        let remote = if peer.is_empty() {
            conversation.to_string()
        } else {
            let result = dingtalk_call_checked(
                &binding.root,
                &[
                    "chat".into(),
                    "+conversation-info".into(),
                    "--open-dingtalk-id".into(),
                    peer.clone(),
                    "--profile".into(),
                    binding.profile.clone(),
                    "-f".into(),
                    "json".into(),
                ],
            )
            .await?;
            let data = result
                .get("result")
                .or_else(|| result.get("data"))
                .unwrap_or(&result);
            let info = &data["conversationInfo"];
            let remote = info["openConversationId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| MessageError::bad("无法确认钉钉单聊会话，请重新同步消息后重试"))?;
            if failed(&result)
                || failed(data)
                || info["singleChat"].as_bool() != Some(true)
                || (conversation != peer && remote != conversation)
            {
                return Err(MessageError::bad(
                    "无法确认钉钉单聊会话，请重新同步消息后重试",
                ));
            }
            remote.to_string()
        };
        check()?;
        let result = dingtalk_call_checked(
            &binding.root,
            &[
                "chat".into(),
                "clear-red-point".into(),
                "--conversation-id".into(),
                remote,
                "--profile".into(),
                binding.profile.clone(),
                "-f".into(),
                "json".into(),
            ],
        )
        .await?;
        let data = result
            .get("result")
            .or_else(|| result.get("data"))
            .unwrap_or(&result);
        if failed(&result)
            || failed(data)
            || !(result["success"].as_bool() == Some(true)
                || data["success"].as_bool() == Some(true)
                || data.as_bool() == Some(true))
        {
            return Err(MessageError::bad("钉钉红点同步结果未确认，请重试"));
        }
        check()?;
        let mut inner = self.lock();
        let box_ = inner.inbox.entry(id.to_string()).or_default();
        let read = box_.read.entry(conversation.to_string()).or_default();
        *read = (*read).max(now);
        let ids = box_
            .read_future
            .entry(conversation.to_string())
            .or_default();
        for id in future {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        self.save_inbox(&inner);
        if let Some(run) = inner.runs.get(id) {
            self.persist_run(run);
        }
        let owners = super::lifecycle::binding_owners(&inner, id);
        drop(inner);
        self.bump_owners(owners);
        Ok(json!({"ok":true,"remoteSynced":true}))
    }
}
