#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>
#include "chrome_theme.h"

namespace keepwork_cef {
inline int PopupScale(int value, int dpi) {
  if (value <= 0) return 0;
  dpi = std::clamp(dpi > 0 ? dpi : 96, 48, 768);
  return static_cast<int>(std::min<std::int64_t>((std::int64_t(value) * dpi + 48) / 96,
    (std::numeric_limits<int>::max)()));
}
struct PopupMetrics { int width, height; };
inline PopupMetrics MeasurePopupRow(int label_pixels, int shortcut_pixels, int font_height,
                                   int dpi, int max_width, bool separator = false, bool reserve_checks = false) {
  using I = std::int64_t;
  const I label = std::max(0, label_pixels), shortcut = std::max(0, shortcut_pixels);
  const I natural = PopupScale(reserve_checks ? 28 : 12, dpi) + label + (shortcut ? PopupScale(24, dpi) + shortcut : 0) + PopupScale(12, dpi);
  const I cap = max_width > 0 ? max_width : PopupScale(640, dpi);
  const I width = std::min(cap, std::max<I>(PopupScale(200, dpi), natural));
  const I height = separator ? PopupScale(8, dpi) :
    std::max<I>(PopupScale(28, dpi), I(std::max(0, font_height)) + PopupScale(12, dpi));
  return {static_cast<int>(std::min<I>(width, (std::numeric_limits<int>::max)())),
    static_cast<int>(std::min<I>(height, (std::numeric_limits<int>::max)()))};
}
struct PopupColumns {
  int check_left, check_right, label_left, label_right, shortcut_left, shortcut_right;
};
inline PopupColumns LayoutPopupColumns(int row_width, int shortcut_pixels, int dpi, bool reserve_checks = false) {
  const int width = std::max(0, row_width);
  const int check_left = reserve_checks ? std::min(width, PopupScale(8, dpi)) : 0;
  const int check_right = reserve_checks ? std::min(width, PopupScale(20, dpi)) : 0;
  const int label_left = std::min(width, PopupScale(reserve_checks ? 28 : 12, dpi));
  const int right = std::max(label_left, width - std::min(width, PopupScale(12, dpi)));
  if (shortcut_pixels <= 0) return {check_left, check_right, label_left, right, right, right};
  const int shortcut_left = static_cast<int>(std::max<std::int64_t>(label_left, std::int64_t(right) - shortcut_pixels));
  const int label_right = std::max(label_left, shortcut_left - PopupScale(24, dpi));
  return {check_left, check_right, label_left, label_right, shortcut_left, right};
}
inline ChromeColor PopupBlend(const ChromeColor& foreground, const ChromeColor& background, int percent) {
  percent = std::clamp(percent, 0, 100);
  const auto channel = [percent](int foreground_channel, int background_channel) {
    return (std::clamp(foreground_channel, 0, 255) * percent +
      std::clamp(background_channel, 0, 255) * (100 - percent) + 50) / 100;
  };
  return {channel(foreground.red, background.red), channel(foreground.green, background.green),
    channel(foreground.blue, background.blue)};
}
inline ChromeColor PopupSelectionBackground(const ChromeTheme& theme) {
  const auto distance = [](int first, int second) {
    const int delta = std::clamp(first, 0, 255) - std::clamp(second, 0, 255);
    return delta < 0 ? -delta : delta;
  };
  const int difference = distance(theme.hover.red, theme.background.red) +
    distance(theme.hover.green, theme.background.green) + distance(theme.hover.blue, theme.background.blue);
  if (difference >= 24) return theme.hover;
  const auto blended = PopupBlend(theme.text, theme.background, 14);
  if (distance(blended.red, theme.background.red) + distance(blended.green, theme.background.green) +
      distance(blended.blue, theme.background.blue) >= 24) return blended;
  const int brightness = (std::clamp(theme.background.red, 0, 255) +
    std::clamp(theme.background.green, 0, 255) + std::clamp(theme.background.blue, 0, 255)) / 3;
  const ChromeColor contrast = brightness < 128 ? ChromeColor{255, 255, 255} : ChromeColor{0, 0, 0};
  return PopupBlend(contrast, theme.background, 14);
}
}
