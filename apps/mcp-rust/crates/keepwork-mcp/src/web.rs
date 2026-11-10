//! `web_search` and `fetch_url` (mirrors `src/core/web.ts`).
//!
//! Private/localhost targets are blocked, redirects are followed manually,
//! downloads are capped at 2 MiB and HTML is reduced to structured text.
//! Divergence from Node: no headless browser pass, so JS-rendered pages return
//! their static markup instead of a rendered DOM.

use serde_json::{json, Value};
use std::net::IpAddr;
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Url;

const FETCH_TIMEOUT_MS: u64 = 15_000;
const MAX_DOWNLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const DEFAULT_SEARCH_COUNT: usize = 8;
const MAX_SEARCH_COUNT: usize = 12;
const SNIPPET_CAP: usize = 160;
const DEFAULT_TEXT_CHARS: usize = 8000;
const MAX_TEXT_CHARS: usize = 16_000;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ACCEPT_LANG: &str = "zh-CN,zh;q=0.9,en;q=0.8";

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

fn json_error(error: &str, detail: Option<&str>) -> Value {
    match detail {
        Some(detail) => json!({ "error": error, "detail": detail }),
        None => json!({ "error": error }),
    }
}

fn clamp_count(count: Option<f64>) -> usize {
    match count {
        Some(value) if value.is_finite() => {
            (value.floor() as i64).clamp(1, MAX_SEARCH_COUNT as i64) as usize
        }
        _ => DEFAULT_SEARCH_COUNT,
    }
}

fn clamp_text_chars(value: Option<f64>) -> usize {
    match value {
        Some(raw) if raw.is_finite() => {
            (raw.floor() as i64).clamp(200, MAX_TEXT_CHARS as i64) as usize
        }
        _ => DEFAULT_TEXT_CHARS,
    }
}

fn has_cjk(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ('\u{3000}'..='\u{9fff}').contains(&ch))
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
                || octets[0] >= 224
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .map(|mapped| is_private(IpAddr::V4(mapped)))
                    .unwrap_or(false)
        }
    }
}

fn skip_host(host: &str) -> bool {
    matches!(
        host,
        "localhost"
            | "0.0.0.0"
            | "::1"
            | "metadata.google.internal"
            | "metadata.google.com"
            | "kubernetes.default.svc"
    ) || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".localhost")
}

/// Rejects non-public targets before any bytes leave the machine.
pub async fn assert_public_url(raw: &str) -> Result<Url, (String, String)> {
    let trimmed = raw.trim();
    let url =
        Url::parse(trimmed).map_err(|_| ("invalid".to_string(), "invalid-url".to_string()))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(("blocked".to_string(), other.to_string())),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(("blocked".to_string(), "credentials".to_string()));
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if host.is_empty() || skip_host(&host) {
        return Err(("blocked".to_string(), "private-host".to_string()));
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if is_private(address) {
            return Err(("blocked".to_string(), "private-ip".to_string()));
        }
        return Ok(url);
    }
    let resolved = tokio::net::lookup_host((host.as_str(), 80u16)).await;
    let Ok(mut records) = resolved else {
        return Err(("blocked".to_string(), "dns".to_string()));
    };
    let mut any = false;
    for record in records.by_ref() {
        any = true;
        if is_private(record.ip()) {
            return Err(("blocked".to_string(), "private-ip".to_string()));
        }
    }
    if !any {
        return Err(("blocked".to_string(), "dns".to_string()));
    }
    Ok(url)
}

fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(semi) = tail.find(';').filter(|semi| *semi <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let replacement = match entity.to_ascii_lowercase().as_str() {
            "nbsp" | "ensp" | "emsp" | "thinsp" => Some(" ".to_string()),
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" | "#39" => Some("'".to_string()),
            other => {
                if let Some(hex) = other.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|ch| ch.to_string())
                } else if let Some(dec) = other.strip_prefix('#') {
                    dec.parse::<u32>()
                        .ok()
                        .and_then(char::from_u32)
                        .map(|ch| ch.to_string())
                } else {
                    None
                }
            }
        };
        match replacement {
            Some(value) => {
                out.push_str(&value);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_tags(html: &str) -> String {
    let re = regex::Regex::new(r"(?s)<[^>]+>").expect("tag regex");
    re.replace_all(html, " ").into_owned()
}

fn collapse_ws(input: &str) -> String {
    let re = regex::Regex::new(r"\s+").expect("ws regex");
    re.replace_all(input, " ").trim().to_string()
}

pub fn extract_title(html: &str) -> String {
    let title_re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex");
    let og_re =
        regex::Regex::new(r#"(?is)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)"#)
            .expect("og regex");
    let og_reversed = regex::Regex::new(
        r#"(?is)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']"#,
    )
    .expect("og regex");
    let raw = title_re
        .captures(html)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .or_else(|| {
            og_re
                .captures(html)
                .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        })
        .or_else(|| {
            og_reversed
                .captures(html)
                .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        })
        .unwrap_or_default();
    let inline = regex::Regex::new(r"[ \t\f\v]+").expect("inline regex");
    let decoded = decode_entities(&strip_tags(&raw));
    inline.replace_all(&decoded, " ").trim().to_string()
}

fn strip_chrome(html: &str) -> String {
    let mut out = html.to_string();
    for pattern in [
        r"(?is)<script.*?</script>",
        r"(?is)<style.*?</style>",
        r"(?is)<noscript.*?</noscript>",
        r"(?is)<svg.*?</svg>",
        r"(?is)<template.*?</template>",
        r"(?is)<iframe.*?</iframe>",
        r"(?is)<!--.*?-->",
        r"(?is)<nav.*?</nav>",
        r"(?is)<footer.*?</footer>",
        r"(?is)<aside.*?</aside>",
        r"(?is)<form.*?</form>",
        r"(?is)<header.*?</header>",
    ] {
        let re = regex::Regex::new(pattern).expect("chrome regex");
        out = re.replace_all(&out, " ").into_owned();
    }
    out
}

fn pick_main_html(html: &str) -> String {
    let body_re = regex::Regex::new(r"(?is)<body[^>]*>(.*?)</body>").expect("body regex");
    let body = body_re
        .captures(html)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| html.to_string());
    let cleaned = strip_chrome(&body);
    let candidates = [
        r"(?is)<article\b[^>]*>(.*?)</article>",
        r"(?is)<main\b[^>]*>(.*?)</main>",
        r#"(?is)<div[^>]*role=["']main["'][^>]*>(.*?)</div>"#,
        r#"(?is)<div[^>]*class=["'][^"']*(?:article|post-content|entry-content|markdown-body|article-content)[^"']*["'][^>]*>(.*?)</div>"#,
    ];
    let tag_re = regex::Regex::new(r"(?s)<[^>]+>").expect("tag regex");
    let text_len = |value: &str| collapse_ws(&tag_re.replace_all(value, " ")).chars().count();
    let mut best = String::new();
    for pattern in candidates {
        let Ok(re) = regex::Regex::new(pattern) else {
            continue;
        };
        if let Some(caps) = re.captures(&cleaned) {
            if let Some(candidate) = caps.get(1) {
                if text_len(candidate.as_str()) > text_len(&best) {
                    best = candidate.as_str().to_string();
                }
            }
        }
    }
    let best_len = text_len(&best);
    let full_len = text_len(&cleaned);
    if !best.is_empty() && best_len >= 120 && best_len * 4 >= full_len.min(400) {
        return best;
    }
    cleaned
}

fn tags_to_text(html: &str) -> String {
    let mut out = html.to_string();
    let replacements: Vec<(&str, &str)> = vec![
        (r"(?is)<br\s*/?>", "\n"),
        (r"(?is)<hr\s*/?>", "\n"),
        (r"(?is)<li\b[^>]*>", "\n- "),
        (r"(?is)<tr\b[^>]*>", "\n"),
        (r"(?is)</t[dh]>", " | "),
        (
            r"(?is)<(p|div|section|article|blockquote|ul|ol|table|pre|figcaption)\b[^>]*>",
            "\n\n",
        ),
        (
            r"(?is)</(p|div|section|article|blockquote|ul|ol|table|pre|figcaption|li|tr)>",
            "\n",
        ),
    ];
    for (pattern, replacement) in replacements {
        let re = regex::Regex::new(pattern).expect("text regex");
        out = re.replace_all(&out, replacement).into_owned();
    }
    for level in 1..=6 {
        let open = regex::Regex::new(&format!(r"(?is)<h{level}\b[^>]*>")).expect("heading open");
        let close = regex::Regex::new(&format!(r"(?is)</h{level}>")).expect("heading close");
        out = open
            .replace_all(&out, format!("\n\n{} ", "#".repeat(level)))
            .into_owned();
        out = close.replace_all(&out, "\n\n").into_owned();
    }
    let tags = regex::Regex::new(r"(?s)<[^>]+>").expect("tag regex");
    decode_entities(&tags.replace_all(&out, ""))
}

/// Structured readable text from HTML. Never returns markup.
pub fn html_to_structured_text(html: &str) -> String {
    let main = pick_main_html(html);
    let raw = tags_to_text(&main);
    let mut out: Vec<String> = Vec::new();
    let mut blank = 0usize;
    let space_run = regex::Regex::new(r"[ \t]+").expect("space regex");
    let bullet_only = regex::Regex::new(r"^[-*•]\s*$").expect("bullet regex");
    let trailing_pipes = regex::Regex::new(r"(?:\s*\|\s*)+$").expect("pipe regex");
    for line in raw.split('\n') {
        let line = space_run.replace_all(line, " ").trim().to_string();
        if line.is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push(String::new());
            }
            continue;
        }
        blank = 0;
        if line == "|" || line.chars().all(|ch| ch == '|' || ch.is_whitespace()) {
            continue;
        }
        if bullet_only.is_match(&line) {
            continue;
        }
        if line.starts_with("- ")
            && out
                .last()
                .map(|prev| !prev.is_empty() && !prev.starts_with("- "))
                .unwrap_or(false)
        {
            out.push(String::new());
        }
        let trimmed = trailing_pipes.replace(&line, "").trim().to_string();
        out.push(trimmed);
    }
    out.join("\n").trim().to_string()
}

