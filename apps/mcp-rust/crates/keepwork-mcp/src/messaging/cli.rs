//! Channel CLI plumbing: `dws` / `lark-cli` resolution, one-shot invocation and error classification.

use super::policy::*;
use super::*;

#[derive(Debug, Clone)]
pub struct DwsError {
    // Write-only in this crate; kept `pub` for parity with the pre-split
    // module surface, where the field sat in the public `messaging` module.
    #[allow(dead_code)]
    pub uncertain: bool,
    pub message: String,
}

impl DwsError {
    pub(crate) fn uncertain(reason: impl Into<String>) -> Self {
        Self {
            uncertain: true,
            message: format!("DWS result unknown; not retried ({})", reason.into()),
        }
    }

    pub(crate) fn rejected(reason: impl Into<String>) -> Self {
        Self {
            uncertain: false,
            message: format!("DWS rejected the operation ({})", reason.into()),
        }
    }
}

pub(crate) fn is_directory(dir: &Path) -> bool {
    std::fs::metadata(dir).map(|m| m.is_dir()).unwrap_or(false)
}

pub(crate) fn version_prefixes() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let roots: [(PathBuf, &str); 3] = [
        (home.join(".nvm/versions/node"), ""),
        (home.join(".local/share/fnm/node-versions"), "installation"),
        (home.join(".nodenv/versions"), ""),
    ];
    let mut prefixes = Vec::new();
    for (root, suffix) in roots {
        let Ok(versions) = std::fs::read_dir(&root) else {
            continue;
        };
        for version in versions.flatten() {
            let mut path = version.path();
            if !suffix.is_empty() {
                path = path.join(suffix);
            }
            prefixes.push(path);
        }
    }
    prefixes
}

pub(crate) fn cli_search_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut dirs = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".volta/bin"),
        home.join(".bun/bin"),
        home.join("Library/pnpm"),
        home.join(".local/share/pnpm"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.insert(0, PathBuf::from(appdata).join("npm"));
    }
    for prefix in version_prefixes() {
        dirs.push(prefix.join("bin"));
    }
    if let Some(custom) = std::env::var_os("KEEPWORK_CLI_BIN") {
        dirs.insert(0, PathBuf::from(custom));
    }
    dirs.into_iter().filter(|dir| is_directory(dir)).collect()
}

/// Environment key for PATH; Windows spells it `Path`.
pub(crate) fn path_env_key() -> &'static str {
    if cfg!(windows) {
        "Path"
    } else {
        "PATH"
    }
}

fn inherited_path() -> std::ffi::OsString {
    std::env::var_os(path_env_key())
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default()
}

/// `first` followed by the inherited PATH, keeping existing directories and
/// dropping duplicates. Falls back to the inherited value when nothing is left.
fn merged_path(first: Vec<PathBuf>, inherited: &std::ffi::OsStr) -> String {
    let mut dirs = first;
    dirs.extend(std::env::split_paths(inherited));
    let mut unique = Vec::<PathBuf>::new();
    for dir in dirs {
        if !dir.as_os_str().is_empty() && is_directory(&dir) && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    match std::env::join_paths(unique) {
        Ok(path) if !path.is_empty() => path.to_string_lossy().into_owned(),
        _ => inherited.to_string_lossy().into_owned(),
    }
}

/// PATH for DWS/Lark children. npm installs CLIs as `#!/usr/bin/env node`
/// shims, and a GUI-launched daemon inherits a minimal PATH, so the install
/// prefixes must come first even when the caller's PATH lacks Node.
pub(crate) fn cli_child_path(program: Option<&Path>) -> String {
    let mut first: Vec<PathBuf> = Vec::new();
    if let Some(program) = program.and_then(Path::parent) {
        first.push(program.to_path_buf());
    }
    for variable in ["KEEPWORK_DWS_PATH", "KEEPWORK_LARK_PATH"] {
        if let Some(parent) = std::env::var_os(variable)
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            first.push(parent);
        }
    }
    if let Some(parent) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        first.push(parent);
    }
    first.extend(cli_search_dirs());
    merged_path(first, &inherited_path())
}

