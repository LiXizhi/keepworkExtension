//! One fixed-camera exposure supplies the complete pulse sequence. Validate
//! every segment before the renderer can see any movement instruction.

use super::{
    default_scene_confidence, extract_json_object, FloorPoint, WalkFloorSize, MAX_REASON_CHARS,
    NOMINAL_FORWARD_STEP_M,
};
use serde::{Deserialize, Serialize};

const MAX_PULSES: usize = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Query {
    pub(super) target: String,
    calibrated_floor: bool,
    floor_size_m: Option<WalkFloorSize>,
    step_m: Option<f64>,
    greeting_m: f64,
    left_deg: Option<f64>,
    turn_deg: Option<f64>,
    #[serde(default = "default_scene_confidence")]
    min_confidence: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ready,
    Arrived,
    Ambiguous,
    Lost,
    Uncertain,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Forward,
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
struct Segment {
    direction: Direction,
    count: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<FloorPoint>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    status: Status,
    #[serde(default)]
    segments: Vec<Segment>,
    #[serde(default)]
    confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    robot: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_point: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approach: Option<FloorPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    #[serde(flatten)]
    route: Route,
    robot_count: Option<u32>,
    target_count: Option<u32>,
    target_kind: Option<String>,
    #[serde(default)]
    scale_reliable: bool,
    #[serde(default)]
    path_clear: bool,
    #[serde(default)]
    turn_clear: bool,
}

impl Query {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.step_m.is_some_and(|m| !(0.001..=100.0).contains(&m))
            || !(self.greeting_m > 0.0 && self.greeting_m <= 100.0)
            || !(0.01..=1.0).contains(&self.min_confidence)
            || [self.left_deg, self.turn_deg]
                .into_iter()
                .flatten()
                .any(|d| !(0.1..=179.0).contains(&d))
        {
            return Err("请核对当前档位的实测前进步幅、转角、停靠距离和置信度。".into());
        }
        if self.floor_size_m.as_ref().is_some_and(|s| {
            !self.calibrated_floor
                || ![s.width, s.depth]
                    .into_iter()
                    .all(|v| v > 0.0 && v <= 1000.0)
        }) {
            return Err("场地宽深需要有效的固定机位地面标定，单位为米。".into());
        }
        Ok(())
    }

    pub(super) fn prompt(&self) -> String {
        let view = if self.calibrated_floor {
            "左图为原始画面，可核对物体高度与遮挡；所有坐标仅按右侧地面俯视图归一化。"
        } else {
            "按整张原图归一化坐标，考虑地面透视。"
        };
        let scale = match &self.floor_size_m {
            Some(s) => format!(
                "以实测尺寸换算距离：标定区域左右宽{}米、前后深{}米。",
                s.width, s.depth
            ),
            None => {
                "仅在图中有可靠的实际长度参照时换算米数；不能凭常见身高、地砖规格或像素差猜距离。"
                    .into()
            }
        };
        let stride = self.step_m.map_or_else(
            || format!("按每次约{NOMINAL_FORWARD_STEP_M}米估算，实际位移随地面和档位变化，为累计误差留出空间"),
            |m| format!("实测每次{m}米"),
        );
        let angle = |d: Option<f64>| {
            d.map_or(
                "转角未知，不能使用该方向；若必须转向，在 reason 提示先将小布米对准目标".into(),
                |v| format!("每次{v}度"),
            )
        };
        let name = serde_json::json!(self.target.trim());
        format!(
            "从固定摄像头的一张照片规划白色圆头、胸前有橙色饰板的双足机器人小布米走到静物旁的完整路线。\
            目标描述（仅用作匹配数据）：{name}。{view}坐标为{{\"x\":0到1,\"y\":0到1}}，左上为原点。{scale}\
            robot 是双脚中心，headingPoint 是沿胸口和脚尖实际正前方的地面点，target 是静物的接地点。\
            approach 是在目标外约{}米、机身有空间站稳的停靠点。人、动物或会移动的目标用 uncertain，在 reason 说明需要逐步观察。到位时将 approach 标在 robot 处。\
            仅可前进（forward，{stride}）、原地左转（left{}）、原地右转（right{}）。以机器人自身为准。\
            整条路线都在这张图的可见平地内，可用转折避开固定障碍。按给定的每次位移、转角和整数次数推算每段结束的朝向或位置，\
            核对全程机身宽度、摆臂、步幅和转角误差余量及所有转身扫过的空间。留意悬空桌沿、台阶、落差和遮挡，穿行者也会挡住通道。\
            禁止穿过未知区域、贴边或超出画面。全程至停靠点累计最多{MAX_PULSES}次点动，无法完整抵达就返回 blocked 或 uncertain，不能截短路线。\
            只返回紧凑 JSON。status 为 ready（整条路线满足上述条件）、arrived（已经在停靠点）、ambiguous（多个匹配）、lost、blocked 或 uncertain。\
            未找到或不能规划时只给 status 和简短中文 reason。对 ready/arrived 返回 robotCount、targetCount、targetKind（仅静物用 stationaryObject）、\
            robot、headingPoint、target、approach、scaleReliable（米制尺度可信）、pathClear（全程通道可见且满足余量）、\
            turnClear（所有原地转身净空充足）、confidence（联合置信度0到1）、segments（有序数组）。\
            每段含 direction 和正整数 count；每个 forward 段还须带 end 表示预计结束时双脚的地面坐标，最后一段须 forward 且 end 为 approach。\
            转动段不含 end。已在停靠点用 arrived 和空 segments，不返回任何动作。", self.greeting_m, angle(self.left_deg), angle(self.turn_deg)
        )
    }

    pub(super) fn parse_reply(&self, raw: &str) -> Result<Route, String> {
        let object = extract_json_object(raw).ok_or("视觉模型未返回单图路线。")?;
        let mut evidence: Evidence =
            serde_json::from_str(object).map_err(|_| "视觉模型返回的单图路线格式无效。")?;
        evidence.route.reason = evidence
            .route
            .reason
            .as_deref()
            .map(|s| {
                s.trim()
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(MAX_REASON_CHARS)
                    .collect()
            })
            .filter(|s: &String| !s.is_empty());
        if matches!(evidence.route.status, Status::Ready | Status::Arrived)
            && evidence.target_kind.as_deref() != Some("stationaryObject")
        {
            evidence.route.status = Status::Uncertain;
            evidence.route.reason =
                Some("单图路线仅支持固定物体。接近人或动物时请使用逐步观察。".into());
        }
        if matches!(evidence.route.status, Status::Ready | Status::Arrived) {
            self.check(&evidence)?;
        } else {
            evidence.route.segments.clear();
            evidence.route.confidence = 0.0;
            evidence.route.robot = None;
            evidence.route.heading_point = None;
            evidence.route.target = None;
            evidence.route.approach = None;
        }
        Ok(evidence.route)
    }

    fn check(&self, e: &Evidence) -> Result<(), String> {
        let r = &e.route;
        if e.robot_count != Some(1) {
            return Err(
                "单图规划需要在画面中定位一台小布米。请检查双脚和机身是否清晰可见。".into(),
            );
        }
        if e.target_count != Some(1) {
            return Err("单图规划未能确定唯一目标。请补充目标的颜色或位置后重试。".into());
        }
        if self.floor_size_m.is_none() && !e.scale_reliable {
            return Err("单图中缺少可靠的长度参照。请标定地面四角并填写实测宽深，或关闭单图规划后逐步观察。".into());
        }
        if !(0.0..=1.0).contains(&r.confidence) {
            return Err("模型返回的单图路线置信度超出范围。".into());
        }
        if r.confidence < self.min_confidence {
            return Err(format!(
                "单图路线置信度 {} 低于设定值 {}。可关闭单图规划后逐步观察。",
                r.confidence, self.min_confidence
            ));
        }
        let [Some(robot), Some(front), Some(target), Some(approach)] =
            [&r.robot, &r.heading_point, &r.target, &r.approach]
                .map(|p| p.as_ref().filter(|p| p.on_floor()))
        else {
            return Err("无法确定机器人、朝向、目标和停靠点在地面上的位置。".into());
        };
        let separation = |a: &FloorPoint, b: &FloorPoint| (a.x - b.x).hypot(a.y - b.y);
        if separation(robot, front) < 0.005 || separation(approach, target) < 0.001 {
            return Err("机器人朝向或目标外的停靠点不明确。".into());
        }
        if r.status == Status::Arrived {
            if !r.segments.is_empty() || separation(robot, approach) > 0.015 {
                return Err("到位判断与路线动作或机器人位置冲突。".into());
            }
        } else {
            if !e.path_clear || r.segments.is_empty() || r.segments.len() > MAX_PULSES {
                return Err("未得到完整且全程可通行的路线。".into());
            }
            let mut total = 0;
            let mut previous = robot;
            for part in &r.segments {
                total += usize::from(part.count);
                if part.count == 0 || total > MAX_PULSES {
                    return Err("路线点动次数超出范围。".into());
                }
                match part.direction {
                    Direction::Forward => {
                        let end = part
                            .end
                            .as_ref()
                            .filter(|p| p.on_floor() && separation(previous, p) > 0.0)
                            .ok_or("无法确定前进路段的地面终点。")?;
                        previous = end;
                    }
                    Direction::Left | Direction::Right => {
                        let angle = if part.direction == Direction::Left {
                            self.left_deg
                        } else {
                            self.turn_deg
                        };
                        if angle.is_none() {
                            return Err(
                                "这条路线需要转向。请将小布米对准目标后重新单图行走。".into()
                            );
                        }
                        if !e.turn_clear || part.end.is_some() {
                            return Err("单图路线中的原地转向空间或终点无效。".into());
                        }
                    }
                }
            }
            if r.segments.last().map(|s| s.direction) != Some(Direction::Forward)
                || separation(previous, approach) > 0.005
            {
                return Err("路线未终止在目标外的停靠点。".into());
            }
        }
        if let Some(size) = &self.floor_size_m {
            self.check_floor(size, robot, front, target, approach, &r.segments)?;
        }
        Ok(())
    }

    // Simulate the calibrated pulses in metres, including the aspect ratio of
    // the rectangular floor. Compare each predicted endpoint with the point on
    // the photographed clear corridor before releasing even the first pulse.
    fn check_floor(
        &self,
        size: &WalkFloorSize,
        robot: &FloorPoint,
        front: &FloorPoint,
        target: &FloorPoint,
        approach: &FloorPoint,
        segments: &[Segment],
    ) -> Result<(), String> {
        let mut x = robot.x * size.width;
        let mut y = robot.y * size.depth;
        let mut angle = ((front.y - robot.y) * size.depth).atan2((front.x - robot.x) * size.width);
        let step_m = self.step_m.unwrap_or(NOMINAL_FORWARD_STEP_M);
        let tolerance = step_m * 0.5 + 0.02;
        for part in segments {
            let count = f64::from(part.count);
            match part.direction {
                Direction::Left => angle -= self.left_deg.unwrap().to_radians() * count,
                Direction::Right => angle += self.turn_deg.unwrap().to_radians() * count,
                Direction::Forward => {
                    let travel = step_m * count;
                    x += travel * angle.cos();
                    y += travel * angle.sin();
                    let end = part.end.as_ref().unwrap();
                    if !(0.0..=size.width).contains(&x)
                        || !(0.0..=size.depth).contains(&y)
                        || (x - end.x * size.width).hypot(y - end.y * size.depth) > tolerance
                    {
                        return Err("按步幅和转角推算的终点偏离画面中的通路。".into());
                    }
                }
            }
        }
        let stand_off = (x - target.x * size.width).hypot(y - target.y * size.depth);
        if (x - approach.x * size.width).hypot(y - approach.y * size.depth) > tolerance
            || (stand_off - self.greeting_m).abs() > tolerance
        {
            return Err("按实测场地推算，路线无法在设定距离停靠。".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::bumi::vision::{build_prompt, LocateInput, MOTION_OBSERVATION_TIMEOUT};
    use serde_json::{json, Value};

    fn input() -> Value {
        json!({
            "imageDataUrl": "data:image/jpeg;base64,/9j/AA==",
            "singleFrameRoute": {
                "target":"白色垃圾桶","stepM":0.25,"leftDeg":90.0,"turnDeg":90.0,"greetingM":0.5,
                "calibratedFloor":true,"floorSizeM":{"width":4.0,"depth":2.0}
            }
        })
    }

    fn reply() -> Value {
        json!({
            "status":"ready","confidence":0.85,"robotCount":1,"targetCount":1,"targetKind":"stationaryObject",
            "scaleReliable":true,"pathClear":true,"turnClear":true,
            "robot":{"x":0.25,"y":0.25},"headingPoint":{"x":0.375,"y":0.25},
            "target":{"x":0.5,"y":0.5},"approach":{"x":0.375,"y":0.5},
            "segments":[{"direction":"forward","count":2,"end":{"x":0.375,"y":0.25}},
                {"direction":"right","count":1},{"direction":"forward","count":2,"end":{"x":0.375,"y":0.5}}]
        })
    }

    #[test]
    fn route_requires_exclusive_passive_camera_and_valid_motion_scale() {
        let mut data = input();
        let parse = |data: &Value| serde_json::from_value::<LocateInput>(data.clone());
        let native = parse(&data).unwrap();
        assert!(native.validate().is_ok());
        assert_eq!(native.request_timeout(), MOTION_OBSERVATION_TIMEOUT);
        let prompt = build_prompt(&native);
        for text in [
            "白色垃圾桶",
            "右侧地面俯视图",
            "4米",
            "0.25米",
            "每次90度",
            "静物",
            "10次",
            "stationaryObject",
            "segments",
        ] {
            assert!(prompt.contains(text), "{text}");
        }
        for conflict in [
            json!({"searchView":"dominant"}),
            json!({"goalCell":1}),
            json!({"targetName":"人"}),
            json!({"inspection":{"target":"人","calibratedFloor":false}}),
            json!({"walkContinue":{"calibratedFloor":false}}),
            json!({"walkPath":{"calibratedFloor":false,"direction":"forward"}}),
        ] {
            let mut extra = data.clone();
            extra
                .as_object_mut()
                .unwrap()
                .extend(conflict.as_object().unwrap().clone());
            assert!(parse(&extra).unwrap().validate().is_err(), "{conflict}");
        }
        for (field, value) in [
            ("stepM", json!(0)),
            ("stepM", json!(140)),
            ("leftDeg", json!(180)),
            ("greetingM", json!(-1)),
            ("minConfidence", json!(0)),
            ("calibratedFloor", json!(false)),
            ("target", json!("  ")),
            ("floorSizeM", json!({"width":0,"depth":1})),
        ] {
            let mut invalid = data.clone();
            invalid["singleFrameRoute"][field] = value;
            assert!(parse(&invalid).unwrap().validate().is_err(), "{field}");
        }
        data["singleFrameRoute"]
            .as_object_mut()
            .unwrap()
            .remove("floorSizeM");
        data["singleFrameRoute"]["calibratedFloor"] = false.into();
        let raw = parse(&data).unwrap();
        assert!(raw.validate().is_ok() && build_prompt(&raw).contains("实际长度参照"));
        data["singleFrameRoute"]
            .as_object_mut()
            .unwrap()
            .remove("stepM");
        let raw = parse(&data).unwrap();
        assert!(raw.validate().is_ok());
        assert!(build_prompt(&raw).contains("每次约0.4米估算"));
    }

    #[test]
    fn full_route_retains_endpoints_and_rejects_invalid_suffix_before_motion() {
        let mut q: Query = serde_json::from_value(input()["singleFrameRoute"].clone()).unwrap();
        let plan = reply();
        let accepted = serde_json::to_value(q.parse_reply(&plan.to_string()).unwrap()).unwrap();
        assert_eq!(accepted["status"], "ready");
        assert_eq!(accepted["segments"], plan["segments"]);
        assert!(accepted.get("scaleReliable").is_none());
        for (pointer, value) in [
            ("/targetCount", json!(2)),
            ("/robotCount", json!(0)),
            ("/pathClear", json!(false)),
            ("/turnClear", json!(false)),
            ("/confidence", json!(0.74)),
            ("/robot", Value::Null),
            ("/headingPoint", plan["robot"].clone()),
            ("/segments/2/count", json!(0)),
            ("/segments/2/count", json!(8)),
            ("/segments/2/count", json!(0.7)),
            ("/segments/2/direction", json!("backward")),
            ("/segments/2/end", Value::Null),
            ("/segments/2/end/x", json!(1.3)),
            ("/segments/0/end/x", json!(0.25)),
            ("/segments/1/direction", json!("left")),
            ("/segments/2/end/y", json!(0.1)),
            ("/target/y", json!(0.95)),
        ] {
            let mut invalid = plan.clone();
            *invalid.pointer_mut(pointer).unwrap() = value.clone();
            assert!(
                q.parse_reply(&invalid.to_string()).is_err(),
                "{pointer} {value}"
            );
        }
        q.turn_deg = None;
        assert!(q
            .parse_reply(&plan.to_string())
            .unwrap_err()
            .contains("对准目标"));
        let mut straight = plan;
        straight["segments"] =
            json!([{"direction":"forward","count":2,"end":{"x":0.375,"y":0.25}}]);
        straight["approach"] = straight["segments"][0]["end"].clone();
        straight["target"]["y"] = json!(0.25);
        straight["turnClear"] = json!(false);
        assert!(q.parse_reply(&straight.to_string()).is_ok());
    }

    #[test]
    fn measured_floor_supplies_scale_but_still_checks_the_planned_waypoints() {
        let mut q: Query = serde_json::from_value(input()["singleFrameRoute"].clone()).unwrap();
        let mut plan = reply();
        plan["scaleReliable"] = json!(false);
        assert!(q.parse_reply(&plan.to_string()).is_ok());
        let mut deviation = plan.clone();
        deviation["segments"][0]["end"]["x"] = json!(0.8);
        assert!(q
            .parse_reply(&deviation.to_string())
            .unwrap_err()
            .contains("偏离"));
        q.floor_size_m = None;
        assert!(q
            .parse_reply(&plan.to_string())
            .unwrap_err()
            .contains("长度参照"));
        plan["scaleReliable"] = json!(true);
        assert!(q.parse_reply(&plan.to_string()).is_ok());
    }

    #[test]
    fn nominal_stride_works_without_manual_entries_and_preserves_full_route_checks() {
        let mut q: Query = serde_json::from_value(json!({
            "target":"垃圾桶","calibratedFloor":false,"greetingM":0.5
        }))
        .unwrap();
        let mut plan = reply();
        plan["segments"] = json!([{"direction":"forward","count":2,"end":{"x":0.45,"y":0.25}}]);
        plan["approach"] = plan["segments"][0]["end"].clone();
        plan["target"] = json!({"x":0.575,"y":0.25});
        assert_eq!(
            q.parse_reply(&plan.to_string()).unwrap().status,
            Status::Ready
        );
        plan["scaleReliable"] = json!(false);
        assert!(q.parse_reply(&plan.to_string()).is_err());
        q.calibrated_floor = true;
        q.floor_size_m = Some(WalkFloorSize {
            width: 4.0,
            depth: 2.0,
        });
        assert_eq!(
            q.parse_reply(&plan.to_string()).unwrap().status,
            Status::Ready
        );
        plan["segments"][0]["count"] = json!(4);
        assert!(q
            .parse_reply(&plan.to_string())
            .unwrap_err()
            .contains("偏离"));
    }

    #[test]
    fn non_motion_results_never_leak_commands_or_claim_arrival_without_evidence() {
        let q: Query = serde_json::from_value(input()["singleFrameRoute"].clone()).unwrap();
        for state in ["uncertain", "ambiguous", "blocked", "lost"] {
            let mut v = reply();
            v["status"] = json!(state);
            let r = q.parse_reply(&v.to_string()).unwrap();
            assert!(r.segments.is_empty() && r.robot.is_none());
        }
        let mut v = reply();
        v["targetKind"] = json!("person");
        let person = q.parse_reply(&v.to_string()).unwrap();
        assert_eq!(person.status, Status::Uncertain);
        assert!(person.segments.is_empty());
        v = reply();
        v["status"] = json!("arrived");
        assert!(q.parse_reply(&v.to_string()).is_err());
        v["segments"] = json!([]);
        assert!(q.parse_reply(&v.to_string()).is_err());
        v["robot"] = v["approach"].clone();
        assert_eq!(
            q.parse_reply(&v.to_string()).unwrap().status,
            Status::Arrived
        );
        v.as_object_mut().unwrap().remove("target");
        assert!(q.parse_reply(&v.to_string()).is_err());
    }
}
