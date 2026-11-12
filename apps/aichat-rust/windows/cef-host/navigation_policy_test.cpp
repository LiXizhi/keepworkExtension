#include "navigation_policy.h"

#include <cstdlib>
#include <iostream>

using keepwork_cef::Url;

static void Check(bool value, const char* label) {
  if (!value) {
    std::cerr << "Navigation policy failure: " << label << '\n';
    std::exit(1);
  }
}

int main() {
  using namespace keepwork_cef;
  Url chat{"https", "keepwork.com", "443", "/chat", "", false};
  Check(Navigation(chat, false, true), "main chat");
  Check(LoginPopup(chat), "chat popup");
  Url provider{"https", "accounts.feishu.cn", "", "/oauth", "code=a", false};
  Check(LoginPopup(provider), "provider popup");
  Check(Navigation(provider, true, true), "provider redirect inside popup");
  Check(!Navigation(provider, false, true), "provider cannot replace main page");
  for (const auto* host : {"evilfeishu.cn", "feishu.cn.evil.test", "keepwork.com.evil.test"}) {
    provider.host = host;
    Check(!LoginPopup(provider), "lookalike provider");
  }
  Url tool{"https", "cdn.keepwork.com", "", "/apps/calendar.html", "token=secret", false};
  Check(Navigation(tool, false, false), "trusted tool iframe");
  Check(!Navigation(tool, false, true), "CDN cannot replace main page");
  Url website{"https", "www.baidu.com", "", "/", "", false};
  Check(Navigation(website, false, false), "ordinary website stays in preview iframe");
  Check(!Navigation(website, false, true), "ordinary website cannot replace main page");
  Check(!Navigation(website, true, true), "ordinary website cannot replace login popup");
  website.host = "redirected.example.test";
  Check(Navigation(website, false, false), "cross-origin redirect stays in preview iframe");
  website.scheme = "http";
  website.host = "127.0.0.1";
  website.port = "3001";
  Check(Navigation(website, false, false), "local HTTP preview server stays embedded");
  Check(!Navigation(website, false, true), "local preview server cannot replace main page");
  website.credentials = true;
  Check(!Navigation(website, false, false), "preview URL credentials remain forbidden");
  website.credentials = false;
  for (const auto* scheme : {"file", "javascript", "data", "keepwork"}) {
    website.scheme = scheme;
    Check(!Navigation(website, false, false), "preview scheme boundary");
  }
  website.scheme = "https";
  website.host.clear();
  Check(!Navigation(website, false, false), "preview URLs require a host");
  Check(!External(tool), "token cannot leave app");
  for (const auto* query : {"%74oken=a", "x=1&ACCESS_TOKEN=a", "id_token=a", "authorization=a"}) {
    tool.query = query;
    Check(!External(tool), "encoded and mixed case token keys");
  }
  tool.query = "document=1";
  Check(External(tool), "ordinary external document");
  tool.credentials = true;
  Check(!External(tool) && !Navigation(tool, false, false), "URL credentials");
  chat.port = "8443";
  Check(!Navigation(chat, false, true), "untrusted port");
  chat.port.clear();
  chat.scheme = "http";
  Check(!Navigation(chat, false, true), "insecure main page");
  chat.scheme = "file";
  Check(!External(chat) && !Navigation(chat, false, true), "local file navigation");
  Url wechat{"https", "open.weixin.qq.com", "", "/connect/qrconnect", "", false};
  Check(Navigation(wechat, false, false), "WeChat login iframe");
  wechat.path = "/cgi-bin/other";
  Check(Navigation(wechat, false, false), "ordinary provider pages stay in preview iframe");
  Check(!Navigation(wechat, false, true), "provider page cannot replace main page");
  std::cout << "CEF navigation policy tests passed\n";
}
