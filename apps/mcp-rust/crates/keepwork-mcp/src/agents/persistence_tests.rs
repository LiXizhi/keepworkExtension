use super::*;
use std::time::Instant;

#[derive(Default)]
pub(super) struct PersistenceStats {
    /// Benchmark-only control reproduces the former all-history write scope.
    pub legacy_all_histories: AtomicBool,
    pub registry_writes: AtomicUsize,
    pub registry_bytes: AtomicUsize,
    pub history_writes: AtomicUsize,
    pub history_bytes: AtomicUsize,
}

impl PersistenceStats {
    fn reset(&self) {
        for counter in [
            &self.registry_writes,
            &self.registry_bytes,
            &self.history_writes,
            &self.history_bytes,
        ] {
            counter.store(0, Ordering::Relaxed);
        }
    }
    fn snapshot(&self) -> Value {
        json!({
            "registryWrites":self.registry_writes.load(Ordering::Relaxed),
            "registryBytes":self.registry_bytes.load(Ordering::Relaxed),
            "historyWrites":self.history_writes.load(Ordering::Relaxed),
            "historyBytes":self.history_bytes.load(Ordering::Relaxed),
        })
    }
}

struct Fixture {
    directory: PathBuf,
    manager: Arc<AgentManager>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn fixture(count: usize, text_size: usize) -> Fixture {
    let directory = std::env::temp_dir().join(format!("keepwork-agent-persistence-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let manager = AgentManager::open(directory.join("sessions.json"), 0);
    {
        let mut sessions = manager.sessions.lock().unwrap();
        for index in 0..count {
            let session_id = format!("session-{index}");
            let data = json!({"id":session_id,"owner":"a".repeat(64),"threadId":format!("native-{index}"),
                "turnId":"turn","backend":"workbuddy","roots":[directory],"conversationId":session_id,
                "status":"completed","cursor":0,"items":[{"id":"reply","type":"agentMessage","text":"x".repeat(text_size)}],
                "pending":[],"submissions":{},"aichatContext":false});
            let (events, _) = watch::channel(json!({"cursor":0,"session":snapshot(&data)}));
            sessions.insert(
                session_id,
                Session {
                    data,
                    harness: None,
                    native: json!({}),
                    pending: HashMap::new(),
                    events,
                    viewers: Arc::new(AtomicUsize::new(0)),
                    configuration: Arc::new(AsyncMutex::new(())),
                    context_marker: None,
                    restoring: false,
                    needs_native_history: false,
                },
            );
        }
        manager.persist(&mut sessions).unwrap();
    }
    manager.persistence_stats.reset();
    Fixture { directory, manager }
}

fn append(manager: &AgentManager, session: &str, text: &str) {
    manager
        .edit(session, |s| {
            let previous = s.data["items"][0]["text"].as_str().unwrap();
            s.data["items"][0]["text"] = json!(format!("{previous}{text}"));
            Ok(())
        })
        .unwrap();
}

fn sidecar(fixture: &Fixture, index: usize) -> PathBuf {
    fixture
        .directory
        .join("sessions.json.workbuddy")
        .join(format!("native-{index}.json"))
}

#[test]
fn streamed_chunks_only_rewrite_the_changed_history_and_keep_registry_durable() {
    let fixture = fixture(16, 4096);
    let unrelated = std::fs::read(sidecar(&fixture, 1)).unwrap();
    for _ in 0..4 {
        append(&fixture.manager, "session-0", "下一段🙂");
    }
    let stats = fixture.manager.persistence_stats.snapshot();
    assert_eq!(
        stats["registryWrites"], 4,
        "each chunk must retain the existing durable registry boundary"
    );
    assert_eq!(
        stats["historyWrites"], 4,
        "one changed transcript must not rewrite fifteen unrelated sidecars"
    );
    assert_eq!(std::fs::read(sidecar(&fixture, 1)).unwrap(), unrelated);
    let reloaded = AgentManager::open(fixture.manager.file.clone(), 0);
    let view = reloaded.view("session-0", &"a".repeat(64)).unwrap();
    assert_eq!(view["cursor"], 4);
    assert!(view["items"][0]["text"]
        .as_str()
        .unwrap()
        .ends_with(&"下一段🙂".repeat(4)));
}

#[test]
fn unrelated_unreadable_history_does_not_block_a_different_session() {
    let fixture = fixture(2, 100);
    // This unrelated sidecar was never edited. Explicit mutation scope avoids
    // reading or replacing it while preserving its exact bytes for repair.
    std::fs::write(sidecar(&fixture, 1), b"unreadable older history").unwrap();
    append(&fixture.manager, "session-0", "new text");
    assert_eq!(
        std::fs::read(sidecar(&fixture, 1)).unwrap(),
        b"unreadable older history"
    );
    assert_eq!(
        fixture.manager.persistence_stats.snapshot()["historyWrites"],
        1
    );
}

#[test]
fn registry_failure_keeps_receipt_unpublished_and_retry_writes_it_durably() {
    let fixture = fixture(3, 100);
    let registry_before = std::fs::read(&fixture.manager.file).unwrap();
    let original = fixture.manager.sessions.lock().unwrap()["session-0"]
        .data
        .clone();
    let watcher = fixture.manager.sessions.lock().unwrap()["session-0"]
        .events
        .subscribe();
    let blocker = fixture.manager.file.with_extension("json.tmp");
    std::fs::create_dir(&blocker).unwrap();
    let update = |session: &mut Session| {
        session.data["items"][0]["text"] = json!("a durable answer");
        session.data["lastRequestId"] = json!("owned-request");
        session.data["submissions"]["owned-request"] = json!({"state":"starting"});
        Ok(())
    };
    assert!(fixture.manager.edit("session-0", update).is_err());
    assert_eq!(
        fixture.manager.sessions.lock().unwrap()["session-0"].data,
        original
    );
    assert_eq!(
        std::fs::read(&fixture.manager.file).unwrap(),
        registry_before
    );
    assert!(
        !watcher.has_changed().unwrap(),
        "no successful snapshot may precede durable persistence"
    );
    std::fs::remove_dir(blocker).unwrap();
    fixture.manager.edit("session-0", update).unwrap();
    assert!(watcher.has_changed().unwrap());
    assert_eq!(
        fixture.manager.persistence_stats.snapshot()["historyWrites"],
        2,
        "failed registry commit cannot mark the sidecar clean and suppress retry"
    );
    let reloaded = AgentManager::open(fixture.manager.file.clone(), 0);
    let sessions = reloaded.sessions.lock().unwrap();
    assert_eq!(
        sessions["session-0"].data["submissions"]["owned-request"]["state"],
        "unknown"
    );
    assert_eq!(
        sessions["session-0"].data["items"][0]["text"],
        "a durable answer"
    );
    assert!(
        sessions["session-0"].harness.is_none(),
        "opening a registry never replays an uncertain native request"
    );
}

#[test]
fn sidecar_failure_preserves_registry_and_remains_retryable() {
    let fixture = fixture(2, 100);
    let registry_before = std::fs::read(&fixture.manager.file).unwrap();
    let history_before = std::fs::read(sidecar(&fixture, 0)).unwrap();
    let watcher = fixture.manager.sessions.lock().unwrap()["session-0"]
        .events
        .subscribe();
    std::fs::write(sidecar(&fixture, 0), "broken history").unwrap();
    assert!(fixture
        .manager
        .edit("session-0", |session| {
            session.data["pending"] = json!([{"id":"approval"}]);
            Ok(())
        })
        .is_err());
    assert_eq!(
        std::fs::read(&fixture.manager.file).unwrap(),
        registry_before
    );
    assert!(!watcher.has_changed().unwrap());
    std::fs::write(sidecar(&fixture, 0), history_before).unwrap();
    fixture
        .manager
        .edit("session-0", |session| {
            session.data["pending"] = json!([{"id":"approval"}]);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fixture.manager.view("session-0", &"a".repeat(64)).unwrap()["pending"][0]["id"],
        "approval"
    );
    assert_eq!(
        fixture.manager.persistence_stats.snapshot()["registryWrites"],
        1
    );
}

#[test]
fn an_uncommitted_native_history_does_not_block_other_sessions_or_lose_its_outcome() {
    let fixture = fixture(2, 100);
    let history_before = std::fs::read(sidecar(&fixture, 0)).unwrap();
    std::fs::write(sidecar(&fixture, 0), "broken history").unwrap();
    assert!(fixture
        .manager
        .edit_native("session-0", None, |s| {
            s.data["items"][0]["text"] = json!("observed native answer");
            s.data["status"] = json!("completed");
            s.data["error"] = json!("");
            Ok(())
        })
        .is_err());
    assert_eq!(
        fixture.manager.view("session-0", &"a".repeat(64)).unwrap()["status"],
        "error"
    );

    append(&fixture.manager, "session-1", "unaffected answer");
    let rows: Vec<Value> =
        serde_json::from_slice(&std::fs::read(&fixture.manager.file).unwrap()).unwrap();
    let pending = rows.iter().find(|row| row["id"] == "session-0").unwrap();
    assert_eq!(
        pending["status"], "error",
        "older readers must not see a false durable success"
    );
    assert!(pending["error"]
        .as_str()
        .unwrap()
        .contains("NATIVE_STATE_PERSIST_FAILED"));
    let metadata = &pending[NATIVE_OBSERVED_STATE];
    let digest = metadata["identity"].as_str().unwrap();
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(
        !metadata.to_string().contains(&"a".repeat(64)),
        "older readers may pass through unknown metadata; do not duplicate private owner values"
    );
    let reloaded = AgentManager::open(fixture.manager.file.clone(), 0);
    assert_eq!(
        reloaded.view("session-0", &"a".repeat(64)).unwrap()["status"],
        "error"
    );
    assert!(
        reloaded.view("session-1", &"a".repeat(64)).unwrap()["items"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with("unaffected answer")
    );

    std::fs::write(sidecar(&fixture, 0), history_before).unwrap();
    let recovered = reloaded.view("session-0", &"a".repeat(64)).unwrap();
    assert_eq!(recovered["status"], "completed");
    assert_eq!(recovered["items"][0]["text"], "observed native answer");
    assert!(recovered.get(NATIVE_PERSISTENCE_ERROR).is_none());
    assert!(recovered.get(NATIVE_OBSERVED_STATE).is_none());
    let reopened = AgentManager::open(fixture.manager.file.clone(), 0);
    assert_eq!(
        reopened.view("session-0", &"a".repeat(64)).unwrap()["status"],
        "completed"
    );
}

#[test]
fn recovery_metadata_cannot_restore_an_observation_into_a_different_request() {
    let fixture = fixture(1, 100);
    let original = fixture.manager.sessions.lock().unwrap()["session-0"]
        .data
        .clone();
    for key in [
        "id",
        "owner",
        "backend",
        "threadId",
        "conversationId",
        "turnId",
        "lastRequestId",
        "cursor",
    ] {
        let mut row = original.clone();
        row[NATIVE_OBSERVED_STATE] = json!({
            "status":"completed", "error":"",
            "identity":native_observation_identity(&row),
        });
        row[NATIVE_PERSISTENCE_ERROR] = json!(native_persistence_error("fixture fault"));
        row["status"] = json!("error");
        row["error"] = row[NATIVE_PERSISTENCE_ERROR].clone();
        row[key] = match key {
            "owner" => json!("b".repeat(64)),
            "cursor" => json!(1),
            _ => json!("different-request"),
        };
        std::fs::write(
            &fixture.manager.file,
            serde_json::to_vec(&vec![row.clone()]).unwrap(),
        )
        .unwrap();
        let reopened = AgentManager::open(fixture.manager.file.clone(), 0);
        let view = reopened
            .view(row["id"].as_str().unwrap(), row["owner"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            view["status"], "error",
            "stale {key} must not claim completion"
        );
        assert!(view["error"]
            .as_str()
            .unwrap()
            .contains("NATIVE_STATE_PERSIST_FAILED"));
        assert!(view.get(NATIVE_OBSERVED_STATE).is_none());
        assert!(view.get(NATIVE_PERSISTENCE_ERROR).is_none());
        assert!(
            reopened.sessions.lock().unwrap()[row["id"].as_str().unwrap()]
                .harness
                .is_none()
        );
    }
}

#[test]
fn missing_or_legacy_object_identity_never_restores_a_native_success() {
    let fixture = fixture(1, 100);
    let original = fixture.manager.sessions.lock().unwrap()["session-0"]
        .data
        .clone();
    for identity in [
        Value::Null,
        json!({"owner":original["owner"]}),
        json!("invalid-digest"),
    ] {
        let mut row = original.clone();
        row[NATIVE_OBSERVED_STATE] = json!({"status":"completed","error":"","identity":identity});
        row[NATIVE_PERSISTENCE_ERROR] = json!(native_persistence_error("fixture fault"));
        row["status"] = json!("error");
        row["error"] = row[NATIVE_PERSISTENCE_ERROR].clone();
        std::fs::write(
            &fixture.manager.file,
            serde_json::to_vec(&vec![row]).unwrap(),
        )
        .unwrap();
        let reopened = AgentManager::open(fixture.manager.file.clone(), 0);
        assert_eq!(
            reopened.view("session-0", &"a".repeat(64)).unwrap()["status"],
            "error"
        );
        assert!(reopened.sessions.lock().unwrap()["session-0"]
            .harness
            .is_none());
    }
}

#[test]
fn simultaneous_sessions_persist_each_chunk_without_cross_session_loss() {
    let fixture = fixture(4, 100);
    let workers: Vec<_> = (0..4)
        .map(|index| {
            let manager = fixture.manager.clone();
            std::thread::spawn(move || {
                for _ in 0..4 {
                    append(
                        &manager,
                        &format!("session-{index}"),
                        &format!(" marker-{index}"),
                    );
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let stats = fixture.manager.persistence_stats.snapshot();
    assert_eq!(stats["registryWrites"], 16);
    assert_eq!(stats["historyWrites"], 16);
    let reloaded = AgentManager::open(fixture.manager.file.clone(), 0);
    for index in 0..4 {
        let view = reloaded
            .view(&format!("session-{index}"), &"a".repeat(64))
            .unwrap();
        assert_eq!(view["cursor"], 4);
        assert!(view["items"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with(&format!(" marker-{index}").repeat(4)));
    }
}

#[test]
#[ignore = "isolated disk benchmark; run explicitly with --ignored --nocapture"]
fn persistence_disk_benchmark() {
    let mut cases = Vec::new();
    for (mode, legacy) in [("legacy-all-histories", true), ("changed-history", false)] {
        for session_count in [1, 16, 64] {
            let fixture = fixture(session_count, 8192);
            fixture
                .manager
                .persistence_stats
                .legacy_all_histories
                .store(legacy, Ordering::Relaxed);
            let chunk = "流式持久化🙂".repeat(24);
            let mut micros = Vec::new();
            for _ in 0..32 {
                let started = Instant::now();
                append(&fixture.manager, "session-0", &chunk);
                micros.push(started.elapsed().as_micros() as u64);
            }
            micros.sort_unstable();
            let disk: Vec<Value> =
                serde_json::from_slice(&std::fs::read(&fixture.manager.file).unwrap()).unwrap();
            assert_eq!(
                disk.iter().find(|row| row["id"] == "session-0").unwrap()["cursor"],
                32
            );
            let mut row = fixture.manager.persistence_stats.snapshot();
            row["sessions"] = json!(session_count);
            row["mode"] = json!(mode);
            row["chunks"] = json!(32);
            row["p50Micros"] = json!(micros[15]);
            row["p95Micros"] = json!(micros[30]);
            row["totalMicros"] = json!(micros.iter().sum::<u64>());
            cases.push(row);
        }
    }
    let build: Value = serde_json::from_str(crate::identity::BUILD_INFO).unwrap();
    let report = json!({"kind":"isolated-persistence-disk","version":env!("CARGO_PKG_VERSION"),"commit":build["commit"],"sourceHash":build["sourceHash"],"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"cases":cases});
    println!("KEEPWORK_MCP_PERSIST_BENCH {report}");
    if let Some(output) = std::env::var_os("KEEPWORK_MCP_PERSIST_BENCH_OUTPUT") {
        std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}
