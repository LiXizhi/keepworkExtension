use url::Url;

pub const ENTRY: &str = "https://keepwork.com/chat";

pub fn has_credentials(parsed: &Url) -> bool {
    !parsed.username().is_empty() || parsed.password().is_some()
}

pub fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

pub fn same_origin_and_path(left: &Url, right: &Url) -> bool {
    same_origin(left, right) && left.path() == right.path()
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

/// Policy for the main window's `on_navigation`.
///
/// wry reports subframe (tool iframe) navigations to the same handler without
/// frame information, so this accepts same-origin keepwork.com pages and the
/// exact dev-source origin in addition to `trusted_page`. `trusted_page` stays
/// strict for bridge senders, media grants and entry validation.
pub fn allowed_navigation(raw_url: &str, dev_url: Option<&str>) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    if has_credentials(&parsed) {
        return false;
    }
    if parsed.scheme() == "tauri" || parsed.scheme() == "file" {
        return trusted_page(raw_url, dev_url);
    }
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    // The WeChat QR login iframe stays inside the app. Other providers are
    // popup-only (see allowed_in_app_popup).
    if is_login_iframe(&parsed) {
        return true;
    }
    if let Ok(entry) = Url::parse(ENTRY) {
        if same_origin(&parsed, &entry) {
            return true;
        }
    }
    // Published AIChat tools load from the CDN (for example
    // cdn.keepwork.com/apps/aichat/release/<hash>/tools/calendar/calendar.html).
    if is_keepwork_cdn(&parsed) {
        return true;
    }
    if let Some(dev_raw) = dev_url {
        if !dev_raw.trim().is_empty() {
            if let Ok(dev) = Url::parse(dev_raw) {
                if !has_credentials(&dev) && same_origin(&parsed, &dev) {
                    return true;
                }
            }
        }
    }
    trusted_page(raw_url, dev_url)
}

fn is_login_iframe(parsed: &Url) -> bool {
    parsed.scheme() == "https"
        && parsed.host_str() == Some("open.weixin.qq.com")
        && parsed.path().starts_with("/connect/")
}

fn is_keepwork_cdn(parsed: &Url) -> bool {
    parsed.scheme() == "https"
        && parsed.host_str() == Some("cdn.keepwork.com")
        && parsed.port_or_known_default() == Some(443)
}

fn is_login_provider_host(host: &str) -> bool {
    matches!(host, "accounts.google.com" | "open.weixin.qq.com")
        || host == "feishu.cn"
        || host.ends_with(".feishu.cn")
        || host == "larksuite.com"
        || host.ends_with(".larksuite.com")
        || host == "dingtalk.com"
        || host.ends_with(".dingtalk.com")
}

fn is_keepwork_popup_path(path: &str) -> bool {
    ["/sso", "/chat", "/login"]
        .iter()
        .any(|base| path == *base || path.starts_with(&format!("{base}/")))
}

