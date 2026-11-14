#pragma once
#include "policy.hpp"

namespace keepwork {
// This manifest is independently signed. A modern runtime with an identical
// product/architecture/version is never a Win7 candidate.
Manifest validate_win7_mcp_manifest(const std::string& payload, WindowsVersion os);
constexpr const char* win7_mcp_base = "https://cdn.keepwork.com/keepwork/mcp-win7-win8-rs/";
constexpr const char* win7_client_base = "https://cdn.keepwork.com/keepwork/aichat-rust-win7-win8/";
}
