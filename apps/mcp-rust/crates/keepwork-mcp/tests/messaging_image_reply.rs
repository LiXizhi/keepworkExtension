//! Image transport contracts against a temporary CLI, never a DingTalk account.
#![cfg(unix)]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use keepwork_mcp::messaging::MessagingService;
use keepwork_mcp::personas::PersonaStore;
use keepwork_mcp::presence::PresenceState;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

static CLI_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_OWNER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PERSONA: &str = "default-persona";
const BINDING: &str = "image-fixture-dingtalk";
const FEISHU: &str = "image-fixture-feishu";
const DIRECT: &str = "cid+direct/fixture==";
const GROUP: &str = "cid+group/fixture==";
const PEER: &str = "fixture-open-dingtalk-id";
const PROFILE: &str = "fixture-corp:fixture-user";
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMGQAAAAASUVORK5CYII=";

const FAKE_DWS: &str = r#"#!/usr/bin/env python3
import json, os, pathlib, shutil, stat, sys, time
root = pathlib.Path.cwd()
args = sys.argv[1:]
def arg(flag):
    return args[args.index(flag)+1] if flag in args else None
if args[:3] == ['chat', 'message', 'query-send-status']:
    with open(root / '.fixture-task-calls', 'a') as log: log.write(json.dumps(args) + '\n')
    result = root / '.fixture-task-result'
    print(result.read_text() if result.exists() else '{}')
    raise SystemExit(0)
if args[:2] == ['event', 'status'] and (root / '.fixture-history').exists():
    print(json.dumps({'identity': {'corp_id': 'fixture-corp', 'user_id': 'fixture-user', 'open_dingtalk_id': 'fixture-self'}}))
    raise SystemExit(0)
if args[:3] == ['chat', 'message', 'list-all'] and (root / '.fixture-history').exists():
    print((root / '.fixture-history').read_text())
    raise SystemExit(0)
if args[:2] != ['chat', '+messages-send']:
    with open(root / '.fixture-other-cli', 'a') as log:
        log.write(json.dumps(args) + '\n')
    print(json.dumps({'error': {'code': 'fixture_metadata_unavailable'}}))
    raise SystemExit(2)
calls = root / '.fixture-calls'
count = len(calls.read_text().splitlines()) if calls.exists() else 0
record = {'args': args, 'cwd': str(root), 'file': arg('--file')}
if record['file'] is not None:
    path = root / record['file']
    record['fileMode'] = stat.S_IMODE(path.stat().st_mode)
    record['directoryMode'] = stat.S_IMODE(path.parent.stat().st_mode)
    shutil.copyfile(path, root / ('.fixture-captured-' + str(count)))
with open(calls, 'a') as log:
    log.write(json.dumps(record) + '\n')
mode = (root / '.fixture-outcome').read_text().strip() if (root / '.fixture-outcome').exists() else 'sent'
if mode == 'hold':
    deadline = time.monotonic() + 8
    while not (root / '.fixture-release').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    if not (root / '.fixture-release').exists():
        raise SystemExit(3)
if mode == 'rejected':
    print(json.dumps({'error': {'code': 'unauthorized'}}))
    raise SystemExit(2)
if mode == 'invalid-json':
    print('not-json: remote result cannot be confirmed')
elif mode == 'empty':
    print('{}')
elif mode == 'upload-only':
    print(json.dumps({'result': {'dentryId': 'fixture-upload'}}))
elif mode == 'empty-id':
    print(json.dumps({'result': {'openTaskId': '  '}}))
elif mode == 'nested':
    print(json.dumps({'data': {'result': {'openMessageId': 'fixture-message'}}}))
elif mode == 'message-id':
    print(json.dumps({'messageId': 'fixture-message'}))
else:
    print(json.dumps({'result': {'openTaskId': 'fixture-task'}}))
"#;

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    service: Arc<MessagingService>,
    previous_cli: Option<OsString>,
    previous_lark: Option<OsString>,
    cleanly_closed: Cell<bool>,
}

impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("kp-image-reply-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        let state = home.join("messaging-v1");
        let rules = root.join(".github/skills/message-autoreply");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(
            rules.join("SKILL.md"),
            "Isolated image fixture; no real account.",
        )
        .unwrap();
        std::fs::write(rules.join("config.json"), json!({"version":1,"keywords":[],"groups":[],"knowledge":[],"executor":"auto","model":""}).to_string()).unwrap();
        std::fs::write(state.join("bindings.json"), json!([
            {"id":BINDING,"channel":"dingtalk","root":root,"profile":PROFILE,"enabled":false,"agentOwner":OWNER,"agentId":PERSONA},
            {"id":FEISHU,"channel":"feishu","root":root,"profile":"fixture-feishu","enabled":false,"agentOwner":OWNER,"agentId":PERSONA}
        ]).to_string()).unwrap();
        let messages = json!([
            {"id":"incoming-direct","conversation":DIRECT,"sender":PEER,"text":"Legacy received text 😀","time":1794448800000_i64,"kind":"direct","direction":"in"},
            {"id":"incoming-group","conversation":GROUP,"sender":"group-peer","text":"Group text","time":1794448800001_i64,"kind":"group","direction":"in"}
        ]);
        std::fs::write(
            state.join("inbox.json"),
            json!({
                BINDING:{"messages":messages,"paused":[],"read":{}},
                FEISHU:{"messages":messages,"paused":[],"read":{}}
            })
            .to_string(),
        )
        .unwrap();
        let program = home.join("fake-dws");
        std::fs::write(&program, FAKE_DWS).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let previous_cli = std::env::var_os("KEEPWORK_DWS_PATH");
        let previous_lark = std::env::var_os("KEEPWORK_LARK_PATH");
        std::env::set_var("KEEPWORK_DWS_PATH", &program);
        std::env::set_var("KEEPWORK_LARK_PATH", &program);
        let service = Self::open(&home);
        Self {
            home,
            root,
            service,
            previous_cli,
            previous_lark,
            cleanly_closed: Cell::new(false),
        }
    }

    fn open(home: &Path) -> Arc<MessagingService> {
        MessagingService::open(
            home.join("messaging-v1"),
            PersonaStore::open(home.join("personas-v1")),
            Arc::new(PresenceState::new()),
        )
    }

    fn image(&self) -> Value {
        json!({"name":"设计稿.original-extension","mimeType":"image/png","base64":PNG})
    }

    fn mode(&self, mode: &str) {
        std::fs::write(self.root.join(".fixture-outcome"), mode).unwrap();
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join(".fixture-calls"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ledger(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.home.join("messaging-v1/inbox.json")).unwrap())
            .unwrap()
    }

    fn assert_clean(&self) {
        assert!(
            std::fs::read_dir(&self.root).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".keepwork-reply-")),
            "staged attachment directory survived send/rejection/replay"
        );
        let store = std::fs::read_to_string(self.home.join("messaging-v1/inbox.json")).unwrap();
        assert!(!store.contains(PNG), "encoded image persisted in inbox");
        assert!(
            !store.contains("\"base64\""),
            "image bytes are not inbox metadata"
        );
        assert!(
            !store.contains(".keepwork-reply-"),
            "temporary path leaked into inbox metadata"
        );
    }

    async fn wait_calls(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(4);
        while self.calls().len() < count {
            assert!(Instant::now() < deadline, "fake send never started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn send(&self, conversation: &str, id: &str, image: &Value) -> Value {
        self.service
            .manual_image_reply(OWNER, PERSONA, BINDING, conversation, id, image)
            .await
            .unwrap()
    }

    async fn finish(&self, service: &Arc<MessagingService>) {
        service.close().await;
        self.service.close().await;
        self.cleanly_closed.set(true);
    }

    async fn http_state(&self) -> Arc<AppState> {
        self.service.close().await;
        let state = Arc::new(AppState::new_at(
            8099,
            self.root.clone(),
            false,
            "fixture-token".into(),
            Identity::from_env(Some("standalone".into()), None),
            self.home.join("personas-v1"),
        ));
        let (status, body) = http(&state, "POST", "/agents/personas", OWNER, Some(json!({"id":PERSONA,"name":"Image fixture","root":self.root,"executor":"auto","prompt":"Offline test"}))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        state
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root.join(".fixture-release"), "release");
        // A failed test may still have background metadata work. Keep its fake
        // executable available until the test runtime drops all those futures.
        if !self.cleanly_closed.get() {
            return;
        }
        for (key, previous) in [
            ("KEEPWORK_DWS_PATH", self.previous_cli.take()),
            ("KEEPWORK_LARK_PATH", self.previous_lark.take()),
        ] {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn argument<'a>(call: &'a Value, flag: &str) -> Option<&'a str> {
    let args = call["args"].as_array().unwrap();
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .and_then(Value::as_str)
}

async fn http(
    state: &Arc<AppState>,
    method: &str,
    uri: &str,
    owner: &str,
    input: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("Origin", "http://127.0.0.1:64533")
        .header("X-Agent-Owner", owner)
        .header("Content-Type", "application/json")
        .body(
            input
                .map(|value| Body::from(value.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let response = router(Arc::clone(state)).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, body)
}

#[tokio::test]
async fn exact_send_task_id_merges_history_echo_and_preserves_image_request_across_restart() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    std::fs::write(
        f.root.join(".fixture-task-result"),
        json!({"result":{"openMessageId":"remote-image","openConversationId":GROUP}}).to_string(),
    )
    .unwrap();
    let sent = f.send(GROUP, "merge-request", &f.image()).await;
    assert_eq!(sent["remoteTaskId"], "fixture-task");
    assert_eq!(sent["remoteMessageId"], "remote-image");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    std::fs::write(f.root.join(".fixture-history"), json!({"success":true,"result":{"hasMore":false,"conversationMessagesList":[{"singleChat":false,"openConversationId":GROUP,"messages":[{"openMessageId":"remote-image","senderOpenDingTalkId":"fixture-self","content":"[文件] image.png fileId: exact-file","createTime":now-3000}]}]}}).to_string()).unwrap();
    let result = f
        .service
        .inbox_refresh(OWNER, PERSONA, BINDING)
        .await
        .unwrap();
    assert_eq!(result["imported"], 0);
    let rows = f.ledger()[BINDING]["messages"].as_array().unwrap().clone();
    assert_eq!(
        rows.iter()
            .filter(|row| row["image"].is_object() || row["id"] == "remote-image")
            .count(),
        1
    );
    assert_eq!(
        rows.iter().find(|row| row["image"].is_object()).unwrap()["id"],
        "merge-request"
    );
    let lookups = std::fs::read_to_string(f.root.join(".fixture-task-calls")).unwrap();
    let args: Vec<String> = serde_json::from_str(lookups.lines().next().unwrap()).unwrap();
    assert_eq!(args[4], "fixture-task");
    assert!(args.windows(2).any(|pair| pair == ["--profile", PROFILE]));
    f.service.close().await;
    let reopened = Fixture::open(&f.home);
    let replay = reopened
        .manual_image_reply(OWNER, PERSONA, BINDING, GROUP, "merge-request", &f.image())
        .await
        .unwrap();
    assert_eq!(replay["remoteMessageId"], "remote-image");
    assert_eq!(replay["image"], sent["image"]);
    assert_eq!(f.calls().len(), 1);
    f.finish(&reopened).await;
}

#[tokio::test]
async fn late_task_metadata_removes_an_existing_synced_echo_without_merging_other_images() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let sent = f.send(GROUP, "late-request", &f.image()).await;
    assert_eq!(sent["state"], "sent");
    assert!(sent.get("remoteMessageId").is_none());
    f.service.close().await;
    let mut ledger = f.ledger();
    let rows = ledger[BINDING]["messages"].as_array_mut().unwrap();
    for (id, conversation, direction) in [
        ("remote-image", GROUP, "out"),
        ("remote-image", DIRECT, "out"),
        ("different-image", GROUP, "out"),
        ("remote-image", GROUP, "in"),
    ] {
        rows.push(json!({"id":id,"conversation":conversation,"direction":direction,"sender":"fixture-self","kind":"group","text":"[文件] image.png fileId: fixture-file","time":1794448800002_i64,"state":"synced"}));
    }
    std::fs::write(f.home.join("messaging-v1/inbox.json"), ledger.to_string()).unwrap();
    std::fs::write(
        f.root.join(".fixture-task-result"),
        json!({"result":{"openMessageId":"remote-image","openConversationId":GROUP}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        f.root.join(".fixture-history"),
        json!({"success":true,"result":{"hasMore":false,"conversationMessagesList":[]}})
            .to_string(),
    )
    .unwrap();
    let reopened = Fixture::open(&f.home);
    reopened
        .inbox_refresh(OWNER, PERSONA, BINDING)
        .await
        .unwrap();
    let rows = f.ledger()[BINDING]["messages"].as_array().unwrap().clone();
    assert!(!rows.iter().any(|row| row["id"] == "remote-image"
        && row["conversation"] == GROUP
        && row["direction"] == "out"));
    assert_eq!(
        rows.iter()
            .filter(|row| row["id"] == "remote-image")
            .count(),
        2
    );
    assert!(rows.iter().any(|row| row["id"] == "different-image"));
    assert_eq!(
        rows.iter().find(|row| row["id"] == "late-request").unwrap()["remoteMessageId"],
        "remote-image"
    );
    assert_eq!(f.calls().len(), 1);
    f.finish(&reopened).await;
}

#[tokio::test]
async fn legacy_direct_sender_key_retains_the_exact_tasks_actual_remote_conversation() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.close().await;
    let mut ledger = f.ledger();
    ledger[BINDING]["messages"].as_array_mut().unwrap().push(json!({"id":"legacy-incoming","conversation":PEER,"sender":PEER,"direction":"in","kind":"direct","text":"legacy direct","time":1794448800000_i64}));
    std::fs::write(f.home.join("messaging-v1/inbox.json"), ledger.to_string()).unwrap();
    std::fs::write(
        f.root.join(".fixture-task-result"),
        json!({"result":{"openMessageId":"legacy-remote-image","openConversationId":DIRECT}})
            .to_string(),
    )
    .unwrap();
    let reopened = Fixture::open(&f.home);
    let sent = reopened
        .manual_image_reply(OWNER, PERSONA, BINDING, PEER, "legacy-direct", &f.image())
        .await
        .unwrap();
    assert_eq!(sent["conversation"], PEER);
    assert_eq!(sent["remoteConversationId"], DIRECT);
    assert_eq!(sent["remoteMessageId"], "legacy-remote-image");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    std::fs::write(f.root.join(".fixture-history"),json!({"success":true,"result":{"hasMore":false,"conversationMessagesList":[{"singleChat":true,"openConversationId":DIRECT,"messages":[{"openMessageId":"legacy-remote-image","senderOpenDingTalkId":"fixture-self","content":"[文件] image.png fileId: same-file","createTime":now-3000}]}]}}).to_string()).unwrap();
    assert_eq!(
        reopened
            .inbox_refresh(OWNER, PERSONA, BINDING)
            .await
            .unwrap()["imported"],
        0
    );
    assert_eq!(f.calls().len(), 1);
    f.finish(&reopened).await;
}

#[tokio::test]
async fn file_transport_preserves_bytes_and_binding_targets_without_client_paths() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let png = STANDARD.decode(PNG).unwrap();
    let samples = [
        ("image/png", "png", png.clone(), DIRECT),
        (
            "image/jpeg",
            "jpg",
            b"\xff\xd8\xff\xe0fixture\xff\xd9".to_vec(),
            GROUP,
        ),
        (
            "image/gif",
            "gif",
            STANDARD
                .decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
                .unwrap(),
            DIRECT,
        ),
        (
            "image/webp",
            "webp",
            STANDARD
                .decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
                .unwrap(),
            GROUP,
        ),
    ];
    for (index, (mime, extension, bytes, conversation)) in samples.iter().enumerate() {
        let id = format!("image-{index}");
        let image = json!({"name":"设计稿.not-the-mime-extension","mimeType":mime,"base64":STANDARD.encode(bytes)});
        let result = f.send(conversation, &id, &image).await;
        assert_eq!(result["state"], "sent");
        assert_eq!(result["conversation"], *conversation);
        assert_eq!(
            result["image"],
            json!({"name":image["name"],"mimeType":mime,"size":bytes.len(),"sha256":format!("{:x}", Sha256::digest(bytes)),"transport":"file"})
        );
        let calls = f.calls();
        let call = &calls[index];
        assert_eq!(call["cwd"], f.root.to_string_lossy().as_ref());
        assert_eq!(
            &call["args"].as_array().unwrap()[..2],
            &[json!("chat"), json!("+messages-send")]
        );
        assert_eq!(argument(call, "--as"), Some("user"));
        assert_eq!(argument(call, "--msg-type"), Some("file"));
        assert_eq!(argument(call, "--profile"), Some(PROFILE));
        assert_eq!(
            argument(call, "--idempotency-key"),
            Some(format!("{id}-image").as_str())
        );
        assert_eq!(argument(call, "-f"), Some("json"));
        assert!(call["args"].as_array().unwrap().contains(&json!("--yes")));
        let relative = argument(call, "--file").unwrap();
        let path = Path::new(relative);
        assert!(!path.is_absolute());
        assert!(path
            .components()
            .all(|component| matches!(component, Component::Normal(_))));
        assert!(relative.starts_with(".keepwork-reply-"));
        assert!(relative.ends_with(&format!("/image.{extension}")));
        assert_eq!(call["fileMode"], 0o600);
        assert_eq!(call["directoryMode"], 0o700);
        if *conversation == DIRECT {
            assert_eq!(argument(call, "--open-dingtalk-id"), Some(PEER));
            assert_eq!(argument(call, "--group"), None);
        } else {
            assert_eq!(argument(call, "--group"), Some(GROUP));
            assert_eq!(argument(call, "--open-dingtalk-id"), None);
        }
        assert_eq!(
            std::fs::read(f.root.join(format!(".fixture-captured-{index}"))).unwrap(),
            *bytes
        );
        assert!(!f.root.join(relative).exists());
        f.assert_clean();
    }
    assert_eq!(f.calls().len(), samples.len());
    f.finish(&f.service).await;
}

#[tokio::test]
async fn replay_conflicts_restart_and_cleared_history_never_repeat_the_mutation() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let image = f.image();
    let sent = f.send(DIRECT, "persistent-id", &image).await;
    assert_eq!(f.send(DIRECT, "persistent-id", &image).await, sent);
    let mut changed = image.clone();
    let mut bytes = STANDARD.decode(PNG).unwrap();
    bytes.push(1);
    changed["base64"] = json!(STANDARD.encode(bytes));
    for (conversation, value) in [(DIRECT, &changed), (GROUP, &image)] {
        assert!(f
            .service
            .manual_image_reply(
                OWNER,
                PERSONA,
                BINDING,
                conversation,
                "persistent-id",
                value
            )
            .await
            .is_err());
    }
    f.service.close().await;
    let reopened = Fixture::open(&f.home);
    assert_eq!(
        reopened
            .manual_image_reply(OWNER, PERSONA, BINDING, DIRECT, "persistent-id", &image)
            .await
            .unwrap(),
        sent
    );
    reopened
        .inbox_action(OWNER, PERSONA, BINDING, DIRECT, "clear")
        .unwrap();
    assert!(reopened
        .manual_image_reply(OWNER, PERSONA, BINDING, DIRECT, "persistent-id", &image)
        .await
        .is_err());
    assert_eq!(f.calls().len(), 1);
    f.assert_clean();
    f.finish(&reopened).await;
}

#[tokio::test]
async fn concurrent_replay_observes_durable_unknown_ledger_before_cli_finishes() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.mode("hold");
    let service = Arc::clone(&f.service);
    let image = f.image();
    let pending_image = image.clone();
    let pending = tokio::spawn(async move {
        service
            .manual_image_reply(
                OWNER,
                PERSONA,
                BINDING,
                DIRECT,
                "pending-image",
                &pending_image,
            )
            .await
    });
    f.wait_calls(1).await;
    let ledger = f.ledger();
    assert_eq!(ledger[BINDING]["sends"]["pending-image"], "unknown");
    assert!(ledger[BINDING]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "pending-image" && row["state"] == "sending"));
    let replay = f.send(DIRECT, "pending-image", &image).await;
    assert_eq!(replay["state"], "unknown");
    assert_eq!(f.calls().len(), 1);
    std::fs::write(f.root.join(".fixture-release"), "release").unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["state"], "sent");
    assert_eq!(f.calls().len(), 1);
    f.assert_clean();
    f.finish(&f.service).await;
}

