use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const HOST_COMMANDS: &[&str] = &[
    "file:open-folder",
    "file:new-window",
    "file:close-window",
    "view:reload",
    "view:force-reload",
    "view:toggle-devtools",
    "view:reset-zoom",
    "view:zoom-in",
    "view:zoom-out",
    "view:toggle-fullscreen",
    "view:toggle-source",
    "view:toggle-pet",
    "view:toggle-login-startup",
    "help:mcp-dashboard",
    "help:check-updates",
    "help:restart-mcp",
    "help:open-keepwork",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuContextState {
    pub local_source_available: bool,
    pub local_source_enabled: bool,
    pub pet_visible: bool,
    pub open_at_login: bool,
    pub mcp_version: String,
    pub desktop_version: String,
}

pub fn is_allowed_host_command(id: &str) -> bool {
    HOST_COMMANDS.contains(&id)
}

pub fn top_menu_bar_labels() -> Value {
    json!([
        { "id": "file", "label": "文件" },
        { "id": "edit", "label": "编辑" },
        { "id": "view", "label": "视图" },
        { "id": "help", "label": "帮助" }
    ])
}

pub fn menu_payload(menu_id: &str, state: &MenuContextState) -> Option<Value> {
    let items = match menu_id {
        "file" => json!([
            { "id": "file:open-folder", "label": "打开文件夹…", "accelerator": "CmdOrCtrl+O" },
            { "type": "separator" },
            { "id": "file:close-window", "label": "关闭窗口", "accelerator": "CmdOrCtrl+W" }
        ]),
        "edit" => json!([
            { "id": "edit:undo", "label": "撤销", "role": "undo", "accelerator": "CmdOrCtrl+Z" },
            { "id": "edit:redo", "label": "重做", "role": "redo", "accelerator": "CmdOrCtrl+Shift+Z" },
            { "type": "separator" },
            { "id": "edit:cut", "label": "剪切", "role": "cut", "accelerator": "CmdOrCtrl+X" },
            { "id": "edit:copy", "label": "复制", "role": "copy", "accelerator": "CmdOrCtrl+C" },
            { "id": "edit:paste", "label": "粘贴", "role": "paste", "accelerator": "CmdOrCtrl+V" },
            { "id": "edit:select-all", "label": "全选", "role": "selectAll", "accelerator": "CmdOrCtrl+A" }
        ]),
        "view" => {
            let mut list = vec![
                json!({ "id": "view:reload", "label": "重新加载", "accelerator": "CmdOrCtrl+R" }),
                json!({ "id": "view:force-reload", "label": "强制重新加载", "accelerator": "CmdOrCtrl+Shift+R" }),
                json!({ "id": "view:toggle-devtools", "label": "开发者工具", "accelerator": "CmdOrCtrl+Alt+I" }),
                json!({ "type": "separator" }),
                json!({ "id": "view:reset-zoom", "label": "实际大小", "accelerator": "CmdOrCtrl+0" }),
                json!({ "id": "view:zoom-in", "label": "放大", "accelerator": "CmdOrCtrl+Plus" }),
                json!({ "id": "view:zoom-out", "label": "缩小", "accelerator": "CmdOrCtrl+-" }),
                json!({ "type": "separator" }),
                json!({ "id": "view:toggle-fullscreen", "label": "全屏", "accelerator": "F11" }),
                json!({
                    "id": "view:toggle-pet",
                    "label": "显示桌面宠物",
                    "type": "checkbox",
                    "checked": state.pet_visible
                }),
                json!({
                    "id": "view:toggle-login-startup",
                    "label": "开机自动启动",
                    "type": "checkbox",
                    "checked": state.open_at_login
                }),
            ];
            if state.local_source_available {
                list.push(json!({
                    "id": "view:toggle-source",
                    "label": "使用本地 AIChat 源码",
                    "type": "checkbox",
                    "checked": state.local_source_enabled
                }));
            }
            Value::Array(list)
        }
        "help" => json!([
            { "id": "help:mcp-dashboard", "label": "打开本地 MCP 面板" },
            { "id": "help:restart-mcp", "label": "重启本地 MCP 服务" },
            { "id": "help:check-updates", "label": "检查更新…" },
            { "type": "separator" },
            { "id": "help:open-keepwork", "label": "访问 Keepwork 官网" },
            {
                "id": "help:version",
                "label": format!("桌面版本 {} · MCP {}", state.desktop_version, state.mcp_version),
                "enabled": false
            }
        ]),
        _ => return None,
    };

    Some(json!({
        "channel": "aichat.desktop-menu.v1",
        "type": "show",
        "menuId": menu_id,
        "items": items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_menu_payloads_and_validates_host_commands() {
        assert!(is_allowed_host_command("file:open-folder"));
        assert!(is_allowed_host_command("help:check-updates"));
        assert!(!is_allowed_host_command("evil:exec"));

        let ctx = MenuContextState {
            local_source_available: true,
            local_source_enabled: false,
            pet_visible: true,
            open_at_login: true,
            mcp_version: "0.2.88".to_string(),
            desktop_version: "0.2.0".to_string(),
        };
        let view = menu_payload("view", &ctx).unwrap();
        assert_eq!(view["menuId"], "view");
        assert!(view["items"].as_array().unwrap().len() >= 10);
    }
}
