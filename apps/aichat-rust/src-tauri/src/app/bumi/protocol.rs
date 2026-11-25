use super::{Command, TeachAction};
use std::time::{Duration, Instant};
use uuid::{uuid, Uuid};

pub(super) const SERVICE: Uuid = uuid!("061e8f00-8a56-11f0-a62c-00155dff3a7e");
pub(super) const NOTIFY: Uuid = uuid!("061e8f01-8a56-11f0-a62c-00155dff3a7e");
pub(super) const WRITE: Uuid = uuid!("061e8f02-8a56-11f0-a62c-00155dff3a7e");

const TEACH_NAME_MAX_BYTES: usize = 48;
const TEACH_LIST_MAX_BYTES: usize = 256 * 1024;
const TEACH_SLICE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reading {
    Battery(u8),
    Status(i8),
}

impl Reading {
    pub(super) fn matches(self, command: &Command) -> bool {
        matches!(
            (self, command),
            (Self::Battery(_), &Command::Battery) | (Self::Status(_), &Command::Status)
        )
    }
}

// Noetix 3.2.2, ProtocolBtUtils.buildPacket plus the Flutter BleCommand builders.
// Movement follows RobotCommandSender.sendJoy -> BleCommand.createMoveCommand:
// ROCKER (0x13) + vx, vyaw, vy as round(axis * 127). The two-byte form in the
// Java TcpConversionToBleUtils is never called; a robot did not walk with it.
// CommandBtUtils uses DANCE_ID (30) + dance_id to play; keystroke 0 only enters dance mode.
// The official UI calls keystrokes 3 and 4 Wave and Handshake, respectively.
pub(super) fn frame(command: Command) -> Result<Vec<u8>, &'static str> {
    let inner: Vec<u8> = match command {
        Command::Battery => vec![0x22],
        Command::Status => vec![0x31],
        Command::Dance => vec![0x1e, 0x01],
        Command::Wave => vec![0x12, 0x03],
        Command::Handshake => vec![0x12, 0x04],
        Command::Cheer => vec![0x12, 0x05],
        Command::StandUp => vec![0x12, 0x08],
        Command::StandToFall => vec![0x12, 0x09],
        Command::Walk => vec![0x12, 0x01],
        Command::Run => vec![0x12, 0x02],
        Command::StartTeach => vec![0x17],
        Command::StopTeach => vec![0x18],
        Command::SaveTeach { name } => {
            let name = name.trim();
            if name.is_empty() {
                return Err("请输入动作名称。");
            }
            if name.chars().any(|c| c.is_control()) {
                return Err("动作名称不能包含控制字符。");
            }
            if name.len() > TEACH_NAME_MAX_BYTES {
                return Err("动作名称最多 48 个 UTF-8 字节，请缩短后重试。");
            }
            // NTXB firmware can treat every byte after 0x19 as part of the name.
            let mut inner = vec![0x19];
            inner.extend_from_slice(name.as_bytes());
            inner
        }
        Command::TeachList => vec![0x1c],
        Command::PlayTeach { id } => vec![0x14, id],
        Command::DeleteTeach { id } => vec![0x1b, id],
        Command::Move { vy: i8::MIN, .. } => return Err("侧向速度必须在 −127 到 127 之间。"),
        Command::Move { vx, vyaw, vy } => vec![0x13, vx as u8, vyaw as u8, vy as u8],
        Command::Speak { text } => {
            let text = text.trim();
            if text.is_empty() {
                return Err("请输入要让机器人说的内容。");
            }
            if text.len() > 120 {
                return Err("说话内容最多 120 个 UTF-8 字节，请缩短后重试。");
            }
            let mut inner = vec![0x16];
            inner.extend_from_slice(text.as_bytes());
            inner
        }
        Command::Volume { percent } if percent <= 100 => vec![0x32, percent],
        Command::Volume { .. } => return Err("音量必须在 0–100 之间。"),
    };
    let length = (inner.len() + 4) as u8;
    let mut bytes = vec![0x55, 0xaa, length];
    bytes.extend_from_slice(&inner);
    bytes.push(length);
    Ok(bytes)
}

