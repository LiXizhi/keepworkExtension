#include "native.hpp"
#include "common/archive.hpp"
#include "release-key.hpp"
#ifndef KEEPWORK_WIN7_EDITION
#include <wrl.h>
#include <WebView2.h>
#endif
#include "common/win7_policy.hpp"
#include <winhttp.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <nlohmann/json.hpp>
#include <array>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <vector>

namespace keepwork {
namespace fs = std::filesystem;
#ifndef KEEPWORK_WIN7_EDITION
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
#endif
namespace {
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void nt(NTSTATUS status) { check(status >= 0, "Windows cryptography operation failed"); }
struct Algorithm {
  BCRYPT_ALG_HANDLE handle = nullptr;
  explicit Algorithm(LPCWSTR id) { nt(BCryptOpenAlgorithmProvider(&handle, id, nullptr, 0)); }
  ~Algorithm() { if (handle) BCryptCloseAlgorithmProvider(handle, 0); }
};
struct Hasher {
  Algorithm algorithm{BCRYPT_SHA256_ALGORITHM};
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<unsigned char> object;
  Hasher() {
    DWORD size = 0, result = 0;
    nt(BCryptGetProperty(algorithm.handle, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &result, 0));
    object.resize(size);
    nt(BCryptCreateHash(algorithm.handle, &hash, object.data(), size, nullptr, 0, 0));
  }
  ~Hasher() { if (hash) BCryptDestroyHash(hash); }
  void add(const void* bytes, ULONG size) { nt(BCryptHashData(hash, (PUCHAR)bytes, size, 0)); }
  std::array<unsigned char, 32> finish() {
    std::array<unsigned char, 32> result{};
    nt(BCryptFinishHash(hash, result.data(), static_cast<ULONG>(result.size()), 0)); return result;
  }
};
std::vector<unsigned char> unhex(const std::string& hex) {
  check(hex.size() % 2 == 0 && hex.find_first_not_of("0123456789abcdef") == std::string::npos, "Invalid hexadecimal signature");
  std::vector<unsigned char> out;
  for (std::size_t i = 0; i < hex.size(); i += 2) out.push_back(static_cast<unsigned char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  return out;
}
std::string hex(const unsigned char* bytes, std::size_t size) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string result;
  for (std::size_t i = 0; i < size; ++i) { result += alphabet[bytes[i] >> 4]; result += alphabet[bytes[i] & 15]; }
  return result;
}
struct Internet {
  HINTERNET handle;
  explicit Internet(HINTERNET h) : handle(h) { check(h != nullptr, "Cannot open HTTPS connection"); }
  ~Internet() { WinHttpCloseHandle(handle); }
};
void fetch(const std::string& url, std::uint64_t limit, const std::function<void(const char*, DWORD)>& consume, const Progress& progress) {
  bool allowed = url.rfind(cdn_base, 0) == 0;
#ifdef KEEPWORK_WIN7_EDITION
  allowed = allowed || url.rfind(win7_mcp_base, 0) == 0 || url.rfind(win7_client_base, 0) == 0;
#endif
  check(allowed && url.find_first_of("?#\\") == std::string::npos, "Unexpected download origin");
  auto address = wide(url);
  URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts); parts.dwHostNameLength = parts.dwUrlPathLength = DWORD(-1);
  check(WinHttpCrackUrl(address.c_str(), 0, 0, &parts) && parts.nScheme == INTERNET_SCHEME_HTTPS && parts.nPort == 443, "Invalid HTTPS download URL");
  Internet session(WinHttpOpen(L"Keepwork-CEF-Bootstrap/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
  DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
  check(WinHttpSetOption(session.handle, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols)), "TLS 1.2 is unavailable; update Windows TLS support");
  WinHttpSetTimeouts(session.handle, 10000, 10000, 10000, 15000);
  Internet connection(WinHttpConnect(session.handle, std::wstring(parts.lpszHostName, parts.dwHostNameLength).c_str(), parts.nPort, 0));
  Internet request(WinHttpOpenRequest(connection.handle, L"GET", std::wstring(parts.lpszUrlPath, parts.dwUrlPathLength).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
  DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
  check(WinHttpSetOption(request.handle, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect)), "Cannot restrict download redirects");
  progress(L"正在连接下载服务器…", 0, limit);
  check(WinHttpSendRequest(request.handle, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(request.handle, nullptr), "HTTPS request failed; check network, Windows TLS 1.2 and trusted root certificates");
  DWORD status = 0, status_size = sizeof(status);
  check(WinHttpQueryHeaders(request.handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX), "Invalid HTTP response");
  if (status != 200) throw std::runtime_error("CEF download HTTP " + std::to_string(status));
  std::array<char, 64 * 1024> bytes{};
  std::uint64_t total = 0;
  for (;;) {
    progress(L"正在下载兼容组件…", total, limit);
    DWORD count = 0;
    check(WinHttpReadData(request.handle, bytes.data(), static_cast<DWORD>(bytes.size()), &count), "CEF download interrupted");
    if (!count) break;
    total += count;
    check(total <= limit, "Download exceeds signed size limit");
    consume(bytes.data(), count);
  }
}
}
std::wstring wide(const std::string& text) {
  if (text.empty()) return {};
  auto n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  check(n > 0, "Invalid UTF-8"); std::wstring out(n, 0);
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), out.data(), n); return out;
}
std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  auto n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  check(n > 0, "Invalid Unicode"); std::string out(n, 0);
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr); return out;
}
std::wstring quote(const std::wstring& argument) {
  std::wstring out = L"\""; std::size_t slashes = 0;
  for (auto c : argument) {
    if (c == L'\\') { ++slashes; continue; }
    if (c == L'\"') out.append(slashes * 2 + 1, L'\\'); else out.append(slashes, L'\\');
    slashes = 0; out += c;
  }
  out.append(slashes * 2, L'\\'); return out + L"\"";
}
fs::path executable_dir() {
  std::array<wchar_t, 32768> path{}; DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  check(n && n < path.size(), "Cannot locate launcher"); return fs::path(std::wstring(path.data(), n)).parent_path();
}
fs::path local_data() {
  wchar_t path[MAX_PATH]{}; check(SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA | CSIDL_FLAG_CREATE, nullptr, SHGFP_TYPE_CURRENT, path)), "Cannot locate user data folder"); return path;
}
WindowsVersion windows_version() {
  using GetVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto fn = reinterpret_cast<GetVersion>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW v{}; v.dwOSVersionInfoSize = sizeof(v);
  check(fn && fn(&v) == 0, "Cannot determine Windows version"); return {v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber};
}
const char* architecture() {
#if defined(_M_ARM64)
  return "arm64";
#elif defined(_M_X64)
  return "x64";
#else
  return "x86";
#endif
}
bool probe_webview(const fs::path& probe_profile, const Progress& progress) {
#ifdef KEEPWORK_WIN7_EDITION
  (void)probe_profile; (void)progress;
  return false;
#else
  progress(L"正在检查 WebView2…", 0, 0);
  plain_path(probe_profile); fs::create_directories(probe_profile);
  auto path = executable_dir() / L"WebView2Loader.dll";
  HMODULE loader = LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!loader) return false;
  // Keep loader mapped until process exit: async callbacks may finish after the timeout.
  using CreateEnvironment = HRESULT(STDAPICALLTYPE*)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);
  auto create = reinterpret_cast<CreateEnvironment>(GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"));
  if (!create) return false;
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return false;
  struct ComCleanup { ~ComCleanup() { CoUninitialize(); } } cleanup;
  HWND window = CreateWindowExW(0, L"STATIC", L"Keepwork WebView2 probe", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!window) return false;
  struct Probe { bool done = false, ok = false, cancelled = false; HWND window = nullptr; };
  auto state = std::make_shared<Probe>(); state->window = window;
  auto handler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([state](HRESULT error, ICoreWebView2Environment* environment) -> HRESULT {
    if (state->cancelled) return S_OK;
    if (FAILED(error) || !environment) { state->done = true; return S_OK; }
    auto controller = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([state](HRESULT result, ICoreWebView2Controller* control) -> HRESULT {
      if (control) control->Close();
      if (!state->cancelled) { state->ok = SUCCEEDED(result) && control; state->done = true; }
      return S_OK;
    });
    if (FAILED(environment->CreateCoreWebView2Controller(state->window, controller.Get()))) state->done = true;
    return S_OK;
  });
  HRESULT result = create(nullptr, probe_profile.c_str(), nullptr, handler.Get());
  const auto start = GetTickCount64();
  try {
    while (SUCCEEDED(result) && !state->done && GetTickCount64() - start < 15000) {
      progress(L"正在检查 WebView2…", 0, 0);
      MSG message{}; while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
      Sleep(20);
    }
  } catch (...) { state->cancelled = true; DestroyWindow(window); throw; }
  state->cancelled = true; DestroyWindow(window); return state->ok;
#endif
}
std::string sha256_file(const fs::path& path) {
  plain_path(path); std::ifstream file(path, std::ios::binary); check(bool(file), "Cannot hash runtime file");
  Hasher hash; std::array<char, 64 * 1024> buffer{};
  while (file) { file.read(buffer.data(), buffer.size()); if (file.gcount()) hash.add(buffer.data(), static_cast<ULONG>(file.gcount())); }
  check(file.eof(), "Cannot read runtime file"); auto digest = hash.finish(); return hex(digest.data(), digest.size());
}
std::string verify_envelope(const std::string& envelope) {
  check(envelope.size() <= 2 * 1024 * 1024, "Signed manifest too large");
  auto json = nlohmann::json::parse(envelope);
  check(json.at("algorithm") == "rsa-sha256", "Unknown release signature algorithm");
  auto payload = json.at("payload").get<std::string>(); check(payload.size() <= 1024 * 1024, "Release payload too large");
  auto raw_signature = json.at("signature").get<std::string>(); check(raw_signature.size() == 512, "Invalid RSA-2048 signature size");
  auto signature = unhex(raw_signature);
  Algorithm rsa(BCRYPT_RSA_ALGORITHM); BCRYPT_KEY_HANDLE key = nullptr;
  nt(BCryptImportKeyPair(rsa.handle, nullptr, BCRYPT_RSAPUBLIC_BLOB, &key, const_cast<PUCHAR>(release_public_key), sizeof(release_public_key), 0));
  struct KeyCleanup { BCRYPT_KEY_HANDLE key; ~KeyCleanup() { BCryptDestroyKey(key); } } cleanup{key};
  Hasher hash; hash.add(payload.data(), static_cast<ULONG>(payload.size())); auto digest = hash.finish();
  BCRYPT_PKCS1_PADDING_INFO padding{BCRYPT_SHA256_ALGORITHM};
  check(BCryptVerifySignature(key, &padding, digest.data(), static_cast<ULONG>(digest.size()), signature.data(), static_cast<ULONG>(signature.size()), BCRYPT_PAD_PKCS1) >= 0, "CEF release signature is invalid");
  return payload;
}
std::string fetch_manifest(const std::string& url, const Progress& progress) {
  std::string body; fetch(url, 2 * 1024 * 1024, [&](const char* b, DWORD n) { body.append(b, n); }, progress); return body;
}
void download(const std::string& url, const fs::path& path, std::uint64_t size, const Progress& progress) {
  plain_path(path); std::ofstream file(path, std::ios::binary | std::ios::trunc); check(bool(file), "Cannot create download file");
  std::uint64_t total = 0;
  fetch(url, size, [&](const char* b, DWORD n) { file.write(b, n); check(bool(file), "Cannot write download (disk full?)"); total += n; }, progress);
  file.close(); check(bool(file) && total == size, "Incomplete CEF download");
}
void allow_sandbox_read(const fs::path& path) {
  // Modern CEF's LPAC sandbox must read the SDK files under LocalAppData.
  plain_path(path);
  PSID packages = nullptr, restricted = nullptr;
  check(ConvertStringSidToSidW(L"S-1-15-2-1", &packages) && ConvertStringSidToSidW(L"S-1-15-2-2", &restricted), "Cannot create sandbox SID");
  struct Sids { PSID a, b; ~Sids() { LocalFree(a); LocalFree(b); } } sids{packages, restricted};
  PACL previous = nullptr, updated = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  check(GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &previous, nullptr, &descriptor) == ERROR_SUCCESS, "Cannot read runtime ACL");
  struct Local { void* value; ~Local() { if (value) LocalFree(value); } } old{descriptor};
  EXPLICIT_ACCESSW entries[2]{};
  for (unsigned i = 0; i < 2; ++i) {
    entries[i].grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    entries[i].grfAccessMode = GRANT_ACCESS; entries[i].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID; entries[i].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    entries[i].Trustee.ptstrName = static_cast<LPWSTR>(i == 0 ? packages : restricted);
  }
  check(SetEntriesInAclW(2, entries, previous, &updated) == ERROR_SUCCESS, "Cannot grant sandbox read access");
  Local acl{updated};
  check(SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr) == ERROR_SUCCESS, "Cannot apply sandbox runtime ACL");
}
bool launch_cef(const fs::path& directory, const fs::path& profile, bool background, const Progress& progress) {
  plain_path(directory); plain_path(profile); fs::create_directories(profile);
  std::array<unsigned char, 16> random{}; nt(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG));
  auto name = L"Local\\Keepwork.Cef.Ready." + wide(hex(random.data(), random.size()));
  Handle ready(CreateEventW(nullptr, TRUE, FALSE, name.c_str())); check(ready.value != nullptr, "Cannot create startup event");
  auto exe = directory / L"keepwork-cef.exe";
  auto args = quote(exe.wstring()) + L" --profile " + quote(profile.wstring()) + L" --ready-event " + quote(name) + (background ? L" --background" : L"");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
  check(CreateProcessW(exe.c_str(), args.data(), nullptr, nullptr, FALSE, 0, nullptr, directory.c_str(), &startup, &child), "Cannot launch CEF host (check Windows version and package architecture)");
  Handle process(child.hProcess), thread(child.hThread);
  const auto start = GetTickCount64();
  try {
    for (;;) {
      progress(L"正在启动兼容窗口…", 0, 0);
      if (WaitForSingleObject(ready.value, 100) == WAIT_OBJECT_0) return true;
      if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
        DWORD code = 0; GetExitCodeProcess(process.value, &code);
        if (code == 17) throw std::runtime_error("Keepwork CEF is already open; close it before switching or updating the runtime");
        throw std::runtime_error("CEF host exited before startup confirmation (code " + std::to_string(code) + ")");
      }
      if (GetTickCount64() - start > 45000) throw std::runtime_error("CEF host startup timed out");
    }
  } catch (...) {
    // Only this candidate process is ours. Never kill an existing desktop/MCP by name or port.
    TerminateProcess(process.value, 2); WaitForSingleObject(process.value, 5000); throw;
  }
}
bool launch_desktop(const fs::path& exe, bool background, const Progress& progress) {
  check(fs::is_regular_file(exe), "The Rust desktop executable is missing; reinstall Keepwork");
  std::array<unsigned char, 16> random{}; nt(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG));
  auto name = L"Local\\Keepwork.WebView.Ready." + wide(hex(random.data(), random.size()));
  Handle ready(CreateEventW(nullptr, TRUE, FALSE, name.c_str())); check(ready.value != nullptr, "Cannot create desktop startup event");
  auto args = quote(exe.wstring()) + L" --webview-ready-event " + quote(name) + (background ? L" --background" : L"");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
  check(CreateProcessW(exe.c_str(), args.data(), nullptr, nullptr, FALSE, 0, nullptr, exe.parent_path().c_str(), &startup, &child), "Cannot start the Rust desktop client");
  Handle process(child.hProcess), thread(child.hThread);
  auto started = GetTickCount64();
  for (;;) {
    progress(L"正在打开 Keepwork…", 0, 0);
    if (WaitForSingleObject(ready.value, 100) == WAIT_OBJECT_0) return true;
    if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
      DWORD code = 0; GetExitCodeProcess(process.value, &code);
      if (code == 86) return false; // Explicit main-webview creation failure, not a generic crash.
      if (code == 0) return true; // Existing instance was activated.
      throw std::runtime_error("Desktop exited unexpectedly; no automatic replay or engine switch (code " + std::to_string(code) + ")");
    }
    check(GetTickCount64() - started <= 60000, "Desktop startup not confirmed; it may still be starting. No automatic engine switch was performed");
  }
}
bool installation_busy(const fs::path& directory) {
  const auto installation = fs::weakly_canonical(directory).wstring() + L"\\";
  const auto cache = (local_data() / L"Keepwork" / L"BrowserRuntimes").wstring() + L"\\";
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  check(snapshot.value != INVALID_HANDLE_VALUE, "Cannot inspect running Keepwork processes");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  for (BOOL found = Process32FirstW(snapshot.value, &entry); found; found = Process32NextW(snapshot.value, &entry)) {
    if (entry.th32ProcessID == GetCurrentProcessId()) continue;
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID));
    if (!process.value) continue;
    std::array<wchar_t, 32768> image{}; DWORD size = static_cast<DWORD>(image.size());
    if (!QueryFullProcessImageNameW(process.value, 0, image.data(), &size)) continue;
    std::wstring path(image.data(), size);
    auto under = [&](const std::wstring& root) { return path.size() > root.size() && CompareStringOrdinal(path.data(), static_cast<int>(root.size()), root.data(), static_cast<int>(root.size()), TRUE) == CSTR_EQUAL; };
    auto name = fs::path(path).filename().wstring();
    if ((under(installation) && (_wcsicmp(name.c_str(), L"aichat-rust.exe") == 0 || _wcsicmp(name.c_str(), L"Keepwork.exe") == 0)) ||
        (under(cache) && _wcsicmp(name.c_str(), L"keepwork-cef.exe") == 0)) return true;
  }
  return false;
}
bool cef_running() {
  Handle mutex(OpenMutexW(SYNCHRONIZE, FALSE, L"Local\\Keepwork.CEF.Desktop"));
  return mutex.value != nullptr || GetLastError() == ERROR_ACCESS_DENIED;
}
}
