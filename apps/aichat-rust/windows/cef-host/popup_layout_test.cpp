#include "popup_layout.h"
#include <climits>
#include <cstdlib>
#include <iostream>

using namespace keepwork_cef;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Popup layout failure: " << label << '\n'; std::exit(1); }
}

static void ColumnsStaySeparate(const PopupColumns& columns, int width) {
  Check(0 <= columns.check_left && columns.check_left <= columns.check_right
      && columns.check_right <= columns.label_left && columns.label_left <= columns.label_right
      && columns.label_right <= columns.shortcut_left && columns.shortcut_left <= columns.shortcut_right
      && columns.shortcut_right <= width,
    "checkmark, label and shortcut columns remain ordered and inside the native row");
}

static void LabelsAndShortcutsHaveIndependentSpace() {
  const auto columns = LayoutPopupColumns(400, 80, 96);
  Check(columns.check_left == 0 && columns.check_right == 0 && columns.label_left == 12,
    "ordinary menus do not reserve an empty checkmark gutter before their text");
  Check(columns.shortcut_right == 388 && columns.shortcut_left == 308 && columns.label_right == 284,
    "right-aligned shortcuts keep their complete width and a 24 DIP gap from labels");
  const auto short_row = LayoutPopupColumns(200, 80, 96);
  Check(short_row.shortcut_right - short_row.shortcut_left == 80 && short_row.label_right == 84,
    "shortening a row ellipsizes its label before reducing an ordinary shortcut");
  const auto no_shortcut = LayoutPopupColumns(200, 0, 96);
  Check(no_shortcut.label_left == 12 && no_shortcut.label_right == 188
      && no_shortcut.shortcut_left == no_shortcut.shortcut_right,
    "rows without shortcuts return the unused column space to their labels");
  const auto checked = LayoutPopupColumns(400, 80, 96, true);
  Check(checked.check_left == 8 && checked.check_right == 20 && checked.label_left == 28
      && checked.shortcut_right == columns.shortcut_right && checked.label_right == columns.label_right,
    "menus containing a checkmark reserve one gutter while preserving the right shortcut margin");
  for (int dpi : {96, 97, 120, 144, 192}) {
    for (int width : {0, 1, 10, 28, 60, 100, 200, 400}) {
      for (int shortcut : {-1, 0, 40, INT_MAX}) for (const bool reserve_checks : {false, true})
        ColumnsStaySeparate(LayoutPopupColumns(width, shortcut, dpi, reserve_checks), width);
    }
    const int width = PopupScale(400, dpi), padding = PopupScale(12, dpi);
    const auto plain = LayoutPopupColumns(width, 0, dpi);
    Check(plain.label_left == padding && width - plain.label_right == padding,
      "unchecked popup label space has symmetric 12 DIP padding at each monitor DPI");
    const auto shortcut = LayoutPopupColumns(width, PopupScale(80, dpi), dpi);
    Check(shortcut.label_left == padding && width - shortcut.shortcut_right == padding,
      "left label and right shortcut edges share equal padding in ordinary menus");
    const auto checked_menu = LayoutPopupColumns(width, PopupScale(80, dpi), dpi, true);
    Check(checked_menu.label_left == PopupScale(28, dpi)
        && checked_menu.shortcut_right == shortcut.shortcut_right,
      "the checkable menu gutter changes only the leading text edge");
  }
  ColumnsStaySeparate(LayoutPopupColumns(INT_MIN, INT_MAX, INT_MAX), 0);
  ColumnsStaySeparate(LayoutPopupColumns(INT_MAX, INT_MAX, INT_MAX), INT_MAX);
}

