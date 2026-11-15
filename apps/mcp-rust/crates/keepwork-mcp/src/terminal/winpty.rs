//! Windows 7/8 real console PTY. Only the pinned app-local WinPTY release may
//! load; missing assets never prevent ordinary MCP startup. No PATH/CWD search,
//! ConPTY, redirected-pipe shell substitute, Node, or arbitrary DLL loading.
use super::native::{ChildControl, PtyControl, PtySize, SpawnedTerminal};
use super::readiness::{Failure, Readiness, Work};
use sha2::{Digest, Sha256};
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::null_mut;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

type Ptr = *mut c_void;
type Error = Ptr;
type ConfigNew = unsafe extern "C" fn(u64, *mut Error) -> Ptr;
type ConfigFree = unsafe extern "C" fn(Ptr);
type ConfigSize = unsafe extern "C" fn(Ptr, i32, i32);
type ConfigTimeout = unsafe extern "C" fn(Ptr, u32);
type Open = unsafe extern "C" fn(Ptr, *mut Error) -> Ptr;
type PipeName = unsafe extern "C" fn(Ptr) -> *const u16;
type SpawnConfigNew =
    unsafe extern "C" fn(u64, *const u16, *const u16, *const u16, *const u16, *mut Error) -> Ptr;
type Spawn = unsafe extern "C" fn(Ptr, Ptr, *mut Ptr, *mut Ptr, *mut u32, *mut Error) -> i32;
type SetSize = unsafe extern "C" fn(Ptr, i32, i32, *mut Error) -> i32;
type ErrorMsg = unsafe extern "C" fn(Error) -> *const u16;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: Ptr, flags: u32) -> Ptr;
    fn GetProcAddress(module: Ptr, name: *const u8) -> Ptr;
    fn GetModuleFileNameW(module: Ptr, buffer: *mut u16, size: u32) -> u32;
    fn FreeLibrary(module: Ptr) -> i32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: Ptr,
        creation: u32,
        flags: u32,
        template: Ptr,
    ) -> Ptr;
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

struct Api {
    // Retained for the lifetime of this process so all live function pointers
    // and reader threads remain valid. The library has only OS DLL imports.
    _module: usize,
    agent: std::path::PathBuf,
    config_new: ConfigNew,
    config_free: ConfigFree,
    config_size: ConfigSize,
    config_timeout: ConfigTimeout,
    open: Open,
    conin: PipeName,
    conout: PipeName,
    spawn_config_new: SpawnConfigNew,
    spawn_config_free: ConfigFree,
    spawn: Spawn,
    set_size: SetSize,
    free: ConfigFree,
    error_msg: ErrorMsg,
    error_free: ConfigFree,
}

const DLL_HASH: &str = "936f611c2129600d35ab7aad45546a837f4f3a9ca7f673e5d66b48c313b9cd75";
const AGENT_HASH: &str = "9add1a61155ec47cf6f347faf776b746eebbde1dc9360d81b8a909da34650642";

fn wide(value: impl AsRef<OsStr>) -> Result<Vec<u16>, String> {
    let mut units: Vec<_> = value.as_ref().encode_wide().collect();
    if units.contains(&0) {
        return Err("terminal path or argument contains NUL".into());
    }
    units.push(0);
    Ok(units)
}

fn verify(path: &Path, expected: &str) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|_| format!("Bundled terminal backend is missing: {}", path.display()))?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(format!(
            "Bundled terminal backend checksum mismatch: {}",
            path.display()
        ));
    }
    Ok(())
}

