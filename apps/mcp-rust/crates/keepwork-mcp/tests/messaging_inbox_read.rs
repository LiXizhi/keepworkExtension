//! Explicit remote read contracts use a temporary fake DWS, never an account.
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
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PERSONA: &str = "default-persona";
const CUSTOM: &str = "read-custom";
const BINDING: &str = "read-fixture";
const FEISHU: &str = "read-fixture-feishu";
const PROFILE: &str = "fixture-corp:fixture-user";
const GROUP: &str = "cid+group/fixture==";
const DIRECT: &str = "cid+direct/fixture==";
const PEER: &str = "fixture-open-peer";

const FAKE_DWS: &str = r#"#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path.cwd()
args = sys.argv[1:]
with open(root / '.calls', 'a') as out: out.write(json.dumps(args) + '\n')
command = 'status' if args[:2] == ['event','status'] else args[1] if len(args)>1 else ''
hold = root/'.hold-command'
if hold.exists() and hold.read_text() == command:
    (root/'.started').write_text(command)
    deadline = time.monotonic()+8
    while not (root/'.release').exists() and time.monotonic()<deadline: time.sleep(.01)
    if not (root/'.release').exists(): raise SystemExit(3)
if command == 'status':
    print(json.dumps({'identity':{'corp_id':'fixture-corp','user_id':'wrong-user' if (root/'.bad-identity').exists() else 'fixture-user','open_dingtalk_id':'fixture-self'}}))
elif command == '+conversation-info':
    remote = 'wrong-conversation' if (root/'.bad-direct').exists() else 'cid+direct/fixture=='
    print(json.dumps({'result':{'conversationInfo':{'singleChat':True,'openConversationId':remote}}}))
elif command == 'clear-red-point':
    mode = (root/'.mode').read_text() if (root/'.mode').exists() else 'success'
    if mode == 'rejected':
        print(json.dumps({'error':{'code':'fixture-rejection'}})); raise SystemExit(2)
    if mode == 'invalid-json': print('not-json')
    elif mode == 'empty': print('{}')
    elif mode == 'false': print(json.dumps({'success':False}))
    elif mode == 'partial': print(json.dumps({'success':True,'partial':True}))
    elif mode == 'nested-failure': print(json.dumps({'success':True,'result':{'failedCount':1}}))
    else: print(json.dumps({'result':{'success':True}}))
elif args[:3] == ['chat','message','list-all']:
    print((root/'.history.json').read_text())
else:
    (root/'.forbidden').write_text(json.dumps(args))
    print(json.dumps({'error':{'code':'fixture-forbidden'}})); raise SystemExit(2)
"#;

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    state: PathBuf,
    service: Arc<MessagingService>,
    store: Arc<PersonaStore>,
    presence: Arc<PresenceState>,
    previous_cli: Option<OsString>,
}

impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("kp-inbox-read-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        let state = home.join("messaging-v1");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        std::fs::write(
            state.join("bindings.json"),
            json!([
                {"id":BINDING,"channel":"dingtalk","root":root,"profile":PROFILE,"enabled":false,"agentOwner":OWNER,"agentId":PERSONA},
                {"id":FEISHU,"channel":"feishu","root":root,"profile":"fixture-feishu","enabled":false,"agentOwner":OWNER,"agentId":PERSONA}
            ]).to_string(),
        ).unwrap();
        let rows = json!([
            {"id":"group-in","conversation":GROUP,"sender":PEER,"text":"Group incoming","time":now-1000,"kind":"group","direction":"in"},
            {"id":"stored-future","conversation":GROUP,"sender":PEER,"text":"Future incoming","time":now+86_400_000,"kind":"group","direction":"in"},
            {"id":"direct-in","conversation":DIRECT,"sender":PEER,"text":"Direct incoming","time":now-1000,"kind":"direct","direction":"in"},
            {"id":"alias-in","conversation":PEER,"sender":PEER,"text":"Legacy direct alias","time":now-1000,"kind":"direct","direction":"in"},
            {"id":"other-in","conversation":"other-group","sender":PEER,"text":"Unrelated group","time":now-1000,"kind":"group","direction":"in"}
        ]);
        std::fs::write(
            state.join("inbox.json"),
            json!({
                BINDING:{"messages":rows,"paused":[GROUP],"read":{},"sends":{"kept":"unknown"}},
                FEISHU:{"messages":rows,"paused":[],"read":{}}
            })
            .to_string(),
        )
        .unwrap();
        let program = home.join("fake-dws");
        std::fs::write(&program, FAKE_DWS).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let previous_cli = std::env::var_os("KEEPWORK_DWS_PATH");
        std::env::set_var("KEEPWORK_DWS_PATH", program);
        let store = PersonaStore::open(home.join("personas-v1"));
        let presence = Arc::new(PresenceState::new());
        store.upsert(&presence, OWNER, &json!({"id":PERSONA,"name":"Read fixture","root":root,"prompt":"Never send","executor":"auto"})).unwrap();
        let service =
            MessagingService::open(state.clone(), Arc::clone(&store), Arc::clone(&presence));
        Self {
            home,
            root,
            state,
            service,
            store,
            presence,
            previous_cli,
        }
    }

    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.state.join("inbox.json")).unwrap()).unwrap()
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join(".calls"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn unread(&self, conversation: &str) -> Value {
        let view = self
            .service
            .inbox_view(OWNER, PERSONA, BINDING, "", i64::MAX)
            .await
            .unwrap();
        view["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == conversation)
            .unwrap()["unread"]
            .clone()
    }

    async fn read(
        &self,
        conversation: &str,
        remote: bool,
    ) -> Result<Value, keepwork_mcp::messaging::MessageError> {
        self.service
            .inbox_action_request(OWNER, PERSONA, BINDING, conversation, "read", remote)
            .await
    }

    fn custom(&self, groups: Value) {
        self.store.upsert(&self.presence, OWNER, &json!({"id":CUSTOM,"name":"Custom read fixture","root":self.root,"prompt":"Never send","executor":"auto",
            "messaging":{"version":1,"enabled":false,"groups":groups}})).unwrap();
        self.service
            .bind_agent(OWNER, CUSTOM, BINDING, true)
            .unwrap();
    }

    fn hold(&self, command: &str) {
        std::fs::write(self.root.join(".hold-command"), command).unwrap();
    }

    async fn wait_started(&self) {
        let deadline = Instant::now() + Duration::from_secs(4);
        while !self.root.join(".started").exists() {
            assert!(
                Instant::now() < deadline,
                "fake acknowledgement never started"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn release(&self) {
        std::fs::write(self.root.join(".release"), "release").unwrap();
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
async fn legacy_requests_and_cached_views_stay_local_and_only_dingtalk_advertises_support() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    assert_eq!(f.unread(GROUP).await, 2);
    f.service
        .inbox_view(OWNER, PERSONA, BINDING, GROUP, i64::MAX)
        .await
        .unwrap();
    let bindings = f.service.agent_bindings(OWNER, PERSONA);
    assert_eq!(
        bindings.iter().find(|row| row["id"] == BINDING).unwrap()["inboxReadVersion"],
        1
    );
    assert!(bindings
        .iter()
        .find(|row| row["id"] == FEISHU)
        .unwrap()
        .get("inboxReadVersion")
        .is_none());
    assert!(f.calls().is_empty());
    assert_eq!(f.read(GROUP, false).await.unwrap(), json!({"ok":true}));
    assert_eq!(f.unread(GROUP).await, 0);
    assert_eq!(
        f.service
            .inbox_action_request(OWNER, PERSONA, FEISHU, GROUP, "read", false)
            .await
            .unwrap(),
        json!({"ok":true})
    );
    assert!(f.calls().is_empty());
    f.service.close().await;
}

#[tokio::test]
async fn explicit_group_read_verifies_identity_and_only_clears_the_selected_conversation() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let before = f.saved();
    assert_eq!(
        f.read(GROUP, true).await.unwrap(),
        json!({"ok":true,"remoteSynced":true})
    );
    assert_eq!(f.unread(GROUP).await, 0);
    assert_eq!(f.unread("other-group").await, 1);
    let calls = f.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][0], "event");
    assert_eq!(calls[0][1], "status");
    assert_eq!(
        calls[1],
        json!([
            "chat",
            "clear-red-point",
            "--conversation-id",
            GROUP,
            "--profile",
            PROFILE,
            "-f",
            "json"
        ])
    );
    let after = f.saved();
    for field in ["messages", "paused", "sends"] {
        assert_eq!(before[BINDING][field], after[BINDING][field]);
    }
    assert_eq!(
        after[BINDING]["readFutureIds"][GROUP],
        json!(["stored-future"])
    );
    assert!(!f.root.join(".forbidden").exists());
    f.service.close().await;
}

#[tokio::test]
async fn direct_read_resolves_exact_conversation_and_supports_the_legacy_peer_alias() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    for conversation in [DIRECT, PEER] {
        f.read(conversation, true).await.unwrap();
        let calls = f.calls();
        let last = calls.len();
        assert_eq!(
            calls[last - 2],
            json!([
                "chat",
                "+conversation-info",
                "--open-dingtalk-id",
                PEER,
                "--profile",
                PROFILE,
                "-f",
                "json"
            ])
        );
        assert_eq!(calls[last - 1][3], DIRECT);
        assert_eq!(f.unread(conversation).await, 0);
    }
    f.service.close().await;
}

#[tokio::test]
async fn failed_unknown_partial_identity_and_target_results_preserve_local_unread() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let before = f.saved();
    for mode in [
        "rejected",
        "invalid-json",
        "empty",
        "false",
        "partial",
        "nested-failure",
    ] {
        std::fs::write(f.root.join(".mode"), mode).unwrap();
        assert!(f.read(GROUP, true).await.is_err(), "{mode}");
        assert_eq!(f.saved(), before, "{mode}");
        assert_eq!(f.unread(GROUP).await, 2);
    }
    std::fs::write(f.root.join(".bad-identity"), "bad").unwrap();
    let count = f.calls().len();
    assert!(f
        .read(GROUP, true)
        .await
        .unwrap_err()
        .message
        .contains("identity"));
    assert_eq!(f.calls().len(), count + 1);
    std::fs::remove_file(f.root.join(".bad-identity")).unwrap();
    std::fs::write(f.root.join(".bad-direct"), "bad").unwrap();
    let count = f.calls().len();
    assert!(f
        .read(DIRECT, true)
        .await
        .unwrap_err()
        .message
        .contains("单聊会话"));
    assert_eq!(f.calls().len(), count + 2);
    assert_eq!(f.saved(), before);
    f.service.close().await;
}

