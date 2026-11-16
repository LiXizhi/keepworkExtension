#include <winsock2.h>
#include "native.hpp"
#include "common/archive.hpp"
#include "common/mcp_restart_policy.hpp"
#include "common/mcp_restart_http.hpp"
#include "common/mcp_restart_identity.hpp"
#include <winhttp.h>
#include <iphlpapi.h>
#include <shlobj.h>
#include <algorithm>
#include <array>
#include <fstream>
#include <memory>
#include <regex>
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
struct Listener { DWORD pid = 0; bool loopback = false; };
Listener mcp_listener() {
  DWORD bytes = 0;
  require(GetExtendedTcpTable(nullptr, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) == ERROR_INSUFFICIENT_BUFFER,
    "Cannot inspect the local service listener; no service was stopped");
  for (unsigned attempt = 0; attempt < 3; ++attempt) {
    require(bytes >= offsetof(MIB_TCPTABLE_OWNER_PID, table) && bytes <= 4 * 1024 * 1024,
      "Local listener table exceeds its inspection limit");
    std::vector<unsigned char> buffer(bytes);
    const auto result = GetExtendedTcpTable(buffer.data(), &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (result == ERROR_INSUFFICIENT_BUFFER) continue;
    require(result == NO_ERROR, "Cannot inspect the local service listener; no service was stopped");
    const auto table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(buffer.data());
    const auto maximum = (buffer.size() - offsetof(MIB_TCPTABLE_OWNER_PID, table)) / sizeof(MIB_TCPROW_OWNER_PID);
    require(table->dwNumEntries <= maximum, "Invalid local listener table");
    Listener found;
    for (DWORD index = 0; index < table->dwNumEntries; ++index) {
      const auto& row = table->table[index];
      const auto port = static_cast<unsigned short>((row.dwLocalPort >> 8) | (row.dwLocalPort << 8));
      if (port != 8089) continue;
      require(found.pid == 0, "Multiple services use port 8089; no service was stopped");
      found = {row.dwOwningPid, row.dwLocalAddr == 0x0100007f};
    }
    return found;
  }
  throw std::runtime_error("The local service listener kept changing; retry after it stabilizes");
}
std::uint64_t creation_time(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  require(GetProcessTimes(process, &created, &exited, &kernel, &user) != 0,
    "Cannot verify the local service process creation time");
  return (std::uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
std::vector<unsigned char> process_user(HANDLE process) {
  Handle token;
  require(OpenProcessToken(process, TOKEN_QUERY, &token.value) != 0, "Cannot verify the local service process user");
  DWORD bytes = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
  require(bytes >= sizeof(TOKEN_USER) && bytes <= 65536, "Invalid local service user identity");
  std::vector<unsigned char> user(bytes);
  require(GetTokenInformation(token.value, TokenUser, user.data(), bytes, &bytes) != 0,
    "Cannot verify the local service process user");
  return user;
}
bool same_user(HANDLE process) {
  const auto target = process_user(process), caller = process_user(GetCurrentProcess());
  return EqualSid(reinterpret_cast<const TOKEN_USER*>(target.data())->User.Sid,
    reinterpret_cast<const TOKEN_USER*>(caller.data())->User.Sid) != 0;
}
std::wstring image_path(HANDLE process) {
  std::vector<wchar_t> buffer(32768);
  DWORD length = static_cast<DWORD>(buffer.size());
  require(QueryFullProcessImageNameW(process, 0, buffer.data(), &length) != 0 && length > 3 && length < buffer.size(),
    "Cannot verify the local service executable path");
  return {buffer.data(), length};
}
std::wstring local_drive_path(std::wstring path) {
  if (path.compare(0, 4, L"\\\\?\\") == 0) path.erase(0, 4);
  require(!restart_path(path).empty(), "The local service identity is not on a local drive");
  return path;
}
std::wstring held_file_path(HANDLE file) {
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetFinalPathNameByHandleW(file, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  require(length > 4 && length < buffer.size(), "Cannot resolve the local service executable path");
  return local_drive_path({buffer.data(), length});
}
std::string held_file_bytes(HANDLE file, std::uint64_t cap) {
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file, &size) != 0 && size.QuadPart > 0 && std::uint64_t(size.QuadPart) <= cap,
    "The local service identity file exceeds its size limit");
  std::string bytes(static_cast<std::size_t>(size.QuadPart), '\0');
  LARGE_INTEGER beginning{};
  require(SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN) != 0, "Cannot read the local service identity");
  DWORD received = 0;
  require(ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr) != 0 && received == bytes.size(),
    "Cannot read the local service identity");
  return bytes;
}
struct RestartSocket {
  SOCKET value = INVALID_SOCKET;
  RestartSocket() {
    WSADATA data{};
    require(WSAStartup(MAKEWORD(2, 2), &data) == 0, "Cannot prepare a local restart connection");
  }
  ~RestartSocket() { if (value != INVALID_SOCKET) closesocket(value); WSACleanup(); }
  void Connect() {
    value = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    require(value != INVALID_SOCKET, "Cannot create a local restart connection");
    u_long nonblocking = 1;
    require(ioctlsocket(value, FIONBIO, &nonblocking) == 0, "Cannot bound a local restart connection");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = 0x0100007f;
    address.sin_port = htons(8089);
    if (connect(value, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) {
      require(WSAGetLastError() == WSAEWOULDBLOCK, "Local restart connection failed");
      fd_set ready{}, failed{}; FD_ZERO(&ready); FD_ZERO(&failed); FD_SET(value, &ready); FD_SET(value, &failed);
      timeval timeout{2, 0};
      require(select(0, nullptr, &ready, &failed, &timeout) > 0 && FD_ISSET(value, &ready) && !FD_ISSET(value, &failed),
        "Local restart connection timed out");
      int error = 0, length = sizeof(error);
      require(getsockopt(value, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &length) == 0 && error == 0,
        "Local restart connection failed");
    }
    nonblocking = 0;
    require(ioctlsocket(value, FIONBIO, &nonblocking) == 0, "Cannot prepare a local restart connection");
    const DWORD timeout = 2000;
    require(setsockopt(value, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) == 0
      && setsockopt(value, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) == 0,
      "Cannot bound local restart requests");
  }
  void Send(const std::string& message) {
    std::size_t written = 0;
    while (written < message.size()) {
      const auto sent = send(value, message.data() + written, static_cast<int>(message.size() - written), 0);
      require(sent > 0, "Local restart request failed");
      written += sent;
    }
  }
  RestartHttpResponse Receive() {
    std::string bytes;
    char buffer[4096];
    const auto began = GetTickCount64();
    for (;;) {
      require(GetTickCount64() - began <= 3000, "Local restart response timed out");
      const auto count = recv(value, buffer, sizeof(buffer), 0);
      require(count > 0, "Local restart response ended unexpectedly");
      bytes.append(buffer, count);
      if (auto response = restart_http_response(bytes)) return *response;
    }
  }
  DWORD ServerPid() const {
    sockaddr_in local{};
    int address_bytes = sizeof(local);
    require(getsockname(value, reinterpret_cast<sockaddr*>(&local), &address_bytes) == 0
      && local.sin_family == AF_INET && local.sin_addr.s_addr == 0x0100007f,
      "Cannot bind the local restart connection identity");
    DWORD bytes = 0;
    require(GetExtendedTcpTable(nullptr, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) == ERROR_INSUFFICIENT_BUFFER,
      "Cannot inspect the accepted restart connection owner");
    for (unsigned attempt = 0; attempt < 3; ++attempt) {
      require(bytes >= offsetof(MIB_TCPTABLE_OWNER_PID, table) && bytes <= 4 * 1024 * 1024,
        "Accepted restart connection table exceeds its limit");
      std::vector<unsigned char> storage(bytes);
      const auto result = GetExtendedTcpTable(storage.data(), &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
      if (result == ERROR_INSUFFICIENT_BUFFER) continue;
      require(result == NO_ERROR, "Cannot inspect the accepted restart connection owner");
      const auto table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(storage.data());
      const auto maximum = (storage.size() - offsetof(MIB_TCPTABLE_OWNER_PID, table)) / sizeof(MIB_TCPROW_OWNER_PID);
      require(table->dwNumEntries <= maximum, "Invalid accepted restart connection table");
      DWORD found = 0;
      for (DWORD index = 0; index < table->dwNumEntries; ++index) {
        const auto& row = table->table[index];
        if (row.dwLocalAddr == 0x0100007f && static_cast<unsigned short>(row.dwLocalPort) == htons(8089)
            && row.dwRemoteAddr == local.sin_addr.s_addr && static_cast<unsigned short>(row.dwRemotePort) == local.sin_port) {
          require(found == 0, "Ambiguous accepted restart connection owner");
          found = row.dwOwningPid;
        }
      }
      return found;
    }
    throw std::runtime_error("Accepted restart connection owner kept changing");
  }
};
std::string restart_authorization() {
  PWSTR profile = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Profile, KF_FLAG_DONT_VERIFY, nullptr, &profile))) return {};
  struct Release { PWSTR value; ~Release() { CoTaskMemFree(value); } } release{profile};
  try {
    const auto path = fs::path(profile) / L".keepwork-mcp" / L"token";
    plain_path(path);
    Handle token(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (token.value == INVALID_HANDLE_VALUE) return {};
    auto value = held_file_bytes(token.value, 4096);
    const auto begin = value.find_first_not_of(" \t\r\n"), end = value.find_last_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    value = value.substr(begin, end - begin + 1);
    for (const unsigned char character : value) if (character <= 32 || character >= 127) return {};
    return "Authorization: Bearer " + value + "\r\n";
  } catch (...) { return {}; }
}
// A restart targets one held OS process, never a PID copied into a kill command
// or an unbound HTTP POST that could reach a replacement listener. Stopping a
// prior preview package is an ownership decision, not permission to execute it:
// the selected replacement still passes the current pinned-key package checks.
class ManagedMcpProcess {
 public:
  ManagedMcpProcess(const McpHealth& health, const fs::path& cache, const fs::path& bundle)
    : health_(health) {
    require(health.pid != 0 && health.pid != GetCurrentProcessId(), "The service did not provide a usable process identity");
    process_.value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, health.pid);
    require(process_.value != nullptr, "Cannot access the managed local service process");
    identity_.health_pid = health.pid;
    identity_.process_pid = GetProcessId(process_.value);
    identity_.created = creation_time(process_.value);
    const auto image = fs::path(image_path(process_.value));
    plain_path(image); plain_path(cache); plain_path(bundle);
    image_.value = CreateFileW(image.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(image_.value != INVALID_HANDLE_VALUE, "Cannot lock the local service executable identity");
    identity_.image = held_file_path(image_.value);
    identity_.cache_root = local_drive_path(fs::canonical(cache).wstring());
    identity_.bundle_root = local_drive_path(fs::canonical(bundle).wstring());
    require(restart_edition_image_path(identity_.image, identity_.cache_root, identity_.bundle_root),
      "当前 MCP 由其它应用或未知位置管理，请在对应应用中重启；此处不会停止它。");
    const auto metadata = fs::path(identity_.image).parent_path().parent_path() / L"runtime.json";
    plain_path(metadata);
    metadata_.value = CreateFileW(metadata.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(metadata_.value != INVALID_HANDLE_VALUE, "Cannot verify the managed local service metadata");
    const auto runtime = nlohmann::json::parse(held_file_bytes(metadata_.value, 2 * 1024 * 1024));
    identity_.managed_runtime = mcp_restart_runtime_identity(runtime, held_file_bytes(image_.value, 128 * 1024 * 1024), health);
    identity_.same_user = same_user(process_.value);
    Recheck();
  }
  void Recheck() {
    const auto current = probe_mcp_health();
    const auto listener = mcp_listener();
    identity_.keepwork = current.keepwork && current.pid == health_.pid && current.version == health_.version && current.commit == health_.commit;
    identity_.engine = current.engine; identity_.variant = current.variant; identity_.host_kind = current.host_kind;
    identity_.listener_pid = listener.loopback ? listener.pid : 0;
    identity_.process_alive = WaitForSingleObject(process_.value, 0) == WAIT_TIMEOUT;
    identity_.rechecked_created = creation_time(process_.value);
    plain_path(fs::path(identity_.image));
    require(restart_path(held_file_path(image_.value)) == restart_path(identity_.image)
      && restart_path(local_drive_path(fs::canonical(image_path(process_.value)).wstring())) == restart_path(identity_.image)
      && restart_owned_mcp(identity_),
      "当前 MCP 归属或进程身份已改变，未停止任何服务；请在对应管理应用中重启。");
  }
  void Stop() {
    // The caller already obtained the user's explicit interruption confirmation.
    // This handle refers to the inspected process even if its PID is later reused.
    // Prefer the existing orderly shutdown route on a socket proven to belong
    // to this exact process. This connection never automatically reconnects.
    // Once a POST may have been sent, allow its asynchronous cleanup to finish.
    if (GracefulStop() && WaitForSingleObject(process_.value, 5000) == WAIT_OBJECT_0) return;
    if (WaitForSingleObject(process_.value, 0) == WAIT_OBJECT_0) return;
    require(creation_time(process_.value) == identity_.created && GetProcessId(process_.value) == identity_.process_pid,
      "The confirmed local service process identity changed");
    require(TerminateProcess(process_.value, 0) != 0, "Cannot stop the confirmed managed local service");
  }
  void Wait(const Progress& progress) {
    progress(L"正在等待本地 MCP 服务退出…", 0, 0);
    require(WaitForSingleObject(process_.value, 10000) == WAIT_OBJECT_0,
      "本地 MCP 未在限定时间内退出，未启动第二个服务。");
  }
 private:
  bool GracefulStop() {
    bool attempted = false;
    try {
      RestartSocket connection;
      connection.Connect();
      require(connection.ServerPid() == identity_.process_pid, "Restart connection reached another process");
      connection.Send("GET /health HTTP/1.1\r\nHost: 127.0.0.1:8089\r\nConnection: keep-alive\r\nAccept: application/json\r\n\r\n");
      const auto response = connection.Receive();
      require(response.status == 200 && response.keep_alive, "Restart connection is not persistent");
      const auto current = parse_mcp_health(response.body);
      require(current.keepwork && current.pid == identity_.process_pid && current.version == health_.version
        && current.commit == health_.commit && current.engine == "rust" && current.variant == "win7-win8"
        && current.host_kind == "win7-win8-desktop" && connection.ServerPid() == identity_.process_pid
        && creation_time(process_.value) == identity_.created && WaitForSingleObject(process_.value, 0) == WAIT_TIMEOUT,
        "Restart connection no longer belongs to the confirmed local service");
      const auto authorization = restart_authorization();
      const auto request = "POST /admin/stop HTTP/1.1\r\nHost: 127.0.0.1:8089\r\nConnection: close\r\n"
        "Content-Length: 0\r\nAccept: application/json\r\n" + authorization + "\r\n";
      attempted = true;
      connection.Send(request);
      // A lost reply does not justify replaying this mutation. The caller waits
      // for the same process to exit, then may terminate only that held handle.
      (void)connection.Receive();
      return true;
    } catch (...) { return attempted; }
  }
  McpHealth health_;
  McpRestartIdentity identity_;
  Handle process_, image_, metadata_;
};
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
bool restart_managed_mcp(const fs::path& cache_root, const fs::path& bundle_root,
    const Progress& progress, const std::function<void()>& prepare,
    const std::function<void(const McpHealth&)>& validate_running,
    const std::function<bool()>& confirm, const std::function<void()>& start) {
  const auto existing = probe_mcp_health();
  require(!existing.responded || existing.keepwork, "Port 8089 belongs to another service; it was left untouched");
  std::unique_ptr<ManagedMcpProcess> process;
  McpRestartOperations operations;
  operations.prepare = prepare;
  operations.validate_owner = [&] {
    process = std::make_unique<ManagedMcpProcess>(existing, cache_root, bundle_root);
    validate_running(existing);
  };
  operations.confirm = confirm;
  operations.recheck = [&] { process->Recheck(); };
  operations.stop = [&] { progress(L"正在重启本地 MCP 服务…", 0, 0); process->Stop(); };
  operations.wait_exit = [&] { process->Wait(progress); };
  operations.start = [&] {
    require(mcp_listener().pid == 0 && !probe_mcp_health().responded,
      "Port 8089 was claimed by another service; it was left untouched");
    start();
  };
  return perform_mcp_restart(existing.keepwork, operations);
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
