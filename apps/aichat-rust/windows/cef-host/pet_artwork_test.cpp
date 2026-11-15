#include "pet_artwork.h"
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <vector>

using keepwork_cef::NormalizePetAppearance;
using keepwork_cef::ValidPetPng;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Pet artwork failure: " << label << '\n'; std::exit(1); }
}

static std::vector<unsigned char> Png(unsigned width = 256, unsigned height = 256) {
  std::vector<unsigned char> bytes{
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 'I', 'H', 'D', 'R',
    0, 0, 0, 0, 0, 0, 0, 0,
    8, 6, 0, 0, 0, 0, 0, 0, 0,
  };
  for (int index = 0; index < 4; ++index) {
    bytes[16 + index] = static_cast<unsigned char>(width >> ((3 - index) * 8));
    bytes[20 + index] = static_cast<unsigned char>(height >> ((3 - index) * 8));
  }
  return bytes;
}

static void OnlyKnownAppearanceModesCanReachTheRenderer() {
  Check(NormalizePetAppearance(L"dragon") == L"dragon", "the fixed local dragon remains selectable");
  Check(NormalizePetAppearance(L"follow") == L"follow", "the web pet remains selectable");
  for (const auto value : {L"", L"current", L"Dragon", L"follow ", L"https://evil.invalid", L"javascript:alert(1)"})
    Check(NormalizePetAppearance(value) == L"follow", "missing or unknown preferences preserve the follow default");
}

static void PngHeadersRequireBoundedPositiveDimensionsAndPayloads() {
  for (const auto size : {1U, 128U, 256U}) {
    const auto bytes = Png(size, size);
    Check(ValidPetPng(bytes.data(), bytes.size()), "ordinary rasterized PNG headers are accepted");
  }
  for (const auto width : {0U, 257U, 4096U, 0xffffffffU}) {
    const auto bytes = Png(width, 128);
    Check(!ValidPetPng(bytes.data(), bytes.size()), "zero or oversized PNG width cannot reach GDI+");
  }
  for (const auto height : {0U, 257U, 4096U, 0xffffffffU}) {
    const auto bytes = Png(128, height);
    Check(!ValidPetPng(bytes.data(), bytes.size()), "zero or oversized PNG height cannot reach GDI+");
  }
  auto bytes = Png();
  bytes.resize(98304);
  Check(ValidPetPng(bytes.data(), bytes.size()), "the exact bounded image payload remains valid");
  bytes.push_back(0);
  Check(!ValidPetPng(bytes.data(), bytes.size()), "one byte beyond the payload limit is rejected");
}

static void MalformedOrTruncatedHeadersNeverReachTheImageDecoder() {
  const auto good = Png();
  Check(!ValidPetPng(nullptr, 0) && !ValidPetPng(nullptr, good.size()), "null input is rejected before reading");
  for (size_t length = 0; length < 33; ++length)
    Check(!ValidPetPng(good.data(), length), "truncated signatures or dimensions are rejected");
  for (size_t offset = 0; offset < 16; ++offset) {
    auto bad = good; bad[offset] ^= 0xff;
    Check(!ValidPetPng(bad.data(), bad.size()), "PNG signature, chunk length and IHDR identity are checked");
  }
  const char svg[] = "<svg width='128' height='128'></svg>";
  Check(!ValidPetPng(svg, std::strlen(svg)), "vector and executable markup is never an image transport");
}

int main() {
  OnlyKnownAppearanceModesCanReachTheRenderer();
  PngHeadersRequireBoundedPositiveDimensionsAndPayloads();
  MalformedOrTruncatedHeadersNeverReachTheImageDecoder();
  std::cout << "Pet artwork passed\n";
}