/// PATH for `run_terminal` children. The caller's own PATH keeps precedence so
/// existing commands resolve as before; the install prefixes are appended as a
/// fallback for `dws` / `lark-cli` when the daemon has only a minimal PATH.
pub(crate) fn shell_child_path() -> String {
    let inherited = inherited_path();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&inherited).collect();
    dirs.extend(cli_search_dirs());
    merged_path(dirs, &inherited)
}

pub(crate) fn global_module_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut dirs = vec![
        home.join(".npm-global/lib"),
        PathBuf::from("/usr/local/lib"),
        PathBuf::from("/opt/homebrew/lib"),
    ];
    for prefix in version_prefixes() {
        dirs.push(prefix.join("lib"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.insert(0, PathBuf::from(appdata).join("npm"));
    }
    dirs.into_iter().filter(|dir| is_directory(dir)).collect()
}

pub(crate) fn resolve_cli(
    env_var: &str,
    binary: &str,
    module_subdir: &str,
    unavailable: &str,
) -> Result<PathBuf, DwsError> {
    if let Ok(custom) = std::env::var(env_var) {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Ok(path);
        }
    }
    let mut candidates = Vec::new();
    // The caller's PATH wins over install prefixes, matching `resolveDws` in
    // `src/core/messagingDingtalk.ts`.
    for dir in std::env::split_paths(&inherited_path()) {
        candidates.push(dir.join(binary));
    }
    for dir in cli_search_dirs() {
        candidates.push(dir.join(binary));
    }
    for dir in global_module_dirs() {
        candidates.push(dir.join("node_modules").join(module_subdir).join(binary));
    }
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(DwsError {
        uncertain: false,
        message: unavailable.to_string(),
    })
}

pub(crate) fn resolve_dws() -> Result<PathBuf, DwsError> {
    let binary = if cfg!(windows) { "dws.exe" } else { "dws" };
    resolve_cli(
        "KEEPWORK_DWS_PATH",
        binary,
        "dingtalk-workspace-cli/vendor",
        "DWS CLI unavailable; install dingtalk-workspace-cli or set KEEPWORK_DWS_PATH to its native executable",
    )
}

pub(crate) fn resolve_lark() -> Result<PathBuf, DwsError> {
    let binary = if cfg!(windows) {
        "lark-cli.exe"
    } else {
        "lark-cli"
    };
    resolve_cli(
        "KEEPWORK_LARK_PATH",
        binary,
        "@larksuite/cli/bin",
        "Lark CLI unavailable; install @larksuite/cli",
    )
}

pub(crate) fn classify_cli_error(output: &str, diagnostics: &str, feishu: bool) -> DwsError {
    let error_text = format!("{output} {diagnostics}");
    if !feishu
        && regex_is_match(r"(?i)proxy", diagnostics)
        && regex_is_match(r"(?i)connection|connect|dial", diagnostics)
    {
        return DwsError::uncertain("proxy connection failed; check daemon proxy settings");
    }
    if regex_is_match(r"(?i)scope|permission|9999167[29]|forbidden", &error_text) {
        return DwsError {
            uncertain: false,
            message: "Feishu permission denied; authorize personal messaging scopes: contact:user.basic_profile:readonly offline_access search:message im:chat:read im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user".to_string(),
        };
    }
    if regex_is_match(r"(?i)token|auth login|unauthorized|未登录", &error_text) {
        return DwsError {
            uncertain: false,
            message: if feishu {
                "Feishu login required"
            } else {
                "DingTalk login required"
            }
            .into(),
        };
    }
    if feishu {
        return DwsError {
            uncertain: false,
            message: "Feishu CLI request failed".into(),
        };
    }
    DwsError::uncertain(format!(
        "exit code nonzero, invalid JSON, {} characters",
        output.len()
    ))
}

