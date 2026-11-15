#pragma once
#include <algorithm>
#include <cstdint>

namespace keepwork_cef {
struct PetWorkArea { int left, top, right, bottom; };
struct PetPlacement { int x, y, pixels; };
struct PetChatPlacement { int x, y, width, height; };

// Screen coordinates may be negative or span monitors. Keep all intermediate
// arithmetic wide, including tiny or unavailable work-area fallbacks.
inline PetChatPlacement PlacePetChat(const PetWorkArea& anchor, int width, int height,
                                     int gap, const PetWorkArea& area) {
  using I = std::int64_t;
  const I available_width = I(area.right) - area.left;
  const I available_height = I(area.bottom) - area.top;
  if (available_width <= 0 || available_height <= 0) return {area.left, area.top, 1, 1};
  const I w = std::clamp<I>(width, 1, available_width);
  const I h = std::clamp<I>(height, 1, available_height);
  const I spacing = std::max(0, gap);
  const I above = I(anchor.top) - spacing - h;
  const I top = above >= area.top ? above : I(anchor.bottom) + spacing;
  return {static_cast<int>(std::clamp<I>(I(anchor.right) - w, area.left, I(area.right) - w)),
    static_cast<int>(std::clamp<I>(top, area.top, I(area.bottom) - h)),
    static_cast<int>(w), static_cast<int>(h)};
}

inline int PetPixels(int dpi) {
  if (dpi <= 0) dpi = 96;
  dpi = std::clamp(dpi, 48, 768);
  return (112 * dpi + 48) / 96;
}

inline PetPlacement PlacePet(int x, int y, int pixels, const PetWorkArea& area) {
  using I = std::int64_t;
  const I width = I(area.right) - area.left, height = I(area.bottom) - area.top;
  if (width <= 0 || height <= 0) return {area.left, area.top, 1};
  const I size = std::min({std::max<I>(1, pixels), width, height, I(896)});
  return {static_cast<int>(std::clamp<I>(x, area.left, I(area.right) - size)),
    static_cast<int>(std::clamp<I>(y, area.top, I(area.bottom) - size)), static_cast<int>(size)};
}

class PetDragState {
 public:
  void Begin(int x, int y) { start_x_ = x; start_y_ = y; active_ = true; moved_ = false; }
  bool Move(int x, int y) {
    if (active_) moved_ = moved_ || PastThreshold(x, y);
    return active_ && moved_;
  }
  bool End(int x, int y) {
    if (!active_) return false;
    Move(x, y);
    const bool click = !moved_;
    active_ = false;
    return click;
  }
  void Cancel() { active_ = false; moved_ = false; }
  bool active() const { return active_; }
  bool moved() const { return moved_; }
 private:
  bool PastThreshold(int x, int y) const {
    const std::int64_t dx = std::int64_t(x) - start_x_, dy = std::int64_t(y) - start_y_;
    // Check large deltas before squaring, including wrapped/offscreen input.
    return dx > 4 || dx < -4 || dy > 4 || dy < -4 || dx * dx + dy * dy > 16;
  }
  int start_x_ = 0, start_y_ = 0;
  bool active_ = false, moved_ = false;
};
}
