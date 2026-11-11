#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
