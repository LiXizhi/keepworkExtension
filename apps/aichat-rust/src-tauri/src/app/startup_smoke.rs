//! Real Tauri/AppKit/WKWebView startup checks, available only in `dev-bins`.
//! Every path and HTTP listener belongs to this fixture. Runtime supervisors
//! are constructed for status snapshots but are never started or checked.

use super::{main_window, native_startup, state::AppCore};
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
        pet_audio: Arc::new(crate::pet_audio::PetAudioRelay::default()),
        remote_voice: Arc::new(crate::remote_voice::RemoteVoice::new(profile)),
        pet_menu: crate::pet_menu::Session::default(),
        dev_server: Mutex::new(None),
        entry_url: Mutex::new(format!("{}/AIChat.html", fixture.origin)),
        local_source_enabled: AtomicBool::new(false),
        zoom: Mutex::new(1.0),
        signed_in: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
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
    fn keepwork_startup_smoke_restore_application();
    fn keepwork_startup_smoke_capture_main(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_main_intact(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_overlay_present(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_overlay_covers(window: *mut std::ffi::c_void) -> bool;
    fn keepwork_startup_smoke_document_focused(window: *mut std::ffi::c_void) -> bool;
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

async fn exercise(app: AppHandle, fixture: Arc<FixtureState>) -> Result<(), String> {
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
        let app = tauri::Builder::default()
            .activate_ignoring_other_apps(false)
            .enable_macos_default_menu(false)
            .manage(core)
            .invoke_handler(tauri::generate_handler![
                main_window::desktop_page_connection_status,
                main_window::desktop_retry_page_connection,
                main_window::desktop_page_connection_attempt,
                main_window::desktop_main_document_ready,
            ])
            .setup(move |app| {
                let handle = app.handle().clone();
                handle.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
                if !unsafe { keepwork_startup_smoke_passive_application() } {
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
                main.set_focusable(false)?;
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
                    let code = match exercise(test_app.clone(), state).await {
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
            .build(tauri::generate_context!(test = true))
            .map_err(|e| e.to_string())?;
        let returned = app.run_return(|_, _| {});
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
