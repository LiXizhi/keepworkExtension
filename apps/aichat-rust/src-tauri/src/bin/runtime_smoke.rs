use aichat_rust_lib::runtime::{
    create_zip_from_dir, current_runtime_arch, current_runtime_platform, sha256_hex,
    validate_runtime_dir, RuntimeConfig, RuntimeManifest, RuntimeSupervisor, RuntimeUpdateManifest,
};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let root = std::env::temp_dir().join(format!("aichat-rust-runtime-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    // 1. Prepare bundled v0.2.80 runtime and remote v0.2.88 update package
    let bundled_dir = root.join("bundled-mcp");
    fs::create_dir_all(bundled_dir.join("bin")).unwrap();
    fs::write(bundled_dir.join("bin/node"), "#!/bin/sh\n").unwrap();
    fs::write(bundled_dir.join("cli.js"), "console.log('bundled');\n").unwrap();

    let bundled_manifest = RuntimeManifest {
        product: "keepwork-mcp-node-runtime".to_string(),
        platform: current_runtime_platform().to_string(),
        arch: current_runtime_arch().to_string(),
        version: "0.2.80".to_string(),
        commit: "1".repeat(40),
        built_at: "2026-11-01T00:00:00Z".to_string(),
        node: "bin/node".to_string(),
        entry: "cli.js".to_string(),
        args: vec![],
        env: Default::default(),
    };
    fs::write(
        bundled_dir.join("runtime.json"),
        serde_json::to_string_pretty(&bundled_manifest).unwrap(),
    )
    .unwrap();

    let remote_src = root.join("remote-mcp-src");
    fs::create_dir_all(remote_src.join("bin")).unwrap();
    fs::write(remote_src.join("bin/node"), "#!/bin/sh\n").unwrap();
    fs::write(remote_src.join("cli.js"), "console.log('updated');\n").unwrap();
    let remote_commit = "2".repeat(40);
    let remote_rt_manifest = RuntimeManifest {
        product: "keepwork-mcp-node-runtime".to_string(),
        platform: current_runtime_platform().to_string(),
        arch: current_runtime_arch().to_string(),
        version: "0.2.88".to_string(),
        commit: remote_commit.clone(),
        built_at: "2026-11-09T00:00:00Z".to_string(),
        node: "bin/node".to_string(),
        entry: "cli.js".to_string(),
        args: vec![],
        env: Default::default(),
    };
    fs::write(
        remote_src.join("runtime.json"),
        serde_json::to_string_pretty(&remote_rt_manifest).unwrap(),
    )
    .unwrap();

    let zip_file = root.join("mcp-0.2.88.zip");
    create_zip_from_dir(&remote_src, &zip_file).unwrap();
    let zip_bytes = fs::read(&zip_file).unwrap();
    let zip_sha = sha256_hex(&zip_bytes);
    let zip_size = zip_bytes.len() as u64;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let feed_port = listener.local_addr().unwrap().port();
    let zip_url = format!("http://127.0.0.1:{feed_port}/mcp.zip");
    let feed_url = format!("http://127.0.0.1:{feed_port}/feed.json");

    let feed_manifest = RuntimeUpdateManifest {
        schema_version: 1,
        product: "keepwork-mcp-node-runtime".to_string(),
        platform: current_runtime_platform().to_string(),
        arch: current_runtime_arch().to_string(),
        version: "0.2.88".to_string(),
        commit: remote_commit.clone(),
        built_at: "2026-11-09T00:00:00Z".to_string(),
        url: zip_url,
        sha256: zip_sha.clone(),
        size: zip_size,
    };
    let feed_json = serde_json::to_string(&feed_manifest).unwrap();

    let srv = thread::spawn(move || {
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                if req.contains("GET /feed.json") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        feed_json.len(),
                        feed_json
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        zip_bytes.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(&zip_bytes);
                }
            }
        }
    });

    let store_dir = root.join("mcp-runtimes");
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".to_string(),
        product: "keepwork-mcp-node-runtime".to_string(),
        port: 18099,
        health_path: "/health".to_string(),
        updates_enabled: true,
        bundled_dir,
        store_dir: store_dir.clone(),
        feed_url,
    });

    let (snap, newly_staged) = supervisor.check_for_update().await;
    let _ = srv.join();
    assert!(newly_staged);
    assert_eq!(snap.update_state, "staged");
    assert_eq!(snap.pending_version, "0.2.88");

    let staged_manifest =
        validate_runtime_dir(&store_dir.join(&zip_sha), "keepwork-mcp-node-runtime").unwrap();
    assert_eq!(staged_manifest.version, "0.2.88");

    // Promote pending update on next selection
    let (_, promoted_manifest, promoted_hash) = supervisor.select_best_local_runtime(true).unwrap();
    assert_eq!(promoted_manifest.version, "0.2.88");
    assert_eq!(promoted_hash.as_deref(), Some(zip_sha.as_str()));

    let _ = fs::remove_dir_all(&root);
    println!("runtime-smoke: OK");
}
