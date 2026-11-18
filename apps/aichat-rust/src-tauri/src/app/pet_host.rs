//! Native pet window, pointer tracking and pet command orchestration.

use super::events::broadcast_to_main;
use super::main_window::show_main_window;
use super::pet_audio_host::{
    notify_pet_audio_stopped, send_pet_audio_to_main, stop_pet_audio, watch_pet_audio,
};
use super::sender::{verify_main_sender, verify_pet_sender};
use super::state::AppCore;
use crate::pet::{PetController, WorkArea};
use crate::{pet, pet_audio, pet_canvas, pet_menu, pet_pointer};
use crate::remote_voice::{RecordingFeedback, RecordingPhase, RecordingTarget};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

#[cfg(any(target_os = "macos", test))]
fn primary_button_from_macos_mask(buttons: usize) -> bool {
    buttons & 1 != 0
}

#[cfg(any(target_os = "windows", test))]
fn primary_button_from_windows_state(state: i16) -> bool {
    (state as u16) & 0x8000 != 0
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
            primary_button_from_macos_mask(send(class, sel))
        }
    }
    #[cfg(target_os = "windows")]
    {
        unsafe { primary_button_from_windows_state(GetAsyncKeyState(0x01)) }
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

fn reconcile_pet_canvas(window: &WebviewWindow, pet: &Arc<PetController>) {
    let target = window.clone();
    let pet = Arc::clone(pet);
    // The frame, acknowledgement and renderer origin must commit in the same
    // UI transaction. Worker-thread wake order must never rewind the origin.
    let _ = window.run_on_main_thread(move || {
        if let Some(area) = pet.pending_canvas() {
            if pet_canvas::sync_pet_canvas(&target, area).is_ok() {
                pet.note_canvas(area);
                let _ = target.app_handle().emit("aichat-desktop:pet-state", &drag_snapshot(&pet));
            }
        }
    });
}

fn move_with_global_cursor(app: &AppHandle, pet: &Arc<PetController>) -> bool {
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
    pet: &Arc<PetController>,
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

fn sync_pet_pointer(window: &WebviewWindow, pet: &Arc<PetController>, app: &AppHandle) {
    if app
        .try_state::<Arc<AppCore>>()
        .is_some_and(|core| core.pet_menu.is_showing())
    {
        if pet_pointer::set_interactive(window, true).is_ok() {
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
            pet.current_canvas(),
        )
    })();
    let interactive = pet.pointer_interactive(cursor, primary_down);
    // AppKit mode can be changed outside this loop (notably native menus).
    // Its asynchronous Tauri setter cannot be acknowledged by an enqueue cache.
    if (cfg!(target_os = "macos") || pet.pointer_needs_update(interactive))
        && pet_pointer::set_interactive(window, interactive).is_ok()
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

pub(super) fn pet_is_active(pet: &WebviewWindow) -> tauri::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn keepwork_pet_is_presented(window: *mut std::ffi::c_void) -> bool; }
        Ok(unsafe { keepwork_pet_is_presented(pet.ns_window()?) })
    }
    #[cfg(not(target_os = "macos"))]
    { Ok(pet.is_visible()? && !pet.is_minimized()?) }
}

fn pet_back_context_matches(snapshot: &Value, context: &Value) -> bool {
    context.is_string()
        && snapshot["context"] == *context
        && snapshot["permission"].is_null()
        && snapshot["exitPrompt"].is_null()
}

/// Route a physical Back to the actual pet editor (which may have an unsynced
/// local draft). Once routed, never repeat it as a system-wide delete.
pub(super) fn route_remote_back(app: &AppHandle) -> Result<bool, String> {
    route_pet_button(app, "aichat:remote-back")
}

