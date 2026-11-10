//! Command line: `keepwork-mcp [--port N] [--root DIR] [--require-auth]`.

#[derive(Debug, Default, Clone)]
pub struct Args {
    pub port: Option<u16>,
    pub root: Option<String>,
    pub require_auth: Option<bool>,
    pub help: bool,
}

pub const USAGE: &str = "Usage: keepwork-mcp [--port <port>] [--root <dir>] [--require-auth]";

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--port" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--port requires a value".to_string())?;
                parsed.port = Some(
                    value
                        .parse()
                        .map_err(|_| format!("invalid --port: {value}"))?,
                );
            }
            "--root" => {
                parsed.root = Some(
                    iter.next()
                        .ok_or_else(|| "--root requires a value".to_string())?,
                );
            }
            "--require-auth" => parsed.require_auth = Some(true),
            // The Node runtime manifest passes `["--port","8089"]`; external
            // hosts may also append flags we do not need yet.
            "--help" | "-h" => parsed.help = true,
            other if other.starts_with("--port=") => {
                parsed.port = Some(
                    other[7..]
                        .parse()
                        .map_err(|_| format!("invalid --port: {other}"))?,
                );
            }
            other if other.starts_with("--root=") => parsed.root = Some(other[7..].to_string()),
            other => return Err(format!("unknown argument: {other}\n{USAGE}")),
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_manifest_args() {
        let args = parse([
            "--port".to_string(),
            "8089".to_string(),
            "--root".to_string(),
            "/tmp/x".to_string(),
        ])
        .unwrap();
        assert_eq!(args.port, Some(8089));
        assert_eq!(args.root.as_deref(), Some("/tmp/x"));
        assert_eq!(args.require_auth, None);
    }

    #[test]
    fn parses_equals_form_and_rejects_unknown_flags() {
        assert_eq!(parse(["--port=9000".to_string()]).unwrap().port, Some(9000));
        assert!(parse(["--nope".to_string()]).is_err());
    }
}
