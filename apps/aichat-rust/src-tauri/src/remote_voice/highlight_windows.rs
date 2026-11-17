//! Paint a click-through border for the current Windows dictation target.
//! UI Automation runs separately from the window thread so a slow provider
//! cannot retain the border after a release or block the Bluetooth event loop.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use windows::Win32::UI::Accessibility::*;
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT, SIZE},
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::*,
};

static ACTIVE: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    #[default]
    Preparing,
    Recording,
    Transcribing,
    Retry,
}

#[derive(Default)]
struct Feedback {
    id: u64,
    phase: Option<Phase>,
    transcript: String,
}

impl Feedback {
    fn start(&mut self, id: u64) -> bool {
        if id <= self.id {
            return false;
        }
        self.id = id;
        self.phase = Some(Phase::Preparing);
        self.transcript.clear();
        true
    }

    fn advance(&mut self, id: u64, phase: Phase) {
        if id == self.id && self.phase.is_some_and(|current| phase > current) {
            self.phase = Some(phase);
            if phase == Phase::Retry {
                self.transcript.clear();
            }
        }
    }

    fn preview(&mut self, id: u64, text: &str) {
        if self.id == id && self.phase.is_some_and(|phase| phase != Phase::Retry) {
            text.clone_into(&mut self.transcript);
        }
    }

    fn end(&mut self, id: u64) -> bool {
        if self.id != id || self.phase.take().is_none() {
            return false;
        }
        self.transcript.clear();
        true
    }
}

static FEEDBACK: Mutex<Feedback> = Mutex::new(Feedback {
    id: 0,
    phase: None,
    transcript: String::new(),
});

// Set KEEPWORK_VOICE_DEBUG=1 to dump one probe report per press to
// %TEMP%\keepwork_voice_probe.txt while diagnosing anchoring issues.
fn probe_debug() -> Option<std::fs::File> {
    use std::sync::atomic::AtomicU8;
    static ENABLED: AtomicU8 = AtomicU8::new(0);
    match ENABLED.load(Ordering::Acquire) {
        2 => return None,
        1 => {}
        _ => {
            let enabled = std::env::var_os("KEEPWORK_VOICE_DEBUG").is_some();
            ENABLED.store(if enabled { 1 } else { 2 }, Ordering::Release);
            if !enabled {
                return None;
            }
        }
    }
    let path = std::env::temp_dir().join("keepwork_voice_probe.txt");
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

// Write every distinct line once per press, plus re-emit the same line if it
// persists for over a second, so a hold shows how the UIA focus state evolves.
fn probe_report(id: u64, line: &str) {
    use std::io::Write;
    static LAST: Mutex<Option<(u64, String, Instant)>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap();
        let dominated = last
            .as_ref()
            .map(|(prev, text, at)| {
                *prev == id && text == line && at.elapsed() < Duration::from_secs(1)
            })
            .unwrap_or(false);
        if dominated {
            return;
        }
        *last = Some((id, line.to_string(), Instant::now()));
    }
    if let Some(mut file) = probe_debug() {
        let _ = writeln!(file, "[press {id}] {line}");
    }
}
struct Workers {
    probe: thread::Thread,
    frames: mpsc::Sender<Option<Frame>>,
}
static WORKERS: OnceLock<Option<Workers>> = OnceLock::new();

fn wake() {
    if let Some(Some(workers)) = WORKERS.get() {
        let _ = workers.frames.send(None);
        workers.probe.unpark();
    }
}

pub(super) fn start(id: u64) {
    if WORKERS.get_or_init(Workers::spawn).is_some() {
        let mut feedback = FEEDBACK.lock().unwrap();
        if feedback.start(id) {
            ACTIVE.store(id, Ordering::Release);
            wake();
        }
    }
}

fn advance(id: u64, phase: Phase) {
    FEEDBACK.lock().unwrap().advance(id, phase);
    wake();
}

pub(super) fn recording(id: u64) {
    advance(id, Phase::Recording);
}
pub(super) fn transcribing(id: u64) {
    advance(id, Phase::Transcribing);
}
pub(super) fn retry(id: u64) {
    advance(id, Phase::Retry);
}

pub(super) fn preview(id: u64, text: &str) {
    FEEDBACK.lock().unwrap().preview(id, text);
    wake();
}

