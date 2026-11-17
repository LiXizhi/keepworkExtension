#pragma once
#include <windows.h>
#include <commctrl.h>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <cwctype>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "include/cef_parser.h"

namespace keepwork_cef {
// Native settings and private inherited pipes only. Neither cloud frames nor
// the pet bridge can start a process, submit text or control this service.
class RemoteVoiceController {
 public:
  ~RemoteVoiceController() { Shutdown(); }
  void Initialize(const std::wstring& profile) {
    Shutdown();
    profile_ = profile;
    { std::lock_guard<std::mutex> lock(mutex_);
      available_ = running_ = config_loaded_ = begin_ready_ = auto_paused_ = selection_required_ = stopped_ = false;
      auto_start_ = true; device_.clear(); devices_.clear();
      status_ = L"正在读取遥控器状态…";
    }
    supported_ = SupportedWindows();
    if (!supported_) {
      status_ = L"当前系统不支持原版蓝牙遥控器语音服务。该功能需要 Windows 10 1703（15063）或更新版本的系统 BLE API；Windows 7 / 8 可继续使用麦克风语音、通话和文字输入。";
      return;
    }
    stopping_.store(false);
    worker_ = std::thread([this] { Worker(); });
  }
  void Open(HWND owner, std::function<void()> begin_input = {}) {
    begin_input_ = std::move(begin_input);
    if (const auto existing = window_.load()) {
      ShowWindow(existing, SW_SHOW); SetForegroundWindow(existing); return;
    }
    owner_ = owner;
    WNDCLASSW type{}; type.lpfnWndProc = Procedure;
    type.hInstance = GetModuleHandleW(nullptr); type.lpszClassName = L"KeepworkCefRemoteVoice";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    if (!RegisterClassW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return;
    const HWND window = CreateWindowExW(WS_EX_TOOLWINDOW, type.lpszClassName, L"遥控器语音输入",
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN,
      CW_USEDEFAULT, CW_USEDEFAULT, 620, 590, owner, nullptr, type.hInstance, this);
    if (!window) return;
    ShowWindow(window, SW_SHOW); SetForegroundWindow(window);
  }
  void Shutdown() {
    stopping_.store(true); changed_.notify_all();
    if (worker_.joinable()) worker_.join();
    if (const auto window = window_.load()) DestroyWindow(window);
    window_.store(nullptr);
    std::lock_guard<std::mutex> lock(mutex_); commands_.clear();
  }
 private:
  static constexpr UINT update_message = WM_APP + 63;
  static constexpr int device_id = 201, auto_id = 202, start_id = 203, stop_id = 204, ready_id = 205,
    picker_id = 206, refresh_id = 207;
  struct RemoteDevice { std::wstring id, name; bool connected = false; };
  static bool SameDevices(const std::vector<RemoteDevice>& a, const std::vector<RemoteDevice>& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i)
      if (a[i].id != b[i].id || a[i].name != b[i].name || a[i].connected != b[i].connected) return false;
    return true;
  }
  std::wstring InputDevice() const {
    std::array<wchar_t, 257> value{};
    GetWindowTextW(device_control_, value.data(), static_cast<int>(value.size()));
    return value.data();
  }
  static bool HasTarget(const std::wstring& value) {
    for (const auto ch : value) if (!std::iswspace(ch)) return true;
    return false;
  }
  void SetInputDevice(const std::wstring& value) {
    updating_controls_ = true;
    SetWindowTextW(device_control_, value.c_str());
    updating_controls_ = false;
  }
  static bool SupportedWindows() {
    using Version = LONG (WINAPI*)(OSVERSIONINFOW*);
    const auto address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    Version version = nullptr;
    static_assert(sizeof(version) == sizeof(address));
    std::memcpy(&version, &address, sizeof(version));
    OSVERSIONINFOW info{}; info.dwOSVersionInfoSize = sizeof(info);
    return version && version(&info) == 0 && (info.dwMajorVersion > 10 || (info.dwMajorVersion == 10 && info.dwBuildNumber >= 15063));
  }
  static std::wstring Quote(const std::wstring& value) {
    std::wstring result = L"\""; size_t slashes = 0;
    for (const auto ch : value) {
      if (ch == L'\\') { ++slashes; continue; }
      result.append(slashes * (ch == L'"' ? 2 : 1), L'\\'); slashes = 0;
      if (ch == L'"') result += L'\\';
      result += ch;
    }
    result.append(slashes * 2, L'\\'); result += L'"'; return result;
  }
  static void Close(HANDLE& handle) { if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle); handle = nullptr; }
  bool Launch() {
    std::array<wchar_t, 32768> module{};
    const DWORD size = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
    if (!size || size == module.size()) return false;
    const std::wstring current(module.data(), size);
    const auto slash = current.find_last_of(L"\\/");
    if (slash == std::wstring::npos || profile_.empty()) return false;
    const auto executable = current.substr(0, slash + 1) + L"keepwork-remote-voice.exe";
    const DWORD attributes = GetFileAttributesW(executable.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return false;
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE child_input = nullptr, child_output = nullptr, null_output = nullptr;
    bool success = false;
    do {
      if (!CreatePipe(&child_input, &input_, &security, 0) || !CreatePipe(&output_, &child_output, &security, 0)) break;
      if (!SetHandleInformation(input_, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(output_, HANDLE_FLAG_INHERIT, 0)) break;
      null_output = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
      if (null_output == INVALID_HANDLE_VALUE) break;
      STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start);
      start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      start.StartupInfo.hStdInput = child_input; start.StartupInfo.hStdOutput = child_output; start.StartupInfo.hStdError = null_output;
      SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
      std::vector<unsigned char> storage(bytes);
      start.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
      if (!InitializeProcThreadAttributeList(start.lpAttributeList, 1, 0, &bytes)) break;
      HANDLE handles[] = {child_input, child_output, null_output};
      const bool configured = UpdateProcThreadAttribute(start.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles, sizeof(handles), nullptr, nullptr) != FALSE;
      auto line = Quote(executable) + L" --profile " + Quote(profile_);
      PROCESS_INFORMATION process{};
      const bool created = configured && CreateProcessW(executable.c_str(), line.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, current.substr(0, slash).c_str(), &start.StartupInfo, &process);
      DeleteProcThreadAttributeList(start.lpAttributeList);
      if (!created) break;
      process_ = process.hProcess;
      job_ = CreateJobObjectW(nullptr, nullptr);
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (job_ && SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &limit, sizeof(limit))
          && AssignProcessToJobObject(job_, process_) && ResumeThread(process.hThread) != static_cast<DWORD>(-1)) success = true;
      else TerminateProcess(process_, 1);
      CloseHandle(process.hThread);
    } while (false);
    Close(child_input); Close(child_output); Close(null_output);
    if (!success) Cleanup();
    return success;
  }
  void Cleanup() {
    Close(input_); Close(output_);
    Close(job_); // Own child only; closing the job also revokes F5 on a crash/hang.
    Close(process_);
  }
  bool Exchange(const std::string& value, std::string& reply, bool exiting = false) {
    const std::string line = value + "\n"; DWORD written = 0;
    if (line.size() > 4096 || !WriteFile(input_, line.data(), static_cast<DWORD>(line.size()), &written, nullptr) || written != line.size()) return false;
    reply.clear();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline && (exiting || !stopping_.load())) {
      DWORD available = 0;
      if (WaitForSingleObject(process_, 0) == WAIT_OBJECT_0 || !PeekNamedPipe(output_, nullptr, 0, nullptr, &available, nullptr)) return false;
      if (available) {
        char byte = 0; DWORD read = 0;
        if (!ReadFile(output_, &byte, 1, &read, nullptr) || read != 1) return false;
        if (byte == '\n') return true;
        // Bounded status now includes up to 256 named BLE identities. This is
        // still a private status-only pipe; command input stays capped at 4 KiB.
        if (reply.size() >= 262144) return false;
        reply += byte;
      } else std::this_thread::sleep_for(std::chrono::milliseconds(15));
    }
    return false;
  }
  void Worker() {
    if (!Launch()) { Status(L"遥控器语音组件无法启动。请重新安装完整兼容版；普通聊天和麦克风语音仍可使用。", false); return; }
    while (!stopping_.load()) {
      std::string request = "{\"action\":\"status\"}";
      { std::unique_lock<std::mutex> lock(mutex_);
        if (commands_.empty()) changed_.wait_for(lock, std::chrono::milliseconds(500), [this] { return stopping_.load() || !commands_.empty(); });
        if (stopping_.load()) break;
        if (!commands_.empty()) { request = std::move(commands_.front()); commands_.pop_front(); }
      }
      std::string reply;
      if (!Exchange(request, reply)) { Status(L"遥控器语音组件连接中断，本次操作结果未知，未自动重试。请关闭并重新打开客户端后重试。", false); break; }
      Apply(reply);
    }
    // Stop before closing owned handles; EOF is a second cancellation path.
    std::string ignored; Exchange("{\"action\":\"shutdown\"}", ignored, true);
    Cleanup();
  }
  void Status(const std::wstring& text, bool available) {
    { std::lock_guard<std::mutex> lock(mutex_); status_ = text; available_ = available; }
    if (const auto window = window_.load()) PostMessageW(window, update_message, 0, 0);
  }
  void Apply(const std::string& reply) {
    const auto value = CefParseJSON(reply, JSON_PARSER_RFC);
    if (!value || value->GetType() != VTYPE_DICTIONARY) { Status(L"遥控器组件返回无效状态，未重放任何输入。", false); return; }
    const auto root = value->GetDictionary();
    if (!root->GetBool("ok")) { Status(root->GetString("error").ToWString(), true); return; }
    const auto snapshot = root->GetDictionary("snapshot");
    if (!snapshot) { Status(L"遥控器组件状态不完整。", false); return; }
    const auto state = snapshot->GetString("state").ToString();
    std::wstring status = L"状态：";
    if (state == "waiting-paired") status += L"等待系统已配对的小米遥控器";
    else if (state == "waiting-selection") status += L"请选择要使用的遥控器；未找到时请唤醒后刷新";
    else if (state == "preparing-microphone") status += L"正在准备麦克风，请保持按住语音键";
    else if (state == "no-audio") status += L"未收到音频，请重新按住语音键";
    else if (state == "scanning" || state == "connecting") status += L"正在连接遥控器";
    else if (state == "ready") status += L"就绪，按住语音键说话，松手后识别";
    else if (state == "recording") status += L"录音中，松开语音键结束";
    else if (state == "recognizing" || state == "transcribing") status += L"正在识别，请等待";
    else if (state == "pasted") status += L"已输入文字，短按 OK 发送";
    else if (state == "submitted") status += L"已发送回车指令";
    else if (state == "cleared") status += L"已清除提示词";
    else if (state == "stopping") status += L"正在停止";
    else if (state == "stopped") status += L"已停止";
    else status += L"请检查设备、权限与网络";
    const auto error = snapshot->GetString("error").ToWString();
    if (!error.empty()) status += L"\r\n" + error.substr(0, 500);
    const auto diagnostic = snapshot->GetString("diagnostic").ToWString();
    if (!diagnostic.empty()) {
      status += L"\r\n\r\n蓝牙服务诊断（可复制）\r\n";
      for (size_t i = 0; i < diagnostic.size() && i < 24000; ++i) {
        if (diagnostic[i] == L'\n' && (i == 0 || diagnostic[i - 1] != L'\r')) status += L'\r';
        status += diagnostic[i];
      }
    }
    std::vector<RemoteDevice> devices;
    if (const auto list = snapshot->GetList("devices")) {
      for (size_t i = 0; i < list->GetSize() && devices.size() < 256; ++i) {
        const auto candidate = list->GetDictionary(i);
        if (!candidate) continue;
        const auto id = candidate->GetString("id").ToWString();
        if (id.empty() || id.size() > 256 || id.find(L'\0') != std::wstring::npos) continue;
        bool duplicate = false;
        for (const auto& previous : devices) if (previous.id == id) { duplicate = true; break; }
        if (!duplicate) devices.push_back({id, candidate->GetString("name").ToWString().substr(0, 120), candidate->GetBool("connected")});
      }
    }
    { std::lock_guard<std::mutex> lock(mutex_);
      status_ = status; available_ = true; running_ = snapshot->GetBool("running");
      selection_required_ = state == "waiting-selection";
      stopped_ = state == "stopping" || state == "stopped";
      devices_ = std::move(devices);
      begin_ready_ = running_ && state != "stopping" && state != "scanning" && state != "connecting" && state != "preparing-microphone" && state != "reconnecting";
      auto_paused_ = snapshot->GetBool("autoPaused");
      if (const auto config = snapshot->GetDictionary("config")) {
        auto_start_ = config->GetBool("autoStart"); device_ = config->GetString("device").ToWString();
        config_loaded_ = true;
      }
    }
    if (const auto window = window_.load()) PostMessageW(window, update_message, 0, 0);
  }
  void Enqueue(CefRefPtr<CefDictionaryValue> value) {
    const auto wrapper = CefValue::Create(); wrapper->SetDictionary(value);
    { std::lock_guard<std::mutex> lock(mutex_); if (!available_ || commands_.size() >= 8) return; commands_.push_back(CefWriteJSON(wrapper, JSON_WRITER_DEFAULT).ToString()); }
    changed_.notify_all();
  }
  void Refresh() {
    // Copy worker-owned state before touching HWNDs: edit notifications are
    // synchronous and may reenter this UI thread while updating controls.
    bool available, running, automatic, paused, ready, loaded, required, stopped;
    std::wstring status, saved;
    std::vector<RemoteDevice> devices;
    { std::lock_guard<std::mutex> lock(mutex_);
      available = available_; running = running_; automatic = auto_start_; paused = auto_paused_;
      ready = begin_ready_; loaded = config_loaded_; required = selection_required_;
      stopped = stopped_;
      status = status_; saved = device_; devices = devices_;
    }
    if (!initialized_controls_ && loaded) {
      SetInputDevice(saved); initialized_controls_ = true;
      for (const auto& device : devices) if (device.id == saved) { selected_device_ = saved; break; }
    }
    if (stopped && !was_stopped_) {
      // Stop intentionally clears discovery results. Keep the saved target
      // available for another explicit Start, without treating it as offline.
      selected_device_.clear(); choice_missing_ = false; SetInputDevice(saved);
    }
    was_stopped_ = stopped;
    if (!selected_device_.empty()) {
      bool found = false;
      for (const auto& device : devices) if (device.id == selected_device_) { found = true; break; }
      if (!found) {
        selected_device_.clear(); choice_missing_ = true; SetInputDevice(L"");
      }
    }
    if (!picker_initialized_ || !SameDevices(displayed_devices_, devices)) {
      displayed_devices_ = std::move(devices); picker_initialized_ = true;
      SendMessageW(picker_, CB_RESETCONTENT, 0, 0);
      SendMessageW(picker_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"请选择遥控器…"));
      for (const auto& device : displayed_devices_) {
        const auto label = (device.name.empty() ? L"小米遥控器" : device.name) + L" · " + device.id
          + (device.connected ? L" · 已连接" : L"");
        SendMessageW(picker_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
      }
    }
    int selected = 0;
    for (size_t i = 0; i < displayed_devices_.size(); ++i)
      if (displayed_devices_[i].id == selected_device_) { selected = static_cast<int>(i + 1); break; }
    if (SendMessageW(picker_, CB_GETCURSEL, 0, 0) != selected)
      SendMessageW(picker_, CB_SETCURSEL, selected, 0);
    if (choice_missing_) status += L"\r\n所选遥控器已不在列表中，请唤醒后刷新，或重新选择。";
    if (displayed_status_ != status) {
      displayed_status_ = status;
      SetWindowTextW(status_control_, status.c_str());
    }
    EnableWindow(start_, supported_ && available && !running && !choice_missing_ && (!required || HasTarget(InputDevice())));
    EnableWindow(stop_, supported_ && available && (running || (automatic && !paused)));
    EnableWindow(ready_, supported_ && available && ready);
    EnableWindow(automatic_, supported_ && available);
    EnableWindow(device_control_, supported_ && available && !running);
    EnableWindow(picker_, supported_ && available && !running && !displayed_devices_.empty());
    EnableWindow(refresh_, supported_ && available && !running);
    SendMessageW(automatic_, BM_SETCHECK, supported_ && automatic ? BST_CHECKED : BST_UNCHECKED, 0);
  }
  HWND Control(const wchar_t* type, const wchar_t* text, DWORD style, int x, int y, int width, int height, int id = 0) {
    const HWND control = CreateWindowExW(type == std::wstring(L"EDIT") ? WS_EX_CLIENTEDGE : 0, type, text,
      WS_CHILD | WS_VISIBLE | style, x, y, width, height, window_.load(), reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
    SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE); return control;
  }
  void CreateControls() {
    Control(L"STATIC", L"适配小米蓝牙语音遥控器 2 / 2 Pro（RC001 / RC003）。请先在 Windows 蓝牙设置中配对。按住语音键录音，松手后由 Keepwork 云端识别；录音不落盘。", 0, 20, 20, 560, 54);
    Control(L"STATIC", L"选择遥控器（选择后点击启动，客户端会记住设备）", 0, 20, 84, 550, 22);
    picker_ = Control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 20, 110, 420, 180, picker_id);
    SendMessageW(picker_, CB_SETDROPPEDWIDTH, 550, 0);
    refresh_ = Control(L"BUTTON", L"刷新设备", BS_PUSHBUTTON | WS_TABSTOP, 450, 110, 120, 28, refresh_id);
    Control(L"STATIC", L"设备 MAC 地址（也可手填；留空自动查找唯一设备）", 0, 20, 148, 550, 22);
    device_control_ = Control(L"EDIT", L"", ES_AUTOHSCROLL | WS_TABSTOP, 20, 174, 550, 28, device_id);
    SendMessageW(device_control_, EM_SETLIMITTEXT, 256, 0);
    automatic_ = Control(L"BUTTON", L"检测到已配对遥控器时自动开启", BS_AUTOCHECKBOX | WS_TABSTOP, 20, 214, 550, 28, auto_id);
    status_control_ = Control(L"EDIT", L"正在读取组件状态…", ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_TABSTOP, 20, 256, 550, 96);
    start_ = Control(L"BUTTON", L"启动语音输入", BS_PUSHBUTTON | WS_TABSTOP, 20, 366, 160, 32, start_id);
    stop_ = Control(L"BUTTON", L"停止", BS_PUSHBUTTON | WS_TABSTOP, 192, 366, 100, 32, stop_id);
    ready_ = Control(L"BUTTON", L"就绪，开始输入", BS_PUSHBUTTON | WS_TABSTOP, 320, 366, 250, 32, ready_id);
    Control(L"STATIC", L"识别文字输入到完成时的当前焦点，不会自动发送；OK 保留原生回车。短按遥控器菜单键可取消在途识别并清空当前可编辑输入框（仅接管唯一 RC003 遥控器来源，普通键盘菜单键保持不变）。整句“发送提示词”发送一次回车，“清除提示词”同样可清空当前可编辑输入框。普通口述会替换剪贴板。", 0, 20, 418, 550, 92);
    initialized_controls_ = picker_initialized_ = choice_missing_ = was_stopped_ = false;
    selected_device_.clear(); displayed_devices_.clear(); displayed_status_.clear(); Refresh();
  }
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto self = reinterpret_cast<RemoteVoiceController*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) { self = static_cast<RemoteVoiceController*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams); SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); self->window_.store(window); }
    if (!self) return DefWindowProcW(window, message, w, l);
    if (message == WM_CREATE) { self->CreateControls(); return 0; }
    if (message == update_message) { self->Refresh(); return 0; }
    if (message == WM_CLOSE) { ShowWindow(window, SW_HIDE); return 0; }
    if (message == WM_NCDESTROY) { self->window_.store(nullptr); SetWindowLongPtrW(window, GWLP_USERDATA, 0); }
    if (message == WM_COMMAND && LOWORD(w) == picker_id && HIWORD(w) == CBN_SELCHANGE) {
      { std::lock_guard<std::mutex> lock(self->mutex_); if (!self->available_ || self->running_) return 0; }
      const auto selected = SendMessageW(self->picker_, CB_GETCURSEL, 0, 0);
      self->selected_device_ = selected > 0 && static_cast<size_t>(selected) <= self->displayed_devices_.size()
        ? self->displayed_devices_[static_cast<size_t>(selected - 1)].id : L"";
      self->choice_missing_ = false;
      self->SetInputDevice(self->selected_device_);
      self->Refresh();
      return 0;
    }
    if (message == WM_COMMAND && LOWORD(w) == device_id && HIWORD(w) == EN_CHANGE) {
      if (!self->updating_controls_) {
        self->selected_device_.clear(); self->choice_missing_ = false;
        self->Refresh();
      }
      return 0;
    }
    if (message == WM_COMMAND && HIWORD(w) == BN_CLICKED) {
      const int id = LOWORD(w);
      if (id == ready_id) {
        { std::lock_guard<std::mutex> lock(self->mutex_); if (!self->supported_ || !self->available_ || !self->begin_ready_) return 0; }
        ShowWindow(window, SW_HIDE); if (self->begin_input_) self->begin_input_(); return 0;
      }
      const auto request = CefDictionaryValue::Create();
      if (id == start_id) {
        const auto device = self->InputDevice();
        { std::lock_guard<std::mutex> lock(self->mutex_);
          if (!self->supported_ || !self->available_ || self->running_ || self->choice_missing_
              || (self->selection_required_ && !HasTarget(device))) return 0;
        }
        request->SetString("action", "start"); request->SetString("device", device);
        request->SetBool("autoStart", SendMessageW(self->automatic_, BM_GETCHECK, 0, 0) == BST_CHECKED);
      } else if (id == refresh_id) {
        { std::lock_guard<std::mutex> lock(self->mutex_); if (!self->supported_ || !self->available_ || self->running_) return 0; }
        request->SetString("action", "refreshDevices");
      } else if (id == stop_id) request->SetString("action", "stop");
      else if (id == auto_id) { request->SetString("action", "auto"); request->SetBool("enabled", SendMessageW(self->automatic_, BM_GETCHECK, 0, 0) == BST_CHECKED); }
      else return 0;
      self->Enqueue(request); return 0;
    }
    return DefWindowProcW(window, message, w, l);
  }
  std::atomic<HWND> window_{nullptr};
  HWND owner_ = nullptr, device_control_ = nullptr, automatic_ = nullptr, status_control_ = nullptr, start_ = nullptr, stop_ = nullptr, ready_ = nullptr,
    picker_ = nullptr, refresh_ = nullptr;
  bool supported_ = false, available_ = false, running_ = false, auto_start_ = true, initialized_controls_ = false, config_loaded_ = false;
  bool begin_ready_ = false, auto_paused_ = false;
  bool selection_required_ = false, stopped_ = false;
  // These interaction fields belong solely to the native window thread.
  bool picker_initialized_ = false, choice_missing_ = false, updating_controls_ = false, was_stopped_ = false;
  std::wstring selected_device_;
  std::wstring displayed_status_;
  std::vector<RemoteDevice> devices_, displayed_devices_;
  std::wstring profile_, status_ = L"正在读取遥控器状态…", device_;
  HANDLE input_ = nullptr, output_ = nullptr, process_ = nullptr, job_ = nullptr;
  std::atomic<bool> stopping_{true}; std::thread worker_;
  std::mutex mutex_; std::condition_variable changed_; std::deque<std::string> commands_;
  std::function<void()> begin_input_;
};
}
