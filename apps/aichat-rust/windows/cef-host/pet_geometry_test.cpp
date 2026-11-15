#include "pet_geometry.h"
#include <climits>
#include <cstdlib>
#include <iostream>

using keepwork_cef::PetDragState;
using keepwork_cef::PetPixels;
using keepwork_cef::PlacePet;
using keepwork_cef::PlacePetChat;

static void Check(bool value, const char* label) {
  if (!value) { std::cerr << "Pet geometry failure: " << label << '\n'; std::exit(1); }
}

static void SizeUsesMonitorDpiWithBoundedFallbacks() {
  Check(PetPixels(96) == 112 && PetPixels(120) == 140 && PetPixels(144) == 168
      && PetPixels(192) == 224 && PetPixels(384) == 448,
    "ordinary Windows monitor scales preserve the 112 DIP pet size");
  Check(PetPixels(100) == 117, "fractional physical pixels round rather than truncate");
  Check(PetPixels(0) == 112 && PetPixels(-96) == 112 && PetPixels(INT_MIN) == 112,
    "a missing or invalid legacy DPI report falls back to 96 DPI");
  Check(PetPixels(1) == 56 && PetPixels(24) == 56,
    "very low DPI input cannot produce an invisible or zero-size pet");
  Check(PetPixels(960) == 896 && PetPixels(INT_MAX) == 896,
    "extreme DPI remains bounded without overflowing size calculations");
}

static void PlacementStaysInsideTheSelectedWorkArea() {
  auto position = PlacePet(1800, 1000, 112, {0, 0, 1920, 1040});
  Check(position.x == 1800 && position.y == 928 && position.pixels == 112,
    "the taskbar's excluded work area clamps a pet near the lower edge");
  position = PlacePet(-2000, -250, 168, {-1920, -200, 0, 880});
  Check(position.x == -1920 && position.y == -200 && position.pixels == 168,
    "a monitor above and left of the primary retains negative screen coordinates");
  position = PlacePet(0, 880, 168, {-1920, -200, 0, 880});
  Check(position.x == -168 && position.y == 712,
    "right/bottom clamping is relative to the selected monitor rather than primary-screen origin");
  position = PlacePet(-1200, 100, 168, {-1920, -200, 0, 880});
  Check(position.x == -1200 && position.y == 100,
    "an in-bounds drag leaves its screen position unchanged");
  position = PlacePet(100, 100, 112, {0, 0, 40, 30});
  Check(position.x == 10 && position.y == 0 && position.pixels == 30,
    "small work areas shrink the pet before clamping its coordinates");
  position = PlacePet(640, 480, 0, {0, 0, 640, 480});
  Check(position.x == 639 && position.y == 479 && position.pixels == 1,
    "invalid zero-size placement still has a bounded one-pixel surface");
  position = PlacePet(INT_MIN, INT_MAX, -100, {0, 0, 640, 480});
  Check(position.x == 0 && position.y == 479 && position.pixels == 1,
    "negative sizes and extreme drag coordinates cannot escape the work area");
}

static void PlacementDefendsAgainstExtremeAndUnavailableMonitorData() {
  auto position = PlacePet(INT_MAX, INT_MAX, INT_MAX, {INT_MIN, INT_MIN, INT_MAX, INT_MAX});
  Check(position.x == INT_MAX - 896 && position.y == INT_MAX - 896 && position.pixels == 896,
    "work-area width and oversized input use bounded arithmetic across the full int range");
  position = PlacePet(INT_MIN, INT_MIN, 112, {INT_MIN, INT_MIN, INT_MAX, INT_MAX});
  Check(position.x == INT_MIN && position.y == INT_MIN && position.pixels == 112,
    "the most negative valid monitor origin does not wrap to the primary screen");
  position = PlacePet(INT_MAX, INT_MAX, 112, {INT_MAX - 100, INT_MAX - 80, INT_MAX, INT_MAX});
  Check(position.x == INT_MAX - 80 && position.y == INT_MAX - 80 && position.pixels == 80,
    "a tiny monitor near the positive coordinate limit still clamps safely");
  position = PlacePet(0, 0, 112, {40, -30, 40, -30});
  Check(position.x == 40 && position.y == -30 && position.pixels == 1,
    "an unavailable empty work area has a deterministic defensive fallback");
  position = PlacePet(0, 0, 112, {100, 50, -100, -50});
  Check(position.x == 100 && position.y == 50 && position.pixels == 1,
    "reversed monitor bounds cannot become a huge allocation");
}

