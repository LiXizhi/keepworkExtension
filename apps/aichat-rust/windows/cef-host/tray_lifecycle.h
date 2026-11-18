#pragma once

namespace keepwork_cef {
enum class CloseAction { hide, close_browser };

// A close request is not permission to destroy the browser. Only CEF's
// DoClose (after beforeunload accepts) commits the native close transition.
class TrayLifecycle {
 public:
  bool tray_available() const { return tray_available_; }
  bool hidden() const { return hidden_; }
  bool pet_visible() const { return pet_visible_; }
  bool browser_closing() const { return browser_closing_; }
  bool SetTrayAvailable(bool available) {
    tray_available_ = available;
    if (!available && hidden_) {
      hidden_ = false;
      pet_visible_ = false;
      return true;
    }
    return false;
  }
  bool Start(bool background) {
    pet_visible_ = false;
    hidden_ = background && tray_available_;
    return !hidden_;
  }
  void Show() { hidden_ = false; pet_visible_ = false; }
  void SetPetVisible(bool visible) { pet_visible_ = visible && hidden_ && !browser_closing_; }
  CloseAction Close() {
    if (tray_available_ && !browser_closing_) {
      hidden_ = true;
      return CloseAction::hide;
    }
    return CloseAction::close_browser;
  }
  void BrowserClosing() { browser_closing_ = true; hidden_ = false; pet_visible_ = false; }
  void Destroy() {
    tray_available_ = false;
    hidden_ = false;
    pet_visible_ = false;
    browser_closing_ = true;
  }
 private:
  bool tray_available_ = false;
  bool hidden_ = false;
  bool pet_visible_ = false;
  bool browser_closing_ = false;
};
}
