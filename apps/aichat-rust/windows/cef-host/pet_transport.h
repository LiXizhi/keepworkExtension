#pragma once
#include <windows.h>
#include <objbase.h>
#include <map>
#include "include/cef_parser.h"
#include "include/cef_process_message.h"
#include "include/cef_v8.h"
#include "include/wrapper/cef_helpers.h"
#include "pet_origin.h"

namespace keepwork_cef {
inline constexpr char kPetConnect[] = "keepwork.cef.pet.connect.v1";
inline constexpr char kPetConnected[] = "keepwork.cef.pet.connected.v1";
inline constexpr char kPetState[] = "keepwork.cef.pet.state.v1";
inline constexpr char kPetResult[] = "keepwork.cef.pet.result.v1";
inline constexpr char kPetCommand[] = "keepwork.cef.pet.command.v1";
inline std::string PetToken() {
  GUID guid{}; wchar_t value[40]{};
  if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, value, 40)) return {};
  return CefString(value).ToString();
}
inline Url PetUrl(const CefString& raw) {
  CefURLParts p;
  if (!CefParseURL(raw, p)) return {};
  return {CefString(&p.scheme), CefString(&p.host), CefString(&p.port),
    CefString(&p.path), {}, p.username.length != 0 || p.password.length != 0};
}
inline bool PetFrame(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame) {
  return browser && frame && TrustedPetFrame(PetUrl(frame->GetURL()), browser->IsPopup(), frame->IsMain());
}

// One instance per V8 document. No global JS dispatcher or postMessage channel.
class PetRenderDocument final : public CefV8Handler {
 public:
  explicit PetRenderDocument(CefRefPtr<CefV8Context> context)
    : context_(context), document_(PetToken()) {}
  bool Current(CefRefPtr<CefFrame> frame) const {
    if (!context_ || !context_->IsValid() || !frame) return false;
    const auto current = frame->GetV8Context();
    return current && current->IsSame(context_);
  }
  bool Same(CefRefPtr<CefV8Context> context) const { return context_ && context_->IsSame(context); }
  void Dispose() { dispatcher_ = nullptr; context_ = nullptr; challenge_.clear(); }
  void Dispatch(const char* kind, const CefString& payload) {
    if (!context_ || !context_->IsValid() || !dispatcher_ || !context_->Enter()) return;
    CefV8ValueList args{CefV8Value::CreateString(kind), CefV8Value::CreateString(payload)};
    dispatcher_->ExecuteFunction(nullptr, args);
    context_->Exit();
  }
  void Receive(CefRefPtr<CefFrame> frame, CefRefPtr<CefProcessMessage> message) {
    if (!Current(frame)) return;
    const auto args = message->GetArgumentList();
    if (message->GetName() == kPetConnect) {
      if (args->GetSize() != 1 || args->GetType(0) != VTYPE_STRING || args->GetString(0).length() > 64) return;
      challenge_ = args->GetString(0).ToString();
      if (!challenge_.empty()) Dispatch("connect", challenge_);
    } else if (message->GetName() == kPetCommand) {
      if (args->GetSize() != 3 || args->GetType(0) != VTYPE_STRING || args->GetType(1) != VTYPE_STRING ||
          args->GetType(2) != VTYPE_STRING || args->GetString(0) != document_ ||
          challenge_.empty() || args->GetString(1) != challenge_ || args->GetString(2).length() > 196608) return;
      Dispatch("command", args->GetString(2));
    }
  }
  bool Execute(const CefString&, CefRefPtr<CefV8Value>, const CefV8ValueList& args,
               CefRefPtr<CefV8Value>& result, CefString&) override {
    CEF_REQUIRE_RENDERER_THREAD();
    result = CefV8Value::CreateBool(false);
    const auto context = CefV8Context::GetCurrentContext();
    if (!context || !Same(context) || document_.empty() ||
        !PetFrame(context->GetBrowser(), context->GetFrame()) || args.size() != 2 || !args[0]->IsString()) return true;
    const auto kind = args[0]->GetStringValue();
    if (kind == "register") {
      if (!dispatcher_ && args[1]->IsFunction()) { dispatcher_ = args[1]; result = CefV8Value::CreateBool(true); }
      return true;
    }
    if (!args[1]->IsString()) return true;
    const auto payload = args[1]->GetStringValue();
    if (kind == "connect") {
      if (challenge_.empty() || payload != challenge_) return true;
      const auto message = CefProcessMessage::Create(kPetConnected);
      message->GetArgumentList()->SetString(0, document_);
      message->GetArgumentList()->SetString(1, challenge_);
      context->GetFrame()->SendProcessMessage(PID_BROWSER, message);
    } else if ((kind == "state" || kind == "result") && !challenge_.empty() && payload.length() <= 196608) {
      const auto message = CefProcessMessage::Create(kind == "state" ? kPetState : kPetResult);
      message->GetArgumentList()->SetString(0, document_);
      message->GetArgumentList()->SetString(1, challenge_);
      message->GetArgumentList()->SetString(2, payload);
      context->GetFrame()->SendProcessMessage(PID_BROWSER, message);
    } else return true;
    result = CefV8Value::CreateBool(true); return true;
  }
 private:
  CefRefPtr<CefV8Context> context_;
  CefRefPtr<CefV8Value> dispatcher_;
  std::string document_, challenge_;
  IMPLEMENT_REFCOUNTING(PetRenderDocument);
};
}  // namespace keepwork_cef
