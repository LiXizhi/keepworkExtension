#include "native.hpp"
#include "common/archive.hpp"
#include <winhttp.h>
#include <algorithm>
#include <array>
#include <fstream>
#include <stdexcept>
#include <vector>

namespace keepwork {
namespace fs = std::filesystem;
namespace {
void require(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
struct Internet {
  HINTERNET value;
  explicit Internet(HINTERNET handle) : value(handle) {}
  ~Internet() { if (value) WinHttpCloseHandle(value); }
};
std::wstring child_environment(const wchar_t* host_kind) {
  auto inherited = GetEnvironmentStringsW();
  require(inherited != nullptr, "Cannot prepare MCP process environment");
  struct Cleanup { LPWCH value; ~Cleanup() { FreeEnvironmentStringsW(value); } } cleanup{inherited};
  std::vector<std::wstring> variables;
  for (auto current = inherited; *current; current += wcslen(current) + 1) {
    std::wstring variable(current);
    const auto key = variable.substr(0, variable.find(L'='));
    if (_wcsnicmp(key.c_str(), L"KEEPWORK_MCP_RUNTIME_", 21) == 0
      || _wcsicmp(key.c_str(), L"KEEPWORK_MCP_HOST_KIND") == 0
      || _wcsicmp(key.c_str(), L"KEEPWORK_MCP_HOST_VERSION") == 0) continue;
    variables.push_back(std::move(variable));
  }
  variables.push_back(std::wstring(L"KEEPWORK_MCP_HOST_KIND=") + host_kind);
  std::sort(variables.begin(), variables.end(), [](const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(),
      static_cast<int>(right.size()), TRUE) == CSTR_LESS_THAN;
  });
  std::wstring result;
  for (const auto& variable : variables) { result += variable; result += L'\0'; }
  result += L'\0';
  return result;
}
}
McpHealth probe_mcp_health() {
  McpHealth result;
  const auto started = GetTickCount64();
  Internet session(WinHttpOpen(L"Keepwork-MCP-Bootstrap/1", WINHTTP_ACCESS_TYPE_NO_PROXY,
    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session.value) return result;
  WinHttpSetTimeouts(session.value, 750, 750, 750, 750);
  Internet connection(WinHttpConnect(session.value, L"127.0.0.1", 8089, 0));
  if (!connection.value) return result;
  Internet request(WinHttpOpenRequest(connection.value, L"GET", L"/health", nullptr,
    WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
  if (!request.value) return result;
  DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
  if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect))) return result;
  if (!WinHttpSendRequest(request.value, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
    || !WinHttpReceiveResponse(request.value, nullptr)) return result;
  result.responded = true;
  DWORD status = 0, size = sizeof(status);
  if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) || status != 200) return result;
  std::string body;
  std::array<char, 4096> bytes{};
  for (;;) {
    if (GetTickCount64() - started > 2000) return result;
    DWORD count = 0;
    if (!WinHttpReadData(request.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count)) return result;
    if (!count) break;
    if (body.size() + count > 32768) return result;
    body.append(bytes.data(), count);
  }
  return parse_mcp_health(body);
}
McpHealth launch_mcp_process(const fs::path& directory, const std::string& version,
    const std::string& variant, const wchar_t* host_kind, const fs::path& log_directory,
    const Progress& progress) {
  plain_path(directory); plain_path(log_directory); fs::create_directories(log_directory);
  const auto exe = directory / L"bin" / L"keepwork-mcp.exe";
  plain_path(exe);
  require(fs::is_regular_file(exe), "Bundled MCP executable is missing; reinstall Keepwork");
  // Supply real stdio handles to a detached console program and retain failures.
  // Restrict inheritance to stdio; daemon lifetime is independent of the UI.
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  const auto log = log_directory / L"mcp-runtime.log";
  plain_path(log);
  Handle output(CreateFileW(log.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(output.value != INVALID_HANDLE_VALUE && input.value != INVALID_HANDLE_VALUE, "Cannot open MCP startup log");
  auto environment = child_environment(host_kind);
  auto arguments = quote(exe.wstring()) + L" --port 8089";
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  require(attribute_size > 0, "Cannot prepare MCP handle inheritance");
  std::vector<unsigned char> attributes(attribute_size);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  require(InitializeProcThreadAttributeList(list, 1, 0, &attribute_size) != 0, "Cannot initialize MCP handle inheritance");
  struct Cleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Cleanup() { DeleteProcThreadAttributeList(value); } } cleanup{list};
  HANDLE handles[] = {input.value, output.value};
  require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) != 0,
    "Cannot restrict MCP handle inheritance");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = output.value;
  startup.lpAttributeList = list;
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(exe.c_str(), arguments.data(), nullptr, nullptr, TRUE,
    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(), directory.c_str(), &startup.StartupInfo, &child))
    throw std::runtime_error("Cannot start MCP (Windows error " + std::to_string(GetLastError())
      + "); reinstall Keepwork or check required Windows updates");
  Handle process(child.hProcess), thread(child.hThread);
  const auto started = GetTickCount64();
  try {
    for (;;) {
      progress(L"正在启动本地 MCP 服务…", 0, 0);
      auto current = probe_mcp_health();
      if (current.keepwork) {
        if (current.pid != child.dwProcessId) return current;
        require(current.version == version && (variant.empty() || current.variant == variant), "MCP health identity mismatch");
        require(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "MCP exited during health verification");
        current.owned = true;
        return current;
      }
      require(!current.responded, "Port 8089 is occupied by another service; it was left untouched");
      if (WaitForSingleObject(process.value, 100) == WAIT_OBJECT_0) {
        DWORD code = 0; GetExitCodeProcess(process.value, &code);
        throw std::runtime_error("MCP exited before startup confirmation (code " + std::to_string(code) + "); see mcp-runtime.log");
      }
      require(GetTickCount64() - started <= 15000, "MCP startup timed out; see mcp-runtime.log");
    }
  } catch (...) {
    // Never terminate an existing daemon by PID from HTTP or by process name.
    if (WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0) {
      TerminateProcess(process.value, 2); WaitForSingleObject(process.value, 5000);
    }
    throw;
  }
}
void mcp_startup_warning(const fs::path& directory, const std::string& message) {
  try {
    plain_path(directory); fs::create_directories(directory);
    const auto file = directory / L"mcp-startup-error.txt";
    plain_path(file);
    std::ofstream output(file, std::ios::binary | std::ios::trunc);
    output << message << '\n';
  } catch (...) {}
}
void start_compatible_mcp(WindowsVersion os, const Progress& progress) {
  const auto existing = probe_mcp_health();
  if (existing.keepwork) return;
  require(!existing.responded, "Port 8089 is occupied by another service; it was left untouched");
  require(os.major >= 10, "Use the Windows 7/8 edition for its compatible local MCP service");
  const auto root = executable_dir() / L"resources" / L"mcp-runtime";
  plain_path(root);
  auto directory = root / architecture();
  if (!fs::exists(directory / L"runtime.json")) directory = root;
  plain_path(directory);
  const auto file = directory / L"runtime.json";
  plain_path(file);
  require(fs::is_regular_file(file) && fs::file_size(file) <= 2 * 1024 * 1024, "Bundled MCP metadata is missing or invalid");
  std::ifstream input(file, std::ios::binary);
  const auto runtime = nlohmann::json::parse(input);
  require(runtime.at("schemaVersion") == 2 && runtime.at("product") == "keepwork-mcp-runtime"
    && runtime.at("engine") == "rust" && runtime.at("platform") == "windows"
    && runtime.at("arch") == architecture() && runtime.at("entry") == "bin/keepwork-mcp.exe",
    "Bundled MCP identity is invalid; reinstall Keepwork");
  launch_mcp_process(directory, runtime.at("version").get<std::string>(), "", L"cef-desktop",
    local_data() / L"Keepwork", progress);
}
}
