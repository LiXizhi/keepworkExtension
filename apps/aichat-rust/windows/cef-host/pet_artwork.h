#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace keepwork_cef {
inline std::wstring NormalizePetAppearance(const std::wstring& value) {
  return value == L"dragon" ? L"dragon" : L"follow";
}
// Inspect the bounded PNG header before asking the native decoder to allocate.
// GDI+ still validates the complete PNG when constructing the bitmap.
inline bool ValidPetPng(const void* data, std::size_t size) {
  if (!data || size < 33 || size > 98304) return false;
  const auto bytes = static_cast<const unsigned char*>(data);
  const unsigned char header[]{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 'I', 'H', 'D', 'R'};
  if (std::memcmp(bytes, header, sizeof(header)) != 0) return false;
  const auto number = [bytes](int at) {
    return (std::uint32_t(bytes[at]) << 24) | (std::uint32_t(bytes[at + 1]) << 16)
      | (std::uint32_t(bytes[at + 2]) << 8) | bytes[at + 3];
  };
  const auto width = number(16), height = number(20);
  return width > 0 && height > 0 && width <= 256 && height <= 256;
}
}
