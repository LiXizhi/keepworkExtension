use super::*;
use std::io::{Read, Write};

fn fixture_manifest(version: &str) -> RuntimeUpdateManifest {
    RuntimeUpdateManifest {
        schema_version: 2,
        product: RUST_MCP_PRODUCT.into(),
        engine: Some("rust".into()),
        platform: mcp_feed_platform().into(),
        arch: current_runtime_arch().into(),
        version: version.into(),
        commit: "a".repeat(40),
        built_at: String::new(),
        url: "https://cdn.keepwork.com/test.zip".into(),
        sha256: "b".repeat(64),
        size: 100,
    }
}

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("kp-native-update-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

// Windows CI builds on D: and uses C: for temporary runtime fixtures. Keep
// zero-copy hard links when available, but preserve the exact executable bytes
// across volumes instead of requiring the test profile to live on one drive.
fn install_fixture_executable(destination: &Path) {
    let executable = std::env::current_exe().unwrap();
    match fs::hard_link(&executable, destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            fs::copy(executable, destination).unwrap();
        }
        Err(error) => panic!("Cannot install fixture executable: {error}"),
    }
}

fn write_bundle(dir: &Path, feed: &RuntimeUpdateManifest) {
    fs::create_dir_all(dir.join("bin")).unwrap();
    let target = match (mcp_feed_platform(), current_runtime_arch()) {
        ("macos", "arm64") => "aarch64-apple-darwin",
        ("macos", _) => "x86_64-apple-darwin",
        ("windows", "arm64") => "aarch64-pc-windows-msvc",
        ("windows", _) => "x86_64-pc-windows-msvc",
        ("linux", "arm64") => "aarch64-unknown-linux-gnu",
        _ => "x86_64-unknown-linux-gnu",
    };
    let entry = if cfg!(windows) {
        "bin/keepwork-mcp.exe"
    } else {
        "bin/keepwork-mcp"
    };
    let identity = format!("{{\"marker\":\"keepwork-mcp-build-v1\",\"product\":\"keepwork-mcp-runtime\",\"engine\":\"rust\",\"version\":\"{}\",\"commit\":\"{}\",\"target\":\"{target}\",\"sourceHash\":\"{}\",\"endMarker\":\"keepwork-mcp-build-end\"}}", feed.version, feed.commit, "c".repeat(64));
    fs::write(dir.join(entry), identity).unwrap();
    fs::write(
        dir.join("runtime.json"),
        json!({"schemaVersion":2,"product":feed.product,
        "engine":"rust","platform":feed.platform,"arch":feed.arch,"version":feed.version,
        "commit":feed.commit,"entry":entry})
        .to_string(),
    )
    .unwrap();
}

#[test]
fn feeds_preserve_node_v1_and_require_explicit_rust_v2() {
    let rust = fixture_manifest("0.3.0");
    assert!(validate_update_manifest(
        &rust,
        RUST_MCP_PRODUCT,
        mcp_feed_platform(),
        current_runtime_arch()
    )
    .is_ok());
    for (schema, engine) in [
        (1, Some("rust")),
        (2, None),
        (2, Some("node")),
        (3, Some("rust")),
    ] {
        let mut wrong = rust.clone();
        wrong.schema_version = schema;
        wrong.engine = engine.map(str::to_string);
        assert!(validate_update_manifest(
            &wrong,
            RUST_MCP_PRODUCT,
            mcp_feed_platform(),
            current_runtime_arch()
        )
        .is_err());
    }
    let mut node = rust.clone();
    node.schema_version = 1;
    node.product = "keepwork-mcp-node-runtime".into();
    node.engine = None;
    assert!(validate_update_manifest(
        &node,
        &node.product,
        mcp_feed_platform(),
        current_runtime_arch()
    )
    .is_ok());
    assert!(validate_update_manifest(
        &node,
        RUST_MCP_PRODUCT,
        mcp_feed_platform(),
        current_runtime_arch()
    )
    .is_err());
    assert!(default_mcp_feed_url(true).contains("/mcp-stable-rs/"));
    assert!(!default_mcp_feed_url(false).contains("/mcp-stable-rs/"));
    for url in [
        "http://example.com/test.zip",
        "https://user:password@cdn.keepwork.com/a",
        "https://cdn.keepwork.com/a#x",
        "file:///tmp/test",
    ] {
        assert!(validate_update_url(url).is_err());
    }
}

