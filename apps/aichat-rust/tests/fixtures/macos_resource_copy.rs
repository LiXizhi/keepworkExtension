#[path = "../../src-tauri/build_support/macos_resources.rs"]
mod macos_resources;

use macos_resources::ResourceCopyGuard;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{symlink, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    target: PathBuf,
    backups: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        // macOS aliases /var and /tmp; use a genuinely canonical test root.
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!(
            "keepwork-resource-inode-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Self {
            source: root.join("source"),
            target: root.join("target"),
            backups: root.join("backups"),
            root,
        };
        for directory in [&fixture.source, &fixture.target, &fixture.backups] {
            fs::create_dir(directory).unwrap();
        }
        fixture
    }

    fn entry(root: &Path, arch: &str) -> PathBuf {
        root.join(arch).join("bin/keepwork-mcp")
    }

    fn write(root: &Path, arch: &str, content: &[u8]) -> PathBuf {
        let entry = Self::entry(root, arch);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, content).unwrap();
        entry
    }

    fn prepare(&self) -> ResourceCopyGuard {
        ResourceCopyGuard::prepare(&self.source, &self.target, &self.backups).unwrap()
    }

    fn backup_count(&self) -> usize {
        fs::read_dir(&self.backups).unwrap().count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn identity(path: &Path) -> (u64, u64) {
    let metadata = fs::metadata(path).unwrap();
    (metadata.dev(), metadata.ino())
}

fn opened_bytes(file: &mut File) -> Vec<u8> {
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn repeated_builds_preserve_each_open_inode_and_cleanup_committed_backups() {
    let fixture = Fixture::new();
    let source = Fixture::write(&fixture.source, "arm64", b"new build 0");
    let target = Fixture::write(&fixture.target, "arm64", b"original process image");
    let mut opened = vec![(
        File::open(&target).unwrap(),
        b"original process image".to_vec(),
    )];
    let mut previous_id = identity(&target);
    for build in 0..3 {
        let bytes = format!("new build {build}").into_bytes();
        fs::write(&source, &bytes).unwrap();
        let mut guard = fixture.prepare();
        let backup = guard.backup_dir().unwrap().to_path_buf();
        assert!(!target.exists(), "Tauri must create a fresh target file");
        assert!(backup.exists());
        for (file, expected) in &mut opened {
            assert_eq!(opened_bytes(file), *expected);
        }
        fs::copy(&source, &target).unwrap();
        let new_id = identity(&target);
        assert_ne!(new_id, previous_id);
        guard.commit().unwrap();
        assert!(!backup.exists());
        assert_eq!(fixture.backup_count(), 0);
        assert_eq!(fs::read(&target).unwrap(), bytes);
        for (file, expected) in &mut opened {
            assert_eq!(
                opened_bytes(file),
                *expected,
                "copy must never overwrite a live old inode"
            );
        }
        opened.push((File::open(&target).unwrap(), bytes));
        previous_id = new_id;
    }
}

#[test]
fn rollback_restores_exact_old_inode_after_partial_copy() {
    let fixture = Fixture::new();
    Fixture::write(&fixture.source, "arm64", b"replacement");
    let target = Fixture::write(&fixture.target, "arm64", b"working image");
    let old_id = identity(&target);
    let mut old_handle = File::open(&target).unwrap();
    let mut guard = fixture.prepare();
    let backup = guard.backup_dir().unwrap().to_path_buf();
    fs::write(&target, b"partial invalid copy").unwrap();
    guard.rollback().unwrap();
    assert_eq!(identity(&target), old_id);
    assert_eq!(fs::read(&target).unwrap(), b"working image");
    assert_eq!(opened_bytes(&mut old_handle), b"working image");
    assert!(!backup.exists());
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn drop_restores_original_after_copy_without_commit() {
    let fixture = Fixture::new();
    let source = Fixture::write(&fixture.source, "arm64", b"replacement");
    let target = Fixture::write(&fixture.target, "arm64", b"working image");
    let old_id = identity(&target);
    {
        let _guard = fixture.prepare();
        fs::copy(&source, &target).unwrap();
        assert_ne!(identity(&target), old_id);
    }
    assert_eq!(identity(&target), old_id);
    assert_eq!(fs::read(&target).unwrap(), b"working image");
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn commit_without_a_completed_copy_fails_and_preserves_original_for_recovery() {
    let fixture = Fixture::new();
    Fixture::write(&fixture.source, "arm64", b"new build");
    let target = Fixture::write(&fixture.target, "arm64", b"original build");
    let original_id = identity(&target);
    {
        let mut guard = fixture.prepare();
        let backup = guard.backup_dir().unwrap().to_path_buf();
        assert!(guard.commit().is_err());
        assert!(
            backup.exists(),
            "a failed copy must retain its recovery inode"
        );
    }
    assert_eq!(identity(&target), original_id);
    assert_eq!(fs::read(target).unwrap(), b"original build");
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn rollback_rejects_new_symlink_paths_and_keeps_backup_until_safe_to_restore() {
    for link_parent in [false, true] {
        let fixture = Fixture::new();
        Fixture::write(&fixture.source, "arm64", b"new build");
        let target = Fixture::write(&fixture.target, "arm64", b"original build");
        let original_id = identity(&target);
        let mut guard = fixture.prepare();
        let backup = guard.backup_dir().unwrap().to_path_buf();
        let outside = fixture.root.join("external");
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("keepwork-mcp");
        fs::write(&sentinel, b"must not modify").unwrap();
        let link = if link_parent {
            target.parent().unwrap().to_path_buf()
        } else {
            target.clone()
        };
        if link_parent {
            fs::remove_dir(&link).unwrap();
            symlink(&outside, &link).unwrap();
        } else {
            symlink(&sentinel, &link).unwrap();
        }
        assert!(guard.rollback().is_err());
        assert!(backup.exists());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&sentinel).unwrap(), b"must not modify");
        fs::remove_file(&link).unwrap();
        if link_parent {
            fs::create_dir(&link).unwrap();
        }
        guard.rollback().unwrap();
        assert_eq!(identity(&target), original_id);
        assert_eq!(fs::read(target).unwrap(), b"original build");
        assert_eq!(fixture.backup_count(), 0);
    }
}

#[test]
fn rollback_before_copy_restores_both_architectures_without_touching_other_resources() {
    let fixture = Fixture::new();
    let mut targets = Vec::new();
    for arch in ["arm64", "x64"] {
        Fixture::write(&fixture.source, arch, b"replacement");
        let target = Fixture::write(&fixture.target, arch, arch.as_bytes());
        targets.push((target.clone(), identity(&target), arch.as_bytes().to_vec()));
    }
    let unrelated = fixture.target.join("runtime.json");
    fs::write(&unrelated, b"unrelated resource").unwrap();
    let unrelated_id = identity(&unrelated);
    let mut guard = fixture.prepare();
    for (target, _, _) in &targets {
        assert!(!target.exists());
    }
    guard.rollback().unwrap();
    for (target, id, bytes) in targets {
        assert_eq!(identity(&target), id);
        assert_eq!(fs::read(target).unwrap(), bytes);
    }
    assert_eq!(identity(&unrelated), unrelated_id);
    assert_eq!(fs::read(unrelated).unwrap(), b"unrelated resource");
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn absent_target_or_source_does_not_create_backups_or_remove_unmatched_target() {
    let fixture = Fixture::new();
    Fixture::write(&fixture.source, "arm64", b"new arm64 build");
    let unmatched = Fixture::write(&fixture.target, "x64", b"existing x64 build");
    let unmatched_id = identity(&unmatched);
    let mut guard = fixture.prepare();
    assert!(guard.backup_dir().is_none());
    guard.commit().unwrap();
    assert_eq!(identity(&unmatched), unmatched_id);
    assert_eq!(fs::read(unmatched).unwrap(), b"existing x64 build");
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn equal_and_nested_runtime_roots_are_rejected_without_moving_sources() {
    let fixture = Fixture::new();
    let source = Fixture::write(&fixture.source, "arm64", b"source sentinel");
    let source_id = identity(&source);
    let nested = fixture.source.join("nested");
    fs::create_dir(&nested).unwrap();
    Fixture::write(&nested, "arm64", b"nested source sentinel");
    for (source_root, target_root) in [
        (&fixture.source, &fixture.source),
        (&fixture.source, &nested),
        (&nested, &fixture.source),
    ] {
        assert!(ResourceCopyGuard::prepare(source_root, target_root, &fixture.backups).is_err());
        assert_eq!(identity(&source), source_id);
        assert_eq!(fs::read(&source).unwrap(), b"source sentinel");
        assert_eq!(fixture.backup_count(), 0);
    }
}

#[test]
fn same_and_cross_architecture_hardlinks_are_rejected_before_any_target_moves() {
    for alias_arch in ["arm64", "x64"] {
        let fixture = Fixture::new();
        let source = Fixture::write(&fixture.source, "arm64", b"source sentinel");
        Fixture::write(&fixture.source, "x64", b"x64 source sentinel");
        let target_arm64 = Fixture::write(&fixture.target, "arm64", b"old arm64");
        let target_x64 = Fixture::write(&fixture.target, "x64", b"old x64");
        let alias_target = Fixture::entry(&fixture.target, alias_arch);
        fs::remove_file(&alias_target).unwrap();
        fs::hard_link(&source, &alias_target).unwrap();
        let identities = [
            identity(&target_arm64),
            identity(&target_x64),
            identity(&source),
        ];
        assert!(
            ResourceCopyGuard::prepare(&fixture.source, &fixture.target, &fixture.backups).is_err()
        );
        assert_eq!(identity(&target_arm64), identities[0]);
        assert_eq!(identity(&target_x64), identities[1]);
        assert_eq!(identity(&source), identities[2]);
        assert_eq!(fs::read(&source).unwrap(), b"source sentinel");
        assert_eq!(fixture.backup_count(), 0);
    }
}

#[test]
fn symlinked_source_and_target_components_never_touch_external_files() {
    for (source_side, component) in [
        (true, "root"),
        (true, "parent"),
        (true, "file"),
        (false, "root"),
        (false, "parent"),
        (false, "file"),
    ] {
        let fixture = Fixture::new();
        let source = Fixture::write(&fixture.source, "arm64", b"source sentinel");
        let target = Fixture::write(&fixture.target, "arm64", b"target sentinel");
        let selected_root = if source_side {
            &fixture.source
        } else {
            &fixture.target
        };
        let selected = match component {
            "root" => selected_root.clone(),
            "parent" => selected_root.join("arm64/bin"),
            "file" => Fixture::entry(selected_root, "arm64"),
            _ => unreachable!(),
        };
        let outside = fixture.root.join("external");
        fs::rename(&selected, &outside).unwrap();
        symlink(&outside, &selected).unwrap();
        let original_source = identity(&source);
        let original_target = identity(&target);
        assert!(
            ResourceCopyGuard::prepare(&fixture.source, &fixture.target, &fixture.backups).is_err(),
            "accepted symlink: source_side={source_side}, component={component}"
        );
        assert!(fs::symlink_metadata(&selected)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(identity(&source), original_source);
        assert_eq!(identity(&target), original_target);
        assert_eq!(fs::read(&source).unwrap(), b"source sentinel");
        assert_eq!(fs::read(&target).unwrap(), b"target sentinel");
        assert_eq!(fixture.backup_count(), 0);
    }
}

#[test]
fn later_architecture_symlink_is_rejected_before_first_architecture_moves() {
    let fixture = Fixture::new();
    Fixture::write(&fixture.source, "arm64", b"new arm64");
    Fixture::write(&fixture.source, "x64", b"new x64");
    let target = Fixture::write(&fixture.target, "arm64", b"original arm64");
    let original_id = identity(&target);
    let external = fixture.root.join("external sentinel");
    fs::write(&external, b"must not modify").unwrap();
    let linked = Fixture::entry(&fixture.target, "x64");
    fs::create_dir_all(linked.parent().unwrap()).unwrap();
    symlink(&external, &linked).unwrap();
    assert!(
        ResourceCopyGuard::prepare(&fixture.source, &fixture.target, &fixture.backups).is_err()
    );
    assert_eq!(identity(&target), original_id);
    assert_eq!(fs::read(&target).unwrap(), b"original arm64");
    assert_eq!(fs::read(external).unwrap(), b"must not modify");
    assert!(fs::symlink_metadata(linked)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fixture.backup_count(), 0);
}

#[test]
fn symlinked_backup_parent_is_rejected_without_modifying_runtime() {
    let fixture = Fixture::new();
    Fixture::write(&fixture.source, "arm64", b"new build");
    let target = Fixture::write(&fixture.target, "arm64", b"original build");
    let original_id = identity(&target);
    let external = fixture.root.join("external-backups");
    fs::rename(&fixture.backups, &external).unwrap();
    symlink(&external, &fixture.backups).unwrap();
    assert!(
        ResourceCopyGuard::prepare(&fixture.source, &fixture.target, &fixture.backups).is_err()
    );
    assert_eq!(identity(&target), original_id);
    assert_eq!(fs::read(target).unwrap(), b"original build");
    assert_eq!(fs::read_dir(external).unwrap().count(), 0);
}

#[test]
fn non_file_entry_is_rejected_without_removing_directory_contents() {
    for source_side in [true, false] {
        let fixture = Fixture::new();
        Fixture::write(&fixture.source, "arm64", b"new build");
        Fixture::write(&fixture.target, "arm64", b"old build");
        let entry = Fixture::entry(
            if source_side {
                &fixture.source
            } else {
                &fixture.target
            },
            "arm64",
        );
        fs::remove_file(&entry).unwrap();
        fs::create_dir(&entry).unwrap();
        let sentinel = entry.join("sentinel");
        fs::write(&sentinel, b"untouched").unwrap();
        assert!(
            ResourceCopyGuard::prepare(&fixture.source, &fixture.target, &fixture.backups).is_err()
        );
        assert_eq!(fs::read(sentinel).unwrap(), b"untouched");
        assert_eq!(fixture.backup_count(), 0);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn live_macho_child_survives_replacement_and_new_executable_starts() {
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let fixture = Fixture::new();
    // Use our own linker-signed Mach-O. Relocating Apple's platform-signed
    // system executables can independently fail code-signature enforcement.
    let executable = std::env::var_os("KEEPWORK_RESOURCE_TEST_CHILD").unwrap();
    let source = Fixture::entry(&fixture.source, "arm64");
    let target = Fixture::entry(&fixture.target, "arm64");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::copy(&executable, &source).unwrap();
    fs::copy(&executable, &target).unwrap();
    let old_id = identity(&target);
    let mut old_child = OwnedChild(
        Command::new(&target)
            .arg("hold")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(old_child.0.try_wait().unwrap().is_none());
    let mut guard = fixture.prepare();
    assert!(old_child.0.try_wait().unwrap().is_none());
    fs::copy(&source, &target).unwrap();
    assert_ne!(identity(&target), old_id);
    guard.commit().unwrap();
    assert!(
        old_child.0.try_wait().unwrap().is_none(),
        "isolating a file must preserve its running process"
    );
    let new_child = Command::new(&target)
        .arg("fresh-executable-works")
        .output()
        .unwrap();
    assert!(
        new_child.status.success(),
        "new executable exited {:?}; stdout={:?}, stderr={:?}",
        new_child.status,
        new_child.stdout,
        new_child.stderr
    );
    assert_eq!(new_child.stdout, b"fresh-executable-works\n");
    assert_eq!(fixture.backup_count(), 0);
}