fn route_pet_button(app: &AppHandle, event: &'static str) -> Result<bool, String> {
    let core = app.state::<Arc<AppCore>>();
    let Some(pet) = app.get_webview_window("pet") else { return Ok(false) };
    if !pet_is_active(&pet).map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let Some(url) = super::sender::loaded_page_url(&pet)? else { return Ok(true); };
    crate::security::assert_sender(pet.label(), "pet", true, url.as_str(), core.current_dev_url().as_deref())?;
    let snapshot = core.pet.snapshot();
    if snapshot["permission"].is_null() && snapshot["exitPrompt"].is_null() {
        #[cfg(target_os = "macos")]
        if event == "aichat:remote-ok"
            && !matches!(snapshot["petSpeech"]["state"].as_str(), Some("waiting" | "speaking" | "paused"))
            && route_main_narration_ok(app, &snapshot)
        {
            return Ok(true);
        }
        let detail = json!({"context": snapshot["context"]});
        let page = json!(url.as_str());
        pet.eval(format!("if (window === window.top && location.href === {page}) window.dispatchEvent(new CustomEvent('{event}', {{detail:{detail},cancelable:true}}))"))
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn route_main_narration_ok(app: &AppHandle, snapshot: &Value) -> bool {
    let Some(token) = snapshot["remoteNarrationToken"].as_str() else { return false; };
    let Some(main) = app.get_webview_window("main") else { return false; };
    if verify_main_sender(&main, &app.state::<Arc<AppCore>>()).is_err() { return false; }
    let detail = json!({ "token": token });
    main.eval(format!("if (window === window.top) window.dispatchEvent(new CustomEvent('aichat:remote-narration-ok', {{detail:{detail}}}))")).is_ok()
}

// Local AppKit monitor: a non-pet OK is eligible only in our own key window.
// Other apps, keyboards and unpublished/older documents retain native Return.
#[cfg(target_os = "macos")]
pub(super) fn watch_main_narration_ok(window: &WebviewWindow) -> tauri::Result<()> {
    static HOST: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
    extern "C" fn deliver() -> bool {
        HOST.get().is_some_and(|app| {
            let core = app.state::<Arc<AppCore>>();
            !core.remote_voice.dialogue.active() && route_main_narration_ok(app, &core.pet.snapshot())
        })
    }
    extern "C" { fn keepwork_watch_main_narration_ok(window: *mut std::ffi::c_void, handler: extern "C" fn() -> bool); }
    let _ = HOST.get_or_init(|| window.app_handle().clone());
    unsafe { keepwork_watch_main_narration_ok(window.ns_window()?, deliver); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn watch_pet_ok(window: &WebviewWindow) {
    static HOST: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
    extern "C" fn deliver(device_epoch: u64) {
        if crate::remote_voice::dialogue::pet_ok_current(device_epoch) {
            if let Some(app) = HOST.get() {
                let _ = route_pet_button(app, "aichat:remote-ok");
            }
        }
    }
    let _ = HOST.get_or_init(|| window.app_handle().clone());
    let pet = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(native) = pet.ns_window() {
            extern "C" { fn keepwork_pet_watch_ok(window: *mut std::ffi::c_void, action: extern "C" fn(u64)); }
            unsafe { keepwork_pet_watch_ok(native, deliver); }
        }
    });
}

/// The physical remote requests focus once, at the start of the utterance.
/// Other applications keep the ordinary current-focus dictation behavior.
pub(super) fn focus_pet_for_remote_voice(
    app: &AppHandle,
) -> RecordingTarget {
    static NEXT_PRESS: AtomicU64 = AtomicU64::new(1);
    const UNAVAILABLE: &str = "无法聚焦桌宠输入框，请打开桌宠聊天后重新录音。";
    let Some(pet) = app.get_webview_window("pet") else { return Ok(None); };
    if !pet_is_active(&pet).map_err(|_| UNAVAILABLE)? {
        return Ok(None);
    }

    let core = app.state::<Arc<AppCore>>();
    let pet_url = super::sender::loaded_page_url(&pet).ok().flatten().ok_or(UNAVAILABLE)?;
    let local_pet_page = pet_url.path() == "/pet.html" && match (pet_url.scheme(), pet_url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("127.0.0.1")) => cfg!(debug_assertions) && pet_url.port() == Some(1430),
        _ => false,
    };
    let preview_url = json!(pet_url.as_str());
    if !local_pet_page { return Err(UNAVAILABLE.into()); }
    crate::security::assert_sender(pet.label(), "pet", true, pet_url.as_str(), core.current_dev_url().as_deref()).map_err(|_| UNAVAILABLE)?;
    let snap = core.pet.snapshot();
    if !snap["exitPrompt"].is_null() || !snap["permission"].is_null()
        || snap["richDraft"] == true || snap["dictating"] == true {
        return Err("桌宠输入框当前不可编辑，请先完成当前操作再录音。".into());
    }
    // The full-screen overlay can focus its DOM editor without activating AIChat.
    #[cfg(target_os = "macos")]
    let activate_window = core.pet_home_overlay.lock().unwrap().is_none();
    #[cfg(not(target_os = "macos"))]
    let activate_window = true;
    if activate_window {
        pet.set_focus().map_err(|_| UNAVAILABLE)?;
        app.get_webview("pet").ok_or(UNAVAILABLE)?.set_focus().map_err(|_| UNAVAILABLE)?;
    }
    let expanded = core.pet.set_expanded(true);
    pet.emit_to("pet", "aichat-desktop:pet-state", &expanded).map_err(|_| UNAVAILABLE)?;
    let (reply, focused) = tokio::sync::oneshot::channel();
    let reply = std::sync::Mutex::new(Some(reply));
    let press = NEXT_PRESS.fetch_add(1, Ordering::Relaxed);
    cancel_pet_speech(app, &core);
    pet.eval_with_callback(
        format!("window === window.top && location.href === {preview_url} && !window.dispatchEvent(new CustomEvent('aichat:remote-voice-focus', {{detail:{press}, cancelable:true}}))"),
        move |result| {
            if let Some(reply) = reply.lock().unwrap().take() {
                let _ = reply.send(result == "true");
            }
        },
    ).map_err(|_| UNAVAILABLE)?;
    let target = pet.clone();
    let target_url = preview_url.clone();
    let context = snap["context"].clone();
    Ok(Some(RecordingFeedback {
        focus: Some(focused),
        pet_delivery: Some(Box::new(move |action, text| {
            if !pet_is_active(&target).map_err(|_| UNAVAILABLE)? {
                return Err(UNAVAILABLE.into());
            }
            let detail = json!({"press": press, "context": context, "action": action, "text": text});
            let (ack, result) = tokio::sync::oneshot::channel();
            let ack = std::sync::Mutex::new(Some(ack));
            target.eval_with_callback(format!(
                "window === window.top && location.href === {target_url} && !window.dispatchEvent(new CustomEvent('aichat:remote-voice-edit', {{detail:{detail}, cancelable:true}}))"
            ), move |value| {
                if let Some(ack) = ack.lock().unwrap().take() { let _ = ack.send(value == "true"); }
            }).map_err(|_| UNAVAILABLE)?;
            Ok(result)
        })),
        notify: Box::new(move |phase| {
            let event = match phase {
                RecordingPhase::Preview(text) => {
                    // Only the original local pet page can receive the ephemeral caption.
                    let detail = json!({"press": press, "text": crate::remote_voice::preview_tail(&text)});
                    let _ = pet.eval(format!("if (window === window.top && location.href === {preview_url}) window.dispatchEvent(new CustomEvent('aichat:remote-voice-preview', {{detail:{detail}}}));"));
                    return;
                }
                RecordingPhase::Recording => "aichat:remote-voice-recording",
                RecordingPhase::Transcribing => "aichat:remote-voice-transcribing",
                RecordingPhase::NoAudio => "aichat:remote-voice-no-audio",
                RecordingPhase::End => "aichat:remote-voice-end",
            };
            let _ = pet.eval(format!("window.dispatchEvent(new CustomEvent('{event}', {{detail:{press}}}))"));
        }),
    }))
}

pub fn ensure_pet_window(app: &AppHandle, core: &Arc<AppCore>, show_now: bool) {
    let handle = app.clone();
    let core = Arc::clone(core);
    let _ = super::main_window::run_on_window_thread(app, move || {
        if core.quitting.load(Ordering::Relaxed) {
            return;
        }
        if show_now && (!core.settings().pet_visible
            || core.page_connection.lock().unwrap().wants_foreground()
            || handle.get_webview_window("main").is_some_and(|main| {
                main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false)
            }))
        {
            return;
        }
        ensure_pet_window_on_ui(&handle, &core, show_now);
    });
}

