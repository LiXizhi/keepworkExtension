//! A small OS-native launch window. No browser, document, or IPC bridge lives here.
//!
//! Creation and updates run on the Tauri main thread. The window owns its
//! controls and their callbacks, so hiding/reusing it does not detach actions.

use std::sync::Arc;
use tauri::{AppHandle, Manager, Theme, Window, WindowBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Retry,
    Hide,
}

type ActionHandler = Arc<dyn Fn(Action) + Send + Sync>;

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

pub(super) fn create(
    app: &AppHandle,
    theme: Theme,
    on_action: impl Fn(Action) + Send + Sync + 'static,
) -> Result<(), String> {
    if app.get_window("startup").is_some() {
        return Ok(());
    }
    let builder = WindowBuilder::new(app, "startup")
        .title("KeepWork 第二大脑")
        .inner_size(360.0, 176.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .theme(Some(theme))
        .center()
        .visible(false)
        .focused(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build().map_err(|error| error.to_string())?;
    if let Err(error) = platform::install(&window, Arc::new(on_action)) {
        let _ = window.destroy();
        return Err(error);
    }
    Ok(())
}

pub(super) fn update(app: &AppHandle, failed: bool) -> Result<(), String> {
    let window = app
        .get_window("startup")
        .ok_or("Native startup window is unavailable")?;
    platform::update(&window, failed)
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
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, DEFAULT_GUI_FONT};
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
    const SUBCLASS: usize = 0x4b575350;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS);
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
            let command = (wparam & 0xffff) as i32;
            match command {
                RETRY => Some(Action::Retry),
                HIDE => Some(Action::Hide),
                _ => None,
            }
        } else {
            None
        };
        if let Some(action) = action {
            // Clone before calling out: the action may synchronously hide or
            // destroy this native window and release its own handler.
            let callback = (&*(data as *const ActionHandler)).clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(action)));
            return 0;
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub(super) fn install(window: &Window, handler: ActionHandler) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let px = |value: i32| (value as f64 * scale).round() as i32;
        unsafe {
            let common = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS,
            };
            if InitCommonControlsEx(&common) == 0 {
                return Err("Cannot initialize native startup progress control".into());
            }
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
                    hwnd,
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
                [24, 30, 312, 26],
            );
            let summary = child(
                "STATIC",
                "正在准备工作台…",
                SS_CENTER as u32,
                SUMMARY,
                [24, 64, 312, 32],
            );
            let progress = child(
                "msctls_progress32",
                "",
                PBS_MARQUEE,
                PROGRESS,
                [120, 108, 120, 5],
            );
            let retry = child(
                "BUTTON",
                "重试",
                WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
                RETRY,
                [248, 126, 84, 30],
            );
            let hide = child(
                "BUTTON",
                "稍后",
                WS_TABSTOP | BS_PUSHBUTTON as u32,
                HIDE,
                [156, 126, 84, 30],
            );
            if [title, summary, progress, retry, hide]
                .iter()
                .any(|control| control.is_null())
            {
                return Err("Cannot create native startup controls".into());
            }
            ShowWindow(retry, SW_HIDE);
            ShowWindow(hide, SW_HIDE);
            SendMessageW(progress, PBM_SETMARQUEE, 1, 30);
            // A focused BUTTON receives its own key messages. Keep the same
            // local shortcuts on each focusable startup control, with separate
            // ownership released by that exact HWND's WM_NCDESTROY.
            for target in [hwnd, retry, hide] {
                let callback = Box::into_raw(Box::new(handler.clone()));
                if SetWindowSubclass(target, Some(window_proc), SUBCLASS, callback as usize) == 0 {
                    drop(Box::from_raw(callback));
                    return Err("Cannot connect native startup controls".into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn update(window: &Window, failed: bool) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        unsafe {
            SetWindowTextW(
                GetDlgItem(hwnd, TITLE),
                wide(if failed {
                    "暂时无法打开工作台"
                } else {
                    "KeepWork 第二大脑"
                })
                .as_ptr(),
            );
            SetWindowTextW(
                GetDlgItem(hwnd, SUMMARY),
                wide(if failed {
                    "请检查网络或本地服务后重试。"
                } else {
                    "正在准备工作台…"
                })
                .as_ptr(),
            );
            let progress = GetDlgItem(hwnd, PROGRESS);
            SendMessageW(progress, PBM_SETMARQUEE, (!failed) as WPARAM, 30);
            ShowWindow(progress, if failed { SW_HIDE } else { SW_SHOW });
            for id in [RETRY, HIDE] {
                ShowWindow(GetDlgItem(hwnd, id), if failed { SW_SHOW } else { SW_HIDE });
            }
            if failed && window.is_focused().unwrap_or(false) {
                SetFocus(GetDlgItem(hwnd, RETRY));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use gtk::prelude::*;

    pub(super) fn install(window: &Window, handler: ActionHandler) -> Result<(), String> {
        let native = window.gtk_window().map_err(|error| error.to_string())?;
        let on_key = handler.clone();
        native.connect_key_press_event(move |_, event| {
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
        layout.set_widget_name("keepwork-startup");
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
        // Tauri's native GTK window has no WebView child. Keep its existing
        // container if present, since the runtime owns the window hierarchy.
        if let Some(child) = native.child() {
            let container = child
                .downcast::<gtk::Container>()
                .map_err(|_| "Unsupported native startup container")?;
            container.add(&layout);
        } else {
            native.add(&layout);
        }
        layout.show_all();
        buttons.hide();
        Ok(())
    }

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
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::*;
    pub(super) fn install(_: &Window, _: ActionHandler) -> Result<(), String> {
        Err("Native startup controls are unavailable on this platform".into())
    }
    pub(super) fn update(_: &Window, _: bool) -> Result<(), String> {
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
