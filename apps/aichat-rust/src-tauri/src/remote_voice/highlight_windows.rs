//! Paint a click-through border for the current Windows dictation target.
//! UI Automation runs separately from the window thread so a slow provider
//! cannot retain the border after a release or block the Bluetooth event loop.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::*;
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT, SIZE},
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::*,
};

static ACTIVE: AtomicU64 = AtomicU64::new(0);
// IDs increase for every press. A delayed phase from an older press can never
// supersede a newer waiting ID or turn a fresh recording into a waiting cue.
static TRANSCRIBING: AtomicU64 = AtomicU64::new(0);
struct Workers {
    probe: thread::Thread,
    frames: mpsc::Sender<Option<Frame>>,
}
static WORKERS: OnceLock<Option<Workers>> = OnceLock::new();

pub(super) fn start(id: u64) {
    if let Some(workers) = WORKERS.get_or_init(Workers::spawn) {
        ACTIVE.store(id, Ordering::Release);
        workers.probe.unpark();
    }
}

pub(super) fn transcribing(id: u64) {
    if ACTIVE.load(Ordering::Acquire) == id {
        TRANSCRIBING.fetch_max(id, Ordering::AcqRel);
        if let Some(Some(workers)) = WORKERS.get() {
            // Wake the window thread directly, even if UIA is still inside its first call.
            let _ = workers.frames.send(None);
            workers.probe.unpark();
        }
    }
}

// Coalesce caption revisions; the paint thread owns the HWND and never takes focus.
static CAPTION: Mutex<Option<(u64, String)>> = Mutex::new(None);

pub(super) fn preview(id: u64, text: &str) {
    if let Ok(mut value) = CAPTION.lock() {
        if ACTIVE.load(Ordering::Acquire) != id { return; }
        *value = (!text.is_empty()).then(|| (id, text.to_owned()));
    }
    if let Some(Some(workers)) = WORKERS.get() {
        let _ = workers.frames.send(None);
    }
}

pub(super) fn end(id: u64) {
    if ACTIVE
        .compare_exchange(id, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        if let Ok(mut value) = CAPTION.lock() {
            if value.as_ref().is_some_and(|(owner, _)| *owner == id) { *value = None; }
        }
        if let Some(Some(workers)) = WORKERS.get() {
            let _ = workers.frames.send(None);
            workers.probe.unpark();
        }
    }
}

impl Workers {
    fn spawn() -> Option<Self> {
        let (frames, receiver) = mpsc::channel();
        let sender = frames.clone();
        thread::Builder::new()
            .name("voice-outline".into())
            .spawn(move || paint_frames(receiver))
            .ok()?;
        let probe = thread::Builder::new()
            .name("voice-outline-focus".into())
            .spawn(move || {
                loop {
                    if ACTIVE.load(Ordering::Acquire) == 0 {
                        thread::park();
                        continue;
                    }
                    // This apartment owns all UIA interfaces and never touches the clipboard.
                    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
                    let automation = initialized.then(|| unsafe { automation().ok() }).flatten();
                    loop {
                        let id = ACTIVE.load(Ordering::Acquire);
                        if id == 0 {
                            break;
                        }
                        let observed = Instant::now();
                        let target = automation
                            .as_ref()
                            .and_then(|(uia, cache)| unsafe { focused_target(uia, cache) });
                        if sender
                            .send(Some(Frame {
                                id,
                                target,
                                observed,
                            }))
                            .is_err()
                        {
                            return;
                        }
                        thread::park_timeout(Duration::from_millis(75));
                    }
                    drop(automation);
                    if initialized {
                        unsafe { CoUninitialize() };
                    }
                }
            })
            .ok()?;
        Some(Self {
            probe: probe.thread().clone(),
            frames,
        })
    }
}

