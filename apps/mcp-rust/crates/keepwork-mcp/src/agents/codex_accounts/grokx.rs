use super::{child_directory, name, path_identity, GROKX_PREFIX, MAX_ACCOUNTS};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const APP_ID: &str = "com.chenliao.grokx";
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const MAX_LEGACY_BYTES: u64 = 16 * MAX_SETTINGS_BYTES;
// Preserve the picker contract: at most 100 total rows, including default.
const MAX_PROFILES: usize = 100 - 1 - MAX_ACCOUNTS;

pub(super) struct Profile {
    pub id: String,
    pub label: String,
    pub home: PathBuf,
}

fn data_directory() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = crate::config::home_dir()?.join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let base = data_env("APPDATA").or_else(dirs::data_dir)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = data_env("XDG_DATA_HOME")
        .or_else(|| crate::config::home_dir().map(|home| home.join(".local/share")))?;
    let root = crate::paths::strip_verbatim(base.canonicalize().ok()?);
    child_directory(&root, APP_ID, false).ok().flatten()
}

#[cfg(not(target_os = "macos"))]
fn data_env(variable: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn local_file(path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.is_file()
        && path.canonicalize().is_ok_and(|real| {
            path_identity::normalize(real) == path_identity::normalize(path.to_path_buf())
        })
}

fn database_accounts(database: &Path) -> Option<Value> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(Duration::from_millis(100)).ok()?;
    db.execute_batch("PRAGMA trusted_schema = OFF;").ok()?;
    let rows: Option<String> = db
        .query_row(
            "SELECT json_extract(json, '$.agentAccounts.codex') FROM kv \
             WHERE key = 'settings' AND length(CAST(json AS BLOB)) <= ?1",
            [MAX_SETTINGS_BYTES as i64],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()?
        .flatten();
    serde_json::from_str(&rows?).ok()
}

fn legacy_accounts(root: &Path) -> Option<Value> {
    let file = root.join("state.json");
    let metadata = file.symlink_metadata().ok()?;
    if !local_file(&file, &metadata) || metadata.len() > MAX_LEGACY_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(file)
        .ok()?
        .take(MAX_LEGACY_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_LEGACY_BYTES {
        return None;
    }
    let mut state: Value = serde_json::from_slice(&bytes).ok()?;
    state
        .pointer_mut("/settings/agentAccounts/codex")
        .map(Value::take)
}

fn read_accounts(root: &Path) -> Option<Value> {
    let database = root.join("state.db");
    match database.symlink_metadata() {
        Ok(metadata) if local_file(&database, &metadata) => database_accounts(&database),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => legacy_accounts(root),
        _ => None,
    }
}

fn profile_id(owner: &str, native_id: &str) -> String {
    // Expose a stable reference scoped to the same owner and Origin as Keepwork
    // sessions. The GrokX folder name is never an accepted API account ID.
    let hash = Sha256::digest([owner.as_bytes(), b"\0", native_id.as_bytes()].concat());
    format!(
        "{GROKX_PREFIX}{:032x}",
        u128::from_be_bytes(hash[..16].try_into().unwrap())
    )
}

fn profiles_at(root: &Path, owner: &str) -> Option<Vec<Profile>> {
    let accounts = child_directory(root, "cli-accounts", false).ok()??;
    let codex = child_directory(&accounts, "codex", false).ok()??;
    let Value::Array(rows) = read_accounts(root)? else {
        return None;
    };
    let mut seen = HashSet::new();
    Some(
        rows.iter()
            .filter_map(|row| {
                let native_id = row["id"].as_str()?;
                if native_id.is_empty()
                    || native_id == "default"
                    || native_id.len() > 64
                    || !native_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                {
                    return None;
                }
                let label = name(&row["label"])?;
                let home = child_directory(&codex, native_id, false).ok()??;
                seen.insert(native_id).then(|| Profile {
                    id: profile_id(owner, native_id),
                    label: label.into(),
                    home,
                })
            })
            .take(MAX_PROFILES)
            .collect(),
    )
}

pub(super) fn profiles(owner: &str) -> Vec<Profile> {
    data_directory()
        .and_then(|root| profiles_at(&root, owner))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("keepwork-grokx-{}", uuid::Uuid::new_v4()));
            for id in ["a123", "a456", "orphan"] {
                fs::create_dir_all(root.join("cli-accounts/codex").join(id)).unwrap();
            }
            Self(crate::paths::strip_verbatim(root.canonicalize().unwrap()))
        }

        fn legacy(&self) {
            fs::write(
                self.0.join("state.json"),
                json!({"settings":{"agentAccounts":{"codex":[{"id":"a123","label":"Old name"}]}}})
                    .to_string(),
            )
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_registered_homes_and_renames_in_the_active_wal() {
        let fixture = Fixture::new();
        fixture.legacy();
        let db = Connection::open(fixture.0.join("state.db")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;\
             CREATE TABLE kv(key TEXT PRIMARY KEY, json TEXT NOT NULL);",
        )
        .unwrap();
        let settings = json!({"agentAccounts":{"codex":[
            {"id":"a123","label":"Personal"},
            {"id":"a456","label":"Boss"},
            {"id":"missing","label":"Missing"},
            {"id":"../codex/orphan","label":"Invalid path"},
            {"id":"a456","label":"Duplicate"}
        ]}});
        db.execute(
            "INSERT INTO kv VALUES ('settings', ?1)",
            [settings.to_string()],
        )
        .unwrap();

        let profiles = profiles_at(&fixture.0, "owner").unwrap();
        assert_eq!(
            profiles
                .iter()
                .map(|p| p.label.as_str())
                .collect::<Vec<_>>(),
            ["Personal", "Boss"]
        );
        assert_eq!(profiles[1].home, fixture.0.join("cli-accounts/codex/a456"));
        assert!(super::super::valid_account_id(&profiles[1].id));
        assert_ne!(
            profiles[1].id,
            profiles_at(&fixture.0, "owner-at-other-origin").unwrap()[1].id
        );

        let renamed = json!({"agentAccounts":{"codex":[{"id":"a456","label":"Work"}]}});
        db.execute(
            "UPDATE kv SET json = ?1 WHERE key = 'settings'",
            [renamed.to_string()],
        )
        .unwrap();
        let updated = profiles_at(&fixture.0, "owner").unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].label, "Work");
        assert_eq!(updated[0].id, profiles[1].id);
    }

    #[test]
    fn uses_legacy_roster_only_when_database_is_absent() {
        let fixture = Fixture::new();
        fixture.legacy();
        assert_eq!(
            profiles_at(&fixture.0, "owner").unwrap()[0].label,
            "Old name"
        );
        fs::write(fixture.0.join("state.db"), b"not a sqlite database").unwrap();
        assert!(profiles_at(&fixture.0, "owner").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_registered_home_retargeted_as_a_symlink() {
        let fixture = Fixture::new();
        fixture.legacy();
        let home = fixture.0.join("cli-accounts/codex/a123");
        fs::remove_dir(&home).unwrap();
        std::os::unix::fs::symlink(fixture.0.join("cli-accounts/codex/orphan"), home).unwrap();
        assert!(profiles_at(&fixture.0, "owner").unwrap().is_empty());
    }
}
