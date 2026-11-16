//! Real Tauri/AppKit/WKWebView startup checks, available only in `dev-bins`.
//! Every path and HTTP listener belongs to this fixture. Runtime supervisors
//! are constructed for status snapshots but are never started or checked.

use super::{main_window, native_startup, pet_host, state::AppCore};
use crate::{
    files::NativeFiles,
    launch_intents::LaunchIntents,
    login_startup::LoginStartup,
    page_connection::{PageConnection, Phase, Presentation, LOAD_TIMEOUT_SECONDS},
    permissions::MediaGrants,
    pet::PetController,
    runtime::{RuntimeConfig, RuntimeSupervisor},
    terminal::TerminalSessionManager,
    theme::ThemePreference,
    updates::UpdateManager,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Isolated startup fixture</title>
<div id="startup-progress" role="progressbar">Loading fixture packages</div>
<div id="app"><div class="loading" aria-busy="true">Loading workspace…</div></div><script>
const poll = setInterval(async () => {
  try {
    const response = await fetch('/gate', { cache: 'no-store' });
    if (!(await response.json()).ready) return;
    document.getElementById('app').innerHTML = '<main class="app-shell"><button id="workspace-action">Isolated workspace is ready</button></main>';
    document.documentElement.dataset.workbenchReady = 'true';
    document.getElementById('startup-progress').remove();
    // The content/marker are complete before this stylesheet is requested. The
    // desktop must still wait for the critical first-screen style to finish.
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/screen.css';
    document.head.appendChild(stylesheet);
    clearInterval(poll);
  } catch (_) {}
}, 50);
addEventListener('aichat:remote-phone', ({ detail }) => {
  if (detail.action === 'enter' && detail.surface === 'pet') {
    detail.status = 'active';
    detail.liveVersion = 1;
    const publish = state => window.__TAURI_INTERNALS__.invoke('desktop_publish_pet_state', {state:{
      remotePhoneVersion:1, remoteDialogue:{id:detail.id, state}
    }});
    // Once listening, WebKit must still be able to acquire a fresh microphone.
    publish('starting').then(() => publish('listening'));
  }
});
addEventListener('pagehide', () => clearInterval(poll), { once: true });
</script>"#;

const SHELL: &str = r#"<!doctype html><meta charset="utf-8"><title>Internal recovery fixture</title>
<script>
const connection = window.__AICHAT_PAGE_CONNECTION__;
connection.status().then(async status => {
  await fetch('/status-confirmed', { cache: 'no-store' });
  // The initial native attempt is already reserved. This exercises the real
  // shell retry IPC and its deduplication without adding a second navigation.
  if (status.pageConnection.phase === 'connecting') {
    await connection.retry(false);
    await fetch('/retry-confirmed', { cache: 'no-store' });
  }
}).catch(() => fetch('/ipc-failed'));
</script>"#;

#[derive(Default)]
struct FixtureState {
    ready: AtomicBool,
    entries: AtomicUsize,
    gates: AtomicUsize,
    styles_started: AtomicUsize,
    styles_finished: AtomicUsize,
    statuses: AtomicUsize,
    retries: AtomicUsize,
    dock_reopens: AtomicUsize,
    approval_presented: AtomicUsize,
    approval_returned: AtomicUsize,
    screenshot_checks: AtomicUsize,
    unexpected: AtomicUsize,
    stopped: AtomicBool,
}

struct Fixture {
    origin: String,
    port: u16,
    state: Arc<FixtureState>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    fn new() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let state = Arc::new(FixtureState::default());
        let server = Arc::clone(&state);
        let worker = thread::spawn(move || {
            while !server.stopped.load(Ordering::Relaxed) {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
                let mut request = [0; 8192];
                let length = socket.read(&mut request).unwrap_or(0);
                if length == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&request[..length]);
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let (code, mime, body) = match path {
                    "/AIChat.html" => {
                        server.entries.fetch_add(1, Ordering::Relaxed);
                        (200, "text/html", PAGE.to_string())
                    }
                    "/pet.html" => (200, "text/html", "<!doctype html><title>Isolated pet</title>".into()),
                    "/recovery" => (200, "text/html", SHELL.to_string()),
                    "/gate" => {
                        server.gates.fetch_add(1, Ordering::Relaxed);
                        (
                            200,
                            "application/json",
                            json!({"ready":server.ready.load(Ordering::Relaxed)}).to_string(),
                        )
                    }
                    "/screen.css" => {
                        // The page requests CSS only after its gate response
                        // and ready marker; delaying this sequential worker
                        // cannot block a gate needed to complete the page.
                        server.styles_started.fetch_add(1, Ordering::Relaxed);
                        thread::sleep(Duration::from_millis(500));
                        server.styles_finished.fetch_add(1, Ordering::Relaxed);
                        (200, "text/css", ".app-shell { font: 16px system-ui; padding: 24px; } #workspace-action { min-height: 40px; }".into())
                    }
                    "/status-confirmed" => {
                        server.statuses.fetch_add(1, Ordering::Relaxed);
                        (200, "text/plain", "ok".into())
                    }
                    "/screenshot-checked" => {
                        server.screenshot_checks.fetch_add(1, Ordering::Relaxed);
                        (200, "text/plain", "ok".into())
                    }
                    "/approval-returned" => {
                        server.approval_returned.fetch_add(1, Ordering::Relaxed);
                        (200, "text/plain", "ok".into())
                    }
                    "/approval-presented" => {
                        server.approval_presented.fetch_add(1, Ordering::Relaxed);
                        (200, "text/plain", "ok".into())
                    }
                    "/retry-confirmed" => {
                        server.retries.fetch_add(1, Ordering::Relaxed);
                        (200, "text/plain", "ok".into())
                    }
                    "/favicon.ico" => (204, "text/plain", String::new()),
                    _ => {
                        server.unexpected.fetch_add(1, Ordering::Relaxed);
                        (404, "text/plain", "Unexpected fixture request".into())
                    }
                };
                let headers = format!("HTTP/1.1 {code} Fixture\r\nContent-Type: {mime}; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = socket.write_all(headers.as_bytes());
                let _ = socket.write_all(body.as_bytes());
            }
        });
        Ok(Self {
            origin: format!("http://127.0.0.1:{port}"),
            port,
            state,
            worker: Some(worker),
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Profile(PathBuf);
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn core(profile: &Path, fixture: &Fixture) -> Result<Arc<AppCore>, String> {
    let settings = profile.join("settings.json");
    fs::write(&settings, r#"{"petVisible":false,"openAtLogin":false}"#)
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(profile.join("remote-voice")).map_err(|e| e.to_string())?;
    fs::write(
        profile.join("remote-voice/config.json"),
        r#"{"autoStart":false}"#,
    )
    .map_err(|e| e.to_string())?;
    let supervisor = |id: &str| {
        Arc::new(RuntimeSupervisor::new(RuntimeConfig {
            id: id.into(),
            products: vec![if id == "mcp" {
                "keepwork-mcp-runtime"
            } else {
                "keepwork-local-model-node-runtime"
            }
            .into()],
            port: fixture.port,
            health_path: format!("/never-start-{id}"),
            updates_enabled: false,
            bundled_dir: profile.join(format!("empty-{id}")),
            store_dir: profile.join(format!("store-{id}")),
            feed_url: format!("{}/never-update-{id}", fixture.origin),
        }))
    };
    Ok(Arc::new(AppCore {
        profile_dir: profile.to_path_buf(),
        settings_path: settings.clone(),
        theme: ThemePreference::new(profile.join("theme.json")),
        mcp_home: profile.join("mcp-home"),
        files: NativeFiles::new(profile.join("folder-grants.json")),
        terminals: TerminalSessionManager::new(profile.join("terminals")),
        media_grants: MediaGrants::new(profile.join("media-grants.json")),
        login_startup: LoginStartup::new(
            settings.clone(),
            profile.join("LaunchAgents"),
            std::env::current_exe().map_err(|e| e.to_string())?,
            false,
        ),
        mcp_supervisor: supervisor("mcp"),
        local_model_supervisor: supervisor("local-model"),
        updates: Arc::new(UpdateManager::new(
            "0.0.0".into(),
            profile.join("updates.json"),
            profile.join("updates"),
            format!("{}/never-update-shell", fixture.origin),
            None,
        )),
        pet: Arc::new(PetController::new(profile.join("pet.json"))),
        pet_approval_return: Mutex::new(None),
        pet_audio: Arc::new(crate::pet_audio::PetAudioRelay::default()),
        remote_voice: Arc::new(crate::remote_voice::RemoteVoice::new(profile)),
        pet_menu: crate::pet_menu::Session::default(),
        dev_server: Mutex::new(None),
        entry_url: Mutex::new(format!("{}/AIChat.html", fixture.origin)),
        local_source_enabled: AtomicBool::new(false),
        zoom: Mutex::new(1.0),
        signed_in: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        #[cfg(target_os = "macos")]
        pet_home_overlay: Mutex::new(None),
        replacing_instance: AtomicBool::new(false),
        channels: Mutex::new(crate::tray_channels::channel_states(&Value::Null)),
        lock: Mutex::new(None),
        page_connection: Mutex::new(PageConnection::default()),
        launch_intents: Mutex::new(LaunchIntents::new(settings)),
    }))
}

async fn ui<T, F>(app: &AppHandle, action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle, &Arc<AppCore>) -> Result<T, String> + Send + 'static,
{
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let core = handle.state::<Arc<AppCore>>();
        let _ = send.send(action(&handle, core.inner()));
    })
    .map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

// Use the production remote dispatch queue for remote button sequences. Native
// menu restores below deliberately originate in a Tao event callback.
async fn remote_ui<F>(app: &AppHandle, action: F) -> Result<(), String>
where
    F: FnOnce(&AppHandle, &Arc<AppCore>) -> Result<(), String> + Send + 'static,
{
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    main_window::run_on_window_thread(app, move || {
        let core = handle.state::<Arc<AppCore>>();
        let _ = send.send(action(&handle, core.inner()));
    })
    .map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[derive(Debug)]
struct ViewState {
    phase: Phase,
    main: bool,
    overlay: bool,
}

async fn snapshot(app: &AppHandle) -> Result<ViewState, String> {
    ui(app, |app, core| {
        // Single-window invariant: a separate startup window must never exist.
        if app.get_window("startup").is_some() {
            return Err("A second startup window was created".into());
        }
        if app.windows().len() != 1 || app.webview_windows().len() != 1 {
            return Err("Startup must use exactly one main window and one WebView".into());
        }
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let visible = main.is_visible().map_err(|e| e.to_string())?;
        let native = main.ns_window().map_err(|e| e.to_string())?;
        if !unsafe { keepwork_startup_smoke_main_intact(native) } {
            return Err("Startup replaced its main window, content view, or WebView".into());
        }
        let overlay = unsafe { keepwork_startup_smoke_overlay_present(native) };
        if overlay && !unsafe { keepwork_startup_smoke_overlay_covers(native) } {
            return Err("Startup overlay does not opaquely cover its WebView".into());
        }
        if visible && !overlay && !unsafe { keepwork_startup_smoke_document_focused(native) } {
            return Err("Ready document did not receive keyboard focus after startup".into());
        }
        Ok(ViewState {
            phase: core.page_connection.lock().unwrap().snapshot("").phase,
            main: visible,
            overlay,
        })
    })
    .await
}

async fn wait_view(
    app: &AppHandle,
    label: &str,
    phase: Phase,
    main: bool,
    overlay: Option<bool>,
    seconds: u64,
) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(seconds);
    loop {
        let actual = snapshot(app).await?;
        if matches!(actual.phase, Phase::Idle | Phase::Connecting) && actual.main {
            return Err(format!(
                "Loading window became visible during {label}: {actual:?}"
            ));
        }
        if actual.phase == Phase::Unavailable && actual.main && !actual.overlay {
            return Err(format!(
                "Unready document exposed without the overlay during {label}: {actual:?}"
            ));
        }
        if actual.phase == phase && actual.main == main
            && overlay.map_or(true, |expected| actual.overlay == expected)
        {
            println!(
                "{}",
                json!({"case":label,"phase":format!("{phase:?}"),"mainVisible":actual.main,"overlayPresent":actual.overlay})
            );
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(format!("{label} timed out: {actual:?}"));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn loading_stays_hidden(
    app: &AppHandle,
    fixture: &FixtureState,
    label: &str,
) -> Result<(), String> {
    let gates = fixture.gates.load(Ordering::Relaxed);
    wait_count(&fixture.gates, gates + 2, "loading document scripts").await?;
    let until = Instant::now() + Duration::from_millis(300);
    loop {
        let actual = snapshot(app).await?;
        if actual.phase != Phase::Connecting || actual.main {
            return Err(format!(
                "Initial loading content was treated as a complete first screen during {label}: {actual:?}"
            ));
        }
        if Instant::now() >= until {
            println!("{}", json!({"case":label,"phase":"Connecting","mainVisible":false,"loadingObserved":true}));
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

async fn recovery_failure(app: &AppHandle) -> Result<(), String> {
    ui(app, |app, core| {
        let target = main_window::current_entry_url(core);
        let url = target.parse().map_err(|e: url::ParseError| e.to_string())?;
        {
            let mut connection = core.page_connection.lock().unwrap();
            let generation = connection.attempt(&url).ok_or("Missing pending recovery attempt")?;
            if !connection.fail(generation, "Controlled native recovery fixture") {
                return Err("Cannot enter controlled recovery failure".into());
            }
        }
        main_window::sync_window_presentation(app, false);
        Ok(())
    }).await
}

async fn wait_count(counter: &AtomicUsize, expected: usize, label: &str) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(8);
    while counter.load(Ordering::Relaxed) < expected {
        if Instant::now() >= until {
            return Err(format!("No real WebView acknowledgement for {label}"));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Ok(())
}

extern "C" {
    fn keepwork_startup_smoke_passive_application() -> bool;
    fn keepwork_startup_smoke_cancel_screenshot_alert();
    fn keepwork_startup_smoke_restore_application();
    fn keepwork_startup_smoke_dock_reopen(expected_visible: bool) -> bool;
    fn keepwork_startup_smoke_capture_main(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_main_intact(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_overlay_present(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_overlay_covers(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_document_focused(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_voice_modifier_state() -> u32;
    fn keepwork_startup_smoke_action(window: *mut std::ffi::c_void, action: u32) -> bool;
}

async fn native_action(app: &AppHandle, action: u32) -> Result<(), String> {
    ui(app, move |app, _| {
        // The overlay lives inside the main window; actions target that window.
        let window = app.get_window("main").ok_or("Missing main window")?;
        let native = window.ns_window().map_err(|e| e.to_string())?;
        if unsafe { keepwork_startup_smoke_action(native, action) } {
            Ok(())
        } else {
            Err(format!("Cannot dispatch native startup action {action}"))
        }
    })
    .await
}

async fn reload(
    app: &AppHandle,
    fixture: &FixtureState,
    foreground: bool,
) -> Result<usize, String> {
    fixture.ready.store(false, Ordering::Relaxed);
    let expected = fixture.entries.load(Ordering::Relaxed) + 1;
    ui(app, move |app, core| {
        if foreground {
            main_window::show_main_window(app, core);
        } else {
            main_window::hide_main_window(app, core);
        }
        main_window::reload_main_window(app, core);
        Ok(())
    })
    .await?;
    wait_count(&fixture.entries, expected, "entry navigation").await?;
    Ok(expected)
}

// Begin with a visible pet and the main window in the background. Finish in
// the same state so the caller can verify normal restore and the page request count.
fn check_temporary_pet_hide(app: &AppHandle, core: &AppCore) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("Missing main window")?;
    let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
    let context = core.pet.snapshot()["context"].clone();

    if !pet_host::route_remote_back(app)? {
        return Err("A visible pet did not consume Back".into());
    }
    core.pet.set_expanded(true);
    if pet_host::temporarily_hide_pet(app, core, &context, false).is_ok() {
        return Err("An expanded pet accepted a collapsed-pet Back request".into());
    }
    core.pet.set_expanded(false);
    if pet_host::temporarily_hide_pet(app, core, &context, true).is_ok() {
        return Err("A collapsed pet accepted a stale panel minimize request".into());
    }
    if pet_host::temporarily_hide_pet(app, core, &json!("stale-pet-context"), false).is_ok()
        || !pet.is_visible().map_err(|e| e.to_string())?
    {
        return Err("Stale pet context was allowed to hide the window".into());
    }

    pet_host::temporarily_hide_pet(app, core, &context, false)?;
    if pet_host::route_remote_back(app)? {
        return Err("A temporarily hidden pet consumed Back".into());
    }
    if pet.is_visible().map_err(|e| e.to_string())?
        || main.is_visible().map_err(|e| e.to_string())?
        || core.page_connection.lock().unwrap().presentation() != Presentation::Hidden
        || !core.settings().pet_visible
    {
        return Err("Temporary hide changed the main presentation or saved pet preference".into());
    }

    main_window::toggle_remote_home(app);
    let native = main.ns_window().map_err(|e| e.to_string())?;
    if !main.is_visible().map_err(|e| e.to_string())?
        || main.is_minimized().map_err(|e| e.to_string())?
        || pet.is_visible().map_err(|e| e.to_string())?
        || !unsafe { keepwork_startup_smoke_main_intact(native) }
        || pet_host::route_remote_back(app)?
    {
        return Err("Home from temporary hide failed to restore the retained main document".into());
    }
    main_window::toggle_remote_home(app);
    if main.is_visible().map_err(|e| e.to_string())?
        || !pet.is_visible().map_err(|e| e.to_string())?
        || !core.settings().pet_visible
    {
        return Err("Minimizing after temporary hide failed to show the pet again".into());
    }
    println!("{}", json!({"case": "remote-back-temporarily-hide-pet"}));
    Ok(())
}

// Run the physical gesture's production dispatch, page IPC and presentation
// without requesting a microphone or contacting a service in this shell smoke.
async fn exercise_pet_phone_start(app: &AppHandle) -> Result<(), String> {
    let service = app.state::<Arc<AppCore>>().remote_voice.dialogue.clone();
    let handle = app.clone();
    service.install(move |background| super::remote_dialogue::surface(&handle, background));
    service.enter();
    for expected_attached in [true, false] {
        if !expected_attached {
            service.exit("ok");
            super::remote_phone_view::sync(app);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let (attached, listening) = ui(app, |app, core| {
                let main = app.get_webview_window("main").ok_or("Missing phone owner")?;
                let native = main.ns_window().map_err(|e| e.to_string())?;
                if main.is_visible().map_err(|e| e.to_string())? {
                    return Err("Pet phone opened the full window".into());
                }
                Ok((!unsafe { keepwork_startup_smoke_main_intact(native) },
                    core.pet.snapshot()["remoteDialogue"]["state"] == "listening"))
            }).await?;
            if attached == expected_attached && listening { break; }
            if Instant::now() >= deadline { return Err(format!("Pet phone view did not reach attached={expected_attached}")); }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    }
    println!("{}", json!({ "case": "pet-gesture-retains-main-phone" }));
    Ok(())
}

async fn minimize_to_pet(app: &AppHandle, fixture: &FixtureState) -> Result<(), String> {
    let entries = fixture.entries.load(Ordering::Relaxed);
    // Start with the native control to cover creation and reuse of the pet.
    // Remote Home then switches each direction, including tightly spaced presses.
    for (enabled, home_presses) in [
        (true, 0), (false, 0), (true, 0),
        (true, 1), (false, 1), (true, 2), (false, 2),
    ] {
        ui(app, move |_, core| {
            core.update_settings(|s| s.pet_visible = enabled);
            Ok(())
        })
        .await?;
        if home_presses == 0 {
            native_action(app, 3).await?;
        } else {
            remote_ui(app, move |app, _| {
                for _ in 0..home_presses {
                    main_window::toggle_remote_home(app);
                }
                Ok(())
            })
            .await?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state = ui(app, |app, core| {
                let main = app
                    .get_webview_window("main")
                    .ok_or("Main window was destroyed")?;
                let pet_visible = app
                    .get_webview_window("pet")
                    .map_or(Ok(false), |pet| pet.is_visible())
                    .map_err(|e| e.to_string())?;
                Ok((
                    core.page_connection.lock().unwrap().presentation(),
                    main.is_visible().map_err(|e| e.to_string())?,
                    main.is_minimized().map_err(|e| e.to_string())?,
                    pet_visible,
                ))
            })
            .await?;
            let (presentation, main_visible, main_minimized, pet_visible) = state;
            let expected = if home_presses == 2 {
                presentation == Presentation::Main && main_visible && !main_minimized && !pet_visible
            } else if enabled {
                presentation == Presentation::Hidden && !main_visible && pet_visible
            } else {
                presentation == Presentation::Main && main_minimized && !pet_visible
            };
            if expected {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Minimize with pet enabled={enabled}, Home presses={home_presses} produced {state:?}"
                ));
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        if enabled && home_presses == 0 {
            exercise_pet_phone_start(app).await?;
        }
        if home_presses == 0 {
            ui(app, |app, core| {
                main_window::show_main_window(app, core);
                Ok(())
            })
            .await?;
        } else if home_presses == 1 {
            remote_ui(app, move |app, core| {
                if enabled {
                    check_temporary_pet_hide(app, core)?;
                }
                main_window::toggle_remote_home(app);
                Ok(())
            })
            .await?;
        }
        remote_ui(app, |app, _| {
            let main = app
                .get_webview_window("main")
                .ok_or("Missing restored window")?;
            let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
            let native = main.ns_window().map_err(|e| e.to_string())?;
            if !main.is_visible().map_err(|e| e.to_string())?
                || main.is_minimized().map_err(|e| e.to_string())?
                || pet.is_visible().map_err(|e| e.to_string())?
                || !unsafe { keepwork_startup_smoke_main_intact(native) }
            {
                return Err("Restore did not return to the retained main WebView".into());
            }
            Ok(())
        })
        .await?;
        if fixture.entries.load(Ordering::Relaxed) != entries {
            return Err("Minimize/restore reloaded the active document".into());
        }
        println!(
            "{}",
            json!({"case": if home_presses == 0 { "native-minimize-restore" } else { "remote-home-restore" },
                "petEnabled":enabled, "consecutiveHomePresses":home_presses})
        );
    }
    Ok(())
}

async fn dock_reopen(app: &AppHandle, fixture: &FixtureState) -> Result<(), String> {
    let entries = fixture.entries.load(Ordering::Relaxed);
    // A queued pet-show request can arrive after Home has already restored chat.
    remote_ui(app, |app, core| {
        core.update_settings(|s| s.pet_visible = true);
        pet_host::ensure_pet_window(app, core, true);
        let snapshot = core.pet.set_expanded(true);
        if pet_host::temporarily_hide_pet(app, core, &snapshot["context"], true).is_ok() {
            return Err("A delayed pet show made the pet actionable over the restored chat".into());
        }
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
        if pet.is_visible().map_err(|e| e.to_string())?
            || !main.is_visible().map_err(|e| e.to_string())?
            || main.is_minimized().map_err(|e| e.to_string())?
            || core.page_connection.lock().unwrap().presentation() != Presentation::Main
            || !core.settings().pet_visible
        {
            return Err("A delayed pet show changed the visible main window or saved preference".into());
        }
        Ok(())
    }).await?;
    println!("{}", json!({"case":"late-pet-show-after-main-restore"}));

    for (pet_enabled, temporary_hide) in [(true, true), (true, false), (false, false)] {
        remote_ui(app, move |_, core| {
            core.update_settings(|s| s.pet_visible = pet_enabled);
            Ok(())
        }).await?;
        native_action(app, 3).await?;
        if pet_enabled {
            // Wait until native minimization actually switched to pet mode.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if ui(app, |app, _| {
                    let main = app.get_webview_window("main").ok_or("Missing main window")?;
                    let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
                    Ok(!main.is_visible().map_err(|e| e.to_string())?
                        && pet_host::pet_is_active(&pet).map_err(|e| e.to_string())?)
                }).await? { break; }
                if Instant::now() >= deadline { return Err("The pet never became clickable".into()); }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
        if temporary_hide {
            remote_ui(app, |app, core| {
                let snapshot = core.pet.set_expanded(true);
                pet_host::temporarily_hide_pet(app, core, &snapshot["context"], true)
            }).await?;
        }
        for repeat in [false, true] {
            let expected_event = fixture.dock_reopens.load(Ordering::Relaxed) + 1;
            let has_visible_windows = repeat || (pet_enabled && !temporary_hide);
            // Ordinary Dock minimization is animated. Wait for the native window
            // state before delivering the next real application-delegate event.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let dispatched = ui(app, move |app, _| {
                    let main = app.get_webview_window("main").ok_or("Missing main window")?;
                    if !repeat && !pet_enabled && !main.is_minimized().map_err(|e| e.to_string())? {
                        return Ok(false);
                    }
                    Ok(unsafe { keepwork_startup_smoke_dock_reopen(has_visible_windows) })
                }).await?;
                if dispatched {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(format!("Cannot dispatch Dock reopen with visible windows={has_visible_windows}, pet={pet_enabled}, temporary hide={temporary_hide}, repeat={repeat}"));
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            wait_count(&fixture.dock_reopens, expected_event, "Dock reopen event").await?;
            remote_ui(app, move |app, core| {
                let main = app.get_webview_window("main").ok_or("Missing main window")?;
                let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
                let native = main.ns_window().map_err(|e| e.to_string())?;
                if !main.is_visible().map_err(|e| e.to_string())?
                    || main.is_minimized().map_err(|e| e.to_string())?
                    || pet.is_visible().map_err(|e| e.to_string())?
                    || core.settings().pet_visible != pet_enabled
                    || core.page_connection.lock().unwrap().presentation() != Presentation::Main
                    || !unsafe { keepwork_startup_smoke_main_intact(native) }
                    || !unsafe { keepwork_startup_smoke_document_focused(native) }
                {
                    return Err(format!("Dock reopen failed: pet={pet_enabled}, temporary hide={temporary_hide}, repeat={repeat}"));
                }
                Ok(())
            }).await?;
        }
        if fixture.entries.load(Ordering::Relaxed) != entries {
            return Err("Dock reopen reloaded the active document".into());
        }
        println!("{}", json!({"case":"dock-reopen","petEnabled":pet_enabled,"temporarilyHidden":temporary_hide,"repeatVerified":true}));
    }
    Ok(())
}

async fn pet_approval(app: &AppHandle, fixture: &FixtureState) -> Result<(), String> {
    const DOCUMENT: &str = "8a73e312-c3a0-47a3-b074-a09dd7bf25c1";
    let entries = fixture.entries.load(Ordering::Relaxed);
    remote_ui(app, |app, core| {
        core.update_settings(|s| s.pet_visible = true);
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let token = core.launch_intents.lock().unwrap().capability().to_owned();
        if super::pet_approval::reveal(app, &main, core, DOCUMENT, false)? {
            return Err("An approval outside pet mode stole focus".into());
        }
        main_window::dismiss_main_window(app, core, main_window::DismissAction::Close);
        let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
        if super::pet_approval::authenticate(&pet, core, DOCUMENT, &token).is_ok()
            || super::pet_approval::authenticate(&main, core, DOCUMENT, "").is_ok()
            || main.is_visible().map_err(|e| e.to_string())?
        {
            return Err("An unauthorized approval presenter was accepted".into());
        }
        // Mirror the page contract: open the choice before requesting its window.
        main.eval(format!(r#"(() => {{
            const dialog = document.createElement('dialog');
            dialog.innerHTML = '<button>Cancel</button><button>Allow</button>';
            const args = {{token:{token}, document:{document}}};
            dialog.addEventListener('click', async () => {{
                dialog.close();
                if (await window.__TAURI_INTERNALS__.invoke('desktop_return_to_pet_after_approval', args))
                    fetch('/approval-returned');
            }});
            document.body.append(dialog);
            dialog.showModal();
            window.__TAURI_INTERNALS__.invoke('desktop_reveal_pet_approval', {{...args, returnToPet:true}})
                .then(shown => {{ if (shown && dialog.open) fetch('/approval-presented'); }});
        }})()"#, token = json!(token), document = json!(DOCUMENT))).map_err(|e| e.to_string())
    }).await?;
    wait_count(&fixture.approval_presented, 1, "pending pet approval reveal").await?;
    remote_ui(app, |app, core| {
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
        let native = main.ns_window().map_err(|e| e.to_string())?;
        if !main.is_visible().map_err(|e| e.to_string())?
            || main.is_minimized().map_err(|e| e.to_string())?
            || pet.is_visible().map_err(|e| e.to_string())?
            || !core.settings().pet_visible
            || !unsafe { keepwork_startup_smoke_main_intact(native) }
            || !unsafe { keepwork_startup_smoke_document_focused(native) }
        {
            return Err("The retained document with the pending approval was not focused".into());
        }
        if super::pet_approval::return_to_pet(app, &main, core, "other-document")? {
            return Err("Another document consumed the screenshot return".into());
        }
        main.eval("document.querySelector('dialog[open] button').click()").map_err(|e| e.to_string())
    }).await?;
    wait_count(&fixture.approval_returned, 1, "owned screenshot return").await?;
    remote_ui(app, |app, core| {
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let pet = app.get_webview_window("pet").ok_or("Missing pet window")?;
        if main.is_visible().map_err(|e| e.to_string())? || !pet.is_visible().map_err(|e| e.to_string())?
            || super::pet_approval::return_to_pet(app, &main, core, DOCUMENT)?
        {
            return Err("Screenshot did not return to pet mode exactly once".into());
        }
        if !super::pet_approval::reveal(app, &main, core, DOCUMENT, true)? {
            return Err("Second screenshot did not acquire a temporary presentation".into());
        }
        main_window::show_main_window(app, core);
        if super::pet_approval::return_to_pet(app, &main, core, DOCUMENT)? || !main.is_visible().map_err(|e| e.to_string())? {
            return Err("Stale screenshot return overrode an explicit main-window reopen".into());
        }
        Ok(())
    }).await?;
    if fixture.entries.load(Ordering::Relaxed) != entries {
        return Err("Approval presentation reloaded the document".into());
    }
    println!("{}", json!({"case":"pending-pet-tool-approval"}));
    Ok(())
}

// Each probe is installed into a fresh, private WKWebView document. The positive
// path cancels the permission settings dialog and never requests any pixels.
async fn check_screenshot_bridge(
    app: &AppHandle, fixture: &FixtureState, authorized: bool,
) -> Result<(), String> {
    let prior = fixture.screenshot_checks.load(Ordering::Relaxed);
    let label = if authorized { "native-screenshot-cancel-with-main-hidden" } else { "native-screenshot-rejects-foreign-credential" };
    remote_ui(app, move |app, core| {
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        let (token, check) = if authorized {
            let token = core.launch_intents.lock().unwrap().capability().to_owned();
            unsafe { keepwork_startup_smoke_cancel_screenshot_alert(); }
            (token, r#"
                const initial = await bridge.getScreenshotPermission();
                try { await bridge.setScreenshotPermission(true); return false; }
                catch (error) { if (!String(error).includes('桌面截图请求已取消')) return false; }
                const afterCancel = await bridge.getScreenshotPermission();
                const revoked = await bridge.setScreenshotPermission(false);
                return [initial, afterCancel, revoked].every(status => status.alwaysAllowScreenshots === false && status.pending === false);
            "#)
        } else {
            ("unrelated-smoke-credential".to_owned(), r#"
                try { await bridge.captureScreenshot(); return false; }
                catch (error) { return String(error).includes('Unauthorized launch document'); }
            "#)
        };
        let script = crate::bridge::build_main_window_init_script_with_launch_capability(
            "darwin", "", &main_window::current_entry_url(core), &token,
        );
        main.eval(format!(r#"{script}
            (async () => {{
                const bridge = window.aichatDesktop;
                if (bridge?.capabilities?.desktopScreenshotVersion !== 1) return false;
                {check}
            }})().then(passed => {{ if (passed) fetch('/screenshot-checked'); }});"#))
            .map_err(|e| e.to_string())
    }).await?;
    wait_count(&fixture.screenshot_checks, prior + 1, label).await?;
    println!("{}", json!({"case":label}));
    Ok(())
}

async fn check_direct_main_composer(app: &AppHandle) -> Result<(), String> {
    use crate::remote_voice::ComposerDelivery;
    let main = app.get_webview_window("main").ok_or("Missing main window")?;
    ui(app, |app, core| {
        super::host_menu::setup_mac_native_menu(app, core, "zh-CN").map_err(|e| e.to_string())
    }).await?;
    let evaluate = |script: String| {
        let (send, receive) = tokio::sync::oneshot::channel();
        let send = Mutex::new(Some(send));
        let scheduled = main.eval_with_callback(script, move |value| {
            if let Some(send) = send.lock().unwrap().take() { let _ = send.send(value); }
        });
        async move {
            scheduled.map_err(|e| e.to_string())?;
            let value = tokio::time::timeout(Duration::from_secs(2), receive).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            serde_json::from_str::<Value>(&value).map_err(|e| e.to_string())
        }
    };
    if unsafe { keepwork_startup_smoke_voice_modifier_state() } != 0 {
        return Err("A real modifier is active before the direct main composer case".into());
    }
    for rich in [true, false] {
        let kind = if rich { "rich" } else { "textarea" };
        if evaluate(format!(r#"(() => {{
            document.getElementById('voiceMainFixture')?.remove();
            document.getElementById('chatInput')?.remove();
            const panel=document.createElement('section');panel.id='voiceMainFixture';
            panel.innerHTML='<button id="voiceMainToolbar">Toolbar</button>'+({rich}
                ? '<div id="chatInput" contenteditable="true"></div>' : '<textarea id="chatInput"></textarea>');
            document.body.append(panel);
            chatInput.style.whiteSpace='pre-wrap';
            if ({rich}) Object.defineProperty(chatInput,'value',{{get(){{return Array.from(this.childNodes).map(n=>
                n.nodeType===Node.TEXT_NODE?n.textContent:n.nodeName==='BR'?'\n':n.matches?.('[data-file-ref]')?'':n.textContent).join('').replace(/\u200b/g,'')}}}});
            if ({rich}) chatInput._fileMentionAdapter=true;
            window.voiceMain={{model:'',events:[]}};
            chatInput.oninput=e=>{{voiceMain.model=chatInput.value;voiceMain.events.push([e.isTrusted,e.inputType])}};
            voiceMainToolbar.focus();return document.hasFocus()&&document.activeElement===voiceMainToolbar;
        }})()"#)).await? != json!(true) { return Err(format!("Could not prepare direct main {kind} fixture")); }
        for round in 0..3 {
            let text = if round == 1 { "第二行\n\n  缩进与😀".to_owned() } else { format!("同一对话第{round}段😀") };
            let reply = super::remote_voice_host::deliver_main_composer_smoke(app, &text)?.ok_or("Main direct delivery unexpectedly unavailable")?;
            let delivery = tokio::time::timeout(Duration::from_secs(1), reply).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            let delivery = match delivery {
                Ok(delivery) => delivery,
                Err(error) => {
                    let metadata = evaluate("({active:document.activeElement?.id,focused:document.hasFocus(),valueLength:chatInput.value.length,modelLength:voiceMain.model.length,events:voiceMain.events})".to_owned()).await?;
                    return Err(format!("Direct main {kind} rejected round={round}: {error}; {metadata}"));
                }
            };
            let expected = json!(text);
            let inserted = evaluate(format!("document.activeElement===chatInput && chatInput.value==={expected} && voiceMain.model==={expected} && voiceMain.events.at(-1)?.[0]===true && voiceMain.events.at(-1)?.[1].startsWith('insert')")).await? == json!(true);
            if delivery != ComposerDelivery::Inserted || !inserted {
                let metadata = evaluate("({active:document.activeElement?.id,focused:document.hasFocus(),valueLength:chatInput.value.length,modelLength:voiceMain.model.length,events:voiceMain.events})".to_owned()).await?;
                return Err(format!("Direct main {kind} delivery failed round={round}: {delivery:?}, {metadata}"));
            }
            let cleared = super::remote_voice_host::clear_main_composer(app, Instant::now(), || true)?;
            let empty = evaluate("document.activeElement===chatInput && !chatInput.value.trim() && voiceMain.model===chatInput.value && voiceMain.events.at(-1)?.[0]===true && voiceMain.events.at(-1)?.[1].startsWith('delete')".to_owned()).await? == json!(true);
            let modifier_state = unsafe { keepwork_startup_smoke_voice_modifier_state() };
            println!("{}", json!({"case":"main-direct-positive-ack","kind":kind,"round":round,
                "accepted":delivery==ComposerDelivery::Inserted,"modelMatches":inserted,"cleared":cleared,"modelEmpty":empty,"modifierState":modifier_state}));
            if !cleared || !empty || modifier_state != 0 { return Err(format!("Direct main {kind} clear/state regression")); }
        }
    }
    if evaluate("document.getElementById('voiceMainFixture').remove();true".to_owned()).await? != json!(true) {
        return Err("Could not clean up the direct main fixture".into());
    }
    Ok(())
}

async fn check_focused_composer_back(app: &AppHandle) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("Missing main window")?;
    let evaluate = |script: &'static str| {
        let (reply, result) = tokio::sync::oneshot::channel();
        let reply = Mutex::new(Some(reply));
        let scheduled = main.eval_with_callback(script, move |value| {
            if let Some(reply) = reply.lock().unwrap().take() { let _ = reply.send(value == "true"); }
        });
        async move {
            scheduled.map_err(|e| e.to_string())?;
            tokio::time::timeout(Duration::from_secs(2), result).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
        }
    };
    if !evaluate(r#"(() => {
        const editor = document.createElement('div');
        editor.id = 'chatInput'; editor.contentEditable = 'true'; document.body.append(editor);
        editor.focus();
        editor.addEventListener('input', () => editor.dataset.model = editor.textContent);
        return document.execCommand('insertText', false, 'voice fixture') && editor.dataset.model === 'voice fixture';
    })()"#).await? { return Err("Could not type into the isolated main composer".into()); }
    if !super::remote_voice_host::clear_main_composer(app, Instant::now(), || true)?
        || !evaluate("document.activeElement.id === 'chatInput' && document.activeElement.dataset.model === ''").await?
    {
        return Err("Main Back did not clear the keyboard-focused draft".into());
    }
    println!("{}", json!({"case":"main-composer-back-without-click"}));
    Ok(())
}

async fn check_home_windows(app: &AppHandle, enabled: bool, returning_to_main: bool) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let actual = ui(app, |app, core| {
            let main = app.get_webview_window("main").ok_or("Missing main window")?;
            let pet = app.get_webview_window("pet");
            let pet_visible = pet.map(|w| w.is_visible()).transpose().map_err(|e| e.to_string())?.unwrap_or(false);
            let minimized = main.is_minimized().map_err(|e| e.to_string())?;
            let main_visible = main.is_visible().map_err(|e| e.to_string())? && !minimized;
            if main_visible && pet_visible {
                return Err("Home presented the standalone pet over the full chat window".into());
            }
            if core.pet_home_overlay.lock().unwrap().is_some() {
                return Err("Home treated its own chat window as an external overlay target".into());
            }
            if !unsafe { keepwork_startup_smoke_main_intact(main.ns_window().map_err(|e| e.to_string())?) } {
                return Err("Home replaced the chat document".into());
            }
            Ok((main_visible, minimized, pet_visible, core.settings().pet_visible))
        }).await?;
        let (main, minimized, pet, setting) = actual;
        if main == returning_to_main && pet == (enabled && !returning_to_main)
            && (returning_to_main || enabled || minimized) && setting == enabled {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(format!("Unexpected Home presentation: pet enabled={enabled}, restoring={returning_to_main}, state={actual:?}"));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

// Opt-in foreground scenario. Only this isolated application is activated and zoomed.
async fn zoomed_home(app: &AppHandle, fixture: &FixtureState) -> Result<(), String> {
    let entries = fixture.entries.load(Ordering::Relaxed);
    remote_ui(app, |app, _| {
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        main.maximize().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())
    }).await?;
    let until = Instant::now() + Duration::from_secs(4);
    loop {
        if ui(app, |app, _| {
            let main = app.get_webview_window("main").ok_or("Missing main window")?;
            Ok(main.is_focused().map_err(|e| e.to_string())? && main.is_maximized().map_err(|e| e.to_string())?)
        }).await? { break; }
        if Instant::now() >= until { return Err("The isolated zoomed main could not take focus".into()); }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    check_direct_main_composer(app).await?;
    check_focused_composer_back(app).await?;
    for enabled in [true, false, true] {
        remote_ui(app, move |_, core| {
            core.update_settings(|s| s.pet_visible = enabled);
            Ok(())
        }).await?;
        for returning_to_main in [false, true] {
            remote_ui(app, |app, _| {
                main_window::toggle_remote_home(app);
                Ok(())
            }).await?;
            check_home_windows(app, enabled, returning_to_main).await?;
        }
        println!("{}", json!({"case":"zoomed-main-home-exclusive","petEnabled":enabled}));
    }
    remote_ui(app, |app, _| {
        app.get_webview_window("main").ok_or("Missing main window")?
            .set_fullscreen(true).map_err(|e| e.to_string())
    }).await?;
    let until = Instant::now() + Duration::from_secs(6);
    loop {
        if ui(app, |app, _| {
            let main = app.get_webview_window("main").ok_or("Missing main window")?;
            Ok(main.is_fullscreen().map_err(|e| e.to_string())? && main.is_focused().map_err(|e| e.to_string())?)
        }).await? { break; }
        if Instant::now() >= until { return Err("Cannot enter native full-screen chat".into()); }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    remote_ui(app, |app, _| {
        main_window::toggle_remote_home(app);
        Ok(())
    }).await?;
    check_home_windows(app, true, false).await?;
    remote_ui(app, |app, core| {
        main_window::show_main_window(app, core);
        Ok(())
    }).await?;
    check_home_windows(app, true, true).await?;
    println!("{}", json!({"case":"native-fullscreen-home-and-open-exclusive"}));
    if fixture.entries.load(Ordering::Relaxed) != entries { return Err("Home reloaded the retained main document".into()); }
    println!("startup-smoke: OK (real zoomed Tauri main, remote Home dispatch)");
    Ok(())
}

async fn exercise(app: AppHandle, fixture: Arc<FixtureState>, home_overlay: bool) -> Result<(), String> {
    wait_count(&fixture.statuses, 1, "private status IPC").await?;
    wait_count(&fixture.retries, 1, "coalesced private retry IPC").await?;
    wait_view(
        &app,
        "idle-wake-before-begin",
        Phase::Connecting,
        false,
        None,
        8,
    )
    .await?;
    ui(&app, |app, core| {
        let target = main_window::current_entry_url(core);
        let url = target.parse().map_err(|e: url::ParseError| e.to_string())?;
        let generation = core
            .page_connection
            .lock()
            .unwrap()
            .attempt(&url)
            .ok_or("Missing reserved attempt")?;
        main_window::navigate_page_connection(app, core, &target, generation);
        Ok(())
    })
    .await?;
    wait_count(&fixture.entries, 1, "initial private entry").await?;
    wait_view(
        &app,
        "foreground-pending",
        Phase::Connecting,
        false,
        None,
        8,
    )
    .await?;
    loading_stays_hidden(&app, &fixture, "foreground-loading-shell-hidden").await?;
    let styles = fixture.styles_started.load(Ordering::Relaxed);
    fixture.ready.store(true, Ordering::Relaxed);
    wait_count(&fixture.styles_started, styles + 1, "critical first-screen stylesheet request").await?;
    ui(&app, move |app, _| {
        let main = app.get_webview_window("main").ok_or("Missing main window")?;
        if main.is_visible().map_err(|e| e.to_string())? {
            return Err("The first-screen marker exposed an unstyled workspace".into());
        }
        Ok(())
    }).await?;
    if fixture.styles_finished.load(Ordering::Relaxed) != styles {
        return Err("The delayed stylesheet finished before pending-style visibility was observed".into());
    }
    wait_view(&app, "first-screen-marker-awaits-css", Phase::Connecting, false, None, 2).await?;
    wait_view(&app, "foreground-ready", Phase::Ready, true, Some(false), 8).await?;

    if home_overlay { return zoomed_home(&app, &fixture).await; }

    reload(&app, &fixture, false).await?;
    wait_view(
        &app,
        "background-pending",
        Phase::Connecting,
        false,
        None,
        8,
    )
    .await?;
    loading_stays_hidden(&app, &fixture, "background-loading-shell-hidden").await?;
    fixture.ready.store(true, Ordering::Relaxed);
    wait_view(&app, "background-ready", Phase::Ready, false, None, 8).await?;
    check_screenshot_bridge(&app, &fixture, true).await?;
    ui(&app, |app, core| {
        main_window::show_main_window(app, core);
        Ok(())
    })
    .await?;
    wait_view(&app, "background-ready-wake", Phase::Ready, true, Some(false), 8).await?;

    for (action, label) in [(0, "native-close"), (1, "native-escape")] {
        reload(&app, &fixture, true).await?;
        wait_view(
            &app,
            &format!("{label}-pending"),
            Phase::Connecting,
            false,
            None,
            8,
        )
        .await?;
        loading_stays_hidden(&app, &fixture, &format!("{label}-loading-shell-hidden")).await?;
        // Exercise close/Escape on a visible failure surface. These controlled
        // failures avoid repeating a 20-second wait; the actual production
        // timeout is separately exercised below.
        recovery_failure(&app).await?;
        wait_view(
            &app,
            &format!("{label}-recovery-visible"),
            Phase::Unavailable,
            true,
            Some(true),
            8,
        )
        .await?;
        native_action(&app, action).await?;
        wait_view(
            &app,
            &format!("{label}-hidden"),
            Phase::Unavailable,
            false,
            Some(true),
            8,
        )
        .await?;
        // A subsequent background reconnect must preserve that explicit close
        // intent, even when its real document completes successfully later.
        reload(&app, &fixture, false).await?;
        loading_stays_hidden(&app, &fixture, &format!("{label}-background-retry-hidden")).await?;
        fixture.ready.store(true, Ordering::Relaxed);
        wait_view(
            &app,
            &format!("{label}-late-ready"),
            Phase::Ready,
            false,
            None,
            8,
        )
        .await?;
    }

    let statuses = fixture.statuses.load(Ordering::Relaxed);
    reload(&app, &fixture, true).await?;
    let started = Instant::now();
    wait_view(&app, "timeout-pending", Phase::Connecting, false, None, 8).await?;
    loading_stays_hidden(&app, &fixture, "timeout-loading-shell-hidden").await?;
    wait_view(
        &app,
        "real-20-second-failure",
        Phase::Unavailable,
        true,
        Some(true),
        LOAD_TIMEOUT_SECONDS + 6,
    )
    .await?;
    if started.elapsed() < Duration::from_secs(LOAD_TIMEOUT_SECONDS - 1) {
        return Err("The production timeout did not actually elapse".into());
    }
    wait_count(
        &fixture.statuses,
        statuses + 1,
        "hidden recovery after timeout",
    )
    .await?;
    let entries = fixture.entries.load(Ordering::Relaxed);
    native_action(&app, 2).await?;
    wait_count(&fixture.entries, entries + 1, "native retry navigation").await?;
    wait_view(&app, "native-retry-pending", Phase::Connecting, false, None, 8).await?;
    loading_stays_hidden(&app, &fixture, "native-retry-loading-shell-hidden").await?;
    fixture.ready.store(true, Ordering::Relaxed);
    wait_view(&app, "native-retry-ready", Phase::Ready, true, Some(false), 8).await?;
    minimize_to_pet(&app, &fixture).await?;
    dock_reopen(&app, &fixture).await?;
    pet_approval(&app, &fixture).await?;
    check_screenshot_bridge(&app, &fixture, false).await?;
    if fixture.unexpected.load(Ordering::Relaxed) != 0 {
        return Err(
            "Unexpected IPC failure, runtime probe, or network path reached the fixture".into(),
        );
    }
    ui(&app, |_, core| {
        if core.mcp_supervisor.snapshot().state != "stopped"
            || core.local_model_supervisor.snapshot().state != "stopped"
        {
            return Err("A runtime supervisor was started by the isolated UI smoke".into());
        }
        Ok(())
    })
    .await?;
    println!("startup-smoke: OK (real AppKit + WKWebView, private loopback; no shared daemon)");
    Ok(())
}

pub fn run_startup_smoke(profile: PathBuf) -> i32 {
    // create_dir refuses an existing directory, so cleanup can never remove
    // a user-supplied existing profile by accident.
    if let Err(error) = fs::create_dir(&profile) {
        eprintln!("startup-smoke: FAILED to create isolated profile: {error}");
        return 1;
    }
    let _profile = Profile(profile.clone());
    let done = Arc::new(AtomicBool::new(false));
    let watchdog_done = done.clone();
    let watchdog_profile = profile.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(90));
        if !watchdog_done.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(watchdog_profile);
            eprintln!("startup-smoke: FAILED (90-second deadline)");
            std::process::exit(124);
        }
    });
    let result = (|| -> Result<i32, String> {
        let fixture = Fixture::new()?;
        let core = core(&profile, &fixture)?;
        let state = fixture.state.clone();
        let shell = format!("{}/recovery", fixture.origin);
        core.page_connection.lock().unwrap().shell_url =
            Some(shell.parse().map_err(|e: url::ParseError| e.to_string())?);
        let script = include_str!("../../../src/pageConnection.js").replacen(
            "export function",
            "function",
            1,
        );
        let script = format!(
            "(() => {{ {script}\ninstallPageConnection({}, {}); }})();",
            json!(core.page_connection.lock().unwrap().token),
            json!(shell)
        );
        let exit = Arc::new(AtomicI32::new(1));
        let setup_exit = exit.clone();
        let setup_core = core.clone();
        // Allow production pet window creation to use only this private fixture.
        let mut context = tauri::generate_context!(test = true);
        context.config_mut().build.dev_url = Some(fixture.origin.parse().unwrap());
        let home_overlay = std::env::args().any(|arg| arg == "--home-overlay");
        let app = tauri::Builder::default()
            .activate_ignoring_other_apps(home_overlay)
            .enable_macos_default_menu(false)
            .manage(core)
            .manage(super::screenshot::ScreenshotAccess::default())
            .invoke_handler(tauri::generate_handler![
                super::screenshot::desktop_capture_screenshot,
                super::screenshot::desktop_get_screenshot_permission,
                super::screenshot::desktop_set_screenshot_permission,
                pet_host::desktop_publish_pet_state,
                super::pet_approval::desktop_return_to_pet_after_approval,
                super::pet_approval::desktop_reveal_pet_approval,
                main_window::desktop_page_connection_status,
                main_window::desktop_retry_page_connection,
                main_window::desktop_page_connection_attempt,
                main_window::desktop_main_document_ready,
            ])
            .setup(move |app| {
                let handle = app.handle().clone();
                handle.set_activation_policy(if home_overlay { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory })?;
                if !home_overlay && !unsafe { keepwork_startup_smoke_passive_application() } {
                    return Err("Cannot suppress activation for isolated smoke".into());
                }
                let page_core = setup_core.clone();
                let allowed_shell = shell.clone();
                let allowed_entry = main_window::current_entry_url(&setup_core);
                let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(shell.parse()?))
                    .title("Isolated native startup smoke")
                    .inner_size(640.0, 480.0)
                    .visible(false)
                    .focused(false)
                    .incognito(true)
                    .data_directory(profile.join("webview"))
                    .background_throttling(
                        tauri::utils::config::BackgroundThrottlingPolicy::Disabled,
                    )
                    .initialization_script(&script)
                    .on_navigation(move |url| {
                        url.as_str() == allowed_shell || url.as_str() == allowed_entry
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_page_load(move |_, payload| {
                        main_window::handle_main_page_load(
                            payload.event(),
                            &page_core.terminals,
                            &page_core.pet,
                        );
                    })
                    .build()?;
                super::pet_approval::observe_main(&main, Arc::clone(&setup_core));
                main_window::observe_main_minimize(&main)?;
                main.set_focusable(home_overlay)?;
                main.set_ignore_cursor_events(true)?;
                let native = main.ns_window()?;
                if !unsafe { keepwork_startup_smoke_capture_main(native) } {
                    return Err("Cannot capture the fixture's only main window/WebView".into());
                }
                let callback_app = handle.clone();
                let callback_core = setup_core.clone();
                native_startup::install(&handle, tauri::Theme::Light, move |action| match action {
                    native_startup::Action::Retry => {
                        main_window::reload_main_window(&callback_app, &callback_core)
                    }
                    native_startup::Action::Hide => {
                        main_window::hide_main_window(&callback_app, &callback_core)
                    }
                })?;
                let close_app = handle.clone();
                let close_core = setup_core.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        main_window::hide_main_window(&close_app, &close_core);
                    }
                });
                // Wake the idle background instance before reserving its first
                // attempt. Later setup must preserve this foreground intent.
                main_window::show_main_window(&handle, &setup_core);
                {
                    let mut connection = setup_core.page_connection.lock().unwrap();
                    if connection.presentation() != Presentation::Hidden {
                        return Err("Idle wake was lost".into());
                    }
                    connection
                        .begin(&main_window::current_entry_url(&setup_core), false)
                        .ok_or("Cannot reserve attempt")?;
                    if connection.presentation() != Presentation::Hidden {
                        return Err("Begin overwrote foreground intent".into());
                    }
                }
                main_window::sync_window_presentation(&handle, false);
                let test_app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let code = match exercise(test_app.clone(), state, home_overlay).await {
                        Ok(()) => 0,
                        Err(error) => {
                            eprintln!("startup-smoke: FAILED: {error}");
                            1
                        }
                    };
                    setup_exit.store(code, Ordering::Relaxed);
                    test_app
                        .state::<Arc<AppCore>>()
                        .quitting
                        .store(true, Ordering::Relaxed);
                    test_app.exit(code);
                });
                Ok(())
            })
            .build(context)
            .map_err(|e| e.to_string())?;
        let reopen_state = fixture.state.clone();
        let returned = app.run_return(move |app, event| {
            main_window::handle_dock_reopen(app, &event);
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                reopen_state.dock_reopens.fetch_add(1, Ordering::Relaxed);
            }
        });
        let code = exit.load(Ordering::Relaxed);
        Ok(if code == 0 { returned } else { code })
    })();
    done.store(true, Ordering::Relaxed);
    unsafe { keepwork_startup_smoke_restore_application(); }
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("startup-smoke: FAILED: {error}");
            1
        }
    }
}
