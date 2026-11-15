#include "pet_chat_state.h"
#include "pet_origin.h"
#include <cstdlib>
#include <iostream>

using keepwork_cef::PetChatState;
using Snapshot = PetChatState::Snapshot;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Pet chat state failure: " << label << '\n'; std::exit(1); }
}

static Snapshot Ready(const std::string& context = "account-a:chat") {
  Snapshot state;
  state.context = context; state.target = "chat"; state.title = L"AIChat";
  state.ready = state.can_switch = true;
  return state;
}

static PetChatState::Command ReachSend(PetChatState& state, const std::string& input_id,
                                     const std::string& send_id, std::uint64_t now) {
  const auto input = state.Begin("send", input_id, now);
  Check(input && input->action == "input", "explicit send always stages actual composer input first");
  auto echoed = state.snapshot(); echoed.draft = input->text;
  Check(state.Publish(echoed), "actual controller publishes the synchronized composer before input ACK");
  const auto send = state.Result(input_id, true, L"", send_id, now + 1);
  Check(send && send->action == "send", "only successful matching input ACK issues send");
  return *send;
}

static void InputBarrierAndLiveProjection() {
  PetChatState state;
  auto web = Ready(); web.draft = L"page draft";
  Check(state.Publish(web) && state.draft() == web.draft, "initial published draft is reflected");
  Check(state.Edit(L"native message"), "native text can be staged");
  const auto revision = state.revision();
  const auto input = state.Begin("send", "input-1", 100);
  Check(input && input->context == web.context && input->text == L"native message" &&
    input->action == "input", "input carries the exact draft and current conversation identity");
  Check(state.pending() && !state.accepted(), "sending input is not send acceptance");
  web.draft = L"native message"; web.messages = L"earlier transcript";
  Check(state.Publish(web) && state.dirty() && state.revision() == revision,
    "snapshot echo before input ACK cannot erase local dirty revision");
  Check(!state.Result("unrelated", true, L"", "send-wrong", 101) && state.pending_id() == "input-1",
    "wrong request ACK cannot advance input barrier");
  Check(!state.Begin("send", "input-overlap", 101), "a second send cannot overlap pending input");
  const auto send = state.Result("input-1", true, L"", "send-1", 102);
  Check(send && send->action == "send" && send->id == "send-1" && send->context == web.context &&
    send->text.empty(), "matching input ACK issues exactly one separate send request");
  Check(!state.Result("input-1", true, L"", "send-duplicate", 103) && state.pending_id() == "send-1",
    "duplicate input ACK cannot issue a second mutation");
  Check(!state.Result("send-1", true, L"", "unused", 104) && state.accepted() && !state.pending(),
    "send ACK records acceptance without fabricating a reply");
  Check(state.snapshot().reply.empty() && state.snapshot().messages == L"earlier transcript",
    "acceptance preserves actual page transcript rather than adding fake response");
  Check(!state.Begin("send", "input-repeat", 105), "accepted unchanged text cannot accidentally be sent twice");
  web.busy = true; web.draft.clear(); web.reply = L"streamed reply"; web.messages = L"real transcript";
  Check(state.Publish(web) && state.snapshot().busy && state.snapshot().reply == L"streamed reply" &&
    state.snapshot().messages == L"real transcript", "live page stream remains authoritative after ACK");
  web.busy = false; web.error = L"provider failed after acceptance";
  Check(state.Publish(web) && state.error() == web.error,
    "real asynchronous page error remains visible after successful send ACK");
}

