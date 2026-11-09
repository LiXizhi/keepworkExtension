use crate::files::{is_symlink_or_junction, NativeFiles};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrainFolderInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub granted: bool,
}

pub fn default_brain_folder(
    files: &NativeFiles,
    documents_dir: &Path,
    prepare: bool,
) -> Result<BrainFolderInfo, String> {
    let target = documents_dir.join("MyBrain");
    let target_str = target.to_string_lossy().into_owned();
    if !prepare {
        let exists = fs::symlink_metadata(&target)
            .map(|m| m.is_dir() && !is_symlink_or_junction(&target))
            .unwrap_or(false);
        let existing_grant = files
            .roots()
            .into_iter()
            .find(|g| Path::new(&g.path) == target);
        return Ok(BrainFolderInfo {
            id: existing_grant.as_ref().map(|g| g.id.clone()),
            path: target_str,
            name: "MyBrain".to_string(),
            exists,
            granted: existing_grant.is_some(),
        });
    }

    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if is_symlink_or_junction(&target) || !meta.is_dir() {
                return Err("MyBrain 已被其他文件或链接占用，请选择其他文件夹".to_string());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&target)
                .map_err(|err| format!("Failed to create MyBrain folder: {err}"))?;
        }
        Err(e) => return Err(format!("Failed to inspect MyBrain folder: {e}")),
    }

    let grant = files.grant(&target)?;
    Ok(BrainFolderInfo {
        id: Some(grant.id),
        path: grant.path,
        name: grant.name,
        exists: true,
        granted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn preview_has_no_side_effects_and_prepare_rejects_occupied_or_symlink() {
        let root = std::env::temp_dir().join(format!("aichat-rust-brain-{}", Uuid::new_v4()));
        let docs = root.join("Documents With Spaces");
        let files = NativeFiles::new(root.join("grants.json"));

        let preview = default_brain_folder(&files, &docs, false).unwrap();
        assert_eq!(preview.path, docs.join("MyBrain").to_string_lossy());
        assert!(!docs.exists());
        assert!(files.roots().is_empty());

        let prepared = default_brain_folder(&files, &docs, true).unwrap();
        assert!(prepared.id.is_some());
        assert!(docs.join("MyBrain").is_dir());
        assert_eq!(files.roots().len(), 1);

        //Occupied by file
        let root2 = std::env::temp_dir().join(format!("aichat-rust-brain-occ-{}", Uuid::new_v4()));
        fs::create_dir_all(&root2).unwrap();
        fs::write(root2.join("MyBrain"), "preserve").unwrap();
        let files2 = NativeFiles::new(root2.join("grants.json"));
        let err = default_brain_folder(&files2, &root2, true).unwrap_err();
        assert!(err.contains("占用"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }
}
