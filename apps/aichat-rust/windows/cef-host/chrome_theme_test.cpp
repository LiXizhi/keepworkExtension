#include "chrome_theme.h"
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using keepwork_cef::ChromeColor;
using keepwork_cef::ChromeTheme;
using keepwork_cef::TrustedThemeFrame;
using keepwork_cef::Url;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Chrome theme failure: " << label << '\n'; std::exit(1); }
}

static void NormalizedRgbSupportsEveryChannelValue() {
  ChromeColor actual;
  Check(ChromeColor::Parse("#f2f3f7", actual) && actual == ChromeColor{242, 243, 247},
    "the light titlebar palette retains its exact RGB channels");
  Check(ChromeColor::Parse("#D4d4Dc", actual) && actual == ChromeColor{212, 212, 220},
    "normalized CSS hex is independent of hexadecimal letter casing");
  for (int channel = 0; channel <= 255; ++channel) {
    std::ostringstream value;
    value << '#' << std::hex << std::setfill('0')
      << std::setw(2) << channel << "80" << std::setw(2) << 255 - channel;
    Check(ChromeColor::Parse(value.str(), actual) && actual == ChromeColor{channel, 128, 255 - channel},
      "all unsigned byte values survive the renderer/native color boundary");
  }
}

static void UnnormalizedOrMalformedColorsAreRejected() {
  std::vector<std::string> invalid = {
    "", "#fff", "#ffff", "#ffffff00", "#00000", "#0000000", "ffffff", "0xffffff",
    "#gg0000", "#00000g", "#12/456", "#-12345", "#12345 ", " #123456", "#123456\n",
    "rgb(255,255,255)", "rgba(0,0,0,1)", "transparent", "var(--bg-sidebar)",
    "color-mix(in srgb,black,white)", std::string(4096, 'a'),
    std::string("#123456\0", 8), std::string("#12\0abc", 7),
  };
  for (const auto& input : invalid) {
    ChromeColor actual{17, 34, 51};
    Check(!ChromeColor::Parse(input, actual),
      "the native boundary accepts only a fully normalized six-digit RGB value");
  }
}

static void PaletteUpdatesAreAtomicAndKeepCustomSkinColors() {
  ChromeTheme light;
  Check(light.background == ChromeColor{242, 243, 247}
      && light.text == ChromeColor{26, 26, 46} && light.hover == ChromeColor{226, 230, 239},
    "the unreported page starts with readable light chrome");
  ChromeTheme current = light;
  Check(ChromeTheme::Parse("#18181f", "#d4d4dc", "#282834", current),
    "an explicitly sampled dark page can update all chrome colors");
  Check(current.background == ChromeColor{24, 24, 31}
      && current.text == ChromeColor{212, 212, 220} && current.hover == ChromeColor{40, 40, 52},
    "dark page colors are preserved rather than replaced with OS appearance");
  const ChromeTheme dark = current;
  for (int bad = 0; bad < 3; ++bad) {
    std::string colors[] = {"#123456", "#abcdef", "#FEDCBA"};
    colors[bad] = "#12345g";
    Check(!ChromeTheme::Parse(colors[0], colors[1], colors[2], current),
      "one invalid native color rejects the whole renderer report");
    Check(current == dark, "a rejected report cannot partially repaint an existing palette");
  }
  Check(ChromeTheme::Parse("#123456", "#abcdef", "#fedcba", current),
    "custom skins can supply any valid normalized RGB colors");
  const ChromeTheme custom = current;
  Check(ChromeTheme::Parse("#123456", "#ABCDEF", "#FEDCBA", current) && current == custom,
    "equivalent repeated reports compare equal for repaint deduplication");
  Check(ChromeTheme::Parse("#123456", "#abcdef", "#001122", current) && !(current == custom),
    "hover-only skin changes count as a real palette update");
  Check(ChromeTheme::Parse("#f2f3f7", "#1a1a2e", "#e2e6ef", current) && current == light,
    "returning from a dark or custom page restores the sampled light palette");
}

static void ThemeMessagesBelongToTheTrustedMainPage() {
  Url page{"https", "keepwork.com", "", "/chat", "", false};
  Check(TrustedThemeFrame(page, false, true), "the ordinary Keepwork main page can report colors");
  page.port = "443";
  page.path = "/chat/previous-client";
  Check(TrustedThemeFrame(page, false, true), "same-origin page paths preserve older-client compatibility");
  for (bool popup : {false, true}) for (bool main : {false, true}) {
    Check(TrustedThemeFrame(page, popup, main) == (!popup && main),
      "neither Keepwork login popups nor same-origin child frames control main-window chrome");
  }
  for (const auto* host : {"cdn.keepwork.com", "accounts.google.com", "localhost", "127.0.0.1",
                          "keepwork.com.evil.test", "evilkeepwork.com", ""}) {
    page.host = host;
    Check(!TrustedThemeFrame(page, false, true), "foreign, CDN, provider, and loopback pages cannot report theme");
  }
  page.host = "keepwork.com";
  for (const auto* scheme : {"http", "file", "data", "javascript", ""}) {
    page.scheme = scheme;
    Check(!TrustedThemeFrame(page, false, true), "theme IPC requires the expected HTTPS origin");
  }
  page.scheme = "https";
  page.credentials = true;
  Check(!TrustedThemeFrame(page, false, true), "credentialed origin input is rejected");
  page.credentials = false;
  page.port = "8443";
  Check(!TrustedThemeFrame(page, false, true), "a different Keepwork port is a different origin");
}

int main() {
  NormalizedRgbSupportsEveryChannelValue();
  UnnormalizedOrMalformedColorsAreRejected();
  PaletteUpdatesAreAtomicAndKeepCustomSkinColors();
  ThemeMessagesBelongToTheTrustedMainPage();
  std::cout << "Chrome theme passed\n";
}
