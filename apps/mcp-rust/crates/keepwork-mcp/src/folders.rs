//! `/fs/locations` and `/fs/browse`: the folder picker API (mirrors
//! `src/core/folderBrowser.ts`).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const FOLDER_BROWSER_API: &str = "folders-v1";

fn is_directory(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
}

fn home() -> PathBuf {
    crate::config::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn mac_folder(key: &str) -> Option<String> {
    let script = format!("POSIX path of (path to {key} from user domain)");
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn windows_user_folders() -> Vec<(String, String, String)> {
    // Fixed script; user data is never interpolated into PowerShell source.
    const SCRIPT: &str = "$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'; $f=@{}; foreach($p in $k.PSObject.Properties){if($p.Value -is [string]){$f[$p.Name]=[Environment]::ExpandEnvironmentVariables($p.Value)}}; $f | ConvertTo-Json -Compress";
    let output = match Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, key) in [
        ("Desktop", "Desktop"),
        ("Documents", "Personal"),
        ("Downloads", "{374DE290-123F-4565-9164-39C4925E467B}"),
        ("Pictures", "My Pictures"),
        ("Music", "My Music"),
        ("Videos", "My Video"),
    ] {
        if let Some(path) = value.get(key).and_then(Value::as_str) {
            out.push((
                name.to_string(),
                name.to_ascii_lowercase(),
                path.to_string(),
            ));
        }
    }
    out
}

pub fn folder_locations() -> Value {
    let home = home();
    let mut locations = vec![json!({ "id": "home", "name": "Home", "path": home })];
    let mut volumes: Vec<Value> = Vec::new();

    match platform() {
        "win32" => {
            for (name, id, path) in windows_user_folders() {
                if is_directory(Path::new(&path)) {
                    locations.push(json!({ "id": id, "name": name, "path": path }));
                }
            }
            for letter in b'C'..=b'Z' {
                let drive = format!("{}:\\", letter as char);
                if is_directory(Path::new(&drive)) {
                    volumes.push(json!({ "name": drive, "path": drive }));
                }
            }
        }
        "darwin" => {
            for (name, key) in [
                ("Desktop", "desktop folder"),
                ("Documents", "documents folder"),
                ("Downloads", "downloads folder"),
                ("Pictures", "pictures folder"),
                ("Music", "music folder"),
                ("Movies", "movies folder"),
            ] {
                if let Some(path) = mac_folder(key) {
                    if is_directory(Path::new(&path)) {
                        locations.push(json!({
                            "id": name.to_ascii_lowercase(),
                            "name": name,
                            "path": path,
                        }));
                    }
                }
            }
            volumes.push(json!({ "name": "Macintosh HD", "path": "/" }));
            if let Ok(entries) = std::fs::read_dir("/Volumes") {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if is_directory(&path) {
                        volumes.push(json!({
                            "name": entry.file_name().to_string_lossy(),
                            "path": path.to_string_lossy(),
                        }));
                    }
                }
            }
        }
        _ => volumes.push(json!({ "name": "Filesystem", "path": "/" })),
    }

    json!({
        "platform": platform(),
        "home": home.to_string_lossy(),
        "locations": locations,
        "volumes": volumes,
    })
}

fn absolute_folder(raw: &str) -> Result<PathBuf, String> {
    let expanded = crate::paths::expand_user_path(raw);
    let path = Path::new(&expanded);
    if !path.has_root() {
        return Err("An absolute directory path is required".to_string());
    }
    // On Windows, /folder is absolute to the current drive, as in path.resolve.
    let path = std::path::absolute(path).map_err(|error| error.to_string())?;
    // Match Node's path.resolve: preserve the selected symlink/junction name.
    // canonicalize would change that name and expose \\?\ Windows prefixes.
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    Ok(resolved)
}

