//! Real, isolated listener subprocesses exercise ownership and cancellation.
//! The fake CLI never contacts DingTalk or sends messages.
#![cfg(unix)]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use keepwork_mcp::messaging::MessagingService;
use keepwork_mcp::personas::PersonaStore;
use keepwork_mcp::presence::PresenceState;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

// This test executable owns its CLI environment independently of unit tests.
static CLI_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const BINDING: &str = "fixture-binding";
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONA: &str = "default-persona";
const CONVERSATION: &str = "cid+/fixture==";

const FAKE_DWS: &str = r#"#!/bin/sh
case "$1:$2" in
  event:status)
    if [ -f .external-consumer ]; then
      printf '%s\n' '{"identity":{"corp_id":"corp","user_id":"user"},"bus":{"live":{"consumers":[{"id":"external-owner"}]}}}'
    else
      printf '%s\n' '{"identity":{"corp_id":"corp","user_id":"user"},"bus":{"live":{"consumers":[]}}}'
    fi
    ;;
  event:consume)
    printf '%s %s\n' "$$" "$3" >> .fixture-listeners
    if [ -f .hold-before-ready ]; then
      exec /bin/sleep 600
    fi
    if [ -f .fail-second ] && [ "$3" = user_im_message_receive_group ]; then
      printf '%s\n' 'unsupported event rule' >&2
      exit 2
    fi
    printf '%s\n' '[event] ready' >&2
    if [ -f .flood-stderr ]; then
      i=0
      while [ "$i" -lt 6000 ]; do
        printf '%s\n' 'fixture diagnostic output after readiness must continue to drain rather than block the listener' >&2
        i=$((i + 1))
      done
      : > ".fixture-drained-$$"
    fi
    exec /bin/sleep 600
    ;;
  *)
    printf '%s\n' '{"error":{"code":"fixture_metadata_unavailable"}}'
    exit 2
    ;;
esac
"#;

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    service: Arc<MessagingService>,
    old_cli: Option<OsString>,
}

