//! Native, opt-in voice input. No shell, executable helper or renderer text API.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Target {
    native: [u64; 12],
    control: Vec<i32>,
    selection: Option<(i32, i32)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    Pasted,
    Copied,
    Cancelled,
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

    pub fn target(&self) -> Option<Target> {
        self.platform.target()
    }

    pub fn deliver(&self, text: &str, target: &Option<Target>) -> Result<Delivery, String> {
        let _gate = self.gate.lock().map_err(|_| "系统输入状态不可用")?;
        if !self.enabled.load(Ordering::Acquire) {
            return Ok(Delivery::Cancelled);
        }
        if text.trim().is_empty() {
            return Ok(Delivery::Cancelled);
        }
        if text.len() > 64_000 || text.contains('\0') {
            return Err("识别文字超出长度限制或包含无效字符".into());
        }
        self.platform.copy(text)?;
        if !self.enabled.load(Ordering::Acquire) {
            return Ok(Delivery::Cancelled);
        }
        if !may_paste(
            target,
            &self.platform.target(),
            self.platform.modifiers_down(),
        ) {
            return Ok(Delivery::Copied);
        }
        // Recheck after writing the clipboard, immediately before the only
        // injection. Never activate a window, move its caret or press Enter.
        if !self.enabled.load(Ordering::Acquire)
            || !may_paste(
                target,
                &self.platform.target(),
                self.platform.modifiers_down(),
            )
        {
            return Ok(Delivery::Copied);
        }
        self.platform.paste()?;
        Ok(Delivery::Pasted)
    }
}

impl Drop for NativeInput {
    fn drop(&mut self) {
        self.stop();
    }
}

