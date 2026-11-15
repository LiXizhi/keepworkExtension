#include "policy.hpp"
#include "archive.hpp"
#include "mcp_health.hpp"
#include <nlohmann/json.hpp>
#include <miniz.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using nlohmann::json;
using keepwork::WindowsVersion;
unsigned assertions = 0;
void expect(bool condition, const std::string& message) {
  ++assertions;
  if (!condition) throw std::runtime_error(message);
}
void rejects(const std::function<void()>& action, const std::string& message) {
  ++assertions;
  try { action(); } catch (const std::exception&) { return; }
  throw std::runtime_error("Accepted invalid input: " + message);
}
json manifest(const std::string& channel = "legacy", const std::string& arch = "x64") {
  json files = json::array();
  for (const auto* name : {"keepwork-cef.exe", "libcef.dll", "icudtl.dat", "resources.pak", "locales/en-US.pak"})
    files.push_back({{"path", name}, {"size", 1}, {"sha256", std::string(64, 'b')}});
  const unsigned major = channel == "legacy" ? 109 : 143;
  if (major >= 138) files.push_back({{"path", "keepwork-cef.dll"}, {"size", 1}, {"sha256", std::string(64, 'b')}});
  return {{"schemaVersion", 1}, {"product", "keepwork-aichat-cef"}, {"hostProtocol", 1},
          {"channel", channel}, {"arch", arch}, {"entry", "keepwork-cef.exe"},
          {"minWindows", channel == "legacy" ? json::array({6, 1, 7601}) : json::array({10, 0, 0})},
          {"version", "0.2.41"}, {"cefVersion", std::to_string(major) + ".1.2+g1234567+chromium-" + std::to_string(major) + ".0.0.0"},
          {"chromiumMajor", major}, {"size", 100}, {"unpackedSize", files.size()},
          {"sha256", std::string(64, 'a')}, {"files", files}};
}
const WindowsVersion win7{6, 1, 7601}, win10{10, 0, 19045};
void invalid(const std::function<void(json&)>& mutate, const std::string& label) {
  auto value = manifest(); mutate(value);
  rejects([&] { keepwork::validate_manifest(value.dump(), "legacy", "x64", win7); }, label);
}
void selection() {
  for (const auto os : {win7, WindowsVersion{6, 2, 9200}, WindowsVersion{6, 3, 9600}}) {
    expect(keepwork::select_channel(os, false) == "legacy", "Older Windows needs legacy CEF");
    expect(keepwork::select_channel(os, true) == "legacy", "Old WebView2 installation must not bypass legacy policy");
  }
  for (const auto os : {win10, WindowsVersion{10, 0, 22631}, WindowsVersion{11, 0, 1}}) {
    expect(keepwork::select_channel(os, true).empty(), "Healthy modern WebView2 remains preferred");
    expect(keepwork::select_channel(os, false) == "modern", "Missing modern WebView2 selects modern CEF");
  }
  for (const auto os : {WindowsVersion{0, 0, 0}, WindowsVersion{5, 1, 2600}, WindowsVersion{6, 0, 6002},
                        WindowsVersion{6, 1, 7600}, WindowsVersion{6, 4, 1}, WindowsVersion{9, 0, 1}})
    rejects([&] { keepwork::select_channel(os, true); }, "unsupported OS even with WebView2");
}
void mcp_health_contracts() {
  const json base{{"name", "keepwork-mcp"}, {"ok", true}};
  const auto legacy = keepwork::parse_mcp_health(base.dump());
  expect(legacy.responded && legacy.keepwork, "Existing MCP needs no optional identity metadata");
  expect(legacy.pid == 0 && legacy.version.empty() && legacy.variant.empty(), "Missing identity remains unknown");
  expect(legacy.terminal_api.empty() && legacy.terminal_status.empty() && legacy.terminal_reason.empty(),
    "A legacy peer may omit every additive terminal field");
  expect(keepwork::mcp_service_status(legacy).find("未声明") != std::string::npos,
    "The service result explains missing capability without declaring a newer version required");
  auto terminal = base;
  terminal["terminalApi"] = "pty-session-v1";
  terminal["terminalStatus"] = "future-status";
  expect(keepwork::mcp_service_status(keepwork::parse_mcp_health(terminal.dump())).find("已就绪") != std::string::npos,
    "A recognized capability works even if an additive status is unknown");
  terminal["terminalApi"] = "future-pty";
  terminal["terminalStatus"] = "ready";
  expect(keepwork::mcp_service_status(keepwork::parse_mcp_health(terminal.dump())).find("未声明") != std::string::npos,
    "A ready status alone cannot invent support for an unknown terminal contract");
  terminal.erase("terminalApi");
  terminal["terminalStatus"] = "initializing";
  expect(keepwork::mcp_service_status(keepwork::parse_mcp_health(terminal.dump())).find("正在准备") != std::string::npos,
    "Cold startup is distinct from missing capability");
  terminal["terminalStatus"] = "unavailable";
  terminal["terminalReason"] = "Agent initialization timed out\nRetry will follow";
  const auto unavailable = keepwork::parse_mcp_health(terminal.dump());
  expect(unavailable.keepwork && unavailable.terminal_reason == "Agent initialization timed out Retry will follow",
    "Backend diagnostics are plain bounded text without control characters");
  expect(keepwork::mcp_service_status(unavailable).find("Agent initialization timed out") != std::string::npos,
    "The explicit service action shows the actual unavailable reason");
  terminal["terminalReason"] = std::string(2049, 'x');
  expect(keepwork::parse_mcp_health(terminal.dump()).terminal_reason.empty(),
    "Oversized diagnostics are discarded without splitting UTF-8 or rejecting the service");
  for (const auto& value : {json(nullptr), json(false), json(1), json::array(), json::object()}) {
    auto peer = base;
    peer["terminalApi"] = peer["terminalStatus"] = peer["terminalReason"] = value;
    const auto parsed = keepwork::parse_mcp_health(peer.dump());
    expect(parsed.keepwork && parsed.terminal_api.empty() && parsed.terminal_status.empty() && parsed.terminal_reason.empty(),
      "Malformed additive terminal fields do not reject an otherwise usable peer");
  }
  auto current = base;
  current["pid"] = 123;
  current["runtimeVersion"] = "0.2.61";
  current["runtimeVariant"] = "win7-win8";
  current["futureCapability"] = {{"enabled", true}};
  current["owned"] = true;
  const auto known = keepwork::parse_mcp_health(current.dump());
  expect(known.keepwork && known.pid == 123 && known.version == "0.2.61" && known.variant == "win7-win8",
    "Decode current MCP identity and accept additive fields");
  expect(!known.owned, "HTTP fields can never establish ownership of a spawned child");
  for (const auto& value : {json(nullptr), json(false), json(1), json::array(), json::object()}) {
    auto peer = base;
    peer["runtimeVersion"] = peer["runtimeVariant"] = value;
    const auto parsed = keepwork::parse_mcp_health(peer.dump());
    expect(parsed.keepwork && parsed.version.empty() && parsed.variant.empty(),
      "Malformed optional identity must not make a usable peer unavailable");
  }
  for (const auto& version : {"0.1.0", "99.100.101", "unknown", ""}) {
    auto peer = base; peer["runtimeVersion"] = version; peer["runtimeVariant"] = "future-runtime";
    const auto parsed = keepwork::parse_mcp_health(peer.dump());
    expect(parsed.keepwork && parsed.version == version && parsed.variant == "future-runtime",
      "Peer versions and variants do not gate shared capabilities");
  }
  for (const auto& pid : {json(nullptr), json(false), json("123"), json(-1), json(1.5),
      json(0), json(std::uint64_t{UINT32_MAX} + 1), json::array(), json::object()}) {
    auto peer = base; peer["pid"] = pid;
    const auto parsed = keepwork::parse_mcp_health(peer.dump());
    expect(parsed.keepwork && parsed.pid == 0, "Malformed optional PID remains unknown without blocking attachment");
  }
  auto largest_pid = base; largest_pid["pid"] = std::uint64_t{UINT32_MAX};
  expect(keepwork::parse_mcp_health(largest_pid.dump()).pid == UINT32_MAX, "Retain full-width Windows process IDs");
  for (const auto& name : {json(nullptr), json(1), json(true), json("other-service"), json("KEEPWORK-MCP")}) {
    auto foreign = base; foreign["name"] = name;
    const auto parsed = keepwork::parse_mcp_health(foreign.dump());
    expect(parsed.responded && !parsed.keepwork, "Wrong or malformed service identity must not be attached");
  }
  for (const auto& ok : {json(nullptr), json(0), json("true"), json(false), json::array(), json::object()}) {
    auto unhealthy = base; unhealthy["ok"] = ok;
    expect(!keepwork::parse_mcp_health(unhealthy.dump()).keepwork, "Require the actual boolean health success field");
  }
  for (const auto* missing : {"name", "ok"}) {
    auto absent = base; absent.erase(missing);
    expect(!keepwork::parse_mcp_health(absent.dump()).keepwork, "Missing required health field is unavailable");
  }
  for (const auto* body : {"", "{", "null", "true", "[]", "<html>foreign service</html>"}) {
    const auto parsed = keepwork::parse_mcp_health(body);
    expect(parsed.responded && !parsed.keepwork, "Malformed health response is an occupied foreign endpoint");
  }
}
void cached_host_versions() {
  const auto host = [](const std::string& version, const std::string& channel = "legacy", const std::string& arch = "x64") {
    auto value = manifest(channel, arch); value["version"] = version;
    return keepwork::validate_manifest(value.dump(), channel, arch, channel == "legacy" ? win7 : win10);
  };
  const auto cached = host("0.2.99");
  expect(keepwork::newer_cef_host(host("0.2.100"), cached), "Promote newer bundled host using numeric patch ordering");
  expect(!keepwork::newer_cef_host(host("0.2.98"), cached), "Never downgrade a cached host to the bundled version");
  expect(!keepwork::newer_cef_host(host("0.2.99"), cached), "An equal bundle does not replace the active host");
  expect(keepwork::newer_cef_host(host("0.10.0"), cached), "Compare numeric minor versions");
  expect(keepwork::newer_cef_host(host("1.0.0"), cached), "Compare major version before minor or patch");
  expect(!keepwork::newer_cef_host(host("0.9.999"), host("1.0.0")), "A large patch cannot bypass a lower major version");
  expect(!keepwork::newer_cef_host(host("00.002.099"), cached), "Leading zeroes do not create a false upgrade");
  expect(keepwork::newer_cef_host(host("0.2.000100"), cached), "Leading zeroes preserve numeric version comparison");
  expect(keepwork::newer_cef_host(host("123456789012345678901234567890.0.0"), host("99999999999999999999999999999.0.0")),
    "Long signed version components compare without integer truncation");
  expect(!keepwork::newer_cef_host(host("9.0.0", "modern"), cached), "A modern host cannot replace a legacy cache");
  expect(!keepwork::newer_cef_host(host("9.0.0"), host("0.2.99", "modern")), "A legacy host cannot replace a modern cache");
  expect(!keepwork::newer_cef_host(host("9.0.0", "legacy", "x86"), cached), "A newer host cannot replace another architecture");
  expect(!keepwork::newer_cef_host(host("9.0.0", "modern", "arm64"), host("0.2.99", "modern")),
    "Modern ARM64 and x64 caches remain independent");
}
void paths() {
  for (const auto& path : {"keepwork-cef.exe", "locales/en-US.pak", "swiftshader/vk_swiftshader.dll", "LICENSE.txt", "a..b/file", "com10.txt"})
    expect(keepwork::zip_path(path, false) == path, std::string("Valid runtime path: ") + path);
  expect(keepwork::zip_path("locales/", true) == "locales", "Normalize directory slash");
  const std::vector<std::string> unsafe = {
    "", "/", "/tmp/payload", "//server/share/a", "C:/payload", "C:payload", "../payload", "a/../../payload",
    "a/./payload", "a//payload", "a/..", "a/.", "a/", "a\\payload", "a:payload", "a/file:stream",
    "a/file.", "a/file ", "a./file", "a /file", "NUL", "CON.txt", "conin$", "CONOUT$.txt",
    "COM0", "COM1.dll", "LPT9.txt", "a/AUX.dll", "PRN", "a<.txt", "a>.txt", "a?.txt", "a*.txt",
    "a|.txt", "a\".txt", std::string("a\0b", 3), "a\nb", "locales/\xc3\xa9.pak", std::string(180, 'a')
  };
  for (const auto& path : unsafe)
    rejects([&] { keepwork::zip_path(path, false); }, "unsafe ZIP path");
  for (const auto& path : {"/", "../", "a//", "NUL/", "a/../"})
    rejects([&] { keepwork::zip_path(path, true); }, "unsafe ZIP directory");
  expect(keepwork::is_sha256(std::string(64, 'a')), "Lowercase SHA256");
  for (const auto& digest : {std::string(), std::string(63, 'a'), std::string(65, 'a'), std::string(64, 'A'), std::string(64, 'g')})
    expect(!keepwork::is_sha256(digest), "Reject malformed SHA256");
}
void contracts() {
  const auto legacy = keepwork::validate_manifest(manifest().dump(), "legacy", "x64", win7);
  expect(!legacy.service_launcher, "Older signed hosts receive no unknown launcher argument");
  for (const auto& value : {json(nullptr), json(false), json(true), json("1"), json(2), json(1)}) {
    auto capable = manifest(); capable["serviceLauncher"] = value;
    expect(keepwork::validate_manifest(capable.dump(), "legacy", "x64", win7).service_launcher ==
      (value.is_number_integer() && value == 1), "Only the supported optional service launcher contract is enabled");
  }
  expect(legacy.files.size() == 5 && legacy.chromium_major == 109 && legacy.size == 100, "Decode legacy manifest");
  auto modern = manifest("modern", "arm64");
  expect(keepwork::validate_manifest(modern.dump(), "modern", "arm64", win10).chromium_major == 143, "Decode modern ARM64 manifest");
  auto missing_dll = modern; missing_dll["files"].erase(5); missing_dll["unpackedSize"] = 5;
  rejects([&] { keepwork::validate_manifest(missing_dll.dump(), "modern", "arm64", win10); }, "modern sandbox application DLL missing");
  auto unsupported_modern = modern; unsupported_modern["chromiumMajor"] = 137; unsupported_modern["cefVersion"] = "137.1.2";
  rejects([&] { keepwork::validate_manifest(unsupported_modern.dump(), "modern", "arm64", win10); }, "unsupported modern sandbox generation");
  expect(keepwork::validate_manifest(manifest("legacy", "x86").dump(), "legacy", "x86", win7).arch == "x86", "Decode legacy x86 manifest");
  auto additive = manifest(); additive["futureOptionalField"] = true;
  expect(keepwork::validate_manifest(additive.dump(), "legacy", "x64", win7).version == "0.2.41", "Accept additive fields");
  rejects([&] { keepwork::validate_manifest(manifest().dump(), "legacy", "x64", win10); }, "legacy channel on modern Windows");
  rejects([&] { keepwork::validate_manifest(modern.dump(), "modern", "arm64", win7); }, "modern channel on Win7");
  rejects([&] { keepwork::validate_manifest(manifest("legacy", "arm64").dump(), "legacy", "arm64", win7); }, "legacy ARM64");
  rejects([&] { keepwork::validate_manifest(manifest().dump(), "nightly", "x64", win7); }, "unknown channel");
  rejects([&] { keepwork::validate_manifest(manifest().dump(), "legacy", "mips", win7); }, "unknown architecture");
  rejects([&] { keepwork::validate_manifest("{", "legacy", "x64", win7); }, "malformed JSON");
  rejects([&] { keepwork::validate_manifest(std::string(1024 * 1024 + 1, ' '), "legacy", "x64", win7); }, "oversized manifest");
  invalid([](json& j) { j.erase("files"); }, "missing file table");
  invalid([](json& j) { j["schemaVersion"] = 2; }, "unsupported schema");
  invalid([](json& j) { j["product"] = "other-product"; }, "cross-product artifact");
  invalid([](json& j) { j["hostProtocol"] = 2; }, "unsupported host protocol");
  invalid([](json& j) { j["channel"] = "modern"; }, "channel mismatch");
  invalid([](json& j) { j["arch"] = "x86"; }, "architecture mismatch");
  invalid([](json& j) { j["entry"] = "other.exe"; }, "arbitrary entry executable");
  invalid([](json& j) { j["minWindows"] = {10, 0, 0}; }, "newer OS required");
  invalid([](json& j) { j["minWindows"] = {6, 1, 7600}; }, "baseline below SP1");
  invalid([](json& j) { j["minWindows"] = {6, 1}; }, "incomplete OS version");
  invalid([](json& j) { j["minWindows"] = {6, -1, 7601}; }, "negative OS component");
  invalid([](json& j) { j["minWindows"] = {6, 1.5, 7601}; }, "fractional OS component");
  invalid([](json& j) { j["minWindows"] = {6, 1, 1000001}; }, "oversized OS component");
  invalid([](json& j) { j["version"] = "../host"; }, "invalid host version");
  invalid([](json& j) { j["chromiumMajor"] = 110; j["cefVersion"] = "110.1.2"; }, "modern engine in legacy channel");
  invalid([](json& j) { j["chromiumMajor"] = -109; }, "negative Chromium generation");
  invalid([](json& j) { j["chromiumMajor"] = 4294967405ULL; }, "Chromium generation truncation to 109");
  invalid([](json& j) { j["cefVersion"] = "110.1.2"; }, "CEF major mismatch");
  invalid([](json& j) { j["cefVersion"] = "109.1.2/unsafe"; }, "unsafe CEF version");
  invalid([](json& j) { j["size"] = 0; }, "empty archive");
  invalid([](json& j) { j["size"] = -1; }, "negative archive size");
  invalid([](json& j) { j["size"] = 1.5; }, "fractional archive size");
  invalid([](json& j) { j["size"] = keepwork::max_archive_size + 1; }, "oversized archive");
  invalid([](json& j) { j["unpackedSize"] = keepwork::max_unpacked_size + 1; }, "decompression limit");
  invalid([](json& j) { j["sha256"] = std::string(64, 'A'); }, "noncanonical archive digest");
  invalid([](json& j) { j["files"][0]["path"] = "../keepwork-cef.exe"; }, "manifest path traversal");
  invalid([](json& j) { j["files"][0]["sha256"] = "bad"; }, "malformed file digest");
  invalid([](json& j) { j["files"][0]["size"] = -1; }, "negative file size");
  invalid([](json& j) { j["files"][0]["size"] = keepwork::max_archive_size + 1; }, "oversized file");
  invalid([](json& j) { j["files"][0]["size"] = 2; }, "unpacked total mismatch");
  invalid([](json& j) { j["files"].push_back(j["files"][0]); j["unpackedSize"] = 6; }, "duplicate file");
  invalid([](json& j) { auto f = j["files"][0]; f["path"] = "KEEPWORK-CEF.EXE"; j["files"].push_back(f); j["unpackedSize"] = 6; }, "case-colliding files");
  invalid([](json& j) { auto f = j["files"][0]; f["path"] = "locales"; j["files"].push_back(f); j["unpackedSize"] = 6; }, "file/directory collision");
  for (unsigned index = 0; index < 5; ++index)
    invalid([index](json& j) { j["files"][index]["path"] = "other-" + std::to_string(index) + ".bin"; }, "required runtime asset missing");
  invalid([](json& j) { j["files"] = json::array(); }, "empty runtime");
}
namespace fs = std::filesystem;
using Entries = std::vector<std::pair<std::string, std::string>>;
void zip_file(const fs::path& file, const Entries& entries, bool symlink = false) {
  mz_zip_archive writer{};
  if (!mz_zip_writer_init_heap(&writer, 0, 0)) throw std::runtime_error("Fixture ZIP init failed");
  struct End { mz_zip_archive* zip; ~End() { mz_zip_writer_end(zip); } } end{&writer};
  for (const auto& entry : entries)
    if (!mz_zip_writer_add_mem(&writer, entry.first.c_str(), entry.second.data(), entry.second.size(), MZ_BEST_SPEED))
      throw std::runtime_error("Fixture ZIP entry failed: " + entry.first);
  void* buffer = nullptr; size_t size = 0;
  if (!mz_zip_writer_finalize_heap_archive(&writer, &buffer, &size)) throw std::runtime_error("Fixture ZIP finalize failed");
  std::string bytes(static_cast<char*>(buffer), size); mz_free(buffer);
  if (symlink) {
    const auto central = bytes.find(std::string("PK\x01\x02", 4));
    if (central == std::string::npos) throw std::runtime_error("No fixture ZIP central directory");
    const std::uint32_t attributes = 0120777U << 16;
    bytes[central + 5] = 3; // UNIX creator; symlink mode in external attributes.
    for (unsigned offset = 0; offset < 4; ++offset) bytes[central + 38 + offset] = char(attributes >> (offset * 8));
  }
  std::ofstream out(file, std::ios::binary); out.write(bytes.data(), bytes.size());
}
// Exercise integrity dispatch without a platform crypto dependency. Each fixture
// file is exactly one byte; the callback observes those bytes and maps to the
// expected signed digest. Packaging tests separately use real RSA and SHA256.
std::string fixture_hash(const fs::path& file) {
  std::ifstream in(file, std::ios::binary);
  return std::string(64, char(in.get()));
}
void archives() {
  const auto unique = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::canonical(fs::temp_directory_path()) / ("keepwork-cef-policy-" + std::to_string(unique));
  fs::create_directories(root);
  struct Cleanup { fs::path path; ~Cleanup() { std::error_code ec; fs::remove_all(path, ec); } } cleanup{root};
  const auto metadata = keepwork::validate_manifest(manifest().dump(), "legacy", "x64", win7);
  Entries entries{{"locales/", ""}};
  for (const auto& record : metadata.files) entries.push_back({record.path, "b"});
  const auto archive = root / "runtime.zip", destination = root / "good";
  zip_file(archive, entries);
  keepwork::extract_package(archive, destination, metadata, fixture_hash);
  expect(fs::file_size(destination / "keepwork-cef.exe") == 1, "Valid archive extracts");
  keepwork::verify_package(destination, metadata, fixture_hash);
  rejects([&] { keepwork::extract_package(archive, destination, metadata, fixture_hash); }, "nonempty staging directory");
  std::ofstream(destination / "libcef.dll", std::ios::binary) << "c";
  rejects([&] { keepwork::verify_package(destination, metadata, fixture_hash); }, "same-size cached file tampering");
  std::ofstream(destination / "libcef.dll", std::ios::binary) << "b";
  std::ofstream(destination / "untrusted.exe", std::ios::binary) << "b";
  rejects([&] { keepwork::verify_package(destination, metadata, fixture_hash); }, "extra cached executable");
  fs::remove(destination / "untrusted.exe"); fs::remove(destination / "resources.pak");
  rejects([&] { keepwork::verify_package(destination, metadata, fixture_hash); }, "missing cached asset");
  unsigned candidate = 0;
  const auto bad_zip = [&](const Entries& bad, const std::string& label, bool before_write = true, bool symlink = false) {
    const auto dir = root / ("bad-" + std::to_string(++candidate));
    zip_file(archive, bad, symlink);
    rejects([&] { keepwork::extract_package(archive, dir, metadata, fixture_hash); }, label);
    if (before_write) expect(!fs::exists(dir) || fs::is_empty(dir), "Validate whole archive before writing: " + label);
  };
  auto bad = entries; bad.push_back({"unexpected.exe", "b"});
  bad_zip(bad, "extra unsigned ZIP file");
  bad = entries; bad.push_back(entries.back()); bad_zip(bad, "duplicate ZIP member");
  bad = entries; bad.push_back({"unneeded/", ""}); bad_zip(bad, "unsigned ZIP directory");
  bad = entries; bad[1].second = "bb"; bad_zip(bad, "uncompressed size mismatch");
  bad = entries; bad[1].second = "c"; bad_zip(bad, "same-size archive content mismatch", false);
  bad = entries; bad.erase(bad.begin() + 1); bad_zip(bad, "missing ZIP file", false);
  for (const auto& path : {"../outside.exe", "C:/outside.exe", "a/../../outside.exe", "locales/en-US.pak:stream", "NUL"}) {
    bad = entries; bad.push_back({path, "b"}); bad_zip(bad, "unsafe ZIP member");
  }
  bad = entries; bad[1].first = "KEEPWORK-CEF.EXE"; bad_zip(bad, "case-changed unsigned ZIP path");
  bad = entries; bad.erase(bad.begin()); bad_zip(bad, "symlink ZIP member", true, true);
  const auto target = root / "target";
  fs::create_directory(target);
  const auto link = root / "link";
  std::error_code link_error; fs::create_directory_symlink(target, link, link_error);
  if (!link_error) {
    rejects([&] { keepwork::plain_path(link / "candidate"); }, "symlink cache ancestor");
    zip_file(archive, entries);
    rejects([&] { keepwork::extract_package(archive, link / "candidate", metadata, fixture_hash); }, "symlink staging ancestor");
    expect(fs::is_empty(target), "No writes through cache link");
  } else {
#ifndef _WIN32
    throw std::runtime_error("Cannot create symlink fixture: " + link_error.message());
#else
    std::cout << "SKIP cache symlink creation: " << link_error.message() << '\n';
#endif
  }
  std::ofstream(archive, std::ios::binary | std::ios::trunc) << "invalid ZIP";
  rejects([&] { keepwork::extract_package(archive, root / "invalid", metadata, fixture_hash); }, "corrupt ZIP format");
  expect(!fs::exists(root / "outside.exe"), "Traversal never writes outside staging");
}
}
int main() {
  try {
    selection(); mcp_health_contracts(); cached_host_versions(); paths(); contracts(); archives();
    std::cout << "CEF policy: " << assertions << " assertions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "CEF policy failed: " << error.what() << '\n';
    return 1;
  }
}
