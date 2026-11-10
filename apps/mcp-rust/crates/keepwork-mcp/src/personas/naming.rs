//! Name, identity-rule and AGENTS.md helpers for persona validation.

use super::util::*;
use super::*;

pub(crate) fn forbidden_name(name: &str, amp: bool) -> bool {
    name.chars().any(|ch| {
        (ch as u32) <= 0x1f || ch == '【' || ch == '】' || (amp && (ch == '&' || ch == '＆'))
    })
}

pub(crate) fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

pub(crate) fn agent_messaging(value: &Value) -> Result<Value, PersonaError> {
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

pub(crate) fn shares_account(left: &Value, right: &Value) -> bool {
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

pub(crate) fn assert_names(candidate: &Value, others: &[Value]) -> Result<(), PersonaError> {
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

pub(crate) fn keepwork_chat_url(base_url: &str) -> Result<String, String> {
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

pub(crate) fn agents_md(root: &str) -> String {
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
