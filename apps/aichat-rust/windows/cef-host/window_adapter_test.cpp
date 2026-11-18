#if !defined(_WIN32)
#error This fixture exercises real Win32 owner drawing and must run on Windows.
#endif

#include "window_frame.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <vector>

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Window adapter failure: " << label << '\n'; std::exit(1); }
}

class DibSurface {
 public:
  DibSurface(int width, int height) : width_(width), height_(height) {
    Check(width > 0 && height > 0 && width < 8192 && height < 8192, "test drawing has bounded positive dimensions");
    dc_ = CreateCompatibleDC(nullptr);
    Check(dc_ != nullptr, "a real memory drawing context is available");
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    bitmap_ = CreateDIBSection(dc_, &info, DIB_RGB_COLORS, &pixels_, nullptr, 0);
    Check(bitmap_ && pixels_, "the actual owner draw uses a readable 32-bit DIB");
    previous_ = SelectObject(dc_, bitmap_);
    Check(previous_ && previous_ != HGDI_ERROR, "the test bitmap is selected into its DC");
  }
  ~DibSurface() {
    if (dc_ && previous_) SelectObject(dc_, previous_);
    if (bitmap_) DeleteObject(bitmap_);
    if (dc_) DeleteDC(dc_);
  }
  HDC dc() const { return dc_; }
  RECT bounds() const { return {0, 0, width_, height_}; }
  void Clear() { std::memset(pixels_, 0, static_cast<size_t>(width_) * height_ * 4); }
  std::vector<unsigned char> Pixels() const {
    Check(GdiFlush() != FALSE, "owner-draw GDI calls finish before pixels are read");
    const auto bytes = static_cast<const unsigned char*>(pixels_);
    return {bytes, bytes + static_cast<size_t>(width_) * height_ * 4};
  }
 private:
  HDC dc_ = nullptr;
  HBITMAP bitmap_ = nullptr;
  HGDIOBJ previous_ = nullptr;
  void* pixels_ = nullptr;
  int width_, height_;
};

static std::vector<unsigned char> DrawRealButton(HWND parent, HWND child, UINT state) {
  RECT rect{};
  Check(child && GetClientRect(child, &rect), "the fixture uses an actual WindowFrame child BUTTON");
  DibSurface surface(rect.right, rect.bottom);
  surface.Clear();
  DRAWITEMSTRUCT item{};
  item.CtlType = ODT_BUTTON;
  item.CtlID = static_cast<UINT>(GetDlgCtrlID(child));
  item.itemAction = ODA_DRAWENTIRE;
  item.itemState = state;
  item.hwndItem = child;
  item.hDC = surface.dc();
  item.rcItem = surface.bounds();
  Check(SendMessageW(parent, WM_DRAWITEM, item.CtlID, reinterpret_cast<LPARAM>(&item)) == TRUE,
    "the real WindowFrame WM_DRAWITEM adapter handles the BUTTON");
  const auto pixels = surface.Pixels();
  Check(GetPixel(surface.dc(), 0, 0) == RGB(242, 243, 247),
    "the adapter actually painted the current default light background");
  return pixels;
}

static void StaleButtonFocusDoesNotLeakThroughTheNativeDrawingAdapter() {
  keepwork_cef::WindowFrame frame;
  Check(frame.Create(), "an isolated hidden native frame can be created without CEF");
  Check(!IsWindowVisible(frame.window()), "the fixture never displays or activates its top-level window");
  HWND help = GetDlgItem(frame.window(), 103);
  const auto unfocused_help = DrawRealButton(frame.window(), help, 0);
  const auto stale_focused_help = DrawRealButton(frame.window(), help, ODS_FOCUS);
  Check(unfocused_help == stale_focused_help,
    "native Help ODS_FOCUS cannot add the stale dashed outline from the reported regression");
  HWND address = GetDlgItem(frame.window(), 200);
  const auto unfocused_address = DrawRealButton(frame.window(), address, 0);
  const auto focused_address = DrawRealButton(frame.window(), address, ODS_FOCUS);
  const auto hidden_focus_address = DrawRealButton(frame.window(), address, ODS_FOCUS | ODS_NOFOCUSRECT);
  Check(unfocused_address != focused_address,
    "the menu fix must not remove actual keyboard focus drawing from non-menu controls");
  Check(unfocused_address == hidden_focus_address,
    "the real adapter preserves ODS_NOFOCUSRECT for ordinary controls");
  frame.Destroy();
}

