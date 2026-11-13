//! Controlled installation callbacks exercise routing and lifetime decisions
//! without launching an installer, showing UI or contacting a shared daemon.

use super::*;
use std::sync::atomic::AtomicUsize;
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    manager: Arc<UpdateManager>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture(ready: bool) -> Fixture {
    let root = std::env::temp_dir().join(format!("keepwork-install-intent-{}", Uuid::new_v4()));
    let downloads = root.join("downloads");
    fs::create_dir_all(&downloads).unwrap();
    let package = downloads.join("0.3.0-installer.dmg");
    let bytes = b"verified fixture installer";
    fs::write(&package, bytes).unwrap();
    let manager = Arc::new(UpdateManager::new(
        "0.2.0".into(),
        root.join("metadata.json"),
        downloads,
        "https://cdn.keepwork.com/fixture.json".into(),
        None,
    ));
    if ready {
        let mut state = manager.desktop_state.lock().unwrap();
        state.state = "ready".into();
        state.meta = PersistedDesktopUpdateMeta {
            latest_version: "0.3.0".into(),
            downloaded_path: package.to_string_lossy().into_owned(),
            url: "https://cdn.keepwork.com/fixture.dmg".into(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            ..Default::default()
        };
    }
    Fixture { root, manager }
}

fn mcp_snapshot(ready: bool) -> RuntimeStatusSnapshot {
    let mut state = RuntimeStatusSnapshot::initial("mcp", 0);
    state.owner = "desktop".into();
    state.state = "running".into();
    state.pid = 321;
    state.version = "0.8.0".into();
    if ready {
        state.pending_version = "0.9.0".into();
        state.update_state = "staged".into();
    }
    state
}

#[test]
fn desktop_installation_readiness_matrix_never_changes_mcp_pending_or_execution() {
    for desktop_ready in [false, true] {
        for mcp_ready in [false, true] {
            let fixture = fixture(desktop_ready);
            let manager = &fixture.manager;
            let mcp = mcp_snapshot(mcp_ready);
            let before = serde_json::to_value(manager.snapshot(&mcp).mcp).unwrap();
            assert_eq!(before["canApply"], mcp_ready);
            let confirmations = AtomicUsize::new(0);
            let installations = AtomicUsize::new(0);
            let result = manager
                .install_desktop_with_confirmation(
                    || {
                        confirmations.fetch_add(1, Ordering::Relaxed);
                        true
                    },
                    |path| {
                        installations.fetch_add(1, Ordering::Relaxed);
                        assert_eq!(fs::read(path).unwrap(), b"verified fixture installer");
                        Ok(())
                    },
                )
                .unwrap();
            assert_eq!(
                result,
                if desktop_ready {
                    DesktopInstallOutcome::Launched
                } else {
                    DesktopInstallOutcome::Unavailable
                }
            );
            assert_eq!(
                confirmations.load(Ordering::Relaxed),
                usize::from(desktop_ready)
            );
            assert_eq!(
                installations.load(Ordering::Relaxed),
                usize::from(desktop_ready)
            );
            assert_eq!(
                serde_json::to_value(manager.snapshot(&mcp).mcp).unwrap(),
                before
            );
            assert_eq!(mcp.pending_version, if mcp_ready { "0.9.0" } else { "" });
            assert_eq!(mcp.state, "running");
        }
    }
}

#[test]
fn cancellation_and_launch_failure_release_the_gate_but_success_prevents_duplicate_launch() {
    let fixture = fixture(true);
    let manager = &fixture.manager;
    let mcp = mcp_snapshot(true);
    assert_eq!(
        manager
            .install_desktop_with_confirmation(
                || false,
                |_| panic!("cancelled installation must not launch")
            )
            .unwrap(),
        DesktopInstallOutcome::Cancelled
    );
    assert!(manager.snapshot(&mcp).desktop.can_apply);
    assert_eq!(
        manager
            .install_desktop_with_confirmation(|| true, |_| Err("fixture installer refused".into()))
            .unwrap_err(),
        "fixture installer refused"
    );
    assert!(manager.snapshot(&mcp).desktop.can_apply);
    assert_eq!(
        manager
            .install_desktop_with_confirmation(|| true, |_| Ok(()))
            .unwrap(),
        DesktopInstallOutcome::Launched
    );
    assert_eq!(
        manager
            .install_desktop_with_confirmation(
                || panic!("no duplicate dialog"),
                |_| panic!("no duplicate launch")
            )
            .unwrap(),
        DesktopInstallOutcome::Busy
    );
    assert!(!manager.snapshot(&mcp).desktop.can_apply);
    assert!(manager.snapshot(&mcp).mcp.can_apply);
}

#[test]
fn a_confirmation_failure_does_not_leave_the_manager_busy() {
    let fixture = fixture(true);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fixture
            .manager
            .install_desktop_with_confirmation(|| panic!("fixture dialog failed"), |_| Ok(()))
    }));
    assert!(result.is_err());
    assert!(
        fixture
            .manager
            .snapshot(&mcp_snapshot(false))
            .desktop
            .can_apply
    );
    assert_eq!(
        fixture
            .manager
            .install_desktop_with_confirmation(|| false, |_| Ok(()))
            .unwrap(),
        DesktopInstallOutcome::Cancelled
    );
}

