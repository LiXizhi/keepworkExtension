use aichat_rust_lib::{
    runtime::{sha256_hex, RuntimeStatusSnapshot},
    updates::UpdateManager,
};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let root = std::env::temp_dir().join(format!("aichat-rust-updates-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    let installer_bytes = b"KEEPWORK_RUST_DESKTOP_UPDATE_PACKAGE_0_3_0".to_vec();
    let installer_sha = sha256_hex(&installer_bytes);
    let installer_size = installer_bytes.len() as u64;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pkg_url = format!("http://127.0.0.1:{port}/KeepWork-SecondBrain.dmg");
    let feed_url = format!("http://127.0.0.1:{port}/latest-client.json");

    let feed_body = serde_json::json!({
        "product": "aichat-desktop",
        "version": "0.3.0",
        "publishedAt": "2026-11-09T12:00:00Z",
        "fileName": "KeepWork-SecondBrain.dmg",
        "url": pkg_url,
        "sha256": installer_sha,
        "size": installer_size,
    })
    .to_string();

    let srv = thread::spawn(move || {
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                if req.contains("GET /latest-client.json") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        feed_body.len(),
                        feed_body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        installer_bytes.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(&installer_bytes);
                }
            }
        }
    });

    let manager = UpdateManager::new(
        "0.2.0".to_string(),
        root.join("update-metadata.json"),
        root.join("desktop-updates"),
        feed_url,
        None,
    );

    manager.check_desktop_update().await;
    let _ = srv.join();

    let mut mcp_snap = RuntimeStatusSnapshot::initial("mcp", 8089);
    mcp_snap.version = "0.2.80".to_string();
    mcp_snap.latest_version = "0.2.88".to_string();
    mcp_snap.pending_version = "0.2.88".to_string();
    mcp_snap.update_state = "staged".to_string();
    mcp_snap.owner = "desktop".to_string();

    let snap = manager.snapshot(&mcp_snap);
    assert!(snap.mcp.can_apply);
    assert_eq!(snap.mcp.state, "ready");
    assert!(snap.desktop.can_apply);
    assert_eq!(snap.desktop.state, "ready");
    assert_eq!(snap.desktop.latest_version, "0.3.0");

    let prepared = manager.prepare_desktop_install().unwrap();
    assert!(prepared.is_file());

    let _ = fs::remove_dir_all(&root);
    println!("updates-smoke: OK");
}
