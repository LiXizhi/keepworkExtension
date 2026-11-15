#pragma once

namespace keepwork_cef {
struct ControlVisual {
  bool highlighted;
  bool focus_outline;
};
// Shared by the native menu loop and portable interaction tests. Switching is
// deferred until TrackPopupMenuEx returns so popup loops never nest.
class MenuTracking {
 public:
  int active() const { return active_; }
  ControlVisual Visual(int heading, bool pressed, bool hovered, bool native_focused, bool hide_focus) const {
    if (Valid(heading)) {
      // The focused BUTTON may still be the one that first opened the menu.
      // Only the live popup owns menu emphasis, for both mouse and keyboard.
      return {active_ >= 0 ? heading == active_ : pressed || hovered, false};
    }
    return {pressed || hovered, native_focused && !hide_focus};
  }
  bool Begin(int index, int x, int y) {
    if (active_ >= 0 || !Valid(index)) return false;
    active_ = index;
    next_ = -1;
    x_ = x; y_ = y;
    return true;
  }
  bool Hover(int index, int x, int y) {
    // Native menus can generate a mouse move without moving the pointer. Such
    // messages must not undo a keyboard switch to another heading.
    if (active_ < 0 || (x == x_ && y == y_)) return false;
    x_ = x; y_ = y;
    return Switch(index);
  }
  bool Switch(int index) {
    if (active_ < 0 || !Valid(index) || (index == active_ && next_ < 0)) return false;
    next_ = index;
    return true;
  }
  bool Step(int direction) { return active_ >= 0 && Switch((active_ + direction + 4) % 4); }
  bool Click(int index) {
    if (active_ < 0 || !Valid(index)) return false;
    next_ = index == active_ ? -1 : index;
    return true;
  }
  int Advance() {
    active_ = next_;
    next_ = -1;
    return active_;
  }
  void Close() { active_ = next_ = -1; }

 private:
  static bool Valid(int index) { return index >= 0 && index < 4; }
  int active_ = -1, next_ = -1;
  int x_ = 0, y_ = 0;
};
}
