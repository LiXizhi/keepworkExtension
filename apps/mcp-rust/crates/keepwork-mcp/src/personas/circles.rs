//! Owner-scoped circle design and explicit, receipted IM operations.
//! The brain files and daemon-local state use the Node runtime's layout.

use super::circle_channels::CircleChannels;
use super::circle_model::*;
use super::util::{now_ms, sha256_hex};
use super::view::restrict_file;
use super::*;
use std::collections::VecDeque;
use unicode_normalization::UnicodeNormalization;

pub(crate) struct Circles {
    home: PathBuf,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    previews: Mutex<VecDeque<(String, Preview)>>,
    channel: OnceLock<CircleChannels>,
    owners: Mutex<HashSet<String>>,
}

#[derive(Clone)]
struct Scope {
    owner: String,
    root: String,
    organization: String,
}

struct Preview {
    scope: Scope,
    revision: u64,
    input: Value,
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn rows(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn hash(value: &str) -> String {
    sha256_hex(&[value.as_bytes()])
}
fn stable_request(value: &Value, max: usize) -> bool {
    let text = s(value);
    !text.is_empty()
        && text.len() <= max
        && text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn revision(org: &Value, expected: &Value) -> Result<(), PersonaError> {
    if expected.as_u64() == org["revision"].as_u64() {
        Ok(())
    } else {
        Err(PersonaError::bad("组织已变化，请刷新后重新预览"))
    }
}
fn circle(org: &Value, id: &str) -> Result<Value, PersonaError> {
    rows(&org["circles"])
        .into_iter()
        .find(|c| s(&c["id"]) == id)
        .ok_or_else(|| PersonaError::bad("Unknown circle"))
}
fn replace_circle(org: &mut Value, c: Value) {
    if let Some(row) = org["circles"]
        .as_array_mut()
        .and_then(|rows| rows.iter_mut().find(|r| r["id"] == c["id"]))
    {
        *row = c;
    }
}
fn group_version(value: &Value) -> Value {
    let mut ids: Vec<String> = rows(&value["members"])
        .iter()
        .map(|m| s(&m["id"]).to_string())
        .collect();
    ids.sort();
    json!([
        value["name"],
        value.get("description").unwrap_or(&Value::Null),
        ids
    ])
}
fn record<'a>(state: &'a mut Value, key: &str) -> &'a mut Value {
    if !state["groups"][key].is_object() {
        state["groups"][key] = json!({});
    }
    &mut state["groups"][key]
}
fn safe_path(path: &Path, directory: bool) -> Result<(), PersonaError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta)
            if meta.file_type().is_symlink()
                || (directory && !meta.is_dir())
                || (!directory && !meta.is_file()) =>
        {
            Err(PersonaError::bad("Unsafe circles path"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(PersonaError::bad("无法读取圈子存储")),
    }
}
fn read_json_file(path: &Path, max: u64, empty: Value) -> Result<Value, PersonaError> {
    safe_path(path, false)?;
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty),
        Ok(meta) if meta.len() <= max => {
            let bytes = std::fs::read(path).map_err(|_| PersonaError::bad("无法读取圈子存储"))?;
            serde_json::from_slice(&bytes).map_err(|_| PersonaError::bad("Invalid circles storage"))
        }
        _ => Err(PersonaError::bad("Organization too large or unavailable")),
    }
}
fn write_json(path: &Path, value: &Value) -> Result<(), PersonaError> {
    safe_path(path, false)?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| PersonaError::bad("Invalid circles storage"))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        restrict_file(&tmp);
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
        return Err(PersonaError::bad("无法保存圈子记录，请检查本机存储"));
    }
    Ok(())
}

impl Scope {
    fn key(&self) -> String {
        hash(&format!(
            "{}\0{}{}",
            self.owner,
            self.root,
            if self.organization == "default" {
                String::new()
            } else {
                format!("\0{}", self.organization)
            }
        ))
    }
    fn file(&self, create: bool) -> Result<PathBuf, PersonaError> {
        let mut path = PathBuf::from(&self.root);
        for name in [".aichat", "circles"] {
            path.push(name);
            safe_path(&path, true)?;
            if create && !path.exists() {
                std::fs::create_dir(&path).map_err(|_| PersonaError::bad("无法创建圈子目录"))?;
            }
        }
        path.push(if self.organization == "default" {
            "organization.json".into()
        } else {
            format!("organization.{}.json", self.organization)
        });
        safe_path(&path, false)?;
        Ok(path)
    }
    fn read(&self) -> Result<Value, PersonaError> {
        organization(&read_json_file(
            &self.file(false)?,
            2_000_000,
            empty_organization(),
        )?)
    }
    fn write(&self, value: &Value, expected: &Value) -> Result<Value, PersonaError> {
        revision(&self.read()?, expected)?;
        let mut next = value.clone();
        next["revision"] = json!(expected.as_u64().unwrap_or(0) + 1);
        let next = organization(&next)?;
        if serde_json::to_vec_pretty(&next).map_or(true, |bytes| bytes.len() > 2_000_000) {
            return Err(PersonaError::bad("Organization too large"));
        }
        write_json(&self.file(true)?, &next)?;
        Ok(next)
    }
    fn organizations(&self) -> Result<Vec<(String, Value)>, PersonaError> {
        let mut ids = vec!["default".to_string()];
        if let Ok(entries) = std::fs::read_dir(self.file(false)?.parent().unwrap()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(id) = name
                    .strip_prefix("organization.")
                    .and_then(|n| n.strip_suffix(".json"))
                {
                    if valid_organization_id(id) && id != "default" {
                        ids.push(id.to_string());
                    }
                }
            }
        }
        ids[1..].sort();
        ids.into_iter()
            .map(|id| {
                let scope = Scope {
                    organization: id.clone(),
                    ..self.clone()
                };
                Ok((id, scope.read()?))
            })
            .collect()
    }
    fn bound_elsewhere(&self, binding: &Value) -> Result<bool, PersonaError> {
        Ok(self.organizations()?.iter().any(|(id, org)| {
            id != &self.organization
                && rows(&org["circles"]).iter().any(|c| {
                    c["binding"].is_object() && identity_key(&c["binding"]) == identity_key(binding)
                })
        }))
    }
}

