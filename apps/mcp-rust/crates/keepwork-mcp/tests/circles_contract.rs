//! Isolated HTTP contracts for the Node-compatible local circles surface.
//! These fixtures never touch a user's brain, channel credentials or IM groups.

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use keepwork_mcp::presence::RememberClientInput;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:64533";
const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_OWNER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROUTE: &str = "/agents/personas/circles";

struct Fixture {
    home: PathBuf,
    brain: PathBuf,
    state: Arc<AppState>,
}

impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!(
            "kp-circles-contract-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let brain = home.join("brain");
        std::fs::create_dir_all(&brain).unwrap();
        let state = Self::open(&home);
        remember(&state, OWNER, ORIGIN, &brain, "initial-session");
        Self { home, brain, state }
    }

    fn open(home: &Path) -> Arc<AppState> {
        Arc::new(AppState::new_at(
            8099,
            home.to_path_buf(),
            false,
            "test-token".to_string(),
            Identity::from_env(Some("standalone".into()), None),
            home.join("personas-v1"),
        ))
    }

    fn restart(&mut self) {
        self.state = Self::open(&self.home);
        remember(&self.state, OWNER, ORIGIN, &self.brain, "restart-session");
    }

    fn file(&self) -> PathBuf {
        self.brain.join(".aichat/circles/organization.json")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn remember(state: &Arc<AppState>, owner: &str, origin: &str, root: &Path, session: &str) {
    state
        .presence
        .remember_client(&RememberClientInput {
            session_id: session,
            url: &format!("{origin}/chat"),
            token: "isolated-fixture-token",
            base_url: None,
            owner: Some(owner),
            origin,
            handler: false,
            brain_root: root.to_str(),
            default_executor: None,
        })
        .unwrap();
}

fn request(method: &str, path: &str, input: &Value, owner: &str, origin: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, origin)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-agent-owner", owner)
        .body(Body::from(input.to_string()))
        .unwrap()
}

