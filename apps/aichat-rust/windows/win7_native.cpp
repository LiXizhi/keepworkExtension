#include "win7_native.hpp"
#include "common/archive.hpp"
#include "common/win7_policy.hpp"
#include <winhttp.h>
#include <shellapi.h>
#include <nlohmann/json.hpp>
#include <array>
#include <algorithm>
#include <fstream>
#include <regex>
#include <stdexcept>
#include <tuple>
#include <vector>

namespace keepwork {
namespace fs = std::filesystem;
namespace {
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
fs::path edition_data() {
  auto directory = local_data() / L"KeepworkWin7Win8";
  plain_path(directory); fs::create_directories(directory); return directory;
}
std::string read(const fs::path& file, std::uint64_t cap = 2 * 1024 * 1024) {
  plain_path(file);
  require(fs::is_regular_file(file) && fs::file_size(file) <= cap, "Invalid Win7 runtime metadata");
  std::ifstream stream(file, std::ios::binary);
  std::string text((std::istreambuf_iterator<char>(stream)), {});
  require(!stream.bad(), "Cannot read Win7 runtime metadata"); return text;
}
void atomic_write(const fs::path& file, const std::string& value) {
  plain_path(file);
  auto temporary = file; temporary += L".tmp";
  std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
  stream.write(value.data(), static_cast<std::streamsize>(value.size())); stream.close();
  require(bool(stream), "Cannot save Win7 runtime metadata");
  require(MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0,
    "Cannot activate Win7 runtime metadata");
}
auto version(const std::string& value) {
  std::smatch match;
  require(std::regex_match(value, match, std::regex("([0-9]{1,9})\\.([0-9]{1,9})\\.([0-9]{1,9})")), "Invalid Win7 version");
  return std::make_tuple(std::stoul(match[1]), std::stoul(match[2]), std::stoul(match[3]));
}
struct Internet {
  HINTERNET value;
  explicit Internet(HINTERNET handle) : value(handle) {}
  ~Internet() { if (value) WinHttpCloseHandle(value); }
};
struct Health { bool responded = false, keepwork = false, win7 = false; DWORD pid = 0; std::string version; };
Health health() {
  Health result;
  const auto started = GetTickCount64();
  Internet session(WinHttpOpen(L"Keepwork-Win7/1", WINHTTP_ACCESS_TYPE_NO_PROXY,
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
  try {
    auto document = nlohmann::json::parse(body);
    result.keepwork = document.value("name", "") == "keepwork-mcp" && document.value("ok", false);
    result.win7 = document.value("runtimeVariant", "") == "win7-win8";
    if (document.contains("pid") && document.at("pid").is_number_unsigned()) {
      auto pid = document.at("pid").get<std::uint64_t>();
      if (pid > 0 && pid <= MAXDWORD) result.pid = static_cast<DWORD>(pid);
    }
    result.version = document.value("runtimeVersion", "");
  } catch (...) { result.keepwork = false; }
  return result;
}
struct Candidate { std::string envelope; Manifest manifest; fs::path directory; };
void verify_runtime(const Candidate& candidate) {
  verify_package(candidate.directory, candidate.manifest, sha256_file);
  auto runtime = nlohmann::json::parse(read(candidate.directory / L"runtime.json"));
  auto signed_metadata = nlohmann::json::parse(verify_envelope(candidate.envelope));
  for (const auto* key : {"schemaVersion", "product", "engine", "variant", "version", "platform", "arch",
      "buildTarget", "entry", "minWindows", "commit", "sourceHash"})
    require(runtime.at(key) == signed_metadata.at(key), "Bundled Win7 MCP identity mismatch");
}
Candidate candidate(const std::string& envelope, const fs::path& directory) {
  Candidate value{envelope, validate_win7_mcp_manifest(verify_envelope(envelope), windows_version()), directory};
  verify_runtime(value); return value;
}
Candidate cache_bundle(const fs::path& root) {
  const auto bundle = executable_dir() / L"resources";
  auto bundled = candidate(read(bundle / L"win7-mcp.signed.json"), bundle / L"win7-mcp");
  auto destination = root / L"versions" / bundled.manifest.sha256;
  plain_path(destination);
  if (!fs::exists(destination)) {
    auto staging = root / (bundled.manifest.sha256 + ".bundled-staging");
    plain_path(staging);
    require(!fs::exists(staging), "An interrupted Win7 MCP staging directory exists; close Keepwork and remove that staging directory before retrying");
    fs::copy(bundled.directory, staging, fs::copy_options::recursive);
    auto staged = bundled; staged.directory = staging; verify_runtime(staged);
    fs::rename(staging, destination);
  }
  return candidate(bundled.envelope, destination);
}
Candidate download_candidate(const fs::path& root, const Progress& progress) {
  const auto envelope = fetch_manifest(std::string(win7_mcp_base) + "windows-x64.json", progress);
  const auto manifest = validate_win7_mcp_manifest(verify_envelope(envelope), windows_version());
  auto destination = root / L"versions" / manifest.sha256;
  plain_path(destination);
  if (!fs::exists(destination)) {
    auto archive = root / (manifest.sha256 + ".zip.part");
    auto staging = root / (manifest.sha256 + ".download-staging");
    plain_path(staging);
    require(!fs::exists(staging), "An interrupted Win7 MCP download staging directory exists; close Keepwork and remove it before retrying");
    try {
      download(std::string(win7_mcp_base) + manifest.version + "/windows-x64.zip", archive, manifest.size, progress);
      require(sha256_file(archive) == manifest.sha256, "Win7 MCP download digest mismatch");
      extract_package(archive, staging, manifest, sha256_file);
      auto staged = candidate(envelope, staging);
      (void)staged;
      fs::rename(staging, destination); fs::remove(archive);
    } catch (...) {
      std::error_code ignored;
      fs::remove(archive, ignored);
      if (fs::exists(staging)) { plain_path(staging); fs::remove_all(staging, ignored); }
      throw;
    }
  }
  auto value = candidate(envelope, destination);
  return value;
}
std::wstring child_environment() {
  auto inherited = GetEnvironmentStringsW();
  require(inherited != nullptr, "Cannot prepare MCP process environment");
  struct Cleanup { LPWCH value; ~Cleanup() { FreeEnvironmentStringsW(value); } } cleanup{inherited};
  std::vector<std::wstring> variables;
  for (auto current = inherited; *current; current += wcslen(current) + 1) {
    std::wstring variable(current);
    const auto separator = variable.find(L'=');
    auto key = variable.substr(0, separator);
    if (_wcsnicmp(key.c_str(), L"KEEPWORK_MCP_RUNTIME_", 21) == 0
      || _wcsicmp(key.c_str(), L"KEEPWORK_MCP_HOST_KIND") == 0
      || _wcsicmp(key.c_str(), L"KEEPWORK_MCP_HOST_VERSION") == 0) continue;
    variables.push_back(std::move(variable));
  }
  variables.push_back(L"KEEPWORK_MCP_HOST_KIND=win7-win8-desktop");
  std::sort(variables.begin(), variables.end(), [](const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(),
      static_cast<int>(right.size()), TRUE) == CSTR_LESS_THAN;
  });
  std::wstring result;
  for (const auto& variable : variables) { result += variable; result += L'\0'; }
  result += L'\0';
  return result;
}
void run_candidate(const Candidate& selected, const fs::path& root, const Progress& progress) {
  verify_runtime(selected);
  auto exe = selected.directory / L"bin" / L"keepwork-mcp.exe";
  auto arguments = quote(exe.wstring()) + L" --port 8089";
  auto environment = child_environment();
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  require(CreateProcessW(exe.c_str(), arguments.data(), nullptr, nullptr, FALSE,
    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
    environment.data(), selected.directory.c_str(), &startup, &child) != 0,
    "Cannot start Windows 7/8 MCP; check the package and required Windows system updates");
  Handle process(child.hProcess), thread(child.hThread);
  const auto started = GetTickCount64();
  try {
    for (;;) {
      progress(L"正在启动 Windows 7/8 本地服务…", 0, 0);
      auto current = health();
      if (current.keepwork) {
        if (current.pid != child.dwProcessId) return;
        require(current.win7 && current.version == selected.manifest.version, "Windows 7/8 MCP health identity mismatch");
        require(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "MCP exited during health verification");
        if (fs::exists(root / L"active.json")) {
          const auto previous = read(root / L"active.json");
          if (previous != selected.envelope) atomic_write(root / L"previous.json", previous);
        }
        atomic_write(root / L"active.json", selected.envelope);
        if (fs::exists(root / L"pending.json") && read(root / L"pending.json") == selected.envelope)
          fs::remove(root / L"pending.json");
        return;
      }
      require(!current.responded, "Port 8089 was occupied by another service; it was left untouched");
      if (WaitForSingleObject(process.value, 100) == WAIT_OBJECT_0)
        throw std::runtime_error("MCP exited before startup confirmation; cloud chat remains available");
      require(GetTickCount64() - started <= 15000, "MCP startup timed out; cloud chat remains available");
    }
  } catch (...) {
    // Only the exact process handle created above can be stopped on failure.
    if (WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0) {
      TerminateProcess(process.value, 2); WaitForSingleObject(process.value, 5000);
    }
    throw;
  }
}
}
void win7_startup_warning(const std::string& message) {
  try { atomic_write(edition_data() / L"mcp-startup-error.txt", message + "\n"); } catch (...) {}
}
void start_win7_mcp(bool update, const Progress& progress) {
  auto root = edition_data() / L"McpRuntimes";
  plain_path(root); fs::create_directories(root / L"versions");
  // The launcher lock also serializes signed runtime promotion and downloads.
  auto existing = health();
  if (existing.keepwork && !update) return;
  require(!existing.responded || existing.keepwork, "Port 8089 is occupied by another service; it was left untouched");
  auto selected = cache_bundle(root);
  std::string failed_digest;
  if (fs::exists(root / L"failed.json")) {
    try { failed_digest = validate_win7_mcp_manifest(verify_envelope(read(root / L"failed.json")), windows_version()).sha256; }
    catch (const std::exception& error) { win7_startup_warning(error.what()); }
  }
  for (const auto* name : {L"active.json", L"pending.json"}) {
    auto file = root / name;
    if (!fs::exists(file)) continue;
    try {
      auto envelope = read(file);
      auto metadata = validate_win7_mcp_manifest(verify_envelope(envelope), windows_version());
      auto cached = candidate(envelope, root / L"versions" / metadata.sha256);
      if (cached.manifest.sha256 == failed_digest) continue;
      if (selected.manifest.sha256 == failed_digest || version(cached.manifest.version) > version(selected.manifest.version)) selected = std::move(cached);
    } catch (const std::exception& error) { win7_startup_warning(error.what()); }
  }
  if (update) {
    auto remote = download_candidate(root, progress);
    require(version(remote.manifest.version) >= version(selected.manifest.version), "Refusing Win7 MCP downgrade");
    require(remote.manifest.version != selected.manifest.version || remote.manifest.sha256 == selected.manifest.sha256,
      "Same Win7 MCP version has different immutable bytes");
    selected = std::move(remote);
    atomic_write(root / L"pending.json", selected.envelope);
  }
  if (existing.keepwork) {
    // Preparing an update never stops an existing daemon or replays its work.
    win7_startup_warning("Win7 MCP update verified and staged. It will be health-checked on the next MCP start; the running daemon was left untouched.");
    return;
  }
  try {
    run_candidate(selected, root, progress);
  } catch (const std::exception& error) {
    win7_startup_warning(error.what());
    atomic_write(root / L"failed.json", selected.envelope);
    if (fs::exists(root / L"pending.json") && read(root / L"pending.json") == selected.envelope) {
      fs::remove(root / L"pending.json");
    }
    if (fs::exists(root / L"active.json")) {
      const auto envelope = read(root / L"active.json");
      auto metadata = validate_win7_mcp_manifest(verify_envelope(envelope), windows_version());
      if (metadata.sha256 != selected.manifest.sha256) {
        auto previous = candidate(envelope, root / L"versions" / metadata.sha256);
        run_candidate(previous, root, progress);
        return;
      }
    }
    throw;
  }
}
void update_win7_client(const Progress& progress) {
  auto payload = verify_envelope(fetch_manifest(std::string(win7_client_base) + "windows-x64/latest-client.json", progress));
  auto manifest = nlohmann::json::parse(payload);
  require(manifest.at("schemaVersion") == 1 && manifest.at("product") == "aichat-desktop"
    && manifest.at("variant") == "win7-win8" && manifest.at("platform") == "windows"
    && manifest.at("arch") == "x64" && manifest.at("format") == "exe"
    && manifest.at("minWindows") == nlohmann::json::array({6, 1, 7601}), "Not a Win7 desktop update");
  const auto release = manifest.at("version").get<std::string>();
  auto installed = nlohmann::json::parse(read(executable_dir() / L"win7-edition.json"));
  require(version(release) > version(installed.at("version").get<std::string>()), "The installed Win7 client is already current");
  const auto file = "Keepwork_Win7_Win8_" + release + "_x64-setup.exe";
  const auto url = std::string(win7_client_base) + release + "/" + file;
  require(manifest.at("fileName") == file && manifest.at("url") == url, "Unexpected Win7 installer URL");
  auto digest = manifest.at("sha256").get<std::string>();
  require(is_sha256(digest) && manifest.at("size").is_number_unsigned(), "Invalid Win7 installer metadata");
  const auto size = manifest.at("size").get<std::uint64_t>();
  require(size > 0 && size <= max_archive_size, "Win7 installer exceeds size limit");
  auto root = edition_data() / L"Updates"; plain_path(root); fs::create_directories(root);
  auto destination = root / (digest + "-setup.exe"), partial = root / (digest + ".part");
  plain_path(destination);
  if (!fs::exists(destination)) {
    download(url, partial, size, progress);
    require(sha256_file(partial) == digest, "Win7 installer download digest mismatch");
    fs::rename(partial, destination);
  }
  require(fs::file_size(destination) == size && sha256_file(destination) == digest, "Cached Win7 installer integrity mismatch");
  auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", destination.c_str(), L"/UPDATE", root.c_str(), SW_SHOWNORMAL));
  require(result > 32, "Cannot open verified Win7 installer");
}
}
