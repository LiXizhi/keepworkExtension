use crate::dev_server::DevServer;
use crate::files::{inside, validate_relative_path};
use crate::security::{trusted_page, ENTRY};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRecord {
    pub version: Option<String>,
    pub entry: Option<String>,
    pub web_dir: Option<String>,
    pub entry_file: Option<String>,
}

pub fn validate_entry_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trusted_page(trimmed, None) {
        return Ok(trimmed.to_string());
    }
    Err("Untrusted deployment entry URL".to_string())
}

pub fn startup_deployment(
    deployment_file: &Path,
    fallback_entry: &str,
    report: impl FnOnce(&str),
) -> (String, Option<DevServer>) {
    match open_deployment(deployment_file) {
        Ok((entry, server)) if entry != ENTRY => (entry, server),
        Ok(_) => (fallback_entry.to_string(), None),
        Err(error) => {
            let origin = url::Url::parse(fallback_entry)
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|_| "configured desktop entry".to_string());
            report(&format!(
                "Cannot open saved deployment: {error}. Falling back to {origin}"
            ));
            (fallback_entry.to_string(), None)
        }
    }
}

pub fn open_deployment(deployment_file: &Path) -> Result<(String, Option<DevServer>), String> {
    if !deployment_file.is_file() {
        return Ok((ENTRY.to_string(), None));
    }
    let raw = fs::read_to_string(deployment_file)
        .map_err(|e| format!("Failed to read deployment.json: {e}"))?;
    let record: DeploymentRecord =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid deployment.json: {e}"))?;

    if let Some(web_dir_rel) = record.web_dir.as_deref() {
        if !web_dir_rel.trim().is_empty() {
            let base_dir = deployment_file
                .parent()
                .ok_or_else(|| "Invalid deployment directory".to_string())?;
            let clean_rel = validate_relative_path(web_dir_rel)?;
            let web_dir = base_dir.join(clean_rel);
            if !inside(base_dir, &web_dir) {
                return Err("Deployment webDir escapes deployment root".to_string());
            }
            let entry_file = record.entry_file.as_deref().unwrap_or("AIChat.html");
            let clean_entry = validate_relative_path(entry_file)?;
            let entry_str = clean_entry.to_string_lossy().into_owned();
            let srv = DevServer::start(&web_dir, &entry_str, &base_dir.join("source-ports.json"))?;
            let url = srv.url();
            return Ok((url, Some(srv)));
        }
    }

    if let Some(entry) = record.entry.as_deref() {
        let valid = validate_entry_url(entry)?;
        return Ok((valid, None));
    }

    Ok((ENTRY.to_string(), None))
}

pub fn resolve_local_aichat_source_dir() -> Option<PathBuf> {
    resolve_local_aichat_source_dir_from(
        std::env::var_os("AICHAT_DESKTOP_SOURCE_DIR").map(PathBuf::from),
        std::env::var_os("AICHAT_SOURCE_DIR").map(PathBuf::from),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )
}

