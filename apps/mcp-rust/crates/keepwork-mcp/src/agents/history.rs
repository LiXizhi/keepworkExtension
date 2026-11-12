//! Node-compatible ACP / Antigravity history. The registry is shared by independently shipped
//! hosts, so transcripts must remain readable after switching runtime engines.
use super::discovery::{definition, Protocol};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 16 * 1024 * 1024;

fn sidecar(file: &Path, backend: &str, thread: &str) -> Result<Option<PathBuf>, String> {
    let Some(spec) = definition(backend) else {
        return Ok(None);
    };
    if !matches!(spec.protocol, Protocol::Acp | Protocol::Antigravity) {
        return Ok(None);
    }
    if thread.is_empty()
        || thread.len() > 160
        || !thread
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("Invalid native history thread ID".into());
    }
    let name = file
        .file_name()
        .ok_or("Invalid agent registry path")?
        .to_string_lossy();
    Ok(Some(
        file.with_file_name(format!("{name}.{backend}"))
            .join(format!("{thread}.json")),
    ))
}

pub fn load(file: &Path, backend: &str, thread: &str) -> Result<Option<Value>, String> {
    let Some(path) = sidecar(file, backend, thread)? else {
        return Ok(None);
    };
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("Native history could not be read; original data was preserved".into())
        }
    };
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err("Native history is too large or invalid; original data was preserved".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|_| "Native history could not be read; original data was preserved")?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Native history is unreadable; original data was preserved")?;
    if value["id"] != thread
        || !value["cwd"].is_string()
        || !value["turns"].is_array()
        || !Path::new(value["cwd"].as_str().unwrap_or_default()).is_absolute()
    {
        return Err("Native history has an incompatible shape; original data was preserved".into());
    }
    Ok(Some(value))
}