impl Api {
    fn load() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let directory = exe
            .parent()
            .ok_or("terminal executable directory is unavailable")?;
        // current_exe is absolute. The official DLL locates its agent adjacent
        // to itself, so neither asset may be resolved against caller input.
        let dll = directory.join("winpty.dll");
        verify(&dll, DLL_HASH)?;
        verify(&directory.join("winpty-agent.exe"), AGENT_HASH)?;
        let name = wide(&dll)?;
        // LOAD_WITH_ALTERED_SEARCH_PATH accepts an absolute DLL on unpatched
        // Win7. This pinned DLL's dependency closure contains only OS DLLs.
        let module = unsafe { LoadLibraryExW(name.as_ptr(), null_mut(), 0x8) };
        if module.is_null() {
            return Err(format!(
                "Cannot load bundled terminal backend: {}",
                std::io::Error::last_os_error()
            ));
        }
        let loaded = (|| {
            let mut actual = vec![0u16; 32768];
            let length =
                unsafe { GetModuleFileNameW(module, actual.as_mut_ptr(), actual.len() as u32) }
                    as usize;
            if length == 0 || length >= actual.len() {
                return Err("Cannot verify loaded terminal backend path".into());
            }
            actual.truncate(length);
            let actual = std::path::PathBuf::from(OsString::from_wide(&actual));
            let expected = std::fs::canonicalize(&dll).map_err(|error| error.to_string())?;
            let canonical = std::fs::canonicalize(&actual).map_err(|error| error.to_string())?;
            if !canonical
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy())
            {
                return Err("Loaded terminal backend is outside its bundled directory".into());
            }
            verify(&actual, DLL_HASH)?;
            macro_rules! symbol {
                ($name:literal, $kind:ty) => {{
                    let address = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) };
                    if address.is_null() {
                        return Err(format!("Terminal backend export is missing: {}", $name));
                    }
                    unsafe { std::mem::transmute::<Ptr, $kind>(address) }
                }};
            }
            Ok(Self {
                _module: module as usize,
                agent: directory.join("winpty-agent.exe"),
                config_new: symbol!("winpty_config_new", ConfigNew),
                config_free: symbol!("winpty_config_free", ConfigFree),
                config_size: symbol!("winpty_config_set_initial_size", ConfigSize),
                config_timeout: symbol!("winpty_config_set_agent_timeout", ConfigTimeout),
                open: symbol!("winpty_open", Open),
                conin: symbol!("winpty_conin_name", PipeName),
                conout: symbol!("winpty_conout_name", PipeName),
                spawn_config_new: symbol!("winpty_spawn_config_new", SpawnConfigNew),
                spawn_config_free: symbol!("winpty_spawn_config_free", ConfigFree),
                spawn: symbol!("winpty_spawn", Spawn),
                set_size: symbol!("winpty_set_size", SetSize),
                free: symbol!("winpty_free", ConfigFree),
                error_msg: symbol!("winpty_error_msg", ErrorMsg),
                error_free: symbol!("winpty_error_free", ConfigFree),
            })
        })();
        if loaded.is_err() {
            unsafe {
                FreeLibrary(module);
            }
        }
        loaded
    }

    fn error(&self, error: Error, fallback: &str) -> String {
        if error.is_null() {
            return fallback.into();
        }
        let message = unsafe { (self.error_msg)(error) };
        let text = if message.is_null() {
            fallback.into()
        } else {
            let mut length = 0;
            unsafe {
                while length < 32768 && *message.add(length) != 0 {
                    length += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(message, length))
            }
        };
        unsafe {
            (self.error_free)(error);
        }
        text
    }

    fn verified_agent(&self) -> Result<File, String> {
        // Hold a read-only, FILE_SHARE_READ handle through winpty_open so an
        // agent verified earlier cannot be replaced before CreateProcess.
        // The loaded DLL stays mapped; its fixed adjacent agent is checked on
        // every actual agent spawn, including the initial readiness probe.
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&self.agent)
            .map_err(|_| "Bundled terminal agent is missing or unavailable")?;
        if file.metadata().map_err(|error| error.to_string())?.len() != 727552 {
            return Err("Bundled terminal agent checksum mismatch".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 16384];
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != AGENT_HASH {
            return Err("Bundled terminal agent checksum mismatch".into());
        }
        Ok(file)
    }

    fn open_instance(&self, size: PtySize, timeout: u32) -> Result<Ptr, String> {
        let mut error = null_mut();
        let config = unsafe { (self.config_new)(0, &mut error) };
        if config.is_null() {
            return Err(self.error(error, "terminal configuration failed"));
        }
        let instance = unsafe {
            (self.config_size)(config, size.cols as i32, size.rows as i32);
            (self.config_timeout)(config, timeout);
            let opened = (self.open)(config, &mut error);
            (self.config_free)(config);
            opened
        };
        if instance.is_null() {
            return Err(self.error(error, "terminal agent could not start"));
        }
        Ok(instance)
    }

    fn probe(&self) -> Result<(), String> {
        // Prove that this OS can initialize the hidden console/agent before
        // advertising a real PTY. The caller retains a verified agent handle.
        // This runs on a dedicated worker, never in a health/HTTP executor.
        // No shell or user command is started here.
        let instance = self.open_instance(PtySize { rows: 24, cols: 80 }, 5000)?;
        unsafe {
            (self.free)(instance);
        }
        Ok(())
    }
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(Api::load).as_ref().map_err(Clone::clone)
}
struct Controller {
    epoch: Instant,
    state: Mutex<Readiness>,
}
impl Controller {
    fn now(&self) -> Duration {
        self.epoch.elapsed()
    }

