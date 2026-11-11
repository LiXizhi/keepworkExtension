#pragma once
#include "policy.hpp"
#include <filesystem>
#include <functional>

namespace keepwork {
using HashFile = std::function<std::string(const std::filesystem::path&)>;
void plain_path(const std::filesystem::path& path);
void verify_package(const std::filesystem::path& directory, const Manifest& manifest, const HashFile& hash);
// Destination must be new/empty and under a caller-verified cache root.
void extract_package(const std::filesystem::path& archive, const std::filesystem::path& destination,
                     const Manifest& manifest, const HashFile& hash);
}
