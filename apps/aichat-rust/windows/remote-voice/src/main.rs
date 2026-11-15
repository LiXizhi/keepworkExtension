//! Private, parent-owned native dictation companion. No listener, renderer API,
//! transcript output or audio files. Closing the inherited input cancels all work.
extern crate self as tauri;
pub mod async_runtime {
    pub use tokio::spawn;
}
#[cfg(windows)]
#[path = "../../../src-tauri/src/remote_voice.rs"]
mod remote_voice;
#[cfg(windows)]
mod files {
    use serde::Serialize;
    use std::{fs, io::Write, path::Path};
    pub fn atomic_json_write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
        let parent = path.parent().ok_or("Missing profile directory")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = parent.join(format!(".voice-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(value)?)?;
            file.sync_all()?;
            fs::rename(&temporary, path)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result.map_err(|e| e.to_string())
    }
}

use serde::Deserialize;
#[cfg(windows)]
use serde_json::{json, Value};
use std::io::{self, BufRead};
#[cfg(windows)]
use std::io::Write;

const MAX_COMMAND: usize = 4096;
#[derive(Debug, Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Status {},
    Start { device: String, #[serde(rename = "autoStart")] auto_start: bool },
    Stop {},
    Auto { enabled: bool },
    Shutdown {},
}
fn command(bytes: &[u8]) -> Result<Command, String> {
    if bytes.len() > MAX_COMMAND { return Err("遥控器请求过长。".into()); }
    serde_json::from_slice(bytes).map_err(|_| "遥控器请求无效。".into())
}
/// Read without ever allocating an unbounded line from an inherited pipe.
fn read_command(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() { return Ok(if line.is_empty() { None } else { Some(line) }); }
        let count = buffer.iter().position(|b| *b == b'\n').map_or(buffer.len(), |i| i + 1);
        if line.len() + count > MAX_COMMAND + 1 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Command exceeds limit"));
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if line.last() == Some(&b'\n') { line.pop(); return Ok(Some(line)); }
    }
}
#[cfg(windows)]
fn run(profile: std::path::PathBuf) -> Result<(), String> {
    use std::sync::Arc;
    use remote_voice::{RemoteVoice, VoiceConfig};
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let _entered = runtime.enter();
    let voice = Arc::new(RemoteVoice::new(&profile));
    // Setup UI belongs to the parent CEF process; this companion opens none.
    voice.start_automatic(|| false);
    let input = io::stdin();
    let mut input = input.lock();
    let output = io::stdout();
    let mut output = output.lock();
    let result = (|| -> Result<(), String> {
        while let Some(bytes) = read_command(&mut input).map_err(|e| e.to_string())? {
            let mut shutdown = false;
            let result = match command(&bytes) {
                Ok(Command::Status {}) => Ok(voice.snapshot()),
                Ok(Command::Start { device, auto_start }) => voice.start(VoiceConfig { device, auto_start }),
                Ok(Command::Stop {}) => Ok(voice.stop()),
                Ok(Command::Auto { enabled }) => voice.set_auto_start(enabled),
                Ok(Command::Shutdown {}) => { shutdown = true; voice.shutdown(); Ok(voice.snapshot()) },
                Err(error) => Err(error),
            };
            let response: Value = match result {
                Ok(snapshot) => json!({ "ok": true, "snapshot": snapshot }),
                Err(error) => json!({ "ok": false, "error": error }),
            };
            serde_json::to_writer(&mut output, &response).map_err(|_| "Status output closed")?;
            output.write_all(b"\n").and_then(|_| output.flush()).map_err(|_| "Status output closed")?;
            if shutdown { break; }
        }
        Ok(())
    })();
    voice.shutdown();
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    result
}
fn main() {
    // The CEF browser process supplies only its own absolute profile, never a
    // webpage-supplied command or path. No interactive/HTTP service mode exists.
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--profile")) { std::process::exit(2); }
    let Some(profile) = args.next().map(std::path::PathBuf::from).filter(|p| p.is_absolute()) else { std::process::exit(2); };
    if args.next().is_some() { std::process::exit(2); }
    #[cfg(windows)]
    if run(profile).is_err() { std::process::exit(1); }
    #[cfg(not(windows))]
    { let _ = profile; std::process::exit(2); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_explicit_native_commands_are_accepted() {
        for input in [r#"{"action":"status"}"#, r#"{"action":"start","device":"","autoStart":true}"#,
            r#"{"action":"stop"}"#, r#"{"action":"auto","enabled":false}"#, r#"{"action":"shutdown"}"#] {
            assert!(command(input.as_bytes()).is_ok(), "{input}");
        }
        for input in [r#"{"action":"input","text":"private"}"#, r#"{"action":"status","text":"private"}"#,
            r#"{"action":"start","device":""}"#, r#"{"action":"auto","enabled":"false"}"#] {
            assert!(command(input.as_bytes()).is_err(), "{input}");
        }
        assert!(command(&vec![b' '; MAX_COMMAND + 1]).is_err());
    }
    #[test]
    fn pipe_eof_is_terminal_and_oversized_lines_fail_before_unbounded_allocation() {
        let mut input = io::Cursor::new(b"{\"action\":\"stop\"}\n");
        assert_eq!(read_command(&mut input).unwrap().unwrap(), b"{\"action\":\"stop\"}");
        assert!(read_command(&mut input).unwrap().is_none());
        assert!(read_command(&mut io::Cursor::new(vec![b'x'; MAX_COMMAND + 2])).is_err());
    }
}
