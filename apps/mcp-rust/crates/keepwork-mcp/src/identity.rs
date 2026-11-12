//! Build/runtime identity reported by `/health` and `/admin/status`.
//!
//! The host process injects `KEEPWORK_MCP_RUNTIME_VERSION/COMMIT/BUILT_AT`
//! exactly like it does for the Node runtime, so dashboards and update logic
//! keep working with either engine.

use serde_json::{json, Map, Value};

use crate::SERVER_VERSION;

/// Commit recorded by `build.rs`; overridable at runtime by the host.
const BUILD_COMMIT: Option<&str> = option_env!("KEEPWORK_MCP_BUILD_COMMIT");

/// Embedded build identity is independent of host-provided runtime metadata.
/// Keep the complete document in the binary so cross-target packaging can read
/// it without executing foreign code or accessing a user's profile.
pub const BUILD_INFO: &str = include_str!(concat!(env!("OUT_DIR"), "/build-info.json"));

#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub host_kind: Option<String>,
    pub host_version: Option<String>,
    pub runtime_version: Option<String>,
    pub runtime_commit: Option<String>,
    pub runtime_built_at: Option<String>,
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl Identity {
    pub fn from_env(host_kind: Option<String>, host_version: Option<String>) -> Self {
        Self {
            host_kind: host_kind.filter(|value| !value.trim().is_empty()),
            host_version: host_version.filter(|value| !value.trim().is_empty()),
            runtime_version: env_non_empty("KEEPWORK_MCP_RUNTIME_VERSION")
                .or_else(|| Some(env!("CARGO_PKG_VERSION").to_string())),
            runtime_commit: env_non_empty("KEEPWORK_MCP_RUNTIME_COMMIT")
                .or_else(|| BUILD_COMMIT.map(str::to_string)),
            runtime_built_at: env_non_empty("KEEPWORK_MCP_RUNTIME_BUILT_AT"),
        }
    }

    /// Identity fields spread into `/health` and `/admin/status`, in the same
    /// order the Node daemon emits them.
    pub fn fields(&self) -> Map<String, Value> {
        let mut map = Map::new();
        if let Some(value) = &self.runtime_version {
            map.insert("runtimeVersion".into(), json!(value));
        }
        if let Some(value) = &self.runtime_commit {
            map.insert("runtimeCommit".into(), json!(value));
        }
        if let Some(value) = &self.runtime_built_at {
            map.insert("runtimeBuiltAt".into(), json!(value));
        }
        if let Some(value) = &self.host_kind {
            map.insert("hostKind".into(), json!(value));
        }
        if let Some(value) = &self.host_version {
            map.insert("hostVersion".into(), json!(value));
        }
        map
    }
}

/// Service version constant (0.1.2), independent of the crate version.
pub fn server_version() -> &'static str {
    SERVER_VERSION
}

pub fn read_desktop_client() -> Option<Value> {
    let path = crate::config::mcp_home_dir().join("desktop-client.json");
    let content = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    let product = value.get("product")?.as_str()?;
    if product != "aichat-desktop" {
        return None;
    }
    let version = value.get("version")?.as_str()?;
    let ver_regex = regex::Regex::new(r"^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$").ok()?;
    if !ver_regex.is_match(version) {
        return None;
    }
    let platform = value.get("platform")?.as_str()?;
    if platform != "macos" && platform != "windows" {
        return None;
    }
    let arch = value.get("arch")?.as_str()?;
    if arch != "arm64" && arch != "x64" {
        return None;
    }
    let exec = value.get("executable")?.as_str()?;
    if !std::path::Path::new(exec).is_file() {
        return None;
    }
    Some(json!({
        "product": product,
        "version": version,
        "platform": platform,
        "arch": arch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_reports_service_and_runtime_versions() {
        let identity = Identity::from_env(Some("standalone".into()), None);
        let fields = identity.fields();
        assert_eq!(fields["hostKind"], "standalone");
        assert!(fields.contains_key("runtimeVersion"));
        assert!(fields.get("hostVersion").is_none());
    }
}
