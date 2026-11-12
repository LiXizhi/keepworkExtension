//! Native pet window, pointer tracking and pet command orchestration.

use super::events::broadcast_to_main;
use super::main_window::show_main_window;
use super::pet_audio_host::{
    notify_pet_audio_stopped, send_pet_audio_to_main, stop_pet_audio, watch_pet_audio,
};
use super::platform::open_in_system_browser;
use super::sender::{verify_main_sender, verify_pet_sender};
use super::state::AppCore;
use crate::pet::{PetController, WorkArea};
use crate::{pet, pet_audio, pet_canvas, pet_menu};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[cfg(target_os = "macos")]
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn sel_registerName(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn objc_msgSend();
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

pub(super) fn broadcast_pet_state(app: &AppHandle, core: &AppCore) {
    let snap = core.pet.snapshot();
    let _ = app.emit("aichat-desktop:pet-state", &snap);
}

fn primary_button_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let class = objc_getClass(c"NSEvent".as_ptr());
            let sel = sel_registerName(c"pressedMouseButtons".as_ptr());
            if class.is_null() || sel.is_null() {
                return true;
            }
            let send: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> usize =
                std::mem::transmute(objc_msgSend as *const ());
            (send(class, sel) & 1) != 0
        }
    }
    #[cfg(target_os = "windows")]
    {
        unsafe { (GetAsyncKeyState(0x01) as u16) & 0x8000 != 0 }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        true
    }
}

fn logical_work_area(monitor: &tauri::Monitor) -> Option<WorkArea> {
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    // Monitor geometry is already in one logical point space. Convert with each
    // display's own scale so mixed-DPI layouts stay in that shared space.
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let width = size.width.round();
    let height = size.height.round();
    if !pos.x.is_finite() || !pos.y.is_finite() || width < 32.0 || height < 32.0 {
        return None;
    }
    Some(WorkArea {
        x: pos.x.round() as i32,
        y: pos.y.round() as i32,
        width: width as i32,
        height: height as i32,
    })
}

fn logical_monitors(app: &AppHandle) -> Vec<WorkArea> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .filter_map(logical_work_area)
        .collect()
}

fn logical_cursor(app: &AppHandle) -> Option<(i32, i32)> {
    // Tao scales the flipped cursor by the primary display, then we divide by
    // that same scale to get the shared point space used by monitor positions.
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    let cursor = app.cursor_position().ok()?;
    let logical = cursor.to_logical::<f64>(scale);
    if !logical.x.is_finite() || !logical.y.is_finite() {
        return None;
    }
    Some((logical.x.round() as i32, logical.y.round() as i32))
}