impl Fixture {
    fn new() -> Self {
        let home =
            std::env::temp_dir().join(format!("kp-listener-lifecycle-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        let state = home.join("messaging");
        let rules = root.join(".github/skills/message-autoreply");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(
            rules.join("config.json"),
            json!({"version":1,"keywords":["fixture"],"groups":["group"],"knowledge":[],"executor":"auto","model":""}).to_string(),
        ).unwrap();
        std::fs::write(rules.join("SKILL.md"), "Fixture: never send a message.").unwrap();
        std::fs::write(
            state.join("bindings.json"),
            json!([{"id":BINDING,"channel":"dingtalk","root":root,"profile":"corp:user","enabled":false,"agentOwner":OWNER,"agentId":PERSONA}]).to_string(),
        ).unwrap();
        std::fs::write(
            state.join("inbox.json"),
            json!({BINDING:{"messages":[{"id":"saved-message","conversation":CONVERSATION,"sender":"saved-peer","text":"Previously received message","time":1794448800000_i64,"kind":"direct","direction":"in"}],"paused":[],"read":{}}}).to_string(),
        ).unwrap();
        let program = home.join("fake-dws");
        std::fs::write(&program, FAKE_DWS).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let old_cli = std::env::var_os("KEEPWORK_DWS_PATH");
        std::env::set_var("KEEPWORK_DWS_PATH", program);
        let service = MessagingService::open(
            state,
            PersonaStore::open(home.join("personas")),
            Arc::new(PresenceState::new()),
        );
        Self {
            home,
            root,
            service,
            old_cli,
        }
    }

    fn flag(&self, name: &str) {
        std::fs::write(self.root.join(name), "fixture").unwrap();
    }

    fn pids(&self) -> Vec<u32> {
        std::fs::read_to_string(self.root.join(".fixture-listeners"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.split_whitespace().next()?.parse().ok())
            .collect()
    }

    async fn wait_for_pids(&self, count: usize) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let pids = self.pids();
            if pids.len() >= count {
                return pids;
            }
            assert!(
                Instant::now() < deadline,
                "only {} of {count} listener processes started",
                pids.len()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn assert_dead(&self, pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while pids.iter().copied().any(alive) {
            assert!(
                Instant::now() < deadline,
                "owned listeners remained alive: {pids:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn assert_cached_message(&self) {
        let result = self
            .service
            .named_inbox_view(OWNER, PERSONA, BINDING, CONVERSATION, i64::MAX)
            .await
            .unwrap();
        assert_eq!(result["messages"][0]["text"], "Previously received message");
        assert_eq!(result["messages"][0]["conversation"], CONVERSATION);
        assert_eq!(
            result["messages"][0]["senderName"], "",
            "offline metadata does not hide the message"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.service.stop(BINDING);
        // Panic cleanup only touches PIDs created by this exact fake CLI.
        for pid in self.pids() {
            if alive(pid) {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        match self.old_cli.take() {
            Some(value) => std::env::set_var("KEEPWORK_DWS_PATH", value),
            None => std::env::remove_var("KEEPWORK_DWS_PATH"),
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[tokio::test]
async fn stop_reaps_owned_listeners_and_preserves_cached_history_without_open_id() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.start(BINDING).await.unwrap();
    let pids = f.wait_for_pids(2).await;
    assert_eq!(f.service.view(BINDING).unwrap()["autoReply"], true);
    assert!(pids.iter().copied().all(alive));
    f.service.stop(BINDING);
    f.assert_dead(&pids).await;
    let view = f.service.view(BINDING).unwrap();
    assert_eq!(view["status"], "stopped");
    assert_eq!(view["error"], "");
    assert_eq!(view["autoReply"], false);
    assert_eq!(
        f.service.agent_bindings(OWNER, PERSONA)[0]["autoReply"],
        false
    );
    f.assert_cached_message().await;
    assert!(f
        .service
        .inbox_view("another-owner", PERSONA, BINDING, CONVERSATION, i64::MAX)
        .await
        .is_err());
    f.service.close().await;
}

#[tokio::test]
async fn restarting_waits_for_owned_cleanup_and_old_exits_cannot_disconnect_new_listeners() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.start(BINDING).await.unwrap();
    let old_pids = f.wait_for_pids(2).await;
    f.service.stop(BINDING);
    f.service.start(BINDING).await.unwrap();
    let all = f.wait_for_pids(4).await;
    f.assert_dead(&old_pids).await;
    assert!(all[2..].iter().copied().all(alive));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let view = f.service.view(BINDING).unwrap();
    assert_eq!(view["status"], "listening");
    assert_eq!(view["error"], "");
    assert_eq!(view["autoReply"], true);
    assert_eq!(
        f.service.agent_bindings(OWNER, PERSONA)[0]["autoReply"],
        true
    );
    f.service.close().await;
    f.assert_dead(&all).await;
}

#[tokio::test]
async fn listener_disconnect_reaps_the_other_owned_subscriptions() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.start(BINDING).await.unwrap();
    let pids = f.wait_for_pids(2).await;
    assert!(Command::new("/bin/kill")
        .args(["-TERM", &pids[0].to_string()])
        .status()
        .unwrap()
        .success());
    f.assert_dead(&pids).await;
    let view = f.service.view(BINDING).unwrap();
    assert_eq!(view["status"], "reconnecting");
    assert_eq!(view["autoReply"], true);
    assert!(view["nextRetryAt"].is_number());
    f.assert_cached_message().await;
    f.service.close().await;
}

#[tokio::test]
async fn close_reaps_listeners_and_preserves_the_enabled_preference() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.start(BINDING).await.unwrap();
    let pids = f.wait_for_pids(2).await;
    f.service.close().await;
    f.assert_dead(&pids).await;
    let saved: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("messaging/bindings.json")).unwrap())
            .unwrap();
    assert_eq!(saved[0]["enabled"], true);
    f.assert_cached_message().await;
}

#[tokio::test]
async fn failure_of_a_second_subscription_reaps_the_first_owned_listener() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.flag(".fail-second");
    let error = f.service.start(BINDING).await.unwrap_err();
    assert!(
        error.message.contains("update required"),
        "{}",
        error.message
    );
    let pids = f.wait_for_pids(2).await;
    f.assert_dead(&pids).await;
    assert_eq!(f.service.view(BINDING).unwrap()["status"], "error");
    f.service.close().await;
}

#[tokio::test]
async fn stop_during_readiness_wait_cancels_the_child_promptly() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.flag(".hold-before-ready");
    let service = Arc::clone(&f.service);
    let pending = tokio::spawn(async move { service.start(BINDING).await });
    let pids = f.wait_for_pids(1).await;
    f.service.stop(BINDING);
    tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("Stop must cancel the 45-second readiness wait")
        .unwrap()
        .unwrap();
    f.assert_dead(&pids).await;
    assert_eq!(f.service.view(BINDING).unwrap()["status"], "stopped");
    assert_eq!(f.service.view(BINDING).unwrap()["error"], "");
    f.service.close().await;
}

#[tokio::test]
async fn stderr_after_readiness_keeps_draining() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.flag(".flood-stderr");
    f.service.start(BINDING).await.unwrap();
    let pids = f.wait_for_pids(2).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids
        .iter()
        .any(|pid| !f.root.join(format!(".fixture-drained-{pid}")).exists())
    {
        assert!(
            Instant::now() < deadline,
            "stderr filled the pipe after readiness"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(f.service.view(BINDING).unwrap()["status"], "listening");
    f.service.close().await;
    f.assert_dead(&pids).await;
}

#[tokio::test]
async fn an_external_consumer_is_left_untouched_and_does_not_hide_history() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.flag(".external-consumer");
    let mut external = Command::new("/bin/sleep").arg("600").spawn().unwrap();
    let result = f.service.start(BINDING).await;
    let untouched = external.try_wait().unwrap().is_none();
    external.kill().unwrap();
    external.wait().unwrap();
    assert!(untouched, "external consumer process was modified");
    assert!(result.unwrap_err().message.contains("已有个人消息桥"));
    assert!(
        f.pids().is_empty(),
        "no listener may spawn over a foreign consumer"
    );
    assert_eq!(f.service.view(BINDING).unwrap()["status"], "reconnecting");
    f.assert_cached_message().await;
    f.service.close().await;
}

#[tokio::test]
async fn stopped_inbox_http_preserves_legacy_requests_and_encoded_conversation_ids() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.close().await;
    let messaging_home = f.home.join("messaging-v1");
    std::fs::create_dir_all(&messaging_home).unwrap();
    for file in ["bindings.json", "inbox.json"] {
        std::fs::copy(
            f.home.join("messaging").join(file),
            messaging_home.join(file),
        )
        .unwrap();
    }
    let state = Arc::new(AppState::new_at(
        8099,
        f.root.clone(),
        false,
        "fixture-token".into(),
        Identity::from_env(Some("standalone".into()), None),
        f.home.join("http-personas"),
    ));
    let created = router(Arc::clone(&state))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agents/personas")
                .header("Origin", "http://127.0.0.1:64533")
                .header("X-Agent-Owner", OWNER)
                .header("Content-Type", "application/json")
                .body(Body::from(
                    json!({
                        "id": PERSONA, "name": "Fixture persona", "root": f.root,
                        "executor": "auto", "prompt": "Fixture: never send a message."
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("binding", BINDING)
        .append_pair("conversation", CONVERSATION)
        .finish();
    let path = format!("/agents/personas/{PERSONA}/inbox?{query}");
    let request = |owner: &str| {
        Request::builder()
            .uri(&path)
            .header("Origin", "http://127.0.0.1:64533")
            .header("X-Agent-Owner", owner)
            .body(Body::empty())
            .unwrap()
    };
    let response = router(Arc::clone(&state))
        .oneshot(request(OWNER))
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["messages"][0]["text"], "Previously received message");
    assert_eq!(result["messages"][0]["conversation"], CONVERSATION);
    assert!(result["name"].is_string());
    assert_eq!(result["before"], Value::Null);
    assert_eq!(result["paused"], false);
    let response = router(Arc::clone(&state))
        .oneshot(request("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        .await
        .unwrap();
    assert_ne!(
        response.status(),
        StatusCode::OK,
        "another owner cannot read the inbox"
    );
    state.messaging.close().await;
}

struct DaemonProcess(std::process::Child);

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

async fn daemon_shutdown_fixture(admin_stop: bool) {
    let f = Fixture::new();
    f.service.close().await;
    let fixture_profile = f.home.join("daemon-profile");
    let messaging_home = fixture_profile.join(".keepwork-mcp/messaging-v1");
    std::fs::create_dir_all(&messaging_home).unwrap();
    let mut bindings: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("messaging/bindings.json")).unwrap())
            .unwrap();
    bindings[0]["enabled"] = json!(true);
    std::fs::write(messaging_home.join("bindings.json"), bindings.to_string()).unwrap();
    std::fs::copy(
        f.home.join("messaging/inbox.json"),
        messaging_home.join("inbox.json"),
    )
    .unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("daemon shutdown verification needs permission to bind loopback")
        .local_addr()
        .unwrap()
        .port();
    // Only this subprocess sees the isolated user profile; the test process's
    // home and the real daemon's port/state remain untouched.
    let mut daemon = DaemonProcess(
        Command::new(env!("CARGO_BIN_EXE_keepwork-mcp"))
            .args([
                "--port",
                &port.to_string(),
                "--root",
                f.root.to_str().unwrap(),
            ])
            .env("HOME", &fixture_profile)
            .env("KEEPWORK_MCP_REQUIRE_AUTH", "0")
            .current_dir(&f.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "fixture daemon exited before becoming healthy"
        );
        if let Ok(response) = client.get(format!("{base}/health")).send().await {
            if response.status().is_success() {
                let health: Value =
                    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
                assert_eq!(health["pid"].as_u64(), Some(u64::from(daemon.0.id())));
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "fixture daemon did not bind its loopback port"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pids = f.wait_for_pids(2).await;
    assert!(pids.iter().copied().all(alive));
    if admin_stop {
        let response = client
            .post(format!("{base}/admin/stop"))
            .header("Origin", "http://127.0.0.1:64533")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
    } else {
        assert!(Command::new("/bin/kill")
            .args(["-TERM", &daemon.0.id().to_string()])
            .status()
            .unwrap()
            .success());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = daemon.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "fixture daemon failed to exit gracefully: {status}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fixture daemon did not exit after shutdown"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f.assert_dead(&pids).await;
    let saved: Value =
        serde_json::from_slice(&std::fs::read(messaging_home.join("bindings.json")).unwrap())
            .unwrap();
    assert_eq!(
        saved[0]["enabled"], true,
        "daemon exit preserves the user's enabled preference"
    );
}

#[tokio::test]
async fn admin_stop_reaps_the_real_daemons_owned_listener_children() {
    let _env = CLI_ENV.lock().await;
    daemon_shutdown_fixture(true).await;
}

#[tokio::test]
async fn sigterm_reaps_the_real_daemons_owned_listener_children() {
    let _env = CLI_ENV.lock().await;
    daemon_shutdown_fixture(false).await;
}
