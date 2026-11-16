#include "client_update_policy.hpp"
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using nlohmann::json;
unsigned assertions = 0;
void expect(bool condition, const char* message) {
  ++assertions;
  if (!condition) throw std::runtime_error(message);
}
void rejects(const std::function<void()>& action, const char* message) {
  ++assertions;
  try { action(); } catch (const std::exception&) { return; }
  throw std::runtime_error(message);
}
json manifest(const std::string& version = "0.2.155") {
  const auto file = "Keepwork_Win7_Win8_" + version + "_x64-setup.exe";
  return {
    {"schemaVersion", 1}, {"product", "aichat-desktop"}, {"variant", "win7-win8"},
    {"platform", "windows"}, {"arch", "x64"}, {"format", "exe"},
    {"minWindows", json::array({6, 1, 7601})}, {"version", version},
    {"fileName", file}, {"url", std::string(keepwork::win7_client_base) + version + "/" + file},
    {"sha256", std::string(64, 'a')}, {"size", std::uint64_t{100}},
    {"releaseDate", "2026-11-15T00:00:00Z"},
  };
}
void invalid(const std::function<void(json&)>& mutate, const char* message) {
  auto candidate = manifest();
  mutate(candidate);
  rejects([&] { keepwork::validate_win7_client_manifest(candidate.dump()); }, message);
}

void client_channel_and_signed_payload_shape() {
  const auto candidate = keepwork::validate_win7_client_manifest(manifest().dump());
  expect(candidate.version == "0.2.155" && candidate.file_name == "Keepwork_Win7_Win8_0.2.155_x64-setup.exe",
    "decode the dedicated compatibility client identity");
  expect(candidate.url == std::string(keepwork::win7_client_base) + "0.2.155/Keepwork_Win7_Win8_0.2.155_x64-setup.exe"
      && candidate.size == 100 && candidate.sha256 == std::string(64, 'a'),
    "preserve exact pinned HTTPS URL, size and digest for installer verification");
  auto additive = manifest();
  additive["futureOptionalCapability"] = {{"enabled", true}};
  additive["mcpVersion"] = "999.1.2";
  expect(keepwork::validate_win7_client_manifest(additive.dump()).version == candidate.version,
    "additive metadata and independent MCP versions do not gate client updates");
  additive["releaseDate"] = json::object();
  expect(keepwork::validate_win7_client_manifest(additive.dump()).release_date.empty(),
    "unknown optional release date remains unknown without rejecting a supported update");
  additive["releaseDate"] = std::string(129, 'x');
  expect(keepwork::validate_win7_client_manifest(additive.dump()).release_date.empty(),
    "unbounded optional display metadata is not retained");
  for (const auto* required : {"schemaVersion", "product", "variant", "platform", "arch", "format", "minWindows",
      "version", "fileName", "url", "sha256", "size"}) {
    invalid([&](auto& value) { value.erase(required); }, "missing required update metadata must be rejected");
  }
  for (const auto& replacement : std::vector<std::pair<std::string, json>>{
      {"schemaVersion", 2}, {"product", "keepwork-mcp-runtime"}, {"variant", "modern"},
      {"platform", "macos"}, {"arch", "arm64"}, {"format", "zip"},
      {"minWindows", json::array({10, 0, 0})}, {"minWindows", json::array({6, 1, 7600})},
      {"minWindows", json::array({6, 1})}, {"minWindows", nullptr},
    }) {
    invalid([&](auto& value) { value[replacement.first] = replacement.second; },
      "a different product, platform, format, architecture or OS baseline is never the compatibility update");
  }
  for (const auto& version : {"../new", "0.2", "0.2.155-beta", "0.2.155/other", "1.2.-1", "1000000000.0.0"}) {
    invalid([&](auto& value) { value["version"] = version; }, "unsafe or excessive version strings must fail");
  }
  for (const auto& replacement : {
      "http://cdn.keepwork.com/keepwork/aichat-rust-win7-win8/0.2.155/Keepwork_Win7_Win8_0.2.155_x64-setup.exe",
      "https://cdn.keepwork.com/keepwork/aichat-rust/win32-x64/latest-client.json",
      "https://cdn.keepwork.com/keepwork/aichat-rust-win7-win8/0.2.154/Keepwork_Win7_Win8_0.2.155_x64-setup.exe",
      "https://example.com/keepwork/aichat-rust-win7-win8/0.2.155/Keepwork_Win7_Win8_0.2.155_x64-setup.exe",
      "https://cdn.keepwork.com/keepwork/aichat-rust-win7-win8/0.2.155/Keepwork_Win7_Win8_0.2.155_x64-setup.exe?token=unexpected",
    }) {
    invalid([&](auto& value) { value["url"] = replacement; }, "reject redirected, unpinned, mismatched or modern update channels");
  }
  invalid([](auto& value) { value["fileName"] = "../setup.exe"; }, "installer names cannot escape the selected version");
  for (const auto& digest : {std::string(63, 'a'), std::string(64, 'g'), std::string(64, 'A'), std::string{}}) {
    invalid([&](auto& value) { value["sha256"] = digest; }, "reject invalid installer digests");
  }
  for (const auto& size : {json(0), json(-1), json(1.5), json(true), json("100"), json(nullptr),
      json(keepwork::max_archive_size + 1)}) {
    invalid([&](auto& value) { value["size"] = size; }, "reject missing, excessive or non-integer installer sizes");
  }
  rejects([&] { keepwork::validate_win7_client_manifest("{"); }, "invalid JSON must not become an update");
  rejects([&] { keepwork::validate_win7_client_manifest(std::string(1024 * 1024 + 1, ' ')); },
    "manifest byte caps apply before decoding");
}

