//! Windows demo isolation before keyboard input reaches WebView2 or the shell.
use std::cell::RefCell;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const SUBCLASS_ID: usize = 0x4b57444d;
const REPORTS: [&str; 4] = ["back", "home", "menu", "volume"];
const HOOK_LOST: u64 = u64::MAX;
static INSTALLED_WINDOW: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_WINDOW: AtomicUsize = AtomicUsize::new(0);

fn is_demo_foreground(hwnd: usize) -> bool {
    hwnd != 0
        && ACTIVE_WINDOW.load(Ordering::Acquire) == hwnd
        && unsafe { GetForegroundWindow() as usize == hwnd }
}

unsafe extern "system" fn app_command_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    match message {
        WM_APPCOMMAND if is_demo_foreground(hwnd as usize) => return 1,
        WM_ACTIVATE if (wparam & 0xffff) == WA_INACTIVE as usize => {
            let _ = ACTIVE_WINDOW.compare_exchange(
                hwnd as usize,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        WM_NCDESTROY => {
            let _ = ACTIVE_WINDOW.compare_exchange(
                hwnd as usize,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            let _ = INSTALLED_WINDOW.compare_exchange(
                hwnd as usize,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            RemoveWindowSubclass(hwnd, Some(app_command_proc), SUBCLASS_ID);
        }
        _ => {}
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

// Called on the owning UI thread as the settings window is built. DefWindowProc
// would otherwise pass an unhandled application command to the shell.
pub(super) fn install_app_command_guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    if unsafe { SetWindowSubclass(hwnd, Some(app_command_proc), SUBCLASS_ID, 0) } == 0 {
        return Err("无法拦截遥控器系统命令。".into());
    }
    INSTALLED_WINDOW.store(hwnd as usize, Ordering::Release);
    Ok(())
}

#[derive(Clone, Copy, Default)]
struct Key {
    down: bool,
    delivered: bool,
    demo_bit: u8,
}

struct KeyPolicy {
    keys: [Key; 256],
    mask: u8,
}

impl KeyPolicy {
    fn new(initially_down: impl Fn(u16) -> bool) -> Self {
        Self {
            keys: std::array::from_fn(|index| {
                let vk = index as u16;
                let down = tracks_key(vk) && initially_down(vk);
                Key {
                    down,
                    delivered: down,
                    demo_bit: 0,
                }
            }),
            mask: 0,
        }
    }

    fn modifier_down(&self, keys: &[u16]) -> bool {
        keys.iter().any(|&vk| self.keys[vk as usize].down)
    }

    fn edge(&mut self, vk: u16, released: bool, alt_context: bool) -> bool {
        if !tracks_key(vk) {
            // Unrelated keystrokes are consumed without retaining their values.
            return true;
        }
        let shortcut = alt_context || self.modifier_down(&SHORTCUT_MODIFIERS);
        let shifted = self.modifier_down(&SHIFT_KEYS);
        let pass =
            !shortcut && (SHIFT_KEYS.contains(&vk) || vk == VK_TAB || (!shifted && web_key(vk)));
        let key = &mut self.keys[vk as usize];
        let suppress = if released {
            // Preserve the release for a key-down that already reached Windows.
            let suppress = if key.down { !key.delivered } else { !pass };
            *key = Key::default();
            suppress
        } else if key.down {
            !key.delivered || !pass
        } else {
            *key = Key {
                down: true,
                delivered: pass,
                demo_bit: if shortcut || shifted { 0 } else { demo_bit(vk) },
            };
            !pass
        };
        self.mask = REPORT_KEYS
            .iter()
            .fold(0, |mask, &vk| mask | self.keys[vk as usize].demo_bit);
        suppress
    }
}

const SHIFT_KEYS: [u16; 3] = [VK_SHIFT, VK_LSHIFT, VK_RSHIFT];
const SHORTCUT_MODIFIERS: [u16; 8] = [
    VK_CONTROL,
    VK_LCONTROL,
    VK_RCONTROL,
    VK_MENU,
    VK_LMENU,
    VK_RMENU,
    VK_LWIN,
    VK_RWIN,
];

fn web_key(vk: u16) -> bool {
    matches!(
        vk,
        VK_ESCAPE | VK_RETURN | VK_SPACE | VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT
    )
}

fn tracks_key(vk: u16) -> bool {
    vk == VK_TAB
        || web_key(vk)
        || SHIFT_KEYS.contains(&vk)
        || SHORTCUT_MODIFIERS.contains(&vk)
        || demo_bit(vk) != 0
}

const REPORT_KEYS: [u16; 8] = [
    VK_BACK,
    VK_BROWSER_BACK,
    VK_HOME,
    VK_BROWSER_HOME,
    VK_APPS,
    VK_VOLUME_MUTE,
    VK_VOLUME_DOWN,
    VK_VOLUME_UP,
];

// A low-level keyboard event has no device handle. These keys are demo aliases,
// while the independent Raw Input listener identifies the actual remote.
fn demo_bit(vk: u16) -> u8 {
    match vk {
        VK_BACK | VK_BROWSER_BACK => 1,
        VK_HOME | VK_BROWSER_HOME => 2,
        VK_APPS => 4,
        VK_VOLUME_MUTE | VK_VOLUME_DOWN | VK_VOLUME_UP => 8,
        _ => 0,
    }
}

struct HookState {
    hwnd: usize,
    policy: KeyPolicy,
    latest: Arc<AtomicU64>,
    report: mpsc::SyncSender<u64>,
}

thread_local! { static HOOK: RefCell<Option<HookState>> = const { RefCell::new(None) }; }

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 {
        let suppress = HOOK.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(state) = slot.as_mut().filter(|state| is_demo_foreground(state.hwnd)) else {
                return false;
            };
            let keyboard = &*(lparam as *const KBDLLHOOKSTRUCT);
            let before = state.policy.mask;
            let suppress = state.policy.edge(
                keyboard.vkCode as u16,
                keyboard.flags & LLKHF_UP != 0,
                keyboard.flags & LLKHF_ALTDOWN != 0,
            );
            if state.policy.mask != before {
                let next = ((state.latest.load(Ordering::Relaxed) & !0xff) + 0x100)
                    | u64::from(state.policy.mask);
                state.latest.store(next, Ordering::Release);
                let _ = state.report.try_send(next);
            }
            suppress
        });
        if suppress {
            return 1;
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 && blocks_mouse_action(wparam as u32) {
        let hwnd = ACTIVE_WINDOW.load(Ordering::Acquire);
        if is_demo_foreground(hwnd) {
            let pointer = &*(lparam as *const MSLLHOOKSTRUCT);
            if GetAncestor(WindowFromPoint(pointer.pt), GA_ROOT) as usize == hwnd {
                return 1;
            }
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

fn blocks_mouse_action(message: u32) -> bool {
    // Native navigation buttons and zoom/scroll can be handled by the webview
    // before a document receives a DOM event. Primary presses stay available.
    matches!(
        message,
        WM_XBUTTONDOWN | WM_XBUTTONUP | WM_MOUSEWHEEL | WM_MOUSEHWHEEL
    )
}

pub(super) struct Guard {
    hwnd: usize,
    live: Arc<AtomicBool>,
    thread_id: u32,
    worker: Option<JoinHandle<()>>,
}

impl Guard {
    pub(super) fn start(
        window: &tauri::WebviewWindow,
        report: Arc<dyn Fn(&'static str, bool) + Send + Sync>,
    ) -> Result<Self, String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        if hwnd != INSTALLED_WINDOW.load(Ordering::Acquire)
            || unsafe { GetForegroundWindow() as usize } != hwnd
            || ACTIVE_WINDOW
                .compare_exchange(0, hwnd, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err("遥控器演示窗口无法拦截系统输入。".into());
        }
        let live = Arc::new(AtomicBool::new(true));
        let thread_live = Arc::clone(&live);
        let reporter_live = Arc::clone(&live);
        let latest = Arc::new(AtomicU64::new(0));
        let reported = Arc::clone(&latest);
        let (send_edge, recv_edge) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut previous = 0;
            let mut publish = |next: u64| {
                if next <= previous || !reporter_live.load(Ordering::Acquire) {
                    return;
                }
                for (index, key) in REPORTS.iter().enumerate() {
                    let bit = 1 << index;
                    if ((previous ^ next) & bit) != 0 {
                        report(key, next & bit != 0);
                    }
                }
                previous = next;
            };
            while let Ok(next) = recv_edge.recv() {
                if next == HOOK_LOST {
                    report("unavailable", false);
                    return;
                }
                publish(next);
                for next in recv_edge.try_iter() {
                    if next == HOOK_LOST {
                        report("unavailable", false);
                        return;
                    }
                    publish(next);
                }
                // A saturated accessory cannot leave the last release undisplayed.
                publish(reported.load(Ordering::Acquire));
            }
        });

        let (startup, ready) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || unsafe {
            let mut message = MSG::default();
            PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
            let policy = KeyPolicy::new(|vk| {
                // Low-level events use side-specific codes. Querying both a
                // generic modifier and its side would leave the generic held.
                !matches!(vk, VK_SHIFT | VK_CONTROL | VK_MENU)
                    && GetAsyncKeyState(i32::from(vk)) < 0
            });
            HOOK.with(|slot| {
                *slot.borrow_mut() = Some(HookState {
                    hwnd,
                    policy,
                    latest,
                    report: send_edge.clone(),
                })
            });
            let module = GetModuleHandleW(null());
            let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0);
            if keyboard.is_null() {
                return;
            }
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0);
            if mouse.is_null() {
                UnhookWindowsHookEx(keyboard);
                return;
            }
            if startup.send(GetCurrentThreadId()).is_ok() {
                while thread_live.load(Ordering::Acquire)
                    && GetMessageW(&mut message, null_mut(), 0, 0) > 0
                {}
                if thread_live.load(Ordering::Acquire) {
                    let _ = ACTIVE_WINDOW.compare_exchange(
                        hwnd,
                        0,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                    let _ = send_edge.try_send(HOOK_LOST);
                }
            }
            UnhookWindowsHookEx(mouse);
            UnhookWindowsHookEx(keyboard);
        });
        match ready.recv_timeout(Duration::from_secs(2)) {
            Ok(thread_id) => Ok(Self {
                hwnd,
                live,
                thread_id,
                worker: Some(worker),
            }),
            Err(_) => {
                live.store(false, Ordering::Release);
                let _ =
                    ACTIVE_WINDOW.compare_exchange(hwnd, 0, Ordering::AcqRel, Ordering::Acquire);
                Err("无法拦截遥控器演示键盘输入。".into())
            }
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.live.store(false, Ordering::Release);
        let _ = ACTIVE_WINDOW.compare_exchange(self.hwnd, 0, Ordering::AcqRel, Ordering::Acquire);
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_navigation_and_accessible_exit_reach_the_demo_document() {
        let mut policy = KeyPolicy::new(|_| false);
        for vk in [
            VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN, VK_ESCAPE, VK_RETURN, VK_SPACE, VK_TAB,
        ] {
            assert!(!policy.edge(vk, false, false));
            assert!(!policy.edge(vk, true, false));
        }
        assert!(!policy.edge(VK_LSHIFT, false, false));
        assert!(!policy.edge(VK_TAB, false, false));
        assert!(!policy.edge(VK_TAB, true, false));
        assert!(!policy.edge(VK_LSHIFT, true, false));
    }

    #[test]
    fn media_actions_are_consumed_and_overlapping_volume_buttons_release_independently() {
        let mut policy = KeyPolicy::new(|_| false);
        assert!(policy.edge(VK_VOLUME_UP, false, false));
        assert!(policy.edge(VK_VOLUME_DOWN, false, false));
        assert_eq!(policy.mask, 8);
        assert!(policy.edge(VK_VOLUME_UP, true, false));
        assert_eq!(policy.mask, 8);
        assert!(policy.edge(VK_VOLUME_DOWN, true, false));
        assert_eq!(policy.mask, 0);
        for vk in [
            VK_BROWSER_BACK,
            VK_BROWSER_HOME,
            VK_APPS,
            VK_MEDIA_PLAY_PAUSE,
        ] {
            assert!(policy.edge(vk, false, false));
            assert!(policy.edge(vk, true, false));
        }
    }

    #[test]
    fn shell_chords_are_consumed_and_preexisting_keys_get_a_release() {
        let mut policy = KeyPolicy::new(|vk| vk == VK_LMENU);
        assert!(policy.edge(VK_TAB, false, true));
        assert!(policy.edge(VK_TAB, true, true));
        assert!(!policy.edge(VK_LMENU, true, true));
        for modifier in [VK_LCONTROL, VK_RMENU, VK_LWIN] {
            assert!(policy.edge(modifier, false, false));
            assert!(policy.edge(VK_RETURN, false, false));
            assert!(policy.edge(VK_RETURN, true, false));
            assert!(policy.edge(modifier, true, false));
        }
        assert!(!policy.edge(VK_ESCAPE, false, false));
        assert!(!policy.edge(VK_ESCAPE, true, false));
        assert_eq!(policy.mask, 0);
    }

    #[test]
    fn unrelated_typing_and_native_accelerators_do_not_enter_the_feedback_state() {
        let mut policy = KeyPolicy::new(|vk| {
            assert!(!matches!(vk, VK_A | VK_F4 | VK_F5 | VK_SNAPSHOT));
            false
        });
        for vk in [VK_A, VK_F4, VK_F5, VK_SNAPSHOT] {
            assert!(policy.edge(vk, false, false));
            assert!(policy.edge(vk, false, true));
            assert!(policy.edge(vk, true, false));
            assert!(!policy.keys[vk as usize].down);
        }
        assert_eq!(policy.mask, 0);
    }

    #[test]
    fn native_side_buttons_and_scroll_are_isolated_without_blocking_diagram_clicks() {
        for message in [WM_XBUTTONDOWN, WM_XBUTTONUP, WM_MOUSEWHEEL, WM_MOUSEHWHEEL] {
            assert!(blocks_mouse_action(message));
        }
        for message in [WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP] {
            assert!(!blocks_mouse_action(message));
        }
    }
}
