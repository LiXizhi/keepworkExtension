#include "window_geometry.h"
#include <cstdlib>
#include <iostream>

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Window frame geometry failure: " << label << '\n'; std::exit(1); }
}

static bool Overlaps(const keepwork_cef::FrameRect& a, const keepwork_cef::FrameRect& b) {
  return !a.Empty() && !b.Empty() && std::max(a.left, b.left) < std::min(a.right, b.right)
    && std::max(a.top, b.top) < std::min(a.bottom, b.bottom);
}

static void RectanglesHaveUnambiguousHitEdges() {
  using keepwork_cef::FrameRect;
  const FrameRect rect{10, 20, 30, 40};
  Check(rect.Width() == 20 && rect.Height() == 20 && !rect.Empty(), "rectangle dimensions use physical pixels");
  Check(rect.Contains(10, 20) && rect.Contains(29, 39), "left/top pixels belong to the rectangle");
  Check(!rect.Contains(30, 20) && !rect.Contains(10, 40) && !rect.Contains(9, 20),
    "right/bottom edges and outside pixels cannot activate adjacent controls");
  Check(FrameRect{}.Empty() && !FrameRect{}.Contains(0, 0), "hidden widgets have no hit target at the origin");
  Check(FrameRect{30, 20, 10, 40}.Empty() && !FrameRect{30, 20, 10, 40}.Contains(20, 30),
    "reversed rectangles never become clickable");
}

static void ResponsiveCenterControlsDoNotCoverMenusOrResizeBorders() {
  using namespace keepwork_cef;
  for (const int dpi : {96, 97, 120, 144, 192}) for (const bool maximized : {false, true}) {
    for (const int dip_width : {640, 849, 850, 851, 1360}) {
      const FrameLayout scale{0, 0, dpi, maximized};
      const FrameLayout layout{scale.Scale(dip_width), scale.Scale(900), dpi, maximized};
      const auto center = layout.CenterBounds();
      Check(center.title.Empty() == (dip_width < 850), "the title appears at 850 DIP, independently of monitor DPI");
      Check(!center.address.Empty() && !center.refresh.Empty(), "minimum supported windows keep address and refresh usable");
      const int left_limit = layout.MenuBounds(3).right + layout.Scale(12);
      const int right_limit = layout.ControlBounds(0).left - layout.Scale(12);
      for (const auto rect : {center.title, center.address, center.refresh}) {
        if (rect.Empty()) continue;
        Check(rect.left >= left_limit && rect.right <= right_limit,
          "center widgets stay between menus and caption buttons");
        Check(rect.top >= layout.Border() && rect.bottom <= layout.TitleHeight(),
          "center child windows preserve the top resize strip");
        for (int index = 0; index < 4; ++index)
          Check(!Overlaps(rect, layout.MenuBounds(index)), "center chrome cannot cover a menu heading");
        for (int index = 0; index < 3; ++index)
          Check(!Overlaps(rect, layout.ControlBounds(index)), "center chrome cannot cover system controls");
      }
      Check(!Overlaps(center.title, center.address) && !Overlaps(center.address, center.refresh)
          && !Overlaps(center.title, center.refresh), "title/address/refresh have separate display and hit areas");
      for (const auto rect : {center.address, center.refresh}) {
        for (const int x : {rect.left, (rect.left + rect.right) / 2, rect.right - 1}) {
          const int y = (rect.top + rect.bottom) / 2;
          Check(layout.Hit(x, y) == FrameHit::client, "all address/refresh pixels are clickable rather than draggable");
          Check(layout.MenuAt(x, y) == -1, "address/refresh cannot switch a native menu");
        }
      }
      if (!center.title.Empty())
        Check(layout.Hit((center.title.left + center.title.right) / 2, (center.title.top + center.title.bottom) / 2)
          == FrameHit::caption, "the decorative centered title remains draggable");
      const auto icon = layout.IconBounds();
      Check(!icon.Empty() && icon.right <= layout.MenuBounds(0).left,
        "the compact monochrome K leaves room for File");
      Check(layout.Hit((icon.left + icon.right) / 2, (icon.top + icon.bottom) / 2) == FrameHit::caption,
        "the decorative K remains part of the draggable caption");
      const int first = center.title.Empty() ? center.address.left : center.title.left;
      Check(std::abs(first + center.refresh.right - layout.width) <= 1,
        "an unconstrained center group stays centered in the whole window");
      if (!maximized) {
        Check(layout.Hit((center.address.left + center.address.right) / 2, layout.Border() - 1) == FrameHit::top,
          "interactive center controls do not swallow the top resize border");
      }
    }
  }
  const FrameLayout reduced{520, 900, 96, false};
  Check(reduced.CenterBounds().address.Width() >= 72 && reduced.CenterBounds().address.Width() < 144
      && !reduced.CenterBounds().refresh.Empty(), "a narrower programmatic window first shortens its address pill");
  const FrameLayout minimum_address{484, 900, 96, false};
  Check(minimum_address.CenterBounds().address.Width() == 72, "the address remains usable at its minimum width");
  const FrameLayout only_refresh{483, 900, 96, false};
  Check(only_refresh.CenterBounds().address.Empty() && !only_refresh.CenterBounds().refresh.Empty(),
    "address disappears before refresh when it cannot fit at minimum width");
  const FrameLayout tiny{380, 900, 96, false};
  Check(tiny.CenterBounds().title.Empty() && tiny.CenterBounds().address.Empty() && tiny.CenterBounds().refresh.Empty(),
    "center widgets disappear instead of overlapping menus in a tiny programmatic window");
}

