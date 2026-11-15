#include "mcp_restart_policy.hpp"
#include "mcp_restart_http.hpp"
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
unsigned assertions = 0;
void expect(bool condition, const char* message) {
  ++assertions;
  if (!condition) throw std::runtime_error(message);
}
void rejects(const std::function<void()>& action, const char* message) {
  ++assertions;
  try { action(); } catch (const std::runtime_error&) { return; }
  throw std::runtime_error(message);
}

keepwork::McpRestartIdentity owned_runtime() {
  keepwork::McpRestartIdentity identity;
  identity.keepwork = identity.process_alive = identity.same_user = identity.managed_runtime = true;
  identity.health_pid = identity.listener_pid = identity.process_pid = 4242;
  identity.created = identity.rechecked_created = 123456789;
  identity.engine = "rust";
  identity.variant = "win7-win8";
  identity.host_kind = "win7-win8-desktop";
  identity.cache_root = L"C:\\Users\\tester\\AppData\\Local\\KeepworkWin7Win8\\McpRuntimes\\versions";
  identity.bundle_root = L"C:\\Users\\tester\\AppData\\Local\\Programs\\Keepwork Windows 7 and 8\\resources\\win7-mcp";
  identity.image = identity.cache_root + L"\\" + std::wstring(64, L'a') + L"\\bin\\keepwork-mcp.exe";
  return identity;
}

void exact_edition_paths() {
  using keepwork::restart_edition_image_path;
  const auto identity = owned_runtime();
  const auto accepts = [&](const std::wstring& image) {
    return restart_edition_image_path(image, identity.cache_root, identity.bundle_root);
  };
  expect(accepts(identity.image), "a content-addressed runtime from this edition is eligible");
  expect(accepts(identity.bundle_root + L"\\bin\\keepwork-mcp.exe"),
    "the current edition's bundled MCP is eligible");
  expect(accepts(identity.cache_root + L"\\" + std::wstring(64, L'F') + L"\\BIN\\KEEPWORK-MCP.EXE"),
    "Windows path and digest casing do not change edition ownership");
  auto slash = identity.image;
  for (auto& character : slash) if (character == L'\\') character = L'/';
  expect(accepts(slash), "normalized drive-absolute Windows separators remain equivalent");
  const std::wstring unicode_cache = L"D:\\Users\\\u4e2d\u6587 user\\KeepworkWin7Win8\\McpRuntimes\\versions";
  const std::wstring unicode_bundle = L"D:\\Programs\\Keepwork \u5b89\u88c5\\resources\\win7-mcp";
  expect(restart_edition_image_path(unicode_cache + L"\\" + std::wstring(64, L'b')
      + L"\\bin\\keepwork-mcp.exe", unicode_cache, unicode_bundle),
    "spaces and Unicode user directories do not require weakening exact runtime confinement");
  for (const auto& image : std::vector<std::wstring>{
      L"keepwork-mcp.exe", L"C:keepwork-mcp.exe", L"/tmp/keepwork-mcp.exe",
      L"\\\\server\\share\\bin\\keepwork-mcp.exe", L"\\\\?\\" + identity.image,
      L"\\\\.\\" + identity.image,
      identity.cache_root + L"-other\\" + std::wstring(64, L'a') + L"\\bin\\keepwork-mcp.exe",
      identity.cache_root + L"\\" + std::wstring(63, L'a') + L"\\bin\\keepwork-mcp.exe",
      identity.cache_root + L"\\" + std::wstring(65, L'a') + L"\\bin\\keepwork-mcp.exe",
      identity.cache_root + L"\\" + std::wstring(64, L'g') + L"\\bin\\keepwork-mcp.exe",
      identity.cache_root + L"\\" + std::wstring(64, L'a') + L"\\nested\\bin\\keepwork-mcp.exe",
      identity.cache_root + L"\\" + std::wstring(64, L'a') + L"\\bin\\other.exe",
      identity.cache_root + L"\\" + std::wstring(64, L'a') + L"\\bin\\keepwork-mcp.exe:stream",
      identity.bundle_root + L"-other\\bin\\keepwork-mcp.exe",
      identity.bundle_root + L"\\..\\win7-mcp\\bin\\keepwork-mcp.exe",
      identity.bundle_root + L"\\.\\bin\\keepwork-mcp.exe",
      identity.bundle_root + L"\\bin.\\keepwork-mcp.exe",
      identity.bundle_root + L"\\bin \\keepwork-mcp.exe",
      identity.bundle_root + L"\\bin\\\\keepwork-mcp.exe",
      identity.image + std::wstring(1, L'\0') + L"ignored.exe",
    }) {
    expect(!accepts(image), "unsafe, lookalike, or non-MCP image paths cannot confer stop authority");
  }
  expect(!restart_edition_image_path(identity.image, L"", identity.bundle_root),
    "a missing canonical cache root cannot confer ownership");
  expect(!restart_edition_image_path(identity.image, identity.cache_root, L"\\\\server\\bundle"),
    "an unsafe bundle root cannot confer ownership through another allowed root");
}

