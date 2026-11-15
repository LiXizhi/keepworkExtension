#pragma once
#include <functional>
#include <utility>
#include "include/cef_browser.h"
#include "include/wrapper/cef_helpers.h"

namespace keepwork_cef {
// CEF owns the system dialog and its browser parent on both CEF 109 and modern
// CEF. Only the explicitly selected directory is returned; no file grants or IO.
class FolderDialogCallback final : public CefRunFileDialogCallback {
 public:
  explicit FolderDialogCallback(std::function<void(const std::vector<CefString>&)> done)
      : done_(std::move(done)) {}
  void OnFileDialogDismissed(const std::vector<CefString>& paths) override {
    CEF_REQUIRE_UI_THREAD();
    auto done = std::move(done_);
    if (done) done(paths);
  }
 private:
  std::function<void(const std::vector<CefString>&)> done_;
  IMPLEMENT_REFCOUNTING(FolderDialogCallback);
};
}  // namespace keepwork_cef
