use aichat_rust_lib::{
    files::atomic_json_write,
    pet::{
        run_permission_bridge_session, PermissionBridgeRecord, PetController, PetPermissionPrompt,
        WorkArea,
    },
};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use uuid::Uuid;

fn main() {
    let root = std::env::temp_dir().join(format!("aichat-rust-pet-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    let controller = PetController::new(root.join("pet-prefs.json"));
    controller.set_work_area(WorkArea {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
    });

    let snap = controller.update_raw_state(json!({
        "context": "session-smoke",
        "ready": true,
        "pet": {
            "name": "抱抱龙",
            "sheetUrl": "https://cdn.keepwork.com/maisi/magichaqi/pet/dragon_green_20260528090748.webp"
        },
        "reply": {
            "text": "桌面宠物已就绪",
            "options": [{ "icon": "🐉", "text": "继续对话" }]
        }
    }));
    assert_eq!(snap["version"], 1);
    assert_eq!(snap["petPixels"], 112);

    let scaled = controller.set_scale(2.0);
    assert_eq!(scaled["petPixels"], 224);

    let (exit_id, _) = controller.begin_exit_prompt(false);
    controller.resolve_exit_info(&json!({
        "personas": [{ "name": "知识管家", "channels": ["飞书"] }]
    }));
    controller.verify_exit_confirm(&exit_id).unwrap();
    controller.cancel_exit_prompt();

    let perm_snap = controller.set_permission_prompt(Some(PetPermissionPrompt {
        id: "perm-1".to_string(),
        client: "Keepwork MCP".to_string(),
    }));
    assert_eq!(perm_snap["permission"]["id"], "perm-1");

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let bridge_file = root.join("pet-permission-bridge.json");
    atomic_json_write(
        &bridge_file,
        &PermissionBridgeRecord {
            port,
            token: "smoke-token".to_string(),
        },
    )
    .unwrap();

    let srv = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["role"], "desktop");

        let req = json!({ "type": "request", "id": "shot-1", "client": "Keepwork MCP" });
        stream.write_all(format!("{req}\n").as_bytes()).unwrap();
        stream.flush().unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        let resp: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(resp["id"], "shot-1");
        assert_eq!(resp["choice"], "always");
    });

    run_permission_bridge_session(&bridge_file, |id, _client| {
        assert_eq!(id, "shot-1");
        "always".to_string()
    })
    .unwrap();
    srv.join().unwrap();

    let _ = fs::remove_dir_all(&root);
    println!("pet-smoke: OK");
}