static void RowMeasurementsRespectDpiFontAndScreenCaps() {
  const auto ordinary = MeasurePopupRow(80, 40, 16, 96, 1920);
  Check(ordinary.width == 200 && ordinary.height == 28,
    "ordinary menu rows have a readable 200 by 28 DIP minimum");
  const auto long_row = MeasurePopupRow(260, 60, 20, 96, 1920);
  Check(long_row.width == 368 && long_row.height == 32,
    "ordinary natural width includes symmetric padding, separate shortcuts and tall-font vertical space");
  const auto checked_row = MeasurePopupRow(260, 60, 20, 96, 1920, false, true);
  Check(checked_row.width == 384 && checked_row.height == long_row.height,
    "checkmark gutter expands natural width only when the menu actually needs it");
  const auto capped = MeasurePopupRow(2000, 200, 16, 96, 320);
  Check(capped.width == 320 && capped.height == 28, "long names cannot expand beyond the current work area");
  const auto unavailable_screen = MeasurePopupRow(INT_MAX, INT_MAX, 16, 96, 0);
  Check(unavailable_screen.width == 640, "missing monitor width uses the bounded fallback rather than unbounded text size");
  const auto separator = MeasurePopupRow(0, 0, 100, 96, 1920, true);
  Check(separator.height == 8 && separator.height < ordinary.height,
    "separators remain compact even when an ordinary row needs a tall font");
  Check(MeasurePopupRow(-1, -1, -1, 96, 1920).height == 28,
    "invalid text metrics cannot collapse a clickable row");
  for (int dpi : {96, 97, 120, 144, 192}) {
    const auto row = MeasurePopupRow(PopupScale(80, dpi), PopupScale(40, dpi), PopupScale(16, dpi), dpi, PopupScale(1920, dpi));
    Check(row.width >= PopupScale(200, dpi) && row.width <= PopupScale(1920, dpi)
        && row.height >= PopupScale(28, dpi), "DPI-scaled rows preserve bounded text and selection surfaces");
    Check(MeasurePopupRow(0, 0, 0, dpi, 100000, true).height == PopupScale(8, dpi),
      "separator measurement follows the same monitor DPI as ordinary rows");
  }
  Check(PopupScale(28, 0) == 28 && PopupScale(28, INT_MIN) == 28 && PopupScale(0, 96) == 0,
    "legacy missing DPI and shared zero edges have deterministic behavior");
  const auto extreme = MeasurePopupRow(INT_MAX, INT_MAX, INT_MAX, INT_MAX, INT_MAX);
  Check(extreme.width == INT_MAX && extreme.height == INT_MAX,
    "extreme native text/DPI metrics saturate without wrapping negative");
}

static void ThemeColorsPreserveReadableSelectionAcrossSkins() {
  const ChromeTheme light;
  ChromeTheme dark, skin;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", dark), "a dark theme is valid");
  Check(ChromeTheme::Parse("#102030", "#eeddcc", "#445566", skin), "a custom skin is valid");
  for (const auto theme : {light, dark, skin}) {
    Check(PopupSelectionBackground(theme) == theme.hover,
      "normal light, dark and custom selections use the same sampled hover palette");
    Check(!(PopupBlend(theme.text, theme.background, 45) == theme.text),
      "disabled text can be distinguished without substituting a fixed dark or light OS palette");
  }
  for (int value : {0, 64, 128, 255}) {
    const ChromeColor flat{value, value, value};
    const ChromeTheme indistinguishable{flat, flat, flat};
    Check(!(PopupSelectionBackground(indistinguishable) == flat),
      "a skin with identical hover/background/text still gets a visible keyboard selection surface");
  }
  const ChromeColor foreground{200, 100, 0}, background{0, 100, 200};
  Check(PopupBlend(foreground, background, 50) == ChromeColor{100, 100, 100},
    "disabled/separator blends retain predictable RGB values");
  Check(PopupBlend(foreground, background, -1) == background
      && PopupBlend(foreground, background, 101) == foreground,
    "out-of-range blend percentages cannot produce invalid native colors");
}

int main() {
  LabelsAndShortcutsHaveIndependentSpace();
  RowMeasurementsRespectDpiFontAndScreenCaps();
  ThemeColorsPreserveReadableSelectionAcrossSkins();
  std::cout << "Popup layout passed\n";
}
