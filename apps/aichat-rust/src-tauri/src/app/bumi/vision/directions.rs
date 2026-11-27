//! Robot-relative directions from a single camera image.

use super::{extract_json_object, InspectionQuery, VisionPose, NOMINAL_FORWARD_STEP_M};
use serde::{Deserialize, Serialize};

const MAX_DIRECTIONS: usize = 10;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Direction {
    Left,
    Right,
    Around,
    FaceTarget,
    Forward,
    Stop,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(super) struct PulseSegment {
    direction: Direction,
    count: u8,
}

pub(super) fn prompt(query: &InspectionQuery, dominant: bool) -> String {
    let view = if dominant {
        "这是机器人前方摄像头的画面，左右对应机器人的左右。"
    } else if query.calibrated_floor {
        "左图是固定摄像头画面，右图是同一地面的俯视图。按小布米胸口和脚尖的朝向区分它的左右。"
    } else {
        "这是固定摄像头画面。小布米是白色圆头、胸前有橙色饰板的双足机器人。按它胸口和脚尖的朝向区分它的左右。"
    };
    let target = serde_json::json!(query.target.trim());
    if query.pulse_directions {
        return format!(
            "{view}目标名称（仅作图中物体匹配）为 {target}。从这张照片给出小布米走到该静物旁并停下的完整走法。\
             只用机器人自身的 left（向左短转）、right（向右短转）、forward（直行）。每段 count 是正整数点动次数。\
             按图中目标相对机器人正前方的偏向估计转动方向和次数，略偏时可转一次。\
             按每步约 {NOMINAL_FORWARD_STEP_M} 米估计直行步数，走向目标旁的空位。所有段累计最多 {MAX_DIRECTIONS} 次。\
             只返回 JSON 对象，含 status、stationaryTarget（目标是静物为 true）和 segments。\
             ready 表示图中有完整可走的路线，例如 {{\"status\":\"ready\",\"stationaryTarget\":true,\"segments\":[{{\"direction\":\"left\",\"count\":1}},{{\"direction\":\"forward\",\"count\":2}}]}}。\
             已到目标旁用 arrived 和空数组。目标不明确、方向或步数无法估算、路线不通或超过次数上限时用 unknown 和空数组。"
        );
    }
    format!(
        "{view}根据这张照片给出小布米走到目标旁的简短走法。目标名称为 {target}。\
         按顺序选择 left（左转）、right（右转）、around（掉头）、faceTarget（转向目标）、forward（直行）、stop（停下）。\
         转向的左右不明确而目标可见时可用 faceTarget。每段直行只写一次 forward，已经到达时只写 stop。\
         只返回 JSON 对象。directions 是最多 {MAX_DIRECTIONS} 项的动作数组，无法辨认路线时给空数组。\
         distancesM 数组与动作逐项对应。对每段 forward，根据照片估算该段直行距离（米）；其他动作或无法估算的距离填 null。"
    )
}

pub(super) fn parse_pulses(raw: &str) -> Result<VisionPose, String> {
    #[derive(Deserialize, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Status {
        Ready,
        Arrived,
        Unknown,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        status: Status,
        stationary_target: bool,
        segments: Vec<PulseSegment>,
    }
    let invalid = "未能将这张照片的走法转换成点动指令。";
    let object = extract_json_object(raw).ok_or(invalid)?;
    let reply: Reply = serde_json::from_str(object).map_err(|_| invalid)?;
    let valid_status = match reply.status {
        Status::Ready => reply.stationary_target && !reply.segments.is_empty(),
        Status::Arrived => reply.stationary_target && reply.segments.is_empty(),
        Status::Unknown => reply.segments.is_empty(),
    };
    if !valid_status || reply.segments.len() > MAX_DIRECTIONS {
        return Err(invalid.into());
    }
    let mut total = 0;
    let mut directions = Vec::new();
    let mut counts = Vec::new();
    for part in &reply.segments {
        total += usize::from(part.count);
        if !matches!(
            part.direction,
            Direction::Left | Direction::Right | Direction::Forward
        ) || part.count == 0
            || total > MAX_DIRECTIONS
        {
            return Err(invalid.into());
        }
        directions.push(part.direction.clone());
        counts.push(Some(u32::from(part.count)));
    }
    if reply.status != Status::Unknown {
        directions.push(Direction::Stop);
        counts.push(None);
    }
    Ok(VisionPose {
        directions: Some(directions),
        direction_steps: Some(counts),
        pulse_directions: Some(reply.segments),
        ..VisionPose::default()
    })
}

