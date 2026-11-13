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
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--stop-mcp")) {
        let result = std::env::args_os()
            .nth(2)
            .ok_or_else(|| "Missing installation directory".to_string())
            .and_then(|root| {
                aichat_rust_lib::installer_stop::stop_bundled_mcp(std::path::Path::new(&root))
            });
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    aichat_rust_lib::run();
}