fn initial_pet_work_area(app: &AppHandle, pet: &crate::pet::PetController) -> WorkArea {
    let monitors = logical_monitors(app);
    let prefs = pet.preferences();
    if let (Some(x), Some(y)) = (prefs.monitor_x, prefs.monitor_y) {
        if let Some(monitor) = monitors
            .into_iter()
            .find(|area| (area.x - x).abs() <= 4 && (area.y - y).abs() <= 4)
        {
            return monitor;
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .and_then(logical_work_area)
        .unwrap_or_default()
}

fn drag_snapshot(pet: &crate::pet::PetController) -> Value {
    let mut snap = pet.snapshot();
    if let Some(obj) = snap.as_object_mut() {
        obj.insert("dragging".to_string(), json!(pet.is_dragging()));
        obj.insert("dragMoved".to_string(), json!(pet.drag_moved()));
        obj.insert("dragId".to_string(), json!(pet.drag_id()));
        obj.insert(
            "nativeDragTracking".to_string(),
            json!(
                cfg!(any(target_os = "macos", target_os = "windows")) && pet.native_drag_tracking()
            ),
        );
    }
    snap
}

fn reconcile_pet_canvas(window: &WebviewWindow, pet: &PetController) {
    if let Some(area) = pet.pending_canvas() {
        if pet_canvas::sync_pet_canvas(window, area).is_ok() {
            pet.note_canvas(area);
        }
    }
}

fn move_with_global_cursor(app: &AppHandle, pet: &crate::pet::PetController) -> bool {
    let Some((x, y)) = logical_cursor(app) else {
        return false;
    };
    let before = pet.placement();
    let mut monitors = logical_monitors(app);
    if monitors.is_empty() {
        monitors.push(pet.work_area());
    }
    if pet.drag_global(x, y, &monitors).is_some() {
        if let Some(window) = app.get_webview_window("pet") {
            reconcile_pet_canvas(&window, pet);
        }
    }
    before != pet.placement()
}

fn apply_pet_drag(
    app: &AppHandle,
    pet: &crate::pet::PetController,
    args: &Value,
    force_end: bool,
) -> Value {
    // A cross-monitor move can synthesize pointerup without a physical release.
    if force_end && pet.is_global_dragging() && primary_button_down() {
        return drag_snapshot(pet);
    }
    // The controller preserves the click threshold, so even a fast release can
    // commit its final sample without moving a simple click.
    let ending = force_end || !primary_button_down();
    if pet.is_global_dragging() {
        move_with_global_cursor(app, pet);
    } else if !ending {
        let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        pet.update_drag(x, y);
    }
    if ending {
        pet.end_drag();
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.set_shadow(false);
        }
    }
    drag_snapshot(pet)
}

fn sync_pet_pointer(window: &WebviewWindow, pet: &PetController, app: &AppHandle) {
    if app
        .try_state::<Arc<AppCore>>()
        .is_some_and(|core| core.pet_menu.is_showing())
    {
        if window.set_ignore_cursor_events(false).is_ok() {
            pet.record_pointer_interactive(true);
        }
        return;
    }
    let buttons_available = cfg!(any(target_os = "macos", target_os = "windows"));
    let primary_down = buttons_available && primary_button_down();
    if primary_down && pet.is_global_dragging() && move_with_global_cursor(app, pet) {
        // The renderer may stop animating during a monitor/DPI transition.
        // Native sampling owns the drag, including all frames after that move.
        let _ = app.emit("aichat-desktop:pet-state", &drag_snapshot(pet));
    }
    if buttons_available && !primary_down && pet.is_dragging() {
        // A background renderer may miss the release. Finish the native drag
        // before a later press in another app can inherit its input hold.
        let snap = apply_pet_drag(app, pet, &json!({}), true);
        let _ = app.emit("aichat-desktop:pet-state", &snap);
    }
    // A failed final move remains pending after the button is released.
    // Retry it without requiring another drag or renderer animation frame.
    reconcile_pet_canvas(window, pet);
    #[cfg(target_os = "macos")]
    let cursor = logical_cursor(app);
    #[cfg(not(target_os = "macos"))]
    let cursor = (|| {
        // Windows screen positions are physical pixels. Subtract this window's
        // physical origin before applying its own DPI, not the primary DPI.
        let point = app.cursor_position().ok()?;
        let origin = window.inner_position().ok()?;
        crate::pet::physical_pet_cursor(
            (point.x, point.y),
            (origin.x as f64, origin.y as f64),
            window.scale_factor().ok()?,
            pet.work_area(),
        )
    })();
    let interactive = pet.pointer_interactive(cursor, primary_down);
    if pet.pointer_needs_update(interactive)
        && window.set_ignore_cursor_events(!interactive).is_ok()
    {
        pet.record_pointer_interactive(interactive);
    }
}

/// Unlike Electron's forwarded mousemove, a click-through WKWebView cannot
/// restore its own mouse input. Keep hit testing outside the inactive renderer.
fn start_pet_pointer_tracker(app: &AppHandle, window: &WebviewWindow, pet: &Arc<PetController>) {
    let stopped = Arc::new(AtomicBool::new(false));
    let destroyed = Arc::clone(&stopped);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            destroyed.store(true, Ordering::Relaxed);
        }
    });
    let app = app.clone();
    let window = window.clone();
    let pet = Arc::clone(pet);
    tauri::async_runtime::spawn(async move {
        while !stopped.load(Ordering::Relaxed) {
            let (done, completed) = tokio::sync::oneshot::channel();
            let handle = app.clone();
            let target = window.clone();
            let controller = Arc::clone(&pet);
            if app
                .run_on_main_thread(move || {
                    let visible = target.is_visible().ok();
                    if visible == Some(true) {
                        sync_pet_pointer(&target, &controller, &handle);
                    } else {
                        controller.suspend_pointer_tracking();
                    }
                    let _ = done.send(visible);
                })
                .is_err()
            {
                break;
            }
            // Wait for each main-thread pass, so a busy event loop cannot build
            // an unbounded backlog. Hidden windows do not read the cursor.
            match completed.await {
                Ok(Some(visible)) => {
                    tokio::time::sleep(Duration::from_millis(if visible { 16 } else { 200 })).await
                }
                _ => break,
            }
        }
    });
}