struct PopupRowImage {
  std::vector<unsigned char> pixels;
  COLORREF corner, center;
  int height, width;
};

static MENUITEMINFOW NativeRow(const keepwork_cef::ThemedPopup& popup, UINT position) {
  MENUITEMINFOW item{};
  item.cbSize = sizeof(item);
  item.fMask = MIIM_DATA | MIIM_STATE | MIIM_FTYPE | MIIM_ID;
  Check(GetMenuItemInfoW(popup.menu(), position, TRUE, &item) != FALSE && item.dwItemData != 0,
    "owner-drawn rows retain their actual native item data and flags");
  return item;
}

static PopupRowImage DrawRealPopup(const keepwork_cef::ThemedPopup& popup, UINT position, UINT state) {
  const auto row = NativeRow(popup, position);
  MEASUREITEMSTRUCT measure{};
  measure.CtlType = ODT_MENU;
  measure.itemID = row.wID;
  measure.itemData = row.dwItemData;
  Check(popup.Measure(measure), "the actual popup measures the row identified by native item data");
  DibSurface surface(static_cast<int>(measure.itemWidth), static_cast<int>(measure.itemHeight));
  surface.Clear();
  DRAWITEMSTRUCT item{};
  item.CtlType = ODT_MENU;
  item.itemID = row.wID;
  item.itemAction = ODA_DRAWENTIRE;
  item.itemState = state;
  item.hwndItem = reinterpret_cast<HWND>(popup.menu());
  item.hDC = surface.dc();
  item.rcItem = surface.bounds();
  item.itemData = row.dwItemData;
  Check(popup.Draw(item), "the production popup draws into a real GDI DIB");
  const auto pixels = surface.Pixels();
  return {pixels, GetPixel(surface.dc(), 0, 0),
    GetPixel(surface.dc(), static_cast<int>(measure.itemWidth / 2), static_cast<int>(measure.itemHeight / 2)),
    static_cast<int>(measure.itemHeight), static_cast<int>(measure.itemWidth)};
}

static COLORREF NativeColor(const keepwork_cef::ChromeColor& color) {
  return RGB(color.red, color.green, color.blue);
}

static COLORREF PixelColor(const std::vector<unsigned char>& pixels, int width, int x, int y) {
  const auto index = (static_cast<size_t>(y) * width + x) * 4;
  return RGB(pixels[index + 2], pixels[index + 1], pixels[index]);
}

static bool IsInk(COLORREF pixel, COLORREF foreground, COLORREF background) {
  const int dr = int(GetRValue(foreground)) - GetRValue(background);
  const int dg = int(GetGValue(foreground)) - GetGValue(background);
  const int db = int(GetBValue(foreground)) - GetBValue(background);
  const int contrast = dr * dr + dg * dg + db * db;
  const int coverage = (int(GetRValue(pixel)) - GetRValue(background)) * dr
    + (int(GetGValue(pixel)) - GetGValue(background)) * dg
    + (int(GetBValue(pixel)) - GetBValue(background)) * db;
  // GDI+ strokes at 16 DIP can cover only part of a physical pixel. A 20%
  // foreground projection counts that antialiased stroke without accepting
  // an unchanged background or depending on a fully opaque center pixel.
  return contrast > 0 && coverage * 5 >= contrast;
}

