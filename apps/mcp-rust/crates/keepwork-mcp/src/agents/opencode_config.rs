use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

const MAX_MODELS: usize = 50;
const MAX_DISCOVERED: usize = 500;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const DISCOVERY_LIMIT: usize = 2_000_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderV1 {
    name: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderV2 {
    name: String,
    base_url: String,
    models: Vec<String>,
    api_key: String,
}

struct Provider {
    name: String,
    base_url: String,
    models: Vec<String>,
    api_key: String,
}

pub(super) fn is_managed_model(model: &str) -> bool {
    model
        .strip_prefix("keepwork-openai-")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(id, _)| {
            id.len() == 16
                && id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
}

fn valid_model(model: &str) -> bool {
    let bytes = model.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 200
        && (bytes[0].is_ascii_alphanumeric() || b"@._~+-".contains(&bytes[0]))
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"@._:/~+=-".contains(b))
        && !matches!(model, "constructor" | "prototype" | "__proto__")
}

fn normalize_base_url(raw_url: &str) -> Result<String, String> {
    let unsafe_char = raw_url
        .bytes()
        .any(|b| b < 32 || matches!(b, 127 | b'{' | b'}'));
    url::Url::parse(raw_url)
        .ok()
        .filter(|url| {
            let lower = raw_url.to_ascii_lowercase();
            !raw_url.trim().is_empty()
                && !unsafe_char
                && raw_url.len() <= 2048
                && (lower.starts_with("https://") || lower.starts_with("http://"))
                && !raw_url.contains(['?', '#', '\\'])
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.as_str().trim_end_matches('/').len() <= 2048
        })
        .map(|url| url.as_str().trim_end_matches('/').to_owned())
        .ok_or_else(|| {
            "OpenCode Base URL must be HTTP(S) without credentials, query or fragment".into()
        })
}

fn model_list(
    input: &Value,
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<String>, String> {
    let Some(value) = object.get("models") else {
        let model = input["model"]
            .as_str()
            .filter(|model| valid_model(model))
            .ok_or("Invalid OpenCode model ID")?;
        return Ok(vec![model.to_owned()]);
    };
    let list = value.as_array().ok_or("Invalid OpenCode model list")?;
    if list.is_empty() || list.len() > MAX_MODELS {
        return Err("Invalid OpenCode model list".into());
    }
    let mut models: Vec<String> = Vec::new();
    for item in list {
        let model = item
            .as_str()
            .filter(|model| valid_model(model))
            .ok_or("Invalid OpenCode model ID")?;
        if !models.iter().any(|saved| saved == model) {
            models.push(model.to_owned());
        }
    }
    if models.is_empty() {
        return Err("Invalid OpenCode model list".into());
    }
    if let Some(model) = object.get("model") {
        if model.as_str() != Some(models[0].as_str()) {
            return Err("OpenCode model must match the first models entry".into());
        }
    }
    Ok(models)
}

fn validate(input: &Value, previous: Option<&Provider>) -> Result<Provider, String> {
    let object = input
        .as_object()
        .filter(|object| {
            object.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "name" | "baseUrl" | "model" | "models" | "apiKey"
                )
            })
        })
        .ok_or("Invalid OpenCode provider fields")?;
    let field = |key: &str, value: Option<&str>, max: usize| {
        value
            .filter(|s| {
                !s.trim().is_empty()
                    && s.len() <= max
                    && !s.bytes().any(|b| b < 32 || matches!(b, 127 | b'{' | b'}'))
            })
            .map(|value| value.trim().to_owned())
            .ok_or_else(|| format!("Invalid OpenCode provider {key}"))
    };
    let name = field("name", input["name"].as_str(), 80)?;
    let models = model_list(input, object)?;
    let base_url = normalize_base_url(&field("baseUrl", input["baseUrl"].as_str(), 2048)?)?;
    let saved_key = previous
        .filter(|saved| saved.base_url == base_url)
        .map(|saved| saved.api_key.as_str());
    let api_key = field(
        "apiKey",
        if object.contains_key("apiKey") {
            input["apiKey"].as_str()
        } else {
            saved_key
        },
        4096,
    )?;
    Ok(Provider {
        name,
        base_url,
        models,
        api_key,
    })
}

