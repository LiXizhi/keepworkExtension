use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 页面命令：由 AIChat 页面自行执行的菜单动作，桌面进程只负责投递
/// （与 `apps/aichat-desktop` 的 `PAGE_COMMANDS` 保持一致）。
pub const PAGE_COMMANDS: &[&str] = &[
    "new-chat",
    "toggle-sidebar",
    "toggle-files",
    "open-settings",
    "experience-simple",
    "experience-professional",
    "theme-light",
    "theme-dark",
];

/// 主机命令：由桌面进程原生执行的动作（与 `apps/aichat-desktop` 的 `HOST_COMMANDS` 对齐）。
/// `toggle-pet` / `open-keepwork` / `close-window` 是 Rust 版保留的桌面自有动作。
pub const HOST_COMMANDS: &[&str] = &[
    "open-folder",
    "reload",
    "check-updates",
    "toggle-login",
    "quit",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "select-all",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "fullscreen",
    "mcp-status",
    "mcp-dashboard",
    "mcp-restart",
    "open-browser",
    "local-source",
    "published-site",
    "close-window",
    "toggle-pet",
    "open-keepwork",
    "remote-voice",
];

/// 历史 id → 规范化 id。原生菜单/托盘与旧页面仍可能投递旧 id，
/// 这里统一映射，避免升级后既有调用方失效。
const HOST_COMMAND_ALIASES: &[(&str, &str)] = &[
    ("file:open-folder", "open-folder"),
    // 旧实现没有原生实现，只向页面广播；规范化为页面命令 `new-chat`。
    ("file:new-window", "new-chat"),
    ("file:close-window", "close-window"),
    ("view:reload", "reload"),
    ("view:force-reload", "reload"),
    ("view:reset-zoom", "zoom-reset"),
    ("view:zoom-in", "zoom-in"),
    ("view:zoom-out", "zoom-out"),
    ("view:toggle-fullscreen", "fullscreen"),
    ("view:toggle-source", "local-source"),
    ("view:toggle-pet", "toggle-pet"),
    ("view:toggle-login-startup", "toggle-login"),
    ("help:mcp-dashboard", "mcp-dashboard"),
    ("help:check-updates", "check-updates"),
    ("help:restart-mcp", "mcp-restart"),
    ("help:open-keepwork", "open-keepwork"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuContextState {
    pub local_source_available: bool,
    pub local_source_enabled: bool,
    pub pet_visible: bool,
    pub open_at_login: bool,
    pub mcp_state: String,
    pub mcp_owner: String,
    pub mcp_error: String,
    pub mcp_version: String,
    pub desktop_version: String,
    pub entry_url: String,
    pub update_label: String,
    pub update_error: String,
}

pub fn is_allowed_page_command(id: &str) -> bool {
    PAGE_COMMANDS.contains(&id)
}

/// 把历史 id 规范化成新的无前缀 id；新 id 原样返回。
pub fn canonical_host_command(id: &str) -> Option<&'static str> {
    if let Some(found) = HOST_COMMANDS.iter().find(|cmd| **cmd == id) {
        return Some(*found);
    }
    HOST_COMMAND_ALIASES
        .iter()
        .find(|(old, _)| *old == id)
        .map(|(_, new)| *new)
}

/// 新 id 与旧别名都接受；`file:new-window` 这类只映射到页面命令的别名不算主机命令。
pub fn is_allowed_host_command(id: &str) -> bool {
    match canonical_host_command(id) {
        Some(canonical) => HOST_COMMANDS.contains(&canonical),
        None => false,
    }
}

pub fn top_menu_bar_labels() -> Value {
    json!([
        { "id": "file", "label": "文件" },
        { "id": "edit", "label": "编辑" },
        { "id": "view", "label": "视图" },
        { "id": "help", "label": "帮助" }
    ])
}

fn menu_label(menu_id: &str) -> Option<&'static str> {
    match menu_id {
        "file" => Some("文件"),
        "edit" => Some("编辑"),
        "view" => Some("视图"),
        "help" => Some("帮助"),
        _ => None,
    }
}

/// macOS 用 ⌘ ⇧ ⌥ 符号，其它平台用 Ctrl/Shift/Alt（与桌面版 `shortcut()` 一致）。
fn shortcut(accelerator: &str) -> String {
    let (cmd, shift, alt) = if cfg!(target_os = "macos") {
        ("⌘", "⇧", "⌥")
    } else {
        ("Ctrl", "Shift", "Alt")
    };
    accelerator
        .replace("CmdOrCtrl", cmd)
        .replace("Shift", shift)
        .replace("Alt", alt)
}

fn key_item(accelerator: &str, label: &str, id: &str) -> Value {
    json!({
        "id": id,
        "label": label,
        "accelerator": accelerator,
        "shortcut": shortcut(accelerator),
    })
}