static bool HasInk(const std::vector<unsigned char>& pixels, int width, int height, RECT area,
                   COLORREF ink, COLORREF background) {
  for (int y = std::max(0L, area.top); y < std::min<LONG>(height, area.bottom); ++y)
    for (int x = std::max(0L, area.left); x < std::min<LONG>(width, area.right); ++x)
      if (IsInk(PixelColor(pixels, width, x, y), ink, background)) return true;
  return false;
}

static int LeadingLabelInk(const PopupRowImage& image, COLORREF foreground, COLORREF background) {
  for (int x = 0; x < image.width / 2; ++x)
    for (int y = 0; y < image.height; ++y)
      if (IsInk(PixelColor(image.pixels, image.width, x, y), foreground, background)) return x;
  return -1;
}

static void OrdinaryPopupPaddingReachesTheRealTextRenderer() {
  using namespace keepwork_cef;
  ChromeTheme dark, skin;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", dark), "dark popup padding colors are valid");
  Check(ChromeTheme::Parse("#102030", "#eeddcc", "#445566", skin), "custom popup padding colors are valid");
  for (const int dpi : {96, 97, 120, 144, 192}) for (const auto theme : {ChromeTheme{}, dark, skin}) {
    ThemedPopup plain(theme, dpi, static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT)));
    plain.Item(1100, L"M\tM");
    Check(plain.valid(), "ordinary popup with no checkmarks allocates native resources");
    MENUINFO info{}; info.cbSize = sizeof(info); info.fMask = MIM_STYLE;
    Check(GetMenuInfo(plain.menu(), &info) && (info.dwStyle & MNS_NOCHECK),
      "native menu metadata does not reserve a second OS checkmark gutter");
    const auto ordinary = DrawRealPopup(plain, 0, 0);
    const auto selected = DrawRealPopup(plain, 0, ODS_SELECTED);
    const int padding = PopupScale(12, dpi);
    const auto foreground = NativeColor(theme.text), background = NativeColor(theme.background);
    const int first = LeadingLabelInk(ordinary, foreground, background);
    Check(first >= padding && first <= padding + PopupScale(4, dpi),
      "ordinary native popup text begins at 12 DIP padding rather than an empty check gutter");
    Check(!HasInk(ordinary.pixels, ordinary.width, ordinary.height,
        {0, 0, padding, ordinary.height}, foreground, background)
        && !HasInk(ordinary.pixels, ordinary.width, ordinary.height,
          {ordinary.width - padding, 0, ordinary.width, ordinary.height}, foreground, background),
      "ordinary label and shortcut preserve equal empty outer padding in the actual GDI surface");
    Check(LeadingLabelInk(selected, foreground, NativeColor(PopupSelectionBackground(theme))) == first,
      "selection changes the surface without shifting label placement");
    ThemedPopup checked(theme, dpi, static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT)));
    checked.Item(1100, L"M\tM");
    checked.Item(1101, L"M\tM", true, true);
    Check(checked.valid(), "mixed checked menu allocates native resources");
    const auto unchecked_in_mixed_menu = DrawRealPopup(checked, 0, 0);
    Check(LeadingLabelInk(unchecked_in_mixed_menu, foreground, background) - first
        == PopupScale(28, dpi) - padding,
      "one checked row reserves exactly one aligned label gutter for every row in the same popup");
    const auto checked_row = DrawRealPopup(checked, 1, 0);
    Check(HasInk(checked_row.pixels, checked_row.width, checked_row.height,
      {PopupScale(6, dpi), 0, PopupScale(24, dpi), checked_row.height}, foreground, background),
      "reserved checkmark gutter contains the actual checked-state glyph");
  }
}

