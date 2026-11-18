//! Compatibility edition: use only existing system kernel32 ConPTY exports.
//! No modern API is statically imported, and no conpty.dll search is performed.
use super::native::{ChildControl, PtyControl, PtySize, SpawnedTerminal};
use std::ffi::c_void;
use std::fs::File;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::{Mutex, OnceLock};

type Handle = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy)]
struct Coord {
    x: i16,
    y: i16,
}
type Create = unsafe extern "system" fn(Coord, Handle, Handle, u32, *mut Handle) -> i32;
type Resize = unsafe extern "system" fn(Handle, Coord) -> i32;
type Close = unsafe extern "system" fn(Handle);

struct Api {
    create: Create,
    resize: Resize,
    close: Close,
}
struct Exports {
    present: [bool; 3],
    api: Option<Api>,
}

#[repr(C)]
struct StartupInfo {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_chars: u32,
    y_chars: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_bytes: u16,
    reserved_data: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}
#[repr(C)]
struct StartupInfoEx {
    startup: StartupInfo,
    attributes: Handle,
}
#[repr(C)]
struct ProcessInfo {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

// Every statically imported function below exists on the Windows 7 baseline.
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> Handle;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attributes: Handle, size: u32) -> i32;
    fn InitializeProcThreadAttributeList(
        list: Handle,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: Handle,
        flags: u32,
        attribute: usize,
        value: Handle,
        size: usize,
        previous: Handle,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: Handle);
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_attributes: Handle,
        thread_attributes: Handle,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        directory: *const u16,
        startup: *const StartupInfo,
        process: *mut ProcessInfo,
    ) -> i32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

fn exports() -> &'static Exports {
    static EXPORTS: OnceLock<Exports> = OnceLock::new();
    EXPORTS.get_or_init(|| {
        let name: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        let addresses = [
            b"CreatePseudoConsole\0".as_slice(),
            b"ResizePseudoConsole\0",
            b"ClosePseudoConsole\0",
        ]
        .map(|name| {
            if module.is_null() {
                null_mut()
            } else {
                unsafe { GetProcAddress(module, name.as_ptr()) }
            }
        });
        let present = addresses.map(|address| !address.is_null());
        let api = present.into_iter().all(|value| value).then(|| unsafe {
            Api {
                create: std::mem::transmute::<Handle, Create>(addresses[0]),
                resize: std::mem::transmute::<Handle, Resize>(addresses[1]),
                close: std::mem::transmute::<Handle, Close>(addresses[2]),
            }
        });
        Exports { present, api }
    })
}

pub(super) fn export_presence() -> [bool; 3] {
    exports().present
}

