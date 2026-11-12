//! Remote data and local inbox are independent: only explicit refresh imports a
//! bounded page. The temporary fake DWS never reads an account or sends a reply.
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
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

static CLI_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONA: &str = "default-persona";
const BINDING: &str = "refresh-fixture";

const FAKE_DWS: &str = r#"#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path.cwd()
args = sys.argv[1:]
with open(root / '.calls', 'a') as out: out.write(json.dumps(args) + '\n')
def arg(flag): return args[args.index(flag)+1] if flag in args else ''
if args[:2] == ['event', 'status']:
    identity = {'corp_id':'corp','user_id':'other' if (root/'.bad-identity').exists() else 'user'}
    if not (root/'.no-open-id').exists(): identity['open_dingtalk_id'] = 'self-open'
    print(json.dumps({'identity':identity}))
elif args[:2] == ['chat', '+search-msg']:
    sender = {'status':'resolved','profile':'corp:user','selected':{'userId':'user','openDingTalkId':'self-open'}}
    if (root/'.ambiguous-self').exists(): sender['selected']['userId'] = 'other'
    print(json.dumps({'resolvedFilters':{'senders':[sender]}}))
elif args[:3] == ['chat', 'message', 'list-all']:
    (root/'.page-started').write_text('started')
    deadline = time.monotonic() + 5
    while (root/'.hold').exists() and not (root/'.release').exists() and time.monotonic() < deadline: time.sleep(.01)
    if (root/'.fail').exists():
        print(json.dumps({'error':{'code':'offline-fixture'}})); raise SystemExit(2)
    pages = json.loads((root/'.pages.json').read_text())
    print(json.dumps(pages[arg('--cursor')]))
else:
    (root/'.forbidden').write_text(json.dumps(args))
    print(json.dumps({'error':{'code':'forbidden_fixture_command'}})); raise SystemExit(2)
"#;

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    state: PathBuf,
    service: Arc<MessagingService>,
    previous_cli: Option<OsString>,
    now: i64,
}

impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("kp-inbox-refresh-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        let state = home.join("messaging");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let now = chrono::Utc::now().timestamp_millis() / 1000 * 1000;
        std::fs::write(
            state.join("bindings.json"),
            json!([{
                "id":BINDING,"channel":"dingtalk","root":root,"profile":"corp:user",
                "enabled":false,"agentOwner":OWNER,"agentId":PERSONA,
            }])
            .to_string(),
        )
        .unwrap();
        std::fs::write(state.join("inbox.json"), json!({BINDING:{
            "messages":[{"id":"old","conversation":"group-a","sender":"peer","text":"old local message",
                "time":now-120_000,"kind":"group","direction":"in"}],
            "paused":["group-a"],"read":{"group-a":now-60_000},
            "readFutureIds":{},"sends":{"kept":"sent"},"autoReplyTimes":{"group-a":[now-200_000]},
        }}).to_string()).unwrap();
        let program = home.join("fake-dws");
        std::fs::write(&program, FAKE_DWS).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let previous_cli = std::env::var_os("KEEPWORK_DWS_PATH");
        std::env::set_var("KEEPWORK_DWS_PATH", program);
        let service = MessagingService::open(
            state.clone(),
            PersonaStore::open(home.join("personas")),
            Arc::new(PresenceState::new()),
        );
        Self {
            home,
            root,
            state,
            service,
            previous_cli,
            now,
        }
    }

    fn pages(&self, value: Value) {
        std::fs::write(self.root.join(".pages.json"), value.to_string()).unwrap();
    }

    fn row(&self, id: &str, sender: &str, time: i64) -> Value {
        json!({"openMessageId":id,"senderOpenDingTalkId":sender,"createTime":time,"content":format!("remote {id}")})
    }

    fn page(&self, messages: Vec<Value>, next: &str) -> Value {
        json!({"success":true,"result":{"hasMore":!next.is_empty(),"nextCursor":next,
            "conversationMessagesList":[{"openConversationId":"group-a","singleChat":false,"messages":messages}]}})
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join(".calls"))
            .unwrap_or_default()
            .lines()
            .map(|row| serde_json::from_str(row).unwrap())
            .collect()
    }

    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.state.join("inbox.json")).unwrap()).unwrap()
    }

    fn cursor(&self) -> Value {
        serde_json::from_slice(
            &std::fs::read(self.state.join(format!("{BINDING}.refresh-cursor.json"))).unwrap(),
        )
        .unwrap()
    }

    async fn cached(&self) -> Value {
        self.service
            .inbox_view(OWNER, PERSONA, BINDING, "", i64::MAX)
            .await
            .unwrap()
    }

    async fn refresh(&self) -> Result<Value, keepwork_mcp::messaging::MessageError> {
        self.service.inbox_refresh(OWNER, PERSONA, BINDING).await
    }

    async fn wait_started(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.root.join(".page-started").exists() {
            assert!(Instant::now() < deadline, "fake history page never started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root.join(".release"), "release");
        match self.previous_cli.take() {
            Some(value) => std::env::set_var("KEEPWORK_DWS_PATH", value),
            None => std::env::remove_var("KEEPWORK_DWS_PATH"),
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[tokio::test]
async fn explicit_refresh_imports_remote_messages_once_without_sending_or_changing_controls() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let mut page = f.page(
        vec![
            f.row("same-id", "peer", f.now - 10_000),
            f.row("self", "self-open", f.now - 5_000),
            f.row("old", "peer", f.now - 120_000),
        ],
        "",
    );
    page["result"]["conversationMessagesList"].as_array_mut().unwrap().push(json!({
        "openConversationId":"group-b","singleChat":false,"messages":[f.row("same-id", "peer", f.now-9_000)]
    }));
    f.pages(json!({"0":page}));
    let before = f.saved();
    assert_eq!(f.cached().await["conversations"][0]["last"]["id"], "old");
    assert!(f.calls().is_empty(), "ordinary GET cannot query DingTalk");
    assert_eq!(f.service.view(BINDING).unwrap()["inboxRefreshVersion"], 1);
    let result = f.refresh().await.unwrap();
    assert_eq!(result["status"], "current");
    assert_eq!(result["imported"], 3);
    let view = f.cached().await;
    assert_eq!(view["conversations"].as_array().unwrap().len(), 2);
    assert_eq!(view["conversations"][0]["last"]["id"], "self");
    assert_eq!(view["conversations"][0]["last"]["direction"], "out");
    assert_eq!(view["conversations"][0]["unread"], 1);
    assert_eq!(view["conversations"][0]["paused"], true);
    let after = f.saved();
    for field in ["paused", "read", "readFutureIds", "sends", "autoReplyTimes"] {
        assert_eq!(
            after[BINDING][field], before[BINDING][field],
            "refresh must preserve {field}"
        );
    }
    assert_eq!(f.service.view(BINDING).unwrap()["autoReply"], false);
    assert_eq!(f.service.view(BINDING).unwrap()["queued"], 0);
    assert!(after[BINDING]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["id"] != "old")
        .all(|m| m["state"] == "synced"));
    // Force a second overlap window to test dedup independently of the clock.
    std::fs::write(
        f.state.join(format!("{BINDING}.refresh-cursor.json")),
        json!({"since":f.now-1000}).to_string(),
    )
    .unwrap();
    assert_eq!(f.refresh().await.unwrap()["imported"], 0);
    assert_eq!(f.saved(), after);
    assert!(!f.root.join(".forbidden").exists());
    f.service.close().await;
}

#[tokio::test]
async fn refresh_persists_pagination_and_reports_incomplete_fixed_window_honestly() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.pages(
        json!({"0":f.page(vec![f.row("page-one","peer",f.now-20_000)],"next-page"),
        "next-page":f.page(vec![f.row("page-two","peer",f.now-10_000)],"")}),
    );
    assert_eq!(f.refresh().await.unwrap()["status"], "syncing");
    let pending = f.cursor()["pending"].clone();
    assert_eq!(pending["cursor"], "next-page");
    assert_eq!(f.refresh().await.unwrap()["status"], "current");
    assert!(f.cursor()["pending"].is_null());
    let calls: Vec<_> = f
        .calls()
        .into_iter()
        .filter(|args| args[0] == "chat" && args[1] == "message")
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][4], calls[1][4], "pagination retains start");
    assert_eq!(calls[0][6], calls[1][6], "pagination retains end");
    assert_eq!(calls[1][8], "next-page");
    assert_eq!(f.saved()[BINDING]["messages"].as_array().unwrap().len(), 3);
    f.service.close().await;
}

