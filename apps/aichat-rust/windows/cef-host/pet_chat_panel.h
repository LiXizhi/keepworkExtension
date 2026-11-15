#pragma once
#include <windows.h>
#include <commctrl.h>
#include <imm.h>
#include <algorithm>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace keepwork_cef {
enum class PetChatAction { Send, Stop, ToggleTarget, OpenMain, Collapse, AcknowledgeUnknown };
struct PetChatView {
  std::wstring title, transcript, status, error;
  bool ready = false, busy = false, rich_draft = false, dictating = false;
  bool can_switch = false, pending = false, uncertain = false, unsynced = false;
};

// Native text presentation only. The owner supplies the existing webpage's
// conversation snapshot and handles explicit actions; this window creates no
// session, browser, network connection or model invocation on its own.
class PetChatPanel {
 public:
  static constexpr int title_id = 101, transcript_id = 102, status_id = 103, error_id = 104;
  static constexpr int draft_id = 105, send_id = 106, stop_id = 107, target_id = 108;
  static constexpr int open_id = 109, collapse_id = 110, acknowledge_id = 111;
  ~PetChatPanel() { Destroy(); }
  bool Create(HINSTANCE instance, std::function<void(PetChatAction)> action,
              std::function<void(std::wstring)> edit) {
    Destroy();
    instance_ = instance; action_ = std::move(action); edit_ = std::move(edit);
    creating_ = true;
    WNDCLASSW type{};
    type.lpfnWndProc = Procedure;
    type.hInstance = instance;
    type.lpszClassName = L"KeepworkCefPetChatPanel";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
    if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) { Destroy(); return false; }
    window_ = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, type.lpszClassName,
      L"Keepwork 宠物对话", WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN,
      0, 0, 380, 460, nullptr, nullptr, instance, this);
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
      MONITORINFO monitor{sizeof(monitor)};
      if (GetMonitorInfoW(MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST), &monitor)) {
        const int width = std::min<int>(Scale(380), std::max(1L, monitor.rcWork.right - monitor.rcWork.left));
        const int height = std::min<int>(Scale(460), std::max(1L, monitor.rcWork.bottom - monitor.rcWork.top));
        const int left = std::clamp(static_cast<int>(anchor.right) - width,
          static_cast<int>(monitor.rcWork.left), static_cast<int>(monitor.rcWork.right) - width);
        int top = static_cast<int>(anchor.top) - height - Scale(8);
        if (top < monitor.rcWork.top) top = static_cast<int>(anchor.bottom) + Scale(8);
        top = std::clamp(top, static_cast<int>(monitor.rcWork.top), static_cast<int>(monitor.rcWork.bottom) - height);
        SetWindowPos(window_, HWND_TOPMOST, left, top, width, height, SWP_NOACTIVATE);
      }
      ShowWindow(window_, SW_SHOW);
    }
    SetForegroundWindow(window_);
    SetFocus(draft_);
  }
  void Hide() { if (window_) ShowWindow(window_, SW_HIDE); }
  void Destroy() {
    action_ = {}; edit_ = {};
    if (window_) DestroyWindow(window_);
    if (font_) { DeleteObject(font_); font_ = nullptr; }
    title_ = transcript_ = status_ = error_ = draft_ = nullptr;
    send_ = stop_ = target_ = open_ = collapse_ = acknowledge_ = nullptr;
    setting_draft_ = composing_ = creating_ = false;
  }
  bool visible() const { return window_ && IsWindowVisible(window_) != FALSE; }
  HWND window() const { return window_; }
  void Update(const PetChatView& view) {
    view_ = view;
    if (!window_) return;
    SetText(title_, view.title.empty() ? L"当前对话" : view.title);
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
  HWND window_ = nullptr, title_ = nullptr, transcript_ = nullptr, status_ = nullptr;
  HWND error_ = nullptr, draft_ = nullptr, send_ = nullptr, stop_ = nullptr, target_ = nullptr;
  HWND open_ = nullptr, collapse_ = nullptr, acknowledge_ = nullptr;
  HINSTANCE instance_ = nullptr;
  HFONT font_ = nullptr;
  int dpi_ = 96;
  bool setting_draft_ = false, composing_ = false, creating_ = false;
  PetChatView view_;
  std::function<void(PetChatAction)> action_;
  std::function<void(std::wstring)> edit_;
  int Scale(int value) const { return (value * std::clamp(dpi_, 48, 768) + 48) / 96; }
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
    if (window && Text(window) != text) SetWindowTextW(window, text.c_str());
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
    const auto text = Draft();
    return text.find_first_not_of(L" \t\r\n") != std::wstring::npos;
  }
  bool CanSend() const {
    return view_.ready && !view_.busy && !view_.rich_draft && !view_.dictating &&
      !view_.pending && !view_.uncertain && !composing_ && HasDraft();
  }
  bool CanStop() const { return view_.ready && view_.busy && !view_.pending; }
  bool CanSwitch() const {
    return view_.can_switch && !view_.busy && !view_.pending && !view_.uncertain && !view_.unsynced &&
      !view_.rich_draft && !view_.dictating && !composing_;
  }
  std::wstring StatusText() const {
    if (!view_.status.empty()) return view_.status;
    if (view_.uncertain) return L"结果待核查；不会自动重发。";
    if (view_.pending) return L"请求处理中…";
    if (!view_.ready) return L"等待网页宠物通道就绪…";
    if (view_.rich_draft) return L"草稿包含富文本，请打开主窗口继续编辑。";
    if (view_.dictating) return L"正在语音输入，请在主窗口完成后发送。";
    if (view_.busy) return L"正在回复…";
    return L"使用当前网页对话；按发送按钮提交。";
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
    title_ = Control(L"STATIC", L"当前对话", SS_LEFT | SS_NOPREFIX, title_id);
    transcript_ = Control(L"EDIT", L"", ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_TABSTOP,
      transcript_id, WS_EX_CLIENTEDGE);
    status_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, status_id);
    error_ = Control(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, error_id);
    draft_ = Control(L"EDIT", L"", ES_MULTILINE | ES_WANTRETURN | ES_AUTOVSCROLL | WS_VSCROLL | WS_TABSTOP,
      draft_id, WS_EX_CLIENTEDGE);
    send_ = Control(L"BUTTON", L"发送", BS_PUSHBUTTON | WS_TABSTOP, send_id);
    stop_ = Control(L"BUTTON", L"停止", BS_PUSHBUTTON | WS_TABSTOP, stop_id);
    target_ = Control(L"BUTTON", L"切换目标", BS_PUSHBUTTON | WS_TABSTOP, target_id);
    open_ = Control(L"BUTTON", L"打开主窗", BS_PUSHBUTTON | WS_TABSTOP, open_id);
    collapse_ = Control(L"BUTTON", L"收起", BS_PUSHBUTTON | WS_TABSTOP, collapse_id);
    acknowledge_ = Control(L"BUTTON", L"已核查，继续", BS_PUSHBUTTON | WS_TABSTOP, acknowledge_id);
    SendMessageW(draft_, EM_SETLIMITTEXT, 32000, 0);
    SendMessageW(transcript_, EM_SETLIMITTEXT, 1024 * 1024, 0);
    return title_ && transcript_ && status_ && error_ && draft_ && send_ && stop_ && target_ && open_ && collapse_ && acknowledge_;
  }
  void RefreshFont() {
    HFONT next = CreateFontW(-Scale(13), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
      DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    if (!next) return;
    for (const auto control : {title_, transcript_, status_, error_, draft_, send_, stop_, target_, open_, collapse_, acknowledge_})
      if (control) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(next), TRUE);
    if (font_) DeleteObject(font_);
    font_ = next;
  }
  void Layout() {
    if (!window_) return;
    RECT client{}; GetClientRect(window_, &client);
    const int margin = Scale(10), gap = Scale(6);
    const int width = std::max(0L, client.right - 2 * margin);
    int y = margin;
    const auto place = [](HWND control, int left, int top, int width, int height) {
      if (control) SetWindowPos(control, nullptr, left, top, std::max(0, width), std::max(0, height), SWP_NOZORDER | SWP_NOACTIVATE);
    };
    place(title_, margin, y, width, Scale(22)); y += Scale(22) + gap;
    place(target_, margin, y, Scale(82), Scale(28));
    place(open_, margin + Scale(88), y, Scale(82), Scale(28));
    place(collapse_, margin + Scale(176), y, Scale(60), Scale(28)); y += Scale(28) + gap;
    place(status_, margin, y, width, Scale(36)); y += Scale(36) + gap;
    const bool has_error = !ErrorText().empty();
    ShowWindow(error_, has_error ? SW_SHOWNA : SW_HIDE);
    if (has_error) { place(error_, margin, y, width, Scale(48)); y += Scale(48) + gap; }
    if (view_.uncertain) { place(acknowledge_, margin, y, width, Scale(28)); y += Scale(28) + gap; }
    const int action_y = std::max(y, static_cast<int>(client.bottom) - margin - Scale(30));
    const int draft_height = std::min(Scale(80), std::max(0, action_y - gap - y));
    const int draft_y = action_y - gap - draft_height;
    place(transcript_, margin, y, width, std::max(0, draft_y - gap - y));
    place(draft_, margin, draft_y, width, draft_height);
    place(send_, margin + std::max(0, width - Scale(68)), action_y, Scale(68), Scale(30));
    place(stop_, margin + std::max(0, width - Scale(142)), action_y, Scale(68), Scale(30));
  }
  static LRESULT CALLBACK ControlProcedure(HWND window, UINT message, WPARAM w, LPARAM l,
                                           UINT_PTR id, DWORD_PTR reference) {
    auto self = reinterpret_cast<PetChatPanel*>(reference);
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
    if (message == WM_KEYDOWN && w == VK_TAB && !self->composing_) {
      const HWND next = GetNextDlgTabItem(self->window_, window, (GetKeyState(VK_SHIFT) & 0x8000) != 0);
      if (next) SetFocus(next);
      return 0;
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
      case WM_DPICHANGED: {
        self->dpi_ = HIWORD(w);
        self->RefreshFont();
        const auto rect = reinterpret_cast<RECT*>(l);
        SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top,
          SWP_NOZORDER | SWP_NOACTIVATE);
        self->Layout(); return 0;
      }
      case WM_GETMINMAXINFO: {
        const auto info = reinterpret_cast<MINMAXINFO*>(l);
        info->ptMinTrackSize = {self->Scale(300), self->Scale(330)};
        return 0;
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