/// Policy for the main window's `on_new_window` (`window.open`).
///
/// Login providers open a real popup so `window.opener` / postMessage and the
/// `/sso` callback work; every other http(s) URL is handed to the system
/// browser. Popups never receive the `aichatDesktop` bridge.
pub fn allowed_in_app_popup(raw_url: &str, dev_url: Option<&str>) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    if has_credentials(&parsed) {
        return false;
    }
    if let Some(dev_raw) = dev_url {
        if !dev_raw.trim().is_empty() {
            if let Ok(dev) = Url::parse(dev_raw) {
                if !has_credentials(&dev) && same_origin(&parsed, &dev) {
                    return true;
                }
            }
        }
    }
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if is_login_provider_host(host) {
        return true;
    }
    if let Ok(entry) = Url::parse(ENTRY) {
        if same_origin(&parsed, &entry) && is_keepwork_popup_path(parsed.path()) {
            return true;
        }
    }
    false
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
    // Never hand a URL carrying a bearer token to the system browser.
    const SENSITIVE_QUERY_KEYS: [&str; 4] = ["token", "access_token", "id_token", "authorization"];
    if parsed
        .query_pairs()
        .any(|(key, _)| SENSITIVE_QUERY_KEYS.iter().any(|name| key.eq_ignore_ascii_case(name)))
    {
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
    fn allows_same_origin_iframe_navigation_without_weakening_bridge_policy() {
        // wry sends iframe navigations through on_navigation: tool pages under
        // /api/raw must stay in the app instead of opening the system browser.
        assert!(allowed_navigation(
            "https://keepwork.com/api/raw/official/apps/tools/AIChat/tools/calendar/calendar.html",
            None
        ));
        assert!(allowed_navigation("https://keepwork.com/docs", None));
        assert!(allowed_navigation("https://keepwork.com/chat?session=1#top", None));
        assert!(allowed_navigation("tauri://localhost/index.html", None));

        assert!(!allowed_navigation(
            "https://user:pass@keepwork.com/chat",
            None
        ));
        assert!(!allowed_navigation("http://keepwork.com/chat", None));
        assert!(!allowed_navigation("https://keepwork.com:8443/chat", None));
        assert!(!allowed_navigation("https://a.keepwork.com/chat", None));
        assert!(!allowed_navigation("https://evil.example.com/chat", None));
        assert!(!allowed_navigation("javascript:alert(1)", None));
        assert!(!allowed_navigation("file:///etc/passwd", None));

        // Bridge sender / media / entry validation must remain path-exact.
        assert!(!trusted_page(
            "https://keepwork.com/api/raw/official/apps/tools/AIChat/tools/calendar/calendar.html",
            None
        ));

        let dev = Some("http://127.0.0.1:18432/AIChat.html");
        assert!(allowed_navigation("http://127.0.0.1:18432/AIChat.html?debug=1", dev));
        assert!(allowed_navigation(
            "http://127.0.0.1:18432/tools/calendar/calendar.html",
            dev
        ));
        assert!(!allowed_navigation("http://127.0.0.1:18433/AIChat.html", dev));
        assert!(!allowed_navigation("http://127.0.0.1:18432/other.html", None));
    }

    #[test]
    fn allows_wechat_qr_iframe_but_not_provider_top_level_navigation() {
        assert!(allowed_navigation(
            "https://open.weixin.qq.com/connect/qrconnect?appid=wxc97e44ce7c18725e",
            None
        ));
        assert!(!allowed_navigation(
            "https://open.weixin.qq.com/cgi-bin/other",
            None
        ));
        assert!(!allowed_navigation(
            "https://accounts.google.com/o/oauth2/v2/auth",
            None
        ));
        assert!(!allowed_navigation(
            "https://open.weixin.qq.com.evil.com/connect/qrconnect",
            None
        ));
        assert!(!allowed_navigation(
            "https://evil-open.weixin.qq.com/connect/qrconnect",
            None
        ));
    }

    #[test]
    fn allows_only_login_popups_in_app() {
        assert!(allowed_in_app_popup(
            "https://accounts.google.com/o/oauth2/v2/auth",
            None
        ));
        assert!(allowed_in_app_popup(
            "https://open.weixin.qq.com/connect/qrconnect",
            None
        ));
        assert!(allowed_in_app_popup(
            "https://accounts.feishu.cn/open-apis/authen/v1/index",
            None
        ));
        assert!(allowed_in_app_popup(
            "https://passport.feishu.cn/suite/passport/oauth/authorize",
            None
        ));
        assert!(allowed_in_app_popup(
            "https://login.dingtalk.com/oauth2/auth",
            None
        ));
        assert!(allowed_in_app_popup("https://keepwork.com/sso?code=1", None));
        assert!(allowed_in_app_popup("https://keepwork.com/chat?tool=calendar", None));
        assert!(allowed_in_app_popup("https://keepwork.com/login", None));

        assert!(!allowed_in_app_popup("https://keepwork.com/docs", None));
        assert!(!allowed_in_app_popup("https://evil-dingtalk.com/login", None));
        assert!(!allowed_in_app_popup("https://dingtalk.com.evil.com/login", None));
        assert!(!allowed_in_app_popup("https://evilfeishu.cn/login", None));
        assert!(!allowed_in_app_popup("http://accounts.google.com/o/oauth2/v2/auth", None));
        assert!(!allowed_in_app_popup("https://user:pass@keepwork.com/sso", None));
        assert!(!allowed_in_app_popup("javascript:alert(1)", None));
        assert!(!allowed_in_app_popup("about:blank", None));

        let dev = Some("http://127.0.0.1:18432/AIChat.html");
        assert!(allowed_in_app_popup("http://127.0.0.1:18432/login.html", dev));
        assert!(!allowed_in_app_popup("http://127.0.0.1:18433/login.html", dev));
        assert!(!allowed_in_app_popup("http://127.0.0.1:18432/login.html", None));
    }

    #[test]
    fn allows_keepwork_cdn_tool_iframes_without_exposing_tokens() {
        let cdn = "https://cdn.keepwork.com/apps/aichat/release/d29b1ecb4622/tools/calendar/calendar.html?locale=zh-CN&host=aichat&token=eyJhbGciOiJIUzI1NiJ9.demo";
        assert!(allowed_navigation(cdn, None));
        assert!(allowed_navigation(
            "https://cdn.keepwork.com/apps/aichat/release/d29b1ecb4622/tools/calendar/calendar.html",
            None
        ));
        assert!(!trusted_page(cdn, None));

        assert!(!allowed_navigation("http://cdn.keepwork.com/apps/x.html", None));
        assert!(!allowed_navigation("https://cdn.keepwork.com:8443/apps/x.html", None));
        assert!(!allowed_navigation(
            "https://cdn.keepwork.com.evil.com/apps/x.html",
            None
        ));
        assert!(!allowed_navigation("https://evilkeepwork.com/apps/x.html", None));
        assert!(!allowed_navigation(
            "https://user:pass@cdn.keepwork.com/apps/x.html",
            None
        ));

        assert_eq!(external_url(cdn), None);
        assert_eq!(
            external_url("https://cdn.keepwork.com/apps/aichat/x.html"),
            Some("https://cdn.keepwork.com/apps/aichat/x.html".to_string())
        );
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
