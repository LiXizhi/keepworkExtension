use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("keepwork-mac-overwrite-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn app(root: &Path, name: &str, version: &str, identifier: &str, marker: &Path) -> PathBuf {
    let bundle = root.join(format!("{name}.app"));
    let macos = bundle.join("Contents/MacOS");
    fs::create_dir_all(&macos).unwrap();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleName</key><string>Keepwork Update Fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>{version}</string><key>LSUIElement</key><true/></dict></plist>"#
    );
    fs::write(bundle.join("Contents/Info.plist"), plist).unwrap();
    let marker_literal = serde_json::to_string(marker.to_str().unwrap()).unwrap();
    let args_literal =
        serde_json::to_string(marker.with_extension("args").to_str().unwrap()).unwrap();
    let code = format!("#include <stdio.h>\n#include <string.h>\nint main(int argc, char **argv) {{ FILE *f = fopen({args_literal}, \"wb\"); if (f) {{ for(int i = 1; i < argc; i++) fwrite(argv[i], 1, strlen(argv[i]) + 1, f); fclose(f); }} f = fopen({marker_literal}, \"w\"); if (f) {{ fputs(\"{version}\", f); fclose(f); }} return 0; }}\n");
    let source = root.join(format!("{}.c", uuid::Uuid::new_v4()));
    fs::write(&source, code).unwrap();
    assert!(Command::new("/usr/bin/clang")
        .arg(&source)
        .arg("-o")
        .arg(macos.join("Fixture"))
        .status()
        .unwrap()
        .success());
    fs::remove_file(source).unwrap();
    assert!(Command::new("/usr/bin/codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(&bundle)
        .status()
        .unwrap()
        .success());
    bundle
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.is_file() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(path.is_file(), "missing {}", path.display());
}

#[test]
fn rejects_bundle_identity_version_and_executable_escape() {
    let fixture = Fixture::new();
    let bundle = app(
        &fixture.0,
        "Other",
        "1.0.0",
        "example.other",
        &fixture.0.join("marker"),
    );
    assert!(validate_candidate(&bundle, "1.0.0")
        .unwrap_err()
        .contains("标识"));
    let valid = app(
        &fixture.0,
        "Keepwork",
        "1.1.0",
        BUNDLE_ID,
        &fixture.0.join("marker"),
    );
    assert!(validate_candidate(&valid, "1.0.0")
        .unwrap_err()
        .contains("版本"));
    let exe = valid.join("Contents/MacOS/Fixture");
    fs::remove_file(&exe).unwrap();
    std::os::unix::fs::symlink("/bin/ls", &exe).unwrap();
    assert!(validate_candidate(&valid, "1.1.0")
        .unwrap_err()
        .contains("越出"));
    assert!(installed_bundle(Path::new("/bin/ls")).is_err());
}

#[test]
fn helper_rolls_back_rejected_launch_and_keeps_previous_app() {
    let fixture = Fixture::new();
    let target = app(
        &fixture.0,
        "Keepwork",
        "1.0.0",
        BUNDLE_ID,
        &fixture.0.join("old-started"),
    );
    let transaction = fixture.0.join(".keepwork-update-test");
    fs::create_dir(&transaction).unwrap();
    fs::create_dir(transaction.join("next.app")).unwrap(); // LaunchServices must reject this.
    let mut parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut helper = Command::new("/bin/sh")
        .args(["-c", HELPER, "keepwork-update"])
        .arg(parent.id().to_string())
        .arg(&target)
        .arg(&transaction)
        .args(["1", "1.1.0"])
        .arg(format!(
            "{}:{}",
            fs::metadata(&target).unwrap().dev(),
            fs::metadata(&target).unwrap().ino()
        ))
        .arg(format!(
            "{}:{}",
            fs::metadata(transaction.join("next.app")).unwrap().dev(),
            fs::metadata(transaction.join("next.app")).unwrap().ino()
        ))
        .arg(&fixture.0)
        .spawn()
        .unwrap();
    wait_for(&transaction.join("ready"));
    parent.kill().unwrap();
    parent.wait().unwrap();
    assert!(!helper.wait().unwrap().success());
    assert_eq!(bundle_info(&target).unwrap().version, "1.0.0");
    assert!(transaction.join("failed.app").is_dir());
    let old_args = fixture.0.join("old-started.args");
    wait_for(&fixture.0.join("old-started"));
    let expected = format!("--user-data-dir={}", fixture.0.display());
    assert!(fs::read(old_args)
        .unwrap()
        .split(|byte| *byte == 0)
        .any(|arg| arg == expected.as_bytes()));
    assert!(fs::read_to_string(transaction.join("status"))
        .unwrap()
        .contains("previous application restored"));
}

