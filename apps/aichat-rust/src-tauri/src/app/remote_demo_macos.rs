use crate::remote_voice::buttons::demo_keys;
use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use tauri::WebviewWindow;

type Reporter = Arc<dyn Fn(&'static str, bool) + Send + Sync>;

const DEVICE_KEYS: [&str; 3] = ["home", "menu", "power"];

#[derive(Default)]
struct Held {
    device: [bool; DEVICE_KEYS.len()],
    quartz: [bool; DEVICE_KEYS.len()],
}

impl Held {
    fn update(slot: &mut bool, other: bool, down: bool) -> bool {
        let changed = *slot != down;
        *slot = down;
        changed && !other
    }

    fn device_edge(&mut self, index: usize, down: bool) -> bool {
        Self::update(&mut self.device[index], self.quartz[index], down)
    }

    fn quartz_edge(&mut self, index: usize, down: bool) -> bool {
        Self::update(&mut self.quartz[index], self.device[index], down)
    }
}

pub(super) struct Guard {
    token: u64,
    _reporter: Box<Reporter>,
    _device: demo_keys::Subscription,
}

extern "C" {
    fn keepwork_remote_demo_start(
        window: *mut c_void,
        report: extern "C" fn(*mut c_void, u32, bool),
        context: *mut c_void,
        token: &mut u64,
    ) -> i32;
    fn keepwork_remote_demo_stop(token: u64);
}

extern "C" fn report_control(context: *mut c_void, control: u32, down: bool) {
    // Matches DemoControl in demo_input_macos.m. Native events and user text
    // never cross this boundary.
    let key = match control {
        1 => "up",
        2 => "down",
        3 => "left",
        4 => "right",
        5 => "back",
        6 => "home",
        7 => "menu",
        8 => "volume",
        9 => "ok",
        10 => "unavailable",
        11 => "ended",
        12 => "power",
        13 => "voice",
        _ => return,
    };
    let report = unsafe { &*context.cast::<Reporter>() };
    report(key, down);
}

impl Guard {
    pub(super) fn start(window: &WebviewWindow, report: Reporter) -> Result<Self, String> {
        let window = window.ns_window().map_err(|error| error.to_string())?;
        // A single press can arrive from both Quartz and the device. Keep it
        // highlighted until both release, including overlapping Home + Menu.
        let held = Arc::new(Mutex::new(Held::default()));
        let raw_report = Arc::clone(&report);
        let raw_held = Arc::clone(&held);
        let device = demo_keys::subscribe(Arc::new(move |keys| {
            let mut held = raw_held.lock().unwrap();
            for (index, key) in DEVICE_KEYS.iter().copied().enumerate() {
                let down = keys.iter().any(|pressed| pressed == key);
                if held.device_edge(index, down) {
                    raw_report(key, down);
                }
            }
        }))?;
        let quartz: Reporter = Arc::new(move |key, down| {
            if let Some(index) = DEVICE_KEYS.iter().position(|name| *name == key) {
                let mut held = held.lock().unwrap();
                if held.quartz_edge(index, down) {
                    report(key, down);
                }
            } else {
                report(key, down);
            }
        });
        let mut reporter = Box::new(quartz);
        let mut token = 0;
        let context = (&mut *reporter as *mut Reporter).cast();
        let result =
            unsafe { keepwork_remote_demo_start(window, report_control, context, &mut token) };
        match result {
            0 => Ok(Self { token, _reporter: reporter, _device: device }),
            1 => Err("演示图解需要辅助功能权限。请在系统设置 → 隐私与安全性 → 辅助功能中允许 Keepwork 后重试。".into()),
            2 => Err("演示图解需要输入监控权限。请在系统设置 → 隐私与安全性 → 输入监控中允许 Keepwork 后重试。".into()),
            3 => Err("请先点击遥控器语音输入窗口，再进入演示。".into()),
            _ => Err("macOS 无法拦截演示窗口的系统按键。请检查 Keepwork 的辅助功能和输入监控权限后重试。".into()),
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        unsafe { keepwork_remote_demo_stop(self.token) };
    }
}

#[cfg(test)]
mod tests {
    use super::Held;

    #[test]
    fn overlapping_device_and_quartz_reports_release_each_hotspot_once() {
        let mut held = Held::default();
        assert!(held.device_edge(0, true));
        assert!(!held.quartz_edge(0, true));
        assert!(held.device_edge(1, true));
        assert!(!held.device_edge(0, false));
        assert!(held.quartz_edge(0, false));
        assert!(!held.quartz_edge(0, false));
        assert!(held.device_edge(1, false));
    }
}
