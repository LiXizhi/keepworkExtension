use super::*;
use std::time::Instant;

const DASHBOARD: &str = "http://127.0.0.1:8089/dashboard#personas";

#[derive(Debug)]
struct BrowserInvocation {
    program: String,
    args: Vec<String>,
    timeout: Duration,
}

fn invocation(command: &Command, timeout: Duration) -> BrowserInvocation {
    BrowserInvocation {
        program: command.get_program().to_string_lossy().into_owned(),
        args: command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect(),
        timeout,
    }
}

fn assert_applescript(call: &BrowserInvocation, url: &str) {
    assert_eq!(call.program, "/usr/bin/osascript");
    assert_eq!(
        call.args,
        [
            "-e",
            "on run argv\ntell application id (item 1 of argv) to open location (item 2 of argv)\nend run",
            "com.google.Chrome",
            url,
        ]
    );
    assert_eq!(call.timeout, Duration::from_secs(3));
}

fn assert_system_open(call: &BrowserInvocation, url: &str) {
    assert_eq!(call.program, "/usr/bin/open");
    assert_eq!(call.args, ["--", url]);
    assert!(call.timeout > Duration::ZERO);
    assert!(call.timeout <= Duration::from_secs(3));
}

#[test]
fn browser_apple_event_success_does_not_open_a_second_tab() {
    let mut calls = Vec::new();
    let result = open_macos_url(DASHBOARD, Some("com.google.Chrome"), |command, timeout| {
        calls.push(invocation(command, timeout));
        Ok(())
    });
    assert!(result.is_ok());
    assert_eq!(calls.len(), 1, "successful delivery must not be repeated");
    assert_applescript(&calls[0], DASHBOARD);
}

#[test]
fn browser_apple_event_failures_fall_back_once_to_system_open() {
    for failure in [
        "osascript exit status: 1",
        "osascript spawn: Permission denied",
        "osascript timed out after 3 seconds",
    ] {
        let mut calls = Vec::new();
        let result = open_macos_url(DASHBOARD, Some("com.google.Chrome"), |command, timeout| {
            calls.push(invocation(command, timeout));
            if calls.len() == 1 {
                Err(failure.to_string())
            } else {
                Ok(())
            }
        });
        assert!(result.is_ok(), "fallback must recover from {failure}");
        assert_eq!(calls.len(), 2, "one fallback is sufficient: {failure}");
        assert_applescript(&calls[0], DASHBOARD);
        assert_system_open(&calls[1], DASHBOARD);
    }
}

#[test]
fn browser_without_a_saved_default_uses_only_system_open() {
    let mut calls = Vec::new();
    let result = open_macos_url(DASHBOARD, None, |command, timeout| {
        calls.push(invocation(command, timeout));
        Ok(())
    });
    assert!(result.is_ok());
    assert_eq!(calls.len(), 1);
    assert_system_open(&calls[0], DASHBOARD);
}

#[test]
fn browser_url_is_an_argument_in_both_opening_paths() {
    let url = "http://localhost:8089/dashboard?name=\"quote\"&literal=$(touch%20fixture)#personas";
    let mut calls = Vec::new();
    let result = open_macos_url(url, Some("com.google.Chrome"), |command, timeout| {
        calls.push(invocation(command, timeout));
        if calls.len() == 1 {
            Err("fixture failure".to_string())
        } else {
            Ok(())
        }
    });
    assert!(result.is_ok());
    assert_eq!(calls.len(), 2);
    assert_applescript(&calls[0], url);
    assert_system_open(&calls[1], url);
}

#[test]
fn browser_invalid_bundle_identifiers_cannot_execute_a_command() {
    for bundle_id in [
        "",
        "com.google.Chrome;exit",
        "com.google.Chrome\n",
        "com.google.Chrome\r",
        "com.google.Chrome extra",
        "com.google.Chrome/other",
        "$(fixture)",
        "浏览器",
    ] {
        let mut calls = 0;
        let result = open_macos_url(DASHBOARD, Some(bundle_id), |_, _| {
            calls += 1;
            Ok(())
        });
        assert!(result.is_err(), "invalid bundle identifier: {bundle_id:?}");
        assert_eq!(calls, 0, "invalid identifiers must not reach an opener");
    }
}

