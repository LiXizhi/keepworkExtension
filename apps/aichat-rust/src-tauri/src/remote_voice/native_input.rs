//! Native, opt-in voice input. No shell, executable helper or renderer text API.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    Pasted,
    Submitted,
    Cleared,
    NotEditable,
    Cancelled,
    ModifiersHeld,
}

/// Paste and Enter use current focus without an accessibility snapshot.
/// Clear alone must confirm that current focus is an editable text control.
pub(crate) trait DeliveryBackend {
    fn modifiers_down(&self) -> bool;
    fn copy(&self, text: &str) -> Result<(), String>;
    fn paste(&self) -> Result<(), String>;
    fn submit(&self) -> Result<(), String>;
    fn clear(&self) -> Result<bool, String>;
}

pub(crate) fn is_submit_command(text: &str) -> bool {
    is_command(text, "发送提示词")
}
fn is_command(text: &str, command: &str) -> bool {
    text.trim().trim_end_matches(|ch: char| {
        ch.is_whitespace() || matches!(ch, '。' | '．' | '.' | '！' | '!' | '？' | '?')
    }) == command
}

pub(crate) fn clear_current(
    enabled: &AtomicBool,
    backend: &impl DeliveryBackend,
) -> Result<Delivery, String> {
    if !enabled.load(Ordering::Acquire) {
        return Ok(Delivery::Cancelled);
    }
    if backend.modifiers_down() {
        return Ok(Delivery::ModifiersHeld);
    }
    if !enabled.load(Ordering::Acquire) {
        return Ok(Delivery::Cancelled);
    }
    Ok(if backend.clear()? { Delivery::Cleared } else { Delivery::NotEditable })
}

pub(crate) fn deliver_current(
    enabled: &AtomicBool,
    backend: &impl DeliveryBackend,
    text: &str,
) -> Result<Delivery, String> {
    if !enabled.load(Ordering::Acquire) || text.trim().is_empty() {
        return Ok(Delivery::Cancelled);
    }
    if text.len() > 64_000 || text.contains('\0') {
        return Err("识别文字超出长度限制或包含无效字符".into());
    }
    if backend.modifiers_down() {
        return Ok(Delivery::ModifiersHeld);
    }
    if !enabled.load(Ordering::Acquire) {
        return Ok(Delivery::Cancelled);
    }
    if is_command(text, "清除提示词") {
        return clear_current(enabled, backend);
    }
    // Only the complete final utterance is a command. Quotes and embedded or
    // suffixed occurrences remain ordinary dictation, without any submission.
    if is_submit_command(text) {
        if backend.modifiers_down() {
            return Ok(Delivery::ModifiersHeld);
        }
        if !enabled.load(Ordering::Acquire) {
            return Ok(Delivery::Cancelled);
        }
        backend.submit()?;
        return Ok(Delivery::Submitted);
    }
    backend.copy(text)?;
    if !enabled.load(Ordering::Acquire) {
        return Ok(Delivery::Cancelled);
    }
    // A modifier may have been pressed while acquiring the clipboard. Do not
    // combine it with the paste gesture or replay an uncertain mutation.
    if backend.modifiers_down() {
        return Ok(Delivery::ModifiersHeld);
    }
    if !enabled.load(Ordering::Acquire) {
        return Ok(Delivery::Cancelled);
    }
    backend.paste()?;
    Ok(Delivery::Pasted)
}

pub struct NativeInput {
    enabled: AtomicBool,
    gate: Mutex<()>,
    platform: platform::Input,
}

impl NativeInput {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            enabled: AtomicBool::new(false),
            gate: Mutex::new(()),
            platform: platform::Input::new()?,
        })
    }

    /// Reserve F5 only after the native ATVV session is ready.
    pub fn start(&self) -> Result<(), String> {
        let _gate = self.gate.lock().map_err(|_| "系统输入状态不可用")?;
        if self.enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        self.platform.start()?;
        self.enabled.store(true, Ordering::Release);
        Ok(())
    }

    pub fn stop(&self) {
        // Revoke before acquiring the gate; a pending delivery must not begin.
        self.enabled.store(false, Ordering::Release);
        if let Ok(_gate) = self.gate.lock() {
            self.enabled.store(false, Ordering::Release);
            self.platform.stop();
        }
    }

    pub fn deliver(&self, text: &str) -> Result<Delivery, String> {
        let _gate = self.gate.lock().map_err(|_| "系统输入状态不可用")?;
        deliver_current(&self.enabled, &self.platform, text)
    }
    pub fn clear(&self) -> Result<Delivery, String> {
        let _gate = self.gate.lock().map_err(|_| "系统输入状态不可用")?;
        clear_current(&self.enabled, &self.platform)
    }
}

