#include "tray_lifecycle.h"
#include <cstdlib>
#include <iostream>

using keepwork_cef::CloseAction;
using keepwork_cef::TrayLifecycle;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Tray lifecycle failure: " << label << '\n'; std::exit(1); }
}

static void MissingTrayKeepsTheWindowReachable() {
  TrayLifecycle state;
  Check(!state.tray_available() && !state.hidden() && !state.browser_closing(),
    "a new host has no registered tray or pending browser close");
  Check(state.Start(false) && !state.hidden(), "ordinary startup shows the main window");
  Check(state.Close() == CloseAction::close_browser,
    "without a tray, closing follows the browser close protocol");
  Check(!state.hidden(), "a failed tray registration cannot hide the only window");

  TrayLifecycle background;
  Check(background.Start(true) && !background.hidden(),
    "background startup falls back to a reachable window if tray creation failed");
  Check(!background.SetTrayAvailable(false), "repeated registration failure needs no extra restore");
  Check(background.Close() == CloseAction::close_browser,
    "the fallback window still supports an ordinary browser close");
}

static void ClosingAndRestoringPreserveTheBrowserSession() {
  TrayLifecycle state;
  Check(!state.SetTrayAvailable(true), "registering a tray does not require restoring a visible window");
  Check(state.Start(false), "a registered tray does not suppress normal startup");
  for (int repeat = 0; repeat < 5; ++repeat) {
    Check(state.Close() == CloseAction::hide && state.hidden(),
      "the titlebar close hides the existing browser session");
    Check(state.Close() == CloseAction::hide && state.hidden(),
      "repeated close messages do not start browser teardown");
    Check(!state.browser_closing(), "hiding does not approve or initiate browser destruction");
    state.Show();
    state.Show();
    Check(!state.hidden() && state.tray_available() && !state.browser_closing(),
      "repeated tray activation restores the same live session");
  }
}

static void BackgroundStartupRequiresAnActualTray() {
  TrayLifecycle state;
  state.SetTrayAvailable(true);
  Check(!state.Start(true) && state.hidden(),
    "background startup hides only after the tray has registered");
  Check(state.tray_available() && !state.browser_closing(),
    "the hidden background host remains alive and reachable through its tray");
  state.Show();
  Check(!state.hidden(), "the first tray activation reveals the background host");
  Check(state.Close() == CloseAction::hide, "a restored background host can hide again");
}

static void ExplorerRestartCannotStrandAHiddenHost() {
  TrayLifecycle hidden;
  hidden.SetTrayAvailable(true);
  hidden.Start(true);
  Check(hidden.SetTrayAvailable(false),
    "losing the registered tray while hidden requests an immediate window restore");
  Check(!hidden.hidden() && !hidden.tray_available(),
    "tray recovery failure leaves a reachable window and no stale registration claim");
  Check(hidden.Close() == CloseAction::close_browser,
    "close after failed Explorer recovery cannot hide an unreachable host");
  Check(!hidden.SetTrayAvailable(false), "repeated Explorer failure cannot request repeated restores");
  Check(!hidden.SetTrayAvailable(true), "a recovered tray leaves the restored window visible");
  Check(hidden.Close() == CloseAction::hide && hidden.hidden(),
    "successful later registration re-enables close-to-tray");

  TrayLifecycle visible;
  visible.SetTrayAvailable(true);
  visible.Start(false);
  Check(!visible.SetTrayAvailable(false) && !visible.hidden(),
    "Explorer restart does not change the visibility of an already visible window");
  Check(!visible.SetTrayAvailable(true), "Explorer can re-register while the window stays visible");
  Check(visible.Close() == CloseAction::hide, "the restored icon supports subsequent hiding");

  TrayLifecycle recoveredInPlace;
  recoveredInPlace.SetTrayAvailable(true);
  recoveredInPlace.Start(true);
  Check(!recoveredInPlace.SetTrayAvailable(true) && recoveredInPlace.hidden(),
    "a successful icon refresh does not reveal a deliberately hidden window");
}

