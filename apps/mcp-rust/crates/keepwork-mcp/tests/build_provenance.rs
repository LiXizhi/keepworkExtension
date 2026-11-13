//! Compile the real build script in A, then reuse that executable for Cargo's B.
//! A small offline fixture target replaces relocation of the user's large cache.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BUILD_SCRIPT: &str = include_str!("../build.rs");
const WORKSPACE_LOCK: &str = include_str!("../../../Cargo.lock");

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("kw-build-provenance-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("empty-git-template")).unwrap();
        fs::write(root.join("empty-git-config"), "").unwrap();
        Self { root }
    }

    fn isolated_command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_INDEX_FILE",
        ] {
            command.env_remove(key);
        }
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.root.join("empty-git-config"))
            .env("GIT_CEILING_DIRECTORIES", &self.root);
        command
    }

    fn git(&self, root: &Path, args: &[&str]) -> String {
        let output = self
            .isolated_command("git")
            .current_dir(root)
            .arg("-c")
            .arg(format!(
                "core.hooksPath={}",
                self.root.join("empty-git-template").display()
            ))
            .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn init_git(&self, root: &Path, message: &str) -> String {
        self.git(root, &["init", "-q", "-b", "main", "--object-format=sha1"]);
        self.git(root, &["config", "user.name", "Build provenance fixture"]);
        self.git(root, &["config", "user.email", "fixture@example.invalid"]);
        self.commit(root, message)
    }

    fn commit(&self, root: &Path, message: &str) -> String {
        self.git(root, &["add", "."]);
        self.git(root, &["commit", "-qm", message]);
        self.git(root, &["rev-parse", "HEAD"])
    }

    fn compile_in_a(&self) -> (PathBuf, PathBuf) {
        let workspace = self.root.join("A compile 空格");
        let crate_dir = workspace.join("crates/keepwork-mcp");
        fs::create_dir_all(crate_dir.join("src")).unwrap();
        fs::write(
            workspace.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/keepwork-mcp\"]\nresolver = \"2\"\n",
        )
        .unwrap();
        let sha2_version = WORKSPACE_LOCK
            .split("[[package]]")
            .filter(|block| block.lines().any(|line| line.trim() == "name = \"sha2\""))
            .filter_map(|block| {
                block.lines().find_map(|line| {
                    line.trim()
                        .strip_prefix("version = \"")
                        .and_then(|value| value.strip_suffix('"'))
                })
            })
            .find(|version| version.starts_with("0.10."))
            .expect("the main crate has already downloaded its locked sha2 dependency");
        fs::write(crate_dir.join("Cargo.toml"), format!("[package]\nname = \"build-provenance-fixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\nbuild = false\n[[bin]]\nname = \"build-script-under-test\"\npath = \"build.rs\"\n[dependencies]\nsha2 = \"={sha2_version}\"\n")).unwrap();
        fs::write(crate_dir.join("build.rs"), BUILD_SCRIPT).unwrap();
        fs::write(
            crate_dir.join("src/lib.rs"),
            "pub const MARKER: &str = \"initial identical bytes\";\n",
        )
        .unwrap();
        let target = self.root.join("small-compiler-target");
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let output = self
            .isolated_command(cargo)
            .current_dir(&workspace)
            .args(["build", "--quiet", "--offline", "--manifest-path"])
            .arg(crate_dir.join("Cargo.toml"))
            .args(["--bin", "build-script-under-test", "--target-dir"])
            .arg(&target)
            .env_remove("CARGO_TARGET_DIR")
            .env_remove("CARGO_BUILD_TARGET")
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .env("CARGO_INCREMENTAL", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "compile fixture offline: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let binary = target.join("debug").join(format!(
            "build-script-under-test{}",
            std::env::consts::EXE_SUFFIX
        ));
        (workspace, binary)
    }

    fn copy_inputs(&self, source: &Path, name: &str) -> PathBuf {
        let destination = self.root.join(name);
        fs::create_dir_all(destination.join("crates/keepwork-mcp/src")).unwrap();
        for relative in [
            "Cargo.toml",
            "Cargo.lock",
            "crates/keepwork-mcp/Cargo.toml",
            "crates/keepwork-mcp/build.rs",
            "crates/keepwork-mcp/src/lib.rs",
        ] {
            fs::copy(source.join(relative), destination.join(relative)).unwrap();
        }
        destination
    }

    fn run(&self, binary: &Path, workspace: &Path, name: &str, provide_manifest: bool) -> Output {
        let out = self.root.join("outputs").join(name);
        fs::create_dir_all(&out).unwrap();
        let crate_dir = workspace.join("crates/keepwork-mcp");
        let mut command = self.isolated_command(binary);
        command
            .current_dir(&crate_dir)
            .env("OUT_DIR", &out)
            .env("TARGET", "fixture-host")
            .env("CARGO_PKG_VERSION", "0.0.0")
            .env_remove("KEEPWORK_MCP_BUILD_COMMIT");
        if provide_manifest {
            command.env("CARGO_MANIFEST_DIR", crate_dir);
        } else {
            command.env_remove("CARGO_MANIFEST_DIR");
        }
        command.output().unwrap()
    }

    fn metadata(&self, name: &str) -> Value {
        serde_json::from_slice(
            &fs::read(self.root.join("outputs").join(name).join("build-info.json")).unwrap(),
        )
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn check_runtime_paths(output: &Output, workspace: &Path, has_git: bool, errors: &mut Vec<String>) {
    let root = workspace.canonicalize().unwrap();
    let crate_dir = workspace.join("crates/keepwork-mcp");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("cargo:rerun-if-changed="))
        .map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                crate_dir.join(path)
            }
        })
        .collect::<Vec<_>>();
    if paths.is_empty() {
        errors.push("build script did not declare rerun inputs".into());
    }
    for path in &paths {
        if !path
            .canonicalize()
            .is_ok_and(|value| value.starts_with(&root))
        {
            errors.push(format!(
                "rerun input belongs to compile-time A instead of runtime tree {}: {}",
                workspace.display(),
                path.display()
            ));
        }
    }
    if has_git
        && !paths
            .iter()
            .any(|path| path.canonicalize().ok() == workspace.join(".git/HEAD").canonicalize().ok())
    {
        errors.push("runtime Git HEAD is not watched".into());
    }
    if !has_git && stdout.contains("cargo:rustc-env=KEEPWORK_MCP_BUILD_COMMIT=") {
        errors.push("a no-Git runtime tree borrowed a commit from compile-time A".into());
    }
}