#[tokio::test]
async fn invalid_actions_foreign_owners_unsupported_channels_and_unassigned_groups_never_call_dws()
{
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    assert!(f
        .service
        .inbox_action_request(OTHER, PERSONA, BINDING, GROUP, "read", true)
        .await
        .is_err());
    assert!(f
        .service
        .inbox_action_request(OWNER, PERSONA, BINDING, GROUP, "pause", true)
        .await
        .is_err());
    assert!(f.read("missing", true).await.is_err());
    assert!(f.read("", true).await.is_err());
    assert!(f
        .service
        .inbox_action_request(OWNER, PERSONA, FEISHU, GROUP, "read", true)
        .await
        .is_err());
    f.custom(json!([{"channel":"dingtalk","account":PROFILE,"id":GROUP,"name":"Assigned group"}]));
    assert!(f
        .service
        .inbox_action_request(OWNER, CUSTOM, BINDING, "other-group", "read", true)
        .await
        .is_err());
    assert!(f.calls().is_empty());
    assert_eq!(f.unread(GROUP).await, 2);
    f.service.close().await;
}

#[tokio::test]
async fn removing_scope_or_closing_inflight_prevents_the_remote_write_and_local_commit() {
    let _env = CLI_ENV.lock().await;
    for close in [false, true] {
        let f = Fixture::new();
        f.custom(
            json!([{"channel":"dingtalk","account":PROFILE,"id":GROUP,"name":"Assigned group"}]),
        );
        f.hold("status");
        let service = Arc::clone(&f.service);
        let pending = tokio::spawn(async move {
            service
                .inbox_action_request(OWNER, CUSTOM, BINDING, GROUP, "read", true)
                .await
        });
        f.wait_started().await;
        if close {
            f.service.close().await;
        } else {
            f.custom(json!([]));
        }
        f.release();
        assert!(pending.await.unwrap().is_err());
        assert_eq!(f.calls().len(), 1);
        assert_eq!(f.saved()[BINDING]["read"], json!({}));
        f.service.close().await;
    }
}