pub fn ensure_pet_window(app: &AppHandle, core: &Arc<AppCore>, show_now: bool) {
    if let Some(existing) = app.get_webview_window("pet") {
        if show_now {
            let _ = existing.show();
            sync_pet_pointer(&existing, &core.pet, app);
        }
        broadcast_pet_state(app, core);
        return;
    }

    let area = initial_pet_work_area(app, &core.pet);
    core.pet.set_work_area(area);

    if let Ok(builder) = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("桌面宠物")
        .position(area.x as f64, area.y as f64)
        .inner_size(area.width as f64, area.height as f64)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .resizable(false)
        .visible(show_now)
        .build()
    {
        if pet_canvas::sync_pet_canvas(&builder, area).is_ok() {
            core.pet.note_canvas(area);
        }
        let _ = builder.set_shadow(false);
        let _ = builder.set_ignore_cursor_events(true);
        core.pet.clear_hit_regions();
        core.pet.suspend_pointer_tracking();
        let controller = Arc::clone(&core.pet);
        let audio = Arc::clone(&core.pet_audio);
        let audio_app = app.clone();
        builder.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(false) | WindowEvent::Destroyed) {
                controller.set_pointer_hold(false);
            }
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(identity) = audio.stop(None) {
                    notify_pet_audio_stopped(&audio_app, identity, "宠物窗口已关闭", false);
                }
            }
        });
        let menu_core = Arc::clone(core);
        builder.on_menu_event(move |window, event| {
            if let Some(action) = pet_menu::action(event.id().as_ref()) {
                if let Err(error) = execute_pet_menu_action(window.app_handle(), &menu_core, action)
                {
                    eprintln!("pet menu failed: {error}");
                }
            }
        });
        start_pet_pointer_tracker(app, &builder, &core.pet);
        broadcast_pet_state(app, core);
    }
}