unsafe fn automation() -> windows::core::Result<(IUIAutomation2, IUIAutomationCacheRequest)> {
    let uia: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
    uia.SetConnectionTimeout(250)?;
    uia.SetTransactionTimeout(250)?;
    let cache = uia.CreateCacheRequest()?;
    for property in [
        UIA_HasKeyboardFocusPropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_IsPasswordPropertyId,
        UIA_ControlTypePropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_ValueIsReadOnlyPropertyId,
    ] {
        cache.AddProperty(property)?;
    }
    cache.AddPattern(UIA_ValuePatternId)?;
    Ok((uia, cache))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Bounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Bounds {
    fn clipped(self, area: Self) -> Option<Self> {
        let result = Self {
            left: self.left.max(area.left),
            top: self.top.max(area.top),
            right: self.right.min(area.right),
            bottom: self.bottom.min(area.bottom),
        };
        // Use checked subtraction for arbitrary provider coordinates.
        let width = result.right.checked_sub(result.left)?;
        let height = result.bottom.checked_sub(result.top)?;
        (width >= 6 && height >= 6).then_some(result)
    }
}
impl From<RECT> for Bounds {
    fn from(r: RECT) -> Self {
        Self {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    foreground: usize,
    focus: usize,
    bounds: Bounds,
}
struct Frame {
    id: u64,
    target: Option<Target>,
    observed: Instant,
}

unsafe fn gui_focus() -> Option<(HWND, GUITHREADINFO)> {
    let foreground = GetForegroundWindow();
    if foreground.is_null() {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let tid = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
    if tid == 0
        || GetGUIThreadInfo(tid, &mut info) == 0
        || info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE | GUI_INMOVESIZE)
            != 0
        || info.hwndFocus.is_null()
        || GetAncestor(info.hwndFocus, GA_ROOT) != foreground
    {
        return None;
    }
    Some((foreground, info))
}

// Chromium and custom editors may expose only a document/pane and a native
// insertion caret. Keep the cue local to that caret instead of framing the app.
unsafe fn caret_bounds(info: &GUITHREADINFO) -> Option<Bounds> {
    if info.hwndCaret.is_null() || info.hwndCaret != info.hwndFocus {
        return None;
    }
    let r = info.rcCaret;
    let h = r.bottom.checked_sub(r.top)?;
    if !(2..=256).contains(&h) || !(0..=128).contains(&r.right.checked_sub(r.left)?) {
        return None;
    }
    let mut origin = POINT {
        x: r.left,
        y: r.top,
    };
    if ClientToScreen(info.hwndCaret, &mut origin) == 0 {
        return None;
    }
    Some(Bounds {
        left: origin.x.saturating_sub(5),
        top: origin.y.saturating_sub(2),
        right: origin.x.saturating_add(9),
        bottom: origin.y.saturating_add(h).saturating_add(2),
    })
}

unsafe fn focused_target(
    uia: &IUIAutomation2,
    cache: &IUIAutomationCacheRequest,
) -> Option<Target> {
    let (foreground, info) = gui_focus()?;
    let el = uia.GetFocusedElementBuildCache(cache).ok()?;
    if !el.CachedHasKeyboardFocus().ok()?.as_bool()
        || !el.CachedIsEnabled().ok()?.as_bool()
        || el.CachedIsOffscreen().ok()?.as_bool()
        || el.CachedIsPassword().ok()?.as_bool()
    {
        return None;
    }
    let role = el.CachedControlType().ok()?;
    if ![
        UIA_EditControlTypeId,
        UIA_CustomControlTypeId,
        UIA_DocumentControlTypeId,
        UIA_PaneControlTypeId,
    ]
    .contains(&role)
    {
        return None;
    }
    let value = el
        .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok();
    if let Some(value) = &value {
        if value.CachedIsReadOnly().ok()?.as_bool() {
            return None;
        }
    }
    let mut frame = RECT::default();
    if GetWindowRect(foreground, &mut frame) == 0 {
        return None;
    }
    let area = Bounds::from(frame);
    let field = (role == UIA_EditControlTypeId && value.is_some())
        .then(|| {
            let r = el.CachedBoundingRectangle().ok()?;
            Bounds {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            }
            .clipped(area)
        })
        .flatten();
    let bounds = field.or_else(|| caret_bounds(&info)?.clipped(area))?;
    let (current, after) = gui_focus()?;
    (current == foreground && after.hwndFocus == info.hwndFocus).then_some(Target {
        foreground: foreground as usize,
        focus: info.hwndFocus as usize,
        bounds,
    })
}

const STYLE: u32 =
    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
const CLASS: windows_sys::core::PCWSTR = windows_sys::w!("KeepworkRemoteVoiceOutline");

unsafe fn create_outline() -> Option<HWND> {
    static CLASS_ATOM: OnceLock<u16> = OnceLock::new();
    let module = GetModuleHandleW(std::ptr::null());
    let atom = CLASS_ATOM.get_or_init(|| {
        // The registered window class owns the brush for the process lifetime.
        let brush = CreateSolidBrush(0x005855BB); // muted warm red, RGB(187, 85, 88)
        if brush.is_null() {
            return 0;
        }
        let atom = RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(DefWindowProcW),
            hInstance: module,
            hbrBackground: brush,
            lpszClassName: CLASS,
            ..Default::default()
        });
        if atom == 0 {
            DeleteObject(brush);
        }
        atom
    });
    if *atom == 0 {
        return None;
    }
    let hwnd = CreateWindowExW(
        STYLE,
        CLASS,
        std::ptr::null(),
        WS_POPUP,
        0,
        0,
        0,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        module,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        return None;
    }
    Some(hwnd)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cue {
    Outline,
    Dots { raised: Option<u8> },
}

impl Cue {
    fn alpha(self) -> u8 {
        match self {
            Self::Outline => 128,
            Self::Dots { .. } => 235,
        }
    }
}

fn waiting_cue(elapsed: Duration, animate: bool) -> Cue {
    Cue::Dots {
        raised: animate.then(|| ((elapsed.as_millis() / 240) % 3) as u8),
    }
}

unsafe fn animations_enabled() -> bool {
    let mut enabled: i32 = 0;
    SystemParametersInfoW(
        SPI_GETCLIENTAREAANIMATION,
        0,
        (&mut enabled as *mut i32).cast(),
        0,
    ) != 0
        && enabled != 0
}

unsafe fn outline_region(width: i32, height: i32) -> HRGN {
    let outer = CreateRectRgn(0, 0, width, height);
    let inner = CreateRectRgn(2, 2, width - 2, height - 2);
    let ok = !outer.is_null()
        && !inner.is_null()
        && CombineRgn(outer, outer, inner, RGN_DIFF) != RGN_ERROR;
    if !inner.is_null() {
        DeleteObject(inner);
    }
    if !ok {
        if !outer.is_null() {
            DeleteObject(outer);
        }
        return std::ptr::null_mut();
    }
    outer
}

const DOT_RADIUS: i32 = 4;
const DOT_STEP: i32 = 13;
const DOT_WIDTH: i32 = DOT_STEP * 2 + DOT_RADIUS * 2;
const DOT_HEIGHT: i32 = 4 + DOT_RADIUS * 2;

fn dot_bounds(x: i32, y: i32, work: Bounds) -> Option<Bounds> {
    let max_x = work.right.checked_sub(DOT_WIDTH)?;
    let max_y = work.bottom.checked_sub(DOT_HEIGHT)?;
    if max_x < work.left || max_y < work.top {
        return None;
    }
    let left = if x.saturating_add(16) <= max_x {
        x.saturating_add(16)
    } else {
        x.saturating_sub(DOT_WIDTH + 8)
    }
    .clamp(work.left, max_x);
    let top = if y.saturating_add(20) <= max_y {
        y.saturating_add(20)
    } else {
        y.saturating_sub(DOT_HEIGHT + 8)
    }
    .clamp(work.top, max_y);
    Some(Bounds {
        left,
        top,
        right: left + DOT_WIDTH,
        bottom: top + DOT_HEIGHT,
    })
}

fn compact_dot_bounds(field: Bounds, work: Bounds) -> Option<Bounds> {
    let width = i64::from(field.right) - i64::from(field.left);
    let height = i64::from(field.bottom) - i64::from(field.top);
    let work_width = i64::from(work.right) - i64::from(work.left);
    let work_height = i64::from(work.bottom) - i64::from(work.top);
    if width > 720.min(work_width * 3 / 4) || height > 180.min(work_height / 3) {
        return None;
    }
    let field = field.clipped(work)?;
    if work_width < i64::from(DOT_WIDTH) || work_height < i64::from(DOT_HEIGHT) {
        return None;
    }
    let left = field
        .right
        .saturating_sub(DOT_WIDTH)
        .clamp(work.left, work.right - DOT_WIDTH);
    let below = field.bottom.saturating_add(3);
    let y = if below <= work.bottom - DOT_HEIGHT {
        below
    } else {
        field.top.saturating_sub(DOT_HEIGHT + 3)
    };
    let top = y.clamp(work.top, work.bottom - DOT_HEIGHT);
    Some(Bounds {
        left,
        top,
        right: left + DOT_WIDTH,
        bottom: top + DOT_HEIGHT,
    })
}

unsafe fn monitor_work_area(monitor: HMONITOR) -> Option<Bounds> {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    (GetMonitorInfoW(monitor, &mut info) != 0).then(|| info.rcWork.into())
}

unsafe fn field_dot_bounds(field: Bounds) -> Option<Bounds> {
    let rect = RECT {
        left: field.left,
        top: field.top,
        right: field.right,
        bottom: field.bottom,
    };
    compact_dot_bounds(
        field,
        monitor_work_area(MonitorFromRect(&rect, MONITOR_DEFAULTTONULL))?,
    )
}

unsafe fn cursor_dot_bounds() -> Option<Bounds> {
    let mut cursor = POINT::default();
    if GetCursorPos(&mut cursor) == 0 {
        return None;
    }
    let work = monitor_work_area(MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST))?;
    dot_bounds(cursor.x, cursor.y, work)
}

unsafe fn dots_region(raised: Option<u8>) -> HRGN {
    let all = CreateRectRgn(0, 0, 0, 0);
    if all.is_null() {
        return all;
    }
    for i in 0..3u8 {
        let x = i32::from(i) * DOT_STEP;
        let y = if raised == Some(i) { 0 } else { 4 };
        let dot = CreateEllipticRgn(x, y, x + 2 * DOT_RADIUS, y + 2 * DOT_RADIUS);
        let ok = !dot.is_null() && CombineRgn(all, all, dot, RGN_OR) != RGN_ERROR;
        if !dot.is_null() {
            DeleteObject(dot);
        }
        if !ok {
            DeleteObject(all);
            return std::ptr::null_mut();
        }
    }
    all
}

unsafe fn show_cue(hwnd: HWND, b: Bounds, cue: Cue) -> bool {
    if SetLayeredWindowAttributes(hwnd, 0, cue.alpha(), LWA_ALPHA) == 0 {
        return false;
    }
    let region = match cue {
        Cue::Outline => outline_region(b.right - b.left, b.bottom - b.top),
        Cue::Dots { raised } => dots_region(raised),
    };
    // Windows owns the region only after successful SetWindowRgn.
    if region.is_null() {
        return false;
    }
    if SetWindowRgn(hwnd, region, 1) == 0 {
        DeleteObject(region);
        return false;
    }
    if SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        b.left,
        b.top,
        b.right - b.left,
        b.bottom - b.top,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    ) == 0
    {
        return false;
    }
    RedrawWindow(
        hwnd,
        std::ptr::null(),
        std::ptr::null_mut(),
        RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW,
    );
    true
}

