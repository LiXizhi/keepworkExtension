//! Bounded, argument-only DingTalk/Feishu operations used by owner-driven circles.
//! Reads never grant write authority; every external write checks the account,
//! group owner/admin role and the request's current brain/revision again.

use super::*;
use crate::messaging::{dingtalk_group_name, dws_call, feishu_identity_checked, lark_call};

type Check<'a> = &'a (dyn Fn() -> Result<(), PersonaError> + Send + Sync);

pub(crate) struct CircleChannels {
    _messaging: Arc<MessagingService>,
    labels: Mutex<HashMap<String, (std::time::Instant, Value)>>,
}

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| (*word).to_string()).collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn first<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|v| !v.is_null()))
}

fn truthy(value: &Value) -> bool {
    !value.is_null()
        && value.as_bool() != Some(false)
        && value.as_str() != Some("")
        && value.as_f64() != Some(0.0)
}

fn choose<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .filter_map(|value| *value)
        .find(|value| truthy(value))
}

fn scalar(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn data(value: &Value) -> &Value {
    value
        .get("result")
        .filter(|v| !v.is_null())
        .or_else(|| value.get("data").filter(|v| !v.is_null()))
        .unwrap_or(value)
}

fn rows<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Vec<Value>, PersonaError> {
    let value = data(value);
    value
        .as_array()
        .or_else(|| keys.iter().find_map(|key| value[*key].as_array()))
        .ok_or_else(|| PersonaError::bad("Unexpected channel response; synchronization paused"))
}

fn has_rows(value: &Value, key: &str) -> bool {
    value[key].as_array().is_some_and(|items| !items.is_empty())
}

fn incomplete(value: &Value) -> bool {
    value["success"] == false
        || value["ok"] == false
        || value["partial"] == true
        || value["failedCount"].as_u64().unwrap_or(0) > 0
        || has_rows(value, "failures")
        || value["code"].as_i64().is_some_and(|code| code != 0)
}

fn identity(b: &Value) -> Result<(&str, &str, &str), PersonaError> {
    let channel = text(b, "channel");
    let account = text(b, "account");
    let id = text(b, "id");
    if !matches!(channel, "dingtalk" | "feishu")
        || account.is_empty()
        || id.is_empty()
        || [account, id]
            .iter()
            .any(|v| v.len() > 1024 || v.chars().any(char::is_control))
    {
        return Err(PersonaError::bad("Invalid channel identity"));
    }
    Ok((channel, account, id))
}

fn person(row: &Value, id_keys: &[&str], name_keys: &[&str]) -> Result<Value, PersonaError> {
    let id = scalar(first(row, id_keys));
    if id.is_empty() {
        return Err(PersonaError::bad("Member identity unavailable"));
    }
    let name = scalar(first(row, name_keys));
    Ok(json!({"id": id, "name": if name.is_empty() { id.clone() } else { name }}))
}

impl CircleChannels {
    pub(crate) fn new(messaging: Arc<MessagingService>) -> Self {
        Self {
            _messaging: messaging,
            labels: Mutex::new(HashMap::new()),
        }
    }

    async fn dws(&self, root: &str, arguments: &[String]) -> Result<Value, PersonaError> {
        dws_call(arguments, root)
            .await
            .map_err(|error| PersonaError::bad(error.message))
    }

    async fn lark(&self, root: &str, arguments: &[String]) -> Result<Value, PersonaError> {
        lark_call(arguments, root)
            .await
            .map_err(|error| PersonaError::bad(error.message))
    }

    async fn call(
        &self,
        root: &str,
        b: &Value,
        arguments: Vec<String>,
        write: bool,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.call_inner(root, b, arguments, write, false)).await
    }

    async fn call_inner(
        &self,
        root: &str,
        b: &Value,
        mut arguments: Vec<String>,
        write: bool,
        partial_history: bool,
    ) -> Result<Value, PersonaError> {
        let (channel, account, _) = identity(b)?;
        let value = if channel == "feishu" {
            let delete = arguments.iter().any(|arg| arg == "delete");
            arguments.extend(args(&[
                "--as",
                "user",
                "--profile",
                account.split(':').next().unwrap_or(""),
                "--format",
                "json",
            ]));
            if write && delete {
                arguments.push("--yes".into());
            }
            Box::pin(self.lark(root, &arguments)).await?
        } else {
            arguments.extend(args(&["--profile", account, "-f", "json"]));
            if write {
                arguments.push("--yes".into());
            }
            Box::pin(self.dws(root, &arguments)).await?
        };
        // A history page may carry useful messages plus data.partial; callers
        // must receive those messages with incomplete=true. Mutating operations
        // and complete group snapshots still fail closed on partial data.
        if incomplete(&value) || (!partial_history && incomplete(data(&value))) {
            return Err(PersonaError::bad("Channel operation incomplete"));
        }
        Ok(value)
    }

    pub(crate) async fn verify(&self, root: &str, b: &Value) -> Result<Value, PersonaError> {
        let (channel, account, _) = identity(b)?;
        if channel == "feishu" {
            feishu_identity_checked(root, account)
                .await
                .map_err(MessageError::into_persona_error)?;
        } else {
            let value = Box::pin(self.dws(
                root,
                &args(&["event", "status", "--profile", account, "-f", "json"]),
            ))
            .await?;
            let user = &value["identity"];
            if format!("{}:{}", text(user, "corp_id"), text(user, "user_id")) != account {
                return Err(PersonaError::bad("Channel account changed"));
            }
        }
        Ok(Value::Null)
    }

    pub(crate) async fn account_label(&self, root: &str, b: &Value) -> Result<Value, PersonaError> {
        let (channel, account, _) = identity(b)?;
        let key = json!([root, channel, account]).to_string();
        {
            let labels = self
                .labels
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some((time, value)) = labels.get(&key) {
                if time.elapsed() < Duration::from_secs(60) {
                    return Ok(value.clone());
                }
            }
        }
        let mut label = json!({"organization": "", "accountName": ""});
        let clean = |value: Option<&Value>| -> String { scalar(value).chars().take(160).collect() };
        if channel == "dingtalk" {
            if let Ok(value) =
                Box::pin(self.dws(root, &args(&["profile", "list", "-f", "json"]))).await
            {
                if let Some(profile) = value["profiles"].as_array().and_then(|profiles| {
                    profiles.iter().find(|profile| {
                        let named = text(profile, "profile");
                        named == account
                            || (named.is_empty()
                                && format!(
                                    "{}:{}",
                                    scalar(first(profile, &["corpId", "corp_id"])),
                                    scalar(first(profile, &["userId", "user_id"]))
                                ) == account)
                    })
                }) {
                    label["organization"] =
                        json!(clean(first(profile, &["corpName", "corp_name"])));
                    label["accountName"] = json!(clean(first(profile, &["userName", "user_name"])));
                }
            }
        } else if let Ok(value) = Box::pin(self.lark(
            root,
            &args(&[
                "auth",
                "status",
                "--json",
                "--profile",
                account.split(':').next().unwrap_or(""),
            ]),
        ))
        .await
        {
            let user = &value["identities"]["user"];
            if format!("{}:{}", text(&value, "appId"), text(user, "openId")) == account {
                label["organization"] = json!(clean(first(user, &["corpName", "tenantName"])));
                label["accountName"] = json!(clean(first(user, &["userName", "name"])));
            }
        }
        let mut labels = self
            .labels
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if labels.len() > 100 {
            labels.clear();
        }
        labels.insert(key, (std::time::Instant::now(), label.clone()));
        Ok(label)
    }

    pub(crate) async fn operator(&self, root: &str, b: &Value) -> Result<Value, PersonaError> {
        let (channel, account, _) = identity(b)?;
        if channel == "feishu" {
            let (_, id) = feishu_identity_checked(root, account)
                .await
                .map_err(MessageError::into_persona_error)?;
            return Ok(json!({"id": id, "name": id}));
        }
        let value = Box::pin(self.dws(
            root,
            &args(&["event", "status", "--profile", account, "-f", "json"]),
        ))
        .await?;
        let user = &value["identity"];
        if format!("{}:{}", text(user, "corp_id"), text(user, "user_id")) != account
            || text(user, "open_dingtalk_id").is_empty()
        {
            return Err(PersonaError::bad(
                "无法核实 Agent 背后真人的钉钉 openDingtalkId，请重新连接渠道",
            ));
        }
        let id = text(user, "open_dingtalk_id");
        let name = text(user, "user_name");
        Ok(json!({"id": id, "name": if name.is_empty() { id } else { name }}))
    }

    async fn joined(&self, root: &str, b: &Value) -> Result<Vec<Value>, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let mut groups: Vec<Value> = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = String::new();
        for _ in 0..20 {
            let mut arguments = if text(b, "channel") == "feishu" {
                args(&["im", "+chat-list", "--types", "group", "--page-size", "100"])
            } else {
                args(&["chat", "group", "list-all", "--limit", "100"])
            };
            if !cursor.is_empty() {
                arguments.extend(args(&[
                    if text(b, "channel") == "feishu" {
                        "--page-token"
                    } else {
                        "--cursor"
                    },
                    &cursor,
                ]));
            }
            let raw = Box::pin(self.call(root, b, arguments, false)).await?;
            let value = data(&raw);
            for row in rows(value, &["chats", "groups", "items", "list"])? {
                let id = first(row, &["chat_id", "openConversationId", "conversationId"])
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let name =
                    first(row, &["name", "title", "conversationName"]).and_then(Value::as_str);
                let (Some(id), Some(name)) = (id, name) else {
                    return Err(PersonaError::bad(
                        "Group identity unavailable; discovery paused",
                    ));
                };
                if text(row, "chat_mode") == "p2p"
                    || matches!(text(row, "chat_status"), "dissolved" | "dissolved_save")
                {
                    continue;
                }
                let projected = json!({"id": id, "name": name, "isOwner": matches!(text(row, "myRole"), "群主" | "群管理员")});
                if let Some(index) = groups.iter().position(|group| text(group, "id") == id) {
                    groups[index] = projected;
                } else {
                    groups.push(projected);
                }
            }
            if has_rows(value, "truncations") {
                return Err(PersonaError::bad("Incomplete group list"));
            }
            let next = scalar(first(
                value,
                &["page_token", "next_page_token", "nextCursor", "next_cursor"],
            ));
            if next.is_empty() || next == "0" {
                if value["has_more"] == true || value["hasMore"] == true {
                    return Err(PersonaError::bad("Incomplete group list"));
                }
                return Ok(groups);
            }
            if value["has_more"] == false || value["hasMore"] == false {
                return Ok(groups);
            }
            if !seen.insert(next.clone()) {
                return Err(PersonaError::bad("Repeated group cursor"));
            }
            cursor = next;
        }
        Err(PersonaError::bad("Incomplete group list; discovery paused"))
    }

    pub(crate) async fn discover(&self, root: &str, b: &Value) -> Result<Value, PersonaError> {
        Ok(json!(Box::pin(self.joined(root, b))
            .await?
            .into_iter()
            .filter(|group| text(group, "name").starts_with("X-"))
            .collect::<Vec<_>>()))
    }

    pub(crate) async fn require_owner(&self, root: &str, b: &Value) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let (channel, account, id) = identity(b)?;
        let owner = if channel == "feishu" {
            let raw = Box::pin(self.call(
                root,
                b,
                args(&[
                    "im",
                    "chats",
                    "get",
                    "--chat-id",
                    id,
                    "--user-id-type",
                    "open_id",
                ]),
                false,
            ))
            .await?;
            let info = data(&raw);
            let self_id = account.split_once(':').map(|(_, user)| user).unwrap_or("");
            !self_id.is_empty()
                && (text(info, "owner_id") == self_id
                    || info["user_manager_id_list"]
                        .as_array()
                        .is_some_and(|users| {
                            users.iter().any(|user| user.as_str() == Some(self_id))
                        }))
        } else {
            Box::pin(self.joined(root, b))
                .await?
                .iter()
                .any(|group| text(group, "id") == id && group["isOwner"] == true)
        };
        if !owner {
            return Err(PersonaError::bad(
                "只有群主或管理员可以更新群；无法核实当前账号权限时禁止写入",
            ));
        }
        Ok(Value::Null)
    }

    pub(crate) async fn search(
        &self,
        root: &str,
        b: &Value,
        query: &str,
        contacts: bool,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let feishu = text(b, "channel") == "feishu";
        let arguments = if feishu && !contacts {
            if query.is_empty() {
                args(&["im", "+chat-list", "--types", "group", "--page-size", "50"])
            } else {
                args(&[
                    "im",
                    "+chat-search",
                    "--query",
                    query,
                    "--disable-search-by-user",
                    "--search-types",
                    "private,external,public_joined",
                    "--chat-modes",
                    "group",
                    "--page-size",
                    "50",
                ])
            }
        } else if feishu {
            args(&["contact", "+search-user", "--query", query])
        } else if contacts {
            args(&["contact", "user", "search", "--query", query])
        } else {
            args(&["chat", "search", "--query", query])
        };
        let raw = Box::pin(self.call(root, b, arguments, false)).await?;
        let mut result = Vec::new();
        for row in rows(
            &raw,
            if contacts {
                &["users", "items", "list"]
            } else {
                &["chats", "groups", "items", "list"]
            },
        )? {
            if !contacts
                && (text(row, "chat_mode") == "p2p"
                    || matches!(text(row, "chat_status"), "dissolved" | "dissolved_save"))
            {
                continue;
            }
            let id = scalar(first(
                row,
                if contacts {
                    &["open_id", "openDingtalkId", "userId", "user_id"]
                } else {
                    &["openConversationId", "chat_id", "conversationId"]
                },
            ));
            if !id.is_empty() {
                result.push(json!({"id": id, "name": scalar(first(row, &["name", "title", "nick", "display_name"]))}));
            }
        }
        Ok(json!(result))
    }

    async fn goal_notice(&self, root: &str, b: &Value) -> Result<Option<Value>, PersonaError> {
        let id = text(b, "id");
        let mut cursor = String::new();
        let mut seen = HashSet::new();
        let mut matches: Vec<Value> = Vec::new();
        for _ in 0..20 {
            let mut arguments = args(&[
                "chat",
                "group",
                "notice",
                "list",
                "--conversation-id",
                id,
                "--limit",
                "100",
            ]);
            if !cursor.is_empty() {
                arguments.extend(args(&["--cursor", &cursor]));
            }
            let raw = Box::pin(self.call(root, b, arguments, false)).await?;
            let value = data(&raw);
            for row in rows(value, &["list", "items", "notices", "noticeList"])? {
                let notice_id = first(row, &["dataId", "noticeId"])
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| PersonaError::bad("群公告身份不可用，停止同步"))?;
                let detail_raw = Box::pin(self.call(
                    root,
                    b,
                    args(&[
                        "chat",
                        "group",
                        "notice",
                        "get",
                        "--conversation-id",
                        id,
                        "--notice-id",
                        notice_id,
                    ]),
                    false,
                ))
                .await?;
                let detail = data(&detail_raw);
                let content = first(detail, &["content", "markdown"])
                    .and_then(Value::as_str)
                    .ok_or_else(|| PersonaError::bad("无法完整读取群公告正文，停止 X:goal 同步"))?;
                if let Some(description) = notice_description(content) {
                    let projected = json!({"id": notice_id, "description": description});
                    if let Some(index) = matches.iter().position(|row| text(row, "id") == notice_id)
                    {
                        matches[index] = projected;
                    } else {
                        matches.push(projected);
                    }
                }
            }
            let next = scalar(value.get("nextPageCursor"));
            if value["hasMore"] == false || (value["hasMore"] != true && next.is_empty()) {
                if matches.len() > 1 {
                    return Err(PersonaError::bad("发现多条 X:goal 公告，请先明确保留一条"));
                }
                return Ok(matches.pop());
            }
            if next.is_empty() || !seen.insert(next.clone()) {
                return Err(PersonaError::bad("群公告分页不完整，停止同步"));
            }
            cursor = next;
        }
        Err(PersonaError::bad("群公告分页超过限制，停止同步"))
    }

    async fn update_goal_notice(
        &self,
        root: &str,
        b: &Value,
        description: &str,
        remote: &Value,
        check: Check<'_>,
    ) -> Result<(), PersonaError> {
        let notice = Box::pin(self.goal_notice(root, b)).await?;
        let prior = notice
            .as_ref()
            .map(|n| text(n, "description"))
            .unwrap_or("");
        if prior != text(remote, "description") {
            return Err(PersonaError::bad("X:goal 公告已变化，请重新预览"));
        }
        if notice.is_some() && prior == description {
            return Ok(());
        }
        Box::pin(self.require_owner(root, b)).await?;
        check()?;
        let mut arguments = args(&[
            "chat",
            "group",
            "notice",
            if notice.is_some() { "edit" } else { "create" },
            "--conversation-id",
            text(b, "id"),
        ]);
        if let Some(notice) = &notice {
            arguments.extend(args(&["--notice-id", text(notice, "id")]));
        }
        arguments.extend(args(&["--content", &format!("# X:goal\n\n{description}")]));
        Box::pin(self.call(root, b, arguments, true)).await?;
        Ok(())
    }

    /// Reads company departments, never joined groups. The local import preview
    /// is bounded to 100 unique people and one minute for the entire traversal.
    pub(crate) async fn directory(
        &self,
        root: &str,
        b: &Value,
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        let operation = self.directory_inner(root, b, check);
        tokio::time::timeout(Duration::from_secs(60), operation)
            .await
            .map_err(|_| PersonaError::bad("公司通讯录读取超时，请稍后重试；本次未保存成员"))?
    }

    async fn directory_inner(
        &self,
        root: &str,
        b: &Value,
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        check()?;
        let feishu = text(b, "channel") == "feishu";
        let mut queue =
            std::collections::VecDeque::from([if feishu { "0" } else { "1" }.to_string()]);
        let mut seen = HashSet::new();
        let mut members: Vec<Value> = Vec::new();
        let mut limited = false;
        while let Some(dept) = queue.pop_front() {
            check()?;
            if !seen.insert(dept.clone()) {
                continue;
            }
            if seen.len() > 100 {
                limited = true;
                break;
            }
            if !feishu {
                let raw = Box::pin(self.call(
                    root,
                    b,
                    args(&["contact", "dept", "list-members", "--depts", &dept]),
                    false,
                ))
                .await?;
                check()?;
                for row in rows(&raw, &["deptUserList", "users", "members", "list"])? {
                    let user = row.get("userInfo").filter(|v| !v.is_null()).unwrap_or(row);
                    let member =
                        person(user, &["openDingtalkId", "userId"], &["name", "userName"])?;
                    upsert_person(&mut members, member);
                    if members.len() == 100 {
                        limited = true;
                        break;
                    }
                }
                if members.len() == 100 {
                    break;
                }
                let raw = Box::pin(self.call(
                    root,
                    b,
                    args(&["contact", "dept", "list-children", "--dept", &dept]),
                    false,
                ))
                .await?;
                check()?;
                for row in rows(&raw, &["departments", "list", "items"])? {
                    let id = scalar(first(row, &["deptId", "dept_id"]));
                    if id.is_empty() {
                        return Err(PersonaError::bad("公司部门信息不完整"));
                    }
                    if !seen.contains(&id) {
                        queue.push_back(id);
                    }
                }
                continue;
            }
            let mut token = String::new();
            let mut tokens = HashSet::new();
            loop {
                let mut params = json!({"department_id": dept, "department_id_type": "open_department_id", "user_id_type": "open_id", "page_size": (100 - members.len()).min(50)});
                if !token.is_empty() {
                    params["page_token"] = json!(token);
                }
                check()?;
                let raw = Box::pin(self.call(
                    root,
                    b,
                    args(&[
                        "api",
                        "GET",
                        "/open-apis/contact/v3/users/find_by_department",
                        "--params",
                        &params.to_string(),
                    ]),
                    false,
                ))
                .await?;
                check()?;
                let value = data(&raw);
                for user in rows(value, &["items"])? {
                    let member = person(user, &["open_id"], &["name"])?;
                    upsert_person(&mut members, member);
                    if members.len() == 100 {
                        limited = true;
                        break;
                    }
                }
                if members.len() == 100 || value["has_more"] != true {
                    break;
                }
                token = text(value, "page_token").to_string();
                if token.is_empty() || !tokens.insert(token.clone()) {
                    return Err(PersonaError::bad("公司通讯录分页不完整"));
                }
            }
            if members.len() == 100 {
                break;
            }
            token.clear();
            tokens.clear();
            loop {
                let mut params =
                    json!({"department_id_type": "open_department_id", "page_size": 50});
                if !token.is_empty() {
                    params["page_token"] = json!(token);
                }
                let escaped: String =
                    url::form_urlencoded::byte_serialize(dept.as_bytes()).collect();
                let path = format!("/open-apis/contact/v3/departments/{escaped}/children");
                check()?;
                let raw = Box::pin(self.call(
                    root,
                    b,
                    args(&["api", "GET", &path, "--params", &params.to_string()]),
                    false,
                ))
                .await?;
                check()?;
                let value = data(&raw);
                for child in rows(value, &["items"])? {
                    let id = text(child, "open_department_id");
                    if id.is_empty() {
                        return Err(PersonaError::bad("公司部门信息不完整"));
                    }
                    if !seen.contains(id) {
                        queue.push_back(id.to_string());
                    }
                }
                if value["has_more"] != true {
                    break;
                }
                token = text(value, "page_token").to_string();
                if token.is_empty() || !tokens.insert(token.clone()) {
                    return Err(PersonaError::bad("公司部门分页不完整"));
                }
            }
        }
        check()?;
        Ok(
            json!({"members": members, "groups": 0, "source": "company", "limit": 100, "limited": limited || !queue.is_empty()}),
        )
    }

    pub(crate) async fn snapshot(
        &self,
        root: &str,
        b: &Value,
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        check()?;
        Box::pin(self.verify(root, b)).await?;
        check()?;
        let (_, account, id) = identity(b)?;
        if text(b, "channel") == "feishu" {
            let raw = Box::pin(self.call(
                root,
                b,
                args(&["im", "chats", "get", "--chat-id", id]),
                false,
            ))
            .await?;
            let info = data(&raw);
            let name = info["name"]
                .as_str()
                .ok_or_else(|| PersonaError::bad("Group name unavailable"))?;
            check()?;
            let raw = Box::pin(self.call(
                root,
                b,
                args(&[
                    "im",
                    "+chat-members-list",
                    "--chat-id",
                    id,
                    "--member-types",
                    "user",
                    "--page-all",
                    "--page-limit",
                    "20",
                ]),
                false,
            ))
            .await?;
            check()?;
            let value = data(&raw);
            if value["has_more"] == true
                || has_rows(value, "truncations")
                || !value["users"].is_array()
            {
                return Err(PersonaError::bad(
                    "Incomplete member list; synchronization paused",
                ));
            }
            let members: Vec<Value> = rows(value, &["users"])?
                .iter()
                .map(|row| {
                    person(
                        row,
                        &["member_id", "open_id"],
                        &["name", "member_id", "open_id"],
                    )
                })
                .collect::<Result<_, _>>()?;
            let mut result = json!({"name": name, "members": members});
            if let Some(description) = info["description"].as_str() {
                result["description"] = json!(description);
            }
            return Ok(result);
        }
        let name = dingtalk_group_name(root, account, id)
            .await
            .map_err(MessageError::into_persona_error)?;
        let mut members = Vec::new();
        let mut cursor = "0".to_string();
        let mut seen = HashSet::new();
        for _ in 0..20 {
            check()?;
            let raw = Box::pin(self.call(
                root,
                b,
                args(&["chat", "group", "members", "--id", id, "--cursor", &cursor]),
                false,
            ))
            .await?;
            let value = data(&raw);
            for row in rows(value, &["members", "list", "userList"])? {
                upsert_person(
                    &mut members,
                    person(
                        row,
                        &["openDingtalkId", "userId", "userid"],
                        &["name", "nick", "memberEmpName"],
                    )?,
                );
            }
            let next = scalar(first(value, &["nextCursor", "next_cursor"]));
            if next.is_empty() || next == "0" || value["hasMore"] == false {
                if value["hasMore"] == true && (next.is_empty() || next == "0") {
                    return Err(PersonaError::bad(
                        "Incomplete member list; synchronization paused",
                    ));
                }
                check()?;
                let description = Box::pin(self.goal_notice(root, b))
                    .await?
                    .map(|row| text(&row, "description").to_string())
                    .unwrap_or_default();
                check()?;
                return Ok(json!({"name": name, "description": description, "members": members}));
            }
            if !seen.insert(next.clone()) {
                return Err(PersonaError::bad("Repeated member cursor"));
            }
            cursor = next;
        }
        Err(PersonaError::bad(
            "Incomplete member list; synchronization paused",
        ))
    }

    pub(crate) async fn create(
        &self,
        root: &str,
        b: &Value,
        snapshot: &Value,
        type_: &str,
        dry_run: bool,
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let (channel, account, _) = identity(b)?;
        let users = member_ids(snapshot)?.join(",");
        if channel == "dingtalk" && users.is_empty() {
            return Err(PersonaError::bad("钉钉建群需要至少一名已解析的真人成员"));
        }
        let mut arguments = if channel == "feishu" {
            args(&[
                "im",
                "+chat-create",
                "--name",
                text(snapshot, "name"),
                "--owner",
                account.split_once(':').map(|(_, user)| user).unwrap_or(""),
                "--type",
                "private",
                "--description",
                text(snapshot, "description"),
            ])
        } else {
            args(&[
                "chat",
                "group",
                "create",
                "--name",
                text(snapshot, "name"),
                "--users",
                &users,
                "--type",
                if type_ == "EXTERNAL" {
                    "EXTERNAL"
                } else {
                    "INTERNAL"
                },
            ])
        };
        if channel == "feishu" && !users.is_empty() {
            arguments.extend(args(&["--users", &users]));
        }
        check()?;
        if dry_run {
            arguments.push("--dry-run".into());
            Box::pin(self.call(root, b, arguments, false)).await?;
            return Ok(json!(""));
        }
        let raw = Box::pin(self.call(root, b, arguments, true)).await?;
        let id = scalar(first(
            data(&raw),
            &["chat_id", "openConversationId", "conversationId"],
        ));
        if id.is_empty() {
            return Err(PersonaError::bad(
                "Creation result unknown; verify group before retrying",
            ));
        }
        Ok(json!(id))
    }

    pub(crate) async fn update(
        &self,
        root: &str,
        b: &Value,
        desired: &Value,
        remote: &Value,
        remove: &[String],
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.require_owner(root, b)).await?;
        check()?;
        let feishu = text(b, "channel") == "feishu";
        let id = text(b, "id");
        if desired["name"] != remote["name"]
            || (feishu && desired.get("description") != remote.get("description"))
        {
            let arguments = if feishu {
                args(&[
                    "im",
                    "+chat-update",
                    "--chat-id",
                    id,
                    "--name",
                    text(desired, "name"),
                    "--description",
                    text(desired, "description"),
                ])
            } else {
                args(&[
                    "chat",
                    "group",
                    "rename",
                    "--id",
                    id,
                    "--name",
                    text(desired, "name"),
                ])
            };
            check()?;
            Box::pin(self.call(root, b, arguments, true)).await?;
        }
        if !feishu
            && desired.get("description").is_some()
            && desired.get("description") != remote.get("description")
        {
            Box::pin(self.update_goal_notice(root, b, text(desired, "description"), remote, check))
                .await?;
        }
        let current = member_ids(remote)?;
        let add: Vec<String> = member_ids(desired)?
            .into_iter()
            .filter(|id| !current.contains(id))
            .collect();
        for (ids, operation) in [(&add[..], "add"), (remove, "remove")] {
            if ids.is_empty() {
                continue;
            }
            Box::pin(self.require_owner(root, b)).await?;
            check()?;
            let arguments = if feishu {
                args(&[
                    "im",
                    "chat.members",
                    if operation == "add" {
                        "create"
                    } else {
                        "delete"
                    },
                    "--chat-id",
                    id,
                    "--member-id-type",
                    "open_id",
                    "--data",
                    &json!({"id_list": ids}).to_string(),
                ])
            } else {
                args(&[
                    "chat",
                    "group",
                    "members",
                    operation,
                    "--id",
                    id,
                    "--users",
                    &ids.join(","),
                ])
            };
            let raw = Box::pin(self.call(root, b, arguments, true)).await?;
            let value = data(&raw);
            if [
                "invalid_id_list",
                "not_existed_id_list",
                "pending_approval_id_list",
            ]
            .iter()
            .any(|key| has_rows(value, key))
            {
                return Err(PersonaError::bad(
                    "Some members were not applied; refresh before retry",
                ));
            }
        }
        Ok(Value::Null)
    }

    pub(crate) async fn history(
        &self,
        root: &str,
        b: &Value,
        cursor: &str,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let feishu = text(b, "channel") == "feishu";
        let mut arguments = if feishu {
            args(&[
                "im",
                "+chat-messages-list",
                "--chat-id",
                text(b, "id"),
                "--page-size",
                "50",
                "--no-reactions",
            ])
        } else {
            args(&[
                "chat",
                "+chat-messages",
                "--group",
                text(b, "id"),
                "--limit",
                "50",
            ])
        };
        if !cursor.is_empty() {
            arguments.extend(args(&[
                if feishu { "--page-token" } else { "--time" },
                cursor,
            ]));
        }
        let raw = Box::pin(self.call_inner(root, b, arguments, false, true)).await?;
        let value = data(&raw);
        let messages: Vec<Value> = rows(value, &["messages", "items"])?
            .iter()
            .map(message)
            .collect::<Result<_, _>>()?;
        let next = scalar(
            first(value, &["page_token", "next_page_token"])
                .or_else(|| value.pointer("/nextPage/time")),
        );
        let incomplete = value["partial"] == true
            || value["failedCount"].as_u64().unwrap_or(0) > 0
            || has_rows(value, "truncations")
            || (value["has_more"] == true && next.is_empty());
        Ok(json!({"messages": messages, "cursor": next, "incomplete": incomplete}))
    }

    pub(crate) async fn send(
        &self,
        root: &str,
        b: &Value,
        request_id: &str,
        content: &str,
        reply: Option<&Value>,
        check: Check<'_>,
    ) -> Result<Value, PersonaError> {
        Box::pin(self.verify(root, b)).await?;
        let feishu = text(b, "channel") == "feishu";
        let mut arguments = if feishu {
            if let Some(reply) = reply {
                args(&["im", "+messages-reply", "--message-id", text(reply, "id")])
            } else {
                args(&["im", "+messages-send", "--chat-id", text(b, "id")])
            }
        } else if let Some(reply) = reply {
            args(&[
                "chat",
                "message",
                "reply",
                "--group",
                text(b, "id"),
                "--ref-msg-id",
                text(reply, "id"),
                "--ref-sender",
                text(reply, "sender"),
                "--content",
                content,
                "--uuid",
                request_id,
            ])
        } else {
            args(&[
                "chat",
                "+messages-send",
                "--as",
                "user",
                "--group",
                text(b, "id"),
            ])
        };
        if feishu {
            arguments.extend(args(&[
                "--content",
                &json!({"text": content}).to_string(),
                "--msg-type",
                "text",
                "--idempotency-key",
                request_id,
            ]));
        } else if reply.is_none() {
            arguments.extend(args(&["--text", content, "--idempotency-key", request_id]));
        }
        check()?;
        Box::pin(self.call(root, b, arguments, true)).await?;
        Ok(Value::Null)
    }
}

