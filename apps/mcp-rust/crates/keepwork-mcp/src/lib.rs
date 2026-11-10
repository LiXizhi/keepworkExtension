//! Keepwork local MCP daemon.
//!
//! Scope: process lifecycle, config/paths, loopback HTTP with the same
//! CORS/auth contract as the Node daemon, `/health`, `/exists`, the full `/fs/*`
//! surface, PTY `/terminal/*` sessions, `/admin/status|stop`, the MCP handshake
//! and the five portable tools (`mcp_status`, `run_terminal`, `grep_files`,
//! `web_search`, `fetch_url`). Personas (`personasApi: personas-v1`) persist
//! under `~/.keepwork-mcp/personas-v1` and answer through Keepwork when AIChat
//! is logged in. Messaging (`messagingApi: messaging-v1`) hosts DingTalk (`dws`
//! listener) and Feishu (`lark-cli` polling) channels for persona bindings;
//! native agent CLI sessions and WeChat stay unadvertised.

pub mod cli;
pub mod config;
pub mod dashboard;
pub mod folders;
pub mod fs;
pub mod grep;
pub mod http;
pub mod identity;
pub mod mcp;
pub mod messaging;
pub mod paths;
pub mod personas;
pub mod presence;
pub mod shell;
pub mod terminal;
pub mod tools;
pub mod web;

pub const SERVER_NAME: &str = "keepwork-mcp";
/// Service protocol version, not the crate version (matches the Node daemon).
pub const SERVER_VERSION: &str = "0.1.2";
pub const RUNTIME_PRODUCT: &str = "keepwork-mcp-runtime";
pub const ENGINE: &str = "rust";
