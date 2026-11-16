use super::sender::{verify_main_sender, verify_pet_sender};
use super::state::AppCore;
use crate::remote_voice::dialogue::Surface;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

pub(super) fn surface(app: &AppHandle, allow_background: bool) -> Option<Surface> {
    let core = app.state::<Arc<AppCore>>();
    let main = app.get_webview_window("main")?;
    verify_main_sender(&main, &core).ok()?;
    let pet = app.get_webview_window("pet").filter(|pet| {
        super::pet_host::pet_is_active(pet).unwrap_or(false)
            && verify_pet_sender(pet, &core).is_ok()
    });
    let presentation = if pet.is_some() {
        let snapshot = core.pet.snapshot();
        if !allow_background
            && (!snapshot["permission"].is_null() || !snapshot["exitPrompt"].is_null())
        {
            return None;
        }
        "pet"
    } else if allow_background || main.is_focused().unwrap_or(false) {
        "main"
    } else {
        return None;
    };
    let page_url = main.url().ok()?;
    Some(Surface {
        // Presentation can change while talking. The main document owns the
        // call and receives every Record/Back/OK until its own ID is closed.
        label: "main",
        send: Box::new(move |action, id, reason| {
            let core = main.app_handle().state::<Arc<AppCore>>();
            verify_main_sender(&main, &core)?;
            if main.url().ok().as_ref() != Some(&page_url) {
                return Err("对话页面已改变。".into());
            }
            if action == "interrupt" {
                if let Some(pet) = &pet {
                    if verify_pet_sender(pet, &core).is_ok() {
                        let _ = pet.eval("window.dispatchEvent(new CustomEvent('aichat:remote-dialogue',{detail:{action:'interrupt',id:''}}))");
                    }
                }
            }
            let detail =
                json!({ "action": action, "id": id, "reason": reason, "surface": presentation });
            let (reply, result) = tokio::sync::oneshot::channel();
            let reply = std::sync::Mutex::new(Some(reply));
            let expected = json!(page_url.as_str());
            let event = if action == "interrupt" {
                "aichat:remote-dialogue"
            } else {
                "aichat:remote-phone"
            };
            let check_entry = action == "enter";
            let js = format!(
                r#"(() => {{
                if (window.location.href !== {expected}) return false;
                const detail = {detail};
                window.dispatchEvent(new CustomEvent('{event}', {{ detail }}));
                if ({check_entry} && !detail.status) return -1;
                return detail.status === 'active' && (detail.action !== 'enter' || detail.liveVersion === 1);
            }})()"#
            );
            let app = main.app_handle().clone();
            main.eval_with_callback(js, move |value| {
                if check_entry && value == "-1" {
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog()
                        .message("请更新 AIChat 页面后使用豆包实时语音 3.0 Pro 通话。")
                        .title("AIChat")
                        .show(|_| {});
                }
                if let Some(reply) = reply.lock().unwrap().take() {
                    let _ = reply.send(value == "true");
                }
            })
            .map_err(|e| e.to_string())?;
            Ok(result)
        }),
    })
}

#[tauri::command]
pub(super) fn remote_voice_dialogue_closed(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    id: String,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    let closed = state.remote_voice.dialogue.closed(window.label(), &id);
    if closed {
        super::remote_phone_view::sync(window.app_handle());
    }
    Ok(closed)
}
