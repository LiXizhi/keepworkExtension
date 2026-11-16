//! Optional names must never gate local inbox reads or multiply CLI processes.
//! Every subprocess here is a temporary fake CLI; no DingTalk account is used.
#![cfg(unix)]

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

static CLI_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONA: &str = "default-persona";
const BINDING: &str = "metadata-fixture";
const BASE_TIME: i64 = 1_794_448_800_000;

const FAKE_DWS: &str = r#"#!/usr/bin/env python3
import fcntl, json, os, pathlib, sys, time
root = pathlib.Path.cwd()
args = sys.argv[1:]
def arg(flag):
    return args[args.index(flag)+1] if flag in args else ''
if args[:2] == ['event', 'status']:
    external = (root / '.external-pid').read_text().strip() if (root / '.external-pid').exists() else ''
    consumers = [{'pid': int(external), 'subscribe_id': 'external-fixture'}] if external else []
    print(json.dumps({'identity': {'corp_id': 'corp', 'user_id': 'user'}, 'bus': {'live': {'consumers': consumers}}}))
    raise SystemExit(0)
if args[:2] == ['chat', '+conversation-info']:
    target = arg('--group') or arg('--open-dingtalk-id')
    key = 'group:' + target
    result = {'conversationInfo': {'openConversationId': target, 'title': 'Resolved ' + target, 'singleChat': False}}
elif args[:2] == ['chat', '+chat-members-get']:
    target = arg('--users')
    key = 'sender:' + arg('--id') + ':' + target
    result = {'members': [{'openDingtalkId': target, 'memberEmpName': 'Resolved ' + target}]}
else:
    with open(root / '.forbidden-cli', 'a') as out:
        out.write(' '.join(args[:2]) + '\n')
    print(json.dumps({'error': {'code': 'unexpected_fixture_command'}}))
    raise SystemExit(2)
