use super::{
    confident_marker, inspection_markers_in, read_markers_json, FloorPoint, VisionPose,
    WalkDirection, WalkFloorSize, WalkPath, WalkPathQuery, UNMEASURED_WALK_CLEARANCE_M,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum WalkIssueKind {
    Obstacle,
    Occluded,
    Uncertain,
}

impl WalkFloorSize {
    // Coordinates are normalized on the rectified floor. Only the component
    // along the requested travel direction counts toward the required distance.
    fn visible_distance(
        &self,
        feet: &FloorPoint,
        heading: &FloorPoint,
        end: &FloorPoint,
        direction: &WalkDirection,
    ) -> Option<f64> {
        let dx = (heading.x - feet.x) * self.width;
        let dy = (heading.y - feet.y) * self.depth;
        let length = dx.hypot(dy);
        if length <= 0.0 {
            return None;
        }
        let sign = match direction {
            WalkDirection::Forward => 1.0,
            WalkDirection::Backward => -1.0,
        };
        let ux = sign * dx / length;
        let uy = sign * dy / length;
        let ex = (end.x - feet.x) * self.width;
        let ey = (end.y - feet.y) * self.depth;
        let along = ex * ux + ey * uy;
        let across = (ex * uy - ey * ux).abs();
        (along >= 0.0 && across <= along * 25_f64.to_radians().tan()).then_some(along)
    }
}

fn distance_problem(
    query: &WalkPathQuery,
    result: &Value,
    feet: &FloorPoint,
    heading: &FloorPoint,
) -> Option<String> {
    let required = query.step_m.unwrap_or(UNMEASURED_WALK_CLEARANCE_M);
    let estimate = if let Some(size) = &query.floor_size_m {
        let distance = confident_marker(result, "clearTo")
            .and_then(|end| size.visible_distance(feet, heading, &end, &query.direction));
        if distance.is_none() {
            return Some(format!(
                "无法在标定地面上定位沿行走方向的可通行边界，本步需确认至少 {required} 米。"
            ));
        }
        distance
    } else if query.step_m.is_none() {
        result["clearDistanceM"]
            .as_f64()
            .filter(|m| (0.0..=100.0).contains(m))
    } else {
        return None;
    };
    // Subtracting normalized coordinates can put an exact step a few ULPs
    // below its metric length. Only absorb that arithmetic error on the map.
    let roundoff = query
        .floor_size_m
        .as_ref()
        .map_or(0.0, |s| 8.0 * f64::EPSILON * s.width.max(s.depth));
    match estimate {
        None => Some(format!(
            "未取得可靠的可通行距离估计，本步需确认至少 {required} 米。"
        )),
        Some(m) if m + roundoff < required => Some(format!(
            "画面可确认的地面距离不足 {required} 米（估计 {m:.3} 米）。"
        )),
        _ => None,
    }
}

pub(super) fn parse_walk_path(
    raw: &str,
    dominant: bool,
    query: &WalkPathQuery,
) -> Result<VisionPose, String> {
    let result = read_markers_json(raw)?;
    let marks = inspection_markers_in(&result, !dominant);
    let (Some(robot), Some(heading_point)) = (marks.robot, marks.heading_point) else {
        return Err(marks
            .reason
            .unwrap_or_else(|| "画面未能确认机器人的位置和行走方向。".into()));
    };
    let issue_kind = match &result["issueKind"] {
        Value::Null if result["issuePoint"].is_null() => None,
        kind => Some(match kind.as_str() {
            Some("obstacle") => WalkIssueKind::Obstacle,
            Some("occluded") => WalkIssueKind::Occluded,
            _ => WalkIssueKind::Uncertain,
        }),
    };
    let issue_point = match issue_kind {
        Some(WalkIssueKind::Obstacle | WalkIssueKind::Occluded) => {
            confident_marker(&result, "issuePoint")
        }
        _ => None,
    };
    let distance = distance_problem(query, &result, &robot, &heading_point);
    let confident = result["clearConfidence"]
        .as_f64()
        .is_some_and(|c| (0.75..=1.0).contains(&c));
    let reported_clear = result["clear"].as_bool() == Some(true);
    let model_clear = reported_clear && issue_kind.is_none();
    let clear = model_clear && distance.is_none() && confident;
    let reason = if !model_clear {
        let detail = match (issue_kind, &issue_point) {
            (Some(WalkIssueKind::Obstacle | WalkIssueKind::Occluded), None) => {
                Some("无法可靠定位通路内的障碍或遮挡位置。".into())
            }
            _ if reported_clear => Some("模型同时报告了通畅和异常，无法确认下一步可通行。".into()),
            _ => marks.reason,
        };
        match (detail, distance) {
            (Some(detail), Some(distance)) => Some(format!("{detail} {distance}")),
            (detail, distance) => detail.or(distance),
        }
    } else if distance.is_some() {
        distance
    } else if !confident {
        Some("视觉模型对通路畅通的置信度不足，无法确认本步可通行。".into())
    } else {
        marks.reason
    };
    Ok(VisionPose {
        walk_path: Some(WalkPath {
            robot,
            heading_point,
            clear,
            reason,
            issue_kind,
            issue_point,
        }),
        ..VisionPose::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibrated_walk_measures_confident_floor_evidence_in_the_requested_direction() {
        let point = |x, y| serde_json::json!({"x":x, "y":y, "confidence":0.91});
        let mut query: WalkPathQuery = serde_json::from_value(serde_json::json!({
            "direction":"forward", "calibratedFloor":true, "floorSizeM":{"width":4.0,"depth":2.0}
        }))
        .unwrap();
        let mut data = serde_json::json!({
            "robotCount":1, "robot":point(0.4, 0.5), "headingPoint":point(0.5, 0.5),
            "clear":true, "clearConfidence":0.93, "clearDistanceM":1.4
        });
        let parse = |data: &serde_json::Value, query: &WalkPathQuery| {
            parse_walk_path(&data.to_string(), false, query)
                .unwrap()
                .walk_path
                .unwrap()
        };
        for (name, endpoint, allowed) in [
            ("no endpoint", serde_json::Value::Null, false),
            ("off the calibrated floor", point(1.1, 0.5), false),
            (
                "low confidence",
                serde_json::json!({"x":0.73,"y":0.5,"confidence":0.4}),
                false,
            ),
            ("opposite the requested direction", point(0.1, 0.5), false),
            ("exactly 0.8 m along the floor", point(0.6, 0.5), true),
            ("0.76 m projected along heading", point(0.59, 0.67), false),
            ("26.6 degrees off heading", point(0.65, 0.75), false),
            (
                "21.8 degrees off heading on a rectangular floor",
                point(0.65, 0.7),
                true,
            ),
            ("1.3 m directly ahead", point(0.725, 0.5), true),
        ] {
            data["clearTo"] = endpoint;
            assert_eq!(parse(&data, &query).clear, allowed, "{name}");
        }
        data["clearDistanceM"] = 0.15.into();
        assert!(
            parse(&data, &query).clear,
            "floor geometry supersedes guessed metres"
        );
        data["clearConfidence"] = 0.5.into();
        assert!(!parse(&data, &query).clear);
        data["clearConfidence"] = 0.9.into();
        data["clear"] = false.into();
        assert!(!parse(&data, &query).clear);
        data["clear"] = true.into();
        query.direction = WalkDirection::Backward;
        assert!(!parse(&data, &query).clear);
        data["clearTo"] = point(0.1, 0.5);
        assert!(parse(&data, &query).clear);
        query.step_m = Some(1.3);
        assert!(
            !parse(&data, &query).clear,
            "1.2 m cannot cover a 1.3 m pulse"
        );
    }

    #[test]
    fn walk_path_reports_only_locatable_issues_and_keeps_contradictory_clearance_stopped() {
        let query: WalkPathQuery = serde_json::from_value(serde_json::json!({
            "direction":"forward", "calibratedFloor":false, "stepM":0.15
        }))
        .unwrap();
        let mut data = serde_json::json!({
            "robotCount":1, "robot":{"x":0.4,"y":0.5,"confidence":0.9},
            "headingPoint":{"x":0.5,"y":0.5,"confidence":0.9},
            "clear":false, "clearConfidence":0.93,
            "issuePoint":{"x":0.48,"y":0.51,"confidence":0.91}
        });
        let parse = |data: &serde_json::Value| {
            let path = parse_walk_path(&data.to_string(), false, &query)
                .unwrap()
                .walk_path
                .unwrap();
            serde_json::to_value(path).unwrap()
        };
        for kind in ["obstacle", "occluded"] {
            data["issueKind"] = kind.into();
            let blocked = parse(&data);
            assert_eq!(blocked["clear"], false);
            assert_eq!(blocked["issueKind"], kind);
            assert_eq!(blocked["issuePoint"]["x"], 0.48);
            assert_eq!(blocked["issuePoint"]["y"], 0.51);
            data["clear"] = true.into();
            assert_eq!(parse(&data)["clear"], false, "{kind} conflicts with clear");
            data["clear"] = false.into();
        }
        for unreliable in [
            serde_json::Value::Null,
            serde_json::json!({"x":1.02,"y":0.51,"confidence":0.91}),
            serde_json::json!({"x":0.48,"y":0.51,"confidence":0.5}),
        ] {
            data["issuePoint"] = unreliable;
            let blocked = parse(&data);
            assert_eq!(blocked["clear"], false);
            assert!(blocked["issuePoint"].is_null());
        }
        data["issueKind"] = "uncertain".into();
        data["issuePoint"] = serde_json::json!({"x":0.48,"y":0.51,"confidence":0.91});
        let uncertain = parse(&data);
        assert_eq!(uncertain["clear"], false);
        assert!(
            uncertain["issuePoint"].is_null(),
            "unlocated uncertainty has no obstacle marker"
        );
    }
}
