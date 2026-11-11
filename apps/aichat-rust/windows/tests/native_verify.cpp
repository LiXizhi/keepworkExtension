// A console verifier for Windows CI. It uses the launcher's real pinned RSA
// key, BCrypt SHA256, manifest policy, and ZIP extractor; no browser/network.
#include "native.hpp"
#include "common/archive.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <regex>
#include <stdexcept>

namespace fs = std::filesystem;
std::string read_envelope(const fs::path& file) {
  keepwork::plain_path(file);
  if (!fs::is_regular_file(file) || fs::file_size(file) > 2 * 1024 * 1024)
    throw std::runtime_error("Invalid envelope file");
  std::ifstream input(file, std::ios::binary);
  std::string text((std::istreambuf_iterator<char>(input)), {});
  if (input.bad()) throw std::runtime_error("Cannot read envelope");
  return text;
}
keepwork::WindowsVersion version(const std::wstring& value) {
  const auto text = keepwork::utf8(value);
  std::smatch match;
  if (!std::regex_match(text, match, std::regex("([0-9]{1,6})\\.([0-9]{1,6})\\.([0-9]{1,6})")))
    throw std::runtime_error("Expected major.minor.build");
  return {static_cast<unsigned>(std::stoul(match[1])), static_cast<unsigned>(std::stoul(match[2])), static_cast<unsigned>(std::stoul(match[3]))};
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 3 && std::wstring(argv[1]) == L"envelope") {
      std::cout << keepwork::verify_envelope(read_envelope(argv[2]));
      return 0;
    }
    if (argc == 8 && std::wstring(argv[1]) == L"package") {
      const auto payload = keepwork::verify_envelope(read_envelope(argv[2]));
      const auto manifest = keepwork::validate_manifest(payload, keepwork::utf8(argv[5]), keepwork::utf8(argv[6]), version(argv[7]));
      const fs::path archive = argv[3], output = argv[4];
      if (fs::file_size(archive) != manifest.size || keepwork::sha256_file(archive) != manifest.sha256)
        throw std::runtime_error("Archive size/hash does not match signed manifest");
      keepwork::extract_package(archive, output, manifest, keepwork::sha256_file);
      keepwork::verify_package(output, manifest, keepwork::sha256_file);
      std::cout << "Native CEF signature, SHA256, ZIP and cache verification passed\n";
      return 0;
    }
    throw std::runtime_error("Usage: native-verify envelope SIGNED.json | package SIGNED.json ARCHIVE.zip EMPTY_OUTPUT CHANNEL ARCH WINDOWS_VERSION");
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 2;
  }
}
