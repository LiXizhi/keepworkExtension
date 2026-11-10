//! MCP tool registry. Schemas and descriptions are byte-identical to the Node
//! daemon (`src/mcp/server.ts`); `tools/list` order follows the Node server.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::grep;
use crate::shell::ShellRunner;
use crate::terminal::assert_allowed_command;
use crate::web;
use crate::{SERVER_NAME, SERVER_VERSION};

pub struct ToolContext<'a> {
    pub port: u16,
    pub root: &'a PathBuf,
    pub started_at: &'a str,
    pub require_auth: bool,
    pub session: &'a str,
}

pub fn list() -> Vec<Value> {
    vec![
        json!({
            "name": "mcp_status",
            "description": "Report Keepwork local MCP daemon status: workspace root, port, ripgrep availability.",
            "inputSchema": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {},
            },
            "execution": { "taskSupport": "forbidden" },
        }),
        json!({
            "name": "run_terminal",
            "description": "Run a shell command on the user's local disk. cwd may be an absolute disk path (local folder) or relative to the MCP workspace root (cloud workspaces). AIChat fills cwd from the bound folder when omitted and requires user confirmation. When VS Code / Cursor is open, the command uses the Keepwork integrated terminal.",
            "inputSchema": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run" },
                    "cwd": {
                        "description": "Working directory: absolute path of a local disk folder (e.g. C:\\\\lxzsrc or ~/myfolder), or a path relative to the MCP workspace root. Omit to use the AIChat-bound folder.",
                        "type": "string",
                    },
                    "timeoutMs": {
                        "description": "Timeout in milliseconds (default 30000, max 120000)",
                        "type": "number",
                    },
                },
                "required": ["command"],
            },
            "execution": { "taskSupport": "forbidden" },
        }),
        json!({
            "name": "grep_files",
            "description": "Search file contents. path may be an absolute disk folder or relative to the MCP workspace root. Follows symbolic links and Windows junctions (loop-aware). Prefer this over shelling out to grep. pattern is a regex.",
            "inputSchema": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Regular expression to search for" },
                    "path": {
                        "description": "Directory or file: absolute local disk path, or relative to the MCP workspace root. Omit to search the AIChat-bound folder.",
                        "type": "string",
                    },
                    "glob": { "description": "Optional glob filter, e.g. **/*.ts", "type": "string" },
                    "maxMatches": {
                        "description": "Maximum matches to return (default 50, max 200)",
                        "type": "number",
                    },
                },
                "required": ["pattern"],
            },
            "execution": { "taskSupport": "forbidden" },
        }),
        json!({
            "name": "web_search",
            "description": "Search the public web from this machine (no API key). HTML is parsed locally; the result is minified JSON: {\"engine\",\"query\",\"results\":[{\"title\",\"url\",\"snippet\"}]}. Use for current events, then fetch_url on 1-3 promising links. Do not curl HTML via run_terminal.",
            "inputSchema": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "count": { "description": "Max results (default 8, max 12)", "type": "number" },
                },
                "required": ["query"],
            },
            "execution": { "taskSupport": "forbidden" },
        }),
        json!({
            "name": "fetch_url",
            "description": "Fetch one public http(s) URL from this machine. HTML is rendered in local Edge/Chrome when available, then converted to structured text (headings/lists). Returns minified JSON: {\"url\",\"finalUrl\",\"title\",\"text\",\"truncated\"}. Never returns HTML. Private/localhost URLs are blocked.",
            "inputSchema": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Public http(s) URL to fetch" },
                    "maxChars": {
                        "description": "Max extracted text characters (default 8000, max 16000)",
                        "type": "number",
                    },
                },
                "required": ["url"],
            },
            "execution": { "taskSupport": "forbidden" },
        }),
    ]
}

