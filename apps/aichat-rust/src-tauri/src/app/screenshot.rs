//! Capture-only, document-bound permission for the native desktop bridge.
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, WebviewWindow};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

use super::{launch::trusted_main_document_origin, state::AppCore};

const MAX_JPEG: usize = 3 * 1024 * 1024;
#[cfg(not(target_os = "macos"))]
const ONCE: &str = "允许本次";
#[cfg(not(target_os = "macos"))]
const ALWAYS: &str = "始终允许此来源截图";
const DENIED: &str = "桌面截图请求已取消。";

#[derive(Default)]
pub(super) struct ScreenshotAccess {
    // A second request must never inherit the decision for the first request.
    busy: tokio::sync::Mutex<()>,
    revision: Mutex<u64>,
}

fn grant_path(core: &AppCore) -> PathBuf {
    core.profile_dir.join("desktop-screenshot-origins.json")
}
fn grants(path: &Path) -> Result<BTreeSet<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "无法读取本机截图授权记录。".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(e) => Err(format!("无法读取本机截图授权记录：{e}")),
    }
}
fn change_grant(path: &Path, scope: &str, enabled: bool) -> Result<(), String> {
    let mut saved = grants(path)?;
    let changed = if enabled {
        saved.insert(scope.to_owned())
    } else {
        saved.remove(scope)
    };
    if changed {
        crate::files::atomic_json_write(path, &saved)?;
    }
    Ok(())
}

