#include "policy.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>
#include <tuple>

namespace keepwork {
namespace {
void require(bool value, const char* error) { if (!value) throw std::runtime_error(error); }
std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
  return s;
}
auto tuple(WindowsVersion v) { return std::make_tuple(v.major, v.minor, v.build); }
}
bool is_sha256(const std::string& s) {
  return s.size() == 64 && s.find_first_not_of("0123456789abcdef") == std::string::npos;
}
std::string select_channel(WindowsVersion os, bool ready) {
  if (os.major == 6 && os.minor >= 1 && os.minor <= 3) {
    require(os.minor != 1 || os.build >= 7601, "Windows 7 SP1 or later is required");
    return "legacy";
  }
  require(os.major >= 10, "Unsupported Windows version");
  return ready ? "" : "modern";
}
std::string zip_path(const std::string& input, bool directory) {
  require(!input.empty() && input.size() < 180, "Invalid archive path length");
  std::string s = input;
  if (directory && s.back() == '/') s.pop_back();
  require(!s.empty() && s.front() != '/' && s.back() != '/', "Absolute or empty archive path");
  require(s.find_first_of("\\:<>\"|?*") == std::string::npos, "Invalid Windows archive path");
  // Runtime distribution filenames are ASCII. This also makes case collision checks deterministic.
  for (unsigned char c : s) require(c >= 32 && c < 127, "Invalid archive filename encoding");
  std::size_t start = 0;
  while (start < s.size()) {
    auto end = s.find('/', start);
    auto part = s.substr(start, end == std::string::npos ? end : end - start);
    require(!part.empty() && part != "." && part != ".." && part.back() != '.' && part.back() != ' ', "Unsafe archive component");
    auto stem = lower(part.substr(0, part.find('.')));
    require(stem != "con" && stem != "prn" && stem != "aux" && stem != "nul" && stem != "conin$" && stem != "conout$", "Reserved Windows filename");
    require(!(stem.size() == 4 && (stem.substr(0, 3) == "com" || stem.substr(0, 3) == "lpt") && stem[3] >= '0' && stem[3] <= '9'), "Reserved Windows device");
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return s;
}
Manifest validate_manifest(const std::string& payload, const std::string& channel,
                           const std::string& arch, WindowsVersion os) {
  require(payload.size() <= 1024 * 1024, "Manifest too large");
  auto j = nlohmann::json::parse(payload);
  require(j.at("schemaVersion") == 1 && j.at("product") == "keepwork-aichat-cef" && j.at("hostProtocol") == 1, "Unsupported CEF host contract");
  require(channel == "legacy" || channel == "modern", "Unknown CEF channel");
  require(arch == "x64" || arch == "x86" || arch == "arm64", "Unknown architecture");
  require(j.at("channel") == channel && j.at("arch") == arch && j.at("entry") == "keepwork-cef.exe", "CEF package target mismatch");
  require(channel != "legacy" || arch != "arm64", "No Windows 7 ARM64 runtime");
  require(select_channel(os, false) == channel, "CEF channel does not match Windows");
  const auto& min = j.at("minWindows");
  require(min.is_array() && min.size() == 3, "Invalid minimum Windows version");
  for (const auto& n : min) require(n.is_number_unsigned() && n.get<std::uint64_t>() <= 1000000, "Invalid Windows version component");
  WindowsVersion minimum{min[0].get<unsigned>(), min[1].get<unsigned>(), min[2].get<unsigned>()};
  require(tuple(os) >= tuple(minimum), "CEF package requires a newer Windows version");
  require(tuple(minimum) >= tuple(channel == "legacy" ? WindowsVersion{6, 1, 7601} : WindowsVersion{10, 0, 0}), "Invalid package Windows baseline");
  Manifest m;
  m.channel = channel; m.arch = arch;
  m.version = j.at("version").get<std::string>();
  m.cef_version = j.at("cefVersion").get<std::string>();
  require(std::regex_match(m.version, std::regex("[0-9]+\\.[0-9]+\\.[0-9]+")), "Invalid host version");
  require(j.at("chromiumMajor").is_number_unsigned(), "Invalid Chromium version");
  require(j.at("chromiumMajor").get<std::uint64_t>() <= 10000, "Invalid Chromium version range");
  m.chromium_major = j.at("chromiumMajor").get<unsigned>();
  require(channel == "legacy" ? m.chromium_major == 109 : m.chromium_major >= 138, "Wrong Chromium generation");
  require(m.cef_version.size() < 120 && std::regex_match(m.cef_version, std::regex("[0-9]+\\.[0-9]+\\.[0-9]+[A-Za-z0-9.+_-]*")) && m.cef_version.rfind(std::to_string(m.chromium_major) + ".", 0) == 0, "Invalid CEF version");
  require(j.at("size").is_number_unsigned() && j.at("unpackedSize").is_number_unsigned(), "Invalid package sizes");
  m.size = j.at("size").get<std::uint64_t>(); m.unpacked_size = j.at("unpackedSize").get<std::uint64_t>();
  require(m.size > 0 && m.size <= max_archive_size && m.unpacked_size > 0 && m.unpacked_size <= max_unpacked_size, "Package exceeds size limits");
  m.sha256 = j.at("sha256").get<std::string>();
  require(is_sha256(m.sha256), "Invalid package digest");
  const auto& files = j.at("files");
  require(files.is_array() && files.size() >= 5 && files.size() <= 10000, "Invalid package file list");
  std::set<std::string> names;
  std::uint64_t total = 0;
  for (const auto& f : files) {
    FileRecord record{zip_path(f.at("path").get<std::string>(), false), f.at("sha256").get<std::string>(), 0};
    require(f.at("size").is_number_unsigned(), "Invalid file size");
    record.size = f.at("size").get<std::uint64_t>();
    require(record.size <= max_archive_size && is_sha256(record.sha256), "Invalid file metadata");
    require(names.insert(lower(record.path)).second, "Duplicate package path");
    total += record.size;
    require(total <= max_unpacked_size, "Unpacked package too large");
    m.files.push_back(record);
  }
  for (const auto& name : names) {
    for (auto p = name.find('/'); p != std::string::npos; p = name.find('/', p + 1))
      require(!names.count(name.substr(0, p)), "File and directory collide");
  }
  for (const auto* required : {"keepwork-cef.exe", "libcef.dll", "icudtl.dat", "resources.pak", "locales/en-us.pak"})
    require(names.count(required) != 0, "Incomplete CEF distribution");
  if (m.chromium_major >= 138) require(names.count("keepwork-cef.dll") != 0, "Missing sandbox bootstrap application DLL");
  require(total == m.unpacked_size, "Unpacked size mismatch");
  return m;
}
}
