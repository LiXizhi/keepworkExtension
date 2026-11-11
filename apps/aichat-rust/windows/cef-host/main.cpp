// This host deliberately exposes no native JavaScript bridge. Website features
// use normal browser capabilities; desktop files, PTY, pet and MCP supervision
// remain unavailable until their independent compatibility implementations land.
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_parser.h"
#include "include/cef_permission_handler.h"
#include "include/cef_sandbox_win.h"
#include "include/cef_version.h"
#include "include/wrapper/cef_helpers.h"

#include "navigation_policy.h"

#if !defined(CEF_USE_SANDBOX) && !defined(CEF_USE_BOOTSTRAP)
#error The Keepwork CEF host requires the Chromium process sandbox.
#endif

namespace {

constexpr char kEntry[] = "https://keepwork.com/chat";
constexpr wchar_t kTitle[] = L"Keepwork — 兼容模式";

struct Options {
  std::wstring profile;
  std::wstring ready_event;
  bool background = false;
};

void Error(const wchar_t* message) {
  MessageBoxW(nullptr, message, kTitle, MB_OK | MB_ICONERROR);
}

bool ReadOptions(Options& options) {
  int count = 0;
  wchar_t** args = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!args) return false;
  bool valid = true;
  for (int i = 1; i < count && valid; ++i) {
    const std::wstring arg(args[i]);
    if (arg == L"--background") {
      options.background = true;
      continue;
    }
    const auto read = [&](const std::wstring& name, std::wstring& value) {
      if (arg.compare(0, name.size() + 1, name + L"=") == 0) {
        value = arg.substr(name.size() + 1);
        return true;
      }
      if (arg == name) {
        if (i + 1 < count) value = args[++i];
        else valid = false;
        return true;
      }
      return false;
    };
    if (read(L"--profile", options.profile) ||
        read(L"--ready-event", options.ready_event)) continue;
    // The official M138+ bootstrap may add its module-selection argument.
    if (arg.compare(0, 9, L"--module=") == 0) continue;
    valid = false;
  }
  LocalFree(args);
  // Profiles are local drive paths; UNC and device paths are not accepted.
  const auto& profile = options.profile;
  valid = valid && profile.size() > 3 &&
          ((profile[0] >= L'A' && profile[0] <= L'Z') ||
           (profile[0] >= L'a' && profile[0] <= L'z')) &&
          profile[1] == L':' && (profile[2] == L'\\' || profile[2] == L'/');
  if (!options.ready_event.empty()) {
    valid = valid && options.ready_event.size() <= 200 &&
            options.ready_event.compare(0, 14, L"Local\\Keepwork") == 0;
  }
  if (!valid) return false;
  std::vector<wchar_t> normalized(32768);
  const DWORD length = GetFullPathNameW(profile.c_str(),
      static_cast<DWORD>(normalized.size()), normalized.data(), nullptr);
  if (!length || length >= normalized.size()) return false;
  options.profile.assign(normalized.data(), length);
  const int result = SHCreateDirectoryExW(nullptr, options.profile.c_str(), nullptr);
  return result == ERROR_SUCCESS || result == ERROR_ALREADY_EXISTS || result == ERROR_FILE_EXISTS;
}

keepwork_cef::Url Parse(const CefString& raw) {
  CefURLParts parts;
  if (!CefParseURL(raw, parts)) return {};
  return {CefString(&parts.scheme).ToString(), CefString(&parts.host).ToString(),
          CefString(&parts.port).ToString(), CefString(&parts.path).ToString(),
          CefString(&parts.query).ToString(),
          parts.username.length != 0 || parts.password.length != 0};
}

void OpenExternal(const CefString& raw) {
  if (!keepwork_cef::External(Parse(raw))) return;
  const auto url = raw.ToWString();
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

bool SignalReady(const std::wstring& name) {
  if (name.empty()) return true;  // Manual host smoke tests may omit the event.
  HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str());
  if (!event) return false;
  const bool result = SetEvent(event) != FALSE;
  CloseHandle(event);
  return result;
}

class Client final : public CefClient,
                     public CefLifeSpanHandler,
                     public CefRequestHandler,
                     public CefDisplayHandler,
                     public CefDownloadHandler,
                     public CefPermissionHandler,
                     public CefContextMenuHandler,
                     public CefLoadHandler {
 public:
  explicit Client(Options options) : options_(std::move(options)) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browsers_.push_back(browser);
    if (browser->IsPopup()) return;
    main_id_ = browser->GetIdentifier();
    const HWND window = browser->GetHost()->GetWindowHandle();
    SetWindowTextW(window, kTitle);
    // This host has no tray/pet. A background launch must remain discoverable.
    ShowWindow(window, options_.background ? SW_SHOWMINIMIZED : SW_SHOWNORMAL);
  }

  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
                     CefRefPtr<CefFrame> frame,
