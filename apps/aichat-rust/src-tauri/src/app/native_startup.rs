//! A small OS-native startup overlay rendered INSIDE the main window. No
//! browser, document, or IPC bridge lives here, and no second OS window is
//! created. The overlay covers the WebView until the trusted document is ready,
//! then is removed in place. Creation and updates run on the Tauri main thread.
//!
//! The action handler is registered once by the host and reused whenever the
//! overlay re-appears (for example a manual reload after the page was ready).

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Theme, Window};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Retry,
    Hide,
}

type ActionHandler = Arc<dyn Fn(Action) + Send + Sync>;

static HANDLER: Mutex<Option<ActionHandler>> = Mutex::new(None);

// Match only startup-local shortcuts. Shift+Ctrl+R retains the previous
// renderer's case-insensitive reload shortcut; Alt/Meta combinations belong to
// the OS. Repeated reload keys are coalesced by PageConnection::begin.
#[cfg(any(windows, target_os = "linux", test))]
fn shortcut_action(key: u32, control: bool, alt: bool, shift: bool, meta: bool) -> Option<Action> {
    if alt || meta {
        return None;
    }
    match key {
        27 if !control && !shift => Some(Action::Hide),
        82 | 114 if control => Some(Action::Retry),
        _ => None,
    }
}

/// Register the host action handler and attach the overlay to the main window.
pub(super) fn install(
    app: &AppHandle,
    _theme: Theme,
    on_action: impl Fn(Action) + Send + Sync + 'static,
) -> Result<(), String> {
    *HANDLER.lock().unwrap() = Some(Arc::new(on_action));
    attach(app)
}

fn attach(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or("Native startup requires the main window")?;
    if platform::is_installed(&window) {
        return Ok(());
    }
    let handler = HANDLER
        .lock()
        .unwrap()
        .clone()
        .ok_or("Native startup handler is unavailable")?;
    platform::install(&window, handler)
}

/// Update the overlay, re-attaching it if a new attempt began after readiness.
pub(super) fn update(app: &AppHandle, failed: bool) -> Result<(), String> {
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    if !platform::is_installed(&window) {
        attach(app)?;
    }
    platform::update(&window, failed)
}