pub(crate) async fn drain_stream<S: tokio::io::AsyncRead + Unpin>(
    mut stream: S,
    cap: usize,
) -> String {
    let mut text = String::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(size) => {
                text.push_str(&String::from_utf8_lossy(&buffer[..size]));
                if text.len() > cap {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    text
}

/// Joins two futures into one, polling both so neither pipe stalls the other.
pub(crate) async fn join2<A: std::future::Future, B: std::future::Future>(
    a: A,
    b: B,
) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let mut va: Option<A::Output> = None;
    let mut vb: Option<B::Output> = None;
    std::future::poll_fn(|cx| {
        if va.is_none() {
            if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
                va = Some(v);
            }
        }
        if vb.is_none() {
            if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
                vb = Some(v);
            }
        }
        match (va.take(), vb.take()) {
            (Some(x), Some(y)) => std::task::Poll::Ready((x, y)),
            (x, y) => {
                va = x;
                vb = y;
                std::task::Poll::Pending
            }
        }
    })
    .await
}

/// One bounded one-shot JSON CLI call, mirroring `dws()` / `lark()` in Node:
/// unknown outcomes are never retried automatically.
pub(crate) async fn cli_call(
    program: &Path,
    args: &[String],
    cwd: &str,
    feishu: bool,
) -> Result<Value, DwsError> {
    let cap = if feishu { 4_000_000 } else { 2_000_000 };
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(if cwd.is_empty() { "." } else { cwd })
        .env(path_env_key(), cli_child_path(Some(program)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| DwsError::rejected("CLI could not start"))?;
    let out = child
        .stdout
        .take()
        .ok_or_else(|| DwsError::rejected("CLI could not start"))?;
    let err = child
        .stderr
        .take()
        .ok_or_else(|| DwsError::rejected("CLI could not start"))?;
    let (output, diagnostics): (String, String) = match tokio::time::timeout(
        std::time::Duration::from_millis(CLI_TIMEOUT_MS),
        join2(drain_stream(out, cap), drain_stream(err, 8000)),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            return Err(DwsError::uncertain("CLI timed out"));
        }
    };
    let code = child
        .wait()
        .await
        .map(|status| status.code())
        .unwrap_or(None);
    if code.is_none() {
        return Err(DwsError::uncertain("CLI exited without a status code"));
    }
    let value: Value = serde_json::from_str(&output)
        .map_err(|_| classify_cli_error(&output, &diagnostics, feishu))?;
    let dws_error = value.get("error").is_some_and(|error| !error.is_null());
    if code != Some(0) || dws_error {
        return Err(classify_cli_error(&output, &diagnostics, feishu));
    }
    Ok(value)
}

pub(crate) async fn dws_call(args: &[String], cwd: &str) -> Result<Value, DwsError> {
    let program = resolve_dws()?;
    cli_call(&program, args, cwd, false).await
}

pub(crate) async fn lark_call(args: &[String], cwd: &str) -> Result<Value, DwsError> {
    let program = resolve_lark()?;
    cli_call(&program, args, cwd, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kp-cli-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn merged_path_keeps_first_wins_and_drops_missing_dirs() {
        let first = scratch("first");
        let second = scratch("second");
        let inherited = std::env::join_paths([
            second.clone(),
            first.clone(),
            PathBuf::from("/definitely/missing/kp-cli"),
        ])
        .unwrap();
        let merged = merged_path(vec![first.clone()], &inherited);
        assert_eq!(
            std::env::split_paths(&merged).collect::<Vec<_>>(),
            vec![first.clone(), second.clone()]
        );
        std::fs::remove_dir_all(first).ok();
        std::fs::remove_dir_all(second).ok();
    }

    #[test]
    fn merged_path_falls_back_to_the_inherited_value() {
        let inherited = std::ffi::OsString::from("/definitely/missing/kp-cli");
        let merged = merged_path(vec![PathBuf::from("/also/missing")], &inherited);
        assert_eq!(merged, "/definitely/missing/kp-cli");
    }
}
