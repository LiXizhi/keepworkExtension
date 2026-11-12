use super::*;
use std::io::{Cursor, Write};
use uuid::Uuid;

fn restart_supervisor(root: &Path, port: u16) -> RuntimeSupervisor {
    RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec!["keepwork-mcp-runtime".into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("bundle"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    })
}

#[test]
fn restart_reclaims_orphan_desktop_process_and_preserves_foreign_owners() {
    const CHILD_ENV: &str = "AICHAT_TEST_RESTART_HEALTH_CHILD";
    if let Some(ready_path) = std::env::var_os(CHILD_ENV) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let host = std::env::var("AICHAT_TEST_RESTART_HEALTH_HOST").unwrap();
        let ready_path = PathBuf::from(ready_path);
        let ready_temp = ready_path.with_extension("tmp");
        fs::write(
            &ready_temp,
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
        fs::rename(ready_temp, ready_path).unwrap();
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let mut body = serde_json::json!({
                "name": "keepwork-mcp", "pid": std::process::id(),
                "hostKind": host, "runtimeVersion": "0.1.0", "runtimeEngine": "rust"
            });
            if host == "legacy-owned" {
                body.as_object_mut().unwrap().remove("hostKind");
            }
            let body = body.to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            let _ = stream.write_all(response.as_bytes());
        }
        return;
    }

    struct FixtureChild(Option<Child>);
    impl Drop for FixtureChild {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for host in ["rust-node-runtime", "legacy-owned", "vscode-extension", "local-helper", "unknown-host"] {
            let root = std::env::temp_dir().join(format!("aichat-restart-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let ready_path = root.join("ready-port");
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "runtime::tests::restart_reclaims_orphan_desktop_process_and_preserves_foreign_owners",
                "--nocapture",
            ]).env(CHILD_ENV, &ready_path)
                .env("AICHAT_TEST_RESTART_HEALTH_HOST", host)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = FixtureChild(Some(command.spawn().unwrap()));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !ready_path.exists() {
                assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none(), "health fixture exited before readiness");
                assert!(Instant::now() < deadline, "health fixture did not become ready");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let port = fs::read_to_string(&ready_path).unwrap().parse::<u16>().unwrap();
            let supervisor = restart_supervisor(&root, port);
            assert!(supervisor.child.lock().unwrap().is_none());
            let child_pid = child.0.as_ref().unwrap().id();
            assert_eq!(supervisor.probe_health().await.unwrap().pid, child_pid);
            if host == "legacy-owned" {
                assert!(supervisor.probe_health().await.unwrap().host_kind.is_empty());
                *supervisor.child.lock().unwrap() = child.0.take();
            }
            let stopped = supervisor.stop_for_restart().await;
            if host == "rust-node-runtime" || host == "legacy-owned" {
                stopped.expect("a verified orphan desktop runtime must be stopped");
                let deadline = Instant::now() + Duration::from_secs(3);
                if let Some(child) = child.0.as_mut() {
                    while child.try_wait().unwrap().is_none() {
                        assert!(Instant::now() < deadline, "orphan runtime remains alive");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
                assert!(supervisor.child.lock().unwrap().is_none());
                assert!(supervisor.probe_health().await.is_none());
                assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(), "restart must release the listening port");
            } else {
                assert!(stopped.is_err(), "external ownership must reject restart: {host}");
                assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none(), "foreign runtime must stay alive: {host}");
                assert_eq!(supervisor.probe_health().await.unwrap().pid, child_pid);
            }
            drop(child);
            fs::remove_dir_all(root).unwrap();
        }
    });
}

#[test]
fn restart_reports_failed_start_instead_of_success_when_runtime_is_missing() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let root = std::env::temp_dir().join(format!("aichat-restart-missing-{}", Uuid::new_v4()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let supervisor = restart_supervisor(&root, port);
        let error = supervisor
            .restart()
            .await
            .expect_err("missing runtime must fail restart");
        assert!(!error.is_empty());
        assert_eq!(supervisor.snapshot().state, "error");
    });
}