struct FetchedDoc {
    final_url: String,
    content_type: String,
    body: String,
}

fn decode_body(bytes: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).into_owned();
    let mut charset = String::new();
    if let Some(caps) = regex::Regex::new(r#"(?i)charset\s*=\s*["']?([^\s"';]+)"#)
        .unwrap()
        .captures(content_type)
    {
        charset = caps[1].to_ascii_lowercase();
    }
    if charset.is_empty() {
        let meta = regex::Regex::new(r#"(?i)<meta[^>]+charset\s*=\s*["']?([^\s"';>]+)"#)
            .unwrap()
            .captures(&head)
            .or_else(|| {
                regex::Regex::new(r#"(?i)<meta[^>]+content=["'][^"']*charset=([^\s"';]+)"#)
                    .unwrap()
                    .captures(&head)
            });
        if let Some(caps) = meta {
            charset = caps[1].to_ascii_lowercase();
        }
    }
    if charset.is_empty() {
        charset = "utf-8".to_string();
    }
    if matches!(charset.as_str(), "gb2312" | "gbk" | "gb-2312") {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        return text.into_owned();
    }
    let encoding =
        encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

async fn fetch_public_doc(
    start_url: &str,
    extra_headers: &[(&str, &str)],
) -> Result<FetchedDoc, (String, String)> {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .build()
        .map_err(|error| {
            (
                "network".to_string(),
                error.to_string().chars().take(80).collect(),
            )
        })?;
    let mut current = start_url.trim().to_string();
    for _ in 0..=MAX_REDIRECTS {
        let parsed = assert_public_url(&current).await?;
        let mut request = client
            .get(parsed.clone())
            .header("User-Agent", USER_AGENT)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            )
            .header("Accept-Language", ACCEPT_LANG);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                ("timeout".to_string(), "timeout".to_string())
            } else {
                (
                    "network".to_string(),
                    error.to_string().chars().take(80).collect(),
                )
            }
        })?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| (format!("http-{}", status.as_u16()), "network".to_string()))?;
            current = parsed
                .join(location)
                .map_err(|_| ("network".to_string(), "bad-redirect".to_string()))?
                .to_string();
            continue;
        }
        if !status.is_success() {
            return Err((format!("http-{}", status.as_u16()), "network".to_string()));
        }
        if let Some(length) = response.content_length() {
            if length as usize > MAX_DOWNLOAD_BYTES {
                return Err(("invalid".to_string(), "too-large".to_string()));
            }
        }
        let bytes = response.bytes().await.map_err(|error| {
            (
                "network".to_string(),
                error.to_string().chars().take(80).collect(),
            )
        })?;
        if bytes.len() > MAX_DOWNLOAD_BYTES {
            return Err(("invalid".to_string(), "too-large".to_string()));
        }
        let body = decode_body(&bytes, &content_type);
        return Ok(FetchedDoc {
            final_url: parsed.to_string(),
            content_type,
            body,
        });
    }
    Err(("too-many-redirects".to_string(), "network".to_string()))
}

