//! Application bootstrap, bundled runtime discovery and event-loop setup.

use super::host_menu::setup_native_menu_and_tray;
use super::main_window::{handle_main_page_load, show_main_window};
use super::pet_audio_host::notify_pet_audio_stopped;
use super::pet_host::{broadcast_pet_state, ensure_pet_window};
use super::platform::open_in_system_browser;
use super::state::{resolve_profile_dir, AppCore};
use super::updates_window::broadcast_update_status;
use super::{commands, main_window, pet_audio_host, pet_host, updates_window};
use crate::bridge::build_main_window_init_script;
use crate::deployment::{resolve_local_aichat_source_dir, startup_deployment};
use crate::desktop_identity::{default_mcp_home, remember_desktop_client};
use crate::desktop_lock::DesktopLock;
use crate::dev_server::DevServer;
use crate::files::NativeFiles;
use crate::login_startup::LoginStartup;
use crate::page_connection::PageConnection;
use crate::permissions::MediaGrants;
use crate::pet::PetController;
use crate::runtime::{
    current_runtime_arch, current_runtime_platform, mcp_feed_platform, RuntimeConfig,
    RuntimeSupervisor, DEFAULT_MCP_FEED_BASE, LOCAL_MODEL_PORT, MCP_PORT,
};
use crate::security::{allowed_in_app_popup, allowed_navigation, ENTRY};
use crate::terminal::TerminalSessionManager;
use crate::tray_channels::{channel_states, describe, fetch_tray_channels};
use crate::updates::{default_desktop_feed_url, UpdateManager};
use crate::APP_VERSION;
use crate::{pet_audio, pet_menu};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(target_os = "windows")]
use tauri::image::Image;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

fn local_source_startup_warning(error: &str, fallback_entry: &str) -> String {
    let origin = url::Url::parse(fallback_entry)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "配置的备用页面".to_string());
    format!(
        "本地源码服务未启动，已打开配置的备用页面（{origin}）。此页面与本地页面地址不同，原本地记录未搬迁。\n\n原因：{error}\n\n请检查源码目录或处理端口冲突后，通过“使用本地源码服务器…”重试。"
    )
}

/// Products this desktop can launch: the packaged Node runtime and the native
/// Rust daemon (v2 manifest, `engine: "rust"`).
const MCP_PRODUCT_NODE: &str = "keepwork-mcp-node-runtime";
const MCP_PRODUCT_RUST: &str = "keepwork-mcp-runtime";
const LOCAL_MODEL_PRODUCT: &str = "keepwork-local-model-node-runtime";

fn valid_mcp_runtime(dir: &Path, products: &[&str]) -> bool {
    crate::runtime::validate_runtime_dir_any(dir, products).is_ok()
}

/// Reuse the MCP runtime installed by DesktopLauncher when the app bundle does
/// not carry one (A+C bootstrap: bundled > launcher > CDN).
fn launcher_mcp_runtime(products: &[&str]) -> Option<PathBuf> {
    let releases = dirs::data_local_dir()?
        .join("Keepwork")
        .join("DesktopLauncher")
        .join("releases");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(releases).ok()? {
        let Ok(entry) = entry else { continue };
        let dir = entry.path().join("mcp");
        if !valid_mcp_runtime(&dir, products) {
            continue;
        }
        let modified = std::fs::metadata(dir.join("runtime.json"))
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(time, _)| modified > *time) {
            best = Some((modified, dir));
        }
    }
    best.map(|(_, dir)| dir)
}

