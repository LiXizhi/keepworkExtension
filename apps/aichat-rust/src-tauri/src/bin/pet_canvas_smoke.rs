//! Isolated native window geometry check. No AIChat page, account, microphone,
//! MCP runtime, user window, cursor movement, or persisted application state.
use aichat_rust_lib::{pet::WorkArea, pet_canvas::sync_pet_canvas};
use serde_json::json;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    LogicalPosition, LogicalSize, Position, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

fn logical_geometry(monitor: &tauri::Monitor) -> WorkArea {
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    WorkArea {
        x: position.x.round() as i32,
        y: position.y.round() as i32,
        width: size.width.round() as i32,
        height: size.height.round() as i32,
    }
}

fn check_geometry(window: &WebviewWindow, expected: WorkArea, scale: f64) -> Result<(), String> {
    let actual_scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(actual_scale);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(actual_scale);
    let current = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(logical_geometry);
    println!(
        "{}",
        json!({"expected":expected,"actual":{
        "x":position.x,"y":position.y,"width":size.width,"height":size.height,
        "scale":actual_scale,"monitor":current},"expectedScale":scale})
    );
    let close = |a: f64, b: i32| (a - b as f64).abs() <= 0.5;
    if !close(position.x, expected.x)
        || !close(position.y, expected.y)
        || !close(size.width, expected.width)
        || !close(size.height, expected.height)
        || (actual_scale - scale).abs() > 0.01
        || current != Some(expected)
    {
        return Err("Native pet canvas did not land at the requested monitor bounds".to_string());
    }
    if window.is_visible().map_err(|error| error.to_string())? {
        return Err("The isolated test window must remain hidden".to_string());
    }
    Ok(())
}

fn main() {
    let baseline = std::env::args().any(|arg| arg == "--baseline");
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(20));
        eprintln!("pet-canvas-smoke: FAILED: native event loop exceeded 20 seconds");
        std::process::exit(124);
    });
    let result_code = Arc::new(AtomicI32::new(2));
    let code_from_setup = Arc::clone(&result_code);
    let app = tauri::Builder::default().setup(move |app| {
        // Build only a blank, incognito, hidden fixture. The ordinary app entry
        // and its runtime supervisors/single-instance code are never invoked.
        let handle = app.handle().clone();
        #[cfg(target_os = "macos")]
        handle.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
        let primary = handle.primary_monitor()?.ok_or("No primary monitor is available")?;
        let initial = logical_geometry(&primary);
        let mut targets = vec![(initial, primary.scale_factor())];
        for monitor in handle.available_monitors()? {
            let area = logical_geometry(&monitor);
            if area != initial { targets.push((area, monitor.scale_factor())); }
        }
        if targets.len() < 2 {
            println!("pet-canvas-smoke: SKIP (requires at least two displays)");
            code_from_setup.store(77, Ordering::Relaxed);
            handle.exit(77);
            return Ok(());
        }
        let window = WebviewWindowBuilder::new(app, "pet-canvas-isolated-test", WebviewUrl::External("about:blank".parse()?))
            .title("Isolated pet canvas geometry")
            .position(initial.x as f64, initial.y as f64)
            .inner_size(initial.width as f64, initial.height as f64)
            .decorations(false).transparent(true).shadow(false)
            .visible(false).focused(false).skip_taskbar(true).resizable(false).incognito(true)
            .build()?;
        let code = Arc::clone(&code_from_setup);
        tauri::async_runtime::spawn(async move {
            let test = async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                check_geometry(&window, initial, targets[0].1)?;
                println!("{}", json!({"mode":if baseline {"baseline-position-then-size"}else{"production-atomic-bounds"},"monitors":targets}));
                let mut cases = 0;
                for _ in 0..4 {
                    for &(area, scale) in targets.iter().skip(1).chain(targets.iter().take(1)) {
                        if baseline {
                            window.set_position(Position::Logical(LogicalPosition::new(area.x as f64, area.y as f64)))
                                .map_err(|error| error.to_string())?;
                            window.set_size(Size::Logical(LogicalSize::new(area.width as f64, area.height as f64)))
                                .map_err(|error| error.to_string())?;
                        } else { sync_pet_canvas(&window, area)?; }
                        // Let the old Tao setters' separate GCD callbacks land
                        // before comparing, so baseline failures reflect actual
                        // final geometry rather than unfinished async work.
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        check_geometry(&window, area, scale)?;
                        cases += 1;
                    }
                }
                println!("pet-canvas-smoke: OK ({cases} native monitor transitions)");
                Ok::<(), String>(())
            }.await;
            let exit_code = match test {
                Ok(()) => 0,
                Err(error) => { eprintln!("pet-canvas-smoke: FAILED: {error}"); 1 }
            };
            code.store(exit_code, Ordering::Relaxed);
            handle.exit(exit_code);
        });
        Ok(())
    }).build(tauri::generate_context!(test = true)).expect("Cannot build isolated native fixture");
    let code = app.run_return(|_, _| {});
    let stored = result_code.load(Ordering::Relaxed);
    std::process::exit(if stored == 2 { code } else { stored });
}