fn normalize_hit_url(raw: &str, base: &str) -> String {
    let Ok(base_url) = Url::parse(base) else {
        return String::new();
    };
    let Ok(mut url) = base_url.join(&decode_entities(raw)) else {
        return String::new();
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return String::new();
    }
    url.set_fragment(None);
    url.to_string()
}

fn push_hit(
    hits: &mut Vec<SearchHit>,
    seen: &mut Vec<String>,
    title: &str,
    url: &str,
    snippet: &str,
) {
    if title.is_empty() || url.is_empty() {
        return;
    }
    if regex::Regex::new(
        r"(?i)(?:bing\.com/aclk|duckduckgo\.com/y\.js|baidu\.com/baidu\.php|googleadservices\.com)",
    )
    .unwrap()
    .is_match(url)
    {
        return;
    }
    let key = url.trim_end_matches('/').to_string();
    if seen.contains(&key) {
        return;
    }
    seen.push(key);
    hits.push(SearchHit {
        title: title.chars().take(200).collect(),
        url: url.to_string(),
        snippet: snippet.chars().take(SNIPPET_CAP).collect(),
    });
}

pub fn parse_bing_html(html: &str, base: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut seen = Vec::new();
    let split = regex::Regex::new(r#"(?i)<li[^>]*class="[^"]*\bb_algo\b[^"]*""#).unwrap();
    let anchor =
        regex::Regex::new(r#"(?is)<h2[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let anchor_fallback =
        regex::Regex::new(r#"(?is)<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let snippet_re = regex::Regex::new(
        r"(?is)<(?:p|div)[^>]*(?:b_lineclamp|b_caption|b_algoSlug)[^>]*>(.*?)</(?:p|div)>",
    )
    .unwrap();
    let snippet_fallback = regex::Regex::new(r"(?is)<p[^>]*>(.*?)</p>").unwrap();
    let chunks: Vec<&str> = split.split(html).collect();
    for chunk in chunks.iter().skip(1) {
        if hits.len() >= MAX_SEARCH_COUNT + 4 {
            break;
        }
        let block: String = chunk.chars().take(6000).collect();
        let Some(caps) = anchor
            .captures(&block)
            .or_else(|| anchor_fallback.captures(&block))
        else {
            continue;
        };
        let url = normalize_hit_url(&caps[1], base);
        let title = collapse_ws(&decode_entities(&strip_tags(&caps[2])));
        let snippet = snippet_re
            .captures(&block)
            .or_else(|| snippet_fallback.captures(&block))
            .map(|caps| collapse_ws(&decode_entities(&strip_tags(&caps[1]))))
            .unwrap_or_default();
        push_hit(&mut hits, &mut seen, &title, &url, &snippet);
    }
    hits
}

pub fn parse_ddg_html(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut seen = Vec::new();
    let re = regex::Regex::new(
        r#"(?is)<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
    )
    .unwrap();
    let snippet_re = regex::Regex::new(
        r#"(?is)class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|span|td|div)"#,
    )
    .unwrap();
    for caps in re.captures_iter(html) {
        if hits.len() >= MAX_SEARCH_COUNT + 4 {
            break;
        }
        let url = normalize_hit_url(
            &unwrap_ddg(&decode_entities(&caps[1])),
            "https://duckduckgo.com/",
        );
        let title = collapse_ws(&decode_entities(&strip_tags(&caps[2])));
        let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
        let after: String = html.chars().skip(start).take(1800).collect();
        let snippet = snippet_re
            .captures(&after)
            .map(|caps| collapse_ws(&decode_entities(&strip_tags(&caps[1]))))
            .unwrap_or_default();
        push_hit(&mut hits, &mut seen, &title, &url, &snippet);
    }
    hits
}

fn unwrap_ddg(href: &str) -> String {
    match Url::parse(href)
        .or_else(|_| Url::parse("https://html.duckduckgo.com/").and_then(|base| base.join(href)))
    {
        Ok(url) => url
            .query_pairs()
            .find(|(key, _)| key == "uddg")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| url.to_string()),
        Err(_) => href.to_string(),
    }
}

pub fn parse_baidu_html(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut seen = Vec::new();
    let re = regex::Regex::new(r#"(?is)<h3[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let snippet_re = regex::Regex::new(
        r#"(?is)class="[^"]*(?:c-abstract|content-right_8Zs40)[^"]*"[^>]*>(.*?)</(?:div|span)"#,
    )
    .unwrap();
    let self_link = regex::Regex::new(r"(?i)baidu\.com/(?:s\?|index)").unwrap();
    for caps in re.captures_iter(html) {
        if hits.len() >= MAX_SEARCH_COUNT + 4 {
            break;
        }
        let url = normalize_hit_url(&decode_entities(&caps[1]), "https://www.baidu.com/");
        if url.is_empty() || self_link.is_match(&url) {
            continue;
        }
        let title = collapse_ws(&decode_entities(&strip_tags(&caps[2])));
        let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
        let after: String = html.chars().skip(start).take(2000).collect();
        let snippet = snippet_re
            .captures(&after)
            .map(|caps| collapse_ws(&decode_entities(&strip_tags(&caps[1]))))
            .unwrap_or_default();
        push_hit(&mut hits, &mut seen, &title, &url, &snippet);
    }
    hits
}

fn distinctive_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let ascii = regex::Regex::new(r"[A-Za-z][A-Za-z0-9]{2,}").unwrap();
    let cjk = regex::Regex::new(r"[\u4e00-\u9fff]{2,}").unwrap();
    for found in ascii.find_iter(query) {
        let value = found.as_str().to_ascii_lowercase();
        if !tokens.contains(&value) {
            tokens.push(value);
        }
    }
    for found in cjk.find_iter(query) {
        let value = found.as_str().to_string();
        if !tokens.contains(&value) {
            tokens.push(value);
        }
    }
    tokens
}

