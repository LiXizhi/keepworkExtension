//! Real host PTY contract regression. On legacy Windows, copy the pinned WinPTY
//! DLL/agent next to this test executable before running it. Cross-compilation
//! alone is not a native Win7/8 smoke result.
#![cfg(any(not(any(target_vendor = "win7", feature = "win7-compat")), windows))]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

struct Fixture {
    root: std::path::PathBuf,
    state: Arc<AppState>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kp-pty-中文-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("workspace/中文 folder")).unwrap();
        let state = Arc::new(AppState::new_at(
            31337,
            root.join("workspace"),
            true,
            "owned-terminal-token".into(),
            Identity::from_env(None, None),
            root.join("profile/personas-v1"),
        ));
        Self { root, state }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.terminals.close_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
const OWNER: &str = "https://keepwork.com";
async fn send(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Value,
    owner: &str,
    auth: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Origin", owner)
        .header("Content-Type", "application/json");
    if auth {
        request = request.header("Authorization", "Bearer owned-terminal-token");
    }
    let response = router(Arc::clone(&f.state))
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn marker_command(name: &str) -> String {
    if cfg!(windows) {
        format!("$p = 'KW_PTY_'; Write-Output ($p + '{name}')\r")
    } else {
        format!("printf '%s%s\\n' KW_PTY_ {name}\r")
    }
}
async fn wait_output(f: &Fixture, route: &str, marker: &str) -> Value {
    wait_output_since(f, route, marker, 0).await
}
async fn wait_output_since(f: &Fixture, route: &str, marker: &str, cursor: u64) -> Value {
    wait_output_matching(f, route, marker, cursor, |text| text.contains(marker)).await
}
async fn wait_output_matching(
    f: &Fixture,
    route: &str,
    description: &str,
    cursor: u64,
    matches: impl Fn(&str) -> bool,
) -> Value {
    let mut last_snapshot = Value::Null;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (status, value) = send(
                f,
                "GET",
                &format!("{route}/output?cursor={cursor}"),
                json!({}),
                OWNER,
                true,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{value}");
            if matches(value["output"].as_str().unwrap_or("")) {
                return value;
            }
            let tail: String = value["output"]
                .as_str()
                .unwrap_or("")
                .chars()
                .rev()
                .take(4096)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            last_snapshot = json!({"outputTail":tail,"cursor":value["cursor"],"closed":value["closed"]});
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("real PTY must produce {description}, not just echo its input; last snapshot: {last_snapshot}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_pty_preserves_input_stream_resize_interrupt_owner_and_auth_contracts() {
    #[cfg(all(windows, not(any(target_vendor = "win7", feature = "win7-compat"))))]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetConsoleCtrlHandler(
                handler: Option<unsafe extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
            fn AllocConsole() -> i32;
        }
        // This integration-test executable owns one test. Reproduce the
        // inheritable flag of CI/detached launchers; spawning the actual PTY
        // must clear it without replacing the shell or weakening interrupt.
        let mut enabled = unsafe { SetConsoleCtrlHandler(None, 1) };
        if enabled == 0 && std::io::Error::last_os_error().raw_os_error() == Some(6) {
            // A headless runner may lack a console. Only this isolated test
            // allocates one so the inheritable precondition is real.
            assert_ne!(unsafe { AllocConsole() }, 0);
            enabled = unsafe { SetConsoleCtrlHandler(None, 1) };
        }
        assert_ne!(
            enabled, 0,
            "must establish the inherited ignore-Ctrl+C state"
        );
    }
    // Legacy readiness starts asynchronously. Missing assets still fail this
    // native test, while a cold agent has time for bounded startup retries.
    tokio::time::timeout(Duration::from_secs(30), async {
        while !keepwork_mcp::terminal::health().ready {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "native test requires a ready, complete pinned PTY backend: {:?}",
            keepwork_mcp::terminal::health()
        )
    });
    let f = Fixture::new();
    for (owner, auth, expected) in [
        ("https://evil.example", true, StatusCode::FORBIDDEN),
        (OWNER, false, StatusCode::UNAUTHORIZED),
    ] {
        assert_eq!(
            send(&f, "POST", "/terminal/sessions", json!({}), owner, auth)
                .await
                .0,
            expected
        );
    }
    assert!(!send(
        &f,
        "POST",
        "/terminal/sessions",
        json!({"cwd":"../../outside"}),
        OWNER,
        true
    )
    .await
    .0
    .is_success());
    #[cfg(unix)]
    {
        std::fs::create_dir_all(f.root.join("external")).unwrap();
        std::os::unix::fs::symlink(f.root.join("external"), f.state.root.join("escape-link"))
            .unwrap();
        assert_eq!(
            send(
                &f,
                "POST",
                "/terminal/sessions",
                json!({"cwd":"escape-link/new-child"}),
                OWNER,
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert!(!f.root.join("external/new-child").exists());
    }
    let (status, session) = send(
        &f,
        "POST",
        "/terminal/sessions",
        json!({"cwd":"中文 folder","cols":80,"rows":24}),
        OWNER,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{session}");
    assert!(session["cwd"].as_str().unwrap().ends_with("中文 folder"));
    let route = format!("/terminal/sessions/{}", session["id"].as_str().unwrap());
    assert_eq!(
        send(
            &f,
            "GET",
            &format!("{route}/output"),
            json!({}),
            "http://localhost:3001",
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(
            &f,
            "POST",
            &format!("{route}/commands"),
            json!({"command":"shutdown -h now"}),
            OWNER,
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Raw user input remains a PTY byte stream; it is not run_terminal.
    #[cfg(windows)]
    {
        // Backend readiness is separate from a new shell's first prompt. Do
        // not mix initialization with the command's own 10-second deadline or
        // inject input while PowerShell is still changing its console modes.
        // No input has been sent, and both parts must come from this session's
        // default NoProfile prompt rather than the executable's window title.
        wait_output_matching(&f, &route, "initial PowerShell prompt", 0, |text| {
            text.contains("PS ") && text.contains("中文 folder>")
        })
        .await;
    }
    assert_eq!(
        send(
            &f,
            "POST",
            &format!("{route}/input"),
            json!({"data":marker_command("EXECUTED")}),
            OWNER,
            true
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let output = wait_output(&f, &route, "KW_PTY_EXECUTED").await;
    let cursor = output["cursor"].as_u64().unwrap();
    let (status, resized) = send(
        &f,
        "POST",
        &format!("{route}/resize"),
        json!({"cols":101,"rows":31}),
        OWNER,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resized["cols"], 101);
    assert_eq!(resized["rows"], 31);

    let response = router(Arc::clone(&f.state))
        .oneshot(
            Request::builder()
                .uri(format!("{route}/stream?cursor={cursor}"))
                .header("Origin", OWNER)
                .header("Authorization", "Bearer owned-terminal-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("application/x-ndjson"));
    let mut stream = response.into_body();
    let first = tokio::time::timeout(Duration::from_secs(2), stream.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let replay: Value = serde_json::from_slice(first.data_ref().unwrap()).unwrap();
    assert!(replay["cursor"].as_u64().unwrap() >= cursor);
    assert_eq!(replay["reset"], false);

    let unicode = if cfg!(windows) {
        "Write-Output ([string][char]0x4e2d + [char]0x6587 + [char]0xd83d + [char]0xde00)\r"
    } else {
        "printf '\\344\\270\\255\\346\\226\\207\\360\\237\\230\\200\\n'\r"
    };
    send(
        &f,
        "POST",
        &format!("{route}/input"),
        json!({"data":unicode}),
        OWNER,
        true,
    )
    .await;
    let output = wait_output(&f, &route, "中文😀").await;
    assert_eq!(
        output["cursor"].as_u64().unwrap() as usize,
        output["output"].as_str().unwrap().encode_utf16().count()
    );
    let mut streamed = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !streamed.contains("中文😀") {
            let frame = stream.frame().await.unwrap().unwrap();
            let event: Value = serde_json::from_slice(frame.data_ref().unwrap()).unwrap();
            streamed.push_str(event["output"].as_str().unwrap());
        }
    })
    .await
    .unwrap();

    let sleeping = if cfg!(windows) {
        "function prompt { 'KW_PTY_' + 'READY> ' }; $p = 'KW_PTY_'; Write-Output ($p + 'SLEEPING'); Start-Sleep -Seconds 30\r"
    } else {
        "PS1='KW_PTY_''READY> '; printf '%s%s\\n' KW_PTY_ SLEEPING; sleep 30\r"
    };
    send(
        &f,
        "POST",
        &format!("{route}/input"),
        json!({"data":sleeping}),
        OWNER,
        true,
    )
    .await;
    // A write acknowledgement does not prove that the shell has started the
    // long command. Its computed output cannot be satisfied by input echo.
    let sleeping_output = wait_output(&f, &route, "KW_PTY_SLEEPING").await;
    let before_interrupt = sleeping_output["cursor"].as_u64().unwrap();
    assert_eq!(
        send(
            &f,
            "POST",
            &format!("{route}/interrupt"),
            json!({}),
            OWNER,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    // Ctrl+C is asynchronous. Wait for a new prompt so cancellation cannot
    // flush the next command, and never accept an old prompt from replay.
    wait_output_since(&f, &route, "KW_PTY_READY> ", before_interrupt).await;
    send(
        &f,
        "POST",
        &format!("{route}/input"),
        json!({"data":marker_command("AFTER_INTERRUPT")}),
        OWNER,
        true,
    )
    .await;
    wait_output(&f, &route, "KW_PTY_AFTER_INTERRUPT").await;
    assert_eq!(
        send(
            &f,
            "DELETE",
            &route,
            json!({}),
            "http://localhost:3001",
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(&f, "DELETE", &route, json!({}), OWNER, true).await.0,
        StatusCode::OK
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = stream.frame().await.unwrap().unwrap();
            let event: Value = serde_json::from_slice(frame.data_ref().unwrap()).unwrap();
            if event["closed"] == true {
                break;
            }
        }
    })
    .await
    .expect("closing an owned PTY must close its output stream");
    assert_eq!(
        send(
            &f,
            "GET",
            &format!("{route}/output"),
            json!({}),
            OWNER,
            true
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
