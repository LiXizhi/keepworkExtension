//! Bundled visuals selected from model IDs; appearance never changes the chat target.
pub const EXPERIMENTS: &[(&str, &str)] = &[
    ("ainiang:claude", "圣女果 · Claude"),
    ("ainiang:gpt", "小龙女 · GPT"),
    ("ainiang:gemini", "哈基米 · Gemini"),
    ("ainiang:grok", "大小姐 · Grok"),
    ("ainiang:qwen", "千金金 · Qwen"),
    ("ainiang:kimi", "小狐狸 · Kimi"),
    ("ainiang:glm", "嘎拉吗 · GLM"),
    ("ainiang:minimax", "小田螺 · MiniMax"),
    ("ainiang:deepseek", "大肥鱼 · DeepSeek"),
];

pub fn experiment(value: &str) -> Option<(&'static str, &'static str)> {
    EXPERIMENTS.iter().copied().find(|(id, _)| *id == value)
}

pub fn normalize(value: &str) -> &'static str {
    match value {
        "dragon" => "dragon",
        _ => experiment(value).map(|(id, _)| id).unwrap_or("follow"),
    }
}

/// Accept only a bounded model identifier, never a label, URL or provider config.
pub fn model_id(raw: &serde_json::Value) -> Option<&str> {
    let value = raw["modelId"].as_str()?.trim();
    (!value.is_empty() && value.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/:".contains(&b)))
        .then_some(value)
}

fn family(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|suffix| suffix.is_empty()
        || suffix.as_bytes()[0].is_ascii_digit()
        || matches!(suffix.as_bytes()[0], b'-' | b'_' | b'.'))
}

/// Known family boundaries avoid matching incidental model/provider text.
/// Keepwork routing and unsupported models always retain the user's pet.
pub fn for_model(value: &str) -> Option<&'static str> {
    if value.len() > 160 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/:".contains(&b)) {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let id = if let Some((provider, id)) = lower.split_once('/') {
        if !matches!(provider, "anthropic" | "openai" | "google" | "xai" | "x-ai"
            | "qwen" | "alibaba" | "moonshot" | "moonshotai" | "zai" | "z-ai"
            | "zhipu" | "minimax" | "deepseek") || id.contains('/') {
            return None;
        }
        id
    } else { lower.as_str() };
    if family(id, "keepwork") || family(id, "keepbook") { return None; }
    for (prefix, appearance) in [
        ("claude", "ainiang:claude"), ("gpt", "ainiang:gpt"),
        ("gemini", "ainiang:gemini"), ("grok", "ainiang:grok"),
        ("qwen", "ainiang:qwen"), ("kimi", "ainiang:kimi"),
        ("moonshot", "ainiang:kimi"), ("glm", "ainiang:glm"),
        ("minimax", "ainiang:minimax"), ("deepseek", "ainiang:deepseek"),
    ] {
        if family(id, prefix) { return Some(appearance); }
    }
    if ["o1", "o3", "o4"].iter().any(|prefix| id == *prefix || id.strip_prefix(prefix).is_some_and(|s| s.starts_with('-'))) {
        return Some("ainiang:gpt");
    }
    None
}

pub fn effective(raw: &serde_json::Value, fallback: &str, follow_model: bool) -> &'static str {
    if follow_model {
        if let Some(appearance) = model_id(raw).and_then(for_model) { return appearance; }
    }
    normalize(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_mapping_is_bounded_family_matching_with_user_choice_fallback() {
        for (model, appearance) in [
            ("claude-sonnet-4-5", "ainiang:claude"), ("anthropic/claude-opus-4", "ainiang:claude"),
            ("GPT-5.1", "ainiang:gpt"), ("openai/o3-mini", "ainiang:gpt"),
            ("gemini-2.5-pro", "ainiang:gemini"), ("grok-4-fast", "ainiang:grok"),
            ("qwen3-235b", "ainiang:qwen"), ("qwen-plus", "ainiang:qwen"),
            ("kimi-k2", "ainiang:kimi"), ("moonshot-v1-8k", "ainiang:kimi"),
            ("glm-4.7", "ainiang:glm"), ("MiniMax-M2", "ainiang:minimax"),
            ("deepseek-chat", "ainiang:deepseek"),
        ] { assert_eq!(for_model(model), Some(appearance), "{model}"); }
        for model in ["", "keepwork", "keepwork-pro", "openai/keepwork-pro", "claudette",
            "my-gpt-5", "qwenish", "o30", "other/claude-4", "https://claude.invalid",
            "claude/../gpt", "gpt-5?token=x", "Claude Sonnet", "deep\nseek"] {
            assert_eq!(for_model(model), None, "{model}");
            assert_eq!(effective(&serde_json::json!({"modelId":model}), "ainiang:kimi", true), "ainiang:kimi");
        }
        assert_eq!(model_id(&serde_json::json!({"modelId":"g".repeat(161)})), None);
        assert_eq!(effective(&serde_json::json!({"modelId":"claude-4"}), "dragon", false), "dragon");
        assert_eq!(effective(&serde_json::json!({"model":{"id":"claude-4"}, "provider":"anthropic"}), "dragon", true), "dragon");
    }

    #[test]
    fn known_appearances_round_trip_and_unknown_values_fail_closed() {
        for (id, label) in EXPERIMENTS {
            assert_eq!(normalize(id), *id);
            assert_eq!(experiment(id), Some((*id, *label)));
        }
        assert_eq!(normalize("dragon"), "dragon");
        for value in ["follow", "", "ainiang:unknown", "ainiang:CLAUDE", "ainiang:claude/../gpt", "https://evil.invalid/pet.png"] {
            assert_eq!(normalize(value), "follow");
            assert!(experiment(value).is_none());
        }
    }
}
