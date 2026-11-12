#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace keepwork_cef {

// Filled by CefParseURL. Keeping decisions independent of CEF makes the
// navigation boundary testable on every development platform.
struct Url {
  std::string scheme;
  std::string host;
  std::string port;
  std::string path;
  std::string query;
  bool credentials = false;
};

inline bool Https(const Url& url) {
  return !url.credentials && url.scheme == "https" &&
         (url.port.empty() || url.port == "443");
}

inline bool Domain(const std::string& host, const std::string& domain) {
  return host == domain ||
         (host.size() > domain.size() &&
          host.compare(host.size() - domain.size(), domain.size(), domain) == 0 &&
          host[host.size() - domain.size() - 1] == '.');
}

inline bool LoginProvider(const Url& url) {
  return Https(url) &&
         (url.host == "accounts.google.com" ||
          url.host == "open.weixin.qq.com" || Domain(url.host, "feishu.cn") ||
          Domain(url.host, "larksuite.com") || Domain(url.host, "dingtalk.com"));
}

inline bool PathAt(const std::string& path, const std::string& base) {
  return path == base || path.compare(0, base.size() + 1, base + "/") == 0;
}

inline bool LoginPopup(const Url& url) {
  return LoginProvider(url) ||
         (Https(url) && url.host == "keepwork.com" &&
          (PathAt(url.path, "/chat") || PathAt(url.path, "/sso") ||
           PathAt(url.path, "/login")));
}

inline bool Navigation(const Url& url, bool popup, bool main_frame) {
  // Preview iframes browse arbitrary websites and local workspace servers.
  // Only actual subframes get this rule; top-level and popup policies stay strict.
  if (!main_frame) {
    return !url.credentials && !url.host.empty() &&
           (url.scheme == "http" || url.scheme == "https");
  }
  if (!Https(url)) return false;
  if (url.host == "keepwork.com") return true;
  if (popup && LoginProvider(url)) return true;
  return false;
}

inline int Hex(char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}

inline std::string QueryKey(const std::string& raw) {
  std::string key;
  for (size_t i = 0; i < raw.size(); ++i) {
    char value = raw[i];
    if (value == '%' && i + 2 < raw.size() && Hex(raw[i + 1]) >= 0 &&
        Hex(raw[i + 2]) >= 0) {
      value = static_cast<char>(Hex(raw[i + 1]) * 16 + Hex(raw[i + 2]));
      i += 2;
    }
    key.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(value))));
  }
  return key;
}

inline bool External(const Url& url) {
  if (url.credentials || (url.scheme != "http" && url.scheme != "https") ||
      url.host.empty()) return false;
  size_t start = 0;
  while (start < url.query.size()) {
    const auto end = url.query.find('&', start);
    const auto item = url.query.substr(start, end == std::string::npos ? end : end - start);
    const auto key = QueryKey(item.substr(0, item.find('=')));
    if (key == "token" || key == "access_token" || key == "id_token" ||
        key == "authorization") return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

}  // namespace keepwork_cef
