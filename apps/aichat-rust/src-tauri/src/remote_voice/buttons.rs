//! Device-scoped remote buttons. Ordinary keyboards never enter this queue.
use serde::Serialize;
use std::sync::Mutex;

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

pub struct Buttons {
    listener: Mutex<Option<platform::Listener>>,
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
        match platform::start() {
            Ok(active) => {
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
            listener.take();
            self.last_error.lock().unwrap().clear();
        }
    }

    pub fn poll_clear(&self) -> bool {
        self.listener
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(platform::poll_clear)
    }

    pub fn poll_home(&self) -> bool {
        self.listener
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(platform::poll_home)
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
        fn keepwork_remote_buttons_start() -> i32;
        fn keepwork_remote_buttons_stop();
        fn keepwork_remote_buttons_poll() -> bool;
        fn keepwork_remote_home_poll() -> bool;
        fn keepwork_remote_buttons_status(out: *mut Snapshot);
    }
    pub struct Listener;

    pub fn start() -> Result<Listener, String> {
        match unsafe { keepwork_remote_buttons_start() } {
            0 => Ok(Listener),
            1 => Err("另一个遥控器按键监听正在运行".into()),
            2 => Err(
                "请在系统设置 → 隐私与安全性 → 输入监控中允许 Keepwork，再重新启动语音输入".into(),
            ),
            _ => Err("无法启动设备限定的遥控器按键监听，语音口令仍可使用".into()),
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
    pub fn poll_home(listener: &Listener) -> bool {
        listener.poll()
    }
    pub fn poll_clear(listener: &Listener) -> bool {
        listener.poll_clear()
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
