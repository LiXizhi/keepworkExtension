//! Shared Node/Rust profiles-v1 storage. Native Claude settings are never edited.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MODEL_FIELDS: &[(&str, &str)] = &[
    ("model", "ANTHROPIC_MODEL"),
    ("sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
];
const READ_ERROR: &str =
    "Could not read Claude profiles; repair the local configuration before changing providers";
const SAVE_ERROR: &str = "Could not save Claude profiles; the previous configuration is unchanged";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: u8,
    revision: u64,
    active_profile_id: Option<String>,
    profiles: Vec<Value>,
}

pub(super) struct ClaudeProfiles {
    file: PathBuf,
    // Lazy loading keeps a damaged Claude configuration from blocking other CLIs.
    state: Mutex<Option<State>>,
}

#[derive(Clone)]
pub(super) struct Selection {
    pub key: String,
    profile: Option<Value>,
    directory: PathBuf,
}

pub(super) struct Prepared {
    environment: BTreeMap<String, String>,
    directory: Option<PathBuf>,
}

impl Default for Selection {
    fn default() -> Self {
        Self {
            key: "native".into(),
            profile: None,
            directory: PathBuf::new(),
        }
    }
}

fn text(input: &Value, key: &str, max: usize, required: bool) -> Result<String, String> {
    let value = input[key]
        .as_str()
        .ok_or_else(|| format!("Invalid Claude profile {key}"))?;
    if value.encode_utf16().count() > max
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        || (required && value.trim().is_empty())
    {
        return Err(format!("Invalid Claude profile {key}"));
    }
    Ok(value.trim().to_string())
}

fn validate(input: &Value, previous: Option<&Value>) -> Result<Value, String> {
    let fields = [
        "name",
        "baseUrl",
        "authType",
        "secret",
        "model",
        "sonnetModel",
        "opusModel",
        "haikuModel",
    ];
    let patch = input.as_object().ok_or("Invalid Claude profile fields")?;
    if patch.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("Invalid Claude profile fields".into());
    }
    let mut merged = previous.cloned().unwrap_or(json!({}));
    for (key, value) in patch {
        merged[key] = value.clone();
    }
    let name = text(&merged, "name", 80, true)?;
    let base_url = text(&merged, "baseUrl", 2048, true)?;
    let url_error = "Claude baseUrl must be an HTTP(S) URL without credentials, query or fragment";
    let url = url::Url::parse(&base_url).map_err(|_| url_error)?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some_and(|s| !s.is_empty())
        || url.query().is_some_and(|s| !s.is_empty())
        || url.fragment().is_some_and(|s| !s.is_empty())
    {
        return Err(url_error.into());
    }
    if !matches!(merged["authType"].as_str(), Some("apiKey" | "authToken")) {
        return Err("Invalid Claude profile authType".into());
    }
    let secret = text(&merged, "secret", 4096, true)?;
    let mut result =
        json!({"name":name,"baseUrl":base_url,"authType":merged["authType"],"secret":secret});
    for (field, _) in MODEL_FIELDS {
        if merged.get(*field).is_some() {
            let model = text(&merged, field, 200, false)?;
            if !model.is_empty() {
                result[*field] = json!(model);
            }
        }
    }
    Ok(result)
}