fn clean_model_name(value: Option<&Value>) -> Option<String> {
    let name = value?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '{' | '}'))
        .collect::<String>();
    let name = name.trim();
    (!name.is_empty() && name.len() <= 200).then(|| name.to_owned())
}

pub(super) struct OpenCodeConfig {
    file: PathBuf,
    models_file: PathBuf,
    lock: Mutex<()>,
}

impl OpenCodeConfig {
    pub fn new(file: PathBuf) -> Self {
        let models_file = file
            .parent()
            .map(|parent| parent.join("opencode-provider-v2.json"))
            .unwrap_or_else(|| PathBuf::from("opencode-provider-v2.json"));
        Self {
            file,
            models_file,
            lock: Mutex::new(()),
        }
    }

    fn read(&self, file: &PathBuf) -> Result<Value, String> {
        let error = "Could not read the local OpenCode API configuration";
        match file.metadata() {
            Ok(meta) if meta.len() <= 20_000 => {}
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Value::Null),
            _ => return Err(error.into()),
        }
        serde_json::from_slice(&std::fs::read(file).map_err(|_| error)?).map_err(|_| error.into())
    }

    fn load_v1(&self) -> Result<Option<ProviderV1>, String> {
        let error = "Could not read the local OpenCode API configuration";
        let saved = self.read(&self.file)?;
        if saved.is_null() {
            return Ok(None);
        }
        if saved["version"] != 1 {
            return Err(error.into());
        }
        match saved.get("provider") {
            Some(Value::Null) => Ok(None),
            Some(value) => {
                let provider: ProviderV1 =
                    serde_json::from_value(value.clone()).map_err(|_| error)?;
                if provider.name.trim().is_empty()
                    || provider.name.len() > 80
                    || !valid_model(&provider.model)
                    || normalize_base_url(&provider.base_url).ok().as_deref()
                        != Some(provider.base_url.as_str())
                    || provider.api_key.trim().is_empty()
                    || provider.api_key.len() > 4096
                {
                    return Err(error.into());
                }
                Ok(Some(provider))
            }
            None => Err(error.into()),
        }
    }

    fn load_v2(&self) -> Option<ProviderV2> {
        let saved = self.read(&self.models_file).ok()?;
        if saved["version"] != 2 {
            return None;
        }
        let provider: ProviderV2 = serde_json::from_value(saved.get("provider")?.clone()).ok()?;
        if provider.name.trim().is_empty()
            || provider.name.len() > 80
            || provider.models.is_empty()
            || provider.models.len() > MAX_MODELS
            || provider.models.iter().any(|model| !valid_model(model))
            || normalize_base_url(&provider.base_url).ok().as_deref()
                != Some(provider.base_url.as_str())
            || provider.api_key.trim().is_empty()
            || provider.api_key.len() > 4096
        {
            return None;
        }
        Some(provider)
    }

    fn load(&self) -> Result<Option<Provider>, String> {
        let Some(v1) = self.load_v1()? else {
            return Ok(None);
        };
        if let Some(v2) = self.load_v2() {
            // An older daemon may have rewritten v1 after v2 was created. Only
            // accept the extended list when both copies describe the same provider.
            if v2.name == v1.name
                && v2.base_url == v1.base_url
                && v2.models.first() == Some(&v1.model)
                && v2.api_key == v1.api_key
            {
                return Ok(Some(Provider {
                    name: v2.name,
                    base_url: v2.base_url,
                    models: v2.models,
                    api_key: v2.api_key,
                }));
            }
        }
        Ok(Some(Provider {
            name: v1.name,
            base_url: v1.base_url,
            models: vec![v1.model],
            api_key: v1.api_key,
        }))
    }

    fn write(&self, file: &PathBuf, value: &Value) -> Result<(), String> {
        let error = "Could not save the local OpenCode API configuration";
        let parent = file.parent().ok_or(error)?;
        std::fs::create_dir_all(parent).map_err(|_| error)?;
        let temporary = parent.join(format!("opencode-provider-{}.tmp", uuid::Uuid::new_v4()));
        let write = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec(value).map_err(|_| error)?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut handle = options.open(&temporary).map_err(|_| error)?;
            handle.write_all(&bytes).map_err(|_| error)?;
            handle.sync_all().map_err(|_| error)?;
            drop(handle);
            std::fs::rename(&temporary, file).map_err(|_| error.to_string())
        })();
        let _ = std::fs::remove_file(&temporary);
        write
    }

    fn save(&self, provider: Option<&Provider>) -> Result<(), String> {
        let Some(provider) = provider else {
            self.write(&self.file, &json!({"version":1,"provider":Value::Null}))?;
            let _ = std::fs::remove_file(&self.models_file);
            return Ok(());
        };
        let extended = provider.models.len() > 1;
        if extended {
            self.write(
                &self.models_file,
                &json!({"version":2,"provider":{
                    "name":provider.name,"baseUrl":provider.base_url,"models":provider.models,"apiKey":provider.api_key
                }}),
            )?;
        }
        let written = self.write(
            &self.file,
            &json!({"version":1,"provider":{
                "name":provider.name,"baseUrl":provider.base_url,"model":provider.models[0],"apiKey":provider.api_key
            }}),
        );
        if let Err(error) = written {
            if extended {
                let _ = std::fs::remove_file(&self.models_file);
            }
            return Err(error);
        }
        if !extended {
            let _ = std::fs::remove_file(&self.models_file);
        }
        Ok(())
    }

    fn snapshot(provider: Option<&Provider>) -> Value {
        json!({"version":1,"provider":provider.map(|p| json!({
            "name":p.name,"baseUrl":p.base_url,"model":p.models[0],"models":p.models,"hasApiKey":true
        }))})
    }

    pub fn call(&self, method: &str, input: &Value) -> Result<Value, String> {
        let _lock = self.lock.lock().unwrap();
        let provider = match method {
            "GET" => self.load()?,
            "PATCH" => Some(validate(input, self.load()?.as_ref())?),
            _ => None,
        };
        let result = Self::snapshot(provider.as_ref());
        if method == "GET" {
            return Ok(result);
        }
        self.save(provider.as_ref())?;
        Ok(result)
    }

    /// Fetch the provider model catalog server-side so the key never reaches a
    /// cross-origin browser request and CORS does not decide what the user sees.
    pub async fn discover_models(&self, input: &Value) -> Result<Value, String> {
        let object = input
            .as_object()
            .filter(|object| {
                object
                    .keys()
                    .all(|key| matches!(key.as_str(), "baseUrl" | "apiKey"))
            })
            .ok_or("Invalid OpenCode model discovery fields")?;
        let base_url = normalize_base_url(
            object
                .get("baseUrl")
                .and_then(Value::as_str)
                .ok_or("Invalid OpenCode Base URL")?,
        )?;
        if let Some(value) = object.get("apiKey") {
            let valid = value.as_str().is_some_and(|key| {
                key.len() <= 4096
                    && !key
                        .bytes()
                        .any(|b| b < 32 || matches!(b, 127 | b'{' | b'}'))
            });
            if !valid {
                return Err("Invalid OpenCode provider apiKey".into());
            }
        }
        let saved = {
            let _lock = self.lock.lock().unwrap();
            self.load()?
        };
        let api_key = object
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                saved
                    .filter(|provider| provider.base_url == base_url)
                    .map(|provider| provider.api_key)
            })
            .ok_or("AUTH_REQUIRED: OpenCode API Key required for this Base URL")?;
        let client = reqwest::Client::builder()
            .timeout(DISCOVERY_TIMEOUT)
            .build()
            .map_err(|_| "Could not prepare the OpenCode model request".to_string())?;
        let response = match client
            .get(format!("{base_url}/models"))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return Ok(json!({
                    "version":1,
                    "status":if error.is_timeout() {"timeout"} else {"unreachable"},
                    "models":[]
                }))
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Ok(json!({
                "version":1,"status":"auth","models":[],"message":format!("HTTP {}", status.as_u16())
            }));
        }
        if !status.is_success() {
            return Ok(json!({
                "version":1,"status":"error","models":[],"message":format!("HTTP {}", status.as_u16())
            }));
        }
        let mut response = response;
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > DISCOVERY_LIMIT {
                        return Ok(json!({
                            "version":1,"status":"error","models":[],"message":"OpenCode model list is too large"
                        }));
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => {
                    return Ok(json!({
                        "version":1,"status":"error","models":[],"message":"Could not read the model list"
                    }))
                }
            }
        }
        let Ok(value) = serde_json::from_slice::<Value>(&body) else {
            return Ok(json!({
                "version":1,"status":"error","models":[],"message":"Invalid JSON model list"
            }));
        };
        let rows = if value.is_array() {
            value.as_array().map(|rows| rows.iter().collect::<Vec<_>>())
        } else {
            value["data"]
                .as_array()
                .or_else(|| value["models"].as_array())
                .map(|rows| rows.iter().collect::<Vec<_>>())
        };
        let Some(rows) = rows else {
            return Ok(json!({
                "version":1,"status":"error","models":[],"message":"Invalid JSON model list"
            }));
        };
        let mut models: Vec<Value> = Vec::new();
        let total = rows.len();
        for row in rows {
            let id = match row {
                Value::String(id) => Some(id.as_str()),
                Value::Object(object) => object
                    .get("id")
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str),
                _ => None,
            };
            let Some(id) = id.filter(|id| valid_model(id)) else {
                continue;
            };
            if models.iter().any(|model| model["id"] == id) {
                continue;
            }
            let name = row
                .as_object()
                .and_then(|object| {
                    clean_model_name(
                        object
                            .get("name")
                            .or_else(|| object.get("display_name"))
                            .or_else(|| object.get("displayName")),
                    )
                })
                .filter(|name| name != id);
            models.push(match name {
                Some(name) => json!({"id":id,"name":name}),
                None => json!({"id":id}),
            });
            if models.len() >= MAX_DISCOVERED {
                break;
            }
        }
        let mut result = json!({
            "version":1,
            "status":if models.is_empty() {"empty"} else {"ok"},
            "models":models
        });
        if models.len() >= MAX_DISCOVERED && total > models.len() {
            result["truncated"] = json!(true);
        }
        Ok(result)
    }

    pub fn launch(&self, selected: Option<&str>) -> Result<Option<Launch>, String> {
        let _lock = self.lock.lock().unwrap();
        let Some(provider) = self.load()? else {
            return Ok(None);
        };
        Ok(Some(Launch::new(provider, selected)?))
    }
}

