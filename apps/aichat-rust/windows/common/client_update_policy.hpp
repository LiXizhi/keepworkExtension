#pragma once
#include "policy.hpp"
#include "win7_policy.hpp"
#include <nlohmann/json.hpp>
#include <regex>
#include <stdexcept>
#include <tuple>

namespace keepwork {
struct ClientUpdateManifest {
  std::string version, file_name, url, sha256, release_date;
  std::uint64_t size = 0;
};
inline auto client_version(const std::string& value) {
  std::smatch match;
  if (!std::regex_match(value, match, std::regex("([0-9]{1,9})\\.([0-9]{1,9})\\.([0-9]{1,9})")))
    throw std::runtime_error("Invalid compatibility client version");
  return std::make_tuple(std::stoul(match[1]), std::stoul(match[2]), std::stoul(match[3]));
}
// Called only after verifying the original signed envelope, never raw feed JSON.
inline ClientUpdateManifest validate_win7_client_manifest(const std::string& payload) {
  if (payload.size() > 1024 * 1024) throw std::runtime_error("Client update manifest exceeds size limit");
  const auto j = nlohmann::json::parse(payload);
  if (j.at("schemaVersion") != 1 || j.at("product") != "aichat-desktop"
      || j.at("variant") != "win7-win8" || j.at("platform") != "windows"
      || j.at("arch") != "x64" || j.at("format") != "exe"
      || j.at("minWindows") != nlohmann::json::array({6, 1, 7601}))
    throw std::runtime_error("Not a Windows 7/8 compatibility client update");
  ClientUpdateManifest m;
  m.version = j.at("version").get<std::string>();
  (void)client_version(m.version);
  m.file_name = "Keepwork_Win7_Win8_" + m.version + "_x64-setup.exe";
  m.url = std::string(win7_client_base) + m.version + "/" + m.file_name;
  if (j.at("fileName") != m.file_name || j.at("url") != m.url)
    throw std::runtime_error("Unexpected compatibility installer URL");
  m.sha256 = j.at("sha256").get<std::string>();
  if (!is_sha256(m.sha256) || !j.at("size").is_number_unsigned())
    throw std::runtime_error("Invalid compatibility installer metadata");
  m.size = j.at("size").get<std::uint64_t>();
  if (!m.size || m.size > max_archive_size) throw std::runtime_error("Client update exceeds size limit");
  if (j.contains("releaseDate") && j.at("releaseDate").is_string()) {
    const auto value = j.at("releaseDate").get<std::string>();
    if (value.size() <= 128) m.release_date = value;
  }
  return m;
}
inline void validate_client_update_choice(const std::string& current,
    const ClientUpdateManifest& remote, const ClientUpdateManifest* pending) {
  if (client_version(remote.version) < client_version(current))
    throw std::runtime_error("Refusing a compatibility client downgrade");
  if (pending) {
    if (remote.version == pending->version && remote.sha256 != pending->sha256)
      throw std::runtime_error("Same client version has different immutable bytes");
    if (client_version(remote.version) < client_version(pending->version))
      throw std::runtime_error("The client feed is older than a previously verified update");
  }
}
inline void require_client_update_digest(const std::string& actual, const std::string& approved) {
  if (!is_sha256(approved) || actual != approved)
    throw std::runtime_error("The update candidate changed; check and confirm the update again");
}
// The concrete operation owns the verified candidate and the exact parent
// process handle. A canceled close or failed handshake never launches NSIS.
template<class Operations> void apply_prepared_client_update(Operations& operations) {
  operations.prepare();
  operations.signal_ready();
  if (!operations.wait_for_parent_exit())
    throw std::runtime_error("Keepwork did not exit; the update remains downloaded for later");
  operations.revalidate();
  operations.launch_installer();
}
}
