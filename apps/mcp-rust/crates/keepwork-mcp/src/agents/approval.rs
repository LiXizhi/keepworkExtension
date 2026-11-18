//! Explicit native/App approvals, separate from legacy chat-mode defaults.
use serde_json::{json, Value};

pub(super) const MODES: &[&str] = &["default", "on-request", "untrusted", "never", "read-only"];
pub(super) const APP_MODES: &[&str] = &["default", "app", "never"];
pub(super) const TOOL_MODES: &[&str] =
    &["default", "app", "never", "ask", "edit", "auto", "readonly"];

pub(super) fn modes(backend: &str) -> &'static [&'static str] {
    if backend == "codex" {
        MODES
    } else if scope(backend) == "turn" {
        APP_MODES
    } else {
        TOOL_MODES
    }
}

pub(super) fn scope(backend: &str) -> &'static str {
    if ["gemini", "trae"].contains(&backend) {
        "turn"
    } else {
        "tool"
    }
}

pub(super) fn selected(
    input: Option<&Value>,
    backend: &str,
    previous: Option<&Value>,
) -> Result<Option<String>, String> {
    let Some(value) = input.or(previous.filter(|v| !v.is_null())) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .filter(|value| modes(backend).contains(value))
        .ok_or("UNSUPPORTED_FEATURE: Unsupported agent approval mode for this backend")?;
    Ok((value != "default").then(|| value.to_string()))
}

pub(super) fn read_only(mode: &str, approval: Option<&str>) -> bool {
    approval.is_some() && (mode != "craft" || matches!(approval, Some("read-only" | "readonly")))
}

