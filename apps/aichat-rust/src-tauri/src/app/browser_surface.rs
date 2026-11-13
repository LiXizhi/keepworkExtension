//! Unprivileged native web pages embedded over the active browser tool canvas.
use super::{sender::verify_main_sender, state::AppCore};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::WebviewWindow;

fn validate_command(op: &str, args: &Value) -> Result<Value, String> {
    if !matches!(
        op,
        "open" | "navigate" | "back" | "forward" | "reload" | "bounds" | "hide" | "close"
    ) {
        return Err("Unsupported browser surface command".into());
    }
    let id = args["id"].as_str().unwrap_or_default();
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid browser surface identity".into());
    }
    let mut command = json!({"op":op,"id":id});
    if matches!(op, "open" | "navigate") {
        let raw = args["url"].as_str().unwrap_or_default();
        if raw.len() > 8192 {
            return Err("Browser URL is too long".into());
        }
        command["url"] = json!(crate::security::external_url(raw)
            .ok_or("Only credential-free HTTP(S) browser URLs are supported")?);
    }
    if let Some(bounds) = args.get("bounds") {
        for key in ["x", "y", "width", "height"] {
            let value = bounds[key].as_f64().ok_or("Invalid browser bounds")?;
            if !value.is_finite() || !(0.0..=32768.0).contains(&value) {
                return Err("Invalid browser bounds".into());
            }
        }
        if bounds["width"].as_f64().unwrap() < 1.0 || bounds["height"].as_f64().unwrap() < 1.0 {
            return Err("Browser bounds must be visible".into());
        }
        command["bounds"] = bounds.clone();
    } else if op == "open" {
        return Err("Browser open requires bounds".into());
    }
    if let Some(viewport) = args.get("viewport") {
        let bounds = command
            .get("bounds")
            .ok_or("Browser viewport requires bounds")?;
        let scale = match viewport.get("scale") {
            Some(value) => value.as_f64().ok_or("Invalid browser display scale")?,
            None => 1.0,
        };
        if !scale.is_finite() || !(0.0001..=1.0).contains(&scale) {
            return Err("Invalid browser display scale".into());
        }
        for key in ["width", "height", "offsetX", "offsetY"] {
            let value = viewport[key].as_f64().ok_or("Invalid browser viewport")?;
            if !value.is_finite() || !(0.0..=32768.0).contains(&value) {
                return Err("Invalid browser viewport".into());
            }
        }
        for (dimension, offset) in [("width", "offsetX"), ("height", "offsetY")] {
            let full = viewport[dimension].as_f64().unwrap();
            let crop = viewport[offset].as_f64().unwrap();
            // CSS layout rounds displayed rectangles to subpixels. Compare in
            // display coordinates so a fractional fit scale cannot amplify
            // that rounding into a false confinement failure.
            if full < 1.0
                || crop > full
                || crop * scale + bounds[dimension].as_f64().unwrap() > full * scale + 0.02
            {
                return Err("Visible browser bounds exceed the viewport".into());
            }
        }
        command["viewport"] = viewport.clone();
    }
    if let Some(visible) = args.get("visible") {
        command["visible"] = json!(visible.as_bool().ok_or("Invalid browser visibility")?);
    }
    Ok(command)
}

#[tauri::command]
pub(super) async fn desktop_browser_surface(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    op: String,
    args: Value,
) -> Result<Value, String> {
    verify_main_sender(&window, &state)?;
    let command = validate_command(&op, &args)?;
    #[cfg(windows)]
    {
        crate::browser_surface_policy::windows_contract(&command)?;
        let zoom = *state.zoom.lock().map_err(|_| "Browser zoom unavailable")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                crate::browser_surface_windows::dispatch(
                    &webview.environment(),
                    &webview.controller(),
                    command,
                    zoom,
                    Box::new(move |result| {
                        let _ = send.send(result);
                    }),
                );
            })
            .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "Native browser closed".to_owned())?
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = command;
        if let Some(bounds) = command.get_mut("bounds") {
            let zoom = *state.zoom.lock().map_err(|_| "Browser zoom unavailable")?;
            for key in ["x", "y", "width", "height"] {
                bounds[key] = json!(bounds[key].as_f64().unwrap() * zoom);
            }
            if let Some(viewport) = command.get_mut("viewport") {
                for key in ["width", "height", "offsetX", "offsetY"] {
                    viewport[key] = json!(viewport[key].as_f64().unwrap() * zoom);
                }
            }
            command["zoom"] = json!(zoom);
        }
        let command =
            std::ffi::CString::new(command.to_string()).map_err(|_| "Invalid browser command")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                extern "C" {
                    fn keepwork_browser_surface_command(
                        owner: *mut std::ffi::c_void,
                        command: *const std::ffi::c_char,
                    ) -> *mut std::ffi::c_char;
                    fn keepwork_browser_surface_free(result: *mut std::ffi::c_char);
                }
                let result = unsafe {
                    let raw = keepwork_browser_surface_command(webview.inner(), command.as_ptr());
                    if raw.is_null() {
                        Err("Native browser returned no result".to_string())
                    } else {
                        let result = serde_json::from_slice::<Value>(
                            std::ffi::CStr::from_ptr(raw).to_bytes(),
                        )
                        .map_err(|_| "Invalid native browser response".to_string());
                        keepwork_browser_surface_free(raw);
                        result
                    }
                };
                let _ = send.send(result);
            })
            .map_err(|e| e.to_string())?;
        let result = receive.await.map_err(|_| "Native browser closed")??;
        if let Some(error) = result["error"].as_str() {
            return Err(error.into());
        }
        Ok(result)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = command;
        Err("Native browser surface is unavailable on this platform".into())
    }
}