static void BeforeUnloadApprovalControlsTheActualExit() {
  TrayLifecycle state;
  state.SetTrayAvailable(true);
  state.Start(true);
  // Explicit Quit first shows the existing browser and requests CEF close.
  // A rejected beforeunload never invokes BrowserClosing (CEF DoClose).
  state.Show();
  Check(!state.browser_closing(), "requesting Quit does not pre-approve the browser close");
  Check(state.Close() == CloseAction::hide && state.hidden(),
    "after a canceled Quit, the next titlebar close still hides normally");
  state.Show();
  state.BrowserClosing();
  Check(state.browser_closing(), "CEF DoClose records actual close approval");
  for (int repeat = 0; repeat < 3; ++repeat) {
    Check(state.Close() == CloseAction::close_browser && !state.hidden(),
      "CEF's follow-up close messages finish teardown instead of hiding again");
  }
  Check(!state.SetTrayAvailable(false), "tray deletion during approved exit cannot resurrect the window");
  state.SetTrayAvailable(true);
  Check(state.Close() == CloseAction::close_browser,
    "late shell registration cannot turn an approved exit back into hiding");

  TrayLifecycle hidden;
  hidden.SetTrayAvailable(true);
  hidden.Start(true);
  hidden.BrowserClosing();
  Check(hidden.browser_closing() && !hidden.hidden(),
    "browser-initiated approved close clears an earlier hidden state");
  Check(!hidden.SetTrayAvailable(false),
    "Explorer failure during an approved hidden-browser exit must not restore the window");
  Check(hidden.Close() == CloseAction::close_browser,
    "a browser-initiated close completes even if its tray disappeared");
}

static void CleanupIsSafeAcrossPartialStartupAndRepeatedDestruction() {
  for (bool registerTray : {false, true}) for (bool background : {false, true}) {
    TrayLifecycle state;
    state.SetTrayAvailable(registerTray);
    state.Start(background);
    state.Destroy();
    state.Destroy();
    Check(!state.tray_available() && !state.hidden(),
      "cleanup forgets the icon and hidden state even after partial startup");
    Check(state.Close() == CloseAction::close_browser,
      "a destroyed tray cannot intercept a final browser close message");
  }
}

static void PetVisibilityFollowsTheExistingWindowLifecycle() {
  TrayLifecycle state;
  Check(!state.pet_visible(), "ordinary startup has no desktop pet overlay");
  state.SetTrayAvailable(true);
  state.Start(false);
  state.SetPetVisible(true);
  Check(!state.pet_visible(), "a visible main window cannot also claim a visible desktop pet");
  for (int repeat = 0; repeat < 3; ++repeat) {
    Check(state.Close() == CloseAction::hide, "closing the existing browser requests hiding");
    state.SetPetVisible(true);  // The native pet has actually been shown.
    Check(state.hidden() && state.pet_visible() && !state.browser_closing(),
      "closing can preserve the browser behind a visible desktop pet");
    state.Show();
    Check(!state.hidden() && !state.pet_visible() && !state.browser_closing(),
      "pet or tray activation reveals the main window and clears the pet overlay");
  }
  state.Close();
  state.SetPetVisible(true);
  state.SetPetVisible(false);
  Check(state.hidden() && !state.pet_visible(), "the pet can be hidden while the tray remains a recovery entry");
  state.Close();
  state.SetPetVisible(true);
  Check(state.pet_visible(), "closing again can restore a previously hidden pet");
  state.Show();
  Check(!state.hidden() && !state.pet_visible(), "failed pet creation can use the same visible-window fallback");
  state.Close();
  state.SetPetVisible(true);
  Check(state.SetTrayAvailable(false) && !state.hidden() && !state.pet_visible(),
    "Explorer failure recovery restores the main window and clears its pet");
  state.SetTrayAvailable(true);
  state.Close();
  state.SetPetVisible(true);
  state.BrowserClosing();
  state.SetPetVisible(true);
  Check(!state.hidden() && !state.pet_visible() && state.browser_closing(),
    "approved browser teardown cannot re-show a stale pet");
  state.Destroy();
  Check(!state.pet_visible(), "final cleanup clears the desktop pet visibility claim");

  TrayLifecycle background;
  background.SetTrayAvailable(true);
  background.Start(true);
  Check(background.hidden() && !background.pet_visible(),
    "background startup does not claim a pet before native creation succeeds");
  background.SetPetVisible(true);
  background.Start(true);
  Check(!background.pet_visible(), "restarting startup visibility clears any stale native pet claim");
}

int main() {
  MissingTrayKeepsTheWindowReachable();
  ClosingAndRestoringPreserveTheBrowserSession();
  BackgroundStartupRequiresAnActualTray();
  ExplorerRestartCannotStrandAHiddenHost();
  BeforeUnloadApprovalControlsTheActualExit();
  CleanupIsSafeAcrossPartialStartupAndRepeatedDestruction();
  PetVisibilityFollowsTheExistingWindowLifecycle();
  std::cout << "Tray lifecycle passed\n";
}
