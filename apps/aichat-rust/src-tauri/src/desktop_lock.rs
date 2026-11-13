use crate::files::atomic_json_write;
use crate::launch_intents::LaunchUrl;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceAction {
    Wake,
    Replace,
    Launch(LaunchUrl),
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
        Self::acquire_with_launch(
            lock_file,
            background_launch,
            replace_existing,
            None,
            move |action| {
                on_wake(action == InstanceAction::Replace);
            },
        )
    }

    pub fn acquire_with_launch<F>(
        lock_file: PathBuf,
        background_launch: bool,
        replace_existing: bool,
        launch: Option<LaunchUrl>,
        on_wake: F,
    ) -> Result<Option<Self>, String>
    where
        F: Fn(InstanceAction) + Send + Sync + 'static,
    {
        if let Some(existing) = Self::read_existing(&lock_file) {
            if existing.pid != std::process::id()
                && Self::ping_existing_with_launch(
                    &existing,
                    !background_launch,
                    replace_existing,
                    launch,
                )
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
                        // BSD-derived platforms hand back an accepted socket that
                        // inherits O_NONBLOCK, which makes the command read fail
                        // with EAGAIN and silently drop the wake request.
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                        let mut command = Vec::with_capacity(16);
                        let mut byte = [0u8; 1];
                        while command.len() < 128 {
                            match stream.read(&mut byte) {
                                Ok(0) => break,
                                Ok(1) => {
                                    command.push(byte[0]);
                                    if byte[0] == b'\n' {
                                        break;
                                    }
                                }
                                Ok(_) => unreachable!(),
                                Err(_) => break,
                            }
                        }
                        let action = match command.as_slice() {
                            b"REPLACE\n" => Some(InstanceAction::Replace),
                            b"WAKE\n" => Some(InstanceAction::Wake),
                            b"LAUNCH open\n" => Some(InstanceAction::Launch(LaunchUrl::Open)),
                            b"LAUNCH onboarding\n" => {
                                Some(InstanceAction::Launch(LaunchUrl::Onboarding))
                            }
                            b"BACKGROUND\n" => None,
                            _ => {
                                let _ = stream.write_all(b"INVALID\n");
                                continue;
                            }
                        };
                        let response: &[u8] = if matches!(action, Some(InstanceAction::Launch(_))) {
                            b"OK LAUNCH\n"
                        } else {
                            b"OK\n"
                        };
                        let _ = stream.write_all(response);
                        let _ = stream.flush();
                        if action == Some(InstanceAction::Replace) {
                            thread_stop.store(true, Ordering::Relaxed);
                            callback(InstanceAction::Replace);
                            break;
                        } else if let Some(action) = action {
                            callback(action);
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

    #[cfg(test)]
    fn ping_existing(record: &LockRecord, should_focus: bool, replace: bool) -> bool {
        Self::ping_existing_with_launch(record, should_focus, replace, None)
    }

    fn ping_existing_with_launch(
        record: &LockRecord,
        should_focus: bool,
        replace: bool,
        launch: Option<LaunchUrl>,
    ) -> bool {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], record.wake_port));
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
            return false;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let msg = if replace {
            "REPLACE\n"
        } else if launch == Some(LaunchUrl::Onboarding) {
            "LAUNCH onboarding\n"
        } else if launch == Some(LaunchUrl::Open) {
            "LAUNCH open\n"
        } else if should_focus {
            "WAKE\n"
        } else {
            "BACKGROUND\n"
        };
        if stream.write_all(msg.as_bytes()).is_err() {
            return false;
        }
        let mut response = Vec::with_capacity(16);
        let mut byte = [0u8];
        while response.len() < 16 {
            match stream.read(&mut byte) {
                Ok(1) => {
                    response.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                _ => break,
            }
        }
        if launch.is_some() && !replace && response == b"OK\n" {
            // Older desktop hosts acknowledge unknown commands. Preserve the
            // existing app and at least foreground it; onboarding stays manual.
            return Self::ping_existing_with_launch(record, true, false, None);
        }
        if launch.is_some() && !replace {
            response == b"OK LAUNCH\n"
        } else {
            response == b"OK\n"
        }
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

    #[test]
    fn fragmented_wake_command_is_handled_as_one_message() {
        let root =
            std::env::temp_dir().join(format!("aichat-rust-lock-fragmented-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let lock_file = root.join("desktop.lock.json");

        let wakes = Arc::new(AtomicUsize::new(0));
        let wakes_clone = Arc::clone(&wakes);
        let mut primary = DesktopLock::acquire(lock_file.clone(), false, false, move |_replace| {
            wakes_clone.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap()
        .expect("primary instance should acquire lock");

        let record = DesktopLock::read_existing(&lock_file).unwrap();
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], record.wake_port));
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        stream.write_all(b"WA").unwrap();
        thread::sleep(Duration::from_millis(5));
        stream.write_all(b"KE\n").unwrap();

        let mut response = [0u8; 16];
        let n = stream.read(&mut response).unwrap();
        assert_eq!(&response[..n], b"OK\n");

        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while wakes.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 1);

        primary.release();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn launch_actions_forward_without_urls_and_unknown_commands_cannot_wake_or_replace() {
        let root = std::env::temp_dir().join(format!("aichat-launch-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let lock_file = root.join("desktop.lock.json");
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut primary = DesktopLock::acquire_with_launch(
            lock_file.clone(),
            false,
            false,
            None,
            move |action| {
                sender.send(action).unwrap();
            },
        )
        .unwrap()
        .unwrap();
        let record = DesktopLock::read_existing(&lock_file).unwrap();
        assert!(DesktopLock::ping_existing_with_launch(
            &record,
            true,
            false,
            Some(LaunchUrl::Onboarding)
        ));
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            InstanceAction::Launch(LaunchUrl::Onboarding)
        );
        let mut stream = TcpStream::connect(("127.0.0.1", record.wake_port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(b"REPLACE arbitrary-argument\n").unwrap();
        let mut reply = [0u8; 16];
        let count = stream.read(&mut reply).unwrap();
        assert_eq!(&reply[..count], b"INVALID\n");
        assert!(receiver.recv_timeout(Duration::from_millis(80)).is_err());
        assert!(DesktopLock::ping_existing(&record, true, false));
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            InstanceAction::Wake
        );
        primary.release();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn older_host_unknown_command_ack_falls_back_to_ordinary_wake() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let record = LockRecord {
            pid: 1,
            wake_port: listener.local_addr().unwrap().port(),
            executable: String::new(),
        };
        let worker = thread::spawn(move || {
            let mut messages = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut message = Vec::new();
                let mut byte = [0u8];
                while stream.read(&mut byte).unwrap() == 1 {
                    message.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                messages.push(message);
                stream.write_all(b"OK\n").unwrap();
            }
            messages
        });
        assert!(DesktopLock::ping_existing_with_launch(
            &record,
            true,
            false,
            Some(LaunchUrl::Onboarding)
        ));
        assert_eq!(
            worker.join().unwrap(),
            vec![b"LAUNCH onboarding\n".to_vec(), b"WAKE\n".to_vec()]
        );
    }

    #[test]
    fn fragmented_launch_ack_does_not_trigger_a_second_instance() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let record = LockRecord {
            pid: 1,
            wake_port: listener.local_addr().unwrap().port(),
            executable: String::new(),
        };
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut command = [0u8; 32];
            stream.read(&mut command).unwrap();
            stream.write_all(b"OK ").unwrap();
            thread::sleep(Duration::from_millis(5));
            stream.write_all(b"LAUNCH\n").unwrap();
        });
        assert!(DesktopLock::ping_existing_with_launch(
            &record,
            true,
            false,
            Some(LaunchUrl::Open)
        ));
        worker.join().unwrap();
    }
}