void ownership_requires_process_and_listener_evidence() {
  using keepwork::McpRestartIdentity;
  const auto owned = owned_runtime();
  expect(keepwork::restart_owned_mcp(owned),
    "old same-edition peers can restart from process evidence without requiring equal application versions");
  auto bundled = owned;
  bundled.image = bundled.bundle_root + L"\\bin\\keepwork-mcp.exe";
  expect(keepwork::restart_owned_mcp(bundled), "bundled same-edition process evidence is sufficient");
  const std::vector<std::function<void(McpRestartIdentity&)>> foreign_or_uncertain{
    [](auto& peer) { peer.keepwork = false; },
    [](auto& peer) { peer.process_alive = false; },
    [](auto& peer) { peer.same_user = false; },
    [](auto& peer) { peer.managed_runtime = false; },
    [](auto& peer) { peer.health_pid = 0; },
    [](auto& peer) { ++peer.health_pid; },
    [](auto& peer) { ++peer.listener_pid; },
    [](auto& peer) { ++peer.process_pid; },
    [](auto& peer) { peer.created = 0; },
    [](auto& peer) { ++peer.rechecked_created; },
    [](auto& peer) { peer.engine = "node"; },
    [](auto& peer) { peer.engine.clear(); },
    [](auto& peer) { peer.variant = "modern"; },
    [](auto& peer) { peer.variant.clear(); },
    [](auto& peer) { peer.host_kind = "vscode-extension"; },
    [](auto& peer) { peer.host_kind = "local-helper"; },
    [](auto& peer) { peer.host_kind = "cef-desktop"; },
    [](auto& peer) { peer.host_kind.clear(); },
    [](auto& peer) { peer.image = L"C:\\OtherInstallation\\bin\\keepwork-mcp.exe"; },
  };
  for (const auto& change : foreign_or_uncertain) {
    auto peer = owned;
    change(peer);
    expect(!keepwork::restart_owned_mcp(peer),
      "foreign ownership, missing metadata, PID reuse, and listener replacement must fail closed");
  }
}

struct RestartFixture {
  std::vector<std::string> calls;
  std::string fail;
  bool accepted = true;
  void step(const char* name) {
    calls.push_back(name);
    if (fail == name) throw std::runtime_error(std::string("fixture failure: ") + name);
  }
  keepwork::McpRestartOperations operations() {
    return {
      [this] { step("prepare"); }, [this] { step("owner"); }, [this] { step("recheck"); },
      [this] { step("stop"); }, [this] { step("wait-exit"); }, [this] { step("start"); },
      [this] { step("confirm"); return accepted; },
    };
  }
};