fn file_menu(state: &MenuContextState) -> Value {
    json!([
        key_item("CmdOrCtrl+N", "新对话", "new-chat"),
        key_item("CmdOrCtrl+O", "打开文件夹…", "open-folder"),
        { "type": "separator" },
        key_item("CmdOrCtrl+R", "重新加载", "reload"),
        { "type": "separator" },
        { "id": "check-updates", "label": "检查更新…" },
        {
            "id": "toggle-login",
            "label": "登录后自动启动",
            "enabled": true,
            "type": "checkbox",
            "checked": state.open_at_login
        },
        { "type": "separator" },
        key_item("CmdOrCtrl+Q", "退出", "quit"),
    ])
}

fn edit_menu() -> Value {
    json!([
        { "id": "undo", "label": "撤销", "role": "undo", "accelerator": "CmdOrCtrl+Z", "shortcut": shortcut("CmdOrCtrl+Z") },
        { "id": "redo", "label": "重做", "role": "redo", "accelerator": "CmdOrCtrl+Shift+Z", "shortcut": shortcut("CmdOrCtrl+Shift+Z") },
        { "type": "separator" },
        { "id": "cut", "label": "剪切", "role": "cut", "accelerator": "CmdOrCtrl+X", "shortcut": shortcut("CmdOrCtrl+X") },
        { "id": "copy", "label": "复制", "role": "copy", "accelerator": "CmdOrCtrl+C", "shortcut": shortcut("CmdOrCtrl+C") },
        { "id": "paste", "label": "粘贴", "role": "paste", "accelerator": "CmdOrCtrl+V", "shortcut": shortcut("CmdOrCtrl+V") },
        { "id": "select-all", "label": "全选", "role": "selectAll", "accelerator": "CmdOrCtrl+A", "shortcut": shortcut("CmdOrCtrl+A") },
        { "type": "separator" },
        { "id": "remote-voice", "label": "遥控器语音输入…" },
    ])
}

fn view_menu() -> Value {
    json!([
        { "id": "experience-simple", "label": "简洁模式", "check": true },
        { "id": "experience-professional", "label": "专业模式", "check": true },
        { "type": "separator" },
        { "id": "theme-light", "label": "浅色外观", "check": true },
        { "id": "theme-dark", "label": "深色外观", "check": true },
        { "type": "separator" },
        { "id": "toggle-sidebar", "label": "历史侧栏", "check": true },
        { "id": "toggle-files", "label": "文件面板", "check": true },
        { "type": "separator" },
        key_item("CmdOrCtrl+=", "放大", "zoom-in"),
        key_item("CmdOrCtrl+-", "缩小", "zoom-out"),
        key_item("CmdOrCtrl+0", "实际大小", "zoom-reset"),
        { "type": "separator" },
        key_item("F11", "全屏", "fullscreen"),
        { "type": "separator" },
        { "id": "open-settings", "label": "设置" },
    ])
}

fn help_menu(state: &MenuContextState) -> Value {
    let mut items: Vec<Value> = vec![
        json!({ "id": "check-updates", "label": "检查更新…" }),
        json!({ "type": "separator" }),
        json!({
            "id": "menu-info:mcp",
            "label": format!("MCP：{} {}（{}）", state.mcp_state, state.mcp_version, state.mcp_owner),
            "enabled": false
        }),
    ];
    if !state.mcp_error.trim().is_empty() {
        items.push(json!({ "id": "menu-info:mcp-error", "label": clip(&state.mcp_error, 80), "enabled": false }));
    }
    items.push(json!({ "id": "mcp-status", "label": "查看状态…", "enabled": true }));
    items.push(json!({ "id": "mcp-dashboard", "label": "打开 Dashboard" }));
    items.push(json!({ "id": "mcp-restart", "label": "重启 Keepwork MCP", "enabled": true }));
    items.push(json!({ "type": "separator" }));
    items.push(json!({ "id": "open-browser", "label": "在浏览器中打开" }));
    items.push(json!({ "id": "local-source", "label": "使用本地源码服务器…" }));
    items.push(json!({ "id": "published-site", "label": "使用线上服务器" }));
    items.push(json!({ "id": "menu-info:entry", "label": state.entry_url, "enabled": false }));
    items.push(json!({ "type": "separator" }));
    items.push(json!({ "id": "menu-info:update", "label": state.update_label, "enabled": false }));
    if !state.update_error.trim().is_empty() {
        items.push(json!({
            "id": "menu-info:update-error",
            "label": format!("更新失败：{}", clip(&state.update_error, 80)),
            "enabled": false
        }));
    }
    items.push(json!({
        "id": "menu-info:version",
        "label": format!("桌面版本 {}", state.desktop_version),
        "enabled": false
    }));
    Value::Array(items)
}

/// 按字符（而不是字节/UTF-16 单元）截断，避免截断多字节中文。
fn clip(raw: &str, max_chars: usize) -> String {
    raw.trim().chars().take(max_chars).collect()
}