#[tauri::command]
pub(super) fn desktop_publish_pet_state(
    app: AppHandle,
    window: WebviewWindow,
    state_mgr: tauri::State<'_, Arc<AppCore>>,
    state: Option<Value>,
    document: Option<String>,
) -> Result<bool, String> {
    verify_main_sender(&window, &state_mgr)?;
    let incoming = state.unwrap_or_else(|| json!({}));
    let supports_audio = (incoming["petDictationAudioVersion"].as_u64() == Some(pet_audio::VERSION)
        || (incoming["target"].as_str() == Some("persona")
            && incoming["petVoiceAudioVersion"].as_u64() == Some(pet_audio::VERSION)))
        && incoming["ready"].as_bool() == Some(true);
    state_mgr.pet.update_raw_state(incoming);
    let context = state_mgr.pet.snapshot()["context"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if let Some(identity) =
        state_mgr
            .pet_audio
            .set_page(&context, supports_audio, document.as_deref())
    {
        notify_pet_audio_stopped(&app, identity, "录音上下文已改变", false);
    }
    broadcast_pet_state(&app, &state_mgr);
    Ok(true)
}

#[tauri::command]
pub(super) fn desktop_pet_result(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    result: Value,
) -> Result<bool, String> {
    verify_main_sender(&window, &state)?;
    if result["ok"].as_bool() == Some(false) {
        if let Some(id) = result["requestId"]
            .as_str()
            .and_then(|request| state.pet_audio.capture_for_request(request))
        {
            stop_pet_audio(&app, &state, Some(&id), "语音输入未能启动", false);
        }
    }
    state.pet.resolve_command(&result);
    if result.get("type").and_then(|v| v.as_str()) == Some("exit-info") {
        state.pet.resolve_exit_info(&result);
        broadcast_pet_state(&app, &state);
    }
    Ok(true)
}

async fn request_pet_command(
    app: &AppHandle,
    core: &AppCore,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let (mut command, receiver) = core.pet.begin_command(name, args)?;
    let request_id = command["requestId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let snapshot = core.pet.snapshot();
    let context = snapshot["context"].as_str().unwrap_or("");
    if name == "dictation" && snapshot["dictating"].as_bool() == Some(true) {
        if let Some(identity) = core.pet_audio.stop_in_context(context) {
            // The stopped notification already ends recognition. Forwarding the
            // original toggle afterwards could start another recording.
            notify_pet_audio_stopped(app, identity, "语音输入已停止", false);
            let stopped = json!({ "stopped": true });
            core.pet
                .resolve_command(&json!({"requestId":request_id,"ok":true,"data":stopped}));
            return Ok(stopped);
        }
    }
    let pet_capture = pet::uses_pet_audio(&snapshot, name)
        && core.pet_audio.supported(context);
    let capture_id = if pet_capture {
        let (id, replaced) = match core.pet_audio.issue(context, &request_id) {
            Ok(capture) => capture,
            Err(error) => {
                core.pet
                    .resolve_command(&json!({"requestId":request_id,"ok":false,"error":error}));
                return Err(error);
            }
        };
        if let Some(identity) = replaced {
            notify_pet_audio_stopped(app, identity, "新的语音输入已开始", false);
        }
        command["petAudio"] = json!({ "version": pet_audio::VERSION, "id": id });
        watch_pet_audio(app.clone(), Arc::clone(&core.pet_audio), id.clone());
        Some(id)
    } else {
        None
    };
    #[cfg(target_os = "macos")]
    if !pet_capture && pet::starts_media_capture(&snapshot, name) {
        // WebKit defers getUserMedia while its owner document is hidden. The
        // pet's click does not make the retained main WebView visible. Keep the
        // pet open so its draft and Stop control remain available.
        let prepared = (|| -> Result<(), String> {
            let main = app
                .get_webview_window("main")
                .ok_or_else(|| "无法打开录音页面，请重新打开 AIChat 主窗口后重试。".to_string())?;
            main.unminimize()
                .and_then(|_| main.show())
                .and_then(|_| main.set_focus())
                .map_err(|_| "无法显示录音页面，请打开 AIChat 主窗口后重试。".to_string())
        })();
        if let Err(error) = prepared {
            core.pet
                .resolve_command(&json!({ "requestId": request_id, "ok": false, "error": error }));
            return Err(error);
        }
    }
    if let Some(id) = capture_id.as_deref() {
        let delivered = core
            .pet_audio
            .document(id)
            .ok_or_else(|| "录音页面身份不可用".to_string())
            .and_then(|document| send_pet_audio_to_main(app, &document, "pet-command", &command));
        if let Err(error) = delivered {
            stop_pet_audio(app, core, Some(id), "语音输入页面不可用", true);
            core.pet
                .resolve_command(&json!({"requestId":request_id,"ok":false,"error":error}));
            return Err(error);
        }
    } else {
        broadcast_to_main(app, "pet-command", &command);
    }
    let result = core
        .pet
        .wait_for_command(&request_id, receiver, Duration::from_secs(15))
        .await;
    if result.is_err() {
        if let Some(id) = capture_id.as_deref() {
            stop_pet_audio(app, core, Some(id), "语音输入未能启动", false);
        }
    }
    result
}

pub(super) fn hide_pet_window(app: &AppHandle, core: &AppCore) {
    core.update_settings(|settings| settings.pet_visible = false);
    stop_pet_audio(app, core, None, "宠物已隐藏", false);
    core.pet.cancel_exit_prompt();
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.hide();
    }
    // The same hide lifecycle is shared by tray and pet-menu actions.
    broadcast_to_main(
        app,
        "pet-command",
        &json!({
            "version": 1, "requestId": uuid::Uuid::new_v4().to_string(),
            "context": core.pet.snapshot()["context"], "action": "hide"
        }),
    );
    broadcast_pet_state(app, core);
}

fn request_pet_exit(app: &AppHandle, core: &Arc<AppCore>) -> Value {
    let shared = core.mcp_supervisor.snapshot().owner != "desktop";
    let (id, snapshot) = core.pet.begin_exit_prompt(shared);
    broadcast_pet_state(app, core);
    let core = Arc::clone(core);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let context = core.pet.snapshot()["context"].clone();
        let result =
            request_pet_command(&app, &core, "exit-info", &json!({ "context": context })).await;
        if core.pet.snapshot()["exitPrompt"]["id"].as_str() != Some(id.as_str()) {
            return;
        }
        match result {
            Ok(info) => {
                core.pet.resolve_exit_info(&info);
            }
            Err(_) => {
                core.pet.mark_exit_info_unavailable();
            }
        }
        broadcast_pet_state(&app, &core);
    });
    snapshot
}

