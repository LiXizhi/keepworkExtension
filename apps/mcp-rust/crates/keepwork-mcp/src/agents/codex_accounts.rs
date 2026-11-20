//! Named accounts get private directories. Only Codex reads or writes login data.
use super::{id, path_identity, AgentManager};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_ACCOUNTS: usize = 16;
const METADATA: &str = "account.json";
const UNAVAILABLE: &str = "Codex account profile unavailable";

pub(super) fn valid_account_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub(super) fn account_id<'a>(
    backend: &str,
    field: Option<&'a Value>,
) -> Result<Option<&'a str>, String> {
    let Some(field) = field else { return Ok(None) };
    if backend != "codex" {
        return Err("UNSUPPORTED_FEATURE: Account profiles require Codex".into());
    }
    match field.as_str() {
        Some("default") => Ok(None),
        Some(id) if valid_account_id(id) => Ok(Some(id)),
        _ => Err("Invalid Codex account ID".into()),
    }
}

fn name(value: &Value) -> Option<&str> {
    let text = value.as_str()?.trim();
    (!text.is_empty() && text.encode_utf16().count() <= 80 && !text.chars().any(char::is_control))
        .then_some(text)
}

fn create_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    fs::create_dir(path)
}

// Check each component below the daemon's real config root, including junctions.
fn child_directory(parent: &Path, entry: &str, create: bool) -> Result<Option<PathBuf>, String> {
    let child = parent.join(entry);
    if create {
        if let Err(error) = create_directory(&child) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(UNAVAILABLE.into());
            }
        }
    }
    let metadata = match child.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UNAVAILABLE.into()),
    };
    let real = child.canonicalize().map_err(|_| UNAVAILABLE)?;
    if !metadata.is_dir()
        || path_identity::normalize(real) != path_identity::normalize(child.clone())
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(Some(child))
}

fn read_name(directory: &Path) -> Result<String, String> {
    let file = directory.join(METADATA);
    if !file
        .symlink_metadata()
        .is_ok_and(|info| info.is_file() && info.len() <= 1024)
    {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    fs::File::open(file)
        .map_err(|_| UNAVAILABLE)?
        .take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    let entry: Value = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    Ok(name(&entry["name"]).ok_or(UNAVAILABLE)?.into())
}

impl AgentManager {
    fn codex_owner_dir(&self, owner: &str, create: bool) -> Result<Option<PathBuf>, String> {
        if owner.len() != 64 || !owner.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Agent owner key required".into());
        }
        let root = self.file.parent().ok_or(UNAVAILABLE)?;
        if create {
            fs::create_dir_all(root).map_err(|_| UNAVAILABLE)?;
        }
        let root = match root.canonicalize() {
            Ok(root) => crate::paths::strip_verbatim(root),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(UNAVAILABLE.into()),
        };
        let Some(accounts) = child_directory(&root, "codex-accounts-v1", create)? else {
            return Ok(None);
        };
        child_directory(&accounts, owner, create)
    }

    pub(super) fn codex_home(&self, owner: &str, account: &str) -> Result<PathBuf, String> {
        if !valid_account_id(account) {
            return Err("Invalid Codex account ID".into());
        }
        let parent = self.codex_owner_dir(owner, false)?.ok_or(UNAVAILABLE)?;
        let directory = child_directory(&parent, account, false)?.ok_or(UNAVAILABLE)?;
        read_name(&directory)?;
        // Keep the metadata outside the directory managed by the CLI.
        child_directory(&directory, "home", false)?.ok_or_else(|| UNAVAILABLE.into())
    }

    fn named_codex_accounts(&self, owner: &str) -> Result<Vec<Value>, String> {
        let mut accounts = Vec::new();
        if let Some(directory) = self.codex_owner_dir(owner, false)? {
            for entry in fs::read_dir(&directory).map_err(|_| UNAVAILABLE)? {
                let entry = entry.map_err(|_| UNAVAILABLE)?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if !valid_account_id(&id) {
                    continue;
                }
                let Some(profile) = child_directory(&directory, &id, false)? else {
                    continue;
                };
                // account.json is written last. A partially created profile
                // can never be selected or interpreted as the default account.
                if let Ok(name) = read_name(&profile) {
                    accounts.push(json!({"id": id, "name": name}));
                }
                if accounts.len() > MAX_ACCOUNTS {
                    return Err("Codex account profile limit reached".into());
                }
            }
        }
        accounts.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(accounts)
    }

    pub(super) fn codex_accounts(&self, owner: &str) -> Result<Value, String> {
        let _guard = self.codex_accounts_lock.lock().map_err(|_| UNAVAILABLE)?;
        let mut accounts = self.named_codex_accounts(owner)?;
        accounts.insert(0, json!({"id": "default", "name": "默认"}));
        Ok(json!({"accounts": accounts}))
    }

    pub(super) fn create_codex_account(&self, owner: &str, input: &Value) -> Result<Value, String> {
        if input.as_object().is_none_or(|object| object.len() != 1) {
            return Err("Unexpected Codex account fields".into());
        }
        let name = name(&input["name"]).ok_or("Invalid Codex account name")?;
        let _guard = self.codex_accounts_lock.lock().map_err(|_| UNAVAILABLE)?;
        let accounts = self.named_codex_accounts(owner)?;
        if name == "默认" || accounts.iter().any(|entry| entry["name"] == name) {
            return Err("A Codex account with this name already exists".into());
        }
        if accounts.len() >= MAX_ACCOUNTS {
            return Err("Codex account profile limit reached".into());
        }
        let owner_dir = self.codex_owner_dir(owner, true)?.ok_or(UNAVAILABLE)?;
        let id = id();
        let directory = owner_dir.join(&id);
        create_directory(&directory).map_err(|_| UNAVAILABLE)?;
        let result = (|| {
            create_directory(&directory.join("home")).map_err(|_| UNAVAILABLE)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let temp = directory.join("account.tmp");
            let mut file = options.open(&temp).map_err(|_| UNAVAILABLE)?;
            file.write_all(json!({"name": name}).to_string().as_bytes())
                .map_err(|_| UNAVAILABLE)?;
            file.sync_all().map_err(|_| UNAVAILABLE)?;
            drop(file);
            fs::rename(temp, directory.join(METADATA)).map_err(|_| UNAVAILABLE)?;
            Ok(json!({"id": id, "name": name}))
        })();
        if result.is_err() {
            // Only remove the empty directory and files created by this request.
            let _ = fs::remove_file(directory.join("account.tmp"));
            let _ = fs::remove_dir(directory.join("home"));
            let _ = fs::remove_dir(directory);
        }
        result
    }
}
