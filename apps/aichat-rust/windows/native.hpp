#pragma once
#include "common/policy.hpp"
#include "common/mcp_health.hpp"
#include <windows.h>
#include <filesystem>
#include <functional>
#include <string>

namespace keepwork {
using Progress = std::function<void(const std::wstring&, std::uint64_t, std::uint64_t)>;
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
std::wstring wide(const std::string& text);
std::string utf8(const std::wstring& text);
std::wstring quote(const std::wstring& argument);
std::filesystem::path executable_dir();
std::filesystem::path local_data();
WindowsVersion windows_version();
const char* architecture();
bool probe_webview(const std::filesystem::path& probe_profile, const Progress& progress);
std::string sha256_file(const std::filesystem::path& path);
std::string verify_envelope(const std::string& envelope);
std::string verify_client_update_envelope(const std::string& envelope);
std::string fetch_manifest(const std::string& url, const Progress& progress);
void download(const std::string& url, const std::filesystem::path& path, std::uint64_t size, const Progress& progress);
void allow_sandbox_read(const std::filesystem::path& path);
bool launch_cef(const std::filesystem::path& directory, const std::filesystem::path& profile,
                bool background, const Progress& progress, bool service_launcher = false, bool maintenance = false);
bool launch_desktop(const std::filesystem::path& executable, bool background, const Progress& progress);
bool installation_busy(const std::filesystem::path& directory);
bool cef_running();
McpHealth probe_mcp_health();
McpHealth launch_mcp_process(const std::filesystem::path& directory, const std::string& version,
                            const std::string& variant, const wchar_t* host_kind,
                            const std::filesystem::path& log_directory, const Progress& progress);
void start_compatible_mcp(WindowsVersion os, const Progress& progress);
bool restart_managed_mcp(const std::filesystem::path& cache_root,
                        const std::filesystem::path& bundle_root,
                        const Progress& progress, const std::function<void()>& prepare,
                        const std::function<void(const McpHealth&)>& validate_running,
                        const std::function<bool()>& confirm, const std::function<void()>& start);
void mcp_startup_warning(const std::filesystem::path& directory, const std::string& message);
}
