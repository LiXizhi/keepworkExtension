use super::sender::verify_main_sender;
use super::state::AppCore;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{fs, io::Write, path::Path, sync::Arc};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 32 * 1024 * 1024;

#[tauri::command]
pub(super) async fn desktop_save_markdown_export(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    file_name: String,
    data: String,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let extension = export_extension(&file_name)?;
    let bytes = decode_export(&data, extension)?;
    let dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("导出 Markdown")
        .set_file_name(&file_name)
        .add_filter(
            if extension == "md" { "Markdown" } else { "ZIP" },
            &[extension],
        );
    let Some(destination) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let path = destination.into_path().map_err(|e| e.to_string())?;
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
    {
        return Err(format!("请选择以 .{extension} 结尾的文件名"));
    }
    write_export(&path, &bytes).map_err(|e| format!("无法保存 Markdown 导出文件：{e}"))?;
    Ok(true)
}

fn export_extension(name: &str) -> Result<&str, String> {
    let invalid = || "无效的 Markdown 导出文件名".to_owned();
    let (stem, extension) = name.rsplit_once('.').ok_or_else(invalid)?;
    if name.len() > 255
        || stem.trim().is_empty()
        || matches!(stem, "." | "..")
        || !matches!(extension, "md" | "zip")
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(invalid());
    }
    Ok(extension)
}

fn decode_export(data: &str, extension: &str) -> Result<Vec<u8>, String> {
    let too_large = || "Markdown 导出文件超过 32 MiB".to_owned();
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(too_large());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(data)
        .map_err(|_| "无效的 Markdown 导出数据")?;
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    if (extension == "md" && std::str::from_utf8(&bytes).is_err())
        || (extension == "zip" && !bytes.starts_with(b"PK\x03\x04"))
    {
        return Err("无效的 Markdown 导出数据".to_owned());
    }
    Ok(bytes)
}

fn write_export(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_file_name(format!(".keepwork-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_export_name_and_payload() {
        assert_eq!(export_extension("对话.md").unwrap(), "md");
        assert_eq!(export_extension("会话树.zip").unwrap(), "zip");
        for name in ["../chat.md", "C:\\chat.md", "chat\n.md", ".md", "x.exe"] {
            assert!(export_extension(name).is_err(), "{name:?}");
        }
        let markdown = "# 你好 🌱\n".as_bytes();
        assert_eq!(
            decode_export(&URL_SAFE_NO_PAD.encode(markdown), "md").unwrap(),
            markdown
        );
        assert!(decode_export(&URL_SAFE_NO_PAD.encode(markdown), "zip").is_err());
        assert!(decode_export("_w", "md").is_err());
    }

    #[test]
    fn writes_exact_bytes_and_cleans_up_when_replace_fails() {
        let root = std::env::temp_dir().join(format!("keepwork-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("test.md");
        write_export(&path, b"# Original\n").unwrap();
        write_export(&path, b"# Replacement\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"# Replacement\n");
        let directory = root.join("existing.md");
        fs::create_dir(&directory).unwrap();
        assert!(write_export(&directory, b"failure").is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(&root).unwrap();
    }
}
