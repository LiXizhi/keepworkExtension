//! Observe RC003 Home on Tao's existing Raw Input target. Windows permits only
//! one registered raw keyboard target per process. Always chain Tao's handler.
use std::collections::VecDeque;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows_sys::Win32::Devices::HumanInterfaceDevice::{HidD_GetAttributes, HIDD_ATTRIBUTES};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_HOME};
use windows_sys::Win32::UI::Input::*;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const KEYBOARD: (u16, u16) = (1, 6);
const SUBCLASS_ID: usize = 0x4b57484d;
const SHORT_PRESS: Duration = Duration::from_secs(1);

#[derive(Default)]
struct HomePresses {
    source: Option<usize>,
    await_release: bool,
    down: Option<Instant>,
    pending: VecDeque<Instant>,
}

impl HomePresses {
    fn select(&mut self, source: Option<usize>, held: bool) {
        if self.source != source {
            *self = Self {
                source,
                await_release: held,
                ..Self::default()
            };
        }
    }

    fn edge(&mut self, device: usize, key: u16, release: bool, now: Instant) {
        if Some(device) != self.source || key != VK_HOME {
            return;
        }
        if self.await_release {
            if release {
                self.await_release = false;
            }
        } else if release {
            if self
                .down
                .take()
                .is_some_and(|down| now.duration_since(down) < SHORT_PRESS)
            {
                self.expire(now);
                if self.pending.len() < 64 {
                    self.pending.push_back(now);
                }
            }
        } else {
            self.down.get_or_insert(now);
        }
    }

    fn expire(&mut self, now: Instant) {
        while self
            .pending
            .front()
            .is_some_and(|time| now.duration_since(*time) >= SHORT_PRESS)
        {
            self.pending.pop_front();
        }
    }

    fn poll(&mut self, now: Instant) -> bool {
        self.expire(now);
        self.pending.pop_front().is_some()
    }
}

#[derive(Default)]
struct Monitor {
    target: usize,
    original_flags: Option<RAWINPUTDEVICE_FLAGS>,
    presses: HomePresses,
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

fn is_remote(device: HANDLE) -> bool {
    unsafe {
        let mut count = 0;
        if GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, null_mut(), &mut count) == u32::MAX
            || !(1..=32768).contains(&count)
        {
            return false;
        }
        let mut name = vec![0u16; count as usize + 1];
        if GetRawInputDeviceInfoW(
            device,
            RIDI_DEVICENAME,
            name.as_mut_ptr().cast(),
            &mut count,
        ) == u32::MAX
        {
            return false;
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
            return false;
        }
        let mut attrs = HIDD_ATTRIBUTES {
            Size: size_of::<HIDD_ATTRIBUTES>() as u32,
            ..Default::default()
        };
        let ok = HidD_GetAttributes(file, &mut attrs);
        CloseHandle(file);
        ok && attrs.VendorID == 0x2717 && attrs.ProductID == 0x32b8
    }
}

fn unique_remote() -> Option<usize> {
    unsafe {
        let mut count = 0;
        let size = size_of::<RAWINPUTDEVICELIST>() as u32;
        if GetRawInputDeviceList(null_mut(), &mut count, size) == u32::MAX
            || !(1..=1024).contains(&count)
        {
            return None;
        }
        let mut entries = vec![RAWINPUTDEVICELIST::default(); count as usize];
        let got = GetRawInputDeviceList(entries.as_mut_ptr(), &mut count, size);
        let mut remotes = entries
            .get(..got as usize)?
            .iter()
            .filter(|r| r.dwType == RIM_TYPEKEYBOARD && is_remote(r.hDevice));
        let remote = remotes.next()?.hDevice as usize;
        remotes.next().is_none().then_some(remote)
    }
}

fn refresh_source(presses: &mut HomePresses) {
    presses.select(unique_remote(), unsafe {
        GetAsyncKeyState(VK_HOME.into()) < 0
    });
}

unsafe fn handle_input(presses: &mut HomePresses, raw: HRAWINPUT) {
    let Some(device) = presses.source else {
        return;
    };
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
        || header.hDevice as usize != device
        || header.dwType != RIM_TYPEKEYBOARD
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
    presses.edge(
        device,
        key.VKey,
        key.Flags & RI_KEY_BREAK as u16 != 0,
        Instant::now(),
    );
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
                *monitor = Monitor::default();
                RemoveWindowSubclass(hwnd, Some(observe), SUBCLASS_ID);
            } else if monitor.original_flags.is_some() {
                if message == WM_INPUT_DEVICE_CHANGE {
                    // A fast unplug/replug can reuse the same numeric handle
                    // before enumeration catches up. Discard its old edges first.
                    if wparam == GIDC_REMOVAL as usize
                        && monitor.presses.source == Some(lparam as usize)
                    {
                        monitor.presses.select(None, false);
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

/// Must run in Tauri setup on the thread that owns Tao's event window.
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
        let mut monitor = MONITOR.lock().map_err(|_| "遥控器主页键监听不可用")?;
        let mut target = keyboard_registration()
            .filter(|r| {
                monitor.target != 0
                    && r.hwndTarget as usize == monitor.target
                    && monitor.original_flags.is_none()
            })
            .ok_or("无法连接当前窗口的遥控器主页键监听")?;
        let flags = target.dwFlags;
        target.dwFlags |= RIDEV_INPUTSINK | RIDEV_DEVNOTIFY;
        if unsafe { RegisterRawInputDevices(&target, 1, size_of::<RAWINPUTDEVICE>() as u32) } == 0 {
            return Err("无法启用遥控器主页键".into());
        }
        monitor.original_flags = Some(flags);
        refresh_source(&mut monitor.presses);
        Ok(Self(()))
    }

    pub(super) fn poll(&self) -> bool {
        MONITOR
            .lock()
            .is_ok_and(|mut monitor| monitor.presses.poll(Instant::now()))
    }

    pub(super) fn ready(&self) -> bool {
        MONITOR
            .lock()
            .is_ok_and(|monitor| monitor.presses.source.is_some())
    }
}

impl Drop for HomeListener {
    fn drop(&mut self) {
        if let Ok(mut monitor) = MONITOR.lock() {
            monitor.presses = HomePresses::default();
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_distinct_short_home_presses_on_the_selected_remote_toggle() {
        let now = Instant::now();
        let mut presses = HomePresses::default();
        presses.select(Some(11), true);
        presses.edge(11, VK_HOME, false, now); // held during activation
        presses.edge(11, VK_HOME, true, now);
        presses.edge(12, VK_HOME, false, now);
        presses.edge(12, VK_HOME, true, now);
        presses.edge(11, 0xf1, false, now);
        presses.edge(11, 0xf1, true, now);
        for _ in 0..3 {
            presses.edge(11, VK_HOME, false, now);
            presses.edge(11, VK_HOME, false, now);
            presses.edge(11, VK_HOME, true, now);
        }
        for _ in 0..3 {
            assert!(presses.poll(now));
        }
        assert!(!presses.poll(now));

        presses.edge(11, VK_HOME, false, now);
        presses.edge(11, VK_HOME, true, now + SHORT_PRESS);
        assert!(!presses.poll(now + SHORT_PRESS));
        presses.edge(11, VK_HOME, false, now);
        presses.edge(11, VK_HOME, true, now);
        assert!(!presses.poll(now + SHORT_PRESS));
        presses.edge(11, VK_HOME, false, now);
        presses.edge(11, VK_HOME, true, now);
        presses.select(None, false);
        presses.select(Some(13), false);
        presses.edge(13, VK_HOME, true, now);
        assert!(!presses.poll(now));
    }
}