fn resolve_bundled_mcp_dir(resource_base: &Path, products: &[&str]) -> PathBuf {
    let arch = crate::runtime::current_runtime_arch();
    let roots = [
        resource_base.join("..").join("Resources"),
        resource_base.join("..").join("Resources").join("resources"),
        resource_base.join("resources"),
        resource_base.join("../..").join("resources"),
        resource_base.join("../../..").join("resources"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
    ];
    let mut legacy = None;
    for root in roots {
        // scripts/bundle-mcp-runtime.cjs lays the app's own server out per slice,
        // so a universal macOS build can carry both arm64 and x64 runtimes.
        let per_arch = root.join("mcp-runtime").join(arch);
        if valid_mcp_runtime(&per_arch, products) {
            return per_arch;
        }
        let flat = root.join("mcp-runtime");
        if legacy.is_none() && valid_mcp_runtime(&flat, products) {
            legacy = Some(flat);
        }
    }
    legacy
        .or_else(|| launcher_mcp_runtime(products))
        .unwrap_or_else(|| {
            resource_base
                .join("resources")
                .join("mcp-runtime")
                .join(arch)
        })
}

pub fn run() {
    let packaged = !cfg!(debug_assertions);
    let background_launch = std::env::args().any(|a| a == "--background");
    let replace_existing = std::env::var("AICHAT_DESKTOP_REPLACE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let profile_dir = resolve_profile_dir(packaged);
    let _ = std::fs::create_dir_all(&profile_dir);

    let mcp_home = default_mcp_home();
    let _ = std::fs::create_dir_all(&mcp_home);

    if let Ok(exe) = std::env::current_exe() {
        let _ = remember_desktop_client(&mcp_home, APP_VERSION, &exe, packaged);
    }

    let settings_path = profile_dir.join("settings.json");
    let grants_path = profile_dir.join("folder-grants.json");
    let media_grants_path = profile_dir.join("media-grants.json");
    let pet_prefs_path = profile_dir.join("pet-preferences.json");
    let update_meta_path = profile_dir.join("update-metadata.json");
    let desktop_updates_dir = profile_dir.join("desktop-updates");
    let terminal_workspaces_dir = profile_dir.join("terminal-workspaces");
    let mcp_runtimes_dir = profile_dir.join("mcp-runtimes");
    let local_model_runtimes_dir = profile_dir.join("local-model-runtimes");

    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("aichat-rust"));
    let resource_base = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| profile_dir.clone());

    let bundled_mcp_dir = std::env::var("AICHAT_MCP_BUNDLED_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_RUST, MCP_PRODUCT_NODE])
        });
    // The published feed still carries Node runtimes; a Rust build must not
    // download a Node runtime over itself.
    let bundled_mcp_is_rust =
        crate::runtime::validate_runtime_dir(&bundled_mcp_dir, MCP_PRODUCT_RUST).is_ok();
    let bundled_local_model_dir = std::env::var("AICHAT_LOCAL_MODEL_BUNDLED_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| resource_base.join("resources").join("local-model-runtime"));

    let mcp_feed_url = std::env::var("AICHAT_MCP_FEED_URL").unwrap_or_else(|_| {
        format!(
            "{DEFAULT_MCP_FEED_BASE}/{}-{}.json",
            mcp_feed_platform(),
            current_runtime_arch()
        )
    });

    let mcp_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "mcp".to_string(),
        products: if bundled_mcp_is_rust {
            vec![MCP_PRODUCT_RUST.to_string()]
        } else {
            vec![MCP_PRODUCT_NODE.to_string(), MCP_PRODUCT_RUST.to_string()]
        },
        port: MCP_PORT,
        health_path: "/health".to_string(),
        updates_enabled: !bundled_mcp_is_rust,
        bundled_dir: bundled_mcp_dir,
        store_dir: mcp_runtimes_dir,
        feed_url: mcp_feed_url,
    }));

    let local_model_supervisor = Arc::new(RuntimeSupervisor::new(RuntimeConfig {
        id: "local-model".to_string(),
        products: vec![LOCAL_MODEL_PRODUCT.to_string()],
        port: LOCAL_MODEL_PORT,
        health_path: "/v1/health".to_string(),
        updates_enabled: false,
        bundled_dir: bundled_local_model_dir,
        store_dir: local_model_runtimes_dir,
        feed_url: String::new(),
    }));

    let updates = Arc::new(UpdateManager::new(
        APP_VERSION.to_string(),
        update_meta_path,
        desktop_updates_dir,
        default_desktop_feed_url(),
        None,
    ));

    let launch_agents_dir = dirs::home_dir()
        .unwrap_or_else(|| profile_dir.clone())
        .join("Library")
        .join("LaunchAgents");
    let login_exe = {
        #[cfg(windows)]
        {
            let launcher = exe_path.with_file_name("Keepwork.exe");
            if packaged && launcher.is_file() {
                launcher
            } else {
                exe_path
            }
        }
        #[cfg(not(windows))]
        {
            exe_path
        }
    };
    let login_startup = LoginStartup::new(
        settings_path.clone(),
        launch_agents_dir,
        login_exe,
        packaged,
    );
    let _ = login_startup.ensure_default();

    let mut initial_entry = std::env::var("AICHAT_DESKTOP_DEV_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| ENTRY.to_string());
    let mut initial_dev_srv: Option<DevServer> = None;
    let mut initial_local_source = false;
    let mut initial_local_source_error = None;

    if std::env::var("AICHAT_DESKTOP_LOCAL_SOURCE").ok().as_deref() == Some("1") {
        if let Some(src_dir) = resolve_local_aichat_source_dir() {
            match DevServer::start(
                &src_dir,
                "AIChat.html",
                &profile_dir.join("source-ports.json"),
            ) {
                Ok(srv) => {
                    initial_entry = srv.url();
                    eprintln!(
                        "[desktop] Local AIChat source: {} -> {initial_entry}",
                        src_dir.display()
                    );
                    initial_dev_srv = Some(srv);
                    initial_local_source = true;
                }
                Err(error) => {
                    initial_local_source_error = Some(format!(
                        "Cannot start local AIChat source at {}: {error}",
                        src_dir.display()
                    ));
                }
            }
        } else {
            initial_local_source_error = Some("找不到包含 AIChat.html 的本地源码目录。请设置 AICHAT_DESKTOP_SOURCE_DIR（或 AICHAT_SOURCE_DIR）。".to_string());
        }
    } else {
        (initial_entry, initial_dev_srv) = startup_deployment(
            &profile_dir.join("deployment.json"),
            &initial_entry,
            |error| eprintln!("[desktop] {error}"),
        );
    }
    if let Some(error) = initial_local_source_error.as_deref() {
        eprintln!(
            "[desktop] {}",
            local_source_startup_warning(error, &initial_entry)
        );
    }

    let core = Arc::new(AppCore {
        profile_dir: profile_dir.clone(),
        settings_path,
        mcp_home,
        files: NativeFiles::new(grants_path),
        terminals: TerminalSessionManager::new(terminal_workspaces_dir),
        media_grants: MediaGrants::new(media_grants_path),
        login_startup,
        mcp_supervisor,
        local_model_supervisor,
        updates,
        pet: Arc::new(PetController::new(pet_prefs_path)),
        pet_audio: Arc::new(pet_audio::PetAudioRelay::default()),
        pet_menu: pet_menu::Session::default(),
        dev_server: Mutex::new(initial_dev_srv),
        entry_url: Mutex::new(initial_entry),
        local_source_enabled: AtomicBool::new(initial_local_source),
        zoom: Mutex::new(1.0),
        signed_in: AtomicBool::new(true),
        quitting: AtomicBool::new(false),
        channels: Mutex::new(channel_states(&Value::Null)),
        lock: Mutex::new(None),
        page_connection: Mutex::new(PageConnection::default()),
    });

    let icon_b64 = base64::engine::general_purpose::STANDARD
        .encode(include_bytes!("../../icons/keepwork.png"));
    let icon_data_url = format!("data:image/png;base64,{icon_b64}");
    let init_script = build_main_window_init_script(current_runtime_platform(), &icon_data_url);

    let core_for_setup = Arc::clone(&core);
    #[cfg(windows)]
    let webview_failed = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let webview_failed_in_setup = Arc::clone(&webview_failed);

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::clone(&core))
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Acquire single-instance lock
            let lock_file = core_for_setup.profile_dir.join("desktop-instance.json");
            let app_for_lock = app_handle.clone();
            let core_for_lock = Arc::clone(&core_for_setup);
            match DesktopLock::acquire(
                lock_file,
                background_launch,
                replace_existing,
                move |should_exit| {
                    if should_exit {
                        core_for_lock.quitting.store(true, Ordering::Relaxed);
                        app_for_lock.exit(0);
                    } else {
                        show_main_window(&app_for_lock, &core_for_lock);
                    }
                },
            ) {
                Ok(Some(lock)) => {
                    if let Ok(mut guard) = core_for_setup.lock.lock() {
                        *guard = Some(lock);
                    }
                }
                Ok(None) => {
                    // Another instance is already running and was notified
                    std::process::exit(0);
                }
                Err(_) => {}
            }

            // Bring the MCP daemon up before the webview's first /health probe.
            // One attempt here so startup stays short. A Rust MCP that fails is
            // retried by the 60s heartbeat below, at most five times. A missing
            // runtime still fails this call; the update checker stages one for
            // a later launch. Runs after the single-instance lock so a second
            // launch does not start a daemon before exiting.
            let _ = tauri::async_runtime::block_on(
                core_for_setup.mcp_supervisor.ensure_started(true),
            );

            let _ = setup_native_menu_and_tray(&app_handle, &core_for_setup);

            // Configure main window navigation guard, close-to-tray, and initialization script
            let entry_target = core_for_setup
                .entry_url
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| ENTRY.to_string());

            let core_for_nav = Arc::clone(&core_for_setup);
            let core_for_page_load = Arc::clone(&core_for_setup);
            let core_for_popup = Arc::clone(&core_for_setup);
            // Use the same WebView/storage for the local connection UI and chat.
            // The local page initiates the first attempt after it has rendered.
            let shell_url = if tauri::is_dev() {
                app.config().build.dev_url.clone()
            } else { None }.unwrap_or_else(|| {
                if cfg!(target_os = "windows") { "http://tauri.localhost/" } else { "tauri://localhost/" }.parse().unwrap()
            });
            let connection_script = {
                let mut connection = core_for_setup.page_connection.lock().unwrap();
                connection.shell_url = Some(shell_url.clone());
                let script = include_str!("../../../src/pageConnection.js").replacen("export function", "function", 1);
                format!("{script}\ninstallPageConnection({}, {});", json!(connection.token), json!(shell_url.as_str()))
            };
            let mut main_builder = WebviewWindowBuilder::new(
                app,
                "main",
                // Keep the requested URL identical to the script/native shell
                // identity; App("index.html") strips '/' on custom schemes.
                WebviewUrl::External(shell_url.clone()),
            )
            .title("KeepWork 第二大脑")
            .inner_size(1360.0, 900.0)
            .min_inner_size(640.0, 480.0)
            .resizable(true)
            .visible(!background_launch)
            .initialization_script(&connection_script)
            .initialization_script(&init_script)
            .on_navigation(move |nav_url| {
                let dev_url = core_for_nav.current_dev_url();
                let url_str = nav_url.as_str();
                if core_for_nav.page_connection.lock().unwrap().is_shell(nav_url) || allowed_navigation(url_str, dev_url.as_deref()) {
                    return true;
                }
                if let Err(err) = open_in_system_browser(url_str) {
                    eprintln!("open external navigation failed: {err}");
                }
                false
            })
            .on_page_load(move |window, payload| {
                // on_navigation also sees iframe navigations. Only a committed
                // main document replaces the owner of pet commands and PTYs.
                // Finished can arrive after the new page has published its pet
                // snapshot, so it must leave that state intact.
                if payload.event() == PageLoadEvent::Started {
                    if let Some(identity) = core_for_page_load.pet_audio.reset_page() {
                        notify_pet_audio_stopped(window.app_handle(), identity, "录音页面已重新加载", false);
                    }
                }
                if handle_main_page_load(
                    payload.event(),
                    &core_for_page_load.terminals,
                    &core_for_page_load.pet,
                ) {
                    broadcast_pet_state(window.app_handle(), &core_for_page_load);
                }
            })
            .on_new_window(move |url, _features| {
                let dev_url = core_for_popup.current_dev_url();
                if allowed_in_app_popup(url.as_str(), dev_url.as_deref()) {
                    // Login popups (Google / Feishu / DingTalk) need window.opener
                    // and the /sso callback to complete inside the app.
                    NewWindowResponse::Allow
                } else {
                    if let Err(err) = open_in_system_browser(url.as_str()) {
                        eprintln!("open external window failed: {err}");
                    }
                    NewWindowResponse::Deny
                }
            });

            #[cfg(target_os = "macos")]
            {
                main_builder = main_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(target_os = "windows")]
            {
                main_builder = main_builder.decorations(false)
                    .icon(Image::from_bytes(include_bytes!("../../icons/titlebar-k.png"))?)?;
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                main_builder = main_builder.decorations(false);
            }

            let main_win = main_builder.build();
            #[cfg(windows)]
            let main_win = main_win.map_err(|error| {
                webview_failed_in_setup.store(true, Ordering::Relaxed);
                error
            });
            let main_win = main_win?;
            #[cfg(windows)]
            signal_launcher_webview_ready();

            if let Some(error) = initial_local_source_error.take() {
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                app_handle.dialog()
                    .message(local_source_startup_warning(&error, &entry_target))
                    .title("本地源码服务未启动")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }

            let app_for_close = app_handle.clone();
            let core_for_close = Arc::clone(&core_for_setup);
            main_win.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    if let Some(identity) = core_for_close.pet_audio.reset_page() {
                        notify_pet_audio_stopped(&app_for_close, identity, "录音页面已关闭", false);
                    }
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !core_for_close.quitting.load(Ordering::Relaxed) {
                        api.prevent_close();
                        if let Some(w) = app_for_close.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        if core_for_close.settings().pet_visible {
                            ensure_pet_window(&app_for_close, &core_for_close, true);
                        }
                    }
                }
            });

            // Background runtime supervisor & self-update scheduler
            let app_bg = app_handle.clone();
            let core_bg = Arc::clone(&core_for_setup);
            tauri::async_runtime::spawn(async move {
                // Start Keepwork MCP (:8089) first, promoting any pending update on startup
                let _ = core_bg.mcp_supervisor.ensure_started(true).await;
                let _ = core_bg.local_model_supervisor.ensure_started(false).await;
                broadcast_update_status(&app_bg, &core_bg);

                // Initial update check after 15s, then every 6 hours
                let app_upd = app_bg.clone();
                let core_upd = Arc::clone(&core_bg);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    loop {
                        let (_snap, newly_staged) =
                            core_upd.updates.check_all(&core_upd.mcp_supervisor).await;
                        if newly_staged {
                            use tauri_plugin_notification::NotificationExt;
                            let _ = app_upd
                                .notification()
                                .builder()
                                .title("Keepwork MCP 更新已就绪")
                                .body("本地 MCP 服务新版本已下载完成，可在「检查更新」窗口或下次重启后生效。")
                                .show();
                        }
                        broadcast_update_status(&app_upd, &core_upd);
                        tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                    }
                });

                // 60s heartbeat for runtimes and tray channel status.
                // This is also the Rust MCP retry timer: a failed launch waits
                // one minute and stops after five attempts.
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let _ = core_bg.mcp_supervisor.ensure_started(false).await;
                    let _ = core_bg.local_model_supervisor.ensure_started(false).await;
                    let channels = fetch_tray_channels(MCP_PORT, &core_bg.mcp_home).await;
                    if let Ok(mut guard) = core_bg.channels.lock() {
                        *guard = channels.clone();
                    }
                    let signed_in = core_bg.signed_in.load(Ordering::Relaxed);
                    let main_vis = app_bg
                        .get_webview_window("main")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(false);
                    let summary = describe(&channels, signed_in, main_vis);
                    if let Some(tray) = app_bg.tray_by_id("main-tray") {
                        let _ = tray.set_tooltip(Some(&summary.tooltip));
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            main_window::desktop_page_connection_status,
            main_window::desktop_retry_page_connection,
            main_window::desktop_page_connection_attempt,
            main_window::desktop_main_document_ready,
            commands::desktop_report_startup_signin,
            pet_host::desktop_publish_pet_state,
            pet_host::desktop_pet_result,
            pet_audio_host::desktop_pet_audio,
            pet_audio_host::desktop_pet_audio_event,
            commands::desktop_check_git,
            commands::desktop_install_git,
            commands::desktop_roots,
            commands::desktop_pick_folder,
            commands::desktop_default_brain_folder,
            commands::desktop_revoke_folder,
            commands::desktop_file,
            commands::desktop_terminal,
            commands::desktop_status,
            updates_window::desktop_check_updates,
            updates_window::desktop_install_update,
            commands::desktop_run_menu_command,
            commands::desktop_open_menu,
            commands::desktop_titlebar_action,
            commands::desktop_sync_theme,
            pet_host::desktop_pet_action,
            updates_window::updates_window_status,
            updates_window::updates_window_check,
            updates_window::updates_window_apply_mcp,
            updates_window::updates_window_apply_desktop,
        ])
        .run(tauri::generate_context!());
    #[cfg(windows)]
    if let Err(error) = result {
        eprintln!("error while running KeepWork 第二大脑 (aichat-rust): {error}");
        // Only window initialization failure authorizes the native launcher's one-time CEF fallback.
        // Page/network failures and arbitrary process crashes never use this exit code.
        std::process::exit(if webview_failed.load(Ordering::Relaxed) {
            86
        } else {
            2
        });
    }
    #[cfg(not(windows))]
    finish_tauri_run(result);
}