    fn work(&self, work: Work) -> Result<(), Failure> {
        let api = api().map_err(|error| {
            let _ = writeln!(std::io::stderr(), "keepwork-mcp: terminal backend load failed: {error}");
            Failure::Permanent("Bundled terminal backend could not be loaded or verified. Reinstall the complete compatibility runtime and restart the local service.")
        })?;
        let _agent = api.verified_agent().map_err(|error| {
            let _ = writeln!(std::io::stderr(), "keepwork-mcp: terminal backend integrity check failed: {error}");
            Failure::Permanent("Bundled terminal agent is missing, modified or unavailable. Reinstall the complete compatibility runtime and restart the local service.")
        })?;
        if work == Work::Probe {
            api.probe().map_err(|error| {
                let _ = writeln!(std::io::stderr(), "keepwork-mcp: terminal readiness probe failed: {error}");
                Failure::Transient("Terminal backend initialization failed. It will retry automatically; check Windows security software if this continues.")
            })?;
        }
        Ok(())
    }
}

/// The first call returns immediately, and concurrent health/SSE requests never
/// launch duplicate probes. Transient startup failures retry at a bounded rate;
/// fixed-asset failures stay closed until the corrected runtime is restarted.
pub fn health() -> super::TerminalHealth {
    static CONTROLLER: OnceLock<Controller> = OnceLock::new();
    let controller = CONTROLLER.get_or_init(|| Controller {
        epoch: Instant::now(),
        state: Mutex::new(Readiness::default()),
    });
    let work = controller
        .state
        .lock()
        .expect("terminal readiness")
        .begin(controller.now());
    if let Some(work) = work {
        if std::thread::Builder::new()
            .name("winpty-readiness".into())
            .spawn(move || {
                let result = controller.work(work);
                controller
                    .state
                    .lock()
                    .expect("terminal readiness")
                    .finish(controller.now(), result);
            })
            .is_err()
        {
            controller.state.lock().expect("terminal readiness").finish(
                controller.now(),
                Err(Failure::Transient(
                    "Terminal readiness worker could not start. It will retry automatically.",
                )),
            );
        }
    }
    controller
        .state
        .lock()
        .expect("terminal readiness")
        .health()
}

