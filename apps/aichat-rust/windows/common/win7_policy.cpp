#include "win7_policy.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <regex>
#include <set>
#include <stdexcept>
#include <tuple>

namespace keepwork {
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return char(std::tolower(c)); });
  return value;
}
}
Manifest validate_win7_mcp_manifest(const std::string& payload, WindowsVersion os) {
  require(payload.size() <= 1024 * 1024, "Win7 MCP manifest exceeds size limit");
  require(std::make_tuple(os.major, os.minor, os.build) >= std::make_tuple(6U, 1U, 7601U), "Windows 7 SP1 is required");
  auto j = nlohmann::json::parse(payload);
  require(j.at("schemaVersion") == 2 && j.at("product") == "keepwork-mcp-runtime"
    && j.at("engine") == "rust" && j.at("variant") == "win7-win8", "Not a Win7 Rust MCP package");
  require(j.at("platform") == "windows" && j.at("arch") == "x64"
    && j.at("buildTarget") == "x86_64-win7-windows-msvc"
    && j.at("entry") == "bin/keepwork-mcp.exe", "Wrong Win7 MCP target or entry");
  require(j.at("minWindows") == nlohmann::json::array({6, 1, 7601}), "Wrong Win7 MCP system baseline");
  require(!j.contains("terminalApi") || j.at("terminalApi").is_null(), "Win7 package cannot advertise PTY");
  require(std::regex_match(j.at("commit").get<std::string>(), std::regex("[a-f0-9]{40}"))
    && is_sha256(j.at("sourceHash").get<std::string>()), "Invalid Win7 MCP provenance");
  Manifest m{};
  m.channel = "win7-win8"; m.arch = "x64";
  m.version = j.at("version").get<std::string>();
  require(std::regex_match(m.version, std::regex("[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}")), "Invalid Win7 MCP version");
  require(j.at("size").is_number_unsigned() && j.at("unpackedSize").is_number_unsigned(), "Invalid Win7 MCP package size");
  m.size = j.at("size").get<std::uint64_t>(); m.unpacked_size = j.at("unpackedSize").get<std::uint64_t>();
  require(m.size > 0 && m.size <= max_archive_size && m.unpacked_size > 0
    && m.unpacked_size <= max_unpacked_size, "Win7 MCP package exceeds limits");
  m.sha256 = j.at("sha256").get<std::string>();
  require(is_sha256(m.sha256), "Invalid Win7 MCP package digest");
  const auto& files = j.at("files");
  require(files.is_array() && files.size() >= 3 && files.size() <= 1000, "Invalid Win7 MCP file list");
  std::set<std::string> names;
  std::uint64_t total = 0;
  for (const auto& file : files) {
    FileRecord record{zip_path(file.at("path").get<std::string>(), false), file.at("sha256").get<std::string>(), 0};
    require(file.at("size").is_number_unsigned(), "Invalid Win7 MCP file size");
    record.size = file.at("size").get<std::uint64_t>();
    require(record.size <= max_archive_size && is_sha256(record.sha256), "Invalid Win7 MCP file metadata");
    require(names.insert(lower(record.path)).second, "Duplicate Win7 MCP path");
    total += record.size;
    require(total <= max_unpacked_size, "Win7 MCP files exceed size limit");
    m.files.push_back(record);
  }
  for (const auto& name : names) {
    for (auto p = name.find('/'); p != std::string::npos; p = name.find('/', p + 1))
      require(!names.count(name.substr(0, p)), "Win7 MCP file/directory collision");
  }
  for (const auto* required : {"runtime.json", "bin/keepwork-mcp.exe", "license"})
    require(names.count(required) != 0, "Incomplete Win7 MCP package");
  require(total == m.unpacked_size, "Win7 MCP unpacked size mismatch");
  // Download locations are fixed by this edition, never accepted from a feed.
  const auto expected = std::string(win7_mcp_base) + m.version + "/windows-x64.zip";
  require(j.at("url") == expected && j.at("fileName") == "windows-x64.zip", "Unexpected Win7 MCP package URL");
  return m;
}
}