#if CEF_VERSION_MAJOR >= 138
                     int popup_id,
#endif
                     const CefString& target_url,
                     const CefString& target_frame_name,
                     CefLifeSpanHandler::WindowOpenDisposition target_disposition,
                     bool user_gesture,
                     const CefPopupFeatures& popup_features,
                     CefWindowInfo& window_info,
                     CefRefPtr<CefClient>& client,
                     CefBrowserSettings& settings,
                     CefRefPtr<CefDictionaryValue>& extra_info,
                     bool* no_javascript_access) override {
    CEF_REQUIRE_UI_THREAD();
    // Real login windows retain window.opener and use this same request context.
    // No renderer, including popups, receives privileged native JS functions.
    if (keepwork_cef::LoginPopup(Parse(target_url)) ||
        target_url == "about:blank" || target_url.empty()) {
      *no_javascript_access = false;
      return false;
    }
    if (user_gesture) OpenExternal(target_url);
    return true;
  }

  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request, bool user_gesture,
                      bool is_redirect) override {
    CEF_REQUIRE_UI_THREAD();
    const CefString url = request->GetURL();
    if (url == "about:blank" &&
        (startup_pending_ || browser->IsPopup() || !frame->IsMain())) return false;
    if (keepwork_cef::Navigation(Parse(url), browser->IsPopup(), frame->IsMain())) return false;
    if (frame->IsMain() && user_gesture && !is_redirect) OpenExternal(url);
    return true;
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
    CEF_REQUIRE_UI_THREAD();
    // Page-controlled titles must not hide the compatibility-mode distinction.
    const auto caption = browser->IsPopup()
        ? L"Keepwork — " + title.ToWString().substr(0, 120)
        : std::wstring(kTitle);
    SetWindowTextW(browser->GetHost()->GetWindowHandle(), caption.c_str());
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    const int closing_id = browser->GetIdentifier();
    browsers_.erase(std::remove_if(browsers_.begin(), browsers_.end(),
        [closing_id](const CefRefPtr<CefBrowser>& candidate) {
          return candidate->GetIdentifier() == closing_id;
        }), browsers_.end());
    if (closing_id == main_id_) {
      const auto popups = browsers_;
      for (const auto& popup : popups) popup->GetHost()->CloseBrowser(true);
    }
    if (browsers_.empty()) CefQuitMessageLoop();
  }

#if CEF_VERSION_MAJOR >= 138
  bool
#else
  void
#endif
  OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefDownloadItem> item, const CefString& name,
                   CefRefPtr<CefBeforeDownloadCallback> callback) override {
    CEF_REQUIRE_UI_THREAD();
    const auto origin = Parse(browser->GetMainFrame()->GetURL());
    if (!browser->IsPopup() && keepwork_cef::Https(origin) &&
        origin.host == "keepwork.com") {
      // A browser Save As dialog is explicit user consent; no silent native write.
      callback->Continue(CefString(), true);
    }
#if CEF_VERSION_MAJOR >= 138
    return true;
#endif
  }

  bool OnRequestMediaAccessPermission(CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame, const CefString& origin, uint32_t permissions,
      CefRefPtr<CefMediaAccessCallback> callback) override {
    callback->Cancel();
    return true;
  }

  bool OnShowPermissionPrompt(CefRefPtr<CefBrowser> browser, uint64_t prompt_id,
      const CefString& origin, uint32_t permissions,
      CefRefPtr<CefPermissionPromptCallback> callback) override {
    callback->Continue(CEF_PERMISSION_RESULT_DENY);
    return true;
  }

  void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame, CefRefPtr<CefContextMenuParams> params,
      CefRefPtr<CefMenuModel> model) override {
    model->Remove(MENU_ID_VIEW_SOURCE);
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                 int http_status_code) override {
    CEF_REQUIRE_UI_THREAD();
    if (!startup_pending_ || browser->IsPopup() || !frame->IsMain() ||
        frame->GetURL() != "about:blank") return;
    // A local page verifies the renderer/sandbox without depending on the
    // internet. A website outage must never mark a good runtime as broken.
    startup_pending_ = false;
    if (!SignalReady(options_.ready_event)) {
      error_ = 18;
      browser->GetHost()->CloseBrowser(true);
      return;
    }
    frame->LoadURL(kEntry);
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
      CefLoadHandler::ErrorCode code, const CefString& text, const CefString& failed_url) override {
    CEF_REQUIRE_UI_THREAD();
    if (code == ERR_ABORTED || !frame->IsMain() || browser->IsPopup()) return;
    if (startup_pending_) {
      error_ = 23;
      browser->GetHost()->CloseBrowser(true);
      return;
    }
    const std::wstring message = L"无法加载聊天页面。请检查网络后重试。\n错误码：" +
                                std::to_wstring(static_cast<int>(code));
    if (MessageBoxW(browser->GetHost()->GetWindowHandle(), message.c_str(), kTitle,
                    MB_RETRYCANCEL | MB_ICONWARNING) == IDRETRY) {
      frame->LoadURL(kEntry);
    }
  }

  int error() const { return error_; }

 private:
  Options options_;
  std::vector<CefRefPtr<CefBrowser>> browsers_;
  int main_id_ = -1;
  int error_ = 0;
  bool startup_pending_ = true;
  IMPLEMENT_REFCOUNTING(Client);
};

