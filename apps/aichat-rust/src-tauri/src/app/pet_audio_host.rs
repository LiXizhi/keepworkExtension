//! Document-scoped pet audio delivery, capture lifecycle and audio IPC.

use super::sender::{verify_main_sender, verify_pet_sender};
use super::state::AppCore;
use crate::pet_audio;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Capture IDs and PCM are delivered only to the document that owns the lease.
/// The ordinary app-wide event stream must never carry microphone data.
pub(super) fn send_pet_audio_to_main(
    app: &AppHandle,
    document: &str,
    event: &str,
    payload: &Value,
) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("录音接收页面已关闭")?;
    let detail = json!({ "event": event, "payload": payload });
    let document = json!(document);
    main.eval(&format!("if (window.__AICHAT_PET_AUDIO_DOCUMENT__ === {document}) window.dispatchEvent(new CustomEvent('__aichat_desktop_event__', {{detail:{detail}}}));"))
        .map_err(|error| error.to_string())
}

fn pet_audio_command(app: &AppHandle, op: &str, id: &str) -> Result<(), String> {
    app.emit_to(
        "pet",
        "aichat-desktop:pet-audio-command",
        &json!({ "op": op, "id": id }),
    )
    .map_err(|error| error.to_string())
}

pub(super) fn notify_pet_audio_stopped(
    app: &AppHandle,
    identity: pet_audio::CaptureIdentity,
    reason: &str,
    error: bool,
) {
    let _ = pet_audio_command(app, "stop", &identity.id);
    if let Some(document) = identity.document {
        let payload = if error {
            json!({"id": identity.id, "type":"error", "message":reason})
        } else {
            json!({"id": identity.id, "type":"stopped", "reason":reason})
        };
        let _ = send_pet_audio_to_main(app, &document, "pet-audio", &payload);
    }
}

pub(super) fn stop_pet_audio(
    app: &AppHandle,
    core: &AppCore,
    id: Option<&str>,
    reason: &str,
    error: bool,
) {
    let cancelled = if error {
        core.pet_audio.stop_with_error(id, reason)
    } else {
        core.pet_audio.stop(id)
    };
    if let Some(identity) = cancelled {
        notify_pet_audio_stopped(app, identity, reason, error);
    }
}

pub(super) fn watch_pet_audio(app: AppHandle, relay: Arc<pet_audio::PetAudioRelay>, id: String) {
    tauri::async_runtime::spawn(async move {
        while relay.is_current(&id) {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let pet_visible = app
                .get_webview_window("pet")
                .and_then(|pet| pet.is_visible().ok())
                == Some(true);
            if !pet_visible || app.get_webview_window("main").is_none() {
                if let Some(identity) = relay.stop(Some(&id)) {
                    notify_pet_audio_stopped(&app, identity, "录音窗口已关闭或隐藏", false);
                }
                break;
            }
            if let Some(reason) = relay.expired_reason(&id) {
                if let Some(identity) = relay.stop_with_error(Some(&id), reason) {
                    notify_pet_audio_stopped(&app, identity, reason, true);
                }
                break;
            }
        }
    });
}

