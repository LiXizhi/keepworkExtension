#pragma once
#include <windows.h>
#include <objidl.h>
#include <algorithm>
namespace Gdiplus { using std::min; using std::max; }
#include <gdiplus.h>

namespace keepwork_cef {
// The frame owns its graphics session: painting must work before the pet is
// created and when that optional window is disabled or unavailable.
class RefreshGlyph {
 public:
  ~RefreshGlyph() { Destroy(); }
  bool Initialize() {
    if (token_) return true;
    Gdiplus::GdiplusStartupInput input;
    return Gdiplus::GdiplusStartup(&token_, &input, nullptr) == Gdiplus::Ok;
  }
  void Destroy() {
    if (token_) { Gdiplus::GdiplusShutdown(token_); token_ = 0; }
  }
  void Draw(HDC context, const RECT& bounds, COLORREF color, int pixels) const {
    if (!token_ || !context || pixels <= 0) return;
    const Gdiplus::REAL scale = static_cast<Gdiplus::REAL>(pixels) / 24.0f;
    const Gdiplus::REAL left = (bounds.left + bounds.right - pixels) / 2.0f;
    const Gdiplus::REAL top = (bounds.top + bounds.bottom - pixels) / 2.0f;
    Gdiplus::Graphics graphics(context);
    graphics.SetPageUnit(Gdiplus::UnitPixel);
    graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
    const Gdiplus::Matrix transform(scale, 0, 0, scale, left, top);
    graphics.SetTransform(&transform);
    // Match the original titlebar.ts SVG without rounding each small-arc
    // endpoint to integer pixels or inheriting the HDC's arc direction.
    Gdiplus::GraphicsPath path;
    path.AddArc(3.0f, 3.0f, 18.0f, 18.0f, 0.0f, 315.0f);
    path.StartFigure();
    const Gdiplus::PointF head[]{{21, 3}, {21, 9}, {15, 9}};
    path.AddLines(head, 3);
    Gdiplus::Pen pen(Gdiplus::Color(255, GetRValue(color), GetGValue(color), GetBValue(color)), 1.8f);
    pen.SetStartCap(Gdiplus::LineCapRound);
    pen.SetEndCap(Gdiplus::LineCapRound);
    pen.SetLineJoin(Gdiplus::LineJoinRound);
    graphics.DrawPath(&pen, &path);
  }
 private:
  ULONG_PTR token_ = 0;
};
}
