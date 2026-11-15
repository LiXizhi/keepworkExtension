#pragma once
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace keepwork_cef {
// The web page owns conversations and generation. This model only stages
// explicit native edits and correlates acknowledgements from that document.
class PetChatState {
 public:
  struct Snapshot {
    std::string context, target;
    std::wstring title, draft, reply, attention, error, messages;
    bool ready = false, busy = false, rich_draft = false, dictating = false, can_switch = false;
  };
  struct Command { std::string action, id, context; std::wstring text; };
  struct IsolatedDraft {
    std::uint64_t document;
    std::string context, request_id;
    std::wstring text, submitted_text;
    bool unknown_send;
  };
  static constexpr std::uint64_t timeout_ms = 15000;
  static constexpr std::size_t max_text_units = 32000;
  static constexpr std::size_t max_remembered_ids = 512;
  static constexpr std::size_t max_isolated_drafts = 16;
  static constexpr std::size_t max_isolated_units = 512 * 1024;

  const Snapshot& snapshot() const { return snapshot_; }
  const std::wstring& draft() const { return draft_; }
  const std::wstring& error() const {
    if (unknown_send_) return UnknownMessage();
    return local_error_.empty() ? snapshot_.error : local_error_;
  }
  std::uint64_t revision() const { return revision_; }
  bool pending() const { return pending_.has_value(); }
  const std::string& pending_id() const { return pending_ ? pending_->command.id : empty_id_; }
  bool unknown() const { return unknown_send_; }
  const std::string& unknown_id() const { return unknown_id_; }
  bool accepted() const { return accepted_; }  // Accepted by the page, never generation completion.
  bool dirty() const { return dirty_; }
  const std::vector<IsolatedDraft>& isolated_drafts() const { return isolated_; }
  std::size_t remembered_ids() const { return used_ids_.size(); }

  void ResetDocument() {
    Isolate();
    ClearActive();
    ++document_;
    owner_bound_ = false;
  }

  bool Publish(const Snapshot& next) {
    if (!ValidId(next.context)) {
      // An unbound current-document offline edit can await its first owner.
      // Once an owner existed, an invalid replacement must clear its projection.
      if (owner_bound_) { Isolate(); ClearActive(); owner_bound_ = true; }
      snapshot_.ready = false;
      local_error_ = L"网页尚未提供有效会话，请打开 AIChat 检查。";
      return false;
    }
    if (!owner_bound_) {
      owner_bound_ = true;
      snapshot_ = next;
      if (!TextFits(next.draft)) return InvalidDraft();
      if (!dirty_) AdoptDraft(next.draft);
      if (!unknown_send_) local_error_.clear();
      return true;
    }
    if (snapshot_.context != next.context) {
      Isolate();
      ClearActive();
      owner_bound_ = true;
      snapshot_ = next;
      if (!TextFits(next.draft)) return InvalidDraft();
      AdoptDraft(next.draft);
      return true;
    }
    snapshot_ = next;
    // A later authoritative provider failure must replace an older local guard
    // message (for example a second click while the accepted send was busy).
    if (!unknown_send_ && !next.error.empty()) local_error_.clear();
    if (!TextFits(next.draft)) return InvalidDraft();
    // Updated draft snapshots commonly precede input ACK. They cannot change
    // the native revision or erase edits made while that command is pending.
    if (!dirty_ && !pending_ && !unknown_send_) AdoptDraft(next.draft);
    return true;
  }

  bool Edit(const std::wstring& text) {
    if (!TextFits(text)) { local_error_ = L"宠物输入最多 32000 个 UTF-16 字符，请在 AIChat 中编辑。"; return false; }
    if (draft_ == text) {
      if (!pending_ && !unknown_send_ && text == snapshot_.draft) dirty_ = false;
      return true;
    }
    draft_ = text;
    ++revision_;
    dirty_ = pending_.has_value() || unknown_send_ || text != snapshot_.draft;
    accepted_ = false;
    if (!unknown_send_) local_error_.clear();
    return true;
  }

  std::optional<Command> Begin(const std::string& action, const std::string& id, std::uint64_t now) {
    if (pending_) { local_error_ = L"上一项操作尚未确认，请稍候。"; return {}; }
    if (action != "input" && action != "send" && action != "stop" && action != "toggle-target") {
      local_error_ = L"不支持此宠物操作。"; return {};
    }
    if (!FreshId(id)) { local_error_ = L"请求标识无效或已使用。"; return {}; }
    if (!ValidId(snapshot_.context)) { local_error_ = L"当前网页不支持或尚未连接宠物对话，请打开 AIChat。"; return {}; }
    if (unknown_send_ && action != "stop") { UnknownError(); return {}; }
    if (action == "toggle-target") {
      if (dirty_ && draft_ != snapshot_.draft) {
        local_error_ = L"有未同步草稿，请先发送或恢复主窗口草稿后再切换目标。"; return {};
      }
      if (!snapshot_.can_switch || snapshot_.dictating) { local_error_ = L"当前无法切换目标，请打开 AIChat。"; return {}; }
    } else if (!snapshot_.ready) {
      local_error_ = L"当前目标尚未就绪，草稿已保留，请打开 AIChat。"; return {};
    }
    if ((action == "input" || action == "send") && !Writable()) return {};
    if (action == "send") {
      if (snapshot_.busy) { local_error_ = L"正在回复，请先停止当前回复。"; return {}; }
      if (!HasContent(draft_)) { local_error_ = L"请输入消息后再发送。"; return {}; }
      if (accepted_ && revision_ == accepted_revision_ && draft_ == accepted_text_) {
        local_error_ = L"上一条请求已被接收，请等待网页状态或编辑新消息。"; return {};
      }
    }
    local_error_.clear();
    if (action == "input" || action == "send") accepted_ = false;
    // Every explicit Send first establishes the actual page composer value.
    return Start(action == "send" ? "input" : action, id, now, action == "send");
  }

  std::optional<Command> Result(const std::string& id, bool ok, const std::wstring& failure,
                              const std::string& next_id, std::uint64_t now) {
    if (!pending_ || pending_->command.id != id || pending_->document != document_ ||
        pending_->command.context != snapshot_.context) return {};
    if (Expired(now, pending_->started)) { Timeout(now); return {}; }
    const Pending completed = *pending_;
    pending_.reset();
    if (!ok) {
      if (completed.command.action == "input" || completed.command.action == "send") dirty_ = true;
      local_error_ = failure.empty() ? L"AIChat 未确认操作，草稿已保留。" : failure;
      return {};
    }
    local_error_.clear();
    if (unknown_send_) UnknownError();
    if (completed.command.action == "input") {
      const bool unchanged = revision_ == completed.revision && draft_ == completed.text;
      if (unchanged) dirty_ = false;
      if (!completed.send_after_input) return {};
      if (!unchanged) { local_error_ = L"草稿已更改，尚未发送，请再次确认。"; return {}; }
      if (snapshot_.draft != completed.text) {
        dirty_ = true;
        local_error_ = L"网页草稿已改变，尚未发送；宠物草稿已保留，请打开 AIChat 核查。";
        return {};
      }
      if (!snapshot_.ready || snapshot_.busy || !Writable()) {
        dirty_ = true;
        if (local_error_.empty()) local_error_ = L"网页状态已改变，尚未发送，请打开 AIChat。";
        return {};
      }
      if (!FreshId(next_id)) { dirty_ = true; local_error_ = L"后续请求标识无效，尚未发送。"; return {}; }
      return Start("send", next_id, now, false);
    }
    if (completed.command.action == "send") {
      accepted_ = true;
      accepted_revision_ = completed.revision;
      accepted_text_ = completed.text;
      if (!dirty_ && revision_ == completed.revision) AdoptDraft(snapshot_.draft);
    }
    return {};
  }

  bool CancelUnsubmittedInput() {
    if (!pending_ || pending_->command.action != "input" || !pending_->send_after_input) return false;
    pending_.reset();
    dirty_ = true;
    local_error_ = L"已打开主窗口，尚未发送；宠物草稿已保留。";
    return true;
  }

  bool Timeout(std::uint64_t now) {
    if (!pending_ || !Expired(now, pending_->started)) return false;
    const Pending timed_out = *pending_;
    pending_.reset();
    if (timed_out.command.action == "send") {
      unknown_send_ = true;
      unknown_id_ = timed_out.command.id;
      unknown_text_ = timed_out.text;
      UnknownError();
    } else if (timed_out.command.action == "input") {
      dirty_ = true;
      local_error_ = L"输入同步未确认，未继续发送；草稿已保留，请打开 AIChat 检查。";
    } else local_error_ = L"操作结果未确认，请打开 AIChat 检查后再操作。";
    return true;
  }

  void AcknowledgeUnknown() {
    if (!unknown_send_) return;
    RememberId(unknown_id_);
    unknown_send_ = false;
    unknown_id_.clear(); unknown_text_.clear();
    accepted_ = false;
    local_error_.clear();
  }

 private:
  struct Pending {
    Command command;
    std::uint64_t started, document, revision;
    std::wstring text;
    bool send_after_input;
  };
  Snapshot snapshot_;
  std::wstring draft_, local_error_, accepted_text_, unknown_text_;
  std::string unknown_id_;
  std::uint64_t revision_ = 0, document_ = 1, accepted_revision_ = 0;
  bool owner_bound_ = false, dirty_ = false, accepted_ = false, unknown_send_ = false;
  std::optional<Pending> pending_;
  std::unordered_set<std::string> used_ids_;
  std::deque<std::string> id_order_;
  std::vector<IsolatedDraft> isolated_;
  inline static const std::string empty_id_;

  static bool ValidId(const std::string& value) {
    return !value.empty() && value.size() <= 200 && value.find('\0') == std::string::npos;
  }
  bool FreshId(const std::string& value) const {
    return ValidId(value) && used_ids_.find(value) == used_ids_.end() &&
      (!pending_ || value != pending_->command.id) && value != unknown_id_;
  }
  static bool Expired(std::uint64_t now, std::uint64_t started) {
    return now >= started && now - started >= timeout_ms;
  }
  static bool TextFits(const std::wstring& text) {
    std::size_t units = 0;
    for (wchar_t value : text) {
      const auto point = static_cast<std::uint32_t>(value);
      if (point > 0x10ffff) return false;
      units += point > 0xffff ? 2 : 1;
      if (units > max_text_units) return false;
    }
    return true;
  }
  static std::size_t TextUnits(const std::wstring& text) {
    std::size_t units = 0;
    for (wchar_t value : text) units += static_cast<std::uint32_t>(value) > 0xffff ? 2 : 1;
    return units;
  }
  static bool HasContent(const std::wstring& text) {
    for (wchar_t value : text) {
      const auto c = static_cast<std::uint32_t>(value);
      const bool blank = (c >= 9 && c <= 13) || c == 32 || c == 0xa0 || c == 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
      if (!blank) return true;
    }
    return false;
  }
  bool Writable() {
    if (snapshot_.rich_draft) { local_error_ = L"请在 AIChat 中编辑附件或工具内容，草稿未替换。"; return false; }
    if (snapshot_.dictating) { local_error_ = L"语音输入中，请在 AIChat 中操作。"; return false; }
    return true;
  }
  bool InvalidDraft() {
    snapshot_.draft.clear();
    snapshot_.ready = false; snapshot_.rich_draft = true;
    local_error_ = L"主窗口草稿超过宠物文字限制，请打开 AIChat 编辑。";
    return false;
  }
  static const std::wstring& UnknownMessage() {
    static const std::wstring message = L"发送结果未确认，请打开 AIChat 核查后明确确认，不能自动重发。";
    return message;
  }
  void UnknownError() { local_error_ = UnknownMessage(); }
  void AdoptDraft(const std::wstring& text) {
    if (draft_ != text) { draft_ = text; ++revision_; }
    dirty_ = false;
  }
  void RememberId(const std::string& id) {
    if (id.empty() || !used_ids_.insert(id).second) return;
    id_order_.push_back(id);
    if (id_order_.size() > max_remembered_ids) {
      used_ids_.erase(id_order_.front());
      id_order_.pop_front();
    }
  }
  std::optional<Command> Start(const std::string& action, const std::string& id,
                               std::uint64_t now, bool send_after_input) {
    Command command{action, id, snapshot_.context, action == "input" ? draft_ : std::wstring{}};
    RememberId(id);
    pending_ = Pending{command, now, document_, revision_, draft_, send_after_input};
    return command;
  }
  void Isolate() {
    if (!dirty_ && !pending_ && !unknown_send_) return;
    if (draft_.empty() && !pending_ && !unknown_send_) return;
    const bool uncertain = unknown_send_ || (pending_ && pending_->command.action == "send");
    isolated_.push_back({document_, snapshot_.context,
      unknown_send_ ? unknown_id_ : pending_ ? pending_->command.id : std::string{}, draft_,
      unknown_send_ ? unknown_text_ : pending_ ? pending_->text : std::wstring{}, uncertain});
    std::size_t units = 0;
    for (const auto& item : isolated_) units += TextUnits(item.text) + TextUnits(item.submitted_text);
    while (isolated_.size() > max_isolated_drafts || units > max_isolated_units) {
      units -= TextUnits(isolated_.front().text) + TextUnits(isolated_.front().submitted_text);
      isolated_.erase(isolated_.begin());
    }
  }
  void ClearActive() {
    snapshot_ = {}; draft_.clear(); local_error_.clear(); pending_.reset();
    unknown_id_.clear(); unknown_text_.clear(); accepted_text_.clear();
    dirty_ = accepted_ = unknown_send_ = false;
    ++revision_;
  }
};
}
