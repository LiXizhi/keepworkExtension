#pragma once
#include <windows.h>
#include <algorithm>
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include "chrome_theme.h"
#include "popup_layout.h"

namespace keepwork_cef {
// TrackPopupMenuEx still owns keyboard navigation, placement and cancellation.
// This synchronous scope owns only the menu, its stable row data and GDI art.
class ThemedPopup {
 public:
  explicit ThemedPopup(const ChromeTheme& theme, int dpi, HFONT font)
      : theme_(theme), dpi_(dpi > 0 ? dpi : 96) {
    menu_ = CreatePopupMenu();
    background_ = CreateSolidBrush(Color(theme.background));
    selected_ = CreateSolidBrush(Color(PopupSelectionBackground(theme)));
    measure_dc_ = CreateCompatibleDC(nullptr);
    LOGFONTW definition{};
    if (font && GetObjectW(font, sizeof(definition), &definition) == sizeof(definition))
      owned_font_ = CreateFontIndirectW(&definition);
    font_ = owned_font_ ? owned_font_ : font ? font : static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    if (measure_dc_) previous_font_ = SelectObject(measure_dc_, font_);
    TEXTMETRICW metrics{};
    font_height_ = measure_dc_ && GetTextMetricsW(measure_dc_, &metrics) ? metrics.tmHeight : PopupScale(16, dpi_);
    POINT cursor{}; GetCursorPos(&cursor);
    const HWND foreground = GetForegroundWindow();
    const auto monitor = foreground ? MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) :
      MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
    MONITORINFO monitor_info{sizeof(monitor_info)};
    int max_height = 0;
    max_width_ = PopupScale(640, dpi_);
    if (GetMonitorInfoW(monitor, &monitor_info)) {
      max_width_ = static_cast<int>(std::clamp<std::int64_t>(
        std::int64_t(monitor_info.rcWork.right) - monitor_info.rcWork.left - PopupScale(16, dpi_),
        1, (std::numeric_limits<int>::max)()));
      max_height = static_cast<int>(std::clamp<std::int64_t>(
        std::int64_t(monitor_info.rcWork.bottom) - monitor_info.rcWork.top - PopupScale(16, dpi_),
        1, (std::numeric_limits<int>::max)()));
    }
    MENUINFO info{};
    info.cbSize = sizeof(info);
    info.fMask = MIM_BACKGROUND | MIM_STYLE;
    info.hbrBack = background_;
    // Owner-drawn rows paint their check gutter; do not reserve a second one.
    info.dwStyle = MNS_NOCHECK;
    if (max_height) { info.fMask |= MIM_MAXHEIGHT; info.cyMax = static_cast<UINT>(max_height); }
    valid_ = menu_ && background_ && selected_ && measure_dc_ && previous_font_ &&
      previous_font_ != HGDI_ERROR && SetMenuInfo(menu_, &info) != FALSE;
  }
  ~ThemedPopup() {
    // The native menu may reference every row and brush until it is destroyed.
    if (menu_) DestroyMenu(menu_);
    if (measure_dc_ && previous_font_ && previous_font_ != HGDI_ERROR) SelectObject(measure_dc_, previous_font_);
    if (measure_dc_) DeleteDC(measure_dc_);
    if (owned_font_) DeleteObject(owned_font_);
    if (selected_) DeleteObject(selected_);
    if (background_) DeleteObject(background_);
  }
  ThemedPopup(const ThemedPopup&) = delete;
  ThemedPopup& operator=(const ThemedPopup&) = delete;
  bool valid() const { return valid_; }
  HMENU menu() const { return menu_; }
  void Item(unsigned command, const wchar_t* label, bool enabled = true, bool checked = false) {
    reserve_checks_ = reserve_checks_ || checked;
    auto row = std::make_unique<Row>();
    row->command = command; row->enabled = enabled; row->checked = checked;
    row->raw = label ? label : L"";
    const auto tab = row->raw.find(L'\t');
    row->label = row->raw.substr(0, tab);
    if (tab != std::wstring::npos) row->shortcut = row->raw.substr(tab + 1);
    row->label_width = TextWidth(VisibleLabel(row->label));
    row->shortcut_width = TextWidth(row->shortcut);
    Insert(std::move(row));
  }
  void Separator() {
    auto row = std::make_unique<Row>();
    row->separator = true; row->enabled = false;
    Insert(std::move(row));
  }
  bool Measure(MEASUREITEMSTRUCT& item) const {
    if (item.CtlType != ODT_MENU) return false;
    const auto row = Find(item.itemData);
    if (!row) return false;
    const auto metrics = MeasurePopupRow(row->label_width, row->shortcut_width, font_height_, dpi_, max_width_, row->separator, reserve_checks_);
    item.itemWidth = static_cast<UINT>(metrics.width);
    item.itemHeight = static_cast<UINT>(metrics.height);
    return true;
  }
  bool Draw(const DRAWITEMSTRUCT& item) const {
    if (item.CtlType != ODT_MENU || reinterpret_cast<HMENU>(item.hwndItem) != menu_ || !item.hDC) return false;
    const auto row = Find(item.itemData);
    if (!row) return false;
    const int state = SaveDC(item.hDC);
    if (!state) return false;
    const bool enabled = row->enabled && !(item.itemState & (ODS_DISABLED | ODS_GRAYED));
    const bool selected = enabled && !row->separator && (item.itemState & ODS_SELECTED);
    FillRect(item.hDC, &item.rcItem, selected ? selected_ : background_);
    const auto surface = selected ? PopupSelectionBackground(theme_) : theme_.background;
    if (row->separator) {
      const auto line = PopupBlend(theme_.text, surface, 22);
      HPEN pen = CreatePen(PS_SOLID, std::max(1, PopupScale(1, dpi_)), Color(line));
      const auto previous = SelectObject(item.hDC, pen);
      const int middle = (item.rcItem.top + item.rcItem.bottom) / 2;
      MoveToEx(item.hDC, item.rcItem.left + PopupScale(12, dpi_), middle, nullptr);
      LineTo(item.hDC, item.rcItem.right - PopupScale(12, dpi_), middle);
      SelectObject(item.hDC, previous); if (pen) DeleteObject(pen);
    } else {
      SelectObject(item.hDC, font_);
      SetBkMode(item.hDC, TRANSPARENT);
      const auto text = enabled ? theme_.text : PopupBlend(theme_.text, surface, 45);
      SetTextColor(item.hDC, Color(text));
      const auto columns = LayoutPopupColumns(std::max(0L, item.rcItem.right - item.rcItem.left), row->shortcut_width, dpi_, reserve_checks_);
      RECT label{item.rcItem.left + columns.label_left, item.rcItem.top,
        item.rcItem.left + columns.label_right, item.rcItem.bottom};
      const UINT prefix = item.itemState & ODS_NOACCEL ? DT_HIDEPREFIX : 0;
      DrawTextW(item.hDC, row->label.c_str(), static_cast<int>(row->label.size()), &label,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | prefix);
      if (!row->shortcut.empty()) {
        RECT shortcut{item.rcItem.left + columns.shortcut_left, item.rcItem.top,
          item.rcItem.left + columns.shortcut_right, item.rcItem.bottom};
        DrawTextW(item.hDC, row->shortcut.c_str(), static_cast<int>(row->shortcut.size()), &shortcut,
          DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
      }
      if (row->checked || (item.itemState & ODS_CHECKED)) {
        HPEN pen = CreatePen(PS_SOLID, std::max(1, PopupScale(2, dpi_)), Color(text));
        const auto previous = SelectObject(item.hDC, pen);
        const int left = item.rcItem.left + columns.check_left;
        const int middle = (item.rcItem.top + item.rcItem.bottom) / 2;
        MoveToEx(item.hDC, left, middle, nullptr);
        LineTo(item.hDC, left + PopupScale(3, dpi_), middle + PopupScale(3, dpi_));
        LineTo(item.hDC, left + PopupScale(10, dpi_), middle - PopupScale(4, dpi_));
        SelectObject(item.hDC, previous); if (pen) DeleteObject(pen);
      }
    }
    // Selection fill is the keyboard cue; never paint the system's focus box.
    RestoreDC(item.hDC, state);
    return true;
  }

 private:
  struct Row {
    unsigned command = 0;
    std::wstring raw, label, shortcut;
    int label_width = 0, shortcut_width = 0;
    bool enabled = true, checked = false, separator = false;
  };
  ChromeTheme theme_;
  int dpi_, font_height_ = 0, max_width_ = 0;
  HMENU menu_ = nullptr;
  HBRUSH background_ = nullptr, selected_ = nullptr;
  HDC measure_dc_ = nullptr;
  HFONT font_ = nullptr, owned_font_ = nullptr;
  HGDIOBJ previous_font_ = nullptr;
  bool valid_ = false;
  bool reserve_checks_ = false;
  std::vector<std::unique_ptr<Row>> rows_;
  static COLORREF Color(const ChromeColor& value) {
    return RGB(std::clamp(value.red, 0, 255), std::clamp(value.green, 0, 255), std::clamp(value.blue, 0, 255));
  }
  static std::wstring VisibleLabel(const std::wstring& label) {
    std::wstring visible;
    for (size_t index = 0; index < label.size(); ++index) {
      if (label[index] == L'&') {
        if (index + 1 < label.size() && label[index + 1] == L'&') ++index;
        else continue;
      }
      visible.push_back(label[index]);
    }
    return visible;
  }
  int TextWidth(const std::wstring& text) const {
    SIZE size{};
    if (measure_dc_ && GetTextExtentPoint32W(measure_dc_, text.c_str(), static_cast<int>(text.size()), &size))
      return std::max(0L, size.cx);
    return static_cast<int>(std::min<size_t>(text.size(), 4096)) * PopupScale(16, dpi_);
  }
  const Row* Find(ULONG_PTR value) const {
    for (const auto& row : rows_) if (reinterpret_cast<ULONG_PTR>(row.get()) == value) return row.get();
    return nullptr;
  }
  void Insert(std::unique_ptr<Row> row) {
    if (!valid_) return;
    MENUITEMINFOW item{};
    item.cbSize = sizeof(item);
    item.fMask = MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_DATA;
    item.fType = MFT_OWNERDRAW | (row->separator ? MFT_SEPARATOR : 0);
    item.fState = (row->enabled ? MFS_ENABLED : MFS_DISABLED) | (row->checked ? MFS_CHECKED : MFS_UNCHECKED);
    item.wID = row->command;
    item.dwItemData = reinterpret_cast<ULONG_PTR>(row.get());
    if (!row->separator) {
      // Native accessibility and menu metadata retain the complete raw name,
      // including the shortcut. dwItemData separately stores the drawing row.
      item.fMask |= MIIM_STRING;
      item.dwTypeData = row->raw.data();
      item.cch = static_cast<UINT>(row->raw.size());
    }
    if (!InsertMenuItemW(menu_, static_cast<UINT>(rows_.size()), TRUE, &item)) { valid_ = false; return; }
    rows_.push_back(std::move(row));
  }
};
}