fn results_relevant(query: &str, results: &[SearchHit]) -> bool {
    if results.is_empty() {
        return false;
    }
    let tokens = distinctive_tokens(query);
    if tokens.is_empty() {
        return true;
    }
    let blob = results
        .iter()
        .map(|hit| format!("{}\n{}\n{}", hit.title, hit.url, hit.snippet))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    tokens
        .iter()
        .any(|token| blob.contains(&token.to_lowercase()))
}

fn bing_search_url(query: &str) -> (String, Vec<(&'static str, &'static str)>, &'static str) {
    let encoded = urlencode(query);
    if has_cjk(query) {
        return (
            format!("https://cn.bing.com/search?q={encoded}&ensearch=0&setmkt=zh-CN&setlang=zh-Hans&cc=CN"),
            vec![
                ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8"),
                ("Referer", "https://cn.bing.com/"),
                ("Cookie", "_EDGE_S=ui=zh-cn&mkt=zh-cn; SRCHHPGUSR=SRCHLANG=zh-Hans"),
            ],
            "https://cn.bing.com/",
        );
    }
    (
        format!("https://www.bing.com/search?q={encoded}"),
        Vec::new(),
        "https://www.bing.com/",
    )
}

fn urlencode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub async fn web_search(query: &str, count: Option<f64>) -> Value {
    let query = query.trim();
    if query.is_empty() {
        return json_error("invalid", Some("query-required"));
    }
    let limit = clamp_count(count);
    let encoded = urlencode(query);
    let (bing_url, bing_headers, bing_base) = bing_search_url(query);
    let cjk = has_cjk(query);
    let ddg_url = format!("https://html.duckduckgo.com/html/?q={encoded}");
    let baidu_url = format!("https://www.baidu.com/s?wd={encoded}");

    struct Attempt {
        engine: &'static str,
        url: String,
        headers: Vec<(&'static str, &'static str)>,
    }
    let mut attempts = vec![Attempt {
        engine: "bing",
        url: bing_url,
        headers: bing_headers,
    }];
    if cjk {
        attempts.push(Attempt {
            engine: "baidu",
            url: baidu_url,
            headers: Vec::new(),
        });
        attempts.push(Attempt {
            engine: "ddg",
            url: ddg_url,
            headers: Vec::new(),
        });
    } else {
        attempts.push(Attempt {
            engine: "ddg",
            url: ddg_url,
            headers: Vec::new(),
        });
        attempts.push(Attempt {
            engine: "baidu",
            url: baidu_url,
            headers: Vec::new(),
        });
    }

    let mut failures: Vec<String> = Vec::new();
    for Attempt {
        engine,
        url,
        headers,
    } in attempts
    {
        match fetch_public_doc(&url, &headers).await {
            Ok(doc) => {
                let results = match engine {
                    "bing" => parse_bing_html(&doc.body, bing_base),
                    "baidu" => parse_baidu_html(&doc.body),
                    _ => parse_ddg_html(&doc.body),
                };
                let results: Vec<SearchHit> = results.into_iter().take(limit).collect();
                if results.is_empty() {
                    failures.push(format!("{engine}:empty"));
                    continue;
                }
                if !results_relevant(query, &results) {
                    failures.push(format!("{engine}:irrelevant"));
                    continue;
                }
                return json!({
                    "engine": engine,
                    "query": query,
                    "results": results.iter().map(|hit| json!({
                        "title": hit.title,
                        "url": hit.url,
                        "snippet": hit.snippet,
                    })).collect::<Vec<_>>(),
                });
            }
            Err((_code, detail)) => failures.push(format!("{engine}:{detail}")),
        }
    }
    json_error("empty", Some(&failures.join(",")))
}