fn pipe() -> Result<(File, File), String> {
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, null_mut(), 0) } == 0 {
        return Err(format!(
            "Cannot create terminal pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

struct Attributes(Vec<usize>);
impl Attributes {
    fn new(console: Handle) -> Result<Self, String> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err("Cannot size terminal process attributes".into());
        }
        let mut storage = vec![0; bytes.div_ceil(std::mem::size_of::<usize>())];
        let pointer = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(format!(
                "Cannot initialize terminal process attributes: {}",
                std::io::Error::last_os_error()
            ));
        }
        let attributes = Self(storage);
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.pointer(),
                0,
                0x00020016,
                console,
                std::mem::size_of::<Handle>(),
                null_mut(),
                null_mut(),
            )
        } == 0
        {
            return Err(format!(
                "Cannot attach terminal process attributes: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(attributes)
    }
    fn pointer(&self) -> Handle {
        self.0.as_ptr().cast_mut().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

struct Master {
    api: &'static Api,
    console: Mutex<Option<usize>>,
}
impl PtyControl for Master {
    fn resize(&self, size: PtySize) -> Result<(), String> {
        let console = self.console.lock().expect("system console");
        let console = console.ok_or("terminal session is closed")?;
        let result = unsafe {
            (self.api.resize)(
                console as Handle,
                Coord {
                    x: size.cols as i16,
                    y: size.rows as i16,
                },
            )
        };
        if result != 0 {
            return Err(format!(
                "System terminal resize failed: HRESULT {result:#x}"
            ));
        }
        Ok(())
    }
}
impl Drop for Master {
    fn drop(&mut self) {
        let console = self.console.lock().expect("system console").take();
        if let Some(console) = console {
            unsafe { (self.api.close)(console as Handle) };
        }
    }
}
struct Child(OwnedHandle);
impl ChildControl for Child {
    fn kill(&mut self) -> Result<(), String> {
        if unsafe { TerminateProcess(self.0.as_raw_handle(), 1) } != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        let mut code = 259;
        if unsafe { GetExitCodeProcess(self.0.as_raw_handle(), &mut code) } != 0 && code != 259 {
            return Ok(());
        }
        Err(error.to_string())
    }
}

// A failed setup still drains the console output before closing its master:
// ClosePseudoConsole may otherwise block while flushing the output pipe.
struct Opening {
    master: Option<Master>,
    reader: Option<File>,
    writer: Option<File>,
}
impl Drop for Opening {
    fn drop(&mut self) {
        if let Some(master) = self.master.take() {
            if let Some(mut reader) = self.reader.take() {
                std::thread::spawn(move || {
                    let _ = std::io::copy(&mut reader, &mut std::io::sink());
                });
            }
            drop(master);
        }
    }
}

pub(super) fn spawn(args: &[String], cwd: &Path, size: PtySize) -> Result<SpawnedTerminal, String> {
    let api = exports()
        .api
        .as_ref()
        .ok_or("System terminal API is unavailable")?;
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut console = null_mut();
    // Standard documented flags: no cursor inheritance or private modes.
    let result = unsafe {
        (api.create)(
            Coord {
                x: size.cols as i16,
                y: size.rows as i16,
            },
            input_read.as_raw_handle(),
            output_write.as_raw_handle(),
            0,
            &mut console,
        )
    };
    if result != 0 || console.is_null() {
        return Err(format!(
            "System terminal creation failed: HRESULT {result:#x}"
        ));
    }
    let mut opening = Opening {
        master: Some(Master {
            api,
            console: Mutex::new(Some(console as usize)),
        }),
        reader: Some(output_read),
        writer: Some(input_write),
    };
    drop(input_read);
    drop(output_write);
    let attributes = Attributes::new(console)?;
    let mut startup: StartupInfoEx = unsafe { std::mem::zeroed() };
    startup.startup.cb = std::mem::size_of::<StartupInfoEx>() as u32;
    startup.startup.flags = 0x100; // STARTF_USESTDHANDLES; do not inherit redirected daemon output.
    startup.startup.stdin = -1isize as Handle;
    startup.startup.stdout = -1isize as Handle;
    startup.startup.stderr = -1isize as Handle;
    startup.attributes = attributes.pointer();
    let shell = super::winpty::system_shell()?;
    let application = super::winpty::wide(&shell)?;
    let command = std::iter::once(shell.as_str())
        .chain(args.iter().map(String::as_str))
        .map(super::winpty::quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = super::winpty::wide(command)?;
    let directory = super::winpty::wide(cwd)?;
    let environment = super::winpty::environment();
    let mut process: ProcessInfo = unsafe { std::mem::zeroed() };
    super::native::restore_ctrl_c()?;
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null_mut(),
            null_mut(),
            0,
            0x00080400,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup.startup,
            &mut process,
        )
    } == 0
    {
        return Err(format!(
            "Cannot start the system terminal shell: {}",
            std::io::Error::last_os_error()
        ));
    }
    if process.process.is_null() || process.thread.is_null() {
        unsafe {
            if !process.process.is_null() {
                TerminateProcess(process.process, 1);
                CloseHandle(process.process);
            }
            if !process.thread.is_null() {
                CloseHandle(process.thread);
            }
        }
        return Err("System terminal shell did not return owned process handles".into());
    }
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.thread) };
    let process = unsafe { OwnedHandle::from_raw_handle(process.process) };
    Ok(SpawnedTerminal {
        master: Box::new(opening.master.take().expect("opened console")),
        child: Box::new(Child(process)),
        reader: Box::new(opening.reader.take().expect("console reader")),
        writer: Box::new(opening.writer.take().expect("console writer")),
        backend: Some("conpty"),
    })
}

#[cfg(all(test, target_pointer_width = "64"))]
mod tests {
    use super::*;

    #[test]
    fn process_structures_match_the_windows_64_bit_abi() {
        assert_eq!(std::mem::size_of::<Coord>(), 4);
        assert_eq!(std::mem::size_of::<StartupInfo>(), 104);
        assert_eq!(std::mem::size_of::<StartupInfoEx>(), 112);
        assert_eq!(std::mem::offset_of!(StartupInfo, flags), 60);
        assert_eq!(std::mem::offset_of!(StartupInfo, stdin), 80);
        assert_eq!(std::mem::offset_of!(StartupInfoEx, attributes), 104);
        assert_eq!(std::mem::size_of::<ProcessInfo>(), 24);
    }
}
