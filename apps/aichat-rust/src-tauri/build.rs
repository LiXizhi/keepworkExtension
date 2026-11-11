#[cfg(windows)]
#[path = "src/installer_stop.rs"]
mod installer_stop;

fn main() {
    #[cfg(windows)]
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        // Tauri copies bundled resources next to the executable. A detached
        // development MCP can outlive the desktop and lock that destination.
        // Reuse native handle-based ownership checks, scoped to this build's
        // MCP resources; never stop a daemon merely because it owns port 8089.
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
        let target = out.ancestors().nth(3).expect("Cargo target directory");
        let runtime = target.join("resources/mcp-runtime");
        installer_stop::stop_bundled_mcp(&runtime).unwrap_or_else(|error| {
            panic!(
                "Cannot release development MCP resources at {}: {error}",
                runtime.display()
            )
        });
    }
    tauri_build::build()
}