#[test]
fn loopback_health_ignores_proxy_environment() {
    const CHILD_ENV: &str = "AICHAT_TEST_HEALTH_PROXY_CHILD";
    if std::env::var_os(CHILD_ENV).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let health = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                stream.read(&mut request).await.unwrap();
                let body = r#"{"name":"keepwork-mcp","pid":123,"runtimeVersion":"fixture","hostKind":"vscode-extension"}"#;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            // Prove this process really has a proxy that would reject health checks.
            if std::env::var(CHILD_ENV).unwrap() == "proxy" {
                let ordinary = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
                let rejected = ordinary.get(format!("http://127.0.0.1:{port}/health")).send().await.unwrap();
                assert_eq!(rejected.status(), reqwest::StatusCode::BAD_GATEWAY);
            }
            let root = std::env::temp_dir().join(format!("aichat-health-{}", Uuid::new_v4()));
            let supervisor = RuntimeSupervisor::new(RuntimeConfig {
                id: "mcp".into(), products: vec!["keepwork-mcp-runtime".into()],
                port, health_path: "/health".into(), updates_enabled: false,
                bundled_dir: root.join("bundle"), store_dir: root.join("store"), feed_url: String::new(),
            });
            let probe = supervisor.probe_health().await.expect("loopback health must bypass the rejecting proxy");
            assert!(probe.compatible, "legacy health without optional fsApi remains supported");
            assert_eq!(probe.pid, 123);
            assert_eq!(probe.runtime_version, "fixture");
            assert_eq!(probe.host_kind, "vscode-extension");
            health.await.unwrap();
            assert!(supervisor.probe_health().await.is_none(), "a stopped daemon remains offline even with a proxy configured");
        });
        return;
    }

    // Give only the child process hostile proxy settings; parallel tests keep
    // their original environment and never share process-global mutations.
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    proxy.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let proxy_done = Arc::clone(&done);
    let proxy_thread = std::thread::spawn(move || {
        while !proxy_done.load(Ordering::Relaxed) {
            match proxy.accept() {
                Ok((mut stream, _)) => {
                    // Accepted sockets inherit O_NONBLOCK on BSD, so the
                    // request would be dropped before the 502 is written.
                    let _ = stream.set_nonblocking(false);
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0u8; 4096];
                    // Drain the complete request headers before closing;
                    // unread TCP data can turn the fixture's 502 into a reset.
                    let mut used = 0;
                    while used < request.len() {
                        match stream.read(&mut request[used..]) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => used += n,
                        }
                        if request[..used].windows(4).any(|v| v == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => panic!("proxy fixture failed: {e}"),
            }
        }
    });
    let mut results = Vec::new();
    for mode in ["proxy", "direct"] {
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "runtime::tests::loopback_health_ignores_proxy_environment",
                "--nocapture",
            ])
            .env(CHILD_ENV, mode)
            .env("NO_PROXY", if mode == "direct" { "*" } else { "" })
            .env("no_proxy", if mode == "direct" { "*" } else { "" });
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            if mode == "proxy" {
                child.env(key, &proxy_url);
            } else {
                child.env_remove(key);
            }
        }
        results.push((mode, child.output()));
    }
    done.store(true, Ordering::Relaxed);
    proxy_thread.join().unwrap();
    for (mode, output) in results {
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "isolated {mode} health check failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "the child must actually execute the regression test"
        );
    }
}

