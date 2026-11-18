#include "win7_policy.hpp"
#include <nlohmann/json.hpp>
#include <functional>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using nlohmann::json;
const keepwork::WindowsVersion win7{6, 1, 7601};
unsigned assertions = 0;

void expect(bool condition, const std::string& message) {
  ++assertions;
  if (!condition) throw std::runtime_error(message);
}
void rejects(const std::function<void()>& action, const std::string& message) {
  ++assertions;
  try { action(); } catch (const std::exception&) { return; }
  throw std::runtime_error("Accepted invalid Win7 package: " + message);
}
json manifest() {
  const std::string version = "0.2.61";
  return {
    {"schemaVersion", 2}, {"product", "keepwork-mcp-runtime"}, {"engine", "rust"},
    {"variant", "win7-win8"}, {"buildTarget", "x86_64-win7-windows-msvc"},
    {"platform", "windows"}, {"arch", "x64"}, {"minWindows", {6, 1, 7601}},
    {"entry", "bin/keepwork-mcp.exe"}, {"version", version},
    {"commit", std::string(40, 'a')}, {"sourceHash", std::string(64, 'b')},
    {"sha256", std::string(64, 'c')}, {"size", 100}, {"unpackedSize", 3},
    {"fileName", "windows-x64.zip"},
    {"url", std::string(keepwork::win7_mcp_base) + version + "/windows-x64.zip"},
    {"files", json::array({
      {{"path", "runtime.json"}, {"size", 1}, {"sha256", std::string(64, 'd')}},
      {{"path", "bin/keepwork-mcp.exe"}, {"size", 1}, {"sha256", std::string(64, 'e')}},
      {{"path", "LICENSE"}, {"size", 1}, {"sha256", std::string(64, 'f')}}
    })}
  };
}
void invalid(const std::function<void(json&)>& change, const std::string& label) {
  auto value = manifest(); change(value);
  rejects([&] { keepwork::validate_win7_mcp_manifest(value.dump(), win7); }, label);
}

void contract() {
  const auto value = manifest();
  const auto parsed = keepwork::validate_win7_mcp_manifest(value.dump(), win7);
  expect(parsed.channel == "win7-win8" && parsed.arch == "x64" && parsed.version == "0.2.61",
    "Decode dedicated Win7 target");
  expect(parsed.size == 100 && parsed.unpacked_size == 3 && parsed.files.size() == 3,
    "Preserve package limits and file records");
  auto additive = value; additive["futureOptionalField"] = {{"enabled", true}};
  expect(keepwork::validate_win7_mcp_manifest(additive.dump(), win7).sha256 == parsed.sha256,
    "Ignore additive optional fields");
  additive["terminalApi"] = nullptr;
  expect(keepwork::validate_win7_mcp_manifest(additive.dump(), win7).version == parsed.version,
    "Null optional capability remains unavailable");
  for (const auto os : {keepwork::WindowsVersion{6, 2, 9200}, keepwork::WindowsVersion{6, 3, 9600}}) {
    expect(keepwork::validate_win7_mcp_manifest(value.dump(), os).version == parsed.version,
      "Same dedicated artifact supports the Windows 8 and 8.1 contracts");
  }
  for (const auto os : {keepwork::WindowsVersion{5, 1, 2600}, keepwork::WindowsVersion{6, 0, 6002},
                         keepwork::WindowsVersion{6, 1, 7600}}) {
    rejects([&] { keepwork::validate_win7_mcp_manifest(value.dump(), os); }, "OS below Win7 SP1");
  }
  rejects([&] { keepwork::validate_win7_mcp_manifest("{", win7); }, "malformed JSON");
  rejects([&] { keepwork::validate_win7_mcp_manifest(std::string(1024 * 1024 + 1, ' '), win7); },
    "unbounded manifest");
  for (const auto* key : {"schemaVersion", "product", "engine", "variant", "buildTarget", "platform",
                          "arch", "minWindows", "entry", "version", "commit", "sourceHash", "files",
                          "size", "unpackedSize", "sha256", "url", "fileName"}) {
    invalid([&](json& j) { j.erase(key); }, std::string("missing ") + key);
  }
  invalid([](json& j) { j["schemaVersion"] = 1; }, "legacy runtime schema");
  invalid([](json& j) { j["product"] = "aichat-desktop"; }, "different product");
  invalid([](json& j) { j["engine"] = "node"; }, "Node runtime");
  invalid([](json& j) { j.erase("variant"); j["buildTarget"] = "x86_64-pc-windows-msvc"; },
    "published modern runtime without Win7 identity");
  invalid([](json& j) { j["variant"] = "modern"; }, "modern variant");
  invalid([](json& j) { j["buildTarget"] = "x86_64-pc-windows-msvc"; }, "modern Rust standard library");
  invalid([](json& j) { j["buildTarget"] = "i686-win7-windows-msvc"; }, "32-bit target");
  invalid([](json& j) { j["platform"] = "macos"; }, "wrong platform");
  invalid([](json& j) { j["arch"] = "arm64"; }, "wrong architecture");
  invalid([](json& j) { j["entry"] = "aichat-rust.exe"; }, "modern desktop entry");
  invalid([](json& j) { j["terminalApi"] = "pty-session-v1"; }, "unsupported ConPTY advertisement");
  for (const auto baseline : {json::array({6, 1, 7600}), json::array({10, 0, 19045}),
                              json::array({6, 1}), json::array({6, 1, -1})}) {
    invalid([&](json& j) { j["minWindows"] = baseline; }, "wrong or malformed minimum OS");
  }
  for (const auto version : {"../latest", "0.2.61-beta", "0.2", "0.2.61/other"}) {
    invalid([&](json& j) { j["version"] = version; }, "unsafe version");
  }
  invalid([](json& j) { j["commit"] = std::string(40, 'A'); }, "noncanonical commit");
  invalid([](json& j) { j["commit"] = std::string(39, 'a'); }, "short commit");
  invalid([](json& j) { j["sourceHash"] = std::string(64, 'g'); }, "invalid source hash");
  invalid([](json& j) { j["sha256"] = std::string(64, 'A'); }, "noncanonical archive digest");
  for (const auto key : {"size", "unpackedSize"}) {
    for (const auto number : {json(0), json(-1), json(1.5), json("100"), json(nullptr)}) {
      invalid([&](json& j) { j[key] = number; }, "invalid package size");
    }
  }
  invalid([](json& j) { j["size"] = keepwork::max_archive_size + 1; }, "archive size cap");
  invalid([](json& j) { j["unpackedSize"] = keepwork::max_unpacked_size + 1; }, "unpacked size cap");
  for (const auto url : {
      "http://cdn.keepwork.com/keepwork/mcp-win7-win8-rs/0.2.61/windows-x64.zip",
      "https://cdn.keepwork.com/keepwork/mcp-stable-rs/0.2.61/windows-x64.zip",
      "https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs/0.2.60/windows-x64.zip",
      "https://example.com/keepwork/mcp-win7-win8-rs/0.2.61/windows-x64.zip",
      "https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs/0.2.61/windows-x64.zip?redirect=modern"}) {
    invalid([&](json& j) { j["url"] = url; }, "unexpected or modern update channel");
  }
  invalid([](json& j) { j["fileName"] = "../windows-x64.zip"; }, "unsafe archive name");
}