impl Drop for NativeInput {
    fn drop(&mut self) {
        self.stop();
    }
}

impl DeliveryBackend for platform::Input {
    fn modifiers_down(&self) -> bool {
        self.modifiers_down()
    }
    fn copy(&self, text: &str) -> Result<(), String> {
        self.copy(text)
    }
    fn paste(&self) -> Result<(), String> {
        self.paste()
    }
    fn submit(&self) -> Result<(), String> {
        self.submit()
    }
    fn clear(&self) -> Result<bool, String> {
        self.clear()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_char;
    use std::sync::Mutex;

    #[link(name = "AppKit", kind = "framework")]
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn keepwork_voice_input_start() -> i32;
        fn keepwork_voice_input_stop();
        fn keepwork_voice_input_modifiers() -> bool;
        fn keepwork_voice_input_copy(bytes: *const c_char, len: usize) -> bool;
        fn keepwork_voice_input_paste() -> bool;
        fn keepwork_voice_input_submit() -> bool;
        fn keepwork_voice_input_clear() -> i32;
    }

    // The native event tap is process-wide; only the owning object may stop it.
    pub struct Input {
        owned: Mutex<bool>,
    }
    impl Input {
        pub fn new() -> Result<Self, String> {
            Ok(Self {
                owned: Mutex::new(false),
            })
        }
        pub fn start(&self) -> Result<(), String> {
            let mut owned = self.owned.lock().map_err(|_| "语音键状态不可用")?;
            if *owned {
                return Ok(());
            }
            let result = unsafe { keepwork_voice_input_start() };
            if result == 0 {
                *owned = true;
                return Ok(());
            }
            Err(match result {
                1 => "请在系统设置 → 隐私与安全性 → 辅助功能中允许 Keepwork，然后重新启动语音输入",
                2 => "请在系统设置 → 隐私与安全性 → 输入监控中允许 Keepwork，然后重新启动语音输入",
                3 => "另一个遥控器语音会话正在使用 F5",
                _ => "无法启动系统语音键监听，请检查辅助功能和输入监控权限",
            }
            .into())
        }
        pub fn stop(&self) {
            if let Ok(mut owned) = self.owned.lock() {
                if *owned {
                    unsafe { keepwork_voice_input_stop() };
                    *owned = false;
                }
            }
        }
        pub fn modifiers_down(&self) -> bool {
            unsafe { keepwork_voice_input_modifiers() }
        }
        pub fn copy(&self, text: &str) -> Result<(), String> {
            if unsafe { keepwork_voice_input_copy(text.as_ptr().cast(), text.len()) } {
                Ok(())
            } else {
                Err("无法写入系统剪贴板；未执行粘贴".into())
            }
        }
        pub fn paste(&self) -> Result<(), String> {
            if unsafe { keepwork_voice_input_paste() } {
                Ok(())
            } else {
                Err("无法发送系统粘贴，请检查辅助功能权限；不会自动重试".into())
            }
        }
        pub fn submit(&self) -> Result<(), String> {
            if unsafe { keepwork_voice_input_submit() } {
                Ok(())
            } else {
                Err("无法发送回车，请检查辅助功能权限；不会自动重试".into())
            }
        }
        pub fn clear(&self) -> Result<bool, String> {
            match unsafe { keepwork_voice_input_clear() } {
                0 => Ok(true),
                1 => Ok(false),
                _ => Err("无法发送清空指令，请检查辅助功能权限；不会自动重试".into()),
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        VK_BACK, VK_CONTROL, VK_F5, VK_RETURN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CreateWindowExW, DestroyWindow, GetMessageW, PeekMessageW,
        PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HWND_MESSAGE, KBDLLHOOKSTRUCT,
        MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_QUIT,
    };

    static RESERVED: AtomicBool = AtomicBool::new(false);
    static CLAIMED: AtomicBool = AtomicBool::new(false);

    fn keyboard_event(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    ..Default::default()
                },
            },
        }
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0
            && lparam != 0
            && RESERVED.load(Ordering::Acquire)
            && (*(lparam as *const KBDLLHOOKSTRUCT)).vkCode == VK_F5 as u32
        {
            return 1;
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }

    struct Hook {
        thread_id: u32,
        cancelled: Arc<AtomicBool>,
        thread: JoinHandle<()>,
    }
    pub struct Input {
        hook: Mutex<Option<Hook>>,
    }

    impl Input {
        pub fn new() -> Result<Self, String> {
            Ok(Self {
                hook: Mutex::new(None),
            })
        }
        pub fn start(&self) -> Result<(), String> {
            let mut guard = self.hook.lock().map_err(|_| "语音键状态不可用")?;
            if guard.is_some() {
                return Ok(());
            }
            if CLAIMED
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err("另一个遥控器语音会话正在使用 F5".into());
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_thread = Arc::clone(&cancelled);
            let startup_thread_id = Arc::new(AtomicU32::new(0));
            let report_thread_id = Arc::clone(&startup_thread_id);
            let (sender, receiver) = mpsc::sync_channel(1);
            let thread = thread::spawn(move || unsafe {
                // Force creation of the thread queue before reporting its ID.
                let mut message = MSG::default();
                PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
                report_thread_id.store(GetCurrentThreadId(), Ordering::Release);
                let hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard_hook),
                    GetModuleHandleW(null()),
                    0,
                );
                if hook.is_null() {
                    let _ = sender.send(Err(()));
                    CLAIMED.store(false, Ordering::Release);
                    return;
                }
                RESERVED.store(true, Ordering::Release);
                let _ = sender.send(Ok(GetCurrentThreadId()));
                while !cancel_thread.load(Ordering::Acquire)
                    && GetMessageW(&mut message, null_mut(), 0, 0) > 0
                {}
                RESERVED.store(false, Ordering::Release);
                UnhookWindowsHookEx(hook);
                CLAIMED.store(false, Ordering::Release);
            });
            match receiver.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(thread_id)) => {
                    *guard = Some(Hook {
                        thread_id,
                        cancelled,
                        thread,
                    });
                    Ok(())
                }
                _ => {
                    cancelled.store(true, Ordering::Release);
                    RESERVED.store(false, Ordering::Release);
                    let thread_id = startup_thread_id.load(Ordering::Acquire);
                    if thread_id != 0 {
                        unsafe {
                            PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
                        }
                    }
                    Err("无法启动系统语音键监听，请检查当前桌面权限后重试".into())
                }
            }
        }
        pub fn stop(&self) {
            if let Ok(mut guard) = self.hook.lock() {
                if let Some(hook) = guard.take() {
                    RESERVED.store(false, Ordering::Release);
                    hook.cancelled.store(true, Ordering::Release);
                    unsafe {
                        PostThreadMessageW(hook.thread_id, WM_QUIT, 0, 0);
                    }
                    let _ = hook.thread.join();
                }
            }
        }
        pub fn modifiers_down(&self) -> bool {
            [0x10, 0x11, 0x12, 0x5B, 0x5C]
                .iter()
                .any(|key| unsafe { GetAsyncKeyState(*key) } < 0)
        }
        pub fn copy(&self, text: &str) -> Result<(), String> {
            let value: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            unsafe {
                let memory = GlobalAlloc(GMEM_MOVEABLE, value.len() * 2);
                if memory.is_null() {
                    return Err("无法分配系统剪贴板内存".into());
                }
                let pointer = GlobalLock(memory);
                if pointer.is_null() {
                    GlobalFree(memory);
                    return Err("无法锁定系统剪贴板内存".into());
                }
                std::ptr::copy_nonoverlapping(value.as_ptr(), pointer.cast::<u16>(), value.len());
                GlobalUnlock(memory);
                // A message-only owner avoids OpenClipboard(NULL)'s null-owner
                // behavior and never creates a visible or focused window.
                let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
                let owner = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    null_mut(),
                    GetModuleHandleW(null()),
                    null(),
                );
                if owner.is_null() {
                    GlobalFree(memory);
                    return Err("无法创建系统剪贴板所有者；未执行粘贴".into());
                }
                let mut opened = false;
                for _ in 0..5 {
                    if OpenClipboard(owner) != 0 {
                        opened = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                let success =
                    opened && EmptyClipboard() != 0 && !SetClipboardData(13, memory).is_null();
                if opened {
                    CloseClipboard();
                }
                DestroyWindow(owner);
                if !success {
                    GlobalFree(memory);
                    return Err("无法写入系统剪贴板；未执行粘贴".into());
                }
            }
            Ok(())
        }
        pub fn paste(&self) -> Result<(), String> {
            let keys = [
                keyboard_event(VK_CONTROL, false),
                keyboard_event(b'V' as u16, false),
                keyboard_event(b'V' as u16, true),
                keyboard_event(VK_CONTROL, true),
            ];
            if unsafe {
                SendInput(
                    keys.len() as u32,
                    keys.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            } != keys.len() as u32
            {
                // Release any injected held keys, but never retry the mutation.
                let releases = [
                    keyboard_event(b'V' as u16, true),
                    keyboard_event(VK_CONTROL, true),
                ];
                unsafe {
                    SendInput(
                        releases.len() as u32,
                        releases.as_ptr(),
                        std::mem::size_of::<INPUT>() as i32,
                    );
                }
                return Err("系统未完整接收粘贴按键；文字已复制，不会自动重试".into());
            }
            Ok(())
        }
        pub fn submit(&self) -> Result<(), String> {
            let keys = [
                keyboard_event(VK_RETURN, false),
                keyboard_event(VK_RETURN, true),
            ];
            if unsafe {
                SendInput(
                    keys.len() as u32,
                    keys.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            } != keys.len() as u32
            {
                // The key-down might already have submitted. Only release the
                // key; never retry it or fall back to pasting command text.
                let release = [keyboard_event(VK_RETURN, true)];
                unsafe {
                    SendInput(1, release.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                }
                return Err("系统未完整接收回车，发送结果未知；不会自动重试".into());
            }
            Ok(())
        }
        pub fn clear(&self) -> Result<bool, String> {
            if !editable_focus() { return Ok(false); }
            if self.modifiers_down() { return Err("请先松开修饰键，再清空输入框。".into()); }
            let keys = [
                keyboard_event(VK_CONTROL, false), keyboard_event(b'A' as u16, false),
                keyboard_event(b'A' as u16, true), keyboard_event(VK_CONTROL, true),
                keyboard_event(VK_BACK, false), keyboard_event(VK_BACK, true),
            ];
            if unsafe { SendInput(keys.len() as u32, keys.as_ptr(), std::mem::size_of::<INPUT>() as i32) } != keys.len() as u32 {
                let releases = [keyboard_event(b'A' as u16, true), keyboard_event(VK_CONTROL, true), keyboard_event(VK_BACK, true)];
                unsafe { SendInput(releases.len() as u32, releases.as_ptr(), std::mem::size_of::<INPUT>() as i32); }
                return Err("系统未完整接收清空按键，结果未知；不会自动重试".into());
            }
            Ok(true)
        }
    }

    // Read only role/flags, never the value or selection. UIA timeouts keep an
    // unresponsive provider from indefinitely blocking the BLE event loop.
    fn editable_focus() -> bool {
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
        use windows::Win32::UI::Accessibility::{CUIAutomation8, IUIAutomation2, IUIAutomationValuePattern, UIA_EditControlTypeId, UIA_ValuePatternId};
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return false; }
            let result = (|| -> windows::core::Result<bool> {
                let automation: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
                automation.SetConnectionTimeout(500)?;
                automation.SetTransactionTimeout(500)?;
                let focus = automation.GetFocusedElement()?;
                if focus.CurrentControlType()? != UIA_EditControlTypeId
                    || !focus.CurrentHasKeyboardFocus()?.as_bool()
                    || !focus.CurrentIsEnabled()?.as_bool()
                    || focus.CurrentIsPassword()?.as_bool() { return Ok(false); }
                let value: IUIAutomationValuePattern = focus.GetCurrentPatternAs(UIA_ValuePatternId)?;
                Ok(!value.CurrentIsReadOnly()?.as_bool())
            })().unwrap_or(false);
            CoUninitialize();
            result
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub struct Input;
    impl Input {
        pub fn new() -> Result<Self, String> {
            Err("遥控器语音输入目前支持 Windows 和 macOS".into())
        }
        pub fn start(&self) -> Result<(), String> {
            Err("当前平台不支持系统语音输入".into())
        }
        pub fn stop(&self) {}
        pub fn modifiers_down(&self) -> bool {
            true
        }
        pub fn copy(&self, _: &str) -> Result<(), String> {
            Err("当前平台不支持系统剪贴板".into())
        }
        pub fn paste(&self) -> Result<(), String> {
            Err("当前平台不支持系统粘贴".into())
        }
        pub fn submit(&self) -> Result<(), String> {
            Err("当前平台不支持系统回车输入".into())
        }
        pub fn clear(&self) -> Result<bool, String> {
            Err("当前平台不支持清空输入框".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    struct FakeBackend<'a> {
        enabled: &'a AtomicBool,
        clipboard: RefCell<Vec<String>>,
        paste_attempts: Cell<usize>,
        submit_attempts: Cell<usize>,
        clear_attempts: Cell<usize>,
        editable: Cell<bool>,
        clear_error: bool,
        modifiers: RefCell<VecDeque<bool>>,
        modifier_checks: Cell<usize>,
        stop_on_check: Option<usize>,
        stop_on_copy: bool,
        copy_error: bool,
        paste_error: bool,
        submit_error: bool,
        current_focus: Cell<u8>,
        delivered_to: RefCell<Vec<u8>>,
        submitted_to: RefCell<Vec<u8>>,
    }
    impl<'a> FakeBackend<'a> {
        fn new(enabled: &'a AtomicBool) -> Self {
            Self {
                enabled,
                clipboard: RefCell::new(vec![]),
                paste_attempts: Cell::new(0),
                submit_attempts: Cell::new(0),
                clear_attempts: Cell::new(0),
                editable: Cell::new(true),
                clear_error: false,
                modifiers: RefCell::new(VecDeque::from([false, false])),
                modifier_checks: Cell::new(0),
                stop_on_check: None,
                stop_on_copy: false,
                copy_error: false,
                paste_error: false,
                submit_error: false,
                current_focus: Cell::new(1),
                delivered_to: RefCell::new(vec![]),
                submitted_to: RefCell::new(vec![]),
            }
        }
        fn assert_no_side_effects(&self) {
            assert!(self.clipboard.borrow().is_empty());
            assert_eq!(self.paste_attempts.get(), 0);
            assert_eq!(self.submit_attempts.get(), 0);
            assert_eq!(self.clear_attempts.get(), 0);
            assert!(self.delivered_to.borrow().is_empty());
            assert!(self.submitted_to.borrow().is_empty());
        }
    }
    impl DeliveryBackend for FakeBackend<'_> {
        fn modifiers_down(&self) -> bool {
            let check = self.modifier_checks.get() + 1;
            self.modifier_checks.set(check);
            if self.stop_on_check == Some(check) {
                self.enabled.store(false, Ordering::Release);
            }
            self.modifiers.borrow_mut().pop_front().unwrap_or(false)
        }
        fn copy(&self, text: &str) -> Result<(), String> {
            self.clipboard.borrow_mut().push(text.to_string());
            if self.stop_on_copy {
                self.enabled.store(false, Ordering::Release);
            }
            if self.copy_error {
                return Err("clipboard unavailable".into());
            }
            Ok(())
        }
        fn paste(&self) -> Result<(), String> {
            self.paste_attempts.set(self.paste_attempts.get() + 1);
            self.delivered_to
                .borrow_mut()
                .push(self.current_focus.get());
            if self.paste_error {
                return Err("uncertain native paste".into());
            }
            Ok(())
        }
        fn submit(&self) -> Result<(), String> {
            self.submit_attempts.set(self.submit_attempts.get() + 1);
            self.submitted_to.borrow_mut().push(self.current_focus.get());
            if self.submit_error { return Err("uncertain native submit".into()); }
            Ok(())
        }
        fn clear(&self) -> Result<bool, String> {
            self.clear_attempts.set(self.clear_attempts.get() + 1);
            if self.clear_error { return Err("uncertain native clear".into()); }
            Ok(self.editable.get())
        }
    }

    #[test]
    fn current_focus_pastes_once_without_an_accessibility_selection_snapshot() {
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        backend.current_focus.set(2); // User selected this input during recognition.
        assert_eq!(
            deliver_current(&enabled, &backend, "当前输入框").unwrap(),
            Delivery::Pasted
        );
        assert_eq!(&*backend.clipboard.borrow(), &["当前输入框"]);
        assert_eq!(backend.paste_attempts.get(), 1);
        assert_eq!(&*backend.delivered_to.borrow(), &[2]);
        assert_eq!(backend.submit_attempts.get(), 0);
    }

    #[test]
    fn disabled_empty_or_invalid_text_never_touches_clipboard_or_input() {
        let disabled = AtomicBool::new(false);
        let backend = FakeBackend::new(&disabled);
        assert_eq!(
            deliver_current(&disabled, &backend, "private transcript").unwrap(),
            Delivery::Cancelled
        );
        backend.assert_no_side_effects();
        for text in ["", " \n\t"] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert_eq!(
                deliver_current(&enabled, &backend, text).unwrap(),
                Delivery::Cancelled
            );
            backend.assert_no_side_effects();
        }
        for text in ["invalid\0text".to_string(), "x".repeat(64_001)] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert!(deliver_current(&enabled, &backend, &text).is_err());
            backend.assert_no_side_effects();
        }
    }

    #[test]
    fn a_modifier_held_before_delivery_prevents_both_clipboard_write_and_paste() {
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        *backend.modifiers.borrow_mut() = VecDeque::from([true]);
        assert_eq!(
            deliver_current(&enabled, &backend, "text").unwrap(),
            Delivery::ModifiersHeld
        );
        backend.assert_no_side_effects();
    }

    #[test]
    fn stop_during_clipboard_acquisition_cannot_paste_or_retry() {
        let enabled = AtomicBool::new(true);
        let mut backend = FakeBackend::new(&enabled);
        backend.stop_on_copy = true;
        assert_eq!(
            deliver_current(&enabled, &backend, "text").unwrap(),
            Delivery::Cancelled
        );
        assert_eq!(backend.clipboard.borrow().len(), 1);
        assert_eq!(backend.paste_attempts.get(), 0);
        assert_eq!(
            deliver_current(&enabled, &backend, "late result").unwrap(),
            Delivery::Cancelled
        );
        assert_eq!(backend.clipboard.borrow().len(), 1);
    }

    #[test]
    fn stop_during_either_modifier_check_prevents_the_next_mutation() {
        for check in [1, 2] {
            let enabled = AtomicBool::new(true);
            let mut backend = FakeBackend::new(&enabled);
            backend.stop_on_check = Some(check);
            assert_eq!(
                deliver_current(&enabled, &backend, "text").unwrap(),
                Delivery::Cancelled
            );
            assert_eq!(backend.clipboard.borrow().len(), check - 1);
            assert_eq!(backend.paste_attempts.get(), 0);
        }
    }

    #[test]
    fn modifier_pressed_during_copy_prevents_the_paste_and_is_reported_explicitly() {
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        *backend.modifiers.borrow_mut() = VecDeque::from([false, true]);
        assert_eq!(
            deliver_current(&enabled, &backend, "text").unwrap(),
            Delivery::ModifiersHeld
        );
        assert_eq!(backend.clipboard.borrow().len(), 1);
        assert_eq!(backend.paste_attempts.get(), 0);
    }

    #[test]
    fn clipboard_and_uncertain_paste_failures_are_never_retried() {
        let enabled = AtomicBool::new(true);
        let mut clipboard_failure = FakeBackend::new(&enabled);
        clipboard_failure.copy_error = true;
        assert!(deliver_current(&enabled, &clipboard_failure, "text").is_err());
        assert_eq!(clipboard_failure.clipboard.borrow().len(), 1);
        assert_eq!(clipboard_failure.paste_attempts.get(), 0);
        let mut paste_failure = FakeBackend::new(&enabled);
        paste_failure.paste_error = true;
        assert!(deliver_current(&enabled, &paste_failure, "text").is_err());
        assert_eq!(paste_failure.clipboard.borrow().len(), 1);
        assert_eq!(paste_failure.paste_attempts.get(), 1);
        assert_eq!(paste_failure.delivered_to.borrow().len(), 1);
    }

    #[test]
    fn a_stopped_native_instance_has_no_system_side_effects() {
        #[cfg(any(target_os = "macos", windows))]
        {
            let input = NativeInput::new().unwrap();
            assert_eq!(
                input.deliver("private transcript").unwrap(),
                Delivery::Cancelled
            );
            input.stop();
            assert_eq!(
                input.deliver("late transcript").unwrap(),
                Delivery::Cancelled
            );
            assert_eq!(input.deliver("发送提示词").unwrap(), Delivery::Cancelled);
        }
    }

    #[test]
    fn exact_send_command_with_only_allowed_terminal_punctuation_submits_once_without_copy_or_paste() {
        for command in ["发送提示词", " 发送提示词 \n", "\u{3000}发送提示词。\u{3000}",
            "发送提示词．", "发送提示词.", "发送提示词！", "发送提示词!", "发送提示词？", "发送提示词?",
            "发送提示词？！", "发送提示词...", "发送提示词 。 \n"] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            backend.current_focus.set(3);
            assert_eq!(deliver_current(&enabled, &backend, command).unwrap(), Delivery::Submitted, "{command:?}");
            assert!(backend.clipboard.borrow().is_empty());
            assert_eq!(backend.paste_attempts.get(), 0);
            assert_eq!(backend.submit_attempts.get(), 1);
            assert_eq!(&*backend.submitted_to.borrow(), &[3]);
        }
    }

    #[test]
    fn embedded_command_quotes_internal_spaces_and_nonterminal_punctuation_remain_plain_dictation() {
        for text in ["不要发送提示词", "请把发送提示词写下来", "发送提示词以后再修改", "发送 提示词",
            "。发送提示词", "“发送提示词”", "\"发送提示词\"", "发送提示词…", "发送提示词，",
            "发送提示词,", "发送提示词；", "发送提示词;", "发送提示词：", "发送提示词:", "发送提示词\n再修改"] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert_eq!(deliver_current(&enabled, &backend, text).unwrap(), Delivery::Pasted, "{text:?}");
            assert_eq!(&*backend.clipboard.borrow(), &[text]);
            assert_eq!(backend.paste_attempts.get(), 1);
            assert_eq!(backend.submit_attempts.get(), 0);
        }
    }

    #[test]
    fn stopped_invalid_or_modifier_held_commands_never_touch_clipboard_or_submit() {
        let enabled = AtomicBool::new(false);
        let backend = FakeBackend::new(&enabled);
        assert_eq!(deliver_current(&enabled, &backend, "发送提示词").unwrap(), Delivery::Cancelled);
        backend.assert_no_side_effects();
        for text in ["发送提示词\0".to_string(), "发送提示词".repeat(20_000)] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert!(deliver_current(&enabled, &backend, &text).is_err());
            backend.assert_no_side_effects();
        }
        for checks in [VecDeque::from([true]), VecDeque::from([false, true])] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            *backend.modifiers.borrow_mut() = checks;
            assert_eq!(deliver_current(&enabled, &backend, "发送提示词").unwrap(), Delivery::ModifiersHeld);
            backend.assert_no_side_effects();
        }
    }

    #[test]
    fn stop_during_either_command_guard_prevents_submission_and_any_fallback_paste() {
        for check in [1, 2] {
            let enabled = AtomicBool::new(true);
            let mut backend = FakeBackend::new(&enabled);
            backend.stop_on_check = Some(check);
            assert_eq!(deliver_current(&enabled, &backend, "发送提示词").unwrap(), Delivery::Cancelled);
            backend.assert_no_side_effects();
        }
    }

    #[test]
    fn uncertain_submit_failure_is_attempted_once_without_retry_or_dictation_fallback() {
        let enabled = AtomicBool::new(true);
        let mut backend = FakeBackend::new(&enabled);
        backend.submit_error = true;
        assert!(deliver_current(&enabled, &backend, "发送提示词。").is_err());
        assert_eq!(backend.submit_attempts.get(), 1);
        assert_eq!(backend.submitted_to.borrow().len(), 1);
        assert!(backend.clipboard.borrow().is_empty());
        assert_eq!(backend.paste_attempts.get(), 0);
    }

    #[test]
    fn clear_command_only_clears_the_current_editable_input_without_clipboard_or_return() {
        for text in ["清除提示词", " 清除提示词。 ", "清除提示词？！", "\u{3000}清除提示词\n"] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert_eq!(deliver_current(&enabled, &backend, text).unwrap(), Delivery::Cleared);
            assert_eq!(backend.clear_attempts.get(), 1);
            assert!(backend.clipboard.borrow().is_empty());
            assert_eq!(backend.submit_attempts.get(), 0);
            assert_eq!(backend.paste_attempts.get(), 0);
        }
        for text in ["不要清除提示词", "“清除提示词”", "清除 提示词", "清除提示词，", "清除提示词后重写"] {
            let enabled = AtomicBool::new(true);
            let backend = FakeBackend::new(&enabled);
            assert_eq!(deliver_current(&enabled, &backend, text).unwrap(), Delivery::Pasted);
            assert_eq!(backend.clear_attempts.get(), 0);
        }
    }

    #[test]
    fn clear_respects_stop_modifiers_editability_and_never_retries_uncertain_deletion() {
        let enabled = AtomicBool::new(false);
        let backend = FakeBackend::new(&enabled);
        assert_eq!(clear_current(&enabled, &backend).unwrap(), Delivery::Cancelled);
        backend.assert_no_side_effects();
        enabled.store(true, Ordering::Release);
        *backend.modifiers.borrow_mut() = VecDeque::from([true]);
        assert_eq!(clear_current(&enabled, &backend).unwrap(), Delivery::ModifiersHeld);
        backend.assert_no_side_effects();
        backend.editable.set(false);
        assert_eq!(clear_current(&enabled, &backend).unwrap(), Delivery::NotEditable);
        assert_eq!(backend.clear_attempts.get(), 1);
        assert!(backend.clipboard.borrow().is_empty());
        assert_eq!(backend.submit_attempts.get(), 0);
        assert_eq!(backend.paste_attempts.get(), 0);
        let mut failure = FakeBackend::new(&enabled);
        failure.clear_error = true;
        assert!(clear_current(&enabled, &failure).is_err());
        assert_eq!(failure.clear_attempts.get(), 1);
        assert!(failure.clipboard.borrow().is_empty());
        assert_eq!(failure.submit_attempts.get(), 0);
        assert_eq!(failure.paste_attempts.get(), 0);
    }

    async fn final_asr_text_fixture(partial: &'static str, final_text: &'static str, text_in_done: bool) -> String {
        use futures_util::{SinkExt, StreamExt};
        use tokio::net::TcpListener;
        use tokio::sync::watch;
        use tokio_tungstenite::tungstenite::Message;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/speech?asr_format=pcm&asr_rate=16000", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Message::Text(r#"{"type":"ready"}"#.into())).await.unwrap();
            while let Some(message) = socket.next().await {
                if let Message::Text(text) = message.unwrap() {
                    assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap()["type"], "asr_end");
                    break;
                }
            }
            socket.send(Message::Text(serde_json::json!({"type":"asr", "event":"result", "text":partial}).to_string())).await.unwrap();
            if text_in_done {
                socket.send(Message::Text(serde_json::json!({"type":"asr", "event":"done", "text":final_text}).to_string())).await.unwrap();
            } else {
                socket.send(Message::Text(serde_json::json!({"type":"asr", "event":"result", "text":final_text}).to_string())).await.unwrap();
                socket.send(Message::Text(r#"{"type":"asr","event":"done"}"#.into())).await.unwrap();
            }
        });
        let (_owner, cancel) = watch::channel(false);
        let text = super::super::asr::transcribe_fixture(&[16, -16], cancel, &endpoint).await.unwrap();
        peer.await.unwrap();
        text
    }

    #[tokio::test]
    async fn partial_asr_command_followed_by_a_long_final_sentence_pastes_without_submitting() {
        let text = final_asr_text_fixture("发送提示词", "请把发送提示词写下来", false).await;
        assert_eq!(text, "请把发送提示词写下来");
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        assert_eq!(deliver_current(&enabled, &backend, &text).unwrap(), Delivery::Pasted);
        assert_eq!(&*backend.clipboard.borrow(), &[text]);
        assert_eq!(backend.paste_attempts.get(), 1);
        assert_eq!(backend.submit_attempts.get(), 0);
    }

    #[tokio::test]
    async fn only_the_final_asr_command_submits_once_without_copy_or_paste() {
        let text = final_asr_text_fixture("请先等一下", "发送提示词！", true).await;
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        assert_eq!(deliver_current(&enabled, &backend, &text).unwrap(), Delivery::Submitted);
        assert!(backend.clipboard.borrow().is_empty());
        assert_eq!(backend.paste_attempts.get(), 0);
        assert_eq!(backend.submit_attempts.get(), 1);
    }

    #[test]
    fn two_independent_completed_commands_are_not_text_deduplicated() {
        let enabled = AtomicBool::new(true);
        let backend = FakeBackend::new(&enabled);
        assert_eq!(deliver_current(&enabled, &backend, "发送提示词").unwrap(), Delivery::Submitted);
        assert_eq!(deliver_current(&enabled, &backend, "发送提示词").unwrap(), Delivery::Submitted);
        assert_eq!(backend.submit_attempts.get(), 2);
        assert!(backend.clipboard.borrow().is_empty());
        assert_eq!(backend.paste_attempts.get(), 0);
    }
}
