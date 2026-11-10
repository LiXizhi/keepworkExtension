//! Keepwork local MCP daemon.
//!
//! P1 scope: process lifecycle, config/paths, loopback HTTP with the same
//! CORS/auth contract as the Node daemon, `/health`, `/exists`, the full `/fs/*`
//! surface, PTY `/terminal/*` sessions, `/admin/status|stop`, the MCP handshake
//! and the five portable tools (`mcp_status`, `run_terminal`, `grep_files`,
//! `web_search`, `fetch_url`). Surfaces that are not implemented stay
//! unadvertised so clients degrade instead of calling a 404.

pub mod cli;
pub mod config;
pub mod folders;
pub mod fs;
pub mod grep;
pub mod http;
pub mod identity;
pub mod mcp;
pub mod paths;
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