async fn send(state: &Arc<AppState>, request: Request<Body>) -> (StatusCode, Value) {
    let response = router(Arc::clone(state)).oneshot(request).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| {
        panic!(
            "non-JSON {status} response: {}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, value)
}

async fn circles(state: &Arc<AppState>, input: Value) -> (StatusCode, Value) {
    send(state, request("POST", ROUTE, &input, OWNER, ORIGIN)).await
}

async fn ok(state: &Arc<AppState>, input: Value) -> Value {
    let (status, value) = circles(state, input).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn read(state: &Arc<AppState>) -> Value {
    ok(state, json!({"action":"read"})).await
}

fn draft() -> Value {
    json!({
        "version":1,"revision":0,"name":"Design team",
        "members":[
            {"id":"alex","kind":"human","name":"Alex"},
            {"id":"sam","kind":"human","name":"Sam"}
        ],
        "circles":[{
            "id":"product","parentId":null,"name":"Product","goal":"Ship",
            "publicDescription":"","archived":false,"members":["alex"],
            "roles":[{
                "id":"design","name":"Design","responsibility":"Design interactions",
                "skills":["$design"],"holders":["sam"],"primaryHolder":"sam"
            }]
        }]
    })
}

async fn preview(state: &Arc<AppState>, snapshot: &Value, organization: Value) -> Value {
    ok(
        state,
        json!({
            "action":"preview","organizationId":snapshot["organizationId"],
            "expectedScope":snapshot["scope"],
            "expectedRevision":snapshot["organization"]["revision"],
            "organization":organization
        }),
    )
    .await
}

async fn apply(state: &Arc<AppState>, snapshot: &Value, ticket: &Value) -> Value {
    ok(
        state,
        json!({
            "action":"apply","organizationId":snapshot["organizationId"],
            "expectedScope":snapshot["scope"],"ticket":ticket
        }),
    )
    .await
}

#[tokio::test]
async fn default_read_matches_legacy_node_fields_and_does_not_create_a_brain_file() {
    let f = Fixture::new();
    // Missing action is the historical read default.
    let snapshot = ok(&f.state, json!({})).await;
    assert_eq!(snapshot["organizationId"], "default");
    assert_eq!(
        snapshot["organizations"],
        json!([{"id":"default","name":"我的组织"}])
    );
    assert_eq!(
        snapshot["organization"],
        json!({
            "version":1,"revision":0,"name":"我的组织","members":[],"circles":[]
        })
    );
    assert_eq!(snapshot["scope"].as_str().unwrap().len(), 64);
    assert_eq!(snapshot["agents"], json!([]));
    assert_eq!(snapshot["channels"], json!([]));
    assert_eq!(snapshot["memberSync"], Value::Null);
    for key in ["sync", "receipts", "discovery"] {
        assert_eq!(snapshot[key], json!({}), "{key}");
    }
    assert!(!f.file().exists());
    let refreshed = ok(
        &f.state,
        json!({"action":"refresh","expectedScope":snapshot["scope"]}),
    )
    .await;
    assert_eq!(refreshed["organization"], snapshot["organization"]);
}

#[tokio::test]
async fn preview_apply_supports_circle_role_member_create_update_and_remove() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let p = preview(&f.state, &initial, draft()).await;
    assert_eq!(p["before"], initial["organization"]);
    assert_eq!(p["after"], draft());
    assert!(p["ticket"].as_str().is_some_and(|value| !value.is_empty()));
    assert!(!f.file().exists(), "preview must not persist");
    assert_eq!(
        read(&f.state).await["organization"],
        initial["organization"]
    );

    let saved = apply(&f.state, &initial, &p["ticket"]).await;
    assert_eq!(saved["organization"]["revision"], 1);
    assert_eq!(
        saved["organization"]["circles"][0]["roles"][0]["primaryHolder"],
        "sam"
    );
    let disk: Value = serde_json::from_slice(&std::fs::read(f.file()).unwrap()).unwrap();
    assert_eq!(disk, saved["organization"]);

    let mut updated = saved["organization"].clone();
    updated["members"][0]["name"] = json!("Alex renamed");
    updated["circles"][0]["name"] = json!("X-Product");
    updated["circles"].as_array_mut().unwrap().push(json!({
        "id":"child","parentId":"product","name":"Research","goal":"Explore",
        "publicDescription":"","archived":false,"members":["sam"],"roles":[]
    }));
    let p = preview(&f.state, &saved, updated).await;
    let saved = apply(&f.state, &saved, &p["ticket"]).await;
    assert_eq!(saved["organization"]["revision"], 2);
    assert_eq!(saved["organization"]["circles"][1]["parentId"], "product");

    let mut removed = saved["organization"].clone();
    removed["members"]
        .as_array_mut()
        .unwrap()
        .retain(|m| m["id"] != "sam");
    removed["circles"].as_array_mut().unwrap().truncate(1);
    removed["circles"][0]["roles"] = json!([]);
    removed["circles"][0]["archived"] = json!(true);
    let p = preview(&f.state, &saved, removed).await;
    let saved = apply(&f.state, &saved, &p["ticket"]).await;
    assert_eq!(saved["organization"]["revision"], 3);
    assert_eq!(
        saved["organization"]["members"].as_array().unwrap().len(),
        1
    );
    assert_eq!(saved["organization"]["circles"][0]["roles"], json!([]));
    assert_eq!(saved["organization"]["circles"][0]["archived"], true);
}

#[tokio::test]
async fn revisions_and_single_use_tickets_prevent_overwriting_a_newer_draft() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let first = preview(&f.state, &initial, draft()).await;
    let second = preview(&f.state, &initial, draft()).await;
    let saved = apply(&f.state, &initial, &first["ticket"]).await;
    for ticket in [
        &first["ticket"],
        &second["ticket"],
        &json!("unknown-ticket"),
    ] {
        let (status, body) = circles(&f.state, json!({"action":"apply","ticket":ticket})).await;
        assert!(!status.is_success(), "ticket replay/stale accepted: {body}");
    }
    for revision in [json!(0), Value::Null, json!("1"), json!(-1)] {
        let (status, _) = circles(
            &f.state,
            json!({
                "action":"preview","organization":draft(),"expectedRevision":revision
            }),
        )
        .await;
        assert!(!status.is_success());
    }
    assert_eq!(read(&f.state).await["organization"], saved["organization"]);
}

#[tokio::test]
async fn simultaneous_applies_serialize_at_the_brain_and_preserve_one_committed_revision() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let mut second_draft = draft();
    second_draft["name"] = json!("Concurrent alternate");
    let first = preview(&f.state, &initial, draft()).await;
    let second = preview(&f.state, &initial, second_draft).await;
    let (a, b) = tokio::join!(
        circles(&f.state, json!({"action":"apply","ticket":first["ticket"]})),
        circles(
            &f.state,
            json!({"action":"apply","ticket":second["ticket"]})
        )
    );
    assert_eq!(
        usize::from(a.0.is_success()) + usize::from(b.0.is_success()),
        1,
        "exactly one revision-zero draft may commit: {:?} {:?}",
        a,
        b
    );
    let final_snapshot = read(&f.state).await;
    assert_eq!(final_snapshot["organization"]["revision"], 1);
    let committed = if a.0.is_success() { &a.1 } else { &b.1 };
    assert_eq!(final_snapshot["organization"], committed["organization"]);
    let disk: Value = serde_json::from_slice(&std::fs::read(f.file()).unwrap()).unwrap();
    assert_eq!(disk, final_snapshot["organization"]);
}

