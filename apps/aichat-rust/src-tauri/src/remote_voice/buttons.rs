//! Device-scoped remote buttons. Ordinary keyboards never enter this queue.
use serde::Serialize;
use std::sync::{Arc, Mutex, Weak};

#[cfg(any(target_os = "macos", windows))]
#[path = "directions.rs"]
pub(crate) mod directions;

#[cfg(any(target_os = "macos", windows))]
mod feedback {
    use std::collections::VecDeque;
    use std::sync::{Mutex, OnceLock};
    use tokio::sync::watch;

    const LIMIT: usize = 32;

    #[derive(Default)]
    struct States {
        current: Vec<String>,
        pending: VecDeque<Vec<String>>,
    }

    impl States {
        fn record(&mut self, keys: Vec<String>) -> bool {
            if self.current == keys {
                return false;
            }
            self.current.clone_from(&keys);
            if self.pending.len() == LIMIT {
                self.pending.pop_front();
            }
            self.pending.push_back(keys);
            true
        }

        fn take(&mut self) -> Vec<Vec<String>> {
            if self.pending.is_empty() {
                return vec![self.current.clone()];
            }
            self.pending.drain(..).collect()
        }
    }

    fn source() -> &'static (Mutex<States>, watch::Sender<()>) {
        static SOURCE: OnceLock<(Mutex<States>, watch::Sender<()>)> = OnceLock::new();
        SOURCE.get_or_init(|| (Mutex::new(States::default()), watch::channel(()).0))
    }

    pub(in super::super) fn record(keys: Vec<String>) {
        super::directions::record(&keys);
        #[cfg(target_os = "macos")]
        super::demo_keys::notify(&keys);
        let (states, wake) = source();
        if states.lock().unwrap().record(keys) {
            wake.send_replace(());
        }
    }

    pub(in super::super) fn changes() -> watch::Receiver<()> {
        source().1.subscribe()
    }

    pub(super) fn take() -> Vec<Vec<String>> {
        source().0.lock().unwrap().take()
    }

    pub(super) fn reset() {
        *source().0.lock().unwrap() = States::default();
    }

    #[cfg(test)]
    #[test]
    fn short_presses_keep_both_edges_and_overflow_keeps_latest_state() {
        let mut states = States::default();
        let down = vec!["left".to_owned()];
        assert!(states.record(down.clone()));
        assert!(!states.record(down.clone()));
        assert!(states.record(Vec::new()));
        assert_eq!(states.take(), vec![down.clone(), Vec::new()]);
        for _ in 0..LIMIT {
            states.record(down.clone());
            states.record(Vec::new());
        }
        let retained = states.take();
        assert_eq!(retained.len(), LIMIT);
        assert!(retained.last().unwrap().is_empty());
        assert_eq!(states.take(), vec![Vec::<String>::new()]);
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(super) use feedback::{changes as activity_changes, record as record_activity};
#[cfg(windows)]
pub(super) use directions::source_changed;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonStatus {
    pub supported: bool,
    pub ready: bool,
    pub home_ready: bool,
    pub clear_key: String,
    pub device: String,
    pub error: String,
}

fn default_clear_key() -> String {
    if cfg!(target_os = "macos") {
        "返回键".into()
    } else if cfg!(windows) {
        "菜单键".into()
    } else {
        String::new()
    }
}

// Dictation and the Bumi window may observe the same physical device. The last
// consumer releases the native registration. Each has its own event queue.
fn shared_listener() -> Result<Arc<platform::Listener>, String> {
    static NATIVE: Mutex<Weak<platform::Listener>> = Mutex::new(Weak::new());
    let mut active = NATIVE.lock().unwrap();
    if let Some(listener) = active.upgrade() {
        return Ok(listener);
    }
    let listener = Arc::new(platform::start()?);
    *active = Arc::downgrade(&listener);
    Ok(listener)
}

// Hold the same passive, device-scoped HID registration while the diagram
// is open, including when dictation is stopped. Do not consume its tap queue.
#[cfg(target_os = "macos")]
pub(crate) mod demo_keys {
    use super::{platform, shared_listener};
    use std::sync::{Arc, Mutex, Weak};

    type Callback = dyn Fn(&[String]) + Send + Sync;
    static SUBSCRIBER: Mutex<Option<Weak<Callback>>> = Mutex::new(None);

    pub(crate) struct Subscription {
        _listener: Arc<platform::Listener>,
        _callback: Arc<Callback>,
    }

    pub(crate) fn subscribe(callback: Arc<Callback>) -> Result<Subscription, String> {
        let listener = shared_listener()?;
        *SUBSCRIBER.lock().unwrap() = Some(Arc::downgrade(&callback));
        Ok(Subscription { _listener: listener, _callback: callback })
    }

    pub(super) fn notify(keys: &[String]) {
        let callback = SUBSCRIBER.lock().unwrap().as_ref().and_then(Weak::upgrade);
        if let Some(callback) = callback {
            callback(keys);
        }
    }
}

pub struct Buttons {
    listener: Mutex<Option<Arc<platform::Listener>>>,
    last_error: Mutex<String>,
}

impl Buttons {
    pub fn new() -> Self {
        Self {
            listener: Mutex::new(None),
            last_error: Mutex::new(String::new()),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let mut listener = self.listener.lock().map_err(|_| "遥控器按键状态不可用")?;
        if listener.is_some() {
            return Ok(());
        }
        match shared_listener() {
            Ok(active) => {
                // Discard Home/Back taps from a preceding Bumi-only session.
                platform::set_demo_mode(&active, true);
                platform::set_demo_mode(&active, false);
                *listener = Some(active);
                self.last_error.lock().unwrap().clear();
                Ok(())
            }
            Err(error) => {
                *self.last_error.lock().unwrap() = error.clone();
                Err(error)
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut listener) = self.listener.lock() {
            if let Some(active) = listener.take() {
                drop(active);
                #[cfg(any(target_os = "macos", windows))]
                feedback::reset();
            }
            self.last_error.lock().unwrap().clear();
        }
    }

    pub fn poll_clear(&self) -> bool {
        self.listener
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|listener| platform::poll_clear(listener))
    }

    pub fn poll_home(&self) -> bool {
        self.listener
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|listener| platform::poll_home(listener))
    }

    pub fn take_pressed_states(&self) -> Vec<Vec<String>> {
        #[cfg(any(target_os = "macos", windows))]
        if self.listener.lock().unwrap().is_some() {
            return feedback::take();
        }
        vec![Vec::new()]
    }

    pub fn set_demo_mode(&self, active: bool) {
        if let Some(listener) = self.listener.lock().unwrap().as_ref() {
            platform::set_demo_mode(listener, active);
        }
    }

    pub fn status(&self) -> ButtonStatus {
        if let Some(listener) = self.listener.lock().unwrap().as_ref() {
            platform::status(listener)
        } else {
            let last_error = self
                .last_error
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            ButtonStatus {
                supported: cfg!(any(target_os = "macos", windows)),
                ready: false,
                home_ready: false,
                clear_key: default_clear_key(),
                device: String::new(),
                error: if !last_error.is_empty() {
                    last_error
                } else if cfg!(any(target_os = "macos", windows)) {
                    String::new()
                } else {
                    "当前平台未接管遥控器清空键，可说“清除提示词”；OK 键保持系统原生回车。".into()
                },
            }
        }
    }
}

impl Default for Buttons {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ButtonStatus;
    use std::ffi::{c_char, CStr};
    #[repr(C)]
    struct Snapshot {
        code: u32,
        ready: u32,
        registry: u64,
        device: [c_char; 128],
        home_ready: u32,
    }
    #[link(name = "IOKit", kind = "framework")]
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn keepwork_remote_buttons_start(report: extern "C" fn(u32), changed: extern "C" fn()) -> i32;
        fn keepwork_remote_buttons_stop();
        fn keepwork_remote_buttons_poll() -> bool;
        fn keepwork_remote_home_poll() -> bool;
        fn keepwork_remote_buttons_set_demo_mode(active: bool);
        fn keepwork_remote_directions_released() -> bool;
        fn keepwork_remote_buttons_status(out: *mut Snapshot);
    }
    pub struct Listener;

    pub(super) fn directions_released(_: &Listener) -> bool {
        unsafe { keepwork_remote_directions_released() }
    }

    pub fn start() -> Result<Listener, String> {
        match unsafe { keepwork_remote_buttons_start(report_pressed_keys, report_source_change) } {
            0 => Ok(Listener),
            1 => Err("另一个遥控器按键监听正在运行".into()),
            2 => Err(
                "请在系统设置 → 隐私与安全性 → 输入监控中允许 Keepwork，授权后重新开启按键监听".into(),
            ),
            _ => Err("无法启动设备限定的遥控器按键监听，请检查系统输入权限后重试".into()),
        }
    }
    impl Drop for Listener {
        fn drop(&mut self) {
            unsafe { keepwork_remote_buttons_stop() };
        }
    }
    pub fn poll_home(_: &Listener) -> bool {
        unsafe { keepwork_remote_home_poll() }
    }
    pub fn poll_clear(_: &Listener) -> bool {
        unsafe { keepwork_remote_buttons_poll() }
    }
    pub fn set_demo_mode(_: &Listener, active: bool) {
        unsafe { keepwork_remote_buttons_set_demo_mode(active) };
    }
    extern "C" fn report_source_change() {
        super::directions::source_changed();
    }

    extern "C" fn report_pressed_keys(mask: u32) {
        super::record_activity(pressed_keys(mask));
    }

    fn pressed_keys(mask: u32) -> Vec<String> {
        // Bit order follows RemoteButton in buttons_macos.m.
        [
            (1 << 0, "back"), (1 << 1, "home"), (1 << 2, "menu"),
            (1 << 3, "up"), (1 << 4, "down"), (1 << 5, "left"),
            (1 << 6, "right"), (1 << 7, "ok"), (0b111 << 8, "volume"),
            (1 << 11, "power"),
        ]
        .into_iter()
        .filter(|(bits, _)| mask & bits != 0)
        .map(|(_, key)| key.into())
        .collect()
    }

    #[cfg(test)]
    #[test]
    fn direction_reports_never_share_a_hotspot() {
        assert_eq!(pressed_keys(1 << 3), ["up"]);
        assert_eq!(pressed_keys(1 << 4), ["down"]);
        assert_eq!(pressed_keys(1 << 5), ["left"]);
        assert_eq!(pressed_keys(1 << 6), ["right"]);
        assert_eq!(pressed_keys(1 << 7), ["ok"]);
        assert_eq!(pressed_keys((1 << 3) | (1 << 6)), ["up", "right"]);
        assert!(pressed_keys(0).is_empty());
    }
    pub fn status(_: &Listener) -> ButtonStatus {
        let mut out = Snapshot {
            code: 0,
            ready: 0,
            registry: 0,
            device: [0; 128],
            home_ready: 0,
        };
        unsafe {
            keepwork_remote_buttons_status(&mut out);
        }
        let device = unsafe { CStr::from_ptr(out.device.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        ButtonStatus {
            supported: true,
            ready: out.ready != 0,
            home_ready: out.home_ready != 0,
            clear_key: "返回键".into(),
            device,
            error: match out.code {
                0 | 1 => "",
                2 => "未找到唯一的 RC003 蓝牙键盘，清空键暂不可用；可说“清除提示词”。",
                3 => "发现多个无法确认是同一只遥控器的键盘服务，已禁用清空键；请只连接一只遥控器后重启。",
                4 => "输入监控授权不可用，清空键已停用；请检查系统权限后重启。",
                5 => "无法打开遥控器 HID 监听，清空键已停用；可说“清除提示词”。",
                6 => "遥控器按键来源已变化，清空键已停用；请重新启动语音输入。",
                7 => "遥控器按键队列已满，已停止清空操作；请重新启动语音输入。",
                9 => "清空按键等待过久，已丢弃这次操作；请确认光标后重新短按返回键。",
                10 => "启动时返回键尚未释放或状态未知，请先松开返回键，再重新短按。",
                _ => "遥控器 HID 输入异常，清空键已停用；可说“清除提示词”。",
            }.into(),
        }
    }
}

#[cfg(windows)]
mod platform {
    pub(super) use super::super::home_windows::HomeListener as Listener;
    use super::ButtonStatus;

    pub fn start() -> Result<Listener, String> {
        Listener::start()
    }
    pub(super) fn directions_released(listener: &Listener) -> bool {
        listener.directions_released()
    }
    pub fn poll_home(listener: &Listener) -> bool {
        listener.poll()
    }
    pub fn poll_clear(listener: &Listener) -> bool {
        listener.poll_clear()
    }
    pub fn set_demo_mode(listener: &Listener, active: bool) {
        listener.set_demo_mode(active);
    }
    pub fn status(listener: &Listener) -> ButtonStatus {
        listener.status()
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::ButtonStatus;
    pub struct Listener;
    pub fn start() -> Result<Listener, String> {
        Err("当前平台不支持遥控器按键。".into())
    }
    pub fn poll_home(_: &Listener) -> bool {
        false
    }
    pub fn poll_clear(_: &Listener) -> bool {
        false
    }
    pub fn set_demo_mode(_: &Listener, _: bool) {}
    pub fn status(_listener: &Listener) -> ButtonStatus {
        ButtonStatus {
            supported: false,
            ready: false,
            home_ready: false,
            clear_key: String::new(),
            device: String::new(),
            error: "当前平台不支持遥控器清空键。".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inactive_buttons_have_no_action_and_no_native_listener() {
        let buttons = Buttons::new();
        assert!(!buttons.poll_clear());
        assert!(!buttons.poll_home());
        assert!(!buttons.status().ready);
        buttons.stop();
        assert!(!buttons.poll_clear());
        assert!(!buttons.poll_home());
    }
    #[test]
    fn unsupported_platform_never_installs_a_keyboard_hook() {
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let buttons = Buttons::new();
            assert!(buttons.start().is_err());
            assert!(!buttons.status().supported);
            assert!(!buttons.poll_clear());
            assert!(!buttons.poll_home());
        }
    }
}
