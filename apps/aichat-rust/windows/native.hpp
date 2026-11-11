#pragma once
#include "common/policy.hpp"
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
std::string fetch_manifest(const std::string& url, const Progress& progress);
void download(const std::string& url, const std::filesystem::path& path, std::uint64_t size, const Progress& progress);
void allow_sandbox_read(const std::filesystem::path& path);
bool launch_cef(const std::filesystem::path& directory, const std::filesystem::path& profile,
                bool background, const Progress& progress);
bool launch_desktop(const std::filesystem::path& executable, bool background, const Progress& progress);
bool installation_busy(const std::filesystem::path& directory);
bool cef_running();
}