/// Remove the overlay in place once the trusted document is ready.
pub(super) fn remove(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    if !platform::is_installed(&window) {
        return Ok(());
    }
    platform::remove(&window)?;
    #[cfg(not(target_os = "macos"))]
    if window.is_focused().unwrap_or(false) {
        if let Some(webview) = app.get_webview("main") {
            let _ = webview.set_focus();
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::c_void;

    struct Callback(ActionHandler);

    extern "C" fn action(context: *mut c_void, retry: bool) {
        // Never unwind through an Objective-C action callback.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            let callback = (&*(context as *const Callback)).0.clone();
            callback(if retry { Action::Retry } else { Action::Hide });
        }));
    }

    extern "C" fn release(context: *mut c_void) {
        unsafe {
            drop(Box::from_raw(context as *mut Callback));
        }
    }

    extern "C" {
        fn keepwork_startup_install(
            window: *mut c_void,
            context: *mut c_void,
            action: extern "C" fn(*mut c_void, bool),
            release: extern "C" fn(*mut c_void),
        ) -> bool;
        fn keepwork_startup_update(window: *mut c_void, failed: bool) -> bool;
        fn keepwork_startup_remove(window: *mut c_void) -> bool;
        fn keepwork_startup_is_installed(window: *mut c_void) -> bool;
    }

    pub(super) fn is_installed(window: &Window) -> bool {
        window
            .ns_window()
            .map(|native| unsafe { keepwork_startup_is_installed(native) })
            .unwrap_or(false)
    }

    pub(super) fn install(window: &Window, handler: ActionHandler) -> Result<(), String> {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        let context = Box::into_raw(Box::new(Callback(handler))) as *mut c_void;
        if unsafe { keepwork_startup_install(native, context, action, release) } {
            Ok(())
        } else {
            release(context);
            Err("Cannot create native startup controls".into())
        }
    }

    pub(super) fn update(window: &Window, failed: bool) -> Result<(), String> {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        if unsafe { keepwork_startup_update(native, failed) } {
            Ok(())
        } else {
            Err("Cannot update native startup controls".into())
        }
    }

    pub(super) fn remove(window: &Window) -> Result<(), String> {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        if unsafe { keepwork_startup_remove(native) } {
            Ok(())
        } else {
            Err("Cannot remove native startup controls".into())
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::Once;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        FillRect, GetStockObject, GetSysColor, GetSysColorBrush, ScreenToClient, SetBkMode,
        SetTextColor, COLOR_WINDOW, COLOR_WINDOWTEXT, DEFAULT_GUI_FONT, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::SystemServices::SS_CENTER;
    use windows_sys::Win32::UI::Controls::{
        InitCommonControlsEx, ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, PBM_SETMARQUEE, PBS_MARQUEE,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, SetFocus, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const TITLE: i32 = 4101;
    const SUMMARY: i32 = 4102;
    const PROGRESS: i32 = 4103;
    const RETRY: i32 = 4104;
    const HIDE: i32 = 4105;
    const CAP_MIN: i32 = 4106;
    const CAP_MAX: i32 = 4107;
    const CAP_CLOSE: i32 = 4108;
    const PANEL_SUBCLASS: usize = 0x4b575350;
    const BUTTON_SUBCLASS: usize = 0x4b575351;
    const PARENT_SUBCLASS: usize = 0x4b575352;
    const CLASS_NAME: &str = "KeepworkStartupPanel";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn panel(hwnd: HWND) -> HWND {
        unsafe {
            FindWindowExW(
                hwnd,
                std::ptr::null_mut(),
                wide(CLASS_NAME).as_ptr(),
                std::ptr::null(),
            )
        }
    }

    fn register_class() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| unsafe {
            let class_name = wide(CLASS_NAME);
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()) as _,
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                hbrBackground: GetSysColorBrush(COLOR_WINDOW),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&class);
        });
    }

    // Center the identity group and the failure action row in the full client
    // area; keep a native caption row aligned to the 34px HTML titlebar so the
    // window can be moved, minimized, maximized and closed before chat loads.
    fn layout_controls(hwnd: HWND) {
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetClientRect(hwnd, &mut rect);
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            let scale = GetWindowLongPtrW(hwnd, GWLP_USERDATA).max(1000) as f64 / 1000.0;
            let px = |value: i32| (value as f64 * scale).round() as i32;
            let move_to = |id: i32, x: i32, y: i32, w: i32, h: i32| {
                let control = GetDlgItem(hwnd, id);
                if !control.is_null() {
                    MoveWindow(control, x, y, px(w), px(h), 1);
                }
            };
            move_to(CAP_CLOSE, width - px(46), px(3), 42, 28);
            move_to(CAP_MAX, width - px(90), px(3), 42, 28);
            move_to(CAP_MIN, width - px(134), px(3), 42, 28);
            let center_y = height / 2;
            move_to(TITLE, (width - px(320)) / 2, center_y - px(46), 320, 26);
            move_to(SUMMARY, (width - px(360)) / 2, center_y - px(12), 360, 32);
            move_to(PROGRESS, (width - px(120)) / 2, center_y + px(30), 120, 5);
            let row_left = (width - px(180)) / 2;
            move_to(HIDE, row_left, center_y + px(56), 84, 30);
            move_to(RETRY, row_left + px(96), center_y + px(56), 84, 30);
        }
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS);
        } else if message == WM_SIZE || message == WM_DPICHANGED {
            let child = panel(hwnd);
            if !child.is_null() {
                if message == WM_DPICHANGED {
                    SetWindowLongPtrW(
                        child,
                        GWLP_USERDATA,
                        ((wparam & 0xffff) * 1000 / 96) as isize,
                    );
                }
                let mut rect: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut rect);
                SetWindowPos(
                    child,
                    HWND_TOP,
                    0,
                    0,
                    rect.right,
                    rect.bottom,
                    SWP_NOACTIVATE,
                );
            }
        } else if message == WM_NCHITTEST {
            let child = panel(hwnd);
            if !child.is_null() {
                let mut point = POINT {
                    x: (lparam as i32 & 0xffff) as i16 as i32,
                    y: ((lparam as i32) >> 16) as i16 as i32,
                };
                ScreenToClient(hwnd, &mut point);
                let scale = GetWindowLongPtrW(child, GWLP_USERDATA).max(1000) as f64 / 1000.0;
                if point.y >= 0 && point.y < (34.0 * scale) as i32 {
                    return HTCAPTION as LRESULT;
                }
            }
        }
        result
    }

    unsafe extern "system" fn button_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(button_proc), BUTTON_SUBCLASS);
            drop(Box::from_raw(data as *mut ActionHandler));
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        if message == WM_KEYDOWN {
            let action = shortcut_action(
                wparam as u32,
                GetKeyState(VK_CONTROL as i32) < 0,
                GetKeyState(VK_MENU as i32) < 0,
                GetKeyState(VK_SHIFT as i32) < 0,
                GetKeyState(VK_LWIN as i32) < 0 || GetKeyState(VK_RWIN as i32) < 0,
            );
            if let Some(action) = action {
                let callback = (&*(data as *const ActionHandler)).clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(action)));
                return 0;
            }
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    unsafe extern "system" fn panel_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(panel_proc), PANEL_SUBCLASS);
            drop(Box::from_raw(data as *mut ActionHandler));
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        let action = if message == WM_KEYDOWN {
            shortcut_action(
                wparam as u32,
                GetKeyState(VK_CONTROL as i32) < 0,
                GetKeyState(VK_MENU as i32) < 0,
                GetKeyState(VK_SHIFT as i32) < 0,
                GetKeyState(VK_LWIN as i32) < 0 || GetKeyState(VK_RWIN as i32) < 0,
            )
        } else if message == WM_COMMAND && (wparam >> 16) == BN_CLICKED as usize {
            match (wparam & 0xffff) as i32 {
                RETRY => Some(Action::Retry),
                HIDE | CAP_CLOSE => Some(Action::Hide),
                CAP_MIN => {
                    ShowWindow(GetParent(hwnd), SW_MINIMIZE);
                    None
                }
                CAP_MAX => {
                    let parent = GetParent(hwnd);
                    let mut placement = WINDOWPLACEMENT {
                        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                        ..std::mem::zeroed()
                    };
                    if GetWindowPlacement(parent, &mut placement) != 0 {
                        let command = if placement.showCmd == SW_SHOWMAXIMIZED as u32 {
                            SW_RESTORE
                        } else {
                            SW_MAXIMIZE
                        };
                        ShowWindow(parent, command);
                    }
                    None
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some(action) = action {
            // Clone before calling out: the action may synchronously destroy
            // this panel and release its own handler.
            let callback = (&*(data as *const ActionHandler)).clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(action)));
            return 0;
        }
        match message {
            WM_SIZE => {
                layout_controls(hwnd);
                DefSubclassProc(hwnd, message, wparam, lparam)
            }
            WM_ERASEBKGND => {
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                GetClientRect(hwnd, &mut rect);
                FillRect(wparam as _, &rect, GetSysColorBrush(COLOR_WINDOW));
                1
            }
            WM_CTLCOLORSTATIC => {
                SetTextColor(wparam as _, GetSysColor(COLOR_WINDOWTEXT));
                SetBkMode(wparam as _, TRANSPARENT as i32);
                GetSysColorBrush(COLOR_WINDOW) as LRESULT
            }
            WM_NCHITTEST => {
                // Drag by the caption strip; the rest stays client so buttons
                // and the future HTML titlebar keep their own hit testing.
                let result = DefSubclassProc(hwnd, message, wparam, lparam);
                let y = ((lparam as i32) >> 16) as i16;
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                GetClientRect(hwnd, &mut rect);
                let mut point = POINT {
                    x: ((lparam as i32) & 0xffff) as i16 as i32,
                    y: y as i32,
                };
                ScreenToClient(hwnd, &mut point);
                let scale = GetWindowLongPtrW(hwnd, GWLP_USERDATA).max(1000) as f64 / 1000.0;
                if point.y >= 0 && point.y < (34.0 * scale) as i32 && result == HTCLIENT as LRESULT
                {
                    // Let the top-level window handle caption dragging.
                    HTTRANSPARENT as LRESULT
                } else {
                    result
                }
            }
            _ => DefSubclassProc(hwnd, message, wparam, lparam),
        }
    }

    pub(super) fn is_installed(window: &Window) -> bool {
        window
            .hwnd()
            .map(|hwnd| !panel(hwnd.0 as HWND).is_null())
            .unwrap_or(false)
    }

    pub(super) fn install(window: &Window, handler: ActionHandler) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let px = |value: i32| (value as f64 * scale).round() as i32;
        register_class();
        unsafe {
            let common = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS,
            };
            if InitCommonControlsEx(&common) == 0 {
                return Err("Cannot initialize native startup progress control".into());
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetClientRect(hwnd, &mut rect);
            let panel_hwnd = CreateWindowExW(
                0,
                wide(CLASS_NAME).as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                0,
                0,
                rect.right - rect.left,
                rect.bottom - rect.top,
                hwnd,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if panel_hwnd.is_null() {
                return Err("Cannot create native startup panel".into());
            }
            SetWindowLongPtrW(panel_hwnd, GWLP_USERDATA, (scale * 1000.0).round() as isize);
            if SetWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS, 0) == 0 {
                DestroyWindow(panel_hwnd);
                return Err("Cannot resize native startup panel".into());
            }
            // Keep the panel above the WebView2 child HWND.
            SetWindowPos(panel_hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            let child = |class: &str, text: &str, style: u32, id: i32, rect: [i32; 4]| {
                let control = CreateWindowExW(
                    0,
                    wide(class).as_ptr(),
                    wide(text).as_ptr(),
                    WS_CHILD | WS_VISIBLE | style,
                    px(rect[0]),
                    px(rect[1]),
                    px(rect[2]),
                    px(rect[3]),
                    panel_hwnd,
                    id as _,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                if !control.is_null() {
                    SendMessageW(
                        control,
                        WM_SETFONT,
                        GetStockObject(DEFAULT_GUI_FONT) as WPARAM,
                        1,
                    );
                }
                control
            };
            let title = child(
                "STATIC",
                "KeepWork 第二大脑",
                SS_CENTER as u32,
                TITLE,
                [0, 0, 320, 26],
            );
            let summary = child(
                "STATIC",
                "正在准备工作台…",
                SS_CENTER as u32,
                SUMMARY,
                [0, 0, 360, 32],
            );
            let progress = child(
                "msctls_progress32",
                "",
                PBS_MARQUEE,
                PROGRESS,
                [0, 0, 120, 5],
            );
            let retry = child(
                "BUTTON",
                "重试",
                WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
                RETRY,
                [0, 0, 84, 30],
            );
            let hide = child(
                "BUTTON",
                "稍后",
                WS_TABSTOP | BS_PUSHBUTTON as u32,
                HIDE,
                [0, 0, 84, 30],
            );
            let cap_min = child(
                "BUTTON",
                "—",
                WS_TABSTOP | BS_PUSHBUTTON as u32,
                CAP_MIN,
                [0, 0, 42, 28],
            );
            let cap_max = child(
                "BUTTON",
                "□",
                WS_TABSTOP | BS_PUSHBUTTON as u32,
                CAP_MAX,
                [0, 0, 42, 28],
            );
            let cap_close = child(
                "BUTTON",
                "✕",
                WS_TABSTOP | BS_PUSHBUTTON as u32,
                CAP_CLOSE,
                [0, 0, 42, 28],
            );
            if [
                title, summary, progress, retry, hide, cap_min, cap_max, cap_close,
            ]
            .iter()
            .any(|control| control.is_null())
            {
                RemoveWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS);
                DestroyWindow(panel_hwnd);
                return Err("Cannot create native startup controls".into());
            }
            ShowWindow(retry, SW_HIDE);
            ShowWindow(hide, SW_HIDE);
            SendMessageW(progress, PBM_SETMARQUEE, 1, 30);
            let panel_callback = Box::into_raw(Box::new(handler.clone()));
            if SetWindowSubclass(
                panel_hwnd,
                Some(panel_proc),
                PANEL_SUBCLASS,
                panel_callback as usize,
            ) == 0
            {
                drop(Box::from_raw(panel_callback));
                RemoveWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS);
                DestroyWindow(panel_hwnd);
                return Err("Cannot connect native startup panel".into());
            }
            // A focused BUTTON receives its own key messages; keep the same
            // local shortcuts on each focusable control, released by its HWND.
            for target in [retry, hide, cap_min, cap_max, cap_close] {
                let callback = Box::into_raw(Box::new(handler.clone()));
                if SetWindowSubclass(
                    target,
                    Some(button_proc),
                    BUTTON_SUBCLASS,
                    callback as usize,
                ) == 0
                {
                    drop(Box::from_raw(callback));
                    RemoveWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS);
                    DestroyWindow(panel_hwnd);
                    return Err("Cannot connect native startup controls".into());
                }
            }
            layout_controls(panel_hwnd);
            SetFocus(panel_hwnd);
        }
        Ok(())
    }

    pub(super) fn update(window: &Window, failed: bool) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let panel_hwnd = panel(hwnd);
        if panel_hwnd.is_null() {
            return Err("Native startup panel is unavailable".into());
        }
        unsafe {
            SetWindowTextW(
                GetDlgItem(panel_hwnd, TITLE),
                wide(if failed {
                    "暂时无法打开工作台"
                } else {
                    "KeepWork 第二大脑"
                })
                .as_ptr(),
            );
            SetWindowTextW(
                GetDlgItem(panel_hwnd, SUMMARY),
                wide(if failed {
                    "请检查网络或本地服务后重试。"
                } else {
                    "正在准备工作台…"
                })
                .as_ptr(),
            );
            let progress = GetDlgItem(panel_hwnd, PROGRESS);
            SendMessageW(progress, PBM_SETMARQUEE, (!failed) as WPARAM, 30);
            ShowWindow(progress, if failed { SW_HIDE } else { SW_SHOW });
            for id in [RETRY, HIDE] {
                ShowWindow(
                    GetDlgItem(panel_hwnd, id),
                    if failed { SW_SHOW } else { SW_HIDE },
                );
            }
            if failed && window.is_focused().unwrap_or(false) {
                SetFocus(GetDlgItem(panel_hwnd, RETRY));
            }
        }
        Ok(())
    }

    pub(super) fn remove(window: &Window) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let panel_hwnd = panel(hwnd);
        if !panel_hwnd.is_null() {
            unsafe {
                RemoveWindowSubclass(hwnd, Some(parent_proc), PARENT_SUBCLASS);
                DestroyWindow(panel_hwnd);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use gtk::prelude::*;

    fn find(widget: gtk::Widget, name: &str) -> Option<gtk::Widget> {
        if widget.widget_name() == name {
            return Some(widget);
        }
        let container = widget.downcast::<gtk::Container>().ok()?;
        container
            .children()
            .into_iter()
            .find_map(|child| find(child, name))
    }

    pub(super) fn is_installed(window: &Window) -> bool {
        window
            .gtk_window()
            .map(|native| find(native.upcast::<gtk::Widget>(), "keepwork-startup").is_some())
            .unwrap_or(false)
    }

    pub(super) fn install(window: &Window, handler: ActionHandler) -> Result<(), String> {
        let native = window.gtk_window().map_err(|error| error.to_string())?;
        // Keep the WebView mapped while it loads; the native layer blocks
        // painting and input without suspending the document's ready callback.
        let host = match native.child() {
            Some(child) if child.widget_name() == "keepwork-startup-host" => child
                .downcast::<gtk::Overlay>()
                .map_err(|_| "Unsupported native startup host")?,
            Some(child) => {
                let host = gtk::Overlay::new();
                host.set_widget_name("keepwork-startup-host");
                native.remove(&child);
                host.add(&child);
                native.add(&host);
                host.show();
                host
            }
            None => return Err("Missing native document container".into()),
        };
        let panel = gtk::EventBox::new();
        panel.set_widget_name("keepwork-startup");
        panel.set_can_focus(true);
        panel.style_context().add_class("background");
        let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let caption = gtk::EventBox::new();
        let caption_row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        caption_row.set_size_request(-1, 34);
        let title = gtk::Label::new(Some("KeepWork 第二大脑"));
        title.set_margin_start(12);
        caption_row.pack_start(&title, false, false, 0);
        let minimize = gtk::Button::with_label("—");
        let maximize = gtk::Button::with_label("□");
        let close = gtk::Button::with_label("×");
        let weak_window = native.downgrade();
        minimize.connect_clicked(move |_| {
            if let Some(window) = weak_window.upgrade() {
                window.iconify();
            }
        });
        let weak_window = native.downgrade();
        maximize.connect_clicked(move |_| {
            if let Some(window) = weak_window.upgrade() {
                if window.is_maximized() {
                    window.unmaximize();
                } else {
                    window.maximize();
                }
            }
        });
        let on_close = handler.clone();
        close.connect_clicked(move |_| on_close(Action::Hide));
        caption_row.pack_end(&close, false, false, 0);
        caption_row.pack_end(&maximize, false, false, 0);
        caption_row.pack_end(&minimize, false, false, 0);
        caption.add(&caption_row);
        let weak_window = native.downgrade();
        caption.connect_button_press_event(move |_, event| {
            if event.button() == 1 {
                if let Some(window) = weak_window.upgrade() {
                    let (x, y) = event.root();
                    window.begin_move_drag(1, x as i32, y as i32, event.time());
                }
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
        body.pack_start(&caption, false, false, 0);
        let on_key = handler.clone();
        panel.connect_key_press_event(move |_, event| {
            let key = match event.keyval() {
                gtk::gdk::keys::constants::Escape => 27,
                gtk::gdk::keys::constants::R | gtk::gdk::keys::constants::r => 82,
                _ => 0,
            };
            let modifiers = event.state();
            let action = shortcut_action(
                key,
                modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK),
                modifiers.contains(gtk::gdk::ModifierType::MOD1_MASK),
                modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK),
                modifiers.intersects(
                    gtk::gdk::ModifierType::META_MASK
                        | gtk::gdk::ModifierType::SUPER_MASK
                        | gtk::gdk::ModifierType::HYPER_MASK,
                ),
            );
            if let Some(action) = action {
                on_key(action);
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
        let layout = gtk::Box::new(gtk::Orientation::Vertical, 20);
        layout.set_halign(gtk::Align::Center);
        layout.set_valign(gtk::Align::Center);
        layout.set_margin_start(28);
        layout.set_margin_end(28);
        let identity = gtk::Box::new(gtk::Orientation::Horizontal, 16);
        let text = gtk::Box::new(gtk::Orientation::Vertical, 6);
        text.set_valign(gtk::Align::Center);
        let status = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(
            include_bytes!("../../icons/keepwork.png").as_slice(),
        ))
        .map_err(|error| error.to_string())?
        .scale_simple(48, 48, gtk::gdk_pixbuf::InterpType::Bilinear)
        .ok_or("Cannot scale native startup icon")?;
        let icon = gtk::Image::from_pixbuf(Some(&pixbuf));
        let title = gtk::Label::new(Some("KeepWork 第二大脑"));
        title.set_widget_name("startup-title");
        title.set_markup("<span size='large' weight='semibold'>KeepWork 第二大脑</span>");
        title.set_xalign(0.0);
        let summary = gtk::Label::new(Some("正在准备工作台…"));
        summary.set_widget_name("startup-summary");
        summary.set_xalign(0.0);
        let spinner = gtk::Spinner::new();
        spinner.set_widget_name("startup-spinner");
        spinner.set_size_request(12, 12);
        spinner.set_valign(gtk::Align::Center);
        spinner.start();
        let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        buttons.set_widget_name("startup-actions");
        buttons.set_halign(gtk::Align::End);
        let retry = gtk::Button::with_label("重试");
        let hide = gtk::Button::with_label("稍后");
        let on_retry = handler.clone();
        retry.connect_clicked(move |_| on_retry(Action::Retry));
        hide.connect_clicked(move |_| handler(Action::Hide));
        buttons.pack_start(&hide, false, false, 0);
        buttons.pack_start(&retry, false, false, 0);
        status.pack_start(&spinner, false, false, 0);
        status.pack_start(&summary, false, false, 0);
        text.pack_start(&title, false, false, 0);
        text.pack_start(&status, false, false, 0);
        identity.pack_start(&icon, false, false, 0);
        identity.pack_start(&text, true, true, 0);
        layout.pack_start(&identity, false, false, 0);
        layout.pack_start(&buttons, false, false, 0);
        body.pack_start(&layout, true, true, 0);
        panel.add(&body);
        host.add_overlay(&panel);
        host.set_overlay_pass_through(&panel, false);
        panel.show_all();
        buttons.hide();
        panel.grab_focus();
        Ok(())
    }

    pub(super) fn update(window: &Window, failed: bool) -> Result<(), String> {
        let root = window
            .gtk_window()
            .map_err(|error| error.to_string())?
            .upcast::<gtk::Widget>();
        let summary = find(root.clone(), "startup-summary")
            .and_then(|w| w.downcast::<gtk::Label>().ok())
            .ok_or("Missing native startup summary")?;
        let spinner = find(root.clone(), "startup-spinner")
            .and_then(|w| w.downcast::<gtk::Spinner>().ok())
            .ok_or("Missing native startup spinner")?;
        let buttons = find(root, "startup-actions").ok_or("Missing native startup actions")?;
        summary.set_text(if failed {
            "暂时无法打开工作台"
        } else {
            "正在准备工作台…"
        });
        summary.set_tooltip_text(failed.then_some("请检查网络或本地服务后重试。"));
        if failed {
            spinner.stop();
            spinner.hide();
            buttons.show();
        } else {
            buttons.hide();
            spinner.show();
            spinner.start();
        }
        Ok(())
    }

    pub(super) fn remove(window: &Window) -> Result<(), String> {
        let root = window
            .gtk_window()
            .map_err(|error| error.to_string())?
            .upcast::<gtk::Widget>();
        if let Some(panel) = find(root, "keepwork-startup") {
            // The shortcut signal belongs to this widget, not the main window;
            // destroying it releases the handler before the page takes focus.
            unsafe { panel.destroy() };
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::*;
    pub(super) fn is_installed(_: &Window) -> bool {
        false
    }
    pub(super) fn install(_: &Window, _: ActionHandler) -> Result<(), String> {
        Err("Native startup controls are unavailable on this platform".into())
    }
    pub(super) fn update(_: &Window, _: bool) -> Result<(), String> {
        Err("Native startup controls are unavailable on this platform".into())
    }
    pub(super) fn remove(_: &Window) -> Result<(), String> {
        Err("Native startup controls are unavailable on this platform".into())
    }
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;

    #[test]
    fn native_shortcuts_keep_reload_local_and_preserve_system_modifiers() {
        assert_eq!(
            shortcut_action(82, true, false, false, false),
            Some(Action::Retry)
        );
        assert_eq!(
            shortcut_action(114, true, false, true, false),
            Some(Action::Retry)
        );
        // A repeated event has the same meaning; the host owns navigation
        // deduplication rather than per-control keyboard state.
        assert_eq!(
            shortcut_action(82, true, false, false, false),
            Some(Action::Retry)
        );
        assert_eq!(
            shortcut_action(27, false, false, false, false),
            Some(Action::Hide)
        );
        for (key, control, alt, shift, meta) in [
            (82, false, false, false, false),
            (82, false, true, false, false),
            (82, true, true, false, false),
            (82, true, false, false, true),
            (27, false, true, false, false),
            (27, true, false, false, false),
            (27, false, false, true, false),
            (27, false, false, false, true),
            (0, true, false, false, false),
        ] {
            assert_eq!(shortcut_action(key, control, alt, shift, meta), None);
        }
    }
}