#[cfg(not(windows))]
fn finish_tauri_run(result: tauri::Result<()>) {
    // The CEF launcher exit protocol applies only to Windows. Preserve the
    // original failure message and panic unwinding on native WebView platforms.
    result.expect("error while running KeepWork 第二大脑 (aichat-rust)");
}

#[cfg(windows)]
fn signal_launcher_webview_ready() {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
        let mut args = std::env::args_os();
        let event = args
            .find(|arg| arg == "--webview-ready-event")
            .and_then(|_| args.next());
        if let Some(event) = event {
            if !event
                .to_string_lossy()
                .starts_with("Local\\Keepwork.WebView.Ready.")
            {
                return;
            }
            let name: Vec<u16> = event.encode_wide().chain(Some(0)).collect();
            unsafe {
                let handle = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
                if !handle.is_null() {
                    SetEvent(handle);
                    CloseHandle(handle);
                }
            }
        }
    }
}

#[cfg(all(test, not(windows)))]
mod native_startup_tests {
    #[test]
    fn successful_event_loop_returns_normally() {
        super::finish_tauri_run(Ok(()));
    }

    #[test]
    fn startup_failure_preserves_panic_and_unwinds_local_resources() {
        use std::cell::Cell;
        use std::panic::{catch_unwind, AssertUnwindSafe};

        struct Cleanup<'a>(&'a Cell<bool>);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.0.set(true);
            }
        }

        let cleaned_up = Cell::new(false);
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _cleanup = Cleanup(&cleaned_up);
            super::finish_tauri_run(Err(tauri::Error::AssetNotFound(
                "controlled-startup-failure".to_string(),
            )));
        }))
        .expect_err("native startup errors must unwind rather than exit the process");
        assert!(cleaned_up.get());
        let message = panic.downcast_ref::<String>().expect("panic message");
        assert!(message.starts_with("error while running KeepWork 第二大脑 (aichat-rust)"));
        assert!(message.contains("controlled-startup-failure"));
    }
}

