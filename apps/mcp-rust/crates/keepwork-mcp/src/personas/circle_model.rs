//! Portable circles model. Keep normalization and merge semantics in step with
//! `src/core/circleModel.ts`; channel credentials never belong in these records.

use super::*;

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
        _ => true,
    }
}

fn string(value: &Value, max: usize) -> Result<String, PersonaError> {
    let value = value
        .as_str()
        .ok_or_else(|| PersonaError::bad("Invalid circle text"))?;
    // JavaScript string limits count UTF-16 code units, not Unicode scalars.
    if value.encode_utf16().count() > max || value.contains('\0') {
        return Err(PersonaError::bad("Invalid circle text"));
    }
    Ok(value.to_owned())
}

fn stable_id(value: &Value) -> Result<String, PersonaError> {
    let value = value
        .as_str()
        .ok_or_else(|| PersonaError::bad("Invalid stable ID"))?;
    if trim(value).is_empty()
        || value.encode_utf16().count() > 256
        || value.chars().any(|c| c <= '\u{001f}')
    {
        return Err(PersonaError::bad("Invalid stable ID"));
    }
    Ok(value.to_owned())
}

fn list(value: &Value, max: usize) -> Result<&Vec<Value>, PersonaError> {
    value
        .as_array()
        .filter(|rows| rows.len() <= max)
        .ok_or_else(|| PersonaError::bad("Invalid circle list"))
}

fn unique(rows: &[Value]) -> Result<(), PersonaError> {
    let mut ids = HashSet::new();
    for row in rows {
        if !ids.insert(row["id"].as_str()) {
            return Err(PersonaError::bad("Duplicate ID"));
        }
    }
    Ok(())
}

fn references(value: &Value, members: &[Value]) -> Result<Vec<Value>, PersonaError> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for reference in list(value, 1000)? {
        let reference = stable_id(reference)?;
        if !seen.insert(reference.clone()) {
            continue;
        }
        if !members.iter().any(|member| member["id"] == reference) {
            return Err(PersonaError::bad("Unknown member"));
        }
        result.push(json!(reference));
    }
    Ok(result)
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

pub(super) fn empty_organization() -> Value {
    json!({"version":1,"revision":0,"name":"我的组织","members":[],"circles":[]})
}

pub(super) fn identity(value: &Value) -> Result<Value, PersonaError> {
    if !matches!(value["channel"].as_str(), Some("dingtalk" | "feishu")) {
        return Err(PersonaError::bad("Invalid channel"));
    }
    Ok(json!({
        "channel":value["channel"],
        "account":stable_id(&value["account"])?,
        "id":stable_id(&value["id"])?,
    }))
}

pub(super) fn identity_key(value: &Value) -> String {
    json!([value["channel"], value["account"], value["id"]]).to_string()
}