struct Shared {
    api: &'static Api,
    // A WinPTY instance is thread safe. Serialize resize/free so an explicit
    // close cannot free it while another request is resizing it.
    instance: Mutex<Option<usize>>,
}
impl Shared {
    fn close(&self) {
        if let Some(instance) = self.instance.lock().expect("winpty instance").take() {
            // Closing the agent's control pipe closes only its own hidden
            // console, which terminates the owned shell and attached children.
            unsafe {
                (self.api.free)(instance as Ptr);
            }
        }
    }
}
impl Drop for Shared {
    fn drop(&mut self) {
        self.close();
    }
}
struct Master(Arc<Shared>);
impl PtyControl for Master {
    fn resize(&self, size: PtySize) -> Result<(), String> {
        let instance = self.0.instance.lock().expect("winpty instance");
        let instance = instance.ok_or("terminal session is closed")?;
        let mut error = null_mut();
        if unsafe {
            (self.0.api.set_size)(
                instance as Ptr,
                size.cols as i32,
                size.rows as i32,
                &mut error,
            )
        } == 0
        {
            return Err(self.0.api.error(error, "terminal resize failed"));
        }
        Ok(())
    }
}
struct Child(Arc<Shared>);
impl ChildControl for Child {
    fn kill(&mut self) -> Result<(), String> {
        self.0.close();
        Ok(())
    }
}

// Standard CreateProcess argument quoting, including trailing backslashes.
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        result.push(ch);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

fn environment() -> Vec<u16> {
    let mut variables: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case("TERM"))
        .collect();
    variables.push(("TERM".into(), "xterm-256color".into()));
    variables.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in variables {
        block.extend(key.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

pub fn spawn(
    _shell: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
) -> Result<SpawnedTerminal, String> {
    let readiness = health();
    if !readiness.ready {
        return Err(readiness
            .reason
            .unwrap_or("Terminal backend is initializing; retry shortly.")
            .into());
    }
    let api = api()?;
    let _agent = api.verified_agent()?;
    let mut error = null_mut();
    let instance = api.open_instance(size, 5000)?;
    let shared = Arc::new(Shared {
        api,
        instance: Mutex::new(Some(instance as usize)),
    });
    let open_pipe = |name: *const u16, access| -> Result<File, String> {
        if name.is_null() {
            return Err("terminal pipe is unavailable".into());
        }
        let handle = unsafe { CreateFileW(name, access, 0, null_mut(), 3, 0, null_mut()) };
        if handle as isize == -1 {
            return Err(format!(
                "Cannot connect terminal pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    };
    let reader = open_pipe(unsafe { (api.conout)(instance) }, 0x8000_0000)?;
    let writer = open_pipe(unsafe { (api.conin)(instance) }, 0x4000_0000)?;
    // Use the inbox PowerShell at a system absolute path, never a similarly
    // named executable in the workspace or PATH. This exists on Win7 SP1.
    let mut system = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if length == 0 || length >= system.len() {
        return Err("Windows system directory is unavailable".into());
    }
    system.truncate(length);
    let shell = format!(
        "{}\\WindowsPowerShell\\v1.0\\powershell.exe",
        String::from_utf16_lossy(&system)
    );
    let app = wide(&shell)?;
    let command = std::iter::once(shell.as_str())
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let command = wide(command)?;
    let directory = wide(cwd)?;
    let environment = environment();
    let config = unsafe {
        (api.spawn_config_new)(
            3,
            app.as_ptr(),
            command.as_ptr(),
            directory.as_ptr(),
            environment.as_ptr(),
            &mut error,
        )
    };
    if config.is_null() {
        return Err(api.error(error, "terminal shell configuration failed"));
    }
    // No process/thread handles requested: this instance's control-pipe
    // ownership is the only termination authority, including descendants.
    let success = unsafe {
        let result = (api.spawn)(
            instance,
            config,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut error,
        );
        (api.spawn_config_free)(config);
        result
    };
    if success == 0 {
        return Err(api.error(error, "terminal shell could not start"));
    }
    Ok(SpawnedTerminal {
        master: Box::new(Master(Arc::clone(&shared))),
        child: Box::new(Child(shared)),
        reader: Box::new(reader),
        writer: Box::new(writer),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_argument_quoting_does_not_create_shell_tokens() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\\\"b\\"), "\"a\\\\\\\"b\\\\\"");
        assert!(wide("invalid\0path").is_err());
    }
}
