#[cfg(target_os = "macos")]
fn main() {
    let profile = std::env::args()
        .find_map(|arg| {
            arg.strip_prefix("--profile-dir=")
                .map(std::path::PathBuf::from)
        })
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("keepwork-startup-smoke-{}", uuid::Uuid::new_v4()))
        });
    std::process::exit(aichat_rust_lib::run_startup_smoke(profile));
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("startup-smoke: SKIP (real AppKit/WKWebView fixture requires macOS)");
    std::process::exit(77);
}