#[cfg(windows)]
pub(super) fn reset(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        crate::browser_surface_windows::reset(&webview.controller());
    });
}

#[cfg(target_os = "macos")]
pub(super) fn reset(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        extern "C" {
            fn keepwork_browser_surface_reset(owner: *mut std::ffi::c_void);
        }
        unsafe {
            keepwork_browser_surface_reset(webview.inner());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_surface_validates_urls_identity_and_geometry() {
        let valid = json!({"id":"browser-123","url":"https://www.baidu.com","bounds":{"x":10,"y":80,"width":800,"height":500}});
        assert!(validate_command("open", &valid).is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://user:password@example.com",
            "https://example.com/?token=secret",
        ] {
            let mut invalid = valid.clone();
            invalid["url"] = json!(url);
            assert!(validate_command("open", &invalid).is_err(), "{url}");
        }
        for key in ["x", "y", "width", "height"] {
            let mut invalid = valid.clone();
            invalid["bounds"][key] = json!(-1);
            assert!(validate_command("open", &invalid).is_err());
        }
        assert!(validate_command("open", &json!({"id":"a","url":"https://example.com"})).is_err());
        assert!(validate_command("eval", &valid).is_err());
        assert!(validate_command("close", &json!({"id":"../main"})).is_err());
        assert!(validate_command("close", &json!({"id":"browser-123"})).is_ok());
    }
    #[test]
    fn browser_viewport_contract_is_optional_and_confines_crop_offsets() {
        let legacy = json!({"id":"browser-123","bounds":{"x":0,"y":0,"width":600,"height":400}});
        assert!(validate_command("bounds", &legacy).is_ok());
        let mut args = legacy.clone();
        args["viewport"] = json!({"width":768,"height":1024,"offsetX":50,"offsetY":200});
        assert!(validate_command("bounds", &args).is_ok());
        for key in ["width", "height", "offsetX", "offsetY"] {
            let mut invalid = args.clone();
            invalid["viewport"][key] = json!(-1);
            assert!(validate_command("bounds", &invalid).is_err());
        }
        args["viewport"]["offsetX"] = json!(200);
        assert!(validate_command("bounds", &args).is_err());
        assert!(validate_command("bounds", &json!({"id":"browser-123","viewport":{"width":768,"height":1024,"offsetX":0,"offsetY":0}})).is_err());
        assert!(validate_command(
            "bounds",
            &json!({"id":"browser-123","bounds":legacy["bounds"],"viewport":{"width":"768"}})
        )
        .is_err());
    }
    #[test]
    fn browser_fit_scale_is_optional_and_preserves_logical_crop_confinement() {
        let valid = json!({"id":"fit-browser","bounds":{"x":10,"y":90,"width":640,"height":400},"viewport":{"width":1280,"height":800,"offsetX":0,"offsetY":0,"scale":0.5}});
        assert!(validate_command("bounds", &valid).is_ok());
        for scale in [json!(0), json!(-1), json!(1.1), json!("0.5"), Value::Null] {
            let mut invalid = valid.clone();
            invalid["viewport"]["scale"] = scale;
            assert!(validate_command("bounds", &invalid).is_err());
        }
        let mut cropped = valid.clone();
        cropped["bounds"]["width"] = json!(600);
        cropped["viewport"]["offsetX"] = json!(80);
        assert!(validate_command("bounds", &cropped).is_ok());
        cropped["viewport"]["offsetX"] = json!(81);
        assert!(validate_command("bounds", &cropped).is_err());
        let mut rounded = valid.clone();
        rounded["viewport"]["scale"] = json!(1.0 / 3.0);
        rounded["bounds"]["width"] = json!(426.671875);
        rounded["bounds"]["height"] = json!(266.671875);
        assert!(
            validate_command("bounds", &rounded).is_ok(),
            "browser subpixel rounding must preserve fit"
        );
        rounded["bounds"]["width"] = json!(427);
        assert!(validate_command("bounds", &rounded).is_err());
    }
}
