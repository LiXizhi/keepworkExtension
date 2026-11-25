//! Keep the origin-owning WebView visible to WebKit for a pet call or one camera frame.
#[cfg(target_os = "macos")]
use super::state::AppCore;
#[cfg(target_os = "macos")]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "macos")]
fn present_on_window_thread(app: &AppHandle) -> Result<bool, String> {
    use super::sender::{verify_main_sender, verify_pet_sender};
    use std::ffi::c_void;
    extern "C" {
        fn keepwork_attach_phone_view(
            main: *mut c_void,
            pet: *mut c_void,
            view: *mut c_void,
        ) -> i32;
        fn keepwork_restore_phone_view(main: *mut c_void);
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Missing main window")?;
    let main_ptr = main.ns_window().map_err(|e| e.to_string())? as usize;
    let core = app.state::<Arc<AppCore>>();
    let phone = core
        .pet
        .active_phone_id()
        .as_deref()
        .is_some_and(|id| core.remote_voice.dialogue.owns("main", id));
    let camera = core.pet_camera_view.lock().unwrap().is_some();
    let pet = app.get_webview_window("pet").filter(|pet| {
        (phone || camera)
            && verify_main_sender(&main, &core).is_ok()
            && verify_pet_sender(pet, &core).is_ok()
            && super::pet_host::pet_is_active(pet).unwrap_or(false)
            && core.page_connection.lock().unwrap().presentation()
                == crate::page_connection::Presentation::Hidden
    });
    let Some(pet_ptr) = pet
        .and_then(|pet| pet.ns_window().ok())
        .map(|ptr| ptr as usize)
    else {
        unsafe { keepwork_restore_phone_view(main_ptr as _) };
        return Ok(false);
    };
    // with_webview runs inline on the window thread. Resolve both window handles first.
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    main.with_webview(move |view| {
        let attached =
            unsafe { keepwork_attach_phone_view(main_ptr as _, pet_ptr as _, view.inner()) } != 0;
        let _ = tx.send(attached);
    })
    .map_err(|e| e.to_string())?;
    let attached = rx.try_recv().map_err(|e| e.to_string())?;
    if !attached && phone && !camera {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .message("请打开 AIChat 主窗口以使用通话麦克风。")
            .title("AIChat")
            .show(|_| {});
    }
    Ok(attached)
}

#[cfg(target_os = "macos")]
pub(super) fn sync(app: &AppHandle) {
    let handle = app.clone();
    let _ = super::main_window::run_on_window_thread(app, move || {
        let _ = present_on_window_thread(&handle);
    });
}

#[cfg(not(target_os = "macos"))]
pub(super) fn sync(_app: &AppHandle) {}

/// This grants window presentation only. WebKit still requests camera consent for the main origin.
#[tauri::command]
pub(super) async fn desktop_present_pet_camera(
    app: AppHandle,
    window: WebviewWindow,
    document: String,
    token: String,
    active: bool,
) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, document, token, active);
        Ok(false)
    }
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let ticket = uuid::Uuid::new_v4();
        let (done, result) = tokio::sync::oneshot::channel();
        super::main_window::run_on_window_thread(&app, move || {
            let core = handle.state::<Arc<AppCore>>();
            let outcome = super::pet_approval::authenticate(&window, &core, &document, &token)
                .and_then(|()| {
                    let mut current = core.pet_camera_view.lock().unwrap();
                    if active {
                        if current.is_some() {
                            return Err("正在拍摄，请稍后重试".into());
                        }
                        *current = Some((document, ticket));
                    } else if current
                        .as_ref()
                        .is_some_and(|(owner, _)| *owner == document)
                    {
                        current.take();
                    } else {
                        return Ok(false);
                    }
                    drop(current);
                    let attached = present_on_window_thread(&handle);
                    if active && !matches!(attached, Ok(true)) {
                        core.pet_camera_view.lock().unwrap().take();
                    }
                    attached.map(|visible| !active || visible)
                });
            let _ = done.send(outcome);
        })
        .map_err(|e| e.to_string())?;
        let presented = result.await.map_err(|e| e.to_string())??;
        if active && presented {
            // Restore the view if the requesting page stalls during a permission prompt.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let core = app.state::<Arc<AppCore>>();
                let mut current = core.pet_camera_view.lock().unwrap();
                if current.as_ref().is_some_and(|(_, id)| *id == ticket) {
                    current.take();
                    drop(current);
                    sync(&app);
                }
            });
        }
        Ok(presented)
    }
}