#[cfg(test)]
mod local_source_startup_tests {
    #[test]
    fn fallback_notice_keeps_failure_details_without_exposing_url_credentials() {
        let error = "Cannot reuse saved local source address 127.0.0.1:3001: Address in use";
        let notice = super::local_source_startup_warning(
            error,
            "https://user:secret@keepwork.com/chat?token=private-token#private-fragment",
        );
        assert!(notice.contains(error));
        assert!(notice.contains("https://keepwork.com"));
        assert!(notice.contains("地址不同"));
        assert!(notice.contains("原本地记录未搬迁"));
        assert!(notice.contains("重试"));
        for secret in ["user", "secret", "private-token", "private-fragment"] {
            assert!(!notice.contains(secret));
        }
    }
}

#[cfg(test)]
mod bundled_runtime_tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn write_runtime(dir: &Path) {
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::write(dir.join("bin").join("node"), b"#!/bin/sh\n").unwrap();
        fs::write(dir.join("dist").join("cli.cjs"), b"// mcp\n").unwrap();
        fs::write(
            dir.join("runtime.json"),
            r#"{"product":"keepwork-mcp-node-runtime","platform":"darwin","arch":"arm64","version":"0.1.45","commit":"0123456789abcdef0123456789abcdef01234567","node":"bin/node","entry":"dist/cli.cjs"}"#,
        )
        .unwrap();
    }

    #[test]
    fn bundled_runtime_is_resolved_per_architecture() {
        let resource_base =
            std::env::temp_dir().join(format!("aichat-rust-bundle-{}", Uuid::new_v4()));
        let arch = crate::runtime::current_runtime_arch();
        let per_arch = resource_base
            .join("resources")
            .join("mcp-runtime")
            .join(arch);
        let legacy = resource_base.join("resources").join("mcp-runtime");
        write_runtime(&per_arch);
        write_runtime(&legacy);
        crate::runtime::validate_runtime_dir(&per_arch, "keepwork-mcp-node-runtime")
            .expect("fixture runtime must validate");

        assert_eq!(
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_NODE]),
            per_arch,
            "the slice bundled by scripts/bundle-mcp-runtime.cjs must win over a flat runtime"
        );
        fs::remove_dir_all(&resource_base).unwrap();
    }

    #[test]
    fn flat_bundled_runtime_still_works_for_older_layouts() {
        let resource_base =
            std::env::temp_dir().join(format!("aichat-rust-flat-{}", Uuid::new_v4()));
        let legacy = resource_base.join("resources").join("mcp-runtime");
        write_runtime(&legacy);

        assert_eq!(
            resolve_bundled_mcp_dir(&resource_base, &[MCP_PRODUCT_NODE]),
            legacy
        );
        fs::remove_dir_all(&resource_base).unwrap();
    }
}