#[tokio::test]
async fn invalid_images_ownership_and_unsupported_channel_never_spawn_any_cli() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let valid = f.image();
    let mut invalid = vec![Value::Null, json!({})];
    for name in [
        "",
        " ",
        ".",
        "..",
        "../escape.png",
        "nested/image.png",
        "nested\\image.png",
        "C:image.png",
        "bad\nname.png",
        "bad\0name.png",
    ] {
        let mut input = valid.clone();
        input["name"] = json!(name);
        invalid.push(input);
    }
    let mut input = valid.clone();
    input["name"] = json!("图".repeat(161));
    invalid.push(input);
    for mime in [
        "image/svg+xml",
        "text/html",
        "image/jpg",
        "IMAGE/PNG",
        "application/octet-stream",
    ] {
        let mut input = valid.clone();
        input["mimeType"] = json!(mime);
        invalid.push(input);
    }
    for encoded in [
        "",
        "!!!!",
        "a===",
        "aGVsbG8=",
        "data:image/png;base64,AAAA",
        "aG Vs\nbG8=",
    ] {
        let mut input = valid.clone();
        input["base64"] = json!(encoded);
        invalid.push(input);
    }
    let mut input = valid.clone();
    input["mimeType"] = json!("image/jpeg");
    invalid.push(input);
    let mut input = valid.clone();
    input["base64"] = json!(STANDARD.encode(b"\x89PNG\r\n\x1a\n"));
    invalid.push(input);
    let mut input = valid.clone();
    input["base64"] = json!(STANDARD.encode(vec![0; MAX_IMAGE + 1]));
    invalid.push(input);
    for (index, input) in invalid.iter().enumerate() {
        assert!(
            f.service
                .manual_image_reply(
                    OWNER,
                    PERSONA,
                    BINDING,
                    DIRECT,
                    &format!("invalid-{index}"),
                    input
                )
                .await
                .is_err(),
            "invalid sample {index} accepted"
        );
    }
    for (owner, persona, binding, conversation, id) in [
        (OTHER_OWNER, PERSONA, BINDING, DIRECT, "wrong-owner"),
        (OWNER, "other-persona", BINDING, DIRECT, "wrong-persona"),
        (OWNER, PERSONA, "missing-binding", DIRECT, "wrong-binding"),
        (OWNER, PERSONA, FEISHU, DIRECT, "unsupported-channel"),
        (
            OWNER,
            PERSONA,
            BINDING,
            "missing-conversation",
            "missing-conversation",
        ),
        (OWNER, PERSONA, BINDING, DIRECT, "../bad-request-id"),
        (OWNER, PERSONA, BINDING, "", "empty-conversation"),
    ] {
        assert!(
            f.service
                .manual_image_reply(owner, persona, binding, conversation, id, &valid)
                .await
                .is_err(),
            "invalid context {id} accepted"
        );
    }
    for id in [
        "".to_string(),
        "x".repeat(161),
        "space id".into(),
        "bad\nid".into(),
        "中文编号".into(),
    ] {
        assert!(
            f.service
                .manual_image_reply(OWNER, PERSONA, BINDING, DIRECT, &id, &valid)
                .await
                .is_err(),
            "invalid request id {id:?} accepted"
        );
    }
    assert!(f.calls().is_empty());
    assert!(!f.root.join(".fixture-other-cli").exists());
    assert_eq!(f.ledger()[BINDING]["messages"].as_array().unwrap().len(), 2);
    f.assert_clean();
    f.finish(&f.service).await;
}