fn safe(value: &Value, depth: usize, budget: &mut usize) -> Value {
    if super::images::is_inline(value) {
        return json!({"type":"image"});
    }
    if depth > 24 || *budget < 16 {
        return Value::Null;
    }
    *budget -= 16;
    match value {
        Value::String(text) => {
            let limit = (*budget).min(131_072);
            let bounded = text.chars().take(limit).collect::<String>();
            *budget = budget.saturating_sub(bounded.len());
            json!(bounded)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(2000)
                .map(|item| safe(item, depth + 1, budget))
                .collect(),
        ),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .filter(|(key, _)| {
                    let key = key.to_ascii_lowercase();
                    ![
                        "token",
                        "password",
                        "secret",
                        "authorization",
                        "cookie",
                        "capability",
                        "mcpservers",
                    ]
                    .iter()
                    .any(|private| key.contains(private))
                })
                .take(2000)
                .map(|(key, value)| (key.clone(), safe(value, depth + 1, budget)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub fn save(file: &Path, data: &Value, native: &Value) -> Result<(), String> {
    let backend = data["backend"].as_str().unwrap_or("codex");
    let thread = data["threadId"]
        .as_str()
        .ok_or("Native history thread ID required")?;
    let Some(path) = sidecar(file, backend, thread)? else {
        return Ok(());
    };
    let existing = load(file, backend, thread)?;
    let cwd = data["roots"]
        .as_array()
        .and_then(|roots| roots.first())
        .and_then(Value::as_str)
        .ok_or("Native history workspace required")?;
    if !Path::new(cwd).is_absolute() {
        return Err("Native history workspace must be absolute".into());
    }
    // A legacy Gemini ACP record has no Antigravity driver. Its wrapper ID is
    // not an agy conversation ID, so saving its readable history must never
    // silently turn it into an Antigravity conversation.
    let antigravity = definition(backend)
        .is_some_and(|spec| spec.protocol == Protocol::Antigravity)
        && native["driver"] == "antigravity-v1"
        && existing
            .as_ref()
            .is_none_or(|old| old["driver"] == "antigravity-v1");
    let mut out = existing.unwrap_or_else(|| json!({"id":thread,"cwd":cwd,"turns":[]}));
    out["id"] = json!(thread);
    out["cwd"] = json!(cwd);
    // Metadata is an allowlist: never serialize the MCP proxy descriptor, its
    // capability bearer, browser login, or a live process's loaded flag.
    for key in ["models", "modes", "normalMode", "configOptions"] {
        if let Some(value) = native.get(key).filter(|value| !value.is_null()) {
            out[key] = safe(value, 0, &mut 2_000_000);
        }
    }
    if antigravity {
        if out["nativeId"].is_string()
            && native["nativeId"].is_string()
            && out["nativeId"] != native["nativeId"]
        {
            return Err(
                "Antigravity history identity mismatch; original data was preserved".into(),
            );
        }
        for key in ["driver", "nativeId", "model", "effort", "mode", "roots"] {
            if let Some(value) = native.get(key) {
                out[key] = safe(value, 0, &mut 2_000_000);
            }
        }
    }
    let obj = out.as_object_mut().ok_or("Invalid native history")?;
    obj.remove("loaded");
    obj.remove("mcpServers");
    let turns = out["turns"]
        .as_array_mut()
        .ok_or("Invalid native history turns")?;
    let mut fresh = vec![];
    if let Some(items) = data["items"].as_array() {
        let mut budget = 2_000_000;
        for item in items {
            let mut present = false;
            for turn in turns.iter_mut() {
                let Some(previous_items) = turn["items"].as_array_mut() else {
                    continue;
                };
                if let Some(previous) =
                    previous_items
                        .iter_mut()
                        .find(|previous| match item["id"].as_str() {
                            Some(id) => previous["id"] == id,
                            None => **previous == *item,
                        })
                {
                    // Keep fields added by another host when a normalized view
                    // has fewer fields, while applying actual item updates.
                    let update = safe(item, 0, &mut budget);
                    if let (Some(before), Some(after)) =
                        (previous.as_object_mut(), update.as_object())
                    {
                        for (key, value) in after {
                            before.insert(key.clone(), value.clone());
                        }
                    } else {
                        *previous = update;
                    }
                    present = true;
                    break;
                }
            }
            if !present {
                fresh.push(safe(item, 0, &mut budget));
            }
        }
    }
    let turn_id = data["turnId"].as_str().filter(|id| !id.is_empty());
    if !fresh.is_empty() {
        let key = turn_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("restored-{}", data["id"].as_str().unwrap_or(thread)));
        if let Some(turn) = turns.iter_mut().find(|turn| turn["id"] == key) {
            let target = turn["items"]
                .as_array_mut()
                .ok_or("Invalid native turn items")?;
            target.extend(fresh);
        } else {
            turns.push(json!({"id":key,"status":data["status"],"items":fresh}));
        }
    }
    if let Some(key) = turn_id {
        if let Some(turn) = turns.iter_mut().find(|turn| turn["id"] == key) {
            if let Some(status) = data["status"].as_str() {
                turn["status"] = json!(status);
            }
        }
    }
    let bytes = serde_json::to_vec(&out).map_err(|_| "Could not encode native history")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("Native history limit reached; original data was preserved".into());
    }
    let parent = path.parent().ok_or("Invalid native history path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create native history directory")?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temporary)
            .map_err(|_| "Could not save native history")?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "Could not save native history")?;
        std::fs::rename(&temporary, &path).map_err(|_| "Could not activate native history")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temporary(PathBuf);
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (Temporary, PathBuf, Value) {
        let directory = std::env::temp_dir().join(format!("kp-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("agent-sessions-v1.json");
        let data = json!({"id":"session","backend":"workbuddy","threadId":"thread","roots":[directory],"status":"completed","turnId":"new-turn","items":[]});
        (Temporary(directory), file, data)
    }

    #[test]
    fn node_turns_and_additive_fields_survive_rust_history_updates() {
        let (_temp, file, mut data) = setup();
        let cache = sidecar(&file, "workbuddy", "thread").unwrap().unwrap();
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        let old = json!({"id":"thread","cwd":data["roots"][0],"turns":[{"id":"native-old","status":"completed","providerField":7,"items":[{"id":"old-item","type":"agentMessage","text":"old answer","providerField":8}]}],"models":{"currentModelId":"old-model"},"mcpServers":[{"env":{"KEEPWORK_AICHAT_CAPABILITY":"private-capability"}}],"loaded":true});
        std::fs::write(&cache, serde_json::to_vec(&old).unwrap()).unwrap();
        data["items"] = json!([{"id":"old-item","type":"agentMessage","text":"old answer"},{"id":"new-item","type":"agentMessage","text":"new answer","token":"private-token"}]);
        save(
            &file,
            &data,
            &json!({"models":{"currentModelId":"new-model"},"mcpServers":["must not persist"]}),
        )
        .unwrap();
        let loaded = load(&file, "workbuddy", "thread").unwrap().unwrap();
        assert_eq!(loaded["turns"][0]["id"], "native-old");
        assert_eq!(loaded["turns"][0]["providerField"], 7);
        assert_eq!(loaded["turns"][0]["items"][0]["providerField"], 8);
        assert_eq!(loaded["turns"][1]["items"][0]["text"], "new answer");
        assert_eq!(loaded["models"]["currentModelId"], "new-model");
        let raw = std::fs::read_to_string(&cache).unwrap();
        assert!(
            !raw.contains("private-capability")
                && !raw.contains("private-token")
                && !raw.contains("mcpServers")
                && !raw.contains("loaded")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&cache).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        save(&file, &data, &Value::Null).unwrap();
        assert_eq!(
            load(&file, "workbuddy", "thread").unwrap().unwrap()["turns"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn invalid_history_is_never_overwritten_and_thread_paths_cannot_escape() {
        let (_temp, file, data) = setup();
        let cache = sidecar(&file, "workbuddy", "thread").unwrap().unwrap();
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(&cache, b"broken original").unwrap();
        assert!(save(&file, &data, &Value::Null).is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), b"broken original");
        assert!(load(&file, "workbuddy", "../outside").is_err());
        assert_eq!(load(&file, "codex", "thread").unwrap(), None);
    }

    #[test]
    fn antigravity_native_identity_and_settings_survive_both_runtime_histories() {
        let (_temp, file, mut data) = setup();
        data["backend"] = json!("gemini");
        let metadata = json!({"driver":"antigravity-v1","nativeId":"native-conversation","model":"native-model","effort":"high","mode":"plan","roots":data["roots"],"mcpServers":[{"env":{"CAPABILITY":"private-capability"}}]});
        data["items"] = json!([{"id":"rust-item","type":"agentMessage","text":"Rust 中文"}]);
        save(&file, &data, &metadata).unwrap();
        let cache = sidecar(&file, "gemini", "thread").unwrap().unwrap();
        assert_eq!(
            cache.parent().unwrap().file_name().unwrap(),
            "agent-sessions-v1.json.gemini"
        );
        let mut node = load(&file, "gemini", "thread").unwrap().unwrap();
        for key in ["driver", "nativeId", "model", "effort", "mode", "roots"] {
            assert_eq!(node[key], metadata[key]);
        }
        node["turns"].as_array_mut().unwrap().push(json!({"id":"node-turn","status":"completed","items":[{"id":"node-item","type":"agentMessage","text":"Node answer","providerField":9}]}));
        std::fs::write(&cache, serde_json::to_vec(&node).unwrap()).unwrap();
        data["items"] = json!([{"id":"rust-item","type":"agentMessage","text":"Rust 中文"},{"id":"node-item","type":"agentMessage","text":"Node answer"}]);
        save(&file, &data, &Value::Null).unwrap();
        let restored = load(&file, "gemini", "thread").unwrap().unwrap();
        assert_eq!(restored["nativeId"], "native-conversation");
        assert_eq!(restored["turns"].as_array().unwrap().len(), 2);
        assert_eq!(restored["turns"][1]["items"][0]["providerField"], 9);
        let raw = std::fs::read_to_string(cache).unwrap();
        assert!(!raw.contains("private-capability") && !raw.contains("mcpServers"));
    }

    #[test]
    fn legacy_gemini_history_is_readable_and_never_upgraded_to_antigravity() {
        let (_temp, file, mut data) = setup();
        data["backend"] = json!("gemini");
        let cache = sidecar(&file, "gemini", "thread").unwrap().unwrap();
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        let legacy = json!({"id":"thread","cwd":data["roots"][0],"turns":[{"id":"legacy-turn","items":[{"id":"legacy-item","type":"agentMessage","text":"Saved Gemini answer"}]}],"models":{"currentModelId":"old-gemini"}});
        std::fs::write(&cache, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(load(&file, "gemini", "thread").unwrap().unwrap(), legacy);
        save(&file, &data, &json!({"driver":"antigravity-v1","nativeId":"unrelated-native-id","model":"new-model","roots":data["roots"]})).unwrap();
        let preserved = load(&file, "gemini", "thread").unwrap().unwrap();
        assert!(preserved.get("driver").is_none());
        assert!(preserved.get("nativeId").is_none());
        assert!(preserved.get("model").is_none());
        assert_eq!(preserved["turns"], legacy["turns"]);
    }

    #[test]
    fn antigravity_history_never_rebinds_the_original_native_conversation() {
        let (_temp, file, mut data) = setup();
        data["backend"] = json!("gemini");
        save(
            &file,
            &data,
            &json!({"driver":"antigravity-v1","nativeId":"original-id"}),
        )
        .unwrap();
        let cache = sidecar(&file, "gemini", "thread").unwrap().unwrap();
        let original = std::fs::read(&cache).unwrap();
        assert!(save(
            &file,
            &data,
            &json!({"driver":"antigravity-v1","nativeId":"different-id"})
        )
        .unwrap_err()
        .contains("identity mismatch"));
        assert_eq!(std::fs::read(&cache).unwrap(), original);
        assert!(load(&file, "gemini", "../outside").is_err());
    }
}