static void EditsFailuresAndDeadline() {
  PetChatState state; auto web = Ready(); Check(state.Publish(web), "connect edit fixture");
  state.Edit(L"first"); Check(state.Begin("send", "edit-input", 10).has_value(), "stage first edit");
  state.Edit(L"newer"); const auto newer_revision = state.revision();
  web.draft = L"first"; Check(state.Publish(web), "page reports old pending input");
  Check(state.draft() == L"newer" && state.revision() == newer_revision,
    "pending input snapshot never overwrites newer native edit");
  Check(!state.Result("edit-input", true, L"", "must-not-send", 11) && !state.pending() && state.dirty(),
    "ACK for an older revision does not send stale or newer text automatically");
  Check(state.draft() == L"newer", "newer edit remains available for explicit retry");
  Check(state.Begin("send", "reject-input", 20).has_value(), "explicit user retries newer text");
  Check(!state.Result("reject-input", false, L"unsupported input", "must-not-send-2", 21) &&
    !state.pending() && state.error() == L"unsupported input", "failed input never reaches send");
  web.draft.clear(); state.Publish(web);
  Check(state.draft() == L"newer" && state.dirty(), "failed input text survives subsequent page snapshots");
  Check(state.Begin("send", "timeout-input", 100).has_value(), "stage timeout input");
  Check(!state.Timeout(99) && !state.Timeout(15099) && state.pending(), "backward clock and pre-deadline do not timeout");
  Check(state.Timeout(15100) && !state.pending() && !state.unknown() && state.dirty(),
    "input timeout at exact deadline retains draft without uncertain send");
  Check(!state.Result("timeout-input", true, L"", "never-send", 15101), "late input ACK cannot resurrect send");
  Check(!state.Timeout(20000), "timeout is consumed once");
  const auto send = ReachSend(state, "retry-input", "reject-send", 20000);
  Check(send.context == web.context, "retry remains in current context");
  Check(!state.Result("reject-send", false, L"send rejected", "unused", 20002) && state.dirty(),
    "explicit failed send is not accepted and keeps native text");
  state.Publish(web);
  Check(state.draft() == L"newer" && state.error() == L"send rejected", "send rejection cannot silently clear text");
  Check(state.Begin("input", "direct-input", 30000).has_value(), "explicit input-only action is available");
  Check(!state.Result("direct-input", true, L"", "must-not-send-3", 30001) && !state.pending(),
    "input-only ACK does not imply send intent");
  state.Edit(L"native A");
  Check(state.Begin("send", "racing-input", 40000).has_value(), "stage input before a main-window edit");
  web.draft = L"different web B"; state.Publish(web);
  Check(!state.Result("racing-input", true, L"", "must-not-send-B", 40001) && !state.pending() &&
    state.dirty() && state.draft() == L"native A", "web draft change before input ACK cannot send another message");
  Check(!state.error().empty(), "web/native composer conflict explains why message was not sent");
}

static void UnknownSendRequiresExplicitInspection() {
  PetChatState state; auto web = Ready(); state.Publish(web); state.Edit(L"uncertain message");
  ReachSend(state, "unknown-input", "unknown-send", 100);
  Check(!state.Result("unknown-send", true, L"", "unused", 15101) && state.unknown() &&
    state.unknown_id() == "unknown-send" && !state.accepted(),
    "late result at deadline becomes unknown even if timer has not run yet");
  const auto error = state.error();
  Check(!error.empty() && !state.Result("unknown-send", true, L"", "unused", 15102),
    "uncertain send never becomes accepted from a stale ACK");
  web.draft.clear(); web.busy = false; web.error = L"page reports later failure"; state.Publish(web);
  Check(state.unknown() && state.draft() == L"uncertain message" && state.error() == error,
    "idle or error snapshot cannot resolve unknown mutation or hide inspection warning");
  Check(!state.Begin("send", "blocked-send", 16000) && !state.Begin("input", "blocked-input", 16000) &&
    !state.Begin("toggle-target", "blocked-toggle", 16000), "unknown result blocks mutation and target switching");
  // Stopping a possible generation remains available, but cannot resolve delivery.
  for (int i = 0; i < 600; ++i) {
    const auto id = "stop-" + std::to_string(i);
    Check(state.Begin("stop", id, 16001 + i).has_value(), "stop remains available during unknown send");
    Check(!state.Result(id, true, L"", "unused", 16001 + i), "stop does not chain another command");
  }
  Check(state.unknown() && !state.error().empty() && state.remembered_ids() <= PetChatState::max_remembered_ids,
    "bounded ACK history does not drop unknown association or user warning");
  Check(!state.Begin("stop", "unknown-send", 17000), "unknown request identity stays reserved even after history eviction");
  state.AcknowledgeUnknown();
  Check(!state.unknown() && state.unknown_id().empty() && !state.pending(),
    "inspection acknowledgment unlocks without issuing a request");
  Check(state.error() == web.error, "actual page failure is exposed after explicit unknown inspection");
  Check(!state.Begin("send", "unknown-send", 17001), "acknowledged unknown identity remains in recent history");
  Check(state.Begin("send", "fresh-explicit-input", 17002).has_value(),
    "only a new explicit send intent can retry after inspection");
}

