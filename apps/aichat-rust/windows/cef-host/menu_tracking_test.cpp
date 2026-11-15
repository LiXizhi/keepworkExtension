#include "menu_tracking.h"
#include "window_geometry.h"
#include <cstdlib>
#include <iostream>

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Menu tracking failure: " << label << '\n'; std::exit(1); }
}

static void ClosedAndDismissedMenus() {
  keepwork_cef::MenuTracking menu;
  Check(menu.active() == -1, "menus start closed");
  Check(!menu.Begin(-1, 0, 0) && !menu.Begin(4, 0, 0), "invalid headings cannot open");
  Check(!menu.Hover(1, 200, 20), "hover alone cannot open a menu");
  Check(!menu.Switch(1) && !menu.Step(1) && !menu.Click(1), "closed menus ignore tracking input");
  Check(menu.Advance() == -1, "no pending menu after idle input");
  Check(menu.Begin(0, 120, 20), "click or shortcut opens the initial menu");
  Check(!menu.Begin(2, 240, 20) && menu.active() == 0, "a second popup loop cannot nest");
  Check(!menu.Hover(0, 121, 20), "hovering the current heading does not rebuild it");
  Check(!menu.Click(-1), "outside clicks remain with the native menu dismissal handler");
  Check(menu.Advance() == -1, "Escape or native outside dismissal has no pending replacement");
  Check(!menu.Hover(2, 250, 20), "hover after dismissal cannot reopen a menu");
  Check(menu.Begin(1, 180, 20) && menu.Click(1), "clicking the open heading is handled");
  Check(menu.Advance() == -1, "clicking the open heading closes it");
  Check(menu.Begin(0, 120, 20) && menu.Switch(3), "a replacement may be pending");
  menu.Close();
  Check(menu.active() == -1 && menu.Advance() == -1, "close discards pending replacements");
  Check(!menu.Hover(3, 300, 20), "focus loss or teardown cannot leave hover tracking active");
  Check(menu.Begin(2, 260, 20), "a later explicit interaction starts cleanly");
}

static void HoverAndRapidSwitching() {
  const keepwork_cef::FrameLayout layout{1360, 900, 96, false};
  const auto heading_x = [&](int heading) {
    const auto rect = layout.MenuBounds(heading);
    return (rect.left + rect.right) / 2;
  };
  const int y = (layout.Border() + layout.TitleHeight()) / 2;
  keepwork_cef::MenuTracking menu;
  Check(menu.Begin(0, heading_x(0), y), "open File before horizontal hover");
  for (int heading : {1, 2, 3, 0}) {
    const int previous = menu.active();
    Check(menu.Hover(layout.MenuAt(heading_x(heading), y), heading_x(heading), y),
      "horizontal movement across compact headings requests the hovered menu");
    Check(menu.active() == previous, "popup replacement waits until the current native loop exits");
    Check(menu.Advance() == heading, "the requested popup becomes active");
  }
  Check(menu.Hover(1, heading_x(1), y), "rapid move first reaches Edit");
  Check(menu.Hover(3, heading_x(3), y), "rapid move can skip View");
  Check(menu.Advance() == 3, "latest hovered heading wins without opening intermediate popups");
  Check(menu.Hover(1, heading_x(1), y) && menu.Hover(3, heading_x(3), y), "rapid direction reversal is handled");
  Check(menu.Advance() == 3, "returning to the original heading supersedes a pending switch");
  Check(!menu.Hover(-1, 600, 20), "blank titlebar does not switch menus");
  Check(!menu.Hover(-1, 290, 80), "entering popup rows does not switch menus");
  Check(menu.Click(1) && menu.Advance() == 1, "clicking a different heading switches once");
  Check(!menu.Hover(1, heading_x(1), y), "the newly opened heading does not reopen on pointer movement");
}

static void KeyboardWithStationaryPointer() {
  keepwork_cef::MenuTracking menu;
  constexpr int x = -1760, y = -220;
  Check(menu.Begin(0, x, y), "open menu on a monitor with negative screen coordinates");
  Check(menu.Step(-1) && menu.Advance() == 3, "Left wraps File to Help");
  Check(!menu.Hover(0, x, y) && menu.active() == 3, "synthetic stationary mouse move cannot undo keyboard navigation");
  Check(menu.Step(1) && menu.Advance() == 0, "Right wraps Help to File");
  Check(menu.Step(1) && menu.Advance() == 1, "Right selects the next heading");
  Check(!menu.Hover(0, x, y), "repeated stationary mouse messages leave the keyboard selection intact");
  Check(menu.Switch(2) && menu.Advance() == 2, "Alt heading navigation selects its requested menu");
  Check(!menu.Switch(2), "the current Alt heading does not rebuild the popup");
  Check(!menu.Switch(-1) && !menu.Switch(4), "unrecognized shortcut headings remain unhandled");
  Check(menu.Hover(0, x + 1, y) && menu.Advance() == 0, "actual pointer movement resumes hover tracking");
  Check(menu.Click(menu.active()) && menu.Advance() == -1, "F10 can dismiss the active menu");
}

