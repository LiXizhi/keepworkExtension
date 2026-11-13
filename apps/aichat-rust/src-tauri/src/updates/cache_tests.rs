use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

struct ScratchDirectory(PathBuf);

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn manifest_checks_bust_cache_without_changing_channels_or_installer_urls() {
    for query in ["", "?token=a%2Bb%2Fc%3D&channel=stable"] {
        let scratch = ScratchDirectory(
            std::env::temp_dir().join(format!("aichat-update-cache-{}", Uuid::new_v4())),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let feed = format!("{base}/latest-client.json{query}");
        let installer_target = "/installer.dmg?token=download%2Btoken%2F%3D";
        let installer_url = format!("{base}{installer_target}");
        let payload = b"verified cache regression installer";
        let manifest = serde_json::json!({
            "version": "0.3.0", "fileName": "installer.dmg",
            "url": installer_url, "size": payload.len(), "sha256": sha256_hex(payload),
        })
        .to_string();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let mut requests = Vec::new();
                // Two manifest checks share one verified installer download.
                for expected_path in [
                    "/latest-client.json",
                    "/installer.dmg",
                    "/latest-client.json",
                ] {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut buf = [0; 1024];
                        let n = stream.read(&mut buf).await.unwrap();
                        assert!(n > 0 && request.len() + n <= 16 * 1024);
                        request.extend_from_slice(&buf[..n]);
                    }
                    let request = String::from_utf8(request).unwrap();
                    let mut line = request.lines().next().unwrap().split_whitespace();
                    assert_eq!(line.next(), Some("GET"));
                    let target = line.next().unwrap();
                    let parsed = url::Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
                    assert_eq!(parsed.path(), expected_path);
                    let bytes = if expected_path == "/latest-client.json" {
                        manifest.as_bytes()
                    } else {
                        assert_eq!(target, installer_target);
                        payload.as_slice()
                    };
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    stream.write_all(headers.as_bytes()).await.unwrap();
                    stream.write_all(bytes).await.unwrap();
                    requests.push(request);
                }
                requests
            })
            .await
            .expect("update fixture exceeded its request deadline")
        });
        let metadata_file = scratch.0.join("metadata.json");
        let downloads = scratch.0.join("downloads");
        let manager = UpdateManager::new(
            "0.2.0".into(),
            metadata_file.clone(),
            downloads.clone(),
            feed.clone(),
            None,
        );
        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(8), manager.check_desktop_update())
                .await
                .expect("desktop update check exceeded its deadline");
            let status = manager.snapshot(&RuntimeStatusSnapshot::initial("mcp", 8089));
            assert_eq!(status.desktop.state, "ready", "{}", status.desktop.error);
        }
        let requests = server.await.unwrap();
        let original = url::Url::parse(&feed).unwrap();
        let original_pairs: Vec<_> = original.query_pairs().collect();
        let mut nonces = Vec::new();
        for request in [&requests[0], &requests[2]] {
            let target = request.split_whitespace().nth(1).unwrap();
            let fetched = url::Url::parse(&format!("{base}{target}")).unwrap();
            assert_eq!(fetched.path(), original.path());
            let pairs: Vec<_> = fetched.query_pairs().collect();
            let nonce_values: Vec<_> = pairs
                .iter()
                .filter(|(key, _)| key == "kp_update_check")
                .map(|(_, value)| value.as_ref())
                .collect();
            assert_eq!(nonce_values.len(), 1);
            let nonce = Uuid::parse_str(nonce_values[0]).unwrap();
            assert_eq!(nonce.get_version_num(), 4);
            nonces.push(nonce);
            let retained: Vec<_> = pairs
                .into_iter()
                .filter(|(key, _)| key != "kp_update_check")
                .collect();
            assert_eq!(retained, original_pairs);
            assert!(request.lines().any(|line| {
                line.split_once(':').is_some_and(|(key, value)| {
                    key.eq_ignore_ascii_case("cache-control") && value.trim() == "no-cache"
                })
            }));
        }
        assert_ne!(nonces[0], nonces[1]);
        assert_eq!(manager.feed_url, feed);
        let persisted = UpdateManager::load_meta(&metadata_file);
        assert_eq!(persisted.feed_url, feed);
        assert_eq!(persisted.url, installer_url);

        let restored = UpdateManager::new("0.2.0".into(), metadata_file, downloads, feed, None);
        let mcp = RuntimeStatusSnapshot::initial("mcp", 8089);
        assert!(restored.snapshot(&mcp).desktop.can_apply);
        assert_eq!(
            fs::read(restored.prepare_desktop_install().unwrap()).unwrap(),
            payload
        );
        // The fixture has closed; the same channel still restores offline data.
        tokio::time::timeout(Duration::from_secs(3), restored.check_desktop_update())
            .await
            .unwrap();
        let offline = restored.snapshot(&mcp).desktop;
        assert!(offline.stale && offline.can_apply);
        assert_eq!(offline.latest_version, "0.3.0");
    }
}