static void RefreshUsesTheReferenceVectorAtEveryDpiAndTheme() {
  using namespace keepwork_cef;
  WindowFrame frame;
  Check(frame.Create(), "refresh drawing uses an isolated hidden production frame");
  ChromeTheme dark, skin;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", dark), "dark refresh colors are valid");
  Check(ChromeTheme::Parse("#102030", "#eeddcc", "#445566", skin), "custom refresh colors are valid");
  for (const int dpi : {96, 97, 120, 144, 192}) {
    RECT suggested{};
    Check(GetWindowRect(frame.window(), &suggested) != FALSE, "hidden frame has a real DPI-change rectangle");
    SendMessageW(frame.window(), WM_DPICHANGED, MAKEWPARAM(dpi, dpi), reinterpret_cast<LPARAM>(&suggested));
    const HWND refresh = GetDlgItem(frame.window(), 201);
    RECT bounds{};
    Check(refresh && GetClientRect(refresh, &bounds) && bounds.right > 0 && bounds.bottom > 0,
      "refresh remains a real bounded BUTTON after DPI changes");
    const int width = bounds.right, height = bounds.bottom;
    const int cx = width / 2, cy = height / 2;
    const int icon = (16 * dpi + 48) / 96;
    const int tolerance = std::max(1, icon / 16);
    for (const auto theme : {ChromeTheme{}, dark, skin}) {
      frame.SetTheme(theme);
      for (const UINT state : {UINT(0), UINT(ODS_SELECTED)}) {
        for (const int direction : {AD_COUNTERCLOCKWISE, AD_CLOCKWISE}) {
          DibSurface surface(width, height);
          surface.Clear();
          Check(SetArcDirection(surface.dc(), direction) != 0, "fixture explicitly sets initial GDI arc direction");
          DRAWITEMSTRUCT item{};
          item.CtlType = ODT_BUTTON; item.CtlID = 201; item.itemAction = ODA_DRAWENTIRE;
          item.itemState = state | ODS_NOFOCUSRECT;
          item.hwndItem = refresh; item.hDC = surface.dc(); item.rcItem = surface.bounds();
          Check(SendMessageW(frame.window(), WM_DRAWITEM, 201, reinterpret_cast<LPARAM>(&item)) == TRUE,
            "production refresh owner-draw adapter paints the fixture DIB");
          Check(GetArcDirection(surface.dc()) == direction, "GDI+ refresh does not change the caller's GDI arc direction");
          const auto pixels = surface.Pixels();
          const COLORREF ink = NativeColor(theme.text);
          const COLORREF background = NativeColor(state ? theme.hover : theme.background);
          Check(HasInk(pixels, width, height, {cx - icon / 2, cy - icon / 8, cx - icon / 4 + 1, cy + icon / 8 + 1}, ink, background),
            "refresh long arc reaches the left side instead of only the old short upper-right segment");
          Check(HasInk(pixels, width, height, {cx - icon / 8, cy - icon / 2, cx + icon / 8 + 1, cy - icon / 4 + 1}, ink, background),
            "refresh long arc reaches the top side at each DPI and theme");
          Check(HasInk(pixels, width, height, {cx - icon / 8, cy + icon / 4, cx + icon / 8 + 1, cy + icon / 2 + 1}, ink, background),
            "refresh long arc reaches the bottom side at each DPI and theme");
          // Sample inside the arm, beyond the Polyline terminal pixel which
          // GDI may exclude; allow one scaled pixel for integer rounding.
          const int head_x = cx + (5 * icon + 12) / 24, head_y = cy - (icon + 4) / 8;
          Check(HasInk(pixels, width, height, {head_x - tolerance, head_y - tolerance,
            head_x + tolerance + 1, head_y + tolerance + 1}, ink, background),
            "the SVG arrow's inner horizontal arm remains visible independently of the ring");
          Check(HasInk(pixels, width, height, {cx + 3 * icon / 8 - tolerance, cy - icon / 4 - tolerance,
            cx + 3 * icon / 8 + tolerance + 1, cy - icon / 4 + tolerance + 1}, ink, background),
            "the SVG arrow's outer vertical arm is visible rather than clipped");
          for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x)
            if (IsInk(PixelColor(pixels, width, x, y), ink, background))
              Check(x > 0 && x < width - 1 && y > 0 && y < height - 1,
                "refresh stroke never touches or escapes its button clipping edge");
          Check(PixelColor(pixels, width, cx, 1) == NativeColor(state ? theme.hover : theme.background),
            "pressed refresh changes the themed background while preserving the glyph color");
        }
      }
    }
  }
  Check(!IsWindowVisible(frame.window()), "DPI and drawing verification never shows or activates the frame");
  frame.Destroy();
}

