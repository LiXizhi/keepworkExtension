#include "pet_geometry.h"
#include <climits>
#include <cstdlib>
#include <iostream>

using keepwork_cef::PetDragState;
using keepwork_cef::PetPixels;
using keepwork_cef::PlacePet;

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

int main() {
  SizeUsesMonitorDpiWithBoundedFallbacks();
  PlacementStaysInsideTheSelectedWorkArea();
  PlacementDefendsAgainstExtremeAndUnavailableMonitorData();
  PointerThresholdSeparatesOpeningFromDragging();
  CaptureLossAndExtremeCoordinatesCannotMisfire();
  std::cout << "Pet geometry passed\n";
}
