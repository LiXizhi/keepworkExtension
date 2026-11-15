// The trusted main chat document receives a bounded pet conversation transport.
// Microphone access requires native consent; directory selection returns only a
// user-chosen path. File IO and terminal APIs remain with the MCP service.
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
#include "include/cef_keyboard_handler.h"
#include "include/cef_parser.h"
#include "include/cef_permission_handler.h"
#include "include/cef_sandbox_win.h"
#include "include/cef_version.h"
#include "include/wrapper/cef_helpers.h"

#include "navigation_policy.h"
#include "window_frame.h"
#include "theme_script.h"
#include "pet_script.h"
#include "pet_transport.h"
#include "folder_dialog.h"
#include "folder_script.h"
#include "pet_chat_state.h"
#include "remote_voice_controller.h"
#include "include/cef_jsdialog_handler.h"
#include "maintenance_controller.h"
#include "include/cef_v8.h"
#include "include/cef_process_message.h"
#if CEF_VERSION_MAJOR == 109
#include "compatibility_script.h"
#endif

#if !defined(CEF_USE_SANDBOX) && !defined(CEF_USE_BOOTSTRAP)
#error The Keepwork CEF host requires the Chromium process sandbox.
#endif

namespace {

constexpr char kEntry[] = "https://keepwork.com/chat";
constexpr wchar_t kTitle[] = L"Keepwork";

struct Options {
  std::wstring profile;
  std::wstring ready_event;
  std::wstring launcher;
  bool background = false;
  bool maintenance = false;
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
    if (arg == L"--maintenance") { options.maintenance = true; continue; }
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
    if (read(L"--profile", options.profile) || read(L"--launcher", options.launcher) ||
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
  if (!options.launcher.empty()) {
    const auto& launcher = options.launcher;
    if (launcher.size() < 4 || launcher[1] != L':' || (launcher[2] != L'\\' && launcher[2] != L'/') ||
        !((launcher[0] >= L'A' && launcher[0] <= L'Z') || (launcher[0] >= L'a' && launcher[0] <= L'z'))) return false;
    const DWORD size = GetFullPathNameW(launcher.c_str(), static_cast<DWORD>(normalized.size()), normalized.data(), nullptr);
    if (!size || size >= normalized.size()) return false;
    options.launcher.assign(normalized.data(), size);
    const auto leaf = options.launcher.find_last_of(L"\\/");
    if (leaf == std::wstring::npos || _wcsicmp(options.launcher.c_str() + leaf + 1, L"Keepwork.exe") != 0) return false;
    const DWORD attributes = GetFileAttributesW(options.launcher.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_DIRECTORY) return false;
  }
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

constexpr char kThemeMessage[] = "keepwork.cef.chrome-theme.v1";
class ThemeReporter final : public CefV8Handler {
 public:
  bool Execute(const CefString&, CefRefPtr<CefV8Value>, const CefV8ValueList& arguments,
               CefRefPtr<CefV8Value>& retval, CefString&) override {
    CEF_REQUIRE_RENDERER_THREAD();
    retval = CefV8Value::CreateBool(false);
    if (arguments.size() != 3) return true;
    const auto context = CefV8Context::GetCurrentContext();
    if (!context) return true;
    const auto browser = context->GetBrowser();
    const auto frame = context->GetFrame();
    if (!browser || !frame || !keepwork_cef::TrustedThemeFrame(Parse(frame->GetURL()), browser->IsPopup(), frame->IsMain())) return true;
    std::string colors[3];
    for (int i = 0; i < 3; ++i) {
      if (!arguments[i]->IsString()) return true;
      const auto color = arguments[i]->GetStringValue();
      if (color.length() != 7) return true;
      colors[i] = color.ToString();
    }
    keepwork_cef::ChromeTheme theme;
    if (!keepwork_cef::ChromeTheme::Parse(colors[0], colors[1], colors[2], theme)) return true;
    const auto message = CefProcessMessage::Create(kThemeMessage);
    for (int i = 0; i < 3; ++i) message->GetArgumentList()->SetString(i, colors[i]);
    frame->SendProcessMessage(PID_BROWSER, message);
    retval = CefV8Value::CreateBool(true);
    return true;
  }
 private:
  IMPLEMENT_REFCOUNTING(ThemeReporter);
};

// Polyfills, theme observer and the restricted pet adapter precede page scripts.
class RendererApp final : public CefApp, public CefRenderProcessHandler {
 public:
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }
  void OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override {
    CEF_REQUIRE_RENDERER_THREAD();
    if (browser->IsPopup() || !frame->IsMain()) return;
    const auto url = Parse(frame->GetURL());
    if (!keepwork_cef::Https(url) || url.host != "keepwork.com") return;
#if CEF_VERSION_MAJOR == 109
    frame->ExecuteJavaScript(keepwork_cef::kPopoverScript, frame->GetURL(), 0);
#endif
    context->GetGlobal()->SetValue("__keepworkChromeColors",
      CefV8Value::CreateFunction("reportChromeColors", new ThemeReporter), V8_PROPERTY_ATTRIBUTE_DONTENUM);
    frame->ExecuteJavaScript(keepwork_cef::kChromeThemeScript, frame->GetURL(), 0);
    if (keepwork_cef::PetFrame(browser, frame)) {
      const auto previous = documents_.find(browser->GetIdentifier());
      if (previous != documents_.end()) previous->second->Dispose();
      auto document = CefRefPtr<keepwork_cef::PetRenderDocument>(new keepwork_cef::PetRenderDocument(context));
      documents_[browser->GetIdentifier()] = document;
      context->GetGlobal()->SetValue("__keepworkPetTransport",
        CefV8Value::CreateFunction("petTextTransport", document), V8_PROPERTY_ATTRIBUTE_DONTENUM);
      frame->ExecuteJavaScript(keepwork_cef::kPetArtworkScript, frame->GetURL(), 0);
      frame->ExecuteJavaScript(keepwork_cef::kPetBridgeScript, frame->GetURL(), 0);
      frame->ExecuteJavaScript(keepwork_cef::kFolderPickerScript, frame->GetURL(), 0);
    }
  }
  void OnContextReleased(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame>, CefRefPtr<CefV8Context> context) override {
    const auto entry = documents_.find(browser->GetIdentifier());
    if (entry != documents_.end() && entry->second->Same(context)) {
      entry->second->Dispose(); documents_.erase(entry);
    }
  }
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
      CefProcessId source, CefRefPtr<CefProcessMessage> message) override {
    if (message->GetName() != keepwork_cef::kPetConnect && message->GetName() != keepwork_cef::kPetCommand &&
        message->GetName() != keepwork_cef::kFolderPicked) return false;
    if (source != PID_BROWSER || !keepwork_cef::PetFrame(browser, frame)) return true;
    const auto entry = documents_.find(browser->GetIdentifier());
    if (entry != documents_.end()) entry->second->Receive(frame, message);
    return true;
  }
 private:
  std::map<int, CefRefPtr<keepwork_cef::PetRenderDocument>> documents_;
  IMPLEMENT_REFCOUNTING(RendererApp);
};

class Client final : public CefClient,
                     public CefLifeSpanHandler,
                     public CefRequestHandler,
                     public CefDisplayHandler,
                     public CefDownloadHandler,
                     public CefPermissionHandler,
                     public CefKeyboardHandler,
                     public CefContextMenuHandler,
                     public CefJSDialogHandler,
                     public CefLoadHandler {
 public:
  explicit Client(Options options) : options_(std::move(options)) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefPermissionHandler> GetPermissionHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefJSDialogHandler> GetJSDialogHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  bool OnBeforeUnloadDialog(CefRefPtr<CefBrowser> browser, const CefString& message,
      bool is_reload, CefRefPtr<CefJSDialogCallback> callback) override {
    CEF_REQUIRE_UI_THREAD();
    if (browser->GetIdentifier() != main_id_ || is_reload || !maintenance_.awaiting_close()) return false;
    auto detail = message.ToWString();
    if (detail.size() > 4096) detail.resize(4096);
    const auto text = L"网页有未完成的操作。仍要退出并安装更新吗？\n\n" + detail;
    const bool leave = MessageBoxW(window_frame_.window(), text.c_str(), L"Keepwork 更新",
      MB_YESNO | MB_DEFBUTTON2 | MB_ICONQUESTION) == IDYES;
    if (!leave) maintenance_.CancelInstall();
    callback->Continue(leave, CefString());
    return true;
  }

  keepwork_cef::WindowFrame& window_frame() { return window_frame_; }

  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
      CefProcessId source_process, CefRefPtr<CefProcessMessage> message) override {
    CEF_REQUIRE_UI_THREAD();
    if (message->GetName() == keepwork_cef::kPickFolder) {
      if (source_process != PID_RENDERER || browser->GetIdentifier() != main_id_ || !keepwork_cef::PetFrame(browser, frame)) return true;
      PickFolder(browser, frame, message); return true;
    }
    if (message->GetName() == keepwork_cef::kPetConnected || message->GetName() == keepwork_cef::kPetState ||
        message->GetName() == keepwork_cef::kPetResult || message->GetName() == keepwork_cef::kPetArtwork) {
      if (source_process != PID_RENDERER || browser->GetIdentifier() != main_id_ || !keepwork_cef::PetFrame(browser, frame)) return true;
      ReceivePet(message); return true;
    }
    if (message->GetName() != kThemeMessage) return false;
    if (source_process != PID_RENDERER || browser->GetIdentifier() != main_id_ || !frame ||
        !keepwork_cef::TrustedThemeFrame(Parse(frame->GetURL()), browser->IsPopup(), frame->IsMain())) return true;
    const auto values = message->GetArgumentList();
    if (values->GetSize() != 3) return true;
    for (int i = 0; i < 3; ++i) if (values->GetType(i) != VTYPE_STRING || values->GetString(i).length() != 7) return true;
    keepwork_cef::ChromeTheme theme;
    if (keepwork_cef::ChromeTheme::Parse(values->GetString(0).ToString(), values->GetString(1).ToString(), values->GetString(2).ToString(), theme))
      window_frame_.SetTheme(theme);
    return true;
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browsers_.push_back(browser);
    if (browser->IsPopup()) return;
    main_id_ = browser->GetIdentifier();
    remote_voice_.Initialize(options_.profile);
    window_frame_.EnableServiceLauncher(!options_.launcher.empty());
    window_frame_.EnableMaintenance(options_.maintenance && !options_.launcher.empty());
    window_frame_.Attach(browser->GetHost()->GetWindowHandle(),
      [browser] { return browser->GetHost()->TryCloseBrowser(); },
      [browser] { browser->GetHost()->SetFocus(true); },
      [browser] { browser->GetHost()->NotifyMoveOrResizeStarted(); },
      [this, browser](keepwork_cef::WindowCommand command) { RunCommand(browser, command); }, options_.background, options_.profile);
    window_frame_.SetupPetChat([this](keepwork_cef::PetChatAction action) { PetAction(action); },
      [this](std::wstring text) { pet_state_.Edit(text); UpdatePet(); }, [this] { PetTick(); },
      [this] { if (pet_state_.CancelUnsubmittedInput()) UpdatePet(); }, [this] { StopPetCapture(); });
    if (options_.maintenance && !options_.launcher.empty()) {
      maintenance_.Start(window_frame_.window(), options_.launcher, [this] { window_frame_.Quit(); },
        [this](const std::wstring& message) { window_frame_.NotifyUpdate(message); });
      window_frame_.SetupMaintenance([this] { maintenance_.Tick(); });
    }
    UpdatePet();
  }

  bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser, const CefKeyEvent& event,
                     CefEventHandle os_event, bool* is_keyboard_shortcut) override {
    if (browser->IsPopup() || event.type != KEYEVENT_RAWKEYDOWN) return false;
    const bool control = (event.modifiers & EVENTFLAG_CONTROL_DOWN) != 0;
    const bool shift = (event.modifiers & EVENTFLAG_SHIFT_DOWN) != 0;
    const bool alt = (event.modifiers & EVENTFLAG_ALT_DOWN) != 0;
    const int key = event.windows_key_code;
    if (alt && !control) {
      const int menu = key == 'F' ? 0 : key == 'E' ? 1 : key == 'V' ? 2 : key == 'H' ? 3 : -1;
      if (menu >= 0) { window_frame_.ShowMenu(menu); return true; }
    }
    if (!alt && !control && key == VK_F10) { window_frame_.ShowMenu(0); return true; }
    using Command = keepwork_cef::WindowCommand;
    if (!alt && (key == VK_F5 || (control && key == 'R'))) {
      RunCommand(browser, ((control && key == VK_F5) || shift) ? Command::reload_no_cache : Command::reload); return true;
    }
    if (!alt && key == VK_F11) { RunCommand(browser, Command::fullscreen); return true; }
    if (control && !alt) {
      if (key == VK_OEM_PLUS || key == VK_ADD) RunCommand(browser, Command::zoom_in);
      else if (key == VK_OEM_MINUS || key == VK_SUBTRACT) RunCommand(browser, Command::zoom_out);
      else if (key == '0' || key == VK_NUMPAD0) RunCommand(browser, Command::zoom_reset);
      else if (key == 'Q') RunCommand(browser, Command::quit);
      else return false;
      return true;
    }
    return false;
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
    // Popups never receive the pet adapter or other native JS functions.
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
    if (keepwork_cef::Navigation(Parse(url), browser->IsPopup(), frame->IsMain())) {
      if (browser->GetIdentifier() == main_id_ && frame->IsMain()) ResetPet();
      return false;
    }
    if (frame->IsMain() && user_gesture && !is_redirect) OpenExternal(url);
    return true;
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
    CEF_REQUIRE_UI_THREAD();
    // Keep the main title stable; only separate login popups use page titles.
    const auto caption = browser->IsPopup()
        ? L"Keepwork — " + title.ToWString().substr(0, 120)
        : std::wstring(kTitle);
    SetWindowTextW(browser->IsPopup() ? browser->GetHost()->GetWindowHandle()
      : window_frame_.window(), caption.c_str());
  }
  void OnAddressChange(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, const CefString&) override {
    if (browser->GetIdentifier() != main_id_ || !frame->IsMain()) return;
    if (!keepwork_cef::PetFrame(browser, frame)) ResetPet();
    else if (!browser->IsLoading() && pet_binding_.document().empty()) ConnectPet(frame);
  }
  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser, TerminationStatus