#[tauri::command]
pub(super) async fn desktop_pet_audio(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    op: String,
    id: String,
    seq: Option<u64>,
    document: String,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    let context = state.pet.snapshot()["context"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if op == "stop" {
        // A delayed stop for an old opaque ID cannot stop its replacement.
        if state.pet_audio.verify_document(&id, &document) {
            stop_pet_audio(&app, &state, Some(&id), "语音输入已停止", false);
        }
        return Ok(json!({ "stopped": true }));
    }
    if op != "start" && !state.pet_audio.verify_document(&id, &document) {
        return Err("录音页面已改变，请重新点击语音输入".to_string());
    }
    match op.as_str() {
        "start" => {
            let visible = app
                .get_webview_window("pet")
                .and_then(|pet| pet.is_visible().ok())
                == Some(true);
            if !visible {
                stop_pet_audio(
                    &app,
                    &state,
                    Some(&id),
                    "请显示宠物后重新点击语音输入",
                    true,
                );
                return Err("请显示宠物后重新点击语音输入".to_string());
            }
            let ready = state.pet_audio.start(&id, &context, &document)?;
            if let Err(error) = pet_audio_command(&app, "start", &id) {
                stop_pet_audio(&app, &state, Some(&id), "宠物录音窗口不可用，请重试", true);
                return Err(error);
            }
            let outcome = tokio::time::timeout(pet_audio::START_TIMEOUT, ready).await;
            match outcome {
                Ok(Ok(Ok(()))) => Ok(pet_audio::descriptor()),
                Ok(Ok(Err(error))) if error == "语音输入已停止" => {
                    Ok(json!({ "cancelled": true }))
                }
                Ok(Ok(Err(error))) => Err(error),
                _ => {
                    let error = "麦克风准备超时，请重新点击语音输入并完成系统授权";
                    stop_pet_audio(&app, &state, Some(&id), error, true);
                    Err(error.to_string())
                }
            }
        }
        "activate" => {
            let active = state.pet_audio.activate(&id, &context)?;
            if pet_audio_command(&app, "activate", &id).is_err() {
                stop_pet_audio(&app, &state, Some(&id), "宠物录音窗口不可用，请重试", true);
                return Err("宠物录音窗口不可用，请重试".to_string());
            }
            match tokio::time::timeout(Duration::from_secs(5), active).await {
                Ok(Ok(Ok(()))) => Ok(json!({ "active": true })),
                Ok(Ok(Err(error))) if error == "语音输入已停止" => {
                    Ok(json!({ "cancelled": true }))
                }
                Ok(Ok(Err(error))) => Err(error),
                _ => {
                    stop_pet_audio(&app, &state, Some(&id), "音频采集激活超时，请重试", true);
                    Err("音频采集激活超时，请重试".to_string())
                }
            }
        }
        "ack" => {
            state
                .pet_audio
                .acknowledge(&id, &context, seq.ok_or("缺少音频确认序号")?)?;
            Ok(json!({ "acknowledged": true }))
        }
        _ => Err("不支持的宠物录音操作".to_string()),
    }
}

#[tauri::command]
pub(super) fn desktop_pet_audio_event(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    id: String,
    event: Value,
) -> Result<bool, String> {
    verify_pet_sender(&window, &state)?;
    if event["type"].as_str() == Some("claim") && window.is_visible().ok() != Some(true) {
        return Err("宠物不可见，无法开始录音".to_string());
    }
    let context = state.pet.snapshot()["context"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let outcome = state.pet_audio.event(&id, &context, &event);
    match outcome {
        Ok(
            pet_audio::PetAudioEvent::Claim
            | pet_audio::PetAudioEvent::Ready
            | pet_audio::PetAudioEvent::Active,
        ) => Ok(true),
        Ok(pet_audio::PetAudioEvent::Audio(payload)) => {
            let document = state.pet_audio.document(&id).ok_or("录音页面已结束")?;
            if let Err(error) = send_pet_audio_to_main(&app, &document, "pet-audio", &payload) {
                stop_pet_audio(&app, &state, Some(&id), "录音接收页面不可用", true);
                return Err(error);
            }
            Ok(true)
        }
        Ok(pet_audio::PetAudioEvent::Error(error)) => {
            stop_pet_audio(&app, &state, Some(&id), &error, true);
            Ok(true)
        }
        Ok(pet_audio::PetAudioEvent::Ended(reason)) => {
            stop_pet_audio(&app, &state, Some(&id), &reason, false);
            Ok(true)
        }
        Err(error) => {
            // Forged/repeated control notifications cannot cancel a valid
            // capture. Invalid PCM from its owner fails closed instead.
            if event["type"].as_str() == Some("audio") {
                stop_pet_audio(&app, &state, Some(&id), &error, true);
            }
            Err(error)
        }
    }
}
