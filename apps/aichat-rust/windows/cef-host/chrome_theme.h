#pragma once
#include <string>
#include "navigation_policy.h"

namespace keepwork_cef {
struct ChromeColor {
  int red, green, blue;
  bool operator==(const ChromeColor& other) const {
    return red == other.red && green == other.green && blue == other.blue;
  }
  static bool Parse(const std::string& value, ChromeColor& out) {
    if (value.size() != 7 || value[0] != '#') return false;
    int rgb[3]{};
    for (int i = 0; i < 3; ++i) {
      const int high = Hex(value[1 + i * 2]), low = Hex(value[2 + i * 2]);
      if (high < 0 || low < 0) return false;
      rgb[i] = high * 16 + low;
    }
    out = {rgb[0], rgb[1], rgb[2]};
    return true;
  }
};
struct ChromeTheme {
  ChromeColor background{242, 243, 247}, text{26, 26, 46}, hover{226, 230, 239};
  bool operator==(const ChromeTheme& other) const {
    return background == other.background && text == other.text && hover == other.hover;
  }
  static bool Parse(const std::string& background, const std::string& text,
                    const std::string& hover, ChromeTheme& out) {
    ChromeTheme next;
    if (!ChromeColor::Parse(background, next.background) ||
        !ChromeColor::Parse(text, next.text) || !ChromeColor::Parse(hover, next.hover)) return false;
    out = next;
    return true;
  }
};
inline bool TrustedThemeFrame(const Url& url, bool popup, bool main_frame) {
  return !popup && main_frame && Https(url) && url.host == "keepwork.com";
}
}
