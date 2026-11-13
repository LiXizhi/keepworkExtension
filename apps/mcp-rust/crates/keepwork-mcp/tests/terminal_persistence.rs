//! A real fixture CLI ends behind a barrier while only its temporary registry
//! commit path is blocked. No listener, provider account or user profile is used.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

const OWNER: &str = "terminal-persistence-owner-aaaaaaaaaaaaaaaa";

struct Fixture {
    directory: PathBuf,
    previous_cli: Option<OsString>,
    previous_log: Option<OsString>,
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "keepwork-terminal-persistence-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(directory.join("workspace")).unwrap();
        let source = include_str!("../../../../../scripts/contract/fixtures/claude-agent-cli.cjs");
        let ready = serde_json::to_string(&directory.join("native-ready.json")).unwrap();
        let release = serde_json::to_string(&directory.join("release-terminal")).unwrap();
        let replacement = format!(
            r#"if (text.includes('FIXTURE_TERMINAL_BARRIER')) {{
  fs.writeFileSync({ready}, JSON.stringify({{ pid: process.pid, thread }}));
  const poll = setInterval(() => {{
    if (!fs.existsSync({release})) return;
    clearInterval(poll);
    send({{ type: 'result', subtype: 'success', is_error: false,
      result: 'fixture finished once', session_id: thread }});
    process.stdout.write('', () => process.exit(0));
  }}, 5);
  return;
}}
if (text.includes('FIXTURE_SLOW')) return;"#
        );
        let marker = "if (text.includes('FIXTURE_SLOW')) return;";
        assert_eq!(source.matches(marker).count(), 1);
        let cli = directory.join("claude fixture.cjs");
        std::fs::write(&cli, source.replace(marker, &replacement)).unwrap();
        let previous_cli = std::env::var_os("KEEPWORK_CLAUDE_PATH");
        let previous_log = std::env::var_os("KEEPWORK_AGENT_FIXTURE_LOG");
        // This integration-test executable contains one test. Other Cargo test
        // executables have independent environments; both values are restored.
        std::env::set_var("KEEPWORK_CLAUDE_PATH", cli);
        std::env::set_var("KEEPWORK_AGENT_FIXTURE_LOG", directory.join("native.log"));
        Self {
            directory,
            previous_cli,
            previous_log,
        }
    }

    fn state(&self) -> Arc<AppState> {
        Arc::new(AppState::new_at(
            31337,
            self.directory.join("workspace"),
            false,
            "isolated-fixture-token".into(),
            Identity::from_env(Some("standalone".into()), None),
            self.directory.join("profile/personas-v1"),
        ))
    }

    fn users(&self, thread: &Value) -> usize {
        std::fs::read_to_string(self.directory.join("native.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|row| row["thread"] == *thread && row["message"]["type"] == "user")
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, previous) in [
            ("KEEPWORK_CLAUDE_PATH", self.previous_cli.take()),
            ("KEEPWORK_AGENT_FIXTURE_LOG", self.previous_log.take()),
        ] {
            if let Some(value) = previous {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

async fn request(state: &Arc<AppState>, route: &str, body: Option<Value>) -> Value {
    let mut request = Request::builder()
        .method(if body.is_some() { "POST" } else { "GET" })
        .uri(route)
        .header("origin", "http://127.0.0.1:31337")
        .header("x-agent-owner", OWNER);
    let body = if let Some(value) = body {
        request = request.header("content-type", "application/json");
        Body::from(value.to_string())
    } else {
        Body::empty()
    };
    let response = router(state.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{route}: {value}");
    value
}

async fn wait_file(file: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !file.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture CLI must reach the explicit terminal barrier");
}

async fn wait_pid_gone(pid: u64) {
    // Node is already required by the real CLI fixture. Signal zero is only a
    // portable liveness probe, never a request to terminate another process.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = tokio::process::Command::new("node")
                .args([
                    "-e",
                    "try{process.kill(Number(process.argv[1]),0);process.exit(1)}catch(e){process.exit(e.code==='ESRCH'?0:2)}",
                    &pid.to_string(),
                ])
                .status()
                .await
                .unwrap();
            if status.success() {
                break;
            }
            assert_eq!(status.code(), Some(1), "own fixture PID probe failed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the exact test-owned CLI PID must exit and be reaped");
}

async fn exercise(fixture: &Fixture, state: &Arc<AppState>) -> Value {
    let mut sessions = Vec::new();
    for conversation in ["terminal-failure", "unaffected-session"] {
        sessions.push(
            request(
                state,
                "/agents/sessions",
                Some(json!({"backend":"claude","conversationId":conversation,
                    "roots":[fixture.directory.join("workspace")]})),
            )
            .await,
        );
    }
    let affected = &sessions[0];
    let affected_route = format!("/agents/sessions/{}", affected["id"].as_str().unwrap());
    let turn_route = format!("{affected_route}/turns");
    let nonce = "persist-terminal-once";
    let accepted = request(
        state,
        &turn_route,
        Some(json!({"requestId":nonce,"text":"FIXTURE_TERMINAL_BARRIER"})),
    )
    .await;
    assert_eq!(accepted["submission"]["state"], "accepted");
    wait_file(&fixture.directory.join("native-ready.json")).await;
    let ready: Value = serde_json::from_slice(
        &std::fs::read(fixture.directory.join("native-ready.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(ready["thread"], affected["threadId"]);
    let pid = ready["pid"].as_u64().unwrap();
    let registry = fixture.directory.join("profile/agent-sessions-v1.json");
    let before = std::fs::read(&registry).unwrap();
    let blocked = registry.with_extension("json.tmp");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(fixture.directory.join("release-terminal"), "release").unwrap();
    wait_pid_gone(pid).await;

    // The native terminal is now known, not guessed from a slow output stream.
    // Keep storage blocked while giving a bounded recovery/error path a chance.
    let mut during = request(state, &affected_route, None).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while during["status"] == "running" && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
        during = request(state, &affected_route, None).await;
    }
    let duplicate = request(
        state,
        &turn_route,
        Some(json!({"requestId":nonce,"text":"must not dispatch changed text"})),
    )
    .await;
    assert_eq!(
        duplicate["submission"]["turnId"],
        accepted["submission"]["turnId"]
    );
    assert_eq!(duplicate["session"]["lastSubmission"]["requestId"], nonce);
    assert_eq!(fixture.users(&affected["threadId"]), 1);
    assert_eq!(std::fs::read(&registry).unwrap(), before);
    let other_route = format!("/agents/sessions/{}", sessions[1]["id"].as_str().unwrap());
    assert_eq!(request(state, &other_route, None).await["status"], "idle");

    std::fs::remove_dir(&blocked).unwrap();
    request(
        state,
        &format!("{other_route}/turns"),
        Some(json!({"requestId":"unaffected-turn","text":"ordinary continuation"})),
    )
    .await;
    // turn/start performs the production harness event barrier. All earlier
    // notifications for this shared Claude harness have now been reconciled.
    let recovered = request(state, &affected_route, None).await;
    let duplicate_after_recovery = request(
        state,
        &turn_route,
        Some(json!({"requestId":nonce,"text":"must not replay after storage recovery"})),
    )
    .await;
    assert_eq!(
        duplicate_after_recovery["submission"]["turnId"],
        accepted["submission"]["turnId"]
    );
    assert_eq!(
        duplicate_after_recovery["session"]["lastSubmission"]["requestId"],
        nonce
    );
    let mut other = request(state, &other_route, None).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while other["status"] != "completed" && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
        other = request(state, &other_route, None).await;
    }
    assert_eq!(
        other["status"], "completed",
        "other session must remain usable"
    );
    assert_eq!(fixture.users(&affected["threadId"]), 1);
    let restarted = fixture.state();
    let after_restart = request(&restarted, &affected_route, None).await;
    let duplicate_after_restart = request(
        &restarted,
        &turn_route,
        Some(json!({"requestId":nonce,"text":"must not replay after restart"})),
    )
    .await;
    assert_eq!(
        duplicate_after_restart["submission"]["turnId"],
        accepted["submission"]["turnId"]
    );
    assert_eq!(
        duplicate_after_restart["session"]["lastSubmission"]["requestId"],
        nonce
    );
    assert_eq!(fixture.users(&affected["threadId"]), 1);
    drop(restarted); // read-only reload; never takes over the live manager.
    json!({"ownedNativePid":pid,"nativeExitedBeforeObservation":true,
        "duringStorageFailure":during,"afterStorageRestoredAndEventBarrier":recovered,
        "afterReadOnlyRestart":after_restart,"unaffectedStatus":other["status"],
        "acceptedTurnId":accepted["submission"]["turnId"],
        "nativeDispatchCount":fixture.users(&affected["threadId"])})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ended_native_turn_cannot_remain_running_after_a_registry_commit_failure() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let result = std::panic::AssertUnwindSafe(exercise(&fixture, &state))
        .catch_unwind()
        .await;
    // Always reap only this manager's CLI children before removing its profile,
    // including a failed assertion in the fault injection or positive controls.
    state.agents.close().await;
    drop(state);
    let observed = result.unwrap();
    let answer = |view: &Value| {
        view["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "agentMessage")
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let compact = |view: &Value| {
        json!({"status":view["status"],"error":view["error"],"cursor":view["cursor"],
            "lastSubmission":view["lastSubmission"],"nativeAnswer":answer(view)})
    };
    eprintln!(
        "terminal persistence observation: {}",
        json!({"ownedNativePid":observed["ownedNativePid"],
            "nativeExitedBeforeObservation":observed["nativeExitedBeforeObservation"],
            "duringStorageFailure":compact(&observed["duringStorageFailure"]),
            "afterStorageRestoredAndEventBarrier":compact(&observed["afterStorageRestoredAndEventBarrier"]),
            "afterReadOnlyRestart":compact(&observed["afterReadOnlyRestart"]),
            "nativeDispatchCount":observed["nativeDispatchCount"],"unaffectedStatus":observed["unaffectedStatus"]})
    );
    let during = &observed["duringStorageFailure"];
    assert!(
        !["running", "starting", "waiting", "completed"]
            .contains(&during["status"].as_str().unwrap_or("")),
        "an ended native turn must expose storage failure/unknown, never active or durable success"
    );
    assert!(during["error"]
        .as_str()
        .unwrap_or("")
        .contains("NATIVE_STATE_PERSIST_FAILED"));
    assert_eq!(answer(during), "fixture finished once");
    for key in [
        "afterStorageRestoredAndEventBarrier",
        "afterReadOnlyRestart",
    ] {
        let view = &observed[key];
        assert_eq!(
            view["status"], "completed",
            "{key}: original terminal must be recovered"
        );
        assert_eq!(
            view["error"], "",
            "{key}: the storage error must clear after commit"
        );
        assert_eq!(
            view["items"], during["items"],
            "{key}: native output must survive recovery"
        );
        assert_eq!(answer(view), "fixture finished once");
        assert_eq!(view["lastSubmission"]["requestId"], "persist-terminal-once");
        assert_eq!(view["lastSubmission"]["turnId"], observed["acceptedTurnId"]);
        assert!(view["cursor"].as_u64().unwrap() > during["cursor"].as_u64().unwrap());
        assert!(view.get("_nativePersistenceError").is_none());
        assert!(view.get("_nativeObservedState").is_none());
    }
    assert_eq!(observed["nativeDispatchCount"], 1);
}
