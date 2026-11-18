#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>

namespace keepwork_cef {
enum class FrameHit { client, caption, left, right, top, bottom, top_left, top_right, bottom_left, bottom_right };
struct FrameRect {
  int left = 0, top = 0, right = 0, bottom = 0;
  int Width() const {
    return static_cast<int>(std::clamp<std::int64_t>(std::int64_t(right) - left, 0, (std::numeric_limits<int>::max)()));
  }
  int Height() const {
    return static_cast<int>(std::clamp<std::int64_t>(std::int64_t(bottom) - top, 0, (std::numeric_limits<int>::max)()));
  }
  bool Empty() const { return right <= left || bottom <= top; }
  bool Contains(int x, int y) const {
    return !Empty() && x >= left && x < right && y >= top && y < bottom;
  }
};
struct CenterLayout { FrameRect title, address, refresh; };

struct FrameLayout {
  int width, height, dpi;
  bool maximized;
  bool fullscreen = false;
  int Scale(int value) const {
    if (value <= 0) return 0;
    const int effective = std::clamp(dpi > 0 ? dpi : 96, 48, 768);
    return static_cast<int>(std::clamp<std::int64_t>((std::int64_t(value) * effective + 48) / 96,
      1, (std::numeric_limits<int>::max)()));
  }
  int Border() const { return maximized || fullscreen ? 0 : Scale(6); }
  int TitleHeight() const { return fullscreen ? 0 : Scale(34); }
  int ButtonWidth() const { return Scale(46); }
  int MenuLeft() const { return Scale(32); }
  int MenuWidth() const { return Scale(44); }
  FrameRect MenuBounds(int index) const {
    if (fullscreen || index < 0 || index >= 4 || width <= 0 || height <= 0) return {};
    // Round shared DIP edges once, rather than accumulating rounded widths.
    return {Scale(32 + index * 44), Border(), Scale(32 + (index + 1) * 44), std::min(height, TitleHeight())};
  }
  FrameRect ControlBounds(int index) const {
    if (fullscreen || index < 0 || index >= 3 || width <= 0 || height <= 0) return {};
    const int right = width - Border();
    return {right - Scale((3 - index) * 46), Border(),
      right - Scale((2 - index) * 46), std::min(height, TitleHeight())};
  }
  FrameRect IconBounds() const {
    if (fullscreen || width <= 0 || height <= 0) return {};
    const int pixels = Scale(18), top = (TitleHeight() - pixels) / 2;
    return {Scale(10), std::max(Border(), top), Scale(10) + pixels,
      std::min({height, TitleHeight(), top + pixels})};
  }
  CenterLayout CenterBounds() const {
    if (fullscreen || width <= 0 || height <= 0) return {};
    const int left = MenuBounds(3).right + Scale(12);
    const int right = ControlBounds(0).left - Scale(12);
    if (right <= left) return {};
    const int available = right - left;
    const bool title = width >= Scale(850);
    struct Group { CenterLayout layout; int width = 0; };
    const auto make = [&](bool address, bool refresh) {
      Group group;
      int offset = 0;
      const auto item = [&](FrameRect& rect, int dip_width, int dip_height) {
        if (offset) offset += 8;
        const int pixels = Scale(dip_height), top = (TitleHeight() - pixels) / 2;
        rect = {Scale(offset), std::max(Border(), top), Scale(offset + dip_width),
          std::min({height, TitleHeight(), top + pixels})};
        offset += dip_width;
      };
      if (title) item(group.layout.title, 132, 24);
      if (address) item(group.layout.address, 144, 24);
      if (refresh) item(group.layout.refresh, 28, 28);
      group.width = Scale(offset);
      return group;
    };
    auto group = make(true, true);
    if (group.width > available && !group.layout.address.Empty()) {
      const int shrink = std::min(group.width - available,
        std::max(0, group.layout.address.Width() - Scale(72)));
      group.layout.address.right -= shrink;
      group.layout.refresh.left -= shrink;
      group.layout.refresh.right -= shrink;
      group.width -= shrink;
    }
    if (group.width > available) group = make(false, true);
    if (group.width > available) group = make(false, false);
    if (group.width <= 0 || group.width > available) return {};
    const int start = std::clamp((width - group.width) / 2, left, right - group.width);
    for (auto rect : {&group.layout.title, &group.layout.address, &group.layout.refresh}) {
      if (!rect->Empty()) { rect->left += start; rect->right += start; }
    }
    return group.layout;
  }
  int MenuAt(int x, int y) const {
    for (int index = 0; index < 4; ++index) if (MenuBounds(index).Contains(x, y)) return index;
    return -1;
  }
  FrameHit Hit(int x, int y) const {
    if (fullscreen) return FrameHit::client;
    const int border = Border();
    const bool left = x < border, right = x >= width - border;
    const bool top = y < border, bottom = y >= height - border;
    if (top && left) return FrameHit::top_left;
    if (top && right) return FrameHit::top_right;
    if (bottom && left) return FrameHit::bottom_left;
    if (bottom && right) return FrameHit::bottom_right;
    if (left) return FrameHit::left;
    if (right) return FrameHit::right;
    if (top) return FrameHit::top;
    if (bottom) return FrameHit::bottom;
    if (MenuAt(x, y) >= 0) return FrameHit::client;
    for (int index = 0; index < 3; ++index) if (ControlBounds(index).Contains(x, y)) return FrameHit::client;
    const auto center = CenterBounds();
    if (center.address.Contains(x, y) || center.refresh.Contains(x, y)) return FrameHit::client;
    if (y < TitleHeight()) return FrameHit::caption;
    return FrameHit::client;
  }
};
}
