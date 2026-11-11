//! Local tool execution for persona runs.
//!
//! Persona chats call the owner's Keepwork model with an OpenAI-style `tools`
//! list; when the model answers with tool calls this module executes them
//! in-process via the shared `tools::call` dispatcher (same `ShellRunner`,
//! same semaphore as MCP `tools/call`). `run_terminal` is allow-listed to
//! `dws` / `lark-cli` because persona runs also auto-process untrusted
//! inbound channel messages.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

use crate::shell::ShellRunner;
use crate::tools::{self, ToolContext};

/// Tool-result text kept per call; the model summarizes instead of quoting.
pub(crate) const TOOL_RESULT_CHARS: usize = 6_000;
/// Upper bound on model→tool round trips per run.
pub(crate) const MAX_TOOL_ROUNDS: usize = 8;

/// Per-daemon tool environment attached to `PersonaStore` (OnceLock pattern
/// mirrors `messaging`). Cheap to clone per run.
pub(crate) struct LocalToolEnv {
    pub(crate) port: u16,
    pub(crate) root: PathBuf,
    pub(crate) started_at: String,
    pub(crate) require_auth: bool,
    pub(crate) shell: Arc<ShellRunner>,
}

impl LocalToolEnv {
    /// OpenAI `tools` payload for persona runs. `mcp_status` stays internal.
    pub(crate) fn defs() -> Vec<Value> {
        vec![
            json!({
                "type": "function",
                "function": {
                    "name": "run_terminal",
                    "description": "在本机运行一条 dws 或 lark-cli 命令（钉钉/飞书 CLI）。command 必须以 dws 或 lark-cli 开头，禁止管道、重定向、分号拼接等其他命令。cwd 可省略。",
                    "parameters": {
                        "$schema": "http://json-schema.org/draft-07/schema#",
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "description": "以 dws 或 lark-cli 开头的完整命令，例如 dws auth status" },
                            "timeoutMs": { "type": "number", "description": "超时毫秒数（默认 30000，最大 120000）" },
                        },
                        "required": ["command"],
                    },
                },
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "grep_files",
                    "description": "在工作区内按正则搜索文件内容（只读）。pattern 为正则，path 省略时搜索工作区根目录。",
                    "parameters": {
                        "$schema": "http://json-schema.org/draft-07/schema#",
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string", "description": "正则表达式" },
                            "path": { "type": "string", "description": "可选，目录或文件路径" },
                            "glob": { "type": "string", "description": "可选 glob 过滤，如 **/*.ts" },
                            "maxMatches": { "type": "number", "description": "最多匹配数（默认 50，最大 200）" },
                        },
                        "required": ["pattern"],
                    },
                },
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "搜索公网（只读），返回 JSON：{\"engine\",\"query\",\"results\":[{\"title\",\"url\",\"snippet\"]}。",
                    "parameters": {
                        "$schema": "http://json-schema.org/draft-07/schema#",
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索词" },
                            "count": { "type": "number", "description": "结果数（默认 8，最大 12）" },
                        },
                        "required": ["query"],
                    },
                },
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "fetch_url",
                    "description": "抓取一个公网 http(s) 页面并转为纯文本（只读），返回 JSON：{\"url\",\"finalUrl\",\"title\",\"text\",\"truncated\"}。",
                    "parameters": {
                        "$schema": "http://json-schema.org/draft-07/schema#",
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "公网 URL" },
                            "maxChars": { "type": "number", "description": "正文最多字符（默认 8000，最大 16000）" },
                        },
                        "required": ["url"],
                    },
                },
            }),
        ]
    }

    /// Executes one tool call and returns the text the model should see.
    /// Failures come back as text so the model can react within the loop.
    pub(crate) async fn execute(&self, name: &str, args: &Value, session: &str) -> String {
        let allowed = matches!(
            name,
            "run_terminal" | "grep_files" | "web_search" | "fetch_url"
        );
        if !allowed {
            return format!("分身不可用工具 {name}");
        }
        if name == "run_terminal" {
            if let Err(message) = allowlisted_terminal(args["command"].as_str().unwrap_or("")) {
                return message;
            }
        }
        let ctx = ToolContext {
            port: self.port,
            root: &self.root,
            started_at: &self.started_at,
            require_auth: self.require_auth,
            session,
        };
        let result = tools::call(name, args, &ctx, &self.shell).await;
        let text = result
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("");
        text.chars().take(TOOL_RESULT_CHARS).collect()
    }
}

/// Persona allow-list on top of `assert_allowed_command`: plain single
/// commands only, and the first token must be `dws` or `lark-cli`.
pub(crate) fn allowlisted_terminal(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令为空".into());
    }
    for banned in [';', '|', '&', '`', '\n', '>', '<'] {
        if trimmed.contains(banned) {
            return Err(format!(
                "分身终端仅允许单条 dws 或 lark-cli 命令，命令中包含被禁止的字符 {banned:?}"
            ));
        }
    }
    if trimmed.contains("$(") {
        return Err("分身终端仅允许单条 dws 或 lark-cli 命令，命令中包含被禁止的命令替换".into());
    }
    let first = trimmed.split_whitespace().next().unwrap_or("");
    if first == "dws" || first == "lark-cli" {
        Ok(())
    } else {
        Err("分身终端仅允许 dws 或 lark-cli 命令".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_dws_and_lark_cli() {
        assert!(allowlisted_terminal("dws auth status").is_ok());
        assert!(allowlisted_terminal("lark-cli --help").is_ok());
        assert!(allowlisted_terminal("  dws  chat list  ").is_ok());
    }

    #[test]
    fn allowlist_rejects_other_commands_and_metacharacters() {
        assert!(allowlisted_terminal("ls").is_err());
        assert!(allowlisted_terminal("echo hi").is_err());
        assert!(allowlisted_terminal("dws auth status; rm -rf /").is_err());
        assert!(allowlisted_terminal("dws status | tee /tmp/x").is_err());
        assert!(allowlisted_terminal("dws status & echo pwn").is_err());
        assert!(allowlisted_terminal("dws status > /tmp/x").is_err());
        assert!(allowlisted_terminal("echo $(whoami)").is_err());
        assert!(allowlisted_terminal("dws status\nrm -rf /").is_err());
        assert!(allowlisted_terminal("").is_err());
    }

    #[test]
    fn defs_are_openai_function_format() {
        let defs = LocalToolEnv::defs();
        assert_eq!(defs.len(), 4);
        for def in &defs {
            assert_eq!(def["type"], "function");
            assert!(def["function"]["name"].is_string());
            assert_eq!(
                def["function"]["parameters"]["$schema"],
                "http://json-schema.org/draft-07/schema#"
            );
        }
        let names: Vec<&str> = defs
            .iter()
            .map(|def| def["function"]["name"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            names,
            vec!["run_terminal", "grep_files", "web_search", "fetch_url"]
        );
    }

    #[tokio::test]
    async fn execute_blocks_disallowed_tools() {
        let env = LocalToolEnv {
            port: 8089,
            root: std::env::temp_dir(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            require_auth: false,
            shell: Arc::new(ShellRunner::default()),
        };
        let text = env.execute("mcp_status", &json!({}), "s").await;
        assert!(text.contains("mcp_status"));
    }

    #[tokio::test]
    async fn execute_rejects_non_allowlisted_terminal_commands() {
        let env = LocalToolEnv {
            port: 8089,
            root: std::env::temp_dir(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            require_auth: false,
            shell: Arc::new(ShellRunner::default()),
        };
        let text = env
            .execute("run_terminal", &json!({"command": "ls"}), "s")
            .await;
        assert!(text.contains("dws"));
    }
}