static void PointerThresholdSeparatesOpeningFromDragging() {
  PetDragState drag;
  Check(!drag.active() && !drag.Move(100, 100) && !drag.End(100, 100),
    "stray mouse move/up events cannot activate an idle pet");
  drag.Begin(-100, -200);
  Check(drag.active() && !drag.moved(), "a press records a fresh drag origin");
  Check(!drag.Move(-97, -200) && drag.End(-97, -200),
    "sub-threshold movement still permits the pet's click action");
  Check(!drag.active() && !drag.End(-97, -200), "one release cannot open the chat twice");
  drag.Begin(50, 60);
  Check(!drag.Move(54, 60) && drag.End(54, 60),
    "exactly four physical pixels remain a click, matching the modern pet");
  drag.Begin(50, 60);
  Check(drag.Move(55, 60) && drag.moved() && !drag.End(55, 60),
    "movement beyond four physical pixels begins a drag rather than opening chat");
  drag.Begin(50, 60);
  Check(drag.Move(54, 61) && !drag.End(54, 61),
    "a diagonal displacement just past the four-pixel circle begins dragging");
  drag.Begin(50, 60);
  Check(drag.Move(53, 63) && !drag.End(53, 63),
    "diagonal displacement uses the distance threshold, not independent axis thresholds");
  drag.Begin(50, 60);
  Check(drag.Move(58, 60) && drag.Move(50, 60) && !drag.End(50, 60),
    "dragging back onto the press origin cannot turn the release into a click");
  drag.Begin(50, 60);
  Check(!drag.End(55, 60), "the final mouse-up position is checked even without a last mouse-move event");
}

static void CaptureLossAndExtremeCoordinatesCannotMisfire() {
  PetDragState drag;
  drag.Begin(10, 20);
  drag.Cancel();
  Check(!drag.active() && !drag.End(10, 20), "capture loss cancels an otherwise valid click");
  drag.Cancel();
  Check(!drag.Move(100, 100) && !drag.End(100, 100), "repeated cancellation stays inactive");
  drag.Begin(10, 20);
  drag.Move(80, 20);
  drag.Cancel();
  Check(!drag.End(10, 20), "capture loss during a drag never activates chat");
  drag.Begin(INT_MIN, INT_MIN);
  Check(drag.Move(INT_MAX, INT_MAX) && !drag.End(INT_MAX, INT_MAX),
    "large cross-monitor moves cannot overflow into a false click");
  drag.Begin(1, 2);
  Check(!drag.moved() && drag.End(1, 2), "a new press works after earlier drag/capture cancellation");
}

static void ChatFollowsItsAnchorAndAvoidsTheTaskbar() {
  auto position = PlacePetChat({1700, 800, 1812, 912}, 360, 360, 8, {0, 0, 1920, 1040});
  Check(position.x == 1452 && position.y == 432 && position.width == 360 && position.height == 360,
    "the chat sits eight pixels above its pet with aligned right edges");
  position = PlacePetChat({1620, 750, 1732, 862}, 360, 360, 8, {0, 0, 1920, 1040});
  Check(position.x == 1372 && position.y == 382,
    "moving the pet in open space moves its chat by the same horizontal and vertical deltas");
  position = PlacePetChat({30, 20, 142, 132}, 360, 360, 8, {0, 0, 1920, 1040});
  Check(position.x == 0 && position.y == 140,
    "near the upper left edge the chat flips below the pet and stays inside the work area");
  position = PlacePetChat({1900, 900, 2012, 1012}, 360, 360, 8, {0, 0, 1920, 1040});
  Check(position.x == 1560 && position.y == 532,
    "an anchor past the right edge cannot place the chat outside the available desktop");
  position = PlacePetChat({700, 200, 812, 312}, 360, 360, 8, {0, 0, 1000, 500});
  Check(position.y >= 0 && position.y + position.height <= 500,
    "when neither side fits the chat remains visible rather than crossing the taskbar");
}

