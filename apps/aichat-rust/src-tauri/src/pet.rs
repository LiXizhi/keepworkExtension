use crate::files::atomic_json_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

pub const MAX_PET_INPUT_CHARS: usize = 32_000;
pub const MAX_PET_IMAGE_DATA_BYTES: usize = 8 * 1024 * 1024;
pub const ALLOWED_SCALES: &[f64] = &[0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PetPreferences {
    pub appearance: String,
    pub scale: f64,
    pub left: Option<i32>,
    pub top: Option<i32>,
}

impl Default for PetPreferences {
    fn default() -> Self {
        Self {
            appearance: "follow".to_string(),
            scale: 1.0,
            left: None,
            top: None,
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

pub struct PetController {
    prefs_path: PathBuf,
    raw_state: Mutex<Value>,
    expanded: Mutex<bool>,
    prefs: Mutex<PetPreferences>,
    work_area: Mutex<WorkArea>,
    exit_prompt: Mutex<Option<PetExitPrompt>>,
    permission_prompt: Mutex<Option<PetPermissionPrompt>>,
    drag_origin: Mutex<Option<(i32, i32, i32, i32)>>,
}

impl PetController {
    pub fn new(prefs_path: PathBuf) -> Self {
        let prefs = Self::load_prefs(&prefs_path);
        Self {
            prefs_path,
            raw_state: Mutex::new(json!({})),
            expanded: Mutex::new(false),
            prefs: Mutex::new(prefs),
            work_area: Mutex::new(WorkArea::default()),
            exit_prompt: Mutex::new(None),
            permission_prompt: Mutex::new(None),
            drag_origin: Mutex::new(None),
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
            *w = area;
        }
    }

    pub fn work_area(&self) -> WorkArea {
        self.work_area.lock().map(|w| *w).unwrap_or_default()
    }

    pub fn snapshot(&self) -> Value {
        let raw = self
            .raw_state
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| json!({}));
        let expanded = self.expanded.lock().map(|g| *g).unwrap_or(false);
        let prefs = self.prefs.lock().map(|g| g.clone()).unwrap_or_default();
        let area = self.work_area();
        let exit = self.exit_prompt.lock().ok().and_then(|g| g.clone());
        let perm = self.permission_prompt.lock().ok().and_then(|g| g.clone());
        sanitize_pet_state(&raw, expanded, &prefs, area, exit.as_ref(), perm.as_ref())
    }

    pub fn update_raw_state(&self, next: Value) -> Value {
        if let Ok(mut guard) = self.raw_state.lock() {
            *guard = next;
        }
        self.snapshot()
    }

    pub fn reset_state(&self) -> Value {
        if let Ok(mut guard) = self.raw_state.lock() {
            *guard = json!({});
        }
        if let Ok(mut exp) = self.expanded.lock() {
            *exp = false;
        }
        self.snapshot()
    }

    pub fn set_expanded(&self, value: bool) -> Value {
        if let Ok(mut exp) = self.expanded.lock() {
            *exp = value;
        }
        self.snapshot()
    }

    pub fn set_scale(&self, scale: f64) -> Value {
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
        let snap = self.snapshot();
        let pet_left = snap["petLeft"].as_i64().unwrap_or(0) as i32;
        let pet_top = snap["petTop"].as_i64().unwrap_or(0) as i32;
        if let Ok(mut drag) = self.drag_origin.lock() {
            *drag = Some((cursor_x, cursor_y, pet_left, pet_top));
        }
    }

    pub fn update_drag(&self, cursor_x: i32, cursor_y: i32) -> Value {
        let origin = self.drag_origin.lock().ok().and_then(|g| *g);
        if let Some((start_x, start_y, start_left, start_top)) = origin {
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
        if let Ok(prefs) = self.prefs.lock() {
            self.save_prefs(&prefs);
        }
        self.snapshot()
    }

    pub fn begin_exit_prompt(&self, shared_runtime: bool) -> (String, Value) {
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
        if let Ok(mut guard) = self.exit_prompt.lock() {
            *guard = None;
        }
        self.snapshot()
    }

    pub fn verify_exit_confirm(&self, id: &str) -> Result<(), String> {
        let guard = self.exit_prompt.lock().map_err(|_| "Lock poisoned".to_string())?;
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
pub fn run_permission_bridge_session<F>(
    bridge_file: &Path,
    mut handler: F,
) -> Result<(), String>
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
        assert_eq!(state["pet"]["sheetUrl"], "https://cdn.keepwork.com/maisi/pet.webp");
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
}