fn resolve_local_aichat_source_dir_from(
    custom: Option<PathBuf>,
    electron_custom: Option<PathBuf>,
    manifest_dir: &Path,
) -> Option<PathBuf> {
    // src-tauri lives at <checkout>/apps/aichat-rust/src-tauri. Match
    // Electron's sibling apps checkout without assuming a drive or username.
    let sibling_source = manifest_dir
        .join("../../../..")
        .join("apps/official/apps/tools/AIChat");
    let candidates = custom.into_iter().chain(electron_custom).chain([
        sibling_source,
        PathBuf::from("/Users/chenliao/CODE/apps/official/apps/tools/AIChat"),
        PathBuf::from("c:/lxzsrc/maisi/maisi/maisi/webgames/tools/AIChat"),
        PathBuf::from("c:/lxzsrc/apps/official/apps/tools/AIChat"),
    ]);
    for c in candidates {
        if c.join("AIChat.html").is_file() {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn deployment_diagnostics_omit_url_credentials_and_preserve_fallback() {
        let root = std::env::temp_dir().join(format!("aichat-deployment-error-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("deployment.json");
        let invalid = "https://private-user:private-password@evil.example/chat?token=private-token#private-fragment";
        fs::write(
            &file,
            serde_json::to_vec(&serde_json::json!({"entry":invalid})).unwrap(),
        )
        .unwrap();
        let fallback = "https://keepwork.com/chat?token=fallback-token#fallback-fragment";
        let mut message = String::new();
        let (entry, server) =
            startup_deployment(&file, fallback, |error| message = error.to_string());
        assert_eq!(entry, fallback);
        assert!(server.is_none());
        assert!(message.contains("Untrusted deployment entry URL"));
        assert!(message.contains("Falling back to https://keepwork.com"));
        for private in [
            "private-user",
            "private-password",
            "private-token",
            "private-fragment",
            "fallback-token",
            "fallback-fragment",
            "/chat",
        ] {
            assert!(
                !message.contains(private),
                "diagnostics must omit URL credentials and path"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// Occupies the port a stopped server just released. Parallel tests open
    /// loopback connections whose local ports come from the same ephemeral
    /// pool, so the freed port can stay busy for a moment on macOS.
    fn occupy_released_port(port: u16) -> std::net::TcpListener {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => return listener,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => panic!("cannot occupy 127.0.0.1:{port}: {error}"),
            }
        }
    }

    #[test]
    fn occupied_deployment_origin_reports_failure_without_changing_saved_state_or_occupant() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let root = std::env::temp_dir().join(format!("aichat-deployment-port-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("web")).unwrap();
        fs::write(root.join("web/AIChat.html"), "local page").unwrap();
        let deployment = root.join("deployment.json");
        fs::write(&deployment, r#"{"webDir":"web"}"#).unwrap();
        let (url, server) = open_deployment(&deployment).unwrap();
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        drop(server);
        let registry = root.join("source-ports.json");
        let before = fs::read(&registry).unwrap();
        let occupied = occupy_released_port(port);
        let mut message = String::new();
        let (entry, server) =
            startup_deployment(&deployment, ENTRY, |error| message = error.to_string());
        assert_eq!(entry, ENTRY);
        assert!(server.is_none());
        assert!(message.contains(&format!("127.0.0.1:{port}")));
        assert!(message.contains("Falling back to https://keepwork.com"));
        assert_eq!(fs::read(&registry).unwrap(), before);
        let responder = std::thread::spawn(move || {
            let (mut stream, _) = occupied.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            stream.read(&mut request).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\noccupant",
                )
                .unwrap();
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(
            response.ends_with("occupant"),
            "the unrelated service remains usable"
        );
        responder.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_sibling_checkout_and_honors_explicit_source_priority() {
        let root = std::env::temp_dir().join(format!("aichat-source-{}", Uuid::new_v4()));
        let manifest = root.join("extension/apps/aichat-rust/src-tauri");
        let sibling = root.join("apps/official/apps/tools/AIChat");
        let custom = root.join("custom");
        let electron = root.join("electron");
        for dir in [&manifest, &sibling, &custom, &electron] {
            fs::create_dir_all(dir).unwrap();
        }
        for dir in [&sibling, &custom, &electron] {
            fs::write(dir.join("AIChat.html"), "<html>local</html>").unwrap();
        }
        let found = resolve_local_aichat_source_dir_from(None, None, &manifest).unwrap();
        assert_eq!(
            fs::canonicalize(&found).unwrap(),
            fs::canonicalize(&sibling).unwrap()
        );
        assert_eq!(
            resolve_local_aichat_source_dir_from(
                Some(custom.clone()),
                Some(electron.clone()),
                &manifest
            ),
            Some(custom)
        );
        assert_eq!(
            resolve_local_aichat_source_dir_from(
                Some(root.join("missing")),
                Some(electron.clone()),
                &manifest
            ),
            Some(electron)
        );
        let server =
            DevServer::start(&found, "AIChat.html", &root.join("source-ports.json")).unwrap();
        assert!(server.url().starts_with("http://127.0.0.1:"));
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_deployment_entries_and_serves_local_bundle() {
        assert_eq!(
            validate_entry_url("https://keepwork.com/chat").unwrap(),
            "https://keepwork.com/chat"
        );
        assert!(validate_entry_url("https://evil.example/chat").is_err());

        let root = std::env::temp_dir().join(format!("aichat-rust-deploy-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("web")).unwrap();
        fs::write(root.join("web/AIChat.html"), "<html>ok</html>").unwrap();
        fs::write(
            root.join("deployment.json"),
            r#"{"version":"0.2.0","webDir":"web","entryFile":"AIChat.html"}"#,
        )
        .unwrap();

        let (url, srv) = open_deployment(&root.join("deployment.json")).unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        assert!(url.ends_with("/AIChat.html"));
        drop(srv);
        let _ = fs::remove_dir_all(&root);
    }
}
