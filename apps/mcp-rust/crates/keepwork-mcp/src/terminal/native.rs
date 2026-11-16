//! Small native boundary shared by the unchanged terminal HTTP/session layer.
use std::io::{Read, Write};
use std::path::Path;

#[derive(Clone, Copy)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}
pub trait PtyControl: Send {
    fn resize(&self, size: PtySize) -> Result<(), String>;
}
pub trait ChildControl: Send + Sync {
    fn kill(&mut self) -> Result<(), String>;
}
pub struct SpawnedTerminal {
    pub master: Box<dyn PtyControl>,
    pub child: Box<dyn ChildControl>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub backend: Option<&'static str>,
}

#[cfg(windows)]
pub(super) fn restore_ctrl_c() -> Result<(), String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    // Clear only the inheritable ignore flag, preserving application handlers.
    // Detached processes may have no console handler table to reset.
    if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(6) {
            return Err(format!("Cannot restore terminal Ctrl+C handling: {error}"));
        }
    }
    Ok(())
}

#[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
pub fn spawn_shell(
    shell: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
) -> Result<SpawnedTerminal, String> {
    use super::selection::{choose_backend, spawn_guarded};
    let backend = choose_backend(true, super::system_conpty::export_presence())
        .expect("the compatibility edition retains WinPTY");
    spawn_guarded(
        super::winpty::session_guard(),
        backend,
        |_| super::system_conpty::spawn(args, cwd, size),
        |guard| super::winpty::spawn_verified(shell, args, cwd, size, guard),
    )
}

#[cfg(not(all(windows, any(target_vendor = "win7", feature = "win7-compat"))))]
pub fn spawn_shell(
    shell: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
) -> Result<SpawnedTerminal, String> {
    use portable_pty::{native_pty_system, CommandBuilder, MasterPty};
    struct Master(Box<dyn MasterPty + Send>);
    impl PtyControl for Master {
        fn resize(&self, size: PtySize) -> Result<(), String> {
            self.0
                .resize(portable_pty::PtySize {
                    rows: size.rows,
                    cols: size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())
        }
    }
    struct Child(Box<dyn portable_pty::Child + Send + Sync>);
    impl ChildControl for Child {
        fn kill(&mut self) -> Result<(), String> {
            self.0.kill().map_err(|error| error.to_string())
        }
    }
    let pair = native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    restore_ctrl_c()?;
    let mut command = CommandBuilder::new(shell);
    command.args(args);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let opened = (|| {
        Ok((
            pair.master
                .try_clone_reader()
                .map_err(|error| error.to_string())?,
            pair.master
                .take_writer()
                .map_err(|error| error.to_string())?,
        ))
    })();
    let (reader, writer) = match opened {
        Ok(value) => value,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    Ok(SpawnedTerminal {
        master: Box::new(Master(pair.master)),
        child: Box::new(Child(child)),
        reader,
        writer,
        backend: if cfg!(windows) { Some("conpty") } else { None },
    })
}

// Explicitly invoked by an ignored backend test. No diagnostic code is built
// into the runtime, and these observations are never release acceptance.
#[cfg(all(
    test,
    windows,
    not(any(target_vendor = "win7", feature = "win7-compat"))
))]
pub(super) fn diagnose_windows_startup(spec: (String, Vec<String>), init: &str) {
    startup_diagnostic::run(spec, init);
}

#[cfg(all(
    test,
    windows,
    not(any(target_vendor = "win7", feature = "win7-compat"))
))]
mod startup_diagnostic {
    use super::*;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    use std::io::{Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    const TEST: &str = "terminal::backend::tests::windows_pty_startup_differential_diagnostic";
    const LIMIT_MS: u64 = 10_000;
    const CLEANUP_MS: u64 = 2_000;
    const OUTPUT_CAP: usize = 65_536;
    const PHASE_ENV: &str = "KEEPWORK_PTY_DIAGNOSTIC_BREADCRUMB";

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        fn AllocConsole() -> i32;
        fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
        fn GetModuleFileNameW(module: *mut std::ffi::c_void, name: *mut u16, size: u32) -> u32;
    }

