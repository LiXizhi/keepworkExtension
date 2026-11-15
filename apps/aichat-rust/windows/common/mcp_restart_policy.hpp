#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cwctype>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>

namespace keepwork {
inline std::optional<std::array<std::uint32_t, 3>> restart_version_parts(const std::string& value) {
  std::array<std::uint32_t, 3> parts{};
  std::size_t offset = 0;
  for (unsigned index = 0; index < 3; ++index) {
    const auto begin = offset;
    while (offset < value.size() && value[offset] >= '0' && value[offset] <= '9') ++offset;
    if (offset == begin || offset - begin > 9) return std::nullopt;
    for (auto digit = begin; digit < offset; ++digit) parts[index] = parts[index] * 10 + (value[digit] - '0');
    if (index < 2) {
      if (offset >= value.size() || value[offset++] != '.') return std::nullopt;
    } else if (offset != value.size()) return std::nullopt;
  }
  return parts;
}
inline bool restart_candidate_not_older(const std::string& running_version, const std::string& candidate_version) {
  const auto running = restart_version_parts(running_version), candidate = restart_version_parts(candidate_version);
  return running && candidate && *candidate >= *running;
}
inline std::wstring restart_path(const std::wstring& raw) {
  if (raw.size() < 4 || raw.size() > 32760 ||
      !((raw[0] >= L'A' && raw[0] <= L'Z') || (raw[0] >= L'a' && raw[0] <= L'z')) ||
      raw[1] != L':' || (raw[2] != L'\\' && raw[2] != L'/')) return {};
  std::wstring value = raw;
  for (auto& character : value) {
    if (character == L'/') character = L'\\';
    character = static_cast<wchar_t>(std::towlower(character));
  }
  if (value.find_first_of(L"\"<>|?*") != std::wstring::npos || value.find(L':', 2) != std::wstring::npos) return {};
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  std::size_t begin = 3;
  while (begin < value.size()) {
    const auto end = value.find(L'\\', begin);
    const auto part = value.substr(begin, end == std::wstring::npos ? end : end - begin);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return {};
    for (const auto character : part) if (character < 32 || character == 127) return {};
    if (end == std::wstring::npos) break;
    begin = end + 1;
  }
  return value;
}
// Paths reaching this policy were canonicalized and had every existing
// ancestor checked for reparse points by the native adapter. This lexical
// decision also prevents prefix lookalikes and arbitrary executables in cache.
inline bool restart_edition_image_path(const std::wstring& image,
    const std::wstring& cache_root, const std::wstring& bundle_root) {
  const auto path = restart_path(image), cache = restart_path(cache_root), bundle = restart_path(bundle_root);
  if (path.empty() || cache.empty() || bundle.empty()) return false;
  if (path == bundle + L"\\bin\\keepwork-mcp.exe") return true;
  const auto prefix = cache + L"\\";
  if (path.compare(0, prefix.size(), prefix) != 0) return false;
  const auto relative = path.substr(prefix.size());
  if (relative.size() != 64 + 21 || relative.substr(64) != L"\\bin\\keepwork-mcp.exe") return false;
  return relative.substr(0, 64).find_first_not_of(L"0123456789abcdef") == std::wstring::npos;
}
struct McpRestartIdentity {
  bool keepwork = false, process_alive = false, same_user = false, managed_runtime = false;
  std::uint32_t health_pid = 0, listener_pid = 0, process_pid = 0;
  std::uint64_t created = 0, rechecked_created = 0;
  std::string engine, variant, host_kind;
  std::wstring image, cache_root, bundle_root;
};
inline bool restart_owned_mcp(const McpRestartIdentity& identity) {
  return identity.keepwork && identity.process_alive && identity.same_user && identity.managed_runtime
    && identity.health_pid != 0 && identity.health_pid == identity.listener_pid
    && identity.health_pid == identity.process_pid && identity.created != 0
    && identity.created == identity.rechecked_created
    && identity.engine == "rust" && identity.variant == "win7-win8"
    && identity.host_kind == "win7-win8-desktop"
    && restart_edition_image_path(identity.image, identity.cache_root, identity.bundle_root);
}
struct McpRestartOperations {
  std::function<void()> prepare, validate_owner, recheck, stop, wait_exit, start;
  std::function<bool()> confirm;
};
// The native adapter binds stop/wait to one held Windows process handle.
// Prepare must verify the selected executable's complete signed package before
// any existing service can be interrupted. False means only user cancellation.
inline bool perform_mcp_restart(bool running, const McpRestartOperations& operations) {
  operations.prepare();
  if (running) {
    operations.validate_owner();
    if (!operations.confirm()) return false;
    operations.recheck();
    operations.stop();
    operations.wait_exit();
  }
  operations.start();
  return true;
}
}
