use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::Mutex,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    name: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Serialize)]
struct State {
    version: u8,
    provider: Option<Provider>,
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

fn validate(input: &Value, previous: Option<&Provider>) -> Result<Provider, String> {
    let object = input
        .as_object()
        .filter(|object| {
            object
                .keys()
                .all(|key| matches!(key.as_str(), "name" | "baseUrl" | "model" | "apiKey"))
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
    let model = field("model", input["model"].as_str(), 200)?;
    if !(model.as_bytes()[0].is_ascii_alphanumeric() || b"@._~+-".contains(&model.as_bytes()[0]))
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@._:/~+=-".contains(&b))
        || matches!(model.as_str(), "constructor" | "prototype" | "__proto__")
    {
        return Err("Invalid OpenCode model ID".into());
    }
    let raw_url = field("baseUrl", input["baseUrl"].as_str(), 2048)?;
    let base_url = url::Url::parse(&raw_url)
        .ok()
        .filter(|url| {
            let lower = raw_url.to_ascii_lowercase();
            (lower.starts_with("https://") || lower.starts_with("http://"))
                && !raw_url.contains(['?', '#', '\\'])
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.as_str().trim_end_matches('/').len() <= 2048
        })
        .map(|url| url.as_str().trim_end_matches('/').to_owned())
        .ok_or("OpenCode Base URL must be HTTP(S) without credentials, query or fragment")?;
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
        model,
        api_key,
    })
}

pub(super) struct OpenCodeConfig {
    file: PathBuf,
    lock: Mutex<()>,
}

impl OpenCodeConfig {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<Option<Provider>, String> {
        let error = "Could not read the local OpenCode API configuration";
        match self.file.metadata() {
            Ok(meta) if meta.len() <= 20_000 => {}
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            _ => return Err(error.into()),
        }
        let saved: Value = serde_json::from_slice(&std::fs::read(&self.file).map_err(|_| error)?)
            .map_err(|_| error)?;
        if saved["version"] != 1 {
            return Err(error.into());
        }
        match saved.get("provider") {
            Some(Value::Null) => Ok(None),
            Some(value) => validate(value, None).map(Some).map_err(|_| error.into()),
            None => Err(error.into()),
        }
    }

    pub fn call(&self, method: &str, input: &Value) -> Result<Value, String> {
        let _lock = self.lock.lock().unwrap();
        let provider = match method {
            "GET" => self.load()?,
            "PATCH" => Some(validate(input, self.load()?.as_ref())?),
            _ => None,
        };
        let result = json!({"version":1,"provider":provider.as_ref().map(|p| json!({
            "name":p.name,"baseUrl":p.base_url,"model":p.model,"hasApiKey":true
        }))});
        if method == "GET" {
            return Ok(result);
        }

        let error = "Could not save the local OpenCode API configuration";
        let parent = self.file.parent().ok_or(error)?;
        std::fs::create_dir_all(parent).map_err(|_| error)?;
        let temporary = parent.join(format!("opencode-provider-{}.tmp", uuid::Uuid::new_v4()));
        let write = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec(&State {
                version: 1,
                provider,
            })
            .map_err(|_| error)?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|_| error)?;
            file.write_all(&bytes).map_err(|_| error)?;
            file.sync_all().map_err(|_| error)?;
            drop(file);
            std::fs::rename(&temporary, &self.file).map_err(|_| error.into())
        })();
        let _ = std::fs::remove_file(&temporary);
        write.map(|()| result)
    }

    pub fn launch(&self, selected: Option<&str>) -> Result<Option<Launch>, String> {
        let _lock = self.lock.lock().unwrap();
        let launch = self.load()?.map(Launch::new);
        if selected.is_some_and(|model| launch.as_ref().is_none_or(|launch| launch.model != model))
        {
            return Err("The saved OpenCode provider changed. Select its current model in a new conversation.".into());
        }
        Ok(launch)
    }
}

pub(super) struct Launch {
    provider: Provider,
    id: String,
    model: String,
    pub generation: String,
}

impl Launch {
    fn new(provider: Provider) -> Self {
        let digest = Sha256::digest(format!("{}\0{}", provider.base_url, provider.model));
        let id = format!("keepwork-openai-{}", &format!("{digest:x}")[..16]);
        let model = format!("{}/{}", id, provider.model);
        let generation = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&provider).expect("OpenCode provider"))
        );
        Self {
            provider,
            id,
            model,
            generation,
        }
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
        providers.insert(
            self.id.clone(),
            json!({
                "name":self.provider.name,
                "npm":"@ai-sdk/openai-compatible",
                "options":{"baseURL":self.provider.base_url,"apiKey":format!("{{env:{env_key}}}")},
                "models":{(&self.provider.model):{"name":format!("{} ({})", self.provider.model, self.provider.name)}},
            }),
        );
        Ok([
            ("OPENCODE_CONFIG_CONTENT", native.to_string()),
            (env_key, self.provider.api_key.clone()),
        ])
    }
}
