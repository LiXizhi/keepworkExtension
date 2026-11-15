#pragma once
#include <windows.h>
#include <windowsx.h>
#include <objidl.h>
#include <shellapi.h>
#include <algorithm>
// GDI+ headers use unqualified min/max even in NOMINMAX builds.
namespace Gdiplus { using std::min; using std::max; }
#include <gdiplus.h>
#include <cstring>
#include <cwchar>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include "pet_geometry.h"
#include "pet_artwork.h"

namespace keepwork_cef {
// A small, native top-level layered window. It has no webview, JavaScript,
// network access, clipboard or MCP access. Artwork arrives as bounded PNG bytes
// from the trusted document's sandboxed decoder, never as a native fetch URL.
class DesktopPet {
 public:
  ~DesktopPet() { Destroy(); }
  bool Create(HMODULE module, const std::wstring& profile,
              std::function<void()> open, std::function<void()> quit,
              std::function<void()> toggle_chat = {}, std::function<void()> hidden = {},
              std::function<void(RECT)> moved = {}) {
    Destroy();
    module_ = module;
    settings_ = profile + L"\\pet-settings.ini";
    open_ = std::move(open); quit_ = std::move(quit);
    toggle_chat_ = std::move(toggle_chat); hidden_ = std::move(hidden);
    moved_ = std::move(moved);
    enabled_ = GetPrivateProfileIntW(L"pet", L"enabled", 1, settings_.c_str()) != 0;
    wchar_t appearance[32]{};
    GetPrivateProfileStringW(L"pet", L"appearance", L"follow", appearance, ARRAYSIZE(appearance), settings_.c_str());
    appearance_ = NormalizePetAppearance(appearance);
    have_position_ = ReadInteger(L"x", x_) && ReadInteger(L"y", y_);
    Gdiplus::GdiplusStartupInput startup;
    if (Gdiplus::GdiplusStartup(&gdiplus_, &startup, nullptr) != Gdiplus::Ok) return Failed();
    const auto resource = FindResourceW(module, MAKEINTRESOURCEW(102), MAKEINTRESOURCEW(10));
    const DWORD bytes = resource ? SizeofResource(module, resource) : 0;
    const auto loaded = resource ? LoadResource(module, resource) : nullptr;
    const void* source = loaded ? LockResource(loaded) : nullptr;
    if (!source || !bytes || bytes > 4 * 1024 * 1024) return Failed();
    HGLOBAL buffer = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!buffer) return Failed();
    void* destination = GlobalLock(buffer);
    if (!destination) { GlobalFree(buffer); return Failed(); }
    std::memcpy(destination, source, bytes);
    GlobalUnlock(buffer);
    if (FAILED(CreateStreamOnHGlobal(buffer, TRUE, &stream_))) {
      GlobalFree(buffer); return Failed();
    }
    image_.reset(Gdiplus::Bitmap::FromStream(stream_));
    if (!image_ || image_->GetLastStatus() != Gdiplus::Ok || image_->GetWidth() < 4 ||
        image_->GetHeight() < 4 || image_->GetWidth() > 4096 || image_->GetHeight() > 4096)
      return Failed();
    WNDCLASSW type{};
    type.style = CS_DBLCLKS;
    type.lpfnWndProc = Procedure;
    type.hInstance = module;
    type.lpszClassName = L"KeepworkCefDesktopPet";
    type.hCursor = LoadCursorW(nullptr, IDC_HAND);
    if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return Failed();
    window_ = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE,
      type.lpszClassName, L"Keepwork 桌面宠物", WS_POPUP, 0, 0, 112, 112,
      nullptr, nullptr, module, this);
    if (!window_) return Failed();
    return true;
  }
  bool Show() {
    if (!window_ || !enabled_) return false;
    POINT point{x_, y_};
    if (!have_position_) GetCursorPos(&point);
    const auto monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{sizeof(info)};
    if (!GetMonitorInfoW(monitor, &info)) return false;
    const int pixels = PetPixels(MonitorDpi(monitor));
    if (!have_position_) {
      x_ = info.rcWork.right - pixels - 24;
      y_ = info.rcWork.bottom - pixels - 24;
    }
    const auto placement = PlacePet(x_, y_, pixels, WorkArea(info));
    if (!Paint(placement)) return false;
    have_position_ = true;
    ShowWindow(window_, SW_SHOWNOACTIVATE);
    Raise();
    return IsWindowVisible(window_) != FALSE;
  }
  void Hide() {
    CancelClick();
    CancelDrag();
    if (window_) ShowWindow(window_, SW_HIDE);
    const auto hidden = hidden_; if (hidden) hidden();
  }
  void Destroy() {
    Hide();
    if (window_) DestroyWindow(window_);
    FreeSurface();
    // The decoder may still read its source stream until the image is gone.
    image_.reset();
    if (stream_) { stream_->Release(); stream_ = nullptr; }
    ClearArtwork();
    if (gdiplus_) { Gdiplus::GdiplusShutdown(gdiplus_); gdiplus_ = 0; }
    open_ = {}; quit_ = {}; toggle_chat_ = {}; hidden_ = {}; moved_ = {}; settings_.clear();
  }
  bool enabled() const { return enabled_; }
  void SetArtwork(const std::wstring& name, const std::string& png) {
    if (artwork_bytes_ == png && artwork_name_ == name) return;
    ClearArtwork();
    artwork_name_ = name.substr(0, 48);
    if (!png.empty() && ValidPetPng(png.data(), png.size())) {
      HGLOBAL buffer = GlobalAlloc(GMEM_MOVEABLE, png.size());
      if (buffer) {
        void* destination = GlobalLock(buffer);
        if (destination) {
          std::memcpy(destination, png.data(), png.size());
          GlobalUnlock(buffer);
          if (SUCCEEDED(CreateStreamOnHGlobal(buffer, TRUE, &artwork_stream_))) {
            artwork_.reset(Gdiplus::Bitmap::FromStream(artwork_stream_));
            if (!artwork_ || artwork_->GetLastStatus() != Gdiplus::Ok || !artwork_->GetWidth()
                || !artwork_->GetHeight() || artwork_->GetWidth() > 256 || artwork_->GetHeight() > 256) {
              ClearArtwork();
            } else artwork_bytes_ = png;
          } else GlobalFree(buffer);
        } else GlobalFree(buffer);
      }
    }
    if (visible()) Show();
  }
  void SetEnabled(bool enabled) {
    enabled_ = enabled;
    if (!settings_.empty()) WritePrivateProfileStringW(L"pet", L"enabled", enabled ? L"1" : L"0", settings_.c_str());
    if (!enabled) Hide();
  }
  bool visible() const { return window_ && IsWindowVisible(window_) != FALSE; }
  // Keep the drag handle reachable when a work-area-clamped chat overlaps it.
  void Raise() const {
    if (visible()) SetWindowPos(window_, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  HWND window() const { return window_; }
  RECT bounds() const {
    RECT rect{};
    if (window_) GetWindowRect(window_, &rect);
    return rect;
  }

 private:
  static constexpr UINT_PTR drag_timer = 1;
  static constexpr UINT_PTR click_timer = 2;
  HMODULE module_ = nullptr;
  HWND window_ = nullptr;
  ULONG_PTR gdiplus_ = 0;
  IStream* stream_ = nullptr;
  std::unique_ptr<Gdiplus::Bitmap> image_;
  IStream* artwork_stream_ = nullptr;
  std::unique_ptr<Gdiplus::Bitmap> artwork_;
  std::string artwork_bytes_;
  std::wstring artwork_name_, appearance_ = L"follow";
  HDC surface_ = nullptr;
  HBITMAP bitmap_ = nullptr;
  HGDIOBJ previous_bitmap_ = nullptr;
  void* bits_ = nullptr;
  int surface_pixels_ = 0;
  int x_ = 0, y_ = 0;
  bool enabled_ = true, have_position_ = false, painting_ = false, pending_click_ = false;
  std::wstring settings_;
  std::function<void()> open_, quit_, toggle_chat_, hidden_;
  std::function<void(RECT)> moved_;
  PetDragState drag_;
  POINT drag_start_{}, drag_origin_{};

  bool Failed() { Destroy(); return false; }
  void ClearArtwork() {
    artwork_.reset();
    if (artwork_stream_) { artwork_stream_->Release(); artwork_stream_ = nullptr; }
    artwork_bytes_.clear(); artwork_name_.clear();
  }
  void SetAppearance(const wchar_t* value) {
    appearance_ = NormalizePetAppearance(value);
    if (!settings_.empty()) WritePrivateProfileStringW(L"pet", L"appearance", appearance_.c_str(), settings_.c_str());
    if (visible()) Show();
  }
  bool ReadInteger(const wchar_t* key, int& value) const {
    wchar_t text[40]{};
    if (!GetPrivateProfileStringW(L"pet", key, L"", text, ARRAYSIZE(text), settings_.c_str())) return false;
    wchar_t* end = nullptr;
    const auto number = std::wcstoll(text, &end, 10);
    if (!end || end == text || *end || number < (std::numeric_limits<int>::min)() ||
        number > (std::numeric_limits<int>::max)()) return false;
    value = static_cast<int>(number);
    return true;
  }
  void SavePosition() const {
    if (!have_position_ || settings_.empty()) return;
    const auto x = std::to_wstring(x_), y = std::to_wstring(y_);
    WritePrivateProfileStringW(L"pet", L"x", x.c_str(), settings_.c_str());
    WritePrivateProfileStringW(L"pet", L"y", y.c_str(), settings_.c_str());
  }
  static PetWorkArea WorkArea(const MONITORINFO& info) {
    return {info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom};
  }
  int MonitorDpi(HMONITOR monitor) const {
    using GetMonitorDpi = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
    static const GetMonitorDpi get_monitor_dpi = [] {
      // Win7 has no Shcore.dll. Load an optional newer API from System32 only.
      wchar_t directory[MAX_PATH]{};
      const UINT length = GetSystemDirectoryW(directory, ARRAYSIZE(directory));
      if (!length || length >= ARRAYSIZE(directory)) return GetMonitorDpi(nullptr);
      const auto path = std::wstring(directory, length) + L"\\shcore.dll";
      const auto library = LoadLibraryW(path.c_str());
      const auto address = library ? GetProcAddress(library, "GetDpiForMonitor") : nullptr;
      GetMonitorDpi function = nullptr;
      static_assert(sizeof(function) == sizeof(address));
      std::memcpy(&function, &address, sizeof(function));
      // Keep a successfully loaded module mapped while its function is used.
      if (!function && library) FreeLibrary(library);
      return function;
    }();
    UINT horizontal = 0, vertical = 0;
    if (get_monitor_dpi && SUCCEEDED(get_monitor_dpi(monitor, 0, &horizontal, &vertical)) && horizontal > 0 && horizontal <= 768)
      return static_cast<int>(horizontal);
    HDC context = GetDC(window_);
    const int dpi = context ? GetDeviceCaps(context, LOGPIXELSX) : 96;
    if (context) ReleaseDC(window_, context);
    return dpi > 0 ? dpi : 96;
  }
  void FreeSurface() {
    if (surface_ && previous_bitmap_) SelectObject(surface_, previous_bitmap_);
    if (bitmap_) DeleteObject(bitmap_);
    if (surface_) DeleteDC(surface_);
    bitmap_ = nullptr; surface_ = nullptr; previous_bitmap_ = nullptr;
    bits_ = nullptr; surface_pixels_ = 0;
  }
  bool Surface(int pixels) {
    if (surface_ && pixels == surface_pixels_) return true;
    FreeSurface();
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = pixels; info.bmiHeader.biHeight = -pixels;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    bitmap_ = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &bits_, nullptr, 0);
    surface_ = CreateCompatibleDC(nullptr);
    if (!bitmap_ || !surface_ || !bits_) { FreeSurface(); return false; }
    previous_bitmap_ = SelectObject(surface_, bitmap_);
    if (!previous_bitmap_ || previous_bitmap_ == HGDI_ERROR) { previous_bitmap_ = nullptr; FreeSurface(); return false; }
    surface_pixels_ = pixels;
    return true;
  }
  bool Paint(const PetPlacement& placement) {
    if (!window_ || !image_ || painting_ || !Surface(placement.pixels)) return false;
    painting_ = true;
    const int pixels = placement.pixels;
    std::memset(bits_, 0, static_cast<size_t>(pixels) * pixels * 4);
    Gdiplus::Status status;
    {
      Gdiplus::Bitmap canvas(pixels, pixels, pixels * 4, PixelFormat32bppPARGB, static_cast<BYTE*>(bits_));
      Gdiplus::Graphics graphics(&canvas);
      graphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy);
      graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
      graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
      const bool follow = appearance_ == L"follow" && artwork_;
      auto image = follow ? artwork_.get() : image_.get();
      // Published PNGs are already cropped. The bundled dragon remains a 4x4
      // sheet, with fractional source cells matching the modern CSS default.
      const float columns = follow ? 1.f : 4.f;
      status = graphics.DrawImage(image, Gdiplus::RectF(0, 0, static_cast<float>(pixels), static_cast<float>(pixels)),
        0.f, 0.f, image->GetWidth() / columns, image->GetHeight() / columns, Gdiplus::UnitPixel);
    }
    POINT position{placement.x, placement.y}, source{0, 0};
    SIZE size{pixels, pixels};
    BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    HDC screen = GetDC(nullptr);
    const bool ok = status == Gdiplus::Ok && UpdateLayeredWindow(window_, screen, &position, &size, surface_, &source, 0, &blend, ULW_ALPHA);
    if (screen) ReleaseDC(nullptr, screen);
    if (ok) { x_ = placement.x; y_ = placement.y; }
    painting_ = false;
    const auto moved = moved_;
    if (ok && moved) moved(bounds());
    if (ok) Raise();
    return ok;
  }
  void MovePet(POINT cursor) {
    const auto monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{sizeof(info)};
    if (!GetMonitorInfoW(monitor, &info)) return;
    const auto x = std::clamp<std::int64_t>(std::int64_t(drag_origin_.x) + cursor.x - drag_start_.x,
      (std::numeric_limits<int>::min)(), (std::numeric_limits<int>::max)());
    const auto y = std::clamp<std::int64_t>(std::int64_t(drag_origin_.y) + cursor.y - drag_start_.y,
      (std::numeric_limits<int>::min)(), (std::numeric_limits<int>::max)());
    Paint(PlacePet(static_cast<int>(x), static_cast<int>(y), PetPixels(MonitorDpi(monitor)), WorkArea(info)));
  }
  void StopTracking() {
    if (window_) KillTimer(window_, drag_timer);
  }
  void CancelClick() {
    if (window_) KillTimer(window_, click_timer);
    pending_click_ = false;
  }
  void SingleClick() {
    if (!pending_click_) return;
    CancelClick();
    const auto action = toggle_chat_ ? toggle_chat_ : open_;
    if (action) action();
  }
  void QueueClick() {
    CancelClick();
    pending_click_ = true;
    if (!window_ || !SetTimer(window_, click_timer, GetDoubleClickTime(), nullptr)) SingleClick();
  }
  void CancelDrag() {
    StopTracking();
    if (drag_.active() && drag_.moved()) SavePosition();
    drag_.Cancel();
    if (window_ && GetCapture() == window_) ReleaseCapture();
  }
  void FinishDrag(POINT point) {
    if (!drag_.active()) { StopTracking(); return; }
    const bool moved = drag_.Move(point.x, point.y);
    const bool click = drag_.End(point.x, point.y);
    // Finish the interaction before releasing capture or invoking callbacks:
    // either can synchronously deliver more messages to this window.
    StopTracking();
    if (moved) { MovePet(point); SavePosition(); }
    if (window_ && GetCapture() == window_) ReleaseCapture();
    if (click) QueueClick();
  }
  void TrackPointer() {
    if (!drag_.active()) { StopTracking(); return; }
    POINT point{};
    if (!GetCursorPos(&point)) { CancelDrag(); return; }
    if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) FinishDrag(point);
    else if (drag_.Move(point.x, point.y)) MovePet(point);
  }
  void Menu() {
    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    auto name = appearance_ == L"follow" && artwork_ && !artwork_name_.empty() ? artwork_name_ : L"抱抱龙";
    // Ampersands in a pet name are text rather than menu accelerators.
    for (size_t at = 0; (at = name.find(L'&', at)) != std::wstring::npos; at += 2) name.insert(at, 1, L'&');
    AppendMenuW(menu, MF_STRING | MF_DISABLED, 0, name.c_str());
    HMENU appearance = CreatePopupMenu();
    if (appearance) {
      AppendMenuW(appearance, MF_STRING | (appearance_ == L"follow" ? MF_CHECKED : 0), 4, L"跟随 AIChat 宠物");
      AppendMenuW(appearance, MF_STRING | (appearance_ == L"dragon" ? MF_CHECKED : 0), 5, L"抱抱龙");
      AppendMenuW(appearance, MF_SEPARATOR, 0, nullptr);
      AppendMenuW(appearance, MF_STRING, 6, L"在哈奇星球更换宠物…");
      if (!AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(appearance), L"外观")) DestroyMenu(appearance);
      AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    }
    AppendMenuW(menu, MF_STRING, 1, L"打开聊天");
    AppendMenuW(menu, MF_STRING, 2, L"隐藏桌面宠物");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, 3, L"完全退出");
    SetMenuDefaultItem(menu, 1, FALSE);
    POINT point{}; GetCursorPos(&point);
    SetForegroundWindow(window_);
    const auto selected = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
      point.x, point.y, window_, nullptr);
    DestroyMenu(menu);
    PostMessageW(window_, WM_NULL, 0, 0);
    if (selected == 2) SetEnabled(false);
    else if (selected == 4 || selected == 5) SetAppearance(selected == 5 ? L"dragon" : L"follow");
    else if (selected == 6) ShellExecuteW(window_, L"open",
      L"https://keepwork.com/api/raw/official/apps/MagicHaqi/release/MagicHaqi_v1.html", nullptr, nullptr, SW_SHOWNORMAL);
    else {
      const auto action = selected == 1 ? open_ : selected == 3 ? quit_ : std::function<void()>{};
      if (action) action();
    }
  }
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto self = reinterpret_cast<DesktopPet*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      self = static_cast<DesktopPet*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
      self->window_ = window;
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (!self) return DefWindowProcW(window, message, w, l);
    switch (message) {
      case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
      case WM_ERASEBKGND: return 1;
      case WM_LBUTTONDOWN: {
        self->CancelClick();
        self->CancelDrag();
        POINT point{}; if (!GetCursorPos(&point)) return 0;
        self->drag_start_ = point; self->drag_origin_ = {self->x_, self->y_};
        self->drag_.Begin(point.x, point.y);
        SetCapture(window);
        // A NOACTIVATE background window only receives captured mouse events
        // over its visible area. Poll solely during this explicit press to
        // keep a quick drag/release outside the sprite from getting stuck.
        if (self->drag_.active() && !SetTimer(window, drag_timer, 16, nullptr)) self->CancelDrag();
        return 0;
      }
      case WM_MOUSEMOVE:
        if (self->drag_.active() && GetCapture() == window) {
          POINT point{};
          if (!GetCursorPos(&point)) { self->CancelDrag(); return 0; }
          if (self->drag_.Move(point.x, point.y)) { self->CancelClick(); self->MovePet(point); }
        }
        return 0;
      case WM_LBUTTONUP: {
        POINT point{};
        if (!GetCursorPos(&point)) { self->CancelDrag(); return 0; }
        self->FinishDrag(point);
        return 0;
      }
      case WM_LBUTTONDBLCLK: {
        self->CancelClick();
        self->CancelDrag();
        const auto open = self->open_; if (open) open();
        return 0;
      }
      case WM_CAPTURECHANGED:
        self->StopTracking();
        if (self->drag_.active() && self->drag_.moved()) self->SavePosition();
        self->drag_.Cancel(); return 0;
      case WM_CANCELMODE: self->CancelDrag(); break;
      case WM_TIMER:
        if (w == drag_timer) { self->TrackPointer(); return 0; }
        if (w == click_timer) { self->SingleClick(); return 0; }
        break;
      case WM_CONTEXTMENU: self->CancelClick(); self->CancelDrag(); self->Menu(); return 0;
      case WM_DISPLAYCHANGE:
      case WM_SETTINGCHANGE:
      case WM_DPICHANGED:
        if (self->visible() && !self->painting_) self->Show();
        return 0;
      case WM_CLOSE: self->SetEnabled(false); return 0;
      case WM_NCDESTROY:
        self->CancelClick();
        self->StopTracking();
        self->window_ = nullptr;
        self->drag_.Cancel();
        SetWindowLongPtrW(window, GWLP_USERDATA, 0); break;
    }
    return DefWindowProcW(window, message, w, l);
  }
};
}
