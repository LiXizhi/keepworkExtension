//! Pure ATVV/PTT state machine. Audio is bounded, mono PCM16 at 16 kHz.
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const SERVICE: Uuid = Uuid::from_u128(0xab5e00015a214f05bc7daf01f617b664);
pub const TX: Uuid = Uuid::from_u128(0xab5e00025a214f05bc7daf01f617b664);
pub const AUDIO: Uuid = Uuid::from_u128(0xab5e00035a214f05bc7daf01f617b664);
pub const CONTROL: Uuid = Uuid::from_u128(0xab5e00045a214f05bc7daf01f617b664);
pub const GET_CAPS: &[u8] = &[0x0a, 1, 0, 0, 3, 3];
pub const MAX_SAMPLES: usize = 16_000 * 60;
const STEPS: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub version: u16,
    pub frame_size: usize,
}
impl Caps {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        if data.len() < 7 || data[0] != 0x0b {
            return Err("ATVV 能力响应不完整。".into());
        }
        let version = u16::from_be_bytes([data[1], data[2]]);
        if ![0x0004, 0x0100].contains(&version) {
            return Err("不支持此遥控器的 ATVV 协议版本。".into());
        }
        let codecs = if data[3] & 15 == 0 { data[4] } else { data[3] };
        if codecs & 2 == 0 {
            return Err("遥控器未提供 16 kHz IMA ADPCM 音频。".into());
        }
        let size = u16::from_be_bytes([data[5], data[6]]) as usize;
        if size > 1024 {
            return Err("ATVV 帧长度超出限制。".into());
        }
        Ok(Self {
            version,
            frame_size: if size != 0 {
                size
            } else if version < 0x0100 {
                128
            } else {
                120
            },
        })
    }
    fn headered(self) -> bool {
        self.version < 0x0100
    }
    fn mic_open(self) -> Vec<u8> {
        vec![0x0c, if self.headered() { 2 } else { 0 }]
    }
}
#[derive(Default)]
struct Ima {
    predictor: i32,
    index: i32,
}
impl Ima {
    fn new(predictor: i16, index: u8) -> Result<Self, String> {
        if index > 88 {
            return Err("ATVV 音频同步状态无效。".into());
        }
        Ok(Self {
            predictor: predictor as i32,
            index: index as i32,
        })
    }
    fn nibble(&mut self, n: u8) -> i16 {
        let step = STEPS[self.index as usize];
        let mut difference = step >> 3;
        if n & 1 != 0 {
            difference += step >> 2;
        }
        if n & 2 != 0 {
            difference += step >> 1;
        }
        if n & 4 != 0 {
            difference += step;
        }
        self.predictor = (self.predictor + if n & 8 != 0 { -difference } else { difference })
            .clamp(-32768, 32767);
        self.index = (self.index + INDEX[(n & 7) as usize]).clamp(0, 88);
        self.predictor as i16
    }
}
pub struct AudioBuffer {
    caps: Caps,
    decoder: Ima,
    pending: Vec<u8>,
    samples: Vec<i16>,
    sequence: Option<u16>,
}
impl AudioBuffer {
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            decoder: Ima::default(),
            pending: vec![],
            samples: vec![],
            sequence: None,
        }
    }
    pub fn sync(&mut self, predictor: i16, index: u8) -> Result<(), String> {
        self.decoder = Ima::new(predictor, index)?;
        self.pending.clear();
        Ok(())
    }
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 8192 {
            return Err("ATVV 通知长度超出限制。".into());
        }
        self.pending.extend_from_slice(bytes);
        let size = self.caps.frame_size + if self.caps.headered() { 6 } else { 0 };
        let whole = self.pending.len() / size * size;
        for frame in self.pending[..whole].chunks_exact(size) {
            let audio = if self.caps.headered() {
                let seq = u16::from_be_bytes([frame[0], frame[1]]);
                if self
                    .sequence
                    .is_some_and(|previous| seq != previous.wrapping_add(1))
                {
                    return Err("ATVV 音频丢包或乱序，本段录音已丢弃。".into());
                }
                self.sequence = Some(seq);
                self.decoder = Ima::new(i16::from_be_bytes([frame[3], frame[4]]), frame[5])?;
                &frame[6..]
            } else {
                frame
            };
            if self.samples.len() + audio.len() * 2 > MAX_SAMPLES {
                return Err("单次语音输入不能超过 60 秒。".into());
            }
            for &byte in audio {
                self.samples.push(self.decoder.nibble(byte >> 4));
                self.samples.push(self.decoder.nibble(byte & 15));
            }
        }
        self.pending.drain(..whole);
        Ok(())
    }
    pub fn finish(self) -> Result<Vec<i16>, String> {
        if !self.pending.is_empty() {
            return Err("ATVV 音频帧被截断，本段录音已丢弃。".into());
        }
        Ok(self.samples)
    }
}
pub enum Action<T> {
    Write(Vec<u8>),
    State(&'static str),
    Recognize {
        samples: Vec<i16>,
        target: Option<T>,
    },
}
pub struct Ptt<T> {
    caps: Caps,
    capture: Option<(AudioBuffer, Option<T>, Instant)>,
    stream: u8,
    open_pending: bool,
    discarding: bool,
    pub busy: bool,
}
impl<T> Ptt<T> {
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            capture: None,
            stream: 0,
            open_pending: false,
            discarding: false,
            busy: false,
        }
    }
    pub fn control(&mut self, data: &[u8], target: Option<T>) -> Result<Vec<Action<T>>, String> {
        if data.is_empty() || data.len() > 256 {
            return Ok(vec![]);
        }
        match data[0] {
            0x08 | 0x10
                if !self.busy
                    && !self.discarding
                    && self.capture.is_none()
                    && !self.open_pending =>
            {
                self.open_pending = true;
                Ok(vec![Action::Write(self.caps.mic_open())])
            }
            0x04 | 0x11 => {
                if self.discarding {
                    return Ok(vec![]);
                }
                if data.len() < 4 {
                    return Err("ATVV 会话开始通知不完整。".into());
                }
                if self.capture.is_some() && self.stream == data[3] {
                    return Ok(vec![]);
                }
                self.capture = None;
                self.open_pending = false;
                self.stream = data[3];
                if self.busy {
                    // Keep receiving and discarding this whole physical PTT.
                    // Closing it would invalidate Notify on firmware 2671.
                    self.discarding = true;
                    return Ok(vec![Action::State("busy")]);
                }
                if data[2] != 2 {
                    return Err("遥控器选择了不支持的音频编码。".into());
                }
                self.capture = Some((AudioBuffer::new(self.caps), target, Instant::now()));
                Ok(vec![Action::State("recording")])
            }
            0x00 | 0x13 => {
                self.open_pending = false;
                if std::mem::take(&mut self.discarding) {
                    return Ok(vec![]);
                }
                let Some((capture, target, _)) = self.capture.take() else {
                    return Ok(vec![]);
                };
                let samples = capture.finish()?;
                if samples.len() < 1600 || !samples.iter().any(|s| (*s as i32).abs() >= 16) {
                    return Ok(vec![Action::State("ready")]);
                }
                self.busy = true;
                Ok(vec![Action::Recognize { samples, target }])
            }
            0x0a | 0x12 => {
                if let Some((capture, _, _)) = &mut self.capture {
                    if data.len() < 7 {
                        return Err("ATVV 音频同步通知不完整。".into());
                    }
                    capture.sync(i16::from_be_bytes([data[4], data[5]]), data[6])?;
                }
                Ok(vec![])
            }
            _ => Ok(vec![]),
        }
    }
    pub fn audio(&mut self, data: &[u8]) -> Result<(), String> {
        if let Some((capture, _, _)) = &mut self.capture {
            capture.append(data)?;
        }
        Ok(())
    }
    pub fn expired(&self) -> bool {
        self.capture
            .as_ref()
            .is_some_and(|(_, _, started)| started.elapsed() >= Duration::from_secs(60))
    }
    pub fn abort(&mut self) -> Vec<u8> {
        self.capture = None;
        self.open_pending = false;
        self.discarding = false;
        vec![0x0d, self.stream]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn caps(version: u16, frame_size: usize) -> Caps {
        Caps {
            version,
            frame_size,
        }
    }
    fn header(seq: u16, predictor: i16, index: u8, bytes: &[u8]) -> Vec<u8> {
        let mut f = seq.to_be_bytes().to_vec();
        f.push(0);
        f.extend(predictor.to_be_bytes());
        f.push(index);
        f.extend(bytes);
        f
    }
    #[test]
    fn known_high_nibble_ima_vector_and_saturation() {
        let mut b = AudioBuffer::new(caps(0x100, 8));
        b.append(&[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0])
            .unwrap();
        assert_eq!(
            b.finish().unwrap(),
            [1, 4, 8, 15, 27, 47, 88, 82, 66, 41, 10, -28, -84, -181, -380, -352]
        );
        let mut d = Ima::new(32760, 88).unwrap();
        assert_eq!(d.nibble(7), 32767);
        assert_eq!(d.index, 88);
        let mut d = Ima::new(-32760, 88).unwrap();
        assert_eq!(d.nibble(15), -32768);
        assert!(Ima::new(0, 89).is_err());
    }
    #[test]
    fn fragments_sync_and_legacy_headers_keep_their_exact_boundaries() {
        let mut b = AudioBuffer::new(caps(0x100, 2));
        b.append(&[0x12]).unwrap();
        b.sync(-100, 0).unwrap();
        b.append(&[0x12]).unwrap();
        b.append(&[0x34]).unwrap();
        assert_eq!(b.finish().unwrap(), [-99, -96, -92, -85]);
        let mut b = AudioBuffer::new(caps(4, 1));
        let bytes = [header(65535, 0, 0, &[0x12]), header(0, 100, 0, &[0x34])].concat();
        for part in bytes.chunks(3) {
            b.append(part).unwrap();
        }
        assert_eq!(b.finish().unwrap(), [1, 4, 104, 111]);
        for seq in [9, 10, 12] {
            let mut b = AudioBuffer::new(caps(4, 1));
            b.append(&header(10, 0, 0, &[0x12])).unwrap();
            assert!(b.append(&header(seq, 0, 0, &[0x34])).is_err());
        }
    }
    #[test]
    fn negotiation_rejects_unsupported_rate_and_bounded_bad_frames() {
        assert!(Caps::parse(&[0x0b, 1, 0, 1, 0, 0, 120]).is_err());
        assert!(Caps::parse(&[0x0b, 2, 0, 2, 0, 0, 120]).is_err());
        assert_eq!(
            Caps::parse(&[0x0b, 1, 0, 2, 0, 0, 0]).unwrap().frame_size,
            120
        );
        let mut b = AudioBuffer::new(caps(0x100, 120));
        b.append(&[1]).unwrap();
        assert!(b.finish().is_err());
        let mut b = AudioBuffer::new(caps(0x100, 1000));
        assert!(b.append(&[0; 8193]).is_err());
        for _ in 0..120 {
            b.append(&[0; 4000]).unwrap();
        }
        assert!(b.append(&[0; 1000]).is_err());
    }
    #[test]
    fn ptt_only_opens_on_remote_request_and_releases_once_without_extra_close() {
        let mut p = Ptt::<u8>::new(caps(0x100, 120));
        assert!(matches!(&p.control(&[8],None).unwrap()[0],Action::Write(w) if w == &[12,0]));
        assert!(p.control(&[8], None).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[4, 0, 2, 1], Some(7)).unwrap()[0],
            Action::State("recording")
        ));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(p.control(&[4, 0, 2, 1], Some(8)).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[0, 2], None).unwrap()[0],
            Action::Recognize {
                target: Some(7),
                ..
            }
        ));
        assert!(p.control(&[0, 0], None).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[4, 0, 2, 2], None).unwrap()[0],
            Action::State("busy")
        ));
    }
    #[test]
    fn aborted_or_silent_recordings_never_create_cloud_work() {
        let mut p = Ptt::<()>::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 1], None).unwrap();
        p.audio(&[0; 1200]).unwrap();
        assert!(matches!(
            &p.control(&[0], None).unwrap()[0],
            Action::State("ready")
        ));
        p.control(&[4, 0, 2, 2], None).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        p.abort();
        assert!(p.control(&[0], None).unwrap().is_empty());
        p.control(&[4, 0, 2, 3], None).unwrap();
        p.audio(&[1]).unwrap();
        assert!(p.control(&[0], None).is_err());
    }

    #[test]
    fn busy_ptt_is_dropped_without_closing_or_replacing_the_existing_recognition() {
        let mut p = Ptt::<u8>::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 1], Some(7)).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        let old = p.control(&[0], None).unwrap().pop().unwrap();
        assert!(p.busy);

        // A new physical session must not write MIC_CLOSE on firmware 2671,
        // create queued audio, or cancel/replace the already released request.
        assert!(p.control(&[8], None).unwrap().is_empty());
        let busy = p.control(&[4, 0, 2, 2], Some(8)).unwrap();
        assert_eq!(busy.len(), 1);
        assert!(matches!(busy[0], Action::State("busy")));
        p.audio(&[0x77; 8193]).unwrap(); // No recording buffer accepts this data.
        assert!(p.control(&[0], None).unwrap().is_empty());
        assert!(
            p.busy,
            "releasing the discarded session cannot complete the old ASR"
        );
        match old {
            Action::Recognize { samples, target } => {
                assert_eq!(target, Some(7));
                assert_eq!(samples.len(), 2400);
            }
            _ => panic!("the original released recording must remain independent"),
        }

        p.busy = false;
        assert!(matches!(
            p.control(&[4, 0, 2, 3], Some(9)).unwrap()[0],
            Action::State("recording")
        ));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(
            p.control(&[0], None).unwrap()[0],
            Action::Recognize {
                target: Some(9),
                ..
            }
        ));
    }

    #[test]
    fn discarded_busy_session_stays_discarded_until_release_even_when_old_asr_completes() {
        let mut p = Ptt::<u8>::new(caps(0x100, 120));
        p.busy = true;
        assert!(matches!(
            p.control(&[4, 0, 2, 2], Some(8)).unwrap()[0],
            Action::State("busy")
        ));
        p.busy = false; // The old request completes while this key is still held.
        assert!(p.control(&[8], None).unwrap().is_empty());
        assert!(p.control(&[4, 0, 2, 2], Some(8)).unwrap().is_empty());
        assert!(p.control(&[0x11, 0, 2, 2], Some(8)).unwrap().is_empty());
        p.audio(&[0x77; 1200]).unwrap();
        assert!(
            p.control(&[0x13], None).unwrap().is_empty(),
            "never recognize only the tail of a discarded utterance"
        );
        assert!(matches!(
            p.control(&[8], None).unwrap()[0],
            Action::Write(_)
        ));
        assert!(matches!(
            p.control(&[4, 0, 2, 3], Some(9)).unwrap()[0],
            Action::State("recording")
        ));
    }
}
