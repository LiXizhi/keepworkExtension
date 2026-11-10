use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelStatus {
    pub id: String,
    pub label: String,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraySummary {
    pub attention: bool,
    pub primary_label: String,
    pub tooltip: String,
    pub channels: Vec<ChannelStatus>,
}

const KNOWN_CHANNELS: &[(&str, &str)] =
    &[("dingtalk", "钉钉"), ("feishu", "飞书"), ("wechat", "微信")];

fn normalize_channel_state(entry: Option<&Value>) -> (&'static str, &'static str) {
    let Some(obj) = entry else {
        return ("off", "未开启");
    };
    if let Some(s) = obj
        .get("state")
        .or_else(|| obj.get("status"))
        .and_then(|v| v.as_str())
    {
        match s.trim().to_ascii_lowercase().as_str() {
            "connected" | "online" | "ready" | "running" => return ("connected", "已连接"),
            "error" | "failed" | "disconnected" => return ("error", "连接异常"),
            "configured" | "enabled" | "starting" => return ("configured", "已配置"),
            "off" | "disabled" | "none" => return ("off", "未开启"),
            _ => {}
        }
    }
    if obj.get("connected").and_then(|v| v.as_bool()) == Some(true) {
        return ("connected", "已连接");
    }
    if obj
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return ("error", "连接异常");
    }
    if obj.get("enabled").and_then(|v| v.as_bool()) == Some(true)
        || obj.get("configured").and_then(|v| v.as_bool()) == Some(true)
    {
        return ("configured", "已配置");
    }
    ("off", "未开启")
}

pub fn channel_states(payload: &Value) -> Vec<ChannelStatus> {
    let container = payload.get("channels").unwrap_or(payload);
    KNOWN_CHANNELS
        .iter()
        .map(|(id, label)| {
            let entry = if let Some(arr) = container.as_array() {
                arr.iter().find(|item| {
                    item.get("id")
                        .or_else(|| item.get("channel"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.eq_ignore_ascii_case(id))
                        .unwrap_or(false)
                })
            } else {
                container.get(*id)
            };
            let (state, detail) = normalize_channel_state(entry);
            ChannelStatus {
                id: (*id).to_string(),
                label: (*label).to_string(),
                state: state.to_string(),
                detail: detail.to_string(),
            }
        })
        .collect()
}

pub fn describe(channels: &[ChannelStatus], signed_in: bool, main_visible: bool) -> TraySummary {
    let base_title = if main_visible {
        "KeepWork 第二大脑"
    } else {
        "KeepWork 第二大脑（后台运行）"
    };
    let primary_label = if !signed_in {
        "点击打开聊天，检查登录状态".to_string()
    } else {
        "打开聊天".to_string()
    };

    let mut lines = vec![base_title.to_string()];
    if !signed_in {
        lines.push("登录状态未确认：点击打开聊天，检查登录状态".to_string());
    }
    for ch in channels {
        lines.push(format!("{}：{}", ch.label, ch.detail));
    }

    TraySummary {
        attention: !signed_in,
        primary_label,
        tooltip: lines.join("\n"),
        channels: channels.to_vec(),
    }
}

pub async fn fetch_tray_channels(port: u16, mcp_home: &Path) -> Vec<ChannelStatus> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return channel_states(&Value::Null),
    };

    let health_url = format!("http://127.0.0.1:{port}/health");
    let Ok(health_resp) = client.get(&health_url).send().await else {
        return channel_states(&Value::Null);
    };
    let Ok(health_json) = health_resp.json::<Value>().await else {
        return channel_states(&Value::Null);
    };
    if health_json.get("name").and_then(|v| v.as_str()) != Some("keepwork-mcp") {
        return channel_states(&Value::Null);
    }

    let require_auth = health_json
        .get("requireAuth")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut req = client.get(format!("http://127.0.0.1:{port}/admin/channels?view=tray"));

    if require_auth {
        // Verify PID matches ~/.keepwork-mcp/instance.json before sending local token
        let health_pid = health_json.get("pid").and_then(|v| v.as_u64());
        let instance_pid = fs::read_to_string(mcp_home.join("instance.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("pid").and_then(|p| p.as_u64()));
        if health_pid.is_some() && health_pid == instance_pid {
            if let Ok(token) = fs::read_to_string(mcp_home.join("token")) {
                let trimmed = token.trim();
                if !trimmed.is_empty() {
                    req = req.bearer_auth(trimmed);
                }
            }
        } else {
            return channel_states(&Value::Null);
        }
    }

    let Ok(resp) = req.send().await else {
        return channel_states(&Value::Null);
    };
    if !resp.status().is_success() {
        return channel_states(&Value::Null);
    }
    let payload = resp.json::<Value>().await.unwrap_or(Value::Null);
    channel_states(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_channel_states_and_signin_attention_summary() {
        let payload = json!({
            "channels": {
                "dingtalk": { "connected": true },
                "feishu": { "enabled": true, "error": "token expired" },
                "wechat": { "enabled": false }
            }
        });
        let states = channel_states(&payload);
        assert_eq!(states.len(), 3);
        assert_eq!(states[0].detail, "已连接");
        assert_eq!(states[1].detail, "连接异常");
        assert_eq!(states[2].detail, "未开启");

        let attention_summary = describe(&states, false, false);
        assert!(attention_summary.attention);
        assert_eq!(
            attention_summary.primary_label,
            "点击打开聊天，检查登录状态"
        );
        assert!(attention_summary.tooltip.contains("钉钉：已连接"));
    }
}
