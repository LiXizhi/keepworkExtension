//! Controller and pointer regressions extracted from pet.rs.
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    pub(super) fn command_controller() -> PetController {
        let controller = PetController::new(
            std::env::temp_dir().join(format!("aichat-pet-commands-{}.json", Uuid::new_v4())),
        );
        controller.update_raw_state(json!({ "context": "alice", "ready": true }));
        controller
    }

    #[test]
    fn reply_presentation_preserves_owned_silent_completion_and_legacy_snapshots() {
        let pet = command_controller();
        let mut raw = json!({ "context": "alice", "petReplyPresentationVersion": 1,
            "reply": { "text": "", "requestId": "own-turn", "speechText": "" } });
        let reply = &pet.update_raw_state(raw.clone())["reply"];
        assert_eq!(reply["requestId"], "own-turn");
        assert_eq!(reply["speechText"], "");
        for version in [Value::Null, json!(2)] {
            raw["petReplyPresentationVersion"] = version;
            assert!(pet.update_raw_state(raw.clone())["reply"].is_null());
        }
        raw["reply"]["text"] = json!("legacy answer");
        let legacy = pet.update_raw_state(raw);
        assert_eq!(legacy["reply"]["text"], "legacy answer");
        assert!(legacy["reply"].get("requestId").is_none());
        assert!(legacy["reply"].get("speechText").is_none());
    }

    #[test]
    fn only_new_media_capture_actions_need_a_visible_owner_page() {
        let ready = json!({
            "ready": true, "canCall": true, "compactVoice": true,
            "classroomRecording": { "enabled": false }
        });
        for action in ["dictation", "call", "voice-start", "record-start"] {
            assert!(starts_media_capture(&ready, action), "{action}");
            let mut offline = ready.clone();
            offline["ready"] = json!(false);
            assert!(!starts_media_capture(&offline, action), "offline {action}");
        }
        for action in [
            "input",
            "send",
            "stop",
            "mute",
            "hide",
            "state",
            "voice-stop",
            "record-stop",
            "toggle-target",
            "exit-info",
        ] {
            assert!(!starts_media_capture(&ready, action), "{action}");
        }
        let mut dictating = ready.clone();
        dictating["dictating"] = json!(true);
        let mut calling = ready.clone();
        calling["voice"] = json!({ "active": true });
        for action in ["dictation", "call", "voice-start", "record-start"] {
            assert!(
                !starts_media_capture(&dictating, action),
                "dictating {action}"
            );
            assert!(!starts_media_capture(&calling, action), "calling {action}");
        }
        let mut recording = ready.clone();
        recording["classroomRecording"]["enabled"] = json!(true);
        assert!(!starts_media_capture(&recording, "record-start"));
        assert!(!starts_media_capture(&recording, "dictation"));
        assert!(
            starts_media_capture(&json!({ "ready": true }), "dictation"),
            "legacy plain dictation remains available"
        );
        assert!(!starts_media_capture(&json!({ "ready": true }), "call"));
        assert!(!starts_media_capture(
            &json!({ "ready": true }),
            "record-start"
        ));
        let mut rich = ready.clone();
        rich["richDraft"] = json!(true);
        assert!(!starts_media_capture(&rich, "dictation"));
    }

    #[test]
    fn background_persona_call_requires_explicit_page_support() {
        let ready = json!({
            "ready": true, "canCall": true, "target": "persona",
            "petVoiceAudioVersion": 1
        });
        assert!(uses_pet_audio(&ready, "call"));
        assert!(uses_pet_audio(&ready, "dictation"));
        for action in ["mute", "voice-stop", "record-start", "voice-start"] {
            assert!(!uses_pet_audio(&ready, action), "{action}");
        }
        for version in [Value::Null, json!(0), json!(2), json!("1")] {
            let mut older = ready.clone();
            older["petVoiceAudioVersion"] = version;
            assert!(!uses_pet_audio(&older, "call"));
        }
        for (key, value) in [
            ("target", json!("chat")),
            ("ready", json!(false)),
            ("canCall", json!(false)),
            ("voice", json!({"active": true})),
            ("dictating", json!(true)),
        ] {
            let mut unsupported = ready.clone();
            unsupported[key] = value;
            assert!(!uses_pet_audio(&unsupported, "call"), "{key}");
        }
        let controller = command_controller();
        controller.update_raw_state(ready);
        assert!(uses_pet_audio(&controller.snapshot(), "call"));
    }

    fn ainiang_mask_fixture() -> (PetController, Value, (i32, i32), (i32, i32), (i32, i32)) {
        let controller = command_controller();
        controller.set_appearance("ainiang:claude");
        let snap = controller.set_scale(4.0);
        let left = snap["petLeft"].as_i64().unwrap() as i32;
        let top = snap["petTop"].as_i64().unwrap() as i32;
        let pixels = snap["petPixels"].as_i64().unwrap() as i32;
        // 010 / 101 / 010: both transparent margin and a transparent body hole.
        let region = json!({"id":"pet", "left":left, "top":top, "width":pixels,
            "height":pixels, "mask":{"width":3,"height":3,"bits":"5500"}});
        let margin = (left + pixels / 6, top + pixels / 6);
        let body = (left + pixels / 2, top + pixels / 6);
        let hole = (left + pixels / 2, top + pixels / 2);
        (controller, region, margin, body, hole)
    }

    #[test]
    fn ainiang_pointer_mask_rejects_transparent_margin_and_hole_but_keeps_body_and_panels() {
        let (controller, region, margin, body, hole) = ainiang_mask_fixture();
        controller.update_hit_regions(&json!([region,
            {"id":"panel","left":20,"top":20,"width":100,"height":100},
            {"id":"dialogue-icon","left":140,"top":20,"width":28,"height":28}]),
            controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some(margin), false),
            "transparent padding inside the old 4x sprite square must pass through");
        assert!(controller.pointer_interactive(Some(body), false));
        assert!(!controller.pointer_interactive(Some(hole), false));
        assert!(controller.pointer_interactive(Some((30, 30)), false));
        assert!(controller.pointer_interactive(Some((150, 30)), false), "explicit hangup icon remains clickable");
        assert!(!controller.pointer_interactive(Some((180, 30)), false), "gap outside control passes through");
        controller.set_pointer_hold(true);
        assert!(controller.pointer_interactive(Some(margin), true));
        assert!(!controller.pointer_interactive(Some(margin), false));
        controller.start_drag(body.0, body.1);
        assert!(controller.pointer_interactive(Some(margin), true));
        controller.end_drag();
        assert!(!controller.pointer_interactive(Some(margin), false));
        controller.set_appearance("follow");
        assert!(controller.pointer_interactive(Some(margin), false), "legacy fallback is preserved");
    }

    #[test]
    fn ainiang_pointer_mask_missing_invalid_or_excess_regions_fail_closed() {
        let (controller, region, _, body, _) = ainiang_mask_fixture();
        assert!(!controller.pointer_interactive(Some(body), false), "no first report means no body hit");
        for mask in [Value::Null,
            json!({"width":0,"height":3,"bits":"5500"}),
            json!({"width":257,"height":3,"bits":"5500"}),
            json!({"width":3,"height":257,"bits":"5500"}),
            json!({"width":-1,"height":3,"bits":"5500"}),
            json!({"width":1.5,"height":3,"bits":"5500"}),
            json!({"width":3,"height":3,"bits":"55"}),
            json!({"width":3,"height":3,"bits":"550000"}),
            json!({"width":3,"height":3,"bits":"5G00"}),
            json!({"width":3,"height":3,"bits":"FF00"}),
            json!({"width":3,"height":3,"bits":"é00"}),
        ] {
            let mut invalid = region.clone();
            invalid["mask"] = mask.clone();
            controller.update_hit_regions(&json!([invalid]), controller.hit_regions_epoch());
            assert!(!controller.pointer_interactive(Some(body), false), "invalid mask: {mask}");
        }
        let mut missing = region.clone();
        missing.as_object_mut().unwrap().remove("mask");
        controller.update_hit_regions(&json!([missing]), controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some(body), false));
        let mut regions = vec![json!({"id":"panel","left":0,"top":0,"width":1,"height":1}); 6];
        regions.push(region.clone());
        controller.update_hit_regions(&json!(regions), controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some(body), false), "existing six-region limit remains");
        let mut maximum = region;
        maximum["mask"] = json!({"width":256,"height":256,"bits":"f".repeat(16384)});
        controller.update_hit_regions(&json!([maximum]), controller.hit_regions_epoch());
        assert!(controller.pointer_interactive(Some(body), false));
    }

    #[test]
    fn ainiang_pointer_mask_does_not_rescale_when_clipped_at_work_area_edge() {
        let controller = command_controller();
        controller.set_appearance("ainiang:claude");
        let mut region = json!({"id":"pet","left":-30,"top":20,"width":90,"height":90,
            "mask":{"width":3,"height":3,"bits":"8000"}});
        controller.update_hit_regions(&json!([region.clone()]), controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some((10,30)), false),
            "offscreen first mask column must not stretch into the viewport");
        region["mask"]["bits"] = json!("4000");
        controller.update_hit_regions(&json!([region]), controller.hit_regions_epoch());
        assert!(controller.pointer_interactive(Some((10,30)), false));
        assert!(!controller.pointer_interactive(Some((-10,30)), false));
    }

    #[test]
    fn ainiang_pointer_mask_is_invalidated_by_appearance_scale_and_monitor_epochs() {
        let (controller, region, _, body, _) = ainiang_mask_fixture();
        let first_epoch = controller.hit_regions_epoch();
        controller.update_hit_regions(&json!([region.clone()]), first_epoch);
        assert!(controller.pointer_interactive(Some(body), false));
        controller.set_appearance("ainiang:gpt");
        assert_ne!(controller.hit_regions_epoch(), first_epoch);
        controller.update_hit_regions(&json!([region.clone()]), first_epoch);
        assert!(!controller.pointer_interactive(Some(body), false));
        controller.update_hit_regions(&json!([region.clone()]), controller.hit_regions_epoch());
        assert!(controller.pointer_interactive(Some(body), false));
        let old_epoch = controller.hit_regions_epoch();
        controller.set_scale(2.0);
        controller.update_hit_regions(&json!([region.clone()]), old_epoch);
        assert!(!controller.pointer_interactive(Some(body), false));
        controller.update_hit_regions(&json!([region.clone()]), controller.hit_regions_epoch());
        let old_epoch = controller.hit_regions_epoch();
        controller.set_work_area(WorkArea {x:-1920,y:0,width:1920,height:1080});
        controller.update_hit_regions(&json!([region]), old_epoch);
        assert!(!controller.pointer_interactive(Some((body.0-1920,body.1)), false));
    }

    #[test]
    fn native_pointer_hit_testing_recovers_without_renderer_mousemove() {
        let controller = command_controller();
        controller.set_work_area(WorkArea {
            x: -1280,
            y: -200,
            width: 1280,
            height: 800,
        });
        controller.update_hit_regions(
            &json!([
                {"id":"panel","left":700,"top":100,"width":348,"height":160},
                {"id":"bubble","left":700,"top":300,"width":348,"height":80}
            ]),
            controller.hit_regions_epoch(),
        );
        assert!(!controller.pointer_interactive(Some((-1200, -100)), false));
        controller.record_pointer_interactive(false);
        // Another app can be foreground throughout: native cursor movement
        // alone enables input when it re-enters a visible pet surface.
        assert!(controller.pointer_interactive(Some((-500, -50)), false));
        assert!(controller.pointer_needs_update(true));
        controller.record_pointer_interactive(true);
        assert!(!controller.pointer_needs_update(true));
        assert!(!controller.pointer_interactive(Some((-500, 80)), false)); // gap
        assert!(controller.pointer_interactive(Some((-500, 120)), false));
        controller.update_hit_regions(&json!([]), controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some((-500, 120)), false));
        let snap = controller.snapshot();
        let x = -1280 + snap["petLeft"].as_i64().unwrap() as i32 + 10;
        let y = -200 + snap["petTop"].as_i64().unwrap() as i32 + 10;
        assert!(controller.pointer_interactive(Some((x, y)), false));
        assert!(!controller.pointer_interactive(None, false));
    }

    #[test]
    fn pointer_hold_ends_on_release_or_hide_without_a_canvas_grace_period() {
        let controller = command_controller();
        let outside = Some((0, 0));
        controller.set_pointer_hold(true);
        assert!(controller.pointer_interactive(outside, true));
        assert!(!controller.pointer_interactive(outside, false));
        assert!(!controller.pointer_interactive(outside, true));
        controller.set_pointer_hold(true);
        controller.suspend_pointer_tracking();
        assert!(!controller.pointer_interactive(outside, true));
        controller.start_drag(100, 100);
        assert!(controller.pointer_interactive(outside, true));
        assert!(!controller.pointer_interactive(outside, false));
        controller.end_drag();
        assert!(!controller.pointer_interactive(outside, true));
        controller.start_drag(100, 100);
        controller.suspend_pointer_tracking();
        assert!(!controller.pointer_interactive(outside, true));
    }

    #[test]
    fn monitor_and_scale_changes_clear_old_surface_rectangles() {
        let controller = command_controller();
        let regions = json!([{"id":"panel","left":20,"top":20,"width":300,"height":100}]);
        let old_epoch = controller.hit_regions_epoch();
        controller.update_hit_regions(&regions, old_epoch);
        assert!(controller.pointer_interactive(Some((30, 30)), false));
        controller.set_work_area(WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        });
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        controller.update_hit_regions(&regions, old_epoch);
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        controller.update_hit_regions(&regions, controller.hit_regions_epoch());
        assert!(controller.pointer_interactive(Some((-1890, 30)), false));
        controller.set_scale(2.0);
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        for scale in [1.0, 1.5, 2.0] {
            assert_eq!(
                physical_pet_cursor(
                    (-1920.0 + 30.0 * scale, 40.0 * scale),
                    (-1920.0, 0.0),
                    scale,
                    controller.work_area()
                ),
                Some((-1890, 40))
            );
        }
        assert!(physical_pet_cursor((0.0, 0.0), (0.0, 0.0), 0.0, controller.work_area()).is_none());
    }

    #[test]
    fn hit_region_validation_does_not_capture_transparent_or_unbounded_canvas() {
        let controller = command_controller();
        for regions in [
            json!([{"id":"stack","left":0,"top":0,"width":1400,"height":800}]),
            json!([{"id":"panel","left":0,"top":0,"width":999999,"height":999999}]),
            json!([{"id":"panel","left":0,"top":0,"width":0,"height":100}]),
            json!([{"id":"panel","left":0,"top":0,"width":100,"height":-1}]),
            json!([{"id":"panel","left":2000,"top":2000,"width":100,"height":100}]),
        ] {
            controller.update_hit_regions(&regions, controller.hit_regions_epoch());
            assert!(!controller.pointer_interactive(Some((10, 10)), false));
        }
        let invalid = PetHitRegion {
            id: "panel".into(),
            left: f64::NAN,
            top: 0.0,
            width: 100.0,
            height: 100.0,
            mask: None,
        };
        assert!(invalid.clipped(controller.work_area()).is_none());
    }

    #[tokio::test]
    async fn commands_use_bridge_v1_and_wait_for_matching_page_acknowledgement() {
        let controller = command_controller();
        let (command, mut receiver) = controller
            .begin_command(
                "input",
                &json!({
                    "context": "alice", "text": "保留输入", "version": 99,
                    "requestId": "untrusted", "action": "send"
                }),
            )
            .unwrap();
        assert_eq!(command["version"], 1);
        assert_eq!(command["action"], "input");
        assert_eq!(command["context"], "alice");
        assert_eq!(command["text"], "保留输入");
        let request_id = command["requestId"].as_str().unwrap();
        assert_ne!(request_id, "untrusted");
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(!controller.resolve_command(&json!({ "requestId": "unknown", "ok": true })));

        // Published Bridge v1 pages publish their updated draft before petResult.
        controller
            .update_raw_state(json!({ "context": "alice", "ready": true, "draft": "保留输入" }));
        assert!(controller
            .resolve_command(&json!({ "requestId": request_id, "ok": true, "additive": 1 })));
        assert_eq!(
            controller
                .wait_for_command(request_id, receiver, Duration::from_secs(1))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(controller.snapshot()["draft"], "保留输入");
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        let (next, _) = controller
            .begin_command("send", &json!({ "context": "alice" }))
            .unwrap();
        assert_ne!(command["requestId"], next["requestId"]);
    }

    #[tokio::test]
    async fn rejected_or_unanswered_commands_fail_without_being_replayed() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "alice", "text": "草稿" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.resolve_command(
            &json!({ "requestId": request_id, "ok": false, "error": "无法修改输入" }),
        );
        assert_eq!(
            controller
                .wait_for_command(request_id, receiver, Duration::from_secs(1))
                .await
                .unwrap_err(),
            "无法修改输入"
        );

        let (command, receiver) = controller
            .begin_command("send", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_millis(1))
            .await
            .unwrap_err()
            .contains("检查结果"));
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        assert!(controller.page_state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn changing_context_or_reloading_cancels_pending_commands() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.update_raw_state(json!({ "context": "bob", "ready": true }));
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("会话已改变"));
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        assert!(controller
            .begin_command("send", &json!({ "context": "alice" }))
            .is_err());
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "bob" }))
            .unwrap();
        controller.reset_state();
        assert!(controller
            .wait_for_command(
                command["requestId"].as_str().unwrap(),
                receiver,
                Duration::from_secs(1)
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn target_switch_ack_before_new_context_remains_successful() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("toggle-target", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.resolve_command(&json!({ "requestId": request_id, "ok": true }));
        controller.update_raw_state(json!({ "context": "chat", "ready": true }));
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_secs(1))
            .await
            .is_ok());
    }

    #[test]
    fn unavailable_or_legacy_pages_cannot_accept_remote_edits() {
        let controller = command_controller();
        for state in [
            json!({ "context": "alice", "ready": false }),
            json!({ "context": "alice" }),
        ] {
            controller.update_raw_state(state);
            assert!(controller
                .begin_command("input", &json!({ "context": "alice" }))
                .is_err());
            assert!(controller
                .begin_command("send", &json!({ "context": "alice" }))
                .is_err());
            assert!(controller
                .begin_command("exit-info", &json!({ "context": "alice" }))
                .is_ok());
            assert!(controller
                .begin_command("toggle-target", &json!({ "context": "alice" }))
                .is_ok());
        }
    }

    #[test]
    fn sanitizes_pet_state_clamps_bounds_and_handles_permission_bridge() {
        let root = std::env::temp_dir().join(format!("aichat-rust-pet-{}", Uuid::new_v4()));
        let controller = PetController::new(root.join("pet-prefs.json"));
        controller.set_work_area(WorkArea {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        });

        let state = controller.update_raw_state(json!({
            "context": "ctx-1",
            "ready": true,
            "pet": {
                "name": "小龙",
                "sheetUrl": "https://cdn.keepwork.com/maisi/pet.webp",
                "imageData": "javascript:alert(1)"
            },
            "messages": [
                { "role": "system", "text": "secret system prompt" },
                { "role": "user", "text": "你好" },
                { "role": "assistant", "text": "你好！我是你的第二大脑。" }
            ],
            "reply": {
                "text": "你好！我是你的第二大脑。",
                "options": [{ "icon": "✨", "text": "继续" }]
            }
        }));

        assert_eq!(state["version"], 1);
        assert_eq!(state["pet"]["imageData"], "");
        assert_eq!(
            state["pet"]["sheetUrl"],
            "https://cdn.keepwork.com/maisi/pet.webp"
        );
        assert_eq!(state["messages"].as_array().unwrap().len(), 2);

        // Test exit prompt lifecycle
        let (exit_id, exit_snap) = controller.begin_exit_prompt(false);
        assert_eq!(exit_snap["exitPrompt"]["loading"], true);
        assert!(controller.verify_exit_confirm(&exit_id).is_err());

        controller.resolve_exit_info(&json!({
            "personas": [{ "name": "工作助手", "channels": ["飞书", "钉钉"] }]
        }));
        assert!(controller.verify_exit_confirm(&exit_id).is_ok());

        // Test TCP permission bridge handshake
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let bridge_file = root.join("pet-permission-bridge.json");
        atomic_json_write(
            &bridge_file,
            &PermissionBridgeRecord {
                port,
                token: "secret-bridge-token".to_string(),
            },
        )
        .unwrap();

        let srv = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut hello_line = String::new();
            reader.read_line(&mut hello_line).unwrap();
            let hello: Value = serde_json::from_str(&hello_line).unwrap();
            assert_eq!(hello["role"], "desktop");
            assert_eq!(hello["token"], "secret-bridge-token");

            let req = json!({ "type": "request", "id": "req-1", "client": "AIChat Agent" });
            stream.write_all(format!("{req}\n").as_bytes()).unwrap();
            stream.flush().unwrap();

            let mut resp_line = String::new();
            reader.read_line(&mut resp_line).unwrap();
            let resp: Value = serde_json::from_str(&resp_line).unwrap();
            assert_eq!(resp["id"], "req-1");
            assert_eq!(resp["choice"], "once");
        });

        run_permission_bridge_session(&bridge_file, |id, client| {
            assert_eq!(id, "req-1");
            assert_eq!(client, "AIChat Agent");
            "once".to_string()
        })
        .unwrap();
        srv.join().unwrap();

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn native_drag_preserves_click_threshold_and_ignores_old_owners() {
        let controller = command_controller();
        let primary = WorkArea {
            x: 0,
            y: 0,
            width: 1710,
            height: 1107,
        };
        let upper = WorkArea {
            x: -458,
            y: -1080,
            width: 1920,
            height: 1080,
        };
        controller.set_work_area(primary);
        controller.note_canvas(controller.desired_canvas());
        {
            let mut prefs = controller.prefs.lock().unwrap();
            prefs.left = Some(100);
            prefs.top = Some(100);
        }
        controller.begin_global_drag_with_id(156, 156, Some(1));
        let before = controller.placement();
        assert_eq!(controller.drag_global(160, 156, &[primary, upper]), None);
        assert_eq!(controller.placement(), before);
        assert!(!controller.drag_moved());
        controller.drag_global(161, 156, &[primary, upper]);
        assert!(controller.drag_moved());
        assert_eq!(controller.placement(), (primary, Some(105), Some(100)));
        let crossed = controller.drag_global(500, -200, &[primary, upper]);
        assert_eq!(crossed, Some(controller.desired_canvas()));
        assert_ne!(crossed, Some(upper), "native canvas is no longer the monitor");
        controller.note_canvas(controller.desired_canvas());
        let placed = controller.placement();
        let epoch = controller.hit_regions_epoch();
        assert_eq!(controller.drag_global(500, -200, &[primary, upper]), None);
        assert_eq!(controller.placement(), placed);
        assert_eq!(
            controller.hit_regions_epoch(),
            epoch,
            "stationary frames keep the current hit regions"
        );
        controller.end_drag();
        assert!(
            controller.drag_moved(),
            "the release frame remembers movement even without DOM pointermove"
        );
        assert!(controller.native_drag_tracking());
        assert_eq!(controller.drag_id(), Some(1));
        controller.begin_global_drag_with_id(500, -200, Some(2));
        assert!(
            !controller.owns_drag(Some(1)),
            "old drag/end requests cannot finish a new press"
        );
        assert!(controller.owns_drag(Some(2)));
        assert!(
            controller.owns_drag(None),
            "legacy renderers keep their historical request shape"
        );
        assert!(!controller.drag_moved());
        controller.end_drag();
    }

    #[test]
    fn monitor_gaps_choose_the_nearest_edge_and_keep_the_current_monitor_on_ties() {
        let wide = WorkArea {
            x: 0,
            y: 0,
            width: 4000,
            height: 1000,
        };
        let right = WorkArea {
            x: 4100,
            y: 0,
            width: 1000,
            height: 1000,
        };
        assert_eq!(monitor_at(&[wide, right], 4010, 100), Some(wide));
        assert_eq!(
            monitor_at_preferred(&[wide, right], 4050, 100, Some(wide)),
            Some(wide)
        );
        assert_eq!(
            monitor_at_preferred(&[wide, right], 4050, 100, Some(right)),
            Some(right)
        );
        assert_eq!(monitor_at(&[wide, right], 4090, 100), Some(right));
        assert_eq!(monitor_at(&[], 0, 0), None);
    }

    #[test]
    fn dragged_pet_crosses_onto_the_monitor_under_the_cursor() {
        let lower = WorkArea {
            x: 0,
            y: 0,
            width: 1710,
            height: 1107,
        };
        let upper = WorkArea {
            x: -458,
            y: -1440,
            width: 2560,
            height: 1440,
        };
        let monitors = [lower, upper];

        let (monitor, left, top) = place_dragged_pet(&monitors, 800, 40, 56, 56, 1.0).unwrap();
        assert_eq!(monitor, lower);
        assert_eq!((left, top), (744, 8));

        let (monitor, left, top) = place_dragged_pet(&monitors, 800, -100, 56, 56, 1.0).unwrap();
        assert_eq!(monitor, upper);
        assert_eq!((left, top), (1202, 1284));

        let (monitor, top_edge) = {
            let (monitor, left, top) = place_dragged_pet(&monitors, 100, -1, 56, 56, 1.0).unwrap();
            (monitor, (left, top))
        };
        assert_eq!(monitor, upper);
        assert_eq!(top_edge, (502, 1304));

        let root = std::env::temp_dir().join(format!("aichat-rust-pet-drag-{}", Uuid::new_v4()));
        let controller = PetController::new(root.join("pet-prefs.json"));
        controller.set_work_area(lower);
        controller.note_canvas(controller.desired_canvas());
        controller.begin_global_drag(856, 456);
        let moved = controller.drag_global(900, 500, &monitors);
        assert_eq!(moved, Some(controller.desired_canvas()));
        assert_ne!(moved, Some(lower));
        assert_eq!(controller.work_area(), lower);
        let crossed = controller.drag_global(800, -100, &monitors);
        assert_eq!(crossed, Some(controller.desired_canvas()));
        assert_ne!(crossed, Some(upper));
        assert_eq!(controller.work_area(), upper);
        let snap = controller.snapshot();
        let pet_left = snap["petLeft"].as_i64().unwrap();
        let pet_top = snap["petTop"].as_i64().unwrap();
        assert!(pet_left >= 8 && pet_left < upper.width as i64);
        assert!(pet_top >= 8 && pet_top < upper.height as i64);
        // Failed native commits remain pending even when the cursor is stationary.
        let retry = controller.drag_global(820, -140, &monitors);
        assert_eq!(retry, Some(controller.desired_canvas()));
        assert_eq!(controller.pending_canvas(), retry);
        assert_eq!(controller.drag_global(820, -140, &monitors), retry);
        controller.note_canvas(controller.desired_canvas());
        assert_eq!(controller.pending_canvas(), None);
        assert_eq!(controller.drag_global(820, -140, &monitors), None);
        // Same-monitor movement now repositions the small native window too.
        let moved_again = controller.drag_global(830, -150, &monitors);
        assert_eq!(moved_again, Some(controller.desired_canvas()));
        assert_ne!(moved_again, retry);
        controller.end_drag();
        assert!(!controller.is_dragging());
        let saved = fs::read_to_string(root.join("pet-prefs.json")).unwrap();
        assert!(saved.contains("\"monitorX\": -458"));
        assert!(saved.contains("\"monitorY\": -1440"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cropped_canvas_tracks_alpha_and_passive_visuals_without_expanding_pointer_targets() {
        let controller = command_controller();
        // Alpha-mask authority belongs to bundled AI Niang appearances; legacy
        // follow/dragon intentionally preserve their rectangular fallback.
        controller.set_appearance("ainiang:claude");
        controller.set_appearance_mode(PetAppearanceMode::Manual);
        let area = WorkArea { x: -1920, y: -200, width: 1920, height: 1080 };
        controller.set_work_area(area);
        { let mut prefs = controller.prefs.lock().unwrap(); prefs.left=Some(100); prefs.top=Some(100); }
        let initial=controller.desired_canvas();
        controller.note_canvas(initial);
        let epoch=controller.hit_regions_epoch();
        let hits=json!([{"id":"pet","left":100,"top":100,"width":112,"height":112,
            "mask":{"width":4,"height":4,"bits":"0660"}}]);
        controller.update_layout(&hits,&json!([]),epoch);
        let cropped=WorkArea{x:-1792,y:-72,width:56,height:56};
        assert_eq!(controller.desired_canvas(),cropped);
        assert_eq!(controller.current_canvas(),initial,"snapshot acknowledges only committed native geometry");
        assert_eq!(controller.work_area(),area);
        controller.note_canvas(cropped);
        assert_eq!(controller.snapshot()["canvas"],json!(cropped));
        assert!(controller.pointer_interactive(Some((-1780,-60)),false));
        assert!(!controller.pointer_interactive(Some((-1810,-90)),false),"transparent art padding stays passive");
        controller.update_layout(&hits,&json!([{"id":"caption","left":250,"top":80,"width":300,"height":200}]),epoch);
        assert_eq!(controller.desired_canvas(),WorkArea{x:-1792,y:-120,width:422,height:200});
        assert!(!controller.pointer_interactive(Some((-1600,-100)),false),"painted caption must not become a pointer target");
        assert!(controller.pointer_interactive(Some((-1780,-60)),false));
        controller.clear_hit_regions();
        let fallback=controller.desired_canvas();
        controller.update_layout(&hits,&json!([{"id":"caption","left":0,"top":0,"width":1000,"height":1000}]),epoch);
        assert_eq!(controller.desired_canvas(),fallback,"stale visual epochs cannot enlarge new canvas");
        assert!(fallback.width<area.width && fallback.height<area.height);
    }
