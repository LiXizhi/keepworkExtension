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

// Noetix 3.2.2, ProtocolBtUtils.buildPacket and TcpConversionToBleUtils.
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
        Command::Move { vx, vyaw } => vec![0x13, vx as u8, vyaw as u8],
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
    fn movement_uses_signed_low_speed_axes_and_has_an_explicit_zero_frame() {
        for (command, expected) in [
            (
                Command::Move { vx: 40, vyaw: 0 },
                &[0x55, 0xaa, 7, 0x13, 40, 0, 7][..],
            ),
            (
                Command::Move { vx: -40, vyaw: 0 },
                &[0x55, 0xaa, 7, 0x13, 0xd8, 0, 7],
            ),
            (
                Command::Move { vx: 0, vyaw: 40 },
                &[0x55, 0xaa, 7, 0x13, 0, 40, 7],
            ),
            (
                Command::Move { vx: 0, vyaw: -40 },
                &[0x55, 0xaa, 7, 0x13, 0, 0xd8, 7],
            ),
            (
                Command::Move { vx: 0, vyaw: 0 },
                &[0x55, 0xaa, 7, 0x13, 0, 0, 7],
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
}