void update_selection_and_approval_are_immutable() {
  auto remote = keepwork::validate_win7_client_manifest(manifest("0.2.155").dump());
  keepwork::validate_client_update_choice("0.2.151", remote, nullptr);
  keepwork::validate_client_update_choice("0.2.155", remote, nullptr);
  ++assertions;
  auto pending = remote;
  keepwork::validate_client_update_choice("0.2.151", remote, &pending);
  ++assertions;
  rejects([&] { keepwork::validate_client_update_choice("0.2.156", remote, nullptr); },
    "an older remote version cannot downgrade the installed client");
  pending.version = "0.2.156";
  rejects([&] { keepwork::validate_client_update_choice("0.2.151", remote, &pending); },
    "an older remote feed cannot replace an already verified newer pending update");
  pending = remote;
  pending.sha256 = std::string(64, 'b');
  rejects([&] { keepwork::validate_client_update_choice("0.2.151", remote, &pending); },
    "a single version cannot silently replace approved immutable bytes");
  // latest.signed.json remains authoritative even if its first download
  // failed, or if pending.signed.json / its installer was later damaged.
  const auto last_verified_feed = remote;
  auto changed_feed = remote;
  changed_feed.sha256 = std::string(64, 'c');
  rejects([&] { keepwork::validate_client_update_choice("0.2.151", changed_feed, &last_verified_feed); },
    "a failed download without any installable pending candidate cannot permit same-version new bytes");
  const auto rolled_back_feed = keepwork::validate_win7_client_manifest(manifest("0.2.154").dump());
  rejects([&] { keepwork::validate_client_update_choice("0.2.151", rolled_back_feed, &last_verified_feed); },
    "losing a pending installer cannot allow the verified latest feed to roll backward");
  keepwork::validate_client_update_choice("0.2.151", remote, &last_verified_feed);
  ++assertions;
  const auto numeric = keepwork::validate_win7_client_manifest(manifest("0.2.10").dump());
  keepwork::validate_client_update_choice("0.2.9", numeric, nullptr);
  ++assertions;
  keepwork::require_client_update_digest(remote.sha256, remote.sha256);
  ++assertions;
  rejects([&] { keepwork::require_client_update_digest(std::string(64, 'b'), remote.sha256); },
    "a changed candidate digest requires a fresh check and explicit approval");
  rejects([&] { keepwork::require_client_update_digest("invalid", "invalid"); },
    "two equal malformed digests do not confer update consent");
}

struct InstallFixture {
  std::vector<std::string> calls;
  std::string fail;
  bool closed = true, closed_acknowledged = true;
  void step(const char* operation) {
    calls.push_back(operation);
    if (fail == operation) throw std::runtime_error(std::string("fixture: ") + operation);
  }
  void prepare() { step("prepare"); }
  void signal_ready() { step("ready"); }
  bool wait_for_parent_exit() { step("wait-exit"); return closed; }
  void revalidate() {
    step("revalidate");
    if (!closed_acknowledged) throw std::runtime_error("main browser did not acknowledge an approved normal close");
  }
  void launch_installer() { step("launch"); }
};

void install_requires_real_parent_exit_and_fresh_validation() {
  InstallFixture success;
  keepwork::apply_prepared_client_update(success);
  expect(success.calls == std::vector<std::string>{"prepare", "ready", "wait-exit", "revalidate", "launch"},
    "verified installer launch follows readiness acknowledgement, actual parent exit and a fresh integrity check");
  InstallFixture canceled;
  canceled.closed = false;
  rejects([&] { keepwork::apply_prepared_client_update(canceled); },
    "canceled beforeunload or an unclosed browser cannot start an installer");
  expect(canceled.calls == std::vector<std::string>{"prepare", "ready", "wait-exit"},
    "an unclosed parent retains the download without installer launch");
  InstallFixture crashed_or_unapproved_exit;
  crashed_or_unapproved_exit.closed_acknowledged = false;
  rejects([&] { keepwork::apply_prepared_client_update(crashed_or_unapproved_exit); },
    "OS process exit alone cannot authorize installation after a crash or an unrelated ordinary quit");
  expect(crashed_or_unapproved_exit.calls == std::vector<std::string>{"prepare", "ready", "wait-exit", "revalidate"},
    "a missing normal-close acknowledgement blocks launch even after the parent process exits");
  const std::vector<std::string> sequence{"prepare", "ready", "wait-exit", "revalidate", "launch"};
  for (std::size_t index = 0; index < sequence.size(); ++index) {
    InstallFixture broken;
    broken.fail = sequence[index];
    rejects([&] { keepwork::apply_prepared_client_update(broken); },
      "handoff errors must stop the install pipeline");
    expect(broken.calls == std::vector<std::string>(sequence.begin(), sequence.begin() + index + 1),
      "failed preparation, IPC, exit wait or final integrity checks cannot continue or replay later effects");
  }
}
}

int main() {
  try {
    client_channel_and_signed_payload_shape();
    update_selection_and_approval_are_immutable();
    install_requires_real_parent_exit_and_fresh_validation();
    std::cout << "Compatibility client update: " << assertions << " assertions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Compatibility client update failure: " << error.what() << '\n';
    return 1;
  }
}