pub(super) fn organization(value: &Value) -> Result<Value, PersonaError> {
    let revision = value["revision"].as_f64().filter(|revision| {
        revision.is_finite()
            && *revision >= 0.0
            && *revision <= 9_007_199_254_740_991.0
            && revision.fract() == 0.0
    });
    if value["version"].as_f64() != Some(1.0) || revision.is_none() {
        return Err(PersonaError::bad("Unsupported organization version"));
    }
    let im = if truthy(&value["im"]) {
        Some(identity(&json!({
            "channel":value["im"]["channel"],
            "account":value["im"]["account"],
            "id":"organization",
        }))?)
    } else {
        None
    };
    let mut members = Vec::new();
    for member in list(&value["members"], 1000)? {
        if !matches!(member["kind"].as_str(), Some("human" | "persona")) {
            return Err(PersonaError::bad("Invalid member kind"));
        }
        let mut normalized = json!({
            "id":stable_id(&member["id"])?,
            "name":string(&member["name"],80)?,
            "kind":member["kind"],
        });
        if member["kind"] == "persona" {
            normalized["personaId"] = json!(stable_id(&member["personaId"])?);
        } else if truthy(&member["identity"]) {
            normalized["identity"] = identity(&member["identity"])?;
        }
        members.push(normalized);
    }
    unique(&members)?;
    let mut identities = HashSet::new();
    for member in &members {
        let key = if member["kind"] == "persona" {
            Some(format!("persona:{}", text(&member["personaId"])))
        } else {
            member.get("identity").map(identity_key)
        };
        if let Some(key) = key {
            if !identities.insert(key) {
                return Err(PersonaError::bad("Duplicate member identity"));
            }
        }
    }
    let mut circles = Vec::new();
    for circle in list(&value["circles"], 200)? {
        if circle.get("platform").is_some()
            && !matches!(circle["platform"].as_str(), Some("dingtalk" | "feishu"))
        {
            return Err(PersonaError::bad("Invalid circle platform"));
        }
        if truthy(&circle["binding"])
            && truthy(&circle["platform"])
            && circle["binding"]["channel"] != circle["platform"]
        {
            return Err(PersonaError::bad("Circle platform does not match binding"));
        }
        let mut roles = Vec::new();
        for role in list(&circle["roles"], 100)? {
            let holders = references(&role["holders"], &members)?;
            let primary = if role["primaryHolder"].is_null() {
                Value::Null
            } else {
                json!(stable_id(&role["primaryHolder"])?)
            };
            if !primary.is_null() && !holders.contains(&primary) {
                return Err(PersonaError::bad("Primary owner must be a role holder"));
            }
            let skills = list(&role["skills"], 30)?
                .iter()
                .map(|skill| string(skill, 256).map(Value::String))
                .collect::<Result<Vec<_>, _>>()?;
            let mut normalized = json!({
                "id":stable_id(&role["id"])?,
                "name":string(&role["name"],80)?,
                "responsibility":string(&role["responsibility"],16000)?,
                "skills":skills,
                "holders":holders,
            });
            if role.get("primaryHolder").is_some() {
                normalized["primaryHolder"] = primary;
            }
            roles.push(normalized);
        }
        unique(&roles)?;
        let parent = if truthy(&circle["parentId"]) {
            json!(stable_id(&circle["parentId"])?)
        } else {
            Value::Null
        };
        let description = if truthy(&circle["publicDescription"]) {
            string(&circle["publicDescription"], 100)?
        } else {
            String::new()
        };
        let mut normalized = json!({
            "id":stable_id(&circle["id"])?,
            "parentId":parent,
            "name":string(&circle["name"],80)?,
            "goal":string(&circle["goal"],16000)?,
            "publicDescription":description,
            "archived":circle["archived"] == true,
            "members":references(&circle["members"],&members)?,
            "roles":roles,
        });
        if truthy(&circle["platform"]) {
            normalized["platform"] = circle["platform"].clone();
        }
        if truthy(&circle["binding"]) {
            normalized["binding"] = identity(&circle["binding"])?;
        }
        circles.push(normalized);
    }
    unique(&circles)?;
    if circles.iter().any(|circle| {
        trim(text(&circle["name"])).is_empty()
            || rows(&circle["roles"])
                .iter()
                .any(|role| trim(text(&role["name"])).is_empty())
    }) {
        return Err(PersonaError::bad("Circle and role names are required"));
    }
    let mut bindings = HashSet::new();
    for circle in &circles {
        let mut seen = HashSet::from([text(&circle["id"])]);
        let mut parent = circle["parentId"].as_str();
        while let Some(parent_id) = parent {
            if !seen.insert(parent_id) {
                return Err(PersonaError::bad("Circle nesting cycle"));
            }
            let row = circles
                .iter()
                .find(|row| row["id"] == parent_id)
                .ok_or_else(|| PersonaError::bad("Unknown parent circle"))?;
            parent = row["parentId"].as_str();
        }
        if circle.get("binding").is_some()
            && circle["archived"] != true
            && !bindings.insert(identity_key(&circle["binding"]))
        {
            return Err(PersonaError::bad("Group already bound to another circle"));
        }
    }
    if let Some(im) = &im {
        if circles.iter().any(|circle| {
            (circle.get("platform").is_some() && circle["platform"] != im["channel"])
                || (circle.get("binding").is_some()
                    && (circle["binding"]["channel"] != im["channel"]
                        || circle["binding"]["account"] != im["account"]))
        }) {
            return Err(PersonaError::bad(
                "圈子平台或已绑定账号与组织 IM 不一致，请先处理群绑定",
            ));
        }
    }
    let mut result = json!({
        "version":1,
        "revision":revision.unwrap() as u64,
        "name":string(&value["name"],80)?,
        "members":members,
        "circles":circles,
    });
    if let Some(im) = im {
        result["im"] = json!({"channel":im["channel"],"account":im["account"]});
    }
    Ok(result)
}