static void MainWindowCancelsOnlyUnsubmittedSendIntent() {
  PetChatState state; auto web = Ready(); state.Publish(web); state.Edit(L"unsent message");
  Check(state.Begin("send", "cancel-input", 1).has_value(), "stage input before opening main window");
  web.draft = L"unsent message"; state.Publish(web);
  Check(state.CancelUnsubmittedInput() && !state.pending() && state.dirty() &&
    state.draft() == L"unsent message" && !state.error().empty(),
    "opening main window cancels unsubmitted send intent and preserves native draft");
  Check(!state.CancelUnsubmittedInput() && !state.Result("cancel-input", true, L"", "never-send", 2),
    "late input ACK after opening main window cannot issue send");
  Check(!state.Begin("send", "cancel-input", 3), "cancelled request identity remains reserved");
  Check(state.Begin("input", "input-only-not-cancelled", 4).has_value() && !state.CancelUnsubmittedInput() &&
    state.pending_id() == "input-only-not-cancelled", "input-only sync is not an automatic send intent");
  state.Result("input-only-not-cancelled", true, L"", "unused", 5);
  ReachSend(state, "already-sent-input", "already-sent", 6);
  Check(!state.CancelUnsubmittedInput() && state.pending_id() == "already-sent",
    "opening main window cannot pretend an already submitted send was cancelled");
  Check(state.Timeout(15007) && state.unknown() && !state.CancelUnsubmittedInput() && state.unknown_id() == "already-sent",
    "opening main window cannot falsely resolve an unknown submitted send");
}

static void ReadinessAndComposerGuards() {
  PetChatState state; auto web = Ready(); web.ready = false; state.Publish(web); state.Edit(L"kept offline");
  Check(!state.Begin("send", "not-ready", 1) && !state.Begin("input", "not-ready-input", 1),
    "unready page cannot accept composer mutations");
  Check(!state.Begin("toggle-target", "toggle-unsynced", 1) && state.draft() == L"kept offline",
    "target change cannot discard an unsynchronized native draft");
  state.Edit(web.draft);
  Check(!state.dirty(), "restoring current page draft clears unsynchronized native edit");
  Check(state.Begin("toggle-target", "toggle-unready", 2).has_value(), "unready persona can switch to available chat");
  state.Result("toggle-unready", true, L"", "unused", 3);
  state.Edit(L"kept offline");
  web.ready = true; web.rich_draft = true; state.Publish(web);
  Check(!state.Begin("send", "rich-send", 4) && !state.Begin("input", "rich-input", 4),
    "rich attachment/tool draft cannot be overwritten by plain native text");
  web.rich_draft = false; web.dictating = true; state.Publish(web);
  Check(!state.Begin("send", "dictating-send", 5) && !state.Begin("toggle-target", "dictating-toggle", 5),
    "dictation protects active composer and target");
  web.dictating = false; web.busy = true; state.Publish(web);
  Check(!state.Begin("send", "busy-send", 6), "generation busy blocks another send");
  Check(state.Begin("stop", "stop-busy", 7).has_value(), "explicit stop is possible during generation");
  state.Result("stop-busy", true, L"", "unused", 8);
  web.busy = false; state.Publish(web); state.Edit(L" \t\r\n\u3000\u00a0\ufeff");
  Check(!state.Begin("send", "blank", 9), "Unicode whitespace-only draft cannot send");
  state.Edit(L"message");
  Check(!state.Begin("unsupported", "unsupported-id", 10) && !state.Begin("send", "", 10),
    "unknown actions and empty request identity fail explicitly");
  Check(!state.Begin("send", std::string("a\0b", 3), 10), "embedded NUL request identity is rejected");
  Check(state.Begin("send", "state-change-input", 11).has_value(), "stage before busy transition");
  web.busy = true; state.Publish(web);
  Check(!state.Result("state-change-input", true, L"", "must-not-send", 12) && state.dirty(),
    "input ACK rechecks current readiness and busy state before sending");
  PetChatState restored; auto existing = Ready(); existing.draft = L"existing web draft"; restored.Publish(existing);
  restored.Edit(L"native replacement");
  Check(!restored.Begin("toggle-target", "nonempty-unsynced", 20) && restored.draft() == L"native replacement",
    "nonempty original page draft is not a reason to discard native replacement on switch");
  restored.Edit(existing.draft);
  Check(!restored.dirty() && restored.Begin("toggle-target", "restored-switch", 21).has_value(),
    "restoring even a nonempty original page draft permits explicit target change");
}