#[tokio::test]
async fn late_incoming_messages_stay_unread_and_only_captured_future_ids_are_acknowledged() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.hold("clear-red-point");
    let service = Arc::clone(&f.service);
    let pending = tokio::spawn(async move {
        service
            .inbox_action_request(OWNER, PERSONA, BINDING, GROUP, "read", true)
            .await
    });
    f.wait_started().await;
    assert_eq!(f.unread(GROUP).await, 2);
    let late = chrono::Utc::now().timestamp_millis();
    // History windows use whole seconds; wait until this new message is within
    // the bounded refresh window while the read acknowledgement is still held.
    tokio::time::sleep(Duration::from_millis(1050)).await;
    std::fs::write(f.root.join(".history.json"),json!({"success":true,"result":{"hasMore":false,"conversationMessagesList":[{
        "openConversationId":GROUP,"singleChat":false,"messages":[
            {"openMessageId":"late-normal","senderOpenDingTalkId":PEER,"content":"late normal","createTime":late}
        ]}]}}).to_string()).unwrap();
    f.service
        .inbox_refresh(OWNER, PERSONA, BINDING)
        .await
        .unwrap();
    f.release();
    pending.await.unwrap().unwrap();
    assert_eq!(f.unread(GROUP).await, 1);
    assert_eq!(
        f.saved()[BINDING]["readFutureIds"][GROUP],
        json!(["stored-future"])
    );
    f.service.close().await;
}

async fn http(
    state: &Arc<AppState>,
    method: &str,
    route: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let response = router(Arc::clone(state))
        .oneshot(
            Request::builder()
                .method(method)
                .uri(route)
                .header("Origin", "https://keepwork.com")
                .header("X-Agent-Owner", OWNER)
                .header("Content-Type", "application/json")
                .body(
                    body.map(|value| Body::from(value.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn http_omitted_false_and_strict_boolean_requests_preserve_the_additive_contract() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.close().await;
    let state = Arc::new(AppState::new_at(
        8099,
        f.root.clone(),
        false,
        "fixture-token".into(),
        Identity::from_env(Some("standalone".into()), None),
        f.home.join("personas-v1"),
    ));
    let route = format!("/agents/personas/{PERSONA}/inbox");
    let (status, body) = http(&state,"POST","/agents/personas",Some(json!({"id":PERSONA,"name":"HTTP read fixture","root":f.root,"prompt":"Never send","executor":"auto"}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for value in [Value::Null, json!(1), json!("true"), json!({})] {
        let (status, body) = http(
            &state,
            "POST",
            &route,
            Some(
                json!({"binding":BINDING,"conversation":GROUP,"action":"read","syncRemote":value}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().unwrap().contains("syncRemote"));
    }
    for input in [
        json!({"binding":BINDING,"conversation":GROUP,"action":"read"}),
        json!({"binding":BINDING,"conversation":GROUP,"action":"read","syncRemote":false}),
    ] {
        let (status, body) = http(&state, "POST", &route, Some(input)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({"ok":true}));
    }
    assert!(f.calls().is_empty());
    let (status, body) = http(
        &state,
        "POST",
        &route,
        Some(json!({"binding":BINDING,"conversation":GROUP,"action":"read","syncRemote":true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"ok":true,"remoteSynced":true}));
    assert!(f.calls().iter().any(|args| args[1] == "clear-red-point"));
    state.messaging.close().await;
}