fn ensure_pet_window_on_ui(app: &AppHandle, core: &Arc<AppCore>, show_now: bool) {
    if let Some(existing) = app.get_webview_window("pet") {
        if show_now {
            #[cfg(target_os = "macos")]
            super::pet_home_overlay::finish(&existing, core);
            if existing.show().is_ok() {
                let _ = existing.eval("window.__aichatPetHidden=false;window.dispatchEvent(new Event('aichat:pet-shown'))");
            }
            #[cfg(target_os = "macos")]
            watch_pet_ok(&existing);
            super::remote_phone_view::sync(app);
            sync_pet_pointer(&existing, &core.pet, app);
        }
        broadcast_pet_state(app, core);
        return;
    }

    let area = initial_pet_work_area(app, &core.pet);
    core.pet.set_work_area(area);
    let canvas = core.pet.desired_canvas();

    if let Ok(builder) = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("桌面宠物")
        .initialization_script(super::main_window::HOME_TEXT_GUARD)
        .initialization_script(format!("window.__aichatPetHidden={};", !show_now))
        .position(canvas.x as f64, canvas.y as f64)
        .inner_size(canvas.width as f64, canvas.height as f64)
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
        if pet_canvas::sync_pet_canvas(&builder, canvas).is_ok() {
            core.pet.note_canvas(canvas);
        }
        let _ = builder.set_shadow(false);
        let _ = pet_pointer::set_interactive(&builder, false);
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
        super::remote_phone_view::sync(app);
        #[cfg(target_os = "macos")]
        watch_pet_ok(&builder);
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
    let dictation_audio = incoming["petDictationAudioVersion"].as_u64() == Some(pet_audio::VERSION);
    let persona_audio = incoming["target"].as_str() == Some("persona")
        && incoming["petVoiceAudioVersion"].as_u64() == Some(pet_audio::VERSION);
    let supports_audio = incoming["ready"].as_bool() == Some(true) && (dictation_audio || persona_audio);
    let previous_phone = state_mgr.pet.active_phone_id();
    let snapshot = state_mgr.pet.update_raw_state(incoming);
    if previous_phone != state_mgr.pet.active_phone_id() {
        super::remote_phone_view::sync(&app);
    }
    let context = snapshot["context"]
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

/// Browser-owned capture needs a visible permission UI on Windows as well as
/// macOS. Negotiated pet capture owns its own microphone and keeps main hidden.
async fn prepare_legacy_media_owner<F: std::future::Future<Output = Result<(), String>>>(
    snapshot: &Value,
    name: &str,
    pet_capture: bool,
    prepare: impl FnOnce() -> F,
) -> Result<(), String> {
    if !pet_capture && pet::starts_media_capture(snapshot, name) {
        prepare().await?;
    }
    Ok(())
}

async fn request_pet_command(
    app: &AppHandle,
    core: &AppCore,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let (mut command, receiver) = core.pet.begin_command(name, args)?;
    if matches!(name, "stop" | "dictation" | "call" | "record-start" | "voice-start" | "toggle-target") {
        cancel_pet_speech(app, core);
    }
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
    // An explicit hangup must never prepare a microphone, even if the call
    // ended between the renderer snapshot and command dispatch.
    let media_action = if name == "call" && args["stopOnly"] == true { "voice-stop" } else { name };
    let pet_capture = pet::uses_pet_audio(&snapshot, media_action) && core.pet_audio.supported(context);
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
    // Browser-owned capture needs the retained document visible for its permission UI.
    if let Err(error) = prepare_legacy_media_owner(&snapshot, media_action, pet_capture, || async {
        let handle = app.clone();
        let (done, visible) = tokio::sync::oneshot::channel();
        super::main_window::run_on_window_thread(app, move || {
            let core = handle.state::<Arc<AppCore>>();
            show_main_window(&handle, &core);
            let presented = handle.get_webview_window("main").is_some_and(|main| {
                main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(true)
            });
            let _ = done.send(presented);
        }).map_err(|e| e.to_string())?;
        if visible.await.unwrap_or(false) {
            Ok(())
        } else {
            Err("无法显示录音页面，请打开 AIChat 主窗口后重试。".into())
        }
    }).await {
        core.pet
            .resolve_command(&json!({ "requestId": request_id, "ok": false, "error": error }));
        return Err(error);
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
    } else if name == "send" && snapshot["petStreamingSpeechVersion"] == 1 {
        // Serialize send delivery with native presentation. If a Dock/Home/hide
        // intervened before dispatch, never start speech in a hidden pet.
        let handle = app.clone();
        let command = command.clone();
        let dispatch = app.run_on_main_thread(move || {
            let core = handle.state::<Arc<AppCore>>();
            let id = command["requestId"].as_str().unwrap_or_default();
            let visible = handle.get_webview_window("pet").is_some_and(|w| w.is_visible().unwrap_or(false));
            if !visible || !core.pet.owns_speech_request(id) {
                core.pet.resolve_command(&json!({"requestId": id, "ok": false, "error": "桌宠状态已改变，草稿已保留。"}));
                return;
            }
            core.pet.set_expanded(false);
            broadcast_pet_state(&handle, &core);
            broadcast_to_main(&handle, "pet-command", &command);
        });
        if let Err(error) = dispatch {
            core.pet.resolve_command(&json!({"requestId": request_id, "ok": false, "error": error.to_string()}));
        }
    } else {
        if name == "send" {
            core.pet.set_expanded(false);
            broadcast_pet_state(app, core);
        }
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
    if name == "send" {
        // If acceptance was lost, the page might already be playing speech.
        // Stop only that send's audio, leaving the chat mutation alone.
        if result.as_ref().ok().and_then(|ack| ack["requestId"].as_str()) != Some(request_id.as_str()) {
            if let Some(cancel) = core.pet.take_speech_cancellation(Some(&request_id)) {
                broadcast_to_main(app, "pet-command", &cancel);
            }
        }
        return result.map(|ack| {
            let mut snapshot = core.pet.snapshot();
            if ack["requestId"].as_str() == Some(request_id.as_str()) && snapshot["context"] == command["context"] {
                snapshot["sentRequestId"] = json!(request_id);
            }
            snapshot
        });
    }
    result
}

fn cancel_pet_speech(app: &AppHandle, core: &AppCore) {
    if let Some(command) = core.pet.take_speech_cancellation(None) {
        broadcast_to_main(app, "pet-command", &command);
    }
}

pub(super) fn dismiss_pet_view(window: &WebviewWindow) -> tauri::Result<()> {
    window.hide()?;
    #[cfg(target_os = "macos")]
    watch_pet_ok(window);
    let app = window.app_handle();
    #[cfg(target_os = "macos")]
    super::pet_home_overlay::finish(window, &app.state::<Arc<AppCore>>());
    super::remote_phone_view::sync(app);
    cancel_pet_speech(app, &app.state::<Arc<AppCore>>());
    let _ = window.eval("window.__aichatPetHidden=true;window.dispatchEvent(new Event('aichat:pet-hidden'))");
    Ok(())
}

pub(super) fn hide_pet_window(app: &AppHandle, core: &AppCore) {
    core.update_settings(|settings| settings.pet_visible = false);
    if let Some(window) = app.get_webview_window("pet") {
        let _ = dismiss_pet_view(&window);
    }
    finish_pet_hide(app, core);
}

/// Runs on the UI thread, serialized with Home and native window presentation.
pub(super) fn temporarily_hide_pet(
    app: &AppHandle,
    core: &AppCore,
    context: &Value,
    expected_expanded: bool,
) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    let pet = core.pet.snapshot();
    if !pet_is_active(&window).map_err(|e| e.to_string())?
        || !pet_back_context_matches(&pet, context)
        || pet["expanded"] != expected_expanded
    {
        return Err("桌宠状态已改变。".into());
    }
    dismiss_pet_view(&window).map_err(|e| e.to_string())?;
    finish_pet_hide(app, core);
    Ok(())
}

pub(super) fn finish_pet_hide(app: &AppHandle, core: &AppCore) {
    stop_pet_audio(app, core, None, "宠物已隐藏", false);
    core.pet.cancel_exit_prompt();
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
        pet_menu::Action::AppearanceMode(mode) => {
            core.pet.set_appearance_mode(mode);
            broadcast_pet_state(app, core);
        }
        pet_menu::Action::Appearance(appearance) => {
            core.pet.set_appearance(appearance);
            broadcast_pet_state(app, core);
        }
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
        "hangup" => {
            let snapshot = state.pet.snapshot();
            let id = args["dialogueId"].as_str().ok_or("缺少通话标识。")?;
            if args["context"] == snapshot["context"] && snapshot["remoteDialogue"]["id"] == id
                && state.remote_voice.dialogue.exit_matching(Some(id), "pet") {
                super::remote_phone_view::sync(&app);
            }
            Ok(state.pet.snapshot())
        }
        "remote-voice-readiness" => Ok(json!({"readiness": state.remote_voice.pet_readiness()})),
        "menu" => {
            let menu = pet_menu::build(&app, &state.pet.preferences(), &state.pet.snapshot())
                .map_err(|error| error.to_string())?;
            let result = state.pet_menu.popup(&window, &state.pet, menu);
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
            if let Some(context) = args.get("context") {
                if !pet_back_context_matches(&state.pet.snapshot(), context) {
                    return Err("桌宠状态已改变。".into());
                }
            }
            let snap = state.pet.set_expanded(expanded);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "hide-temporarily" => {
            // Remote Back omits this field and may hide only a collapsed pet.
            let expected_expanded = match args.get("expanded") {
                None => false,
                Some(value) => value.as_bool().ok_or("桌宠面板状态无效。")?,
            };
            let handle = app.clone();
            let (done, result) = tokio::sync::oneshot::channel();
            super::main_window::run_on_window_thread(&app, move || {
                let core = handle.state::<Arc<AppCore>>();
                let _ = done.send(temporarily_hide_pet(&handle, &core, &args["context"], expected_expanded));
            }).map_err(|e| e.to_string())?;
            result.await.map_err(|e| e.to_string())??;
            Ok(state.pet.snapshot())
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
            let pet = Arc::clone(&state.pet);
            let handle = app.clone();
            let (done, completed) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let current = pet.current_canvas();
                let measured = serde_json::from_value::<WorkArea>(args["canvas"].clone()).ok();
                if measured == Some(current) || args.get("canvas").is_none() {
                    if let Some(epoch) = args["epoch"].as_u64() {
                        pet.update_layout(&args["regions"], &args["visualRegions"], epoch);
                        if let Some(window) = handle.get_webview_window("pet") {
                            reconcile_pet_canvas(&window, &pet);
                        }
                    }
                }
                let _ = done.send(json!({ "ok": true, "canvas": pet.current_canvas(), "workArea": pet.work_area() }));
            }).map_err(|error| error.to_string())?;
            completed.await.map_err(|_| "宠物窗口布局更新中断".to_string())
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
            let _ = dismiss_pet_view(&window);
            let snap = state.pet.set_permission_prompt(None);
            broadcast_pet_state(&app, &state);
            Ok(snap)
        }
        "input" | "send" | "stop" | "dictation" | "call" | "mute" | "voice-start"
        | "voice-stop" | "record-start" | "record-stop" | "toggle-target"
        | "pause-speech" | "resume-speech" | "cancel-speech" => {
            if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
                if text.chars().count() > crate::pet::MAX_PET_INPUT_CHARS {
                    return Err("输入内容过长，请在桌面主窗口中编辑".to_string());
                }
            }
            let result = request_pet_command(&app, &state, &name, &args).await?;
            if name == "send" { Ok(result) } else { Ok(state.pet.snapshot()) }
        }
        _ => Ok(state.pet.snapshot()),
    }
}