pub(super) fn end(id: u64) {
    if FEEDBACK.lock().unwrap().end(id) {
        ACTIVE
            .compare_exchange(id, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        wake();
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
                        if let Some(report) = target.as_ref().map(|t| t.report.clone()) {
                            probe_report(id, &report);
                        } else {
                            probe_report(id, "focused_target: none");
                        }
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
        UIA_ClassNamePropertyId,
        UIA_NamePropertyId,
    ] {
        cache.AddProperty(property)?;
    }
    cache.AddPattern(UIA_ValuePatternId)?;
    cache.AddPattern(UIA_TextPatternId)?;
    cache.AddProperty(UIA_IsTextPatternAvailablePropertyId)?;
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    foreground: usize,
    focus: usize,
    bounds: Bounds,
    // True when `bounds` is the text insertion point rather than the whole
    // field, so the red outline stays a small caret frame instead of
    // shrinking around the caret strip.
    caret: bool,
    // One-line UIA trace, written once per press when KEEPWORK_VOICE_DEBUG=1.
    report: String,
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
    let focus = el.CachedHasKeyboardFocus().map(|b| b.as_bool());
    let enabled = el.CachedIsEnabled().map(|b| b.as_bool());
    let offscreen = el.CachedIsOffscreen().map(|b| b.as_bool());
    let password = el.CachedIsPassword().map(|b| b.as_bool());
    let class = el.CachedClassName().map(|s| s.to_string());
    let name = el.CachedName().map(|s| s.to_string());
    if !matches!(focus, Ok(true))
        || !matches!(enabled, Ok(true))
        || matches!(offscreen, Ok(true))
        || matches!(password, Ok(true))
    {
        probe_report(
            ACTIVE.load(Ordering::Acquire),
            &format!(
                "rejected focus state: focus={focus:?} enabled={enabled:?} offscreen={offscreen:?} password={password:?} class={class:?} name={name:?}"
            ),
        );
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
        probe_report(ACTIVE.load(Ordering::Acquire), &format!("focused_target: rejected role {role:?}"));
        return None;
    }
    let value = el
        .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok();
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
    // Prefer the real text insertion point: the UIA TextPattern selection
    // works in Chromium editors (Cursor, VS Code, Chrome) that never create
    // a Win32 caret, and keeps the voice cue next to the text cursor.
    // The subtree walk needs a live element: a cache-built element (from
    // GetFocusedElementBuildCache) enumerates zero children cross-process.
    let live = uia.GetFocusedElement().ok();
    let (text_caret_raw, text_trace) = match live.as_ref() {
        Some(live) => text_caret_bounds(uia, live),
        None => text_caret_bounds(uia, &el),
    };
    let text_caret = text_caret_raw.and_then(|b| caret_clipped(b, area));
    let caret = text_caret.is_some();
    // CodeMirror and Monaco mark their hidden textarea read-only even while it
    // accepts input; only honor the read-only flag when no editable surface
    // (a TextPattern caret or a usable field) was found.
    let readonly = value
        .as_ref()
        .and_then(|v| v.CachedIsReadOnly().ok())
        .map(|b| b.as_bool())
        .unwrap_or(false);
    if readonly && !caret && field.is_none() {
        probe_report(ACTIVE.load(Ordering::Acquire), &format!("focused_target: rejected readonly, trace={text_trace}"));
        return None;
    }
    let bounds = text_caret
        .or(field)
        .or_else(|| caret_bounds(&info)?.clipped(area))?;
    let report = format!(
        "role={role:?} value={} readonly={readonly} text={:?} field={:?} caret={:?} chosen={bounds:?} trace={text_trace}",
        value.is_some(),
        text_caret,
        field,
        caret_bounds(&info).and_then(|b| b.clipped(area)),
    );
    let (current, after) = gui_focus()?;
    (current == foreground && after.hwndFocus == info.hwndFocus).then_some(Target {
        foreground: foreground as usize,
        focus: info.hwndFocus as usize,
        bounds,
        caret,
        report,
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

// Read the bounds of every rectangle in a TextRange SAFEARRAY of f64
// (left, top, width, height) quadruples. Returns true if at least one
// rectangle was written into `out`.
unsafe fn bounding_rectangles(array: *const SAFEARRAY, out: &mut Vec<Bounds>) -> bool {
    if array.is_null() {
        return false;
    }
    let bounds = (|| {
        let lower = SafeArrayGetLBound(array, 1).ok()?;
        let upper = SafeArrayGetUBound(array, 1).ok()?;
        for i in (lower..=upper).step_by(4) {
            let mut got = [0f64; 4];
            let mut ok = true;
            for (j, slot) in got.iter_mut().enumerate() {
                let index = i + j as i32;
                if index > upper
                    || SafeArrayGetElement(array, &index, slot as *mut f64 as *mut _).is_err()
                {
                    ok = false;
                    break;
                }
            }
            if ok {
                let left = got[0] as i32;
                let top = got[1] as i32;
                let right = left + got[2] as i32;
                let bottom = top + got[3] as i32;
                if right > left && bottom > top {
                    out.push(Bounds { left, top, right, bottom });
                }
            }
        }
        Some(())
    })();
    let _ = bounds;
    let _ = SafeArrayDestroy(array);
    !out.is_empty()
}

// Read the TextPattern selection of one element. Descendants must be probed
// with the live (non-cached) pattern because the cache request only applies
// to the focused root.
unsafe fn selection_caret(el: &IUIAutomationElement) -> Option<Bounds> {
    let pattern = el
        .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
        .ok()?;
    let selection = pattern.GetSelection().ok()?;
    let length = selection.Length().ok()?;
    if length <= 0 {
        return None;
    }
    let range = selection.GetElement(length - 1).ok()?;
    let rects = range.GetBoundingRectangles().ok()?;
    let mut out = Vec::new();
    if !bounding_rectangles(rects, &mut out) {
        return None;
    }
    // A zero-width selection (a caret) can still report one rectangle per
    // visual line; the insertion point is the START of the last line's rect.
    // A real selection reports the highlighted text, and its active end (where
    // the user is editing) is the END of the last rect. Keep a natural 2px
    // caret so the dots anchor right at the cursor.
    let last = *out.last()?;
    let width = last.right.saturating_sub(last.left);
    let caret_left = if width <= 4 { last.left } else { last.right.saturating_sub(2) };
    Some(Bounds {
        left: caret_left,
        top: last.top,
        right: (caret_left + 2).min(last.right.max(caret_left + 2)),
        bottom: last.bottom,
    })
}

// `Bounds::clipped` rejects anything narrower than 6px, which would drop a
// freshly found caret strip. Clip the caret into the window with a caret-wide
// tolerance so the insertion point survives.
fn caret_clipped(caret: Bounds, area: Bounds) -> Option<Bounds> {
    let result = Bounds {
        left: caret.left.max(area.left),
        top: caret.top.max(area.top),
        right: caret.right.min(area.right),
        bottom: caret.bottom.min(area.bottom),
    };
    let width = result.right.checked_sub(result.left)?;
    let height = result.bottom.checked_sub(result.top)?;
    (width >= 1 && height >= 6).then_some(result)
}

// Chromium editors expose their text cursor through the UIA TextPattern
// selection rather than a Win32 caret. CodeMirror and Monaco keep the real
// editable control (and its TextPattern) on a descendant of the focused
// element, so walk the subtree until a selection appears.
unsafe fn text_caret_bounds(
    uia: &IUIAutomation2,
    el: &IUIAutomationElement,
) -> (Option<Bounds>, String) {
    if let Some(bounds) = selection_caret(el) {
        return (Some(bounds), String::from("root has selection"));
    }
    let mut trace = String::new();
    let Some(walker) = uia.RawViewWalker().ok() else {
        return (None, String::from("no walker"));
    };
    let mut queue: std::collections::VecDeque<IUIAutomationElement> =
        std::collections::VecDeque::new();
    match walker.GetFirstChildElement(el) {
        Ok(first) => {
            let mut child = Some(first);
            while let Some(c) = child {
                let next = walker.GetNextSiblingElement(&c).ok();
                queue.push_back(c);
                child = next;
            }
        }
        Err(e) => {
            return (None, format!("no children: {e:?}"));
        }
    }
    let seeded = queue.len();
    let mut visited = 0usize;
    while let Some(node) = queue.pop_front() {
        visited += 1;
        if visited > 64 {
            break;
        }
        if trace.len() < 600 {
            let role = node
                .CurrentControlType()
                .map(|r| format!("{r:?}"))
                .unwrap_or_else(|_| String::from("?"));
            let class = node
                .CurrentClassName()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let has_text = node
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .is_ok();
            trace.push_str(&format!(" [{visited}]{role}/{class}/text={has_text}"));
        }
        if let Some(bounds) = selection_caret(&node) {
            return (Some(bounds), format!("descendant {visited}"));
        }
        let mut child = walker.GetFirstChildElement(&node).ok();
        while let Some(c) = child {
            let next = walker.GetNextSiblingElement(&c).ok();
            queue.push_back(c);
            child = next;
        }
    }
    (None, format!("seeded {seeded} visited {visited}:{trace}"))
}

// Chromium editors expose a tiny caret rectangle instead of an Edit control.
// Anchor the cue to that insertion point so the bars follow the text cursor.
unsafe fn caret_dot_bounds(field: Bounds) -> Option<Bounds> {
    let width = i64::from(field.right) - i64::from(field.left);
    let height = i64::from(field.bottom) - i64::from(field.top);
    if width > 32 || height > 64 {
        return None;
    }
    let rect = RECT {
        left: field.left,
        top: field.top,
        right: field.right,
        bottom: field.bottom,
    };
    let work = monitor_work_area(MonitorFromRect(&rect, MONITOR_DEFAULTTONULL))?;
    dot_bounds(field.right, field.bottom, work)
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
        Cue::Outline => field.filter(|b| {
            // A caret-sized bounds is the text insertion point, not the field:
            // framing it would look like the outline shrank to nothing.
            i64::from(b.right) - i64::from(b.left) > 32
                || i64::from(b.bottom) - i64::from(b.top) > 64
        }),
        Cue::Dots { .. } => field.and_then(field_dots).or_else(pointer),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Symbol {
    Spinner,
    SoundBars,
    Retry,
}

impl Phase {
    fn symbol(self) -> Option<Symbol> {
        match self {
            Self::Preparing => Some(Symbol::Spinner),
            Self::Recording => Some(Symbol::SoundBars),
            Self::Retry => Some(Symbol::Retry),
            Self::Transcribing => None, // Existing waiting dots.
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IconFrame {
    symbol: Symbol,
    step: u8,
}

fn icon_frame(symbol: Symbol, age: Duration, animate: bool) -> IconFrame {
    IconFrame {
        symbol,
        step: if animate {
            (age.as_millis() / 140 % 8) as u8
        } else {
            0
        },
    }
}

unsafe fn paint_icon(dc: HDC, bounds: RECT, icon: IconFrame) {
    let cx = (bounds.right - bounds.left) / 2;
    let cy = (bounds.bottom - bounds.top) / 2;
    let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
    let old_brush = SelectObject(dc, GetStockObject(DC_BRUSH));
    SetDCBrushColor(dc, 0x00ffffff);
    match icon.symbol {
        Symbol::Spinner => {
            let ring = [
                (0, -7),
                (5, -5),
                (7, 0),
                (5, 5),
                (0, 7),
                (-5, 5),
                (-7, 0),
                (-5, -5),
            ];
            for (i, (x, y)) in ring.into_iter().enumerate() {
                let shade = 255 - ((usize::from(icon.step) + 8 - i) % 8) as u32 * 24;
                SetDCBrushColor(dc, shade * 0x010101);
                Ellipse(dc, cx + x - 2, cy + y - 2, cx + x + 2, cy + y + 2);
            }
        }
        Symbol::SoundBars => {
            let heights = [3, 5, 8, 6, 4, 2, 4, 6];
            for i in 0..5 {
                let x = cx - 9 + 4 * i as i32;
                let h = heights[(usize::from(icon.step) + i * 2) % heights.len()];
                RoundRect(dc, x, cy - h, x + 3, cy + h, 2, 2);
            }
        }
        Symbol::Retry => {
            let cy = cy - i32::from(matches!(icon.step, 2 | 3));
            let point = |x, y| POINT {
                x: cx + x,
                y: cy + y,
            };
            let curve = [
                point(5, 6),
                point(2, 8),
                point(-2, 8),
                point(-6, 6),
                point(-8, 2),
                point(-8, -2),
                point(-6, -6),
                point(-2, -8),
                point(2, -8),
                point(5, -6),
                point(7, -3),
            ];
            let pen = CreatePen(PS_SOLID, 2, 0x00ffffff);
            if !pen.is_null() {
                let previous = SelectObject(dc, pen);
                Polyline(dc, curve.as_ptr(), curve.len() as i32);
                SelectObject(dc, previous);
                DeleteObject(pen);
            }
            let head = [point(9, -1), point(9, -9), point(2, -3)];
            Polygon(dc, head.as_ptr(), head.len() as i32);
        }
    }
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
}

struct Caption {
    hwnd: HWND,
    displayed: String,
    icon: Option<IconFrame>,
    width: i32,
}

unsafe extern "system" fn paint_caption(
    hwnd: HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    if message != WM_PAINT {
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    let mut paint = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut paint);
    if !dc.is_null() {
        let mut bounds = RECT::default();
        GetClientRect(hwnd, &mut bounds);
        FillRect(dc, &bounds, GetStockObject(BLACK_BRUSH));
        // GWLP_USERDATA contains a paint-thread-owned copy of the symbol frame.
        let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        let symbol = match data >> 3 {
            1 => Some(Symbol::Spinner),
            2 => Some(Symbol::SoundBars),
            3 => Some(Symbol::Retry),
            _ => None,
        };
        if let Some(symbol) = symbol {
            paint_icon(
                dc,
                bounds,
                IconFrame {
                    symbol,
                    step: (data & 7) as u8,
                },
            );
        } else {
            let old_font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
            SetBkMode(dc, TRANSPARENT as i32);
            SetTextColor(dc, 0x00ffffff);
            // The recognizer limits the caption to the last 160 Unicode characters.
            let mut text = [0u16; 321];
            let count = GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32);
            DrawTextW(
                dc,
                text.as_ptr(),
                count,
                &mut bounds,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
            );
            SelectObject(dc, old_font);
        }
    }
    EndPaint(hwnd, &paint);
    0
}

impl Caption {
    unsafe fn new() -> Option<Self> {
        use windows_sys::Win32::System::SystemServices::{SS_CENTER, SS_CENTERIMAGE, SS_NOPREFIX};
        let hwnd = CreateWindowExW(
            STYLE,
            windows_sys::w!("STATIC"),
            std::ptr::null(),
            WS_POPUP | WS_BORDER | SS_CENTER | SS_CENTERIMAGE | SS_NOPREFIX,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return None;
        }
        if windows_sys::Win32::UI::Shell::SetWindowSubclass(hwnd, Some(paint_caption), 1, 0) == 0 {
            DestroyWindow(hwnd);
            return None;
        }
        SetLayeredWindowAttributes(hwnd, 0, 244, LWA_ALPHA);
        SendMessageW(
            hwnd,
            WM_SETFONT,
            GetStockObject(DEFAULT_GUI_FONT) as usize,
            0,
        );
        Some(Self {
            hwnd,
            displayed: String::new(),
            icon: None,
            width: 0,
        })
    }

    unsafe fn show(
        &mut self,
        text: &str,
        icon: Option<IconFrame>,
        field: Option<Bounds>,
        waiting: bool,
    ) {
        let Some(anchor) = field
            .and_then(|b| caret_dot_bounds(b).or_else(|| field_dot_bounds(b)))
            .or_else(|| cursor_dot_bounds())
        else {
            ShowWindow(self.hwnd, SW_HIDE);
            return;
        };
        let point = POINT {
            x: anchor.left,
            y: anchor.top,
        };
        let Some(work) = monitor_work_area(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST))
        else {
            return;
        };
        let max_width = (work.right - work.left).min(460);
        if max_width < 30 {
            ShowWindow(self.hwnd, SW_HIDE);
            return;
        }
        let icon_changed = self.icon != icon;
        if icon_changed {
            let data = icon.map_or(0, |frame| {
                let kind = match frame.symbol {
                    Symbol::Spinner => 1,
                    Symbol::SoundBars => 2,
                    Symbol::Retry => 3,
                };
                (kind << 3) | isize::from(frame.step)
            });
            SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, data);
            self.icon = icon;
            InvalidateRect(self.hwnd, std::ptr::null(), 0);
        }
        if icon.is_some() {
            self.width = 38.min(max_width);
            if !self.displayed.is_empty() {
                self.displayed.clear();
                SetWindowTextW(self.hwnd, windows_sys::w!(""));
            }
        } else if self.displayed != text || self.width > max_width || icon_changed {
            let dc = GetDC(self.hwnd);
            if dc.is_null() {
                return;
            }
            let old_font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
            let mut wide: Vec<u16> = text.replace(['\n', '\r'], " ").encode_utf16().collect();
            let mut start = 0;
            let mut extent = SIZE::default();
            while start < wide.len() {
                if GetTextExtentPoint32W(
                    dc,
                    wide[start..].as_ptr(),
                    (wide.len() - start) as i32,
                    &mut extent,
                ) == 0
                    || extent.cx + 20 <= max_width
                {
                    break;
                }
                start += 1;
                if wide
                    .get(start)
                    .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                {
                    start += 1;
                }
            }
            SelectObject(dc, old_font);
            ReleaseDC(self.hwnd, dc);
            self.width = (extent.cx + 20).clamp(30, max_width);
            wide.push(0);
            SetWindowTextW(self.hwnd, wide[start..].as_ptr());
            InvalidateRect(self.hwnd, std::ptr::null(), 0);
            self.displayed = text.to_owned();
        }
        let left = anchor.left.clamp(work.left, work.right - self.width);
        let top = (anchor.top - 32 - if waiting { 4 } else { 0 }).max(work.top);
        SetWindowPos(
            self.hwnd,
            HWND_TOPMOST,
            left,
            top,
            self.width,
            28,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

impl Drop for Caption {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.hwnd);
        }
    }
}

fn paint_frames(rx: mpsc::Receiver<Option<Frame>>) {
    let mut visible: Option<(HWND, (u64, Bounds, Cue))> = None;
    let mut caption: Option<Caption> = None;
    let mut latest_field: Option<(u64, Target)> = None;
    let mut clock: Option<(u64, Phase, Instant, bool)> = None;
    let mut last_observed = Instant::now();
    loop {
        let next = if visible.is_some() || clock.is_some() {
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
            let (phase, text) = {
                let feedback = FEEDBACK.lock().unwrap();
                (
                    feedback
                        .phase
                        .filter(|_| active != 0 && active == feedback.id),
                    feedback.transcript.clone(),
                )
            };
            if clock.map(|(id, phase, _, _)| (id, phase)) != phase.map(|phase| (active, phase)) {
                clock = phase.map(|phase| (active, phase, Instant::now(), animations_enabled()));
            }
            let waiting = phase == Some(Phase::Transcribing);
            let cue = match clock {
                Some((_, Phase::Transcribing, began, animate)) => {
                    waiting_cue(began.elapsed(), animate)
                }
                _ => Cue::Outline,
            };
            // Retain the field through a phase-only wake, but don't show stale UIA geometry
            // if a provider stalls or focus changes while recognition is running.
            let brief = matches!(cue, Cue::Outline)
                || last_observed.elapsed() <= Duration::from_millis(350);
            let field = latest_field
                .as_ref()
                .filter(|_| brief)
                .and_then(|(_, target)| {
                    let (fg, info) = gui_focus()?;
                    (fg as usize == target.foreground && info.hwndFocus as usize == target.focus)
                        .then_some(target.bounds)
                });
            let icon = clock
                .and_then(|(_, phase, began, animate)| {
                    phase
                        .symbol()
                        .map(|symbol| icon_frame(symbol, began.elapsed(), animate))
                })
                .filter(|_| text.is_empty());
            if phase.is_some() && (!text.is_empty() || icon.is_some()) {
                if caption.is_none() {
                    caption = Caption::new();
                }
                if let Some(window) = &mut caption {
                    window.show(&text, icon, field, waiting);
                }
            } else {
                caption = None;
            }
            let new_frame = if phase.is_none() || phase == Some(Phase::Retry) {
                None
            } else {
                cue_bounds(
                    cue,
                    field,
                    |b| caret_dot_bounds(b).or_else(|| field_dot_bounds(b)),
                    || cursor_dot_bounds(),
                )
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
    fn transient_symbols_follow_press_and_stop_after_expiry_or_replacement() {
        let mut feedback = Feedback::default();
        assert!(feedback.start(10));
        assert_eq!(feedback.phase.unwrap().symbol(), Some(Symbol::Spinner));
        feedback.advance(10, Phase::Recording);
        assert_eq!(feedback.phase.unwrap().symbol(), Some(Symbol::SoundBars));
        feedback.preview(10, "actual words");
        assert_eq!(feedback.transcript, "actual words");
        feedback.advance(10, Phase::Retry);
        assert_eq!(feedback.phase.unwrap().symbol(), Some(Symbol::Retry));
        feedback.preview(10, "late words");
        assert!(feedback.transcript.is_empty());
        assert!(feedback.start(11));
        feedback.advance(10, Phase::Retry);
        assert!(!feedback.end(10));
        assert_eq!(feedback.phase, Some(Phase::Preparing));
        feedback.advance(11, Phase::Transcribing);
        feedback.advance(11, Phase::Recording);
        assert_eq!(feedback.phase.unwrap().symbol(), None);
        assert!(feedback.end(11));
        assert!(!feedback.start(10));
        assert_eq!(feedback.phase, None);
    }

    #[test]
    fn windows_symbols_have_static_and_animated_frames() {
        for symbol in [Symbol::Spinner, Symbol::SoundBars, Symbol::Retry] {
            let later = Duration::from_millis(420);
            assert_eq!(
                icon_frame(symbol, Duration::ZERO, true),
                icon_frame(symbol, later, false)
            );
            assert_ne!(
                icon_frame(symbol, Duration::ZERO, true),
                icon_frame(symbol, later, true)
            );
        }
    }

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
            caret: false,
            report: String::new(),
        };
        let a = Some((1, target.clone()));
        let b = Some((2, target.clone()));
        let frame = |id, target| {
            Some(Frame {
                id,
                target,
                observed: Instant::now(),
            })
        };
        assert_eq!(next_target(0, a.clone(), frame(1, Some(target.clone()))), None);
        assert_eq!(next_target(2, a.clone(), None), None);
        assert_eq!(next_target(2, a.clone(), frame(1, None)), None);
        assert_eq!(
            next_target(2, a.clone(), frame(1, Some(target.clone()))),
            None
        );
        assert_eq!(
            next_target(2, a.clone(), frame(2, Some(target.clone()))),
            b.clone()
        );
        assert_eq!(next_target(2, b.clone(), frame(1, None)), b.clone());
        assert_eq!(next_target(2, b.clone(), frame(2, None)), None);
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
    fn caret_sized_bounds_never_frame_the_outline() {
        // Once the TextPattern selection provides the insertion point, the red
        // recording outline must not shrink to the caret strip; the strip only
        // anchors the waiting dots.
        let caret = Bounds {
            left: 640,
            top: 700,
            right: 642,
            bottom: 718,
        };
        assert_eq!(cue_bounds(Cue::Outline, Some(caret), |_| None, || None), None);
        let field = Bounds {
            left: 100,
            top: 200,
            right: 620,
            bottom: 260,
        };
        assert_eq!(
            cue_bounds(Cue::Outline, Some(field), |_| None, || None),
            Some(field)
        );
    }

    #[test]
    fn outline_is_a_nonactivating_click_through_tool_window() {
        let required = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        assert_eq!(STYLE & required, required);
    }

    #[test]
    fn caret_sized_fields_anchor_dots_next_to_the_insertion_point() {
        let work = Bounds {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        // Caret-sized fields (Chromium insertion point) must skip the compact
        // in-field placement and anchor just past the caret, like caret_dot_bounds.
        let is_caret = |b: Bounds| {
            i64::from(b.right) - i64::from(b.left) <= 32
                && i64::from(b.bottom) - i64::from(b.top) <= 64
        };
        let caret = Bounds {
            left: 640,
            top: 700,
            right: 642,
            bottom: 718,
        };
        // compact_dot_bounds refuses the tiny caret strip (nothing fits inside
        // it), so without caret handling the cue fell back to the mouse cursor.
        assert!(is_caret(caret));
        assert!(compact_dot_bounds(caret, work).is_none());
        let anchored = dot_bounds(caret.right, caret.bottom, work).unwrap();
        assert_eq!(anchored.left, caret.right + 16);
        assert_eq!(anchored.top, caret.bottom + 20);
        // A wide Edit field keeps the compact inside-the-field placement.
        let field = Bounds {
            left: 100,
            top: 200,
            right: 620,
            bottom: 260,
        };
        assert!(!is_caret(field));
        let inside = compact_dot_bounds(field, work).unwrap();
        assert_eq!(inside.right, field.right);
        assert_eq!(inside.top, field.bottom + 3);
    }
}
