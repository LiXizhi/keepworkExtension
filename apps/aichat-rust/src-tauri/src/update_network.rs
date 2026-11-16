use std::error::Error;

fn public_url(url: &url::Url) -> String {
    let mut url = url.clone();
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

// Lower-level connector errors can also contain URLs (for example a proxy).
// Strip their credentials and query values before showing the source chain.
fn redact_urls(message: &str) -> String {
    let mut remaining = message;
    let mut result = String::new();
    let mut lowercase = remaining.to_ascii_lowercase();
    while let Some(start) = lowercase
        .find("https://")
        .into_iter()
        .chain(lowercase.find("http://"))
        .min()
    {
        result.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let end = remaining
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
            .unwrap_or(remaining.len());
        result.push_str(
            &url::Url::parse(&remaining[..end])
                .map(|url| public_url(&url))
                .unwrap_or_else(|_| "[URL]".into()),
        );
        remaining = &remaining[end..];
        lowercase = remaining.to_ascii_lowercase();
    }
    result.push_str(remaining);
    result
}

pub(crate) fn describe_request_error(error: reqwest::Error) -> String {
    let target = error.url().map(public_url);
    let error = error.without_url();
    let mut details = vec![redact_urls(&error.to_string())];
    let mut source = error.source();
    // Keep the useful DNS/TLS/proxy/socket reason without an unbounded chain.
    for _ in 0..8 {
        let Some(cause) = source else { break };
        let detail = redact_urls(&cause.to_string());
        if details.last() != Some(&detail) && !detail.is_empty() {
            details.push(detail);
        }
        source = cause.source();
    }
    let mut message = details.join(": ");
    if let Some(target) = target {
        message.push_str(&format!(" ({target})"));
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_urls_do_not_expose_proxy_or_feed_credentials() {
        let message = redact_urls(
            "proxy HTTPS://proxy-user:proxy-password@proxy.example:8080/?token=proxy-secret failed; \
             feed 'https://feed-user:feed-password@cdn.example/stable.json?signature=feed-secret#fragment-secret'",
        );
        assert!(message.contains("https://proxy.example:8080/"));
        assert!(message.contains("https://cdn.example/stable.json"));
        assert!(message.contains("failed"));
        for secret in [
            "proxy-user",
            "proxy-password",
            "proxy-secret",
            "feed-user",
            "feed-password",
            "feed-secret",
            "fragment-secret",
        ] {
            assert!(!message.contains(secret), "{message}");
        }
    }
}