impl ClaudeProfiles {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            state: Mutex::new(None),
        }
    }

    fn load(&self) -> Result<State, String> {
        let raw = match std::fs::File::open(&self.file) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = Vec::new();
                file.take(512_001)
                    .read_to_end(&mut bytes)
                    .map_err(|_| READ_ERROR)?;
                if bytes.len() > 512_000 {
                    return Err(READ_ERROR.into());
                }
                serde_json::from_slice::<Value>(&bytes).map_err(|_| READ_ERROR)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(State {
                    version: 1,
                    revision: 0,
                    active_profile_id: None,
                    profiles: vec![],
                })
            }
            Err(_) => return Err(READ_ERROR.into()),
        };
        if !raw.is_object() || raw.get("activeProfileId").is_none() {
            return Err(READ_ERROR.into());
        }
        let mut state: State = serde_json::from_value(raw).map_err(|_| READ_ERROR)?;
        if state.version != 1 || state.revision > 9_007_199_254_740_991 || state.profiles.len() > 50
        {
            return Err(READ_ERROR.into());
        }
        let mut ids = std::collections::HashSet::new();
        for profile in &mut state.profiles {
            let mut input = profile.as_object().cloned().ok_or(READ_ERROR)?;
            let id = input
                .remove("id")
                .and_then(|v| v.as_str().map(str::to_owned))
                .filter(|id| super::valid_id(id))
                .ok_or(READ_ERROR)?;
            if !ids.insert(id.clone()) {
                return Err(READ_ERROR.into());
            }
            *profile = validate(&Value::Object(input), None).map_err(|_| READ_ERROR)?;
            profile["id"] = json!(id);
        }
        if state
            .active_profile_id
            .as_ref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err(READ_ERROR.into());
        }
        Ok(state)
    }

    fn with_state<T>(
        &self,
        operation: impl FnOnce(&mut State) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.state.lock().expect("Claude profiles");
        if state.is_none() {
            *state = Some(self.load()?);
        }
        operation(state.as_mut().unwrap())
    }

    fn snapshot(state: &State) -> Value {
        let profiles: Vec<_> = state
            .profiles
            .iter()
            .map(|profile| {
                let mut view = profile.clone();
                view.as_object_mut().unwrap().remove("secret");
                view["hasSecret"] = json!(true);
                view
            })
            .collect();
        json!({"version":1,"activeProfileId":state.active_profile_id,"profiles":profiles})
    }

    fn commit(&self, state: &mut State, mut next: State) -> Result<Value, String> {
        next.revision = next
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(SAVE_ERROR)?;
        let parent = self.file.parent().ok_or(SAVE_ERROR)?;
        std::fs::create_dir_all(parent).map_err(|_| SAVE_ERROR)?;
        let temporary = parent.join(format!("claude-profiles-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let bytes = serde_json::to_vec(&next).map_err(|_| SAVE_ERROR)?;
            if bytes.len() > 512_000 {
                return Err(SAVE_ERROR);
            }
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| SAVE_ERROR)?;
            file.write_all(&bytes).map_err(|_| SAVE_ERROR)?;
            file.sync_all().map_err(|_| SAVE_ERROR)?;
            drop(file);
            std::fs::rename(&temporary, &self.file).map_err(|_| SAVE_ERROR)
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
        *state = next;
        Ok(Self::snapshot(state))
    }

    pub fn call(&self, method: &str, id: Option<&str>, input: &Value) -> Result<Value, String> {
        self.with_state(|state| {
            if method == "read" { return Ok(Self::snapshot(state)); }
            let mut next = state.clone();
            match method {
                "create" => {
                    if next.profiles.len() >= 50 { return Err("Claude profile limit reached (50)".into()); }
                    let mut profile = validate(input, None)?;
                    profile["id"] = json!(uuid::Uuid::new_v4().to_string());
                    next.profiles.push(profile);
                }
                "update" | "delete" => {
                    let index = next.profiles.iter().position(|p| p["id"].as_str() == id).ok_or("Claude profile not found")?;
                    if method == "delete" {
                        if next.active_profile_id.as_deref() == id { return Err("Switch to another Claude profile or native configuration before deleting the active profile".into()); }
                        next.profiles.remove(index);
                    } else {
                        let mut profile = validate(input, Some(&next.profiles[index]))?;
                        profile["id"] = json!(id);
                        next.profiles[index] = profile;
                    }
                }
                "activate" => {
                    let fields = input.as_object().ok_or("profileId required")?;
                    if fields.len() != 1 || !fields.contains_key("profileId") { return Err("profileId required".into()); }
                    next.active_profile_id = if input["profileId"].is_null() { None }
                    else { Some(input["profileId"].as_str().filter(|id| next.profiles.iter().any(|p| p["id"] == *id)).ok_or("Claude profile not found")?.to_string()) };
                }
                _ => return Err("Unsupported Claude configuration operation".into()),
            }
            self.commit(state, next)
        })
    }

    pub fn selection(&self) -> Result<Selection, String> {
        self.with_state(|state| {
            let profile = state
                .profiles
                .iter()
                .find(|p| p["id"].as_str() == state.active_profile_id.as_deref())
                .cloned();
            let key = profile
                .as_ref()
                .map(|p| {
                    format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(p).expect("profile JSON"))
                    )
                })
                .unwrap_or_else(|| "native".into());
            Ok(Selection {
                key,
                profile,
                directory: self.file.parent().ok_or(READ_ERROR)?.join("claude-launch"),
            })
        })
    }
}

impl Selection {
    pub fn configured_models(&self) -> Vec<Value> {
        MODEL_FIELDS
            .iter()
            .filter_map(|(field, _)| {
                let value = self.profile.as_ref()?[*field].as_str()?;
                Some(json!({"value":value,"displayName":value,"isDefault":*field == "model"}))
            })
            .collect()
    }

