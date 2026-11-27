//! After a forward pulse has settled, judge one fresh frame: may the robot take
//! another forward pulse? The fixed classroom camera (passive view) and the
//! robot's own forward camera (dominant view) use separate prompts. The renderer
//! still owns every motor command and stops whenever this verdict is not a
//! confident "continue".

use super::{read_markers_json, MAX_REASON_CHARS, WALK_CORRIDOR};
use serde::{Deserialize, Serialize};

const MIN_CONTINUE_CONFIDENCE: f64 = 0.75;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WalkContinueQuery {
    calibrated_floor: bool,
    #[serde(default)]
    step_m: Option<f64>,
}

impl WalkContinueQuery {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self
            .step_m
            .is_some_and(|step| !step.is_finite() || step <= 0.0 || step > 100.0)
        {
            return Err("前进一步的实测距离超出范围。".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct WalkContinue {
    #[serde(rename = "continue")]
    proceed: bool,
    confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

pub(super) fn prompt(query: &WalkContinueQuery, dominant: bool) -> String {
    let step = match query.step_m {
        Some(step) => format!("一个实测步幅（{step}米）"),
        None => "一步".into(),
    };
    let reply = "只返回 JSON：{\"continue\":true或false,\"confidence\":0到1,\"reason\":\"简短中文原因\"}。confidence 是对这次判断的把握。";
    if dominant {
        return format!(
            "你是小布米的主视觉，也就是装在机器人正前方的主导视角摄像头。画面里通常看不到机器人自己的身体，不要因为没看见机身就判为不能走。\
            画面下方是近处地面，上方是正前方。机器人刚向前走完一步并已停稳。只报告当前帧所见。\
            判断它能否继续向前再走{step}。{WALK_CORRIDOR}只有确认该步畅通才给 continue=true。\
            画面过暗、模糊、被遮挡或明显倾斜（可能摔倒）时 continue 为 false。{reply}"
        );
    }
    let view = if query.calibrated_floor {
        "左图是原相机画面，用来辨认外观；右图是地面俯视图，可结合两者判断距离。"
    } else {
        "画面是高处固定摄像头拍摄的整张教室画面。"
    };
    format!(
        "观察固定摄像头中白色圆头、胸前有橙色弧形饰板的双足机器人小布米。{view}它刚向前走完一步并已停稳。只报告当前帧所见。\
        判断它能否继续向前再走{step}，方向按胸口和脚尖的真实正前方。{WALK_CORRIDOR}只有确认该步畅通才给 continue=true。\
        看不清唯一的小布米、它的朝向或前方地面，或它已倒地、姿态异常时，continue 为 false。{reply}"
    )
}

pub(super) fn parse_reply(raw: &str) -> Result<WalkContinue, String> {
    let result = read_markers_json(raw)?;
    let wants = result["continue"]
        .as_bool()
        .ok_or("视觉模型没有给出是否继续行走的判断。")?;
    let confidence = result["confidence"]
        .as_f64()
        .filter(|c| (0.0..=1.0).contains(c))
        .unwrap_or(0.0);
    let reason: Option<String> = result["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(MAX_REASON_CHARS)
                .collect()
        });
    let proceed = wants && confidence >= MIN_CONTINUE_CONFIDENCE;
    let reason = if wants && !proceed {
        Some(format!("AI 对继续行走的把握不足（置信度 {confidence:.2}）。"))
    } else {
        reason
    };
    Ok(WalkContinue {
        proceed,
        confidence,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::super::{build_prompt, LocateInput};
    use super::*;

    const FRAME: &str = "data:image/jpeg;base64,/9j/AA==";

    fn input(extra: serde_json::Value) -> LocateInput {
        let mut value = serde_json::json!({ "imageDataUrl": FRAME });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn passive_and_dominant_views_use_their_own_prompt() {
        let passive = input(serde_json::json!({
            "walkContinue": {"calibratedFloor": false, "stepM": 0.12}
        }));
        assert!(passive.validate().is_ok());
        let text = build_prompt(&passive);
        assert!(text.contains("固定摄像头") && text.contains("0.12米") && text.contains("continue"));
        assert!(!text.contains("主导视角摄像头"));

        let calibrated = input(serde_json::json!({ "walkContinue": {"calibratedFloor": true} }));
        assert!(calibrated.validate().is_ok());
        assert!(build_prompt(&calibrated).contains("地面俯视图"));

        let dominant = input(serde_json::json!({
            "walkContinue": {"calibratedFloor": false}, "searchView": "dominant"
        }));
        assert!(dominant.validate().is_ok());
        let text = build_prompt(&dominant);
        assert!(text.contains("主导视角摄像头") && text.contains("继续向前再走一步"));
        assert!(!text.contains("固定摄像头中白色圆头"));
    }

    #[test]
    fn walk_continue_must_be_requested_alone_with_a_valid_step() {
        for extra in [
            serde_json::json!({"walkContinue": {"calibratedFloor": false}, "inspection": {"target": "讲台", "calibratedFloor": false}}),
            serde_json::json!({"walkContinue": {"calibratedFloor": false}, "walkPath": {"direction": "forward", "calibratedFloor": false, "stepM": 0.1}}),
            serde_json::json!({"walkContinue": {"calibratedFloor": false}, "targetName": "椅子"}),
            serde_json::json!({"walkContinue": {"calibratedFloor": false, "stepM": 0.0}}),
            serde_json::json!({"walkContinue": {"calibratedFloor": false, "stepM": f64::MAX}}),
        ] {
            assert!(input(extra).validate().is_err());
        }
        let unknown = serde_json::from_value::<LocateInput>(serde_json::json!({
            "imageDataUrl": FRAME, "walkContinue": {"calibratedFloor": false, "apiKey": "x"}
        }));
        assert!(unknown.is_err());
    }

    #[test]
    fn only_a_confident_explicit_continue_allows_another_step() {
        let parse = |value: serde_json::Value| parse_reply(&value.to_string());
        let ok = parse(serde_json::json!({"continue": true, "confidence": 0.9, "reason": "前方空地"})).unwrap();
        assert!(ok.proceed && ok.reason.as_deref() == Some("前方空地"));
        let fenced = parse_reply("```json\n{\"continue\":false,\"confidence\":0.95,\"reason\":\"前方有椅子\"}\n```").unwrap();
        assert!(!fenced.proceed && fenced.reason.unwrap().contains("椅子"));
        let unsure = parse(serde_json::json!({"continue": true, "confidence": 0.6})).unwrap();
        assert!(!unsure.proceed && unsure.reason.unwrap().contains("把握不足"));
        let missing = parse(serde_json::json!({"continue": true})).unwrap();
        assert!(!missing.proceed);
        assert!(parse(serde_json::json!({"continue": "true", "confidence": 0.9})).is_err());
        assert!(parse_reply("不知道").is_err());
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["continue"], true);
    }
}
