use aichat_rust_lib::{files::NativeFiles, terminal::TerminalSessionManager};
use serde_json::json;
use std::fs;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

fn main() {
    let root = std::env::temp_dir().join(format!("aichat-rust-pty-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    let files = NativeFiles::new(root.join("grants.json"));
    let manager = TerminalSessionManager::new(root.join("workspaces"));
    struct Cleanup<'a>(&'a TerminalSessionManager, &'a std::path::Path);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            self.0.close_all();
            let _ = fs::remove_dir_all(self.1);
        }
    }
    let _cleanup = Cleanup(&manager, &root);

    let created = manager
        .handle(
            "desktop:main",
            &files,
            "create",
            &json!({ "workspace": "smoke-slot", "cols": 100, "rows": 30 }),
        )
        .unwrap();
    let session_id = created["id"].as_str().unwrap().to_string();
    assert!(session_id.starts_with("desktop:"));

    // The marker must be produced by execution, never matched in PTY echo.
    let command = if cfg!(windows) {
        "Write-Output ('AICHAT_RUST_PTY_' + 'SMOKE_PASS')\r\n"
    } else {
        "printf 'AICHAT_RUST_PTY_%s\\n' SMOKE_PASS\n"
    };
    assert!(!command.contains("AICHAT_RUST_PTY_SMOKE_PASS"));
    manager
        .handle(
            "desktop:main",
            &files,
            "resize",
            &json!({ "id": session_id, "cols": 120, "rows": 40 }),
        )
        .unwrap();

    manager
        .handle(
            "desktop:main",
            &files,
            "write",
            &json!({ "id": session_id, "data": command }),
        )
        .unwrap();

    let mut output_acc = String::new();
    let mut cursor = 0usize;
    let deadline = Instant::now() + Duration::from_secs(15);
    let last_chunk = loop {
        let chunk = manager
            .handle(
                "desktop:main",
                &files,
                "output",
                &json!({ "id": session_id, "cursor": cursor }),
            )
            .unwrap();
        let next_cursor = chunk["cursor"].as_u64().unwrap() as usize;
        assert!(
            next_cursor >= cursor,
            "Output cursor must not move backwards"
        );
        cursor = next_cursor;
        output_acc.push_str(chunk["output"].as_str().unwrap_or(""));
        if output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS")
            || chunk["closed"] == true
            || Instant::now() >= deadline
        {
            break chunk;
        }
        thread::sleep(Duration::from_millis(50));
    };
    assert!(
        output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS"),
        "PTY smoke did not receive executed command marker; last chunk: {last_chunk}; output: {output_acc}"
    );

    manager
        .handle(
            "desktop:main",
            &files,
            "interrupt",
            &json!({ "id": session_id }),
        )
        .unwrap();
    manager
        .handle(
            "desktop:main",
            &files,
            "close",
            &json!({ "id": session_id }),
        )
        .unwrap();

    println!("pty-smoke: OK");
}