static void DocumentAndAccountIsolation() {
  PetChatState state; state.Edit(L"offline first-document text"); const auto offline_revision = state.revision();
  Check(!state.Begin("send", "before-connect", 0), "offline draft does not imply bridge readiness");
  auto first = Ready(); first.draft = L"server draft";
  Check(state.Publish(first) && state.draft() == L"offline first-document text" && state.revision() == offline_revision,
    "first current-document owner preserves pre-handshake offline native edit");
  ReachSend(state, "account-a-input", "account-a-send", 1);
  auto second = Ready("account-b:chat"); second.draft = L"account-b draft";
  Check(state.Publish(second) && state.draft() == L"account-b draft" && !state.pending() && !state.unknown(),
    "changing conversation/account clears old projection and pending command");
  Check(!state.Result("account-a-send", true, L"", "never-send", 3) && !state.accepted(),
    "prior account ACK cannot mutate new owner");
  Check(state.isolated_drafts().size() == 1 && state.isolated_drafts().back().context == first.context &&
    state.isolated_drafts().back().text == L"offline first-document text" &&
    state.isolated_drafts().back().request_id == "account-a-send" && state.isolated_drafts().back().unknown_send,
    "old owner's uncertain submission is isolated with its exact request identity");
  state.Edit(L"account-b local"); const auto old_document = state.isolated_drafts().back().document;
  state.ResetDocument();
  Check(state.snapshot().context.empty() && state.draft().empty() && state.error().empty() &&
    !state.pending() && !state.accepted(), "navigation removes every old document projection");
  Check(state.Publish(first) && state.draft() == L"server draft", "reload never imports old document native draft");
  state.Edit(L"new-document offline"); state.ResetDocument();
  Check(state.isolated_drafts().back().document > old_document, "isolation records document epochs");
  state.Edit(L"newer current-document offline");
  Check(state.Publish(second) && state.draft() == L"newer current-document offline",
    "offline buffer after reset belongs only to new document's first owner");
  auto invalid = second; invalid.context.clear();
  Check(!state.Publish(invalid) && state.snapshot().context.empty() && state.draft().empty(),
    "invalid owner replacement clears an already bound account draft");
}

static void TextAndRetentionBounds() {
  PetChatState state; auto web = Ready(); state.Publish(web);
  Check(state.Edit(std::wstring(32000, L'x')), "32000 UTF-16 units fit");
  const auto revision = state.revision();
  Check(!state.Edit(std::wstring(32001, L'x')) && state.draft().size() == 32000 && state.revision() == revision,
    "oversized edit cannot replace existing draft or revision");
  std::wstring emoji;
  for (int i = 0; i < 16000; ++i) emoji += L"\U0001f642";
  Check(state.Edit(emoji), "astral Unicode is measured as UTF-16 consistently across platforms");
  emoji += L"\U0001f642";
  Check(!state.Edit(emoji), "astral character limit counts two UTF-16 units per scalar");
  PetChatState unbound; auto invalid = Ready(); invalid.draft.assign(32001, L'x');
  Check(!unbound.Publish(invalid) && unbound.draft().empty() && !unbound.snapshot().ready,
    "oversized first snapshot is not adopted as editable text");
  for (int i = 0; i < 40; ++i) {
    state.Publish(Ready("retention-" + std::to_string(i)));
    state.Edit(std::wstring(32000, L'x'));
    const auto id = "retention-input-" + std::to_string(i);
    Check(state.Begin("send", id, 1).has_value(), "stage retention fixture request");
  }
  state.ResetDocument();
  std::size_t units = 0;
  for (const auto& draft : state.isolated_drafts()) units += draft.text.size() + draft.submitted_text.size();
  Check(state.isolated_drafts().size() <= PetChatState::max_isolated_drafts && units <= PetChatState::max_isolated_units,
    "isolated drafts are bounded in count and total retained text");
  Check(state.isolated_drafts().back().context == "retention-39", "bounded retention keeps most recent isolated owner");
}

