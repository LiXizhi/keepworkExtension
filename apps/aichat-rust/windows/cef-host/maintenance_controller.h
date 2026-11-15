#pragma once
#include <windows.h>
#include <shlobj.h>
#include <commctrl.h>
#include <objbase.h>
#include <algorithm>
#include <functional>
#include <string>
#include <vector>
#include "include/cef_parser.h"

namespace keepwork_cef {
// Native user actions only. The webpage cannot start helpers, choose paths,
// request installation, or turn an update-state file into executable input.
class MaintenanceController {
 public:
  ~MaintenanceController() { Stop(); }
  void Start(HWND owner, std::wstring launcher, std::function<void()> quit,
      std::function<void(const std::wstring&)> notify) {
    Stop(); owner_ = owner; launcher_ = std::move(launcher);
    quit_ = std::move(quit); notify_ = std::move(notify);
    next_check_ = GetTickCount64() + 15000;
  }
  void Stop() {
    // Releasing our observation handles never terminates a helper or MCP.
    if (process_) CloseHandle(process_);
    if (ready_event_) CloseHandle(ready_event_);
    if (cancel_event_) CloseHandle(cancel_event_);
    if (closed_event_) CloseHandle(closed_event_);
    process_ = ready_event_ = cancel_event_ = closed_event_ = nullptr; operation_ = Operation::None;
    owner_ = nullptr; launcher_.clear(); quit_ = {}; notify_ = {};
  }
  void Check(bool background = false) {
    if (launcher_.empty()) return;
    if (operation_ != Operation::None) {
      if (!background) Busy();
      return;
    }
    background_ = background;
    next_check_ = GetTickCount64() + 6ULL * 60 * 60 * 1000;
    Spawn(background ? L"--check-updates --background" : L"--check-updates", Operation::Check, background);
  }
  void Restart() {
    if (operation_ != Operation::None) { Busy(); return; }
    Spawn(L"--restart-mcp", Operation::Restart, false);
  }
  bool awaiting_close() const { return operation_ == Operation::Install && close_requested_ && !install_canceled_; }
  void AcknowledgeClosed() {
    // Only CEF's accepted main-browser OnBeforeClose acknowledges shutdown.
    // A crash or an ordinary exit before the ready handshake cannot install.
    if (awaiting_close() && closed_event_) SetEvent(closed_event_);
  }
  void CancelInstall() {
    // The helper observes this event before waiting for or installing after
    // process exit. A later ordinary quit cannot revive canceled consent.
    if (operation_ == Operation::Install && cancel_event_) SetEvent(cancel_event_);
    install_canceled_ = true;
  }
  void Tick() {
    if (launcher_.empty()) return;
    const auto now = GetTickCount64();
    if (operation_ == Operation::Install && ready_event_ && !close_requested_
        && WaitForSingleObject(ready_event_, 0) == WAIT_OBJECT_0) {
      close_requested_ = true;
      // This asks CEF to close normally. A beforeunload cancellation leaves
      // the process alive, so the helper cannot launch the installer.
      if (quit_) quit_();
      return;
    }
    if (process_ && WaitForSingleObject(process_, 0) == WAIT_OBJECT_0) {
      DWORD code = 2; GetExitCodeProcess(process_, &code);
      const auto completed = operation_;
      CloseHandle(process_); process_ = nullptr; operation_ = Operation::None;
      if (ready_event_) { CloseHandle(ready_event_); ready_event_ = nullptr; }
      if (cancel_event_) { CloseHandle(cancel_event_); cancel_event_ = nullptr; }
      if (closed_event_) { CloseHandle(closed_event_); closed_event_ = nullptr; }
      if (completed == Operation::Check) CompleteCheck(code);
      else if (completed == Operation::Install) {
        // Reaching this branch means the main CEF process is still alive:
        // validation failed, the user canceled close, or the helper timed out.
        close_requested_ = false;
        if (!install_canceled_) MessageBoxW(owner_, L"更新尚未安装，聊天窗口和已下载的更新已保留。\n请处理未完成的工作后，再从“检查更新…”选择“退出并更新”。",
          L"Keepwork 更新", MB_OK | MB_ICONINFORMATION);
      }
    }
    if (operation_ == Operation::None && now >= next_check_) Check(true);
  }
 private:
  enum class Operation { None, Check, Restart, Install };
  struct Snapshot {
    std::wstring state, current, latest, pending_version, release_date, checked_at, error;
    std::string digest;
    bool ready = false, stale = false;
  };
  HWND owner_ = nullptr;
  HANDLE process_ = nullptr, ready_event_ = nullptr, cancel_event_ = nullptr, closed_event_ = nullptr;
  std::wstring launcher_;
  std::function<void()> quit_;
  std::function<void(const std::wstring&)> notify_;
  Operation operation_ = Operation::None;
  ULONGLONG next_check_ = 0;
  bool background_ = false, close_requested_ = false, install_canceled_ = false;
  std::string notified_digest_;