#[tokio::test]
async fn only_confirmed_delivery_receipts_are_sent_and_all_outcomes_are_not_retried() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let image = f.image();
    for (index, (mode, expected)) in [
        ("sent", "sent"),
        ("nested", "sent"),
        ("message-id", "sent"),
        ("rejected", "failed"),
        ("invalid-json", "unknown"),
        ("empty", "unknown"),
        ("upload-only", "unknown"),
        ("empty-id", "unknown"),
    ]
    .iter()
    .enumerate()
    {
        f.mode(mode);
        let id = format!("outcome-{index}");
        let row = f.send(DIRECT, &id, &image).await;
        assert_eq!(row["state"], *expected, "mode {mode}");
        if *expected != "sent" {
            assert!(row["error"]
                .as_str()
                .unwrap()
                .contains(if *expected == "failed" {
                    "拒绝"
                } else {
                    "核实"
                }));
        }
        assert_eq!(f.send(DIRECT, &id, &image).await, row);
        assert_eq!(f.calls().len(), index + 1);
        assert_eq!(f.ledger()[BINDING]["sends"][&id], *expected);
        f.assert_clean();
    }
    f.finish(&f.service).await;
}

#[tokio::test]
async fn failure_to_persist_the_pre_send_ledger_never_invokes_the_cli() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let inbox = f.home.join("messaging-v1/inbox.json");
    std::fs::remove_file(&inbox).unwrap();
    std::fs::create_dir(&inbox).unwrap();
    let result = f
        .service
        .manual_image_reply(
            OWNER,
            PERSONA,
            BINDING,
            DIRECT,
            "ledger-failure",
            &f.image(),
        )
        .await;
    assert!(result.unwrap_err().message.contains("无法保存发送状态"));
    assert!(f.calls().is_empty());
    assert!(std::fs::read_dir(&f.root).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".keepwork-reply-")));
    std::fs::remove_dir(&inbox).unwrap();
    f.finish(&f.service).await;
}