static void TrustedOriginAndDocumentBinding() {
  using namespace keepwork_cef;
  Url url{"https", "keepwork.com", "", "/chat", "arbitrary=%ff&token=x", false};
  Check(TrustedPetFrame(url, false, true), "exact published chat with arbitrary query is trusted");
  url.path = "/chat/"; url.port = "443";
  Check(TrustedPetFrame(url, false, true), "trailing slash and explicit default TLS port are trusted");
  for (const auto& path : {"/chat/other", "/sso", "/chat-other", "/Chat", "/chat%2f"}) {
    auto denied = url; denied.path = path;
    Check(!TrustedPetFrame(denied, false, true), "unrelated or descendant path never gains pet bridge");
  }
  for (const auto& host : {"other.keepwork.com", "keepwork.com.evil.test", "evil.test", "keepwork.com."}) {
    auto denied = url; denied.host = host;
    Check(!TrustedPetFrame(denied, false, true), "subdomains and lookalike hosts are excluded");
  }
  auto denied = url; denied.scheme = "http"; Check(!TrustedPetFrame(denied, false, true), "HTTP is excluded");
  denied = url; denied.port = "8443"; Check(!TrustedPetFrame(denied, false, true), "nondefault port is excluded");
  denied = url; denied.credentials = true; Check(!TrustedPetFrame(denied, false, true), "userinfo URL is excluded");
  Check(!TrustedPetFrame(url, true, true) && !TrustedPetFrame(url, false, false), "popups and iframes are excluded");
  PetDocumentBinding binding;
  Check(!binding.Connect("doc-a", "") && !binding.Matches("doc-a", ""), "empty challenge cannot establish identity");
  binding.Reset("challenge-a");
  Check(!binding.Matches("doc-a", "challenge-a"), "state is rejected until successful connect");
  Check(!binding.Connect("", "challenge-a") && !binding.Connect("doc-a", "wrong"), "empty document and mismatched challenge fail");
  Check(binding.Connect("doc-a", "challenge-a") && binding.Connect("doc-a", "challenge-a"), "same document may repeat connect");
  Check(!binding.Connect("doc-b", "challenge-a") && binding.document() == "doc-a", "same challenge cannot rebind to another document");
  Check(binding.Matches("doc-a", "challenge-a") && !binding.Matches("doc-b", "challenge-a"), "state matches exact bound pair");
  binding.Reset("challenge-b");
  Check(binding.document().empty() && !binding.Connect("doc-a", "challenge-a") &&
    !binding.Matches("doc-a", "challenge-a"), "navigation invalidates delayed connect and state from old challenge");
  Check(binding.Connect("doc-b", "challenge-b") && binding.Matches("doc-b", "challenge-b"), "new document binds new challenge");
  binding.Reset("");
  Check(!binding.Connect("doc-b", "") && !binding.Matches("doc-b", ""), "reset to empty challenge disables binding");
}

int main() {
  InputBarrierAndLiveProjection();
  EditsFailuresAndDeadline();
  UnknownSendRequiresExplicitInspection();
  MainWindowCancelsOnlyUnsubmittedSendIntent();
  ReadinessAndComposerGuards();
  DocumentAndAccountIsolation();
  TextAndRetentionBounds();
  TrustedOriginAndDocumentBinding();
  std::cout << "Pet chat state checks passed\n";
}
