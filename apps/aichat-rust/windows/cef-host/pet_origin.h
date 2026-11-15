#pragma once
#include "navigation_policy.h"
#include <utility>
namespace keepwork_cef {
inline bool TrustedPetFrame(const Url& url, bool popup, bool main) {
  return !popup && main && Https(url) && url.host == "keepwork.com" &&
    (url.path == "/chat" || url.path == "/chat/");
}
// This scope permits only the microphone. Camera/display capture, popup and
// subframe requests never inherit the trusted chat document's consent.
inline bool TrustedMicrophoneRequest(const Url& requesting, const Url& frame,
                                     bool popup, bool main, unsigned permissions) {
  return permissions == 1 && TrustedPetFrame(frame, popup, main) &&
    Https(requesting) && requesting.host == "keepwork.com";
}
// Browser-owned navigation challenge plus renderer-owned document identity.
// A delayed connect/state from an earlier navigation cannot rebind the panel.
class PetDocumentBinding {
 public:
  void Reset(std::string challenge) { challenge_ = std::move(challenge); document_.clear(); }
  const std::string& challenge() const { return challenge_; }
  const std::string& document() const { return document_; }
  bool Connect(const std::string& document, const std::string& challenge) {
    if (document.empty() || document.size() > 64 || challenge_.empty() || challenge != challenge_ ||
        (!document_.empty() && document != document_)) return false;
    document_ = document; return true;
  }
  bool Matches(const std::string& document, const std::string& challenge) const {
    return !document_.empty() && !challenge_.empty() && document == document_ && challenge == challenge_;
  }
 private:
  std::string challenge_, document_;
};
}
