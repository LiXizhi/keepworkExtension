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
// This control pad only requests longitudinal motion and turns.
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
        Command::Move { vx, vyaw } => vec![0x13, vx as u8, vyaw as u8, 0],
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

// BatteryHandler and StatusHandler read a single binary byte after the opcode.
pub(super) fn reading(bytes: &[u8]) -> Option<Reading> {
    match bytes {
        [0x55, 0xaa, 6, 0x26, percent, 6] if *percent <= 100 => Some(Reading::Battery(*percent)),
        [0x55, 0xaa, 6, 0x51, status, 6] => Some(Reading::Status(*status as i8)),
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
    if bytes.len() < 5 || bytes[0] != 0x55 || bytes[1] != 0xaa {
        return invalid();
    }
    let length = bytes[2] as usize;
    if length != bytes.len() || bytes.last() != Some(&bytes[2]) {
        return invalid();
    }
    let inner = &bytes[3..bytes.len() - 1];
    let Some(&opcode) = inner.first() else {
        return invalid();
    };
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
                Command::Move { vx: 40, vyaw: 0 },
                &[0x55, 0xaa, 8, 0x13, 40, 0, 0, 8][..],
            ),
            (
                Command::Move { vx: -40, vyaw: 0 },
                &[0x55, 0xaa, 8, 0x13, 0xd8, 0, 0, 8],
            ),
            (
                Command::Move { vx: 0, vyaw: 40 },
                &[0x55, 0xaa, 8, 0x13, 0, 40, 0, 8],
            ),
            (
                Command::Move { vx: 0, vyaw: -40 },
                &[0x55, 0xaa, 8, 0x13, 0, 0xd8, 0, 8],
            ),
            (
                Command::Move { vx: 0, vyaw: 0 },
                &[0x55, 0xaa, 8, 0x13, 0, 0, 0, 8],
            ),
            (
                Command::Move { vx: 51, vyaw: 38 },
                &[0x55, 0xaa, 8, 0x13, 0x33, 0x26, 0, 8],
            ),
            (
                Command::Move { vx: -127, vyaw: 0 },
                &[0x55, 0xaa, 8, 0x13, 0x81, 0, 0, 8],
            ),
        ] {
            assert_eq!(frame(command).unwrap(), expected);
        }
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
        ] {
            assert_eq!(reading(invalid), None);
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
