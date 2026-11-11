#include "native.hpp"
#include "common/archive.hpp"
#include <commctrl.h>
#include <shellapi.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace fs = std::filesystem;
using namespace keepwork;
namespace {
constexpr UINT update_message = WM_APP + 1, done_message = WM_APP + 2;
std::atomic<bool> cancelled{false};
std::mutex text_mutex;
std::wstring status_text, error_text;
unsigned progress_percent = 0;
HWND label = nullptr, bar = nullptr;
std::string read_file(const fs::path& file, std::uint64_t limit = 2 * 1024 * 1024) {
  plain_path(file);
  if (!fs::is_regular_file(file) || fs::file_size(file) > limit) throw std::runtime_error("Invalid cached release manifest");
  std::ifstream stream(file, std::ios::binary);
  std::string value((std::istreambuf_iterator<char>(stream)), {});
  if (!stream.eof() && stream.fail()) throw std::runtime_error("Cannot read release manifest");
  return value;
}
void write_file(const fs::path& file, const std::string& value) {
  plain_path(file); std::ofstream stream(file, std::ios::binary | std::ios::trunc);
  stream.write(value.data(), static_cast<std::streamsize>(value.size())); stream.close();
  if (!stream) throw std::runtime_error("Cannot save release manifest");
}
void atomic_write(const fs::path& file, const std::string& value) {
  auto temporary = file; temporary += L".tmp"; write_file(temporary, value);
  if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Cannot activate downloaded CEF package");
}
struct Options { bool force_cef = false, update = false, background = false; };
Options options() {
  int count = 0; auto args = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!args) throw std::runtime_error("Cannot read launch arguments");
  struct Free { LPWSTR* value; ~Free() { LocalFree(value); } } cleanup{args};
  Options result;
  for (int i = 1; i < count; ++i) {
    std::wstring arg = args[i];
    if (arg == L"--cef") result.force_cef = true;
    else if (arg == L"--update-cef") { result.force_cef = true; result.update = true; }
    else if (arg == L"--background") result.background = true;
    else throw std::runtime_error("Unknown launcher option. Supported: --cef, --update-cef, --background");
  }
  return result;
}
void run(const Options& opts, const Progress& progress) {
  auto os = windows_version();
  if (cef_running()) throw std::runtime_error("Keepwork compatibility mode is already open; use the existing window or close it before switching runtimes");
  auto cache = local_data() / L"Keepwork" / L"BrowserRuntimes";
  plain_path(cache); fs::create_directories(cache);
  // Serialize probe, download and promotion across concurrent launches.
  Handle lock(CreateFileW((cache / L"launcher.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (lock.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Another Keepwork launcher is running; retry when it finishes");
  auto channel = select_channel(os, false);
  if (channel == "modern" && !opts.force_cef && probe_webview(cache / L"webview-probe", progress)) {
    progress(L"正在打开 Keepwork…", 0, 0);
    if (launch_desktop(executable_dir() / L"aichat-rust.exe", opts.background, progress)) return;
  }
  if (installation_busy(executable_dir())) throw std::runtime_error("Close the existing Keepwork window before switching to CEF");
  auto root = cache / channel / architecture();
  plain_path(root); fs::create_directories(root / L"versions");
  auto active = root / L"active.json";
  auto hash = [](const fs::path& file) { return sha256_file(file); };
  auto start = [&](const Manifest& m, const fs::path& dir) {
    progress(L"正在校验兼容组件…", 0, 0);
    verify_package(dir, m, hash);
    if (channel == "modern") allow_sandbox_read(dir);
    auto profile = local_data() / L"Keepwork" / L"CefProfiles" / (channel + "-" + std::to_string(m.chromium_major));
    return launch_cef(dir, profile, opts.background, progress);
  };
  std::string previous;
  if (fs::exists(active)) {
    try {
      previous = read_file(active);
      auto m = validate_manifest(verify_envelope(previous), channel, architecture(), os);
      verify_package(root / L"versions" / m.sha256, m, hash);
    } catch (...) { previous.clear(); }
    if (!previous.empty() && !opts.update) {
      auto m = validate_manifest(verify_envelope(previous), channel, architecture(), os);
      start(m, root / L"versions" / m.sha256); return;
    }
  }
  auto envelope = fetch_manifest(std::string(cdn_base) + channel + "/windows-" + architecture() + "/stable.json", progress);
  auto manifest = validate_manifest(verify_envelope(envelope), channel, architecture(), os);
  auto directory = root / L"versions" / manifest.sha256;
  auto archive = root / (manifest.sha256 + ".zip.part");
  auto staging = root / (manifest.sha256 + ".staging");
  try {
    bool valid = false;
    if (fs::exists(directory)) {
      try { verify_package(directory, manifest, hash); valid = true; } catch (...) {}
      // A content-addressed directory may belong to a running process. Never overwrite it in place.
      if (!valid) throw std::runtime_error("Cached CEF files are damaged; close Keepwork and remove the damaged version before retrying");
    }
    if (!valid) {
      download(std::string(cdn_base) + "objects/" + manifest.sha256 + ".zip", archive, manifest.size, progress);
      if (sha256_file(archive) != manifest.sha256) throw std::runtime_error("CEF download SHA-256 mismatch");
      plain_path(staging);
      if (fs::exists(staging)) throw std::runtime_error("An interrupted CEF staging directory exists; close Keepwork and remove it before retrying");
      progress(L"正在解压兼容组件…", 0, 0);
      extract_package(archive, staging, manifest, hash);
      fs::rename(staging, directory);
      fs::remove(archive);
    }
    start(manifest, directory);
    // Host acknowledgment is independent of the website/network. Only now activate this release.
    if (!previous.empty()) atomic_write(root / L"previous.json", previous);
    atomic_write(active, envelope);
  } catch (...) {
    std::error_code ignored;
    // Leave version directories intact (a subprocess may still hold them). Active stays unchanged.
    plain_path(archive); fs::remove(archive, ignored);
    if (fs::exists(staging)) { plain_path(staging); fs::remove_all(staging, ignored); }
    throw;
  }
}
LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_COMMAND && LOWORD(w) == IDCANCEL) { cancelled = true; EnableWindow(GetDlgItem(window, IDCANCEL), FALSE); return 0; }
  if (message == WM_CLOSE) { cancelled = true; return 0; }
  if (message == update_message) {
    std::lock_guard<std::mutex> lock(text_mutex);
    SetWindowTextW(label, status_text.c_str()); SendMessageW(bar, PBM_SETPOS, progress_percent, 0); return 0;
  }
  if (message == done_message) { DestroyWindow(window); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, w, l);
}
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  // Do not load CEF, modern Rust, or WebView2 until after OS selection.
  SetDllDirectoryW(L"");
  // Installer-only read-only check. Runs on Win7 without loading modern Rust or any web engine.
  int argument_count = 0;
  auto arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (arguments && argument_count == 3 && std::wstring(arguments[1]) == L"--check-install-idle") {
    auto directory = fs::path(arguments[2]); LocalFree(arguments);
    try { return installation_busy(directory) ? 16 : 0; } catch (...) { return 2; }
  }
  if (arguments) LocalFree(arguments);
  Options opts;
  try { opts = options(); } catch (const std::exception& e) { MessageBoxW(nullptr, wide(e.what()).c_str(), L"Keepwork", MB_ICONERROR); return 2; }
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS}; InitCommonControlsEx(&controls);
  WNDCLASSW cls{}; cls.lpfnWndProc = window_proc; cls.hInstance = instance; cls.lpszClassName = L"KeepworkCompatibleLauncher";
  cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  RegisterClassW(&cls);
  HWND window = CreateWindowExW(WS_EX_DLGMODALFRAME, cls.lpszClassName, L"Keepwork", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT, 500, 190, nullptr, nullptr, instance, nullptr);
  if (!window) return 2;
  label = CreateWindowW(L"STATIC", L"正在检查运行环境…", WS_CHILD | WS_VISIBLE, 24, 22, 450, 36, window, nullptr, instance, nullptr);
  bar = CreateWindowW(PROGRESS_CLASSW, L"", WS_CHILD | WS_VISIBLE, 24, 64, 450, 20, window, nullptr, instance, nullptr);
  CreateWindowW(L"BUTTON", L"取消", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 390, 103, 84, 28, window, reinterpret_cast<HMENU>(IDCANCEL), instance, nullptr);
  ShowWindow(window, opts.background ? SW_HIDE : SW_SHOW);
  std::thread worker([&] {
    try {
      run(opts, [&](const std::wstring& text, std::uint64_t done, std::uint64_t total) {
        if (cancelled) throw std::runtime_error("Download cancelled");
        { std::lock_guard<std::mutex> lock(text_mutex); status_text = text; progress_percent = total ? static_cast<unsigned>(done * 100 / total) : 0; }
        PostMessageW(window, update_message, 0, 0);
      });
    } catch (const std::exception& e) { if (!cancelled) error_text = wide(e.what()); }
    PostMessageW(window, done_message, 0, 0);
  });
  MSG message{}; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  worker.join();
  if (!error_text.empty()) {
    MessageBoxW(nullptr, (L"无法启动 Keepwork。\n\n" + error_text + L"\n\n已保留原有数据。请检查网络后重新打开；如需重新获取兼容组件，可运行 Keepwork.exe --update-cef。").c_str(), L"Keepwork", MB_OK | MB_ICONERROR);
    return 2;
  }
  return cancelled ? 1 : 0;
}
