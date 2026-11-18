//! Appearance persistence must never change the current conversation target.
use crate::{pet::PetController, pet_appearance};
use serde_json::json;

#[test]
fn local_appearance_round_trip_preserves_conversation_identity() {
    let dir = std::env::temp_dir().join(format!("aichat-appearance-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pet.json");
    let pet = PetController::new(path.clone());
    let original = pet.update_raw_state(json!({
        "context": "persona:original", "target": "persona", "title": "Original persona", "ready": true,
        "pet": { "name": "Original pet" }
    }));
    for (id, _) in pet_appearance::EXPERIMENTS {
        let selected = pet.set_appearance(id);
        assert_eq!(selected["preferences"]["appearance"], *id);
        for field in ["context", "target", "title", "pet"] {
            assert_eq!(selected[field], original[field], "appearance {id} changed {field}");
        }
        let reopened = PetController::new(path.clone());
        assert_eq!(reopened.snapshot()["preferences"]["appearance"], *id);
    }
    for invalid in ["ainiang:unknown", "ainiang:CLAUDE", "ainiang:claude/../gpt", "https://invalid.example/pet.png"] {
        assert_eq!(pet.set_appearance(invalid)["preferences"]["appearance"], "follow");
        assert_eq!(PetController::new(path.clone()).snapshot()["preferences"]["appearance"], "follow");
    }
    // Loading preferences also rejects an unknown value already on disk.
    let mut stored: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    stored["appearance"] = json!("ainiang:unknown");
    std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(PetController::new(path).snapshot()["preferences"]["appearance"], "follow");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn model_mode_migrates_existing_choice_and_returns_to_it_without_rewriting_it() {
    use crate::pet::PetAppearanceMode;
    let dir = std::env::temp_dir().join(format!("aichat-model-pet-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pet.json");
    let legacy = json!({"appearance":"ainiang:kimi","scale":4.0,"left":123,"top":234});
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let original_bytes = std::fs::read(&path).unwrap();
    let pet = PetController::new(path.clone());
    assert_eq!(pet.preferences().appearance_mode, PetAppearanceMode::Model);
    for (model, expected) in [
        ("claude-sonnet-4-5", "ainiang:claude"), ("gpt-5", "ainiang:gpt"),
        ("keepwork", "ainiang:kimi"), ("gemini-2.5-pro", "ainiang:gemini"),
        ("keepwork-pro", "ainiang:kimi"), ("unmapped-model", "ainiang:kimi"),
        ("", "ainiang:kimi"),
    ] {
        let state = pet.update_raw_state(json!({"context":"same-chat", "target":"session", "title":"Same chat",
            "modelId":model, "pet":{"name":"User AIChat pet"}}));
        assert_eq!(state["effectiveAppearance"], expected, "{model}");
        assert_eq!(state["preferences"]["appearance"], "ainiang:kimi");
        assert_eq!(state["preferences"]["appearanceMode"], "model");
        assert_eq!(state["preferences"]["scale"], 4.0);
        assert_eq!(state["context"], "same-chat");
        assert_eq!(state["target"], "session");
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes, "switching models must not persist an automatic visual as the user choice");
    }
    pet.update_raw_state(json!({"context":"same-chat","modelId":"claude-opus-4"}));
    let manual = pet.set_appearance_mode(PetAppearanceMode::Manual);
    assert_eq!(manual["effectiveAppearance"], "ainiang:kimi");
    assert_eq!(PetController::new(path.clone()).preferences().appearance_mode, PetAppearanceMode::Manual);
    assert_eq!(pet.set_appearance("dragon")["effectiveAppearance"], "dragon");
    assert_eq!(pet.set_appearance_mode(PetAppearanceMode::Model)["effectiveAppearance"], "ainiang:claude");
    assert_eq!(pet.set_appearance("ainiang:grok")["effectiveAppearance"], "ainiang:claude", "selecting fallback keeps model mode");
    assert_eq!(pet.update_raw_state(json!({"modelId":"keepwork-pro"}))["effectiveAppearance"], "ainiang:grok");
    assert_eq!(PetController::new(path).preferences().appearance, "ainiang:grok");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn model_transitions_retire_old_alpha_masks_and_native_hits_follow_effective_art() {
    let path = std::env::temp_dir().join(format!("aichat-model-pet-mask-{}.json", uuid::Uuid::new_v4()));
    let pet = PetController::new(path);
    let legacy = pet.update_raw_state(json!({"context":"same", "modelId":"keepwork"}));
    let left = legacy["petLeft"].as_i64().unwrap() as i32;
    let top = legacy["petTop"].as_i64().unwrap() as i32;
    let hit = (left + 5, top + 5);
    assert!(pet.pointer_interactive(Some(hit), false), "user's legacy pet retains its rectangle");
    let claude = pet.update_raw_state(json!({"context":"same", "modelId":"claude-sonnet-4"}));
    let epoch = pet.hit_regions_epoch();
    assert_eq!(claude["effectiveAppearance"], "ainiang:claude");
    assert!(!pet.pointer_interactive(Some(hit), false), "model-selected alpha art must not inherit fallback rectangle");
    let region = json!([{"id":"pet","left":left,"top":top,"width":10,"height":10,
        "mask":{"width":1,"height":1,"bits":"80"}}]);
    pet.update_hit_regions(&region, epoch);
    assert!(pet.pointer_interactive(Some(hit), false));
    pet.update_raw_state(json!({"context":"same", "modelId":"claude-opus-4"}));
    assert_eq!(pet.hit_regions_epoch(), epoch, "same art family does not invalidate its current mask");
    pet.update_raw_state(json!({"context":"same", "modelId":"gpt-5"}));
    assert_ne!(pet.hit_regions_epoch(), epoch);
    assert!(!pet.pointer_interactive(Some(hit), false));
    pet.update_hit_regions(&region, epoch);
    assert!(!pet.pointer_interactive(Some(hit), false), "late Claude report cannot restore stale pixels");
    pet.update_hit_regions(&region, pet.hit_regions_epoch());
    assert!(pet.pointer_interactive(Some(hit), false));
    let fallback = pet.update_raw_state(json!({"context":"same", "modelId":"keepwork-pro"}));
    assert_eq!(fallback["effectiveAppearance"], "follow");
    assert!(pet.pointer_interactive(Some(hit), false));
}