pub fn menu_payload(menu_id: &str, state: &MenuContextState) -> Option<Value> {
    let label = menu_label(menu_id)?;
    let items = match menu_id {
        "file" => file_menu(state),
        "edit" => edit_menu(),
        "view" => view_menu(),
        "help" => help_menu(state),
        _ => return None,
    };

    // 菜单载荷以桌面版形状（`menu: { id, label, items }`）为准，
    // 同时冗余保留 `menuId` / `items` 供既有页面渲染逻辑使用。
    Some(json!({
        "channel": "aichat.desktop-menu.v1",
        "type": "show",
        "menuId": menu_id,
        "id": menu_id,
        "label": label,
        "items": items.clone(),
        "menu": {
            "id": menu_id,
            "label": label,
            "items": items,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> MenuContextState {
        MenuContextState {
            local_source_available: true,
            local_source_enabled: false,
            pet_visible: true,
            open_at_login: true,
            mcp_state: "running".to_string(),
            mcp_owner: "desktop".to_string(),
            mcp_error: String::new(),
            mcp_version: "0.2.88".to_string(),
            desktop_version: "0.2.2".to_string(),
            entry_url: "https://keepwork.com/chat".to_string(),
            update_label: "桌面更新：idle".to_string(),
            update_error: String::new(),
        }
    }

    #[test]
    fn builds_menu_payloads_and_validates_host_commands() {
        // 新 id 与旧别名都必须可用，未知 id 必须被拒绝。
        assert!(is_allowed_host_command("open-folder"));
        assert!(is_allowed_host_command("file:open-folder"));
        assert!(is_allowed_host_command("view:reload"));
        assert!(is_allowed_host_command("help:check-updates"));
        assert!(is_allowed_host_command("view:toggle-pet"));
        assert!(is_allowed_host_command("help:open-keepwork"));
        assert!(is_allowed_host_command("help:mcp-dashboard"));
        assert_eq!(
            canonical_host_command("help:mcp-dashboard"),
            Some("mcp-dashboard")
        );
        assert!(!is_allowed_host_command("evil:exec"));
        assert!(!is_allowed_host_command("file:new-window"));

        assert_eq!(
            canonical_host_command("file:open-folder"),
            Some("open-folder")
        );
        assert_eq!(
            canonical_host_command("view:reset-zoom"),
            Some("zoom-reset")
        );
        assert_eq!(canonical_host_command("zoom-in"), Some("zoom-in"));
        assert_eq!(canonical_host_command("evil:exec"), None);

        // 页面命令集合与桌面版一致。
        for id in PAGE_COMMANDS {
            assert!(is_allowed_page_command(id));
            assert!(!is_allowed_host_command(id), "{id} 不得同时是主机命令");
        }
        assert!(is_allowed_page_command("new-chat"));
        assert!(!is_allowed_page_command("reload"));

        let ctx = context();
        let view = menu_payload("view", &ctx).unwrap();
        assert_eq!(view["menuId"], "view");
        assert_eq!(view["id"], "view");
        assert_eq!(view["label"], "视图");
        assert_eq!(view["menu"]["id"], "view");
        assert_eq!(view["menu"]["label"], "视图");
        assert_eq!(view["items"], view["menu"]["items"]);
        assert!(view["items"].as_array().unwrap().len() >= 10);

        let file = menu_payload("file", &ctx).unwrap();
        let file_items = file["items"].as_array().unwrap();
        let ids: Vec<&str> = file_items
            .iter()
            .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
            .collect();
        assert!(ids.contains(&"new-chat"));
        assert!(ids.contains(&"open-folder"));
        assert!(ids.contains(&"quit"));
        let toggle_login = file_items
            .iter()
            .find(|item| item.get("id").and_then(|v| v.as_str()) == Some("toggle-login"))
            .unwrap();
        assert_eq!(toggle_login["type"], "checkbox");
        assert_eq!(toggle_login["checked"], true);

        let help = menu_payload("help", &ctx).unwrap();
        let labels: Vec<&str> = help["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("label").and_then(|v| v.as_str()))
            .collect();
        assert!(labels.iter().any(|l| l.starts_with("MCP：running")));
        assert!(labels.iter().any(|l| l.starts_with("桌面版本")));
        assert!(labels.iter().any(|l| *l == "https://keepwork.com/chat"));

        assert!(menu_payload("evil", &ctx).is_none());
    }

    #[test]
    fn help_menu_reports_mcp_and_update_errors() {
        let mut ctx = context();
        ctx.mcp_error = "x".repeat(200);
        ctx.update_error = "网络不可达".to_string();
        let help = menu_payload("help", &ctx).unwrap();
        let items = help["items"].as_array().unwrap();
        assert!(items.iter().any(|item| item["label"]
            .as_str()
            .map(|l| l.len() == 80)
            .unwrap_or(false)));
        assert!(items.iter().any(|item| item["label"]
            .as_str()
            .map(|l| l == "更新失败：网络不可达")
            .unwrap_or(false)));
    }
}