    pub fn prepare(&self) -> Result<Prepared, String> {
        let Some(profile) = &self.profile else {
            return Ok(Prepared {
                environment: BTreeMap::new(),
                directory: None,
            });
        };
        let mut environment = BTreeMap::new();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
            "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
            "ANTHROPIC_CUSTOM_HEADERS",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "ANTHROPIC_DEFAULT_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ] {
            environment.insert(key.into(), String::new());
        }
        for key in [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
            "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
            "CLAUDE_CODE_USE_MANTLE",
        ] {
            environment.insert(key.into(), "0".into());
        }
        environment.insert(
            "ANTHROPIC_BASE_URL".into(),
            profile["baseUrl"].as_str().unwrap().into(),
        );
        environment.insert(
            if profile["authType"] == "apiKey" {
                "ANTHROPIC_API_KEY"
            } else {
                "ANTHROPIC_AUTH_TOKEN"
            }
            .into(),
            profile["secret"].as_str().unwrap().into(),
        );
        for (field, key) in MODEL_FIELDS {
            environment.insert((*key).into(), profile[*field].as_str().unwrap_or("").into());
        }
        let error = "Could not prepare private Claude provider settings";
        let directory = self
            .directory
            .join(format!("provider-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| error)?;
        let prepared = Prepared {
            environment,
            directory: Some(directory),
        };
        let settings = json!({"env":prepared.environment,"model":profile["model"].as_str().unwrap_or("default"),"apiKeyHelper":""});
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(prepared.directory.as_ref().unwrap().join("settings.json"))
            .map_err(|_| error)?;
        file.write_all(&serde_json::to_vec(&settings).map_err(|_| error)?)
            .map_err(|_| error)?;
        Ok(prepared)
    }
}

impl Prepared {
    pub fn apply(&self, command: &mut tokio::process::Command) {
        if let Some(directory) = &self.directory {
            for (key, _) in std::env::vars_os() {
                if self
                    .environment
                    .contains_key(&key.to_string_lossy().to_ascii_uppercase())
                {
                    command.env_remove(key);
                }
            }
            command
                .envs(&self.environment)
                .arg("--settings")
                .arg(directory.join("settings.json"));
        }
    }
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("kp-claude-profiles-{}", uuid::Uuid::new_v4())))
        }
        fn store(&self) -> ClaudeProfiles {
            ClaudeProfiles::new(self.0.join("claude-profiles-v1.json"))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn input() -> Value {
        json!({"name":"Fixture gateway","baseUrl":"https://gateway.example.test/anthropic","authType":"authToken","secret":"fixture-only-secret","model":"gateway-default","sonnetModel":"gateway-sonnet"})
    }

    #[test]
    fn updates_preserve_credentials_and_failed_writes_preserve_memory_and_disk() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let saved = store.call("create", None, &input()).unwrap();
        let id = saved["profiles"][0]["id"].as_str().unwrap();
        assert!(!saved.to_string().contains("fixture-only-secret"));
        store
            .call("activate", None, &json!({"profileId":id}))
            .unwrap();
        store
            .call("update", Some(id), &json!({"name":"Renamed"}))
            .unwrap();
        let before = store.call("read", None, &json!({})).unwrap();
        let bytes = std::fs::read(&store.file).unwrap();
        assert!(store
            .call("update", Some(id), &json!({"secret":"secret\nheader"}))
            .is_err());
        assert_eq!(store.call("read", None, &json!({})).unwrap(), before);
        assert_eq!(std::fs::read(&store.file).unwrap(), bytes);
        // A read-only/broken destination must not advance the in-memory selection.
        std::fs::remove_file(&store.file).unwrap();
        std::fs::create_dir(&store.file).unwrap();
        assert!(store
            .call("activate", None, &json!({"profileId":null}))
            .is_err());
        assert_eq!(store.call("read", None, &json!({})).unwrap(), before);
    }

    #[test]
    fn private_settings_override_provider_fields_and_clean_up_without_touching_native_configuration(
    ) {
        let fixture = Fixture::new();
        let store = fixture.store();
        let saved = store.call("create", None, &input()).unwrap();
        store
            .call(
                "activate",
                None,
                &json!({"profileId":saved["profiles"][0]["id"]}),
            )
            .unwrap();
        let restored = fixture.store();
        let selection = restored.selection().unwrap();
        let prepared = selection.prepare().unwrap();
        let settings_file = prepared.directory.as_ref().unwrap().join("settings.json");
        let settings: Value =
            serde_json::from_slice(&std::fs::read(&settings_file).unwrap()).unwrap();
        assert_eq!(
            settings["env"]["ANTHROPIC_AUTH_TOKEN"],
            "fixture-only-secret"
        );
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
        assert_eq!(settings["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "");
        assert_eq!(settings["env"]["CLAUDE_CODE_USE_VERTEX"], "0");
        assert_eq!(
            settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            "gateway-sonnet"
        );
        assert_eq!(settings["apiKeyHelper"], "");
        assert_eq!(settings["model"], "gateway-default");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&settings_file)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&restored.file)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(prepared);
        assert!(!settings_file.exists());
        store
            .call("activate", None, &json!({"profileId":null}))
            .unwrap();
        let native = store.selection().unwrap().prepare().unwrap();
        assert!(native.directory.is_none());
        assert!(native.environment.is_empty());
    }

    #[test]
    fn corrupted_storage_is_preserved_and_never_replaced_with_empty_state() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(&fixture.0).unwrap();
        let file = fixture.store().file;
        for raw in [
            "{broken",
            r#"{"version":1,"revision":0,"activeProfileId":"missing","profiles":[]}"#,
        ] {
            std::fs::write(&file, raw).unwrap();
            assert!(fixture.store().call("create", None, &input()).is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), raw);
        }
    }
}