  static std::wstring Quote(const std::wstring& value) {
    // Validated launcher paths and generated arguments contain no quote/NUL.
    return L"\"" + value + L"\"";
  }
  void Busy() const {
    MessageBoxW(owner_, L"正在检查更新或操作本地服务，请稍候。", L"Keepwork", MB_OK | MB_ICONINFORMATION);
  }
  bool Spawn(const std::wstring& flags, Operation operation, bool hidden) {
    if (launcher_.empty()) return false;
    auto arguments = Quote(launcher_) + L" " + flags;
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = hidden ? SW_HIDE : SW_SHOWNORMAL;
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(launcher_.c_str(), arguments.data(), nullptr, nullptr, FALSE, 0,
        nullptr, nullptr, &startup, &child)) {
      if (!hidden) MessageBoxW(owner_, L"无法打开维护程序。请从安装目录重新打开 Keepwork 后重试。",
        L"Keepwork", MB_OK | MB_ICONERROR);
      return false;
    }
    CloseHandle(child.hThread); process_ = child.hProcess; operation_ = operation;
    return true;
  }
  static bool Text(CefRefPtr<CefDictionaryValue> object, const char* key, size_t cap, std::wstring& out) {
    if (!object->HasKey(key)) return true;
    if (object->GetType(key) != VTYPE_STRING || object->GetString(key).length() > cap) return false;
    out = object->GetString(key).ToWString();
    for (auto& character : out) if (character < 32 || character == 127) character = L' ';
    return true;
  }
  static bool ReadSnapshot(Snapshot& snapshot) {
    wchar_t directory[MAX_PATH]{};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, directory))) return false;
    const auto path = std::wstring(directory) + L"\\KeepworkWin7Win8\\Updates\\state.json";
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 65536) { CloseHandle(file); return false; }
    std::string bytes(static_cast<size_t>(size.QuadPart), '\0'); DWORD count = 0;
    const bool read = ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) != FALSE;
    CloseHandle(file);
    if (!read || count != bytes.size()) return false;
    const auto json = CefParseJSON(bytes, JSON_PARSER_RFC);
    if (!json || json->GetType() != VTYPE_DICTIONARY) return false;
    const auto object = json->GetDictionary();
    if (!Text(object, "state", 32, snapshot.state) || !Text(object, "currentVersion", 64, snapshot.current)
        || !Text(object, "latestVersion", 64, snapshot.latest) || !Text(object, "pendingVersion", 64, snapshot.pending_version)
        || !Text(object, "releaseDate", 128, snapshot.release_date) || !Text(object, "checkedAt", 128, snapshot.checked_at)
        || !Text(object, "error", 2048, snapshot.error)) return false;
    snapshot.stale = object->HasKey("stale") && object->GetType("stale") == VTYPE_BOOL && object->GetBool("stale");
    std::wstring digest;
    if (!Text(object, "pendingDigest", 64, digest)) return false;
    snapshot.digest = CefString(digest).ToString();
    const bool valid_digest = snapshot.digest.size() == 64 && std::all_of(snapshot.digest.begin(), snapshot.digest.end(),
      [](char value) { return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'); });
    snapshot.ready = valid_digest && object->HasKey("ready") && object->GetType("ready") == VTYPE_BOOL && object->GetBool("ready");
    return true;
  }
  void CompleteCheck(DWORD code) {
    Snapshot snapshot;
    const bool loaded = ReadSnapshot(snapshot);
    if (background_) {
      if (loaded && snapshot.ready && snapshot.digest != notified_digest_) {
        notified_digest_ = snapshot.digest;
        const auto& version = snapshot.pending_version.empty() ? snapshot.latest : snapshot.pending_version;
        if (notify_) notify_(L"新版本 " + version + L" 已下载。点击查看，或从帮助菜单选择“检查更新…”。");
      }
      return;
    }
    if (!loaded) {
      MessageBoxW(owner_, L"无法读取更新结果。请稍后重新检查更新。", L"Keepwork 更新", MB_OK | MB_ICONWARNING);
      return;
    }
    std::wstring detail = L"当前版本：" + snapshot.current;
    if (!snapshot.latest.empty()) detail += L"\n最新版本：" + snapshot.latest;
    if (!snapshot.release_date.empty()) detail += L"\n发布时间：" + snapshot.release_date;
    if (snapshot.stale) detail += L"\n\n当前显示上次保存的更新信息。";
    if (!snapshot.error.empty()) detail += L"\n\n" + snapshot.error;
    if (!snapshot.ready) {
      const bool failed = code != 0 || snapshot.state == L"error";
      MessageBoxW(owner_, ((failed ? L"更新检查未完成。\n\n" : L"当前已是最新版本。\n\n") + detail).c_str(),
        L"Keepwork 更新", MB_OK | (failed ? MB_ICONWARNING : MB_ICONINFORMATION));
      return;
    }
    const auto& version = snapshot.pending_version.empty() ? snapshot.latest : snapshot.pending_version;
    const auto instruction = L"新版本 " + version + L" 已下载，是否退出并更新？";
    detail += L"\n\n应用将正常关闭后安装更新。未完成的网页操作可以取消退出，已下载的更新会保留。";
    TASKDIALOG_BUTTON buttons[]{{100, L"退出并更新"}, {101, L"稍后"}};
    TASKDIALOGCONFIG config{}; config.cbSize = sizeof(config); config.hwndParent = owner_;
    config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
    config.pszWindowTitle = L"Keepwork 更新"; config.pszMainInstruction = instruction.c_str();
    config.pszContent = detail.c_str(); config.pButtons = buttons; config.cButtons = ARRAYSIZE(buttons);
    config.nDefaultButton = 101;
    int selected = 101;
    const auto shown = TaskDialogIndirect(&config, &selected, nullptr, nullptr);
    if (FAILED(shown)) selected = MessageBoxW(owner_, (instruction + L"\n\n" + detail).c_str(),
      L"Keepwork 更新", MB_YESNO | MB_DEFBUTTON2 | MB_ICONQUESTION) == IDYES ? 100 : 101;
    if (selected == 100) Install(snapshot.digest);
  }
  void Install(const std::string& digest) {
    if (operation_ != Operation::None) { Busy(); return; }
    GUID nonce{}; wchar_t value[40]{};
    if (FAILED(CoCreateGuid(&nonce)) || !StringFromGUID2(nonce, value, ARRAYSIZE(value))) return;
    const auto name = std::wstring(L"Local\\Keepwork.Update.Ready.") + value;
    const auto cancel_name = std::wstring(L"Local\\Keepwork.Update.Cancel.") + value;
    const auto closed_name = std::wstring(L"Local\\Keepwork.Update.Closed.") + value;
    SetLastError(ERROR_SUCCESS);
    ready_event_ = CreateEventW(nullptr, TRUE, FALSE, name.c_str());
    if (!ready_event_ || GetLastError() == ERROR_ALREADY_EXISTS) {
      if (ready_event_) { CloseHandle(ready_event_); ready_event_ = nullptr; }
      MessageBoxW(owner_, L"无法准备更新，请稍后重试。", L"Keepwork 更新", MB_OK | MB_ICONERROR); return;
    }
    SetLastError(ERROR_SUCCESS);
    cancel_event_ = CreateEventW(nullptr, TRUE, FALSE, cancel_name.c_str());
    if (!cancel_event_ || GetLastError() == ERROR_ALREADY_EXISTS) {
      CloseHandle(ready_event_); ready_event_ = nullptr;
      if (cancel_event_) { CloseHandle(cancel_event_); cancel_event_ = nullptr; }
      MessageBoxW(owner_, L"无法准备更新，请稍后重试。", L"Keepwork 更新", MB_OK | MB_ICONERROR); return;
    }
    SetLastError(ERROR_SUCCESS);
    closed_event_ = CreateEventW(nullptr, TRUE, FALSE, closed_name.c_str());
    if (!closed_event_ || GetLastError() == ERROR_ALREADY_EXISTS) {
      CloseHandle(ready_event_); ready_event_ = nullptr;
      CloseHandle(cancel_event_); cancel_event_ = nullptr;
      if (closed_event_) { CloseHandle(closed_event_); closed_event_ = nullptr; }
      MessageBoxW(owner_, L"无法准备更新，请稍后重试。", L"Keepwork 更新", MB_OK | MB_ICONERROR); return;
    }
    const auto flags = L"--install-update --background --wait-pid " + std::to_wstring(GetCurrentProcessId())
      + L" --ready-event " + Quote(name) + L" --cancel-event " + Quote(cancel_name)
      + L" --closed-event " + Quote(closed_name)
      + L" --expected-update " + CefString(digest).ToWString();
    close_requested_ = install_canceled_ = false;
    if (!Spawn(flags, Operation::Install, true)) {
      CloseHandle(ready_event_); ready_event_ = nullptr;
      CloseHandle(cancel_event_); cancel_event_ = nullptr;
      CloseHandle(closed_event_); closed_event_ = nullptr;
      MessageBoxW(owner_, L"无法启动更新安装程序，聊天窗口和已下载的更新已保留。", L"Keepwork 更新", MB_OK | MB_ICONERROR);
    }
  }
};
}
