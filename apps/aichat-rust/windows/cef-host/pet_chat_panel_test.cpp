#include "desktop_pet.h"
#include "pet_chat_panel.h"
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <vector>

static void Check(bool value, const char* label) {
  if (!value) throw std::runtime_error(label);
}

struct FixtureCleanup {
  POINT cursor{};
  bool cursor_saved = GetCursorPos(&cursor) != FALSE;
  std::wstring profile;
  ~FixtureCleanup() {
    if (cursor_saved) SetCursorPos(cursor.x, cursor.y);
    if (!profile.empty()) {
      const auto settings = profile + L"\\pet-settings.ini";
      DeleteFileW(settings.c_str()); RemoveDirectoryW(profile.c_str());
    }
  }
};

static void Click(keepwork_cef::PetChatPanel& panel, int control) {
  SendMessageW(panel.window(), WM_COMMAND, MAKEWPARAM(control, BN_CLICKED),
    reinterpret_cast<LPARAM>(GetDlgItem(panel.window(), control)));
}

static void NativeTests() {
  using namespace keepwork_cef;
  FixtureCleanup cleanup;
  PetChatPanel panel;
  std::vector<PetChatAction> actions;
  std::vector<std::wstring> edits;
  const auto instance = GetModuleHandleW(nullptr);
  Check(panel.Create(instance, [&](PetChatAction action) { actions.push_back(action); },
    [&](std::wstring text) { edits.push_back(std::move(text)); }), "native panel creates real EDIT and BUTTON controls");
  Check(edits.empty(), "control initialization cannot overwrite the page draft through an empty edit callback");
  const HWND window = panel.window();
  const HWND draft = GetDlgItem(window, PetChatPanel::draft_id);
  Check(draft != nullptr, "draft uses one persistent native EDIT");
  PetChatView view;
  view.ready = true; view.can_switch = true; view.title = L"现有网页对话";
  view.transcript = L"用户：测试\n助手：回复";
  panel.Update(view);
  panel.SetDraft(L"第一行\n第二行");
  Check(panel.Draft() == L"第一行\n第二行" && edits.empty(), "canonical drafts preserve text without echoing an edit callback");
  RECT anchor{10, 10, 122, 122};
  panel.Show(anchor);
  Check(panel.visible() && GetFocus() == draft, "only explicit Show activates the text input");
  const auto preserved = panel.Draft();
  view.transcript += L"\n助手：流式追加"; view.busy = true;
  panel.Update(view);
  Check(GetFocus() == draft && GetDlgItem(window, PetChatPanel::draft_id) == draft && panel.Draft() == preserved,
    "streaming snapshots preserve EDIT identity, keyboard focus and local text");
  SendMessageW(draft, WM_KEYDOWN, VK_RETURN, 0);
  SendMessageW(draft, WM_CHAR, L'\r', 0);
  Check(actions.empty(), "Enter inserts text instead of invoking Send");

  // These messages exercise the native composition guard, not an installed
  // language-specific IME or its candidate UI.
  view.busy = false; panel.Update(view); panel.SetDraft(L"组合"); edits.clear();
  SendMessageW(draft, WM_IME_STARTCOMPOSITION, 0, 0);
  SendMessageW(draft, EM_SETSEL, -1, -1);
  SendMessageW(draft, EM_REPLACESEL, TRUE, reinterpret_cast<LPARAM>(L"输入"));
  const auto composing = panel.Draft();
  view.transcript += L"\n后台状态变化";
  panel.Update(view); panel.SetDraft(L"旧快照不应覆盖输入法");
  Check(panel.Draft() == composing && edits.empty() && GetFocus() == draft,
    "composition survives streaming snapshots and stale canonical draft updates");
  SendMessageW(draft, WM_KEYDOWN, VK_RETURN, 0);
  Check(actions.empty(), "candidate confirmation cannot dispatch Send");
  SendMessageW(draft, WM_IME_ENDCOMPOSITION, 0, 0);
  Check(edits.size() == 1 && edits.back() == composing, "composition completion publishes the committed local draft once");
  panel.SetDraft(L"准备发送");
  Check(edits.size() == 1, "later programmatic SetDraft still emits no user edit callback");
  SendMessageW(draft, WM_IME_STARTCOMPOSITION, 0, 0);
  SendMessageW(draft, EM_SETSEL, -1, -1);
  SendMessageW(draft, EM_REPLACESEL, TRUE, reinterpret_cast<LPARAM>(L"旧会话组合"));
  const auto owner_edit_count = edits.size();
  panel.SetDraft(L"新会话草稿", true);
  Check(panel.Draft() == L"新会话草稿" && edits.size() == owner_edit_count,
    "owner changes cancel the old composition and replace its text without echoing a user edit");
  SendMessageW(draft, WM_IME_ENDCOMPOSITION, 0, 0);
  Check(panel.Draft() == L"新会话草稿" && edits.size() == owner_edit_count,
    "late composition completion cannot publish the old owner's text into the new context");
  panel.SetDraft(L"准备发送");
  Click(panel, PetChatPanel::send_id);
  Check(actions.size() == 1 && actions.back() == PetChatAction::Send, "Send dispatches one explicit action");
  view.busy = true; panel.Update(view);
  Click(panel, PetChatPanel::send_id);
  Check(actions.size() == 1, "busy snapshots reject Send even if a raw command is delivered");
  Click(panel, PetChatPanel::stop_id);
  Check(actions.size() == 2 && actions.back() == PetChatAction::Stop, "Stop targets the existing busy conversation");
  view.busy = false; view.ready = false; panel.Update(view);
  Check(IsWindowEnabled(GetDlgItem(window, PetChatPanel::target_id)), "unready default target does not trap target switching");
  Click(panel, PetChatPanel::target_id);
  Check(actions.back() == PetChatAction::ToggleTarget, "switching remains an explicit owner action while current target is unready");
  view.unsynced = true; panel.Update(view);
  const auto before_unsynced = actions.size();
  Check(!IsWindowEnabled(GetDlgItem(window, PetChatPanel::target_id)),
    "unsynced native draft disables target switching instead of discarding visible text");
  Click(panel, PetChatPanel::target_id);
  Check(actions.size() == before_unsynced, "raw switch commands cannot bypass the unsynced draft guard");
  view.unsynced = false;
  view.ready = true; view.rich_draft = true; panel.Update(view);
  Check((GetWindowLongPtrW(draft, GWL_STYLE) & ES_READONLY) && !IsWindowEnabled(GetDlgItem(window, PetChatPanel::send_id)),
    "rich drafts stay protected instead of being silently converted to plain text");
  view.rich_draft = false; view.uncertain = true; panel.Update(view);
  const auto before_unknown = actions.size();
  Click(panel, PetChatPanel::send_id);
  Check(actions.size() == before_unknown && IsWindowVisible(GetDlgItem(window, PetChatPanel::acknowledge_id)),
    "unknown delivery blocks replay and exposes explicit acknowledgement");
  Click(panel, PetChatPanel::acknowledge_id);
  Check(actions.size() == before_unknown + 1 && actions.back() == PetChatAction::AcknowledgeUnknown,
    "acknowledging a checked outcome is distinct from sending again");
  view.busy = true; panel.Update(view);
  Click(panel, PetChatPanel::stop_id);
  Check(actions.back() == PetChatAction::Stop,
    "an explicit Stop remains available for a busy conversation while Send is locked by unknown delivery");
  SendMessageW(window, WM_CLOSE, 0, 0);
  Check(!panel.visible() && actions.back() == PetChatAction::Collapse && panel.Draft() == L"准备发送",
    "closing collapses the native panel while preserving its draft");
  panel.Show(anchor);
  Check(GetDlgItem(panel.window(), PetChatPanel::draft_id) == draft, "reopening does not create a fresh editor or conversation");

  wchar_t temporary[MAX_PATH]{}, profile[MAX_PATH]{};
  Check(GetTempPathW(ARRAYSIZE(temporary), temporary) != 0 &&
    GetTempFileNameW(temporary, L"kwp", 0, profile) != 0, "isolated pet settings path is available");
  Check(DeleteFileW(profile) && CreateDirectoryW(profile, nullptr), "isolated pet settings directory creates");
  cleanup.profile = profile;
  DesktopPet pet;
  int opened = 0, toggled = 0, hidden = 0;
  Check(pet.Create(instance, profile, [&] { ++opened; }, [] {}, [&] { ++toggled; }, [&] { ++hidden; }),
    "pet loads its embedded resource for click classification");
  Check(pet.Show(), "isolated native pet becomes visible");
  const auto bounds = pet.bounds();
  Check(SetCursorPos(bounds.left + 20, bounds.top + 20), "test can position its cursor on the isolated pet");
  const HWND pet_window = pet.window();
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(toggled == 1 && opened == 0, "one click toggles chat without reopening the main window");
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  SendMessageW(pet_window, WM_LBUTTONDBLCLK, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(toggled == 1 && opened == 1, "double-click cancels the pending single action and opens the main window once");
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  Check(SetCursorPos(bounds.left + 26, bounds.top + 20), "test can move beyond the drag threshold");
  SendMessageW(pet_window, WM_MOUSEMOVE, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(toggled == 1 && opened == 1, "dragging cannot leave a delayed chat or main-window action");
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  pet.Hide();
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(toggled == 1 && hidden > 0, "hiding cancels pending clicks and notifies the panel owner");
  pet.Destroy();
  panel.Destroy(); panel.Destroy();
  Check(!IsWindow(window), "panel teardown releases native windows and is idempotent");
  std::cout << "Native pet chat panel and click adapter passed\n";
}

int main() {
  try { NativeTests(); return 0; }
  catch (const std::exception& error) {
    std::cerr << "Native pet chat failure: " << error.what() << '\n'; return 1;
  }
}