#[test]
fn cached_release_metadata_requires_the_exact_update_source_without_migrating_runtimes() {
    for mismatch in [
        "legacy", "product", "engine", "platform", "arch", "feed", "same",
    ] {
        let root = root();
        let config = RuntimeConfig {
            id: "mcp".into(),
            products: vec![RUST_MCP_PRODUCT.into()],
            port: 0,
            health_path: "/health".into(),
            updates_enabled: true,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: default_mcp_feed_url(true),
        };
        let mut source = config.update_source();
        match mismatch {
            "product" => source.product = "keepwork-mcp-node-runtime".into(),
            "engine" => source.engine = "node".into(),
            "platform" => source.platform = "another-platform".into(),
            "arch" => source.arch = "another-arch".into(),
            "feed" => source.feed_url.push_str("?another-stream=1"),
            _ => {}
        }
        let record = ActiveRuntimeRecord {
            current: Some("current".into()),
            previous: Some("previous".into()),
            pending: Some("pending".into()),
            failed: Some("failed".into()),
            notified: Some("pending".into()),
            latest_version: Some("0.5.0".into()),
            latest_built_at: Some("2026-11-13T08:00:00Z".into()),
            latest_source: (mismatch != "legacy").then_some(source),
            checked_at: Some("123".into()),
        };
        for (directory, version) in [
            ("current", "0.3.0"),
            ("previous", "0.2.0"),
            ("pending", "0.4.0"),
        ] {
            write_bundle(
                &config.store_dir.join(directory),
                &fixture_manifest(version),
            );
        }
        let active = config.store_dir.join("active.json");
        atomic_json_write(&active, &record).unwrap();
        let saved_bytes = fs::read(&active).unwrap();
        let supervisor = RuntimeSupervisor::new(config);
        let snapshot = supervisor.snapshot();
        if mismatch == "same" {
            assert_eq!(snapshot.latest_version, "0.5.0");
            assert_eq!(snapshot.latest_built_at, "2026-11-13T08:00:00Z");
        } else {
            assert!(snapshot.latest_version.is_empty(), "{mismatch}");
            assert!(snapshot.latest_built_at.is_empty(), "{mismatch}");
        }
        assert_eq!(snapshot.pending_version, "0.4.0", "{mismatch}");
        assert_eq!(snapshot.update_state, "staged", "{mismatch}");
        assert_eq!(fs::read(active).unwrap(), saved_bytes, "{mismatch}");
        assert_eq!(
            RuntimeSupervisor::load_active_record(&root.join("store")),
            record,
            "source metadata migration must not rewrite activation identities"
        );
        for directory in ["current", "previous", "pending"] {
            assert!(root
                .join("store")
                .join(directory)
                .join("runtime.json")
                .is_file());
        }
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn missing_feed_preserves_only_the_same_source_release_cache() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = root();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let feed_url = format!(
        "http://127.0.0.1:{}/feed",
        listener.local_addr().unwrap().port()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        let length = socket.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..length]).starts_with("GET /feed "));
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let config = RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: true,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url,
    };
    let record = ActiveRuntimeRecord {
        latest_version: Some("0.3.0".into()),
        latest_built_at: Some("2026-11-13T08:00:00Z".into()),
        latest_source: Some(config.update_source()),
        ..Default::default()
    };
    let active = config.store_dir.join("active.json");
    atomic_json_write(&active, &record).unwrap();
    let saved_bytes = fs::read(&active).unwrap();
    let supervisor = RuntimeSupervisor::new(config);
    assert_eq!(supervisor.snapshot().latest_version, "0.3.0");
    let (failed, newly_staged) = supervisor.check_for_update().await;
    server.await.unwrap();
    assert!(!newly_staged);
    assert_eq!(failed.update_state, "error");
    assert!(failed.update_error.contains("404"));
    assert_eq!(failed.latest_version, "0.3.0");
    assert_eq!(failed.latest_built_at, "2026-11-13T08:00:00Z");
    let card = crate::updates::UpdateManager::build_mcp_component(&failed);
    assert!(card.stale);
    assert_eq!(card.state, "error");
    assert!(!card.can_apply);
    assert_eq!(fs::read(active).unwrap(), saved_bytes);
    assert!(supervisor.child.lock().unwrap().is_none());
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unavailable_feed_keeps_diagnostic_causes_and_cached_release_identity() {
    let root = root();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let config = RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: true,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: format!("http://127.0.0.1:{port}/feed?token=private-query"),
    };
    let record = ActiveRuntimeRecord {
        latest_version: Some("0.3.0".into()),
        latest_built_at: Some("2026-11-13T08:00:00Z".into()),
        latest_source: Some(config.update_source()),
        ..Default::default()
    };
    let active = config.store_dir.join("active.json");
    atomic_json_write(&active, &record).unwrap();
    let saved_bytes = fs::read(&active).unwrap();
    let supervisor = RuntimeSupervisor::new(config);
    let (failed, newly_staged) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        supervisor.check_for_update(),
    )
    .await
    .expect("failed runtime update check exceeded its deadline");
    assert!(!newly_staged);
    assert_eq!(failed.update_state, "error");
    assert!(
        failed.update_error.starts_with("更新清单暂不可用："),
        "{}",
        failed.update_error
    );
    assert!(
        failed.update_error.contains("connect"),
        "{}",
        failed.update_error
    );
    assert!(
        !failed.update_error.contains("private-query"),
        "{}",
        failed.update_error
    );
    assert!(
        !failed.update_error.contains("token="),
        "{}",
        failed.update_error
    );
    assert_eq!(failed.latest_version, "0.3.0");
    assert_eq!(failed.latest_built_at, "2026-11-13T08:00:00Z");
    let card = crate::updates::UpdateManager::build_mcp_component(&failed);
    assert!(card.stale);
    assert_eq!(card.state, "error");
    assert_eq!(fs::read(active).unwrap(), saved_bytes);
    assert!(supervisor.child.lock().unwrap().is_none());
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rust_archive_checks_actual_binary_and_manifest_target() {
    let root = root();
    let feed = fixture_manifest("0.3.0");
    write_bundle(&root, &feed);
    assert!(validate_staged_runtime(&root, &feed).is_ok());
    let mut wrong = feed.clone();
    wrong.arch = "other".into();
    assert!(validate_staged_runtime(&root, &wrong).is_err());
    let mut runtime: Value =
        serde_json::from_slice(&fs::read(root.join("runtime.json")).unwrap()).unwrap();
    runtime["engine"] = json!("node");
    fs::write(root.join("runtime.json"), runtime.to_string()).unwrap();
    assert!(validate_staged_runtime(&root, &feed).is_err());
    write_bundle(&root, &feed);
    let entry = if cfg!(windows) {
        "bin/keepwork-mcp.exe"
    } else {
        "bin/keepwork-mcp"
    };
    fs::write(root.join(entry), "wrong executable").unwrap();
    assert!(validate_staged_runtime(&root, &feed).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_pending_cannot_downgrade_the_verified_current_runtime() {
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    write_bundle(&root.join("store/current"), &fixture_manifest("0.4.0"));
    write_bundle(&root.join("store/pending"), &fixture_manifest("0.3.0"));
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let record = ActiveRuntimeRecord {
        current: Some("current".into()),
        pending: Some("pending".into()),
        ..Default::default()
    };
    supervisor.save_active_record(&record).unwrap();
    let (_, manifest, selected) = supervisor.select_best_local_runtime(true).unwrap();
    assert_eq!(
        manifest.version, "0.4.0",
        "startup must retain the newest verified runtime"
    );
    assert_eq!(selected.as_deref(), Some("current"));
    assert_eq!(
        RuntimeSupervisor::load_active_record(&root.join("store")),
        record
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_equal_version_repack_keeps_current_until_explicit_apply() {
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    write_bundle(&root.join("store/current"), &fixture_manifest("0.4.0"));
    let mut repack = fixture_manifest("0.4.0");
    repack.commit = "b".repeat(40);
    write_bundle(&root.join("store/pending"), &repack);
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    supervisor
        .save_active_record(&ActiveRuntimeRecord {
            current: Some("current".into()),
            pending: Some("pending".into()),
            ..Default::default()
        })
        .unwrap();
    let (_, selected, hash) = supervisor.select_best_local_runtime(true).unwrap();
    assert_eq!(
        hash.as_deref(),
        Some("current"),
        "a different commit is not an automatic upgrade"
    );
    assert_eq!(selected.commit, "a".repeat(40));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_product_never_compares_versions_with_another_engine_cache() {
    for selected_rust in [false, true] {
        let root = root();
        let rust_dir = if selected_rust {
            root.join("bundle")
        } else {
            root.join("store/current")
        };
        write_bundle(
            &rust_dir,
            &fixture_manifest(if selected_rust { "0.1.0" } else { "9.0.0" }),
        );
        let node_dir = if selected_rust {
            root.join("store/current")
        } else {
            root.join("bundle")
        };
        fs::create_dir_all(node_dir.join("bin")).unwrap();
        fs::write(node_dir.join("bin/node"), "fixture node").unwrap();
        fs::write(node_dir.join("bin/node.exe"), "fixture node").unwrap();
        fs::write(node_dir.join("entry.cjs"), "fixture script").unwrap();
        fs::write(node_dir.join("runtime.json"), json!({"product":"keepwork-mcp-node-runtime", "engine":"node", "platform":mcp_feed_platform(),
            "arch":current_runtime_arch(),"version":if selected_rust {"9.0.0"} else {"0.1.0"},"commit":"a".repeat(40),"entry":"entry.cjs"}).to_string()).unwrap();
        let products = if selected_rust {
            vec![RUST_MCP_PRODUCT.into(), "keepwork-mcp-node-runtime".into()]
        } else {
            vec!["keepwork-mcp-node-runtime".into(), RUST_MCP_PRODUCT.into()]
        };
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products,
            port: 0,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        });
        supervisor
            .save_active_record(&ActiveRuntimeRecord {
                current: Some("current".into()),
                ..Default::default()
            })
            .unwrap();
        let (_, selected, _) = supervisor.select_best_local_runtime(true).unwrap();
        assert_eq!(
            selected.is_rust(),
            selected_rust,
            "the configured product chooses the engine before version comparison"
        );
        assert_eq!(supervisor.newest_local_version().as_deref(), Some("0.1.0"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn attached_metadata_is_observed_per_peer_and_missing_fields_remain_unknown() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = Arc::new(Mutex::new(json!({"name":"keepwork-mcp", "pid":100_001,
        "runtimeEngine":"rust", "hostKind":"vscode-extension", "unknownAdditiveField":true})));
    let current = Arc::clone(&body);
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            let body = current.lock().unwrap().to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let first = supervisor.ensure_started(false).await;
    assert_eq!(first.state, "attached");
    assert!(
        first.version.is_empty(),
        "a bundled version is not the observed peer version"
    );
    assert!(first.commit.is_empty());
    assert!(first.built_at.is_empty());
    body.lock().unwrap().as_object_mut().unwrap().extend([
        ("runtimeVersion".into(), json!("0.5.0")),
        ("runtimeCommit".into(), json!("b".repeat(40))),
        ("runtimeBuiltAt".into(), json!("2026-11-13T01:02:03Z")),
    ]);
    let known = supervisor.ensure_started(false).await;
    assert_eq!(known.version, "0.5.0");
    assert_eq!(known.commit, "b".repeat(40));
    assert_eq!(known.built_at, "2026-11-13T01:02:03Z");
    *body.lock().unwrap() =
        json!({"name":"keepwork-mcp", "pid":100_002, "hostKind":"vscode-extension"});
    let changed = supervisor.ensure_started(false).await;
    assert_eq!(changed.state, "attached");
    assert_eq!(changed.pid, 100_002);
    assert!(changed.version.is_empty());
    assert!(changed.commit.is_empty());
    assert!(changed.built_at.is_empty());
    assert!(
        changed.engine.is_empty(),
        "a missing engine is unknown rather than Node"
    );
    assert!(supervisor.child.lock().unwrap().is_none());
    server.abort();
    let _ = server.await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_feed_stages_without_activation_and_rejects_corrupt_digest() {
    let root = root();
    let mut feed = fixture_manifest("0.3.0");
    write_bundle(&root.join("bundle"), &fixture_manifest("0.2.0"));
    write_bundle(&root.join("remote"), &feed);
    let zip = root.join("remote.zip");
    create_zip_from_dir(&root.join("remote"), &zip).unwrap();
    let bytes = Arc::new(fs::read(zip).unwrap());
    feed.size = bytes.len() as u64;
    feed.sha256 = sha256_hex(&bytes);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    feed.url = format!("http://127.0.0.1:{port}/runtime.zip");
    let remote = Arc::new(Mutex::new(serde_json::to_value(&feed).unwrap()));
    let remote_state = remote.clone();
    let download = bytes.clone();
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let length = socket.read(&mut request).await.unwrap();
            let body = if String::from_utf8_lossy(&request[..length]).contains("GET /feed") {
                remote_state.lock().unwrap().to_string().into_bytes()
            } else {
                download.to_vec()
            };
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(headers.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: true,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: format!("http://127.0.0.1:{port}/feed"),
    });
    let (status, fresh) = supervisor.check_for_update().await;
    assert!(fresh, "{}", status.update_error);
    assert_eq!(status.update_state, "staged");
    let record = RuntimeSupervisor::load_active_record(&root.join("store"));
    assert_eq!(record.pending.as_deref(), Some(feed.sha256.as_str()));
    assert_eq!(
        record.latest_source,
        Some(supervisor.config.update_source())
    );
    assert!(record.current.is_none());
    assert!(
        supervisor.child.lock().unwrap().is_none(),
        "a check must never launch a runtime"
    );
    let (_, _, candidate) = supervisor.select_best_local_runtime(true).unwrap();
    assert_eq!(candidate.as_deref(), Some(feed.sha256.as_str()));
    assert!(
        RuntimeSupervisor::load_active_record(&root.join("store"))
            .current
            .is_none(),
        "selection is not health promotion"
    );
    assert!(
        !supervisor.check_for_update().await.1,
        "same digest must not be restaged"
    );
    let directory = root.join("store").join(&feed.sha256);
    assert!(directory.join(".update-manifest.json").is_file());
    let entry = directory.join(if cfg!(windows) {
        "bin/keepwork-mcp.exe"
    } else {
        "bin/keepwork-mcp"
    });
    fs::OpenOptions::new()
        .append(true)
        .open(entry)
        .unwrap()
        .write_all(b"broken payload")
        .unwrap();
    let (corrupt, fresh) = supervisor.check_for_update().await;
    assert!(!fresh);
    assert_eq!(corrupt.update_state, "error");
    assert!(corrupt.update_error.contains("SHA-256"));
    assert_eq!(
        supervisor
            .select_best_local_runtime(true)
            .unwrap()
            .1
            .version,
        "0.2.0"
    );
    write_bundle(&directory, &feed);
    remote.lock().unwrap()["sha256"] = json!("d".repeat(64));
    remote.lock().unwrap()["version"] = json!("0.3.1");
    let (failed, fresh) = supervisor.check_for_update().await;
    assert!(!fresh);
    assert!(failed.update_error.contains("SHA-256"));
    assert_eq!(
        RuntimeSupervisor::load_active_record(&root.join("store")).pending,
        record.pending
    );
    remote.lock().unwrap()["schemaVersion"] = json!(1);
    assert!(supervisor
        .check_for_update()
        .await
        .0
        .update_error
        .contains("schemaVersion"));
    server.abort();
    let _ = server.await;
    let (offline, _) = supervisor.check_for_update().await;
    assert_eq!(offline.update_state, "error");
    assert_eq!(offline.latest_version, "0.3.1");
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_health_fixture() {
    let Ok(port) = std::env::var("KP_UPDATE_FIXTURE_PORT") else {
        return;
    };
    if let Ok(delay) = std::env::var("KP_UPDATE_FIXTURE_START_DELAY_MS") {
        std::thread::sleep(Duration::from_millis(delay.parse().unwrap()));
    }
    let signal = std::env::var("KP_UPDATE_FIXTURE_START_SIGNAL").ok();
    if let Some(signal) = &signal {
        fs::write(signal, b"started").unwrap();
    }
    if std::env::var_os("KP_UPDATE_FIXTURE_SLEEP").is_some() {
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    if std::env::var_os("KP_UPDATE_FIXTURE_FAIL").is_some() {
        if let Ok(ready) = std::env::var("KP_UPDATE_FIXTURE_LISTENER_READY_SIGNAL") {
            // Exit only after the competing listener has bound its port. A
            // fixed sleep races the parent's scheduling on busy native runners.
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while !Path::new(&ready).is_file() {
                assert!(std::time::Instant::now() < deadline, "competing listener did not become ready");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        return;
    }
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    for socket in listener.incoming() {
        let mut socket = socket.unwrap();
        let mut input = [0; 4096];
        let _ = socket.read(&mut input);
        let body = if std::env::var_os("KP_UPDATE_FIXTURE_LOCAL_MODEL").is_some() {
            json!({"service":"keepwork-local-model", "protocolVersion":"1.0.0"}).to_string()
        } else {
            json!({"name":"keepwork-mcp", "pid": std::process::id(), "runtimeEngine":"rust", "hostKind":"rust-node-runtime",
            "runtimeVersion":std::env::var("KP_UPDATE_FIXTURE_VERSION").unwrap(),
            "runtimeCommit":std::env::var("KP_UPDATE_FIXTURE_COMMIT").unwrap_or_else(|_| "a".repeat(40))}).to_string()
        };
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
}

#[tokio::test]
async fn explicit_apply_can_activate_an_equal_version_repack_after_native_health_verification() {
    let root = root();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    for (name, commit) in [("current", "a".repeat(40)), ("repack", "b".repeat(40))] {
        let directory = root.join("store").join(name);
        fs::create_dir_all(directory.join("bin")).unwrap();
        let entry = if cfg!(windows) {
            "bin/keepwork-mcp.exe"
        } else {
            "bin/keepwork-mcp"
        };
        install_fixture_executable(&directory.join(entry));
        fs::write(directory.join("runtime.json"), json!({
            "product":RUST_MCP_PRODUCT, "engine":"rust", "platform":mcp_feed_platform(),
            "arch":current_runtime_arch(), "version":"0.4.0", "commit":commit, "entry":entry,
            "args":["--exact","runtime::update_tests::native_health_fixture","--nocapture"],
            "env":{"KP_UPDATE_FIXTURE_PORT":port.to_string(), "KP_UPDATE_FIXTURE_VERSION":"0.4.0",
                "KP_UPDATE_FIXTURE_COMMIT":commit,
                "KP_UPDATE_FIXTURE_START_DELAY_MS":if name == "repack" { "5000" } else { "0" }}
        }).to_string()).unwrap();
    }
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    supervisor
        .save_active_record(&ActiveRuntimeRecord {
            current: Some("current".into()),
            pending: Some("repack".into()),
            ..Default::default()
        })
        .unwrap();
    let original = supervisor.ensure_started(true).await;
    assert_eq!(original.state, "running", "{}", original.error);
    assert_eq!(
        original.commit,
        "a".repeat(40),
        "startup must not implicitly apply a same-version repack"
    );
    let applied = supervisor.apply_staged_update().await.unwrap();
    assert_eq!(applied.state, "running", "{}", applied.error);
    assert_eq!(applied.version, "0.4.0");
    assert_eq!(applied.commit, "b".repeat(40), "{applied:?}");
    assert!(applied.update_error.is_empty(), "{applied:?}");
    assert_ne!(
        applied.pid, original.pid,
        "explicit apply starts the verified replacement process"
    );
    let observed = supervisor.probe_health().await.unwrap();
    assert_eq!(observed.pid, applied.pid);
    assert_eq!(observed.runtime_commit, "b".repeat(40));
    let active = RuntimeSupervisor::load_active_record(&root.join("store"));
    assert_eq!(active.current.as_deref(), Some("repack"));
    assert_eq!(active.previous.as_deref(), Some("current"));
    assert!(active.pending.is_none());
    supervisor.stop();
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unhealthy_candidate_is_terminated_within_the_native_start_budget() {
    let root = root();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let bundle = root.join("bundle");
    fs::create_dir_all(bundle.join("bin")).unwrap();
    let entry = if cfg!(windows) { "bin/keepwork-mcp.exe" } else { "bin/keepwork-mcp" };
    fs::copy(std::env::current_exe().unwrap(), bundle.join(entry)).unwrap();
    fs::write(bundle.join("runtime.json"), json!({
        "product":RUST_MCP_PRODUCT,"engine":"rust","platform":mcp_feed_platform(),
        "arch":current_runtime_arch(),"version":"0.4.0","commit":"a".repeat(40),"entry":entry,
        "args":["--exact","runtime::update_tests::native_health_fixture","--nocapture"],
        "env":{"KP_UPDATE_FIXTURE_PORT":port.to_string(),"KP_UPDATE_FIXTURE_SLEEP":"1"}
    }).to_string()).unwrap();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id:"mcp".into(),products:vec![RUST_MCP_PRODUCT.into()],port,health_path:"/health".into(),
        updates_enabled:false,bundled_dir:bundle.clone(),store_dir:root.join("store"),feed_url:String::new(),
    });
    let manifest = supervisor.selected_runtime(&bundle).unwrap();
    // Vacancy checking has its own five-second budget before the candidate
    // starts. Even Windows connection refusals must not stretch verification
    // into the old forty independent HTTP timeouts.
    let result = tokio::time::timeout(
        Duration::from_secs(25), supervisor.spawn_and_verify(&bundle, &manifest)
    ).await.expect("candidate verification must remain bounded");
    assert!(matches!(result, Err(RuntimeStartError::CandidateFailed(_))));
    assert!(supervisor.child.lock().unwrap().is_none(), "the unverified child must be reaped");
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

async fn serve_attached_peer(body: Value) -> (u16, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (port, server)
}

#[tokio::test]
async fn desktop_owned_legacy_peer_with_unknown_engine_and_version_is_never_replaced_by_guessing() {
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
    // Using our own PID additionally makes the failure path safe even if the
    // takeover guard regresses: the supervisor never kills the test process.
    let pid = std::process::id();
    let (port, server) = serve_attached_peer(json!({
        "name":"keepwork-mcp", "pid":pid, "hostKind":"rust-node-runtime"
    }))
    .await;
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    for _ in 0..2 {
        let status = supervisor.ensure_started(true).await;
        assert_eq!(status.state, "running");
        assert_eq!(status.owner, "desktop");
        assert_eq!(status.pid, pid);
        assert!(status.engine.is_empty());
        assert!(status.version.is_empty());
        assert!(status.commit.is_empty());
        assert!(status.built_at.is_empty());
        assert!(status.error.is_empty());
        assert!(supervisor.child.lock().unwrap().is_none());
    }
    server.abort();
    let _ = server.await;
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn older_vscode_and_local_helper_peers_keep_ownership_even_when_a_newer_bundle_exists() {
    for owner in ["vscode-extension", "local-helper"] {
        let root = root();
        write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
        let pid = std::process::id();
        let (port, server) = serve_attached_peer(json!({
            "name":"keepwork-mcp", "pid":pid, "hostKind":owner, "runtimeEngine":"rust",
            "runtimeVersion":"0.1.0", "runtimeCommit":"c".repeat(40)
        }))
        .await;
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec![RUST_MCP_PRODUCT.into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        });
        let status = supervisor.ensure_started(true).await;
        assert_eq!(status.state, "attached");
        assert_eq!(status.owner, owner);
        assert_eq!(status.pid, pid);
        assert_eq!(status.version, "0.1.0");
        assert_eq!(status.commit, "c".repeat(40));
        assert!(status.error.is_empty());
        assert!(supervisor.child.lock().unwrap().is_none());
        assert_eq!(supervisor.probe_health().await.unwrap().pid, pid);
        server.abort();
        let _ = server.await;
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}

async fn serve_peer_sequence(
    first: Value,
    current: Value,
) -> (
    u16,
    tokio::task::JoinHandle<()>,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&count);
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let index = observed.fetch_add(1, Ordering::Relaxed);
            let body = if index == 0 { &first } else { &current }.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (port, server, count)
}

fn older_desktop_peer() -> Value {
    json!({
        "name":"keepwork-mcp", "pid":std::process::id(), "hostKind":"rust-node-runtime",
        "runtimeEngine":"rust", "runtimeVersion":"0.1.0", "runtimeCommit":"c".repeat(40),
        "runtimeBuiltAt":"2026-11-13T01:02:03Z"
    })
}

async fn assert_takeover_preserves_current_peer(current: Value) {
    let root = root();
    // The bundle is an inert identity fixture, so an accidental spawn can only
    // fail. The retry counter below detects that attempt even after child cleanup.
    write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
    let (port, server, probes) = serve_peer_sequence(older_desktop_peer(), current.clone()).await;
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let status = supervisor.ensure_started(true).await;
    let live = supervisor.probe_health().await;
    server.abort();
    let _ = server.await;

    let owner = RuntimeSupervisor::classify_owner(current["hostKind"].as_str().unwrap());
    assert!(
        probes.load(Ordering::Relaxed) >= 3,
        "must perform the second identity probe and preserve a live listener"
    );
    assert_eq!(
        status.state,
        if owner == "desktop" {
            "running"
        } else {
            "attached"
        },
        "{}",
        status.error
    );
    assert_eq!(status.owner, owner);
    assert_eq!(status.pid, current["pid"].as_u64().unwrap() as u32);
    assert_eq!(
        status.version,
        current["runtimeVersion"].as_str().unwrap_or("")
    );
    assert_eq!(
        status.engine,
        current["runtimeEngine"].as_str().unwrap_or("")
    );
    assert_eq!(
        status.commit,
        current["runtimeCommit"].as_str().unwrap_or("")
    );
    assert_eq!(
        status.built_at,
        current["runtimeBuiltAt"].as_str().unwrap_or("")
    );
    assert!(
        supervisor.child.lock().unwrap().is_none(),
        "a live peer must not produce another local process"
    );
    assert_eq!(
        supervisor.rust_start_failures.load(Ordering::Relaxed),
        0,
        "must not attempt a replacement spawn after a failed recheck/stop"
    );
    let live = live.expect("the actual listener must remain available");
    assert_eq!(live.pid, current["pid"].as_u64().unwrap() as u32);
    assert_eq!(live.host_kind, current["hostKind"].as_str().unwrap());
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn takeover_recheck_preserves_a_peer_that_changes_to_an_external_owner() {
    for owner in ["vscode-extension", "local-helper"] {
        let mut current = older_desktop_peer();
        current["hostKind"] = json!(owner);
        assert_takeover_preserves_current_peer(current).await;
    }
}

#[tokio::test]
async fn takeover_recheck_preserves_a_peer_whose_pid_changed() {
    let mut current = older_desktop_peer();
    // Both possible kill targets are harmless: the original is our own PID,
    // and zero is explicitly excluded by the supervisor's termination helper.
    current["pid"] = json!(0);
    assert_takeover_preserves_current_peer(current).await;
}

#[tokio::test]
async fn takeover_recheck_preserves_a_peer_that_is_now_newer_than_the_bundle() {
    let mut current = older_desktop_peer();
    current["runtimeVersion"] = json!("0.5.0");
    current["runtimeCommit"] = json!("d".repeat(40));
    assert_takeover_preserves_current_peer(current).await;
}

#[tokio::test]
async fn takeover_recheck_preserves_a_peer_whose_engine_became_unknown() {
    let mut current = older_desktop_peer();
    current.as_object_mut().unwrap().remove("runtimeEngine");
    assert_takeover_preserves_current_peer(current).await;
}

#[tokio::test]
async fn takeover_recheck_does_not_spawn_while_the_original_listener_remains_live() {
    // Killing our own PID is refused by design, modelling a failed/ineffective
    // stop without sending any signal to another process.
    assert_takeover_preserves_current_peer(older_desktop_peer()).await;
}

#[tokio::test]
async fn takeover_boundary_stop_reports_a_live_listener_without_spawning_after_a_test_child_is_stopped() {
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
    // The only killable PID in this test is a child created for this test.
    // Its TCP listener deliberately lives in our parent-side fixture instead.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "runtime::update_tests::native_health_fixture", "--nocapture"])
        .env("KP_UPDATE_FIXTURE_PORT", "0")
        .env("KP_UPDATE_FIXTURE_SLEEP", "1")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap();
    let pid = child.id();
    let mut current = older_desktop_peer();
    current["pid"] = json!(pid);
    let (port, server) = serve_attached_peer(current).await;
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id:"mcp".into(), products:vec![RUST_MCP_PRODUCT.into()], port,
        health_path:"/health".into(), updates_enabled:false, bundled_dir:root.join("bundle"),
        store_dir:root.join("store"), feed_url:String::new(),
    });
    let status = supervisor.ensure_started(true).await;
    let stopped = child.try_wait().unwrap().is_some();
    // Reap before assertions, and ensure a broken takeover cannot leave the
    // dedicated sleeping test child behind.
    let _ = child.kill();
    let _ = child.wait();
    let live = supervisor.probe_health().await;
    server.abort();
    let _ = server.await;
    assert!(stopped, "the fixture child must actually reach the guarded stop path");
    assert_eq!(status.state, "running");
    assert_eq!(status.owner, "desktop");
    assert_eq!(status.pid, pid);
    assert_eq!(status.version, "0.1.0");
    assert!(status.error.contains("仍在运行"));
    assert!(status.error.contains("未启动替换服务"));
    assert!(supervisor.child.lock().unwrap().is_none());
    assert_eq!(supervisor.rust_start_failures.load(Ordering::Relaxed), 0);
    assert_eq!(live.unwrap().pid, pid);
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unhealthy_http_listener_prevents_spawn_when_its_tcp_port_remains_occupied() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (http_status, body) in [
        ("503 Service Unavailable", "temporarily unavailable"),
        ("200 OK", "{invalid json"),
    ] {
        let root = root();
        write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let length = socket.read(&mut request).await.unwrap_or(0);
                // The occupancy probe only establishes TCP, then closes it.
                if length == 0 {
                    continue;
                }
                let response = format!(
                    "HTTP/1.1 {http_status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec![RUST_MCP_PRODUCT.into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        });
        // A formerly observed identity must not survive an unreadable peer.
        {
            let mut old = supervisor.status.lock().unwrap();
            old.owner = "desktop".into();
            old.pid = std::process::id();
            old.engine = "rust".into();
            old.version = "0.1.0".into();
            old.commit = "d".repeat(40);
            old.built_at = "2026-11-13T01:02:03Z".into();
        }
        let status = supervisor.ensure_started(true).await;
        assert_eq!(status.state, "conflict", "{http_status}: {}", status.error);
        assert_eq!(status.owner, "external");
        assert_eq!(status.pid, 0);
        assert!(status.engine.is_empty());
        assert!(status.version.is_empty());
        assert!(status.commit.is_empty());
        assert!(status.built_at.is_empty());
        assert!(status.error.contains("未启动替换服务"));
        assert!(supervisor.child.lock().unwrap().is_none());
        assert_eq!(
            supervisor.rust_start_failures.load(Ordering::Relaxed),
            0,
            "an unhealthy existing listener must not consume a local launch retry"
        );
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok(),
            "the existing TCP listener must remain available"
        );
        server.abort();
        let _ = server.await;
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn takeover_boundary_candidate_failure_preserves_foreign_listener_and_pending_without_spawning_rollback() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = root();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let candidate_started = root.join("candidate-started");
    let listener_ready = root.join("listener-ready");
    let rollback_started = root.join("rollback-started");
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    for (name, version, fail, signal) in [
        ("current", "0.2.0", false, &rollback_started),
        ("candidate", "0.3.0", true, &candidate_started),
    ] {
        let directory = root.join("store").join(name);
        fs::create_dir_all(directory.join("bin")).unwrap();
        let entry = if cfg!(windows) { "bin/keepwork-mcp.exe" } else { "bin/keepwork-mcp" };
        install_fixture_executable(&directory.join(entry));
        let mut env = json!({
            "KP_UPDATE_FIXTURE_PORT":port.to_string(), "KP_UPDATE_FIXTURE_VERSION":version,
            "KP_UPDATE_FIXTURE_START_SIGNAL":signal.to_string_lossy()
        });
        if fail {
            env["KP_UPDATE_FIXTURE_FAIL"] = json!("1");
            env["KP_UPDATE_FIXTURE_LISTENER_READY_SIGNAL"] = json!(listener_ready);
        }
        fs::write(directory.join("runtime.json"), json!({
            "product":RUST_MCP_PRODUCT,"engine":"rust", "platform":mcp_feed_platform(),
            "arch":current_runtime_arch(),"version":version,"commit":"a".repeat(40),"entry":entry,
            "args":["--exact","runtime::update_tests::native_health_fixture","--nocapture"],"env":env
        }).to_string()).unwrap();
    }
    let signal = candidate_started.clone();
    let server = tokio::spawn(async move {
        // Initial HTTP probe and both pre-spawn TCP guards can each wait for
        // Windows connection refusal. The child marker, not elapsed time,
        // determines when it is safe to install the competing listener.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !signal.is_file() {
            assert!(std::time::Instant::now() < deadline, "candidate must start before the foreign listener appears");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        fs::write(listener_ready, b"ready").unwrap();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let length = socket.read(&mut request).await.unwrap_or(0);
            if length == 0 { continue; }
            let body = json!({
                "name":"keepwork-mcp", "pid":std::process::id(), "hostKind":"local-helper",
                "runtimeEngine":"rust", "runtimeVersion":"0.9.0", "runtimeCommit":"f".repeat(40)
            }).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let record = ActiveRuntimeRecord {
        current:Some("current".into()), pending:Some("candidate".into()), ..Default::default()
    };
    atomic_json_write(&root.join("store/active.json"), &record).unwrap();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id:"mcp".into(), products:vec![RUST_MCP_PRODUCT.into()], port,
        health_path:"/health".into(), updates_enabled:false, bundled_dir:root.join("bundle"),
        store_dir:root.join("store"), feed_url:String::new(),
    });
    let status = supervisor.ensure_started(true).await;
    let live = supervisor.probe_health().await;
    server.abort();
    let server_result = server.await;
    assert!(server_result.is_err_and(|error| error.is_cancelled()),
        "competing listener task must remain running until cleanup");
    assert!(candidate_started.is_file(), "the candidate must be launched before the competing listener: {status:?}");
    assert!(!rollback_started.exists(), "rollback must not launch over a foreign listener");
    assert_eq!(status.state, "attached", "{}", status.error);
    assert_eq!(status.owner, "local-helper");
    assert_eq!(status.pid, std::process::id());
    assert_eq!(status.version, "0.9.0");
    assert_eq!(status.commit, "f".repeat(40));
    assert_eq!(status.pending_version, "0.3.0");
    assert!(!status.update_error.is_empty());
    assert!(supervisor.child.lock().unwrap().is_none());
    assert_eq!(supervisor.rust_start_failures.load(Ordering::Relaxed), 0);
    assert_eq!(RuntimeSupervisor::load_active_record(&root.join("store")), record,
        "uncertain activation must preserve the pending candidate and verified current identity");
    assert_eq!(live.unwrap().host_kind, "local-helper");
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn failed_activation_rolls_back_to_last_verified_runtime() {
    let root = root();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    for (name, version, fail) in [
        ("bundle", "0.1.0", false),
        ("store/good", "0.2.0", false),
        ("store/bad", "0.3.0", true),
        ("store/new", "0.4.0", false),
    ] {
        let directory = root.join(name);
        fs::create_dir_all(directory.join("bin")).unwrap();
        let entry = if cfg!(windows) {
            "bin/keepwork-mcp.exe"
        } else {
            "bin/keepwork-mcp"
        };
        // Install our own test executable, copying across Windows volumes when needed.
        // This never calls a shared daemon or requires a cloud account.
        install_fixture_executable(&directory.join(entry));
        let mut env =
            json!({"KP_UPDATE_FIXTURE_PORT":port.to_string(),"KP_UPDATE_FIXTURE_VERSION":version});
        if fail {
            env["KP_UPDATE_FIXTURE_FAIL"] = json!("1");
        }
        fs::write(directory.join("runtime.json"), json!({"product":RUST_MCP_PRODUCT,"engine":"rust", "platform":mcp_feed_platform(),"arch":current_runtime_arch(),
            "version":version,"commit":"a".repeat(40),"entry":entry,"args":["--exact","runtime::update_tests::native_health_fixture","--nocapture"],"env":env}).to_string()).unwrap();
    }
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let mut record = ActiveRuntimeRecord::default();
    record.current = Some("good".into());
    record.pending = Some("bad".into());
    supervisor.save_active_record(&record).unwrap();
    let status = supervisor.apply_staged_update().await.unwrap();
    assert_eq!(
        status.version, "0.2.0",
        "rollback must prefer the last verified version"
    );
    assert!(status.update_error.contains("回退"));
    assert!(status.pending_version.is_empty());
    let record = RuntimeSupervisor::load_active_record(&root.join("store"));
    assert_eq!(record.current.as_deref(), Some("good"));
    assert_eq!(record.failed.as_deref(), Some("bad"));
    assert!(record.pending.is_none());
    let mut record = record;
    record.pending = Some("new".into());
    supervisor.save_active_record(&record).unwrap();
    assert_eq!(
        supervisor.apply_staged_update().await.unwrap().version,
        "0.4.0"
    );
    supervisor.stop();
    assert_eq!(supervisor.ensure_started(true).await.version, "0.4.0");
    let record = RuntimeSupervisor::load_active_record(&root.join("store"));
    assert_eq!(
        record.previous.as_deref(),
        Some("good"),
        "normal startup must preserve the last verified rollback"
    );
    let running_pid = supervisor.probe_health().await.unwrap().pid;
    let mut stale = record.clone();
    stale.pending = Some("missing".into());
    supervisor.save_active_record(&stale).unwrap();
    assert!(supervisor.apply_staged_update().await.is_err());
    assert_eq!(
        supervisor.probe_health().await.unwrap().pid,
        running_pid,
        "a missing update cannot stop the healthy service"
    );
    stale.pending = Some("good".into());
    supervisor.save_active_record(&stale).unwrap();
    assert!(supervisor.apply_staged_update().await.is_err());
    assert_eq!(
        supervisor.probe_health().await.unwrap().pid,
        running_pid,
        "an older update cannot replace the live newer service"
    );
    supervisor.save_active_record(&record).unwrap();
    let file = root.join("store/new/runtime.json");
    let mut broken: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    broken["env"]["KP_UPDATE_FIXTURE_FAIL"] = json!("1");
    fs::write(file, broken.to_string()).unwrap();
    supervisor.stop();
    assert_eq!(
        supervisor.ensure_started(true).await.version,
        "0.2.0",
        "failure after a normal restart must still restore the previous runtime"
    );
    supervisor.stop();
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn local_model_legacy_health_without_pid_still_starts() {
    let root = root();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let bundle = root.join("bundle");
    fs::create_dir_all(bundle.join("bin")).unwrap();
    let entry = if cfg!(windows) {
        "bin/fixture.exe"
    } else {
        "bin/fixture"
    };
    install_fixture_executable(&bundle.join(entry));
    // A native test child serves the actual legacy local-model response shape;
    // no real local-model process or model download is required by this fixture.
    fs::write(bundle.join("runtime.json"), json!({"product":"keepwork-local-model-node-runtime", "engine":"rust",
        "platform":mcp_feed_platform(), "arch":current_runtime_arch(),"version":"0.1.0", "commit":"a".repeat(40),"entry":entry,
        "args":["--exact","runtime::update_tests::native_health_fixture","--nocapture"],
        "env":{"KP_UPDATE_FIXTURE_PORT":port.to_string(),"KP_UPDATE_FIXTURE_LOCAL_MODEL":"1"}}).to_string()).unwrap();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "local-model".into(),
        products: vec!["keepwork-local-model-node-runtime".into()],
        port,
        health_path: "/v1/health".into(),
        updates_enabled: false,
        bundled_dir: bundle,
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let status = supervisor.ensure_started(false).await;
    assert_eq!(status.state, "running", "{}", status.error);
    assert!(status.pid > 0);
    assert_eq!(supervisor.probe_health().await.unwrap().pid, 0);
    supervisor.stop();
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn archives_reject_excessive_expansion_before_allocating() {
    let root = root();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("tiny"), b"small").unwrap();
    let archive = root.join("tiny.zip");
    create_zip_from_dir(&source, &archive).unwrap();
    let mut bytes = fs::read(&archive).unwrap();
    let central = bytes
        .windows(4)
        .position(|part| part == b"PK\x01\x02")
        .unwrap();
    bytes[central + 24..central + 28].copy_from_slice(&(2_147_483_649u32).to_le_bytes());
    assert!(extract_zip_bytes(&bytes, &root.join("output"))
        .unwrap_err()
        .contains("size limit"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn legacy_node_health_without_engine_starts_only_as_our_live_child() {
    let root = root();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is required by desktop development");
    assert!(node.status.success());
    let executable = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let bundle = root.join("bundle");
    fs::create_dir_all(bundle.join("bin")).unwrap();
    fs::copy(
        executable,
        bundle.join(if cfg!(windows) {
            "bin/node.exe"
        } else {
            "bin/node"
        }),
    )
    .unwrap();
    fs::write(bundle.join("entry.cjs"), format!(
        "require('node:http').createServer((req,res)=>res.end(JSON.stringify({{name:'keepwork-mcp',pid:process.pid,hostKind:'rust-node-runtime'}}))).listen({port},'127.0.0.1');"
    )).unwrap();
    fs::write(
        bundle.join("runtime.json"),
        json!({"product":"keepwork-mcp-node-runtime",
        "platform":mcp_feed_platform(), "arch":current_runtime_arch(), "version":"0.1.0",
        "commit":"a".repeat(40), "entry":"entry.cjs"})
        .to_string(),
    )
    .unwrap();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec!["keepwork-mcp-node-runtime".into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: bundle,
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let status = supervisor.ensure_started(false).await;
    assert_eq!(status.state, "running", "{}", status.error);
    assert_eq!(status.engine, "node");
    let observed = supervisor.probe_health().await.unwrap();
    assert_eq!(observed.pid, status.pid);
    assert!(observed.runtime_engine.is_empty());
    assert!(supervisor
        .child
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    supervisor.stop();
    drop(supervisor);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn verified_native_cache_rejects_binary_corruption_before_selection_or_apply() {
    use std::io::Write;
    let root = root();
    write_bundle(&root.join("bundle"), &fixture_manifest("0.1.0"));
    write_bundle(&root.join("store/current"), &fixture_manifest("0.2.0"));
    let feed = fixture_manifest("0.3.0");
    let directory = root.join("store").join(&feed.sha256);
    write_bundle(&directory, &feed);
    let entry = directory.join(if cfg!(windows) {
        "bin/keepwork-mcp.exe"
    } else {
        "bin/keepwork-mcp"
    });
    let mut receipt = serde_json::to_value(&feed).unwrap();
    receipt["binarySha256"] = json!(sha256_hex(&fs::read(&entry).unwrap()));
    atomic_json_write(&directory.join(".update-manifest.json"), &receipt).unwrap();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port: 0,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    supervisor
        .save_active_record(&ActiveRuntimeRecord {
            current: Some("current".into()),
            pending: Some(feed.sha256.clone()),
            ..Default::default()
        })
        .unwrap();
    assert!(supervisor.cached_runtime(&feed.sha256).is_ok());
    fs::OpenOptions::new()
        .append(true)
        .open(entry)
        .unwrap()
        .write_all(b"corrupt trailing bytes")
        .unwrap();
    assert!(supervisor
        .cached_runtime(&feed.sha256)
        .unwrap_err()
        .contains("SHA-256"));
    assert_eq!(
        supervisor
            .select_best_local_runtime(true)
            .unwrap()
            .1
            .version,
        "0.2.0"
    );
    assert_eq!(supervisor.snapshot().update_state, "error");
    assert!(supervisor
        .apply_staged_update()
        .await
        .unwrap_err()
        .contains("SHA-256"));
    assert!(supervisor.child.lock().unwrap().is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn takeover_recheck_observes_replacement_without_killing_or_spawning() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let pid = std::process::id();
    // The fixture never names a different real process for termination: only
    // the first observation is eligible for takeover, and it reports our PID.
    for (replacement, expected_state, expected_owner) in [
        (
            json!({"name":"keepwork-mcp", "pid":pid + 1, "hostKind":"rust-node-runtime"}),
            "running",
            "desktop",
        ),
        (
            json!({"name":"keepwork-mcp", "pid":pid, "hostKind":"vscode-extension"}),
            "attached",
            "vscode-extension",
        ),
        (
            json!({"name":"another-service", "pid":pid, "hostKind":"other"}),
            "conflict",
            "external",
        ),
    ] {
        let root = root();
        write_bundle(&root.join("bundle"), &fixture_manifest("0.4.0"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&requests);
        let final_body = replacement.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).await;
                let body = if count.fetch_add(1, Ordering::Relaxed) == 0 {
                    json!({"name":"keepwork-mcp", "pid":pid, "hostKind":"rust-node-runtime",
                        "runtimeEngine":"rust", "runtimeVersion":"0.1.0", "runtimeCommit":"a".repeat(40)})
                } else {
                    final_body.clone()
                }.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec![RUST_MCP_PRODUCT.into()],
            port,
            health_path: "/health".into(),
            updates_enabled: false,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: String::new(),
        });
        let status = supervisor.ensure_started(true).await;
        assert_eq!(status.state, expected_state, "{}", status.error);
        assert_eq!(status.owner, expected_owner);
        assert_eq!(status.pid, replacement["pid"].as_u64().unwrap() as u32);
        assert!(status.engine.is_empty());
        assert!(status.version.is_empty());
        assert!(status.commit.is_empty());
        assert!(status.built_at.is_empty());
        assert_eq!(
            requests.load(Ordering::Relaxed),
            2,
            "a changed peer must end takeover immediately"
        );
        assert!(supervisor.child.lock().unwrap().is_none());
        assert_eq!(supervisor.probe_health().await.unwrap().pid, status.pid);
        server.abort();
        let _ = server.await;
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn staging_bootstraps_without_a_baseline_and_compares_only_observed_same_engine_versions() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (bundle, engine, peer_version, expected_staged) in [
        (None, "", "", true),
        (None, "", "9.0.0", true),
        (Some("0.2.0"), "", "9.0.0", true),
        (Some("0.2.0"), "node", "9.0.0", true),
        (Some("0.2.0"), "rust", "0.4.0", false),
        (None, "rust", "0.4.0", false),
    ] {
        let root = root();
        if let Some(version) = bundle {
            write_bundle(&root.join("bundle"), &fixture_manifest(version));
        }
        let mut feed = fixture_manifest("0.3.0");
        write_bundle(&root.join("remote"), &feed);
        let zip = root.join("runtime.zip");
        create_zip_from_dir(&root.join("remote"), &zip).unwrap();
        let bytes = fs::read(zip).unwrap();
        feed.size = bytes.len() as u64;
        feed.sha256 = sha256_hex(&bytes);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        feed.url = format!("http://127.0.0.1:{port}/runtime.zip");
        let remote = serde_json::to_vec(&feed).unwrap();
        let mut peer =
            json!({"name":"keepwork-mcp", "pid":std::process::id(), "hostKind":"vscode-extension"});
        if !engine.is_empty() {
            peer["runtimeEngine"] = json!(engine);
        }
        if !peer_version.is_empty() {
            peer["runtimeVersion"] = json!(peer_version);
        }
        let peer = serde_json::to_vec(&peer).unwrap();
        let downloads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&downloads);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let length = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..length]);
                let body = if request.contains("GET /health ") {
                    &peer
                } else if request.contains("GET /feed ") {
                    &remote
                } else {
                    count.fetch_add(1, Ordering::Relaxed);
                    &bytes
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(body).await;
            }
        });
        let supervisor = RuntimeSupervisor::new(RuntimeConfig {
            id: "mcp".into(),
            products: vec![RUST_MCP_PRODUCT.into()],
            port,
            health_path: "/health".into(),
            updates_enabled: true,
            bundled_dir: root.join("bundle"),
            store_dir: root.join("store"),
            feed_url: format!("http://127.0.0.1:{port}/feed"),
        });
        assert_eq!(supervisor.ensure_started(false).await.state, "attached");
        let (status, staged) = supervisor.check_for_update().await;
        assert_eq!(
            staged, expected_staged,
            "bundle={bundle:?}, engine={engine}, peer={peer_version}: {}",
            status.update_error
        );
        assert_eq!(
            status.update_state,
            if expected_staged { "staged" } else { "idle" }
        );
        assert_eq!(status.owner, "vscode-extension");
        let active = RuntimeSupervisor::load_active_record(&root.join("store"));
        assert_eq!(active.pending.is_some(), expected_staged);
        assert!(
            active.current.is_none(),
            "a download never activates or replaces the peer"
        );
        assert!(supervisor.child.lock().unwrap().is_none());
        assert_eq!(
            downloads.load(Ordering::Relaxed),
            usize::from(expected_staged)
        );
        server.abort();
        let _ = server.await;
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn vacancy_probe_rejects_a_listener_and_waits_for_explicit_refusal_after_close() {
    let root = root();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec![RUST_MCP_PRODUCT.into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("missing"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    assert!(supervisor.require_vacant_port().await.is_err());
    drop(listener);
    supervisor
        .require_vacant_port()
        .await
        .expect("a released loopback port must eventually report ConnectionRefused");
    assert!(supervisor.child.lock().unwrap().is_none());
    assert_eq!(supervisor.rust_start_failures.load(Ordering::Relaxed), 0);
    fs::remove_dir_all(root).unwrap();
}