#[tokio::test]
async fn create_organization_is_idempotent_and_drafts_are_scoped_to_the_selected_organization() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let create = json!({
        "action":"createOrganization","name":"Other team","requestId":"create-other",
        "expectedRevision":0,"expectedScope":initial["scope"]
    });
    let other = ok(&f.state, create.clone()).await;
    assert_ne!(other["organizationId"], "default");
    assert_eq!(other["organizationId"].as_str().unwrap().len(), 64);
    assert_ne!(other["scope"], initial["scope"]);
    assert_eq!(other["organization"]["name"], "Other team");
    assert_eq!(other["organization"]["revision"], 1);
    assert_eq!(
        ok(&f.state, create.clone()).await["organizationId"],
        other["organizationId"]
    );
    let mut changed = create;
    changed["name"] = json!("Reused with different content");
    assert!(!circles(&f.state, changed).await.0.is_success());

    let p = preview(&f.state, &other, draft()).await;
    let (status, _) = circles(&f.state, json!({"action":"apply","ticket":p["ticket"]})).await;
    assert!(
        !status.is_success(),
        "other organization's ticket accepted in default"
    );
    let saved = apply(&f.state, &other, &p["ticket"]).await;
    assert_eq!(saved["organization"]["revision"], 2);
    assert_eq!(read(&f.state).await["organization"]["revision"], 0);
    assert_eq!(
        read(&f.state).await["organizations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    for id in ["../outside", "a/b", "unknown", ""] {
        assert!(
            !circles(&f.state, json!({"action":"read","organizationId":id}))
                .await
                .0
                .is_success()
        );
    }
    assert!(!circles(
        &f.state,
        json!({"action":"read","organizationId":"f".repeat(64)})
    )
    .await
    .0
    .is_success());
}

