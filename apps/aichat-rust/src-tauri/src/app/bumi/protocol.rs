use super::Command;
use uuid::{uuid, Uuid};

pub(super) const SERVICE: Uuid = uuid!("061e8f00-8a56-11f0-a62c-00155dff3a7e");
pub(super) const NOTIFY: Uuid = uuid!("061e8f01-8a56-11f0-a62c-00155dff3a7e");
pub(super) const WRITE: Uuid = uuid!("061e8f02-8a56-11f0-a62c-00155dff3a7e");

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
    fn remote_input_allows_bounded_forward_backward_yaw_and_stop() {
        for (vx, vyaw, vy, expected) in [
            (80, 0, 0, "up"),
            (-80, 0, 0, "down"),
            (0, 80, 0, "left"),
            (0, -80, 0, "right"),
        ] {
            let command = Command::Move { vx, vyaw, vy };
            assert_eq!(command.remote_direction(), Ok(Some(expected)));
            assert_eq!(command.motion_active(), Some(true));
        }
        assert_eq!(Command::STOP.remote_direction(), Ok(None));
        assert_eq!(Command::STOP.motion_active(), Some(false));
        for (vx, vyaw, vy) in [(0, 0, 80), (0, 0, -80), (30, 30, 0), (81, 0, 0), (0, 81, 0), (0, -81, 0)] {
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
}