    #[derive(Clone, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        args: Vec<String>,
        plain: bool,
        parent_ignore_ctrl_c: bool,
        input_after_ms: Option<u64>,
        input: String,
        script: Option<String>,
        budget_ms: u64,
    }

    fn encode(text: &str) -> String {
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        crate::fs::encode_base64(&bytes)
    }

    fn phase(stage: &str) -> String {
        format!("[IO.File]::AppendAllText($env:{PHASE_ENV}, '{stage}' + [Environment]::NewLine)")
    }

    fn instrument(init: &str) -> String {
        let mut script = init.to_string();
        let constructor = init.split_once(';').expect("UTF8 constructor statement").0;
        assert!(constructor.starts_with("$utf8 = "));
        for (statement, label) in [
            (constructor, "utf8-constructor"),
            ("[Console]::InputEncoding = $utf8", "input-encoding"),
            ("[Console]::OutputEncoding = $utf8", "output-encoding"),
            ("$OutputEncoding = $utf8", "output-variable"),
        ] {
            assert_eq!(
                script.matches(statement).count(),
                1,
                "diagnostic init changed"
            );
            script = script.replacen(
                statement,
                &format!(
                    "{}; {statement}; {}",
                    phase(&format!("before-{label}")),
                    phase(&format!("after-{label}"))
                ),
                1,
            );
        }
        format!(
            "{}; {script}; {}",
            phase("script-entered"),
            phase("script-complete")
        )
    }

    fn cases(default_args: &[String], init: &str) -> Vec<Case> {
        assert_eq!(
            default_args.len(),
            5,
            "diagnostic requires the actual default shell args"
        );
        assert_eq!(default_args[3], "-EncodedCommand");
        assert_eq!(default_args[4], encode(init));
        let exact = Case {
            name: "exact-no-input".into(),
            args: default_args.to_vec(),
            plain: false,
            parent_ignore_ctrl_c: true,
            input_after_ms: None,
            input: String::new(),
            script: Some(init.into()),
            budget_ms: LIMIT_MS,
        };
        let instrumented = instrument(init);
        let mut stage_args = default_args.to_vec();
        stage_args[4] = encode(&instrumented);
        vec![
            exact.clone(),
            Case {
                name: "exact-focus-in".into(),
                input_after_ms: Some(250),
                input: "\u{1b}[I".into(),
                ..exact.clone()
            },
            Case {
                name: "exact-blank-cr".into(),
                input_after_ms: Some(250),
                input: "\r".into(),
                ..exact.clone()
            },
            Case {
                name: "interactive-no-init".into(),
                args: default_args[..3].to_vec(),
                script: None,
                ..exact.clone()
            },
            Case {
                name: "instrumented-no-input".into(),
                args: stage_args.clone(),
                script: Some(instrumented.clone()),
                ..exact.clone()
            },
            Case {
                name: "instrumented-focus-in".into(),
                args: stage_args,
                script: Some(instrumented.clone()),
                input_after_ms: Some(250),
                input: "\u{1b}[I".into(),
                ..exact.clone()
            },
            Case {
                name: "plain-noninteractive-instrumented".into(),
                args: vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    encode(&instrumented),
                ],
                plain: true,
                script: Some(instrumented),
                ..exact.clone()
            },
            Case {
                name: "exact-no-input-ordinary-parent".into(),
                parent_ignore_ctrl_c: false,
                ..exact
            },
        ]
    }

    fn resolve_shell(shell: &str) -> PathBuf {
        // Mirrors portable-pty 0.8.1's PATH/PATHEXT resolution, without logging
        // PATH or unrelated inherited environment values.
        if let Some(path) = std::env::var_os("PATH") {
            let extensions = std::env::var_os("PATHEXT").unwrap_or_else(|| ".EXE".into());
            for directory in std::env::split_paths(&path) {
                let candidate = directory.join(shell);
                if candidate.exists() {
                    return candidate;
                }
                for extension in std::env::split_paths(&extensions) {
                    let ext = extension.to_string_lossy();
                    let candidate = directory
                        .join(shell)
                        .with_extension(ext.trim_start_matches('.'));
                    if candidate.exists() {
                        return candidate;
                    }
                }
            }
        }
        PathBuf::from(shell)
    }

    fn pe_machine(path: &Path) -> Option<String> {
        let mut file = File::open(path).ok()?;
        file.seek(SeekFrom::Start(0x3c)).ok()?;
        let mut offset = [0; 4];
        file.read_exact(&mut offset).ok()?;
        file.seek(SeekFrom::Start(u32::from_le_bytes(offset) as u64))
            .ok()?;
        let mut header = [0; 6];
        file.read_exact(&mut header).ok()?;
        if &header[..4] != b"PE\0\0" {
            return None;
        }
        let machine = u16::from_le_bytes([header[4], header[5]]);
        Some(format!(
            "0x{machine:04x} ({})",
            match machine {
                0xaa64 => "arm64",
                0x8664 => "x64",
                0x14c => "x86",
                _ => "other",
            }
        ))
    }

    fn loaded_module(name: &str) -> Option<String> {
        let name: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        let mut buffer = vec![0; 32_768];
        let count = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
        (count > 0).then(|| String::from_utf16_lossy(&buffer[..count as usize]))
    }

    fn precondition(ignore: bool) -> Value {
        let mut result = unsafe { SetConsoleCtrlHandler(None, i32::from(ignore)) };
        let mut allocated = false;
        if result == 0 && std::io::Error::last_os_error().raw_os_error() == Some(6) {
            allocated = unsafe { AllocConsole() } != 0;
            if allocated {
                result = unsafe { SetConsoleCtrlHandler(None, i32::from(ignore)) };
            }
        }
        json!({"ignoreCtrlC":ignore,"established":result != 0,"allocatedConsole":allocated,
            "error": if result == 0 { Some(std::io::Error::last_os_error().to_string()) } else { None }})
    }

    #[derive(Default)]
    struct Capture {
        bytes: Vec<u8>,
        total: usize,
        first_ms: Option<u128>,
        chunks: Vec<Value>,
        trace: Option<File>,
    }

    fn reader_thread(
        mut reader: Box<dyn Read + Send>,
        start: Instant,
        capture: Arc<Mutex<Capture>>,
    ) -> mpsc::Receiver<Value> {
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            let result = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break json!({"eof":true,"elapsedMs":start.elapsed().as_millis()}),
                    Ok(count) => {
                        let mut log = capture.lock().unwrap();
                        let at = start.elapsed().as_millis();
                        if log.first_ms.is_none() {
                            log.first_ms = Some(at);
                        }
                        let keep = count.min(OUTPUT_CAP.saturating_sub(log.bytes.len()));
                        log.bytes.extend_from_slice(&buffer[..keep]);
                        if let Some(trace) = &mut log.trace {
                            let _ = trace.write_all(&buffer[..keep]);
                            let _ = trace.flush();
                        }
                        log.total += count;
                        if log.chunks.len() < 2048 {
                            log.chunks.push(json!({"elapsedMs":at,"bytes":count}));
                        }
                    }
                    Err(error) => {
                        break json!({"eof":false,"error":error.to_string(),"elapsedMs":start.elapsed().as_millis()})
                    }
                }
            };
            let _ = done_tx.send(result);
        });
        done_rx
    }

    fn run_case(case: &Case, shell: &str, cwd: &Path, phase_file: &Path, trace: File) -> Value {
        let parent = precondition(case.parent_ignore_ctrl_c);
        std::env::set_var(PHASE_ENV, phase_file);
        let start = Instant::now();
        let deadline = start + Duration::from_millis(case.budget_ms);
        let capture = Arc::new(Mutex::new(Capture {
            trace: Some(trace),
            ..Capture::default()
        }));
        let mut input = Value::Null;
        let mut spawned_ms = None;
        let mut child_exit = Value::Null;
        let mut pty: Option<SpawnedTerminal> = None;
        let mut plain = None;
        let mut readers = Vec::new();
        let spawn_error;
        if case.plain {
            match Command::new(shell)
                .args(&case.args)
                .current_dir(cwd)
                .env("TERM", "xterm-256color")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    spawned_ms = Some(start.elapsed().as_millis());
                    readers.push(reader_thread(
                        Box::new(child.stdout.take().unwrap()),
                        start,
                        Arc::clone(&capture),
                    ));
                    readers.push(reader_thread(
                        Box::new(child.stderr.take().unwrap()),
                        start,
                        Arc::clone(&capture),
                    ));
                    plain = Some(child);
                    spawn_error = None;
                }
                Err(error) => spawn_error = Some(error.to_string()),
            }
        } else {
            match spawn_shell(shell, &case.args, cwd, PtySize { rows: 24, cols: 80 }) {
                Ok(terminal) => {
                    spawned_ms = Some(start.elapsed().as_millis());
                    pty = Some(terminal);
                    spawn_error = None;
                }
                Err(error) => spawn_error = Some(error),
            }
        }
        let mut master = None;
        let mut child = None;
        let mut writer = None;
        if let Some(terminal) = pty.take() {
            readers.push(reader_thread(terminal.reader, start, Arc::clone(&capture)));
            master = Some(terminal.master);
            child = Some(terminal.child);
            writer = Some(terminal.writer);
        }
        let mut input_rx = None;
        let mut phase_observations = Vec::new();
        let mut previous_phase = String::new();
        while spawn_error.is_none() && Instant::now() < deadline {
            if let Some(delay) = case.input_after_ms {
                if input_rx.is_none()
                    && input.is_null()
                    && start.elapsed().as_millis() >= delay as u128
                {
                    if let Some(mut owned_writer) = writer.take() {
                        let data = case.input.clone();
                        let (tx, rx) = mpsc::channel();
                        input = json!({"requestedMs":start.elapsed().as_millis(),"dataBase64":crate::fs::encode_base64(data.as_bytes()),"completed":false});
                        std::thread::spawn(move || {
                            let result = owned_writer
                                .write_all(data.as_bytes())
                                .and_then(|_| owned_writer.flush());
                            let _ = tx.send((
                                owned_writer,
                                result.map_err(|error| error.to_string()),
                                start.elapsed().as_millis(),
                            ));
                        });
                        input_rx = Some(rx);
                    }
                }
            }
            if let Some(rx) = &input_rx {
                if let Ok((returned, result, at)) = rx.try_recv() {
                    writer = Some(returned);
                    input["completed"] = json!(true);
                    input["completedMs"] = json!(at);
                    input["result"] = json!(result);
                }
            }
            let phases = fs::read_to_string(phase_file).unwrap_or_default();
            if phases != previous_phase {
                phase_observations
                    .push(json!({"elapsedMs":start.elapsed().as_millis(),"text":phases}));
                previous_phase = phases;
            }
            if let Some(owned_child) = plain.as_mut() {
                if let Ok(Some(status)) = owned_child.try_wait() {
                    child_exit = json!({"code":status.code(),"success":status.success(),"elapsedMs":start.elapsed().as_millis()});
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let observation_ms = start.elapsed().as_millis();
        let input_writer_pending = input_rx.is_some() && writer.is_none();
        let writer_owner = if writer.is_some() {
            "released by cleanup"
        } else if input_writer_pending {
            "unknown: pending input writer; result receiver dropped"
        } else {
            "not created"
        };
        // A late send must release its returned writer rather than leaving it
        // queued after the cleanup receipt. Never wait for a blocked input.
        drop(input_rx);
        let (cleanup_tx, cleanup_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let kill = if let Some(mut child) = child {
                json!(child.kill())
            } else if let Some(mut child) = plain {
                json!(child.kill().map_err(|error| error.to_string()))
            } else {
                Value::Null
            };
            // Release master before an input writer that might still be blocked.
            drop(master);
            drop(writer);
            let _ = cleanup_tx.send(json!({"killRequest":kill,"masterAndChildOwnersDropped":true,"writerOwner":writer_owner,"inputWriterPendingAtCleanup":input_writer_pending}));
        });
        let cleanup_deadline = Instant::now() + Duration::from_millis(CLEANUP_MS);
        let cleanup = cleanup_rx
            .recv_timeout(Duration::from_millis(CLEANUP_MS))
            .unwrap_or(json!({"masterAndChildOwnersDropped":null,"writerOwner":"unknown: cleanup timed out","inputWriterPendingAtCleanup":input_writer_pending,"timedOut":true}));
        let reader_results: Vec<Value> = readers
            .into_iter()
            .map(|rx| {
                rx.recv_timeout(cleanup_deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or(json!({"eof":"unknown","timedOut":true}))
            })
            .collect();
        let log = capture.lock().unwrap();
        let text = String::from_utf8_lossy(&log.bytes);
        json!({"diagnosticOnly":true,"case":case,"parentPrecondition":parent,"spawnedMs":spawned_ms,"spawnError":spawn_error,
            "observationMs":observation_ms,"deadlineReached":observation_ms >= case.budget_ms as u128,"input":input,"output":text,"outputBase64":crate::fs::encode_base64(&log.bytes),
            "outputBytes":log.total,"outputTruncated":log.total > log.bytes.len(),"firstByteMs":log.first_ms,"chunks":log.chunks,
            "promptObserved":text.contains("PS ") && text.contains("中文 folder>"),
            "phaseObservations":phase_observations,"phaseFile":fs::read_to_string(phase_file).ok(),"childExit":child_exit,
            "childAliveAtDeadline":"unknown: production ChildControl intentionally exposes kill only",
            "cleanup":cleanup,"readerCompletion":reader_results,"loadedConptyDll":loaded_module("conpty.dll"),
            "loadedKernel32":loaded_module("kernel32.dll"),"profileEnvironment":"unchanged; -NoProfile; private disposable-runner cwd"})
    }

    fn write_json(path: &Path, value: &Value) {
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }

    pub(super) fn run((shell, args): (String, Vec<String>), init: &str) {
        let output = PathBuf::from(
            std::env::var_os("KEEPWORK_PTY_DIAGNOSTIC_OUTPUT")
                .expect("set KEEPWORK_PTY_DIAGNOSTIC_OUTPUT to an isolated artifact directory"),
        );
        fs::create_dir_all(&output).unwrap();
        let cases = cases(&args, init);
        if let Ok(name) = std::env::var("KEEPWORK_PTY_DIAGNOSTIC_CASE") {
            let case = cases
                .iter()
                .find(|case| case.name == name)
                .expect("known diagnostic case");
            let fixture =
                PathBuf::from(std::env::var_os("KEEPWORK_PTY_DIAGNOSTIC_FIXTURE").unwrap());
            let cwd = fixture.join("workspace/中文 folder");
            fs::create_dir_all(&cwd).unwrap();
            write_json(
                &output.join(format!("rust-{}.pending.json", case.name)),
                &json!({"diagnosticOnly":true,"case":case,"stage":"before-spawn","workerPid":std::process::id()}),
            );
            let trace = File::create(output.join(format!("rust-{}.raw", case.name))).unwrap();
            let result = run_case(case, &shell, &cwd, &fixture.join("phases.txt"), trace);
            write_json(&output.join(format!("rust-{}.json", case.name)), &result);
            println!("{}", serde_json::to_string(&result).unwrap());
            return;
        }
        let resolved = resolve_shell(&shell);
        let script_hash = format!("{:x}", Sha256::digest(init.as_bytes()));
        let manifest = json!({"diagnosticOnly":true,"acceptance":false,"sourceCommit":std::env::var("GITHUB_SHA").ok(),"shell":shell,"resolvedShell":resolved,"shellPeMachine":pe_machine(&resolved),
            "rustArch":std::env::consts::ARCH,"defaultInit":init,"defaultInitSha256":script_hash,"cases":cases,
            "safeEnvironment":{"ComSpec":std::env::var("ComSpec").ok(),"PSModulePath":std::env::var("PSModulePath").ok(),"PROCESSOR_ARCHITECTURE":std::env::var("PROCESSOR_ARCHITECTURE").ok()},
            "notes":["Each case has a 10s observation budget including spawn, then 2s cleanup; outer 14s watchdog includes test-process startup.","Focus-in is ESC[I; blank CR is 0d; each is sent once to a fresh private session at 250ms.","Instrumented script writes its own stage files and may alter timing.","Plain noninteractive and no-init results cannot substitute for interactive acceptance."]});
        write_json(&output.join("manifest.json"), &manifest);
        let mut results = Vec::new();
        for case in &cases {
            let fixture =
                std::env::temp_dir().join(format!("kw-pty-diag-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&fixture).unwrap();
            let log = File::create(output.join(format!("rust-{}.log", case.name))).unwrap();
            let mut worker = Command::new(std::env::current_exe().unwrap())
                .args([TEST, "--ignored", "--exact", "--nocapture"])
                .env("KEEPWORK_PTY_DIAGNOSTIC_CASE", &case.name)
                .env("KEEPWORK_PTY_DIAGNOSTIC_FIXTURE", &fixture)
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap();
            let start = Instant::now();
            let mut watchdog = false;
            let status = loop {
                if let Some(status) = worker.try_wait().unwrap() {
                    break Some(status.code());
                }
                if start.elapsed() >= Duration::from_millis(LIMIT_MS + CLEANUP_MS + 2_000) {
                    watchdog = true;
                    let _ = worker.kill();
                    // Reap only our coordinator-owned test process. Native
                    // cleanup has its separate bounded completion evidence.
                    for _ in 0..40 {
                        if worker.try_wait().ok().flatten().is_some() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    break None;
                }
                std::thread::sleep(Duration::from_millis(25));
            };
            let path = output.join(format!("rust-{}.json", case.name));
            let mut result = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or(json!({"diagnosticOnly":true,"case":case,"resultMissing":true}));
            if result["resultMissing"] == true {
                let trace =
                    fs::read(output.join(format!("rust-{}.raw", case.name))).unwrap_or_default();
                result["pendingOutputBase64"] = json!(crate::fs::encode_base64(&trace));
                result["pendingOutput"] = json!(String::from_utf8_lossy(&trace));
                result["pendingPhases"] =
                    json!(fs::read_to_string(fixture.join("phases.txt")).ok());
            }
            result["worker"] = json!({"exitCode":status,"watchdogTerminated":watchdog,"elapsedMs":start.elapsed().as_millis()});
            write_json(&path, &result);
            results.push(result);
            let _ = fs::remove_dir_all(fixture);
        }
        write_json(
            &output.join("rust-report.json"),
            &json!({"diagnosticOnly":true,"acceptance":false,"cases":results}),
        );
        println!(
            "Diagnostic observations saved to {}. These do not satisfy release acceptance.",
            output.display()
        );
    }
}