#[tokio::test]
async fn scope_and_tickets_bind_to_owner_origin_and_current_brain() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let p = preview(&f.state, &initial, draft()).await;
    remember(
        &f.state,
        OTHER_OWNER,
        ORIGIN,
        &f.brain,
        "other-owner-session",
    );
    let (status, _) = send(
        &f.state,
        request(
            "POST",
            ROUTE,
            &json!({
                "action":"apply","ticket":p["ticket"]
            }),
            OTHER_OWNER,
            ORIGIN,
        ),
    )
    .await;
    assert!(!status.is_success(), "cross-owner ticket accepted");

    let other_origin = "http://localhost:64534";
    remember(
        &f.state,
        OWNER,
        other_origin,
        &f.brain,
        "other-origin-session",
    );
    let (status, _) = send(
        &f.state,
        request(
            "POST",
            ROUTE,
            &json!({
                "action":"apply","ticket":p["ticket"]
            }),
            OWNER,
            other_origin,
        ),
    )
    .await;
    assert!(!status.is_success(), "cross-origin ticket accepted");

    let other_brain = f.home.join("other-brain");
    std::fs::create_dir(&other_brain).unwrap();
    remember(&f.state, OWNER, ORIGIN, &other_brain, "new-brain-session");
    let current = read(&f.state).await;
    assert_ne!(current["scope"], initial["scope"]);
    assert_eq!(current["organization"]["revision"], 0);
    for action in ["preview", "refresh", "read"] {
        let (status, _) = circles(
            &f.state,
            json!({
                "action":action,"expectedScope":initial["scope"],
                "expectedRevision":0,"organization":draft()
            }),
        )
        .await;
        assert!(
            !status.is_success(),
            "stale brain scope accepted for {action}"
        );
    }
    assert!(
        !circles(&f.state, json!({"action":"apply","ticket":p["ticket"]}))
            .await
            .0
            .is_success()
    );
    assert!(!other_brain
        .join(".aichat/circles/organization.json")
        .exists());
    assert!(!f.file().exists());
}

#[tokio::test]
async fn persisted_node_json_survives_restart_while_preview_tickets_do_not() {
    let mut f = Fixture::new();
    std::fs::create_dir_all(f.file().parent().unwrap()).unwrap();
    let mut node_json = draft();
    node_json["revision"] = json!(7);
    std::fs::write(f.file(), serde_json::to_vec_pretty(&node_json).unwrap()).unwrap();
    let snapshot = read(&f.state).await;
    assert_eq!(snapshot["organization"], node_json);
    let p = preview(&f.state, &snapshot, node_json.clone()).await;
    f.restart();
    let restarted = read(&f.state).await;
    assert_eq!(restarted["organization"], node_json);
    assert_eq!(restarted["scope"], snapshot["scope"]);
    assert!(
        !circles(&f.state, json!({"action":"apply","ticket":p["ticket"]}))
            .await
            .0
            .is_success()
    );
    let p = preview(&f.state, &restarted, node_json).await;
    let saved = apply(&f.state, &restarted, &p["ticket"]).await;
    assert_eq!(saved["organization"]["revision"], 8);
}

