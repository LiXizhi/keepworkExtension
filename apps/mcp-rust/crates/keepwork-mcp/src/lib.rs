//! Keepwork local MCP daemon.
//!
//! P0 scope: process lifecycle, config/paths, loopback HTTP with the same
//! CORS/auth contract as the Node daemon, `/health`, `/exists`, `/fs/stat`,
//! `/admin/status|stop`, and the MCP handshake (`initialize`, `tools/list`,
//! `tools/call` for `mcp_status`). Every further route is added in later
//! phases; unimplemented routes must answer exactly like an unknown route so
//! clients never see a half-advertised capability.

pub mod cli;
pub mod config;
pub mod http;
pub mod identity;
pub mod mcp;
pub mod paths;
pub mod tools;

pub const SERVER_NAME: &str = "keepwork-mcp";
/// Service protocol version, not the crate version (matches the Node daemon).
pub const SERVER_VERSION: &str = "0.1.2";
pub const RUNTIME_PRODUCT: &str = "keepwork-mcp-runtime";
pub const ENGINE: &str = "rust";