struct Caller {
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    origin: String,
}
impl Caller {
    fn bind(window: WebviewWindow, document: String, token: &str) -> Result<Self, String> {
        let app = window.app_handle().clone();
        let origin = {
            let core = app.state::<Arc<AppCore>>();
            let origin = trusted_main_document_origin(&window, &core)?;
            let mut intents = core.launch_intents.lock().unwrap();
            intents.authenticate(token)?;
            intents.bind_document(&document, &origin)?;
            origin
        };
        Ok(Self {
            app,
            window,
            document,
            origin,
        })
    }
    fn validate(&self) -> Result<(), String> {
        let core = self.app.state::<Arc<AppCore>>();
        if core.quitting.load(std::sync::atomic::Ordering::Acquire)
            || trusted_main_document_origin(&self.window, &core)? != self.origin
            || !core
                .launch_intents
                .lock()
                .unwrap()
                .current_document(&self.document, &self.origin)
        {
            return Err("原截图页面已关闭或重新加载。".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn consent(caller: &Caller, setting: bool) -> Result<bool, String> {
    let origin = std::ffi::CString::new(caller.origin.as_str()).map_err(|_| DENIED)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    caller
        .app
        .run_on_main_thread(move || {
            extern "C" {
                fn keepwork_screenshot_consent(
                    origin: *const std::ffi::c_char,
                    setting: bool,
                ) -> i32;
            }
            let choice = unsafe { keepwork_screenshot_consent(origin.as_ptr(), setting) };
            let _ = send.send(choice);
        })
        .map_err(|e| e.to_string())?;
    match receive.await.map_err(|_| DENIED)? {
        1 if !setting => Ok(false),
        2 => Ok(true),
        _ => Err(DENIED.into()),
    }
}

#[cfg(not(target_os = "macos"))]
async fn consent(caller: &Caller, setting: bool) -> Result<bool, String> {
    let message = format!("来源：{}\n允许截取主屏幕并将画面交给当前会话的 AI 吗？截图可能包含其他应用中的内容。可在聊天的 MCP 设置中关闭始终允许截图。",caller.origin);
    let buttons = if setting {
        MessageDialogButtons::OkCancelCustom(ALWAYS.into(), "取消".into())
    } else {
        MessageDialogButtons::YesNoCancelCustom(ONCE.into(), ALWAYS.into(), "取消".into())
    };
    // No parent sheet: the main window may be hidden behind another application in pet mode.
    let (send, receive) = tokio::sync::oneshot::channel();
    caller
        .app
        .dialog()
        .message(message)
        .title("Keepwork · 主屏幕截图授权")
        .buttons(buttons)
        .show_with_result(move |choice| {
            let _ = send.send(choice);
        });
    match receive.await.map_err(|_| DENIED)? {
        MessageDialogResult::Custom(s) if s == ALWAYS => Ok(true),
        MessageDialogResult::Custom(s) if !setting && s == ONCE => Ok(false),
        _ => Err(DENIED.into()),
    }
}

fn check_revision(current: u64, expected: u64) -> Result<(), String> {
    if current != expected {
        return Err("截图授权已撤销，请重新发起请求。".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn desktop_get_screenshot_permission(
    window: WebviewWindow,
    document: String,
    token: String,
) -> Result<Value, String> {
    let caller = Caller::bind(window, document, &token)?;
    let access = caller.app.state::<ScreenshotAccess>();
    let core = caller.app.state::<Arc<AppCore>>();
    let enabled = grants(&grant_path(&core))?.contains(&caller.origin);
    Ok(json!({"alwaysAllowScreenshots":enabled,"pending":access.busy.try_lock().is_err()}))
}

#[tauri::command]
pub(super) async fn desktop_set_screenshot_permission(
    window: WebviewWindow,
    document: String,
    token: String,
    enabled: bool,
) -> Result<Value, String> {
    let caller = Caller::bind(window, document, &token)?;
    let access = caller.app.state::<ScreenshotAccess>();
    let path = grant_path(&caller.app.state::<Arc<AppCore>>());
    if enabled {
        let _active = access
            .busy
            .try_lock()
            .map_err(|_| "已有桌面截图请求正在处理。")?;
        let revision = *access.revision.lock().unwrap();
        consent(&caller, true).await?;
        caller.validate()?;
        let current = access.revision.lock().unwrap();
        check_revision(*current, revision)?;
        change_grant(&path, &caller.origin, true)?;
    } else {
        let mut current = access.revision.lock().unwrap();
        *current = current.wrapping_add(1);
        change_grant(&path, &caller.origin, false)?;
    }
    Ok(json!({"alwaysAllowScreenshots":enabled,"pending":access.busy.try_lock().is_err()}))
}

pub(super) struct Shot {
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
}
impl Shot {
    fn response(self) -> Result<Value, String> {
        if self.width == 0
            || self.height == 0
            || self.jpeg.len() > MAX_JPEG
            || !self.jpeg.starts_with(&[0xff, 0xd8])
            || !self.jpeg.ends_with(&[0xff, 0xd9])
        {
            return Err("主屏幕截图无效或超过 3 MiB。".into());
        }
        let info = json!({"action":"screenshot","inputSent":false,"width":self.width,"height":self.height,
            "capturedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "warning":"Unmasked primary desktop. Coordinates use this image pixel grid."});
        Ok(
            json!({"content":[{"type":"text","text":info.to_string()},{"type":"image","mimeType":"image/jpeg","data":base64::engine::general_purpose::STANDARD.encode(self.jpeg)}]}),
        )
    }
}

#[tauri::command]
pub(super) async fn desktop_capture_screenshot(
    window: WebviewWindow,
    document: String,
    token: String,
) -> Result<Value, String> {
    let caller = Caller::bind(window, document, &token)?;
    let access = caller.app.state::<ScreenshotAccess>();
    let _active = access
        .busy
        .try_lock()
        .map_err(|_| "已有桌面截图请求正在处理。")?;
    let path = grant_path(&caller.app.state::<Arc<AppCore>>());
    let revision = *access.revision.lock().unwrap();
    if !grants(&path)?.contains(&caller.origin) {
        let remember = consent(&caller, false).await?;
        caller.validate()?;
        {
            let current = access.revision.lock().unwrap();
            check_revision(*current, revision)?;
            if remember {
                change_grant(&path, &caller.origin, true)?;
            }
        }
        // Allow the window compositor to remove the dismissed consent dialog.
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    }
    caller.validate()?;
    check_revision(*access.revision.lock().unwrap(), revision)?;
    let result = tauri::async_runtime::spawn_blocking(|| capture()?.response())
        .await
        .map_err(|_| "无法截取主屏幕。")??;
    caller.validate()?;
    check_revision(*access.revision.lock().unwrap(), revision)?;
    Ok(result)
}

#[cfg(target_os = "macos")]
fn capture() -> Result<Shot, String> {
    extern "C" {
        fn keepwork_capture_primary(
            out: *mut u8,
            capacity: usize,
            length: *mut usize,
            width: *mut u32,
            height: *mut u32,
        ) -> i32;
    }
    let mut jpeg = vec![0; MAX_JPEG];
    let (mut length, mut width, mut height) = (0, 0, 0);
    match unsafe { keepwork_capture_primary(jpeg.as_mut_ptr(),jpeg.len(),&mut length,&mut width,&mut height) } {
        0 if length<=jpeg.len() => { jpeg.truncate(length); Ok(Shot{width,height,jpeg}) }
        1 => Err("请在 macOS 系统设置 → 隐私与安全性 → 屏幕与系统录音中允许 Keepwork 截图，然后重新打开应用。".into()),
        2 => Err("主屏幕截图超过 3 MiB 或尺寸过大。".into()),
        3 => Err("等待 macOS 截屏超时，请重试。".into()),
        _ => Err("macOS 未返回有效的主屏幕截图。请检查屏幕录制权限。".into()),
    }
}
#[cfg(windows)]
#[path = "screenshot_windows.rs"]
mod win;
#[cfg(windows)]
use win::capture;
#[cfg(not(any(windows, target_os = "macos")))]
fn capture() -> Result<Shot, String> {
    Err("当前平台不支持原生桌面截图。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remembered_grant_is_origin_scoped_and_revocable() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = root.join("grant.json");
        assert!(grants(&path).unwrap().is_empty());
        change_grant(&path, "http://127.0.0.1:3001", true).unwrap();
        assert!(!grants(&path).unwrap().contains("http://127.0.0.1:3002"));
        change_grant(&path, "http://127.0.0.1:3001", false).unwrap();
        assert!(grants(&path).unwrap().is_empty());
        assert!(check_revision(1, 0).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(all(target_os = "macos", feature = "dev-bins"))]
    #[test]
    fn authored_retina_pixels_return_in_the_native_mcp_image() {
        extern "C" {
            fn keepwork_synthetic_screenshot(
                out: *mut u8,
                capacity: usize,
                length: *mut usize,
            ) -> i32;
        }
        let mut jpeg = vec![0; MAX_JPEG];
        let mut length = 0;
        assert_eq!(
            unsafe { keepwork_synthetic_screenshot(jpeg.as_mut_ptr(), jpeg.len(), &mut length) },
            0
        );
        jpeg.truncate(length);
        let result = Shot {
            width: 16,
            height: 12,
            jpeg,
        }
        .response()
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result["content"][1]["data"].as_str().unwrap())
            .unwrap();
        let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .unwrap()
            .into_rgb8();
        assert_eq!(image.dimensions(), (16, 12));
        let [r, g, b] = image.get_pixel(8, 6).0;
        assert!(r > 245 && g < 8 && b < 8, "encoded pixel {r} {g} {b}");
    }
    #[test]
    fn image_contract_bounds_and_labels_pixels() {
        let shot = |jpeg| Shot {
            width: 800,
            height: 600,
            jpeg,
        };
        assert!(shot(vec![0; MAX_JPEG + 1]).response().is_err());
        assert!(shot(vec![]).response().is_err());
        let result = shot(vec![0xff, 0xd8, 0xff, 0xd9]).response().unwrap();
        let info: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(info["inputSent"], false);
        assert_eq!(info["width"], 800);
        assert_eq!(result["content"][1]["mimeType"], "image/jpeg");
    }
}
