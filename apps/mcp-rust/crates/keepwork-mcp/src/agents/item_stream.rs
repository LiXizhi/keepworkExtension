//! Native item deltas retain their wire fields and add the legacy text projection.
use serde_json::{json, Value};

const TEXT_LIMIT: usize = 131_072;

fn part_text(part: &Value) -> &str {
    part.as_str()
        .or_else(|| part["text"].as_str())
        .unwrap_or("")
}

fn tail(text: String) -> String {
    tail_with_limit(&text, TEXT_LIMIT)
}

fn tail_with_limit(text: &str, limit: usize) -> String {
    let mut cut = text.len().saturating_sub(limit);
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    text[cut..].to_string()
}

fn bound_parts(parts: &mut [Value]) {
    let mut remaining = TEXT_LIMIT;
    for part in parts.iter_mut().rev() {
        let text = tail_with_limit(part_text(part), remaining);
        remaining = remaining.saturating_sub(text.len());
        if part.is_object() {
            part["text"] = json!(text);
        } else {
            *part = json!(text);
        }
    }
}

fn joined_parts(parts: &Value) -> String {
    let Some(parts) = parts.as_array() else {
        return String::new();
    };
    tail(
        parts
            .iter()
            .take(2000)
            .map(part_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

pub(super) fn visible_reasoning(item: &mut Value) {
    if item["type"] != "reasoning" {
        return;
    }
    let summary = joined_parts(&item["summary"]);
    let text = if summary.is_empty() {
        joined_parts(&item["content"])
    } else {
        summary
    };
    if !text.is_empty() {
        item["text"] = json!(text);
    }
}

fn empty(value: &Value) -> bool {
    value.is_null()
        || value.as_str() == Some("")
        || value
            .as_array()
            .is_some_and(|parts| parts.iter().all(|part| part_text(part).is_empty()))
}

pub(super) fn merge_item(previous: &mut Value, incoming: Value) {
    let summary = joined_parts(&incoming["summary"]);
    let native_text = if summary.is_empty() {
        joined_parts(&incoming["content"])
    } else {
        summary
    };
    let legacy_reasoning = incoming["type"] == "reasoning"
        && incoming["text"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        && joined_parts(&incoming["summary"]).is_empty()
        && joined_parts(&incoming["content"]).is_empty();
    if let Some(fields) = incoming.as_object() {
        for (key, value) in fields {
            if ["text", "aggregatedOutput", "summary", "content"].contains(&key.as_str())
                && (incoming["type"] == "reasoning"
                    || !["summary", "content"].contains(&key.as_str()))
                && empty(value)
                && !empty(&previous[key])
                && (native_text.is_empty() || !["summary", "content"].contains(&key.as_str()))
            {
                continue;
            }
            previous[key] = value.clone();
        }
    }
    if incoming["type"] == "reasoning" && !native_text.is_empty() {
        previous["text"] = json!(native_text);
    } else if !legacy_reasoning {
        visible_reasoning(previous);
    }
}

pub(super) fn is_item_delta(method: &str) -> bool {
    method.ends_with("/delta")
        || method.ends_with("/outputDelta")
        || matches!(
            method,
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta"
        )
}

pub(super) fn apply_delta(items: &mut Vec<Value>, method: &str, params: &Value) {
    let Some(id) = params["itemId"].as_str().filter(|id| !id.is_empty()) else {
        return;
    };
    let index = match items.iter().position(|item| item["id"] == id) {
        Some(index) => index,
        None => {
            let item_type = match method {
                "item/agentMessage/delta" => "agentMessage",
                "item/plan/delta" => "plan",
                "item/reasoning/summaryTextDelta"
                | "item/reasoning/textDelta"
                | "item/reasoning/summaryPartAdded" => "reasoning",
                "item/commandExecution/outputDelta" => "commandExecution",
                _ => return,
            };
            items.push(json!({"id":id,"type":item_type}));
            items.len() - 1
        }
    };
    let item = &mut items[index];
    if method.starts_with("item/reasoning/") {
        let (key, index_key) = if method == "item/reasoning/textDelta" {
            ("content", "contentIndex")
        } else {
            ("summary", "summaryIndex")
        };
        let part_index = match params.get(index_key) {
            None | Some(Value::Null) => 0,
            Some(value) => match value.as_u64().filter(|index| *index < 2000) {
                Some(index) => index as usize,
                None => return,
            },
        };
        if !item[key].is_array() {
            item[key] = json!([]);
        }
        let parts = item[key].as_array_mut().unwrap();
        while parts.len() <= part_index {
            parts.push(json!(""));
        }
        if let Some(delta) = params["delta"].as_str() {
            let text = tail(format!("{}{delta}", part_text(&parts[part_index])));
            if parts[part_index].is_object() {
                parts[part_index]["text"] = json!(text);
            } else {
                parts[part_index] = json!(text);
            }
        }
        bound_parts(parts);
        visible_reasoning(item);
    } else if let Some(delta) = params["delta"].as_str() {
        let key = if item["type"] == "commandExecution" {
            "aggregatedOutput"
        } else {
            "text"
        };
        item[key] = json!(tail(format!("{}{delta}", item[key].as_str().unwrap_or(""))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_reasoning_is_authoritative_and_empty_shells_keep_streamed_text() {
        let mut item =
            json!({"id":"reasoning","type":"reasoning","summary":["streamed"],"text":"streamed"});
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","summary":["final", "second part"],"content":["raw"]}),
        );
        assert_eq!(item["text"], "final\n\nsecond part");
        assert_eq!(item["summary"], json!(["final", "second part"]));
        assert_eq!(item["content"], json!(["raw"]));
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","summary":[],"content":[]}),
        );
        assert_eq!(item["text"], "final\n\nsecond part");
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","text":"legacy final"}),
        );
        assert_eq!(item["text"], "legacy final");
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","summary":[],"content":["final raw"]}),
        );
        assert_eq!(item["summary"], json!([]));
        assert_eq!(item["text"], "final raw");
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","summary":["new summary"]}),
        );
        merge_item(
            &mut item,
            json!({"id":"reasoning","type":"reasoning","content":["authoritative content"]}),
        );
        assert_eq!(item["text"], "authoritative content");
    }

    #[test]
    fn native_history_reasoning_keeps_original_fields_and_adds_legacy_text() {
        let items = crate::agents::native::thread_items(&json!({"id":"native", "turns":[{"items":[
            {"id":"summary","type":"reasoning","summary":["第一段","第二段"],"content":["raw"]},
            {"id":"blocks","type":"reasoning","content":[{"type":"reasoning_text","text":"原生文本"}]},
            {"id":"legacy","type":"reasoning","text":"旧CLI"}
        ]}]}), "native").unwrap();
        assert_eq!(items[0]["text"], "第一段\n\n第二段");
        assert_eq!(items[0]["content"], json!(["raw"]));
        assert_eq!(items[1]["text"], "原生文本");
        assert_eq!(items[2]["text"], "旧CLI");
    }

    #[test]
    fn known_delta_fallbacks_preserve_commands_plans_and_ignore_unknown_item_kinds() {
        let mut items = vec![];
        apply_delta(
            &mut items,
            "item/unknown/delta",
            &json!({"itemId":"unknown","delta":"ignored"}),
        );
        assert!(items.is_empty());
        apply_delta(
            &mut items,
            "item/commandExecution/outputDelta",
            &json!({"itemId":"command","delta":"first\n"}),
        );
        apply_delta(
            &mut items,
            "item/commandExecution/outputDelta",
            &json!({"itemId":"command","delta":"中文🙂"}),
        );
        assert_eq!(items[0]["aggregatedOutput"], "first\n中文🙂");
        merge_item(
            &mut items[0],
            json!({"id":"command","type":"commandExecution","aggregatedOutput":""}),
        );
        assert_eq!(items[0]["aggregatedOutput"], "first\n中文🙂");
        apply_delta(
            &mut items,
            "item/plan/delta",
            &json!({"itemId":"plan","delta":"initial plan"}),
        );
        merge_item(
            &mut items[1],
            json!({"id":"plan","type":"plan","text":"rewritten plan"}),
        );
        assert_eq!(items[1]["text"], "rewritten plan");
        apply_delta(
            &mut items,
            "item/reasoning/summaryTextDelta",
            &json!({"itemId":"bounded","summaryIndex":u64::MAX,"delta":"ignored"}),
        );
        assert!(items[2].get("summary").is_none());
        assert!(is_item_delta("item/reasoning/summaryTextDelta"));
        assert!(is_item_delta("item/reasoning/textDelta"));
    }

    #[test]
    fn reasoning_series_budget_keeps_latest_unicode_parts_without_losing_indices() {
        let old = "甲".repeat(TEXT_LIMIT / 3);
        let mut items = vec![
            json!({"id":"reasoning","type":"reasoning","summary":[{"text":old,"providerField":"kept"}]}),
        ];
        apply_delta(
            &mut items,
            "item/reasoning/summaryTextDelta",
            &json!({"itemId":"reasoning","summaryIndex":1,"delta":"🙂".repeat(20)}),
        );
        let parts = items[0]["summary"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["providerField"], "kept");
        assert_eq!(parts[1], "🙂".repeat(20));
        assert!(
            parts
                .iter()
                .map(|part| part_text(part).len())
                .sum::<usize>()
                <= TEXT_LIMIT
        );
        assert!(items[0]["text"]
            .as_str()
            .unwrap()
            .ends_with(&"🙂".repeat(20)));
        apply_delta(
            &mut items,
            "item/reasoning/summaryTextDelta",
            &json!({"itemId":"reasoning","summaryIndex":2,"delta":"乙".repeat(TEXT_LIMIT / 3)}),
        );
        let parts = items[0]["summary"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["text"], "");
        assert_eq!(parts[0]["providerField"], "kept");
        assert!(
            parts
                .iter()
                .map(|part| part_text(part).len())
                .sum::<usize>()
                <= TEXT_LIMIT
        );
        assert_eq!(parts[2], "乙".repeat(TEXT_LIMIT / 3));
    }
}
