//! Shared helpers: record keys, hashing, chunking and schedule math.

use super::*;

pub(crate) fn id_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{1,160}$").unwrap())
}

pub(crate) fn file_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}\.json$").unwrap())
}

pub(crate) fn time_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").unwrap())
}

pub(crate) fn account_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^\s,:]+:[^\s,:]+$").unwrap())
}

pub(crate) fn owner_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9-]{32,128}$").unwrap())
}

pub(crate) fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn file_key(owner: &str, id: &str) -> String {
    sha256_hex(&[owner.as_bytes(), b"\0", id.as_bytes()])
}

pub(crate) fn chars_take(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub(crate) fn chars_tail(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max {
        value.to_string()
    } else {
        value.chars().skip(count - max).collect()
    }
}

pub(crate) fn json_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value.as_f64().and_then(|number| {
            if number.is_finite() {
                Some(number as i64)
            } else {
                None
            }
        })
    })
}

pub(crate) fn is_active(row: &Value) -> bool {
    matches!(
        row["job"]["state"].as_str(),
        Some("queued" | "running" | "waiting")
    )
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Next HH:mm instant in an IANA zone, walking minute by minute like Node.
pub fn next_persona_run(time: &str, timezone: &str, after: i64) -> Result<i64, PersonaError> {
    if !time_re().is_match(time) {
        return Err(PersonaError::bad("时间应为 HH:mm"));
    }
    let tz: Tz = timezone
        .parse()
        .map_err(|_| PersonaError::bad("无法计算下次执行时间"))?;
    let mut cursor = after.div_euclid(60_000) * 60_000 + 60_000;
    let end = cursor + 49 * 3_600_000;
    while cursor < end {
        let Some(utc) = chrono::DateTime::from_timestamp_millis(cursor) else {
            return Err(PersonaError::bad("无法计算下次执行时间"));
        };
        if utc.with_timezone(&tz).format("%H:%M").to_string() == time {
            return Ok(cursor);
        }
        cursor += 60_000;
    }
    Err(PersonaError::bad("无法计算下次执行时间"))
}

pub(crate) fn zone_date(timezone: &str, now: i64) -> Result<String, ()> {
    let tz: Tz = timezone.parse().map_err(|_| ())?;
    let utc = chrono::DateTime::from_timestamp_millis(now).ok_or(())?;
    Ok(utc.with_timezone(&tz).format("%Y-%m-%d").to_string())
}

pub(crate) fn canonical_root(input: &str) -> Result<String, PersonaError> {
    if input.is_empty() {
        return Ok(String::new());
    }
    let path = Path::new(input);
    if !path.is_absolute() {
        return Err(PersonaError::bad("请选择现有本机第二大脑目录"));
    }
    let meta =
        std::fs::metadata(path).map_err(|_| PersonaError::bad("请选择现有本机第二大脑目录"))?;
    if !meta.is_dir() {
        return Err(PersonaError::bad("请选择现有本机第二大脑目录"));
    }
    let real =
        std::fs::canonicalize(path).map_err(|_| PersonaError::bad("请选择现有本机第二大脑目录"))?;
    let mut text = real.to_string_lossy().into_owned();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        text = stripped.to_string();
    }
    Ok(text)
}