#[cfg(test)]
mod pet_drag_host_tests {
    use serde_json::json;

    #[tokio::test]
    async fn legacy_microphone_starts_prepare_the_owner_on_all_platforms() {
        let ready = json!({
            "ready": true, "canCall": true, "compactVoice": true,
            "classroomRecording": { "enabled": false }
        });
        // Absent and unknown optional capabilities keep the browser-owned
        // capture contract. In particular, Windows must not skip preparation.
        for version in [serde_json::Value::Null, json!(2), json!("1")] {
            let mut snapshot = ready.clone();
            snapshot["petVoiceAudioVersion"] = version;
            for action in ["dictation", "call", "voice-start", "record-start"] {
                let mut prepared = 0;
                super::prepare_legacy_media_owner(&snapshot, action, false, || {
                    prepared += 1;
                    std::future::ready(Ok(()))
                })
                .await.unwrap();
                assert_eq!(prepared, 1, "{action}");
            }
        }
    }

    #[tokio::test]
    async fn pet_capture_and_non_start_commands_never_reveal_main() {
        let ready = json!({
            "ready": true, "canCall": true, "compactVoice": true,
            "classroomRecording": { "enabled": false }
        });
        let must_stay_hidden = || async { panic!("main must stay hidden") };
        for action in ["dictation", "call", "voice-start", "record-start"] {
            super::prepare_legacy_media_owner(&ready, action, true, must_stay_hidden).await.unwrap();
            for (key, value) in [
                ("ready", json!(false)),
                ("dictating", json!(true)),
                ("voice", json!({ "active": true })),
            ] {
                let mut unavailable = ready.clone();
                unavailable[key] = value;
                super::prepare_legacy_media_owner(&unavailable, action, false, must_stay_hidden)
                    .await.unwrap();
            }
        }
        for action in [
            "input",
            "send",
            "stop",
            "mute",
            "voice-stop",
            "record-stop",
            "toggle-target",
        ] {
            super::prepare_legacy_media_owner(&ready, action, false, must_stay_hidden).await.unwrap();
        }
        super::prepare_legacy_media_owner(
            &json!({ "ready": true }),
            "call",
            false,
            must_stay_hidden,
        )
        .await.unwrap();
    }