#[test]
fn browser_reports_both_failures_when_fallback_also_fails() {
    let mut calls = 0;
    let result = open_macos_url(DASHBOARD, Some("com.google.Chrome"), |_, _| {
        calls += 1;
        Err(if calls == 1 {
            "fixture Apple event failure".to_string()
        } else {
            "fixture system open failure".to_string()
        })
    });
    let error = result.expect_err("both opening methods failed");
    assert_eq!(calls, 2);
    assert!(error.contains("fixture Apple event failure"), "{error}");
    assert!(error.contains("fixture system open failure"), "{error}");

    let error = open_macos_url(DASHBOARD, None, |_, _| {
        Err("fixture missing-default failure".to_string())
    })
    .expect_err("system opener failed without a known default");
    assert!(error.contains("fixture missing-default failure"), "{error}");
}

#[test]
fn browser_command_runner_observes_success_failure_and_spawn_error() {
    assert!(
        run_browser_command(&mut Command::new("/usr/bin/true"), Duration::from_secs(1)).is_ok()
    );

    let error = run_browser_command(
        Command::new("/bin/sh").args(["-c", "exit 17"]),
        Duration::from_secs(1),
    )
    .expect_err("nonzero command exits must not be reported as delivery");
    assert!(!error.is_empty());

    let missing = std::env::temp_dir().join(format!(
        "aichat-missing-browser-command-{}",
        uuid::Uuid::new_v4()
    ));
    assert!(run_browser_command(&mut Command::new(missing), Duration::from_secs(1)).is_err());
}

#[test]
fn browser_command_timeout_is_bounded_and_reaps_the_child() {
    let pid_path = std::env::temp_dir().join(format!(
        "aichat-browser-timeout-{}.pid",
        uuid::Uuid::new_v4()
    ));
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
        "browser-timeout-fixture",
    ]);
    command.arg(&pid_path);
    let started = Instant::now();
    let result = run_browser_command(&mut command, Duration::from_millis(300));
    let elapsed = started.elapsed();
    let pid: libc::pid_t = std::fs::read_to_string(&pid_path)
        .expect("fixture child records its own PID before sleeping")
        .parse()
        .expect("fixture PID is numeric");
    let _ = std::fs::remove_file(&pid_path);

    // A zombie still answers kill(pid, 0). Checking both calls proves the
    // timed-out child was killed and waited, rather than simply detached.
    let exists = unsafe { libc::kill(pid, 0) } == 0;
    let mut status = 0;
    let reap_result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    let reap_error = std::io::Error::last_os_error().raw_os_error();
    if exists && reap_result == 0 {
        // Confine failure cleanup to the PID created by this fixture.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, &mut status, 0);
        }
    }

    assert!(result.is_err(), "a timed-out command must report failure");
    assert!(elapsed < Duration::from_secs(3), "elapsed: {elapsed:?}");
    assert!(
        !exists,
        "the fixture child must not survive or become a zombie"
    );
    assert_eq!(reap_result, -1, "the runner already waited for its child");
    assert_eq!(reap_error, Some(libc::ECHILD));
}

#[test]
fn browser_dashboard_urls_remain_subject_to_external_link_security() {
    for url in [
        DASHBOARD,
        "http://localhost:8089/dashboard#personas",
        "http://[::1]:8089/dashboard#personas",
        "http://127.0.0.1:18089/dashboard#personas",
    ] {
        assert_eq!(crate::security::external_url(url).as_deref(), Some(url));
    }
    for url in [
        "http://secret@localhost:8089/dashboard#personas",
        "http://localhost:8089/dashboard?token=secret#personas",
        "http://localhost:8089/dashboard?ACCESS_TOKEN=secret#personas",
        "http://localhost:8089/dashboard?id_token=secret#personas",
        "http://localhost:8089/dashboard?authorization=secret#personas",
        "file:///tmp/dashboard.html",
        "javascript:alert(1)",
    ] {
        assert_eq!(crate::security::external_url(url), None);
    }
}