pub(super) struct Launch {
    provider: Provider,
    models: Vec<(String, String)>,
    pub generation: String,
}

impl Launch {
    fn new(provider: Provider, selected: Option<&str>) -> Result<Self, String> {
        let models = provider
            .models
            .iter()
            .map(|model| {
                let digest = Sha256::digest(format!("{}\0{}", provider.base_url, model));
                let id = format!("keepwork-openai-{}", &format!("{digest:x}")[..16]);
                (id, model.clone())
            })
            .collect::<Vec<_>>();
        let managed = |(id, model): &(String, String)| format!("{id}/{model}");
        let model = match selected {
            Some(selected) => models
                .iter()
                .map(managed)
                .find(|candidate| candidate.as_str() == selected)
                // A saved provider edit invalidates the previous selection. Do
                // not silently run a different model than the session requested.
                .ok_or("The saved OpenCode provider changed. Select its current model in a new conversation.")?,
            None => managed(&models[0]),
        };
        let generation = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}\0{}\0{}\0{}\0{}",
                    provider.name,
                    provider.base_url,
                    provider.models.join("\0"),
                    provider.api_key,
                    model
                )
                .as_bytes()
            )
        );
        Ok(Self {
            provider,
            models,
            generation,
        })
    }

    pub fn environment(&self) -> Result<[(&'static str, String); 2], String> {
        let parse_error =
            "Custom OpenCode API requires OPENCODE_CONFIG_CONTENT to be a JSON object";
        let mut native: Value = serde_json::from_str(
            &std::env::var("OPENCODE_CONFIG_CONTENT")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "{}".into()),
        )
        .map_err(|_| parse_error)?;
        let object = native.as_object_mut().ok_or(parse_error)?;
        let providers = object
            .entry("provider")
            .or_insert(json!({}))
            .as_object_mut()
            .ok_or(parse_error)?;
        let env_key = "KEEPWORK_OPENCODE_API_KEY";
        for (id, model) in &self.models {
            providers.insert(
                id.clone(),
                json!({
                    "name":self.provider.name,
                    "npm":"@ai-sdk/openai-compatible",
                    "options":{"baseURL":self.provider.base_url,"apiKey":format!("{{env:{env_key}}}")},
                    "models":{(model):{"name":format!("{} ({})", model, self.provider.name)}},
                }),
            );
        }
        Ok([
            ("OPENCODE_CONFIG_CONTENT", native.to_string()),
            (env_key, self.provider.api_key.clone()),
        ])
    }
}
