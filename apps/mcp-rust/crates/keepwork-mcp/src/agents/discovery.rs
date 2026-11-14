//! Bounded, read-only CLI discovery. Only fixed provider arguments reach a child;
//! npm launchers are resolved to their native or JavaScript entry without a shell.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Acp,
    Codex,
    Claude,
    Antigravity,
    Trae,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Acp => "acp",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Antigravity => "antigravity",
            Self::Trae => "trae",
        }
    }

    pub fn supported(self) -> bool {
        matches!(
            self,
            Self::Acp | Self::Codex | Self::Claude | Self::Antigravity | Self::Trae
        )
    }
}

pub struct BackendDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub protocol: Protocol,
    pub commands: &'static [&'static str],
    pub args: &'static [&'static str],
    pub npm: Option<&'static str>,
    pub login: &'static str,
    pub install_url: &'static str,
}

pub const BACKENDS: &[&str] = &[
    "codex",
    "workbuddy",
    "copilot",
    "claude",
    "cursor",
    "trae",
    "qwen",
    "gemini",
    "kimi",
    "codebuddy",
    "opencode",
    "deepseek",
];

static DEFINITIONS: &[BackendDefinition] = &[
    BackendDefinition {
        id: "codex",
        name: "Codex",
        protocol: Protocol::Codex,
        commands: &["codex"],
        args: &["app-server", "--stdio"],
        npm: Some("@openai/codex"),
        login: "codex login",
        install_url: "https://developers.openai.com/codex/cli/",
    },
    BackendDefinition {
        id: "workbuddy",
        name: "WorkBuddy",
        protocol: Protocol::Acp,
        commands: &["codebuddy", "workbuddy", "cbc", "codebuddy-code"],
        args: &["--acp"],
        npm: Some("@tencent-ai/codebuddy-code"),
        login: "codebuddy /login",
        install_url: "https://www.codebuddy.cn/docs/cli/installation",
    },
    BackendDefinition {
        id: "copilot",
        name: "Copilot",
        protocol: Protocol::Acp,
        commands: &["copilot"],
        args: &["--acp", "--stdio", "--no-auto-update"],
        npm: Some("@github/copilot"),
        login: "copilot login",
        install_url:
            "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli",
    },
    BackendDefinition {
        id: "claude",
        name: "Claude Code",
        protocol: Protocol::Claude,
        commands: &["claude"],
        args: &[],
        npm: Some("@anthropic-ai/claude-code"),
        login: "claude auth login",
        install_url: "https://code.claude.com/docs/en/setup",
    },
    BackendDefinition {
        id: "cursor",
        name: "Cursor",
        protocol: Protocol::Acp,
        commands: &["cursor-agent", "agent"],
        args: &["acp"],
        npm: None,
        login: "agent login",
        install_url: "https://cursor.com/docs/cli/installation",
    },
    BackendDefinition {
        id: "trae",
        name: "Trae Agent",
        protocol: Protocol::Trae,
        commands: &["trae-cli"],
        args: &[],
        npm: None,
        login: "trae-cli --help",
        install_url: "https://github.com/bytedance/trae-agent",
    },
    BackendDefinition {
        id: "qwen",
        name: "Qwen Code",
        protocol: Protocol::Acp,
        commands: &["qwen"],
        args: &["--acp"],
        npm: Some("@qwen-code/qwen-code"),
        login: "qwen",
        install_url: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
    },
    BackendDefinition {
        id: "gemini",
        name: "Antigravity CLI",
        protocol: Protocol::Antigravity,
        commands: &["agy"],
        args: &[
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ],
        npm: None,
        login: "agy",
        install_url: "https://antigravity.google/docs/cli/install/",
    },
    BackendDefinition {
        id: "kimi",
        name: "Kimi CLI",
        protocol: Protocol::Acp,
        commands: &["kimi"],
        args: &["acp"],
        npm: Some("@moonshot-ai/kimi-code"),
        login: "kimi login",
        install_url: "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html",
    },
    BackendDefinition {
        id: "codebuddy",
        name: "CodeBuddy",
        protocol: Protocol::Acp,
        commands: &["codebuddy", "cbc", "codebuddy-code"],
        args: &["--acp"],
        npm: Some("@tencent-ai/codebuddy-code"),
        login: "codebuddy /login",
        install_url: "https://www.codebuddy.cn/docs/cli/installation",
    },
    BackendDefinition {
        id: "opencode",
        name: "OpenCode",
        protocol: Protocol::Acp,
        commands: &["opencode"],
        args: &["acp"],
        npm: Some("opencode-ai"),
        login: "opencode auth login",
        install_url: "https://opencode.ai/docs/",
    },
    BackendDefinition {
        id: "deepseek",
        name: "DeepSeek Harness",
        protocol: Protocol::Acp,
        commands: &["dsh"],
        args: &["--profile", "acp"],
        npm: Some("@deepseek-ai/dsh"),
        login: "dsh web",
        install_url: "https://github.com/deepseek-ai/deepseek-harness",
    },
];

