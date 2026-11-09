use aichat_rust_lib::{files::NativeFiles, terminal::TerminalSessionManager};
use serde_json::json;
use std::fs;
use std::thread;
use std::time::Duration;
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
            &json!({ "id": session_id, "data": "echo AICHAT_RUST_PTY_SMOKE_PASS\n" }),
        )
        .unwrap();

    let mut output_acc = String::new();
    let mut cursor = 0usize;
    for _ in 0..40 {
        let chunk = manager
            .handle(
                "desktop:main",
                &files,
                "output",
                &json!({ "id": session_id, "cursor": cursor }),
            )
            .unwrap();
        cursor = chunk["cursor"].as_u64().unwrap() as usize;
        output_acc.push_str(chunk["output"].as_str().unwrap_or(""));
        if output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS") {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        output_acc.contains("AICHAT_RUST_PTY_SMOKE_PASS"),
        "PTY smoke did not receive expected marker: {output_acc}"
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

    let _ = fs::remove_dir_all(&root);
    println!("pty-smoke: OK");
}
