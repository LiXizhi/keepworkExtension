#include "win7_native.hpp"
#include "common/archive.hpp"
#include "common/win7_policy.hpp"
#include <shellapi.h>
#include <nlohmann/json.hpp>
#include <fstream>
#include <regex>
#include <stdexcept>
#include <tuple>

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
void run_candidate(const Candidate& selected, const fs::path& root, const Progress& progress) {
  verify_runtime(selected);
  const auto current = launch_mcp_process(selected.directory, selected.manifest.version,
    "win7-win8", L"win7-win8-desktop", edition_data(), progress);
  // An existing peer is usable without matching our packaged runtime identity.
  // Promote only after confirming this edition's own candidate.
  if (!current.owned) return;
  if (fs::exists(root / L"active.json")) {
    const auto previous = read(root / L"active.json");
    if (previous != selected.envelope) atomic_write(root / L"previous.json", previous);
  }
  atomic_write(root / L"active.json", selected.envelope);
  if (fs::exists(root / L"pending.json") && read(root / L"pending.json") == selected.envelope)
    fs::remove(root / L"pending.json");
}
}
void win7_startup_warning(const std::string& message) {
  mcp_startup_warning(edition_data(), message);
}
void start_win7_mcp(bool update, const Progress& progress) {
  auto root = edition_data() / L"McpRuntimes";
  plain_path(root); fs::create_directories(root / L"versions");
  // The launcher lock also serializes signed runtime promotion and downloads.
  auto existing = probe_mcp_health();
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