static void ChatPlacementHandlesOtherMonitorsAndSmallWorkAreas() {
  auto position = PlacePetChat({-400, 500, -288, 612}, 360, 360, 8, {-1920, -200, 0, 880});
  Check(position.x == -648 && position.y == 132,
    "chat placement preserves a secondary monitor's negative screen coordinates");
  position = PlacePetChat({-1850, -190, -1738, -78}, 540, 540, 12, {-1920, -200, 0, 880});
  Check(position.x == -1920 && position.y == -66 && position.width == 540 && position.height == 540,
    "physical sizes and spacing at 150 percent DPI work on a monitor above the primary screen");
  position = PlacePetChat({10, 5, 30, 25}, 360, 360, 8, {0, 0, 40, 30});
  Check(position.x == 0 && position.y == 0 && position.width == 40 && position.height == 30,
    "a work area smaller than the chat shrinks both dimensions before coordinate clamping");
  position = PlacePetChat({10, 10, 122, 122}, 0, -10, -8, {0, 0, 640, 480});
  Check(position.width >= 1 && position.height >= 1 && position.x >= 0 && position.y >= 0 &&
      std::int64_t(position.x) + position.width <= 640 && std::int64_t(position.y) + position.height <= 480,
    "invalid dimensions and spacing still produce a bounded visible chat");
}

static void ChatPlacementCannotOverflowOrUseUnavailableBounds() {
  auto position = PlacePetChat({INT_MIN, INT_MIN, INT_MAX, INT_MAX}, INT_MAX, INT_MAX, INT_MAX,
    {INT_MIN, INT_MIN, INT_MAX, INT_MAX});
  Check(position.width > 0 && position.height > 0 && position.x >= INT_MIN && position.y >= INT_MIN &&
      std::int64_t(position.x) + position.width <= INT_MAX &&
      std::int64_t(position.y) + position.height <= INT_MAX,
    "extreme anchor, panel and gap values cannot wrap outside the selected monitor");
  position = PlacePetChat({INT_MAX - 20, INT_MAX - 20, INT_MAX, INT_MAX}, 360, 360, 8,
    {INT_MAX - 100, INT_MAX - 80, INT_MAX, INT_MAX});
  Check(position.x == INT_MAX - 100 && position.y == INT_MAX - 80 && position.width == 100 && position.height == 80,
    "tiny work areas near the integer limit safely constrain both chat dimensions");
  position = PlacePetChat({0, 0, 112, 112}, 360, 360, 8, {40, -30, 40, -30});
  Check(position.x == 40 && position.y == -30 && position.width == 1 && position.height == 1,
    "an unavailable empty monitor has a deterministic one-pixel chat fallback");
  position = PlacePetChat({0, 0, 112, 112}, 360, 360, 8, {100, 50, -100, -50});
  Check(position.x == 100 && position.y == 50 && position.width == 1 && position.height == 1,
    "reversed monitor bounds cannot create a giant chat surface");
}

int main() {
  SizeUsesMonitorDpiWithBoundedFallbacks();
  PlacementStaysInsideTheSelectedWorkArea();
  PlacementDefendsAgainstExtremeAndUnavailableMonitorData();
  PointerThresholdSeparatesOpeningFromDragging();
  CaptureLossAndExtremeCoordinatesCannotMisfire();
  ChatFollowsItsAnchorAndAvoidsTheTaskbar();
  ChatPlacementHandlesOtherMonitorsAndSmallWorkAreas();
  ChatPlacementCannotOverflowOrUseUnavailableBounds();
  std::cout << "Pet geometry passed\n";
}
