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

    // An echoed input line is not proof of command execution. Both shells
    // construct the contiguous marker only when the command actually runs.
    let command = if cfg!(windows) {
        "Write-Output ('AICHAT_RUST_' + 'PTY_SMOKE_PASS')\r\n"
    } else {
        "printf '%s%s\\n' AICHAT_RUST_ PTY_SMOKE_PASS\n"
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
    let mut last_chunk = serde_json::Value::Null;
    // Keep polling for the marker while a cold PowerShell starts on CI.
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let chunk = manager
            .handle(
                "desktop:main",
                &files,
                "output",
                &json!({ "id": session_id, "cursor": cursor }),
            )
            .unwrap();
        let next_cursor = chunk["cursor"].as_u64().unwrap() as usize;
        assert!(next_cursor >= cursor, "Output cursor must not move backwards");
        cursor = next_cursor;
        output_acc.push_str(chunk["output"].as_str().unwrap_or(""));
        last_chunk = chunk;
        if output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS") {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS") {
        manager.close_all();
        let _ = fs::remove_dir_all(&root);
        panic!("PTY smoke did not receive an executed marker: {output_acc:?}; final chunk: {last_chunk}");
    }

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

    let _ = fs::remove_dir_all(&root);
    println!("pty-smoke: OK");
}