    #[tokio::test]
    async fn failed_owner_preparation_returns_the_error_without_retry() {
        let mut attempts = 0;
        let error = super::prepare_legacy_media_owner(
            &json!({ "ready": true }),
            "dictation",
            false,
            || {
                attempts += 1;
                std::future::ready(Err("Cannot reveal the microphone permission UI".to_string()))
            },
        )
        .await.unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(error, "Cannot reveal the microphone permission UI");
    }

    #[test]
    fn macos_button_mask_distinguishes_primary_from_other_buttons() {
        for (mask, pressed) in [
            (0, false),
            (1, true),
            (2, false),
            (3, true),
            (4, false),
            (1 << 16, false),
            (usize::MAX, true),
        ] {
            assert_eq!(
                super::primary_button_from_macos_mask(mask),
                pressed,
                "macOS button mask {mask:#x}"
            );
        }
    }

    #[test]
    fn windows_button_state_uses_current_high_bit_without_historical_low_bit() {
        for (bits, pressed) in [
            (0u16, false),
            (1, false),
            (0x7fff, false),
            (0x8000, true),
            (0x8001, true),
            (0xffff, true),
        ] {
            assert_eq!(
                super::primary_button_from_windows_state(bits as i16),
                pressed,
                "Windows button state {bits:#x}"
            );
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    #[ignore = "requires an unlocked interactive desktop with the physical primary mouse button released; run separately with --ignored --exact"]
    fn primary_button_is_up_without_a_held_click() {
        assert!(
            !super::primary_button_down(),
            "idle primary button must read as up, or every drag frame will end immediately"
        );
    }
}