#[tokio::test]
async fn errors_and_looping_or_partial_pages_preserve_history_and_resume_cursor() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let before = f.saved();
    let mut partial = f.page(vec![f.row("partial", "peer", f.now - 1000)], "");
    partial["partial"] = json!(true);
    f.pages(json!({"0":partial}));
    assert!(f.refresh().await.unwrap_err().message.contains("不完整"));
    assert_eq!(f.saved(), before);
    assert_eq!(f.cursor()["pending"]["cursor"], "0");
    f.pages(json!({"0":f.page(vec![],"next"),"next":f.page(vec![f.row("loop","peer",f.now-1000)],"next")}));
    f.refresh().await.unwrap();
    let cursor = f.cursor();
    assert!(f.refresh().await.unwrap_err().message.contains("没有前进"));
    assert_eq!(f.cursor(), cursor);
    assert_eq!(f.saved(), before);
    std::fs::write(f.root.join(".fail"), "offline").unwrap();
    assert!(f.refresh().await.is_err());
    assert_eq!(f.saved(), before);
    assert_eq!(f.cursor(), cursor);
    f.service.close().await;
}

#[tokio::test]
async fn identity_and_owner_are_checked_before_remote_history_can_be_read() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.pages(json!({"0":f.page(vec![],"")}));
    assert!(f
        .service
        .inbox_refresh("other-owner", PERSONA, BINDING)
        .await
        .is_err());
    assert!(f.calls().is_empty());
    std::fs::write(f.root.join(".bad-identity"), "wrong account").unwrap();
    assert!(f.refresh().await.unwrap_err().message.contains("identity"));
    assert_eq!(f.calls().len(), 1);
    std::fs::remove_file(f.root.join(".bad-identity")).unwrap();
    std::fs::write(f.root.join(".no-open-id"), "old DWS").unwrap();
    std::fs::write(f.root.join(".ambiguous-self"), "ambiguous").unwrap();
    assert!(f.refresh().await.unwrap_err().message.contains("核实"));
    assert!(!f.root.join(".page-started").exists());
    std::fs::remove_file(f.root.join(".ambiguous-self")).unwrap();
    assert_eq!(f.refresh().await.unwrap()["status"], "current");
    assert!(f.calls().iter().any(|args| args[1] == "+search-msg"));
    f.service.close().await;
}

#[tokio::test]
async fn stopping_discards_late_page_and_parallel_refreshes_cannot_race_cursor() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.pages(json!({"0":f.page(vec![f.row("late","peer",f.now-1000)],"")}));
    std::fs::write(f.root.join(".hold"), "hold").unwrap();
    let before = f.saved();
    let service = Arc::clone(&f.service);
    let pending = tokio::spawn(async move { service.inbox_refresh(OWNER, PERSONA, BINDING).await });
    f.wait_started().await;
    assert_eq!(f.refresh().await.unwrap_err().status, 409);
    let cursor = f.cursor();
    f.service.stop(BINDING);
    std::fs::write(f.root.join(".release"), "release").unwrap();
    assert!(pending
        .await
        .unwrap()
        .unwrap_err()
        .message
        .contains("cancelled"));
    assert_eq!(f.saved(), before);
    assert_eq!(f.cursor(), cursor);
    assert_eq!(
        f.calls().iter().filter(|args| args[1] == "message").count(),
        1
    );
    assert!(!f.root.join(".forbidden").exists());
    f.service.close().await;
}