pub fn definition(id: &str) -> Option<&'static BackendDefinition> {
    DEFINITIONS.iter().find(|definition| definition.id == id)
}

#[derive(Debug, Clone)]
pub struct CliLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub path: PathBuf,
    pub source: String,
}

impl CliLaunch {
    pub fn info(&self) -> Value {
        json!({ "path": self.path, "source": self.source })
    }
}

fn entries(root: &Path) -> Vec<PathBuf> {
    let mut result = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .take(128)
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    result.sort_by(|a, b| b.cmp(a));
    result
}

fn usable_file(path: &Path, script: bool) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        script || metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = script;
        true
    }
}

fn node_script(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if ["js", "cjs", "mjs"]
        .iter()
        .any(|expected| extension.eq_ignore_ascii_case(expected))
    {
        return true;
    }
    let mut head = [0u8; 256];
    let size = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    let text = String::from_utf8_lossy(&head[..size]);
    text.starts_with("#!")
        && text.lines().next().is_some_and(|line| {
            line.split(|c: char| c.is_whitespace() || c == '/')
                .any(|word| word == "node")
        })
}

pub fn search_dirs() -> Vec<PathBuf> {
    let home = crate::config::os_home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let inherited = std::env::var_os("PATH")
        .or_else(|| std::env::var_os("Path"))
        .unwrap_or_default();
    let mut result = std::env::split_paths(&inherited)
        .filter(|path| path.is_absolute())
        .collect::<Vec<_>>();
    if let Some(custom) = std::env::var_os("KEEPWORK_CLI_BIN") {
        result.push(PathBuf::from(custom));
    }
    for relative in [
        ".local/bin",
        ".npm-global/bin",
        ".npm/bin",
        ".volta/bin",
        ".bun/bin",
        "Library/pnpm",
        ".local/share/pnpm",
        ".codebuddy/bin",
        ".claude/bin",
        ".cursor/bin",
        ".opencode/bin",
        ".kimi/bin",
        ".trae/bin",
        "scoop/shims",
    ] {
        result.push(home.join(relative));
    }
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        result.push(PathBuf::from(directory));
    }
    if let Some(prefix) = std::env::var_os("npm_config_prefix") {
        result.push(PathBuf::from(prefix).join(if cfg!(windows) { "" } else { "bin" }));
    }
    for (root, suffix) in [
        (
            std::env::var_os("NVM_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".nvm"))
                .join("versions/node"),
            "bin",
        ),
        (
            home.join(".local/share/fnm/node-versions"),
            "installation/bin",
        ),
        (home.join(".nodenv/versions"), "bin"),
    ] {
        result.extend(entries(&root).iter().map(|path| path.join(suffix)));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        result.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        for relative in [
            "Microsoft/WinGet/Links",
            "codebuddy/bin",
            "agy/bin",
            "Programs/cursor-agent",
            "cursor-agent",
        ] {
            result.push(local.join(relative));
        }
    }
    let mut seen = HashSet::new();
    result.retain(|path| path.is_absolute() && seen.insert(path.clone()));
    result
}

fn node_executable(directories: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KEEPWORK_NODE_PATH").map(PathBuf::from) {
        if path.is_absolute() && usable_file(&path, false) {
            return Some(path);
        }
    }
    directories
        .iter()
        .map(|path| path.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|path| usable_file(path, false))
}

fn launch_path(
    path: &Path,
    source: &str,
    definition: &BackendDefinition,
    directories: &[PathBuf],
) -> Option<CliLaunch> {
    // Rust's Windows Command can implicitly invoke cmd.exe for batch files.
    // A configured path never authorizes evaluating shell launcher text.
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["cmd", "bat", "ps1"]
                .iter()
                .any(|shell| extension.eq_ignore_ascii_case(shell))
        })
    {
        return None;
    }
    let script = node_script(path);
    if !usable_file(path, script) {
        return None;
    }
    let mut args = definition
        .args
        .iter()
        .map(|arg| arg.to_string())
        .collect::<Vec<_>>();
    let executable = if script {
        args.insert(0, path.to_string_lossy().into_owned());
        node_executable(directories)?
    } else {
        path.to_path_buf()
    };
    Some(CliLaunch {
        executable,
        args,
        path: path.to_path_buf(),
        source: source.to_string(),
    })
}

