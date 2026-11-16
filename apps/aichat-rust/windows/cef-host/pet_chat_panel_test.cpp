#include "window_frame.h"
#include "pet_chat_panel.h"
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

static void Check(bool value, const std::string& label) {
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

struct KeyboardState {
  BYTE saved[256]{};
  bool valid = GetKeyboardState(saved) != FALSE;
  ~KeyboardState() { if (valid) SetKeyboardState(saved); }
  void Shift(bool down) {
    BYTE state[256]{};
    Check(GetKeyboardState(state) != FALSE, "fixture can read its thread keyboard state");
    state[VK_SHIFT] = down ? 0x80 : 0;
    Check(SetKeyboardState(state) != FALSE, "fixture can set its thread modifier without injecting system keys");
  }
};

static void Enter(HWND draft, bool repeat = false) {
  const LPARAM base = 1 | (static_cast<LPARAM>(MapVirtualKeyW(VK_RETURN, MAPVK_VK_TO_VSC)) << 16);
  const LPARAM pressed = base | (repeat ? static_cast<LPARAM>(1ULL << 30) : 0);
  SendMessageW(draft, WM_KEYDOWN, VK_RETURN, pressed);
  SendMessageW(draft, WM_CHAR, L'\r', pressed);
  SendMessageW(draft, WM_KEYUP, VK_RETURN, base | static_cast<LPARAM>((1ULL << 30) | (1ULL << 31)));
}

static void SelectDraftEnd(HWND draft) {
  const auto length = static_cast<DWORD>(GetWindowTextLengthW(draft));
  SendMessageW(draft, EM_SETSEL, length, length);
  DWORD start = 0, end = 0;
  SendMessageW(draft, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
  Check(start == length && end == length, "fixture caret is explicitly at the end of the native draft");
}

static std::string InputDiagnostic(HWND draft, size_t actions) {
  DWORD start = 0, end = 0;
  SendMessageW(draft, EM_GETSEL, reinterpret_cast<WPARAM>(&start), reinterpret_cast<LPARAM>(&end));
  wchar_t raw[128]{};
  const int count = GetWindowTextW(draft, raw, ARRAYSIZE(raw));
  std::ostringstream out;
  out << "; actions=" << actions << "; selection=" << start << ',' << end
      << "; shift=" << ((GetKeyState(VK_SHIFT) & 0x8000) != 0)
      << "; leftShift=" << ((GetKeyState(VK_LSHIFT) & 0x8000) != 0)
      << "; rightShift=" << ((GetKeyState(VK_RSHIFT) & 0x8000) != 0)
      << "; control=" << ((GetKeyState(VK_CONTROL) & 0x8000) != 0)
      << "; alt=" << ((GetKeyState(VK_MENU) & 0x8000) != 0) << "; raw UTF-16=" << std::hex;
  for (int index = 0; index < count; ++index) out << static_cast<unsigned>(raw[index]) << ',';
  return out.str();
}

static bool IsAbove(HWND upper, HWND lower) {
  for (HWND current = GetTopWindow(nullptr); current; current = GetWindow(current, GW_HWNDNEXT)) {
    if (current == upper) return true;
    if (current == lower) return false;
  }
  return false;
}

static BOOL CALLBACK FindFixturePet(HWND candidate, LPARAM result) {
  wchar_t name[64]{};
  if (GetClassNameW(candidate, name, ARRAYSIZE(name)) && wcscmp(name, L"KeepworkCefDesktopPet") == 0) {
    *reinterpret_cast<HWND*>(result) = candidate;
    return FALSE;
  }
  return TRUE;
}

static void NativeTests() {
  using namespace keepwork_cef;
  FixtureCleanup cleanup;
  PetChatPanel panel;
  std::vector<PetChatAction> actions;
  std::vector<std::wstring> edits;
  const auto instance = GetModuleHandleW(nullptr);
  DesktopPet pet;
  Check(panel.Create(instance, [&](PetChatAction action) {
    actions.push_back(action);
    if (action == PetChatAction::HidePet) pet.Hide();
  },
    [&](std::wstring text) { edits.push_back(std::move(text)); }), "native panel creates real EDIT and BUTTON controls");
  Check(edits.empty(), "control initialization cannot overwrite the page draft through an empty edit callback");
  const HWND window = panel.window();
  const HWND draft = GetDlgItem(window, PetChatPanel::draft_id);
  Check(draft != nullptr, "draft uses one persistent native EDIT");
  PetChatView view;
  view.ready = true; view.title = L"现有网页对话";
  view.transcript = L"用户：测试\n助手：回复";
  panel.Update(view);
  panel.SetDraft(L"第一行\n第二行");
  Check(panel.Draft() == L"第一行\n第二行" && edits.empty(), "canonical drafts preserve text without echoing an edit callback");
  RECT anchor{10, 10, 122, 122};
  panel.Show(anchor);
  Check(panel.visible() && GetFocus() == draft, "only explicit Show activates the text input");
  Check((GetWindowLongPtrW(window, GWL_STYLE) & (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU)) == 0,
    "the chat uses a compact frameless pet panel instead of a system dialog title bar");
  Check((GetWindowLongPtrW(draft, GWL_EXSTYLE) & WS_EX_CLIENTEDGE) == 0 &&
      (GetWindowLongPtrW(GetDlgItem(window, PetChatPanel::transcript_id), GWL_EXSTYLE) & WS_EX_CLIENTEDGE) == 0,
    "the draft and reply avoid recessed system dialog borders");
  HRGN panel_region = CreateRectRgn(0, 0, 0, 0);
  Check(panel_region && GetWindowRgn(window, panel_region) != ERROR && !PtInRegion(panel_region, 0, 0),
    "the native pet panel clips its outer corners to the rounded card shape");
  DeleteObject(panel_region);
  SendMessageW(draft, EM_SETSEL, 1, 3);
  SetFocus(GetDlgItem(window, PetChatPanel::open_id));
  const HWND follow_focus = GetFocus();
  const auto follow_edits = edits.size();
  panel.Follow({30, 40, 142, 152});
  DWORD follow_start = 0, follow_end = 0;
  SendMessageW(draft, EM_GETSEL, reinterpret_cast<WPARAM>(&follow_start), reinterpret_cast<LPARAM>(&follow_end));
  Check(GetFocus() == follow_focus && panel.Draft() == L"第一行\n第二行" && follow_start == 1 && follow_end == 3 &&
      edits.size() == follow_edits && GetDlgItem(window, PetChatPanel::draft_id) == draft,
    "following its pet preserves keyboard focus, selection, editor identity and local draft without publishing edits");
  panel.Hide();
  panel.Follow({60, 80, 172, 192});
  Check(!panel.visible(), "moving a collapsed chat cannot reopen or activate it");
  panel.Show(anchor);
  const auto preserved = panel.Draft();
  view.transcript += L"\n助手：流式追加"; view.busy = true;
  panel.Update(view);
  Check(GetFocus() == draft && GetDlgItem(window, PetChatPanel::draft_id) == draft && panel.Draft() == preserved,
    "streaming snapshots preserve EDIT identity, keyboard focus and local text");
  Enter(draft);
  Check(actions.size() == 1 && actions.back() == PetChatAction::Stop && panel.Draft() == preserved,
    "busy Enter stops the existing reply once and consumes its translated carriage return");
  Enter(draft, true);
  Check(actions.size() == 1 && panel.Draft() == preserved, "held Enter cannot repeat Stop or append a newline");
  actions.clear();
  view.busy = false; panel.Update(view); panel.SetDraft(L"回车发送");
  Enter(draft);
  Check(actions.size() == 1 && actions.back() == PetChatAction::Send && panel.Draft() == L"回车发送",
    "idle Enter sends once without adding its translated carriage return to the submitted draft");
  Enter(draft, true);
  Check(actions.size() == 1 && panel.Draft() == L"回车发送", "held Enter cannot repeat Send or append a newline");
  {
    KeyboardState keyboard;
    keyboard.Shift(true);
    Check((GetKeyState(VK_SHIFT) & 0x8000) != 0, "fixture Shift modifier is visible to the native EDIT thread");
    // EM_SETSEL(-1, -1) only deselects the preserved 1..3 range above; it does
    // not mean "move to end". Establish the native caret precondition first.
    SelectDraftEnd(draft);
    const auto before_multiline_edits = edits.size();
    Enter(draft);
    Check(actions.size() == 1 && panel.Draft() == L"回车发送\n",
      "Shift+Enter retains native multiline editing without sending" + InputDiagnostic(draft, actions.size()));
    keyboard.Shift(false);
    SendMessageW(draft, WM_CHAR, L'续', 1);
    Check(actions.size() == 1 && panel.Draft() == L"回车发送\n续" &&
        edits.size() == before_multiline_edits + 2 && edits.back() == panel.Draft(),
      "native multiline edits publish the actual local draft without sending" + InputDiagnostic(draft, actions.size()));
    actions.clear();
    Enter(draft);
    Check(actions.size() == 1 && actions.back() == PetChatAction::Send && panel.Draft() == L"回车发送\n续",
      "Enter submits the edited multiline draft once without appending another newline" + InputDiagnostic(draft, actions.size()));
  }
  panel.SetDraft(L"　 \t");
  Enter(draft);
  Check(actions.size() == 1, "blank Enter cannot send");
  actions.clear();

  // These messages exercise the native composition guard, not an installed
  // language-specific IME or its candidate UI.
  view.busy = false; panel.Update(view); panel.SetDraft(L"组合"); edits.clear();
  SendMessageW(draft, WM_IME_STARTCOMPOSITION, 0, 0);
  SelectDraftEnd(draft);
  SendMessageW(draft, EM_REPLACESEL, TRUE, reinterpret_cast<LPARAM>(L"输入"));
  const auto composing = panel.Draft();
  view.transcript += L"\n后台状态变化";
  panel.Follow({40, 60, 152, 172});
  panel.Update(view); panel.SetDraft(L"旧快照不应覆盖输入法");
  Check(panel.Draft() == composing && edits.empty() && GetFocus() == draft,
    "composition survives pet movement, streaming snapshots and stale canonical draft updates");
  SendMessageW(draft, WM_KEYDOWN, VK_RETURN, 0);
  Check(actions.empty(), "candidate confirmation cannot dispatch Send");
  SendMessageW(draft, WM_IME_ENDCOMPOSITION, 0, 0);
  Check(edits.size() == 1 && edits.back() == composing, "composition completion publishes the committed local draft once");
  panel.SetDraft(L"准备发送");
  Check(edits.size() == 1, "later programmatic SetDraft still emits no user edit callback");
  SendMessageW(draft, WM_IME_STARTCOMPOSITION, 0, 0);
  SelectDraftEnd(draft);
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
  const HWND target = GetDlgItem(window, PetChatPanel::target_id);
  wchar_t class_name[32]{}, current_title[128]{};
  GetClassNameW(target, class_name, ARRAYSIZE(class_name));
  GetWindowTextW(target, current_title, ARRAYSIZE(current_title));
  Check(_wcsicmp(class_name, L"STATIC") == 0 && !(GetWindowLongPtrW(target, GWL_STYLE) & WS_TABSTOP) &&
    view.title == current_title, "the current conversation is an accessible read-only title");
  Click(panel, PetChatPanel::target_id);
  Check(actions.size() == 2, "clicking the title cannot change the current conversation");
  view.ready = true; view.rich_draft = true; panel.Update(view);
  Check((GetWindowLongPtrW(draft, GWL_STYLE) & ES_READONLY) && !IsWindowEnabled(GetDlgItem(window, PetChatPanel::send_id)),
    "rich drafts stay protected instead of being silently converted to plain text");
  view.rich_draft = false; view.uncertain = true; panel.Update(view);
  const auto before_unknown = actions.size();
  Click(panel, PetChatPanel::send_id);
  Enter(draft);
  Check(actions.size() == before_unknown && IsWindowVisible(GetDlgItem(window, PetChatPanel::acknowledge_id)),
    "unknown delivery blocks replay and exposes explicit acknowledgement");
  Click(panel, PetChatPanel::acknowledge_id);
  Check(actions.size() == before_unknown + 1 && actions.back() == PetChatAction::AcknowledgeUnknown,
    "acknowledging a checked outcome is distinct from sending again");
  view.busy = true; panel.Update(view);
  Click(panel, PetChatPanel::stop_id);
  Check(actions.back() == PetChatAction::Stop,
    "an explicit Stop remains available for a busy conversation while Send is locked by unknown delivery");
  Click(panel, PetChatPanel::open_id);
  Check(actions.back() == PetChatAction::OpenMain, "maximize requests the existing main window");
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
  int opened = 0, toggled = 0, hidden = 0, moved = 0;
  RECT moved_bounds{};
  Check(pet.Create(instance, profile, [&] { ++opened; }, [] {}, [&] { ++toggled; }, [&] { ++hidden; panel.Hide(); },
    [&](RECT rect) { ++moved; moved_bounds = rect; panel.Follow(rect); }),
    "pet loads its embedded resource for click classification");
  Check(pet.Show(), "isolated native pet becomes visible");
  const auto bounds = pet.bounds();
  Check(moved > 0 && EqualRect(&moved_bounds, &bounds), "the movement callback reports the painted pet's actual screen bounds");
  panel.Show(bounds);
  Click(panel, PetChatPanel::collapse_id);
  Check(!panel.visible() && pet.visible() && actions.back() == PetChatAction::Collapse && panel.Draft() == L"准备发送",
    "the close button dismisses only the panel and keeps its draft");
  panel.Show(bounds);
  const HWND raised_focus = GetFocus();
  pet.Raise();
  Check(IsAbove(pet.window(), window) && raised_focus == draft && GetFocus() == raised_focus,
    "raising the pet keeps it above a potentially overlapping chat without taking the editor's focus");
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
  RECT chat_before_drag{}; GetWindowRect(window, &chat_before_drag);
  const auto before_drag_callbacks = moved;
  const auto drag_draft = panel.Draft();
  const auto drag_edits = edits.size();
  SendMessageW(draft, EM_SETSEL, 1, 3);
  SetFocus(draft);
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  Check(SetCursorPos(bounds.left + 26, bounds.top + 20), "test can move beyond the drag threshold");
  SendMessageW(pet_window, WM_MOUSEMOVE, MK_LBUTTON, 0);
  RECT chat_during_drag{}; GetWindowRect(window, &chat_during_drag);
  const auto pet_during_drag = pet.bounds();
  DWORD drag_start = 0, drag_end = 0;
  SendMessageW(draft, EM_GETSEL, reinterpret_cast<WPARAM>(&drag_start), reinterpret_cast<LPARAM>(&drag_end));
  Check(moved > before_drag_callbacks && EqualRect(&moved_bounds, &pet_during_drag) &&
      pet_during_drag.left == bounds.left + 6 && chat_during_drag.left == chat_before_drag.left + 6 &&
      chat_during_drag.top == chat_before_drag.top && panel.visible(),
    "the expanded chat follows the pet while the mouse is still held, before release");
  Check(GetFocus() == draft && panel.Draft() == drag_draft && edits.size() == drag_edits &&
      drag_start == 1 && drag_end == 3 && GetDlgItem(window, PetChatPanel::draft_id) == draft,
    "real pet dragging never steals focus, replaces the editor or mutates its draft and selection");
  Check(IsAbove(pet_window, window), "the pet remains above the chat during a drag so an overlapping panel cannot cover it");
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(toggled == 1 && opened == 1, "dragging cannot leave a delayed chat or main-window action");
  SendMessageW(pet_window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
  SendMessageW(pet_window, WM_LBUTTONUP, 0, 0);
  Click(panel, PetChatPanel::minimize_id);
  SendMessageW(pet_window, WM_TIMER, 2, 0);
  Check(actions.back() == PetChatAction::HidePet && !pet.visible() && pet.enabled() &&
      toggled == 1 && hidden > 0 && !panel.visible() && panel.Draft() == drag_draft,
    "minimize hides the pet and panel, cancels pending clicks and preserves the draft and pet preference");
  Check(pet.Show() && !panel.visible(), "showing or repositioning the pet leaves a collapsed chat hidden");
  pet.Destroy();
  panel.Destroy(); panel.Destroy();
  Check(!IsWindow(window), "panel teardown releases native windows and is idempotent");
  WindowFrame frame;
  Check(frame.Create(), "fixture can create the real native main window");
  frame.Attach(nullptr, [] { return false; }, [] {}, [] {}, [](WindowCommand) {}, true, profile);
  if (!IsWindowVisible(frame.window())) { // Pet mode requires a registered native tray.
    HWND sprite = nullptr;
    EnumThreadWindows(GetCurrentThreadId(), FindFixturePet, reinterpret_cast<LPARAM>(&sprite));
    Check(sprite && IsWindowVisible(sprite), "the native pet starts visible when the frame is hidden");
    frame.SetupPetChat([](PetChatAction) {}, [](std::wstring) {}, [] {}, [] {});
    RECT sprite_bounds{}; GetWindowRect(sprite, &sprite_bounds);
    frame.pet_chat().Show(sprite_bounds);
    ShowWindow(frame.window(), SW_SHOWNOACTIVATE);
    Check(IsWindowVisible(frame.window()) && !IsWindowVisible(sprite) && !frame.pet_chat().visible(),
      "showing the frame through Windows directly dismisses both standalone pet windows");
    SendMessageW(frame.window(), WM_CLOSE, 0, 0);
    Check(!IsWindowVisible(frame.window()) && IsWindowVisible(sprite),
      "returning to pet mode after the native restore keeps the pet preference");
    EnableWindow(frame.window(), FALSE);
    Check(!frame.RevealPetApproval("page", false) && !IsWindowVisible(frame.window()),
      "a native modal retains control while the page requests attention");
    EnableWindow(frame.window(), TRUE);
    Check(frame.RevealPetApproval("page", false) && IsWindowVisible(frame.window()) && !IsIconic(frame.window()),
      "a page confirmation reveals the existing full window from pet mode");
    Check(!frame.ReturnToPetAfterApproval("page"), "ordinary confirmation does not arm a screenshot return");
    SendMessageW(frame.window(), WM_CLOSE, 0, 0);
    Check(frame.RevealPetApproval("page", true) && !frame.ReturnToPetAfterApproval("other-document") &&
        frame.ReturnToPetAfterApproval("page") && !IsWindowVisible(frame.window()) && !frame.ReturnToPetAfterApproval("page"),
      "a screenshot reveal permits one return to pet mode from the same document before capture");
    Check(frame.RevealPetApproval("page", true), "the next screenshot can reveal the window again");
    frame.Show();
    Check(!frame.ReturnToPetAfterApproval("page") && IsWindowVisible(frame.window()),
      "explicitly reopening the main window supersedes a screenshot return");
    Check(!frame.RevealPetApproval("page", false), "another confirmation cannot steal focus in ordinary main mode");
    SendMessageW(frame.window(), WM_CLOSE, 0, 0);
    frame.TemporarilyHidePet();
    Check(IsIconic(frame.window()) && IsWindowVisible(frame.window()) && !frame.RevealPetApproval("page", false),
      "temporary pet minimization keeps the taskbar entry without revealing an unrelated confirmation");
    SendMessageW(frame.window(), WM_SYSCOMMAND, SC_RESTORE, 0);
    Check(IsWindowVisible(frame.window()) && !IsIconic(frame.window()),
      "the standard taskbar restore action opens the retained main window");
  } else {
    Check(!frame.RevealPetApproval("page", false), "a missing tray leaves ordinary main mode undisturbed");
    std::cout << "Native tray unavailable; pet-to-main window transitions skipped\n";
  }
  frame.Destroy();
  std::cout << "Native pet chat panel and click adapter passed\n";
}

int main() {
  try { NativeTests(); return 0; }
  catch (const std::exception& error) {
    std::cerr << "Native pet chat failure: " << error.what() << '\n'; return 1;
  }
}
