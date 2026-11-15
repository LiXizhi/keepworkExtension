#include "mcp_restart_identity.hpp"
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
json runtime(const std::string& version) {
  return {
    {"schemaVersion", 2}, {"product", "keepwork-mcp-runtime"}, {"engine", "rust"},
    {"variant", "win7-win8"}, {"platform", "windows"}, {"arch", "x64"},
    {"buildTarget", "x86_64-win7-windows-msvc"}, {"entry", "bin/keepwork-mcp.exe"},
    {"minWindows", json::array({6, 1, 7601})}, {"version", version},
    {"commit", std::string(40, 'a')}, {"sourceHash", std::string(64, 'b')},
  };
}
nlohmann::ordered_json embedded(const std::string& version) {
  return {
    {"marker", "keepwork-mcp-build-v1"}, {"product", "keepwork-mcp-runtime"}, {"engine", "rust"},
    {"variant", "win7-win8"}, {"version", version}, {"target", "x86_64-win7-windows-msvc"},
    {"commit", std::string(40, 'a')}, {"sourceHash", std::string(64, 'b')},
    {"endMarker", "keepwork-mcp-build-end"},
  };
}
keepwork::McpHealth health(const std::string& version) {
  auto value = keepwork::parse_mcp_health(json{
    {"name", "keepwork-mcp"}, {"ok", true}, {"pid", 4242}, {"runtimeVersion", version},
    {"runtimeCommit", std::string(40, 'a')}, {"runtimeEngine", "rust"},
    {"runtimeVariant", "win7-win8"}, {"hostKind", "win7-win8-desktop"},
  }.dump());
  return value;
}
std::string image(const nlohmann::ordered_json& record) {
  return "MZ fixture prefix" + record.dump() + " PE fixture suffix";
}
void old_and_current_edition_identity() {
  for (const auto& version : {"0.2.66", "0.2.69"}) {
    const auto metadata = runtime(version);
    const auto record = embedded(version);
    const auto peer = health(version);
    expect(keepwork::mcp_restart_runtime_identity(metadata, image(record), peer),
      "a real legacy metadata shape can identify stopping ownership without trusting it as executable replacement input");
    auto additive = metadata;
    additive["futureOptionalField"] = {{"enabled", true}};
    expect(keepwork::mcp_restart_runtime_identity(additive, image(record), peer),
      "additive runtime metadata preserves same-edition ownership evidence");
    for (const auto* required : {"schemaVersion", "product", "engine", "variant", "platform", "arch", "buildTarget",
        "entry", "minWindows", "version", "commit", "sourceHash"}) {
      auto missing = metadata;
      missing.erase(required);
      expect(!keepwork::mcp_restart_runtime_identity(missing, image(record), peer),
        "missing disk identity cannot confer authority to stop a process");
    }
    for (const auto& field : std::vector<std::pair<std::string, json>>{
        {"schemaVersion", 1}, {"product", "aichat-desktop"}, {"engine", "node"}, {"variant", "modern"},
        {"platform", "macos"}, {"arch", "arm64"}, {"buildTarget", "x86_64-pc-windows-msvc"},
        {"entry", "other.exe"}, {"minWindows", json::array({10, 0, 0})}, {"version", "0.2.65"},
        {"commit", std::string(40, 'c')}, {"sourceHash", std::string(64, 'd')},
      }) {
      auto changed = metadata;
      changed[field.first] = field.second;
      expect(!keepwork::mcp_restart_runtime_identity(changed, image(record), peer),
        "disk, health and embedded identities must agree across every product and build boundary");
    }
    for (const auto* required : {"product", "engine", "variant", "version", "target", "commit", "sourceHash"}) {
      auto missing = record;
      missing.erase(required);
      expect(!keepwork::mcp_restart_runtime_identity(metadata, image(missing), peer),
        "a marker alone cannot replace complete embedded build identity");
    }
    auto reused_peer = peer;
    reused_peer.version = "99.0.0";
    expect(!keepwork::mcp_restart_runtime_identity(metadata, image(record), reused_peer),
      "a health reply from another build cannot match the held executable");
    reused_peer = peer;
    reused_peer.commit = std::string(40, 'c');
    expect(!keepwork::mcp_restart_runtime_identity(metadata, image(record), reused_peer),
      "a changed health commit invalidates disk ownership evidence");
    expect(!keepwork::mcp_restart_runtime_identity(metadata, "MZ no build identity", peer),
      "an executable lacking the build marker cannot claim edition ownership");
    expect(!keepwork::mcp_restart_runtime_identity(metadata,
        "{\"marker\":\"keepwork-mcp-build-v1\"," + std::string(16400, ' ')
          + "\"endMarker\":\"keepwork-mcp-build-end\"}", peer),
      "oversized embedded identity is refused before JSON decoding");
    expect(!keepwork::mcp_restart_runtime_identity(metadata,
        "{\"marker\":\"keepwork-mcp-build-v1\",invalid,\"endMarker\":\"keepwork-mcp-build-end\"}", peer),
      "malformed embedded JSON stays an unavailable ownership proof");
  }
}
}

int main() {
  try {
    old_and_current_edition_identity();
    std::cout << "Compatibility MCP identity: " << assertions << " assertions passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Compatibility MCP identity failure: " << error.what() << '\n';
    return 1;
  }
}