#[test]
fn staged_node_bundle_is_readable_by_rust_on_macos_and_windows() {
    let root = std::env::temp_dir().join(format!("node-stage-contract-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let bundler = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/bundle-mcp-runtime.cjs");
    // Consume the actual JS bundler's artifact, rather than duplicating its
    // normalized manifest in a Rust-only fixture. No runtime is launched.
    let output = Command::new("node")
        .args(["-e", r#"
const fs=require('node:fs'),path=require('node:path');
const bundler=require(process.argv[1]),base=process.argv[2];
const {createRuntimeManifest}=require(path.resolve(path.dirname(process.argv[1]),'../../mcp-runtime/scripts/stage-runtime.cjs'));
for(const [target,platform,arch,node] of [
 ['aarch64-apple-darwin','macos','arm64','bin/node'],
 ['x86_64-pc-windows-msvc','windows','x64','node.exe']
]){
 const root=path.join(base,platform),stage=path.join(root,'staging',platform+'-'+arch);
 for(const file of [node,'app/cli.cjs']){fs.mkdirSync(path.dirname(path.join(stage,file)),{recursive:true});fs.writeFileSync(path.join(stage,file),'fixture');}
 fs.writeFileSync(path.join(stage,'app/package.json'),JSON.stringify({version:'0.1.52',commit:'a'.repeat(40)}));
 const canonical=path.join(root,'canonical');fs.cpSync(stage,canonical,{recursive:true});
 fs.writeFileSync(path.join(canonical,'runtime.json'),JSON.stringify(createRuntimeManifest({runtimePackage:{version:'0.1.52',commit:'a'.repeat(40)},nodeVersion:'22.23.2',target:{platform,arch}})));
 fs.writeFileSync(path.join(stage,'runtime.json'),JSON.stringify({schemaVersion:1,product:'keepwork-mcp-node-runtime',version:'0.1.52',platform,arch,entry:'app/cli.cjs'}));
 bundler.bundle({root:path.join(root,'staging'),out:path.join(root,'out'),target,require:true,sourceChanged:()=>false});
}
"#])
        .arg(&bundler)
        .arg(&root)
        .env_remove("AICHAT_MCP_RUNTIME_DIR")
        .output()
        .expect("Node is required for the staged-runtime artifact regression");
    assert!(
        output.status.success(),
        "JS artifact generation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    for (platform, arch, node) in [
        ("macos", "arm64", "bin/node"),
        ("windows", "x64", "node.exe"),
    ] {
        let staged = root.join(platform).join("canonical");
        let fresh = validate_runtime_dir(&staged, "keepwork-mcp-node-runtime").unwrap();
        assert_eq!(fresh.commit, "a".repeat(40));
        assert_eq!(fresh.node, node);
        assert_eq!(fresh.engine, "node");
        let bundled = root.join(platform).join("out").join(arch);
        let parsed = validate_runtime_dir(&bundled, "keepwork-mcp-node-runtime").unwrap();
        assert_eq!(parsed.commit, "a".repeat(40));
        assert_eq!(parsed.engine, "node");
        assert_eq!(parsed.node, node);
        assert!(!parsed.is_rust());
        let manifest_file = bundled.join("runtime.json");
        let mut missing: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_file).unwrap()).unwrap();
        missing.as_object_mut().unwrap().remove("commit");
        fs::write(&manifest_file, serde_json::to_vec(&missing).unwrap()).unwrap();
        assert!(validate_runtime_dir(&bundled, "keepwork-mcp-node-runtime")
            .unwrap_err()
            .contains("commit"));
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn accepts_a_rust_runtime_manifest_without_a_node_binary() {
    let root = std::env::temp_dir().join(format!("aichat-rust-rt-rust-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::write(root.join("bin/keepwork-mcp"), b"bin").unwrap();
    let manifest = serde_json::json!({
        "schemaVersion": 2,
        "product": "keepwork-mcp-runtime",
        "engine": "rust",
        "version": "0.1.0",
        "commit": "b".repeat(40),
        "platform": "macos",
        "arch": "arm64",
        "entry": "bin/keepwork-mcp",
        "args": ["--port", "8089"],
        "env": {},
    });
    fs::write(
        root.join("runtime.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    let parsed = validate_runtime_dir_any(&root, &["keepwork-mcp-runtime"]).unwrap();
    assert!(parsed.is_rust());
    assert_eq!(parsed.entry, "bin/keepwork-mcp");
    // The Node product must not accept a Rust runtime, and vice versa.
    assert!(validate_runtime_dir(&root, "keepwork-mcp-node-runtime").is_err());
    assert!(validate_runtime_dir_any(
        &root,
        &["keepwork-mcp-runtime", "keepwork-mcp-node-runtime"]
    )
    .is_ok());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn zip64_and_descriptor_archives_extract_without_shell_tools() {
    for descriptor in [false, true] {
        let root = std::env::temp_dir().join(format!("zip-contract-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o755)
            .large_file(!descriptor);
        writer.start_file("bin/keepwork-mcp", options).unwrap();
        writer.write_all(b"runtime fixture").unwrap();
        let mut bytes = writer.finish().unwrap().into_inner();
        if descriptor {
            let cd = bytes.windows(4).position(|v| v == b"PK\x01\x02").unwrap();
            let mut data_descriptor = b"PK\x07\x08".to_vec();
            data_descriptor.extend_from_slice(&bytes[14..26]);
            bytes[6] |= 8;
            bytes[14..26].fill(0);
            bytes[cd + 8] |= 8;
            bytes.splice(cd..cd, data_descriptor);
            let end = bytes.len() - 22;
            bytes[end + 16..end + 20].copy_from_slice(&((cd + 16) as u32).to_le_bytes());
        }
        let archive = root.join("runtime.zip");
        fs::write(&archive, bytes).unwrap();
        extract_zip_archive(&archive, &root.join("out")).unwrap();
        let binary = root.join("out/bin/keepwork-mcp");
        assert_eq!(fs::read(&binary).unwrap(), b"runtime fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn zip_paths_cannot_escape_extraction_root() {
    let root = std::env::temp_dir().join(format!("zip-paths-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"outside").unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    fs::write(root.join("bad.zip"), bytes).unwrap();
    assert!(extract_zip_archive(&root.join("bad.zip"), &root.join("out")).is_err());
    assert!(!root.join("escape.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn creates_and_extracts_zip_and_validates_runtime_manifest() {
    let root = std::env::temp_dir().join(format!("aichat-rust-rt-{}", Uuid::new_v4()));
    let src_dir = root.join("src_rt");
    fs::create_dir_all(src_dir.join("bin")).unwrap();
    fs::write(src_dir.join("bin/node"), "#!/bin/sh\n").unwrap();
    fs::write(src_dir.join("cli.js"), "console.log('ok');\n").unwrap();

    let commit = "a".repeat(40);
    let manifest = RuntimeManifest {
        product: "keepwork-mcp-node-runtime".to_string(),
        engine: "node".to_string(),
        platform: current_runtime_platform().to_string(),
        arch: current_runtime_arch().to_string(),
        version: "0.2.88".to_string(),
        commit: commit.clone(),
        built_at: "2026-11-09T00:00:00Z".to_string(),
        node: "bin/node".to_string(),
        entry: "cli.js".to_string(),
        args: vec![],
        env: Default::default(),
    };
    fs::write(
        src_dir.join("runtime.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let zip_path = root.join("package.zip");
    create_zip_from_dir(&src_dir, &zip_path).unwrap();

    let out_dir = root.join("extracted");
    extract_zip_archive(&zip_path, &out_dir).unwrap();

    let validated = validate_runtime_dir(&out_dir, "keepwork-mcp-node-runtime").unwrap();
    assert_eq!(validated.version, "0.2.88");
    assert_eq!(validated.commit, commit);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn runtime_manifest_defaults_missing_node_to_bundled_node_binary() {
    let raw = r#"{
        "product": "keepwork-mcp-node-runtime",
        "platform": "macos",
        "arch": "arm64",
        "version": "0.1.44",
        "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "entry": "app/cli.cjs"
    }"#;
    let manifest: RuntimeManifest = serde_json::from_str(raw).unwrap();
    assert_eq!(
        manifest.node,
        if cfg!(target_os = "windows") {
            "bin/node.exe"
        } else {
            "bin/node"
        }
    );
}

#[test]
fn mcp_feed_platform_uses_published_artifact_names() {
    #[cfg(target_os = "macos")]
    {
        assert_eq!(current_runtime_platform(), "darwin");
        assert_eq!(mcp_feed_platform(), "macos");
    }
    #[cfg(target_os = "windows")]
    {
        assert_eq!(current_runtime_platform(), "win32");
        assert_eq!(mcp_feed_platform(), "windows");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    assert_eq!(mcp_feed_platform(), "linux");
}

#[test]
fn update_manifest_accepts_published_mcp_platform() {
    let manifest = RuntimeUpdateManifest {
        schema_version: 1,
        product: "keepwork-mcp-node-runtime".to_string(),
        platform: mcp_feed_platform().to_string(),
        arch: current_runtime_arch().to_string(),
        version: "0.1.44".to_string(),
        commit: "a".repeat(40),
        built_at: "2026-11-09T00:00:00Z".to_string(),
        url: "https://cdn.keepwork.com/keepwork/mcp-stable/0.1.44/macos-arm64.zip".to_string(),
        sha256: "b".repeat(64),
        size: 1024,
    };
    assert!(validate_update_manifest(
        &manifest,
        "keepwork-mcp-node-runtime",
        mcp_feed_platform(),
        current_runtime_arch(),
    )
    .is_ok());

    #[cfg(target_os = "macos")]
    {
        let mut wrong = manifest.clone();
        wrong.platform = current_runtime_platform().to_string();
        assert!(validate_update_manifest(
            &wrong,
            "keepwork-mcp-node-runtime",
            mcp_feed_platform(),
            current_runtime_arch(),
        )
        .is_err());
    }
}

#[test]
fn rust_mcp_start_waits_one_minute_and_stops_after_five_attempts() {
    assert_eq!(rust_start_retry(0, None), RustStartRetry::Allow);
    assert_eq!(
        rust_start_retry(1, Some(Duration::from_secs(59))),
        RustStartRetry::Wait
    );
    assert_eq!(
        rust_start_retry(1, Some(Duration::from_secs(60))),
        RustStartRetry::Allow
    );
    assert_eq!(
        rust_start_retry(4, Some(Duration::from_secs(60))),
        RustStartRetry::Allow
    );
    assert_eq!(
        rust_start_retry(5, Some(Duration::from_secs(60))),
        RustStartRetry::Stop
    );
    assert_eq!(rust_start_retry(5, None), RustStartRetry::Stop);
    assert!(rust_start_retry_suffix(1).contains("1/5"));
    assert!(rust_start_retry_suffix(4).contains("4/5"));
    assert!(rust_start_retry_suffix(5).contains("停止自动重试"));

    let root = std::env::temp_dir().join(format!("aichat-rust-mcp-retry-{}", Uuid::new_v4()));
    // A port that was just released refuses the health probe immediately.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let supervisor = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec!["keepwork-mcp-runtime".into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("missing"),
        store_dir: root.join("store"),
        feed_url: String::new(),
    });
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let first = supervisor.ensure_started(false).await;
        assert_eq!(first.state, "error");
        assert!(
            first.error.contains("1/5"),
            "first rust start failure should schedule one retry: {}",
            first.error
        );
        let second = supervisor.ensure_started(false).await;
        assert_eq!(
            second.error, first.error,
            "a second call inside the same minute must not consume another attempt"
        );
        assert_eq!(supervisor.rust_start_failures.load(Ordering::Relaxed), 1);

        supervisor
            .rust_start_failures
            .store(RUST_MCP_MAX_START_ATTEMPTS, Ordering::Relaxed);
        let stopped = supervisor.ensure_started(false).await;
        assert_eq!(stopped.error, first.error);
        assert_eq!(
            supervisor.rust_start_failures.load(Ordering::Relaxed),
            RUST_MCP_MAX_START_ATTEMPTS
        );

        supervisor.clear_rust_start_retries();
        let restarted = supervisor.ensure_started(false).await;
        assert!(
            restarted.error.contains("1/5"),
            "a manual retry clears the cap: {}",
            restarted.error
        );
    });

    let node = RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".into(),
        products: vec!["keepwork-mcp-node-runtime".into()],
        port,
        health_path: "/health".into(),
        updates_enabled: false,
        bundled_dir: root.join("missing-node"),
        store_dir: root.join("store-node"),
        feed_url: String::new(),
    });
    runtime.block_on(async {
        let failed = node.ensure_started(false).await;
        assert_eq!(failed.state, "error");
        assert!(
            !failed.error.contains("1/5"),
            "node runtime keeps the existing restart policy: {}",
            failed.error
        );
        assert_eq!(node.rust_start_failures.load(Ordering::Relaxed), 0);
    });
    let _ = std::fs::remove_dir_all(&root);
}