static void BrandPreservesBothLegsAndFractionalEdgesAtEveryDpi() {
  using namespace keepwork_cef;
  WindowFrame frame;
  Check(frame.Create(), "brand drawing retains the production frame's GDI+ lifetime");
  ChromeTheme dark, skin;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", dark), "dark brand colors are valid");
  Check(ChromeTheme::Parse("#102030", "#eeddcc", "#445566", skin), "custom brand colors are valid");
  for (const int dpi : {96, 97, 120, 144, 192}) for (const bool maximized : {false, true}) {
    const FrameLayout layout{(900 * dpi + 48) / 96, (600 * dpi + 48) / 96, dpi, maximized};
    const auto icon = layout.IconBounds();
    Check(!icon.Empty(), "the actual frame layout reserves an icon at every tested DPI and window state");
    const RECT bounds{icon.left, icon.top, icon.right, icon.bottom};
    const int width = icon.right + layout.Scale(8), height = layout.TitleHeight() + layout.Scale(8);
    const auto region = [&](float left, float top, float right, float bottom) {
      return RECT{
        static_cast<LONG>(std::floor(icon.left + left * icon.Width() / 18.f)),
        static_cast<LONG>(std::floor(icon.top + top * icon.Height() / 18.f)),
        static_cast<LONG>(std::ceil(icon.left + right * icon.Width() / 18.f)),
        static_cast<LONG>(std::ceil(icon.top + bottom * icon.Height() / 18.f))};
    };
    for (const auto theme : {ChromeTheme{}, dark, skin}) {
      DibSurface surface(width, height);
      const auto background = NativeColor(theme.background);
      const auto ink = RGB((theme.text.red * 72 + theme.background.red * 28 + 50) / 100,
        (theme.text.green * 72 + theme.background.green * 28 + 50) / 100,
        (theme.text.blue * 72 + theme.background.blue * 28 + 50) / 100);
      HBRUSH brush = CreateSolidBrush(background);
      RECT canvas = surface.bounds();
      FillRect(surface.dc(), &canvas, brush);
      DeleteObject(brush);
      const auto old_pen = GetCurrentObject(surface.dc(), OBJ_PEN);
      const auto old_brush = GetCurrentObject(surface.dc(), OBJ_BRUSH);
      const auto old_font = GetCurrentObject(surface.dc(), OBJ_FONT);
      const auto old_background_mode = GetBkMode(surface.dc());
      const auto old_text_color = GetTextColor(surface.dc());
      BrandGlyph::Draw(surface.dc(), bounds, ink);
      Check(GetCurrentObject(surface.dc(), OBJ_PEN) == old_pen
          && GetCurrentObject(surface.dc(), OBJ_BRUSH) == old_brush
          && GetCurrentObject(surface.dc(), OBJ_FONT) == old_font
          && GetBkMode(surface.dc()) == old_background_mode && GetTextColor(surface.dc()) == old_text_color,
        "brand drawing preserves caller-owned GDI objects and text state");
      const auto pixels = surface.Pixels();
      Check(HasInk(pixels, width, height, region(3.5f, 3.f, 6.5f, 5.f), ink, background)
          && HasInk(pixels, width, height, region(3.5f, 13.f, 6.5f, 15.f), ink, background),
        "the K stem reaches both SVG end caps without clipping");
      Check(HasInk(pixels, width, height, region(11.f, 3.f, 14.5f, 5.f), ink, background),
        "the upper diagonal reaches its full right-hand end cap");
      Check(HasInk(pixels, width, height, region(11.f, 13.f, 14.5f, 15.f), ink, background),
        "the lower diagonal reaches its full right-hand end cap");
      Check(HasInk(pixels, width, height, region(6.f, 8.f, 9.f, 10.f), ink, background),
        "both diagonals remain connected through the K waist");
      bool fractional_edge = false;
      for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const auto pixel = PixelColor(pixels, width, x, y);
        if (IsInk(pixel, ink, background))
          Check(x > icon.left && x < icon.right - 1 && y > icon.top && y < icon.bottom - 1,
            "the complete brand contour stays inside the actual frame icon bounds");
        if (IsInk(pixel, ink, background) && pixel != ink) fractional_edge = true;
      }
      Check(fractional_edge,
        "small K contours retain antialiased fractional coverage rather than integer-rounded polygon edges");
    }
  }
  Check(!IsWindowVisible(frame.window()), "brand verification never shows or activates the native frame");
  frame.Destroy();
}