#[test]
fn changed_or_invalid_candidates_are_rejected_after_confirmation_without_retargeting() {
    for change in [
        "version", "path", "sha256", "size", "url", "unready", "missing", "bytes",
    ] {
        let fixture = fixture(true);
        let manager = &fixture.manager;
        let installations = AtomicUsize::new(0);
        let result = manager.install_desktop_with_confirmation(
            || {
                let mut state = manager.desktop_state.lock().unwrap();
                match change {
                    "version" => state.meta.latest_version = "0.4.0".into(),
                    "path" => {
                        let different = fixture.root.join("downloads/different.dmg");
                        fs::copy(&state.meta.downloaded_path, &different).unwrap();
                        state.meta.downloaded_path = different.to_string_lossy().into_owned();
                    }
                    "sha256" => state.meta.sha256 = "c".repeat(64),
                    "size" => state.meta.size += 1,
                    "url" => state.meta.url = "https://cdn.keepwork.com/different.dmg".into(),
                    "unready" => state.state = "downloading".into(),
                    "missing" => fs::remove_file(&state.meta.downloaded_path).unwrap(),
                    "bytes" => {
                        fs::write(&state.meta.downloaded_path, b"corrupted installer").unwrap()
                    }
                    _ => unreachable!(),
                }
                true
            },
            |_| {
                installations.fetch_add(1, Ordering::Relaxed);
                Ok(())
            },
        );
        assert!(result.is_err(), "changed candidate {change}");
        assert_eq!(installations.load(Ordering::Relaxed), 0, "{change}");
        assert!(!manager.desktop_install_busy.load(Ordering::Acquire));
        assert!(manager.snapshot(&mcp_snapshot(true)).mcp.can_apply);
    }
}

#[test]
fn concurrent_desktop_entry_points_share_one_confirmation_and_status_remains_readable() {
    use std::sync::mpsc;
    let fixture = fixture(true);
    let (entered_send, entered_receive) = mpsc::channel();
    let (release_send, release_receive) = mpsc::channel();
    let manager = Arc::clone(&fixture.manager);
    let installations = Arc::new(AtomicUsize::new(0));
    let launches = Arc::clone(&installations);
    let first = std::thread::spawn(move || {
        manager.install_desktop_with_confirmation(
            || {
                entered_send.send(()).unwrap();
                release_receive
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                true
            },
            |_| {
                launches.fetch_add(1, Ordering::Relaxed);
                Ok(())
            },
        )
    });
    entered_receive
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let (observed_send, observed_receive) = mpsc::channel();
    let manager = Arc::clone(&fixture.manager);
    let second = std::thread::spawn(move || {
        let status = manager.snapshot(&mcp_snapshot(true));
        let outcome = manager.install_desktop_with_confirmation(
            || panic!("duplicate dialog"),
            |_| panic!("duplicate installer"),
        );
        observed_send.send((status, outcome)).unwrap();
    });
    let observation = observed_receive.recv_timeout(Duration::from_secs(2));
    release_send.send(()).unwrap();
    assert_eq!(
        first.join().unwrap().unwrap(),
        DesktopInstallOutcome::Launched
    );
    second.join().unwrap();
    let (status, outcome) = observation.expect(
        "a native confirmation must not hold the status mutex or block another entry point",
    );
    assert!(!status.desktop.can_apply);
    assert!(status.mcp.can_apply);
    assert_eq!(outcome.unwrap(), DesktopInstallOutcome::Busy);
    assert_eq!(installations.load(Ordering::Relaxed), 1);
}