#[tokio::test]
async fn corrupt_or_oversized_node_metadata_fails_without_resetting_existing_data() {
    let f = Fixture::new();
    std::fs::create_dir_all(f.file().parent().unwrap()).unwrap();
    for bytes in [
        b"{invalid JSON".to_vec(),
        vec![b' '; 2_000_001],
        json!({"version":2,"revision":0,"name":"Future data","members":[],"circles":[]})
            .to_string()
            .into_bytes(),
    ] {
        std::fs::write(f.file(), &bytes).unwrap();
        assert!(!circles(&f.state, json!({"action":"read"}))
            .await
            .0
            .is_success());
        assert!(!circles(
            &f.state,
            json!({"action":"preview","expectedRevision":0,"organization":draft()})
        )
        .await
        .0
        .is_success());
        assert_eq!(
            std::fs::read(f.file()).unwrap(),
            bytes,
            "unreadable organization data must never be replaced with empty defaults"
        );
        assert_eq!(
            send(
                &f.state,
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .0,
            StatusCode::OK,
            "a corrupt optional circle file must not break ordinary daemon operation"
        );
    }
}

#[tokio::test]
async fn near_limit_node_documents_cannot_be_saved_as_unreadable_oversized_pretty_json() {
    let f = Fixture::new();
    let mut org = draft();
    org["circles"][0]["binding"] = json!({"channel":"feishu","account":"app:self","id":"group"});
    let roles: Vec<Value> = (0..125)
        .map(|n| {
            json!({
                "id":format!("role-{n}"),"name":format!("Role {n}"),
                "responsibility":"x".repeat(15_500),"skills":[],"holders":[]
            })
        })
        .collect();
    org["circles"][0]["roles"] = json!(&roles[..100]);
    org["circles"].as_array_mut().unwrap().push(json!({
        "id":"other","parentId":null,"name":"Other","goal":"",
        "publicDescription":"","archived":false,"members":[],"roles":&roles[100..]
    }));
    let mut padding = 1_999_000 - serde_json::to_vec(&org).unwrap().len();
    for circle in org["circles"].as_array_mut().unwrap() {
        for role in circle["roles"].as_array_mut().unwrap() {
            let add = padding.min(500);
            let mut responsibility = role["responsibility"].as_str().unwrap().to_string();
            responsibility.push_str(&"x".repeat(add));
            role["responsibility"] = json!(responsibility);
            padding -= add;
        }
    }
    assert_eq!(padding, 0);
    let bytes = serde_json::to_vec(&org).unwrap();
    assert!(bytes.len() <= 2_000_000);
    assert!(
        serde_json::to_vec_pretty(&org).unwrap().len() > 2_000_000,
        "fixture must cross the on-disk cap when formatted"
    );
    std::fs::create_dir_all(f.file().parent().unwrap()).unwrap();
    std::fs::write(f.file(), &bytes).unwrap();
    assert_eq!(read(&f.state).await["organization"]["revision"], 0);
    let (status, _) = circles(
        &f.state,
        json!({
            "action":"unbind","circleId":"product","expectedRevision":0,"confirm":true
        }),
    )
    .await;
    if status.is_success() {
        assert!(std::fs::metadata(f.file()).unwrap().len() <= 2_000_000);
        assert_eq!(read(&f.state).await["organization"]["revision"], 1);
    } else {
        assert!(
            std::fs::read(f.file()).unwrap() == bytes,
            "rejecting an oversized representation must preserve the readable original"
        );
    }
}

#[tokio::test]
async fn invalid_graphs_identities_names_and_oversized_fields_are_rejected_without_writes() {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let mut proposals = Vec::new();
    let mut value = draft();
    value["circles"][0]["parentId"] = json!("product");
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["parentId"] = json!("missing");
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["members"] = json!(["missing"]);
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["roles"][0]["holders"] = json!(["missing"]);
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["roles"][0]["primaryHolder"] = json!("alex");
    proposals.push(value);
    let mut value = draft();
    value["members"][1]["id"] = json!("alex");
    proposals.push(value);
    let mut value = draft();
    value["members"][0]["id"] = json!("bad\nidentity");
    proposals.push(value);
    let mut value = draft();
    value["members"][0]["name"] = json!("a".repeat(81));
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["name"] = json!(" ");
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["roles"][0]["name"] = json!(" ");
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["roles"][0]["skills"] = json!(["x".repeat(257)]);
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["goal"] = json!("x".repeat(16001));
    proposals.push(value);
    let mut value = draft();
    value["circles"][0]["platform"] = json!("unknown");
    proposals.push(value);
    let mut value = draft();
    value["members"][0]["kind"] = json!("unknown");
    proposals.push(value);
    let mut value = draft();
    value["members"][0]["identity"] = json!({"channel":"feishu","account":"a","id":"u"});
    value["members"][1]["identity"] = value["members"][0]["identity"].clone();
    proposals.push(value);
    let mut value = draft();
    value["members"][0] = json!({"id":"bot","kind":"persona","name":"Bot","personaId":"missing"});
    value["circles"][0]["members"] = json!(["bot"]);
    proposals.push(value);
    let mut value = draft();
    let duplicate = value["circles"][0].clone();
    value["circles"].as_array_mut().unwrap().push(duplicate);
    proposals.push(value);
    for (index, organization) in proposals.into_iter().enumerate() {
        let (status, body) = circles(
            &f.state,
            json!({
                "action":"preview","expectedRevision":0,"organization":organization,
                "expectedScope":initial["scope"]
            }),
        )
        .await;
        assert!(
            !status.is_success(),
            "invalid proposal {index} accepted: {body}"
        );
    }
    assert_eq!(read(&f.state).await["organization"]["revision"], 0);
    assert!(!f.file().exists());
}

#[tokio::test]
async fn credentials_are_stripped_and_existing_group_bindings_cannot_be_forged_or_removed_by_preview(
) {
    let f = Fixture::new();
    let initial = read(&f.state).await;
    let mut value = draft();
    value["token"] = json!("secret");
    value["members"][0]["access_token"] = json!("member-secret");
    value["circles"][0]["authorization"] = json!("circle-secret");
    let p = preview(&f.state, &initial, value.clone()).await;
    assert!(p["after"].get("token").is_none());
    assert!(p["after"]["members"][0].get("access_token").is_none());
    assert!(p["after"]["circles"][0].get("authorization").is_none());
    let saved = apply(&f.state, &initial, &p["ticket"]).await;
    assert!(!std::fs::read_to_string(f.file())
        .unwrap()
        .contains("secret"));

    value = saved["organization"].clone();
    value["circles"][0]["binding"] = json!({"channel":"feishu","account":"tenant:user","id":"g"});
    assert!(!circles(
        &f.state,
        json!({
            "action":"preview","organization":value,"expectedRevision":1
        })
    )
    .await
    .0
    .is_success());

    // Read a Node-owned deployed circle without treating it as a local grant.
    let mut node = saved["organization"].clone();
    node["circles"][0]["binding"] = json!({"channel":"feishu","account":"tenant:user","id":"g"});
    std::fs::write(f.file(), serde_json::to_vec(&node).unwrap()).unwrap();
    let snapshot = read(&f.state).await;
    let mut removed = snapshot["organization"].clone();
    removed["circles"][0]
        .as_object_mut()
        .unwrap()
        .remove("binding");
    assert!(!circles(
        &f.state,
        json!({
            "action":"preview","organization":removed,"expectedRevision":1
        })
    )
    .await
    .0
    .is_success());
    assert_eq!(
        read(&f.state).await["organization"]["circles"][0]["binding"]["id"],
        "g"
    );
}

#[tokio::test]
async fn known_personas_can_hold_roles_and_are_projected_in_the_circle_editor() {
    let f = Fixture::new();
    let (status, body) = send(
        &f.state,
        request(
            "POST",
            "/agents/personas",
            &json!({
                "id":"writer","name":"Writer","root":f.brain.to_str().unwrap(),
                "executor":"auto","prompt":"Write docs"
            }),
            OWNER,
            ORIGIN,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let initial = read(&f.state).await;
    assert!(initial["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == "writer" && a["name"] == "Writer"));
    let mut value = draft();
    value["members"].as_array_mut().unwrap().push(json!({
        "id":"bot","name":"Writer","kind":"persona","personaId":"writer"
    }));
    value["circles"][0]["roles"][0]["holders"] = json!(["sam", "bot"]);
    let p = preview(&f.state, &initial, value).await;
    let saved = apply(&f.state, &initial, &p["ticket"]).await;
    assert_eq!(saved["organization"]["members"][2]["personaId"], "writer");
    assert_eq!(
        saved["organization"]["circles"][0]["roles"][0]["holders"],
        json!(["sam", "bot"])
    );
}

#[tokio::test]
async fn owner_brain_presence_takes_priority_and_explicit_unbinding_does_not_reuse_persona_root() {
    let f = Fixture::new();
    let other = f.home.join("persona-brain");
    std::fs::create_dir(&other).unwrap();
    let (status,body) = send(&f.state, request("POST", "/agents/personas", &json!({
        "id":"default-persona","name":"Assistant","root":other.to_str().unwrap(),"executor":"auto"
    }), OWNER, ORIGIN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let initial = read(&f.state).await;
    let p = preview(&f.state, &initial, draft()).await;
    apply(&f.state, &initial, &p["ticket"]).await;
    assert!(
        f.file().exists(),
        "presence brain must win over persona root"
    );
    assert!(!other.join(".aichat/circles/organization.json").exists());

    f.state
        .presence
        .remember_client(&RememberClientInput {
            session_id: "unbind-session",
            url: &format!("{ORIGIN}/chat"),
            token: "fixture-token",
            base_url: None,
            owner: Some(OWNER),
            origin: ORIGIN,
            handler: false,
            brain_root: Some(""),
            default_executor: None,
        })
        .unwrap();
    assert!(
        !circles(&f.state, json!({"action":"read"}))
            .await
            .0
            .is_success(),
        "explicit presence root removal must not fall back to the persona's older brain"
    );

    // A legacy client that has not reported presence can still use its bound default persona.
    let restarted = Fixture::open(&f.home);
    assert_eq!(read(&restarted).await["organization"]["revision"], 0);
    let initial = read(&restarted).await;
    let p = preview(&restarted, &initial, draft()).await;
    apply(&restarted, &initial, &p["ticket"]).await;
    assert!(other.join(".aichat/circles/organization.json").exists());
}

#[tokio::test]
async fn circles_require_allowed_origin_owner_auth_json_and_post_while_health_stays_usable() {
    let f = Fixture::new();
    for (owner, origin) in [
        (OWNER, "https://evil.example"),
        ("invalid", ORIGIN),
        (OWNER, ""),
    ] {
        let (status, _) = send(&f.state, request("POST", ROUTE, &json!({}), owner, origin)).await;
        assert!(!status.is_success());
    }
    let (status, _) = send(&f.state, request("GET", ROUTE, &json!({}), OWNER, ORIGIN)).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    let req = Request::builder()
        .method("POST")
        .uri(ROUTE)
        .header(header::ORIGIN, ORIGIN)
        .header("x-agent-owner", OWNER)
        .body(Body::from("{}"))
        .unwrap();
    assert!(!send(&f.state, req).await.0.is_success());

    let authenticated = AppState::new_at(
        8099,
        f.home.clone(),
        true,
        "test-token".into(),
        Identity::from_env(Some("standalone".into()), None),
        f.home.join("authenticated-personas"),
    );
    let authenticated = Arc::new(authenticated);
    remember(&authenticated, OWNER, ORIGIN, &f.brain, "auth-session");
    assert_eq!(
        circles(&authenticated, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut req = request("POST", ROUTE, &json!({}), OWNER, ORIGIN);
    req.headers_mut()
        .insert(header::AUTHORIZATION, "Bearer test-token".parse().unwrap());
    assert_eq!(send(&authenticated, req).await.0, StatusCode::OK);
    assert_eq!(
        send(
            &authenticated,
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        send(
            &f.state,
            request("GET", "/agents/personas", &Value::Null, OWNER, ORIGIN)
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_in_brain_metadata_paths_never_escape_the_selected_root() {
    use std::os::unix::fs::symlink;
    for component in [
        ".aichat",
        ".aichat/circles",
        ".aichat/circles/organization.json",
    ] {
        let f = Fixture::new();
        let outside = f.home.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let target = f.brain.join(component);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        let destination = if component.ends_with(".json") {
            let path = outside.join("organization.json");
            std::fs::write(&path, serde_json::to_vec(&draft()).unwrap()).unwrap();
            path
        } else {
            outside.clone()
        };
        symlink(&destination, &target).unwrap();
        let before = std::fs::read_dir(&outside).unwrap().count();
        let (status, body) = circles(&f.state, json!({"action":"read"})).await;
        assert!(!status.is_success(), "accepted symlink {component}: {body}");
        assert!(!circles(
            &f.state,
            json!({
                "action":"preview","expectedRevision":0,"organization":draft()
            })
        )
        .await
        .0
        .is_success());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), before);
    }
}
