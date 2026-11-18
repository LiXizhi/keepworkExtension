#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--launch-url")) {
        // Protocol arguments are untrusted. Reject extra argv instead of letting
        // a quote in %1 inject profile, startup or installer helper options.
        if aichat_rust_lib::launch_intents::protocol_launch_action(std::env::args_os().skip(2))
            .is_none()
        {
            eprintln!("Invalid Keepwork launch URL");
            std::process::exit(2);
        }
    }
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    let helper = args.first().and_then(|v| v.to_str());
    if matches!(
        helper,
        Some("--stop-mcp" | "--wait-for-desktop" | "--check-desktop-stopped" | "--stop-desktop")
    ) {
        let error_file = if args.len() >= 3 && args[args.len() - 2] == "--error-file" {
            let path = args.pop();
            args.pop();
            path
        } else {
            None
        };
        let helper = args.first().and_then(|v| v.to_str());
        let result = match (helper, args.as_slice()) {
            (Some("--stop-mcp"), [_, root]) => {
                aichat_rust_lib::installer_stop::stop_bundled_mcp(std::path::Path::new(root))
            }
            (Some("--check-desktop-stopped"), [_, exe]) => {
                aichat_rust_lib::installer_stop::check_desktop_stopped(std::path::Path::new(exe))
            }
            (Some("--stop-desktop"), [_, exe]) => {
                aichat_rust_lib::installer_stop::stop_desktop(std::path::Path::new(exe))
            }
            (Some("--wait-for-desktop"), [_, identity, exe]) => identity
                .to_str()
                .ok_or_else(|| "更新父进程身份无效".to_string())
                .and_then(|identity| {
                    aichat_rust_lib::installer_stop::wait_for_desktop(
                        identity,
                        std::path::Path::new(exe),
                    )
                }),
            _ => Err("安装辅助程序参数无效".into()),
        };
        if let Err(error) = result {
            if let Some(path) = error_file {
                if let Err(report_error) = aichat_rust_lib::installer_stop::write_error_file(
                    std::path::Path::new(&path),
                    &error,
                ) {
                    eprintln!("无法保存安装错误详情：{report_error}");
                }
            }
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    aichat_rust_lib::run();
}