fn upsert_person(people: &mut Vec<Value>, person: Value) {
    if let Some(index) = people.iter().position(|row| row["id"] == person["id"]) {
        people[index] = person;
    } else {
        people.push(person);
    }
}

fn member_ids(snapshot: &Value) -> Result<Vec<String>, PersonaError> {
    let mut result = Vec::new();
    for row in snapshot["members"]
        .as_array()
        .ok_or_else(|| PersonaError::bad("Invalid group snapshot"))?
    {
        let id = text(row, "id");
        if id.is_empty() {
            return Err(PersonaError::bad("Member identity unavailable"));
        }
        if !result.iter().any(|value| value == id) {
            result.push(id.to_string());
        }
    }
    Ok(result)
}

fn notice_description(content: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    let (heading, body) = normalized.split_once('\n').unwrap_or((&normalized, ""));
    (heading.trim() == "# X:goal").then(|| body.strip_prefix('\n').unwrap_or(body).to_string())
}

fn message(row: &Value) -> Result<Value, PersonaError> {
    let id = scalar(choose(&[
        row.get("message_id"),
        row.get("messageId"),
        row.get("id"),
    ]));
    let sender = scalar(choose(&[
        row.pointer("/sender/id"),
        row.pointer("/sender/open_id"),
        row.pointer("/sender/sender_id/open_id"),
        row.get("senderOpenDingTalkId"),
        row.get("senderId"),
    ]));
    if id.is_empty() || sender.is_empty() {
        return Err(PersonaError::bad("Message ID unavailable"));
    }
    let body = choose(&[
        row.get("text"),
        row.pointer("/content/text"),
        row.pointer("/body/content"),
        row.get("content"),
    ]);
    let body = match body {
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v["text"].as_str().map(str::to_string))
            .unwrap_or_else(|| raw.clone()),
        Some(value) => value.to_string(),
        None => String::new(),
    };
    let raw_time = choose(&[
        row.get("create_time"),
        row.get("createTime"),
        row.get("timestamp"),
        row.get("time"),
    ]);
    let numeric = raw_time.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
    });
    let millis = match numeric {
        Some(n) if n.is_finite() && n > 0.0 => {
            if n < 1e12 {
                n * 1000.0
            } else {
                n
            }
        }
        _ => raw_time
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|date| date.timestamp_millis() as f64)
            .filter(|time| *time > 0.0)
            .ok_or_else(|| PersonaError::bad("Message timestamp unavailable"))?,
    };
    let mut result = json!({"id": id, "sender": sender, "name": scalar(row.pointer("/sender/name").or_else(|| row.get("senderName"))), "text": body.chars().take(32_000).collect::<String>(), "time": millis as i64, "kind": scalar(first(row, &["msg_type", "message_type", "messageType"])).to_string()});
    if text(&result, "kind").is_empty() {
        result["kind"] = json!("text");
    }
    if let Some(raw) = first(row, &["url", "message_url"]).and_then(Value::as_str) {
        if let Ok(url) = url::Url::parse(raw) {
            if url.scheme() == "https"
                && url.host_str().is_some_and(|host| {
                    ["feishu.cn", "larksuite.com", "dingtalk.com"]
                        .iter()
                        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
                })
            {
                result["url"] = json!(raw);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_goal_heading_only_and_body_keeps_formatting() {
        assert_eq!(
            notice_description("# X:goal\r\n\r\n目标：发布\r\n角色：维护:小明"),
            Some("目标：发布\n角色：维护:小明".into())
        );
        assert_eq!(notice_description("# X:goal"), Some(String::new()));
        assert_eq!(notice_description("# X:goal for later\nprivate"), None);
        assert_eq!(notice_description("# News\n# X:goal\nprivate"), None);
    }

    #[test]
    fn incomplete_and_malformed_channel_data_fail_closed() {
        for value in [
            json!({"success": false}),
            json!({"partial": true}),
            json!({"code": 999}),
            json!({"failedCount": 1}),
            json!({"failures": ["user"]}),
        ] {
            assert!(incomplete(&value));
        }
        assert!(rows(&json!({"result": {"unknown": []}}), &["users"]).is_err());
        assert!(person(&json!({"name": "name only"}), &["open_id"], &["name"]).is_err());
        assert_eq!(
            rows(&json!({"data": {"users": []}}), &["users"])
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn messages_preserve_platform_identity_and_validate_timestamp_and_links() {
        let result = message(&json!({"message_id": "om_1", "sender": {"id": "ou_1", "name": "小明"}, "body": {"content": "{\"text\":\"hello\"}"}, "create_time": "1700000000", "url": "https://evil-feishu.cn/secret"})).unwrap();
        assert_eq!(result["time"], 1_700_000_000_000i64);
        assert_eq!(result["text"], "hello");
        assert!(result.get("url").is_none());
        assert!(message(&json!({"id": "m", "senderId": "u", "time": "yesterday"})).is_err());
        assert!(message(&json!({"id": "m", "time": 1})).is_err());
        let iso = message(&json!({"id": "m", "senderId": "u", "time": "2026-11-12T00:00:00Z", "url": "https://open.feishu.cn/message"})).unwrap();
        assert_eq!(iso["url"], "https://open.feishu.cn/message");
        for empty in [Value::Null, json!("")] {
            let fallback = message(&json!({
                "message_id":"", "id":"m", "sender":{"id":"", "open_id":"u"},
                "text":empty, "body":{"content":"{\"text\":\"kept\"}"},
                "create_time":null, "time":1700000000
            }))
            .unwrap();
            assert_eq!(fallback["id"], "m");
            assert_eq!(fallback["sender"], "u");
            assert_eq!(fallback["text"], "kept");
        }
    }
}