#[tokio::test]
async fn optional_http_refresh_preserves_legacy_gets_and_rejects_other_owners() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.pages(json!({"0":f.page(vec![f.row("http-new","peer",f.now-1000)],"")}));
    f.service.close().await;
    let http_home = f.home.join("messaging-v1");
    std::fs::create_dir_all(&http_home).unwrap();
    for file in ["bindings.json", "inbox.json"] {
        std::fs::copy(f.state.join(file), http_home.join(file)).unwrap();
    }
    let state = Arc::new(AppState::new_at(
        8099,
        f.root.clone(),
        false,
        "fixture-token".into(),
        Identity::from_env(Some("standalone".into()), None),
        f.home.join("http-personas"),
    ));
    let request = |method: &str, path: &str, owner: &str, body: Option<Value>| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("Origin", "http://127.0.0.1:64533")
            .header("X-Agent-Owner", owner)
            .header("Content-Type", "application/json")
            .body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap()
    };
    let created = router(Arc::clone(&state)).oneshot(request("POST", "/agents/personas", OWNER,
        Some(json!({"id":PERSONA,"name":"Refresh fixture","root":f.root,"prompt":"Never send a message","executor":"auto"})))).await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let path = format!("/agents/personas/{PERSONA}/inbox?binding={BINDING}");
    let before = router(Arc::clone(&state))
        .oneshot(request("GET", &path, OWNER, None))
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK);
    let bytes = before.into_body().collect().await.unwrap().to_bytes();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["conversations"][0]["last"]["id"], "old");
    assert!(!f.root.join(".page-started").exists());
    let refresh_path = format!("/agents/personas/{PERSONA}/inbox-refresh");
    let rejected = router(Arc::clone(&state))
        .oneshot(request(
            "POST",
            &refresh_path,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            Some(json!({"binding":BINDING})),
        ))
        .await
        .unwrap();
    assert_ne!(rejected.status(), StatusCode::OK);
    assert!(!f.root.join(".page-started").exists());
    let refreshed = router(Arc::clone(&state))
        .oneshot(request(
            "POST",
            &refresh_path,
            OWNER,
            Some(json!({"binding":BINDING})),
        ))
        .await
        .unwrap();
    let status = refreshed.status();
    let bytes = refreshed.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["status"], "current");
    assert_eq!(result["imported"], 1);
    let after = router(Arc::clone(&state))
        .oneshot(request("GET", &path, OWNER, None))
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::OK);
    let bytes = after.into_body().collect().await.unwrap().to_bytes();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["conversations"][0]["last"]["id"], "http-new");
    assert_eq!(result["conversations"][0]["paused"], true);
    state.messaging.close().await;
}

#[tokio::test]
async fn refresh_resumes_node_cursor_with_optional_visited_without_changing_its_window() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let start = f.now - 3_600_000;
    let end = f.now - 1000;
    for (cursor, visited) in [("0", None), ("node-next", Some(json!(["0"])))] {
        let mut pending = json!({"start":start,"end":end,"cursor":cursor});
        if let Some(visited) = visited {
            pending["visited"] = visited;
        }
        std::fs::write(
            f.state.join(format!("{BINDING}.refresh-cursor.json")),
            json!({"since":start+600_000,"pending":pending}).to_string(),
        )
        .unwrap();
        let id = format!("from-{cursor}");
        let mut pages = serde_json::Map::new();
        pages.insert(
            cursor.to_string(),
            f.page(vec![f.row(&id, "peer", end - 1000)], ""),
        );
        f.pages(Value::Object(pages));
        let result = f.refresh().await.unwrap();
        assert_eq!(result["imported"], 1);
        assert_eq!(result["since"], end);
        assert_eq!(
            result["status"], "syncing",
            "an older Node window does not cover today's endpoint"
        );
        let call = f
            .calls()
            .into_iter()
            .rfind(|args| args[1] == "message")
            .unwrap();
        let wall = |time| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(time)
                .unwrap()
                .checked_add_signed(chrono::Duration::hours(8))
                .unwrap()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        };
        assert_eq!(call[4], wall(start));
        assert_eq!(call[6], wall(end));
        assert_eq!(call[8], cursor);
        assert_eq!(f.cursor(), json!({"since":end}));
    }
    assert!(!f.root.join(".forbidden").exists());
    f.service.close().await;
}