#if CEF_VERSION_MAJOR >= 138
      , int, const CefString&
#endif
      ) override {
    if (browser->GetIdentifier() == main_id_) ResetPet();
  }

  bool DoClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    if (!browser->IsPopup()) window_frame_.BrowserClosing();
    // CEF now posts WM_CLOSE to the native owner; beforeunload has accepted.
    return false;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    const int closing_id = browser->GetIdentifier();
    browsers_.erase(std::remove_if(browsers_.begin(), browsers_.end(),
        [closing_id](const CefRefPtr<CefBrowser>& candidate) {
          return candidate->GetIdentifier() == closing_id;
        }), browsers_.end());
    if (closing_id == main_id_) {
      remote_voice_.Shutdown();
      maintenance_.AcknowledgeClosed();
      maintenance_.Stop();
      ResetPet();
      // Parent teardown follows CEF's TryCloseBrowser protocol. Release any
      // remaining callbacks only when CEF finishes the browser close.
      window_frame_.Destroy();
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
    CEF_REQUIRE_UI_THREAD();
    static_assert(CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE == 1);
    if (browser->GetIdentifier() != main_id_ || !frame ||
        !keepwork_cef::TrustedMicrophoneRequest(Parse(origin), Parse(frame->GetURL()), browser->IsPopup(), frame->IsMain(), permissions)) {
      callback->Cancel(); return true;
    }
    const auto document = pet_binding_.document();
    const auto owner = pet_state_.snapshot().context;
    const HWND parent = window_frame_.pet_chat().visible() ? window_frame_.pet_chat().window() : window_frame_.window();
    const bool allow = MessageBoxW(parent,
      L"允许 https://keepwork.com 使用麦克风进行语音输入或通话吗？\n\n音频将按 AIChat 当前语音设置发送给语音服务。仅允许本次请求，可通过停止输入或结束通话关闭麦克风。",
      L"Keepwork · 麦克风权限", MB_YESNO | MB_DEFBUTTON2 | MB_ICONQUESTION) == IDYES;
    // The native prompt may pump navigation/account events. Revalidate before granting.
    if (allow && document == pet_binding_.document() && owner == pet_state_.snapshot().context &&
        keepwork_cef::PetFrame(browser, frame)) callback->Continue(permissions);
    else callback->Cancel();
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
    if (browser->GetIdentifier() == main_id_ && keepwork_cef::PetFrame(browser, frame)) ConnectPet(frame);
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
  void FolderPicked(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
      const std::string& document, const std::string& challenge, const CefString& request,
      const CefString& path, const CefString& error) {
    // A native dialog can outlive navigation, renderer replacement or shutdown.
    if (!browser->IsValid() || !frame || !frame->IsValid() || browser->GetIdentifier() != main_id_ || !keepwork_cef::PetFrame(browser, frame) ||
        !pet_binding_.Matches(document, challenge)) return;
    const auto value = CefDictionaryValue::Create();
    value->SetString("requestId", request);
    value->SetString("path", path);
    value->SetString("error", error);
    const auto result = CefValue::Create(); result->SetDictionary(value);
    const auto response = CefProcessMessage::Create(keepwork_cef::kFolderPicked);
    response->GetArgumentList()->SetString(0, document);
    response->GetArgumentList()->SetString(1, challenge);
    response->GetArgumentList()->SetString(2, CefWriteJSON(result, JSON_WRITER_DEFAULT));
    frame->SendProcessMessage(PID_RENDERER, response);
  }
  void PickFolder(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, CefRefPtr<CefProcessMessage> message) {
    const auto args = message->GetArgumentList();
    if (args->GetSize() != 3) return;
    for (int i = 0; i < 3; ++i)
      if (args->GetType(i) != VTYPE_STRING || args->GetString(i).empty() || args->GetString(i).length() > 64) return;
    const auto document = args->GetString(0).ToString(), challenge = args->GetString(1).ToString();
    const auto request = args->GetString(2);
    if (!pet_binding_.Matches(document, challenge)) return;
    if (folder_pending_) {
      FolderPicked(browser, frame, document, challenge, request, CefString(), L"文件夹选择器已打开，请先完成或取消选择。"); return;
    }
    folder_pending_ = true;
    CefRefPtr<Client> self(this);
    browser->GetHost()->RunFileDialog(FILE_DIALOG_OPEN_FOLDER, L"选择本地工作空间文件夹", CefString(), {},
      new keepwork_cef::FolderDialogCallback([self, browser, frame, document, challenge, request](const std::vector<CefString>& paths) {
        self->folder_pending_ = false;
        CefString path, error;
        if (paths.size() == 1) {
          const auto selected = paths.front().ToWString();
          const DWORD attributes = selected.empty() || selected.size() > 32768 ? INVALID_FILE_ATTRIBUTES : GetFileAttributesW(selected.c_str());
          if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY)) path = paths.front();
          else error = L"所选文件夹不可用，请重新选择。";
        }
        self->FolderPicked(browser, frame, document, challenge, request, path, error);
      }));
  }
  bool folder_pending_ = false;
  void ResetPet() {
    pet_binding_.Reset(keepwork_cef::PetToken());
    window_frame_.SetPetArtwork({}, {});
    pet_deadline_ = 0; pet_state_.ResetDocument(); UpdatePet();
  }
  void ConnectPet(CefRefPtr<CefFrame> frame) {
    if (!keepwork_cef::PetFrame(frame->GetBrowser(), frame)) return;
    if (pet_binding_.challenge().empty()) pet_binding_.Reset(keepwork_cef::PetToken());
    if (pet_binding_.challenge().empty()) return;
    const auto message = CefProcessMessage::Create(keepwork_cef::kPetConnect);
    message->GetArgumentList()->SetString(0, pet_binding_.challenge());
    frame->SendProcessMessage(PID_RENDERER, message);
    pet_deadline_ = GetTickCount64() + 15000; UpdatePet();
  }
  static bool PetString(CefRefPtr<CefDictionaryValue> object, const char* key, size_t limit, std::wstring& value) {
    if (!object->HasKey(key) || object->GetType(key) != VTYPE_STRING || object->GetString(key).length() > limit) return false;
    value = object->GetString(key).ToWString(); return true;
  }
  static bool ReadPetSnapshot(CefRefPtr<CefDictionaryValue> object, keepwork_cef::PetChatState::Snapshot& state) {
    if (!object->HasKey("version") || object->GetType("version") != VTYPE_INT || object->GetInt("version") != 1) return false;
    std::wstring context, target;
    if (!PetString(object, "context", 160, context) || context.empty() || !PetString(object, "target", 16, target) ||
        (target != L"persona" && target != L"chat") || !PetString(object, "title", 160, state.title) ||
        !PetString(object, "draft", 32000, state.draft) || !PetString(object, "reply", 8000, state.reply) ||
        !PetString(object, "attention", 2000, state.attention) || !PetString(object, "error", 2000, state.error)) return false;
    state.context = CefString(context).ToString(); state.target = CefString(target).ToString();
    // Optional media fields preserve old webpage text/default contracts.
    if (object->GetType("canDictate") == VTYPE_BOOL) state.can_dictate = object->GetBool("canDictate");
    if (object->GetType("canCall") == VTYPE_BOOL) state.can_call = object->GetBool("canCall");
    if (object->GetType("petDictationAudioVersion") == VTYPE_INT && object->GetInt("petDictationAudioVersion") == 1) state.dictation_audio = 1;
    if (object->GetType("petVoiceAudioVersion") == VTYPE_INT && object->GetInt("petVoiceAudioVersion") == 1) state.voice_audio = 1;
    if (object->GetType("voice") == VTYPE_DICTIONARY) {
      const auto voice = object->GetDictionary("voice");
      state.calling = voice->GetType("active") == VTYPE_BOOL && voice->GetBool("active");
      state.muted = voice->GetType("muted") == VTYPE_BOOL && voice->GetBool("muted");
      PetString(voice, "state", 40, state.voice_state);
    }
    const char* keys[]{"ready", "busy", "richDraft", "dictating", "canSwitchTarget"};
    bool* values[]{&state.ready, &state.busy, &state.rich_draft, &state.dictating, &state.can_switch};
    for (int i = 0; i < 5; ++i) {
      if (!object->HasKey(keys[i]) || object->GetType(keys[i]) != VTYPE_BOOL) return false;
      *values[i] = object->GetBool(keys[i]);
    }
    if (!object->HasKey("messages") || object->GetType("messages") != VTYPE_LIST) return false;
    const auto messages = object->GetList("messages");
    if (messages->GetSize() > 8) return false;
    for (size_t i = 0; i < messages->GetSize(); ++i) {
      if (messages->GetType(i) != VTYPE_DICTIONARY) return false;
      const auto row = messages->GetDictionary(i);
      std::wstring role, content;
      if (!PetString(row, "role", 16, role) || (role != L"user" && role != L"assistant") ||
          !PetString(row, "content", 4000, content)) return false;
      state.messages += (role == L"user" ? L"你：" : L"助手：") + content + L"\r\n\r\n";
    }
    return true;
  }
  void ReceivePet(CefRefPtr<CefProcessMessage> message) {
    const auto args = message->GetArgumentList();
    const bool connected = message->GetName() == keepwork_cef::kPetConnected;
    if (args->GetSize() != (connected ? 2 : 3) || args->GetType(0) != VTYPE_STRING || args->GetType(1) != VTYPE_STRING ||
        args->GetString(0).empty() || args->GetString(0).length() > 64 || pet_binding_.challenge().empty() || args->GetString(1) != pet_binding_.challenge()) return;
    const auto document = args->GetString(0).ToString();
    if (connected) {
      pet_binding_.Connect(document, args->GetString(1).ToString());
      return;
    }
    if (!pet_binding_.Matches(document, args->GetString(1).ToString()) || args->GetType(2) != VTYPE_STRING || args->GetString(2).length() > 196608) return;
    const auto json = CefParseJSON(args->GetString(2), JSON_PARSER_RFC);
    if (!json || json->GetType() != VTYPE_DICTIONARY) return;
    const auto object = json->GetDictionary();
    if (message->GetName() == keepwork_cef::kPetState) {
      keepwork_cef::PetChatState::Snapshot snapshot;
      if (!ReadPetSnapshot(object, snapshot)) return;
      if (snapshot.context != pet_state_.snapshot().context) window_frame_.SetPetArtwork({}, {});
      pet_state_.Publish(snapshot); pet_deadline_ = 0;
    } else if (message->GetName() == keepwork_cef::kPetArtwork) {
      std::wstring context, name, png;
      if (!PetString(object, "context", 160, context) || CefString(context).ToString() != pet_state_.snapshot().context ||
          !PetString(object, "name", 48, name) || !PetString(object, "png", 131072, png)) return;
      std::string bytes;
      const std::wstring prefix = L"data:image/png;base64,";
      if (!png.empty()) {
        if (png.compare(0, prefix.size(), prefix) != 0) { window_frame_.SetPetArtwork({}, {}); return; }
        const auto decoded = CefBase64Decode(CefString(png.substr(prefix.size())));
        if (!decoded || decoded->GetSize() > 98304) { window_frame_.SetPetArtwork({}, {}); return; }
        bytes.resize(decoded->GetSize());
        if (!bytes.empty()) decoded->GetData(bytes.data(), bytes.size(), 0);
      }
      window_frame_.SetPetArtwork(name, bytes);
      return;
    } else {
      std::wstring id, error;
      if (!PetString(object, "requestId", 160, id) || !PetString(object, "error", 2000, error) ||
          !object->HasKey("ok") || object->GetType("ok") != VTYPE_BOOL) return;
      const auto next = pet_state_.Result(CefString(id).ToString(), object->GetBool("ok"), error,
        keepwork_cef::PetToken(), GetTickCount64());
      if (next) SendPet(*next);
    }
    UpdatePet();
  }
  void SendPet(const keepwork_cef::PetChatState::Command& command) {
    if (pet_binding_.document().empty() || pet_binding_.challenge().empty()) return;
    const auto found = std::find_if(browsers_.begin(), browsers_.end(), [this](const auto& b) { return b->GetIdentifier() == main_id_; });
    if (found == browsers_.end()) return;
    const auto frame = (*found)->GetMainFrame();
    if (!keepwork_cef::PetFrame(*found, frame)) return;
    const auto object = CefDictionaryValue::Create();
    object->SetInt("version", 1); object->SetString("context", command.context);
    object->SetString("requestId", command.id); object->SetString("action", command.action);
    if (command.action == "input") object->SetString("text", command.text);
    const auto& state = pet_state_.snapshot();
    const bool media_start = (command.action == "dictation" && !state.dictating) || (command.action == "call" && !state.calling);
    const bool pet_audio = media_start && ((command.action == "dictation" && state.dictation_audio == 1) ||
      (command.action == "call" && state.target == "persona" && state.voice_audio == 1));
    if (pet_audio) {
      const auto intent = CefDictionaryValue::Create();
      intent->SetInt("version", 1); intent->SetString("id", keepwork_cef::PetToken());
      object->SetDictionary("petAudio", intent);
    } else if (media_start) {
      // Legacy pages and ordinary chat calls retain their existing page-owned
      // microphone path; make permission/playback interactions visible.
      window_frame_.Show();
    }
    const auto json = CefValue::Create(); json->SetDictionary(object);
    const auto message = CefProcessMessage::Create(keepwork_cef::kPetCommand);
    message->GetArgumentList()->SetString(0, pet_binding_.document());
    message->GetArgumentList()->SetString(1, pet_binding_.challenge());
    message->GetArgumentList()->SetString(2, CefWriteJSON(json, JSON_WRITER_DEFAULT));
    frame->SendProcessMessage(PID_RENDERER, message);
  }
  void PetAction(keepwork_cef::PetChatAction action) {
    using Action = keepwork_cef::PetChatAction;
    if (action == Action::OpenMain) { window_frame_.Show(); return; }
    if (action == Action::Collapse) { StopPetCapture(); window_frame_.pet_chat().Hide(); return; }
    if (action == Action::AcknowledgeUnknown) pet_state_.AcknowledgeUnknown();
    else {
      const std::string name = action == Action::Send ? "send" : action == Action::Stop ? "stop" :
        action == Action::Dictation ? "dictation" : action == Action::Call ? "call" : action == Action::Mute ? "mute" : "toggle-target";
      const auto command = pet_state_.Begin(name, keepwork_cef::PetToken(), GetTickCount64());
      if (command) SendPet(*command);
    }
    UpdatePet();
  }
  void StopPetCapture() {
    // Host lifecycle notification only. Never toggle/replay a page mutation.
    SendPet({"capture-stop", keepwork_cef::PetToken(), pet_state_.snapshot().context, {}});
  }
  void PetTick() {
    pet_state_.Timeout(GetTickCount64());
    if (pet_deadline_ && GetTickCount64() >= pet_deadline_) pet_deadline_ = 0;
    UpdatePet();
  }
  void UpdatePet() {
    const auto& state = pet_state_.snapshot();
    keepwork_cef::PetChatView view;
    view.title = (state.target == "chat" ? L"当前会话 · " : L"我的分身 · ") + state.title;
    view.transcript = state.messages;
    if (!state.reply.empty() && view.transcript.find(state.reply) == std::wstring::npos)
      view.transcript += L"助手：" + state.reply;
    view.ready = state.ready; view.busy = state.busy;
    view.rich_draft = state.rich_draft; view.dictating = state.dictating;
    view.can_dictate = state.can_dictate; view.can_call = state.can_call;
    view.calling = state.calling; view.muted = state.muted;
    view.can_switch = state.can_switch; view.pending = pet_state_.pending(); view.uncertain = pet_state_.unknown();
    view.unsynced = pet_state_.dirty() && pet_state_.draft() != state.draft;
    view.error = pet_state_.error();
    if (view.error.empty()) view.error = state.error;
    if (state.context.empty()) view.status = pet_deadline_ ? L"正在连接 AIChat…" : L"网页尚未提供宠物对话，请打开 AIChat 登录或刷新后重试。";
    else if (!state.attention.empty()) view.status = state.attention;
    else if (state.rich_draft) view.status = L"请打开 AIChat 处理附件或工具内容。";
    else if (state.dictating) view.status = L"语音输入中…";
    else if (state.calling) {
      if (state.muted) view.status = L"通话中 · 已静音";
      else if (state.voice_state == L"starting" || state.voice_state == L"connecting") view.status = L"正在连接通话…";
      else if (state.voice_state == L"listening") view.status = L"通话中 · 正在聆听…";
      else if (state.voice_state == L"thinking") view.status = L"通话中 · 正在思考…";
      else if (state.voice_state == L"speaking") view.status = L"通话中 · 正在说话…";
      else if (state.voice_state == L"stopping") view.status = L"正在结束通话…";
      else view.status = L"通话中…";
    }
    else if (pet_state_.pending()) view.status = L"正在确认操作…";
    else if (state.busy) view.status = L"正在回复…";
    else if (view.unsynced) view.status = state.draft.empty()
      ? L"有未同步的草稿，发送或清空后再切换目标。"
      : L"有未同步的草稿，请先发送或恢复为主窗口草稿后再切换。";
    else if (!state.ready) view.status = L"当前目标尚未就绪，可切换目标或打开 AIChat。";
    else view.status.clear();
    window_frame_.pet_chat().Update(view);
    const auto owner = pet_binding_.document() + "|" + state.context;
    const bool owner_changed = owner != pet_panel_owner_;
    pet_panel_owner_ = owner;
    if (owner_changed || window_frame_.pet_chat().Draft() != pet_state_.draft())
      window_frame_.pet_chat().SetDraft(pet_state_.draft(), owner_changed);
    window_frame_.PetChatTimer(pet_state_.pending() || pet_deadline_ != 0);
  }
  void RunCommand(CefRefPtr<CefBrowser> browser, keepwork_cef::WindowCommand command) {
    CEF_REQUIRE_UI_THREAD();
    using Command = keepwork_cef::WindowCommand;
    auto frame = browser->GetFocusedFrame();
    if (!frame) frame = browser->GetMainFrame();
    switch (command) {
      case Command::reload: browser->Reload(); break;
      case Command::reload_no_cache: browser->ReloadIgnoreCache(); break;
      case Command::open_browser: OpenExternal(browser->GetMainFrame()->GetURL()); break;
      case Command::open_entry: OpenExternal(kEntry); break;
      case Command::close: SendMessageW(window_frame_.window(), WM_CLOSE, 0, 0); break;
      case Command::quit: window_frame_.Quit(); break;
      case Command::undo: frame->Undo(); break;
      case Command::redo: frame->Redo(); break;
      case Command::cut: frame->Cut(); break;
      case Command::copy: frame->Copy(); break;
      case Command::paste: frame->Paste(); break;
      case Command::select_all: frame->SelectAll(); break;
      case Command::zoom_in: browser->GetHost()->SetZoomLevel(std::min(5.0, browser->GetHost()->GetZoomLevel() + 0.5)); break;
      case Command::zoom_out: browser->GetHost()->SetZoomLevel(std::max(-5.0, browser->GetHost()->GetZoomLevel() - 0.5)); break;
      case Command::zoom_reset: browser->GetHost()->SetZoomLevel(0); break;
      case Command::fullscreen: window_frame_.ToggleFullscreen(); break;
      case Command::dashboard: OpenExternal("http://127.0.0.1:8089/dashboard"); break;
      case Command::start_mcp:
        // This path came from the signed host's native launcher invocation,
        // never from page messages. Only this fixed, non-stopping action runs.
        if (!options_.launcher.empty() && reinterpret_cast<INT_PTR>(ShellExecuteW(window_frame_.window(),
            L"open", options_.launcher.c_str(), L"--start-mcp", nullptr, SW_SHOWNORMAL)) <= 32)
          MessageBoxW(window_frame_.window(), L"无法启动本地服务。请从安装目录重新打开 Keepwork，或在本地 MCP 面板检查服务。",
            kTitle, MB_OK | MB_ICONWARNING);
        break;
      case Command::restart_mcp:
        if (options_.maintenance && !options_.launcher.empty()) maintenance_.Restart();
        break;
      case Command::check_updates:
        if (options_.maintenance && !options_.launcher.empty()) maintenance_.Check();
        break;
      case Command::remote_voice: remote_voice_.Open(window_frame_.window(), [this] { window_frame_.Show(); }); break;
      case Command::about: {
        const auto text = std::wstring(L"Keepwork\nWindows 兼容客户端 ") + keepwork_cef::kHostVersion
          + L"\nChromium / CEF " CEF_VERSION;
        MessageBoxW(window_frame_.window(), text.c_str(), kTitle, MB_OK | MB_ICONINFORMATION); break;
      }
    }
  }
  Options options_;
  keepwork_cef::WindowFrame window_frame_;
  keepwork_cef::MaintenanceController maintenance_;
  keepwork_cef::PetChatState pet_state_;
  keepwork_cef::RemoteVoiceController remote_voice_;
  keepwork_cef::PetDocumentBinding pet_binding_;
  std::string pet_panel_owner_;
  uint64_t pet_deadline_ = 0;
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
    auto& frame = client_->window_frame();
    if (!frame.Create()) {
      error_ = 22;
      Error(L"Keepwork 窗口创建失败。请重新打开 Keepwork。");
      CefQuitMessageLoop();
      return;
    }
    const auto bounds = frame.ContentBounds();
    CefWindowInfo window;
    window.SetAsChild(frame.window(), CefRect(bounds.left, bounds.top,
      bounds.right - bounds.left, bounds.bottom - bounds.top));
#if CEF_VERSION_MAJOR >= 138
    window.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
#endif
    CefBrowserSettings settings;
    if (!CefBrowserHost::CreateBrowser(window, client_, "about:blank", settings, nullptr, nullptr)) {
      frame.Destroy();
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
  CefRefPtr<RendererApp> renderer_app(new RendererApp);
  const int child_result = CefExecuteProcess(args, renderer_app, sandbox_info);
  if (child_result >= 0) return child_result;

  Options options;
  if (!ReadOptions(options)) {
    Error(L"启动参数无效。请通过 Keepwork 启动器打开。");
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