// A late probe may neither resurrect an ended press nor hide a newer one.
fn next_target(
    active: u64,
    painted: Option<(u64, Target)>,
    next: Option<Frame>,
) -> Option<(u64, Target)> {
    if active == 0 {
        return None;
    }
    match next {
        Some(frame) if frame.id == active => frame.target.map(|target| (active, target)),
        _ => painted.filter(|(id, _)| *id == active),
    }
}

// A transcription is a status of the cloud request, not of a particular edit control.
// In particular it has immediate geometry even when there has never been a UIA result.
fn cue_bounds(
    cue: Cue,
    field: Option<Bounds>,
    field_dots: impl FnOnce(Bounds) -> Option<Bounds>,
    pointer: impl FnOnce() -> Option<Bounds>,
) -> Option<Bounds> {
    match cue {
        Cue::Outline => field,
        Cue::Dots { .. } => field.and_then(field_dots).or_else(pointer),
    }
}

struct Caption {
    hwnd: HWND,
    displayed: String,
    width: i32,
}

impl Caption {
    unsafe fn new() -> Option<Self> {
        use windows_sys::Win32::System::SystemServices::{SS_CENTER, SS_CENTERIMAGE, SS_NOPREFIX};
        let hwnd = CreateWindowExW(STYLE, windows_sys::w!("STATIC"), std::ptr::null(),
            WS_POPUP | WS_BORDER | SS_CENTER | SS_CENTERIMAGE | SS_NOPREFIX,
            0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null());
        if hwnd.is_null() { return None; }
        SetLayeredWindowAttributes(hwnd, 0, 244, LWA_ALPHA);
        SendMessageW(hwnd, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT) as usize, 0);
        Some(Self { hwnd, displayed: String::new(), width: 0 })
    }

    unsafe fn show(&mut self, text: &str, field: Option<Bounds>, waiting: bool) {
        let Some(anchor) = field.and_then(|b| field_dot_bounds(b)).or_else(|| cursor_dot_bounds()) else {
            ShowWindow(self.hwnd, SW_HIDE);
            return;
        };
        let point = POINT { x: anchor.left, y: anchor.top };
        let Some(work) = monitor_work_area(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)) else { return; };
        let max_width = (work.right - work.left).min(460);
        if max_width < 30 { ShowWindow(self.hwnd, SW_HIDE); return; }
        if self.displayed != text || self.width > max_width {
            let dc = GetDC(self.hwnd);
            if dc.is_null() { return; }
            let old_font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
            let mut wide: Vec<u16> = text.replace(['\n', '\r'], " ").encode_utf16().collect();
            let mut start = 0;
            let mut extent = SIZE::default();
            while start < wide.len() {
                if GetTextExtentPoint32W(dc, wide[start..].as_ptr(), (wide.len()-start) as i32, &mut extent) == 0
                    || extent.cx + 20 <= max_width { break; }
                start += 1;
                if wide.get(start).is_some_and(|unit| (0xdc00..=0xdfff).contains(unit)) { start += 1; }
            }
            SelectObject(dc, old_font);
            ReleaseDC(self.hwnd, dc);
            self.width = (extent.cx + 20).clamp(30, max_width);
            wide.push(0);
            SetWindowTextW(self.hwnd, wide[start..].as_ptr());
            self.displayed = text.to_owned();
        }
        let left = anchor.left.clamp(work.left, work.right - self.width);
        let top = (anchor.top - 32 - if waiting { 4 } else { 0 }).max(work.top);
        SetWindowPos(self.hwnd, HWND_TOPMOST, left, top, self.width, 28, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

impl Drop for Caption {
    fn drop(&mut self) { unsafe { DestroyWindow(self.hwnd); } }
}

fn paint_frames(rx: mpsc::Receiver<Option<Frame>>) {
    let mut visible: Option<(HWND, (u64, Bounds, Cue))> = None;
    let mut caption: Option<Caption> = None;
    let mut latest_field: Option<(u64, Target)> = None;
    let mut waiting: Option<(u64, Instant, bool)> = None;
    let mut last_observed = Instant::now();
    loop {
        let next = if visible.is_some() || waiting.is_some() {
            match rx.recv_timeout(Duration::from_millis(16)) {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(frame) => frame,
                Err(_) => break,
            }
        };
        // A queued probe from an ended press may never display its outline.
        let active = ACTIVE.load(Ordering::Acquire);
        if let Some(frame) = next.as_ref().filter(|f| f.id == active) {
            last_observed = frame.observed;
        }
        latest_field = next_target(active, latest_field, next);
        unsafe {
            let cue = if active != 0 && TRANSCRIBING.load(Ordering::Acquire) == active {
                if waiting.is_none_or(|(id, _, _)| id != active) {
                    waiting = Some((active, Instant::now(), animations_enabled()));
                }
                let (_, began, animate) = waiting.unwrap();
                waiting_cue(began.elapsed(), animate)
            } else {
                waiting = None;
                Cue::Outline
            };
            // Retain the field through a phase-only wake, but don't show stale UIA geometry
            // if a provider stalls or focus changes while recognition is running.
            let brief = matches!(cue, Cue::Outline)
                || last_observed.elapsed() <= Duration::from_millis(350);
            let field = latest_field.filter(|_| brief).and_then(|(_, target)| {
                let (fg, info) = gui_focus()?;
                (fg as usize == target.foreground && info.hwndFocus as usize == target.focus)
                    .then_some(target.bounds)
            });
            let text = CAPTION.lock().ok().and_then(|v| v.as_ref().filter(|(id, _)| *id == active).map(|(_, s)| s.clone()));
            if let Some(text) = text {
                if caption.is_none() { caption = Caption::new(); }
                if let Some(window) = &mut caption { window.show(&text, field, waiting.is_some()); }
            } else {
                caption = None;
            }
            let new_frame = if active == 0 {
                None
            } else {
                cue_bounds(cue, field, |b| field_dot_bounds(b), || cursor_dot_bounds())
                    .map(|b| (active, b, cue))
            };
            if visible.map(|(_, frame)| frame) != new_frame {
                if let Some(frame) = new_frame {
                    let hwnd = visible.map(|(hwnd, _)| hwnd).or_else(|| create_outline());
                    visible = hwnd.and_then(|hwnd| {
                        if show_cue(hwnd, frame.1, frame.2) {
                            Some((hwnd, frame))
                        } else {
                            DestroyWindow(hwnd);
                            None
                        }
                    });
                } else if let Some((hwnd, _)) = visible.take() {
                    DestroyWindow(hwnd);
                }
            }
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&msg);
            }
        }
    }
    if let Some((hwnd, _)) = visible {
        unsafe {
            DestroyWindow(hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_geometry_is_clipped_to_foreground_including_negative_desktop_coordinates() {
        let window = Bounds {
            left: -1000,
            top: -50,
            right: 0,
            bottom: 650,
        };
        let field = Bounds {
            left: -1200,
            top: 130,
            right: -20,
            bottom: 180,
        };
        assert_eq!(
            field.clipped(window),
            Some(Bounds {
                left: -1000,
                ..field
            })
        );
        assert_eq!(
            Bounds {
                left: 10,
                right: 50,
                ..field
            }
            .clipped(window),
            None
        );
        assert_eq!(
            Bounds {
                bottom: 133,
                ..field
            }
            .clipped(window),
            None
        );
        let invalid = Bounds {
            left: i32::MIN,
            top: i32::MIN,
            right: i32::MAX,
            bottom: i32::MAX,
        };
        assert_eq!(invalid.clipped(invalid), None);
    }

    #[test]
    fn rapid_repress_drops_previous_outline_before_the_new_focus_probe_returns() {
        let target = Target {
            foreground: 10,
            focus: 20,
            bounds: Bounds {
                left: 30,
                top: 40,
                right: 50,
                bottom: 60,
            },
        };
        let a = Some((1, target));
        let b = Some((2, target));
        let frame = |id, target| {
            Some(Frame {
                id,
                target,
                observed: Instant::now(),
            })
        };
        assert_eq!(next_target(0, a, frame(1, Some(target))), None);
        assert_eq!(next_target(2, a, None), None);
        assert_eq!(next_target(2, a, frame(1, None)), None);
        assert_eq!(next_target(2, a, frame(1, Some(target))), None);
        assert_eq!(next_target(2, a, frame(2, Some(target))), b);
        assert_eq!(next_target(2, b, frame(1, None)), b);
        assert_eq!(next_target(2, b, frame(2, None)), None);
    }

    #[test]
    fn waiting_dots_cycle_three_positions_and_hold_still_for_reduced_motion() {
        assert_eq!(Cue::Outline.alpha(), 128);
        assert!(waiting_cue(Duration::ZERO, false).alpha() > Cue::Outline.alpha());
        for i in 0..6 {
            let time = Duration::from_millis(i * 240);
            assert_eq!(
                waiting_cue(time, true),
                Cue::Dots {
                    raised: Some((i % 3) as u8)
                }
            );
            assert_eq!(waiting_cue(time, false), Cue::Dots { raised: None });
        }
    }

    #[test]
    fn waiting_status_has_geometry_on_first_frame_even_if_the_focus_provider_stalls() {
        let work = Bounds {
            left: -1280,
            top: -100,
            right: 0,
            bottom: 900,
        };
        let position = || dot_bounds(-800, 200, work);
        let waiting = waiting_cue(Duration::ZERO, false);
        let compact = |b| compact_dot_bounds(b, work);
        assert_eq!(
            cue_bounds(waiting, None, |_| panic!("no report exists yet"), position),
            position()
        );
        assert_eq!(
            cue_bounds(Cue::Outline, None, compact, || panic!(
                "no field fallback when recording"
            )),
            None
        );
        assert_eq!(
            cue_bounds(waiting, Some(work), compact, position),
            position()
        );
        let field = Bounds {
            left: -1200,
            top: 20,
            right: -1000,
            bottom: 60,
        };
        let dots = cue_bounds(waiting, Some(field), compact, || {
            panic!("use the current compact field")
        })
        .unwrap();
        assert_eq!((dots.right, dots.top), (field.right, field.bottom + 3));
        let normal = position().unwrap();
        assert_eq!((normal.left, normal.top), (-784, 220));
        let corner = dot_bounds(-1, 899, work).unwrap();
        assert!(corner.right < -1 && corner.bottom < 899);
        let other_corner = dot_bounds(i32::MIN, i32::MIN, work).unwrap();
        assert_eq!((other_corner.left, other_corner.top), (work.left, work.top));
    }

    #[test]
    fn outline_is_a_nonactivating_click_through_tool_window() {
        let required = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        assert_eq!(STYLE & required, required);
    }
}