fn may_paste(expected: &Option<Target>, actual: &Option<Target>, modifiers: bool) -> bool {
    expected.is_some() && expected == actual && !modifiers
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Target;
    use std::ffi::c_char;
    use std::sync::Mutex;

    #[link(name = "AppKit", kind = "framework")]
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn keepwork_voice_input_start() -> i32;
        fn keepwork_voice_input_stop();
        fn keepwork_voice_input_target(out: *mut u64) -> bool;
        fn keepwork_voice_input_modifiers() -> bool;
        fn keepwork_voice_input_copy(bytes: *const c_char, len: usize) -> bool;
        fn keepwork_voice_input_paste() -> bool;
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
        pub fn target(&self) -> Option<Target> {
            let mut out = [0; 12];
            unsafe {
                keepwork_voice_input_target(out.as_mut_ptr()).then_some(Target {
                    native: out,
                    control: Vec::new(),
                    selection: None,
                })
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
    }
}

#[cfg(windows)]
mod platform {
    use super::Target;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
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
        VK_CONTROL, VK_F5,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CreateWindowExW, DestroyWindow, GetForegroundWindow, GetGUIThreadInfo,
        GetMessageW, GetWindowThreadProcessId, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
        UnhookWindowsHookEx, GUITHREADINFO, HWND_MESSAGE, KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE,
        WH_KEYBOARD_LL, WM_QUIT,
    };

    static RESERVED: AtomicBool = AtomicBool::new(false);
    static CLAIMED: AtomicBool = AtomicBool::new(false);
    static SNAPSHOTS: AtomicUsize = AtomicUsize::new(0);

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

    unsafe fn runtime_id(
        element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> Option<Vec<i32>> {
        use windows::Win32::System::Com::SAFEARRAY;
        use windows::Win32::System::Ole::{
            SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetLBound,
            SafeArrayGetUBound, SafeArrayUnaccessData,
        };
        struct Array(*mut SAFEARRAY);
        impl Drop for Array {
            fn drop(&mut self) {
                unsafe {
                    let _ = SafeArrayDestroy(self.0);
                }
            }
        }
        let array = Array(element.GetRuntimeId().ok()?);
        if array.0.is_null() || SafeArrayGetDim(array.0) != 1 {
            return None;
        }
        let start = SafeArrayGetLBound(array.0, 1).ok()?;
        let end = SafeArrayGetUBound(array.0, 1).ok()?;
        let count = end.checked_sub(start)?.checked_add(1)?;
        if !(1..=64).contains(&count) {
            return None;
        }
        let mut data = null_mut();
        SafeArrayAccessData(array.0, &mut data).ok()?;
        let result = if data.is_null() {
            None
        } else {
            Some(std::slice::from_raw_parts(data.cast::<i32>(), count as usize).to_vec())
        };
        SafeArrayUnaccessData(array.0).ok()?;
        result
    }

    unsafe fn uia_target() -> Option<Target> {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        };
        use windows::Win32::UI::Accessibility::{
            CUIAutomation8, IUIAutomation2, IUIAutomationTextPattern, TextPatternRangeEndpoint_End,
            TextPatternRangeEndpoint_Start, TextUnit_Character, UIA_TextPatternId,
        };
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut process_id = 0;
        let thread_id = GetWindowThreadProcessId(window, &mut process_id);
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(thread_id, &mut info) == 0 || info.hwndFocus.is_null() {
            return None;
        }
        let automation: IUIAutomation2 =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
        automation.SetConnectionTimeout(200).ok()?;
        automation.SetTransactionTimeout(200).ok()?;
        let element = automation.GetFocusedElement().ok()?;
        if element.CurrentProcessId().ok()? as u32 != process_id
            || !element.CurrentHasKeyboardFocus().ok()?.as_bool()
        {
            return None;
        }
        let control = runtime_id(&element)?;
        // Runtime IDs distinguish individual HTML input controls sharing one
        // Chromium render HWND. Require a text selection contract as well;
        // unsupported providers get copy-only rather than a false guarantee.
        let pattern: IUIAutomationTextPattern =
            element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let ranges = pattern.GetSelection().ok()?;
        if ranges.Length().ok()? != 1 {
            return None;
        }
        let selection = ranges.GetElement(0).ok()?;
        let start = selection.Clone().ok()?;
        start
            .MoveEndpointByRange(
                TextPatternRangeEndpoint_End,
                &selection,
                TextPatternRangeEndpoint_Start,
            )
            .ok()?;
        let end = selection.Clone().ok()?;
        end.MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            &selection,
            TextPatternRangeEndpoint_End,
        )
        .ok()?;
        // Moving each collapsed endpoint to document start measures its offset
        // without reading, retaining or logging any existing application text.
        const LIMIT: i32 = -1_000_000;
        let start_offset = start
            .MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, LIMIT)
            .ok()?;
        let end_offset = end
            .MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, LIMIT)
            .ok()?;
        if start_offset == LIMIT || end_offset == LIMIT || start_offset > 0 || end_offset > 0 {
            return None;
        }
        if GetForegroundWindow() != window {
            return None;
        }
        let last_focused = automation.GetFocusedElement().ok()?;
        if runtime_id(&last_focused)? != control {
            return None;
        }
        Some(Target {
            native: [
                window as u64,
                process_id as u64,
                thread_id as u64,
                info.hwndFocus as u64,
                info.hwndCaret as u64,
                info.rcCaret.left as u64,
                info.rcCaret.top as u64,
                info.rcCaret.right as u64,
                info.rcCaret.bottom as u64,
                0,
                0,
                0,
            ],
            control,
            selection: Some((-start_offset, -end_offset)),
        })
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
        pub fn target(&self) -> Option<Target> {
            // UIA providers can be unresponsive. Bound both caller latency and
            // the number of background queries; failure means copy-only.
            if SNAPSHOTS.fetch_add(1, Ordering::AcqRel) >= 2 {
                SNAPSHOTS.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            let (sender, receiver) = mpsc::sync_channel(1);
            if thread::Builder::new()
                .name("voice-focus".into())
                .spawn(move || {
                    struct CountGuard;
                    impl Drop for CountGuard {
                        fn drop(&mut self) {
                            SNAPSHOTS.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                    let _count = CountGuard;
                    let _ = sender.send(unsafe { uia_target() });
                })
                .is_err()
            {
                SNAPSHOTS.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            receiver
                .recv_timeout(Duration::from_millis(800))
                .ok()
                .flatten()
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
            fn key(vk: u16, up: bool) -> INPUT {
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
            let keys = [
                key(VK_CONTROL, false),
                key(b'V' as u16, false),
                key(b'V' as u16, true),
                key(VK_CONTROL, true),
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
                let releases = [key(b'V' as u16, true), key(VK_CONTROL, true)];
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
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Target;
    pub struct Input;
    impl Input {
        pub fn new() -> Result<Self, String> {
            Err("遥控器语音输入目前支持 Windows 和 macOS".into())
        }
        pub fn start(&self) -> Result<(), String> {
            Err("当前平台不支持系统语音输入".into())
        }
        pub fn stop(&self) {}
        pub fn target(&self) -> Option<Target> {
            None
        }
        pub fn modifiers_down(&self) -> bool {
            true
        }
        pub fn copy(&self, _: &str) -> Result<(), String> {
            Err("当前平台不支持系统剪贴板".into())
        }
        pub fn paste(&self) -> Result<(), String> {
            Err("当前平台不支持系统粘贴".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(value: u64) -> Target {
        Target {
            native: [value; 12],
            control: vec![value as i32],
            selection: Some((1, 1)),
        }
    }
    #[test]
    fn paste_requires_same_known_target_and_released_modifiers() {
        let expected = Some(target(42));
        assert!(may_paste(&expected, &expected, false));
        assert!(!may_paste(&None, &None, false));
        assert!(!may_paste(&expected, &Some(target(43)), false));
        assert!(!may_paste(&expected, &expected, true));
        let mut changed_control = target(42);
        changed_control.control = vec![999];
        assert!(!may_paste(&expected, &Some(changed_control), false));
        let mut moved_caret = target(42);
        moved_caret.selection = Some((2, 2));
        assert!(!may_paste(&expected, &Some(moved_caret), false));
    }
    #[test]
    fn stopped_input_never_changes_the_system_clipboard_or_injects() {
        #[cfg(any(target_os = "macos", windows))]
        {
            let input = NativeInput::new().unwrap();
            assert_eq!(
                input.deliver("private transcript", &None).unwrap(),
                Delivery::Cancelled
            );
            input.stop();
            assert_eq!(
                input
                    .deliver("another transcript", &Some(target(1)))
                    .unwrap(),
                Delivery::Cancelled
            );
        }
    }
}
