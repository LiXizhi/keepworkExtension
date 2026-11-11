#include "archive.hpp"
#include <miniz.h>
#include <cstdio>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif

namespace keepwork {
namespace fs = std::filesystem;
void plain_path(const fs::path& path) {
  for (fs::path current = fs::absolute(path); !current.empty(); current = current.parent_path()) {
#ifdef _WIN32
    auto attrs = GetFileAttributesW(current.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT))
      throw std::runtime_error("Runtime cache cannot contain reparse points");
#else
    if (fs::is_symlink(fs::symlink_status(current))) throw std::runtime_error("Runtime cache cannot contain symlinks");
#endif
    if (current == current.root_path()) break;
  }
}
void verify_package(const fs::path& directory, const Manifest& manifest, const HashFile& hash) {
  plain_path(directory);
  std::map<std::string, const FileRecord*> files;
  for (const auto& file : manifest.files) files.emplace(file.path, &file);
  std::size_t count = 0;
  for (const auto& entry : fs::recursive_directory_iterator(directory)) {
    plain_path(entry.path());
    if (entry.is_directory()) continue;
    if (!entry.is_regular_file()) throw std::runtime_error("Unexpected runtime file type");
    auto relative = entry.path().lexically_relative(directory).generic_string();
    const auto found = files.find(relative);
    if (found == files.end()) throw std::runtime_error("Unexpected file in CEF runtime");
    const auto& expected = *found->second;
    if (entry.file_size() != expected.size || hash(entry.path()) != expected.sha256)
      throw std::runtime_error("CEF runtime file integrity mismatch");
    ++count;
  }
  if (count != files.size()) throw std::runtime_error("Incomplete cached CEF runtime");
}
void extract_package(const fs::path& archive, const fs::path& destination,
                     const Manifest& manifest, const HashFile& hash) {
  plain_path(archive); plain_path(destination);
  if (fs::exists(destination) && !fs::is_empty(destination)) throw std::runtime_error("Staging directory must be empty");
  fs::create_directories(destination);
#ifdef _WIN32
  FILE* input = _wfopen(archive.c_str(), L"rb");
#else
  FILE* input = std::fopen(archive.c_str(), "rb");
#endif
  if (!input) throw std::runtime_error("Cannot read CEF archive");
  mz_zip_archive zip{};
  if (!mz_zip_reader_init_cfile(&zip, input, 0, 0)) {
    std::fclose(input); throw std::runtime_error("Invalid CEF ZIP archive");
  }
  struct Cleanup { mz_zip_archive* zip; FILE* file; ~Cleanup() { mz_zip_reader_end(zip); std::fclose(file); } } cleanup{&zip, input};
  std::map<std::string, const FileRecord*> files;
  for (const auto& file : manifest.files) files.emplace(file.path, &file);
  std::set<std::string> seen;
  const auto count = mz_zip_reader_get_num_files(&zip);
  if (count > 20000) throw std::runtime_error("Too many archive entries");
  // Validate all entries before writing any data. File names must exactly match signed metadata.
  for (mz_uint i = 0; i < count; ++i) {
    mz_zip_archive_file_stat stat{};
    if (!mz_zip_reader_file_stat(&zip, i, &stat)) throw std::runtime_error("Invalid ZIP entry");
    const bool dir = mz_zip_reader_is_file_a_directory(&zip, i) != 0;
    auto name = zip_path(stat.m_filename, dir);
    auto unix_type = (stat.m_external_attr >> 16) & 0170000;
    if ((unix_type != 0 && unix_type != 0100000 && unix_type != 0040000) || stat.m_is_encrypted || !stat.m_is_supported)
      throw std::runtime_error("Unsupported ZIP file type");
    if (!seen.insert(name).second) throw std::runtime_error("Duplicate ZIP entry");
    if (dir) {
      bool expected = false;
      for (const auto& file : manifest.files) if (file.path.rfind(name + "/", 0) == 0) expected = true;
      if (!expected || stat.m_uncomp_size != 0) throw std::runtime_error("Unexpected ZIP directory");
      continue;
    }
    auto file = files.find(name);
    if (file == files.end() || stat.m_uncomp_size != file->second->size)
      throw std::runtime_error("ZIP differs from signed file list");
  }
  for (mz_uint i = 0; i < count; ++i) {
    if (mz_zip_reader_is_file_a_directory(&zip, i)) continue;
    mz_zip_archive_file_stat stat{}; mz_zip_reader_file_stat(&zip, i, &stat);
    auto out = destination / zip_path(stat.m_filename, false);
    plain_path(out); fs::create_directories(out.parent_path());
    std::ofstream stream(out, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("Cannot create staged CEF file");
    struct Output { std::ofstream* stream; std::uint64_t written, limit; } output{&stream, 0, stat.m_uncomp_size};
    auto write = [](void* opaque, mz_uint64 offset, const void* bytes, size_t size) -> size_t {
      auto& o = *static_cast<Output*>(opaque);
      if (offset != o.written || size > o.limit - o.written) return 0;
      o.stream->write(static_cast<const char*>(bytes), static_cast<std::streamsize>(size));
      if (!*o.stream) return 0;
      o.written += size; return size;
    };
    if (!mz_zip_reader_extract_to_callback(&zip, i, write, &output, 0) || output.written != stat.m_uncomp_size)
      throw std::runtime_error("Cannot extract CEF file");
    stream.close();
    if (!stream) throw std::runtime_error("Cannot finish CEF file");
  }
  verify_package(destination, manifest, hash);
}
}