fn frame_data(bytes: &[u8]) -> Option<&[u8]> {
    match bytes {
        [0x55, 0xaa, len, inner @ .., trailer]
            if *len as usize == bytes.len() && len == trailer && !inner.is_empty() =>
        {
            Some(inner)
        }
        _ => None,
    }
}

pub(super) fn reading(bytes: &[u8]) -> Option<Reading> {
    match frame_data(bytes)? {
        // Noetix BatteryHandler reads the first byte after BATTERY_RESULT.
        [0x26, percent, ..] if *percent <= 100 => Some(Reading::Battery(*percent)),
        [0x51, status] => Some(Reading::Status(*status as i8)),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Description {
    pub(super) opcode: Option<u8>,
    pub(super) summary: String,
    pub(super) text: Option<String>,
}

pub(super) fn describe_write(bytes: &[u8]) -> Description {
    let opcode = bytes.get(3).copied();
    let summary = match bytes {
        [_, _, _, 0x13, 0, 0, 0, _] => "停止（零速度）".into(),
        [_, _, _, 0x13, vx, yaw, vy, _] => {
            format!(
                "移动 vx={}，vyaw={}，vy={}",
                *vx as i8, *yaw as i8, *vy as i8
            )
        }
        [_, _, _, 0x12, 1, _] => "请求行走模式".into(),
        [_, _, _, 0x12, 2, _] => "请求全身行走模式".into(),
        [_, _, _, 0x17, _] => "开始示教录制".into(),
        [_, _, _, 0x18, _] => "停止示教录制".into(),
        [_, _, _, 0x19, ..] => "保存示教动作".into(),
        [_, _, _, 0x1c, _] => "查询示教动作库".into(),
        [_, _, _, 0x14, id, _] => format!("回放示教动作 #{id}"),
        [_, _, _, 0x1b, id, _] => format!("删除示教动作 #{id}"),
        [_, _, _, 0x22, _] => "查询电量".into(),
        [_, _, _, 0x31, _] => "查询状态".into(),
        _ => "蓝牙指令".into(),
    };
    Description {
        opcode,
        summary,
        text: None,
    }
}

#[derive(Default)]
pub(super) struct TeachListAssembler {
    buffer: Vec<u8>,
    in_session: bool,
    last_index: Option<u8>,
    last_slice_at: Option<Instant>,
}

impl TeachListAssembler {
    fn reset(&mut self) {
        self.buffer.clear();
        self.in_session = false;
        self.last_index = None;
        self.last_slice_at = None;
    }

    pub(super) fn push(&mut self, bytes: &[u8], now: Instant) -> Option<Result<Vec<TeachAction>, String>> {
        let [0x23, index, total, chunk @ ..] = frame_data(bytes)? else {
            return None;
        };
        let (index, total) = (*index, *total);
        if total == 0 || index >= total {
            self.reset();
            return Some(Err("收到无效的示教动作列表分片。".into()));
        }
        if index == 0 {
            self.reset();
            self.in_session = true;
        } else {
            let expected = self.last_index.and_then(|last| last.checked_add(1));
            let timed_out = self
                .last_slice_at
                .is_some_and(|at| now.saturating_duration_since(at) > TEACH_SLICE_TIMEOUT);
            if !self.in_session || expected != Some(index) || timed_out {
                self.reset();
                return None;
            }
        }
        if self.buffer.len().saturating_add(chunk.len()) > TEACH_LIST_MAX_BYTES {
            self.reset();
            return Some(Err("示教动作列表响应超出容量上限。".into()));
        }
        self.buffer.extend_from_slice(chunk);
        self.last_index = Some(index);
        self.last_slice_at = Some(now);
        if usize::from(index) + 1 < usize::from(total) {
            return None;
        }
        let payload = std::mem::take(&mut self.buffer);
        self.reset();
        let text = match String::from_utf8(payload) {
            Ok(text) => text,
            Err(_) => return Some(Err("示教动作列表不是有效的 UTF-8 文本。".into())),
        };
        Some(parse_teach_list(&text))
    }
}

fn parse_u8_field(value: Option<&serde_json::Value>) -> Option<u8> {
    match value? {
        serde_json::Value::Number(num) => {
            if let Some(n) = num.as_u64() {
                u8::try_from(n).ok()
            } else if let Some(f) = num.as_f64() {
                (f.is_finite() && (0.0..=255.0).contains(&f)).then_some(f as u8)
            } else {
                None
            }
        }
        serde_json::Value::String(text) => text.trim().parse::<u8>().ok(),
        _ => None,
    }
}

fn parse_teach_item(fallback_key: Option<&str>, value: &serde_json::Value) -> Option<TeachAction> {
    let map = value.as_object()?;
    let id = parse_u8_field(map.get("teach_id").or_else(|| map.get("id")))
        .or_else(|| fallback_key.and_then(|key| key.trim().parse::<u8>().ok()))?;
    let raw_name = map
        .get("teach_name")
        .or_else(|| map.get("name"))
        .and_then(|v| match v {
            serde_json::Value::String(s) => {
                // Older clients appended one duration byte. Printable suffixes
                // are indistinguishable from a legitimate part of the name.
                Some(s.trim().trim_end_matches(char::is_control).trim_end().to_owned())
            }
            serde_json::Value::Null => None,
            other => Some(other.to_string()),
        })
        .unwrap_or_default();
    let name = if raw_name.is_empty() {
        format!("动作 #{id}")
    } else {
        raw_name.chars().take(64).collect()
    };
    let duration = parse_u8_field(map.get("teach_duration").or_else(|| map.get("duration")))
        .filter(|seconds| *seconds > 0);
    let time = map
        .get("teach_time")
        .or_else(|| map.get("time"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(64).collect());
    Some(TeachAction {
        id,
        name,
        duration,
        time,
    })
}

fn teach_json(text: &str) -> serde_json::Result<serde_json::Value> {
    serde_json::from_str(text).or_else(|error| {
        // Some devices emit a legacy duration byte literally inside the JSON
        // string. Recover only a raw control at the end of a quoted value.
        let mut repaired = String::with_capacity(text.len());
        let mut quoted = false;
        let mut escaped = false;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if quoted && !escaped && c < ' ' && chars.peek() == Some(&'"') {
                continue;
            }
            if c == '"' && !escaped {
                quoted = !quoted;
            }
            escaped = quoted && !escaped && c == '\\';
            repaired.push(c);
        }
        if repaired.len() == text.len() {
            Err(error)
        } else {
            serde_json::from_str(&repaired)
        }
    })
}

pub(super) fn parse_teach_list(text: &str) -> Result<Vec<TeachAction>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut root: serde_json::Value =
        teach_json(trimmed).map_err(|_| "示教动作列表 JSON 解析失败。".to_owned())?;
    if let Some(obj) = root.as_object() {
        if let Some(inner) = obj.get("data") {
            root = match inner {
                serde_json::Value::String(nested) => teach_json(nested)
                    .map_err(|_| "示教动作列表内层 JSON 解析失败。".to_owned())?,
                other => other.clone(),
            };
        }
    }
    let mut actions = Vec::new();
    match &root {
        serde_json::Value::Object(map) => {
            if map.contains_key("teach_id") || map.contains_key("teach_name") {
                if let Some(item) = parse_teach_item(None, &root) {
                    actions.push(item);
                }
            } else {
                for (key, value) in map {
                    if let Some(item) = parse_teach_item(Some(key), value) {
                        actions.push(item);
                    }
                }
            }
        }
        serde_json::Value::Array(items) => {
            for value in items {
                if let Some(item) = parse_teach_item(None, value) {
                    actions.push(item);
                }
            }
        }
        serde_json::Value::Null => {}
        _ => return Err("示教动作列表格式不受支持。".into()),
    }
    actions.sort_by(|left, right| {
        left.time
            .as_deref()
            .unwrap_or("")
            .cmp(right.time.as_deref().unwrap_or(""))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(actions)
}

pub(super) fn describe(bytes: &[u8]) -> Description {
    let invalid = || Description {
        opcode: None,
        summary: "无法识别的 BLE 帧".into(),
        text: std::str::from_utf8(bytes)
            .ok()
            .map(|text| text.chars().take(512).collect()),
    };
    let Some(inner) = frame_data(bytes) else {
        return invalid();
    };
    let opcode = inner[0];
    if let Some(reading) = reading(bytes) {
        return Description {
            opcode: Some(opcode),
            summary: match reading {
                Reading::Battery(percent) => format!("电量：{percent}%"),
                Reading::Status(status) => format!("运行状态码：{status}"),
            },
            text: None,
        };
    }
    if opcode == 0x26 {
        let summary = match inner.get(1) {
            Some(percent) => format!("电量应答值 {percent} 超出 0–100 范围"),
            None => "电量应答缺少数值".into(),
        };
        return Description {
            opcode: Some(opcode),
            summary,
            text: None,
        };
    }
    let name = match opcode {
        0x00 => "CUSTOM_RESULT",
        0x24 => "NET_RESULT",
        0x25 => "HELLO_RESULT",
        0x53 => "ROBOT_IP_RESULT",
        0x55 => "DOUBAO_VOICE_CONTROL_RESULT",
        0x23 => "TEACH_LIST",
        _ => "未知操作码",
    };
    let mut summary = format!("{name}（0x{opcode:02X}）");
    let mut payload = &inner[1..];
    if inner.len() >= 3 {
        let index = inner[1] as usize;
        let total = inner[2] as usize;
        if total > 0 && index < total {
            payload = &inner[3..];
            if total > 1 {
                summary.push_str(&format!(" · 分片 {}/{}", index + 1, total));
            }
        }
    }
    Description {
        opcode: Some(opcode),
        summary,
        text: std::str::from_utf8(payload)
            .ok()
            .map(|text| text.chars().take(512).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_the_official_app_frames() {
        for (command, expected) in [
            (Command::Battery, &[0x55, 0xaa, 5, 0x22, 5][..]),
            (Command::Status, &[0x55, 0xaa, 5, 0x31, 5]),
            (Command::Dance, &[0x55, 0xaa, 6, 0x1e, 1, 6]),
            (Command::Wave, &[0x55, 0xaa, 6, 0x12, 3, 6]),
            (Command::Handshake, &[0x55, 0xaa, 6, 0x12, 4, 6]),
            (Command::Cheer, &[0x55, 0xaa, 6, 0x12, 5, 6]),
            (Command::StandUp, &[0x55, 0xaa, 6, 0x12, 8, 6]),
            (Command::StandToFall, &[0x55, 0xaa, 6, 0x12, 9, 6]),
            (Command::Walk, &[0x55, 0xaa, 6, 0x12, 1, 6]),
            (Command::Run, &[0x55, 0xaa, 6, 0x12, 2, 6]),
            (
                Command::Volume { percent: 75 },
                &[0x55, 0xaa, 6, 0x32, 75, 6],
            ),
        ] {
            assert_eq!(frame(command).unwrap(), expected);
        }
        assert!(frame(Command::Volume { percent: 101 }).is_err());
    }

    #[test]
    fn movement_matches_the_official_three_axis_rocker_frame() {
        for (command, expected) in [
            (
                Command::Move {
                    vx: 40,
                    vyaw: 0,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 40, 0, 0, 8][..],
            ),
            (
                Command::Move {
                    vx: -40,
                    vyaw: 0,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 0xd8, 0, 0, 8],
            ),
            (
                Command::Move {
                    vx: 0,
                    vyaw: 40,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 0, 40, 0, 8],
            ),
            (
                Command::Move {
                    vx: 0,
                    vyaw: -40,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 0, 0xd8, 0, 8],
            ),
            (
                Command::Move {
                    vx: 0,
                    vyaw: 0,
                    vy: 40,
                },
                &[0x55, 0xaa, 8, 0x13, 0, 0, 0x28, 8],
            ),
            (
                Command::Move {
                    vx: 0,
                    vyaw: 0,
                    vy: -40,
                },
                &[0x55, 0xaa, 8, 0x13, 0, 0, 0xd8, 8],
            ),
            (Command::STOP, &[0x55, 0xaa, 8, 0x13, 0, 0, 0, 8]),
            (
                Command::Move {
                    vx: 51,
                    vyaw: 38,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 0x33, 0x26, 0, 8],
            ),
            (
                Command::Move {
                    vx: -127,
                    vyaw: 0,
                    vy: 0,
                },
                &[0x55, 0xaa, 8, 0x13, 0x81, 0, 0, 8],
            ),
        ] {
            assert_eq!(frame(command).unwrap(), expected);
        }
    }

    #[test]
    fn ipc_move_defaults_legacy_requests_to_zero_strafe() {
        let legacy: Command =
            serde_json::from_str(r#"{"action":"move","vx":0,"vyaw":40}"#).unwrap();
        assert_eq!(frame(legacy).unwrap(), [0x55, 0xaa, 8, 0x13, 0, 40, 0, 8]);
        for (vy, byte) in [(-127, 0x81), (127, 0x7f)] {
            let command = serde_json::from_value(serde_json::json!({
                "action": "move", "vx": 0, "vyaw": 0, "vy": vy,
            }))
            .unwrap();
            assert_eq!(
                frame(command).unwrap(),
                [0x55, 0xaa, 8, 0x13, 0, 0, byte, 8]
            );
        }
        assert!(frame(Command::Move {
            vx: 0,
            vyaw: 0,
            vy: -128
        })
        .is_err());
    }

    #[test]
    fn remote_input_requires_the_horizontal_axis_selected_on_the_device() {
        for (vx, vyaw, vy, yaw_key, strafe_key) in [
            (80, 0, 0, Some("up"), Some("up")),
            (-80, 0, 0, Some("down"), Some("down")),
            (0, 80, 0, Some("left"), None),
            (0, -80, 0, Some("right"), None),
            (0, 0, 80, None, Some("left")),
            (0, 0, -80, None, Some("right")),
        ] {
            let command = Command::Move { vx, vyaw, vy };
            let direction = command.remote_direction().unwrap().unwrap();
            assert_eq!(direction.key_for_mode(false), yaw_key);
            assert_eq!(direction.key_for_mode(true), strafe_key);
            assert_eq!(command.motion_active(), Some(true));
        }
        assert!(Command::STOP.remote_direction().unwrap().is_none());
        assert_eq!(Command::STOP.motion_active(), Some(false));
        for (vx, vyaw, vy) in [(0, 0, 81), (0, 0, -81), (30, 30, 0), (0, 30, 30), (81, 0, 0), (0, 81, 0), (0, -81, 0)] {
            assert!(Command::Move { vx, vyaw, vy }.remote_direction().is_err());
        }
        assert!(Command::Walk.remote_direction().is_err());
    }

    #[test]
    fn speech_is_bounded_utf8_and_rejects_empty_text() {
        assert_eq!(
            frame(Command::Speak {
                text: "你好".into()
            })
            .unwrap(),
            &[0x55, 0xaa, 11, 0x16, 0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd, 11]
        );
        assert!(frame(Command::Speak { text: "  ".into() }).is_err());
        assert!(frame(Command::Speak {
            text: "中".repeat(41)
        })
        .is_err());
        assert!(frame(Command::Speak {
            text: "中".repeat(40)
        })
        .is_ok());
    }

    #[test]
    fn reads_binary_battery_and_status_and_rejects_invalid_frames() {
        assert_eq!(
            reading(&[0x55, 0xaa, 6, 0x26, 83, 6]),
            Some(Reading::Battery(83))
        );
        assert_eq!(
            reading(&[0x55, 0xaa, 6, 0x51, 0xff, 6]),
            Some(Reading::Status(-1))
        );
        for invalid in [
            &[0x55, 0xaa, 6, 0x26, 101, 6][..],
            &[0x55, 0xaa, 6, 0x26, 42, 5],
            &[0x55, 0xaa, 7, 0x26, 42, 7],
            &[0x55, 0xab, 6, 0x26, 42, 6],
            &[0x55, 0xaa, 6, 0x25, 42, 6],
            &[0x55, 0xaa, 5, 0x26, 5],
            &[0x55, 0xaa, 7, 0x26, 101, 83, 7],
            &[0x55, 0xaa, 7, 0x26, 83, 0, 6],
            &[0x55, 0xaa, 7, 0x26, 83, 0, 0, 7],
        ] {
            assert_eq!(reading(invalid), None);
        }
    }

    #[test]
    fn reads_first_battery_byte_in_complete_extended_frames() {
        for percent in [0, 83, 100] {
            let frame = [0x55, 0xaa, 8, 0x26, percent, 0xff, 0x80, 8];
            assert_eq!(reading(&frame), Some(Reading::Battery(percent)));
            assert_eq!(describe(&frame).summary, format!("电量：{percent}%"));
        }
    }

    #[test]
    fn describes_battery_replies_without_a_valid_percentage() {
        for (frame, summary) in [
            (&[0x55, 0xaa, 5, 0x26, 5][..], "电量应答缺少数值"),
            (&[0x55, 0xaa, 7, 0x26, 255, 0, 7], "电量应答值 255 超出 0–100 范围"),
        ] {
            let description = describe(frame);
            assert_eq!(reading(frame), None);
            assert_eq!(description.opcode, Some(0x26));
            assert_eq!(description.summary, summary);
            assert!(description.text.is_none());
        }
    }

    #[test]
    fn describes_notifications_without_losing_raw_or_fragment_information() {
        let battery = describe(&[0x55, 0xaa, 6, 0x26, 83, 6]);
        assert_eq!(battery.opcode, Some(0x26));
        assert_eq!(battery.summary, "电量：83%");
        let ip = describe(&[
            0x55, 0xaa, 16, 0x53, 0, 1, b'1', b'9', b'2', b'.', b'0', b'.', b'0', b'.', b'1', 16,
        ]);
        assert_eq!(ip.summary, "ROBOT_IP_RESULT（0x53）");
        assert_eq!(ip.text.as_deref(), Some("192.0.0.1"));
        let fragment = describe(&[0x55, 0xaa, 9, 0x55, 1, 2, b'a', b'b', 9]);
        assert_eq!(
            fragment.summary,
            "DOUBAO_VOICE_CONTROL_RESULT（0x55） · 分片 2/2"
        );
        assert_eq!(fragment.text.as_deref(), Some("ab"));
        assert_eq!(
            describe(&[0x55, 0xaa, 6, 0x26, 83, 5]).summary,
            "无法识别的 BLE 帧"
        );
    }

    #[test]
    fn encodes_teach_recording_and_action_library_frames() {
        for (command, expected) in [
            (Command::StartTeach, &[0x55, 0xaa, 5, 0x17, 5][..]),
            (Command::StopTeach, &[0x55, 0xaa, 5, 0x18, 5]),
            (Command::TeachList, &[0x55, 0xaa, 5, 0x1c, 5]),
            (Command::PlayTeach { id: 3 }, &[0x55, 0xaa, 6, 0x14, 3, 6]),
            (Command::DeleteTeach { id: 7 }, &[0x55, 0xaa, 6, 0x1b, 7, 6]),
            (
                Command::SaveTeach { name: "挥臂".into() },
                &[0x55, 0xaa, 11, 0x19, 0xe6, 0x8c, 0xa5, 0xe8, 0x87, 0x82, 11],
            ),
        ] {
            assert_eq!(frame(command).unwrap(), expected);
        }
        assert!(frame(Command::SaveTeach {
            name: "   ".into(),
        })
        .is_err());
        assert!(frame(Command::SaveTeach {
            name: "a\nb".into(),
        })
        .is_err());
        assert!(frame(Command::SaveTeach {
            name: "摆".repeat(17),
        })
        .is_err());
        assert!(frame(Command::SaveTeach {
            name: "摆".repeat(16),
        })
        .is_ok());
    }

    #[test]
    fn legacy_save_duration_is_never_encoded_in_the_name() {
        let save: Command = serde_json::from_str(r#"{"action":"saveTeach","name":"测试","duration":5}"#).unwrap();
        assert_eq!(frame(save).unwrap(), [0x55, 0xaa, 11, 0x19, 0xe6, 0xb5, 0x8b, 0xe8, 0xaf, 0x95, 11]);
    }

    #[test]
    fn a_legacy_name_does_not_hide_the_second_action() {
        for suffix in ["\\u0005", "\u{5}", "\n"] {
            let text = format!(
                r#"[{{"teach_id":1,"teach_name":"测试{suffix}"}},{{"teach_id":2,"teach_name":"测试2"}}]"#
            );
            let list = parse_teach_list(&text).unwrap();
            assert_eq!(list.len(), 2);
            assert_eq!((list[0].id, list[0].name.as_str()), (1, "测试"));
            assert_eq!((list[1].id, list[1].name.as_str()), (2, "测试2"));
        }
        assert!(parse_teach_list("{\"bad\":1\u{5}}").is_err());
    }

    #[test]
    fn reassembles_fragmented_teach_list_and_parses_map_and_array_shapes() {
        fn teach_frame(index: u8, total: u8, chunk: &[u8]) -> Vec<u8> {
            let len = (chunk.len() + 7) as u8;
            let mut bytes = vec![0x55, 0xaa, len, 0x23, index, total];
            bytes.extend_from_slice(chunk);
            bytes.push(len);
            bytes
        }

        let json = r#"{"cmd":"teach_list","data":{"2":{"teach_id":2,"teach_name":"右摆臂","teach_duration":8,"teach_time":"2026-11-25 14:02"},"1":{"teach_id":"1","teach_name":"左摆臂","teach_duration":"5","teach_time":"2026-11-25 14:01"}}}"#;
        let bytes = json.as_bytes();
        let mid = bytes.len() / 2;
        let now = Instant::now();
        let mut assembler = TeachListAssembler::default();
        assert!(assembler
            .push(&teach_frame(0, 2, &bytes[..mid]), now)
            .is_none());
        let parsed = assembler
            .push(&teach_frame(1, 2, &bytes[mid..]), now)
            .unwrap()
            .unwrap();
        assert_eq!(
            parsed,
            vec![
                TeachAction {
                    id: 1,
                    name: "左摆臂".into(),
                    duration: Some(5),
                    time: Some("2026-11-25 14:01".into()),
                },
                TeachAction {
                    id: 2,
                    name: "右摆臂".into(),
                    duration: Some(8),
                    time: Some("2026-11-25 14:02".into()),
                },
            ]
        );
        // Empty map and array both succeed cleanly.
        assert_eq!(parse_teach_list(r#"{"cmd":"teach_list","data":{}}"#).unwrap(), vec![]);
        assert_eq!(
            parse_teach_list(r#"[{"teach_id":4,"teach_name":"招手","teach_duration":3}]"#).unwrap(),
            vec![TeachAction {
                id: 4,
                name: "招手".into(),
                duration: Some(3),
                time: None,
            }]
        );
        // Out-of-order fragment drops until a fresh index 0 arrives.
        assert!(assembler.push(&teach_frame(1, 2, b"{}"), now).is_none());
        assert_eq!(
            assembler.push(&teach_frame(0, 1, b"[]"), now).unwrap().unwrap(),
            vec![]
        );
        assert!(parse_teach_list("not-json").is_err());
    }
}
