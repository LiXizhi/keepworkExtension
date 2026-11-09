use url::Url;

pub const ENTRY: &str = "https://keepwork.com/chat";

pub fn has_credentials(parsed: &Url) -> bool {
    !parsed.username().is_empty() || parsed.password().is_some()
}

pub fn same_origin_and_path(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.path() == right.path()
}

pub fn trusted_page(raw_url: &str, dev_url: Option<&str>) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    if has_credentials(&parsed) {
        return false;
    }
    if let Ok(entry) = Url::parse(ENTRY) {
        if same_origin_and_path(&parsed, &entry) {
            return true;
        }
    }
    if let Some(dev_raw) = dev_url {
        if !dev_raw.trim().is_empty() {
            if let Ok(dev) = Url::parse(dev_raw) {
                if !has_credentials(&dev) && same_origin_and_path(&parsed, &dev) {
                    return true;
                }
            }
        }
    }
    // Also allow packaged local fallback index.html in the main window
    match (parsed.scheme(), parsed.host_str(), parsed.path()) {
        ("tauri", Some("localhost"), "/" | "/index.html") => true,
        ("http" | "https", Some("tauri.localhost"), "/" | "/index.html") => true,
        _ => false,
    }
}

pub fn trusted_internal_page(raw_url: &str, expected_path: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    if has_credentials(&parsed) {
        return false;
    }
    let path_matches = parsed.path() == expected_path
        || parsed.path().ends_with(expected_path);
    if !path_matches {
        return false;
    }
    match (parsed.scheme(), parsed.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("localhost" | "127.0.0.1")) => true,
        ("file", _) => true,
        _ => false,
    }
}

pub fn external_url(raw_url: &str) -> Option<String> {
    let parsed = Url::parse(raw_url).ok()?;
    if has_credentials(&parsed) {
        return None;
    }
    match parsed.scheme() {
        "http" | "https" => Some(parsed.to_string()),
        _ => None,
    }
}

pub fn assert_sender(
    actual_window_label: &str,
    expected_window_label: &str,
    is_main_frame: bool,
    frame_url: &str,
    dev_url: Option<&str>,
) -> Result<(), String> {
    if actual_window_label != expected_window_label {
        return Err("Unauthorized desktop window".to_string());
    }
    if !is_main_frame {
        return Err("Subframes cannot call desktop bridge".to_string());
    }
    match expected_window_label {
        "main" => {
            if !trusted_page(frame_url, dev_url) {
                return Err(format!("Untrusted desktop page: {frame_url}"));
            }
        }
        "pet" => {
            if !trusted_internal_page(frame_url, "/pet.html") {
                return Err(format!("Untrusted pet page: {frame_url}"));
            }
        }
        "updates" => {
            if !trusted_internal_page(frame_url, "/updates.html") {
                return Err(format!("Untrusted updates page: {frame_url}"));
            }
        }
        _ => return Err("Unknown desktop window".to_string()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_trusted_pages_and_rejects_untrusted_or_credentialed_urls() {
        assert!(trusted_page("https://keepwork.com/chat", None));
        assert!(trusted_page("https://keepwork.com/chat?session=1#top", None));
        assert!(!trusted_page("https://keepwork.com/other", None));
        assert!(!trusted_page("https://user:pass@keepwork.com/chat", None));
        assert!(!trusted_page("https://evil.example.com/chat", None));

        let dev = Some("http://127.0.0.1:18432/AIChat.html");
        assert!(trusted_page("http://127.0.0.1:18432/AIChat.html?debug=1", dev));
        assert!(!trusted_page("http://127.0.0.1:18432/other.html", dev));
    }

    #[test]
    fn enforces_sender_window_main_frame_and_url() {
        assert!(assert_sender("main", "main", true, "https://keepwork.com/chat", None).is_ok());
        assert!(assert_sender("main", "main", false, "https://keepwork.com/chat", None).is_err());
        assert!(assert_sender("pet", "main", true, "https://keepwork.com/chat", None).is_err());
        assert!(assert_sender("pet", "pet", true, "tauri://localhost/pet.html", None).is_ok());
        assert!(assert_sender("updates", "updates", true, "tauri://localhost/updates.html", None).is_ok());
    }

    #[test]
    fn filters_external_urls() {
        assert_eq!(
            external_url("https://keepwork.com/docs"),
            Some("https://keepwork.com/docs".to_string())
        );
        assert_eq!(external_url("javascript:alert(1)"), None);
        assert_eq!(external_url("file:///etc/passwd"), None);
        assert_eq!(external_url("https://token@keepwork.com/docs"), None);
    }
}
