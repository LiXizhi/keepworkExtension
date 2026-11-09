use aichat_rust_lib::{
    brain_folder::default_brain_folder,
    bridge::build_main_window_init_script,
    desktop_identity::{read_desktop_client, remember_desktop_client},
    desktop_lock::DesktopLock,
    dev_server::DevServer,
    files::NativeFiles,
    git_setup::check_git_with,
    login_startup::LoginStartup,
    menu::{is_allowed_host_command, menu_payload, MenuContextState},
    permissions::MediaGrants,
    security::{
        allowed_in_app_popup, allowed_navigation, assert_sender, external_url, trusted_page, ENTRY,
    },
    tray_channels::{channel_states, describe},
};
use serde_json::json;
use std::fs;
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let root = std::env::temp_dir().join(format!("aichat-rust-desktop-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    // 1. Security & sender assertions
    assert!(trusted_page(ENTRY, None));
    assert!(!trusted_page("https://evil.example/chat", None));
    assert!(allowed_navigation(
        "https://keepwork.com/api/raw/official/apps/tools/AIChat/tools/calendar/calendar.html",
        None
    ));
    assert!(allowed_navigation(
        "https://open.weixin.qq.com/connect/qrconnect?appid=wxc97e44ce7c18725e",
        None
    ));
    assert!(allowed_navigation(
        "https://cdn.keepwork.com/apps/aichat/release/d29b1ecb4622/tools/calendar/calendar.html?locale=zh-CN&host=aichat&token=eyJ.demo",
        None
    ));
    assert!(!allowed_navigation("https://cdn.keepwork.com.evil.com/x", None));
    assert!(!allowed_navigation("https://evilkeepwork.com/x", None));
    assert!(!allowed_navigation("http://cdn.keepwork.com/x", None));
    assert!(!allowed_navigation("https://evil.example/chat", None));
    assert!(allowed_in_app_popup(
        "https://accounts.google.com/o/oauth2/v2/auth",
        None
    ));
    assert!(allowed_in_app_popup(
        "https://login.dingtalk.com/oauth2/auth",
        None
    ));
    assert!(!allowed_in_app_popup("https://evil.example/oauth", None));
    assert!(assert_sender("main", "main", true, ENTRY, None).is_ok());
    assert!(assert_sender("main", "main", false, ENTRY, None).is_err());
    assert_eq!(
        external_url("https://keepwork.com/docs"),
        Some("https://keepwork.com/docs".to_string())
    );

    // 2. Folder grants, workspace file ops, and default brain folder
    let files = NativeFiles::new(root.join("folder-grants.json"));
    let docs_dir = root.join("Documents");
    let preview = default_brain_folder(&files, &docs_dir, false).unwrap();
    assert!(!preview.exists);
    let prepared = default_brain_folder(&files, &docs_dir, true).unwrap();
    let root_id = prepared.id.unwrap();

    files
        .handle(
            "write",
            &json!({ "rootId": root_id, "path": "notes/test.md", "content": "Hello Rust Desktop" }),
        )
        .unwrap();
    let read_back = files
        .handle("read", &json!({ "rootId": root_id, "path": "notes/test.md" }))
        .unwrap();
    assert_eq!(read_back["content"], "Hello Rust Desktop");

    // 3. Media grants
    let media = MediaGrants::new(root.join("media-grants.json"));
    assert!(media.request_with_prompt(
        true,
        ENTRY,
        None,
        &["audio", "clipboard-sanitized-write"],
        |_, _| true,
        || {}
    ));
    assert!(media.is_granted(ENTRY, None, "microphone"));

    // 4. Git detection, login startup, and desktop identity
    let git_status = check_git_with(|_, _| Ok("git version 2.46.0\n".to_string()), "darwin");
    assert!(git_status.installed);
    assert_eq!(git_status.version, "2.46.0");

    let fake_exe = root.join("Keepwork");
    fs::write(&fake_exe, "exe").unwrap();
    let startup = LoginStartup::new(
        root.join("settings.json"),
        root.join("LaunchAgents"),
        fake_exe.clone(),
        true,
    );
    assert!(startup.ensure_default());

    let mcp_home = root.join(".keepwork-mcp");
    remember_desktop_client(&mcp_home, "0.2.0", &fake_exe, true).unwrap();
    assert_eq!(read_desktop_client(&mcp_home).unwrap().version, "0.2.0");

    // 5. DevServer, DesktopLock, Menu, Tray, and Bridge script
    let aichat_src = root.join("aichat_src");
    fs::create_dir_all(&aichat_src).unwrap();
    fs::write(aichat_src.join("AIChat.html"), "<html>AIChat</html>").unwrap();
    let mut dev_srv = DevServer::start(&aichat_src, "AIChat.html").unwrap();
    let resp = reqwest::get(dev_srv.url()).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    dev_srv.stop();

    let mut lock = DesktopLock::acquire(root.join("instance.lock.json"), false, false, |_| {})
        .unwrap()
        .unwrap();
    assert!(lock.wake_port() > 0);
    lock.release();

    assert!(is_allowed_host_command("check-updates"));
    assert!(is_allowed_host_command("help:check-updates"));
    let menu = menu_payload(
        "help",
        &MenuContextState {
            local_source_available: true,
            local_source_enabled: false,
            pet_visible: true,
            open_at_login: true,
            mcp_state: "running".to_string(),
            mcp_owner: "desktop".to_string(),
            mcp_error: String::new(),
            mcp_version: "0.2.88".to_string(),
            desktop_version: "0.2.2".to_string(),
            entry_url: ENTRY.to_string(),
            update_label: "桌面更新：idle".to_string(),
            update_error: String::new(),
        },
    )
    .unwrap();
    assert_eq!(menu["menuId"], "help");
    assert_eq!(menu["menu"]["id"], "help");
    assert_eq!(menu["items"], menu["menu"]["items"]);

    let tray_summary = describe(&channel_states(&json!({})), false, false);
    assert!(tray_summary.attention);

    let script = build_main_window_init_script("darwin", "data:image/png;base64,AA==");
    assert!(script.contains("window.aichatDesktop"));
    assert!(script.contains("keepwork-desktop-input-guard"));
    assert!(script.contains("contextmenu"));

    let _ = fs::remove_dir_all(&root);
    println!("desktop-smoke: OK");
}
