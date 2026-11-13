//! Exercise Tauri's real command authority without touching the OS clipboard.
use std::collections::BTreeMap;
use tauri::ipc::{Origin, RuntimeAuthority};
use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
use tauri::utils::platform::Target;

const CLIPBOARD_COMMANDS: [&str; 3] = [
    "plugin:clipboard-manager|read_text",
    "plugin:clipboard-manager|write_text",
    "plugin:clipboard-manager|write_image",
];
const CLIPBOARD_PERMISSIONS: [&str; 3] = [
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-write-image",
];

fn authority(target: Target, restore_old_grants: bool) -> RuntimeAuthority {
    // These are the actual build-script inputs to the production authority,
    // including every capability and the registered plugins' real manifests.
    let manifests: BTreeMap<String, Manifest> =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let mut capabilities: serde_json::Value =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    if restore_old_grants {
        let permissions = capabilities["default"]["permissions"]
            .as_array_mut()
            .unwrap();
        permissions.retain(|permission| {
            !CLIPBOARD_PERMISSIONS
                .iter()
                .any(|old| permission.as_str() == Some(old))
        });
        permissions.extend(CLIPBOARD_PERMISSIONS.map(serde_json::Value::from));
    }
    let capabilities: BTreeMap<String, Capability> = serde_json::from_value(capabilities).unwrap();
    let resolved = Resolved::resolve(&manifests, capabilities, target).unwrap();
    tauri::runtime_authority!(manifests, resolved)
}

#[derive(Debug, Default)]
struct ClipboardSpy {
    calls: [usize; 3],
}

impl ClipboardSpy {
    fn dispatch(
        &mut self,
        authority: &RuntimeAuthority,
        command: &str,
        window: &str,
        webview: &str,
        origin: &Origin,
    ) -> bool {
        // Match the command authority used before Tauri dispatches a plugin
        // handler. The backend is a spy, never the installed clipboard plugin.
        if authority
            .resolve_access(command, window, webview, origin)
            .is_none()
        {
            return false;
        }
        let index = CLIPBOARD_COMMANDS
            .iter()
            .position(|name| *name == command)
            .unwrap();
        self.calls[index] += 1;
        true
    }
}

#[test]
fn native_clipboard_acl_rejects_raw_commands_before_backend_dispatch() {
    let mut spy = ClipboardSpy::default();
    let mut allowed = Vec::new();
    for target in [Target::MacOS, Target::Windows, Target::Linux] {
        let authority = authority(target, false);
        for window in ["main", "pet", "updates"] {
            // A window grant applies to all its webviews. Denial must hold
            // regardless of the invoking view or old/new webpage Bridge code.
            for webview in [window, "unprivileged-subview"] {
                let origins = [
                    Origin::Local,
                    Origin::Remote {
                        url: "https://keepwork.com/chat".parse().unwrap(),
                    },
                    Origin::Remote {
                        url: "https://keepwork.com/other".parse().unwrap(),
                    },
                    Origin::Remote {
                        url: "https://cdn.keepwork.com/tool.html".parse().unwrap(),
                    },
                    Origin::Remote {
                        url: "http://127.0.0.1:31337/AIChat.html".parse().unwrap(),
                    },
                    Origin::Remote {
                        url: "http://localhost:31337/AIChat.html".parse().unwrap(),
                    },
                    Origin::Remote {
                        url: "https://example.org/".parse().unwrap(),
                    },
                ];
                for origin in &origins {
                    for command in CLIPBOARD_COMMANDS {
                        if spy.dispatch(&authority, command, window, webview, origin) {
                            allowed.push(format!("{target}/{window}/{webview}/{origin}/{command}"));
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        spy.calls,
        [0, 0, 0],
        "native clipboard backend reached; first route: {:?}",
        allowed.first()
    );
    assert!(allowed.is_empty());
}

#[test]
fn native_clipboard_acl_old_grants_reach_fake_backend_as_positive_control() {
    let mut spy = ClipboardSpy::default();
    let authority = authority(Target::current(), true);
    let origin = Origin::Remote {
        url: "https://keepwork.com/chat".parse().unwrap(),
    };
    for command in CLIPBOARD_COMMANDS {
        assert!(spy.dispatch(&authority, command, "main", "main", &origin));
    }
    assert_eq!(
        spy.calls,
        [1, 1, 1],
        "the regression oracle must detect the old bypass"
    );
    eprintln!("old clipboard grants: actual Tauri ACL permits read_text/write_text/write_image; fake backend calls={:?}; OS clipboard untouched", spy.calls);
}

#[test]
fn native_clipboard_acl_keeps_ordinary_bridge_and_unrelated_permissions() {
    for target in [Target::MacOS, Target::Windows, Target::Linux] {
        let authority = authority(target, false);
        for origin in [
            Origin::Local,
            Origin::Remote {
                url: "https://keepwork.com/chat".parse().unwrap(),
            },
        ] {
            for command in [
                "desktop_status",
                "desktop_roots",
                "plugin:dialog|open",
                "plugin:notification|notify",
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &origin)
                        .is_some(),
                    "unrelated route denied: {target}/{origin}/{command}"
                );
            }
        }
        assert!(authority
            .resolve_access(
                "remote_voice_status",
                "remote-voice",
                "remote-voice",
                &Origin::Local
            )
            .is_some());
        assert!(authority
            .resolve_access(
                "desktop_status",
                "login-popup",
                "login-popup",
                &Origin::Local
            )
            .is_none());
    }
}
