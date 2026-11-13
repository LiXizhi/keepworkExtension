//! Build-script timestamp selection; never consult file metadata or startup time.
pub fn select_timestamp(
    source_date_epoch: Option<&str>,
    now: u64,
) -> Result<(u64, &'static str), String> {
    // Four-digit UTC RFC3339 years, bounded to the precision supported by feeds.
    const MAX_UNIX_SECONDS: u64 = 253_402_300_799;
    if now > MAX_UNIX_SECONDS {
        return Err("Compilation clock is outside RFC3339 range".into());
    }
    match source_date_epoch {
        None => Ok((now, "compile-clock")),
        Some(value) => {
            if value.is_empty() || value.len() > 12 || !value.bytes().all(|v| v.is_ascii_digit()) {
                return Err("SOURCE_DATE_EPOCH must be unsigned integer Unix seconds".into());
            }
            let seconds: u64 = value.parse().map_err(|_| "Invalid SOURCE_DATE_EPOCH")?;
            if seconds > MAX_UNIX_SECONDS || seconds > now.saturating_add(300) {
                return Err("SOURCE_DATE_EPOCH is outside the valid build-time range".into());
            }
            Ok((seconds, "source-date-epoch"))
        }
    }
}