static LRESULT CALLBACK ObserveToolbarClicks(HWND window, UINT message, WPARAM w, LPARAM l,
                                            UINT_PTR, DWORD_PTR reference) {
  if (message == WM_COMMAND && HIWORD(w) == BN_CLICKED && l)
    reinterpret_cast<std::vector<int>*>(reference)->push_back(LOWORD(w));
  return DefSubclassProc(window, message, w, l);
}

static void RefreshClickAndEnterRetainTheirNativeButtonIdentity() {
  keepwork_cef::WindowFrame frame;
  Check(frame.Create(), "button notification fixture owns a private hidden frame without Attach side effects");
  std::vector<int> clicked;
  Check(SetWindowSubclass(frame.window(), ObserveToolbarClicks, 91, reinterpret_cast<DWORD_PTR>(&clicked)) != FALSE,
    "fixture observes real parent BUTTON notifications without replacing production handling");
  const HWND refresh = GetDlgItem(frame.window(), 201), address = GetDlgItem(frame.window(), 200);
  Check(refresh && address, "the existing refresh and address controls retain their IDs");
  SendMessageW(refresh, BM_CLICK, 0, 0);
  Check(clicked == std::vector<int>{201}, "one real refresh click emits one notification for the existing reload control");
  SendMessageW(refresh, WM_KEYDOWN, VK_RETURN, 0);
  Check(clicked == std::vector<int>({201, 201}), "first Enter keydown emits one refresh click");
  SendMessageW(refresh, WM_KEYDOWN, VK_RETURN, LPARAM(1) << 30);
  SendMessageW(refresh, WM_KEYUP, VK_RETURN, 0);
  Check(clicked == std::vector<int>({201, 201}), "Enter autorepeat and keyup cannot emit a second refresh click");
  SendMessageW(address, BM_CLICK, 0, 0);
  Check(clicked == std::vector<int>({201, 201, 200}), "address button preserves its separate open-entry control identity");
  Check(!IsWindowVisible(frame.window()), "button notification verification leaves the frame hidden");
  RemoveWindowSubclass(frame.window(), ObserveToolbarClicks, 91);
  frame.Destroy();
}