fn verified_cursor_alias(path: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    if real
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cursor-agent")
                || name.eq_ignore_ascii_case("cursor-agent.exe")
        })
    {
        return true;
    }
    path.parent()
        .and_then(|parent| {
            std::fs::canonicalize(parent.join(if cfg!(windows) {
                "cursor-agent.exe"
            } else {
                "cursor-agent"
            }))
            .ok()
        })
        .is_some_and(|sibling| sibling == real)
}

fn confined_child(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = PathBuf::from(relative.replace('\\', "/"));
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(root.join(relative))
}

/// Read a reviewed npm .cmd layout without evaluating any of the shell text.
fn windows_shim(
    path: &Path,
    source: &str,
    definition: &BackendDefinition,
    directories: &[PathBuf],
) -> Option<CliLaunch> {
    let root = path.parent()?;
    let native = path.with_extension("exe");
    if let Some(launch) = launch_path(&native, source, definition, directories) {
        return Some(launch);
    }
    let text = std::fs::read_to_string(path).ok()?;
    if text.len() > 32_768 {
        return None;
    }
    let regex = regex::Regex::new(r#"(?i)"%(?:dp0|~dp0)%?\\?([^"\r\n]+)""#).ok()?;
    for capture in regex.captures_iter(&text) {
        let target = confined_child(root, &capture[1])?;
        if node_script(&target) {
            if let Some(launch) = launch_path(&target, source, definition, directories) {
                return Some(launch);
            }
        }
    }
    None
}

fn directory_launch(
    directory: &Path,
    source: &str,
    definition: &BackendDefinition,
    directories: &[PathBuf],
) -> Option<CliLaunch> {
    for name in definition.commands {
        let path = directory.join(format!("{name}{}", if cfg!(windows) { ".exe" } else { "" }));
        if definition.id == "cursor" && *name == "agent" && !verified_cursor_alias(&path) {
            continue;
        }
        if let Some(launch) = launch_path(&path, source, definition, directories) {
            return Some(launch);
        }
        if cfg!(windows) {
            if let Some(launch) = windows_shim(
                &directory.join(format!("{name}.cmd")),
                source,
                definition,
                directories,
            ) {
                return Some(launch);
            }
        }
    }
    // Official Windows Cursor installs bundle Node beside their own fixed entry.
    if cfg!(windows) && definition.id == "cursor" && directory.join("cursor-agent.ps1").is_file() {
        for root in
            std::iter::once(directory.to_path_buf()).chain(entries(&directory.join("versions")))
        {
            let executable = root.join("node.exe");
            let entry = root.join("index.js");
            if usable_file(&executable, false) && usable_file(&entry, true) {
                let mut args = vec![entry.to_string_lossy().into_owned()];
                args.extend(definition.args.iter().map(|arg| arg.to_string()));
                return Some(CliLaunch {
                    executable,
                    args,
                    path: entry,
                    source: source.to_string(),
                });
            }
        }
    }
    None
}

pub fn discover(backend: &str) -> Result<CliLaunch, String> {
    let definition = definition(backend).ok_or_else(|| "Unsupported agent backend".to_string())?;
    let directories = search_dirs();
    let variable = format!(
        "KEEPWORK_{}_PATH",
        if backend == "gemini" {
            "ANTIGRAVITY".to_string()
        } else {
            backend.to_ascii_uppercase()
        }
    );
    if let Some(configured) = std::env::var_os(&variable).filter(|value| !value.is_empty()) {
        let configured = configured.to_string_lossy();
        let expanded = if let Some(relative) = configured.strip_prefix("~/") {
            crate::config::os_home_dir()
                .unwrap_or_default()
                .join(relative)
        } else {
            PathBuf::from(configured.as_ref())
        };
        let candidates = if expanded.is_absolute() {
            vec![expanded]
        } else {
            directories
                .iter()
                .map(|directory| directory.join(&expanded))
                .collect()
        };
        for candidate in candidates {
            let extension = candidate
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("");
            if extension.eq_ignore_ascii_case("cmd")
                || extension.eq_ignore_ascii_case("ps1")
                || extension.eq_ignore_ascii_case("bat")
            {
                if let Some(launch) =
                    windows_shim(&candidate, "configured", definition, &directories)
                {
                    return Ok(launch);
                }
                continue;
            }
            if let Some(launch) = launch_path(&candidate, "configured", definition, &directories) {
                return Ok(launch);
            }
            if cfg!(windows) {
                if let Some(launch) = launch_path(
                    &candidate.with_extension("exe"),
                    "configured",
                    definition,
                    &directories,
                ) {
                    return Ok(launch);
                }
            }
        }
        return Err(format!("Configured {} CLI not found or unsupported launcher. Fix {variable}; select its native executable or JavaScript entry.", definition.name));
    }
    let inherited = std::env::var_os("PATH")
        .or_else(|| std::env::var_os("Path"))
        .unwrap_or_default();
    let inherited_dirs = std::env::split_paths(&inherited).collect::<Vec<_>>();
    for directory in &directories {
        let source = if inherited_dirs.contains(directory) {
            "PATH"
        } else {
            "common"
        };
        if let Some(launch) = directory_launch(directory, source, definition, &directories) {
            return Ok(launch);
        }
    }
    if let Some(package) = definition.npm {
        for directory in &directories {
            for modules in [
                directory.join("node_modules"),
                directory.join("../lib/node_modules"),
            ] {
                let package_root = modules.join(package);
                let Ok(bytes) = std::fs::read(package_root.join("package.json")) else {
                    continue;
                };
                if bytes.len() > 1_000_000 {
                    continue;
                }
                let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                let bins = if let Some(bin) = manifest["bin"].as_str() {
                    vec![bin]
                } else {
                    definition
                        .commands
                        .iter()
                        .filter_map(|name| manifest["bin"][*name].as_str())
                        .collect()
                };
                for bin in bins {
                    if let Some(path) = confined_child(&package_root, bin) {
                        if let Some(launch) = launch_path(&path, "npm", definition, &directories) {
                            return Ok(launch);
                        }
                    }
                }
            }
        }
    }
    let home = crate::config::os_home_dir().unwrap_or_default();
    let app_roots = if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        vec![PathBuf::from("/Applications"), home.join("Applications")]
    };
    for root in app_roots {
        if backend == "codex" && cfg!(target_os = "macos") {
            for app in ["Codex.app", "ChatGPT.app"] {
                if let Some(launch) = launch_path(
                    &root.join(app).join("Contents/Resources/codex"),
                    "desktop",
                    definition,
                    &directories,
                ) {
                    return Ok(launch);
                }
            }
        }
        if backend == "workbuddy" || backend == "codebuddy" {
            for app in ["WorkBuddy", "CodeBuddy"] {
                let resources = if cfg!(windows) {
                    root.join(app).join("resources")
                } else {
                    root.join(format!("{app}.app")).join("Contents/Resources")
                };
                if let Some(launch) = launch_path(
                    &resources.join("app.asar.unpacked/cli/bin/codebuddy"),
                    "desktop",
                    definition,
                    &directories,
                ) {
                    return Ok(launch);
                }
            }
        }
    }
    Err(format!("{} CLI not found in PATH or common installation locations. Install its CLI or set {variable}.", definition.name))
}

