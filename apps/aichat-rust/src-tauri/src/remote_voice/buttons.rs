//! Device-scoped remote buttons. Ordinary keyboards never enter this queue.
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ButtonAction {
    Clear,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonStatus {
    pub supported: bool,
    pub ready: bool,
    pub device: String,
    pub error: String,
}

pub struct Buttons {
    owned: Mutex<bool>,
    last_error: Mutex<String>,
}

impl Buttons {
    pub fn new() -> Self {
        Self {
            owned: Mutex::new(false),
            last_error: Mutex::new(String::new()),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let mut owned = self.owned.lock().map_err(|_| "遥控器按键状态不可用")?;
        if *owned {
            return Ok(());
        }
        if let Err(error) = platform::start() {
            if let Ok(mut last_error) = self.last_error.lock() {
                *last_error = error.clone();
            }
            return Err(error);
        }
        if let Ok(mut last_error) = self.last_error.lock() {
            last_error.clear();
        }
        *owned = true;
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut owned) = self.owned.lock() {
            if *owned {
                platform::stop();
                *owned = false;
            }
            if let Ok(mut last_error) = self.last_error.lock() {
                last_error.clear();
            }
        }
    }

    pub fn poll(&self) -> Option<ButtonAction> {
        let owned = self.owned.lock().ok()?;
        if *owned && platform::poll() {
            Some(ButtonAction::Clear)
        } else {
            None
        }
    }

    pub fn status(&self) -> ButtonStatus {
        let owned = self.owned.lock().map(|value| *value).unwrap_or(false);
        if owned {
            platform::status()
        } else {
            let last_error = self
                .last_error
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            ButtonStatus {
                supported: cfg!(target_os = "macos"),
                ready: false,
                device: String::new(),
                error: if !last_error.is_empty() {
                    last_error
                } else if cfg!(target_os = "macos") {
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

impl Drop for Buttons {
    fn drop(&mut self) {
        self.stop();
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
    }
    #[link(name = "IOKit", kind = "framework")]
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn keepwork_remote_buttons_start() -> i32;
        fn keepwork_remote_buttons_stop();
        fn keepwork_remote_buttons_poll() -> bool;
        fn keepwork_remote_buttons_status(out: *mut Snapshot);
    }
    pub fn start() -> Result<(), String> {
        match unsafe { keepwork_remote_buttons_start() } {
            0 => Ok(()),
            1 => Err("另一个遥控器按键监听正在运行".into()),
            2 => Err(
                "请在系统设置 → 隐私与安全性 → 输入监控中允许 Keepwork，再重新启动语音输入".into(),
            ),
            _ => Err("无法启动设备限定的遥控器按键监听，语音口令仍可使用".into()),
        }
    }
    pub fn stop() {
        unsafe {
            keepwork_remote_buttons_stop();
        }
    }
    pub fn poll() -> bool {
        unsafe { keepwork_remote_buttons_poll() }
    }
    pub fn status() -> ButtonStatus {
        let mut out = Snapshot {
            code: 0,
            ready: 0,
            registry: 0,
            device: [0; 128],
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

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::ButtonStatus;
    pub fn start() -> Result<(), String> {
        Err("当前平台无法安全接管遥控器返回键，可说“清除提示词”；OK 键保持系统原生回车。".into())
    }
    pub fn stop() {}
    pub fn poll() -> bool {
        false
    }
    pub fn status() -> ButtonStatus {
        ButtonStatus {
            supported: false,
            ready: false,
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
        assert_eq!(buttons.poll(), None);
        assert!(!buttons.status().ready);
        buttons.stop();
        assert_eq!(buttons.poll(), None);
    }
    #[test]
    fn unsupported_platform_never_installs_a_keyboard_hook() {
        #[cfg(not(target_os = "macos"))]
        {
            let buttons = Buttons::new();
            assert!(buttons.start().is_err());
            assert!(!buttons.status().supported);
            assert_eq!(buttons.poll(), None);
        }
    }
}
