#[cfg(windows)]
#[path = "src/installer_stop.rs"]
mod installer_stop;

#[path = "build_support/macos_resources.rs"]
mod macos_resources;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let mut native = cc::Build::new();
        if std::env::var_os("CARGO_FEATURE_DEV_BINS").is_some() {
            native.file("src/app/startup_smoke_macos.m");
            println!("cargo:rerun-if-changed=src/app/startup_smoke_macos.m");
        }
        native
            .file("src/navigation_macos.m")
            .file("src/local_mcp_macos.m")
            .file("src/browser_surface_macos.m")
            .file("src/app/native_startup_macos.m")
            .file("src/remote_voice/native_input_macos.m")
            .file("src/remote_voice/buttons_macos.m")
            .file("src/remote_voice/paired_macos.m")
            .flag("-fobjc-arc")
            .compile("keepwork_frame_navigation");
        println!("cargo:rerun-if-changed=src/navigation_macos.m");
        println!("cargo:rerun-if-changed=src/local_mcp_macos.m");
        println!("cargo:rerun-if-changed=src/browser_surface_macos.m");
        println!("cargo:rerun-if-changed=src/app/native_startup_macos.m");
        println!("cargo:rerun-if-changed=src/remote_voice/native_input_macos.m");
        println!("cargo:rerun-if-changed=src/remote_voice/buttons_macos.m");
        println!("cargo:rerun-if-changed=src/remote_voice/paired_macos.m");
    }
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
    // Build scripts run on the host; only the target OS determines which
    // resource-copy workaround applies (including Unix cross-compilation).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
        || std::env::var("PROFILE").as_deref() != Ok("debug")
    {
        tauri_build::try_build(build_attributes()).expect("Tauri build failed");
        return;
    }
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let target = out.ancestors().nth(3).expect("Cargo target directory");
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    );
    let mut guard = macos_resources::ResourceCopyGuard::prepare(
        &manifest.join("resources/mcp-runtime"),
        &target.join("resources/mcp-runtime"),
        &out,
    )
    .unwrap_or_else(|error| panic!("Cannot prepare macOS development MCP resources: {error}"));
    match tauri_build::try_build(build_attributes()) {
        Ok(()) => {
            guard.commit().unwrap_or_else(|error| {
                panic!("Cannot finish macOS development MCP resource copy: {error}")
            });
        }
        Err(error) => {
            guard.rollback().unwrap_or_else(|recovery| {
                panic!("Tauri build failed: {error}; MCP resource recovery failed: {recovery}")
            });
            panic!("Tauri build failed: {error}");
        }
    }
}

// tauri-winres links its resource manifest only into binary targets. Library
// unit tests and integration tests also import Common Controls v6 through Tauri,
// so the Windows loader must see the same manifest before their harness starts.
// Embed it through the MSVC linker for all targets, and omit the resource copy
// to avoid duplicate RT_MANIFEST entries in the packaged application.
fn build_attributes() -> tauri_build::Attributes {
    let attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        return attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    attributes
}
