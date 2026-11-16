#pragma once
#include "mcp_health.hpp"
#include "policy.hpp"
#include <nlohmann/json.hpp>
#include <regex>
#include <string>

namespace keepwork {
// This recognizes a managed process for stopping only. New executable launch
// permissions always come from the separately verified signed package.
inline bool mcp_restart_runtime_identity(const nlohmann::json& runtime, const std::string& executable, const McpHealth& health) {
  try {
    if (runtime.at("schemaVersion") != 2 || runtime.at("product") != "keepwork-mcp-runtime" || runtime.at("engine") != "rust"
        || runtime.at("variant") != "win7-win8" || runtime.at("platform") != "windows" || runtime.at("arch") != "x64"
        || runtime.at("buildTarget") != "x86_64-win7-windows-msvc" || runtime.at("entry") != "bin/keepwork-mcp.exe"
        || runtime.at("minWindows") != nlohmann::json::array({6, 1, 7601})
        || runtime.at("version") != health.version || runtime.at("commit") != health.commit
        || !std::regex_match(health.version, std::regex("[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}"))
        || !std::regex_match(health.commit, std::regex("[a-f0-9]{40}"))
        || !is_sha256(runtime.at("sourceHash").get<std::string>())) return false;
    const std::string start = "{\"marker\":\"keepwork-mcp-build-v1\",";
    const std::string ending = "\"endMarker\":\"keepwork-mcp-build-end\"}";
    const auto begin = executable.find(start);
    if (begin == std::string::npos) return false;
    const auto end = executable.find(ending, begin);
    if (end == std::string::npos || end - begin > 16384) return false;
    const auto embedded = nlohmann::json::parse(executable.substr(begin, end + ending.size() - begin));
    return embedded.at("product") == runtime.at("product") && embedded.at("engine") == runtime.at("engine")
      && embedded.at("variant") == runtime.at("variant") && embedded.at("version") == runtime.at("version")
      && embedded.at("target") == runtime.at("buildTarget") && embedded.at("commit") == runtime.at("commit")
      && embedded.at("sourceHash") == runtime.at("sourceHash");
  } catch (...) { return false; }
}
}
