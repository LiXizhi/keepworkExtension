//! Native fake DWS/Lark CLI for the wire tests, including Windows CreateProcess.
use std::{env, ffi::OsStr, io::Write, path::Path, thread, time::Duration};

fn main() {
    let executable = env::current_exe().expect("fixture executable path");
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or_default();
    let subcommand = args.get(1).map(String::as_str).unwrap_or_default();
    if executable.file_stem() == Some(OsStr::new("lark-cli")) {
        if Path::new(".feishu-auth-not-ready").exists() {
            println!(
                "{}",
                r#"{"appId":"cli_fixture","identities":{"user":{"status":"not_authenticated","available":false,"verified":false}}}"#
            );
            return;
        }
        if !Path::new(".feishu-ready").exists() {
            eprintln!("未登录: run lark auth login first");
            std::process::exit(1);
        }
        let response = match (command, subcommand) {
            ("auth", "status") => {
                r#"{"appId":"cli_fixture","identities":{"user":{"status":"ready","available":true,"verified":true,"openId":"ou_fixture"}}}"#
            }
            ("im", "+messages-search") => r#"{"data":{"messages":[],"has_more":false}}"#,
            _ => {
                eprintln!("unsupported fixture command");
                std::process::exit(2);
            }
        };
        println!("{response}");
        return;
    }

    let response = match (command, subcommand) {
        ("profile", "list") => {
            r#"{"currentProfile":"corp1:user1","profiles":[{"corpId":"corp1","userId":"user1","corpName":"Acme","userName":"Tester","isCurrent":true}]}"#
        }
        ("event", "status") => {
            r#"{"identity":{"corpId":"corp1","userId":"user1","openDingTalkId":"oid-1"},"bus":{"live":{"consumers":[]}},"subscriptions":[]}"#
        }
        ("chat", "+chat-list" | "+chat-search") => {
            r#"[{"openConversationId":"cidG1","name":"研发群"},{"openConversationId":"cidG2","name":"客服群"}]"#
        }
        ("event", "consume") => {
            eprintln!("[event] ready");
            // Blank lines are ignored by the daemon. A closed stdout pipe lets
            // us exit even when Windows kills the daemon without running Drop.
            let mut stdout = std::io::stdout().lock();
            while stdout
                .write_all(b"\n")
                .and_then(|()| stdout.flush())
                .is_ok()
            {
                thread::sleep(Duration::from_millis(100));
            }
            return;
        }
        ("auth", "login") => return,
        _ => "{}",
    };
    println!("{response}");
}
