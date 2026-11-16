#pragma once
#include <windows.h>
#include <shellapi.h>
#include <string>
#include <cwchar>
#include <string>

namespace keepwork_cef {
// The browser-process main window owns the icon; renderer/GPU processes and
// the short-lived compatibility launcher never register their own icons.
class TrayIcon {
 public:
  static constexpr UINT message = WM_APP + 20;
  static constexpr UINT id = 1;
  ~TrayIcon() { Remove(); }
  bool Add(HWND window, HICON icon) {
    Remove();
    window_ = window;
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = window;
    data.uID = id;
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = message;
    data.hIcon = icon;
    std::wcsncpy(data.szTip, L"Keepwork Windows 兼容客户端", ARRAYSIZE(data.szTip) - 1);
    // Also used after TaskbarCreated, when Explorer has discarded old icons.
    added_ = Shell_NotifyIconW(NIM_ADD, &data) != FALSE;
    modern_ = false;
    if (added_) {
      data.uVersion = NOTIFYICON_VERSION_4;
      modern_ = Shell_NotifyIconW(NIM_SETVERSION, &data) != FALSE;
    }
    return added_;
  }
  void Remove() {
    if (added_) {
      NOTIFYICONDATAW data{};
      data.cbSize = sizeof(data); data.hWnd = window_; data.uID = id;
      Shell_NotifyIconW(NIM_DELETE, &data);
    }
    added_ = false; window_ = nullptr;
  }
  bool Notify(const std::wstring& text) {
    if (!added_) return false;
    NOTIFYICONDATAW data{}; data.cbSize = sizeof(data); data.hWnd = window_; data.uID = id;
    data.uFlags = NIF_INFO; data.dwInfoFlags = NIIF_INFO;
    lstrcpynW(data.szInfoTitle, L"Keepwork 更新已就绪", ARRAYSIZE(data.szInfoTitle));
    lstrcpynW(data.szInfo, text.c_str(), ARRAYSIZE(data.szInfo));
    return Shell_NotifyIconW(NIM_MODIFY, &data) != FALSE;
  }
  UINT Event(WPARAM w, LPARAM l) const {
    if (!added_) return 0;
    if (modern_) return HIWORD(l) == id ? LOWORD(l) : 0;
    return w == id ? static_cast<UINT>(l) : 0;
  }
  POINT Anchor(WPARAM w) const {
    POINT point{};
    if (modern_) {
      point = {static_cast<short>(LOWORD(w)), static_cast<short>(HIWORD(w))};
      if (point.x != -1 || point.y != -1) return point;
    }
    GetCursorPos(&point);
    return point;
  }
 private:
  HWND window_ = nullptr;
  bool added_ = false, modern_ = false;
};
}
