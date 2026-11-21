//! Pure ATVV/PTT state machine. Audio is bounded, mono PCM16 at 16 kHz.
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const SERVICE: Uuid = Uuid::from_u128(0xab5e00015a214f05bc7daf01f617b664);
pub const TX: Uuid = Uuid::from_u128(0xab5e00025a214f05bc7daf01f617b664);
pub const AUDIO: Uuid = Uuid::from_u128(0xab5e00035a214f05bc7daf01f617b664);
pub const CONTROL: Uuid = Uuid::from_u128(0xab5e00045a214f05bc7daf01f617b664);
pub const GET_CAPS: &[u8] = &[0x0a, 1, 0, 0, 3, 3];
pub const MAX_SAMPLES: usize = 16_000 * 60; // Maximum undrained decoder buffer.
pub const CHUNK_SAMPLES: usize = 1_280; // 80 ms at 16 kHz.
pub const MAX_PRESS_SECONDS: u64 = 600;
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
    audible: bool,
    total: usize,
    limit_exceeded: bool,
}
impl AudioBuffer {
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            decoder: Ima::default(),
            pending: vec![],
            samples: vec![],
            sequence: None,
            audible: false,
            total: 0,
            limit_exceeded: false,
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
                return Err("尚未处理的遥控器音频超过缓冲上限。".into());
            }
            if self.total + audio.len() * 2 > 16_000 * MAX_PRESS_SECONDS as usize {
                self.limit_exceeded = true;
                break;
            }
            self.total += audio.len() * 2;
            for &byte in audio {
                for nibble in [byte >> 4, byte & 15] {
                    let sample = self.decoder.nibble(nibble);
                    self.samples.push(sample);
                    self.audible |= sample.unsigned_abs() >= 16;
                }
            }
        }
        self.pending.drain(..whole);
        Ok(())
    }
    fn take_chunk(&mut self) -> Option<Vec<i16>> {
        if self.samples.len() < CHUNK_SAMPLES { return None; }
        Some(self.samples.drain(..CHUNK_SAMPLES).collect())
    }
    pub fn finish(self) -> Result<Vec<i16>, String> {
        if !self.pending.is_empty() {
            return Err("ATVV 音频帧被截断，本段录音已丢弃。".into());
        }
        Ok(self.samples)
    }
}
pub enum Action {
    AcknowledgePress(Vec<u8>),
    OpenMic(Vec<u8>),
    State(&'static str),
    Recognize { samples: Vec<i16> },
}
pub struct Ptt {
    caps: Caps,
    capture: Option<(AudioBuffer, Instant)>,
    stream: u8,
    open_pending: Option<Instant>,
    discarding: bool,
    pub busy: bool,
}
impl Ptt {
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            capture: None,
            stream: 0,
            open_pending: None,
            discarding: false,
            busy: false,
        }
    }
    pub fn control(&mut self, data: &[u8]) -> Result<Vec<Action>, String> {
        if data.is_empty() || data.len() > 256 {
            return Ok(vec![]);
        }
        match data[0] {
            0x08 | 0x10
                if !self.busy
                    && !self.discarding
                    && self.capture.is_none()
                    && self.open_pending.is_none() =>
            {
                self.open_pending = Some(Instant::now());
                Ok(vec![Action::OpenMic(self.caps.mic_open())])
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
                self.open_pending = None;
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
                self.capture = Some((AudioBuffer::new(self.caps), Instant::now()));
                Ok(vec![Action::State("recording")])
            }
            0x00 | 0x13 => {
                let was_opening = self.open_pending.take().is_some();
                if std::mem::take(&mut self.discarding) {
                    return Ok(vec![]);
                }
                let Some((capture, _)) = self.capture.take() else {
                    return Ok(if was_opening { vec![Action::State("no-audio")] } else { vec![] });
                };
                let (total, audible) = (capture.total, capture.audible);
                let samples = capture.finish()?;
                if total == 0 {
                    return Ok(vec![Action::State("no-audio")]);
                }
                if total < 1600 {
                    return Ok(vec![Action::State("audio-too-short")]);
                }
                if !audible {
                    return Ok(vec![Action::State("silent-audio")]);
                }
                self.busy = true;
                Ok(vec![Action::Recognize { samples }])
            }
            0x0a | 0x12 => {
                if let Some((capture, _)) = &mut self.capture {
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
        if let Some((capture, _)) = &mut self.capture {
            capture.append(data)?;
        }
        Ok(())
    }
    pub fn take_chunk(&mut self) -> Option<Vec<i16>> {
        self.capture.as_mut()?.0.take_chunk()
    }
    pub fn preparation_timed_out(&self) -> bool {
        let deadline = Duration::from_secs(5);
        self.open_pending.is_some_and(|started| started.elapsed() >= deadline)
            || self.capture.as_ref().is_some_and(|(audio, started)| {
                audio.total < CHUNK_SAMPLES && started.elapsed() >= deadline
            })
    }
    pub fn interrupt_capture(&mut self) -> Option<Vec<i16>> {
        let (capture, _) = self.capture.take()?;
        self.discarding = true;
        self.open_pending = None;
        Some(capture.samples)
    }
    pub fn expired(&self) -> bool {
        self.capture
            .as_ref()
            .is_some_and(|(buffer, started)| buffer.limit_exceeded || started.elapsed() >= Duration::from_secs(MAX_PRESS_SECONDS))
    }
    /// Cancel this utterance without MIC_CLOSE (which breaks Notify on some
    /// firmware). If PTT is held, ignore its tail until the physical release.
    pub fn cancel_current(&mut self) {
        self.discarding |= self.capture.is_some() || self.open_pending.is_some();
        self.capture = None;
        self.open_pending = None;
        self.busy = false;
    }
    /// Consume controls received before Clear, even if setup delayed their processing.
    /// A press still held at Clear remains discarded until physical release.
    pub fn discard_buffered_control(&mut self, data: &[u8]) -> Result<Vec<Action>, String> {
        match data {
            [0x08 | 0x10, ..] | [0x04 | 0x11, _, 2, _, ..] if data.len() <= 256 => Ok(self.discard_press(data)),
            [0x00 | 0x13, ..] => self.control(data),
            _ => Ok(vec![]),
        }
    }
    /// The remote may require MIC_OPEN before it reports release. Complete
    /// that handshake without constructing a decoder or recognition stream.
    pub fn discard_press(&mut self, control: &[u8]) -> Vec<Action> {
        self.cancel_current();
        self.discarding = true;
        if matches!(control.first(), Some(0x08 | 0x10)) {
            vec![Action::AcknowledgePress(self.caps.mic_open())]
        } else { Vec::new() }
    }
    pub fn abort(&mut self) -> Vec<u8> {
        self.capture = None;
        self.open_pending = None;
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
        let mut p = Ptt::new(caps(0x100, 120));
        assert!(matches!(&p.control(&[8]).unwrap()[0],Action::OpenMic(w) if w == &[12,0]));
        assert!(p.control(&[8]).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[4, 0, 2, 1]).unwrap()[0],
            Action::State("recording")
        ));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(p.control(&[4, 0, 2, 1]).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[0, 2]).unwrap()[0],
            Action::Recognize { .. }
        ));
        assert!(p.control(&[0, 0]).unwrap().is_empty());
        assert!(matches!(
            &p.control(&[4, 0, 2, 2]).unwrap()[0],
            Action::State("busy")
        ));
    }
    #[test]
    fn a_started_stream_without_a_complete_audio_chunk_times_out_and_allows_a_fresh_press() {
        // No notification, an incomplete frame, and some decoded audio below one chunk.
        for byte_count in [0, 1, 600] {
            let mut p = Ptt::new(caps(0x100, 120));
            p.control(&[8]).unwrap();
            p.control(&[4, 0, 2, 1]).unwrap();
            p.audio(&vec![0x77; byte_count]).unwrap();
            assert!(p.take_chunk().is_none());
            assert!(!p.preparation_timed_out());
            p.capture.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(5);
            assert!(p.preparation_timed_out(), "{byte_count} initial bytes");
            assert!(!p.expired(), "the ordinary recording limit has not elapsed");

            assert_eq!(p.abort(), vec![0x0d, 1]);
            assert!(!p.preparation_timed_out());
            assert!(p.control(&[0]).unwrap().is_empty());
            assert!(matches!(p.control(&[8]).unwrap()[..], [Action::OpenMic(_)]));
            p.control(&[4, 0, 2, 2]).unwrap();
            p.audio(&[0x77; 1200]).unwrap();
            assert!(matches!(p.control(&[0]).unwrap()[..], [Action::Recognize { .. }]));
        }
    }

    #[test]
    fn a_drained_first_audio_chunk_including_silence_completes_preparation() {
        let mut p = Ptt::new(caps(0x100, 1));
        p.control(&[0x11, 0, 2, 1]).unwrap();
        p.audio(&[0; CHUNK_SAMPLES / 2]).unwrap();
        assert_eq!(p.take_chunk().unwrap().len(), CHUNK_SAMPLES);
        p.capture.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(6);
        assert!(!p.preparation_timed_out());
        assert!(!p.expired());
    }

    #[test]
    fn missing_stream_start_times_out_only_the_pending_press() {
        let mut p = Ptt::new(caps(0x100, 120));
        assert!(!p.preparation_timed_out());
        p.control(&[0x10]).unwrap();
        assert!(!p.preparation_timed_out());
        p.open_pending = Some(Instant::now() - Duration::from_secs(5));
        assert!(p.preparation_timed_out());
        p.control(&[0x11, 0, 2, 1]).unwrap();
        assert!(!p.preparation_timed_out());
        p.control(&[0x13]).unwrap();
        p.control(&[8]).unwrap();
        p.cancel_current();
        assert!(!p.preparation_timed_out());
    }
    #[test]
    fn release_reports_missing_short_or_silent_audio_and_accepts_the_next_press() {
        let mut p = Ptt::new(caps(0x100, 1));
        // A remote can acknowledge MIC_OPEN with a stop before stream_start.
        assert!(matches!(p.control(&[8]).unwrap()[..], [Action::OpenMic(_)]));
        assert!(matches!(p.control(&[0]).unwrap()[..], [Action::State("no-audio")]));
        assert!(p.control(&[0]).unwrap().is_empty());
        for (bytes, state) in [
            (vec![], "no-audio"),
            (vec![0x77; 799], "audio-too-short"),
            (vec![0; 800], "silent-audio"),
        ] {
            assert!(matches!(p.control(&[4, 0, 2, 1]).unwrap()[..], [Action::State("recording")]));
            p.audio(&bytes).unwrap();
            assert!(matches!(p.control(&[0]).unwrap()[..], [Action::State(actual)] if actual == state));
            assert!(!p.busy);
            assert!(p.control(&[0]).unwrap().is_empty());
        }
        p.control(&[4, 0, 2, 2]).unwrap();
        p.audio(&[0x77; 800]).unwrap();
        assert!(matches!(p.control(&[0]).unwrap()[..], [Action::Recognize { .. }]));
    }
    #[test]
    fn live_pcm_flushes_every_eighty_ms_including_silence_and_one_residual_tail() {
        let mut p = Ptt::new(caps(0x100, 1));
        p.control(&[4, 0, 2, 1]).unwrap();
        p.audio(&[0; CHUNK_SAMPLES / 2 - 1]).unwrap();
        assert!(p.take_chunk().is_none());
        p.audio(&[0]).unwrap();
        assert_eq!(p.take_chunk().unwrap(), vec![0; CHUNK_SAMPLES]);
        p.audio(&[0x77; CHUNK_SAMPLES / 2 + 1]).unwrap();
        let speech = p.take_chunk().unwrap();
        assert_eq!(speech.len(), CHUNK_SAMPLES);
        assert!(speech.iter().any(|sample| *sample != 0));
        assert!(p.take_chunk().is_none());
        let Action::Recognize { samples } = p.control(&[0]).unwrap().pop().unwrap() else { panic!("missing tail") };
        assert_eq!(samples.len(), 2);
        assert!(p.control(&[0]).unwrap().is_empty());
    }
    #[test]
    fn a_drained_chunk_from_a_short_or_silent_capture_cannot_trigger_delivery() {
        for (pcm_bytes, state) in [(vec![0x77; 650], "audio-too-short"), (vec![0; 1500], "silent-audio")] {
            let mut p = Ptt::new(caps(0x100, 1));
            p.control(&[4, 0, 2, 1]).unwrap();
            p.audio(&pcm_bytes).unwrap();
            assert!(p.take_chunk().is_some());
            assert!(matches!(p.control(&[0]).unwrap()[0], Action::State(actual) if actual == state));
        }
    }

    #[test]
    fn total_limit_keeps_accepted_audio_discards_held_tail_and_recovers_on_next_press() {
        let mut p = Ptt::new(caps(0x100, 1));
        p.control(&[4, 0, 2, 1]).unwrap();
        let (buffer, _) = p.capture.as_mut().unwrap();
        buffer.total = 16_000 * MAX_PRESS_SECONDS as usize - 2;
        p.audio(&[0x77; 3]).unwrap();
        assert!(p.expired());
        assert_eq!(p.interrupt_capture().unwrap().len(), 2);
        p.audio(&[0x77; 120]).unwrap();
        assert!(p.control(&[4, 0, 2, 2]).unwrap().is_empty());
        assert!(p.control(&[0]).unwrap().is_empty());
        assert!(matches!(p.control(&[4, 0, 2, 3]).unwrap()[0], Action::State("recording")));
    }
    #[test]
    fn aborted_or_truncated_recordings_never_create_cloud_work() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 2]).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        p.abort();
        assert!(p.control(&[0]).unwrap().is_empty());
        p.control(&[4, 0, 2, 3]).unwrap();
        p.audio(&[1]).unwrap();
        assert!(p.control(&[0]).is_err());
    }

    #[test]
    fn busy_ptt_is_dropped_without_closing_or_replacing_the_existing_recognition() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 1]).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        let old = p.control(&[0]).unwrap().pop().unwrap();
        assert!(p.busy);

        // A new physical session must not write MIC_CLOSE on firmware 2671,
        // create queued audio, or cancel/replace the already released request.
        assert!(p.control(&[8]).unwrap().is_empty());
        let busy = p.control(&[4, 0, 2, 2]).unwrap();
        assert_eq!(busy.len(), 1);
        assert!(matches!(busy[0], Action::State("busy")));
        p.audio(&[0x77; 8193]).unwrap(); // No recording buffer accepts this data.
        assert!(p.control(&[0]).unwrap().is_empty());
        assert!(
            p.busy,
            "releasing the discarded session cannot complete the old ASR"
        );
        match old {
            Action::Recognize { samples } => {
                assert_eq!(samples.len(), 2400);
            }
            _ => panic!("the original released recording must remain independent"),
        }

        p.busy = false;
        assert!(matches!(
            p.control(&[4, 0, 2, 3]).unwrap()[0],
            Action::State("recording")
        ));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(
            p.control(&[0]).unwrap()[0],
            Action::Recognize { .. }
        ));
    }

    #[test]
    fn discarded_busy_session_stays_discarded_until_release_even_when_old_asr_completes() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.busy = true;
        assert!(matches!(
            p.control(&[4, 0, 2, 2]).unwrap()[0],
            Action::State("busy")
        ));
        p.busy = false; // The old request completes while this key is still held.
        assert!(p.control(&[8]).unwrap().is_empty());
        assert!(p.control(&[4, 0, 2, 2]).unwrap().is_empty());
        assert!(p.control(&[0x11, 0, 2, 2]).unwrap().is_empty());
        p.audio(&[0x77; 1200]).unwrap();
        assert!(
            p.control(&[0x13]).unwrap().is_empty(),
            "never recognize only the tail of a discarded utterance"
        );
        assert!(matches!(p.control(&[8]).unwrap()[0], Action::OpenMic(_)));
        assert!(matches!(
            p.control(&[4, 0, 2, 3]).unwrap()[0],
            Action::State("recording")
        ));
    }

    #[test]
    fn clear_during_capture_discards_its_audio_and_duplicate_starts_until_physical_release() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 1]).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        p.audio(&[1]).unwrap(); // Even a partial frame must be discarded, not finalized.
        p.cancel_current();
        p.cancel_current();
        assert!(!p.busy && !p.expired());
        assert!(p.control(&[8]).unwrap().is_empty());
        assert!(p.control(&[4, 0, 2, 1]).unwrap().is_empty());
        p.audio(&[0x77; 8193]).unwrap(); // There is no buffer to accept the tail.
        assert!(p.control(&[0]).unwrap().is_empty());
        assert!(p.control(&[0]).unwrap().is_empty());
        assert!(matches!(p.control(&[4, 0, 2, 2]).unwrap()[0], Action::State("recording")));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(p.control(&[0]).unwrap()[0], Action::Recognize { .. }));
    }

    #[test]
    fn clear_while_mic_open_is_pending_ignores_the_delayed_session_until_release() {
        let mut p = Ptt::new(caps(0x100, 120));
        assert!(matches!(&p.control(&[8]).unwrap()[0], Action::OpenMic(bytes) if bytes == &[12, 0]));
        p.cancel_current();
        assert!(p.control(&[8]).unwrap().is_empty());
        assert!(p.control(&[0x11, 0, 2, 1]).unwrap().is_empty());
        p.audio(&[0x77; 1200]).unwrap();
        assert!(p.control(&[0x13]).unwrap().is_empty());
        assert!(matches!(&p.control(&[8]).unwrap()[0], Action::OpenMic(bytes) if bytes == &[12, 0]));
        assert!(matches!(p.control(&[4, 0, 2, 2]).unwrap()[0], Action::State("recording")));
    }

    #[test]
    fn clear_while_only_asr_is_pending_does_not_drop_the_next_fresh_ptt() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.control(&[4, 0, 2, 1]).unwrap();
        p.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(p.control(&[0]).unwrap()[0], Action::Recognize { .. }));
        assert!(p.busy);
        p.cancel_current();
        assert!(!p.busy);
        assert!(matches!(p.control(&[4, 0, 2, 2]).unwrap()[0], Action::State("recording")));
        p.audio(&[0x77; 1200]).unwrap();
        assert!(matches!(p.control(&[0]).unwrap()[0], Action::Recognize { .. }));
        let mut idle = Ptt::new(caps(0x100, 120));
        idle.cancel_current();
        assert!(matches!(idle.control(&[4, 0, 2, 1]).unwrap()[0], Action::State("recording")));
    }

    #[test]
    fn clear_keeps_an_already_discarded_busy_ptt_blocked_until_its_release() {
        let mut p = Ptt::new(caps(0x100, 120));
        p.busy = true;
        assert!(matches!(p.control(&[4, 0, 2, 2]).unwrap()[0], Action::State("busy")));
        p.cancel_current();
        assert!(!p.busy);
        assert!(p.control(&[8]).unwrap().is_empty());
        assert!(p.control(&[4, 0, 2, 2]).unwrap().is_empty());
        p.audio(&[0x77; 1200]).unwrap();
        assert!(p.control(&[0]).unwrap().is_empty());
        assert!(matches!(p.control(&[4, 0, 2, 3]).unwrap()[0], Action::State("recording")));
    }
}
