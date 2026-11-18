use super::*;

const PEER: &str = r#"
const readline = require('node:readline');
const calls = [], waiting = new Map(); let sequence = 0;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line), p = m.params || {};
 if (!m.method && waiting.has(m.id)) { const caller = waiting.get(m.id); waiting.delete(m.id); return send({id:caller,result:m.result}); }
 if (['thread/start','thread/resume','turn/start'].includes(m.method)) calls.push({method:m.method,params:p});
 if (m.method === 'initialize') return send({id:m.id,result:{userAgent:'fixture'}});
 if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'approval-thread',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}}});
 if (m.method === 'thread/start' || m.method === 'thread/resume') return send({id:m.id,result:{thread:{id:p.threadId || 'approval-thread',turns:[]},sandbox:p.sandbox}});
 if (m.method === 'turn/start') return send({id:m.id,result:{turn:{id:'native-turn'}}});
 if (m.method === 'fixture/log') return send({id:m.id,result:{calls}});
 if (m.method === 'fixture/approval') { const id='request-'+ ++sequence; waiting.set(id,m.id); return send({id,method:p.method,params:{threadId:'approval-thread',...p.params}}); }
 if (m.id !== undefined) send({id:m.id,result:{}});
});
"#;

async fn attach(
    manager: &Arc<AgentManager>,
    child: &Arc<Harness>,
    root: &Path,
) -> tokio::task::JoinHandle<()> {
    attach_backend(manager, child, root, "codex").await
}

async fn attach_backend(
    manager: &Arc<AgentManager>,
    child: &Arc<Harness>,
    root: &Path,
    backend: &str,
) -> tokio::task::JoinHandle<()> {
    // The fixture cache key must match checked_roots(), including on Windows.
    assert_eq!(root, canonical_root(&root.to_string_lossy()).unwrap());
    manager
        .harnesses
        .lock()
        .await
        .insert(format!("{backend}\0{}", root.display()), child.clone());
    let mut events = child.subscribe();
    let manager = manager.clone();
    let child = child.clone();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            let exiting = matches!(event, HarnessEvent::Exit { .. });
            manager.on_event(&child, event).await;
            if exiting {
                break;
            }
        }
    })
}

fn complete(manager: &AgentManager, session: &str) {
    manager
        .edit(session, |s| {
            s.data["status"] = json!("completed");
            Ok(())
        })
        .unwrap();
}

