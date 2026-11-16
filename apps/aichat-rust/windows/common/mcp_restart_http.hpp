#pragma once
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace keepwork {
struct RestartHttpResponse { unsigned status = 0; bool keep_alive = true; std::string body; };
// Deliberately narrow HTTP/1.1 framing for the existing daemon's finite JSON
// responses. Unsupported framing falls back to the already verified process
// handle; this parser never follows redirects or reconnects a POST elsewhere.
inline std::optional<RestartHttpResponse> restart_http_response(const std::string& bytes) {
  if (bytes.size() > 32768) throw std::runtime_error("Restart health response exceeds its limit");
  const auto end = bytes.find("\r\n\r\n");
  if (end == std::string::npos) {
    if (bytes.size() > 16384) throw std::runtime_error("Restart health headers exceed their limit");
    return std::nullopt;
  }
  if (end > 16384 || bytes.compare(0, 9, "HTTP/1.1 ") != 0) throw std::runtime_error("Unsupported restart health HTTP framing");
  const auto line_end = bytes.find("\r\n");
  if (line_end < 12 || bytes[9] < '1' || bytes[9] > '5' || bytes[10] < '0' || bytes[10] > '9'
      || bytes[11] < '0' || bytes[11] > '9' || (line_end > 12 && bytes[12] != ' '))
    throw std::runtime_error("Invalid restart health status");
  RestartHttpResponse response;
  response.status = (bytes[9] - '0') * 100 + (bytes[10] - '0') * 10 + bytes[11] - '0';
  std::optional<std::uint64_t> length;
  std::size_t begin = line_end + 2;
  while (begin < end) {
    const auto finish = bytes.find("\r\n", begin), colon = bytes.find(':', begin);
    if (finish == std::string::npos || finish > end || colon == std::string::npos || colon >= finish || colon == begin)
      throw std::runtime_error("Invalid restart health header");
    auto name = bytes.substr(begin, colon - begin), value = bytes.substr(colon + 1, finish - colon - 1);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    for (auto& c : value) c = char(std::tolower(static_cast<unsigned char>(c)));
    const auto first = value.find_first_not_of(" \t"), last = value.find_last_not_of(" \t");
    value = first == std::string::npos ? "" : value.substr(first, last - first + 1);
    if (name == "content-length") {
      if (length || value.empty() || value.size() > 5 || value.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error("Invalid restart health content length");
      length = std::stoull(value);
    } else if (name == "transfer-encoding") throw std::runtime_error("Unsupported restart health transfer encoding");
    else if (name == "connection" && value.find("close") != std::string::npos) response.keep_alive = false;
    begin = finish + 2;
  }
  if (!length || *length > 32768 - end - 4) throw std::runtime_error("Missing or excessive restart health content length");
  const auto expected = end + 4 + static_cast<std::size_t>(*length);
  if (bytes.size() < expected) return std::nullopt;
  if (bytes.size() != expected) throw std::runtime_error("Unexpected data after restart health response");
  response.body = bytes.substr(end + 4);
  return response;
}
}