static void ThemeAndNativeMenuStateReachTheActualGdiRenderer() {
  using namespace keepwork_cef;
  const ChromeTheme light;
  ChromeTheme dark, skin;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", dark), "dark test colors are valid");
  Check(ChromeTheme::Parse("#102030", "#eeddcc", "#445566", skin), "custom test colors are valid");
  for (const auto theme : {light, dark, skin}) {
    ThemedPopup popup(theme, 96, static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT)));
    Check(popup.valid(), "a native themed menu can allocate its synchronous drawing resources");
    popup.Item(1000, L"&Zoom\tCtrl++");
    popup.Item(1001, L"&Zoom\tCtrl++", false);
    popup.Separator();
    popup.Item(1003, L"&Zoom\tCtrl++", true, true);
    Check(popup.valid() && GetMenuItemCount(popup.menu()) == 4, "all requested native rows were inserted");
    Check(NativeRow(popup, 0).wID == 1000 && (NativeRow(popup, 1).fState & MFS_DISABLED)
        && (NativeRow(popup, 2).fType & MFT_SEPARATOR) && (NativeRow(popup, 3).fState & MFS_CHECKED),
      "owner drawing preserves command, disabled, separator and checked semantics in HMENU metadata");
    const auto ordinary = DrawRealPopup(popup, 0, 0);
    const auto selected = DrawRealPopup(popup, 0, ODS_SELECTED);
    const auto keyboard = DrawRealPopup(popup, 0, ODS_SELECTED | ODS_FOCUS);
    Check(ordinary.corner == NativeColor(theme.background)
        && selected.corner == NativeColor(PopupSelectionBackground(theme)),
      "ordinary and selected popup surfaces use actual light/dark/custom theme colors");
    Check(selected.pixels == keyboard.pixels,
      "mouse and keyboard selection share one theme cue without an extra focus rectangle");
    const auto disabled = DrawRealPopup(popup, 1, ODS_SELECTED | ODS_DISABLED);
    Check(disabled.corner == NativeColor(theme.background) && disabled.pixels != ordinary.pixels,
      "disabled rows have subdued text and cannot acquire the selected background");
    const auto checked_flag = DrawRealPopup(popup, 0, ODS_CHECKED);
    const auto checked_metadata = DrawRealPopup(popup, 3, 0);
    Check(checked_flag.pixels != ordinary.pixels && checked_metadata.pixels == checked_flag.pixels,
      "native checked flags and menu metadata render the same visible checkmark");
    const auto separator = DrawRealPopup(popup, 2, 0);
    const auto selected_separator = DrawRealPopup(popup, 2, ODS_SELECTED | ODS_FOCUS);
    Check(separator.height == PopupScale(8, 96) && separator.height < ordinary.height
        && separator.pixels == selected_separator.pixels
        && separator.center == NativeColor(PopupBlend(theme.text, theme.background, 22)),
      "separators keep their compact themed rule and never become selected rows");
  }
}

static void MenuNotificationsCannotBeMiscastAsButtonDrawing() {
  using namespace keepwork_cef;
  WindowFrame frame;
  Check(frame.Create(), "the dispatch fixture owns another private hidden frame");
  ThemedPopup popup(ChromeTheme{}, 96, static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT)));
  popup.Item(1000, L"Zoom\tCtrl++");
  Check(popup.valid(), "a foreign popup row exists for type dispatch validation");
  const auto row = NativeRow(popup, 0);
  DibSurface surface(200, 28);
  surface.Clear();
  DRAWITEMSTRUCT draw{};
  draw.CtlType = ODT_MENU;
  draw.itemID = 1000;
  draw.hwndItem = reinterpret_cast<HWND>(popup.menu());
  draw.hDC = surface.dc();
  draw.rcItem = surface.bounds();
  draw.itemData = row.dwItemData;
  Check(SendMessageW(frame.window(), WM_DRAWITEM, 0, reinterpret_cast<LPARAM>(&draw)) != TRUE,
    "an inactive foreign menu cannot enter the native BUTTON paint path");
  const auto pixels = surface.Pixels();
  Check(std::all_of(pixels.begin(), pixels.end(), [](unsigned char value) { return value == 0; }),
    "unowned ODT_MENU drawing cannot paint a caption glyph over another menu's surface");
  draw.CtlType = ODT_BUTTON;
  Check(!popup.Draw(draw), "the popup renderer independently rejects BUTTON notifications");
  frame.Destroy();
}

int main() {
  StaleButtonFocusDoesNotLeakThroughTheNativeDrawingAdapter();
  ThemeAndNativeMenuStateReachTheActualGdiRenderer();
  MenuNotificationsCannotBeMiscastAsButtonDrawing();
  OrdinaryPopupPaddingReachesTheRealTextRenderer();
  RefreshUsesTheReferenceVectorAtEveryDpiAndTheme();
  BrandPreservesBothLegsAndFractionalEdgesAtEveryDpi();
  RefreshClickAndEnterRetainTheirNativeButtonIdentity();
  std::cout << "Window adapter passed\n";
}