#[tokio::test]
async fn http_capability_image_route_and_legacy_text_preserve_existing_contracts() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let state = f.http_state().await;
    let query = |binding: &str| {
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("binding", binding)
            .append_pair("conversation", DIRECT)
            .finish()
    };
    let path = format!("/agents/personas/{PERSONA}/inbox?{}", query(BINDING));
    let (status, view) = http(&state, "GET", &path, OWNER, None).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["messages"][0]["text"], "Legacy received text 😀");
    assert_eq!(view["messages"][0]["conversation"], DIRECT);
    assert_eq!(view["before"], Value::Null);
    assert_eq!(view["paused"], false);
    assert_eq!(
        view["replyImage"],
        json!({"version":1,"transport":"file","maxBytes":MAX_IMAGE,"mimeTypes":["image/png","image/jpeg","image/gif","image/webp"]})
    );
    let (_, feishu) = http(
        &state,
        "GET",
        &format!("/agents/personas/{PERSONA}/inbox?{}", query(FEISHU)),
        OWNER,
        None,
    )
    .await;
    assert!(feishu.get("replyImage").is_none());
    let image_route = format!("/agents/personas/{PERSONA}/reply-image");
    let input =
        json!({"binding":BINDING,"conversation":DIRECT,"requestId":"http-image","image":f.image()});
    let (status, rejected) = http(
        &state,
        "POST",
        &image_route,
        OTHER_OWNER,
        Some(input.clone()),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "{rejected}");
    assert!(f.calls().is_empty());
    let (status, unsupported) = http(&state, "POST", &image_route, OWNER, Some(json!({"binding":FEISHU,"conversation":DIRECT,"requestId":"http-feishu","image":f.image()}))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{unsupported}");
    assert_eq!(unsupported["code"], "UNSUPPORTED_FEATURE");
    assert!(f.calls().is_empty());
    let (status, sent) = http(&state, "POST", &image_route, OWNER, Some(input.clone())).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["state"], "sent");
    let (_, replay) = http(&state, "POST", &image_route, OWNER, Some(input)).await;
    assert_eq!(replay, sent);
    assert_eq!(f.calls().len(), 1);
    let (status, text) = http(&state, "POST", &format!("/agents/personas/{PERSONA}/reply"), OWNER, Some(json!({"binding":BINDING,"conversation":DIRECT,"requestId":"legacy-text","text":"Legacy plain text 😀"}))).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(text["state"], "sent");
    assert_eq!(text["text"], "Legacy plain text 😀");
    let calls = f.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(argument(&calls[1], "--file"), None);
    f.assert_clean();
    f.finish(&state.messaging).await;
}

