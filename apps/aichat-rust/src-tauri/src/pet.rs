use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

pub const MAX_PET_INPUT_CHARS: usize = 32_000;
pub const MAX_PET_IMAGE_DATA_BYTES: usize = 8 * 1024 * 1024;
pub const ALLOWED_SCALES: &[f64] = &[0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

/// Classify clicks that start microphone capture. Legacy main-page capture on
/// macOS needs a visible page; negotiated pet capture keeps the main page hidden.
pub fn starts_media_capture(snapshot: &Value, action: &str) -> bool {
    if snapshot["ready"].as_bool() != Some(true) {
        return false;
    }
    let dictating = snapshot["dictating"].as_bool() == Some(true);
    let calling = snapshot["voice"]["active"].as_bool() == Some(true);
    let recording = snapshot["classroomRecording"]["enabled"].as_bool() == Some(true);
    match action {
        "dictation" => {
            !dictating && !calling && !recording && snapshot["richDraft"].as_bool() != Some(true)
        }
        "call" => !calling && !dictating && snapshot["canCall"].as_bool() == Some(true),
        "voice-start" => {
            !calling
                && !dictating
                && snapshot["canCall"].as_bool() == Some(true)
                && snapshot["compactVoice"].as_bool() == Some(true)
        }
        "record-start" => {
            !recording && !calling && !dictating && snapshot["classroomRecording"].is_object()
        }
        _ => false,
    }
}

/// Voice capture is additive: old pages and unsupported targets retain their
/// existing microphone path instead of silently receiving different semantics.
pub fn uses_pet_audio(snapshot: &Value, action: &str) -> bool {
    starts_media_capture(snapshot, action)
        && (action == "dictation"
            || (action == "call"
                && snapshot["target"].as_str() == Some("persona")
                && snapshot["petVoiceAudioVersion"].as_u64() == Some(1)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PetPreferences {
    pub appearance: String,
    pub scale: f64,
    pub left: Option<i32>,
    pub top: Option<i32>,
    /// Top-left of the monitor that owned `left`/`top`, in shared logical points.
    /// Absent prefs keep the primary monitor.
    #[serde(default)]
    pub monitor_x: Option<i32>,
    #[serde(default)]
    pub monitor_y: Option<i32>,
}

impl Default for PetPreferences {
    fn default() -> Self {
        Self {
            appearance: "follow".to_string(),
            scale: 1.0,
            left: None,
            top: None,
            monitor_x: None,
            monitor_y: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PetHitRegion {
    pub id: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl PetHitRegion {
    fn clipped(mut self, area: WorkArea) -> Option<Self> {
        if !matches!(
            self.id.as_str(),
            "pet" | "panel" | "bubble" | "compact-controls" | "exit-bubble" | "permission-bubble"
        ) || ![self.left, self.top, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            || self.width <= 0.0
            || self.height <= 0.0
            || self.width > area.width as f64
            || self.height > area.height as f64
        {
            return None;
        }
        let right = (self.left + self.width).min(area.width as f64);
        let bottom = (self.top + self.height).min(area.height as f64);
        self.left = self.left.max(0.0);
        self.top = self.top.max(0.0);
        self.width = right - self.left;
        self.height = bottom - self.top;
        (self.width > 0.0 && self.height > 0.0).then_some(self)
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.left && y >= self.top && x < self.left + self.width && y < self.top + self.height
    }
}

#[derive(Default)]
struct PetPointerState {
    regions: Vec<PetHitRegion>,
    epoch: u64,
    held: bool,
    applied: Option<bool>,
}

pub fn physical_pet_cursor(
    cursor: (f64, f64),
    origin: (f64, f64),
    scale: f64,
    area: WorkArea,
) -> Option<(i32, i32)> {
    if ![cursor.0, cursor.1, origin.0, origin.1, scale]
        .iter()
        .all(|n| n.is_finite())
        || scale <= 0.0
    {
        return None;
    }
    Some((
        ((cursor.0 - origin.0) / scale + area.x as f64).round() as i32,
        ((cursor.1 - origin.1) / scale + area.y as f64).round() as i32,
    ))
}

impl Default for WorkArea {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetPersonaSummary {
    pub name: String,
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetExitPrompt {
    pub id: String,
    pub loading: bool,
    pub unavailable: bool,
    pub shared_runtime: bool,
    pub personas: Vec<PetPersonaSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetPermissionPrompt {
    pub id: String,
    pub client: String,
}

pub fn normalize_scale(raw: f64) -> f64 {
    for &s in ALLOWED_SCALES {
        if (raw - s).abs() < 0.01 {
            return s;
        }
    }
    1.0
}

pub fn compute_pet_pixels(scale: f64, work_area: WorkArea) -> i32 {
    let s = normalize_scale(scale);
    let raw = (112.0 * s).round() as i32;
    let max_w = (work_area.width - 16).max(32);
    let max_h = (work_area.height - 300).max(32);
    raw.clamp(32, max_w.min(max_h))
}

pub fn clamp_pet_position(
    left: Option<i32>,
    top: Option<i32>,
    pet_pixels: i32,
    work_area: WorkArea,
) -> (i32, i32) {
    let max_left = (work_area.width - pet_pixels - 8).max(8);
    let max_top = (work_area.height - pet_pixels - 24).max(8);
    let default_left = (work_area.width - pet_pixels - 24).clamp(8, max_left);
    let default_top = (work_area.height - pet_pixels - 40).clamp(8, max_top);
    let l = left.unwrap_or(default_left).clamp(8, max_left);
    let t = top.unwrap_or(default_top).clamp(8, max_top);
    (l, t)
}

fn add_i32(a: i32, b: i32) -> i32 {
    (a as i64 + b as i64).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn sub_i32(a: i32, b: i32) -> i32 {
    (a as i64 - b as i64).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn contains_point(area: WorkArea, x: i32, y: i32) -> bool {
    x >= area.x
        && y >= area.y
        && (x as i64) < area.x as i64 + area.width as i64
        && (y as i64) < area.y as i64 + area.height as i64
}

pub fn monitor_at(monitors: &[WorkArea], x: i32, y: i32) -> Option<WorkArea> {
    monitor_at_preferred(monitors, x, y, None)
}

fn monitor_at_preferred(
    monitors: &[WorkArea],
    x: i32,
    y: i32,
    preferred: Option<WorkArea>,
) -> Option<WorkArea> {
    if let Some(hit) = monitors
        .iter()
        .copied()
        .find(|area| contains_point(*area, x, y))
    {
        return Some(hit);
    }
    monitors.iter().copied().min_by_key(|area| {
        let x = x as i128;
        let y = y as i128;
        let dx = (area.x as i128 - x)
            .max(0)
            .max(x - (area.x as i128 + area.width as i128));
        let dy = (area.y as i128 - y)
            .max(0)
            .max(y - (area.y as i128 + area.height as i128));
        (dx * dx + dy * dy, preferred != Some(*area))
    })
}

/// The pet window stays on one monitor. Pick the monitor under the cursor and
/// clamp the sprite there, preserving the grab offset from the pet's top-left.
pub fn place_dragged_pet(
    monitors: &[WorkArea],
    cursor_x: i32,
    cursor_y: i32,
    grab_x: i32,
    grab_y: i32,
    scale: f64,
) -> Option<(WorkArea, i32, i32)> {
    let monitor = monitor_at(monitors, cursor_x, cursor_y)?;
    Some(place_pet_on_monitor(
        monitor, cursor_x, cursor_y, grab_x, grab_y, scale,
    ))
}

fn place_pet_on_monitor(
    monitor: WorkArea,
    cursor_x: i32,
    cursor_y: i32,
    grab_x: i32,
    grab_y: i32,
    scale: f64,
) -> (WorkArea, i32, i32) {
    let pixels = compute_pet_pixels(scale, monitor);
    let local_x = sub_i32(sub_i32(cursor_x, grab_x), monitor.x);
    let local_y = sub_i32(sub_i32(cursor_y, grab_y), monitor.y);
    let (left, top) = clamp_pet_position(Some(local_x), Some(local_y), pixels, monitor);
    (monitor, left, top)
}

pub fn is_valid_pet_data_image(raw: &str) -> bool {
    if raw.len() > MAX_PET_IMAGE_DATA_BYTES {
        return false;
    }
    let Some((header, b64)) = raw.split_once(";base64,") else {
        return false;
    };
    if !matches!(
        header,
        "data:image/png" | "data:image/jpeg" | "data:image/webp" | "data:image/gif"
    ) {
        return false;
    }
    !b64.is_empty()
        && b64
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

pub fn is_valid_pet_sheet_url(raw: &str) -> bool {
    let Ok(parsed) = Url::parse(raw) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("cdn.keepwork.com")
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

fn truncate_str(raw: &str, max_chars: usize) -> String {
    raw.chars().take(max_chars).collect()
}

pub fn sanitize_pet_state(
    raw: &Value,
    expanded: bool,
    prefs: &PetPreferences,
    work_area: WorkArea,
    exit_prompt: Option<&PetExitPrompt>,
    permission_prompt: Option<&PetPermissionPrompt>,
) -> Value {
    let pet_pixels = compute_pet_pixels(prefs.scale, work_area);
    let (mut pet_left, mut pet_top) =
        clamp_pet_position(prefs.left, prefs.top, pet_pixels, work_area);

    // If a screenshot permission prompt is active and pet is too high for the bubble, push it down temporarily
    if permission_prompt.is_some() && pet_top < 220 {
        let max_top = (work_area.height - pet_pixels - 24).max(8);
        pet_top = 220.min(max_top);
    }
    let _ = &mut pet_left;

    let raw_pet = raw.get("pet").unwrap_or(&Value::Null);
    let pet_name = raw_pet
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| truncate_str(s.trim(), 48))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "抱抱龙".to_string());
    let image_data = raw_pet
        .get("imageData")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_pet_data_image(s))
        .unwrap_or("");
    let sheet_url = raw_pet
        .get("sheetUrl")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_pet_sheet_url(s))
        .unwrap_or("");
    let bg_size = raw_pet
        .get("bgSize")
        .and_then(|v| v.as_str())
        .map(|s| truncate_str(s.trim(), 32))
        .unwrap_or_else(|| "400% 400%".to_string());
    let bg_pos = raw_pet
        .get("bgPos")
        .and_then(|v| v.as_str())
        .map(|s| truncate_str(s.trim(), 32))
        .unwrap_or_else(|| "0% 0%".to_string());

    // Keep last 8 user/assistant messages only
    let messages: Vec<Value> = raw
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let filtered: Vec<Value> = arr
                .iter()
                .filter_map(|m| {
                    let role = m.get("role").and_then(|v| v.as_str())?;
                    if role != "user" && role != "assistant" {
                        return None;
                    }
                    let text = m
                        .get("text")
                        .or_else(|| m.get("content"))
                        .and_then(|v| v.as_str())?;
                    if text.trim().is_empty() {
                        return None;
                    }
                    Some(json!({
                        "role": role,
                        "text": truncate_str(text, 4000),
                    }))
                })
                .collect();
            let skip = filtered.len().saturating_sub(8);
            filtered.into_iter().skip(skip).collect()
        })
        .unwrap_or_default();

    let reply = raw.get("reply").and_then(|r| {
        if r.is_null() {
            return None;
        }
        let text = r
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| truncate_str(s, 8000))
            .unwrap_or_default();
        let thinking = r.get("thinking").and_then(|v| v.as_bool()).unwrap_or(false);
        let immediate = r.get("immediate").and_then(|v| v.as_bool()).unwrap_or(true);
        let options: Vec<Value> = r
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| {
                        let opt_text = o.get("text").and_then(|v| v.as_str())?.trim();
                        if opt_text.is_empty() {
                            return None;
                        }
                        let icon = o
                            .get("icon")
                            .and_then(|v| v.as_str())
                            .map(|s| truncate_str(s.trim(), 16))
                            .unwrap_or_default();
                        Some(json!({
                            "icon": icon,
                            "text": truncate_str(opt_text, 160),
                        }))
                    })
                    .take(20)
                    .collect()
            })
            .unwrap_or_default();
        if text.is_empty() && options.is_empty() {
            None
        } else {
            Some(json!({
                "text": text,
                "thinking": thinking,
                "immediate": immediate,
                "options": options,
            }))
        }
    });

    let voice = raw.get("voice").map(|v| {
        json!({
            "active": v.get("active").and_then(|b| b.as_bool()).unwrap_or(false),
            "muted": v.get("muted").and_then(|b| b.as_bool()).unwrap_or(false),
            "state": v.get("state").and_then(|s| s.as_str()).map(|s| truncate_str(s, 32)).unwrap_or_default(),
        })
    });

    let classroom_recording = raw.get("classroomRecording").and_then(|r| {
        if r.is_null() || !r.is_object() {
            return None;
        }
        Some(json!({
            "enabled": r.get("enabled").and_then(|b| b.as_bool()).unwrap_or(false),
            "phase": r.get("phase").and_then(|s| s.as_str()).map(|s| truncate_str(s, 32)).unwrap_or_default(),
            "error": r.get("error").and_then(|s| s.as_str()).map(|s| truncate_str(s, 240)).unwrap_or_default(),
        }))
    });

    json!({
        "version": 1,
        "context": raw.get("context").and_then(|v| v.as_str()).map(|s| truncate_str(s, 120)).unwrap_or_else(|| "default".to_string()),
        "expanded": expanded,
        "petLeft": pet_left,
        "petTop": pet_top,
        "petPixels": pet_pixels,
        "preferences": {
            "appearance": prefs.appearance,
            "scale": prefs.scale,
        },
        "pet": {
            "name": pet_name,
            "imageData": image_data,
            "sheetUrl": sheet_url,
            "bgSize": bg_size,
            "bgPos": bg_pos,
        },
        "target": raw.get("target").and_then(|v| v.as_str()).unwrap_or("session"),
        "title": raw.get("title").and_then(|v| v.as_str()).map(|s| truncate_str(s, 120)).unwrap_or_else(|| "AIChat".to_string()),
        "folder": raw.get("folder").and_then(|v| v.as_str()).map(|s| truncate_str(s, 260)).unwrap_or_default(),
        "skill": raw.get("skill").and_then(|v| v.as_str()).map(|s| truncate_str(s, 80)).unwrap_or_default(),
        "canSwitchTarget": raw.get("canSwitchTarget").and_then(|v| v.as_bool()).unwrap_or(false),
        "ready": raw.get("ready").and_then(|v| v.as_bool()).unwrap_or(false),
        "busy": raw.get("busy").and_then(|v| v.as_bool()).unwrap_or(false),
        "dictating": raw.get("dictating").and_then(|v| v.as_bool()).unwrap_or(false),
        "richDraft": raw.get("richDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        "canCall": raw.get("canCall").and_then(|v| v.as_bool()).unwrap_or(false),
        "compactVoice": raw.get("compactVoice").and_then(|v| v.as_bool()).unwrap_or(false),
        "petVoiceAudioVersion": raw.get("petVoiceAudioVersion").and_then(|v| v.as_u64()).filter(|v| *v == 1),
        "draft": raw.get("draft").and_then(|v| v.as_str()).map(|s| truncate_str(s, MAX_PET_INPUT_CHARS)).unwrap_or_default(),
        "attention": raw.get("attention").and_then(|v| v.as_str()).map(|s| truncate_str(s, 240)).unwrap_or_default(),
        "error": raw.get("error").and_then(|v| v.as_str()).map(|s| truncate_str(s, 300)).unwrap_or_default(),
        "messages": messages,
        "reply": reply,
        "voice": voice,
        "classroomRecording": classroom_recording,
        "exitPrompt": exit_prompt,
        "permission": permission_prompt,
    })
}

pub fn sanitize_exit_personas(raw: &Value) -> Vec<PetPersonaSummary> {
    let Some(arr) = raw.get("personas").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(|v| v.as_str())?.trim();
            if name.is_empty() {
                return None;
            }
            let channels: Vec<String> = item
                .get("channels")
                .and_then(|v| v.as_array())
                .map(|ch_arr| {
                    ch_arr
                        .iter()
                        .filter_map(|c| c.as_str())
                        .map(|s| truncate_str(s.trim(), 32))
                        .filter(|s| !s.is_empty())
                        .take(8)
                        .collect()
                })
                .unwrap_or_default();
            Some(PetPersonaSummary {
                name: truncate_str(name, 64),
                channels,
            })
        })
        .take(20)
        .collect()
}

#[derive(Clone, Copy)]
enum DragOrigin {
    Global {
        grab_x: i32,
        grab_y: i32,
        start_x: i32,
        start_y: i32,
        active: bool,
    },
    Viewport {
        start_x: i32,
        start_y: i32,
        start_left: i32,
        start_top: i32,
    },
}

type PetCommandResult = Result<Value, String>;

#[derive(Default)]
struct PetPageState {
    raw: Value,
    pending: HashMap<String, oneshot::Sender<PetCommandResult>>,
}

fn pet_context(raw: &Value) -> String {
    raw.get("context")
        .and_then(Value::as_str)
        .map(|s| truncate_str(s, 120))
        .unwrap_or_else(|| "default".to_string())
}

impl PetPageState {
    fn cancel_pending(&mut self) {
        for (_, sender) in self.pending.drain() {
            let _ = sender.send(Err("会话已改变，请打开 AIChat 检查。".to_string()));
        }
    }
}

pub struct PetController {
    prefs_path: PathBuf,
    page_state: Mutex<PetPageState>,
    expanded: Mutex<bool>,
    prefs: Mutex<PetPreferences>,
    work_area: Mutex<WorkArea>,
    exit_prompt: Mutex<Option<PetExitPrompt>>,
    permission_prompt: Mutex<Option<PetPermissionPrompt>>,
    drag_origin: Mutex<Option<DragOrigin>>,
    drag_id: Mutex<Option<u64>>,
    drag_moved: AtomicBool,
    native_drag_tracking: AtomicBool,
    canvas_synced: Mutex<Option<WorkArea>>,
    pointer_state: Mutex<PetPointerState>,
}

impl PetController {
    pub fn new(prefs_path: PathBuf) -> Self {
        let prefs = Self::load_prefs(&prefs_path);
        Self {
            prefs_path,
            page_state: Mutex::new(PetPageState::default()),
            expanded: Mutex::new(false),
            prefs: Mutex::new(prefs),
            work_area: Mutex::new(WorkArea::default()),
            exit_prompt: Mutex::new(None),
            permission_prompt: Mutex::new(None),
            drag_origin: Mutex::new(None),
            drag_id: Mutex::new(None),
            drag_moved: AtomicBool::new(false),
            native_drag_tracking: AtomicBool::new(false),
            canvas_synced: Mutex::new(None),
            pointer_state: Mutex::new(PetPointerState::default()),
        }
    }

    fn load_prefs(path: &Path) -> PetPreferences {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PetPreferences>(&raw).ok())
            .map(|mut p| {
                p.scale = normalize_scale(p.scale);
                if p.appearance != "dragon" && p.appearance != "follow" {
                    p.appearance = "follow".to_string();
                }
                p
            })
            .unwrap_or_default()
    }

    fn save_prefs(&self, prefs: &PetPreferences) {
        let _ = atomic_json_write(&self.prefs_path, prefs);
    }

    pub fn set_work_area(&self, area: WorkArea) {
        if let Ok(mut w) = self.work_area.lock() {
            if *w != area {
                self.clear_hit_regions();
            }
            *w = area;
        }
    }

    pub fn clear_hit_regions(&self) {
        if let Ok(mut pointer) = self.pointer_state.lock() {
            pointer.regions.clear();
            pointer.epoch = pointer.epoch.wrapping_add(1);
        }
    }

    pub fn hit_regions_epoch(&self) -> u64 {
        self.pointer_state
            .lock()
            .map(|pointer| pointer.epoch)
            .unwrap_or_default()
    }

    pub fn update_hit_regions(&self, raw: &Value, epoch: u64) {
        let area = self.work_area();
        let regions = raw
            .as_array()
            .map(|regions| {
                regions
                    .iter()
                    .take(6)
                    .filter_map(|region| {
                        serde_json::from_value::<PetHitRegion>(region.clone()).ok()
                    })
                    .filter_map(|region| region.clipped(area))
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(mut pointer) = self.pointer_state.lock() {
            if pointer.epoch == epoch {
                pointer.regions = regions;
            }
        }
    }

    pub fn set_pointer_hold(&self, held: bool) {
        if let Ok(mut pointer) = self.pointer_state.lock() {
            pointer.held = held;
        }
    }

    pub fn suspend_pointer_tracking(&self) {
        if let Ok(mut drag) = self.drag_origin.lock() {
            *drag = None;
        }
        if let Ok(mut pointer) = self.pointer_state.lock() {
            pointer.held = false;
            pointer.applied = None;
        }
    }

    pub fn pointer_interactive(&self, cursor: Option<(i32, i32)>, primary_down: bool) -> bool {
        let area = self.work_area();
        let prefs = self.preferences();
        let dragging = self.is_dragging();
        let Ok(mut pointer) = self.pointer_state.lock() else {
            return false;
        };
        if !primary_down {
            pointer.held = false;
        }
        let Some((x, y)) = cursor else {
            return false;
        };
        if primary_down && (dragging || pointer.held) {
            return true;
        }
        let local_x = x as f64 - area.x as f64;
        let local_y = y as f64 - area.y as f64;
        if local_x < 0.0
            || local_y < 0.0
            || local_x >= area.width as f64
            || local_y >= area.height as f64
        {
            return false;
        }
        // The native sprite bounds remain usable even before the first layout
        // report, and immediately after a move onto another monitor.
        let pixels = compute_pet_pixels(prefs.scale, area);
        let (left, top) = clamp_pet_position(prefs.left, prefs.top, pixels, area);
        (local_x >= left as f64
            && local_x < (left + pixels) as f64
            && local_y >= top as f64
            && local_y < (top + pixels + 16) as f64)
            || pointer
                .regions
                .iter()
                .any(|region| region.id != "pet" && region.contains(local_x, local_y))
    }

    pub fn pointer_needs_update(&self, interactive: bool) -> bool {
        self.pointer_state
            .lock()
            .map(|pointer| pointer.applied != Some(interactive))
            .unwrap_or(false)
    }

    pub fn record_pointer_interactive(&self, interactive: bool) {
        if let Ok(mut pointer) = self.pointer_state.lock() {
            pointer.applied = Some(interactive);
        }
    }

    pub fn work_area(&self) -> WorkArea {
        self.work_area.lock().map(|w| *w).unwrap_or_default()
    }

    pub fn placement(&self) -> (WorkArea, Option<i32>, Option<i32>) {
        let prefs = self.preferences();
        (self.work_area(), prefs.left, prefs.top)
    }

    pub fn drag_id(&self) -> Option<u64> {
        self.drag_id.lock().ok().and_then(|id| *id)
    }

    pub fn owns_drag(&self, id: Option<u64>) -> bool {
        id.is_none() || self.drag_id() == id
    }

    pub fn set_drag_id(&self, id: Option<u64>) {
        if let Ok(mut current) = self.drag_id.lock() {
            *current = id;
        }
    }

    pub fn preferences(&self) -> PetPreferences {
        self.prefs
            .lock()
            .map(|prefs| prefs.clone())
            .unwrap_or_default()
    }

    pub fn note_canvas(&self, area: WorkArea) {
        if let Ok(mut synced) = self.canvas_synced.lock() {
            *synced = Some(area);
        }
    }

    pub fn pending_canvas(&self) -> Option<WorkArea> {
        let area = self.work_area();
        self.canvas_synced
            .lock()
            .ok()
            .and_then(|synced| (*synced != Some(area)).then_some(area))
    }

    pub fn is_dragging(&self) -> bool {
        self.drag_origin
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .is_some()
    }

    pub fn is_global_dragging(&self) -> bool {
        matches!(
            self.drag_origin.lock().ok().and_then(|guard| *guard),
            Some(DragOrigin::Global { .. })
        )
    }

    pub fn drag_moved(&self) -> bool {
        self.drag_moved.load(Ordering::Relaxed)
    }

    pub fn native_drag_tracking(&self) -> bool {
        self.native_drag_tracking.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> Value {
        let raw = self
            .page_state
            .lock()
            .map(|g| g.raw.clone())
            .unwrap_or_else(|_| json!({}));
        let expanded = self.expanded.lock().map(|g| *g).unwrap_or(false);
        let prefs = self.prefs.lock().map(|g| g.clone()).unwrap_or_default();
        let area = self.work_area();
        let exit = self.exit_prompt.lock().ok().and_then(|g| g.clone());
        let perm = self.permission_prompt.lock().ok().and_then(|g| g.clone());
        let mut snap =
            sanitize_pet_state(&raw, expanded, &prefs, area, exit.as_ref(), perm.as_ref());
        snap["hitRegionsEpoch"] = json!(self.hit_regions_epoch());
        snap
    }

    pub fn update_raw_state(&self, next: Value) -> Value {
        if let Ok(mut page) = self.page_state.lock() {
            if pet_context(&page.raw) != pet_context(&next) {
                page.cancel_pending();
                self.clear_hit_regions();
            }
            page.raw = next;
        }
        self.snapshot()
    }

    pub fn reset_state(&self) -> Value {
        self.clear_hit_regions();
        self.suspend_pointer_tracking();
        if let Ok(mut page) = self.page_state.lock() {
            page.cancel_pending();
            page.raw = json!({});
        }
        if let Ok(mut exp) = self.expanded.lock() {
            *exp = false;
        }
        self.snapshot()
    }

    /// Match the existing Electron/AIChat Bridge v1 envelope. Forwarding a
    /// command is not acknowledgement: the page must confirm its request ID.
    pub fn begin_command(
        &self,
        action: &str,
        args: &Value,
    ) -> Result<(Value, oneshot::Receiver<PetCommandResult>), String> {
        let mut page = self.page_state.lock().map_err(|e| e.to_string())?;
        let context = pet_context(&page.raw);
        if args.get("context").and_then(Value::as_str) != Some(context.as_str()) {
            return Err("会话已改变，请打开 AIChat 检查。".to_string());
        }
        if !page
            .raw
            .get("ready")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !matches!(action, "exit-info" | "toggle-target" | "hide")
        {
            return Err("请先在 AIChat 中连接本机服务和第二大脑，草稿已保留。".to_string());
        }
        if page.pending.len() >= 32 {
            return Err("宠物操作过多，请稍候。".to_string());
        }
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let mut command = args.as_object().cloned().unwrap_or_default();
        command.insert("version".to_string(), json!(1));
        command.insert("requestId".to_string(), json!(request_id));
        command.insert("context".to_string(), json!(context));
        command.insert("action".to_string(), json!(action));
        page.pending.insert(request_id, sender);
        Ok((Value::Object(command), receiver))
    }

    pub fn resolve_command(&self, result: &Value) -> bool {
        let Some(request_id) = result.get("requestId").and_then(Value::as_str) else {
            return false;
        };
        let sender = self
            .page_state
            .lock()
            .ok()
            .and_then(|mut page| page.pending.remove(request_id));
        let Some(sender) = sender else {
            return false;
        };
        let reply = if result.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(result.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(result
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| truncate_str(s, 300))
                .unwrap_or_else(|| "AIChat 未确认操作，草稿已保留。".to_string()))
        };
        let _ = sender.send(reply);
        true
    }

    pub async fn wait_for_command(
        &self,
        request_id: &str,
        receiver: oneshot::Receiver<PetCommandResult>,
        timeout: Duration,
    ) -> PetCommandResult {
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            _ => {
                if let Ok(mut page) = self.page_state.lock() {
                    page.pending.remove(request_id);
                }
                // Do not replay: a timed-out mutation may already have run.
                Err("AIChat 未确认操作，请打开主窗口检查结果。".to_string())
            }
        }
    }

    pub fn set_expanded(&self, value: bool) -> Value {
        self.clear_hit_regions();
        if let Ok(mut exp) = self.expanded.lock() {
            *exp = value;
        }
        self.snapshot()
    }

    pub fn set_scale(&self, scale: f64) -> Value {
        self.clear_hit_regions();
        if let Ok(mut prefs) = self.prefs.lock() {
            prefs.scale = normalize_scale(scale);
            let px = compute_pet_pixels(prefs.scale, self.work_area());
            let (l, t) = clamp_pet_position(prefs.left, prefs.top, px, self.work_area());
            prefs.left = Some(l);
            prefs.top = Some(t);
            self.save_prefs(&prefs);
        }
        self.snapshot()
    }

    pub fn set_appearance(&self, appearance: &str) -> Value {
        if let Ok(mut prefs) = self.prefs.lock() {
            prefs.appearance = if appearance == "dragon" {
                "dragon".to_string()
            } else {
                "follow".to_string()
            };
            self.save_prefs(&prefs);
        }
        self.snapshot()
    }

    pub fn start_drag(&self, cursor_x: i32, cursor_y: i32) {
        self.drag_moved.store(false, Ordering::Relaxed);
        self.native_drag_tracking.store(false, Ordering::Relaxed);
        self.set_drag_id(None);
        let snap = self.snapshot();
        let pet_left = snap["petLeft"].as_i64().unwrap_or(0) as i32;
        let pet_top = snap["petTop"].as_i64().unwrap_or(0) as i32;
        if let Ok(mut drag) = self.drag_origin.lock() {
            *drag = Some(DragOrigin::Viewport {
                start_x: cursor_x,
                start_y: cursor_y,
                start_left: pet_left,
                start_top: pet_top,
            });
        }
    }

    pub fn begin_global_drag(&self, cursor_x: i32, cursor_y: i32) {
        self.begin_global_drag_with_id(cursor_x, cursor_y, None);
    }

    pub fn begin_global_drag_with_id(&self, cursor_x: i32, cursor_y: i32, id: Option<u64>) {
        self.drag_moved.store(false, Ordering::Relaxed);
        self.native_drag_tracking.store(true, Ordering::Relaxed);
        let area = self.work_area();
        let snap = self.snapshot();
        let left = snap["petLeft"].as_i64().unwrap_or(0) as i32;
        let top = snap["petTop"].as_i64().unwrap_or(0) as i32;
        let grab_x = sub_i32(cursor_x, add_i32(area.x, left));
        let grab_y = sub_i32(cursor_y, add_i32(area.y, top));
        if let Ok(mut drag) = self.drag_origin.lock() {
            self.set_drag_id(id);
            *drag = Some(DragOrigin::Global {
                grab_x,
                grab_y,
                start_x: cursor_x,
                start_y: cursor_y,
                active: false,
            });
        }
    }

    /// Moves the pet with the global cursor. Returns the monitor canvas when the
    /// window has to move; `None` means the sprite changed on the same canvas
    /// or no global drag is active.
    pub fn drag_global(
        &self,
        cursor_x: i32,
        cursor_y: i32,
        monitors: &[WorkArea],
    ) -> Option<WorkArea> {
        let mut drag_guard = self.drag_origin.lock().ok()?;
        let (grab_x, grab_y) = match drag_guard.as_mut() {
            Some(DragOrigin::Global {
                grab_x,
                grab_y,
                start_x,
                start_y,
                active,
            }) => {
                if !*active {
                    let dx = cursor_x as i64 - *start_x as i64;
                    let dy = cursor_y as i64 - *start_y as i64;
                    if (dx as i128 * dx as i128 + dy as i128 * dy as i128) <= 16 {
                        return None;
                    }
                    *active = true;
                    self.drag_moved.store(true, Ordering::Relaxed);
                }
                (*grab_x, *grab_y)
            }
            _ => return None,
        };
        let scale = self
            .prefs
            .lock()
            .ok()
            .map(|prefs| prefs.scale)
            .unwrap_or(1.0);
        let previous = self.work_area();
        let monitor = monitor_at_preferred(monitors, cursor_x, cursor_y, Some(previous))?;
        let (_, left, top) =
            place_pet_on_monitor(monitor, cursor_x, cursor_y, grab_x, grab_y, scale);
        if let Ok(mut prefs) = self.prefs.lock() {
            if previous != monitor || prefs.left != Some(left) || prefs.top != Some(top) {
                self.clear_hit_regions();
                self.set_work_area(monitor);
            }
            prefs.left = Some(left);
            prefs.top = Some(top);
            prefs.monitor_x = Some(monitor.x);
            prefs.monitor_y = Some(monitor.y);
        }
        let changed = self
            .canvas_synced
            .lock()
            .map(|current| *current != Some(monitor))
            .unwrap_or(true);
        if changed {
            Some(monitor)
        } else {
            None
        }
    }

    pub fn update_drag(&self, cursor_x: i32, cursor_y: i32) -> Value {
        self.clear_hit_regions();
        let origin = self.drag_origin.lock().ok().and_then(|guard| *guard);
        if let Some(DragOrigin::Viewport {
            start_x,
            start_y,
            start_left,
            start_top,
        }) = origin
        {
            let dx = cursor_x - start_x;
            let dy = cursor_y - start_y;
            if let Ok(mut prefs) = self.prefs.lock() {
                let px = compute_pet_pixels(prefs.scale, self.work_area());
                let (l, t) = clamp_pet_position(
                    Some(start_left + dx),
                    Some(start_top + dy),
                    px,
                    self.work_area(),
                );
                prefs.left = Some(l);
                prefs.top = Some(t);
            }
        }
        self.snapshot()
    }

    pub fn end_drag(&self) -> Value {
        if let Ok(mut drag) = self.drag_origin.lock() {
            *drag = None;
        }
        if let Ok(mut prefs) = self.prefs.lock() {
            let area = self.work_area();
            prefs.monitor_x = Some(area.x);
            prefs.monitor_y = Some(area.y);
            self.save_prefs(&prefs);
        }
        self.snapshot()
    }

    pub fn begin_exit_prompt(&self, shared_runtime: bool) -> (String, Value) {
        self.clear_hit_regions();
        let id = Uuid::new_v4().to_string();
        if let Ok(mut exit) = self.exit_prompt.lock() {
            *exit = Some(PetExitPrompt {
                id: id.clone(),
                loading: true,
                unavailable: false,
                shared_runtime,
                personas: Vec::new(),
            });
        }
        (id, self.snapshot())
    }

    pub fn resolve_exit_info(&self, payload: &Value) -> Value {
        if let Ok(mut guard) = self.exit_prompt.lock() {
            if let Some(prompt) = guard.as_mut() {
                prompt.loading = false;
                prompt.unavailable = payload
                    .get("unavailable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                prompt.personas = sanitize_exit_personas(payload);
            }
        }
        self.snapshot()
    }

    pub fn mark_exit_info_unavailable(&self) -> Value {
        if let Ok(mut guard) = self.exit_prompt.lock() {
            if let Some(prompt) = guard.as_mut() {
                prompt.loading = false;
                prompt.unavailable = true;
            }
        }
        self.snapshot()
    }

    pub fn cancel_exit_prompt(&self) -> Value {
        self.clear_hit_regions();
        if let Ok(mut guard) = self.exit_prompt.lock() {
            *guard = None;
        }
        self.snapshot()
    }

    pub fn verify_exit_confirm(&self, id: &str) -> Result<(), String> {
        let guard = self
            .exit_prompt
            .lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        let Some(prompt) = guard.as_ref() else {
            return Err("退出确认已失效".to_string());
        };
        if prompt.id != id {
            return Err("退出确认 ID 不匹配".to_string());
        }
        if prompt.loading {
            return Err("正在检查分身状态，请稍候…".to_string());
        }
        Ok(())
    }

    pub fn set_permission_prompt(&self, prompt: Option<PetPermissionPrompt>) -> Value {
        self.clear_hit_regions();
        if let Ok(mut guard) = self.permission_prompt.lock() {
            *guard = prompt;
        }
        self.snapshot()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionBridgeRecord {
    pub port: u16,
    pub token: String,
}

/// Connects to `~/.keepwork-mcp/pet-permission-bridge.json` as `role: "desktop"`,
/// processes one or more screenshot permission requests via `handler(id, client) -> choice`,
/// and writes the decision back.
pub fn run_permission_bridge_session<F>(bridge_file: &Path, mut handler: F) -> Result<(), String>
where
    F: FnMut(&str, &str) -> String,
{
    let raw = fs::read_to_string(bridge_file)
        .map_err(|e| format!("Cannot read pet-permission-bridge.json: {e}"))?;
    let record: PermissionBridgeRecord = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid pet-permission-bridge.json: {e}"))?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], record.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1000))
        .map_err(|e| format!("Failed to connect to permission bridge: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let hello = json!({
        "type": "hello",
        "role": "desktop",
        "token": record.token,
    });
    stream
        .write_all(format!("{hello}\n").as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|e| format!("Failed to send hello: {e}"))?;

    let reader_stream = stream
        .try_clone()
        .map_err(|e| format!("Failed to clone stream: {e}"))?;
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                if msg.get("type").and_then(|v| v.as_str()) == Some("request") {
                    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let client = msg
                        .get("client")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Keepwork MCP");
                    let choice = handler(id, client);
                    let reply = json!({
                        "type": "response",
                        "id": id,
                        "choice": choice,
                    });
                    let _ = stream.write_all(format!("{reply}\n").as_bytes());
                    let _ = stream.flush();
                }
            }
        }
        line.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn command_controller() -> PetController {
        let controller = PetController::new(
            std::env::temp_dir().join(format!("aichat-pet-commands-{}.json", Uuid::new_v4())),
        );
        controller.update_raw_state(json!({ "context": "alice", "ready": true }));
        controller
    }

    #[test]
    fn only_new_media_capture_actions_need_a_visible_owner_page() {
        let ready = json!({
            "ready": true, "canCall": true, "compactVoice": true,
            "classroomRecording": { "enabled": false }
        });
        for action in ["dictation", "call", "voice-start", "record-start"] {
            assert!(starts_media_capture(&ready, action), "{action}");
            let mut offline = ready.clone();
            offline["ready"] = json!(false);
            assert!(!starts_media_capture(&offline, action), "offline {action}");
        }
        for action in [
            "input",
            "send",
            "stop",
            "mute",
            "hide",
            "state",
            "voice-stop",
            "record-stop",
            "toggle-target",
            "exit-info",
        ] {
            assert!(!starts_media_capture(&ready, action), "{action}");
        }
        let mut dictating = ready.clone();
        dictating["dictating"] = json!(true);
        let mut calling = ready.clone();
        calling["voice"] = json!({ "active": true });
        for action in ["dictation", "call", "voice-start", "record-start"] {
            assert!(
                !starts_media_capture(&dictating, action),
                "dictating {action}"
            );
            assert!(!starts_media_capture(&calling, action), "calling {action}");
        }
        let mut recording = ready.clone();
        recording["classroomRecording"]["enabled"] = json!(true);
        assert!(!starts_media_capture(&recording, "record-start"));
        assert!(!starts_media_capture(&recording, "dictation"));
        assert!(
            starts_media_capture(&json!({ "ready": true }), "dictation"),
            "legacy plain dictation remains available"
        );
        assert!(!starts_media_capture(&json!({ "ready": true }), "call"));
        assert!(!starts_media_capture(
            &json!({ "ready": true }),
            "record-start"
        ));
        let mut rich = ready.clone();
        rich["richDraft"] = json!(true);
        assert!(!starts_media_capture(&rich, "dictation"));
    }

    #[test]
    fn background_persona_call_requires_explicit_page_support() {
        let ready = json!({
            "ready": true, "canCall": true, "target": "persona",
            "petVoiceAudioVersion": 1
        });
        assert!(uses_pet_audio(&ready, "call"));
        assert!(uses_pet_audio(&ready, "dictation"));
        for action in ["mute", "voice-stop", "record-start", "voice-start"] {
            assert!(!uses_pet_audio(&ready, action), "{action}");
        }
        for version in [Value::Null, json!(0), json!(2), json!("1")] {
            let mut older = ready.clone();
            older["petVoiceAudioVersion"] = version;
            assert!(!uses_pet_audio(&older, "call"));
        }
        for (key, value) in [
            ("target", json!("chat")),
            ("ready", json!(false)),
            ("canCall", json!(false)),
            ("voice", json!({"active": true})),
            ("dictating", json!(true)),
        ] {
            let mut unsupported = ready.clone();
            unsupported[key] = value;
            assert!(!uses_pet_audio(&unsupported, "call"), "{key}");
        }
        let controller = command_controller();
        controller.update_raw_state(ready);
        assert!(uses_pet_audio(&controller.snapshot(), "call"));
    }

    #[test]
    fn native_pointer_hit_testing_recovers_without_renderer_mousemove() {
        let controller = command_controller();
        controller.set_work_area(WorkArea {
            x: -1280,
            y: -200,
            width: 1280,
            height: 800,
        });
        controller.update_hit_regions(
            &json!([
                {"id":"panel","left":700,"top":100,"width":348,"height":160},
                {"id":"bubble","left":700,"top":300,"width":348,"height":80}
            ]),
            controller.hit_regions_epoch(),
        );
        assert!(!controller.pointer_interactive(Some((-1200, -100)), false));
        controller.record_pointer_interactive(false);
        // Another app can be foreground throughout: native cursor movement
        // alone enables input when it re-enters a visible pet surface.
        assert!(controller.pointer_interactive(Some((-500, -50)), false));
        assert!(controller.pointer_needs_update(true));
        controller.record_pointer_interactive(true);
        assert!(!controller.pointer_needs_update(true));
        assert!(!controller.pointer_interactive(Some((-500, 80)), false)); // gap
        assert!(controller.pointer_interactive(Some((-500, 120)), false));
        controller.update_hit_regions(&json!([]), controller.hit_regions_epoch());
        assert!(!controller.pointer_interactive(Some((-500, 120)), false));
        let snap = controller.snapshot();
        let x = -1280 + snap["petLeft"].as_i64().unwrap() as i32 + 10;
        let y = -200 + snap["petTop"].as_i64().unwrap() as i32 + 10;
        assert!(controller.pointer_interactive(Some((x, y)), false));
        assert!(!controller.pointer_interactive(None, false));
    }

    #[test]
    fn pointer_hold_ends_on_release_or_hide_without_a_canvas_grace_period() {
        let controller = command_controller();
        let outside = Some((0, 0));
        controller.set_pointer_hold(true);
        assert!(controller.pointer_interactive(outside, true));
        assert!(!controller.pointer_interactive(outside, false));
        assert!(!controller.pointer_interactive(outside, true));
        controller.set_pointer_hold(true);
        controller.suspend_pointer_tracking();
        assert!(!controller.pointer_interactive(outside, true));
        controller.start_drag(100, 100);
        assert!(controller.pointer_interactive(outside, true));
        assert!(!controller.pointer_interactive(outside, false));
        controller.end_drag();
        assert!(!controller.pointer_interactive(outside, true));
        controller.start_drag(100, 100);
        controller.suspend_pointer_tracking();
        assert!(!controller.pointer_interactive(outside, true));
    }

    #[test]
    fn monitor_and_scale_changes_clear_old_surface_rectangles() {
        let controller = command_controller();
        let regions = json!([{"id":"panel","left":20,"top":20,"width":300,"height":100}]);
        let old_epoch = controller.hit_regions_epoch();
        controller.update_hit_regions(&regions, old_epoch);
        assert!(controller.pointer_interactive(Some((30, 30)), false));
        controller.set_work_area(WorkArea {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        });
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        controller.update_hit_regions(&regions, old_epoch);
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        controller.update_hit_regions(&regions, controller.hit_regions_epoch());
        assert!(controller.pointer_interactive(Some((-1890, 30)), false));
        controller.set_scale(2.0);
        assert!(!controller.pointer_interactive(Some((-1890, 30)), false));
        for scale in [1.0, 1.5, 2.0] {
            assert_eq!(
                physical_pet_cursor(
                    (-1920.0 + 30.0 * scale, 40.0 * scale),
                    (-1920.0, 0.0),
                    scale,
                    controller.work_area()
                ),
                Some((-1890, 40))
            );
        }
        assert!(physical_pet_cursor((0.0, 0.0), (0.0, 0.0), 0.0, controller.work_area()).is_none());
    }

    #[test]
    fn hit_region_validation_does_not_capture_transparent_or_unbounded_canvas() {
        let controller = command_controller();
        for regions in [
            json!([{"id":"stack","left":0,"top":0,"width":1400,"height":800}]),
            json!([{"id":"panel","left":0,"top":0,"width":999999,"height":999999}]),
            json!([{"id":"panel","left":0,"top":0,"width":0,"height":100}]),
            json!([{"id":"panel","left":0,"top":0,"width":100,"height":-1}]),
            json!([{"id":"panel","left":2000,"top":2000,"width":100,"height":100}]),
        ] {
            controller.update_hit_regions(&regions, controller.hit_regions_epoch());
            assert!(!controller.pointer_interactive(Some((10, 10)), false));
        }
        let invalid = PetHitRegion {
            id: "panel".into(),
            left: f64::NAN,
            top: 0.0,
            width: 100.0,
            height: 100.0,
        };
        assert!(invalid.clipped(controller.work_area()).is_none());
    }

    #[tokio::test]
    async fn commands_use_bridge_v1_and_wait_for_matching_page_acknowledgement() {
        let controller = command_controller();
        let (command, mut receiver) = controller
            .begin_command(
                "input",
                &json!({
                    "context": "alice", "text": "保留输入", "version": 99,
                    "requestId": "untrusted", "action": "send"
                }),
            )
            .unwrap();
        assert_eq!(command["version"], 1);
        assert_eq!(command["action"], "input");
        assert_eq!(command["context"], "alice");
        assert_eq!(command["text"], "保留输入");
        let request_id = command["requestId"].as_str().unwrap();
        assert_ne!(request_id, "untrusted");
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(!controller.resolve_command(&json!({ "requestId": "unknown", "ok": true })));

        // Published Bridge v1 pages publish their updated draft before petResult.
        controller
            .update_raw_state(json!({ "context": "alice", "ready": true, "draft": "保留输入" }));
        assert!(controller
            .resolve_command(&json!({ "requestId": request_id, "ok": true, "additive": 1 })));
        assert_eq!(
            controller
                .wait_for_command(request_id, receiver, Duration::from_secs(1))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(controller.snapshot()["draft"], "保留输入");
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        let (next, _) = controller
            .begin_command("send", &json!({ "context": "alice" }))
            .unwrap();
        assert_ne!(command["requestId"], next["requestId"]);
    }

    #[tokio::test]
    async fn rejected_or_unanswered_commands_fail_without_being_replayed() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "alice", "text": "草稿" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.resolve_command(
            &json!({ "requestId": request_id, "ok": false, "error": "无法修改输入" }),
        );
        assert_eq!(
            controller
                .wait_for_command(request_id, receiver, Duration::from_secs(1))
                .await
                .unwrap_err(),
            "无法修改输入"
        );

        let (command, receiver) = controller
            .begin_command("send", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_millis(1))
            .await
            .unwrap_err()
            .contains("检查结果"));
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        assert!(controller.page_state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn changing_context_or_reloading_cancels_pending_commands() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.update_raw_state(json!({ "context": "bob", "ready": true }));
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("会话已改变"));
        assert!(!controller.resolve_command(&json!({ "requestId": request_id, "ok": true })));
        assert!(controller
            .begin_command("send", &json!({ "context": "alice" }))
            .is_err());
        let (command, receiver) = controller
            .begin_command("input", &json!({ "context": "bob" }))
            .unwrap();
        controller.reset_state();
        assert!(controller
            .wait_for_command(
                command["requestId"].as_str().unwrap(),
                receiver,
                Duration::from_secs(1)
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn target_switch_ack_before_new_context_remains_successful() {
        let controller = command_controller();
        let (command, receiver) = controller
            .begin_command("toggle-target", &json!({ "context": "alice" }))
            .unwrap();
        let request_id = command["requestId"].as_str().unwrap();
        controller.resolve_command(&json!({ "requestId": request_id, "ok": true }));
        controller.update_raw_state(json!({ "context": "chat", "ready": true }));
        assert!(controller
            .wait_for_command(request_id, receiver, Duration::from_secs(1))
            .await
            .is_ok());
    }

    #[test]
    fn unavailable_or_legacy_pages_cannot_accept_remote_edits() {
        let controller = command_controller();
        for state in [
            json!({ "context": "alice", "ready": false }),
            json!({ "context": "alice" }),
        ] {
            controller.update_raw_state(state);
            assert!(controller
                .begin_command("input", &json!({ "context": "alice" }))
                .is_err());
            assert!(controller
                .begin_command("send", &json!({ "context": "alice" }))
                .is_err());
            assert!(controller
                .begin_command("exit-info", &json!({ "context": "alice" }))
                .is_ok());
            assert!(controller
                .begin_command("toggle-target", &json!({ "context": "alice" }))
                .is_ok());
        }
    }

    #[test]
    fn sanitizes_pet_state_clamps_bounds_and_handles_permission_bridge() {
        let root = std::env::temp_dir().join(format!("aichat-rust-pet-{}", Uuid::new_v4()));
        let controller = PetController::new(root.join("pet-prefs.json"));
        controller.set_work_area(WorkArea {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        });

        let state = controller.update_raw_state(json!({
            "context": "ctx-1",
            "ready": true,
            "pet": {
                "name": "小龙",
                "sheetUrl": "https://cdn.keepwork.com/maisi/pet.webp",
                "imageData": "javascript:alert(1)"
            },
            "messages": [
                { "role": "system", "text": "secret system prompt" },
                { "role": "user", "text": "你好" },
                { "role": "assistant", "text": "你好！我是你的第二大脑。" }
            ],
            "reply": {
                "text": "你好！我是你的第二大脑。",
                "options": [{ "icon": "✨", "text": "继续" }]
            }
        }));

        assert_eq!(state["version"], 1);
        assert_eq!(state["pet"]["imageData"], "");
        assert_eq!(
            state["pet"]["sheetUrl"],
            "https://cdn.keepwork.com/maisi/pet.webp"
        );
        assert_eq!(state["messages"].as_array().unwrap().len(), 2);

        // Test exit prompt lifecycle
        let (exit_id, exit_snap) = controller.begin_exit_prompt(false);
        assert_eq!(exit_snap["exitPrompt"]["loading"], true);
        assert!(controller.verify_exit_confirm(&exit_id).is_err());

        controller.resolve_exit_info(&json!({
            "personas": [{ "name": "工作助手", "channels": ["飞书", "钉钉"] }]
        }));
        assert!(controller.verify_exit_confirm(&exit_id).is_ok());

        // Test TCP permission bridge handshake
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let bridge_file = root.join("pet-permission-bridge.json");
        atomic_json_write(
            &bridge_file,
            &PermissionBridgeRecord {
                port,
                token: "secret-bridge-token".to_string(),
            },
        )
        .unwrap();

        let srv = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut hello_line = String::new();
            reader.read_line(&mut hello_line).unwrap();
            let hello: Value = serde_json::from_str(&hello_line).unwrap();
            assert_eq!(hello["role"], "desktop");
            assert_eq!(hello["token"], "secret-bridge-token");

            let req = json!({ "type": "request", "id": "req-1", "client": "AIChat Agent" });
            stream.write_all(format!("{req}\n").as_bytes()).unwrap();
            stream.flush().unwrap();

            let mut resp_line = String::new();
            reader.read_line(&mut resp_line).unwrap();
            let resp: Value = serde_json::from_str(&resp_line).unwrap();
            assert_eq!(resp["id"], "req-1");
            assert_eq!(resp["choice"], "once");
        });

        run_permission_bridge_session(&bridge_file, |id, client| {
            assert_eq!(id, "req-1");
            assert_eq!(client, "AIChat Agent");
            "once".to_string()
        })
        .unwrap();
        srv.join().unwrap();

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn native_drag_preserves_click_threshold_and_ignores_old_owners() {
        let controller = command_controller();
        let primary = WorkArea {
            x: 0,
            y: 0,
            width: 1710,
            height: 1107,
        };
        let upper = WorkArea {
            x: -458,
            y: -1080,
            width: 1920,
            height: 1080,
        };
        controller.set_work_area(primary);
        controller.note_canvas(primary);
        {
            let mut prefs = controller.prefs.lock().unwrap();
            prefs.left = Some(100);
            prefs.top = Some(100);
        }
        controller.begin_global_drag_with_id(156, 156, Some(1));
        let before = controller.placement();
        assert_eq!(controller.drag_global(160, 156, &[primary, upper]), None);
        assert_eq!(controller.placement(), before);
        assert!(!controller.drag_moved());
        controller.drag_global(161, 156, &[primary, upper]);
        assert!(controller.drag_moved());
        assert_eq!(controller.placement(), (primary, Some(105), Some(100)));
        assert_eq!(
            controller.drag_global(500, -200, &[primary, upper]),
            Some(upper)
        );
        controller.note_canvas(upper);
        let placed = controller.placement();
        let epoch = controller.hit_regions_epoch();
        assert_eq!(controller.drag_global(500, -200, &[primary, upper]), None);
        assert_eq!(controller.placement(), placed);
        assert_eq!(
            controller.hit_regions_epoch(),
            epoch,
            "stationary frames keep the current hit regions"
        );
        controller.end_drag();
        assert!(
            controller.drag_moved(),
            "the release frame remembers movement even without DOM pointermove"
        );
        assert!(controller.native_drag_tracking());
        assert_eq!(controller.drag_id(), Some(1));
        controller.begin_global_drag_with_id(500, -200, Some(2));
        assert!(
            !controller.owns_drag(Some(1)),
            "old drag/end requests cannot finish a new press"
        );
        assert!(controller.owns_drag(Some(2)));
        assert!(
            controller.owns_drag(None),
            "legacy renderers keep their historical request shape"
        );
        assert!(!controller.drag_moved());
        controller.end_drag();
    }

    #[test]
    fn monitor_gaps_choose_the_nearest_edge_and_keep_the_current_monitor_on_ties() {
        let wide = WorkArea {
            x: 0,
            y: 0,
            width: 4000,
            height: 1000,
        };
        let right = WorkArea {
            x: 4100,
            y: 0,
            width: 1000,
            height: 1000,
        };
        assert_eq!(monitor_at(&[wide, right], 4010, 100), Some(wide));
        assert_eq!(
            monitor_at_preferred(&[wide, right], 4050, 100, Some(wide)),
            Some(wide)
        );
        assert_eq!(
            monitor_at_preferred(&[wide, right], 4050, 100, Some(right)),
            Some(right)
        );
        assert_eq!(monitor_at(&[wide, right], 4090, 100), Some(right));
        assert_eq!(monitor_at(&[], 0, 0), None);
    }

    #[test]
    fn dragged_pet_crosses_onto_the_monitor_under_the_cursor() {
        let lower = WorkArea {
            x: 0,
            y: 0,
            width: 1710,
            height: 1107,
        };
        let upper = WorkArea {
            x: -458,
            y: -1440,
            width: 2560,
            height: 1440,
        };
        let monitors = [lower, upper];

        let (monitor, left, top) = place_dragged_pet(&monitors, 800, 40, 56, 56, 1.0).unwrap();
        assert_eq!(monitor, lower);
        assert_eq!((left, top), (744, 8));

        let (monitor, left, top) = place_dragged_pet(&monitors, 800, -100, 56, 56, 1.0).unwrap();
        assert_eq!(monitor, upper);
        assert_eq!((left, top), (1202, 1284));

        let (monitor, top_edge) = {
            let (monitor, left, top) = place_dragged_pet(&monitors, 100, -1, 56, 56, 1.0).unwrap();
            (monitor, (left, top))
        };
        assert_eq!(monitor, upper);
        assert_eq!(top_edge, (502, 1304));

        let root = std::env::temp_dir().join(format!("aichat-rust-pet-drag-{}", Uuid::new_v4()));
        let controller = PetController::new(root.join("pet-prefs.json"));
        controller.set_work_area(lower);
        controller.note_canvas(lower);
        controller.begin_global_drag(856, 456);
        assert_eq!(controller.drag_global(900, 500, &monitors), None);
        assert_eq!(controller.work_area(), lower);
        assert_eq!(controller.drag_global(800, -100, &monitors), Some(upper));
        assert_eq!(controller.work_area(), upper);
        let snap = controller.snapshot();
        let pet_left = snap["petLeft"].as_i64().unwrap();
        let pet_top = snap["petTop"].as_i64().unwrap();
        assert!(pet_left >= 8 && pet_left < upper.width as i64);
        assert!(pet_top >= 8 && pet_top < upper.height as i64);
        // A failed native commit must be retried, then a successful commit
        // allows subsequent same-monitor moves without another canvas resize.
        assert_eq!(controller.drag_global(820, -140, &monitors), Some(upper));
        assert_eq!(controller.pending_canvas(), Some(upper));
        controller.note_canvas(upper);
        assert_eq!(controller.pending_canvas(), None);
        assert_eq!(controller.drag_global(830, -150, &monitors), None);
        controller.end_drag();
        assert!(!controller.is_dragging());
        let saved = fs::read_to_string(root.join("pet-prefs.json")).unwrap();
        assert!(saved.contains("\"monitorX\": -458"));
        assert!(saved.contains("\"monitorY\": -1440"));
        let _ = fs::remove_dir_all(&root);
    }
}