int main() {
  using namespace keepwork_cef;
  RectanglesHaveUnambiguousHitEdges();
  ResponsiveCenterControlsDoNotCoverMenusOrResizeBorders();
  const FrameLayout compact{1360, 900, 96, false};
  Check(compact.MenuLeft() == 32 && compact.MenuWidth() == 44 && compact.MenuBounds(3).right == 208,
    "left chrome uses a compact K plus four menu headings without the old Keepwork wordmark gap");
  for (const int dpi : {96, 97, 120, 144, 192}) {
    FrameLayout normal{1360 * dpi / 96, 900 * dpi / 96, dpi, false};
    const int expected_title_height = normal.Scale(34);
    Check(normal.TitleHeight() == expected_title_height, "34 DIP titlebar, rounded to physical pixels");
    Check(normal.Hit(0, 0) == FrameHit::top_left, "top left resize");
    Check(normal.Hit(normal.width - 1, 0) == FrameHit::top_right, "top right resize");
    Check(normal.Hit(0, normal.height - 1) == FrameHit::bottom_left, "bottom left resize");
    Check(normal.Hit(normal.width - 1, normal.height - 1) == FrameHit::bottom_right, "bottom right resize");
    Check(normal.Hit(0, normal.height / 2) == FrameHit::left, "left resize");
    Check(normal.Hit(normal.width - 1, normal.height / 2) == FrameHit::right, "right resize");
    Check(normal.Hit(normal.width / 2, 0) == FrameHit::top, "top resize");
    Check(normal.Hit(normal.width / 2, normal.height - 1) == FrameHit::bottom, "bottom resize");
    Check(normal.Hit(normal.MenuBounds(3).right + normal.Scale(6), normal.TitleHeight() / 2) == FrameHit::caption,
      "blank chrome between menus and center controls remains draggable");
    Check(normal.Hit(normal.width - normal.ButtonWidth(), normal.TitleHeight() / 2) == FrameHit::client, "buttons do not drag");
    Check(normal.Hit(normal.width / 2, normal.TitleHeight()) == FrameHit::client, "web content does not drag");
    for (int menu = 0; menu < 4; ++menu) {
      const auto bounds = normal.MenuBounds(menu);
      const int left = bounds.left;
      const int right = bounds.right - 1;
      const int middle_y = (normal.Border() + normal.TitleHeight()) / 2;
      for (const int x : {left, (left + right) / 2, right}) {
        Check(normal.MenuAt(x, middle_y) == menu, "each menu owns its full horizontal range");
        Check(normal.Hit(x, middle_y) == FrameHit::client, "menu click does not drag the window");
        Check(normal.MenuAt(x, normal.TitleHeight()) == -1, "web content is outside the menu");
        Check(normal.MenuAt(x, normal.Border() - 1) == -1, "top resize strip is outside the menu");
      }
      if (menu < 3) {
        Check(bounds.right == normal.MenuBounds(menu + 1).left, "fractional-DPI menu edges have no gap or overlap");
        Check(normal.MenuAt(bounds.right, middle_y) == menu + 1, "the boundary pixel belongs to the next menu");
      }
    }
    Check(normal.MenuAt(normal.MenuLeft() - 1, normal.TitleHeight() / 2) == -1, "product title is outside menus");
    Check(normal.MenuAt(normal.MenuBounds(3).right, normal.TitleHeight() / 2) == -1, "blank titlebar is outside menus");
    Check(normal.MenuBounds(3).right < normal.ControlBounds(0).left, "menus do not overlap system controls");
    for (int button = 0; button < 3; ++button) {
      const auto bounds = normal.ControlBounds(button);
      for (const int x : {bounds.left, (bounds.left + bounds.right) / 2, bounds.right - 1})
        Check(normal.Hit(x, (bounds.top + bounds.bottom) / 2) == FrameHit::client,
          "caption-button edges use actual bounds including the normal-window border offset");
      if (button < 2) Check(bounds.right == normal.ControlBounds(button + 1).left,
        "fractional-DPI system controls share exact edges");
    }
    FrameLayout smallest{normal.Scale(640), normal.Scale(400), dpi, false};
    Check(smallest.MenuBounds(3).right < smallest.ControlBounds(0).left, "menus fit the minimum window width");
    Check(normal.MenuBounds(-1).Empty() && normal.MenuBounds(4).Empty()
      && normal.ControlBounds(-1).Empty() && normal.ControlBounds(3).Empty(), "invalid native child IDs have no bounds");
    normal.maximized = true;
    Check(normal.Border() == 0, "maximized content has no resize border");
    Check(normal.Hit(0, 0) == FrameHit::caption, "maximized titlebar can restore by dragging");
    Check(normal.Hit(0, normal.height / 2) == FrameHit::client, "maximized edges do not resize");
    Check(normal.Hit(normal.MenuLeft(), 0) == FrameHit::client, "maximized menu has no resize strip");
    normal.fullscreen = true;
    Check(normal.Border() == 0 && normal.TitleHeight() == 0, "fullscreen gives the entire client area to web content");
    const auto hidden_center = normal.CenterBounds();
    Check(hidden_center.title.Empty() && hidden_center.address.Empty() && hidden_center.refresh.Empty()
      && normal.IconBounds().Empty(), "fullscreen removes every decorative and interactive center target");
    for (int index = 0; index < 4; ++index) Check(normal.MenuBounds(index).Empty(), "fullscreen removes menu child bounds");
    for (int index = 0; index < 3; ++index) Check(normal.ControlBounds(index).Empty(), "fullscreen removes system button bounds");
    for (const int x : {0, normal.MenuLeft(), normal.width - 1}) {
      for (const int y : {0, normal.TitleHeight(), normal.height - 1}) {
        Check(normal.Hit(x, y) == FrameHit::client, "fullscreen has no draggable or resize regions");
        Check(normal.MenuAt(x, y) == -1, "fullscreen has no hidden menu hit targets");
      }
    }
    normal.fullscreen = false;
    normal.maximized = false;
    Check(normal.TitleHeight() == expected_title_height && normal.Border() > 0, "restoring fullscreen restores chrome and resize regions");
  }
  std::cout << "Window frame geometry passed\n";
}