#[test]
fn a_relocated_build_script_uses_only_the_runtime_cargo_source_and_git() {
    let fixture = Fixture::new();
    let (a, binary) = fixture.compile_in_a();
    let b = fixture.copy_inputs(&a, "B runtime 空格");
    let a_commit = fixture.init_git(&a, "compile A");
    let b_commit = fixture.init_git(&b, "runtime B");
    assert_ne!(a_commit, b_commit);
    fixture.git(&b, &["pack-refs", "--all"]);
    let mut errors = Vec::new();

    let baseline = fixture.run(&binary, &a, "baseline-a", true);
    assert!(baseline.status.success());
    let baseline = fixture.metadata("baseline-a");
    let same = fixture.run(&binary, &b, "same-b", true);
    assert!(same.status.success());
    let same_info = fixture.metadata("same-b");
    if same_info["sourceHash"] != baseline["sourceHash"] {
        errors.push(
            "identical bytes in A and B must have identical path-independent sourceHash".into(),
        );
    }
    if same_info["commit"] != b_commit {
        errors.push(format!(
            "runtime B expected commit {b_commit}, got {}",
            same_info["commit"]
        ));
    }
    check_runtime_paths(&same, &b, true, &mut errors);

    fs::write(
        b.join("crates/keepwork-mcp/src/lib.rs"),
        "pub const MARKER: &str = \"B changed\";\n",
    )
    .unwrap();
    let changed_commit = fixture.commit(&b, "B source changed");
    let changed = fixture.run(&binary, &b, "changed-b", true);
    assert!(changed.status.success());
    let changed_info = fixture.metadata("changed-b");
    if changed_info["sourceHash"] == baseline["sourceHash"] {
        errors.push("changing B source did not change B sourceHash".into());
    }
    if changed_info["commit"] != changed_commit {
        errors.push("changing B Git commit did not update runtime build identity".into());
    }
    check_runtime_paths(&changed, &b, true, &mut errors);

    fs::write(
        a.join("crates/keepwork-mcp/src/lib.rs"),
        "pub const MARKER: &str = \"A changed later\";\n",
    )
    .unwrap();
    fixture.commit(&a, "A changed after relocation");
    let unaffected = fixture.run(&binary, &b, "unaffected-b", true);
    assert!(unaffected.status.success());
    let unaffected_info = fixture.metadata("unaffected-b");
    if unaffected_info["sourceHash"] != changed_info["sourceHash"]
        || unaffected_info["commit"] != changed_info["commit"]
    {
        errors.push("changing compile-time A changed runtime B identity".into());
    }

    let no_git = fixture.copy_inputs(&b, "C no Git");
    let unknown = fixture.run(&binary, &no_git, "no-git-c", true);
    assert!(unknown.status.success());
    let unknown_info = fixture.metadata("no-git-c");
    if unknown_info["commit"] != "" {
        errors.push("no-Git runtime C must report an empty unknown commit".into());
    }
    if unknown_info["sourceHash"] != changed_info["sourceHash"] {
        errors
            .push("identical B/C bytes changed hash because of their path or Git presence".into());
    }
    check_runtime_paths(&unknown, &no_git, false, &mut errors);
    let missing = fixture.run(&binary, &no_git, "missing-manifest", false);
    if missing.status.success() {
        errors.push("missing runtime CARGO_MANIFEST_DIR silently reused compile-time A".into());
    }

    println!("compile A commit={a_commit}; runtime B commit={b_commit}; updated B commit={changed_commit}; baseline hash={}; updated B hash={}", baseline["sourceHash"], changed_info["sourceHash"]);
    assert!(
        errors.is_empty(),
        "relocated build-script provenance violations:\n{}",
        errors.join("\n")
    );
}