fn content_kind(content_type: &str, body: &str) -> &'static str {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if base.is_empty() {
        return if body.trim_start().starts_with('<') {
            "html"
        } else {
            "text"
        };
    }
    if base == "text/html" || base == "application/xhtml+xml" {
        return "html";
    }
    if base == "application/json" || base.ends_with("+json") {
        return "json";
    }
    if base.starts_with("text/") || base == "application/xml" || base == "application/javascript" {
        return "text";
    }
    "reject"
}

pub async fn fetch_url(url: &str, max_chars: Option<f64>) -> Value {
    let raw = url.trim().to_string();
    if raw.is_empty() {
        return json_error("invalid", Some("url-required"));
    }
    let cap = clamp_text_chars(max_chars);
    match fetch_public_doc(&raw, &[]).await {
        Ok(doc) => {
            let kind = content_kind(&doc.content_type, &doc.body);
            if kind == "reject" {
                let base = doc
                    .content_type
                    .split(';')
                    .next()
                    .unwrap_or("unknown")
                    .trim();
                return json_error(
                    "unsupported",
                    Some(if base.is_empty() { "unknown" } else { base }),
                );
            }
            let (title, text) = match kind {
                "html" => (extract_title(&doc.body), html_to_structured_text(&doc.body)),
                "json" => (String::new(), collapse_ws(&doc.body)),
                _ => (extract_title(&doc.body), collapse_ws(&doc.body)),
            };
            let truncated = text.chars().count() > cap;
            let text: String = if truncated {
                text.chars().take(cap).collect()
            } else {
                text
            };
            json!({
                "url": raw,
                "finalUrl": doc.final_url,
                "title": title,
                "text": text,
                "truncated": truncated,
            })
        }
        Err((code, detail)) => json_error(&code, Some(&detail)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_hosts() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        assert!(runtime
            .block_on(assert_public_url("http://127.0.0.1:8089/"))
            .is_err());
        assert!(runtime
            .block_on(assert_public_url("http://localhost/"))
            .is_err());
        assert!(runtime
            .block_on(assert_public_url("file:///etc/passwd"))
            .is_err());
        assert!(runtime
            .block_on(assert_public_url("http://user:pass@example.com/"))
            .is_err());
    }

    #[test]
    fn extracts_title_and_text() {
        let html = "<html><head><title>Hello &amp; World</title></head><body><header>nav</header><article><h2>Title</h2><p>Body text that is long enough.</p><ul><li>one</li><li>two</li></ul></article></body></html>";
        assert_eq!(extract_title(html), "Hello & World");
        let text = html_to_structured_text(html);
        assert!(text.contains("## Title"));
        assert!(text.contains("- one"));
        assert!(!text.contains('<'));
    }

    #[test]
    fn parses_bing_results() {
        let html = r#"<ol><li class="b_algo"><h2><a href="https://example.com/a">Example &amp; Co</a></h2><p class="b_lineclamp4">Snippet text</p></li></ol>"#;
        let hits = parse_bing_html(html, "https://www.bing.com/");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/a");
        assert_eq!(hits[0].title, "Example & Co");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &amp; b &#65; &#x42;"), "a & b A B");
        assert_eq!(decode_entities("100% & more"), "100% & more");
    }
}