async fn log(child: &Harness) -> Vec<Value> {
    child
        .call("fixture/log", json!({}), Duration::from_secs(3))
        .await
        .unwrap()["calls"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn codex_selection_reaches_native_creation_turn_resume_and_explicit_reset() {
    let directory = std::env::temp_dir().join(format!("kp-approval-session-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let request_root = directory.canonicalize().unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let registry = root.join("sessions.json");
    let owner = "a".repeat(64);
    let manager = AgentManager::open(registry.clone(), 0);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach(&manager, &child, &root).await;
    // Exercise Windows verbatim-path input while registering the normalized key.
    let session = manager.create(&owner, &json!({"conversationId":"approval-chat","backend":"codex","roots":[request_root],"mode":"craft","approvalMode":"on-request"})).await.unwrap();
    let session_id = session["id"].as_str().unwrap().to_string();
    assert_eq!(session["roots"], json!([root]));
    assert_eq!(session["approvalMode"], "on-request");
    let calls = log(&child).await;
    assert_eq!(calls[0]["params"]["sandbox"], "workspace-write");
    assert_eq!(calls[0]["params"]["approvalPolicy"], "on-request");

    let selected = manager
        .turn(
            &session_id,
            &owner,
            &json!({"requestId":"first","text":"inspect","approvalMode":"untrusted"}),
        )
        .await
        .unwrap();
    assert_eq!(selected["session"]["approvalMode"], "untrusted");
    complete(&manager, &session_id);
    let omitted = manager
        .turn(
            &session_id,
            &owner,
            &json!({"requestId":"second","text":"inspect again"}),
        )
        .await
        .unwrap();
    assert_eq!(omitted["session"]["approvalMode"], "untrusted");
    let calls = log(&child).await;
    for turn in calls.iter().filter(|call| call["method"] == "turn/start") {
        assert_eq!(turn["params"]["approvalPolicy"], "untrusted");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(
            turn["params"]["sandboxPolicy"]["writableRoots"],
            json!([root])
        );
        assert_eq!(turn["params"]["sandboxPolicy"]["networkAccess"], false);
    }
    complete(&manager, &session_id);
    consumer.abort();
    drop(manager);

    // Restore the on-disk record without assuming a live native thread.
    let manager = AgentManager::open(registry, 0);
    let consumer = attach(&manager, &child, &root).await;
    let restored = manager
        .turn(
            &session_id,
            &owner,
            &json!({"requestId":"third","text":"restored"}),
        )
        .await
        .unwrap();
    assert_eq!(restored["session"]["approvalMode"], "untrusted");
    let calls = log(&child).await;
    let resume = calls
        .iter()
        .find(|call| call["method"] == "thread/resume")
        .unwrap();
    assert_eq!(resume["params"]["approvalPolicy"], "untrusted");
    assert_eq!(resume["params"]["sandbox"], "workspace-write");
    complete(&manager, &session_id);
    let reset = manager
        .turn(
            &session_id,
            &owner,
            &json!({"requestId":"fourth","text":"legacy default","approvalMode":"default"}),
        )
        .await
        .unwrap();
    assert!(reset["session"].get("approvalMode").is_none());
    let calls = log(&child).await;
    assert_eq!(calls.last().unwrap()["params"]["approvalPolicy"], "never");
    assert_eq!(
        calls.last().unwrap()["params"]["sandboxPolicy"]["type"],
        "dangerFullAccess"
    );
    let count = calls.len();
    manager
        .turn(
            &session_id,
            &owner,
            &json!({"requestId":"fourth","text":"must not replay","approvalMode":"read-only"}),
        )
        .await
        .unwrap();
    assert_eq!(log(&child).await.len(), count);
    assert!(manager
        .view(&session_id, &owner)
        .unwrap()
        .get("approvalMode")
        .is_none());
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn explicit_policies_validate_before_dispatch_and_cannot_replace_an_active_turn() {
    let directory = std::env::temp_dir().join(format!("kp-approval-validation-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let manager = AgentManager::open(root.join("sessions.json"), 0);
    let owner = "a".repeat(64);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach(&manager, &child, &root).await;
    for invalid in [json!(null), json!("auto"), json!(true)] {
        assert!(manager
            .create(
                &owner,
                &json!({"conversationId":"invalid","roots":[root],"approvalMode":invalid})
            )
            .await
            .is_err());
    }
    assert!(manager.create(&owner, &json!({"backend":"claude","conversationId":"invalid","roots":[root],"approvalMode":"on-request"})).await.unwrap_err().contains("Unsupported agent approval mode"));
    assert!(log(&child).await.is_empty());
    let session = manager
        .create(
            &owner,
            &json!({"conversationId":"legacy","roots":[root],"mode":"craft"}),
        )
        .await
        .unwrap();
    let session_id = session["id"].as_str().unwrap();
    assert_eq!(
        log(&child).await[0]["params"]["sandbox"],
        "danger-full-access"
    );
    assert!(manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"invalid","text":"denied","approvalMode":"invalid"})
        )
        .await
        .is_err());
    assert_eq!(log(&child).await.len(), 1);
    assert!(manager
        .turn(
            session_id,
            &"b".repeat(64),
            &json!({"requestId":"wrong-owner","text":"denied","approvalMode":"never"})
        )
        .await
        .is_err());
    manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"active","text":"inspect","approvalMode":"read-only"}),
        )
        .await
        .unwrap();
    assert!(manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"blocked","text":"do not dispatch","approvalMode":"never"})
        )
        .await
        .unwrap_err()
        .contains("already running"));
    assert_eq!(
        manager.view(session_id, &owner).unwrap()["approvalMode"],
        "read-only"
    );
    assert_eq!(log(&child).await.len(), 2);
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn native_craft_requests_wait_for_the_user_and_readonly_denies_permissions() {
    let directory = std::env::temp_dir().join(format!("kp-approval-events-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let manager = AgentManager::open(root.join("sessions.json"), 0);
    let owner = "a".repeat(64);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach(&manager, &child, &root).await;
    let session = manager
        .create(
            &owner,
            &json!({"conversationId":"events","roots":[root],"approvalMode":"on-request"}),
        )
        .await
        .unwrap();
    let session_id = session["id"].as_str().unwrap();
    manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"first","text":"inspect"}),
        )
        .await
        .unwrap();
    let task = {
        let child = child.clone();
        tokio::spawn(async move {
            child.call("fixture/approval", json!({"method":"item/commandExecution/requestApproval","params":{"command":"fixture","availableDecisions":["accept","decline"]}}), Duration::from_secs(3)).await.unwrap()
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while manager.view(session_id, &owner).unwrap()["pending"]
            .as_array()
            .unwrap()
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let waiting = manager.view(session_id, &owner).unwrap();
    assert_eq!(waiting["status"], "waiting");
    assert_eq!(
        waiting["pending"][0]["decisionCapabilities"]["autoApproval"],
        false
    );
    manager
        .respond(
            session_id,
            &owner,
            &json!({"id":waiting["pending"][0]["id"],"decision":"decline"}),
        )
        .await
        .unwrap();
    assert_eq!(task.await.unwrap()["decision"], "decline");
    complete(&manager, session_id);
    manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"readonly","text":"inspect","approvalMode":"read-only"}),
        )
        .await
        .unwrap();
    for (method, params) in [
        (
            "item/commandExecution/requestApproval",
            json!({"command":"write something"}),
        ),
        ("item/fileChange/requestApproval", json!({"readOnly":true})),
        (
            "item/permissions/requestApproval",
            json!({"permissions":{"network":{"enabled":true}}}),
        ),
    ] {
        let result = child
            .call(
                "fixture/approval",
                json!({"method":method,"params":params}),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
        if method == "item/permissions/requestApproval" {
            assert_eq!(result, json!({"permissions":{},"scope":"turn"}));
        } else {
            assert_eq!(result["decision"], "decline");
        }
        assert!(manager.view(session_id, &owner).unwrap()["pending"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn dedicated_approval_routes_require_semantics_and_support_image_limits() {
    let directory = std::env::temp_dir().join(format!("kp-approval-routes-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let manager = AgentManager::open(root.join("sessions.json"), 0);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach(&manager, &child, &root).await;
    let mut headers = HeaderMap::new();
    headers.insert("x-agent-owner", "a".repeat(32).parse().unwrap());
    headers.insert(header::ORIGIN, "http://127.0.0.1:3000".parse().unwrap());
    headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    let owner = super::owner(&headers).unwrap();
    let post = |path: String, input: Value| {
        let manager = manager.clone();
        let headers = headers.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri(&path)
                .body(Body::from(input.to_string()))
                .unwrap();
            let response =
                super::handle_request(manager, "POST", &path, &BTreeMap::new(), &headers, request)
                    .await;
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 8_000_000)
                .await
                .unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap())
        }
    };
    let (status, error) = post(
        "/agents/approval-sessions".into(),
        json!({"conversationId":"route","roots":[root]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"], "approvalMode required");
    assert!(log(&child).await.is_empty());
    let (status, session) = post(
        "/agents/approval-sessions".into(),
        json!({"conversationId":"route","roots":[root],"approvalMode":"read-only"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = session["id"].as_str().unwrap();
    for suffix in ["approval-turns", "approval-image-turns"] {
        let (status, error) = post(
            format!("/agents/sessions/{session_id}/{suffix}"),
            json!({"requestId":"missing","text":"must not execute"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"], "approvalMode required");
    }
    assert_eq!(log(&child).await.len(), 1);
    let (status, submitted) = post(
        format!("/agents/sessions/{session_id}/approval-turns"),
        json!({"requestId":"text","text":"inspect","approvalMode":"on-request"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(submitted["session"]["approvalMode"], "on-request");
    complete(&manager, session_id);
    // The dedicated image route retains the existing larger parse allowance.
    // Its invalid image is rejected by image validation, not the 2 MB text cap.
    let (status, error) = post(format!("/agents/sessions/{session_id}/approval-image-turns"), json!({"requestId":"large-image","text":"inspect","approvalMode":"on-request","images":["x".repeat(2_100_000)]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_ne!(error["error"], "Request too large");
    assert_eq!(log(&child).await.len(), 2);
    let (status, submitted) = post(format!("/agents/sessions/{session_id}/approval-image-turns"), json!({"requestId":"image","text":"inspect","approvalMode":"read-only","images":["data:image/png;base64,AAAA"]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(submitted["session"]["approvalMode"], "read-only");
    let calls = log(&child).await;
    assert_eq!(calls.last().unwrap()["params"]["input"][1]["type"], "image");
    assert_eq!(
        calls.last().unwrap()["params"]["sandboxPolicy"]["type"],
        "readOnly"
    );
    assert_eq!(
        manager.view(session_id, &owner).unwrap()["approvalMode"],
        "read-only"
    );
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn every_interactive_backend_app_selection_waits_for_the_owned_decision() {
    for backend in BACKENDS
        .iter()
        .filter(|backend| approval::scope(backend) == "tool" && **backend != "codex")
    {
        let directory = std::env::temp_dir().join(format!("kp-app-tools-{backend}-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        let root = canonical_root(&directory.to_string_lossy()).unwrap();
        let manager = AgentManager::open(root.join("sessions.json"), 0);
        let owner = "a".repeat(64);
        // Normalize provider requests through a deterministic RPC peer. Native
        // ACP mode selection and option mappings have separate protocol tests.
        let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
        let consumer = attach_backend(&manager, &child, &root, backend).await;
        let session = manager.create(&owner, &json!({"conversationId":"app-tools","backend":backend,"roots":[root],"approvalMode":"app"})).await.unwrap();
        let session_id = session["id"].as_str().unwrap();
        manager
            .turn(
                session_id,
                &owner,
                &json!({"requestId":"run","text":"change fixture"}),
            )
            .await
            .unwrap();
        let request = child.submit("fixture/approval", json!({"method":"item/commandExecution/requestApproval","params":{"command":"fixture mutation"}}), Duration::from_secs(3)).await.unwrap();
        let pending = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let view = manager.view(session_id, &owner).unwrap();
                if let Some(pending) = view["pending"].as_array().unwrap().first() {
                    break pending.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(pending["decisionCapabilities"]["autoApproval"], false);
        assert!(manager
            .respond(
                session_id,
                &"b".repeat(64),
                &json!({"id":pending["id"],"decision":"accept"})
            )
            .await
            .is_err());
        manager
            .respond(
                session_id,
                &owner,
                &json!({"id":pending["id"],"decision":"decline"}),
            )
            .await
            .unwrap();
        assert_eq!(
            request.result().await.unwrap(),
            json!({"decision":"decline"})
        );
        assert!(manager
            .respond(
                session_id,
                &owner,
                &json!({"id":pending["id"],"decision":"accept"})
            )
            .await
            .is_err());
        assert_eq!(
            manager.view(session_id, &owner).unwrap()["approvalMode"],
            "app"
        );
        manager.close().await;
        consumer.abort();
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn headless_app_gate_does_not_dispatch_until_accept_and_never_replays() {
    for backend in ["gemini", "trae"] {
        let directory = std::env::temp_dir().join(format!("kp-app-turn-{backend}-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        let root = canonical_root(&directory.to_string_lossy()).unwrap();
        let registry = root.join("sessions.json");
        let manager = AgentManager::open(registry.clone(), 0);
        let owner = "a".repeat(64);
        let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
        let consumer = attach_backend(&manager, &child, &root, backend).await;
        let session = manager.create(&owner, &json!({"conversationId":"app-turn","backend":backend,"roots":[root],"approvalMode":"app"})).await.unwrap();
        let session_id = session["id"].as_str().unwrap();
        for decision in ["decline", "cancel", "interrupt", "accept", "restart"] {
            let input = json!({"requestId":decision,"text":"execute native task"});
            let waiting = manager.turn(session_id, &owner, &input).await.unwrap();
            let pending = waiting["session"]["pending"][0].clone();
            assert_eq!(waiting["submission"]["state"], "accepted");
            assert_eq!(waiting["session"]["status"], "waiting");
            assert_eq!(pending["params"]["approvalScope"], "turn");
            assert_eq!(pending["params"]["requiresUserDecision"], true);
            assert_eq!(
                pending["params"]["availableDecisions"],
                json!(["accept", "decline", "cancel"])
            );
            assert_eq!(
                log(&child)
                    .await
                    .iter()
                    .filter(|call| call["method"] == "turn/start")
                    .count(),
                usize::from(decision == "restart")
            );
            assert!(manager
                .respond(
                    session_id,
                    &owner,
                    &json!({"id":pending["id"],"decision":"acceptForSession"})
                )
                .await
                .is_err());
            if decision == "restart" {
                break;
            }
            if decision == "interrupt" {
                assert_eq!(
                    manager.interrupt(session_id, &owner).await.unwrap()["status"],
                    "interrupted"
                );
            } else {
                let result = manager
                    .respond(
                        session_id,
                        &owner,
                        &json!({"id":pending["id"],"decision":decision}),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    result["status"],
                    if decision == "accept" {
                        "running"
                    } else {
                        "interrupted"
                    }
                );
            }
            assert!(manager
                .respond(
                    session_id,
                    &owner,
                    &json!({"id":pending["id"],"decision":"accept"})
                )
                .await
                .is_err());
            manager.turn(session_id, &owner, &input).await.unwrap();
            assert_eq!(
                log(&child)
                    .await
                    .iter()
                    .filter(|call| call["method"] == "turn/start")
                    .count(),
                usize::from(decision == "accept")
            );
            if decision == "accept" {
                complete(&manager, session_id);
            }
        }
        let restored = AgentManager::open(registry, 0);
        let restored_view = restored.view(session_id, &owner).unwrap();
        assert_eq!(restored_view["status"], "interrupted");
        assert_eq!(restored_view["pending"], json!([]));
        restored
            .turn(
                session_id,
                &owner,
                &json!({"requestId":"restart","text":"must not replay"}),
            )
            .await
            .unwrap();
        assert_eq!(
            log(&child)
                .await
                .iter()
                .filter(|call| call["method"] == "turn/start")
                .count(),
            1
        );
        manager.close().await;
        restored.close().await;
        consumer.abort();
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn headless_app_approval_rechecks_revoked_page_before_dispatch() {
    let directory = std::env::temp_dir().join(format!("kp-app-revoked-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let manager = AgentManager::open(root.join("sessions.json"), 0);
    let owner = "a".repeat(64);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach_backend(&manager, &child, &root, "gemini").await;
    let session = manager.create(&owner, &json!({"conversationId":"app-revoked","backend":"gemini","roots":[root],"approvalMode":"app"})).await.unwrap();
    let session_id = session["id"].as_str().unwrap();
    let waiting = manager
        .turn(
            session_id,
            &owner,
            &json!({"requestId":"run","text":"execute task"}),
        )
        .await
        .unwrap();
    manager.context.register(&owner, "app-revoked", &json!({"pageId":"page","generation":"generation","instructions":"fixture context","revision":"1","tools":[]})).unwrap();
    let marker = manager.context.marker(&owner, "app-revoked").unwrap();
    manager
        .edit(session_id, |s| {
            s.data["aichatContext"] = json!(true);
            s.context_marker = Some(marker);
            Ok(())
        })
        .unwrap();
    manager.context.revoke(&owner);
    let error = manager
        .respond(
            session_id,
            &owner,
            &json!({"id":waiting["session"]["pending"][0]["id"],"decision":"accept"}),
        )
        .await
        .unwrap_err();
    assert!(error.contains("page changed before approval"));
    assert_eq!(
        log(&child)
            .await
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        0
    );
    assert_eq!(
        manager.view(session_id, &owner).unwrap()["lastSubmission"]["state"],
        "rejected"
    );
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn stop_during_native_configuration_stays_immediately_retryable() {
    let directory = std::env::temp_dir().join(format!("kp-stop-configuration-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let root = canonical_root(&directory.to_string_lossy()).unwrap();
    let manager = AgentManager::open(root.join("sessions.json"), 0);
    let owner = "a".repeat(64);
    let (child, _fixture) = harness::fixture(PEER, Protocol::Codex).await;
    let consumer = attach(&manager, &child, &root).await;
    let session = manager
        .create(
            &owner,
            &json!({"conversationId":"stop-configuration","roots":[root]}),
        )
        .await
        .unwrap();
    let session_id = session["id"].as_str().unwrap();
    let configuration = manager.sessions.lock().unwrap()[session_id]
        .configuration
        .clone();
    let guard = configuration.lock().await;
    manager
        .edit(session_id, |s| {
            s.data["status"] = json!("starting");
            Ok(())
        })
        .unwrap();
    let error = tokio::time::timeout(
        Duration::from_millis(100),
        manager.interrupt(session_id, &owner),
    )
    .await
    .expect("Stop must not wait for native configuration")
    .unwrap_err();
    assert!(error.contains("starting; retry Stop"));
    assert_eq!(
        manager.view(session_id, &owner).unwrap()["status"],
        "starting"
    );
    assert_eq!(
        log(&child)
            .await
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        0
    );
    drop(guard);
    manager.close().await;
    consumer.abort();
    std::fs::remove_dir_all(directory).unwrap();
}