static void ScaledAndPositionedHeadings() {
  using namespace keepwork_cef;
  for (int dpi : {96, 97, 120, 144, 192}) for (bool maximized : {false, true})
      for (int dip_width : {640, 849, 850, 1360}) {
    const FrameLayout scale{0, 0, dpi, maximized};
    FrameLayout layout{scale.Scale(dip_width), scale.Scale(900), dpi, maximized};
    // Match ScreenToClient's translation before calling the production MenuAt.
    for (int origin_x : {-2400, 80}) for (int origin_y : {-900, 80}) {
      MenuTracking menu;
      const int local_y = (layout.Border() + layout.TitleHeight()) / 2;
      const auto first = layout.MenuBounds(0);
      const int first_x = (first.left + first.right) / 2;
      Check(menu.Begin(0, origin_x + first_x, origin_y + local_y), "open at translated screen coordinates");
      for (int heading : {1, 3, 2, 0}) {
        const auto bounds = layout.MenuBounds(heading);
        const int local_x = (bounds.left + bounds.right) / 2;
        const int screen_x = origin_x + local_x, screen_y = origin_y + local_y;
        Check(menu.Hover(layout.MenuAt(screen_x - origin_x, screen_y - origin_y), screen_x, screen_y),
          "DPI-scaled screen position selects the hovered heading");
        Check(menu.Advance() == heading, "translated pointer opens the expected menu");
      }
      Check(!menu.Hover(layout.MenuAt(first_x, layout.TitleHeight()), origin_x + first_x,
        origin_y + layout.TitleHeight()), "popup content is outside title headings");
      Check(!menu.Hover(layout.MenuAt(layout.MenuLeft() - 1, local_y), origin_x + layout.MenuLeft() - 1,
        origin_y + local_y), "decorative K is outside menu headings");
      for (const auto bounds : {layout.CenterBounds().address, layout.CenterBounds().refresh}) {
        const int x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
        Check(!bounds.Empty() && !menu.Hover(layout.MenuAt(x, y), origin_x + x, origin_y + y),
          "address and refresh cannot replace the active menu while its native input loop is open");
      }
      if (!maximized) Check(!menu.Hover(layout.MenuAt(first_x, layout.Border() - 1), origin_x + first_x,
        origin_y + layout.Border() - 1), "resize border cannot trigger menu switching");
      layout.fullscreen = true;
      const int second_x = first.right + layout.MenuWidth() / 2;
      Check(!menu.Hover(layout.MenuAt(second_x, local_y), origin_x + second_x, origin_y + local_y),
        "fullscreen has no hidden hover target");
      menu.Close();
      Check(!menu.Hover(1, origin_x + second_x + 1, origin_y + local_y), "dismissal prevents hover reopening");
      layout.fullscreen = false;
    }
  }
}

static void CheckActiveVisual(const keepwork_cef::MenuTracking& menu, int expected,
                             int stale_focus, int stale_hover) {
  for (int heading = 0; heading < 4; ++heading) {
    const auto visual = menu.Visual(heading, heading == stale_focus, heading == stale_hover,
      heading == stale_focus, false);
    Check(visual.highlighted == (heading == expected),
      "the actual live popup owns the only highlighted heading despite stale BUTTON state");
    Check(!visual.focus_outline, "menu headings never retain native BUTTON dashed focus rectangles");
  }
}

