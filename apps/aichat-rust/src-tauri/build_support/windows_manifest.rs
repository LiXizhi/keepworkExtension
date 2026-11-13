use std::path::Path;

pub fn linker_args(target_os: &str, target_env: &str, manifest: &Path) -> Option<[String; 2]> {
    if target_os != "windows" || target_env != "msvc" {
        return None;
    }
    Some([
        "/MANIFEST:EMBED".into(),
        format!("/MANIFESTINPUT:{}", manifest.display()),
    ])
}