/// Numeric-aware ordering close to Node's `localeCompare(..., { numeric: true })`.
fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek(), right_chars.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let left_number: String =
                    std::iter::from_fn(|| left_chars.next_if(|ch| ch.is_ascii_digit())).collect();
                let right_number: String =
                    std::iter::from_fn(|| right_chars.next_if(|ch| ch.is_ascii_digit())).collect();
                let left_value = left_number.trim_start_matches('0').len();
                let right_value = right_number.trim_start_matches('0').len();
                let ordering = left_value
                    .cmp(&right_value)
                    .then_with(|| left_number.cmp(&right_number));
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
            (Some(a), Some(b)) => {
                let a = a.to_ascii_lowercase();
                let b = b.to_ascii_lowercase();
                let ordering = a
                    .cmp(&b)
                    .then_with(|| left_chars.peek().cmp(&right_chars.peek()));
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

pub fn browse_folders(
    raw: &str,
    hidden: bool,
    filter: &str,
    offset: Option<f64>,
    limit: Option<f64>,
) -> Result<Value, String> {
    let current = absolute_folder(raw)?;
    let meta = std::fs::metadata(&current).map_err(|error| error.to_string())?;
    if !meta.is_dir() {
        return Err("Not a directory".to_string());
    }
    let parent = current.parent().map(Path::to_path_buf);
    let root = current
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    let mut breadcrumbs = vec![json!({
        "name": root.to_string_lossy(),
        "path": root.to_string_lossy(),
    })];
    if let Ok(rest) = current.strip_prefix(&root) {
        let mut built = root.clone();
        for part in rest.components() {
            built.push(part);
            breadcrumbs.push(json!({
                "name": part.as_os_str().to_string_lossy(),
                "path": built.to_string_lossy(),
            }));
        }
    }

    let mut entries: Vec<(String, String, bool, bool)> = Vec::new();
    let filter_lower = filter.to_lowercase();
    let Ok(dir) = std::fs::read_dir(&current) else {
        return Err(format!("cannot read {}", current.display()));
    };
    for item in dir.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        let is_hidden = name.starts_with('.');
        if is_hidden && !hidden {
            continue;
        }
        if !filter_lower.is_empty() && !name.to_lowercase().contains(&filter_lower) {
            continue;
        }
        let path = current.join(&name);
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let symlink = file_type.is_symlink();
        let directory = if symlink {
            is_directory(&path)
        } else {
            file_type.is_dir()
        };
        if !directory {
            continue;
        }
        entries.push((
            name,
            path.to_string_lossy().into_owned(),
            is_hidden,
            symlink,
        ));
    }
    entries.sort_by(|a, b| natural_cmp(&a.0, &b.0));

    let offset = offset
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0).floor() as usize)
        .unwrap_or(0);
    let limit = limit
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value.floor() as usize).min(200))
        .unwrap_or(100);
    let total = entries.len();
    let page: Vec<Value> = entries
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(name, path, hidden, symlink)| {
            json!({ "name": name, "path": path, "hidden": hidden, "symlink": symlink })
        })
        .collect();
    let next = offset + limit;
    Ok(json!({
        "path": current.to_string_lossy(),
        "parent": parent
            .filter(|parent| *parent != current)
            .map(|parent| parent.to_string_lossy().into_owned()),
        "breadcrumbs": breadcrumbs,
        "entries": page,
        "total": total,
        "nextOffset": if next < total { json!(next) } else { Value::Null },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_sorts_numbers_by_value() {
        let mut names = vec!["file10", "file2", "file1"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["file1", "file2", "file10"]);
    }

    #[test]
    fn browse_lists_only_directories() {
        let dir = std::env::temp_dir().join(format!("kp-browse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("file.txt"), b"x").unwrap();
        let value = browse_folders(&dir.to_string_lossy(), false, "", None, None).unwrap();
        let names: Vec<String> = value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(names, vec!["sub"]);
        assert_eq!(value["total"], 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(browse_folders("relative/dir", false, "", None, None).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn drive_relative_root_uses_the_current_drive() {
        let cwd = std::env::current_dir().unwrap();
        let root_relative: PathBuf = cwd.components().skip(1).collect();
        assert!(root_relative.has_root());
        assert!(!root_relative.is_absolute());
        let value = browse_folders(root_relative.to_str().unwrap(), false, "", None, None).unwrap();
        assert_eq!(value["path"], cwd.to_string_lossy().as_ref());
        assert_eq!(
            value["parent"],
            cwd.parent().unwrap().to_string_lossy().as_ref()
        );
    }
}