pub(super) fn parse_reply(raw: &str) -> Result<VisionPose, String> {
    #[derive(Deserialize)]
    struct Reply {
        directions: Vec<Direction>,
        #[serde(default, rename = "distancesM")]
        distances_m: serde_json::Value,
    }
    let invalid = "未能读取单图走法。";
    let object = extract_json_object(raw).ok_or(invalid)?;
    let reply: Reply = serde_json::from_str(object).map_err(|_| invalid)?;
    if reply.directions.len() > MAX_DIRECTIONS {
        return Err(invalid.into());
    }
    let distances = reply
        .distances_m
        .as_array()
        .filter(|distances| distances.len() == reply.directions.len());
    let steps: Vec<_> = reply
        .directions
        .iter()
        .enumerate()
        .map(|(index, direction)| {
            if *direction != Direction::Forward {
                return None;
            }
            let meters = distances?[index].as_f64().filter(|m| *m > 0.0)?;
            let count = (meters * NOMINAL_FORWARD_STEP_M.recip()).round().max(1.0);
            (count <= f64::from(u32::MAX)).then_some(count as u32)
        })
        .collect();
    Ok(VisionPose {
        directions: Some(reply.directions),
        direction_steps: steps.iter().any(Option::is_some).then_some(steps),
        ..VisionPose::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::bumi::vision::{build_prompt, LocateInput, READ_ONLY_TIMEOUT};
    use serde_json::json;

    #[test]
    fn pulse_directions_accept_one_uncalibrated_image_in_either_view() {
        for (view, label) in [("passive", "固定摄像头"), ("dominant", "前方摄像头")] {
            let mut request = json!({
                "imageDataUrl": "data:image/jpeg;base64,/9j/AA==",
                "inspection": {"target":"白色垃圾桶","calibratedFloor":false,"directionsOnly":true,"pulseDirections":true},
                "searchView":view
            });
            let input: LocateInput = serde_json::from_value(request.clone()).unwrap();
            input.validate().unwrap();
            let prompt = build_prompt(&input);
            for expected in [
                label,
                "白色垃圾桶",
                "left",
                "right",
                "forward",
                "0.4 米",
                "点动次数",
            ] {
                assert!(prompt.contains(expected), "{expected}");
            }
            for unwanted in [
                "四角",
                "校准",
                "实测",
                "米制尺度",
                "scaleReliable",
                "floorSizeM",
                "置信度",
            ] {
                assert!(!prompt.contains(unwanted), "{unwanted}");
            }
            request["inspection"]["directionsOnly"] = false.into();
            let invalid: LocateInput = serde_json::from_value(request).unwrap();
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn pulse_directions_use_the_same_segments_for_display_and_motion() {
        let segments = json!([{"direction":"left","count":2},{"direction":"forward","count":8}]);
        let ready = json!({"status":"ready","stationaryTarget":true,"segments":segments});
        let pose = serde_json::to_value(parse_pulses(&ready.to_string()).unwrap()).unwrap();
        assert_eq!(pose["pulseDirections"], segments);
        assert_eq!(pose["directions"], json!(["left", "forward", "stop"]));
        assert_eq!(pose["directionSteps"], json!([2, 8, null]));
        for (status, fixed, expected) in [
            ("arrived", true, json!(["stop"])),
            ("unknown", false, json!([])),
        ] {
            let raw = json!({"status":status,"stationaryTarget":fixed,"segments":[]});
            let pose = serde_json::to_value(parse_pulses(&raw.to_string()).unwrap()).unwrap();
            assert_eq!(pose["directions"], expected);
            assert_eq!(pose["pulseDirections"], json!([]));
        }
    }

    #[test]
    fn malformed_or_partial_pulse_directions_never_release_the_valid_prefix() {
        for suffix in [
            json!({"direction":"faceTarget","count":1}),
            json!({"direction":"around","count":1}),
            json!({"direction":"stop","count":1}),
            json!({"direction":"forward","count":null}),
            json!({"direction":"right","count":0}),
            json!({"direction":"right","count":1.5}),
            json!({"direction":"forward","count":10}),
        ] {
            let raw = json!({"status":"ready","stationaryTarget":true,"segments":[{"direction":"left","count":1},suffix]});
            assert!(parse_pulses(&raw.to_string()).is_err(), "{raw}");
        }
        for (status, fixed, segments) in [
            ("ready", false, json!([{"direction":"forward","count":1}])),
            ("ready", true, json!([])),
            ("arrived", true, json!([{"direction":"forward","count":1}])),
            ("unknown", false, json!([{"direction":"right","count":1}])),
        ] {
            let raw = json!({"status":status,"stationaryTarget":fixed,"segments":segments});
            assert!(parse_pulses(&raw.to_string()).is_err(), "{raw}");
        }
    }

    #[test]
    fn single_frame_directions_prompt_uses_the_selected_view_and_only_asks_for_directions() {
        for (view, paired, label) in [
            ("passive", false, "固定摄像头"),
            ("passive", true, "俯视图"),
            ("dominant", false, "前方摄像头"),
        ] {
            let input: LocateInput = serde_json::from_value(json!({
                "imageDataUrl": "data:image/jpeg;base64,/9j/AA==",
                "inspection": {"target":"白色垃圾桶","calibratedFloor":paired,"directionsOnly":true},
                "searchView": view
            })).unwrap();
            input.validate().unwrap();
            assert_eq!(input.request_timeout(), READ_ONLY_TIMEOUT);
            let prompt = build_prompt(&input);
            assert!(!prompt.contains('+'));
            for word in [
                label,
                "白色垃圾桶",
                "faceTarget",
                "forward",
                "directions",
                "distancesM",
                "直行距离（米）",
            ] {
                assert!(prompt.contains(word), "{word}");
            }
            for word in [
                "安全",
                "障碍",
                "净空",
                "置信度",
                "标定",
                "步幅",
                "pathClear",
                "confidence",
                "米数",
                "超时",
            ] {
                assert!(!prompt.contains(word), "{word}");
            }
        }
    }

    #[test]
    fn single_frame_directions_preserve_order_and_only_expose_recognized_actions() {
        let list = json!(["faceTarget", "forward", "right", "around", "left", "stop"]);
        let result =
            parse_reply(&json!({"directions":list, "reason":"额外文字"}).to_string()).unwrap();
        let pose = serde_json::to_value(result).unwrap();
        assert_eq!(pose["directions"], list);
        assert!(pose.get("directionSteps").is_none());
        assert!(pose.get("reason").is_none() && pose.get("singleFrameRoute").is_none());
        assert_eq!(
            parse_reply(r#"{"directions":[]}"#).unwrap().directions,
            Some(vec![])
        );
        for invalid in [
            json!({}),
            json!({"directions":"left"}),
            json!({"directions":["backward"]}),
            json!({"directions":["left", 4]}),
            json!({"directions":vec!["forward"; MAX_DIRECTIONS+1]}),
        ] {
            assert!(parse_reply(&invalid.to_string()).is_err());
        }
    }

    #[test]
    fn single_frame_directions_estimate_each_forward_leg_in_steps() {
        let directions = json!([
            "left", "forward", "forward", "forward", "forward", "forward", "forward", "forward",
            "stop"
        ]);
        let raw = json!({
            "directions": directions,
            "distancesM": [12, 0.04, 0.59, 0.6, 1.4, 1.6, "三米", -1, 0.4]
        });
        let pose = serde_json::to_value(parse_reply(&raw.to_string()).unwrap()).unwrap();
        assert_eq!(
            pose["directionSteps"],
            json!([null, 1, 1, 2, 4, 4, null, null, null])
        );
        assert_eq!(pose["directions"], directions);
        for distances in [
            json!(null),
            json!("1.4"),
            json!([1.4]),
            json!([0, 0, null, -1, {}, 1e100, false, -2, 1.4]),
        ] {
            let raw = json!({"directions": directions, "distancesM":distances});
            let pose = serde_json::to_value(parse_reply(&raw.to_string()).unwrap()).unwrap();
            assert_eq!(pose["directions"], directions);
            assert!(pose.get("directionSteps").is_none());
        }
    }
}
