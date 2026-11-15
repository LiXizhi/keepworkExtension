#pragma once
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <cstring>
#include <functional>
#include "window_geometry.h"
#include "window_commands.h"
#include "menu_tracking.h"
#include "tray_icon.h"
#include "tray_lifecycle.h"
#include "host_version.h"
#include "chrome_theme.h"
#include "desktop_pet.h"
#include "pet_chat_panel.h"
#include "themed_popup.h"
#include "refresh_glyph.h"
#include "brand_glyph.h"

namespace keepwork_cef {
// This is an app-owned parent. Chromium keeps ownership of its child window
// and receives no new native JavaScript functions from the window chrome.
class WindowFrame {
 public:
  ~WindowFrame() { Destroy(); }
  HWND window() const { return window_; }
  void EnableServiceLauncher(bool enabled) { service_launcher_ = enabled; }
  bool Create() {
    if (!refresh_glyph_.Initialize()) return false;
    WNDCLASSW type{};
    type.style = CS_DBLCLKS;
    type.lpfnWndProc = Procedure;
    type.hInstance = Module();
    type.lpszClassName = L"KeepworkCefMainWindow";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.hIcon = LoadIconW(Module(), MAKEINTRESOURCEW(101));
    if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
    return CreateWindowExW(WS_EX_APPWINDOW, type.lpszClassName, L"Keepwork",
      WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, 80, 80, 1360, 900,
      nullptr, nullptr, type.hInstance, this) != nullptr;
  }
  RECT ContentBounds() const {
    const auto layout = Layout();
    const int border = layout.Border();
    return {border, layout.TitleHeight(), std::max(border, layout.width - border),
      std::max(layout.TitleHeight(), layout.height - border)};
  }
  void Attach(HWND content, std::function<bool()> close, std::function<void()> focus,
              std::function<void()> move, std::function<void(WindowCommand)> command, bool background,
              const std::wstring& profile) {
    content_ = content; close_ = std::move(close); focus_ = std::move(focus); move_ = std::move(move);
    command_ = std::move(command);
    SendMessageW(window_, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(LoadIconW(Module(), MAKEINTRESOURCEW(101))));
    SendMessageW(window_, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(LoadIconW(Module(), MAKEINTRESOURCEW(101))));
    Resize();
    pet_.Create(Module(), profile, [this] { Show(); }, [this] { Quit(); },
      [this] { TogglePetChat(); }, [this] { pet_chat_.Hide(); });
    lifecycle_.SetTrayAvailable(tray_.Add(window_, LoadIconW(Module(), MAKEINTRESOURCEW(101))));
    const bool visible = lifecycle_.Start(background);
    ShowWindow(window_, visible ? SW_SHOWNORMAL : SW_HIDE);
    if (!visible) ShowPet();
    UpdateWindow(window_);
  }
  void Show() {
    if (!window_) return;
    if (pet_open_main_) pet_open_main_();
    pet_chat_.Hide(); pet_.Hide();
    lifecycle_.Show();
    ShowWindow(window_, IsIconic(window_) ? SW_RESTORE : SW_SHOW);
    SetForegroundWindow(window_);
    if (focus_) focus_();
  }
  void Quit() {
    // Make beforeunload prompts visible. A canceled request never changes
    // normal close-to-tray behavior; CEF DoClose commits the close separately.
    Show();
    CloseBrowser();
  }
  void BrowserClosing() { pet_chat_.Hide(); pet_.Hide(); lifecycle_.BrowserClosing(); }
  void SetupPetChat(std::function<void(PetChatAction)> action,
      std::function<void(std::wstring)> edit, std::function<void()> tick, std::function<void()> open_main) {
    pet_tick_ = std::move(tick);
    pet_open_main_ = std::move(open_main);
    pet_chat_.Create(Module(), std::move(action), std::move(edit));
  }
  PetChatPanel& pet_chat() { return pet_chat_; }
  void PetChatTimer(bool enabled) {
    if (!window_) return;
    if (enabled) SetTimer(window_, 18, 500, nullptr); else KillTimer(window_, 18);
  }
  void SetTheme(const ChromeTheme& theme) {
    if (theme_ == theme) return;
    theme_ = theme;
    if (window_) RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
  }
  void Destroy() {
    ClearHover();
    if (tooltip_) { DestroyWindow(tooltip_); tooltip_ = nullptr; }
    PetChatTimer(false); pet_tick_ = {}; pet_open_main_ = {}; pet_chat_.Destroy();
    pet_.Destroy(); tray_.Remove(); lifecycle_.Destroy();
    close_ = {}; focus_ = {}; move_ = {}; command_ = {}; content_ = nullptr;
    if (window_) DestroyWindow(window_);
    if (font_) { DeleteObject(font_); font_ = nullptr; }
    if (title_font_) { DeleteObject(title_font_); title_font_ = nullptr; }
    refresh_glyph_.Destroy();
  }
  void ShowMenu(int index) {
    if (!window_ || fullscreen_ || menu_owner_) return;
    POINT cursor{}; GetCursorPos(&cursor);
    if (!menu_tracking_.Begin(index, cursor.x, cursor.y)) return;
    ClearHover();
    // TrackPopupMenuEx runs its own modal input loop, bypassing the heading
    // BUTTON windows. A thread-local filter observes input inside that loop.
    menu_owner_ = this;
    const auto hook = SetWindowsHookExW(WH_MSGFILTER, MenuMessageFilter, nullptr, GetCurrentThreadId());
    UINT selected = 0;
    do {
      index = menu_tracking_.active();
      ThemedPopup menu(theme_, Dpi(), Font());
      if (!menu.valid()) break;
      active_popup_ = &menu;
      PopulateMenu(menu, index, service_launcher_);
      if (!menu.valid()) { active_popup_ = nullptr; break; }
      PaintMenuHeadings();
      const auto layout = Layout();
      POINT point{layout.MenuBounds(index).left, layout.TitleHeight()};
      ClientToScreen(window_, &point);
      selected = TrackPopupMenuEx(menu.menu(), TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
        point.x, point.y, window_, nullptr);
      active_popup_ = nullptr;
      if (selected) break;
    } while (menu_tracking_.Advance() >= 0 && window_ && !fullscreen_ && GetForegroundWindow() == window_);
    if (hook) UnhookWindowsHookEx(hook);
    active_popup_ = nullptr;
    menu_owner_ = nullptr;
    menu_tracking_.Close();
    PaintMenuHeadings();
    // Restore editing focus once, after the entire menu interaction, without
    // stealing focus back when the user clicked another application.
    if (window_ && GetForegroundWindow() == window_ && focus_) focus_();
    const auto command = command_;
    if (selected && command) command(static_cast<WindowCommand>(selected));
  }
 private:
  static void PopulateMenu(ThemedPopup& menu, int index, bool service_launcher) {
    using Command = WindowCommand;
    const auto item = [&menu](Command command, const wchar_t* label) {
      menu.Item(static_cast<unsigned>(command), label);
    };
    const auto separator = [&menu] { menu.Separator(); };
    if (index == 0) {
      item(Command::reload, L"刷新\tCtrl+R");
      item(Command::reload_no_cache, L"忽略缓存刷新\tCtrl+Shift+R");
      item(Command::open_browser, L"在浏览器中打开"); separator();
      item(Command::close, L"关闭窗口\tAlt+F4");
      item(Command::quit, L"完全退出\tCtrl+Q");
    } else if (index == 1) {
      item(Command::undo, L"撤销\tCtrl+Z"); item(Command::redo, L"重做\tCtrl+Y"); separator();
      item(Command::cut, L"剪切\tCtrl+X"); item(Command::copy, L"复制\tCtrl+C");
      item(Command::paste, L"粘贴\tCtrl+V"); item(Command::select_all, L"全选\tCtrl+A");
    } else if (index == 2) {
      item(Command::zoom_in, L"放大\tCtrl++"); item(Command::zoom_out, L"缩小\tCtrl+-");
      item(Command::zoom_reset, L"实际大小\tCtrl+0"); separator();
      item(Command::fullscreen, L"全屏\tF11");
    } else {
      item(Command::dashboard, L"本地 MCP 面板");
      if (service_launcher) item(Command::start_mcp, L"启动本地服务");
      separator();
      item(Command::about, L"关于 Keepwork");
    }
  }
  void PaintMenuHeadings() const {
    for (auto menu : menus_) if (menu) RedrawWindow(menu, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
  }
  int MenuAt(POINT screen) const {
    const auto target = WindowFromPoint(screen);
    if (!window_ || !ScreenToClient(window_, &screen)) return -1;
    const int index = Layout().MenuAt(screen.x, screen.y);
    // A popup positioned above its anchor can cover the titlebar on a short
    // monitor. Only an exposed heading, never a popup item, can switch menus.
    return index >= 0 && target == menus_[index] ? index : -1;
  }
  static LRESULT CALLBACK MenuMessageFilter(int code, WPARAM w, LPARAM l) {
    auto self = menu_owner_;
    if (code == MSGF_MENU && self && self->menu_tracking_.active() >= 0) {
      const auto& message = *reinterpret_cast<MSG*>(l);
      bool handled = false;
      if (message.message == WM_MOUSEMOVE) {
        handled = self->menu_tracking_.Hover(self->MenuAt(message.pt), message.pt.x, message.pt.y);
      } else if (message.message == WM_LBUTTONDOWN || message.message == WM_LBUTTONDBLCLK) {
        handled = self->menu_tracking_.Click(self->MenuAt(message.pt));
      } else if (message.message == WM_KEYDOWN) {
        if (message.wParam == VK_LEFT) handled = self->menu_tracking_.Step(-1);
        else if (message.wParam == VK_RIGHT) handled = self->menu_tracking_.Step(1);
        else if (message.wParam == VK_F10) handled = self->menu_tracking_.Click(self->menu_tracking_.active());
      } else if (message.message == WM_SYSKEYDOWN && !(GetKeyState(VK_CONTROL) & 0x8000)) {
        const auto key = message.wParam;
        const int index = key == 'F' ? 0 : key == 'E' ? 1 : key == 'V' ? 2 : key == 'H' ? 3 : -1;
        handled = self->menu_tracking_.Switch(index);
      }
      if (handled) {
        EndMenu();
        return 1;
      }
    }
    return CallNextHookEx(nullptr, code, w, l);
  }
 public:
  void ToggleFullscreen() {
    if (!fullscreen_) {
      placement_.length = sizeof(placement_);
      if (!GetWindowPlacement(window_, &placement_)) return;
      MONITORINFO monitor{sizeof(monitor)};
      if (!GetMonitorInfoW(MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST), &monitor)) return;
      fullscreen_ = true;
      SetWindowLongPtrW(window_, GWL_STYLE, GetWindowLongPtrW(window_, GWL_STYLE) & ~WS_OVERLAPPEDWINDOW);
      SetWindowPos(window_, nullptr, monitor.rcMonitor.left, monitor.rcMonitor.top,
        monitor.rcMonitor.right - monitor.rcMonitor.left, monitor.rcMonitor.bottom - monitor.rcMonitor.top,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    } else {
      fullscreen_ = false;
      SetWindowLongPtrW(window_, GWL_STYLE, GetWindowLongPtrW(window_, GWL_STYLE) | WS_OVERLAPPEDWINDOW);
      SetWindowPlacement(window_, &placement_);
      SetWindowPos(window_, nullptr, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
    Resize();
    if (focus_) focus_();
  }

 private:
  HWND window_ = nullptr, content_ = nullptr, buttons_[3]{};
  HWND menus_[4]{};
  HWND toolbar_[2]{}, tooltip_ = nullptr, hovered_ = nullptr;
  MenuTracking menu_tracking_;
  ThemedPopup* active_popup_ = nullptr;
  inline static thread_local WindowFrame* menu_owner_ = nullptr;
  mutable HFONT font_ = nullptr;
  mutable HFONT title_font_ = nullptr;
  bool fullscreen_ = false;
  bool service_launcher_ = false;
  TrayIcon tray_;
  TrayLifecycle lifecycle_;
  DesktopPet pet_;
  PetChatPanel pet_chat_;
  std::function<void()> pet_tick_;
  std::function<void()> pet_open_main_;
  ChromeTheme theme_;
  RefreshGlyph refresh_glyph_;
  WINDOWPLACEMENT placement_{};
  int message_dpi_ = 0;
  std::function<bool()> close_;
  std::function<void()> focus_, move_;
  std::function<void(WindowCommand)> command_;
  static COLORREF NativeColor(const ChromeColor& color) { return RGB(color.red, color.green, color.blue); }
  static ChromeColor Blend(const ChromeColor& foreground, const ChromeColor& background, int percent) {
    return {(foreground.red * percent + background.red * (100 - percent) + 50) / 100,
      (foreground.green * percent + background.green * (100 - percent) + 50) / 100,
      (foreground.blue * percent + background.blue * (100 - percent) + 50) / 100};
  }
  void Hover(HWND control) {
    if (hovered_ == control) return;
    const auto previous = hovered_;
    hovered_ = control;
    if (previous) InvalidateRect(previous, nullptr, FALSE);
    if (control) InvalidateRect(control, nullptr, FALSE);
  }
  void ClearHover() {
    Hover(nullptr);
    if (tooltip_) SendMessageW(tooltip_, TTM_POP, 0, 0);
  }
  static LRESULT CALLBACK ControlProcedure(HWND control, UINT message, WPARAM w, LPARAM l,
                                           UINT_PTR id, DWORD_PTR data) {
    auto self = reinterpret_cast<WindowFrame*>(data);
    if (message == WM_MOUSEMOVE) {
      self->Hover(control);
      TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, control, 0};
      TrackMouseEvent(&tracking);
    } else if (message == WM_MOUSELEAVE) {
      if (self->hovered_ == control) self->ClearHover();
    } else if (message == WM_KEYDOWN && w == VK_RETURN) {
      if (!(l & (LPARAM(1) << 30))) SendMessageW(control, BM_CLICK, 0, 0);
      return 0;
    } else if (message == WM_NCDESTROY) {
      if (self->hovered_ == control) self->hovered_ = nullptr;
      RemoveWindowSubclass(control, ControlProcedure, id);
    }
    return DefSubclassProc(control, message, w, l);
  }
  void RegisterControl(HWND control, const wchar_t* description) {
    if (!control) return;
    SetWindowSubclass(control, ControlProcedure, 1, reinterpret_cast<DWORD_PTR>(this));
    if (tooltip_) {
      TOOLINFOW tool{};
      tool.cbSize = sizeof(tool); tool.uFlags = TTF_IDISHWND | TTF_SUBCLASS;
      tool.hwnd = window_; tool.uId = reinterpret_cast<UINT_PTR>(control);
      tool.lpszText = const_cast<wchar_t*>(description);
      SendMessageW(tooltip_, TTM_ADDTOOLW, 0, reinterpret_cast<LPARAM>(&tool));
    }
  }
  void ShowPet() {
    lifecycle_.SetPetVisible(false);
    if (!pet_.enabled()) return;
    if (pet_.Show()) { lifecycle_.SetPetVisible(true); return; }
    Show();
    MessageBoxW(window_, L"桌面宠物暂时无法显示，聊天窗口已保留。请从托盘重新打开，或完全退出后重试。",
      L"Keepwork", MB_OK | MB_ICONWARNING);
  }
  void TogglePetChat() {
    if (pet_chat_.visible()) pet_chat_.Hide();
    else pet_chat_.Show(pet_.bounds());
  }
  void CloseBrowser() {
    const auto close = close_;
    if (close && close()) DestroyWindow(window_);
  }
  void ShowTrayMenu(POINT point) {
    ClearHover();
    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    AppendMenuW(menu, MF_STRING, 1, L"打开聊天");
    AppendMenuW(menu, MF_STRING | (pet_.enabled() ? MF_CHECKED : MF_UNCHECKED), 5, L"显示桌面宠物");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, 2, L"打开本地 MCP 面板");
    if (service_launcher_) AppendMenuW(menu, MF_STRING, 6, L"启动本地服务");
    AppendMenuW(menu, MF_STRING, 3, L"关于 Keepwork");
    const auto version = std::wstring(L"版本 ") + kHostVersion;
    AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, version.c_str());
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, 4, L"完全退出\tCtrl+Q");
    SetMenuDefaultItem(menu, 1, FALSE);
    SetForegroundWindow(window_);
    const auto selected = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
      point.x, point.y, window_, nullptr);
    DestroyMenu(menu);
    // Let a click outside the menu dismiss it on subsequent interactions too.
    PostMessageW(window_, WM_NULL, 0, 0);
    if (selected == 1) Show();
    else if (selected == 4) Quit();
    else if (selected == 5) {
      pet_.SetEnabled(!pet_.enabled());
      if (lifecycle_.hidden()) ShowPet();
      else lifecycle_.SetPetVisible(false);
    } else if (selected && command_) {
      const auto command = command_;
      if (selected == 3) Show();
      command(selected == 2 ? WindowCommand::dashboard : selected == 6 ? WindowCommand::start_mcp : WindowCommand::about);
    }
  }
  static HMODULE Module() {
#if defined(CEF_USE_BOOTSTRAP)
    return GetModuleHandleW(L"keepwork-cef.dll");
#else
    return GetModuleHandleW(nullptr);
#endif
  }
  int Dpi() const {
    if (message_dpi_ > 0) return message_dpi_;
    using GetDpi = UINT(WINAPI*)(HWND);
    static const auto get_dpi = [] {
      const auto address = GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
      GetDpi function = nullptr;
      static_assert(sizeof(function) == sizeof(address));
      std::memcpy(&function, &address, sizeof(function));
      return function;
    }();
    if (get_dpi && window_) return static_cast<int>(get_dpi(window_));
    HDC context = GetDC(window_);
    const int dpi = context ? GetDeviceCaps(context, LOGPIXELSX) : 96;
    if (context) ReleaseDC(window_, context);
    return dpi > 0 ? dpi : 96;
  }
  FrameLayout Layout() const {
    RECT rect{}; if (window_) GetClientRect(window_, &rect);
    return {rect.right, rect.bottom, Dpi(), window_ && IsZoomed(window_) != FALSE, fullscreen_};
  }
  void Resize() {
    if (!window_ || IsIconic(window_)) return;
    ClearHover();
    const auto layout = Layout();
    const auto place = [](HWND child, const FrameRect& rect) {
      if (!child) return;
      if (rect.Empty()) ShowWindow(child, SW_HIDE);
      else SetWindowPos(child, nullptr, rect.left, rect.top, rect.Width(), rect.Height(),
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    };
    for (int i = 0; i < 3; ++i) {
      place(buttons_[i], layout.ControlBounds(i));
    }
    for (int i = 0; i < 4; ++i) {
      place(menus_[i], layout.MenuBounds(i));
    }
    const auto center = layout.CenterBounds();
    place(toolbar_[0], center.address); place(toolbar_[1], center.refresh);
    if (content_) {
      const auto rect = ContentBounds();
      SetWindowPos(content_, nullptr, rect.left, rect.top, rect.right - rect.left,
        rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE);
    }
    InvalidateRect(window_, nullptr, TRUE);
    for (auto button : buttons_) InvalidateRect(button, nullptr, TRUE);
    for (auto menu : menus_) InvalidateRect(menu, nullptr, TRUE);
    for (auto button : toolbar_) InvalidateRect(button, nullptr, TRUE);
  }
  void PaintButton(const DRAWITEMSTRUCT& item) const {
    const int heading = item.CtlID >= 100 && item.CtlID <= 103 ? static_cast<int>(item.CtlID) - 100 : -1;
    const auto visual = menu_tracking_.Visual(heading, (item.itemState & ODS_SELECTED) != 0,
      hovered_ == item.hwndItem, (item.itemState & ODS_FOCUS) != 0, (item.itemState & ODS_NOFOCUSRECT) != 0);
    const bool hot = visual.highlighted;
    const bool close_hot = item.CtlID == 3 && hot;
    const auto background_color = close_hot ? ChromeColor{196, 43, 28} : hot ? theme_.hover : theme_.background;
    const auto text_color = close_hot ? ChromeColor{255, 255, 255} : theme_.text;
    HBRUSH background = CreateSolidBrush(NativeColor(theme_.background));
    FillRect(item.hDC, &item.rcItem, background); DeleteObject(background);
    if (hot || item.CtlID == 200) {
      background = CreateSolidBrush(NativeColor(item.CtlID == 200 && !hot ? Blend(theme_.hover, theme_.background, 75) : background_color));
      const auto old_brush = SelectObject(item.hDC, background);
      const auto old_pen = SelectObject(item.hDC, GetStockObject(NULL_PEN));
      if (item.CtlID <= 3) FillRect(item.hDC, &item.rcItem, background);
      else RoundRect(item.hDC, item.rcItem.left, item.rcItem.top, item.rcItem.right, item.rcItem.bottom, Layout().Scale(5), Layout().Scale(5));
      SelectObject(item.hDC, old_pen); SelectObject(item.hDC, old_brush); DeleteObject(background);
    }
    if (visual.focus_outline) {
      RECT focus = item.rcItem; InflateRect(&focus, -Layout().Scale(2), -Layout().Scale(2));
      DrawFocusRect(item.hDC, &focus);
    }
    if (item.CtlID == 200) {
      RECT rect = item.rcItem; InflateRect(&rect, -Layout().Scale(8), 0);
      const auto old_font = SelectObject(item.hDC, Font());
      SetBkMode(item.hDC, TRANSPARENT); SetTextColor(item.hDC, NativeColor(Blend(text_color, theme_.background, 76)));
      DrawTextW(item.hDC, L"keepwork.com/chat", -1, &rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
      SelectObject(item.hDC, old_font); return;
    }
    if (item.CtlID >= 100 && item.CtlID <= 103) {
      const wchar_t* labels[] = {L"文件", L"编辑", L"视图", L"帮助"};
      RECT rect = item.rcItem;
      const auto old_font = SelectObject(item.hDC, Font());
      SetBkMode(item.hDC, TRANSPARENT); SetTextColor(item.hDC, NativeColor(text_color));
      DrawTextW(item.hDC, labels[item.CtlID - 100], -1, &rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
      SelectObject(item.hDC, old_font); return;
    }
    if (item.CtlID == 201) {
      refresh_glyph_.Draw(item.hDC, item.rcItem, NativeColor(text_color), Layout().Scale(16));
      return;
    }
    const int cx = (item.rcItem.right + item.rcItem.left) / 2;
    const int cy = (item.rcItem.bottom + item.rcItem.top) / 2;
    const int half = Layout().Scale(5);
    HPEN pen = CreatePen(PS_SOLID, Layout().Scale(1), NativeColor(text_color));
    const auto old_pen = SelectObject(item.hDC, pen);
    const auto old_brush = SelectObject(item.hDC, GetStockObject(HOLLOW_BRUSH));
    if (item.CtlID == 1) {
      MoveToEx(item.hDC, cx - half, cy, nullptr); LineTo(item.hDC, cx + half, cy);
    } else if (item.CtlID == 2) {
      if (IsZoomed(window_)) {
        Rectangle(item.hDC, cx - half + 2, cy - half, cx + half, cy + half - 2);
        Rectangle(item.hDC, cx - half, cy - half + 2, cx + half - 2, cy + half);
      } else Rectangle(item.hDC, cx - half, cy - half, cx + half, cy + half);
    } else {
      MoveToEx(item.hDC, cx - half, cy - half, nullptr); LineTo(item.hDC, cx + half, cy + half);
      MoveToEx(item.hDC, cx + half, cy - half, nullptr); LineTo(item.hDC, cx - half, cy + half);
    }
    SelectObject(item.hDC, old_brush); SelectObject(item.hDC, old_pen); DeleteObject(pen);
  }
  HFONT Font() const {
    if (!font_) font_ = CreateFontW(-Layout().Scale(12), 0, 0, 0, FW_NORMAL,
      FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
      CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    return font_;
  }
  HFONT TitleFont() const {
    if (!title_font_) title_font_ = CreateFontW(-Layout().Scale(12), 0, 0, 0, FW_SEMIBOLD,
      FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
      CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    return title_font_;
  }
  void PaintBrand(HDC context) const {
    const auto rect = Layout().IconBounds();
    if (rect.Empty()) return;
    BrandGlyph::Draw(context, {rect.left, rect.top, rect.right, rect.bottom},
      NativeColor(Blend(theme_.text, theme_.background, 72)));
  }
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto self = reinterpret_cast<WindowFrame*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      self = static_cast<WindowFrame*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
      self->window_ = window;
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (!self) return DefWindowProcW(window, message, w, l);
    static const UINT taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
    if (taskbar_created && message == taskbar_created && self->content_) {
      if (self->lifecycle_.SetTrayAvailable(self->tray_.Add(window, LoadIconW(Module(), MAKEINTRESOURCEW(101)))))
        self->Show();
      return 0;
    }
    switch (message) {
      case WM_TIMER:
        if (w == 18) { if (self->pet_tick_) self->pet_tick_(); return 0; }
        break;
      case TrayIcon::message: {
        const auto event = self->tray_.Event(w, l);
        if (event == NIN_SELECT || event == NIN_KEYSELECT || event == WM_LBUTTONUP || event == WM_LBUTTONDBLCLK)
          self->Show();
        else if (event == WM_CONTEXTMENU || event == WM_RBUTTONUP)
          self->ShowTrayMenu(self->tray_.Anchor(w));
        return 0;
      }
      case WM_NCCALCSIZE: return 0;  // Keep native sizing/snap styles without the system frame.
      case WM_NCPAINT: return 0;
      case WM_NCACTIVATE: return TRUE;
      case WM_CREATE: {
        INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_WIN95_CLASSES};
        if (InitCommonControlsEx(&controls)) self->tooltip_ = CreateWindowExW(WS_EX_TOPMOST, TOOLTIPS_CLASSW, nullptr,
          WS_POPUP | TTS_ALWAYSTIP | TTS_NOPREFIX, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
          window, nullptr, Module(), nullptr);
        const wchar_t* names[] = {L"最小化", L"最大化或还原", L"关闭"};
        for (int i = 0; i < 3; ++i) {
          self->buttons_[i] = CreateWindowW(L"BUTTON", names[i],
          WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(i + 1)), GetModuleHandleW(nullptr), nullptr);
          self->RegisterControl(self->buttons_[i], names[i]);
        }
        const wchar_t* menus[] = {L"文件 (Alt+F)", L"编辑 (Alt+E)", L"视图 (Alt+V)", L"帮助 (Alt+H)"};
        for (int i = 0; i < 4; ++i) {
          self->menus_[i] = CreateWindowW(L"BUTTON", menus[i],
          WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, 0, 0, 0, 0, window,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(100 + i)), Module(), nullptr);
          self->RegisterControl(self->menus_[i], menus[i]);
        }
        const wchar_t* toolbar[] = {L"在默认浏览器中打开 keepwork.com/chat", L"刷新页面"};
        for (int i = 0; i < 2; ++i) {
          self->toolbar_[i] = CreateWindowW(L"BUTTON", toolbar[i], WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
            0, 0, 0, 0, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(200 + i)), Module(), nullptr);
          self->RegisterControl(self->toolbar_[i], toolbar[i]);
        }
        self->Resize(); return 0;
      }
      case WM_NCHITTEST: {
        POINT point{GET_X_LPARAM(l), GET_Y_LPARAM(l)}; ScreenToClient(window, &point);
        switch (self->Layout().Hit(point.x, point.y)) {
          case FrameHit::caption: return HTCAPTION;
          case FrameHit::left: return HTLEFT;
          case FrameHit::right: return HTRIGHT;
          case FrameHit::top: return HTTOP;
          case FrameHit::bottom: return HTBOTTOM;
          case FrameHit::top_left: return HTTOPLEFT;
          case FrameHit::top_right: return HTTOPRIGHT;
          case FrameHit::bottom_left: return HTBOTTOMLEFT;
          case FrameHit::bottom_right: return HTBOTTOMRIGHT;
          default: return HTCLIENT;
        }
      }
      case WM_GETMINMAXINFO: {
        auto info = reinterpret_cast<MINMAXINFO*>(l);
        MONITORINFO monitor{sizeof(monitor)};
        if (GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor)) {
          info->ptMaxPosition = {monitor.rcWork.left - monitor.rcMonitor.left, monitor.rcWork.top - monitor.rcMonitor.top};
          info->ptMaxSize = {monitor.rcWork.right - monitor.rcWork.left, monitor.rcWork.bottom - monitor.rcWork.top};
        }
        info->ptMinTrackSize = {self->Layout().Scale(640), self->Layout().Scale(400)}; return 0;
      }
      case WM_DPICHANGED: {
        self->message_dpi_ = HIWORD(w);
        const auto rect = reinterpret_cast<RECT*>(l);
        SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left,
          rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
        if (self->font_) { DeleteObject(self->font_); self->font_ = nullptr; }
        if (self->title_font_) { DeleteObject(self->title_font_); self->title_font_ = nullptr; }
        self->Resize(); return 0;
      }
      case WM_SIZE: self->Resize(); return 0;
      case WM_ACTIVATEAPP: if (!w) self->ClearHover(); break;
      case WM_SHOWWINDOW: if (!w) self->ClearHover(); break;
      case WM_MOVE:
      case WM_MOVING:
      case WM_SIZING: if (self->move_) self->move_(); break;
      case WM_SETFOCUS: if (self->focus_) self->focus_(); return 0;
      case WM_CLOSE: {
        if (self->lifecycle_.Close() == CloseAction::hide) {
          ShowWindow(window, SW_HIDE);
          self->ShowPet();
        }
        else self->CloseBrowser();
        return 0;
      }
      case WM_COMMAND:
        if (LOWORD(w) == 1) ShowWindow(window, SW_MINIMIZE);
        else if (LOWORD(w) == 2) ShowWindow(window, IsZoomed(window) ? SW_RESTORE : SW_MAXIMIZE);
        else if (LOWORD(w) == 3) SendMessageW(window, WM_CLOSE, 0, 0);
        else if (LOWORD(w) >= 100 && LOWORD(w) <= 103) self->ShowMenu(LOWORD(w) - 100);
        else if ((LOWORD(w) == 200 || LOWORD(w) == 201) && self->command_) {
          const auto command = self->command_;
          command(LOWORD(w) == 200 ? WindowCommand::open_entry : WindowCommand::reload);
          if (self->window_ && GetForegroundWindow() == self->window_ && self->focus_) self->focus_();
        }
        return 0;
      case WM_SYSKEYDOWN:
        if (w == 'F') self->ShowMenu(0);
        else if (w == 'E') self->ShowMenu(1);
        else if (w == 'V') self->ShowMenu(2);
        else if (w == 'H') self->ShowMenu(3);
        else break;
        return 0;
      case WM_MEASUREITEM: {
        auto& item = *reinterpret_cast<MEASUREITEMSTRUCT*>(l);
        if (item.CtlType == ODT_MENU && self->active_popup_ && self->active_popup_->Measure(item)) return TRUE;
        break;
      }
      case WM_DRAWITEM: {
        const auto& item = *reinterpret_cast<DRAWITEMSTRUCT*>(l);
        if (item.CtlType == ODT_MENU && self->active_popup_ && self->active_popup_->Draw(item)) return TRUE;
        if (item.CtlType == ODT_BUTTON) { self->PaintButton(item); return TRUE; }
        break;
      }
      case WM_ERASEBKGND: return 1;
      case WM_PAINT: {
        PAINTSTRUCT paint{}; HDC context = BeginPaint(window, &paint);
        RECT rect{}; GetClientRect(window, &rect);
        HBRUSH background = CreateSolidBrush(NativeColor(self->theme_.background));
        FillRect(context, &rect, background); DeleteObject(background);
        const auto old = SelectObject(context, self->Font());
        SetBkMode(context, TRANSPARENT); SetTextColor(context, NativeColor(self->theme_.text));
        self->PaintBrand(context);
        const auto title = self->Layout().CenterBounds().title;
        if (!title.Empty()) {
          rect = {title.left, title.top, title.right, title.bottom};
          SelectObject(context, self->TitleFont());
          DrawTextW(context, L"KeepWork 第二大脑", -1, &rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
        }
        SelectObject(context, old); EndPaint(window, &paint); return 0;
      }
      case WM_NCDESTROY:
        self->hovered_ = nullptr; self->tooltip_ = nullptr;
        self->PetChatTimer(false); self->pet_chat_.Destroy();
        self->pet_.Destroy(); self->tray_.Remove(); self->lifecycle_.Destroy();
        self->window_ = nullptr; SetWindowLongPtrW(window, GWLP_USERDATA, 0); break;
    }
    return DefWindowProcW(window, message, w, l);
  }
};
}
