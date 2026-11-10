//! MCP tool registry. P0 advertises only what it implements: `mcp_status`.
//! Later phases add the remaining twelve tools with identical schemas.

use serde_json::{json, Value};
use std::path::PathBuf;

use crate::{SERVER_NAME, SERVER_VERSION};

pub struct ToolContext<'a> {
    pub port: u16,
    pub root: &'a PathBuf,
    pub started_at: &'a str,
    pub require_auth: bool,
}

pub fn list() -> Vec<Value> {
    vec![json!({
        "name": "mcp_status",
        "description": "Report Keepwork local MCP daemon status: workspace root, port, ripgrep availability.",
        "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {},
        },
        "execution": { "taskSupport": "forbidden" },
    })]
}

/// Dispatch one `tools/call`. Unknown tools must answer as a tool error, not a
/// JSON-RPC error (matches the MCP SDK).
pub fn call(name: &str, ctx: &ToolContext<'_>) -> Value {
    match name {
        "mcp_status" => text_result(&status_text(ctx), false),
        other => text_result(&format!("MCP error -32602: Tool {other} not found"), true),
    }
}

fn status_text(ctx: &ToolContext<'_>) -> String {
    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    let lines = vec![
        "# Keepwork local MCP".to_string(),
        String::new(),
        format!("- name: {SERVER_NAME} {SERVER_VERSION}"),
        format!("- port: {}", ctx.port),
        format!("- pid: {}", std::process::id()),
        format!("- hostname: {hostname}"),
        format!("- workspaceRoot: {}", ctx.root.display()),
        "- terminal: spawn".to_string(),
        format!("- startedAt: {}", ctx.started_at),
        format!(
            "- ripgrep: {}",
            if has_ripgrep() {
                "yes"
            } else {
                "no (Node walker fallback)"
            }
        ),
        format!(
            "- requireAuth: {}",
            if ctx.require_auth { "yes" } else { "no" }
        ),
        String::new(),
        "Tools: run_terminal, grep_files, mcp_status, web_search, fetch_url".to_string(),
    ];
    lines.join("\n")
}

fn text_result(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn has_ripgrep() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(if cfg!(windows) { "rg.exe" } else { "rg" });
        candidate.is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_only_implemented_tools() {
        let tools = list();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "mcp_status");
        assert_eq!(
            tools[0]["inputSchema"]["$schema"],
            "http://json-schema.org/draft-07/schema#"
        );
        assert_eq!(tools[0]["execution"]["taskSupport"], "forbidden");
    }

    #[test]
    fn unknown_tool_returns_tool_error() {
        let root = std::env::temp_dir();
        let ctx = ToolContext {
            port: 8089,
            root: &root,
            started_at: "2026-01-01T00:00:00.000Z",
            require_auth: false,
        };
        let result = call("nope", &ctx);
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("-32602"));
    }
}
