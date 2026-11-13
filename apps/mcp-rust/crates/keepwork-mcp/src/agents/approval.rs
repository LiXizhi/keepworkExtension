//! Optional Codex approvals, separate from legacy chat-mode defaults.
use serde_json::{json, Value};

pub(super) const MODES: &[&str] = &["default", "on-request", "untrusted", "never", "read-only"];

pub(super) fn selected(
    input: Option<&Value>,
    backend: &str,
    previous: Option<&Value>,
) -> Result<Option<String>, String> {
    if input.is_some() && backend != "codex" {
        return Err("UNSUPPORTED_FEATURE: Independent approvals require Codex".into());
    }
    let Some(value) = input.or(previous.filter(|v| !v.is_null())) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .filter(|value| MODES.contains(value))
        .ok_or("Unsupported agent approval mode")?;
    if backend != "codex" {
        return Err("UNSUPPORTED_FEATURE: Independent approvals require Codex".into());
    }
    Ok((value != "default").then(|| value.to_string()))
}

pub(super) fn read_only(mode: &str, approval: Option<&str>) -> bool {
    approval.is_some() && (mode != "craft" || approval == Some("read-only"))
}

pub(super) struct Access {
    pub sandbox: &'static str,
    pub policy: &'static str,
    pub sandbox_policy: Value,
}

pub(super) fn access(mode: &str, approval: Option<&str>, roots: &Value) -> Access {
    if read_only(mode, approval) {
        return Access {
            sandbox: "read-only",
            policy: "never",
            sandbox_policy: json!({"type":"readOnly"}),
        };
    }
    if matches!(approval, Some("on-request" | "untrusted")) {
        return Access {
            sandbox: "workspace-write",
            policy: if approval == Some("untrusted") {
                "untrusted"
            } else {
                "on-request"
            },
            sandbox_policy: json!({"type":"workspaceWrite","writableRoots":roots,"networkAccess":false}),
        };
    }
    if mode == "craft" {
        Access {
            sandbox: "danger-full-access",
            policy: "never",
            sandbox_policy: json!({"type":"dangerFullAccess"}),
        }
    } else {
        Access {
            sandbox: "read-only",
            policy: if mode == "ask" { "on-request" } else { "never" },
            sandbox_policy: json!({"type":"readOnly"}),
        }
    }
}

/// An explicit selection must never flow through the legacy Craft auto-accept.
pub(super) fn decision(
    data: &Value,
    method: &str,
    params: &Value,
    requires_decision: bool,
    request_read_only: bool,
) -> Option<&'static str> {
    let mode = data["mode"].as_str().unwrap_or("craft");
    let approval = data["approvalMode"].as_str();
    if read_only(mode, approval) && method != "item/tool/requestUserInput" {
        return Some(
            if request_read_only
                && !requires_decision
                && method == "item/commandExecution/requestApproval"
            {
                "accept"
            } else {
                "decline"
            },
        );
    }
    if approval.is_none() && mode == "plan" && method != "item/tool/requestUserInput" {
        return Some(if request_read_only && !requires_decision {
            "accept"
        } else {
            "decline"
        });
    }
    if requires_decision {
        return None;
    }
    if approval.is_some() {
        let accepts_once = params["availableDecisions"]
            .as_array()
            .is_none_or(|choices| choices.iter().any(|choice| choice == "accept"));
        return (approval == Some("never") && accepts_once).then_some("accept");
    }
    if mode == "craft" {
        Some("accept")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitted_selection_preserves_an_existing_policy_and_default_resets_it() {
        assert_eq!(selected(None, "codex", None).unwrap(), None);
        assert_eq!(
            selected(None, "codex", Some(&json!("untrusted")))
                .unwrap()
                .as_deref(),
            Some("untrusted")
        );
        assert_eq!(
            selected(Some(&json!("default")), "codex", Some(&json!("read-only"))).unwrap(),
            None
        );
        for invalid in [json!(null), json!("auto"), json!({}), json!(1)] {
            assert!(selected(Some(&invalid), "codex", None).is_err());
        }
        for mode in MODES {
            assert!(selected(Some(&json!(mode)), "claude", None).is_err());
        }
    }

    #[test]
    fn native_access_retains_legacy_defaults_and_bounds_explicit_modes() {
        let roots = json!(["/fixture/project", "/fixture/shared"]);
        for mode in ["craft", "ask", "plan"] {
            let legacy = access(mode, None, &roots);
            assert_eq!(
                legacy.sandbox,
                if mode == "craft" {
                    "danger-full-access"
                } else {
                    "read-only"
                }
            );
            assert_eq!(
                legacy.policy,
                if mode == "ask" { "on-request" } else { "never" }
            );
            for selected in ["on-request", "untrusted", "never", "read-only"] {
                let actual = access(mode, Some(selected), &roots);
                if mode != "craft" || selected == "read-only" {
                    assert_eq!(actual.sandbox, "read-only");
                    assert_eq!(actual.policy, "never");
                } else if selected == "never" {
                    assert_eq!(actual.sandbox, "danger-full-access");
                    assert_eq!(actual.policy, "never");
                } else {
                    assert_eq!(actual.sandbox, "workspace-write");
                    assert_eq!(actual.policy, selected);
                    assert_eq!(actual.sandbox_policy["writableRoots"], roots);
                    assert_eq!(actual.sandbox_policy["networkAccess"], false);
                }
            }
        }
    }

    #[test]
    fn explicit_approvals_do_not_use_legacy_craft_auto_accept() {
        let command = "item/commandExecution/requestApproval";
        for mode in ["on-request", "untrusted"] {
            assert_eq!(
                decision(
                    &json!({"mode":"craft","approvalMode":mode}),
                    command,
                    &json!({}),
                    false,
                    false
                ),
                None
            );
        }
        assert_eq!(
            decision(&json!({"mode":"craft"}), command, &json!({}), false, false),
            Some("accept")
        );
        let full = json!({"mode":"craft","approvalMode":"never"});
        assert_eq!(
            decision(&full, command, &json!({}), false, false),
            Some("accept")
        );
        assert_eq!(
            decision(
                &full,
                command,
                &json!({"availableDecisions":["acceptForSession"]}),
                false,
                false
            ),
            None
        );
        assert_eq!(decision(&full, command, &json!({}), true, false), None);
        for mode in ["craft", "ask", "plan"] {
            let readonly = json!({"mode":mode,"approvalMode":"read-only"});
            assert_eq!(
                decision(&readonly, command, &json!({}), false, true),
                Some("accept")
            );
            assert_eq!(
                decision(&readonly, command, &json!({}), false, false),
                Some("decline")
            );
            assert_eq!(
                decision(
                    &readonly,
                    "item/fileChange/requestApproval",
                    &json!({}),
                    false,
                    true
                ),
                Some("decline")
            );
            assert_eq!(
                decision(
                    &readonly,
                    "item/permissions/requestApproval",
                    &json!({}),
                    false,
                    true
                ),
                Some("decline")
            );
            assert_eq!(
                decision(
                    &readonly,
                    "item/tool/requestUserInput",
                    &json!({}),
                    true,
                    false
                ),
                None
            );
        }
    }
}
