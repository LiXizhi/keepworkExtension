#pragma once
#include <windows.h>
#include <commctrl.h>
#include <imm.h>
#include <algorithm>
#include <cstring>
#include <functional>
#include <string>
#include <vector>
#include "pet_geometry.h"
#include "pet_input_policy.h"

namespace keepwork_cef {
enum class PetChatAction { Send, Stop, ToggleTarget, OpenMain, Collapse, AcknowledgeUnknown, Dictation, Call, Mute };
struct PetChatView {
  std::wstring title, transcript, status, error;
  bool ready = false, busy = false, rich_draft = false, dictating = false;
  bool can_switch = false, pending = false, uncertain = false, unsynced = false;
  bool can_dictate = true, can_call = false, calling = false, muted = false;
};

// Native text presentation only. The owner supplies the existing webpage's
// conversation snapshot and handles explicit actions; this window creates no
// session, browser, network connection or model invocation on its own.
class PetChatPanel {
 public:
  static constexpr int title_id = 101, transcript_id = 102, status_id = 103, error_id = 104;
  static constexpr int draft_id = 105, send_id = 106, stop_id = 107, target_id = 108;
  static constexpr int open_id = 109, collapse_id = 110, acknowledge_id = 111;
  static constexpr int dictation_id = 112, call_id = 113, mute_id = 114;
  ~PetChatPanel() { Destroy(); }
  bool Create(HINSTANCE instance, std::function<void(PetChatAction)> action,
              std::function<void(std::wstring)> edit) {
    Destroy();
    instance_ = instance; action_ = std::move(action); edit_ = std::move(edit);
    creating_ = true;
    WNDCLASSW type{};
    type.style = CS_DROPSHADOW;
    type.lpfnWndProc = Procedure;
    type.hInstance = instance;
    type.lpszClassName = L"KeepworkCefPetChatPanel";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) { Destroy(); return false; }
    window_ = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, type.lpszClassName,
      L"Keepwork 宠物对话", WS_POPUP | WS_CLIPCHILDREN,
      0, 0, 360, 360, nullptr, nullptr, instance, this);
    if (!window_) { Destroy(); return false; }
    dpi_ = WindowDpi();
    RefreshFont();
    Update(view_);
    creating_ = false;
    return true;
  }
  void Show(RECT anchor) {
    if (!window_) return;
    if (!visible()) {
      Position(anchor);
      ShowWindow(window_, SW_SHOW);
    }
    SetForegroundWindow(window_);
    SetFocus(draft_);
  }
  // Only explicit Show may activate the panel. Movement preserves the same
  // EDIT, its selection, IME composition and any local unpublished draft.
  void Follow(RECT anchor) { if (visible()) Position(anchor); }
  void Hide() { if (window_) ShowWindow(window_, SW_HIDE); }
  void Destroy() {
    action_ = {}; edit_ = {};
    if (window_) DestroyWindow(window_);
    for (const auto font : {font_, title_font_, small_font_}) if (font) DeleteObject(font);
    font_ = title_font_ = small_font_ = nullptr;
    if (background_brush_) { DeleteObject(background_brush_); background_brush_ = nullptr; }
    transcript_ = status_ = error_ = draft_ = nullptr;
    send_ = stop_ = target_ = open_ = collapse_ = acknowledge_ = nullptr;
    dictation_ = call_ = mute_ = nullptr;
    setting_draft_ = composing_ = creating_ = false;
    have_anchor_ = false;
    hovered_ = nullptr;
  }
  bool visible() const { return window_ && IsWindowVisible(window_) != FALSE; }
  HWND window() const { return window_; }
  void Update(const PetChatView& view) {
    view_ = view;
    if (!window_) return;
    SetText(target_, view.title.empty() ? L"当前对话" : view.title);
    UpdateTranscript(view.transcript);
    SetText(status_, StatusText());
    SetText(error_, ErrorText());
    Layout();
    UpdateControls();
  }
  void SetDraft(std::wstring value, bool owner_changed = false) {
    if (!draft_ || (composing_ && !owner_changed)) return;
    const auto text = EditText(value);
    const bool previous_setting = setting_draft_;
    if (owner_changed) {
      // Changing account/session is an authority boundary. Do not let an old
      // IME buffer finish into the next owner's draft or publish an edit echo.
      setting_draft_ = true;
      const bool cancel_composition = composing_;
      composing_ = false;
      if (cancel_composition) {
        const HIMC context = ImmGetContext(draft_);
        if (context) {
          ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
          ImmReleaseContext(draft_, context);
        }
        composing_ = false;
      }
    }
    if (Text(draft_) == text) {
      setting_draft_ = previous_setting;
      UpdateControls();
      return;
    }
    DWORD start = 0, end = 0;
    SendMessageW(draft_, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
    setting_draft_ = true;
    SetWindowTextW(draft_, text.c_str());
    setting_draft_ = previous_setting;
    const DWORD limit = static_cast<DWORD>(text.size());
    if (owner_changed) start = end = limit;
    SendMessageW(draft_, EM_SETSEL, std::min(start, limit), std::min(end, limit));
    UpdateControls();
  }
  std::wstring Draft() const { return PlainText(Text(draft_)); }

 private:
  HWND window_ = nullptr, transcript_ = nullptr, status_ = nullptr;
  HWND error_ = nullptr, draft_ = nullptr, send_ = nullptr, stop_ = nullptr, target_ = nullptr;
  HWND open_ = nullptr, collapse_ = nullptr, acknowledge_ = nullptr;
  HWND dictation_ = nullptr, call_ = nullptr, mute_ = nullptr;
  HINSTANCE instance_ = nullptr;
  HFONT font_ = nullptr, title_font_ = nullptr, small_font_ = nullptr;
  HBRUSH background_brush_ = nullptr;
  HWND hovered_ = nullptr;
  RECT anchor_{}, draft_border_{};
  bool have_anchor_ = false;
  int dpi_ = 96;
  bool setting_draft_ = false, composing_ = false, creating_ = false;
  PetChatView view_;
  std::function<void(PetChatAction)> action_;
  std::function<void(std::wstring)> edit_;
  static constexpr COLORREF background = RGB(247, 251, 248), border = RGB(190, 213, 199);
  static constexpr COLORREF foreground = RGB(35, 49, 42), muted = RGB(99, 114, 104);
  static constexpr COLORREF green = RGB(52, 127, 84), hover = RGB(213, 233, 220);
  int Scale(int value) const { return (value * std::clamp(dpi_, 48, 768) + 48) / 96; }
  void Position(RECT anchor) {
    anchor_ = anchor; have_anchor_ = true;
    MONITORINFO monitor{sizeof(monitor)};
    if (!GetMonitorInfoW(MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST), &monitor)) return;
    const auto placed = PlacePetChat({anchor.left, anchor.top, anchor.right, anchor.bottom},
      Scale(360), Scale(360), Scale(12),
      {monitor.rcWork.left, monitor.rcWork.top, monitor.rcWork.right, monitor.rcWork.bottom});
    SetWindowPos(window_, HWND_TOPMOST, placed.x, placed.y, placed.width, placed.height, SWP_NOACTIVATE);
  }
  int WindowDpi() const {
    using GetDpi = UINT(WINAPI*)(HWND);
    static const GetDpi get_dpi = [] {
      const auto address = GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
      GetDpi function = nullptr;
      static_assert(sizeof(function) == sizeof(address));
      std::memcpy(&function, &address, sizeof(function));
      return function;
    }();
    if (get_dpi) {
      const UINT dpi = get_dpi(window_);
      if (dpi > 0 && dpi <= 768) return static_cast<int>(dpi);
    }
    HDC context = GetDC(window_);
    const int dpi = context ? GetDeviceCaps(context, LOGPIXELSX) : 96;
    if (context) ReleaseDC(window_, context);
    return dpi > 0 ? dpi : 96;
  }
  static std::wstring Text(HWND window) {
    if (!window) return {};
    const int length = GetWindowTextLengthW(window);
    if (length <= 0) return {};
    std::vector<wchar_t> text(static_cast<size_t>(length) + 1);
    const int copied = GetWindowTextW(window, text.data(), static_cast<int>(text.size()));
    return copied > 0 ? std::wstring(text.data(), copied) : std::wstring{};
  }
  static void SetText(HWND window, const std::wstring& text) {
    if (window && Text(window) != text) {
      SetWindowTextW(window, text.c_str());
      InvalidateRect(window, nullptr, FALSE);
    }
  }
  static std::wstring PlainText(const std::wstring& text) {
    std::wstring plain;
    for (size_t index = 0; index < text.size(); ++index) {
      if (text[index] == L'\r') {
        if (index + 1 < text.size() && text[index + 1] == L'\n') ++index;
        plain.push_back(L'\n');
      } else plain.push_back(text[index]);
    }
    return plain;
  }
  static std::wstring EditText(const std::wstring& text) {
    const auto plain = PlainText(text);
    std::wstring native;
    for (const wchar_t value : plain) {
      if (value == L'\n') native.push_back(L'\r');
      native.push_back(value);
    }
    return native;
  }
  bool HasDraft() const {
    for (const wchar_t value : Draft()) {
      const auto c = static_cast<unsigned>(value);
      const bool blank = (c >= 9 && c <= 13) || c == 32 || c == 0xa0 || c == 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
      if (!blank) return true;
    }
    return false;
  }
  bool CanSend() const {
    return view_.ready && !view_.busy && !view_.rich_draft && !view_.dictating &&
      !view_.pending && !view_.uncertain && !composing_ && HasDraft();
  }
  bool CanStop() const { return view_.ready && view_.busy && !view_.pending; }
  bool CanSwitch() const {
    return view_.can_switch && !view_.busy && !view_.pending && !view_.uncertain && !view_.unsynced &&
      !view_.rich_draft && !view_.dictating && !view_.calling && !composing_;
  }
  bool CanDictate() const { return view_.ready && (view_.dictating || (view_.can_dictate && !view_.rich_draft && !view_.calling)) &&
    !view_.pending && !view_.uncertain && !composing_; }
  bool CanCall() const { return view_.ready && (view_.can_call || view_.calling) && !view_.dictating &&
    !view_.pending && !view_.uncertain && !composing_; }
  std::wstring StatusText() const {
    if (!view_.status.empty()) return view_.status;
    if (view_.uncertain) return L"结果待核查；不会自动重发。";
    if (view_.pending) return L"请求处理中…";
    if (!view_.ready) return L"等待网页宠物通道就绪…";
    if (view_.rich_draft) return L"草稿包含富文本，请打开主窗口继续编辑。";
    if (view_.dictating) return L"正在语音输入…";
    if (view_.calling) return view_.muted ? L"通话中 · 已静音" : L"通话中…";
    if (view_.busy) return L"正在回复…";
    return L"";
  }
  std::wstring ErrorText() const {
    if (!view_.error.empty()) return view_.error;
    return view_.uncertain ? L"发送结果未知。请先到主窗口核查，确认后选择「已核查，继续」。" : L"";
  }
  void UpdateControls() {
    if (!window_) return;
    EnableWindow(send_, CanSend());
    EnableWindow(stop_, CanStop());
    EnableWindow(target_, CanSwitch());
    SetText(dictation_, view_.dictating ? L"停止输入" : L"语音输入");
    SetText(call_, view_.calling ? L"结束通话" : L"通话");
    SetText(mute_, view_.muted ? L"取消静音" : L"静音");
    EnableWindow(dictation_, CanDictate()); EnableWindow(call_, CanCall());
    EnableWindow(mute_, view_.calling && !view_.pending);
    ShowWindow(mute_, view_.calling ? SW_SHOWNA : SW_HIDE);
    const bool readonly = view_.rich_draft || view_.dictating || view_.pending || view_.uncertain;
    if (((GetWindowLongPtrW(draft_, GWL_STYLE) & ES_READONLY) != 0) != readonly)
      SendMessageW(draft_, EM_SETREADONLY, readonly, 0);
    ShowWindow(acknowledge_, view_.uncertain ? SW_SHOWNA : SW_HIDE);
    EnableWindow(acknowledge_, view_.uncertain);
  }
  void DraftChanged() {
    if (setting_draft_ || composing_ || creating_ || !draft_) return;
    UpdateControls();
    const auto edit = edit_;
    if (edit) edit(Draft());
  }
  void Dispatch(PetChatAction action) {
    if (action == PetChatAction::Send && !CanSend()) return;
    if (action == PetChatAction::Stop && !CanStop()) return;
    if (action == PetChatAction::ToggleTarget && !CanSwitch()) return;
    if (action == PetChatAction::Dictation && !CanDictate()) return;
    if (action == PetChatAction::Call && !CanCall()) return;
    if (action == PetChatAction::Mute && (!view_.calling || view_.pending)) return;
    if (action == PetChatAction::AcknowledgeUnknown && !view_.uncertain) return;
    if (action == PetChatAction::Collapse) Hide();
    const auto callback = action_;
    if (callback) callback(action);
  }
  void UpdateTranscript(const std::wstring& value) {
    const auto text = EditText(value);
    if (Text(transcript_) == text) return;
    SCROLLINFO scroll{sizeof(scroll), SIF_ALL};
    const bool at_bottom = !GetScrollInfo(transcript_, SB_VERT, &scroll) ||
      static_cast<unsigned long long>(std::max(0, scroll.nPos)) + scroll.nPage >= static_cast<unsigned long long>(std::max(0, scroll.nMax));
    const LRESULT first_line = SendMessageW(transcript_, EM_GETFIRSTVISIBLELINE, 0, 0);
    DWORD start = 0, end = 0;
    SendMessageW(transcript_, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
    SetWindowTextW(transcript_, text.c_str());
    const DWORD limit = static_cast<DWORD>(text.size());
    if (at_bottom && start == end) {
      SendMessageW(transcript_, EM_SETSEL, limit, limit);
      SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
    } else {
      SendMessageW(transcript_, EM_SETSEL, std::min(start, limit), std::min(end, limit));
      const LRESULT current = SendMessageW(transcript_, EM_GETFIRSTVISIBLELINE, 0, 0);
      SendMessageW(transcript_, EM_LINESCROLL, 0, first_line - current);
    }
  }
  HWND Control(const wchar_t* type, const wchar_t* text, DWORD style, int id, DWORD extended = 0) {
    HWND control = CreateWindowExW(extended, type, text, WS_CHILD | WS_VISIBLE | style,
      0, 0, 0, 0, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance_, nullptr);
    if (control && (style & WS_TABSTOP)) SetWindowSubclass(control, ControlProcedure, 1, reinterpret_cast<DWORD_PTR>(this));
    return control;
  }
  bool Controls() {
    transcript_ = Control(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_TABSTOP,
      transcript_id);
    status_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, status_id);
    error_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, error_id);
    draft_ = Control(L"EDIT", L"", ES_MULTILINE | ES_WANTRETURN | ES_AUTOVSCROLL | WS_TABSTOP, draft_id);
    send_ = Control(L"BUTTON", L"发送", BS_OWNERDRAW | WS_TABSTOP, send_id);
    stop_ = Control(L"BUTTON", L"停止", BS_OWNERDRAW | WS_TABSTOP, stop_id);
    target_ = Control(L"BUTTON", L"切换目标", BS_OWNERDRAW | WS_TABSTOP, target_id);
    open_ = Control(L"BUTTON", L"打开主窗口", BS_OWNERDRAW | WS_TABSTOP, open_id);
    collapse_ = Control(L"BUTTON", L"收起", BS_OWNERDRAW | WS_TABSTOP, collapse_id);
    acknowledge_ = Control(L"BUTTON", L"已核查，继续", BS_OWNERDRAW | WS_TABSTOP, acknowledge_id);
    dictation_ = Control(L"BUTTON", L"语音输入", BS_OWNERDRAW | WS_TABSTOP, dictation_id);
    call_ = Control(L"BUTTON", L"通话", BS_OWNERDRAW | WS_TABSTOP, call_id);
    mute_ = Control(L"BUTTON", L"静音", BS_OWNERDRAW | WS_TABSTOP, mute_id);
    SendMessageW(draft_, EM_SETLIMITTEXT, 32000, 0);
    SendMessageW(transcript_, EM_SETLIMITTEXT, 1024 * 1024, 0);
    return transcript_ && status_ && error_ && draft_ && send_ && stop_ && target_ && open_ && collapse_ && acknowledge_ && dictation_ && call_ && mute_;
  }
  void RefreshFont() {
    const auto make = [this](int size, int weight) {
      return CreateFontW(-Scale(size), 0, 0, 0, weight, FALSE, FALSE, FALSE,
        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    };
    HFONT next = make(13, FW_NORMAL), title = make(13, FW_SEMIBOLD), secondary = make(12, FW_NORMAL);
    if (!next || !title || !secondary) {
      for (const auto font : {next, title, secondary}) if (font) DeleteObject(font);
      return;
    }
    for (const auto control : {transcript_, status_, error_, draft_, send_, stop_, target_, open_, collapse_, acknowledge_, dictation_, call_, mute_})
      if (control) SendMessageW(control, WM_SETFONT,
        reinterpret_cast<WPARAM>(control == target_ ? title : control == status_ || control == error_ ? secondary : next), TRUE);
    for (const auto font : {font_, title_font_, small_font_}) if (font) DeleteObject(font);
    font_ = next; title_font_ = title; small_font_ = secondary;
  }
  void Layout() {
    if (!window_) return;
    RECT client{}; GetClientRect(window_, &client);
    const int margin = Scale(12), gap = Scale(6);
    const int width = std::max(0L, client.right - 2 * margin);
    int y = margin;
    const auto place = [](HWND control, int left, int top, int width, int height) {
      if (control) SetWindowPos(control, nullptr, left, top, std::max(0, width), std::max(0, height), SWP_NOZORDER | SWP_NOACTIVATE);
    };
    place(target_, margin, y, std::max(0, width - Scale(64)), Scale(32));
    place(collapse_, margin + std::max(0, width - Scale(64)), y, Scale(32), Scale(28));
    place(open_, margin + std::max(0, width - Scale(32)), y, Scale(32), Scale(28)); y += Scale(32) + gap;
    const bool has_status = !StatusText().empty();
    ShowWindow(status_, has_status ? SW_SHOWNA : SW_HIDE);
    if (has_status) { place(status_, margin, y, width, Scale(32)); y += Scale(32) + gap; }
    const bool has_error = !ErrorText().empty();
    ShowWindow(error_, has_error ? SW_SHOWNA : SW_HIDE);
    if (has_error) { place(error_, margin, y, width, Scale(48)); y += Scale(48) + gap; }
    if (view_.uncertain) { place(acknowledge_, margin, y, width, Scale(28)); y += Scale(28) + gap; }
    const int action_y = std::max(y, static_cast<int>(client.bottom) - margin - Scale(30));
    const int media_y = action_y - Scale(32) - gap;
    const int draft_height = std::min(Scale(76), std::max(0, media_y - gap - y));
    const int draft_y = media_y - gap - draft_height;
    place(transcript_, margin, y, width, std::max(0, draft_y - gap - y));
    draft_border_ = {margin, draft_y, margin + width, draft_y + draft_height};
    place(draft_, margin + Scale(8), draft_y + Scale(8), width - Scale(16), draft_height - Scale(16));
    place(send_, margin + std::max(0, width - Scale(68)), action_y, Scale(68), Scale(30));
    place(stop_, margin + std::max(0, width - Scale(142)), action_y, Scale(68), Scale(30));
    place(dictation_, margin, media_y, Scale(92), Scale(30));
    place(call_, margin + Scale(98), media_y, Scale(92), Scale(30));
    place(mute_, margin + Scale(196), media_y, Scale(92), Scale(30));
    // Windows owns a successfully installed region. Rounded chrome works on
    // Win7 without DWM, while all controls remain real accessible HWNDs.
    HRGN region = CreateRoundRectRgn(0, 0, client.right + 1, client.bottom + 1, Scale(36), Scale(36));
    if (region && !SetWindowRgn(window_, region, TRUE)) DeleteObject(region);
    InvalidateRect(window_, nullptr, FALSE);
  }
  HBRUSH BackgroundBrush() {
    if (!background_brush_) background_brush_ = CreateSolidBrush(background);
    return background_brush_;
  }
  void Rounded(HDC dc, RECT rect, int radius, COLORREF fill, COLORREF outline) const {
    const HBRUSH brush = CreateSolidBrush(fill);
    const HPEN pen = CreatePen(PS_SOLID, std::max(1, Scale(1)), outline);
    const auto old_brush = SelectObject(dc, brush), old_pen = SelectObject(dc, pen);
    RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, Scale(radius * 2), Scale(radius * 2));
    SelectObject(dc, old_brush); SelectObject(dc, old_pen);
    DeleteObject(brush); DeleteObject(pen);
  }
  void Paint() {
    PAINTSTRUCT paint{};
    HDC dc = BeginPaint(window_, &paint);
    RECT client{}; GetClientRect(window_, &client);
    FillRect(dc, &client, BackgroundBrush());
    Rounded(dc, client, 18, background, border);
    if (draft_border_.bottom > draft_border_.top)
      Rounded(dc, draft_border_, 9, RGB(255, 255, 255), GetFocus() == draft_ ? green : border);
    EndPaint(window_, &paint);
  }
  void DrawButton(const DRAWITEMSTRUCT& item) {
    const int saved = SaveDC(item.hDC);
    const bool enabled = !(item.itemState & ODS_DISABLED);
    const bool highlighted = (item.itemState & ODS_SELECTED) || hovered_ == item.hwndItem;
    const bool header = item.CtlID == target_id || item.CtlID == open_id || item.CtlID == collapse_id;
    const COLORREF fill = enabled && item.CtlID == send_id ? green :
      enabled && highlighted ? hover : header ? background : RGB(232, 243, 236);
    FillRect(item.hDC, &item.rcItem, BackgroundBrush());
    Rounded(item.hDC, item.rcItem, 9, fill, fill);
    const COLORREF text_color = !enabled ? muted : item.CtlID == send_id ? RGB(255, 255, 255) : foreground;
    SetTextColor(item.hDC, text_color); SetBkMode(item.hDC, TRANSPARENT);
    SelectObject(item.hDC, item.CtlID == target_id ? title_font_ : font_);
    RECT text = item.rcItem;
    if (item.CtlID == open_id || item.CtlID == collapse_id) {
      const int cx = (text.left + text.right) / 2, cy = (text.top + text.bottom) / 2;
      const HPEN pen = CreatePen(PS_SOLID, std::max(1, Scale(1)), text_color);
      const auto old_pen = SelectObject(item.hDC, pen);
      const auto old_brush = SelectObject(item.hDC, GetStockObject(NULL_BRUSH));
      if (item.CtlID == open_id) Rectangle(item.hDC, cx - Scale(5), cy - Scale(5), cx + Scale(5), cy + Scale(5));
      else { MoveToEx(item.hDC, cx - Scale(5), cy, nullptr); LineTo(item.hDC, cx + Scale(5), cy); }
      SelectObject(item.hDC, old_brush); SelectObject(item.hDC, old_pen); DeleteObject(pen);
    } else {
      text.left += Scale(6); text.right -= Scale(6);
      if (item.CtlID == target_id) text.right -= Scale(12);
      const auto label = Text(item.hwndItem);
      DrawTextW(item.hDC, label.c_str(), static_cast<int>(label.size()), &text,
        DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX | (item.CtlID == target_id ? DT_LEFT : DT_CENTER));
      if (item.CtlID == target_id) {
        RECT arrow = item.rcItem; arrow.left = arrow.right - Scale(16);
        DrawTextW(item.hDC, L"⌄", 1, &arrow, DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
      }
    }
    if (item.itemState & ODS_FOCUS) {
      RECT focus = item.rcItem; InflateRect(&focus, -Scale(3), -Scale(3));
      DrawFocusRect(item.hDC, &focus);
    }
    RestoreDC(item.hDC, saved);
  }
  static LRESULT CALLBACK ControlProcedure(HWND window, UINT message, WPARAM w, LPARAM l,
                                           UINT_PTR id, DWORD_PTR reference) {
    auto self = reinterpret_cast<PetChatPanel*>(reference);
    if (message == WM_MOUSEMOVE && window != self->draft_ && window != self->transcript_) {
      if (self->hovered_ != window) {
        if (self->hovered_) InvalidateRect(self->hovered_, nullptr, FALSE);
        self->hovered_ = window;
        InvalidateRect(window, nullptr, FALSE);
        TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, window, 0};
        TrackMouseEvent(&tracking);
      }
    }
    if (message == WM_MOUSELEAVE && self->hovered_ == window) {
      self->hovered_ = nullptr; InvalidateRect(window, nullptr, FALSE);
    }
    if ((message == WM_SETFOCUS || message == WM_KILLFOCUS) && window == self->draft_)
      InvalidateRect(self->window_, &self->draft_border_, FALSE);
    // CPS_CANCEL may be followed by an already queued END notification. Let
    // EDIT finish its native cleanup, but preserve the current owner's text
    // and selection and suppress every edit echo from this obsolete event.
    if (message == WM_IME_ENDCOMPOSITION && window == self->draft_ && !self->composing_) {
      const bool previous_setting = self->setting_draft_;
      self->setting_draft_ = true;
      const auto text = Text(window);
      DWORD start = 0, end = 0;
      SendMessageW(window, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
      const LRESULT result = DefSubclassProc(window, message, w, l);
      if (Text(window) != text) SetWindowTextW(window, text.c_str());
      SendMessageW(window, EM_SETSEL, start, end);
      self->setting_draft_ = previous_setting;
      return result;
    }
    if (message == WM_IME_STARTCOMPOSITION && window == self->draft_) {
      self->composing_ = true; self->UpdateControls();
    }
    if (window == self->draft_ && (message == WM_KEYDOWN || message == WM_CHAR) && w == VK_RETURN) {
      const auto decision = PetEnterDecision({self->composing_, (GetKeyState(VK_SHIFT) & 0x8000) != 0,
        (GetKeyState(VK_CONTROL) & 0x8000) != 0, (GetKeyState(VK_MENU) & 0x8000) != 0,
        (GetKeyState(VK_LWIN) & 0x8000) != 0 || (GetKeyState(VK_RWIN) & 0x8000) != 0,
        (l & (1LL << 30)) != 0, self->view_.busy});
      if (decision != PetEnterAction::PassThrough) {
        if (message == WM_KEYDOWN && decision == PetEnterAction::Send) self->Dispatch(PetChatAction::Send);
        if (message == WM_KEYDOWN && decision == PetEnterAction::Stop) self->Dispatch(PetChatAction::Stop);
        return 0;
      }
    }
    if (message == WM_KEYDOWN && w == VK_TAB && !self->composing_) {
      const HWND next = GetNextDlgTabItem(self->window_, window, (GetKeyState(VK_SHIFT) & 0x8000) != 0);
      if (next) SetFocus(next);
      return 0;
    }
    if (message == WM_KEYDOWN && w == VK_ESCAPE && !self->composing_) {
      self->Dispatch(PetChatAction::Collapse); return 0;
    }
    if (message == WM_KEYDOWN && w == VK_RETURN && window != self->draft_ && window != self->transcript_) {
      if (!(l & (1LL << 30))) SendMessageW(window, BM_CLICK, 0, 0);
      return 0;
    }
    const LRESULT result = DefSubclassProc(window, message, w, l);
    if (message == WM_IME_ENDCOMPOSITION && window == self->draft_) {
      self->composing_ = false; self->DraftChanged();
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, ControlProcedure, id);
    return result;
  }
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto self = reinterpret_cast<PetChatPanel*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      self = static_cast<PetChatPanel*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
      self->window_ = window;
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (!self) return DefWindowProcW(window, message, w, l);
    switch (message) {
      case WM_CREATE: return self->Controls() ? 0 : -1;
      case WM_SIZE: self->Layout(); return 0;
      case WM_ERASEBKGND: return 1;
      case WM_PAINT: self->Paint(); return 0;
      case WM_DRAWITEM:
        if (w) { self->DrawButton(*reinterpret_cast<DRAWITEMSTRUCT*>(l)); return TRUE; }
        break;
      case WM_CTLCOLOREDIT:
      case WM_CTLCOLORSTATIC: {
        const auto dc = reinterpret_cast<HDC>(w);
        const auto control = reinterpret_cast<HWND>(l);
        const bool draft = control == self->draft_;
        const auto color = control == self->error_ ? RGB(165, 42, 35) : control == self->status_ ? muted : foreground;
        SetTextColor(dc, color); SetBkColor(dc, draft ? RGB(255, 255, 255) : background);
        return reinterpret_cast<LRESULT>(draft ? GetStockObject(WHITE_BRUSH) : self->BackgroundBrush());
      }
      case WM_DPICHANGED: {
        self->dpi_ = HIWORD(w);
        self->RefreshFont();
        if (self->have_anchor_) self->Position(self->anchor_);
        self->Layout(); return 0;
      }
      case WM_COMMAND:
        if (LOWORD(w) == draft_id && HIWORD(w) == EN_CHANGE) { self->DraftChanged(); return 0; }
        if (HIWORD(w) != BN_CLICKED) break;
        if (LOWORD(w) == send_id) self->Dispatch(PetChatAction::Send);
        else if (LOWORD(w) == stop_id) self->Dispatch(PetChatAction::Stop);
        else if (LOWORD(w) == target_id) self->Dispatch(PetChatAction::ToggleTarget);
        else if (LOWORD(w) == open_id) self->Dispatch(PetChatAction::OpenMain);
        else if (LOWORD(w) == collapse_id) self->Dispatch(PetChatAction::Collapse);
        else if (LOWORD(w) == acknowledge_id) self->Dispatch(PetChatAction::AcknowledgeUnknown);
        else if (LOWORD(w) == dictation_id) self->Dispatch(PetChatAction::Dictation);
        else if (LOWORD(w) == call_id) self->Dispatch(PetChatAction::Call);
        else if (LOWORD(w) == mute_id) self->Dispatch(PetChatAction::Mute);
        return 0;
      case WM_CLOSE: self->Dispatch(PetChatAction::Collapse); return 0;
      case WM_NCDESTROY:
        self->window_ = nullptr;
        SetWindowLongPtrW(window, GWLP_USERDATA, 0); break;
    }
    return DefWindowProcW(window, message, w, l);
  }
};
}