static void StaleHelpFocusCannotCompeteWithTheViewPopup() {
  keepwork_cef::MenuTracking menu;
  Check(menu.Begin(3, 186, 20), "the user initially clicks Help");
  CheckActiveVisual(menu, 3, 3, 3);
  Check(menu.Hover(2, 142, 20), "moving to View requests the View popup");
  CheckActiveVisual(menu, 3, 3, 2);
  Check(menu.Advance() == 2, "View becomes active only after Help's native loop exits");
  CheckActiveVisual(menu, 2, 3, 3);
  const auto stale_help = menu.Visual(3, true, true, true, false);
  const auto actual_view = menu.Visual(2, false, false, false, false);
  Check(!stale_help.highlighted && !stale_help.focus_outline,
    "a focused, pressed, or hovered old Help BUTTON cannot look selected beside View content");
  Check(actual_view.highlighted && !actual_view.focus_outline,
    "the active View heading is emphasized without requiring native keyboard focus transfer");
  Check(menu.Hover(1, 98, 20) && menu.Hover(0, 54, 20) && menu.Hover(3, 186, 20),
    "rapid pointer movement can supersede multiple pending replacements");
  CheckActiveVisual(menu, 2, 3, 0);
  Check(menu.Advance() == 3, "only the latest requested heading becomes the live popup");
  CheckActiveVisual(menu, 3, 2, 0);
  menu.Close();
  for (int heading = 0; heading < 4; ++heading) {
    const auto dismissed = menu.Visual(heading, false, false, heading == 3, false);
    Check(!dismissed.highlighted && !dismissed.focus_outline,
      "closing the mouse menu clears visual selection despite old native Help focus");
  }
}

static void KeyboardMenusUseTheActualActiveBackgroundAsTheirFocusCue() {
  keepwork_cef::MenuTracking menu;
  constexpr int x = -2300, y = -100;
  Check(menu.Begin(0, x, y), "Alt+F or F10 starts the File popup");
  CheckActiveVisual(menu, 0, 3, -1);
  Check(menu.Step(-1) && menu.Advance() == 3, "Left wraps keyboard selection from File to Help");
  CheckActiveVisual(menu, 3, 0, 0);
  Check(!menu.Hover(0, x, y), "a stationary synthetic mouse message cannot undo keyboard navigation");
  CheckActiveVisual(menu, 3, 0, 0);
  Check(menu.Step(1) && menu.Advance() == 0, "Right wraps the actual popup back to File");
  CheckActiveVisual(menu, 0, 3, 3);
  Check(menu.Switch(2) && menu.Advance() == 2, "Alt+V switches to the actual View popup");
  CheckActiveVisual(menu, 2, 0, 0);
  Check(menu.Click(2) && menu.Advance() == -1, "F10 or the current heading can dismiss the menu");
  for (int heading = 0; heading < 4; ++heading) {
    const auto idle = menu.Visual(heading, false, false, true, false);
    Check(!idle.highlighted && !idle.focus_outline,
      "dismissal or backgrounding cannot leave an old focused heading visually active");
  }
}

static void OrdinaryControlFocusAndClosedHeadingHoverStayUsable() {
  keepwork_cef::MenuTracking menu;
  const auto idle = menu.Visual(0, false, false, true, false);
  const auto hovered = menu.Visual(0, false, true, true, false);
  const auto pressed = menu.Visual(0, true, false, false, false);
  Check(!idle.highlighted && !idle.focus_outline, "native focus alone does not select a closed menu");
  Check(hovered.highlighted && !hovered.focus_outline, "ordinary mouse hover still emphasizes a closed heading");
  Check(pressed.highlighted && !pressed.focus_outline, "press feedback does not require a dashed menu outline");
  for (bool popup : {false, true}) {
    if (popup) Check(menu.Begin(2, 142, 20), "toolbar focus remains independent while a popup is active");
    const auto keyboard = menu.Visual(-1, false, false, true, false);
    const auto hidden_focus = menu.Visual(-1, false, false, true, true);
    const auto toolbar_hover = menu.Visual(-1, false, true, false, false);
    const auto toolbar_press = menu.Visual(-1, true, false, false, false);
    Check(!keyboard.highlighted && keyboard.focus_outline,
      "keyboard focus indication remains available for address and window controls");
    Check(!hidden_focus.highlighted && !hidden_focus.focus_outline,
      "ODS_NOFOCUSRECT continues to suppress non-menu focus cues when Windows requests it");
    Check(toolbar_hover.highlighted && !toolbar_hover.focus_outline
      && toolbar_press.highlighted && !toolbar_press.focus_outline,
      "the menu-specific fix preserves toolbar hover and press feedback");
  }
}

int main() {
  ClosedAndDismissedMenus();
  HoverAndRapidSwitching();
  KeyboardWithStationaryPointer();
  ScaledAndPositionedHeadings();
  StaleHelpFocusCannotCompeteWithTheViewPopup();
  KeyboardMenusUseTheActualActiveBackgroundAsTheirFocusCue();
  OrdinaryControlFocusAndClosedHeadingHoverStayUsable();
  std::cout << "Menu tracking passed\n";
}
