use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
#[path = "src/build_timestamp.rs"]
mod build_timestamp;

fn source_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).expect("read Rust sources") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            source_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("Compilation clock precedes Unix epoch")
        .as_secs();
    let source_date_epoch = match std::env::var("SOURCE_DATE_EPOCH") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => panic!("Invalid SOURCE_DATE_EPOCH: {error}"),
    };
    let (built_at_unix, built_at_source) =
        build_timestamp::select_timestamp(source_date_epoch.as_deref(), now)
            .expect("Invalid build timestamp");
    // Cargo can reuse this executable after a checkout/cache has moved. Resolve
    // inputs from the current invocation rather than its compilation directory.
    let crate_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let workspace = crate_dir.join("../..");
    let mut files = Vec::new();
    source_files(&crate_dir.join("src"), &mut files);
    files.extend([crate_dir.join("Cargo.toml"), crate_dir.join("build.rs")]);
    let mut entries = files
        .into_iter()
        .map(|path| {
            let name = format!(
                "crate/{}",
                path.strip_prefix(&crate_dir)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            );
            (name, path)
        })
        .collect::<Vec<_>>();
    for name in ["Cargo.toml", "Cargo.lock"] {
        entries.push((format!("workspace/{name}"), workspace.join(name)));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    println!("cargo:rerun-if-changed=src");
    for (name, path) in entries {
        println!("cargo:rerun-if-changed={}", path.display());
        let content = std::fs::read(&path).expect("read build input");
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(content.len().to_string().as_bytes());
        hash.update([0]);
        hash.update(&content);
    }
    let source_hash = format!("{:x}", hash.finalize());
    // Resolve Git metadata through Git itself, including linked worktrees and
    // packed refs; the crate is nested four levels below the repository root.
    let git_path = |name: &str| {
        Command::new("git")
            .args(["rev-parse", "--git-path", name])
            .current_dir(&crate_dir)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|path| crate_dir.join(path.trim()))
    };
    if let Some(head) = git_path("HEAD") {
        println!("cargo:rerun-if-changed={}", head.display());
        if let Ok(value) = std::fs::read_to_string(head) {
            if let Some(reference) = value.trim().strip_prefix("ref: ") {
                if let Some(path) = git_path(reference).filter(|path| path.is_file()) {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
    if let Some(path) = git_path("packed-refs").filter(|path| path.is_file()) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let commit = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&crate_dir)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() == 40);
    if let Some(commit) = &commit {
        println!("cargo:rustc-env=KEEPWORK_MCP_BUILD_COMMIT={commit}");
    }
    let document = format!(
        "{{\"marker\":\"keepwork-mcp-build-v1\",\"product\":\"keepwork-mcp-runtime\",\"engine\":\"rust\",\"version\":\"{}\",\"commit\":\"{}\",\"target\":\"{}\",\"sourceHash\":\"{}\",\"builtAtUnix\":{},\"builtAtSource\":\"{}\",\"capabilities\":{{\"agentSessionApi\":\"v1\",\"agentInventoryApi\":\"v1\",\"agentContextApi\":\"v1\",\"agentModeApi\":\"v1\",\"agentImageTurnApi\":\"v1\"}},\"endMarker\":\"keepwork-mcp-build-end\"}}",
        std::env::var("CARGO_PKG_VERSION").unwrap(), commit.unwrap_or_default(),
        std::env::var("TARGET").unwrap(), source_hash, built_at_unix, built_at_source
    );
    std::fs::write(
        Path::new(&std::env::var("OUT_DIR").unwrap()).join("build-info.json"),
        document,
    )
    .expect("write build identity");
}
