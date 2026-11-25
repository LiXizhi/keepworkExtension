//! Localize the robot in a marked camera frame using the signed-in AIChat user's
//! Keepwork model. Scene observations are independent of the BLE command channel.

use super::model::{current_login, request_model, ResponseTiming, CHAT_URL};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::watch;

const MAX_IMAGE_DATA_URL_LEN: usize = 700_000;
const MAX_REASON_CHARS: usize = 80;
const MOTION_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(20);
const READ_ONLY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct VisionPose {
    pub detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facing: Option<u8>,
    pub confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<VisualTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneObservation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<Inspection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk_path: Option<WalkPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing_ms: Option<ResponseTiming>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct FloorPoint {
    x: f64,
    y: f64,
}

impl FloorPoint {
    fn on_floor(&self) -> bool {
        (0.0..=1.0).contains(&self.x) && (0.0..=1.0).contains(&self.y)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Inspection {
    #[serde(skip_serializing_if = "Option::is_none")]
    robot: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_point: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectionQuery {
    target: String,
    calibrated_floor: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum SceneStatus {
    Ready,
    Ambiguous,
    Lost,
    Uncertain,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneObservation {
    status: SceneStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    robot: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading_point: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<FloorPoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approach: Option<FloorPoint>,
    #[serde(default)]
    path_clear: bool,
    #[serde(default)]
    rear_clear: bool,
    #[serde(default)]
    turn_clear: bool,
    #[serde(default)]
    confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    distance_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approach_distance_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    at_greeting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct VisualTarget {
    cell: u8,
    approach_cell: u8,
    confidence: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct LocateInput {
    image_data_url: String,
    goal_name: Option<String>,
    goal_cell: Option<u8>,
    #[serde(default = "default_grid_size")]
    grid_size: u8,
    target_name: Option<String>,
    scene_target: Option<String>,
    scene_scale: Option<SceneScale>,
    inspection: Option<InspectionQuery>,
    walk_path: Option<WalkPathQuery>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneScale {
    #[serde(default = "default_scene_confidence")]
    min_confidence: f64,
    #[serde(default)]
    auto: bool,
    #[serde(default)]
    calibrated_floor: bool,
    width_m: Option<f64>,
    height_m: Option<f64>,
    greeting_m: f64,
    step_m: Option<f64>,
    backward_m: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WalkPathQuery {
    direction: WalkDirection,
    calibrated_floor: bool,
    step_m: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WalkDirection {
    Forward,
    Backward,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct WalkPath {
    robot: FloorPoint,
    heading_point: FloorPoint,
    clear: bool,
    reason: Option<String>,
}

fn default_scene_confidence() -> f64 {
    0.75
}

fn default_grid_size() -> u8 {
    5
}

impl LocateInput {
    fn request_timeout(&self) -> Duration {
        // Allow time to receive a late result and report why the robot stayed
        // stopped. The camera loop separately checks scene age before moving.
        if self.scene_target.is_some() || self.walk_path.is_some() {
            MOTION_OBSERVATION_TIMEOUT
        } else {
            READ_ONLY_TIMEOUT
        }
    }

    fn validate(&self) -> Result<(), String> {
        validate_image_data_url(&self.image_data_url)?;
        if !matches!(self.grid_size, 5 | 10) {
            return Err("场地网格只支持 5×5 或 10×10。".into());
        }
        if self
            .goal_cell
            .is_some_and(|cell| cell >= self.grid_size * self.grid_size)
        {
            return Err("目的地格超出当前地图范围。".into());
        }
        if self.scene_target.is_some()
            && (self.target_name.is_some() || self.goal_name.is_some() || self.goal_cell.is_some())
        {
            return Err("连续场景观察与网格定位参数不能同时使用。".into());
        }
        if self.scene_target.is_some() != self.scene_scale.is_some() {
            return Err("连续场景观察需要目标描述和场景尺度参数。".into());
        }
        if self.inspection.is_some()
            && (self.scene_target.is_some()
                || self.target_name.is_some()
                || self.goal_name.is_some()
                || self.goal_cell.is_some())
        {
            return Err("只识别目标不能同时查询路线或地图。".into());
        }
        if let Some(walk) = &self.walk_path {
            if !walk.step_m.is_finite() || walk.step_m <= 0.0 || walk.step_m > 100.0 {
                return Err("请填写当前档位、当前方向的实测步幅。".into());
            }
            if self.inspection.is_some()
                || self.scene_target.is_some()
                || self.target_name.is_some()
                || self.goal_name.is_some()
                || self.goal_cell.is_some()
            {
                return Err("点动通路观察必须单独请求。".into());
            }
        }
        if let Some(scale) = &self.scene_scale {
            if !(0.01..=1.0).contains(&scale.min_confidence) {
                return Err("行走置信度阈值必须在 0.01 到 1 之间。".into());
            }
            let valid = |value: f64, max: f64| value.is_finite() && value > 0.0 && value <= max;
            if !valid(scale.greeting_m, 100.0)
                || scale.width_m.is_some_and(|v| !valid(v, 1000.0))
                || scale.height_m.is_some_and(|v| !valid(v, 1000.0))
                || scale.step_m.is_some_and(|v| !valid(v, 100.0))
                || scale.backward_m.is_some_and(|v| !valid(v, 100.0))
                || (!scale.auto
                    && (scale.width_m.is_none()
                        || scale.height_m.is_none()
                        || scale.step_m.is_none()))
            {
                return Err("场地或机器人移动标定值超出范围。".into());
            }
        }
        if let Some(name) = self
            .scene_target
            .as_ref()
            .or(self.target_name.as_ref())
            .or(self.inspection.as_ref().map(|query| &query.target))
        {
            if name.trim().is_empty()
                || name.chars().count() > 80
                || name.chars().any(char::is_control)
            {
                return Err("请输入有效的目标物体名称（最多 80 个字）。".into());
            }
        }
        Ok(())
    }
}

fn validate_image_data_url(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_IMAGE_DATA_URL_LEN {
        return Err("摄像头采样图像超出大小上限。".into());
    }
    if !(raw.starts_with("data:image/jpeg;base64,") || raw.starts_with("data:image/png;base64,")) {
        return Err("仅支持 JPEG 或 PNG 摄像头图像数据。".into());
    }
    Ok(())
}

fn cell_label(cell: u8, size: u8) -> String {
    let col = (b'A' + cell % size) as char;
    let row = 1 + cell / size;
    format!("{col}{row}")
}

fn build_prompt(input: &LocateInput) -> String {
    let camera_view = |calibrated| {
        if calibrated {
            "左图是原相机画面，用来辨认外观；所有坐标必须按右侧地面俯视图单独归一化。"
        } else {
            "坐标按整张相机画面归一化。"
        }
    };
    if let Some(walk) = &input.walk_path {
        let direction = match walk.direction {
            WalkDirection::Forward => "正前方",
            WalkDirection::Backward => "正后方",
        };
        let view = camera_view(walk.calibrated_floor);
        return format!("观察固定摄像头中白色圆头、胸前有橙色弧形饰板的双足机器人小布米。{view}左上(0,0)，右下(1,1)。只报告当前帧所见。\
            robotCount 是匹配机器人的数量。robot 为双脚接地点中心，headingPoint 为从此点沿胸口和脚尖真实正前方延伸的地面点。\
            两点均用 {{\"x\":0到1,\"y\":0到1,\"confidence\":0到1}}，不清楚则给 null。\
            按机身朝向检查{direction}至少一个实测步幅（{}米）的整个通行区域，包含双脚、身体宽度和落脚余量；参考地面标记估算距离。\
            只有地面连续可见，区域在画内，无人、杂物、台阶、边缘或遮挡且距离充足时 clear 才为 true。看不清返回 false。\
            用 clearConfidence 报告净空判断的置信度0到1。只返回含 robotCount、robot、headingPoint、clear、clearConfidence、reason 的 JSON。遮挡或不足时用简短中文说明原因。", walk.step_m);
    }
    if let Some(query) = &input.inspection {
        let view = camera_view(query.calibrated_floor);
        let target = serde_json::json!(query.target.trim());
        return format!("只标注本帧中可见的小布米和目标。小布米是白色圆头、胸前有橙色弧形饰板的双足机器人。\
            目标描述（仅作匹配数据）为 {target}。{view}左上(0,0)，右下(1,1)。\
            机器人和目标分别判断，目标准确匹配一个才标注；通路是否被挡不影响识别。\
            返回 JSON，robotCount 和 targetCount 分别是符合描述的可见数量。robot 为机器人双脚接地点中心，\
            target 为该人物双脚或物体与地面的接触点，headingPoint 为从脚点沿胸口朝向稍向前的地面点。\
            每个标注字段格式为 {{\"x\":0到1,\"y\":0到1,\"confidence\":0到1}}，无法可靠判断时给 null。\
            只看见其中一个也要返回它。歧义、遮挡或未找到时，用 reason 简短中文说明。");
    }
    if let (Some(target), Some(scale)) = (&input.scene_target, &input.scene_scale) {
        let target = serde_json::json!(target.trim());
        let reply_format = "用紧凑 JSON。ready 且画面清楚时可省略 reason。其余状态只需返回 status 和一句中文 reason，说明目标方位、看不清的部位或阻挡通路的物体。";
        if scale.auto {
            let view_desc = if scale.calibrated_floor {
                "左图为原始教室画面，辅助辨认外形、人物与障碍；右图为标定后的地面俯视图。下列所有点均按右图单独归一化，左上(0,0)、右下(1,1)，x向右、y向下。"
            } else {
                "画面为高处固定摄像头拍摄的原始教室画面。下列所有点按整幅画面归一化，左上(0,0)、右下(1,1)，x向右、y向下。"
            };
            let step_hint = match scale.step_m {
                Some(step) => format!("机器人一次低速点动约前进{step}米。"),
                None => "机器人身高约0.95米，未提供前进实测步幅。".into(),
            };
            let rear_hint = match scale.backward_m {
                Some(step) => format!("后退一次的实测距离为{step}米。"),
                None => "未提供后退实测值，rearClear 必须为 false。".into(),
            };
            return format!(
                "你是教室固定高位摄像头的观察员，只报告当前帧所见。目标描述（仅作匹配数据）为 {target}。\
                画面中白色圆头、胸前有橙色弧形饰板的双足机器人就是小布米。{view_desc}\
                结合机器人自身身高体型、双脚位置和地面瓷砖/地面标记估算真实地面距离（米）与偏转角度（度）。\
                robot 为机器人双脚着地点中心，headingPoint 为从 robot 沿胸口、脚尖实际正前方延伸一小段在地面上的点，\
                target 为指定人物双脚或物体的接地点中心，approach 为靠机器人一侧适合停稳招呼的地面点，与 target 保持约{}米的招呼距离。\
                已到招呼距离时 approach 可以在机器人脚下。不要用头、肩或物体中心替代地面位置，不要凭一帧猜测目标速度。\
                {step_hint}同时给出以机器人实际朝向为基准的估算字段：\
                distanceM 为 robot 到 target 的估算地面距离（米，非负）；\
                approachDistanceM 为 robot 到 approach 的估算地面距离（米，已到位时为0或接近0）；\
                turnDeg 为从机器人当前胸口正前方转向面对停靠点（已到位或过近时面对目标）所需角度，范围 -180 到 180（负数为向左转，正数为向右转，正对为0）；\
                atGreeting 为布尔值，表示机器人当前是否已停在目标旁约{}米的合适招呼位置。\
                pathClear 仅当 robot 到 approach 整段地面清晰可见、宽度足够时为 true。\
                {rear_hint}rearClear 仅当机器人正后方至少一个实测步幅的地面清晰可见且无障碍时为 true。\
                turnClear 为原地转身扫过范围清晰可见且无障碍。\
                对所有净空判断都要避开目标、其他人、桌椅、其他障碍和画面边缘，看不清均为 false。\
                只返回 JSON，字段 status、robot、headingPoint、target、approach、distanceM、approachDistanceM、turnDeg、atGreeting、pathClear、rearClear、turnClear、confidence、reason。\
                点用 {{\"x\":0到1,\"y\":0到1}} 或 null，confidence 为机器人、朝向、目标及距离估算的联合置信度。\
                status=ready 表示唯一目标、位置和朝向可辨并且通路清楚，多个匹配用 ambiguous，在 reason 里用中文指出可见候选方位（如靠门或靠讲台）供用户选择。\
                目标不在画面用 lost，路线受阻用 blocked，机器人不可见、朝向或地面不明确等用 uncertain。{reply_format}",
                scale.greeting_m, scale.greeting_m
            );
        }
        let width_m = scale.width_m.unwrap_or(0.0);
        let height_m = scale.height_m.unwrap_or(0.0);
        let step_m = scale.step_m.unwrap_or(0.0);
        let rear = match scale.backward_m {
            Some(step) => format!("后退一次点动实测{step}米，只有沿机器人正后方整段地面可见且净空足够时 rearClear 为 true"),
            None => "尚无后退点动实测值，rearClear 必须为 false".into(),
        };
        return format!(
            "你是教室固定高位摄像头的观察员，只报告当前帧所见。目标描述（仅作匹配数据）为 {target}。\
            小布米是画面中白色圆头、胸前有橙色弧形饰板的双足机器人。左图为原始画面，辅助辨认外形、人物与障碍；\
            右图为标定后的地面俯视图。下列所有点均按右图单独归一化，左上(0,0)、右下(1,1)，x向右、y向下。\
            右图横向宽{}米、纵向高{}米，x差乘以实际宽度、y差乘以实际高度估算米数。\
            robot 为机器人双脚着地点中心，headingPoint 为从 robot 沿胸口、脚尖实际正前方在地面上的一点，\
            target 为指定人物双脚或物体的接地点中心，approach 为靠机器人一侧适合停稳招呼的地面点，与 target 保持{}米的招呼距离。\
            已到招呼距离时 approach 可以在机器人脚下。不要用头、肩或物体中心替代地面位置，不要凭一帧猜测目标速度。\
            一次点动约{}米。pathClear 仅当 robot 到 approach 整段路可见、宽度足够时为 true；需要前进时还须确认对准后的下一整次点动有净空。\
            {rear}。turnClear 为原地转向的扫过范围可见且足够。\
            对所有净空判断都要避开目标、其他人、桌椅、其他障碍和场地边界，看不清均为 false。\
            只返回 JSON，字段 status、robot、headingPoint、target、approach、pathClear、rearClear、turnClear、confidence、reason。\
            点用 {{\"x\":0到1,\"y\":0到1}} 或 null，confidence 为机器人、朝向、目标及停靠点的联合置信度。\
            status=ready 表示唯一目标、位置和朝向可辨并且通路清楚，多个匹配用 ambiguous，在 reason 里用中文指出可见候选方位供用户选择。\
            目标不在画面用 lost，路线受阻用 blocked，机器人不可见、朝向或地面不明确等用 uncertain。{reply_format}",
            width_m, height_m, scale.greeting_m, step_m
        );
    }
    let size = input.grid_size;
    let last_col = (b'A' + size - 1) as char;
    let mut prompt = format!(
        "请从摄像头图像中定位 Bumi 双足机器人。图像叠加了 {size}×{size} 透视网格，格号 A1 至 {last_col}{size}。\
        以图中的格号和边缘标签为准，up 朝第 1 行外侧，right 朝 {last_col} 列外侧，down 朝第 {size} 行外侧，left 朝 A 列外侧。\
        机器人双脚落地所在格为 cell，胸口和脚尖面朝方向为 facing（up/right/down/left）。\
        只返回 JSON，包含 detected、cell、facing、confidence（0 至 1）及简短 reason。\
        机器人不可辨认或在网格外时返回 detected:false，朝向不可辨认时将 facing 设为 null。"
    );
    if let Some(name) = input.target_name.as_deref() {
        let name = serde_json::json!(name.trim());
        prompt.push_str(&format!(
            "另外独立寻找名称为 {name} 的真实物体，依据画面中的物体本身定位，忽略图上地点名称。\
            只有唯一目标清晰可见、能够确认其落地位置且有相邻可站立空地，才附上 target 对象。\
            target.cell 是目标实体占据的落地格，target.approachCell 是与它共边且清晰可见、无障碍且足够机器人站立的一格，\
            两者均用图中格号。target.confidence 是对物体及可站立格的联合置信度（0 至 1）。\
            多个匹配、遮挡、落点或空地无法确认时将 target 设为 null。即使机器人不在画面也应独立判断目标。"
        ));
    } else if let (Some(name), Some(cell)) = (&input.goal_name, input.goal_cell) {
        prompt.push_str(&format!(
            "用户标记的目的地 {} 在 {} 格。",
            serde_json::json!(name),
            cell_label(cell, size)
        ));
    }
    prompt
}

fn parse_cell(value: &serde_json::Value, size: u8) -> Option<u8> {
    if let Some(num) = value.as_u64() {
        return (num < u64::from(size * size)).then_some(num as u8);
    }
    let text = value.as_str()?.trim().as_bytes();
    let (&col, digits) = text.split_first()?;
    let col = col.to_ascii_uppercase().checked_sub(b'A')?;
    if col >= size
        || digits.is_empty()
        || digits.len() > 2
        || digits[0] == b'0'
        || !digits.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let row = std::str::from_utf8(digits).ok()?.parse::<u8>().ok()?;
    (1..=size).contains(&row).then(|| (row - 1) * size + col)
}

fn parse_target(data: &serde_json::Value, size: u8) -> Option<VisualTarget> {
    let cell = parse_cell(data.get("cell")?, size)?;
    let approach_cell = parse_cell(data.get("approachCell")?, size)?;
    let distance =
        (cell / size).abs_diff(approach_cell / size) + (cell % size).abs_diff(approach_cell % size);
    let confidence = confidence(data);
    if distance != 1 || confidence == 0.0 {
        return None;
    }
    Some(VisualTarget {
        cell,
        approach_cell,
        confidence,
    })
}

fn confidence(data: &serde_json::Value) -> f32 {
    data.get("confidence")
        .and_then(serde_json::Value::as_f64)
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(0.0) as f32
}

fn parse_facing(value: &serde_json::Value) -> Option<u8> {
    if let Some(num) = value.as_u64() {
        return (num <= 3).then_some(num as u8);
    }
    let raw = value.as_str()?.trim();
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "0" | "up" | "north" | "top" | "forward" => Some(0),
        "1" | "right" | "east" => Some(1),
        "2" | "down" | "south" | "bottom" => Some(2),
        "3" | "left" | "west" => Some(3),
        _ => {
            if raw.contains('上') || raw.contains('↑') {
                Some(0)
            } else if raw.contains('右') || raw.contains('→') {
                Some(1)
            } else if raw.contains('下') || raw.contains('↓') {
                Some(2)
            } else if raw.contains('左') || raw.contains('←') {
                Some(3)
            } else {
                None
            }
        }
    }
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    (end >= start).then(|| &trimmed[start..=end])
}

fn parse_vision_reply(raw: &str, size: u8, find_target: bool) -> Result<VisionPose, String> {
    let slice = extract_json_object(raw).ok_or("视觉模型未返回可解析的 JSON 位姿结果。")?;
    let parsed: serde_json::Value =
        serde_json::from_str(slice).map_err(|_| "视觉模型返回的 JSON 格式无效。".to_string())?;
    let cell = parsed.get("cell").and_then(|value| parse_cell(value, size));
    let target = if find_target {
        parsed
            .get("target")
            .and_then(|value| parse_target(value, size))
    } else {
        None
    };
    let detected = parsed
        .get("detected")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let facing = parsed.get("facing").and_then(parse_facing);
    let confidence = confidence(&parsed);
    let reason = parsed
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(|s| s.trim().chars().take(MAX_REASON_CHARS).collect::<String>())
        .filter(|s| !s.is_empty());

    if !detected || cell.is_none() {
        return Ok(VisionPose {
            detected: false,
            cell: None,
            facing: None,
            confidence: 0.0,
            reason: reason.or_else(|| Some("视觉模型未在场地网格内检测到机器人。".into())),
            target,
            scene: None,
            inspection: None,
            walk_path: None,
            timing_ms: None,
        });
    }

    Ok(VisionPose {
        detected: true,
        cell,
        facing,
        confidence,
        reason,
        target,
        scene: None,
        inspection: None,
        walk_path: None,
        timing_ms: None,
    })
}

impl SceneObservation {
    fn validation_issue(
        &self,
        auto_mode: bool,
        min_confidence: f64,
    ) -> Option<(SceneStatus, String)> {
        let mut missing = Vec::new();
        for (label, point) in [
            ("机器人双脚的接地点", &self.robot),
            ("机身朝向的地面点", &self.heading_point),
            ("目标与地面的接触点", &self.target),
            ("目标旁的停靠点", &self.approach),
        ] {
            if !point.as_ref().is_some_and(FloorPoint::on_floor) {
                missing.push(label);
            }
        }
        if !missing.is_empty() {
            return Some((
                SceneStatus::Uncertain,
                format!("未取得有效地面坐标（{}）。", missing.join("、")),
            ));
        }
        if self
            .robot
            .as_ref()
            .zip(self.heading_point.as_ref())
            .is_some_and(|(feet, front)| (feet.x - front.x).hypot(feet.y - front.y) < 0.005)
        {
            return Some((
                SceneStatus::Uncertain,
                "识别出的朝向点太靠近双脚，无法判断机身正前方。请确认能看清胸前橙色饰板或脚尖。"
                    .into(),
            ));
        }
        if !(min_confidence..=1.0).contains(&self.confidence) {
            let reason = if self.confidence > 0.0 && self.confidence < min_confidence {
                format!(
                    "机器人、朝向及目标的联合置信度为 {}，行走要求至少 {min_confidence}。",
                    self.confidence
                )
            } else {
                "识别结果未提供足够可信的联合置信度。".into()
            };
            return Some((SceneStatus::Uncertain, reason));
        }
        if auto_mode {
            for (label, value) in [
                ("机器人到目标的地面距离", self.distance_m),
                ("机器人到停靠点的地面距离", self.approach_distance_m),
                ("机身朝停靠方向所需的转角", self.turn_deg),
            ] {
                if value.is_none() {
                    return Some((SceneStatus::Uncertain, format!("未取得有效的{label}估计。")));
                }
            }
        }
        if !self.path_clear {
            return Some((
                SceneStatus::Blocked,
                "通往目标的地面通路未确认畅通。".into(),
            ));
        }
        None
    }
}

fn parse_scene_reply(
    raw: &str,
    rear_calibrated: bool,
    auto_mode: bool,
    min_confidence: f64,
) -> Result<VisionPose, String> {
    let object = extract_json_object(raw).ok_or("视觉模型未返回场景观察结果。")?;
    let mut scene: SceneObservation =
        serde_json::from_str(object).map_err(|_| "视觉模型返回的场景观察格式无效。")?;
    scene.rear_clear &= rear_calibrated;
    scene.distance_m = scene
        .distance_m
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
    scene.approach_distance_m = scene
        .approach_distance_m
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
    scene.turn_deg = scene
        .turn_deg
        .filter(|value| value.is_finite() && (-180.0..=180.0).contains(value));
    scene.reason = scene
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(|reason| {
            reason
                .chars()
                .filter(|ch| !ch.is_control())
                .take(MAX_REASON_CHARS)
                .collect()
        });
    if scene.status == SceneStatus::Ready {
        if let Some((status, diagnostic)) = scene.validation_issue(auto_mode, min_confidence) {
            scene.status = status;
            let message = match scene.reason.take() {
                Some(note) => format!("{diagnostic} 识别备注：{note}"),
                None => diagnostic,
            };
            scene.reason = Some(message.chars().take(MAX_REASON_CHARS).collect());
        }
    }
    if scene.status != SceneStatus::Ready {
        scene.robot = None;
        scene.heading_point = None;
        scene.target = None;
        scene.approach = None;
        scene.path_clear = false;
        scene.rear_clear = false;
        scene.turn_clear = false;
        scene.confidence = 0.0;
        scene.distance_m = None;
        scene.approach_distance_m = None;
        scene.turn_deg = None;
        scene.at_greeting = None;
    }
    Ok(VisionPose {
        detected: false,
        cell: None,
        facing: None,
        confidence: 0.0,
        reason: None,
        target: None,
        scene: Some(scene),
        inspection: None,
        walk_path: None,
        timing_ms: None,
    })
}

fn read_markers_json(raw: &str) -> Result<serde_json::Value, String> {
    let object = extract_json_object(raw).ok_or("视觉模型未返回标记结果。")?;
    serde_json::from_str(object).map_err(|_| "视觉模型返回的标记格式无效。".into())
}

fn inspection_markers(result: &serde_json::Value) -> Inspection {
    let marker = |key: &str| -> Option<FloorPoint> {
        let candidate = result.get(key)?;
        if !(0.75..=1.0).contains(&candidate.get("confidence")?.as_f64()?) {
            return None;
        }
        let point = FloorPoint {
            x: candidate.get("x")?.as_f64()?,
            y: candidate.get("y")?.as_f64()?,
        };
        point.on_floor().then_some(point)
    };
    let robot = (result["robotCount"].as_u64() == Some(1))
        .then(|| marker("robot"))
        .flatten();
    let target_count = result["targetCount"].as_u64();
    let target = (target_count == Some(1))
        .then(|| marker("target"))
        .flatten();
    let heading_point = marker("headingPoint").filter(|front| {
        robot
            .as_ref()
            .is_some_and(|feet| (front.x - feet.x).hypot(front.y - feet.y) >= 0.005)
    });
    let reason = result["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(MAX_REASON_CHARS)
                .collect()
        })
        .or_else(|| {
            target_count
                .filter(|count| *count > 1)
                .map(|_| "画面中有多个匹配目标，请补充颜色或位置。".into())
        });
    Inspection {
        robot,
        heading_point,
        target,
        reason,
    }
}

fn parse_inspection_reply(raw: &str) -> Result<VisionPose, String> {
    Ok(VisionPose {
        inspection: Some(inspection_markers(&read_markers_json(raw)?)),
        ..VisionPose::default()
    })
}

fn parse_walk_path_reply(raw: &str) -> Result<VisionPose, String> {
    let result = read_markers_json(raw)?;
    let marks = inspection_markers(&result);
    let (Some(robot), Some(heading_point)) = (marks.robot, marks.heading_point) else {
        return Err(marks
            .reason
            .unwrap_or_else(|| "画面未能确认唯一的小布米、双脚位置和朝向。".into()));
    };
    let clear = result["clear"].as_bool() == Some(true)
        && result["clearConfidence"]
            .as_f64()
            .is_some_and(|c| (0.75..=1.0).contains(&c));
    Ok(VisionPose {
        walk_path: Some(WalkPath {
            robot,
            heading_point,
            clear,
            reason: marks.reason,
        }),
        ..VisionPose::default()
    })
}

async fn request_pose(input: LocateInput, token: &str, url: &str) -> Result<VisionPose, String> {
    let prompt = build_prompt(&input);
    let body = serde_json::json!({
        "model": "keepwork-pro", "stream": true, "reasoning": false,
        "max_tokens": if input.scene_target.is_some() { 512 } else { 256 },
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": { "url": input.image_data_url } }
        ] }]
    });
    let (text, timing) =
        request_model(token, url, &body, input.request_timeout(), "视觉定位").await?;
    let mut pose = if input.walk_path.is_some() {
        parse_walk_path_reply(&text)
    } else if input.inspection.is_some() {
        parse_inspection_reply(&text)
    } else if let Some(scale) = &input.scene_scale {
        parse_scene_reply(
            &text,
            scale.backward_m.is_some(),
            scale.auto,
            scale.min_confidence,
        )
    } else {
        parse_vision_reply(&text, input.grid_size, input.target_name.is_some())
    }?;
    pose.timing_ms = Some(timing);
    Ok(pose)
}

pub(super) async fn locate(
    app: &AppHandle,
    input: LocateInput,
    mut lifetime: watch::Receiver<()>,
) -> Result<VisionPose, String> {
    input.validate()?;
    tokio::select! {
        biased;
        _ = lifetime.changed() => Err("Bumi 控制窗口已关闭。".into()),
        pose = async {
            let token = current_login(app).await?;
            request_pose(input, &token, CHAT_URL).await
        } => pose,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::oneshot;

    #[test]
    fn inspection_reports_unique_objects_independently_of_walkability() {
        let point = serde_json::json!({"x": 0.45, "y": 0.8, "confidence": 0.88});
        let mut reply = serde_json::json!({
            "robotCount": 1, "targetCount": 1, "robot": point, "target": point,
            "headingPoint": {"x": 0.5,"y": 0.6,"confidence": 0.95},
            "reason": "桌子挡住了路"
        });
        let parse = |json: &serde_json::Value| {
            let pose = parse_inspection_reply(&json.to_string()).unwrap();
            assert!(pose.scene.is_none() && !pose.detected);
            pose.inspection.unwrap()
        };
        let both = parse(&reply);
        assert!(both.robot.is_some() && both.heading_point.is_some() && both.target.is_some());
        reply["targetCount"] = 2.into();
        reply["reason"] = serde_json::Value::Null;
        let ambiguous = parse(&reply);
        assert!(ambiguous.target.is_none());
        assert!(ambiguous.reason.unwrap().contains("多个匹配目标"));
        reply["targetCount"] = 1.into();
        reply["robot"]["confidence"] = 0.7.into();
        let partial = parse(&reply);
        assert!(
            partial.robot.is_none() && partial.heading_point.is_none() && partial.target.is_some()
        );
        reply["target"]["x"] = 1.1.into();
        assert!(parse(&reply).target.is_none());
    }

    #[test]
    fn walk_path_screens_the_requested_direction_and_only_accepts_explicit_confident_clearance() {
        let mut query: LocateInput = serde_json::from_value(serde_json::json!({
            "imageDataUrl":FRAME, "walkPath":{"direction":"backward","calibratedFloor":false,"stepM":0.15}
        })).unwrap();
        assert!(query.validate().is_ok());
        let prompt = build_prompt(&query);
        assert!(
            prompt.contains("正后方")
                && prompt.contains("0.15米")
                && prompt.contains("整张相机画面")
        );
        query.walk_path.as_mut().unwrap().direction = WalkDirection::Forward;
        query.walk_path.as_mut().unwrap().calibrated_floor = true;
        assert!(
            build_prompt(&query).contains("正前方")
                && build_prompt(&query).contains("右侧地面俯视图")
        );
        query.target_name = Some("讲台".into());
        assert!(query.validate().is_err());
        query.target_name = None;
        query.walk_path.as_mut().unwrap().step_m = 0.0;
        assert!(query.validate().is_err());

        let mut result = serde_json::json!({"robotCount":1,"robot":{"x":0.4,"y":0.5,"confidence":0.9},
            "headingPoint":{"x":0.5,"y":0.5,"confidence":0.92},"clear":true,"clearConfidence":0.91});
        let parse = |data: &serde_json::Value| {
            parse_walk_path_reply(&data.to_string()).map(|p| p.walk_path.unwrap())
        };
        assert!(parse(&result).unwrap().clear);
        for clear in [serde_json::Value::Null, false.into(), "true".into()] {
            result["clear"] = clear;
            assert!(!parse(&result).unwrap().clear);
        }
        result["clear"] = true.into();
        result["clearConfidence"] = 0.55.into();
        assert!(!parse(&result).unwrap().clear);
        result["robotCount"] = 2.into();
        assert!(parse(&result).is_err());
        result["robotCount"] = 1.into();
        result["headingPoint"] = serde_json::Value::Null;
        assert!(parse(&result).is_err());
    }

    #[test]
    fn inspection_query_checks_target_and_coordinate_space_and_excludes_navigation() {
        for calibrated in [false, true] {
            let mut query: LocateInput = serde_json::from_value(serde_json::json!({
                "imageDataUrl":FRAME, "inspection":{"target":"穿粉色上衣的人","calibratedFloor":calibrated}
            })).unwrap();
            assert!(query.validate().is_ok());
            let prompt = build_prompt(&query);
            assert!(
                prompt.contains("穿粉色上衣的人")
                    && prompt.contains(if calibrated {
                        "右侧地面俯视图"
                    } else {
                        "整张相机画面"
                    })
            );
            query.target_name = Some("讲台".into());
            assert!(query.validate().is_err());
            query.target_name = None;
            query.inspection.as_mut().unwrap().target.clear();
            assert!(query.validate().is_err());
        }
    }

    #[test]
    fn parses_plain_fenced_and_chinese_vlm_replies() {
        let fenced = "```json\n{\"detected\":true,\"cell\":\"C2\",\"facing\":\"right\",\"confidence\":0.92,\"reason\":\"双脚位于C2\"}\n```";
        assert_eq!(
            parse_vision_reply(fenced, 5, false).unwrap(),
            VisionPose {
                detected: true,
                cell: Some(7),
                facing: Some(1),
                confidence: 0.92,
                reason: Some("双脚位于C2".into()),
                target: None,
                scene: None,
                inspection: None,
                walk_path: None,
                timing_ms: None,
            }
        );

        let chinese =
            "识别结果：{\"detected\":true,\"cell\":\"a5\",\"facing\":\"上 ↑\",\"confidence\":1.4}";
        let parsed = parse_vision_reply(chinese, 5, false).unwrap();
        assert_eq!(parsed.cell, Some(20));
        assert_eq!(parsed.facing, Some(0));
        assert_eq!(parsed.confidence, 0.0);
        let unstated =
            parse_vision_reply(r#"{"cell":"C3","facing":"left","confidence":1}"#, 5, false)
                .unwrap();
        assert!(!unstated.detected && unstated.cell.is_none());

        let missing = r#"{"detected":false,"reason":"画面中未见机器人"}"#;
        let none = parse_vision_reply(missing, 5, false).unwrap();
        assert!(!none.detected);
        assert_eq!(none.cell, None);
    }

    const FRAME: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const POSE: &str = r#"{"detected":true,"cell":"B3","facing":"down","confidence":0.88}"#;

    #[test]
    fn target_query_uses_the_selected_grid_and_only_physical_objects() {
        let legacy: LocateInput = serde_json::from_value(serde_json::json!({
            "imageDataUrl": FRAME, "goalName": "手工地点", "goalCell": 24
        }))
        .unwrap();
        assert_eq!(legacy.grid_size, 5);
        assert!(legacy.validate().is_ok());
        assert!(build_prompt(&legacy).contains("E5"));
        let mut input = LocateInput {
            target_name: Some("椅子".into()),
            grid_size: 10,
            ..legacy
        };
        assert!(input.validate().is_ok());
        let prompt = build_prompt(&input);
        assert!(
            prompt.contains("J10") && prompt.contains("椅子") && prompt.contains("approachCell")
        );
        assert!(!prompt.contains("手工地点"));
        for invalid in [0, 1, 6, 255] {
            input.grid_size = invalid;
            assert!(input.validate().is_err());
        }
        input.grid_size = 10;
        input.goal_cell = Some(100);
        assert!(input.validate().is_err());
        input.goal_cell = None;
        input.target_name = Some(" ".into());
        assert!(input.validate().is_err());
    }

    #[test]
    fn scene_queries_require_a_single_bounded_target_and_use_floor_coordinates() {
        let base = serde_json::json!({"imageDataUrl":FRAME,"sceneTarget":"靠门的穿粉色上衣的人",
            "sceneScale":{"widthM":8.0,"heightM":6.0,"greetingM":0.8,"stepM":0.18}});
        let input: LocateInput = serde_json::from_value(base.clone()).unwrap();
        input.validate().unwrap();
        let prompt = build_prompt(&input);
        for token in [
            "右图单独归一化",
            "白色圆头",
            "胸前有橙色",
            "靠门的穿粉色",
            "rearClear",
            "turnClear",
            "横向宽8米、纵向高6米",
            "0.8米的招呼距离",
            "一次点动约0.18米",
        ] {
            assert!(prompt.contains(token));
        }
        for (key, value) in [
            ("goalCell", serde_json::json!(1)),
            ("targetName", serde_json::json!("讲台")),
            ("goalName", serde_json::json!("旧地点")),
            ("sceneTarget", serde_json::json!(" ")),
            ("sceneTarget", serde_json::json!("a".repeat(81))),
            ("sceneScale", serde_json::Value::Null),
            (
                "sceneScale",
                serde_json::json!({"widthM":0,"heightM":8,"greetingM":0.6,"stepM":0.2}),
            ),
        ] {
            let mut invalid = base.clone();
            invalid[key] = value;
            assert!(serde_json::from_value::<LocateInput>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
    }

    #[test]
    fn scene_confidence_threshold_defaults_to_legacy_and_rejects_invalid_requests() {
        let base = serde_json::json!({"imageDataUrl":FRAME,"sceneTarget":"垃圾桶",
            "sceneScale":{"auto":true,"greetingM":0.8}});
        let legacy: LocateInput = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(legacy.scene_scale.unwrap().min_confidence, 0.75);
        for (threshold, valid) in [
            (0.0, false),
            (0.009, false),
            (0.01, true),
            (0.63, true),
            (1.0, true),
            (1.01, false),
        ] {
            let mut query = base.clone();
            query["sceneScale"]["minConfidence"] = threshold.into();
            let input: LocateInput = serde_json::from_value(query).unwrap();
            assert_eq!(input.validate().is_ok(), valid);
            assert_eq!(input.scene_scale.unwrap().min_confidence, threshold);
        }
        for invalid in [serde_json::Value::Null, serde_json::json!("0.63")] {
            let mut query = base.clone();
            query["sceneScale"]["minConfidence"] = invalid;
            assert!(serde_json::from_value::<LocateInput>(query).is_err());
        }
    }

    #[test]
    fn scene_observations_only_expose_motion_geometry_for_a_clear_unambiguous_scene() {
        let ready = serde_json::json!({
            "status":"ready", "robot":{"x":0.1,"y":0.2}, "headingPoint":{"x":0.15,"y":0.2},
            "target":{"x":0.8,"y":0.3}, "approach":{"x":0.7,"y":0.35}, "pathClear":true,
            "confidence":0.9
        });
        let parse = |json: &serde_json::Value| {
            parse_scene_reply(&json.to_string(), true, false, default_scene_confidence())
                .unwrap()
                .scene
                .unwrap()
        };
        let result = parse(&ready);
        assert_eq!(result.status, SceneStatus::Ready);
        assert!(!result.turn_clear && !result.rear_clear);
        assert_eq!(result.target.unwrap().x, 0.8);
        assert_eq!(result.approach.unwrap().x, 0.7);
        for (field, value, expected) in [
            (
                "status",
                serde_json::json!("ambiguous"),
                SceneStatus::Ambiguous,
            ),
            ("status", serde_json::json!("lost"), SceneStatus::Lost),
            (
                "robot",
                serde_json::json!({"x":1.02,"y":0.1}),
                SceneStatus::Uncertain,
            ),
            (
                "headingPoint",
                ready["robot"].clone(),
                SceneStatus::Uncertain,
            ),
            ("target", serde_json::Value::Null, SceneStatus::Uncertain),
            ("approach", serde_json::Value::Null, SceneStatus::Uncertain),
            ("confidence", serde_json::json!(0.4), SceneStatus::Uncertain),
            ("pathClear", serde_json::json!(false), SceneStatus::Blocked),
        ] {
            let mut frame = ready.clone();
            frame[field] = value;
            frame["turnClear"] = true.into();
            frame["rearClear"] = true.into();
            frame["reason"] = "椅背遮住了部分地面".into();
            let observed = parse(&frame);
            assert_eq!(observed.status, expected);
            let reason = observed.reason.unwrap();
            assert!(reason.contains("椅背遮住了部分地面"));
            let issue = match field {
                "robot" => "机器人双脚的接地点",
                "headingPoint" => "朝向点太靠近双脚",
                "target" => "目标与地面的接触点",
                "approach" => "目标旁的停靠点",
                "confidence" => "联合置信度为 0.4",
                "pathClear" => "通路未确认畅通",
                _ => "椅背遮住了部分地面",
            };
            assert!(reason.contains(issue), "{reason}");
            assert!(observed.robot.is_none() && observed.target.is_none());
            assert!(!observed.path_clear && !observed.turn_clear && !observed.rear_clear);
        }
        let mut lower_score = ready.clone();
        lower_score["confidence"] = 0.63.into();
        let at_threshold = |scene: &serde_json::Value, threshold: f64| {
            parse_scene_reply(&scene.to_string(), true, false, threshold)
                .unwrap()
                .scene
                .unwrap()
        };
        let stricter = at_threshold(&lower_score, 0.64);
        assert_eq!(stricter.status, SceneStatus::Uncertain);
        assert!(stricter.reason.unwrap().contains("至少 0.64"));
        assert_eq!(at_threshold(&lower_score, 0.63).status, SceneStatus::Ready);
        lower_score["pathClear"] = false.into();
        assert_eq!(
            at_threshold(&lower_score, 0.63).status,
            SceneStatus::Blocked
        );
        lower_score["pathClear"] = true.into();
        lower_score["status"] = "uncertain".into();
        assert_eq!(
            at_threshold(&lower_score, 0.01).status,
            SceneStatus::Uncertain
        );
        lower_score["status"] = "ready".into();
        lower_score.as_object_mut().unwrap().remove("confidence");
        assert_eq!(
            at_threshold(&lower_score, 0.01).status,
            SceneStatus::Uncertain
        );

        let mut clear_rear = ready.clone();
        clear_rear["rearClear"] = true.into();
        assert!(
            !parse_scene_reply(
                &clear_rear.to_string(),
                false,
                false,
                default_scene_confidence()
            )
            .unwrap()
            .scene
            .unwrap()
            .rear_clear
        );
        let partial = parse(
            &serde_json::json!({"status":"uncertain", "reason":"小布米背对镜头，脚尖被桌子挡住"}),
        );
        assert_eq!(partial.status, SceneStatus::Uncertain);
        assert_eq!(
            partial.reason.as_deref(),
            Some("小布米背对镜头，脚尖被桌子挡住")
        );
        assert!(!partial.path_clear && partial.heading_point.is_none());
        assert!(parse_scene_reply(POSE, false, false, default_scene_confidence()).is_err());
    }

    #[test]
    fn auto_scene_mode_works_without_floor_dimensions_and_requires_relative_estimates() {
        let auto_req = serde_json::json!({
            "imageDataUrl": FRAME,
            "sceneTarget": "穿粉色上衣的人",
            "sceneScale": { "auto": true, "greetingM": 0.8 }
        });
        let input: LocateInput = serde_json::from_value(auto_req.clone()).unwrap();
        input.validate().unwrap();
        let prompt = build_prompt(&input);
        for token in [
            "原始教室画面",
            "白色圆头",
            "橙色弧形饰板",
            "distanceM",
            "approachDistanceM",
            "turnDeg",
            "atGreeting",
            "0.8米",
        ] {
            assert!(prompt.contains(token), "missing token {token}");
        }
        let mut bad = auto_req.clone();
        bad["sceneScale"]["greetingM"] = serde_json::json!(0);
        assert!(serde_json::from_value::<LocateInput>(bad)
            .unwrap()
            .validate()
            .is_err());

        let ready = serde_json::json!({
            "status": "ready",
            "robot": { "x": 0.25, "y": 0.7 },
            "headingPoint": { "x": 0.30, "y": 0.65 },
            "target": { "x": 0.65, "y": 0.4 },
            "approach": { "x": 0.55, "y": 0.48 },
            "distanceM": 1.8,
            "approachDistanceM": 1.0,
            "turnDeg": 24.0,
            "atGreeting": false,
            "pathClear": true,
            "rearClear": true,
            "turnClear": true,
            "confidence": 0.9
        });
        let ok = parse_scene_reply(&ready.to_string(), true, true, default_scene_confidence())
            .unwrap()
            .scene
            .unwrap();
        assert_eq!(ok.status, SceneStatus::Ready);
        assert_eq!(ok.distance_m, Some(1.8));
        assert_eq!(ok.approach_distance_m, Some(1.0));
        assert_eq!(ok.turn_deg, Some(24.0));
        assert_eq!(ok.at_greeting, Some(false));
        assert!(ok.rear_clear);

        let mut missing_turn = ready.clone();
        missing_turn["turnDeg"] = serde_json::Value::Null;
        let downgraded = parse_scene_reply(
            &missing_turn.to_string(),
            true,
            true,
            default_scene_confidence(),
        )
        .unwrap()
        .scene
        .unwrap();
        assert_eq!(downgraded.status, SceneStatus::Uncertain);
        assert!(downgraded.distance_m.is_none());
        assert!(downgraded.turn_deg.is_none());
        assert!(downgraded.reason.unwrap().contains("转角"));
    }

    #[test]
    fn parses_independent_target_and_approach_on_the_fine_grid() {
        let mut payload = serde_json::json!({
            "detected": false,
            "target": {"cell": "j10", "approachCell": "J9", "confidence": 0.91}
        });
        let pose = parse_vision_reply(&payload.to_string(), 10, true).unwrap();
        assert!(!pose.detected && pose.cell.is_none());
        assert_eq!(
            pose.target,
            Some(VisualTarget {
                cell: 99,
                approach_cell: 89,
                confidence: 0.91
            })
        );
        assert!(parse_vision_reply(&payload.to_string(), 5, true)
            .unwrap()
            .target
            .is_none());
        assert!(parse_vision_reply(&payload.to_string(), 10, false)
            .unwrap()
            .target
            .is_none());
        payload["detected"] = true.into();
        payload["cell"] = "A10".into();
        let pose = parse_vision_reply(&payload.to_string(), 10, true).unwrap();
        assert_eq!(pose.cell, Some(90));
        assert_eq!(pose.confidence, 0.0);
        for (cell, approach) in [
            ("J1", "A2"),
            ("J10", "J10"),
            ("J10", "I9"),
            ("J10", "A0"),
            ("K1", "J1"),
            ("A11", "A10"),
            ("A01", "A2"),
            ("Ä1", "A1"),
        ] {
            payload["target"] =
                serde_json::json!({"cell":cell, "approachCell":approach, "confidence":0.9});
            let pose = parse_vision_reply(&payload.to_string(), 10, true).unwrap();
            assert!(pose.target.is_none(), "{cell}/{approach}");
        }
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!(-0.1),
            serde_json::json!(1.3),
        ] {
            payload["target"] =
                serde_json::json!({"cell":99, "approachCell":98, "confidence":invalid});
            assert!(parse_vision_reply(&payload.to_string(), 10, true)
                .unwrap()
                .target
                .is_none());
        }
        payload["target"] = serde_json::Value::Null;
        assert!(parse_vision_reply(&payload.to_string(), 10, true)
            .unwrap()
            .target
            .is_none());
    }

    #[test]
    fn ipc_accepts_camera_input_but_rejects_legacy_destinations_and_credentials() {
        let request = serde_json::json!({"operation": "locateVision", "imageDataUrl": FRAME});
        assert!(serde_json::from_value::<super::super::Request>(request.clone()).is_ok());
        for field in ["endpoint", "model", "apiKey"] {
            let mut old = request.clone();
            old[field] = "legacy-setting".into();
            assert!(serde_json::from_value::<super::super::Request>(old).is_err());
        }
    }

    async fn gateway_response(
        status: &str,
        response: &str,
        extra: &str,
    ) -> (Result<VisionPose, String>, String) {
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{response}", response.len());
        raw_gateway_response(reply, false).await
    }

    async fn raw_gateway_response(
        reply: String,
        keep_body_open: bool,
    ) -> (Result<VisionPose, String>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (finished, client_done) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let request = read_gateway_request(&mut reader).await;
            reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
            if keep_body_open {
                let _ = client_done.await;
            }
            request
        });
        let result = request_pose(
            gateway_input(),
            "fixture-user-token",
            &format!("http://{addr}/core/v0/gpt/chat"),
        )
        .await;
        let _ = finished.send(());
        (result, server.await.unwrap())
    }

    async fn read_gateway_request(reader: &mut BufReader<TcpStream>) -> String {
        let mut headers = String::new();
        while !headers.ends_with("\r\n\r\n") {
            assert!(reader.read_line(&mut headers).await.unwrap() > 0);
        }
        let len: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        let mut payload = vec![0; len];
        reader.read_exact(&mut payload).await.unwrap();
        headers + &String::from_utf8(payload).unwrap()
    }

    fn gateway_input() -> LocateInput {
        LocateInput {
            image_data_url: FRAME.into(),
            goal_name: Some("讲台".into()),
            goal_cell: Some(2),
            target_name: Some("椅子".into()),
            grid_size: 10,
            scene_target: None,
            scene_scale: None,
            inspection: None,
            walk_path: None,
        }
    }

    #[test]
    fn only_motion_observations_receive_the_longer_transport_deadline() {
        let input = |fields: serde_json::Value| {
            let mut fields = fields;
            fields["imageDataUrl"] = FRAME.into();
            let request: LocateInput = serde_json::from_value(fields).unwrap();
            request.validate().unwrap();
            request
        };
        let inspect =
            input(serde_json::json!({"inspection":{"target":"讲台","calibratedFloor":false}}));
        let approach = input(
            serde_json::json!({"sceneTarget":"讲台","sceneScale":{"auto":true,"greetingM":0.8}}),
        );
        let walk = input(
            serde_json::json!({"walkPath":{"direction":"forward","calibratedFloor":false,"stepM":0.1}}),
        );
        for read_only in [gateway_input(), inspect] {
            assert_eq!(read_only.request_timeout(), Duration::from_secs(15));
        }
        for motion in [approach, walk] {
            assert_eq!(motion.request_timeout(), Duration::from_secs(20));
        }
    }

    #[tokio::test]
    async fn successive_observations_reuse_the_socket_with_the_current_login() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/core/v0/gpt/chat", listener.local_addr().unwrap());
        let server = async {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let event = format!(
                "data: {}\n\n",
                serde_json::json!({"result": POSE, "is_end": true})
            );
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{event}", event.len());
            for token in ["fixture-first", "fixture-second"] {
                let request = read_gateway_request(&mut reader).await;
                let auth = format!("authorization: Bearer {token}");
                assert!(request.lines().any(|line| line.eq_ignore_ascii_case(&auth)));
                reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
            }
        };
        let client = async {
            for token in ["fixture-first", "fixture-second"] {
                assert!(
                    request_pose(gateway_input(), token, &url)
                        .await
                        .unwrap()
                        .detected
                );
            }
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client)
        })
        .await
        .expect("both observations should complete on one connection");
    }

    #[tokio::test]
    async fn returns_a_complete_sse_result_while_the_gateway_keeps_the_body_open() {
        let event = format!(
            "data: {}\r\n\r\n",
            serde_json::json!({"result": POSE, "is_end": true})
        );
        // Withhold the final zero-length HTTP chunk until the client has returned.
        let open = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{event}\r\n", event.len());
        let (pose, _) =
            tokio::time::timeout(Duration::from_secs(3), raw_gateway_response(open, true))
                .await
                .expect("a terminal SSE event must not wait for HTTP EOF");
        assert!(pose.unwrap().detected);
    }

    #[tokio::test]
    async fn sends_marked_frame_with_keepwork_auth_and_reads_keepwork_stream() {
        let model_output = r#"{"detected":true,"cell":"A10","facing":"down","confidence":0.88,"target":{"cell":"J10","approachCell":"I10","confidence":0.91}}"#;
        let first = serde_json::json!({"result": &model_output[..15]});
        let second = serde_json::json!({"result": &model_output[15..], "is_end": true});
        let (result, request) = gateway_response(
            "200 OK",
            &format!("data: {first}\r\n\r\ndata: {second}\r\n\r\n"),
            "",
        )
        .await;
        let result = result.unwrap();
        let serialized = serde_json::to_value(&result).unwrap();
        assert!(serialized["timingMs"]["headers"].is_u64());
        assert!(serialized["timingMs"]["body"].is_u64());
        assert_eq!(result.cell, Some(90));
        assert_eq!(result.facing, Some(2));
        assert_eq!(result.target.unwrap().approach_cell, 98);
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /core/v0/gpt/chat "));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer fixture-user-token"));
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "keepwork-pro");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["content"][1]["image_url"]["url"], FRAME);
        let prompt = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(prompt.contains("J10") && prompt.contains("椅子"));
    }

    #[tokio::test]
    async fn distinguishes_missing_headers_from_an_interrupted_visual_result() {
        let truncated = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 256\r\n\r\ndata: partial-response-secret";
        for (reply, stage) in [
            ("", "向 Keepwork 发送视觉定位请求或等待响应头失败"),
            (truncated, "接收 Keepwork 视觉定位结果失败"),
        ] {
            let (result, _) = raw_gateway_response(reply.to_owned(), false).await;
            let error = result.unwrap_err();
            assert!(error.starts_with(stage), "{error}");
            for private in ["fixture-user-token", FRAME, "partial-response-secret"] {
                assert!(!error.contains(private), "{error}");
            }
        }
    }

    #[tokio::test]
    async fn reports_auth_errors_and_redirects_without_echoing_gateway_data() {
        let (unauthorized, _) =
            gateway_response("401 Unauthorized", "fixture-user-token", "").await;
        assert!(unauthorized.unwrap_err().contains("重新登录"));
        let (forbidden, _) = gateway_response("403 Forbidden", "fixture-user-token", "").await;
        assert!(forbidden.unwrap_err().contains("权限"));
        let (redirect, _) = gateway_response(
            "307 Temporary Redirect",
            "fixture-user-token",
            "Location: http://127.0.0.1:1/untrusted\r\n",
        )
        .await;
        assert_eq!(
            redirect.unwrap_err(),
            "Keepwork 视觉定位请求失败（HTTP 307）。"
        );
    }
}
