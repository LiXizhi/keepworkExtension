use crate::files::{atomic_json_write, inside, validate_relative_path};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const FIRST_SOURCE_PORT: u16 = 3001;
const SOURCE_PORT_COUNT: u16 = 100;
static SOURCE_PORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
struct SourcePortBinding {
    root: PathBuf,
    entry: String,
    port: u16,
}

#[derive(Deserialize, Serialize)]
struct SourcePortBindings {
    version: u8,
    entries: Vec<SourcePortBinding>,
}

struct SourcePortRegistryLock {
    _file: fs::File,
}

#[cfg(unix)]
impl std::os::fd::AsRawFd for SourcePortRegistryLock {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self._file.as_raw_fd()
    }
}

impl Drop for SourcePortRegistryLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // fork/dup may retain the open-file description after this owner
            // closes it. End our transaction explicitly before closing the file.
            unsafe { libc::flock(self.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

fn lock_source_port_registry(bindings_path: &Path) -> Result<SourcePortRegistryLock, String> {
    if let Some(parent) = bindings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot prepare source port registry: {e}"))?;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A zero share mode excludes other opens until this handle is dropped.
        options.share_mode(0);
    }
    let lock = options
        .open(bindings_path.with_extension("lock"))
        .map_err(|e| format!("Cannot lock source port registry: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // The stable lock file is separate from the atomically replaced JSON.
        // The guard explicitly unlocks at the end of the transaction.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(format!(
                "Cannot lock source port registry: {}. Retry when the other launch finishes.",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(SourcePortRegistryLock { _file: lock })
}

fn source_identity(source_dir: &Path, entry_file: &str) -> Result<(PathBuf, String), String> {
    let root = dunce::canonicalize(source_dir).map_err(|e| {
        format!(
            "Cannot resolve AIChat source directory {}: {e}",
            source_dir.display()
        )
    })?;
    let entry = validate_relative_path(entry_file)?;
    let target = dunce::canonicalize(root.join(&entry))
        .map_err(|e| format!("Cannot resolve AIChat entry file: {e}"))?;
    if !inside(&root, &target) || !target.is_file() {
        return Err("AIChat entry file must remain inside its source directory".to_string());
    }
    Ok((root, entry.to_string_lossy().into_owned()))
}

fn bind_source_origin(
    root: &Path,
    entry: &str,
    bindings_path: &Path,
    first_port: u16,
    port_count: u16,
) -> Result<TcpListener, String> {
    let end = first_port
        .checked_add(port_count.saturating_sub(1))
        .filter(|_| first_port != 0 && port_count != 0)
        .ok_or_else(|| "Invalid source server port range".to_string())?;
    // Source startup precedes the desktop's single-instance check, so both
    // threads and processes must serialize the read/reserve/commit transaction.
    let _guard = SOURCE_PORT_LOCK
        .lock()
        .map_err(|_| "Source port registry lock poisoned")?;
    let _file_lock = lock_source_port_registry(bindings_path)?;
    let mut bindings = match fs::read(bindings_path) {
        Ok(bytes) => serde_json::from_slice::<SourcePortBindings>(&bytes).map_err(|e| {
            format!(
                "Invalid source port registry {}: {e}",
                bindings_path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SourcePortBindings {
            version: 1,
            entries: Vec::new(),
        },
        Err(e) => {
            return Err(format!(
                "Cannot read source port registry {}: {e}",
                bindings_path.display()
            ))
        }
    };
    let mut ports = HashSet::new();
    let mut identities = HashSet::new();
    if bindings.version != 1
        || bindings.entries.iter().any(|binding| {
            !binding.root.is_absolute()
                || validate_relative_path(&binding.entry).is_err()
                || !(first_port..=end).contains(&binding.port)
                || !ports.insert(binding.port)
                || !identities.insert((binding.root.clone(), binding.entry.clone()))
        })
    {
        return Err(
            "Invalid source port registry: unsupported version or conflicting bindings".to_string(),
        );
    }
    if let Some(binding) = bindings
        .entries
        .iter()
        .find(|b| b.root == root && b.entry == entry)
    {
        return TcpListener::bind(("127.0.0.1", binding.port)).map_err(|e| {
            format!("Cannot reuse saved local source address 127.0.0.1:{}: {e}. The saved origin was not changed; close the program using that port and retry.", binding.port)
        });
    }
    for port in first_port..=end {
        if ports.contains(&port) {
            continue;
        }
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => {
                return Err(format!(
                    "Failed to bind local source address 127.0.0.1:{port}: {e}"
                ))
            }
        };
        bindings.entries.push(SourcePortBinding {
            root: root.to_path_buf(),
            entry: entry.to_string(),
            port,
        });
        // Commit while the socket reserves the port, before serving or
        // replacing any current page. A failed save drops only this listener.
        atomic_json_write(bindings_path, &bindings)
            .map_err(|e| format!("Cannot save source port registry: {e}"))?;
        return Ok(listener);
    }
    Err(format!(
        "No unreserved local source port available in {first_port}..={end}"
    ))
}

pub struct DevServer {
    port: u16,
    root_dir: PathBuf,
    entry_file: String,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn write_http_response(
    mut stream: TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn handle_client(mut stream: TcpStream, root_dir: &Path, entry_file: &str) {
    let mut buf = [0u8; 8192];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let Some(first_line) = req.lines().next() else {
        return;
    };
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        write_http_response(
            stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
            method == "HEAD",
        );
        return;
    }

    let path_part = raw_target.split('?').next().unwrap_or("/");
    let decoded =
        url::form_urlencoded::parse(format!("p={}", path_part.trim_start_matches('/')).as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())
            .unwrap_or_else(|| path_part.trim_start_matches('/').to_string());

    let rel_str = if decoded.is_empty() || decoded == "/" {
        entry_file
    } else {
        decoded.as_str()
    };

    let Ok(rel_buf) = validate_relative_path(rel_str) else {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    };

    let candidate = root_dir.join(&rel_buf);
    if !inside(root_dir, &candidate) {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    }

    let Ok(real_target) = dunce::canonicalize(&candidate) else {
        write_http_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
            method == "HEAD",
        );
        return;
    };

    if !inside(root_dir, &real_target) || !real_target.is_file() {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    }

    match fs::read(&real_target) {
        Ok(bytes) => {
            write_http_response(
                stream,
                "200 OK",
                content_type_for(&real_target),
                &bytes,
                method == "HEAD",
            );
        }
        Err(_) => {
            write_http_response(
                stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"Not Found",
                method == "HEAD",
            );
        }
    }
}

impl DevServer {
    pub fn start(
        source_dir: &Path,
        entry_file: &str,
        bindings_path: &Path,
    ) -> Result<Self, String> {
        Self::start_in_port_range(
            source_dir,
            entry_file,
            bindings_path,
            FIRST_SOURCE_PORT,
            SOURCE_PORT_COUNT,
        )
    }

    fn start_in_port_range(
        source_dir: &Path,
        entry_file: &str,
        bindings_path: &Path,
        first_port: u16,
        port_count: u16,
    ) -> Result<Self, String> {
        let (root_dir, entry_file) = source_identity(source_dir, entry_file)?;
        let listener = bind_source_origin(
            &root_dir,
            &entry_file,
            bindings_path,
            first_port,
            port_count,
        )?;
        Self::serve_listener(listener, root_dir, entry_file)
    }

    fn serve_listener(
        listener: TcpListener,
        root_dir: PathBuf,
        entry_file: String,
    ) -> Result<Self, String> {
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to query local server address: {e}"))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure nonblocking listener: {e}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop_flag);
        let thread_root = root_dir.clone();
        let thread_entry = entry_file.to_string();

        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _addr)) => {
                        let _ = stream.set_nonblocking(false);
                        let r = thread_root.clone();
                        let e = thread_entry.clone();
                        thread::spawn(move || handle_client(stream, &r, &e));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            port,
            root_dir,
            entry_file: entry_file.to_string(),
            stop_flag,
            handle: Some(handle),
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.entry_file)
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    /// Reuse an already-running source, or prepare its replacement completely
    /// before dropping the previous listener. Failure preserves the old page.
    pub fn select_source(
        current: &mut Option<Self>,
        source_dir: &Path,
        entry_file: &str,
        bindings_path: &Path,
    ) -> Result<String, String> {
        Self::select_source_in_port_range(
            current,
            source_dir,
            entry_file,
            bindings_path,
            FIRST_SOURCE_PORT,
            SOURCE_PORT_COUNT,
        )
    }

    fn select_source_in_port_range(
        current: &mut Option<Self>,
        source_dir: &Path,
        entry_file: &str,
        bindings_path: &Path,
        first_port: u16,
        port_count: u16,
    ) -> Result<String, String> {
        let (root, entry) = source_identity(source_dir, entry_file)?;
        if let Some(server) = current.as_ref() {
            if server.root_dir == root && server.entry_file == entry && server.handle.is_some() {
                return Ok(server.url());
            }
        }
        let server =
            Self::start_in_port_range(&root, &entry, bindings_path, first_port, port_count)?;
        let url = server.url();
        *current = Some(server);
        Ok(url)
    }

    pub fn stop(&mut self) {
        if let Some(h) = self.handle.take() {
            self.stop_flag.store(true, Ordering::Relaxed);
            // The accept loop polls a nonblocking listener, so it notices the
            // flag on its own. Do not wake it with a loopback connect: the
            // accepted socket stays bound to the saved origin for a moment
            // after this returns, and macOS refuses to rebind that port until
            // the connection is gone.
            let _ = h.join();
        }
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    static TEST_PORT_LOCK: Mutex<()> = Mutex::new(());

    fn isolated_origin_test() -> bool {
        const CHILD_TEST: &str = "AICHAT_SOURCE_ORIGIN_TEST";
        let thread = thread::current();
        let name = thread.name().expect("named libtest thread");
        if std::env::var(CHILD_TEST).as_deref() == Ok(name) {
            return false;
        }
        // Other libtests spawn PTYs with fork/pre_exec. Even CLOEXEC sockets
        // remain inherited until exec, so a concurrent child can retain our
        // listener after stop joins its thread. Create these sockets only in a
        // fresh, single-test process; do not retry or change a saved origin.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([name, "--exact", "--nocapture", "--test-threads=1"])
            .env(CHILD_TEST, name)
            .spawn()
            .expect("spawn isolated origin test");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    assert!(status.success(), "isolated origin test failed: {status}");
                    return true;
                }
                Ok(None) if std::time::Instant::now() < deadline => {
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("isolated origin test did not finish: {result:?}");
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn registry_owner_releases_lock_while_an_inherited_descriptor_remains_open() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let root = std::env::temp_dir().join(format!("aichat-registry-fd-{}", Uuid::new_v4()));
        let registry = root.join("source-ports.json");
        let owner = lock_source_port_registry(&registry).unwrap();
        let duplicate = unsafe { libc::dup(owner.as_raw_fd()) };
        assert!(duplicate >= 0);
        // dup shares the same open-file description, just like fork before exec.
        let inherited = unsafe { fs::File::from_raw_fd(duplicate) };
        assert!(
            lock_source_port_registry(&registry).is_err(),
            "a live owner must exclude another launch"
        );
        drop(owner);
        let replacement = lock_source_port_registry(&registry)
            .expect("dropping the transaction owner must release the lock before inherited descriptors close");
        assert!(
            lock_source_port_registry(&registry).is_err(),
            "the replacement still owns an exclusive lock"
        );
        drop(inherited);
        assert!(
            lock_source_port_registry(&registry).is_err(),
            "closing an old descriptor must not unlock the replacement"
        );
        drop(replacement);
        drop(lock_source_port_registry(&registry).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    fn source_fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("aichat-rust-devsrv-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::write(
            root.join("source/AIChat.html"),
            "<!doctype html><title>Origin</title>",
        )
        .unwrap();
        let registry = root.join("profile/source-ports.json");
        (root, registry)
    }

    fn fixture() -> (PathBuf, PathBuf, u16, DevServer) {
        let (root, registry) = source_fixture();
        // Allocate through production code and retain its real listener. A
        // probe followed by close leaves a race before the actual first bind.
        let first = 20000 + (Uuid::new_v4().as_u128() % 9000) as u16;
        let server = DevServer::start_in_port_range(
            &root.join("source"),
            "AIChat.html",
            &registry,
            first,
            8,
        )
        .expect("allocate isolated source listener");
        (root, registry, first, server)
    }

    fn occupied_port_fixture() -> (PathBuf, PathBuf, u16, TcpListener) {
        let (root, registry) = source_fixture();
        // Keep the occupied socket itself, rather than probing, releasing and
        // rebinding a port another test process can claim in between.
        let listener = (0..1000)
            .find_map(|_| {
                let port = 20000 + (Uuid::new_v4().as_u128() % 9000) as u16;
                match TcpListener::bind(("127.0.0.1", port)) {
                    Ok(listener) => Some(listener),
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => None,
                    Err(error) => panic!("Cannot bind occupied-port fixture: {error}"),
                }
            })
            .expect("isolated occupied test port unavailable");
        let port = listener.local_addr().unwrap().port();
        (root, registry, port, listener)
    }

    #[test]
    fn restarting_same_source_preserves_origin() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, mut first) = fixture();
        let original = first.url();
        first.stop();
        let mut second =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .unwrap();
        assert_eq!(
            second.url(),
            original,
            "restarting must preserve the browser storage origin"
        );
        let mut request = TcpStream::connect(("127.0.0.1", second.port)).unwrap();
        request
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        request
            .write_all(b"GET /AIChat.html HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        request.read_to_string(&mut response).unwrap();
        assert!(response.contains("200 OK") && response.contains("<title>Origin</title>"));
        second.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn inherited_listener_conflict_preserves_origin_until_owned_child_releases_it() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, mut server) = fixture();
        let original = server.url();
        let before = fs::read(&registry).unwrap();

        struct InheritedListener {
            pid: libc::pid_t,
            release: Option<fs::File>,
        }
        impl Drop for InheritedListener {
            fn drop(&mut self) {
                // Release only our child, and always reap it, including panic.
                drop(self.release.take());
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    let result =
                        unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), libc::WNOHANG) };
                    if result == self.pid {
                        break;
                    }
                    if result < 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD)
                    {
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        unsafe {
                            libc::kill(self.pid, libc::SIGKILL);
                            loop {
                                let reaped = libc::waitpid(self.pid, std::ptr::null_mut(), 0);
                                if reaped == self.pid
                                    || std::io::Error::last_os_error().raw_os_error()
                                        != Some(libc::EINTR)
                                {
                                    break;
                                }
                            }
                        }
                        break;
                    }
                    thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
        let mut ready = [0; 2];
        let mut release = [0; 2];
        assert_eq!(unsafe { libc::pipe(ready.as_mut_ptr()) }, 0);
        assert_eq!(unsafe { libc::pipe(release.as_mut_ptr()) }, 0);
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed: {}", std::io::Error::last_os_error());
        if pid == 0 {
            // The multithreaded parent has an active accept loop. Between fork
            // and exec only async-signal-safe libc operations are permitted.
            unsafe {
                libc::close(ready[0]);
                libc::close(release[1]);
                libc::write(ready[1], b"r".as_ptr().cast(), 1);
                let mut byte = 0u8;
                libc::read(release[0], (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe {
            libc::close(ready[1]);
            libc::close(release[0]);
        }
        let mut ready_file = unsafe { fs::File::from_raw_fd(ready[0]) };
        let inherited = InheritedListener {
            pid,
            release: Some(unsafe { fs::File::from_raw_fd(release[1]) }),
        };
        let mut poll = libc::pollfd {
            fd: ready_file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(
            unsafe { libc::poll(&mut poll, 1, 2000) },
            1,
            "owned child ready barrier timed out"
        );
        ready_file.read_exact(&mut [0u8]).unwrap();
        server.stop();
        assert!(
            server.handle.is_none(),
            "stop joined the sole accept thread"
        );
        let error =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .err()
                .unwrap();
        assert!(error.contains("saved origin was not changed"));
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(
            unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
            0
        );
        eprintln!("controlled inherited listener: child_pid={pid}, origin={original}, parent_accept_thread_joined=true, restart_error={error}");
        drop(inherited);
        let mut restarted =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .unwrap();
        assert_eq!(restarted.url(), original);
        eprintln!("controlled inherited listener released: child_pid={pid}, same_origin_rebound={original}");
        restarted.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_os_lock_preserves_current_source_and_releases_after_failure() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, server) = fixture();
        let source = root.join("source");
        let mut current = Some(server);
        let original = current.as_ref().unwrap().url();
        let before = fs::read(&registry).unwrap();
        fs::write(source.join("other.html"), "other entry").unwrap();
        // A separate file handle exercises the OS lock used across processes.
        let competing_launch = lock_source_port_registry(&registry).unwrap();
        let error = DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "other.html",
            &registry,
            port,
            8,
        )
        .unwrap_err();
        assert!(error.contains("Cannot lock source port registry"));
        assert_eq!(current.as_ref().unwrap().url(), original);
        assert_eq!(fs::read(&registry).unwrap(), before);
        drop(competing_launch);
        let next = DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "other.html",
            &registry,
            port,
            8,
        )
        .unwrap();
        assert_ne!(next, original);
        drop(current);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_busy_ports_once_then_keeps_the_saved_fallback() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, stranger) = occupied_port_fixture();
        let mut server =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .unwrap();
        let fallback_port = server.port;
        assert!(
            (port + 1..port + 8).contains(&fallback_port),
            "the source must skip the occupied first port and stay in its configured range"
        );
        server.stop();
        stranger.set_nonblocking(true).unwrap();
        assert_eq!(
            stranger.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(stranger);
        let mut restarted =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .unwrap();
        assert_eq!(
            restarted.port, fallback_port,
            "an earlier port becoming free must not change the saved origin"
        );
        restarted.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn occupied_saved_origin_fails_without_touching_the_other_service_or_registry() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, mut server) = fixture();
        let saved_port = server.port;
        server.stop();
        let before = fs::read(&registry).unwrap();
        let stranger = TcpListener::bind(("127.0.0.1", saved_port)).unwrap();
        let error =
            DevServer::start_in_port_range(&root.join("source"), "AIChat.html", &registry, port, 8)
                .err()
                .unwrap();
        assert!(error.contains("saved origin was not changed"));
        assert_eq!(fs::read(&registry).unwrap(), before);
        // Dropping an already stopped server must not connect to its old port.
        drop(server);
        stranger.set_nonblocking(true).unwrap();
        assert_eq!(
            stranger.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(stranger);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selection_reuses_canonical_source_and_isolates_other_sources_and_entries() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, server) = fixture();
        let source = root.join("source");
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("other/AIChat.html"), "other source").unwrap();
        fs::write(source.join("other.html"), "other entry").unwrap();
        let mut current = Some(server);
        let first = DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "AIChat.html",
            &registry,
            port,
            8,
        )
        .unwrap();
        let repeated = DevServer::select_source_in_port_range(
            &mut current,
            &source.join("."),
            "AIChat.html",
            &registry,
            port,
            8,
        )
        .unwrap();
        assert_eq!(repeated, first);
        let first_port = current.as_ref().unwrap().port;
        DevServer::select_source_in_port_range(
            &mut current,
            &root.join("other"),
            "AIChat.html",
            &registry,
            port,
            8,
        )
        .unwrap();
        let other_source_port = current.as_ref().unwrap().port;
        assert_ne!(other_source_port, first_port);
        DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "other.html",
            &registry,
            port,
            8,
        )
        .unwrap();
        assert!(
            current.as_ref().unwrap().port != first_port
                && current.as_ref().unwrap().port != other_source_port,
            "released reserved ports belong to their original source"
        );
        assert_eq!(
            DevServer::select_source_in_port_range(
                &mut current,
                &source,
                "AIChat.html",
                &registry,
                port,
                8
            )
            .unwrap(),
            first
        );
        drop(current);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_registry_and_invalid_source_preserve_current_server() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, server) = fixture();
        let source = root.join("source");
        let mut current = Some(server);
        let url = current.as_ref().unwrap().url();
        fs::write(source.join("other.html"), "other entry").unwrap();
        fs::write(&registry, "broken JSON").unwrap();
        let error = DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "other.html",
            &registry,
            port,
            8,
        )
        .unwrap_err();
        assert!(error.contains("Invalid source port registry"));
        assert_eq!(current.as_ref().unwrap().url(), url);
        assert!(current.as_ref().unwrap().handle.is_some());
        assert!(DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "../source/AIChat.html",
            &registry,
            port,
            8
        )
        .is_err());
        assert_eq!(fs::read_to_string(&registry).unwrap(), "broken JSON");
        drop(current);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exhausted_range_and_conflicting_registry_fail_closed() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, busy) = occupied_port_fixture();
        let source = root.join("source");
        let error = DevServer::start_in_port_range(&source, "AIChat.html", &registry, port, 1)
            .err()
            .unwrap();
        assert!(error.contains("No unreserved"));
        assert!(!registry.exists());
        drop(busy);
        let binding = serde_json::json!({"root": dunce::canonicalize(&source).unwrap(), "entry":"AIChat.html", "port":port});
        atomic_json_write(
            &registry,
            &serde_json::json!({"version":1,"entries":[binding.clone(),binding]}),
        )
        .unwrap();
        assert!(
            DevServer::start_in_port_range(&source, "AIChat.html", &registry, port, 8)
                .err()
                .unwrap()
                .contains("conflicting bindings")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn registry_save_failure_preserves_current_server_and_releases_candidate_port() {
        let _test_ports = TEST_PORT_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use std::os::unix::fs::PermissionsExt;
        if isolated_origin_test() {
            return;
        }
        let (root, registry, port, server) = fixture();
        let source = root.join("source");
        let mut current = Some(server);
        let url = current.as_ref().unwrap().url();
        let before = fs::read(&registry).unwrap();
        fs::write(source.join("other.html"), "other entry").unwrap();
        fs::set_permissions(
            registry.parent().unwrap(),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        let result = DevServer::select_source_in_port_range(
            &mut current,
            &source,
            "other.html",
            &registry,
            port,
            8,
        );
        fs::set_permissions(
            registry.parent().unwrap(),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(result
            .unwrap_err()
            .contains("Cannot save source port registry"));
        assert_eq!(current.as_ref().unwrap().url(), url);
        assert_eq!(fs::read(&registry).unwrap(), before);
        let candidate = TcpListener::bind(("127.0.0.1", port + 1)).unwrap();
        drop(candidate);
        drop(current);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn serves_local_aichat_source_on_loopback_and_blocks_traversal() {
        let root = std::env::temp_dir().join(format!("aichat-rust-devsrv-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("js")).unwrap();
        fs::write(
            root.join("AIChat.html"),
            "<!doctype html><title>AIChat</title>",
        )
        .unwrap();
        fs::write(root.join("js/app.js"), "export const ok = true;").unwrap();

        // This case verifies HTTP and confinement, not origin allocation.
        // Keep ownership of the OS-selected socket through server startup;
        // probing and releasing a small range races other local test clients.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let (source, entry) = source_identity(&root, "AIChat.html").unwrap();
        let mut server = DevServer::serve_listener(listener, source, entry).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        let res = client.get(server.url()).send().await.unwrap();
        assert_eq!(res.status().as_u16(), 200);
        assert_eq!(
            res.headers()
                .get("cache-control")
                .unwrap()
                .to_str()
                .unwrap(),
            "no-store"
        );
        let text = res.text().await.unwrap();
        assert!(text.contains("<title>AIChat</title>"));

        let traversal = client
            .get(format!(
                "http://127.0.0.1:{}/%2e%2e%2fsecret.txt",
                server.port
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(traversal.status().as_u16(), 403);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
            let response = client
                .get(format!("http://127.0.0.1:{}/escape", server.port))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 403);
        }

        server.stop();
        let _ = fs::remove_dir_all(&root);
    }
}