pub fn child_path(launch: &CliLaunch) -> OsString {
    let mut directories = launch
        .executable
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    directories.extend(search_dirs());
    let mut seen = HashSet::new();
    directories.retain(|directory| directory.is_dir() && seen.insert(directory.clone()));
    std::env::join_paths(directories)
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contracts_match_known_native_commands() {
        assert_eq!(definition("workbuddy").unwrap().args, &["--acp"]);
        assert_eq!(definition("workbuddy").unwrap().commands[0], "codebuddy");
        assert_eq!(definition("codex").unwrap().protocol, Protocol::Codex);
        assert!(definition("claude").unwrap().protocol.supported());
        assert_eq!(
            definition("gemini").unwrap().protocol,
            Protocol::Antigravity
        );
        assert!(definition("gemini").unwrap().protocol.supported());
        assert!(definition("other").is_none());
    }

    #[test]
    fn package_entries_and_shell_wrappers_cannot_escape() {
        let root = Path::new("/tmp/reviewed-package");
        assert!(confined_child(root, "../evil.js").is_none());
        assert!(confined_child(root, "nested/../../evil.js").is_none());
        assert!(confined_child(root, "/evil.js").is_none());
        assert_eq!(
            confined_child(root, "dist/cli.cjs"),
            Some(root.join("dist/cli.cjs"))
        );
    }
}