void files() {
  invalid([](json& j) { j["files"] = json::object(); }, "file table is not an array");
  invalid([](json& j) { j["files"].erase(0); j["unpackedSize"] = 2; }, "missing runtime manifest");
  invalid([](json& j) { j["files"].erase(1); j["unpackedSize"] = 2; }, "missing MCP executable");
  invalid([](json& j) { j["files"].erase(2); j["unpackedSize"] = 2; }, "missing license");
  for (const auto path : {"../escape.exe", "C:/escape.exe", "/absolute.exe", "bin/../escape.exe",
                          "bin\\escape.exe", "bin/keepwork-mcp.exe:stream", "bin/NUL.exe", "bin/file. "}) {
    invalid([&](json& j) { j["files"][1]["path"] = path; }, "unsafe member path");
  }
  invalid([](json& j) { auto file = j["files"][1]; file["path"] = "BIN/KEEPWORK-MCP.EXE";
    j["files"].push_back(file); j["unpackedSize"] = 4; }, "Windows case collision");
  invalid([](json& j) { auto file = j["files"][0]; file["path"] = "bin";
    j["files"].push_back(file); j["unpackedSize"] = 4; }, "file/directory collision");
  invalid([](json& j) { j["files"][1]["sha256"] = "bad"; }, "invalid member digest");
  invalid([](json& j) { j["files"][1]["size"] = -1; }, "negative member size");
  invalid([](json& j) { j["files"][1]["size"] = 1.5; }, "fractional member size");
  invalid([](json& j) { j["files"][1]["size"] = keepwork::max_archive_size + 1; }, "oversized member");
  invalid([](json& j) { j["files"][1]["size"] = 2; }, "signed total size mismatch");
}
}

int main(int argc, char** argv) {
  try {
    if (argc == 2) {
      std::ifstream input(argv[1], std::ios::binary);
      if (!input) throw std::runtime_error("Cannot open supplied manifest");
      const std::string payload((std::istreambuf_iterator<char>(input)), {});
      if (input.bad()) throw std::runtime_error("Cannot read supplied manifest");
      const auto parsed = keepwork::validate_win7_mcp_manifest(payload, win7);
      std::cout << parsed.version << '\n';
      return 0;
    }
    if (argc != 1) throw std::runtime_error("Expected an optional manifest path");
    contract(); files();
    std::cout << "Win7 MCP policy: " << assertions << " assertions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Win7 MCP policy failed: " << error.what() << '\n';
    return 1;
  }
}