void restart_cancellation_and_failures_preserve_stop_boundaries() {
  RestartFixture success;
  expect(keepwork::perform_mcp_restart(true, success.operations()), "confirmed restart can complete");
  expect(success.calls == std::vector<std::string>{"prepare", "owner", "confirm", "recheck", "stop", "wait-exit", "start"},
    "new signed candidate and ownership are checked before consent, then identity is rechecked immediately before stop");
  RestartFixture canceled;
  canceled.accepted = false;
  expect(!keepwork::perform_mcp_restart(true, canceled.operations()), "declining the disruption confirmation cancels restart");
  expect(canceled.calls == std::vector<std::string>{"prepare", "owner", "confirm"},
    "cancellation performs no stop, activation, or new service launch");
  const std::vector<std::string> sequence{"prepare", "owner", "confirm", "recheck", "stop", "wait-exit", "start"};
  for (std::size_t index = 0; index < sequence.size(); ++index) {
    RestartFixture broken;
    broken.fail = sequence[index];
    rejects([&] { keepwork::perform_mcp_restart(true, broken.operations()); },
      "a failed restart phase must propagate a bounded failure, not continue with later mutations");
    expect(broken.calls == std::vector<std::string>(sequence.begin(), sequence.begin() + index + 1),
      "failed verification, changed peer, stop timeout, or launch errors never replay a later action");
  }
  RestartFixture idle;
  expect(keepwork::perform_mcp_restart(false, idle.operations()), "an empty port can start the verified bundled runtime");
  expect(idle.calls == std::vector<std::string>{"prepare", "start"},
    "an empty port has no process to stop or disruption to confirm");
  expect(keepwork::restart_candidate_not_older("0.2.66", "0.2.69")
      && keepwork::restart_candidate_not_older("0.2.69", "0.2.69"),
    "a verified equal or newer replacement can preserve the old peer's version contract");
  expect(keepwork::restart_candidate_not_older("0.2.99", "0.2.100")
      && !keepwork::restart_candidate_not_older("0.2.100", "0.2.99"),
    "restart comparisons use numeric version components instead of lexicographic strings");
  expect(!keepwork::restart_candidate_not_older("unknown", "0.2.69")
      && !keepwork::restart_candidate_not_older("0.2.69", "0.2.70-beta"),
    "unknown replacement or running versions never authorize a destructive switch");
  RestartFixture newer_running_peer;
  auto guarded = newer_running_peer.operations();
  guarded.validate_owner = [&] {
    newer_running_peer.step("owner");
    if (!keepwork::restart_candidate_not_older("0.2.69", "0.2.66"))
      throw std::runtime_error("verified replacement would downgrade the running peer");
  };
  rejects([&] { keepwork::perform_mcp_restart(true, guarded); },
    "losing trust in a higher version's old signing key cannot justify stopping it to run an older bundle");
  expect(newer_running_peer.calls == std::vector<std::string>{"prepare", "owner"},
    "a newer running peer is preserved before confirmation, stop, activation or launch");
}

void restart_http_framing_never_reconnects_or_accepts_ambiguous_replies() {
  const std::string body = "{\"name\":\"keepwork-mcp\",\"ok\":true}";
  const auto wire = "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(body.size())
    + "\r\nConnection: keep-alive\r\n\r\n" + body;
  for (std::size_t length = 0; length < wire.size(); ++length) {
    expect(!keepwork::restart_http_response(wire.substr(0, length)),
      "fragmented status, headers or JSON bodies are not interpreted before their complete byte framing arrives");
  }
  const auto complete = keepwork::restart_http_response(wire);
  expect(complete && complete->status == 200 && complete->keep_alive && complete->body == body,
    "one complete finite persistent JSON response preserves status and exact body bytes");
  const auto closed = keepwork::restart_http_response("HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncOnNeCtIoN: CLOSE\r\n\r\n{}");
  expect(closed && !closed->keep_alive, "a closed response cannot authorize a subsequent POST on a replacement connection");
  const auto redirect = keepwork::restart_http_response("HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: http://other.example/\r\n\r\n");
  expect(redirect && redirect->status == 302 && redirect->status != 200,
    "a redirect remains an unsuccessful health result rather than being followed or normalized into readiness");
  for (const auto& invalid : std::vector<std::string>{
      "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}",
      "HTTP/1.1 600 Invalid\r\nContent-Length: 2\r\n\r\n{}",
      "HTTP/1.1 20x Invalid\r\nContent-Length: 2\r\n\r\n{}",
      "HTTP/1.1 200x\r\nContent-Length: 2\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: -2\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: two\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
      "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nMalformed header\r\nContent-Length: 2\r\n\r\n{}",
      "HTTP/1.1 200 OK\r\nContent-Length: 99999\r\n\r\n",
      wire + "x",
      wire + wire,
      "HTTP/1.1 200 OK\r\nX-Oversized: " + std::string(16400, 'a') + "\r\nContent-Length: 0\r\n\r\n",
      std::string(32769, 'x'),
    }) {
    rejects([&] { keepwork::restart_http_response(invalid); },
      "ambiguous, unsupported, oversized or pipelined replies cannot grant graceful-stop connection authority");
  }
}
}

int main() {
  try {
    exact_edition_paths();
    ownership_requires_process_and_listener_evidence();
    restart_cancellation_and_failures_preserve_stop_boundaries();
    restart_http_framing_never_reconnects_or_accepts_ambiguous_replies();
    std::cout << "Compatibility maintenance: " << assertions << " assertions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Compatibility maintenance failure: " << error.what() << '\n';
    return 1;
  }
}