pub(super) fn kind<'a>(method: &str, params: &'a Value) -> &'a str {
    if let Some(kind @ ("read" | "edit" | "command" | "other")) = params["approvalKind"].as_str() {
        return kind;
    }
    match params["toolCall"]["kind"].as_str() {
        Some("read" | "search" | "fetch") => "read",
        Some("edit" | "delete" | "move") => "edit",
        Some("execute") => "command",
        _ if method == "item/fileChange/requestApproval" => "edit",
        _ if method == "item/commandExecution/requestApproval" => "command",
        _ => "other",
    }
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
    if data["backend"].as_str().unwrap_or("codex") != "codex"
        && matches!(approval, Some("ask" | "edit" | "auto" | "readonly"))
        && method != "item/tool/requestUserInput"
    {
        let kind = kind(method, params);
        if approval == Some("readonly") && kind != "read" {
            return Some("decline");
        }
        if !requires_decision {
            let accepts_once = params["availableDecisions"]
                .as_array()
                .is_none_or(|options| options.iter().any(|v| v == "accept"))
                && params["options"]
                    .as_array()
                    .is_none_or(|options| options.iter().any(|v| v["kind"] == "allow_once"));
            if accepts_once
                && (kind == "read"
                    || mode == "craft"
                        && (approval == Some("auto") || approval == Some("edit") && kind == "edit"))
            {
                return Some("accept");
            }
        }
    }
    if data["backend"].as_str().unwrap_or("codex") == "codex"
        && read_only(mode, approval)
        && method != "item/tool/requestUserInput"
    {
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
    if mode == "plan" && method != "item/tool/requestUserInput" {
        return Some(if request_read_only && !requires_decision {
            "accept"
        } else {
            "decline"
        });
    }
    if requires_decision {
        return None;
    }
    let accepts_once = params["availableDecisions"]
        .as_array()
        .is_none_or(|choices| choices.iter().any(|choice| choice == "accept"))
        && params["options"]
            .as_array()
            .is_none_or(|options| options.iter().any(|option| option["kind"] == "allow_once"));
    if approval.is_some() {
        return (approval == Some("never") && mode == "craft" && accepts_once).then_some("accept");
    }
    // Legacy Craft keeps auto-accept. A Codex-style request that withholds
    // accept is declined (never widened, never left hanging); an ACP request
    // without allow_once stays pending for the user.
    let acp_once = params["options"]
        .as_array()
        .is_none_or(|options| options.iter().any(|option| option["kind"] == "allow_once"));
    if mode == "craft" && acp_once {
        Some(if accepts_once { "accept" } else { "decline" })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepwork_four_policies_classify_tools_without_trusting_shell_readonly_flags() {
        for backend in ["claude", "workbuddy", "opencode"] {
            for policy in ["ask", "edit", "auto", "readonly"] {
                assert_eq!(
                    selected(Some(&json!(policy)), backend, None)
                        .unwrap()
                        .as_deref(),
                    Some(policy)
                );
                for kind in ["read", "edit", "command", "other"] {
                    let expected =
                        if kind == "read" || policy == "auto" || policy == "edit" && kind == "edit"
                        {
                            Some("accept")
                        } else if policy == "readonly" {
                            Some("decline")
                        } else {
                            None
                        };
                    assert_eq!(
                        decision(
                            &json!({"backend":backend,"mode":"craft","approvalMode":policy}),
                            "item/commandExecution/requestApproval",
                            &json!({"approvalKind":kind,"readOnly":true}),
                            false,
                            true
                        ),
                        expected
                    );
                }
                assert_eq!(
                    decision(
                        &json!({"backend":backend,"mode":"craft","approvalMode":policy}),
                        "item/tool/requestUserInput",
                        &json!({}),
                        true,
                        false
                    ),
                    None
                );
            }
        }
        for backend in ["trae", "gemini"] {
            for policy in ["ask", "edit", "auto", "readonly"] {
                assert!(selected(Some(&json!(policy)), backend, None).is_err());
            }
        }
        assert_eq!(
            kind(
                "item/commandExecution/requestApproval",
                &json!({"toolCall":{"kind":"execute","title":"Read file"}})
            ),
            "command"
        );
        assert_eq!(
            kind(
                "item/commandExecution/requestApproval",
                &json!({"toolCall":{"kind":"read"}})
            ),
            "read"
        );
        assert_eq!(
            kind(
                "item/commandExecution/requestApproval",
                &json!({"toolCall":{"kind":"edit"}})
            ),
            "edit"
        );
    }

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
        for backend in [
            "claude",
            "workbuddy",
            "codebuddy",
            "deepseek",
            "qwen",
            "kimi",
            "cursor",
            "copilot",
            "opencode",
            "gemini",
            "trae",
        ] {
            assert_eq!(
                selected(Some(&json!("app")), backend, None)
                    .unwrap()
                    .as_deref(),
                Some("app")
            );
            assert_eq!(
                selected(None, backend, Some(&json!("app")))
                    .unwrap()
                    .as_deref(),
                Some("app")
            );
            assert_eq!(
                selected(Some(&json!("default")), backend, Some(&json!("app"))).unwrap(),
                None
            );
            assert!(selected(Some(&json!("untrusted")), backend, None).is_err());
        }
        assert!(selected(Some(&json!("app")), "codex", None).is_err());
    }

    #[test]
    fn non_codex_explicit_choices_preserve_ask_and_plan_boundaries() {
        let command = "item/commandExecution/requestApproval";
        for approval in ["app", "never"] {
            assert_eq!(
                decision(
                    &json!({"backend":"claude","mode":"ask","approvalMode":approval}),
                    command,
                    &json!({}),
                    false,
                    false
                ),
                None
            );
            assert_eq!(
                decision(
                    &json!({"backend":"claude","mode":"plan","approvalMode":approval}),
                    command,
                    &json!({}),
                    false,
                    false
                ),
                Some("decline")
            );
        }
        for approval in [Value::Null, json!("never")] {
            assert_eq!(
                decision(
                    &json!({"backend":"workbuddy","mode":"craft","approvalMode":approval}),
                    command,
                    &json!({"options":[{"kind":"allow_always","optionId":"persistent"}]}),
                    false,
                    false
                ),
                None
            );
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
        for mode in ["on-request", "untrusted", "app"] {
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
