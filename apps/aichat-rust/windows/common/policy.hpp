#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace keepwork {
struct WindowsVersion { unsigned major, minor, build; };
struct FileRecord { std::string path, sha256; std::uint64_t size; };
struct Manifest {
  std::string channel, arch, version, cef_version, sha256;
  unsigned chromium_major;
  std::uint64_t size, unpacked_size;
  std::vector<FileRecord> files;
};
// Empty means use the existing WebView2 desktop. Unknown/unsupported OS fails.
std::string select_channel(WindowsVersion os, bool webview_ready);
Manifest validate_manifest(const std::string& payload, const std::string& channel,
                           const std::string& arch, WindowsVersion os);
// Returns a normalized relative path, or throws. Directory entries are optional.
std::string zip_path(const std::string& path, bool directory);
bool is_sha256(const std::string& value);
constexpr std::uint64_t max_archive_size = 1024ULL * 1024 * 1024;
constexpr std::uint64_t max_unpacked_size = 3ULL * 1024 * 1024 * 1024;
constexpr const char* cdn_base = "https://cdn.keepwork.com/keepwork/aichat-cef/v1/";
}