pub(super) fn circle_members(org: &Value, circle: &Value) -> Vec<Value> {
    let mut ids: HashSet<&str> = rows(&circle["members"])
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for role in rows(&circle["roles"]) {
        ids.extend(rows(&role["holders"]).iter().filter_map(Value::as_str));
    }
    rows(&org["members"])
        .iter()
        .filter(|member| ids.contains(text(&member["id"])))
        .cloned()
        .collect()
}

fn clean(value: &str) -> String {
    value
        .split(js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn circle_description(org: &Value, circle: &Value) -> String {
    let roles = rows(&circle["roles"]);
    if trim(text(&circle["goal"])).is_empty() && roles.is_empty() {
        return text(&circle["publicDescription"]).to_owned();
    }
    let name = |id: &Value| {
        let member_name = rows(&org["members"])
            .iter()
            .find(|member| member["id"] == *id)
            .map(|member| text(&member["name"]))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| text(id));
        clean(member_name)
    };
    let role_labels = roles
        .iter()
        .map(|role| {
            let holders = rows(&role["holders"])
                .iter()
                .map(name)
                .collect::<Vec<_>>()
                .join("&");
            format!(
                "{}:{}",
                clean(text(&role["name"])),
                if holders.is_empty() {
                    "待分配"
                } else {
                    &holders
                },
            )
        })
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let owners = roles
        .iter()
        .filter_map(|role| role.get("primaryHolder"))
        .filter(|id| truthy(id) && seen.insert(text(id)))
        .map(name)
        .collect::<Vec<_>>();
    let goal = clean(text(&circle["goal"]));
    let mut lines = vec![format!(
        "目标：{}",
        if goal.is_empty() { "待明确" } else { &goal }
    )];
    if !role_labels.is_empty() {
        lines.push(format!("角色：{}", role_labels.join("；")));
    }
    if !owners.is_empty() {
        lines.push(format!("DRI:{}", owners.join("&")));
    }
    lines.join("\n")
}

pub(super) fn circle_snapshot(org: &Value, circle: &Value) -> Value {
    let members = circle_members(org, circle)
        .iter()
        .filter(|member| {
            member["kind"] == "human"
                && member.get("identity").is_some()
                && circle.get("binding").is_some()
                && member["identity"]["channel"] == circle["binding"]["channel"]
                && member["identity"]["account"] == circle["binding"]["account"]
        })
        .map(|member| json!({"id":member["identity"]["id"],"name":member["name"]}))
        .collect::<Vec<_>>();
    json!({"name":circle["name"],"description":circle_description(org,circle),"members":members})
}

pub(super) fn validate_group_description(
    binding: &Value,
    snapshot: &Value,
) -> Result<(), PersonaError> {
    if binding["channel"] == "feishu" && text(&snapshot["description"]).chars().count() > 100 {
        return Err(PersonaError::bad(
            "飞书群描述最多 100 字，请缩短圈子目标或角色名称后重新预览",
        ));
    }
    Ok(())
}

pub(super) fn reconcile(base: &Value, local: &Value, remote: &Value) -> Value {
    let mut merged = json!({"name":local["name"],"members":[]});
    let mut conflicts = Vec::new();
    for field in ["name", "description"] {
        if field == "description" && remote.get("description").is_none() {
            if let Some(description) = local.get("description") {
                merged["description"] = description.clone();
            }
            continue;
        }
        let b = base
            .get(field)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or(json!(""));
        let l = local
            .get(field)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or(json!(""));
        let r = remote
            .get(field)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or(json!(""));
        if l != b && r != b && l != r {
            conflicts.push(json!({"field":field,"kind":"concurrent","local":l,"remote":r}));
            merged[field] = l;
        } else {
            merged[field] = if l == b { r } else { l };
        }
    }
    let mut seen = HashSet::new();
    let mut members = Vec::new();
    for row in rows(&base["members"])
        .iter()
        .chain(rows(&local["members"]))
        .chain(rows(&remote["members"]))
    {
        let key = text(&row["id"]);
        if !seen.insert(key) {
            continue;
        }
        let find = |snapshot: &Value| {
            rows(&snapshot["members"])
                .iter()
                .find(|row| row["id"] == key)
                .cloned()
        };
        let b = find(base);
        let l = find(local);
        let r = find(remote);
        if b.is_some() && (l.is_none() || r.is_none()) {
            conflicts.push(json!({
                "field":format!("member:{key}"),"kind":"removal",
                "local":l,"remote":r,
            }));
            if let Some(member) = l.or(r) {
                members.push(member);
            }
        } else if let Some(member) = r.or(l) {
            members.push(member);
        }
    }
    merged["members"] = json!(members);
    json!({"merged":merged,"conflicts":conflicts})
}

// Kept under tests until circle-based persona routing is attached to the
// messaging service. Owner-operated circle APIs do not grant reply routing.
#[cfg(test)]
pub(super) fn circle_agent_context(org: &Value, persona_id: &str, binding: &Value) -> String {
    rows(&org["circles"])
        .iter()
        .filter(|circle| {
            circle["archived"] != true
                && circle.get("binding").is_some()
                && identity_key(&circle["binding"]) == identity_key(binding)
                && circle_members(org, circle)
                    .iter()
                    .any(|member| member["personaId"] == persona_id)
        })
        .map(|circle| {
            let role_context = rows(&circle["roles"])
                .iter()
                .filter(|role| {
                    rows(&role["holders"]).iter().any(|holder| {
                        rows(&org["members"]).iter().any(|member| {
                            member["id"] == *holder && member["personaId"] == persona_id
                        })
                    })
                })
                .map(|role| {
                    let skills = rows(&role["skills"])
                        .iter()
                        .map(text)
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!(
                        "{}: {}\n{skills}",
                        text(&role["name"]),
                        text(&role["responsibility"])
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "\n# Circle: {}\n{}\n{role_context}",
                text(&circle["name"]),
                text(&circle["goal"])
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn description_field(lines: &[&str], key: &str) -> Result<Option<String>, PersonaError> {
    let matches = lines
        .iter()
        .filter_map(|line| {
            line.strip_prefix(key)
                .and_then(|rest| rest.strip_prefix(':').or_else(|| rest.strip_prefix('：')))
        })
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(PersonaError::bad("群资料包含重复字段"));
    }
    Ok(matches.first().map(|value| trim(value).to_owned()))
}

fn resolve_member(members: &[Value], name: &str) -> Result<Value, PersonaError> {
    let matches = members
        .iter()
        .filter(|member| member["name"] == trim(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(PersonaError::bad(format!(
            "成员名称无法唯一匹配：{name}；请先明确关联成员身份",
        )));
    }
    Ok(matches[0]["id"].clone())
}

fn resolve_members(members: &[Value], names: &str) -> Result<Vec<Value>, PersonaError> {
    let mut result = Vec::new();
    for name in names.split('&') {
        let id = resolve_member(members, name)?;
        if !result.contains(&id) {
            result.push(id);
        }
    }
    Ok(result)
}

/// Explicit pull only. Names resolve to existing stable identities; ambiguous
/// names never create a new identity or guess an assignment.
pub(super) fn import_circle_description(
    org: &mut Value,
    circle_id: &str,
    description: &str,
) -> Result<(), PersonaError> {
    let normalized = description.replace("\r\n", "\n");
    let lines = normalized
        .split('\n')
        .filter(|line| !trim(line).is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Ok(());
    }
    if lines.iter().any(|line| {
        !["目标:", "目标：", "角色:", "角色：", "DRI:", "DRI："]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    }) {
        return Err(PersonaError::bad(
            "群资料格式无法解析，请使用目标、角色、DRI 三行格式",
        ));
    }
    let goal = description_field(&lines, "目标")?;
    let roles = description_field(&lines, "角色")?;
    let dri = description_field(&lines, "DRI")?;
    let members = rows(&org["members"]).to_vec();
    let circle = org["circles"]
        .as_array_mut()
        .and_then(|circles| circles.iter_mut().find(|circle| circle["id"] == circle_id))
        .ok_or_else(|| PersonaError::bad("Unknown circle"))?;
    if let Some(goal) = goal {
        circle["goal"] = json!(if goal == "待明确" { "" } else { &goal });
    }
    if let Some(role_text) = roles {
        let mut role_names = HashSet::new();
        let existing = rows(&circle["roles"]).to_vec();
        let mut imported = Vec::new();
        if !role_text.is_empty() {
            for entry in role_text.split(['；', ';']) {
                let Some((raw_name, raw_holders)) = entry.split_once([':', '：']) else {
                    return Err(PersonaError::bad("角色格式不明确或角色名称重复"));
                };
                let name = trim(raw_name);
                // JS /^([^:：]+)[:：](.*)$/ needs at least one character
                // before the separator and does not match line terminators.
                if raw_name.is_empty()
                    || raw_holders.contains(['\r', '\n', '\u{2028}', '\u{2029}'])
                    || !role_names.insert(name.to_owned())
                {
                    return Err(PersonaError::bad("角色格式不明确或角色名称重复"));
                }
                let candidates = existing
                    .iter()
                    .filter(|role| role["name"] == name)
                    .collect::<Vec<_>>();
                if candidates.len() > 1 {
                    return Err(PersonaError::bad("本地角色名称重复，请先明确角色"));
                }
                let holders = if trim(raw_holders).is_empty() || trim(raw_holders) == "待分配" {
                    Vec::new()
                } else {
                    resolve_members(&members, raw_holders)?
                };
                let mut role = candidates.first().map(|role| (*role).clone()).unwrap_or_else(|| {
                    json!({"id":uuid::Uuid::new_v4().to_string(),"responsibility":"","skills":[]})
                });
                let primary = role["primaryHolder"].clone();
                role["name"] = json!(name);
                role["primaryHolder"] = if truthy(&primary) && holders.contains(&primary) {
                    primary
                } else {
                    Value::Null
                };
                role["holders"] = json!(holders);
                imported.push(role);
            }
        }
        circle["roles"] = json!(imported);
    }
    if let Some(dri) = dri {
        let owners = if dri.is_empty() {
            Vec::new()
        } else {
            resolve_members(&members, &dri)?
        };
        let mut assigned = HashSet::new();
        let roles = circle["roles"]
            .as_array_mut()
            .ok_or_else(|| PersonaError::bad("Invalid circle list"))?;
        for role in roles.iter_mut() {
            let candidates = owners
                .iter()
                .filter(|id| rows(&role["holders"]).contains(id))
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() > 1 {
                if truthy(&role["primaryHolder"]) && candidates.contains(&role["primaryHolder"]) {
                    assigned.insert(text(&role["primaryHolder"]).to_owned());
                } else {
                    return Err(PersonaError::bad(format!(
                        "角色有多位 DRI 候选，请先明确主要负责人：{}",
                        text(&role["name"]),
                    )));
                }
            } else {
                role["primaryHolder"] = candidates.first().cloned().unwrap_or(Value::Null);
                if truthy(&role["primaryHolder"]) {
                    assigned.insert(text(&role["primaryHolder"]).to_owned());
                }
            }
        }
        for owner in owners
            .iter()
            .filter(|owner| !assigned.contains(text(owner)))
        {
            if roles.iter().any(|role| role["name"] == "DRI") {
                return Err(PersonaError::bad("DRI 角色已存在，请明确其主要负责人"));
            }
            roles.push(json!({
                "id":uuid::Uuid::new_v4().to_string(),"name":"DRI","responsibility":"",
                "skills":[],"holders":[owner],"primaryHolder":owner,
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Value {
        json!({
            "version":1,"revision":0,"name":"Team",
            "members":[
                {"id":"human","kind":"human","name":"Alex","identity":{"channel":"feishu","account":"app:ou_me","id":"ou_alex"}},
                {"id":"bot","kind":"persona","name":"Writer","personaId":"writer"},
                {"id":"other","kind":"human","name":"Other","identity":{"channel":"dingtalk","account":"corp:user","id":"open_other"}},
            ],
            "circles":[{
                "id":"product","parentId":null,"name":"X-Product","goal":"Ship",
                "publicDescription":"Public","archived":false,"members":["human","other"],
                "roles":[{"id":"write","name":"Write","responsibility":"Write docs","skills":["docs"],"holders":["bot","human"],"primaryHolder":"human"}],
                "binding":{"channel":"feishu","account":"app:ou_me","id":"group"},"platform":"feishu",
            }],
        })
    }

    fn error(value: &Value) -> String {
        organization(value).unwrap_err().message
    }

    #[test]
    fn normalizes_portable_fields_and_keeps_legacy_primary_absence() {
        let mut input = example();
        input["extra"] = json!("drop");
        input["members"][0]["extra"] = json!("drop");
        input["circles"][0]["roles"][0]
            .as_object_mut()
            .unwrap()
            .remove("primaryHolder");
        input["circles"][0]["roles"][0]["holders"] = json!(["bot", "human", "bot"]);
        let result = organization(&input).unwrap();
        assert!(result.get("extra").is_none());
        assert!(result["members"][0].get("extra").is_none());
        assert!(result["circles"][0]["roles"][0]
            .get("primaryHolder")
            .is_none());
        assert_eq!(
            result["circles"][0]["roles"][0]["holders"],
            json!(["bot", "human"])
        );
        assert_eq!(result["circles"][0]["platform"], "feishu");
        assert_eq!(
            organization(&empty_organization()).unwrap(),
            empty_organization()
        );
        input["circles"][0]["roles"][0]["primaryHolder"] = Value::Null;
        assert!(organization(&input).unwrap()["circles"][0]["roles"][0]["primaryHolder"].is_null());
    }

    #[test]
    fn validates_versions_text_utf16_and_stable_identity() {
        for revision in [
            json!(-1),
            json!(0.5),
            json!(9_007_199_254_740_992_u64),
            Value::Null,
            json!("0"),
        ] {
            let mut input = example();
            input["revision"] = revision;
            assert!(error(&input).contains("version"));
        }
        let mut input = example();
        input["revision"] = json!(1.0);
        assert_eq!(organization(&input).unwrap()["revision"], 1);
        input["name"] = json!("😀".repeat(40));
        assert!(organization(&input).is_ok());
        input["name"] = json!("😀".repeat(41));
        assert!(error(&input).contains("text"));
        input = example();
        input["members"][0]["id"] = json!("bad\n");
        assert!(error(&input).contains("stable ID"));
        input = example();
        input["circles"][0]["goal"] = json!("bad\0");
        assert!(error(&input).contains("text"));
        assert!(identity(&json!({"channel":"wechat","account":"a","id":"b"})).is_err());
        assert_eq!(
            identity_key(&json!({"channel":"feishu","account":"a","id":"b"})),
            "[\"feishu\",\"a\",\"b\"]"
        );
    }

    #[test]
    fn rejects_duplicate_ids_identities_and_dangling_members() {
        let mut input = example();
        input["members"][1]["id"] = json!("human");
        assert_eq!(error(&input), "Duplicate ID");
        input = example();
        let mut duplicate = input["members"][0].clone();
        duplicate["id"] = json!("copy");
        input["members"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(error(&input), "Duplicate member identity");
        input = example();
        input["circles"][0]["members"] = json!(["missing"]);
        assert_eq!(error(&input), "Unknown member");
        input = example();
        input["circles"][0]["roles"][0]["primaryHolder"] = json!("other");
        assert!(error(&input).contains("Primary owner"));
    }

    #[test]
    fn rejects_cycles_missing_parents_and_duplicate_group_bindings() {
        let mut input = example();
        input["circles"][0]["parentId"] = json!("product");
        assert!(error(&input).contains("cycle"));
        input = example();
        input["circles"][0]["parentId"] = json!("missing");
        assert!(error(&input).contains("parent"));
        input = example();
        let mut child = input["circles"][0].clone();
        child["id"] = json!("child");
        child["parentId"] = json!("product");
        input["circles"].as_array_mut().unwrap().push(child);
        assert!(error(&input).contains("already bound"));
        input["circles"][1]["archived"] = json!(true);
        assert!(organization(&input).is_ok());
    }

    #[test]
    fn checks_platform_and_organization_im_consistency() {
        let mut input = example();
        input["circles"][0]["platform"] = json!("dingtalk");
        assert!(error(&input).contains("platform"));
        input = example();
        input["im"] = json!({"channel":"feishu","account":"other"});
        assert!(error(&input).contains("组织 IM"));
        input["im"]["account"] = json!("app:ou_me");
        assert!(organization(&input).is_ok());
        input["circles"][0]["platform"] = Value::Null;
        assert!(error(&input).contains("platform"));
    }

    #[test]
    fn projects_role_members_description_and_current_group_humans_only() {
        let org = organization(&example()).unwrap();
        let circle = &org["circles"][0];
        assert_eq!(circle_members(&org, circle).len(), 3);
        assert_eq!(
            circle_description(&org, circle),
            "目标：Ship\n角色：Write:Writer&Alex\nDRI:Alex"
        );
        assert_eq!(
            circle_snapshot(&org, circle)["members"],
            json!([{"id":"ou_alex","name":"Alex"}])
        );
        let context = circle_agent_context(&org, "writer", &circle["binding"]);
        assert!(context.contains("Write docs\ndocs"));
        assert!(context.contains("Ship"));
        assert!(circle_agent_context(&org, "other", &circle["binding"]).is_empty());
        let mut public = circle.clone();
        public["goal"] = json!("");
        public["roles"] = json!([]);
        assert_eq!(circle_description(&org, &public), "Public");
        validate_group_description(&circle["binding"], &json!({"description":"😀".repeat(100)}))
            .unwrap();
        assert!(validate_group_description(
            &circle["binding"],
            &json!({"description":"😀".repeat(101)})
        )
        .is_err());
    }

    #[test]
    fn merge_preserves_removals_as_conflicts_and_remote_additions() {
        let base = json!({"name":"Base","description":"old","members":[{"id":"a","name":"A"}]});
        let local = json!({"name":"Local","description":"old","members":[]});
        let remote = json!({"name":"Remote","description":"new","members":[{"id":"a","name":"Renamed"},{"id":"b","name":"B"}]});
        let result = reconcile(&base, &local, &remote);
        assert_eq!(result["merged"]["name"], "Local");
        assert_eq!(result["merged"]["description"], "new");
        assert_eq!(result["conflicts"].as_array().unwrap().len(), 2);
        assert_eq!(result["conflicts"][1]["field"], "member:a");
        assert!(result["conflicts"][1]["local"].is_null());
        assert_eq!(result["merged"]["members"], remote["members"]);
        let no_description = json!({"name":"Remote","members":[]});
        assert_eq!(
            reconcile(&base, &local, &no_description)["merged"]["description"],
            "old"
        );
    }

    #[test]
    fn pulls_description_using_stable_roles_and_explicit_primary() {
        let mut org = example();
        import_circle_description(
            &mut org,
            "product",
            "目标：Launch\r\n角色：Write:Writer&Alex\nDRI:Alex",
        )
        .unwrap();
        let circle = &org["circles"][0];
        assert_eq!(circle["goal"], "Launch");
        assert_eq!(circle["roles"][0]["id"], "write");
        assert_eq!(circle["roles"][0]["responsibility"], "Write docs");
        assert_eq!(circle["roles"][0]["primaryHolder"], "human");
        import_circle_description(
            &mut org,
            "product",
            "目标:待明确\n角色:Developer:Writer&Alex\nDRI:Alex",
        )
        .unwrap();
        assert_eq!(org["circles"][0]["goal"], "");
        assert_ne!(org["circles"][0]["roles"][0]["id"], "write");
        assert_eq!(org["circles"][0]["roles"][0]["primaryHolder"], "human");
        assert!(organization(&org).is_ok());
    }

    #[test]
    fn pull_rejects_ambiguous_names_dri_and_unrecognized_fields() {
        let mut org = example();
        org["members"][2]["name"] = json!("Alex");
        assert!(
            import_circle_description(&mut org, "product", "角色：Dev:Alex")
                .unwrap_err()
                .message
                .contains("唯一匹配")
        );
        org = example();
        org["circles"][0]["roles"][0]["primaryHolder"] = Value::Null;
        assert!(
            import_circle_description(&mut org, "product", "DRI:Writer&Alex")
                .unwrap_err()
                .message
                .contains("多位 DRI")
        );
        assert!(
            import_circle_description(&mut org, "product", "目标:A\n目标:B")
                .unwrap_err()
                .message
                .contains("重复字段")
        );
        assert!(
            import_circle_description(&mut org, "product", "Unrelated description")
                .unwrap_err()
                .message
                .contains("格式")
        );
    }

    #[test]
    fn pull_can_create_dri_role_and_rejects_duplicate_role_names() {
        let mut org = example();
        org["circles"][0]["roles"] = json!([]);
        import_circle_description(&mut org, "product", "DRI:Alex").unwrap();
        assert_eq!(org["circles"][0]["roles"][0]["name"], "DRI");
        assert_eq!(org["circles"][0]["roles"][0]["primaryHolder"], "human");
        assert!(
            import_circle_description(&mut org, "product", "角色:Dev:Alex；Dev:Writer")
                .unwrap_err()
                .message
                .contains("重复")
        );
    }
}
