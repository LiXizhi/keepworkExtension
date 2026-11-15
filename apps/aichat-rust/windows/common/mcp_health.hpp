#pragma once
#include <cstdint>
#include <string>
#include <nlohmann/json.hpp>

namespace keepwork {
struct McpHealth {
  bool responded = false, keepwork = false, owned = false;
  std::uint32_t pid = 0;
  std::string version, variant, terminal_api, terminal_status, terminal_reason;
};
inline McpHealth parse_mcp_health(const std::string& body) {
  McpHealth result;
  result.responded = true;
  try {
    const auto document = nlohmann::json::parse(body);
    result.keepwork = document.value("name", "") == "keepwork-mcp" && document.value("ok", false);
    if (document.contains("pid") && document.at("pid").is_number_unsigned()) {
      const auto pid = document.at("pid").get<std::uint64_t>();
      if (pid > 0 && pid <= UINT32_MAX) result.pid = static_cast<std::uint32_t>(pid);
    }
    // Optional identity fields never determine whether an existing peer is usable.
    if (document.contains("runtimeVersion") && document.at("runtimeVersion").is_string())
      result.version = document.at("runtimeVersion").get<std::string>();
    if (document.contains("runtimeVariant") && document.at("runtimeVariant").is_string())
      result.variant = document.at("runtimeVariant").get<std::string>();
    const auto optional_text = [&](const char* key, std::size_t limit) {
      if (!document.contains(key) || !document.at(key).is_string()) return std::string{};
      auto value = document.at(key).get<std::string>();
      if (value.size() > limit) return std::string{};
      for (auto& character : value)
        if (static_cast<unsigned char>(character) < 32 || character == 127) character = ' ';
      return value;
    };
    result.terminal_api = optional_text("terminalApi", 64);
    result.terminal_status = optional_text("terminalStatus", 64);
    result.terminal_reason = optional_text("terminalReason", 2048);
  } catch (...) { result.keepwork = false; }
  return result;
}
inline std::string mcp_service_status(const McpHealth& health) {
  if (!health.keepwork) return "本地服务未响应，请检查端口占用和安装目录中的服务日志。";
  std::string message;
  if (health.terminal_api == "pty-session-v1")
    message = "本地服务已运行，交互终端已就绪。\n请稍候（最多约30秒），再重新打开网页右上角的加号菜单。";
  else if (health.terminal_status == "initializing")
    message = "本地服务已运行，正在准备交互终端。\n请稍后重新打开网页右上角的加号菜单。";
  else if (health.terminal_status == "unavailable") {
    message = "本地服务已运行，交互终端暂不可用。";
    if (!health.terminal_reason.empty()) message += "\n\n" + health.terminal_reason;
  } else {
    message = "当前服务未声明交互终端能力，聊天和其它工具仍可使用。\n\n"
      "若要切换到安装包内置服务，请先完成所有客户端中的任务，再到本地 MCP 面板确认停止服务，"
      "然后再次点击“启动本地服务”。停止服务会中断正在运行的任务和终端。";
  }
  if (!health.version.empty() && health.version.size() <= 128)
    message += "\n\n当前服务版本：" + health.version;
  return message;
}
}
