//! External circle operations against an argument-recording fake Lark CLI.
//! No real credentials, IM APIs, network listener or user brain are used.
#![cfg(unix)]

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use keepwork_mcp::presence::RememberClientInput;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:64535";
const OWNER: &str = "cccccccccccccccccccccccccccccccc";
const CIRCLES: &str = "/agents/personas/circles";

const CLI: &str = r##"#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const a=process.argv.slice(2), cwd=process.cwd(), stateFile=path.join(cwd,'fixture-im.json');
const st=JSON.parse(fs.readFileSync(stateFile,'utf8'));
fs.appendFileSync(path.join(cwd,'fixture-im-calls.ndjson'),JSON.stringify(a)+'\n');
const arg=k=>a[a.indexOf(k)+1], is=(...words)=>words.every((w,i)=>a[i]===w);
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(st));
const output=v=>process.stdout.write(JSON.stringify(v));
const write=()=>{st.writes++;save();};
if(is('event','consume')) {process.stderr.write('[event] ready\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}
else if(is('event','status')) output({identity:{corp_id:'corp',user_id:st.wrongAccount?'other-user':'user',open_dingtalk_id:'open-self',user_name:'Ding Human'},bus:{live:{consumers:[]}},subscriptions:[]});
else if(is('profile','list')) output({currentProfile:'corp:user',profiles:[{profile:'corp:user',corpId:'corp',userId:'user',corpName:'Ding Fixture Company',userName:'Ding Human',isCurrent:true}]});
else if(is('chat','group','list-all')) output({groups:st.group?[{openConversationId:st.group,name:st.name,myRole:st.role||(st.admin?'群管理员':'普通成员')}]:[],hasMore:false});
else if(is('chat','+conversation-info')) output({openConversationId:st.group,name:st.name});
else if(is('chat','group','members')) output({members:st.members.map(m=>({openDingtalkId:m.id,name:m.name})),hasMore:false});
else if(is('chat','group','notice','list')) output({list:[{dataId:'ordinary-notice'},{dataId:'goal-notice'},...(st.duplicateGoal?[{dataId:'duplicate-goal'}]:[])],hasMore:false});
else if(is('chat','group','notice','get')) output(st.malformedNotice?{summary:'body unavailable'}:{content:arg('--notice-id')==='ordinary-notice'?'# Ordinary announcement\nKeep this announcement intact':'# X:goal\n\n'+st.description});
else if(is('chat','group','notice','edit')) {if(arg('--notice-id')!=='goal-notice')throw Error('Unrelated notice must not be edited');st.goalContent=arg('--content');st.description=st.goalContent.replace(/^# X:goal\n\n/,'');write();output({ok:true});}
else if(is('auth','status')) output({appId:st.wrongAccount?'other-app':'app',identities:{user:{openId:'self',status:'ready',available:true,verified:true,userName:'Fixture Human',tenantName:'Fixture Company'}}});
else if(is('im','+messages-search')) output({messages:[],has_more:false});
else if(is('contact','+search-user')) output({users:[{open_id:'directory-user',name:'Directory Human'}]});
else if(is('im','+chat-search')) output({chats:st.bulkSearch?Array.from({length:60},(_,i)=>({chat_id:'search-'+i,name:i===0?'':'Result '+i,chat_mode:'group'})):(st.group?[{chat_id:st.group,name:st.name,chat_mode:'group'}]:[])});
else if(is('im','+chat-list')) output({chats:st.group?[{chat_id:st.group,name:st.name,chat_mode:'group'}]:[],has_more:false});
else if(is('im','chats','get')) output({name:st.name,description:st.description,owner_id:st.admin?'self':'other-human',user_manager_id_list:[]});
else if(is('im','+chat-members-list')) output({users:st.members.map(m=>({member_id:m.id,name:m.name})),has_more:false,truncations:[]});
else if(is('api','GET')) output({code:0,data:{items:a[2].endsWith('/children')?[]:[{open_id:'directory-user',name:'Directory Human'}],has_more:false}});
else if(is('im','+chat-create')) {
  if(a.includes('--dry-run')) output({dryRun:true});
  else {st.group='new-group';st.name=arg('--name');st.description=arg('--description');st.members=(a.includes('--users')?arg('--users').split(','):[]).map(id=>({id,name:id==='self'?'Fixture Human':id}));write();output({chat_id:st.group});}
}
else if(is('im','+chat-update')) {
  st.name=arg('--name');st.description=arg('--description');write();
  if(st.failUpdate){process.stdout.write('uncertain-result');process.exitCode=1;}
  else output({ok:true});
}
else if(is('im','chat.members','create')) {for(const id of JSON.parse(arg('--data')).id_list)if(!st.members.some(m=>m.id===id))st.members.push({id,name:id});write();output({invalid_id_list:[]});}
else if(is('im','chat.members','delete')) {const ids=JSON.parse(arg('--data')).id_list;st.members=st.members.filter(m=>!ids.includes(m.id));write();output({invalid_id_list:[]});}
else if(is('im','+chat-messages-list')) {const page={messages:[{message_id:'remote-message',sender:{id:'self',name:'Fixture Human'},body:{content:'{"text":"Hello from the group"}'},create_time:'1700000000000',message_type:'text',url:'https://open.feishu.cn/message'}],has_more:!!st.partialHistory};if(st.partialHistory){page.partial=true;page.failedCount=1;output({data:page});}else output(page);}
else if(is('im','+messages-send')||is('im','+messages-reply')) {write();if(st.failSend){process.stdout.write('uncertain-send');process.exitCode=1;}else output({message_id:'sent-message'});}
else {process.stderr.write('Unexpected fixture arguments');process.exitCode=2;}
"##;

struct Fixture {
    home: PathBuf,
    brain: PathBuf,
    state: Arc<AppState>,
    old_cli: Option<std::ffi::OsString>,
    cli_env: &'static str,
}

impl Fixture {
    fn new(channel: &str) -> Self {
        let home =
            std::env::temp_dir().join(format!("kp-circle-channels-{}", uuid::Uuid::new_v4()));
        let brain = home.join("brain");
        std::fs::create_dir_all(&brain).unwrap();
        let program = home.join("lark-cli");
        std::fs::write(&program, CLI).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            brain.join("fixture-im.json"),
            json!({"admin":true,"group":null,"name":"","description":"","members":[],"writes":0})
                .to_string(),
        )
        .unwrap();
        let cli_env = if channel == "dingtalk" {
            "KEEPWORK_DWS_PATH"
        } else {
            "KEEPWORK_LARK_PATH"
        };
        let old_cli = std::env::var_os(cli_env);
        std::env::set_var(cli_env, &program);
        let state = Self::open(&home, &brain);
        Self {
            home,
            brain,
            state,
            old_cli,
            cli_env,
        }
    }

    fn open(home: &Path, brain: &Path) -> Arc<AppState> {
        let state = Arc::new(AppState::new_at(
            8099,
            home.to_path_buf(),
            false,
            "fixture-token".into(),
            Identity::from_env(Some("standalone".into()), None),
            home.join("personas-v1"),
        ));
        state
            .presence
            .remember_client(&RememberClientInput {
                session_id: "fixture-session",
                url: &format!("{ORIGIN}/chat"),
                token: "fixture-token",
                base_url: None,
                owner: Some(OWNER),
                origin: ORIGIN,
                handler: false,
                brain_root: brain.to_str(),
                default_executor: None,
            })
            .unwrap();
        state
    }

    fn im(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.brain.join("fixture-im.json")).unwrap()).unwrap()
    }
    fn change(&self, f: impl FnOnce(&mut Value)) {
        let mut im = self.im();
        f(&mut im);
        std::fs::write(self.brain.join("fixture-im.json"), im.to_string()).unwrap();
    }
    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.brain.join("fixture-im-calls.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn writes(&self) -> u64 {
        self.im()["writes"].as_u64().unwrap()
    }
    async fn restart(&mut self) {
        self.state.messaging.close().await;
        self.state = Self::open(&self.home, &self.brain);
        ok(
            &self.state,
            "/agents/personas/default-persona/channel-connect",
            json!({"channel":"feishu"}),
        )
        .await;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        match &self.old_cli {
            Some(value) => std::env::set_var(self.cli_env, value),
            None => std::env::remove_var(self.cli_env),
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

async fn send(state: &Arc<AppState>, path: &str, input: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-agent-owner", OWNER)
        .body(Body::from(input.to_string()))
        .unwrap();
    // Poll each request in its own task, as an HTTP server would, instead of
    // combining the long fixture and router's debug poll frames on one stack.
    let response = tokio::spawn(router(Arc::clone(state)).oneshot(request))
        .await
        .unwrap()
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn ok(state: &Arc<AppState>, path: &str, input: Value) -> Value {
    let (status, value) = send(state, path, input).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn circles(f: &Fixture, input: Value) -> Value {
    ok(&f.state, CIRCLES, input).await
}

async fn save(f: &Fixture, organization: Value) -> Value {
    let current = circles(f, json!({"action":"read"})).await;
    let preview = circles(f, json!({"action":"preview","expectedScope":current["scope"],"expectedRevision":current["organization"]["revision"],"organization":organization})).await;
    circles(
        f,
        json!({"action":"apply","expectedScope":current["scope"],"ticket":preview["ticket"]}),
    )
    .await
}

async fn publish_preview(f: &Fixture, snapshot: &Value) -> Value {
    circles(f, json!({"action":"publishPreview","circleId":"design","expectedScope":snapshot["scope"],"expectedRevision":snapshot["organization"]["revision"]})).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_previews_permissions_receipts_and_argument_boundaries_match_node_contracts() {
    // This is the only test in this integration process: CLI override env vars
    // cannot affect another test or the developer's actual CLI selection.
    let mut f = Fixture::new("feishu");
    ok(
        &f.state,
        "/agents/personas",
        json!({"id":"default-persona","name":"Assistant","root":f.brain,"executor":"auto"}),
    )
    .await;
    let connected = ok(
        &f.state,
        "/agents/personas/default-persona/channel-connect",
        json!({"channel":"feishu"}),
    )
    .await;
    assert_eq!(connected["status"], "listening");
    let initial = circles(&f, json!({"action":"read"})).await;
    assert_eq!(initial["channels"][0]["organization"], "Fixture Company");
    assert_eq!(initial["channels"][0]["accountName"], "Fixture Human");
    assert_eq!(initial["channels"][0]["available"], true);

    let query = "x $(touch should-never-exist) `id`; literal";
    let search = circles(&f, json!({"action":"search","channel":"feishu","account":"app:self","query":query,"contacts":true})).await;
    assert_eq!(search["items"][0]["id"], "directory-user");
    assert!(f
        .calls()
        .iter()
        .any(|call| call.windows(2).any(|w| w == ["--query", query])));
    assert!(!f.brain.join("should-never-exist").exists());

    let mut org = initial["organization"].clone();
    org["im"] = json!({"channel":"feishu","account":"app:self"});
    org["members"] = json!([{"id":"self-member","kind":"human","name":"Fixture Human","identity":{"channel":"feishu","account":"app:self","id":"self"}}]);
    org["circles"] = json!([{"id":"design","parentId":null,"name":"Design","goal":"","publicDescription":"Design team","archived":false,"members":["self-member"],"roles":[]}]);
    let snapshot = save(&f, org).await;

    let members = circles(
        &f,
        json!({"action":"membersPreview","expectedRevision":snapshot["organization"]["revision"]}),
    )
    .await;
    assert_eq!(
        members["memberSync"],
        json!({"count":1,"groups":0,"source":"company","limit":100,"limited":false})
    );
    assert_eq!(
        f.writes(),
        0,
        "directory import preview must not write to IM"
    );
    let snapshot = circles(&f, json!({"action":"apply","ticket":members["ticket"]})).await;
    assert_eq!(
        snapshot["organization"]["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!f
        .calls()
        .iter()
        .filter(|c| c.first().map(String::as_str) == Some("api"))
        .any(|c| c.iter().any(|a| a.contains("im/v1"))));

    let deploy = circles(&f, json!({"action":"deployPreview","circleId":"design","expectedRevision":snapshot["organization"]["revision"],"channel":"feishu","account":"app:self","type":"INTERNAL"})).await;
    assert_eq!(deploy["desired"]["name"], "X-Design");
    assert_eq!(f.writes(), 0, "deploy preview may only use CLI dry-run");
    assert!(f.calls().iter().any(
        |call| call.starts_with(&["im".into(), "+chat-create".into()])
            && call.iter().any(|arg| arg == "--dry-run")
    ));
    let snapshot = circles(
        &f,
        json!({"action":"deploy","circleId":"design","ticket":deploy["ticket"]}),
    )
    .await;
    assert_eq!(
        snapshot["organization"]["circles"][0]["binding"]["id"],
        "new-group"
    );
    assert_eq!(f.writes(), 1);

    f.change(|im| im["bulkSearch"] = json!(true));
    let group_search = circles(
        &f,
        json!({"action":"search","channel":"feishu","account":"app:self","query":"Design"}),
    )
    .await;
    assert_eq!(group_search["items"].as_array().unwrap().len(), 50);
    assert_eq!(
        group_search["items"][0]["name"], "search-0",
        "unnamed group falls back to its stable id"
    );
    f.change(|im| im["bulkSearch"] = json!(false));

    let mut org = snapshot["organization"].clone();
    org["circles"][0]["goal"] = json!("Ship a clear design");
    let snapshot = save(&f, org).await;
    f.change(|im| {
        im["members"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"obsolete-member","name":"Obsolete"}))
    });
    let writes = f.writes();
    let publish = publish_preview(&f, &snapshot).await;
    assert_eq!(publish["remove"], json!(["obsolete-member"]));
    assert_eq!(
        f.writes(),
        writes,
        "publish preview must not change the group"
    );
    let snapshot = circles(&f, json!({"action":"publish","circleId":"design","ticket":publish["ticket"],"requestId":"publish-first"})).await;
    assert_eq!(f.im()["description"], "目标：Ship a clear design");
    assert_eq!(f.im()["members"].as_array().unwrap().len(), 1);
    assert!(f.calls().iter().any(|call| call.starts_with(&[
        "im".into(),
        "chat.members".into(),
        "delete".into()
    ]) && call.iter().any(|arg| arg == "--yes")));
    assert_eq!(f.writes(), writes + 2);

    f.change(|im| im["admin"] = json!(false));
    let writes = f.writes();
    let (status, body) = send(&f.state, CIRCLES, json!({"action":"publishPreview","circleId":"design","expectedRevision":snapshot["organization"]["revision"]})).await;
    assert!(
        !status.is_success(),
        "ordinary group member was allowed to publish: {body}"
    );
    assert_eq!(f.writes(), writes);
    f.change(|im| im["admin"] = json!(true));

    // A platform write can succeed while its response is lost. Keep the
    // unknown receipt and inspect the result before authorizing another write.
    let mut org = snapshot["organization"].clone();
    org["circles"][0]["goal"] = json!("A second design milestone");
    let snapshot = save(&f, org).await;
    let publish = publish_preview(&f, &snapshot).await;
    f.change(|im| im["failUpdate"] = json!(true));
    let (status, _) = send(&f.state, CIRCLES, json!({"action":"publish","circleId":"design","ticket":publish["ticket"],"requestId":"publish-uncertain"})).await;
    assert!(!status.is_success());
    let writes = f.writes();
    assert_eq!(f.im()["description"], "目标：A second design milestone");
    let current = circles(&f, json!({"action":"read"})).await;
    let (receipt_id, receipt) = current["receipts"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(id, _)| id.ends_with(":publish-uncertain"))
        .unwrap();
    assert_eq!(receipt["status"], "unknown");
    let receipt_id = receipt_id.clone();
    let another = publish_preview(&f, &current).await;
    assert!(!send(&f.state, CIRCLES, json!({"action":"publish","circleId":"design","ticket":another["ticket"],"requestId":"publish-again"})).await.0.is_success());
    assert_eq!(
        f.writes(),
        writes,
        "uncertain publication must not be replayed under a new request id"
    );
    let verified = circles(
        &f,
        json!({"action":"verifyReceipt","circleId":"design","receiptId":receipt_id}),
    )
    .await;
    assert_eq!(verified["status"], "done");
    assert_eq!(f.writes(), writes, "receipt verification is read-only");
    f.change(|im| im["failUpdate"] = json!(false));

    let history = circles(&f, json!({"action":"history","circleId":"design"})).await;
    assert_eq!(history["messages"][0]["id"], "remote-message");
    assert_eq!(history["messages"][0]["text"], "Hello from the group");
    f.change(|im| im["partialHistory"] = json!(true));
    let partial = circles(&f, json!({"action":"history","circleId":"design"})).await;
    assert_eq!(partial["messages"][0]["id"], "remote-message");
    assert_eq!(
        partial["incomplete"], true,
        "partial history must retain available messages"
    );
    f.change(|im| im["partialHistory"] = json!(false));
    let writes = f.writes();
    assert!(!send(&f.state, CIRCLES, json!({"action":"send","circleId":"design","text":"reply","requestId":"bad-reply","replyId":"not-loaded"})).await.0.is_success());
    assert_eq!(f.writes(), writes);
    let sent = circles(&f, json!({"action":"send","circleId":"design","text":"a literal $(echo hidden) reply","requestId":"reply-first","replyId":"remote-message"})).await;
    assert_eq!(sent["status"], "sent");
    let call = f
        .calls()
        .into_iter()
        .find(|call| call.starts_with(&["im".into(), "+messages-reply".into()]))
        .unwrap();
    assert!(call
        .windows(2)
        .any(|w| w == ["--message-id", "remote-message"]));
    assert!(call
        .windows(2)
        .any(|w| w == ["--idempotency-key", "reply-first"]));
    let content = call.iter().position(|word| word == "--content").unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&call[content + 1]).unwrap(),
        json!({"text":"a literal $(echo hidden) reply"})
    );

    f.change(|im| im["failSend"] = json!(true));
    let request = json!({"action":"send","circleId":"design","text":"uncertain message","requestId":"send-uncertain"});
    assert!(!send(&f.state, CIRCLES, request.clone())
        .await
        .0
        .is_success());
    let writes = f.writes();
    assert!(!send(&f.state, CIRCLES, request.clone())
        .await
        .0
        .is_success());
    assert_eq!(f.writes(), writes, "uncertain send must not replay");
    f.restart().await;
    assert!(!send(&f.state, CIRCLES, request).await.0.is_success());
    assert_eq!(
        f.writes(),
        writes,
        "restart must preserve uncertain send receipt"
    );
    let mut changed = json!({"action":"send","circleId":"design","text":"different content","requestId":"send-uncertain"});
    assert!(!send(&f.state, CIRCLES, changed.take()).await.0.is_success());
    assert_eq!(f.writes(), writes);

    // Account verification remains independent of an otherwise-live binding.
    f.change(|im| {
        im["failSend"] = json!(false);
        im["wrongAccount"] = json!(true);
    });
    assert!(!send(&f.state, CIRCLES, json!({"action":"send","circleId":"design","text":"wrong account","requestId":"wrong-account"})).await.0.is_success());
    assert_eq!(f.writes(), writes);
    f.state.messaging.close().await;
    drop(f);
    Box::pin(dingtalk_goal_notice_and_role_contract()).await;
}

async fn dingtalk_goal_notice_and_role_contract() {
    let f = Fixture::new("dingtalk");
    f.change(|im| {
        im["group"] = json!("ding-group");
        im["name"] = json!("X-Ding team");
        im["description"] = json!("目标：Before");
        im["members"] = json!([{"id":"open-self","name":"Ding Human"}]);
    });
    ok(
        &f.state,
        "/agents/personas",
        json!({"id":"default-persona","name":"Assistant","root":f.brain,"executor":"auto"}),
    )
    .await;
    let connected = ok(
        &f.state,
        "/agents/personas/default-persona/channel-connect",
        json!({"channel":"dingtalk"}),
    )
    .await;
    assert_eq!(connected["status"], "listening");
    let initial = circles(&f, json!({"action":"read"})).await;
    assert_eq!(
        initial["channels"][0]["organization"],
        "Ding Fixture Company"
    );
    assert_eq!(initial["channels"][0]["accountName"], "Ding Human");

    // A deployed organization written by the older Node runtime remains
    // readable; importing its binding never creates a second remote group.
    let organization = json!({
        "version":1,"revision":7,"name":"Ding organization",
        "im":{"channel":"dingtalk","account":"corp:user"},
        "members":[{"id":"human","kind":"human","name":"Ding Human","identity":{"channel":"dingtalk","account":"corp:user","id":"open-self"}}],
        "circles":[{"id":"design","parentId":null,"name":"X-Ding team","goal":"After","publicDescription":"","archived":false,"members":["human"],"roles":[],"binding":{"channel":"dingtalk","account":"corp:user","id":"ding-group"},"platform":"dingtalk"}]
    });
    let file = f.brain.join(".aichat/circles/organization.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, organization.to_string()).unwrap();
    let snapshot = circles(&f, json!({"action":"read"})).await;
    let preview = publish_preview(&f, &snapshot).await;
    assert_eq!(preview["remote"]["description"], "目标：Before");
    assert_eq!(preview["desired"]["description"], "目标：After");
    assert_eq!(f.writes(), 0);
    circles(&f, json!({"action":"publish","circleId":"design","ticket":preview["ticket"],"requestId":"ding-goal-publish"})).await;
    assert_eq!(
        f.writes(),
        1,
        "only the reserved goal notice may be changed"
    );
    assert_eq!(f.im()["goalContent"], "# X:goal\n\n目标：After");
    let edits = f
        .calls()
        .into_iter()
        .filter(|call| {
            call.starts_with(&[
                "chat".into(),
                "group".into(),
                "notice".into(),
                "edit".into(),
            ])
        })
        .collect::<Vec<_>>();
    assert_eq!(edits.len(), 1);
    assert!(edits[0]
        .windows(2)
        .any(|args| args == ["--notice-id", "goal-notice"]));
    assert!(edits[0]
        .windows(2)
        .any(|args| args == ["--profile", "corp:user"]));
    assert!(edits[0].iter().any(|arg| arg == "--yes"));

    // Neither a generic directory admin string nor a regular group member
    // proves this caller is the group's owner/administrator.
    for role in ["admin", "普通成员"] {
        f.change(|im| im["role"] = json!(role));
        let (status, body) = send(
            &f.state,
            CIRCLES,
            json!({"action":"publishPreview","circleId":"design","expectedRevision":7}),
        )
        .await;
        assert!(
            !status.is_success(),
            "unverified role {role} accepted: {body}"
        );
        assert_eq!(f.writes(), 1);
    }
    f.change(|im| im["role"] = json!("群主"));
    f.change(|im| im["duplicateGoal"] = json!(true));
    let (status, body) = send(
        &f.state,
        CIRCLES,
        json!({"action":"pullPreview","circleId":"design","expectedRevision":7}),
    )
    .await;
    assert!(
        !status.is_success(),
        "ambiguous goal notices accepted: {body}"
    );
    assert_eq!(f.writes(), 1);
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(),
        organization
    );
    f.change(|im| {
        im["duplicateGoal"] = json!(false);
        im["malformedNotice"] = json!(true);
    });
    assert!(!send(
        &f.state,
        CIRCLES,
        json!({"action":"pullPreview","circleId":"design","expectedRevision":7})
    )
    .await
    .0
    .is_success());
    assert_eq!(
        f.writes(),
        1,
        "summary-only notices cannot authorize replacing an announcement"
    );
    f.state.messaging.close().await;
}
