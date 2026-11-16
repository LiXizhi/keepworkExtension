//! Observe RC003 Home and Menu on Tao's existing Raw Input target (or a private
//! message-only Raw Input window in the standalone companion). Windows permits
//! only one registered raw keyboard target per process. Always chain Tao's handler.
use super::buttons::ButtonStatus;
use std::collections::VecDeque;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::Devices::HumanInterfaceDevice::{
    HidD_GetAttributes, HidD_GetProductString, HIDD_ATTRIBUTES,
};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_APPS, VK_HOME};
use windows_sys::Win32::UI::Input::*;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const KEYBOARD: (u16, u16) = (1, 6);
const SUBCLASS_ID: usize = 0x4b57484d;
const SHORT_PRESS: Duration = Duration::from_secs(1);
const MENU_HOLD_BUDGET_MS: u64 = 10_000;
const MENU_RELEASE_GRACE_MS: u64 = 250;

static EPOCH: OnceLock<Instant> = OnceLock::new();
static MENU_HELD: AtomicBool = AtomicBool::new(false);
static MENU_SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

fn monotonic_ms() -> u64 {
    let base = *EPOCH.get_or_init(Instant::now);
    Instant::now().saturating_duration_since(base).as_millis() as u64 + 1
}

fn note_remote_menu_at(release: bool, now_ms: u64) {
    if !release {
        MENU_SUPPRESS_UNTIL_MS.store(now_ms.saturating_add(MENU_HOLD_BUDGET_MS), Ordering::Release);
        MENU_HELD.store(true, Ordering::Release);
    } else {
        MENU_HELD.store(false, Ordering::Release);
        let grace = now_ms.saturating_add(MENU_RELEASE_GRACE_MS);
        let mut current = MENU_SUPPRESS_UNTIL_MS.load(Ordering::Acquire);
        while current != 0 {
            match MENU_SUPPRESS_UNTIL_MS.compare_exchange_weak(
                current,
                current.min(grace),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
    }
}

pub(super) fn clear_menu_suppression() {
    MENU_HELD.store(false, Ordering::Release);
    MENU_SUPPRESS_UNTIL_MS.store(0, Ordering::Release);
}

fn suppress_menu_keydown_at(now_ms: u64) -> bool {
    MENU_HELD.load(Ordering::Acquire) && now_ms <= MENU_SUPPRESS_UNTIL_MS.load(Ordering::Acquire)
}

fn take_menu_keyup_at(now_ms: u64) -> bool {
    MENU_HELD.store(false, Ordering::Release);
    let prev = MENU_SUPPRESS_UNTIL_MS.swap(0, Ordering::AcqRel);
    prev != 0 && now_ms <= prev
}

pub(super) fn should_suppress_menu_keydown() -> bool {
    suppress_menu_keydown_at(monotonic_ms())
}

pub(super) fn take_menu_keyup_suppression() -> bool {
    take_menu_keyup_at(monotonic_ms())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteButton {
    Clear,
    Home,
}

#[derive(Clone, Copy, Default)]
struct KeyEdge {
    await_release: bool,
    down: Option<Instant>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum SourceChoice {
    #[default]
    None,
    Unique {
        handles: Vec<usize>,
        physical: String,
        label: String,
    },
    Ambiguous,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteCandidate {
    handle: usize,
    physical: String,
    label: String,
}

fn classify_candidates(candidates: Vec<RemoteCandidate>) -> SourceChoice {
    if candidates.is_empty() {
        return SourceChoice::None;
    }
    if candidates.len() == 1 {
        let item = candidates.into_iter().next().unwrap();
        return SourceChoice::Unique {
            handles: vec![item.handle],
            physical: item.physical,
            label: item.label,
        };
    }
    let first = &candidates[0];
    if first.physical.is_empty() {
        return SourceChoice::Ambiguous;
    }
    let mut handles = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        if candidate.physical != first.physical || handles.contains(&candidate.handle) {
            return SourceChoice::Ambiguous;
        }
        handles.push(candidate.handle);
    }
    SourceChoice::Unique {
        handles,
        physical: first.physical.clone(),
        label: first.label.clone(),
    }
}

fn extract_physical_id(raw_name: &str) -> String {
    let trimmed = raw_name.trim_matches('\0').trim();
    let body = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix(r"\??\"))
        .unwrap_or(trimmed);
    let mut parts = body.split('#');
    let Some(bus) = parts.next() else {
        return String::new();
    };
    let Some(device_id) = parts.next() else {
        return String::new();
    };
    let normalized = format!("{bus}#{device_id}").to_ascii_lowercase();
    let meaningful = normalized
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit() && *ch != '0')
        .count();
    if meaningful >= 6 {
        normalized
    } else {
        String::new()
    }
}

#[derive(Default)]
struct RemotePresses {
    choice: SourceChoice,
    home: KeyEdge,
    clear: KeyEdge,
    expired_clear: bool,
    pending: VecDeque<(RemoteButton, Instant)>,
}

impl RemotePresses {
    fn select(&mut self, choice: SourceChoice, home_held: bool, clear_held: bool) -> bool {
        if self.choice == choice {
            return false;
        }
        let same_physical = match (&self.choice, &choice) {
            (
                SourceChoice::Unique { physical: old, .. },
                SourceChoice::Unique { physical: next, .. },
            ) => !old.is_empty() && old == next,
            _ => false,
        };
        let preserve_home =
            same_physical && (self.home.await_release || self.home.down.is_some());
        let preserve_clear =
            same_physical && (self.clear.await_release || self.clear.down.is_some());
        let clear_lost = !same_physical;
        *self = Self {
            choice,
            home: KeyEdge {
                await_release: home_held || preserve_home,
                down: None,
            },
            clear: KeyEdge {
                await_release: clear_held || preserve_clear,
                down: None,
            },
            expired_clear: false,
            pending: VecDeque::new(),
        };
        clear_lost
    }

    fn has_handle(&self, device: usize) -> bool {
        matches!(&self.choice, SourceChoice::Unique { handles, .. } if handles.contains(&device))
    }

    fn edge(&mut self, device: usize, key: u16, release: bool, now: Instant) -> bool {
        if !self.has_handle(device) {
            return false;
        }
        let (button, slot) = match key {
            VK_HOME => (RemoteButton::Home, &mut self.home),
            VK_APPS => (RemoteButton::Clear, &mut self.clear),
            _ => return false,
        };
        if slot.await_release {
            if release {
                slot.await_release = false;
            }
        } else if release {
            if slot.down.take().is_some_and(|down| {
                now.checked_duration_since(down)
                    .is_some_and(|elapsed| elapsed < SHORT_PRESS)
            }) {
                self.expire(now);
                if self.pending.len() < 64 {
                    self.pending.push_back((button, now));
                }
                if button == RemoteButton::Clear {
                    self.expired_clear = false;
                }
            }
        } else {
            slot.down.get_or_insert(now);
        }
        button == RemoteButton::Clear
    }

    fn button_armed(&self, button: RemoteButton) -> bool {
        matches!(self.choice, SourceChoice::Unique { .. })
            && match button {
                RemoteButton::Home => !self.home.await_release,
                RemoteButton::Clear => !self.clear.await_release,
            }
    }

    fn expire(&mut self, now: Instant) {
        while self.pending.front().is_some_and(|(_, time)| {
            now.checked_duration_since(*time)
                .is_none_or(|elapsed| elapsed >= SHORT_PRESS)
        }) {
            if let Some((button, _)) = self.pending.pop_front() {
                if button == RemoteButton::Clear && self.button_armed(RemoteButton::Clear) {
                    self.expired_clear = true;
                }
            }
        }
    }

    fn poll(&mut self, wanted: RemoteButton, now: Instant) -> bool {
        if !matches!(self.choice, SourceChoice::Unique { .. }) {
            self.pending.clear();
            return false;
        }
        self.expire(now);
        while let Some(&(front, _)) = self.pending.front() {
            let armed = self.button_armed(front);
            if armed && front != wanted {
                // Preserve physical release order between Clear and Home so
                // switching windows never redirects an earlier Clear.
                return false;
            }
            self.pending.pop_front();
            if armed && front == wanted {
                if wanted == RemoteButton::Clear {
                    self.expired_clear = false;
                }
                return true;
            }
        }
        false
    }

    fn status(&self) -> ButtonStatus {
        match &self.choice {
            SourceChoice::Unique { label, .. } => ButtonStatus {
                supported: true,
                ready: !self.clear.await_release,
                home_ready: !self.home.await_release,
                clear_key: "菜单键".into(),
                device: label.clone(),
                error: if self.clear.await_release {
                    "启动时菜单键尚未释放，请先松开菜单键，再重新短按。".into()
                } else if self.expired_clear {
                    "清空按键等待过久，已丢弃这次操作；请确认光标后重新短按菜单键。".into()
                } else {
                    String::new()
                },
            },
            SourceChoice::None => ButtonStatus {
                supported: true,
                ready: false,
                home_ready: false,
                clear_key: "菜单键".into(),
                device: String::new(),
                error: "未找到唯一的 RC003 蓝牙键盘，菜单清空键暂不可用；可说“清除提示词”。"
                    .into(),
            },
            SourceChoice::Ambiguous => ButtonStatus {
                supported: true,
                ready: false,
                home_ready: false,
                clear_key: "菜单键".into(),
                device: String::new(),
                error: "发现多个遥控器键盘来源，已停用菜单清空键；请只连接一只遥控器，或说“清除提示词”。"
                    .into(),
            },
        }
    }
}

struct StandaloneSink {
    thread_id: u32,
    cancelled: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct Monitor {
    target: usize,
    original_flags: Option<RAWINPUTDEVICE_FLAGS>,
    standalone: Option<StandaloneSink>,
    presses: RemotePresses,
}

static MONITOR: std::sync::LazyLock<Mutex<Monitor>> =
    std::sync::LazyLock::new(|| Mutex::new(Monitor::default()));

fn keyboard_registration() -> Option<RAWINPUTDEVICE> {
    let mut count = 0;
    let size = size_of::<RAWINPUTDEVICE>() as u32;
    unsafe {
        if GetRegisteredRawInputDevices(null_mut(), &mut count, size) == u32::MAX
            || !(1..=256).contains(&count)
        {
            return None;
        }
        let mut entries = vec![RAWINPUTDEVICE::default(); count as usize];
        let got = GetRegisteredRawInputDevices(entries.as_mut_ptr(), &mut count, size);
        entries
            .get(..got as usize)?
            .iter()
            .find(|d| (d.usUsagePage, d.usUsage) == KEYBOARD)
            .copied()
    }
}

fn remote_candidate(device: HANDLE) -> Option<RemoteCandidate> {
    unsafe {
        let mut count = 0;
        if GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, null_mut(), &mut count) == u32::MAX
            || !(1..=32768).contains(&count)
        {
            return None;
        }
        let mut name = vec![0u16; count as usize + 1];
        if GetRawInputDeviceInfoW(
            device,
            RIDI_DEVICENAME,
            name.as_mut_ptr().cast(),
            &mut count,
        ) == u32::MAX
        {
            return None;
        }
        // Metadata-only access also works for system-owned keyboard collections.
        let file = CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        );
        if file == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut attrs = HIDD_ATTRIBUTES {
            Size: size_of::<HIDD_ATTRIBUTES>() as u32,
            ..Default::default()
        };
        let ok = HidD_GetAttributes(file, &mut attrs)
            && attrs.VendorID == 0x2717
            && attrs.ProductID == 0x32b8;
        let mut product_buf = [0u16; 128];
        let product = if ok
            && HidD_GetProductString(
                file,
                product_buf.as_mut_ptr().cast(),
                (product_buf.len() * size_of::<u16>()) as u32,
            )
        {
            let end = product_buf
                .iter()
                .position(|&ch| ch == 0)
                .unwrap_or(product_buf.len());
            String::from_utf16_lossy(&product_buf[..end])
                .trim()
                .to_owned()
        } else {
            String::new()
        };
        CloseHandle(file);
        if !ok {
            return None;
        }
        let end = name.iter().position(|&ch| ch == 0).unwrap_or(name.len());
        let raw_name = String::from_utf16_lossy(&name[..end]);
        let label = if product.is_empty() {
            "HID · Xiaomi RC003".into()
        } else {
            let trimmed: String = product.chars().take(80).collect();
            format!("HID · {trimmed}")
        };
        Some(RemoteCandidate {
            handle: device as usize,
            physical: extract_physical_id(&raw_name),
            label,
        })
    }
}

fn discover_source() -> SourceChoice {
    unsafe {
        let mut count = 0;
        let size = size_of::<RAWINPUTDEVICELIST>() as u32;
        if GetRawInputDeviceList(null_mut(), &mut count, size) == u32::MAX
            || !(1..=1024).contains(&count)
        {
            return SourceChoice::None;
        }
        let mut entries = vec![RAWINPUTDEVICELIST::default(); count as usize];
        let got = GetRawInputDeviceList(entries.as_mut_ptr(), &mut count, size);
        let Some(slice) = entries.get(..got as usize) else {
            return SourceChoice::None;
        };
        let candidates: Vec<RemoteCandidate> = slice
            .iter()
            .filter(|r| r.dwType == RIM_TYPEKEYBOARD)
            .filter_map(|r| remote_candidate(r.hDevice))
            .collect();
        classify_candidates(candidates)
    }
}

fn refresh_source(presses: &mut RemotePresses) {
    let home_held = unsafe { GetAsyncKeyState(VK_HOME.into()) < 0 };
    let clear_held = unsafe { GetAsyncKeyState(VK_APPS.into()) < 0 };
    if presses.select(discover_source(), home_held, clear_held) {
        clear_menu_suppression();
    }
}

unsafe fn handle_input(presses: &mut RemotePresses, raw: HRAWINPUT) {
    if !matches!(presses.choice, SourceChoice::Unique { .. }) {
        return;
    }
    let header_size = size_of::<RAWINPUTHEADER>() as u32;
    let mut size = header_size;
    let mut header = RAWINPUTHEADER::default();
    if GetRawInputData(
        raw,
        RID_HEADER,
        (&raw mut header).cast(),
        &mut size,
        header_size,
    ) != header_size
        || header.dwType != RIM_TYPEKEYBOARD
        || !presses.has_handle(header.hDevice as usize)
    {
        return; // Leave all other keyboards' input bodies unread.
    }
    let mut input = RAWINPUT::default();
    size = size_of::<RAWINPUT>() as u32;
    let got = GetRawInputData(
        raw,
        RID_INPUT,
        (&raw mut input).cast(),
        &mut size,
        header_size,
    );
    if got == u32::MAX || got < header_size + size_of::<RAWKEYBOARD>() as u32 {
        return;
    }
    let key = input.data.keyboard;
    let release = key.Flags & RI_KEY_BREAK as u16 != 0;
    if presses.edge(header.hDevice as usize, key.VKey, release, Instant::now()) {
        note_remote_menu_at(release, monotonic_ms());
    }
}

unsafe extern "system" fn observe(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if matches!(message, WM_INPUT | WM_INPUT_DEVICE_CHANGE | WM_NCDESTROY) {
        if let Ok(mut monitor) = MONITOR.lock() {
            if message == WM_NCDESTROY {
                clear_menu_suppression();
                monitor.target = 0;
                monitor.original_flags = None;
                monitor.presses = RemotePresses::default();
                RemoveWindowSubclass(hwnd, Some(observe), SUBCLASS_ID);
            } else if monitor.original_flags.is_some() || monitor.standalone.is_some() {
                if message == WM_INPUT_DEVICE_CHANGE {
                    // A fast unplug/replug can reuse the same numeric handle
                    // before enumeration catches up. Discard its old edges first.
                    if wparam == GIDC_REMOVAL as usize
                        && monitor.presses.has_handle(lparam as usize)
                    {
                        monitor.presses.select(SourceChoice::None, false, false);
                        clear_menu_suppression();
                    }
                    refresh_source(&mut monitor.presses);
                } else {
                    handle_input(&mut monitor.presses, lparam as HRAWINPUT);
                }
            }
        }
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn spawn_standalone_sink() -> Result<StandaloneSink, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_thread = Arc::clone(&cancelled);
    let startup_tid = Arc::new(AtomicU32::new(0));
    let report_tid = Arc::clone(&startup_tid);
    let (sender, receiver) = mpsc::sync_channel(1);
    let thread = thread::spawn(move || unsafe {
        let mut msg = MSG::default();
        PeekMessageW(&mut msg, null_mut(), 0, 0, PM_NOREMOVE);
        let tid = GetCurrentThreadId();
        report_tid.store(tid, Ordering::Release);
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = CreateWindowExW(
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
        if hwnd.is_null() {
            let _ = sender.send(Err("无法创建遥控器按键监听窗口".to_owned()));
            return;
        }
        if SetWindowSubclass(hwnd, Some(observe), SUBCLASS_ID, 0) == 0 {
            DestroyWindow(hwnd);
            let _ = sender.send(Err("无法注册遥控器按键消息回调".to_owned()));
            return;
        }
        let target = RAWINPUTDEVICE {
            usUsagePage: KEYBOARD.0,
            usUsage: KEYBOARD.1,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: hwnd,
        };
        if RegisterRawInputDevices(&target, 1, size_of::<RAWINPUTDEVICE>() as u32) == 0 {
            RemoveWindowSubclass(hwnd, Some(observe), SUBCLASS_ID);
            DestroyWindow(hwnd);
            let _ = sender.send(Err("无法启用遥控器按键监听".to_owned()));
            return;
        }
        let _ = sender.send(Ok(tid));
        while !cancel_thread.load(Ordering::Acquire) && GetMessageW(&mut msg, null_mut(), 0, 0) > 0
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let remove = RAWINPUTDEVICE {
            usUsagePage: KEYBOARD.0,
            usUsage: KEYBOARD.1,
            dwFlags: RIDEV_REMOVE,
            hwndTarget: null_mut(),
        };
        RegisterRawInputDevices(&remove, 1, size_of::<RAWINPUTDEVICE>() as u32);
        RemoveWindowSubclass(hwnd, Some(observe), SUBCLASS_ID);
        DestroyWindow(hwnd);
    });
    match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(thread_id)) => Ok(StandaloneSink {
            thread_id,
            cancelled,
            thread,
        }),
        Ok(Err(err)) => {
            let _ = thread.join();
            Err(err)
        }
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            let tid = startup_tid.load(Ordering::Acquire);
            if tid != 0 {
                unsafe {
                    PostThreadMessageW(tid, WM_QUIT, 0, 0);
                }
            }
            Err("启动遥控器按键监听超时".into())
        }
    }
}

/// Must run in Tauri setup on the thread that owns Tao's event window.
#[allow(dead_code)]
pub(crate) fn install() {
    if let Some(target) = keyboard_registration() {
        if !target.hwndTarget.is_null()
            && unsafe { SetWindowSubclass(target.hwndTarget, Some(observe), SUBCLASS_ID, 0) } != 0
        {
            if let Ok(mut monitor) = MONITOR.lock() {
                monitor.target = target.hwndTarget as usize;
            }
        }
    }
}

pub(super) struct HomeListener(());

impl HomeListener {
    pub(super) fn start() -> Result<Self, String> {
        let mut monitor = MONITOR.lock().map_err(|_| "遥控器按键监听不可用")?;
        if monitor.original_flags.is_some() || monitor.standalone.is_some() {
            return Err("另一个遥控器按键监听正在运行".into());
        }
        if let Some(mut target) = keyboard_registration().filter(|r| {
            monitor.target != 0 && r.hwndTarget as usize == monitor.target
        }) {
            let flags = target.dwFlags;
            target.dwFlags |= RIDEV_INPUTSINK | RIDEV_DEVNOTIFY;
            if unsafe { RegisterRawInputDevices(&target, 1, size_of::<RAWINPUTDEVICE>() as u32) }
                == 0
            {
                return Err("无法启用遥控器按键监听".into());
            }
            monitor.original_flags = Some(flags);
            refresh_source(&mut monitor.presses);
            return Ok(Self(()));
        }
        if keyboard_registration().is_none() {
            let sink = spawn_standalone_sink()?;
            monitor.standalone = Some(sink);
            refresh_source(&mut monitor.presses);
            return Ok(Self(()));
        }
        Err("无法连接当前窗口的遥控器按键监听".into())
    }

    pub(super) fn poll(&self) -> bool {
        MONITOR
            .lock()
            .is_ok_and(|mut monitor| monitor.presses.poll(RemoteButton::Home, Instant::now()))
    }

    pub(super) fn poll_clear(&self) -> bool {
        MONITOR
            .lock()
            .is_ok_and(|mut monitor| monitor.presses.poll(RemoteButton::Clear, Instant::now()))
    }

    pub(super) fn status(&self) -> ButtonStatus {
        MONITOR
            .lock()
            .map(|monitor| monitor.presses.status())
            .unwrap_or_else(|_| ButtonStatus {
                supported: true,
                ready: false,
                home_ready: false,
                clear_key: "菜单键".into(),
                device: String::new(),
                error: "遥控器按键状态不可用".into(),
            })
    }
}

impl Drop for HomeListener {
    fn drop(&mut self) {
        clear_menu_suppression();
        let standalone = if let Ok(mut monitor) = MONITOR.lock() {
            monitor.presses = RemotePresses::default();
            if let Some(flags) = monitor.original_flags.take() {
                // Keep any newer registration or target selected by the host.
                if let Some(mut target) = keyboard_registration().filter(|r| {
                    r.hwndTarget as usize == monitor.target
                        && r.dwFlags == flags | RIDEV_INPUTSINK | RIDEV_DEVNOTIFY
                }) {
                    target.dwFlags = flags;
                    unsafe {
                        RegisterRawInputDevices(&target, 1, size_of::<RAWINPUTDEVICE>() as u32);
                    }
                }
            }
            monitor.standalone.take()
        } else {
            None
        };
        if let Some(sink) = standalone {
            sink.cancelled.store(true, Ordering::Release);
            unsafe {
                PostThreadMessageW(sink.thread_id, WM_QUIT, 0, 0);
            }
            let _ = sink.thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(handle: usize) -> SourceChoice {
        SourceChoice::Unique {
            handles: vec![handle],
            physical: format!("hid#dev_{handle:012x}"),
            label: "HID · Xiaomi RC003".into(),
        }
    }

    #[test]
    fn only_distinct_short_home_and_menu_presses_on_the_selected_remote_fire() {
        let now = Instant::now();
        let mut presses = RemotePresses::default();
        presses.select(unique(11), true, true);
        assert!(!presses.status().ready);
        assert!(!presses.status().home_ready);

        presses.edge(11, VK_HOME, false, now); // held during activation
        presses.edge(11, VK_HOME, true, now);
        assert!(presses.status().home_ready);
        assert!(!presses.status().ready);

        presses.edge(11, VK_APPS, false, now); // held during activation
        presses.edge(11, VK_APPS, true, now);
        assert!(presses.status().ready);

        // Other keyboards and unrelated keys never queue actions.
        presses.edge(12, VK_HOME, false, now);
        presses.edge(12, VK_HOME, true, now);
        presses.edge(12, VK_APPS, false, now);
        presses.edge(12, VK_APPS, true, now);
        presses.edge(11, 0xf1, false, now);
        presses.edge(11, 0xf1, true, now);
        assert!(!presses.poll(RemoteButton::Home, now));
        assert!(!presses.poll(RemoteButton::Clear, now));

        for _ in 0..3 {
            presses.edge(11, VK_HOME, false, now);
            presses.edge(11, VK_HOME, false, now);
            presses.edge(11, VK_HOME, true, now);
        }
        for _ in 0..3 {
            assert!(presses.poll(RemoteButton::Home, now));
        }
        assert!(!presses.poll(RemoteButton::Home, now));

        for _ in 0..2 {
            presses.edge(11, VK_APPS, false, now);
            presses.edge(11, VK_APPS, false, now);
            presses.edge(11, VK_APPS, true, now);
        }
        assert!(presses.poll(RemoteButton::Clear, now));
        assert!(presses.poll(RemoteButton::Clear, now));
        assert!(!presses.poll(RemoteButton::Clear, now));

        // Long holds (>= 1s) and expired taps (>= 1s) do not fire.
        presses.edge(11, VK_APPS, false, now);
        presses.edge(11, VK_APPS, true, now + SHORT_PRESS);
        assert!(!presses.poll(RemoteButton::Clear, now + SHORT_PRESS));

        presses.edge(11, VK_APPS, false, now);
        presses.edge(11, VK_APPS, true, now);
        assert!(!presses.poll(RemoteButton::Clear, now + SHORT_PRESS));
        assert!(presses.status().error.contains("等待过久"));

        presses.edge(11, VK_APPS, false, now + SHORT_PRESS);
        presses.edge(11, VK_APPS, true, now + SHORT_PRESS + Duration::from_millis(50));
        assert!(presses.poll(
            RemoteButton::Clear,
            now + SHORT_PRESS + Duration::from_millis(60)
        ));
        assert_eq!(presses.status().error, "");

        presses.edge(11, VK_APPS, false, now);
        presses.edge(11, VK_APPS, true, now);
        presses.select(SourceChoice::None, false, false);
        presses.select(unique(13), false, false);
        presses.edge(13, VK_APPS, true, now);
        assert!(!presses.poll(RemoteButton::Clear, now));
    }

    #[test]
    fn release_order_between_clear_and_home_is_preserved() {
        let now = Instant::now();
        let mut presses = RemotePresses::default();
        presses.select(unique(21), false, false);

        presses.edge(21, VK_APPS, false, now);
        presses.edge(21, VK_APPS, true, now + Duration::from_millis(40));
        presses.edge(21, VK_HOME, false, now + Duration::from_millis(50));
        presses.edge(21, VK_HOME, true, now + Duration::from_millis(90));

        // Home is polled first in the BLE loop, so it must wait for the earlier Clear.
        assert!(!presses.poll(RemoteButton::Home, now + Duration::from_millis(100)));
        assert!(presses.poll(RemoteButton::Clear, now + Duration::from_millis(100)));
        assert!(presses.poll(RemoteButton::Home, now + Duration::from_millis(100)));
    }

    #[test]
    fn candidate_classification_unites_same_ble_instance_and_blocks_multiple_remotes() {
        let name_a = r"\\?\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&012717_PID&32b8_REV&00a4_e85540e13e8a#9&1b6dd9c6&0&0000#{884b96c3-56ef-11d1-bc8c-00a0c91405dd}";
        let name_b = r"\\?\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&012717_PID&32b8_REV&00a4_aabbccddeeff#9&22222222&0&0000#{884b96c3-56ef-11d1-bc8c-00a0c91405dd}";
        let phys_a = extract_physical_id(name_a);
        let phys_b = extract_physical_id(name_b);
        assert!(!phys_a.is_empty() && phys_a != phys_b);

        let same_device = classify_candidates(vec![
            RemoteCandidate {
                handle: 1,
                physical: phys_a.clone(),
                label: "HID · Xiaomi RC003".into(),
            },
            RemoteCandidate {
                handle: 2,
                physical: phys_a,
                label: "HID · Xiaomi RC003".into(),
            },
        ]);
        assert!(matches!(
            same_device,
            SourceChoice::Unique { ref handles, .. } if handles == &[1, 2]
        ));

        let two_remotes = classify_candidates(vec![
            RemoteCandidate {
                handle: 1,
                physical: extract_physical_id(name_a),
                label: "HID · Xiaomi RC003".into(),
            },
            RemoteCandidate {
                handle: 2,
                physical: phys_b,
                label: "HID · Xiaomi RC003".into(),
            },
        ]);
        assert_eq!(two_remotes, SourceChoice::Ambiguous);
    }

    #[test]
    fn menu_suppression_covers_both_raw_and_keyup_arrival_orders_without_touching_other_keys() {
        clear_menu_suppression();
        assert!(!should_suppress_menu_keydown());
        assert!(!take_menu_keyup_at(100));

        // Order A: keyup arrives while raw press is still held (before raw break).
        note_remote_menu_at(false, 1_000);
        assert!(suppress_menu_keydown_at(1_050));
        assert!(take_menu_keyup_at(1_100));
        note_remote_menu_at(true, 1_105);
        assert!(!take_menu_keyup_at(1_110));

        // Order B: raw break arrives slightly before keyup.
        note_remote_menu_at(false, 2_000);
        note_remote_menu_at(true, 2_080);
        assert!(!suppress_menu_keydown_at(2_085));
        assert!(take_menu_keyup_at(2_090));
        assert!(!take_menu_keyup_at(2_095));

        // Expired grace window never swallows a later ordinary keyboard Menu keyup.
        note_remote_menu_at(false, 3_000);
        note_remote_menu_at(true, 3_050);
        assert!(!take_menu_keyup_at(3_050 + MENU_RELEASE_GRACE_MS + 1));
    }
}