class App final : public CefApp, public CefBrowserProcessHandler {
 public:
  explicit App(CefRefPtr<Client> client) : client_(client) {}
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    CefWindowInfo window;
    window.SetAsPopup(nullptr, kTitle);
    window.bounds = CefRect(80, 80, 1360, 900);
#if CEF_VERSION_MAJOR >= 138
    window.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
#endif
    CefBrowserSettings settings;
    if (!CefBrowserHost::CreateBrowser(window, client_, "about:blank", settings, nullptr, nullptr)) {
      error_ = 22;
      Error(L"兼容浏览器窗口创建失败。请重新打开 Keepwork。");
      CefQuitMessageLoop();
    }
  }

  int error() const { return error_; }

 private:
  CefRefPtr<Client> client_;
  int error_ = 0;
  IMPLEMENT_REFCOUNTING(App);
};

int RunHost(HINSTANCE instance, void* sandbox_info) {
  if (!sandbox_info) {
    Error(L"兼容内核缺少进程沙箱，无法启动。请重新下载完整兼容组件。");
    return 20;
  }
  CefMainArgs args(instance);
  // Renderer/GPU processes must return here, before any profile, lock or UI work.
  const int child_result = CefExecuteProcess(args, nullptr, sandbox_info);
  if (child_result >= 0) return child_result;

  Options options;
  if (!ReadOptions(options)) {
    Error(L"兼容模式启动参数无效。请通过 Keepwork 启动器打开。");
    return 2;
  }
  // Shared with the outer launcher and every CEF major/profile. Upgrading the
  // browser must not create a second desktop alongside an already open one.
  HANDLE mutex = CreateMutexW(nullptr, FALSE, L"Local\\Keepwork.CEF.Desktop");
  if (!mutex) return 16;
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    CloseHandle(mutex);
    // Never acknowledge a newly downloaded candidate using another executable.
    // The launcher asks the user to close that instance and retry.
    return 17;
  }

  CefSettings settings;
  settings.no_sandbox = false;
  settings.command_line_args_disabled = true;
  settings.persist_session_cookies = true;
#if CEF_VERSION_MAJOR == 109
  settings.persist_user_preferences = true;
#endif
  CefString(&settings.root_cache_path) = options.profile;
  CefString(&settings.cache_path) = options.profile + L"\\Default";
  CefString(&settings.log_file) = options.profile + L"\\cef.log";
  settings.log_severity = LOGSEVERITY_ERROR;
  CefRefPtr<Client> client(new Client(options));
  CefRefPtr<App> app(new App(client));
  if (!CefInitialize(args, settings, app, sandbox_info)) {
    CloseHandle(mutex);
    return 21;
  }
  CefRunMessageLoop();
  const int result = app->error() ? app->error() : client->error();
  app = nullptr;
  client = nullptr;
  CefShutdown();
  CloseHandle(mutex);
  return result;
}

}  // namespace

#if CEF_VERSION_MAJOR >= 138
// The matching official Chromium-built bootstrap.exe is shipped as
// keepwork-cef.exe and loads this keepwork-cef.dll. It creates the sandbox
// broker with Chromium's toolchain; normal MSVC executables cannot do so.
CEF_BOOTSTRAP_EXPORT int RunWinMain(HINSTANCE instance, LPWSTR command_line,
    int show, void* sandbox_info
#if defined(KEEPWORK_CEF_BOOTSTRAP_VERSION_INFO)
    , cef_version_info_t* version_info
#endif
    ) {
  return RunHost(instance, sandbox_info);
}
#else
int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE previous,
                     LPWSTR command_line, int show) {
#if defined(ARCH_CPU_32_BITS)
  const int fiber = CefRunWinMainWithPreferredStackSize(wWinMain, instance, command_line, show);
  if (fiber >= 0) return fiber;
#endif
  CefEnableHighDPISupport();
  CefScopedSandboxInfo sandbox;
  return RunHost(instance, sandbox.sandbox_info());
}
#endif