#[tokio::test]
async fn http_larger_image_body_does_not_expand_legacy_route_body_limits() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    let state = f.http_state().await;
    let mut bytes = STANDARD.decode(PNG).unwrap();
    bytes.resize(MAX_IMAGE, 0);
    let image =
        json!({"name":"larger.png","mimeType":"image/png","base64":STANDARD.encode(&bytes)});
    let image_body =
        json!({"binding":BINDING,"conversation":GROUP,"requestId":"http-large","image":image});
    assert!(image_body.to_string().len() > 131_072);
    let (status, row) = http(
        &state,
        "POST",
        &format!("/agents/personas/{PERSONA}/reply-image"),
        OWNER,
        Some(image_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!(row["state"], "sent");
    assert_eq!(
        std::fs::read(f.root.join(".fixture-captured-0")).unwrap(),
        bytes
    );
    for route in [
        format!("/agents/personas/{PERSONA}/reply"),
        format!("/agents/personas/{PERSONA}/inbox"),
        "/agents/personas".into(),
    ] {
        let (status, body) = http(
            &state,
            "POST",
            &route,
            OWNER,
            Some(json!({"padding":"x".repeat(131_072)})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "route {route}: {body}");
        assert!(body.to_string().contains("Request too large"), "{body}");
    }
    let (status, body) = http(
        &state,
        "POST",
        &format!("/agents/personas/{PERSONA}/reply-image"),
        OWNER,
        Some(json!({"padding":"x".repeat(7 * 1024 * 1024 + 65_536)})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("Request too large"), "{body}");
    assert_eq!(f.calls().len(), 1);
    f.assert_clean();
    f.finish(&state.messaging).await;
}

#[tokio::test]
async fn custom_persona_can_send_to_assigned_empty_group_but_not_unassigned_history() {
    let _env = CLI_ENV.lock().await;
    let f = Fixture::new();
    f.service.close().await;
    let store = PersonaStore::open(f.home.join("personas-v1"));
    let presence = Arc::new(PresenceState::new());
    let custom = "custom-image-persona";
    let empty = "cid+assigned-empty/fixture==";
    let configured = json!({"id":custom,"name":"Image custom persona","root":f.root,
    "executor":"auto","prompt":"Isolated test","messaging":{"version":1,"enabled":true,"groups":[
        {"channel":"dingtalk","account":PROFILE,"id":empty,"name":"Assigned empty group"},
            {"channel":"dingtalk","account":"fixture-corp:other-user","id":GROUP,"name":"Wrong account"},
        {"channel":"feishu","account":PROFILE,"id":DIRECT,"name":"Wrong channel"}
    ]}});
    store.upsert(&presence, OWNER, &configured).unwrap();
    let service = MessagingService::open(
        f.home.join("messaging-v1"),
        Arc::clone(&store),
        Arc::clone(&presence),
    );
    let image = f.image();
    let row = service
        .manual_image_reply(OWNER, custom, BINDING, empty, "assigned-empty", &image)
        .await
        .unwrap();
    assert_eq!(row["state"], "sent");
    assert_eq!(row["kind"], "group");
    assert_eq!(row["sender"], "");
    let calls = f.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(argument(&calls[0], "--group"), Some(empty));
    assert_eq!(argument(&calls[0], "--open-dingtalk-id"), None);
    assert_eq!(argument(&calls[0], "--profile"), Some(PROFILE));
    for (owner, persona, conversation, id) in [
        (OWNER, custom, GROUP, "unassigned-history"),
        (OWNER, custom, DIRECT, "wrong-channel"),
        (OTHER_OWNER, custom, empty, "wrong-owner"),
        (OWNER, PERSONA, empty, "default-has-no-incoming"),
    ] {
        assert!(
            service
                .manual_image_reply(owner, persona, BINDING, conversation, id, &image)
                .await
                .is_err(),
            "{id} must not send"
        );
    }
    let other_root = f.home.join("another-brain");
    std::fs::create_dir(&other_root).unwrap();
    let mut switched = configured.clone();
    switched["root"] = json!(other_root);
    store.upsert(&presence, OWNER, &switched).unwrap();
    assert!(service
        .manual_image_reply(OWNER, custom, BINDING, empty, "wrong-brain", &image)
        .await
        .is_err());
    let mut removed = configured;
    removed["messaging"]["groups"] = json!([]);
    removed["messaging"]["enabled"] = json!(false);
    store.upsert(&presence, OWNER, &removed).unwrap();
    assert!(service
        .manual_image_reply(OWNER, custom, BINDING, empty, "group-removed", &image)
        .await
        .is_err());
    assert_eq!(
        f.calls().len(),
        1,
        "denied groups/owners/roots must not invoke the CLI"
    );
    f.assert_clean();
    f.finish(&service).await;
}