fn text_result(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

/// Dispatch one `tools/call`. Unknown tools answer as a tool error, not a
/// JSON-RPC error (matches the MCP SDK).
pub async fn call(name: &str, args: &Value, ctx: &ToolContext<'_>, runner: &ShellRunner) -> Value {
    let argument = |key: &str| args.get(key);
    let string_arg = |key: &str| argument(key).and_then(Value::as_str).map(str::to_string);
    let number_arg = |key: &str| argument(key).and_then(Value::as_f64);

    let outcome: Result<Value, String> = match name {
        "mcp_status" => Ok(text_result(&status_text(ctx), false)),
        "run_terminal" => {
            let command = string_arg("command").unwrap_or_default();
            match runner
                .run(
                    ctx.session,
                    &command,
                    string_arg("cwd").as_deref(),
                    number_arg("timeoutMs"),
                    ctx.root,
                )
                .await
            {
                Ok(result) => Ok(text_result(&result.format(), !result.ok)),
                Err(error) => Err(error),
            }
        }
        "grep_files" => {
            let pattern = string_arg("pattern").unwrap_or_default();
            match grep::grep_files(
                &pattern,
                string_arg("path").as_deref(),
                string_arg("glob").as_deref(),
                number_arg("maxMatches"),
                ctx.root,
            ) {
                Ok(result) => Ok(text_result(&result.format(), !result.ok)),
                Err(error) => Err(error),
            }
        }
        "web_search" => {
            let query = string_arg("query").unwrap_or_default();
            let result = web::web_search(&query, number_arg("count")).await;
            let is_error = result.get("error").is_some();
            Ok(text_result(&result.to_string(), is_error))
        }
        "fetch_url" => {
            let url = string_arg("url").unwrap_or_default();
            let result = web::fetch_url(&url, number_arg("maxChars")).await;
            let is_error = result.get("error").is_some();
            Ok(text_result(&result.to_string(), is_error))
        }
        other => {
            return text_result(&format!("MCP error -32602: Tool {other} not found"), true);
        }
    };

    match outcome {
        Ok(value) => value,
        Err(error) => {
            let fallback = if name == "web_search" || name == "fetch_url" {
                json!({ "error": "network", "detail": error.chars().take(80).collect::<String>() })
                    .to_string()
            } else {
                format!("Failed: {error}")
            };
            text_result(&fallback, true)
        }
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

fn has_ripgrep() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(if cfg!(windows) { "rg.exe" } else { "rg" });
        candidate.is_file()
    })
}

/// Validates a command without running it (used by `/terminal/sessions/:id/commands`).
pub fn validate_command(command: &str) -> Result<(), String> {
    assert_allowed_command(command).map(|_| ())
}

#[allow(dead_code)]
fn workspace(root: &Path) -> PathBuf {
    root.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_the_five_portable_tools() {
        let tools = list();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            names,
            vec![
                "mcp_status",
                "run_terminal",
                "grep_files",
                "web_search",
                "fetch_url"
            ]
        );
        for tool in &tools {
            assert_eq!(
                tool["inputSchema"]["$schema"],
                "http://json-schema.org/draft-07/schema#"
            );
            assert_eq!(tool["execution"]["taskSupport"], "forbidden");
        }
        assert_eq!(list()[1]["inputSchema"]["required"], json!(["command"]));
    }

    #[tokio::test]
    async fn unknown_tool_returns_tool_error() {
        let root = std::env::temp_dir();
        let ctx = ToolContext {
            port: 8089,
            root: &root,
            started_at: "2026-01-01T00:00:00.000Z",
            require_auth: false,
            session: "s",
        };
        let result = call("nope", &json!({}), &ctx, &ShellRunner::default()).await;
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("-32602"));
    }

    #[tokio::test]
    async fn run_terminal_reports_output() {
        let root = std::env::temp_dir();
        let ctx = ToolContext {
            port: 8089,
            root: &root,
            started_at: "2026-01-01T00:00:00.000Z",
            require_auth: false,
            session: "s",
        };
        let result = call(
            "run_terminal",
            &json!({ "command": "echo tool-ok" }),
            &ctx,
            &ShellRunner::default(),
        )
        .await;
        assert_eq!(result["isError"], false);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("tool-ok"));
    }
}
