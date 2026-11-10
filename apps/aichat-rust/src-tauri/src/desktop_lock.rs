use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockRecord {
    pub pid: u32,
    pub wake_port: u16,
    pub executable: String,
}

pub struct DesktopLock {
    lock_file: PathBuf,
    stop_flag: Arc<AtomicBool>,
    wake_port: u16,
    handle: Option<JoinHandle<()>>,
}

impl DesktopLock {
    pub fn acquire<F>(
        lock_file: PathBuf,
        background_launch: bool,
        replace_existing: bool,
        on_wake: F,
    ) -> Result<Option<Self>, String>
    where
        F: Fn(bool) + Send + Sync + 'static,
    {
        if let Some(existing) = Self::read_existing(&lock_file) {
            if existing.pid != std::process::id()
                && Self::ping_existing(&existing, !background_launch, replace_existing)
            {
                if !replace_existing {
                    // Existing instance is alive and handled our wake/background signal
                    return Ok(None);
                }
                // Wait briefly for existing instance to exit after replace signal
                for _ in 0..30 {
                    if TcpStream::connect_timeout(
                        &std::net::SocketAddr::from(([127, 0, 0, 1], existing.wake_port)),
                        Duration::from_millis(80),
                    )
                    .is_err()
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to bind single-instance listener: {e}"))?;
        let wake_port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read single-instance port: {e}"))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set nonblocking listener: {e}"))?;

        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let record = LockRecord {
            pid: std::process::id(),
            wake_port,
            executable: exe,
        };
        atomic_json_write(&lock_file, &record)?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop_flag);
        let callback = Arc::new(on_wake);

        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut buf = [0u8; 128];
                        let n = stream.read(&mut buf).unwrap_or(0);
                        let cmd = String::from_utf8_lossy(&buf[..n]);
                        let _ = stream.write_all(b"OK\n");
                        let _ = stream.flush();
                        if cmd.starts_with("REPLACE") {
                            thread_stop.store(true, Ordering::Relaxed);
                            callback(true);
                            break;
                        } else if cmd.starts_with("WAKE") {
                            callback(false);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(40));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Some(Self {
            lock_file,
            stop_flag,
            wake_port,
            handle: Some(handle),
        }))
    }

    pub fn wake_port(&self) -> u16 {
        self.wake_port
    }

    fn read_existing(lock_file: &Path) -> Option<LockRecord> {
        let raw = fs::read_to_string(lock_file).ok()?;
        serde_json::from_str::<LockRecord>(&raw).ok()
    }

    fn ping_existing(record: &LockRecord, should_focus: bool, replace: bool) -> bool {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], record.wake_port));
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
            return false;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let msg = if replace {
            "REPLACE\n"
        } else if should_focus {
            "WAKE\n"
        } else {
            "BACKGROUND\n"
        };
        if stream.write_all(msg.as_bytes()).is_err() {
            return false;
        }
        let mut resp = [0u8; 16];
        let n = stream.read(&mut resp).unwrap_or(0);
        String::from_utf8_lossy(&resp[..n]).starts_with("OK")
    }

    pub fn release(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.wake_port));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        if let Some(existing) = Self::read_existing(&self.lock_file) {
            if existing.pid == std::process::id() {
                let _ = fs::remove_file(&self.lock_file);
            }
        }
    }
}

impl Drop for DesktopLock {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use uuid::Uuid;

    #[test]
    fn second_instance_wakes_first_and_exits_unless_replace_is_requested() {
        let root = std::env::temp_dir().join(format!("aichat-rust-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let lock_file = root.join("desktop.lock.json");

        let wakes = Arc::new(AtomicUsize::new(0));
        let wakes_clone = Arc::clone(&wakes);

        let mut primary = DesktopLock::acquire(lock_file.clone(), false, false, move |_replace| {
            wakes_clone.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap()
        .expect("primary instance should acquire lock");

        // Simulate a second process by reading lock and pinging
        let record = DesktopLock::read_existing(&lock_file).unwrap();
        assert!(DesktopLock::ping_existing(&record, true, false));
        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while wakes.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 1);

        primary.release();
        let _ = fs::remove_dir_all(&root);
    }
}