fn execute_pet_menu_action(
    app: &AppHandle,
    core: &Arc<AppCore>,
    action: pet_menu::Action,
) -> Result<(), String> {
    match action {
        pet_menu::Action::Scale(scale) => {
            core.pet.set_scale(scale);
            broadcast_pet_state(app, core);
        }
        pet_menu::Action::Appearance(appearance) => {
            core.pet.set_appearance(appearance);
            broadcast_pet_state(app, core);
        }
        pet_menu::Action::ChooseAppearance => open_in_system_browser(pet_menu::APPEARANCE_URL)?,
        pet_menu::Action::Open => show_main_window(app, core),
        pet_menu::Action::Hide => hide_pet_window(app, core),
        pet_menu::Action::RequestExit => {
            request_pet_exit(app, core);
        }
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn desktop_pet_action(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    verify_pet_sender(&window, &state)?;
    match name.as_str() {
        "state" => Ok(state.pet.snapshot()),
        "menu" => {
            let menu = pet_menu::build(&app, &state.pet.preferences(), &state.pet.snapshot())
                .map_err(|error| error.to_string())?;
            let result = state.pet_menu.popup(&window, menu);
            let target = window.clone();
            let handle = app.clone();
            let controller = Arc::clone(&state.pet);
            // The popup may have run a nested native event loop. Restore from
            // the real cursor rather than making the entire canvas clickable.
            let _ = app.run_on_main_thread(move || sync_pet_pointer(&target, &controller, &handle));
            result?;
            Ok(state.pet.snapshot())
        }
        "expand" => {
            let expanded = args
                .get("expanded")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let snap = state.pet.set_expanded(expanded);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "open" => {
            show_main_window(&app, &state);
            Ok(state.pet.snapshot())
        }
        "hit-test" => {
            // Legacy bundled renderers may still send this hint. Native cursor
            // geometry remains authoritative; never enable the entire canvas.
            Ok(json!({ "ok": true }))
        }
        "hit-regions" => {
            if let Some(epoch) = args["epoch"].as_u64() {
                state.pet.update_hit_regions(&args["regions"], epoch);
            }
            Ok(json!({ "ok": true }))
        }
        "pointer-hold" => {
            state.pet.set_pointer_hold(
                args["active"].as_bool() == Some(true)
                    && cfg!(any(target_os = "macos", target_os = "windows"))
                    && primary_button_down(),
            );
            Ok(json!({ "ok": true }))
        }
        "drag-start" => {
            if let Some((x, y)) = logical_cursor(&app) {
                state
                    .pet
                    .begin_global_drag_with_id(x, y, args["dragId"].as_u64());
            } else {
                let x = args.get("screenX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let y = args.get("screenY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                state.pet.start_drag(x, y);
                state.pet.set_drag_id(args["dragId"].as_u64());
            }
            Ok(drag_snapshot(&state.pet))
        }
        "drag" => {
            if !state.pet.owns_drag(args["dragId"].as_u64()) {
                return Ok(drag_snapshot(&state.pet));
            }
            let was_dragging = state.pet.is_dragging();
            let snap = apply_pet_drag(&app, &state.pet, &args, false);
            if was_dragging && !state.pet.is_dragging() {
                broadcast_pet_state(&app, &state);
            }
            Ok(snap)
        }
        "drag-end" => {
            if !state.pet.owns_drag(args["dragId"].as_u64()) {
                return Ok(drag_snapshot(&state.pet));
            }
            let snap = apply_pet_drag(&app, &state.pet, &args, true);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "exit-request" => Ok(request_pet_exit(&app, state.inner())),
        "exit-cancel" => {
            let snap = state.pet.cancel_exit_prompt();
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "exit-confirm" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            state.pet.verify_exit_confirm(id)?;
            stop_pet_audio(&app, &state, None, "应用正在退出", false);
            state.quitting.store(true, Ordering::Relaxed);
            state.terminals.close_all();
            state.mcp_supervisor.stop();
            state.local_model_supervisor.stop();
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        "permission-choice" => {
            stop_pet_audio(&app, &state, None, "宠物窗口已隐藏", false);
            let _ = window.hide();
            let snap = state.pet.set_permission_prompt(None);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "input" | "send" | "stop" | "dictation" | "call" | "mute" | "voice-start"
        | "voice-stop" | "record-start" | "record-stop" | "toggle-target" => {
            if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
                if text.chars().count() > crate::pet::MAX_PET_INPUT_CHARS {
                    return Err("输入内容过长，请在桌面主窗口中编辑".to_string());
                }
            }
            request_pet_command(&app, &state, &name, &args).await?;
            Ok(state.pet.snapshot())
        }
        _ => Ok(state.pet.snapshot()),
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod pet_drag_host_tests {
    #[test]
    fn primary_button_is_up_without_a_held_click() {
        assert!(
            !super::primary_button_down(),
            "idle primary button must read as up, or every drag frame will end immediately"
        );
    }
}