pid = os.getpid()
def update(start):
    with open(root / '.counter.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / '.counter.json'
        value = json.loads(path.read_text()) if path.exists() else {'active': [], 'peak': 0, 'calls': {}}
        if start:
            value['active'].append(pid)
            value['peak'] = max(value['peak'], len(value['active']))
            value['calls'][key] = value['calls'].get(key, 0) + 1
        else:
            value['active'] = [p for p in value['active'] if p != pid]
        # Readers do not take the writer lock; publish a complete snapshot.
        temporary = path.with_name('.counter.' + str(pid) + '.tmp')
        temporary.write_text(json.dumps(value))
        os.replace(temporary, path)
        with open(root / '.started-pids', 'a') as out:
            if start: out.write(str(pid) + '\n')
update(True)
try:
    deadline = time.monotonic() + 8
    while not (root / '.release-metadata').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    if not (root / '.release-metadata').exists() or (root / '.fail-metadata').exists():
        print(json.dumps({'error': {'code': 'fixture_metadata_unavailable'}}))
        code = 2
    else:
        print(json.dumps({'result': result}))
        code = 0
finally:
    update(False)
raise SystemExit(code)
"#;

struct Fixture {
    home: PathBuf,
    root: PathBuf,
    service: Arc<MessagingService>,
    previous_cli: Option<OsString>,
    cleanly_closed: bool,
}

impl Fixture {
    fn new(conversations: usize, messages_per_conversation: usize) -> Self {
        let home = std::env::temp_dir().join(format!("kp-metadata-{}", uuid::Uuid::new_v4()));
        let root = home.join("brain");
        let state = home.join("messaging");
        let rules = root.join(".github/skills/message-autoreply");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(
            rules.join("config.json"),
            json!({"version":1,"keywords":[],"groups":[],"knowledge":[],"executor":"auto","model":""}).to_string(),
        ).unwrap();
        std::fs::write(rules.join("SKILL.md"), "Read-only performance fixture.").unwrap();
        std::fs::write(
            state.join("bindings.json"),
            json!([{"id":BINDING,"channel":"dingtalk","root":root,"profile":"corp:user","enabled":false,"agentOwner":OWNER,"agentId":PERSONA}]).to_string(),
        ).unwrap();
        let messages: Vec<_> = (0..conversations)
            .flat_map(|group| (0..messages_per_conversation).map(move |index| json!({
                "id":format!("message-{group}-{index}"),"conversation":format!("group-{group}"),
                "sender":format!("peer-{group}"),"text":format!("message-{group}-{index}:{}","完整原文😀".repeat(1000)),
                "time":BASE_TIME+(group*messages_per_conversation+index) as i64,"kind":"group","direction":"in"
            })))
            .collect();
        std::fs::write(
            state.join("inbox.json"),
            json!({BINDING:{"messages":messages,"paused":[],"read":{}}}).to_string(),
        )
        .unwrap();
        let program = home.join("fake-dws");
        std::fs::write(&program, FAKE_DWS).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let previous_cli = std::env::var_os("KEEPWORK_DWS_PATH");
        std::env::set_var("KEEPWORK_DWS_PATH", &program);
        let service = MessagingService::open(
            state,
            PersonaStore::open(home.join("personas")),
            Arc::new(PresenceState::new()),
        );
        Self {
            home,
            root,
            service,
            previous_cli,
            cleanly_closed: false,
        }
    }

    fn release(&self) {
        std::fs::write(self.root.join(".release-metadata"), "release").unwrap();
    }

    fn counters(&self) -> Value {
        match std::fs::read(self.root.join(".counter.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .expect("metadata fixture counter must be a complete JSON snapshot"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                json!({"active":[],"peak":0,"calls":{}})
            }
            Err(error) => panic!("could not read metadata fixture counter: {error}"),
        }
    }

    fn total_calls(&self) -> usize {
        self.counters()["calls"]
            .as_object()
            .unwrap()
            .values()
            .map(|count| count.as_u64().unwrap() as usize)
            .sum()
    }

    async fn wait_calls(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.total_calls() < expected {
            assert!(
                Instant::now() < deadline,
                "only {} metadata queries started; expected {expected}",
                self.total_calls()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn cached(&self, conversation: &str) -> Value {
        self.service
            .inbox_view(OWNER, PERSONA, BINDING, conversation, i64::MAX)
            .await
            .unwrap()
    }

    async fn fast_named(&self, conversation: &str) -> Value {
        // This is a blocked dependency test, not a machine throughput benchmark:
        // the fake metadata cannot complete until the test releases its gate.
        tokio::time::timeout(
            Duration::from_millis(500),
            self.service
                .named_inbox_view(OWNER, PERSONA, BINDING, conversation, i64::MAX),
        )
        .await
        .expect("local history must not wait for blocked optional names")
        .unwrap()
    }

    async fn close(&mut self) {
        self.service.close().await;
        self.release();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let active = self.counters()["active"].as_array().unwrap().len();
            if active == 0 {
                break;
            }
            assert!(Instant::now() < deadline, "fixture CLI failed to finish");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Let any just-finished CLI pipeline observe closed=true before restoring
        // the environment. Queued workers must never resolve a real CLI.
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.cleanly_closed = true;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root.join(".release-metadata"), "release");
        if let Ok(text) = std::fs::read_to_string(self.root.join(".started-pids")) {
            for pid in text.lines().filter_map(|line| line.parse::<u32>().ok()) {
                let _ = Command::new("/bin/kill")
                    .args(["-TERM", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        if self.cleanly_closed {
            match self.previous_cli.take() {
                Some(value) => std::env::set_var("KEEPWORK_DWS_PATH", value),
                None => std::env::remove_var("KEEPWORK_DWS_PATH"),
            }
            let _ = std::fs::remove_dir_all(&self.home);
        }
        // On a failed assertion keep the fake executable/env in place until this
        // test's Tokio runtime drops all workers. Never fall through to real DWS.
    }
}

#[tokio::test]
async fn cached_views_preserve_legacy_order_full_previews_and_before_pagination() {
    let _env = CLI_ENV.lock().await;
    let mut f = Fixture::new(3, 70);
    let view = f.cached("").await;
    let rows = view["conversations"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for (group, row) in rows.iter().enumerate() {
        assert_eq!(row["id"], format!("group-{group}"));
        assert_eq!(row["unread"], 70);
        assert_eq!(row["last"]["id"], format!("message-{group}-69"));
        assert_eq!(
            row["last"]["text"],
            format!("message-{group}-69:{}", "完整原文😀".repeat(1000)),
            "only the UI may shorten previews; the API retains the full original"
        );
    }
    let first = f.cached("group-0").await;
    let older = f
        .service
        .inbox_view(
            OWNER,
            PERSONA,
            BINDING,
            "group-0",
            first["before"].as_i64().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(older["messages"].as_array().unwrap().len(), 20);
    assert_eq!(older["messages"][0]["id"], "message-0-0");
    assert_eq!(older["messages"][19]["id"], "message-0-19");
    assert!(older["before"].is_null());
    assert!(f
        .service
        .named_inbox_view("another-owner", PERSONA, BINDING, "", i64::MAX)
        .await
        .is_err());
    assert_eq!(f.total_calls(), 0, "cached and rejected reads need no CLI");
    assert_eq!(f.cached("").await, view);
    f.close().await;
}

#[tokio::test]
async fn local_history_and_parallel_reads_do_not_wait_for_optional_metadata() {
    let _env = CLI_ENV.lock().await;
    let mut f = Fixture::new(1, 70);
    let before = f.cached("").await;
    let list = f.fast_named("").await;
    assert_eq!(
        list, before,
        "the first response retains the complete legacy view"
    );
    assert_eq!(list["conversations"][0]["unread"], 70);
    f.wait_calls(2).await;
    let expected = f.cached("group-0").await;
    let mut reads = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let service = Arc::clone(&f.service);
        reads.spawn(async move {
            tokio::time::timeout(
                Duration::from_millis(500),
                service.named_inbox_view(OWNER, PERSONA, BINDING, "group-0", i64::MAX),
            )
            .await
            .unwrap()
            .unwrap()
        });
    }
    while let Some(result) = reads.join_next().await {
        assert_eq!(result.unwrap(), expected);
    }
    assert_eq!(expected["messages"].as_array().unwrap().len(), 50);
    assert_eq!(expected["messages"][0]["id"], "message-0-20");
    assert_eq!(expected["messages"][49]["id"], "message-0-69");
    assert_eq!(expected["before"], BASE_TIME + 20);
    assert!(expected["messages"][0]["text"]
        .as_str()
        .unwrap()
        .contains("完整原文😀"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        f.total_calls(),
        2,
        "all simultaneous readers must share their target lookups"
    );
    assert_eq!(
        f.cached("").await["conversations"][0]["unread"],
        70,
        "metadata cannot mark history read"
    );
    f.release();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let view = f.cached("group-0").await;
        if view["name"] == "Resolved group-0"
            && view["messages"][0]["senderName"] == "Resolved peer-0"
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "released background names never reached the cache"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(f.fast_named("").await["conversations"][0]["unread"], 70);
    assert_eq!(
        f.total_calls(),
        2,
        "fresh cached names need no repeated subprocess"
    );
    assert!(!f.root.join(".forbidden-cli").exists());
    f.close().await;
}

#[tokio::test]
async fn metadata_concurrency_is_bounded_across_views_and_each_target_runs_once() {
    let _env = CLI_ENV.lock().await;
    let mut f = Fixture::new(12, 1);
    let view = f.fast_named("").await;
    assert_eq!(view["conversations"].as_array().unwrap().len(), 12);
    f.wait_calls(4).await;
    for _ in 0..8 {
        assert_eq!(
            f.fast_named("").await["conversations"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        f.total_calls(),
        4,
        "only four gated metadata CLI calls may run globally"
    );
    assert_eq!(f.counters()["peak"], 4);
    f.release();
    f.wait_calls(24).await;
    let deadline = Instant::now() + Duration::from_secs(3);
    while !f.counters()["active"].as_array().unwrap().is_empty() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(f.total_calls(), 24);
    assert!(f.counters()["calls"]
        .as_object()
        .unwrap()
        .values()
        .all(|count| count == 1));
    assert!(f.counters()["peak"].as_u64().unwrap() <= 4);
    assert_eq!(
        f.cached("").await["conversations"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    f.close().await;
}

#[tokio::test]
async fn failed_optional_names_are_cached_without_hiding_messages_or_retry_storms() {
    let _env = CLI_ENV.lock().await;
    let mut f = Fixture::new(1, 3);
    std::fs::write(f.root.join(".fail-metadata"), "fixture").unwrap();
    f.release();
    let expected = f.cached("group-0").await;
    assert_eq!(f.fast_named("group-0").await, expected);
    f.wait_calls(2).await;
    // This yields to the workers after both subprocesses have returned failure.
    tokio::time::sleep(Duration::from_millis(150)).await;
    for _ in 0..10 {
        assert_eq!(f.fast_named("group-0").await, expected);
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        f.total_calls(),
        2,
        "empty-name failures must use the negative cache"
    );
    assert_eq!(f.cached("").await["conversations"][0]["unread"], 3);
    assert!(!f.root.join(".forbidden-cli").exists());
    f.close().await;
}

#[tokio::test]
async fn closing_stops_queued_metadata_without_touching_external_consumers_or_history() {
    let _env = CLI_ENV.lock().await;
    let mut f = Fixture::new(12, 1);
    let mut external = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    std::fs::write(f.root.join(".external-pid"), external.id().to_string()).unwrap();
    let before = f.cached("").await;
    assert_eq!(f.fast_named("").await, before);
    f.wait_calls(4).await;
    f.service.close().await;
    f.release();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        f.total_calls(),
        4,
        "closed services cannot start queued name reads"
    );
    assert_eq!(f.cached("").await, before);
    assert!(
        external.try_wait().unwrap().is_none(),
        "optional metadata cannot stop an external consumer"
    );
    assert_eq!(f.service.view(BINDING).unwrap()["autoReply"], false);
    assert!(!f.root.join(".forbidden-cli").exists());
    external.kill().unwrap();
    external.wait().unwrap();
    f.close().await;
}