/// Real read-only DMG mounting, ditto, code-sign verification, same-volume swap,
/// and LaunchServices restart. Runs only when explicitly requested on macOS.
#[test]
#[ignore = "requires native hdiutil/LaunchServices; run for macOS update smoke"]
fn native_dmg_overwrite_and_restart_smoke() {
    let fixture = Fixture::new();
    let downloads = fixture.0.join("downloads");
    let source = fixture.0.join("image");
    fs::create_dir(&downloads).unwrap();
    fs::create_dir(&source).unwrap();
    let marker = fixture.0.join("new-started");
    let profile_alias = fixture.0.join("profile-link");
    let profile = fixture.0.join("profile spaces ' \" $()");
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("profile.json"), b"profile survives").unwrap();
    std::os::unix::fs::symlink(&profile, &profile_alias).unwrap();
    let target = app(
        &fixture.0,
        "Keepwork spaces ' $()",
        "1.0.0",
        BUNDLE_ID,
        &fixture.0.join("old-started"),
    );
    let _candidate = app(&source, "Keepwork", "1.1.0", BUNDLE_ID, &marker);
    let dmg = downloads.join("candidate.dmg");
    assert!(Command::new("/usr/bin/hdiutil")
        .args(["create", "-quiet", "-fs", "HFS+", "-srcfolder"])
        .arg(&source)
        .args(["-format", "UDZO"])
        .arg(&dmg)
        .status()
        .unwrap()
        .success());
    let mut parent = Command::new("/bin/sleep").arg("60").spawn().unwrap();
    launch_for_bundle(&dmg, "1.1.0", true, &target, parent.id(), &profile_alias).unwrap();
    let record: Transaction =
        serde_json::from_slice(&fs::read(downloads.join("macos-install.json")).unwrap()).unwrap();
    assert_eq!(bundle_info(&target).unwrap().version, "1.0.0");
    parent.kill().unwrap();
    parent.wait().unwrap();
    wait_for(&record.transaction.join("installed"));
    wait_for(&marker);
    assert_eq!(fs::read_to_string(&marker).unwrap(), "1.1.0");
    wait_for(&marker.with_extension("args"));
    let args = fs::read(marker.with_extension("args")).unwrap();
    let expected = format!(
        "--user-data-dir={}",
        profile.canonicalize().unwrap().display()
    );
    assert!(args
        .split(|byte| *byte == 0)
        .any(|arg| arg == expected.as_bytes()));
    assert_eq!(bundle_info(&target).unwrap().version, "1.1.0");
    assert_eq!(
        bundle_info(&record.transaction.join("previous.app"))
            .unwrap()
            .version,
        "1.0.0"
    );
    assert!(!fixture.0.join("old-started").exists());
    assert!(!record.transaction.join("volume").exists());
    // User data outside the application bundle stays untouched.
    assert_eq!(
        fs::read(profile.join("profile.json")).unwrap(),
        b"profile survives"
    );
}

#[test]
fn helper_quit_update_does_not_relaunch_and_keeps_backup() {
    let fixture = Fixture::new();
    let target = fixture.0.join("Keepwork.app");
    let transaction = fixture.0.join(".keepwork-update-fixture");
    let next = transaction.join("next.app");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("version"), "1.0.0").unwrap();
    fs::create_dir_all(&next).unwrap();
    fs::write(next.join("version"), "1.1.0").unwrap();
    let mut parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut helper = Command::new("/bin/sh")
        .args(["-c", HELPER, "keepwork-update"])
        .arg(parent.id().to_string())
        .arg(&target)
        .arg(&transaction)
        .args(["0", "1.1.0"])
        .arg(format!(
            "{}:{}",
            fs::metadata(&target).unwrap().dev(),
            fs::metadata(&target).unwrap().ino()
        ))
        .arg(format!(
            "{}:{}",
            fs::metadata(&next).unwrap().dev(),
            fs::metadata(&next).unwrap().ino()
        ))
        .arg(&fixture.0)
        .spawn()
        .unwrap();
    wait_for(&transaction.join("ready"));
    parent.kill().unwrap();
    parent.wait().unwrap();
    assert!(helper.wait().unwrap().success());
    assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "1.1.0");
    assert_eq!(
        fs::read_to_string(transaction.join("previous.app/version")).unwrap(),
        "1.0.0"
    );
    // Neither fixture is launchable: success proves the no-relaunch branch.
    assert!(transaction.join("installed").is_file());
}

#[test]
fn helper_refuses_changed_target_after_parent_wait() {
    let fixture = Fixture::new();
    let target = fixture.0.join("Keepwork.app");
    let transaction = fixture.0.join(".keepwork-update-fixture");
    let next = transaction.join("next.app");
    fs::create_dir(&target).unwrap();
    fs::create_dir_all(&next).unwrap();
    let mut parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let mut helper = Command::new("/bin/sh")
        .args(["-c", HELPER, "keepwork-update"])
        .arg(parent.id().to_string())
        .arg(&target)
        .arg(&transaction)
        .args(["0", "1.1.0"])
        .arg(format!(
            "{}:{}",
            fs::metadata(&target).unwrap().dev(),
            fs::metadata(&target).unwrap().ino()
        ))
        .arg(format!(
            "{}:{}",
            fs::metadata(&next).unwrap().dev(),
            fs::metadata(&next).unwrap().ino()
        ))
        .arg(&fixture.0)
        .spawn()
        .unwrap();
    wait_for(&transaction.join("ready"));
    fs::rename(&target, fixture.0.join("old.app")).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(target.join("other-installer"), "retain").unwrap();
    parent.kill().unwrap();
    parent.wait().unwrap();
    assert!(!helper.wait().unwrap().success());
    assert_eq!(
        fs::read_to_string(target.join("other-installer")).unwrap(),
        "retain"
    );
    assert!(next.is_dir());
    assert!(!transaction.join("installed").exists());
    assert!(!transaction.join("previous.app").exists());
}
