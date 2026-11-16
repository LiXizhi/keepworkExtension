//! Persisted workspace identities match Node's canonicalRoot. This is a
//! spelling conversion, never a substitute for checking the current real path.
use serde_json::Value;
use std::path::PathBuf;

fn windows_identity(path: PathBuf) -> PathBuf {
    PathBuf::from(
        crate::paths::strip_verbatim(path)
            .to_string_lossy()
            .to_lowercase(),
    )
}

pub(super) fn normalize(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        windows_identity(path)
    } else {
        path
    }
}

pub(super) fn normalize_record(data: &mut Value) {
    for field in ["roots", "worktrees"] {
        if let Some(paths) = data[field].as_array_mut() {
            for path in paths {
                if let Some(raw) = path.as_str() {
                    *path = Value::String(normalize(PathBuf::from(raw)).to_string_lossy().into());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{canonical_root, AgentManager};
    use serde_json::json;

    #[test]
    fn windows_identity_matches_node_for_drive_and_unc_paths() {
        for (input, expected) in [
            (r"C:\Users\Alice\Workspace", r"c:\users\alice\workspace"),
            (r"\\?\C:\Users\Alice\Workspace", r"c:\users\alice\workspace"),
            (r"\\?\UNC\Server\Share\Work", r"\\server\share\work"),
            (r"\\Server\Share\Work", r"\\server\share\work"),
        ] {
            let identity = windows_identity(PathBuf::from(input));
            assert_eq!(identity, PathBuf::from(expected));
            assert_eq!(windows_identity(identity.clone()), identity);
        }
    }

    #[test]
    fn legacy_record_keeps_history_receipts_and_does_not_resolve_retargeted_roots() {
        let directory =
            std::env::temp_dir().join(format!("kp-root-identity-{}", uuid::Uuid::new_v4()));
        let original = directory.join("MixedCaseWorkspace");
        std::fs::create_dir_all(&original).unwrap();
        let root = canonical_root(original.to_str().unwrap()).unwrap();
        let registry = directory.join("sessions.json");
        let owner = "a".repeat(64);
        let mut record = json!({
            "id":"legacy","owner":owner,"threadId":"native-identity","conversationId":"legacy",
            "backend":"workbuddy","roots":[original.canonicalize().unwrap()],
            "worktrees":[original.canonicalize().unwrap()],"items":[{"id":"answer","type":"agentMessage","text":"saved"}],
            "status":"completed","cursor":7,"submissions":{"request-1":{"state":"completed","turnId":"turn-1"}}
        });
        let bytes = serde_json::to_vec(&vec![record.clone()]).unwrap();
        std::fs::write(&registry, &bytes).unwrap();
        // A read-only open converts the spelling in RAM without touching disk
        // or submitting historical requests to a provider.
        let manager = AgentManager::open(registry.clone(), 0);
        let loaded = manager.view("legacy", &owner).unwrap();
        assert_eq!(loaded["roots"], json!([root]));
        assert_eq!(loaded["items"], record["items"]);
        assert_eq!(loaded["threadId"], record["threadId"]);
        assert_eq!(loaded["lastSubmission"]["requestId"], "request-1");
        assert_eq!(std::fs::read(&registry).unwrap(), bytes);

        record["roots"] = json!([directory.join("MissingWorkspace")]);
        normalize_record(&mut record);
        assert!(canonical_root(record["roots"][0].as_str().unwrap()).is_err());
        assert_ne!(record["roots"], loaded["roots"]);
        drop(manager);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