fn valid_organization_id(id: &str) -> bool {
    id == "default"
        || (id.len() == 64
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

impl Circles {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self {
            home,
            locks: Mutex::new(HashMap::new()),
            previews: Mutex::new(VecDeque::new()),
            channel: OnceLock::new(),
            owners: Mutex::new(HashSet::new()),
        }
    }
    fn root(state: &AppState, owner: &str) -> Result<String, PersonaError> {
        let root = if state.presence.owner_client(owner).is_some() {
            state.presence.brain_root(owner)
        } else {
            state
                .personas
                .agent_root(owner, "default-persona")
                .unwrap_or_default()
        };
        if !Path::new(&root).is_absolute() || !Path::new(&root).is_dir() {
            return Err(PersonaError::bad("请绑定可用的本机第二大脑目录"));
        }
        std::fs::canonicalize(&root)
            .map_err(|_| PersonaError::bad("请绑定可用的本机第二大脑目录"))?;
        Ok(crate::paths::inspect_disk_path(&root).resolved)
    }
    fn guard(state: &AppState, scope: &Scope) -> Result<(), PersonaError> {
        if Self::root(state, &scope.owner)? != scope.root {
            return Err(PersonaError::bad("第二大脑或账号连接已变化"));
        }
        Ok(())
    }
    fn bindings(state: &AppState, scope: &Scope) -> Vec<Value> {
        state
            .messaging
            .list_binding_rows()
            .into_iter()
            .filter(|b| {
                s(&b["root"]) == scope.root
                    && (s(&b["agentOwner"]) == scope.owner
                        || rows(&b["peers"])
                            .iter()
                            .any(|p| s(&p["owner"]) == scope.owner))
            })
            .collect()
    }
    fn binding(state: &AppState, scope: &Scope, b: &Value) -> Result<Value, PersonaError> {
        Self::guard(state, scope)?;
        let b = identity(b)?;
        let found = Self::bindings(state, scope)
            .into_iter()
            .find(|row| row["channel"] == b["channel"] && row["profile"] == b["account"])
            .ok_or_else(|| PersonaError::bad("请先连接此账号的消息渠道"))?;
        if found["enabled"] != true
            || s(&found["status"]) != "listening"
            || found["transitioning"] == true
        {
            return Err(PersonaError::bad(
                "Channel unavailable or this computer is not the active gateway",
            ));
        }
        Ok(found)
    }
    fn state_file(&self, scope: &Scope, create: bool) -> Result<PathBuf, PersonaError> {
        if let Some(parent) = self.home.parent() {
            safe_path(parent, true)?;
        }
        safe_path(&self.home, true)?;
        if create {
            std::fs::create_dir_all(&self.home)
                .map_err(|_| PersonaError::bad("无法创建圈子状态目录"))?;
        }
        Ok(self.home.join(format!("{}.json", scope.key())))
    }
    fn load(&self, scope: &Scope) -> Result<Value, PersonaError> {
        let state = read_json_file(
            &self.state_file(scope, false)?,
            64_000_000,
            json!({"groups":{},"receipts":{}}),
        )?;
        if !state["groups"].is_object() || !state["receipts"].is_object() {
            return Err(PersonaError::bad("Invalid circles state"));
        }
        Ok(state)
    }
    fn save(&self, scope: &Scope, state: &Value) -> Result<(), PersonaError> {
        if serde_json::to_vec_pretty(state).map_or(true, |bytes| bytes.len() > 64_000_000) {
            return Err(PersonaError::bad(
                "Circles state too large; history was not saved",
            ));
        }
        write_json(&self.state_file(scope, true)?, state)
    }
    fn ticket(&self, scope: &Scope, org: &Value, input: Value) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut previews = self.previews.lock().unwrap();
        previews.push_back((
            id.clone(),
            Preview {
                scope: scope.clone(),
                revision: org["revision"].as_u64().unwrap_or(0),
                input,
            },
        ));
        if previews.len() > 100 {
            previews.pop_front();
        }
        id
    }
    fn consume(&self, scope: &Scope, org: &Value, ticket: &Value) -> Result<Value, PersonaError> {
        let mut previews = self.previews.lock().unwrap();
        let index = previews
            .iter()
            .position(|(id, p)| id == s(ticket) && p.scope.key() == scope.key())
            .ok_or_else(|| PersonaError::bad("请重新预览"))?;
        revision(org, &json!(previews[index].1.revision))?;
        Ok(previews.remove(index).unwrap().1.input)
    }
    async fn snapshot(
        &self,
        app: &AppState,
        scope: &Scope,
        org: &Value,
        state: &Value,
        channel: &CircleChannels,
    ) -> Result<Value, PersonaError> {
        let mut channels = Vec::new();
        for b in Self::bindings(app, scope) {
            let mut label = Box::pin(channel.account_label(
                &scope.root,
                &json!({"channel":b["channel"],"account":b["profile"],"id":"label"}),
            ))
            .await?;
            if !label.is_object() {
                label = json!({});
            }
            label["channel"] = b["channel"].clone();
            label["account"] = b["profile"].clone();
            label["enabled"] = b["enabled"].clone();
            label["available"] = json!(
                b["enabled"] == true
                    && s(&b["status"]) == "listening"
                    && b["transitioning"] != true
            );
            channels.push(label);
        }
        Self::guard(app, scope)?;
        let organizations: Vec<Value> = scope
            .organizations()?
            .iter()
            .map(|(id, o)| json!({"id":id,"name":o["name"]}))
            .collect();
        let agents: Vec<Value> = rows(&app.personas.list(&scope.owner)["agents"])
            .iter()
            .map(|p| json!({"id":p["id"],"name":p["name"]}))
            .collect();
        let keys: HashSet<String> = rows(&org["circles"])
            .iter()
            .filter(|c| c["binding"].is_object())
            .map(|c| identity_key(&c["binding"]))
            .collect();
        let sync: Map<String, Value> = state["groups"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| keys.contains(*key))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Ok(
            json!({"scope":scope.key(),"organizationId":scope.organization,"organizations":organizations,"organization":org,
            "agents":agents,"channels":channels,"sync":sync,"receipts":state["receipts"],"discovery":state.get("discovery").cloned().unwrap_or(json!({})),
            "memberSync":if org["im"].is_object() { state["memberSync"][serde_json::to_string(&org["im"]).unwrap()].clone() } else { Value::Null }}),
        )
    }
    fn check_names(&self, app: &AppState, scope: &Scope, org: &Value) -> Result<(), PersonaError> {
        let agents = rows(&app.personas.list(&scope.owner)["agents"]);
        let mut names: HashMap<String, String> = HashMap::new();
        let mut add = |agent: &Value, binding: &Value| -> Result<(), PersonaError> {
            let name = s(&agent["name"]).nfkc().collect::<String>();
            let key = serde_json::to_string(&json!([
                binding["channel"],
                binding["account"],
                name.trim().to_lowercase()
            ]))
            .unwrap();
            if names
                .insert(key, s(&agent["id"]).to_string())
                .is_some_and(|old| old != s(&agent["id"]))
            {
                return Err(PersonaError::bad("同一消息账号的智能体名称必须唯一"));
            }
            Ok(())
        };
        for agent in &agents {
            if agent["messaging"]["enabled"] == true {
                for binding in rows(&agent["messaging"]["groups"]) {
                    add(agent, &binding)?;
                }
            }
        }
        let mut all = scope
            .organizations()?
            .into_iter()
            .filter(|(id, _)| id != &scope.organization)
            .map(|(_, org)| org)
            .collect::<Vec<_>>();
        all.push(org.clone());
        for organization in all {
            for c in rows(&organization["circles"]) {
                if c["archived"] == true || !c["binding"].is_object() {
                    continue;
                }
                for member in circle_members(&organization, &c) {
                    if member["kind"] != "persona" {
                        continue;
                    }
                    let agent = agents
                        .iter()
                        .find(|a| a["id"] == member["personaId"])
                        .ok_or_else(|| {
                            PersonaError::bad("圈子中有已删除的智能体，请移除其角色分配")
                        })?;
                    add(agent, &c["binding"])?;
                }
            }
        }
        Ok(())
    }
    async fn projected(
        &self,
        app: &AppState,
        scope: &Scope,
        org: &Value,
        c: &Value,
        channel: &CircleChannels,
    ) -> Result<Value, PersonaError> {
        let mut result = circle_snapshot(org, c);
        let personas: Vec<Value> = circle_members(org, c)
            .into_iter()
            .filter(|m| m["kind"] == "persona")
            .collect();
        let mut operators = Vec::new();
        if !personas.is_empty() && c["binding"].is_object() {
            for m in &personas {
                if app
                    .personas
                    .agent_root(&scope.owner, s(&m["personaId"]))
                    .as_deref()
                    != Some(scope.root.as_str())
                {
                    return Err(PersonaError::bad("Agent 必须属于当前真人账号及第二大脑"));
                }
            }
            let mut human = Box::pin(channel.operator(&scope.root, &c["binding"])).await?;
            Self::binding(app, scope, &c["binding"])?;
            let mut identity = c["binding"].clone();
            identity["id"] = human["id"].clone();
            if let Some(known) = rows(&org["members"]).iter().find(|m| {
                m["kind"] == "human"
                    && m["identity"].is_object()
                    && identity_key(&m["identity"]) == identity_key(&identity)
            }) {
                human["name"] = known["name"].clone();
            }
            if !rows(&result["members"])
                .iter()
                .any(|m| m["id"] == human["id"])
            {
                result["members"]
                    .as_array_mut()
                    .unwrap()
                    .push(human.clone());
            }
            for m in personas {
                operators.push(json!({"personaId":m["personaId"],"name":m["name"],"human":human,"channel":c["binding"]["channel"],"account":c["binding"]["account"]}));
            }
        }
        result["operators"] = json!(operators);
        Ok(result)
    }
    fn import_members(org: &mut Value, id: &str, remote: &Value) -> Result<(), PersonaError> {
        let mut c = circle(org, id)?;
        let matches = |m: &Value| {
            m["identity"].is_object()
                && m["identity"]["channel"] == c["binding"]["channel"]
                && m["identity"]["account"] == c["binding"]["account"]
        };
        let desired: HashSet<String> = rows(&remote["members"])
            .iter()
            .map(|m| s(&m["id"]).into())
            .collect();
        let removed: HashSet<String> = rows(&org["members"])
            .iter()
            .filter(|m| matches(m) && !desired.contains(s(&m["identity"]["id"])))
            .map(|m| s(&m["id"]).into())
            .collect();
        c["members"]
            .as_array_mut()
            .unwrap()
            .retain(|id| !removed.contains(s(id)));
        for role in c["roles"].as_array_mut().unwrap() {
            role["holders"]
                .as_array_mut()
                .unwrap()
                .retain(|id| !removed.contains(s(id)));
            if role["primaryHolder"].is_string()
                && !rows(&role["holders"]).contains(&role["primaryHolder"])
            {
                role["primaryHolder"] = Value::Null;
            }
        }
        for remote in rows(&remote["members"]) {
            let mut identity = c["binding"].clone();
            identity["id"] = remote["id"].clone();
            let existing = rows(&org["members"]).into_iter().find(|m| {
                m["identity"].is_object() && identity_key(&m["identity"]) == identity_key(&identity)
            });
            let member = existing.unwrap_or_else(|| json!({"id":uuid::Uuid::new_v4().to_string(),"name":remote["name"],"kind":"human","identity":identity}));
            if !rows(&org["members"])
                .iter()
                .any(|m| m["id"] == member["id"])
            {
                org["members"].as_array_mut().unwrap().push(member.clone());
            }
            if !circle_members(org, &c)
                .iter()
                .any(|m| m["id"] == member["id"])
            {
                c["members"]
                    .as_array_mut()
                    .unwrap()
                    .push(member["id"].clone());
            }
        }
        c["name"] = remote["name"].clone();
        if remote["description"].is_string()
            && s(&c["goal"]).trim().is_empty()
            && rows(&c["roles"]).is_empty()
        {
            c["publicDescription"] = remote["description"].clone();
        }
        replace_circle(org, c);
        Ok(())
    }
    async fn effect<F: std::future::Future<Output = Result<Value, PersonaError>>>(
        &self,
        scope: &Scope,
        state: &mut Value,
        key: &str,
        payload: &str,
        intent: Value,
        future: F,
    ) -> Result<Value, PersonaError> {
        if let Some(previous) = state["receipts"].get(key) {
            if s(&previous["payloadHash"]) != payload {
                return Err(PersonaError::bad(
                    "Request ID was already used for different content",
                ));
            }
            return if previous["status"] == "done" {
                Ok(previous["value"].clone())
            } else {
                Err(PersonaError::bad("操作结果待核实，未自动重试"))
            };
        }
        state["receipts"][key] = json!({"status":"unknown","time":now_ms(),"payloadHash":payload});
        if !intent.is_null() {
            state["receipts"][key]["intent"] = intent;
        }
        self.save(scope, state)?;
        match future.await {
            Ok(value) => {
                state["receipts"][key]["status"] = json!("done");
                state["receipts"][key]["value"] = value.clone();
                state["receipts"][key]["time"] = json!(now_ms());
                self.save(scope, state)?;
                Ok(value)
            }
            Err(error) => {
                state["receipts"][key]["error"] = json!(error.message);
                self.save(scope, state)?;
                Err(error)
            }
        }
    }
    pub(crate) async fn request(
        &self,
        app: &AppState,
        owner: &str,
        input: &Value,
    ) -> Result<Value, PersonaError> {
        self.owners.lock().unwrap().insert(owner.to_string());
        let root = Self::root(app, owner)?;
        let id = input
            .get("organizationId")
            .and_then(Value::as_str)
            .unwrap_or("default");
        if input
            .get("organizationId")
            .is_some_and(|v| !v.is_null() && !v.is_string())
            || !valid_organization_id(id)
        {
            return Err(PersonaError::bad("Invalid organization ID"));
        }
        let scope = Scope {
            owner: owner.into(),
            root,
            organization: id.into(),
        };
        let lock = self
            .locks
            .lock()
            .unwrap()
            .entry(scope.root.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        Self::guard(app, &scope)?;
        if id != "default" && !scope.file(false)?.exists() {
            return Err(PersonaError::bad("组织不存在，请重新选择"));
        }
        if input
            .get("expectedScope")
            .is_some_and(|value| value.as_str() != Some(scope.key().as_str()))
        {
            return Err(PersonaError::bad("第二大脑已切换，请重新读取圈子"));
        }
        let channel = self
            .channel
            .get_or_init(|| CircleChannels::new(Arc::clone(&app.messaging)));
        Box::pin(self.run(app, &scope, channel, input)).await
    }
    pub(crate) async fn refresh_registered(&self, app: &AppState) {
        let owners: Vec<String> = self.owners.lock().unwrap().iter().cloned().collect();
        for owner in owners {
            let Ok(root) = Self::root(app, &owner) else {
                continue;
            };
            let scope = Scope {
                owner: owner.clone(),
                root,
                organization: "default".into(),
            };
            let Ok(organizations) = scope.organizations() else {
                continue;
            };
            for (id, _) in organizations {
                let target = Scope {
                    organization: id.clone(),
                    ..scope.clone()
                };
                let _ = Box::pin(self.request(
                    app,
                    &owner,
                    &json!({"action":"refresh","organizationId":id,"expectedScope":target.key()}),
                ))
                .await;
            }
        }
    }
    async fn run(
        &self,
        app: &AppState,
        scope: &Scope,
        channel: &CircleChannels,
        input: &Value,
    ) -> Result<Value, PersonaError> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("read");
        let org = scope.read()?;
        let state = self.load(scope)?;
        match action {
            "read" | "createOrganization" | "preview" | "apply" | "membersPreview" | "search"
            | "refresh" => Box::pin(self.run_local(app, scope, channel, input, org, state)).await,
            "deployPreview" | "deploy" | "unbind" => {
                Box::pin(self.run_deploy(app, scope, channel, input, org, state)).await
            }
            _ => Box::pin(self.run_bound(app, scope, channel, input, org, state)).await,
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn run_local(
        &self,
        app: &AppState,
        scope: &Scope,
        channel: &CircleChannels,
        input: &Value,
        mut org: Value,
        mut state: Value,
    ) -> Result<Value, PersonaError> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("read");
        let check = || Self::guard(app, scope);
        match action {
            "read" => return Box::pin(self.snapshot(app, scope, &org, &state, channel)).await,
            "createOrganization" => {
                revision(&org, &input["expectedRevision"])?;
                let name = s(&input["name"]).trim();
                if name.is_empty()
                    || name.encode_utf16().count() > 80
                    || !stable_request(&input["requestId"], 80)
                {
                    return Err(PersonaError::bad("Invalid organization name or request ID"));
                }
                let target = Scope {
                    organization: hash(&format!("{}\0{}", scope.owner, s(&input["requestId"]))),
                    ..scope.clone()
                };
                let mut organization = target.read()?;
                if target.file(false)?.exists() {
                    if organization["name"] != name {
                        return Err(PersonaError::bad(
                            "Request ID was already used for different content",
                        ));
                    }
                } else {
                    organization["name"] = json!(name);
                    organization = target.write(&organization, &json!(0))?;
                }
                return Box::pin(self.snapshot(
                    app,
                    &target,
                    &organization,
                    &self.load(&target)?,
                    channel,
                ))
                .await;
            }
            "preview" => {
                revision(&org, &input["expectedRevision"])?;
                let mut next = input["organization"].clone();
                if !next.is_object() {
                    return Err(PersonaError::bad("Invalid organization"));
                }
                next["revision"] = org["revision"].clone();
                let next = organization(&next)?;
                if next["im"].is_object() {
                    let mut b = next["im"].clone();
                    b["id"] = json!("organization");
                    Self::binding(app, scope, &b)?;
                }
                for c in rows(&org["circles"]) {
                    if !c["binding"].is_object() {
                        continue;
                    }
                    let changed = circle(&next, s(&c["id"])).unwrap_or(Value::Null);
                    if !changed["binding"].is_object()
                        || identity_key(&changed["binding"]) != identity_key(&c["binding"])
                    {
                        return Err(PersonaError::bad("请通过解绑操作解除群关联"));
                    }
                }
                for c in rows(&next["circles"]) {
                    if c["binding"].is_object()
                        && !rows(&org["circles"]).iter().any(|old| {
                            old["id"] == c["id"]
                                && old["binding"].is_object()
                                && identity_key(&old["binding"]) == identity_key(&c["binding"])
                        })
                    {
                        return Err(PersonaError::bad("请通过部署操作绑定群"));
                    }
                }
                let agents = rows(&app.personas.list(&scope.owner)["agents"]);
                for m in rows(&next["members"]) {
                    if m["kind"] == "persona"
                        && !agents.iter().any(|a| a["id"] == m["personaId"])
                        && !rows(&org["members"])
                            .iter()
                            .any(|old| old["id"] == m["id"] && old["personaId"] == m["personaId"])
                    {
                        return Err(PersonaError::bad("Unknown persona"));
                    }
                }
                self.check_names(app, scope, &next)?;
                return Ok(
                    json!({"ticket":self.ticket(scope,&org,next.clone()),"before":org,"after":next}),
                );
            }
            "apply" => {
                let p = self.consume(scope, &org, &input["ticket"])?;
                let mut next = p.clone();
                if p["kind"] == "members" {
                    next = p["organization"].clone();
                    let mut b = next["im"].clone();
                    b["id"] = json!("organization");
                    Self::binding(app, scope, &b)?;
                    if !state["memberSync"].is_object() {
                        state["memberSync"] = json!({});
                    }
                    state["memberSync"][serde_json::to_string(&next["im"]).unwrap()] = json!({"lastSynced":now_ms(),"count":p["count"],"groups":p["groups"],"source":p["source"],"limit":p["limit"],"limited":p["limited"]});
                } else if p["kind"] == "pull" {
                    Self::binding(app, scope, &p["binding"])?;
                    let remote =
                        Box::pin(channel.snapshot(&scope.root, &p["binding"], &check)).await?;
                    Self::binding(app, scope, &p["binding"])?;
                    if group_version(&remote) != group_version(&p["remote"]) {
                        return Err(PersonaError::bad("群资料已变化，请重新从群预览"));
                    }
                    next = p["organization"].clone();
                    let projected = Box::pin(self.projected(
                        app,
                        scope,
                        &next,
                        &circle(&next, s(&p["circleId"]))?,
                        channel,
                    ))
                    .await?;
                    let r = record(&mut state, &identity_key(&p["binding"]));
                    r["base"] = remote.clone();
                    r["conflicts"] = json!([]);
                    r["decisions"] = json!({});
                    r["lastSynced"] = json!(now_ms());
                    r["operators"] = json!(rows(&projected["operators"])
                        .into_iter()
                        .map(|mut o| {
                            o["present"] = json!(rows(&remote["members"])
                                .iter()
                                .any(|m| m["id"] == o["human"]["id"]));
                            o
                        })
                        .collect::<Vec<_>>());
                    r["pendingPublish"] =
                        json!(group_version(&remote) != group_version(&projected));
                }
                check()?;
                org = scope.write(&next, &org["revision"])?;
                if p["kind"].is_string() {
                    self.save(scope, &state)?;
                }
                return Box::pin(self.snapshot(app, scope, &org, &state, channel)).await;
            }
            "membersPreview" => {
                revision(&org, &input["expectedRevision"])?;
                if !org["im"].is_object() {
                    return Err(PersonaError::bad("请先配置组织 IM 平台与账号"));
                }
                let mut b = org["im"].clone();
                b["id"] = json!("organization");
                Self::binding(app, scope, &b)?;
                let guard = || Self::binding(app, scope, &b).map(|_| ());
                let result = Box::pin(channel.directory(&scope.root, &b, &guard)).await?;
                guard()?;
                let mut next = org.clone();
                for remote in rows(&result["members"]) {
                    let mut identity = b.clone();
                    identity["id"] = remote["id"].clone();
                    if let Some(m) = next["members"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|m| {
                            m["kind"] == "human"
                                && m["identity"].is_object()
                                && identity_key(&m["identity"]) == identity_key(&identity)
                        })
                    {
                        m["name"] = remote["name"].clone();
                    } else {
                        next["members"].as_array_mut().unwrap().push(json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"human","name":remote["name"],"identity":identity}));
                    }
                }
                let next = organization(&next)?;
                let info = json!({"count":rows(&result["members"]).len(),"groups":result["groups"],"source":result["source"],"limit":result["limit"],"limited":result["limited"]});
                let mut p = info.clone();
                p["kind"] = json!("members");
                p["organization"] = next.clone();
                return Ok(
                    json!({"ticket":self.ticket(scope,&org,p),"before":org,"after":next,"memberSync":info}),
                );
            }
            "search" => {
                let b = identity(
                    &json!({"channel":input["channel"],"account":input["account"],"id":"search"}),
                )?;
                Self::binding(app, scope, &b)?;
                let query = s(&input["query"]).chars().take(64).collect::<String>();
                let result =
                    Box::pin(channel.search(&scope.root, &b, &query, input["contacts"] == true))
                        .await?;
                Self::binding(app, scope, &b)?;
                return Ok(json!({"items":result}));
            }
            "refresh" => {
                Box::pin(self.discover(app, scope, &mut org, &mut state, channel)).await?;
                for c in rows(&org["circles"]) {
                    if !c["binding"].is_object() || c["archived"] == true {
                        continue;
                    }
                    let result = async {
                        Box::pin(self.sync(
                            app,
                            scope,
                            &mut org,
                            s(&c["id"]),
                            &mut state,
                            None,
                            channel,
                        ))
                        .await?;
                        Box::pin(self.catchup(app, scope, &c, &mut state, channel)).await
                    }
                    .await;
                    if let Err(error) = result {
                        record(&mut state, &identity_key(&c["binding"]))["error"] =
                            json!(error.message);
                        self.save(scope, &state)?;
                    }
                }
                return Box::pin(self.snapshot(app, scope, &org, &state, channel)).await;
            }
            _ => {}
        }
        Err(PersonaError::bad("Unknown circles action"))
    }
    #[allow(clippy::too_many_arguments)]
    async fn run_deploy(
        &self,
        app: &AppState,
        scope: &Scope,
        channel: &CircleChannels,
        input: &Value,
        mut org: Value,
        mut state: Value,
    ) -> Result<Value, PersonaError> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("read");
        let id = s(&input["circleId"]);
        let mut c = circle(&org, id)?;
        if action == "deployPreview" {
            revision(&org, &input["expectedRevision"])?;
            if c["archived"] == true || c["binding"].is_object() {
                return Err(PersonaError::bad("Circle is archived or already bound"));
            }
            if org["im"].is_object()
                && (org["im"]["channel"] != input["channel"]
                    || org["im"]["account"] != input["account"])
            {
                return Err(PersonaError::bad("请选择组织配置的 IM 账号"));
            }
            if c["platform"].is_string() && c["platform"] != input["channel"] {
                return Err(PersonaError::bad("请选择圈子指定的平台"));
            }
            let create = s(&input["groupId"]).is_empty();
            let b = identity(
                &json!({"channel":input["channel"],"account":input["account"],"id":if create {"new"}else{s(&input["groupId"])}}),
            )?;
            Self::binding(app, scope, &b)?;
            if !create
                && (scope.bound_elsewhere(&b)?
                    || rows(&org["circles"]).iter().any(|c| {
                        c["binding"].is_object()
                            && c["archived"] != true
                            && identity_key(&c["binding"]) == identity_key(&b)
                    }))
            {
                return Err(PersonaError::bad("此群已绑定其他圈子"));
            }
            Box::pin(channel.verify(&scope.root, &b)).await?;
            Self::binding(app, scope, &b)?;
            c["binding"] = b.clone();
            let mut next = org.clone();
            replace_circle(&mut next, c.clone());
            self.check_names(app, scope, &next)?;
            Self::check_humans(&org, &c, &b)?;
            let guard = || {
                Self::binding(app, scope, &b)?;
                revision(&scope.read()?, &org["revision"])
            };
            let target = if create {
                Value::Null
            } else {
                Box::pin(channel.snapshot(&scope.root, &b, &guard)).await?
            };
            let mut desired = Box::pin(self.projected(app, scope, &org, &c, channel)).await?;
            if create && !s(&desired["name"]).starts_with("X-") {
                desired["name"] = json!(format!("X-{}", s(&desired["name"])));
            }
            validate_group_description(&b, &desired)?;
            let type_ = if input["type"] == "EXTERNAL" {
                "EXTERNAL"
            } else {
                "INTERNAL"
            };
            if create {
                Box::pin(channel.create(&scope.root, &b, &desired, type_, true, &guard)).await?;
            }
            guard()?;
            let payload = json!({"kind":"deploy","circleId":id,"binding":b,"create":create,"type":type_,"desired":desired});
            let mut response = payload.clone();
            response["ticket"] = json!(self.ticket(scope, &org, payload));
            response["target"] = target;
            response["personas"] = json!(circle_members(&org, &c)
                .into_iter()
                .filter(|m| m["kind"] == "persona")
                .collect::<Vec<_>>());
            response["operators"] = desired["operators"].clone();
            return Ok(response);
        }
        if action == "deploy" {
            let mut p = self.consume(scope, &org, &input["ticket"])?;
            if p["kind"] != "deploy"
                || p["circleId"] != c["id"]
                || c["binding"].is_object()
                || c["archived"] == true
            {
                return Err(PersonaError::bad("Preview does not match circle"));
            }
            let b = p["binding"].clone();
            Self::binding(app, scope, &b)?;
            let key = format!("deploy:{id}:{}", hash(&serde_json::to_string(&p).unwrap()));
            let guard = || {
                Self::binding(app, scope, &b)?;
                revision(&scope.read()?, &org["revision"])
            };
            if p["create"] == true {
                if state["receipts"].as_object().unwrap().iter().any(|(k, r)| {
                    k.starts_with(&format!("deploy:{id}:")) && r["status"] == "unknown"
                }) {
                    return Err(PersonaError::bad(
                        "建群结果待核实，请先查找并绑定已经创建的群",
                    ));
                }
                let group_id = Box::pin(self.effect(
                    scope,
                    &mut state,
                    &key,
                    "",
                    Value::Null,
                    channel.create(&scope.root, &b, &p["desired"], s(&p["type"]), false, &guard),
                ))
                .await?;
                p["binding"]["id"] = group_id;
            }
            guard()?;
            if scope.bound_elsewhere(&p["binding"])? {
                return Err(PersonaError::bad("此群已绑定其他组织的圈子"));
            }
            c["binding"] = p["binding"].clone();
            c["platform"] = p["binding"]["channel"].clone();
            if p["create"] == true {
                c["name"] = p["desired"]["name"].clone();
            }
            replace_circle(&mut org, c.clone());
            org = scope.write(&org, &org["revision"])?;
            let b = &c["binding"];
            let guard = || {
                Self::binding(app, scope, b)?;
                revision(&scope.read()?, &org["revision"])
            };
            if p["create"] == true {
                Box::pin(channel.require_owner(&scope.root, b)).await?;
            }
            let remote = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
            guard()?;
            if p["create"] != true {
                let mut combined = remote.clone();
                combined["name"] = c["name"].clone();
                combined["description"] = c["publicDescription"].clone();
                for member in rows(&p["desired"]["members"]) {
                    if !rows(&combined["members"])
                        .iter()
                        .any(|m| m["id"] == member["id"])
                    {
                        combined["members"].as_array_mut().unwrap().push(member);
                    }
                }
                Self::import_members(&mut org, id, &combined)?;
                org = scope.write(&org, &org["revision"])?;
            }
            record(&mut state, &identity_key(b))["base"] = remote.clone();
            self.save(scope, &state)?;
            if p["create"] == true
                && b["channel"] == "dingtalk"
                && remote["description"] != p["desired"]["description"]
            {
                let operation = format!("publish:{}:initial-goal", identity_key(b));
                let intent = json!({"kind":"publish","circleId":id,"binding":b,"remote":remote,"desired":p["desired"],"remove":[]});
                let guard = || {
                    Self::binding(app, scope, b)?;
                    revision(&scope.read()?, &org["revision"])
                };
                Box::pin(self.effect(
                    scope,
                    &mut state,
                    &operation,
                    &hash(&serde_json::to_string(&intent).unwrap()),
                    intent.clone(),
                    async {
                        Box::pin(channel.update(
                            &scope.root,
                            b,
                            &p["desired"],
                            &remote,
                            &[],
                            &guard,
                        ))
                        .await?;
                        let actual = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                        guard()?;
                        if group_version(&actual) != group_version(&p["desired"]) {
                            return Err(PersonaError::bad("X:goal 公告结果待核实"));
                        }
                        Ok(Value::Null)
                    },
                ))
                .await?;
            }
            if p["create"] != true {
                for (key, receipt) in state["receipts"].as_object_mut().unwrap() {
                    if key.starts_with(&format!("deploy:{id}:")) && receipt["status"] == "unknown" {
                        receipt["status"] = json!("linked");
                        receipt["linkedGroup"] = b.clone();
                        receipt["verifiedAt"] = json!(now_ms());
                    }
                }
                self.save(scope, &state)?;
            }
            Box::pin(self.sync(app, scope, &mut org, id, &mut state, None, channel)).await?;
            return Box::pin(self.snapshot(app, scope, &org, &state, channel)).await;
        }
        if action == "unbind" {
            revision(&org, &input["expectedRevision"])?;
            if input["confirm"] != true {
                return Err(PersonaError::bad("请确认解绑，外部群将保留"));
            }
            if c["binding"].is_object() {
                record(&mut state, &identity_key(&c["binding"]))["ignored"] = json!(true);
                self.save(scope, &state)?;
            }
            c.as_object_mut().unwrap().remove("binding");
            replace_circle(&mut org, c);
            org = scope.write(&org, &org["revision"])?;
            return Box::pin(self.snapshot(app, scope, &org, &state, channel)).await;
        }
        Err(PersonaError::bad("Unknown circles action"))
    }
    #[allow(clippy::too_many_arguments)]
    async fn run_bound(
        &self,
        app: &AppState,
        scope: &Scope,
        channel: &CircleChannels,
        input: &Value,
        mut org: Value,
        mut state: Value,
    ) -> Result<Value, PersonaError> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("read");
        let id = s(&input["circleId"]);
        let c = circle(&org, id)?;
        if !c["binding"].is_object() || c["archived"] == true {
            return Err(PersonaError::bad("请选择已部署的活动圈子"));
        }
        let b = &c["binding"];
        let binding = Self::binding(app, scope, b)?;
        let key = identity_key(b);
        let guard = || {
            Self::binding(app, scope, b)?;
            revision(&scope.read()?, &org["revision"])
        };
        match action {
            "pullPreview" => {
                revision(&org, &input["expectedRevision"])?;
                let remote = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                guard()?;
                let mut next = org.clone();
                Self::import_members(&mut next, id, &remote)?;
                if let Some(description) = remote["description"].as_str() {
                    import_circle_description(&mut next, id, description)?;
                }
                let next = organization(&next)?;
                self.check_names(app, scope, &next)?;
                let payload = json!({"kind":"pull","organization":next,"circleId":id,"binding":b,"remote":remote});
                Ok(
                    json!({"ticket":self.ticket(scope,&org,payload),"before":org,"after":next,"source":{"binding":b,"snapshot":remote}}),
                )
            }
            "publishPreview" => {
                revision(&org, &input["expectedRevision"])?;
                Box::pin(channel.require_owner(&scope.root, b)).await?;
                let remote = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                guard()?;
                Self::check_humans(&org, &c, b)?;
                let mut desired = Box::pin(self.projected(app, scope, &org, &c, channel)).await?;
                if remote.get("description").is_none() {
                    desired.as_object_mut().unwrap().remove("description");
                }
                validate_group_description(b, &desired)?;
                let remove: Vec<Value> = rows(&remote["members"])
                    .iter()
                    .filter(|m| !rows(&desired["members"]).iter().any(|d| d["id"] == m["id"]))
                    .map(|m| m["id"].clone())
                    .collect();
                let mut payload = json!({"kind":"publish","circleId":id,"binding":b,"remote":remote,"desired":desired,"remove":remove});
                payload["ticket"] = json!(self.ticket(scope, &org, payload.clone()));
                Ok(payload)
            }
            "publish" => {
                if !stable_request(&input["requestId"], 50) {
                    return Err(PersonaError::bad("Invalid request ID"));
                }
                let p = self.consume(scope, &org, &input["ticket"])?;
                if p["kind"] != "publish"
                    || p["circleId"] != c["id"]
                    || identity_key(&p["binding"]) != key
                {
                    return Err(PersonaError::bad("Preview does not match circle"));
                }
                Box::pin(channel.require_owner(&scope.root, b)).await?;
                let remote = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                guard()?;
                if group_version(&remote) != group_version(&p["remote"]) {
                    return Err(PersonaError::bad("群已变化，请刷新后重新预览"));
                }
                let operation = format!("publish:{key}:{}", s(&input["requestId"]));
                if state["receipts"].as_object().unwrap().iter().any(|(k, r)| {
                    k.starts_with(&format!("publish:{key}:")) && r["status"] == "unknown"
                }) {
                    return Err(PersonaError::bad(
                        "操作结果待核实，请先在平台核实已完成步骤",
                    ));
                }
                let remove: Vec<String> = rows(&p["remove"])
                    .iter()
                    .map(|m| s(m).to_string())
                    .collect();
                let verified = Box::pin(self.effect(
                    scope,
                    &mut state,
                    &operation,
                    &hash(&serde_json::to_string(&p).unwrap()),
                    json!({"kind":"publish","binding":b,"desired":p["desired"]}),
                    async {
                        Box::pin(channel.update(
                            &scope.root,
                            b,
                            &p["desired"],
                            &remote,
                            &remove,
                            &guard,
                        ))
                        .await?;
                        let actual = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                        guard()?;
                        if group_version(&actual) != group_version(&p["desired"]) {
                            return Err(PersonaError::bad("群更新部分完成，请刷新核实"));
                        }
                        Ok(actual)
                    },
                ))
                .await?;
                let r = record(&mut state, &key);
                r["base"] = verified;
                r["pendingPublish"] = json!(false);
                r["conflicts"] = json!([]);
                r["decisions"] = json!({});
                r["lastSynced"] = json!(now_ms());
                for (k, r) in state["receipts"].as_object_mut().unwrap() {
                    if k.starts_with(&format!("publish:{key}:")) && r["status"] == "reviewed" {
                        r["status"] = json!("superseded");
                        r["resolvedBy"] = json!(operation);
                    }
                }
                self.save(scope, &state)?;
                Box::pin(self.snapshot(app, scope, &org, &state, channel)).await
            }
            "verifyReceipt" => {
                let receipt_id = s(&input["receiptId"]);
                let receipt = state["receipts"][receipt_id].clone();
                if receipt["status"] != "unknown"
                    || receipt["intent"]["kind"] != "publish"
                    || identity_key(&receipt["intent"]["binding"]) != key
                {
                    return Err(PersonaError::bad("此回执无法通过当前群核实"));
                }
                let actual = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
                guard()?;
                let complete =
                    group_version(&actual) == group_version(&receipt["intent"]["desired"]);
                let status = if complete { "done" } else { "reviewed" };
                state["receipts"][receipt_id]["status"] = json!(status);
                state["receipts"][receipt_id]["verifiedAt"] = json!(now_ms());
                state["receipts"][receipt_id]["observed"] = actual.clone();
                if complete {
                    state["receipts"][receipt_id]["value"] = Value::Null;
                }
                let mut projected = Box::pin(self.projected(app, scope, &org, &c, channel)).await?;
                if actual.get("description").is_none() {
                    projected.as_object_mut().unwrap().remove("description");
                }
                let r = record(&mut state, &key);
                r["pendingPublish"] = json!(group_version(&actual) != group_version(&projected));
                if complete {
                    r["base"] = actual.clone();
                    r["lastSynced"] = json!(now_ms());
                    if r["pendingPublish"] == false {
                        r["conflicts"] = json!([]);
                        r["decisions"] = json!({});
                    }
                }
                self.save(scope, &state)?;
                Ok(
                    json!({"status":status,"expected":receipt["intent"]["desired"],"actual":actual,"snapshot":Box::pin(self.snapshot(app,scope,&org,&state,channel)).await?}),
                )
            }
            "resolve" => {
                revision(&org, &input["expectedRevision"])?;
                if !input["resolutions"].is_object()
                    || input["resolutions"]
                        .as_object()
                        .unwrap()
                        .values()
                        .any(|v| v != "local" && v != "remote")
                {
                    return Err(PersonaError::bad("Invalid conflict resolution"));
                }
                Box::pin(self.sync(
                    app,
                    scope,
                    &mut org,
                    id,
                    &mut state,
                    Some(&input["resolutions"]),
                    channel,
                ))
                .await?;
                Box::pin(self.snapshot(app, scope, &org, &state, channel)).await
            }
            "history" => {
                let page = Box::pin(channel.history(&scope.root, b, s(&input["cursor"]))).await?;
                guard()?;
                Self::merge_messages(record(&mut state, &key), &page);
                record(&mut state, &key)["cursor"] = page["cursor"].clone();
                self.save(scope, &state)?;
                Ok(page)
            }
            "send" => {
                let text = s(&input["text"]);
                if text.trim().is_empty()
                    || text.encode_utf16().count() > 16000
                    || !stable_request(&input["requestId"], 50)
                {
                    return Err(PersonaError::bad("Invalid message"));
                }
                let reply = if s(&input["replyId"]).is_empty() {
                    None
                } else {
                    Some(
                        rows(&state["groups"][&key]["messages"])
                            .into_iter()
                            .find(|m| m["id"] == input["replyId"])
                            .ok_or_else(|| PersonaError::bad("请先加载被回复消息"))?,
                    )
                };
                guard()?;
                let agent = if s(&binding["agentOwner"]) == scope.owner {
                    s(&binding["agentId"]).to_string()
                } else {
                    rows(&binding["peers"])
                        .iter()
                        .find(|p| s(&p["owner"]) == scope.owner)
                        .map(|p| s(&p["agentId"]).to_string())
                        .unwrap_or_default()
                };
                app.messaging
                    .inbox_action(
                        &scope.owner,
                        &agent,
                        s(&binding["id"]),
                        s(&b["id"]),
                        "pause",
                    )
                    .map_err(MessageError::into_persona_error)?;
                Box::pin(self.effect(
                    scope,
                    &mut state,
                    &format!("send:{key}:{}", s(&input["requestId"])),
                    &hash(&serde_json::to_string(&json!([text, s(&input["replyId"])])).unwrap()),
                    Value::Null,
                    channel.send(
                        &scope.root,
                        b,
                        s(&input["requestId"]),
                        text,
                        reply.as_ref(),
                        &guard,
                    ),
                ))
                .await?;
                Ok(json!({"status":"sent"}))
            }
            _ => Err(PersonaError::bad("Unknown circles action")),
        }
    }
    fn check_humans(org: &Value, c: &Value, b: &Value) -> Result<(), PersonaError> {
        if circle_members(org, c)
            .iter()
            .filter(|m| m["kind"] == "human")
            .any(|m| {
                !m["identity"].is_object()
                    || m["identity"]["channel"] != b["channel"]
                    || m["identity"]["account"] != b["account"]
            })
        {
            return Err(PersonaError::bad("请为所有真人选择目标渠道的联系人"));
        }
        Ok(())
    }
    fn merge_messages(record: &mut Value, page: &Value) {
        let mut messages = rows(&record["messages"]);
        for m in rows(&page["messages"]) {
            if let Some(old) = messages.iter_mut().find(|old| old["id"] == m["id"]) {
                *old = m;
            } else {
                messages.push(m);
            }
        }
        messages.sort_by_key(|m| m["time"].as_i64().unwrap_or(0));
        if messages.len() > 10000 {
            messages.drain(..messages.len() - 10000);
        }
        record["messages"] = json!(messages);
        record["incomplete"] = page["incomplete"].clone();
        record["lastMessagesAt"] = json!(now_ms());
    }
    async fn catchup(
        &self,
        app: &AppState,
        scope: &Scope,
        c: &Value,
        state: &mut Value,
        channel: &CircleChannels,
    ) -> Result<(), PersonaError> {
        let b = &c["binding"];
        let key = identity_key(b);
        Self::binding(app, scope, b)?;
        let r = record(state, &key);
        let mut cursor = s(&r["catchupCursor"]).to_string();
        let resuming = !cursor.is_empty();
        let prior: HashSet<String> = rows(&r["messages"])
            .iter()
            .map(|m| s(&m["id"]).to_string())
            .collect();
        let mut cursors = HashSet::new();
        let mut finished = false;
        for page_number in 0..5 {
            let page = Box::pin(channel.history(&scope.root, b, &cursor)).await?;
            Self::binding(app, scope, b)?;
            let overlaps = !resuming
                && rows(&page["messages"])
                    .iter()
                    .any(|m| prior.contains(s(&m["id"])));
            Self::merge_messages(record(state, &key), &page);
            cursor = s(&page["cursor"]).to_string();
            if cursor.is_empty() || overlaps {
                finished = true;
                break;
            }
            if !cursors.insert(cursor.clone()) {
                return Err(PersonaError::bad("Repeated history cursor"));
            }
            if page_number == 4 {
                record(state, &key)["incomplete"] = json!(true);
            }
        }
        record(state, &key)["catchupCursor"] = json!(if finished { "" } else { &cursor });
        self.save(scope, state)
    }
    async fn discover(
        &self,
        app: &AppState,
        scope: &Scope,
        org: &mut Value,
        state: &mut Value,
        channel: &CircleChannels,
    ) -> Result<(), PersonaError> {
        if scope.organization != "default" {
            return Ok(());
        }
        for binding in Self::bindings(app, scope) {
            if binding["enabled"] != true || binding["status"] != "listening" {
                continue;
            }
            let account =
                json!({"channel":binding["channel"],"account":binding["profile"],"id":"discover"});
            let account_key =
                serde_json::to_string(&json!([account["channel"], account["account"]])).unwrap();
            if !state["discovery"].is_object() {
                state["discovery"] = json!({});
            }
            state["discovery"][&account_key] = json!({"lastChecked":now_ms(),"error":""});
            let result=async {
                Self::binding(app,scope,&account)?;
                let groups=Box::pin(channel.discover(&scope.root,&account)).await?;Self::binding(app,scope,&account)?;
                for group in rows(&groups) {
                    let mut b=account.clone();b["id"]=group["id"].clone();let key=identity_key(&b);
                    if !s(&group["name"]).starts_with("X-") || state["groups"][&key]["ignored"]==true || scope.bound_elsewhere(&b)? || rows(&org["circles"]).iter().any(|c|c["binding"].is_object() && identity_key(&c["binding"])==key) {continue;}
                    let guard=||Self::binding(app,scope,&b).map(|_|());let remote=Box::pin(channel.snapshot(&scope.root,&b,&guard)).await?;guard()?;
                    if !s(&remote["name"]).starts_with("X-") {continue;}
                    let id=uuid::Uuid::new_v4().to_string();let mut next=org.clone();
                    next["circles"].as_array_mut().unwrap().push(json!({"id":id,"parentId":null,"name":remote["name"],"goal":"","publicDescription":"","archived":false,"members":[],"roles":[],"binding":b}));
                    Self::import_members(&mut next,&id,&remote)?;*org=scope.write(&next,&org["revision"])?;
                    state["groups"][&key]=json!({"base":remote,"lastSynced":now_ms(),"discovered":true});self.save(scope,state)?;
                }Ok::<(),PersonaError>(())
            }.await;
            if let Err(error) = result {
                state["discovery"][&account_key]["error"] = json!(error.message);
            }
            self.save(scope, state)?;
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    async fn sync(
        &self,
        app: &AppState,
        scope: &Scope,
        org: &mut Value,
        id: &str,
        state: &mut Value,
        resolutions: Option<&Value>,
        channel: &CircleChannels,
    ) -> Result<(), PersonaError> {
        let c = circle(org, id)?;
        let b = &c["binding"];
        if !b.is_object() || c["archived"] == true {
            return Ok(());
        }
        Self::binding(app, scope, b)?;
        let key = identity_key(b);
        let original = org.clone();
        let guard = || Self::binding(app, scope, b).map(|_| ());
        let remote = Box::pin(channel.snapshot(&scope.root, b, &guard)).await?;
        guard()?;
        let local = Box::pin(self.projected(app, scope, org, &c, channel)).await?;
        let r = record(state, &key);
        let base = r.get("base").unwrap_or(&remote);
        let result = reconcile(base, &local, &remote);
        let mut desired = result["merged"].clone();
        let fingerprint = hash(&serde_json::to_string(&result["conflicts"]).unwrap());
        if resolutions.is_some() && r["conflictFingerprint"] != fingerprint {
            return Err(PersonaError::bad("冲突内容已变化，请刷新后重新选择"));
        }
        if r["conflictFingerprint"] != fingerprint {
            r["decisions"] = json!({});
        }
        r["conflictFingerprint"] = json!(fingerprint);
        if !r["decisions"].is_object() {
            r["decisions"] = json!({});
        }
        if let Some(resolutions) = resolutions {
            for (field, choice) in resolutions.as_object().unwrap() {
                r["decisions"][field] = choice.clone();
            }
        }
        let mut conflicts = Vec::new();
        for conflict in rows(&result["conflicts"]) {
            let field = s(&conflict["field"]);
            let choice = s(&r["decisions"][field]);
            if choice.is_empty() {
                conflicts.push(conflict);
                continue;
            }
            let selected = conflict[choice].clone();
            if let Some(id) = field.strip_prefix("member:") {
                desired["members"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|m| s(&m["id"]) != id);
                if !selected.is_null() {
                    desired["members"].as_array_mut().unwrap().push(selected);
                }
            } else {
                desired[field] = selected;
            }
        }
        r["conflicts"] = json!(conflicts);
        r["lastChecked"] = json!(now_ms());
        r["descriptionSupported"] = json!(remote.get("description").is_some());
        r["operators"] = json!(rows(&local["operators"])
            .into_iter()
            .map(|mut o| {
                o["present"] = json!(rows(&remote["members"])
                    .iter()
                    .any(|m| m["id"] == o["human"]["id"]));
                o
            })
            .collect::<Vec<_>>());
        if !conflicts.is_empty() {
            return self.save(scope, state);
        }
        guard()?;
        revision(&scope.read()?, &org["revision"])?;
        if remote.get("description").is_none() {
            desired["description"] = c["publicDescription"].clone();
        }
        Self::import_members(org, id, &desired)?;
        if *org != original {
            *org = scope.write(org, &original["revision"])?;
        }
        let mut projected =
            Box::pin(self.projected(app, scope, org, &circle(org, id)?, channel)).await?;
        if remote.get("description").is_none() {
            projected.as_object_mut().unwrap().remove("description");
        }
        let r = record(state, &key);
        r["base"] = remote.clone();
        r["pendingPublish"] = json!(group_version(&remote) != group_version(&projected));
        r["lastSynced"] = json!(now_ms());
        r["error"] = json!("");
        self.save(scope, state)
    }
}
