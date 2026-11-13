//! Pure policy shared by the Windows surface and its cross-platform contracts.
use serde_json::Value;

pub fn windows_contract(command: &Value) -> Result<(), String> {
    if command.get("viewport").is_some() {
        return Err(
            "Fixed browser viewports and display scaling are unavailable on Windows".into(),
        );
    }
    Ok(())
}

pub fn bounded(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub fn event_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return String::new();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(key, value)| {
            let normalized: String = key
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .flat_map(char::to_lowercase)
                .collect();
            let secret = [
                "token",
                "authorization",
                "password",
                "secret",
                "cookie",
                "apikey",
            ]
            .iter()
            .any(|name| normalized.contains(name));
            (
                key.into_owned(),
                if secret {
                    "[redacted]".to_owned()
                } else {
                    value.into_owned()
                },
            )
        })
        .collect();
    if url.query().is_some() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    bounded(url.as_str(), 4000)
}

/// CSS canvas coordinates -> physical pixels in the owner's parent HWND.
/// Adaptive v1 deliberately resizes the page to the clipped visible aperture.
pub fn physical_bounds(bounds: &Value, owner: [i32; 4], zoom: f64, dpi: f64) -> Option<[i32; 4]> {
    let scale = zoom * dpi;
    if !scale.is_finite() || scale <= 0.0 || owner[2] <= owner[0] || owner[3] <= owner[1] {
        return None;
    }
    let x = bounds["x"].as_f64()?;
    let y = bounds["y"].as_f64()?;
    let width = bounds["width"].as_f64()?;
    let height = bounds["height"].as_f64()?;
    if [x, y, width, height]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.0)
    {
        return None;
    }
    let left = (owner[0] as f64 + x * scale).round().max(owner[0] as f64);
    let top = (owner[1] as f64 + y * scale).round().max(owner[1] as f64);
    let right = (owner[0] as f64 + (x + width) * scale)
        .round()
        .min(owner[2] as f64);
    let bottom = (owner[1] as f64 + (y + height) * scale)
        .round()
        .min(owner[3] as f64);
    (right > left && bottom > top).then_some([left as i32, top as i32, right as i32, bottom as i32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_keeps_legacy_bounds_and_rejects_unimplemented_viewport_semantics() {
        assert!(
            windows_contract(&json!({"op":"bounds","bounds":{"width":600,"height":400}})).is_ok()
        );
        for viewport in [
            Value::Null,
            json!({"width":1280,"height":800}),
            json!({"scale":0.5}),
        ] {
            assert!(windows_contract(&json!({"viewport":viewport})).is_err());
        }
    }

    #[test]
    fn events_strip_credentials_fragments_and_sensitive_query_values() {
        let safe = event_url("https://user:password@example.com/path?q=hello&access_token=secret&API-Key=key&cookie=private#id_token=fragment");
        assert!(!safe.contains("user") && !safe.contains("password@") && !safe.contains("secret"));
        assert!(!safe.contains("private") && !safe.contains("fragment"));
        let parsed = url::Url::parse(&safe).unwrap();
        let pairs: Vec<_> = parsed.query_pairs().collect();
        assert_eq!(pairs[0].1, "hello");
        assert!(pairs[1..].iter().all(|(_, value)| value == "[redacted]"));
        assert_eq!(event_url("not a url"), "");
        assert_eq!(bounded("标题🙂", 3), "标题🙂");
        assert_eq!(bounded("标题🙂", 2), "标题");
    }

    #[test]
    fn adaptive_bounds_apply_owner_offset_app_zoom_and_monitor_dpi_once() {
        let bounds = json!({"x":10,"y":80,"width":600,"height":400});
        assert_eq!(
            physical_bounds(&bounds, [20, 30, 2020, 1530], 1.0, 1.0),
            Some([30, 110, 630, 510])
        );
        assert_eq!(
            physical_bounds(&bounds, [20, 30, 2020, 1530], 1.25, 1.5),
            Some([39, 180, 1164, 930])
        );
        assert_eq!(
            physical_bounds(&bounds, [0, 0, 700, 500], 1.0, 2.0),
            Some([20, 160, 700, 500])
        );
        assert_eq!(physical_bounds(&bounds, [0, 0, 10, 10], 1.0, 1.0), None);
        assert_eq!(
            physical_bounds(&bounds, [0, 0, 700, 500], f64::NAN, 1.0),
            None
        );
    }
}
