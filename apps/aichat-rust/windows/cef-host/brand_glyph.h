#pragma once
#include "refresh_glyph.h"

namespace keepwork_cef {
// WindowFrame owns the GDI+ session, including when its optional pet is absent.
class BrandGlyph {
 public:
  static void Draw(HDC context, const RECT& bounds, COLORREF color) {
    if (!context || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
    Gdiplus::Graphics graphics(context);
    graphics.SetPageUnit(Gdiplus::UnitPixel);
    graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
    const Gdiplus::Matrix transform(
      (bounds.right - bounds.left) / 18.0f, 0, 0,
      (bounds.bottom - bounds.top) / 18.0f,
      static_cast<Gdiplus::REAL>(bounds.left), static_cast<Gdiplus::REAL>(bounds.top));
    graphics.SetTransform(&transform);
    // Preserve the original titlebar.ts SVG's half-pixel vertices. Rounding
    // these before rasterization removes part of the small K's diagonal arms.
    const Gdiplus::PointF points[]{{3.5f,3},{6.5f,3},{6.5f,7.5f},{11,3},{14.5f,3},
      {8.5f,9},{14.5f,15},{11,15},{6.5f,10.5f},{6.5f,15},{3.5f,15}};
    Gdiplus::GraphicsPath path;
    path.AddPolygon(points, ARRAYSIZE(points));
    Gdiplus::SolidBrush brush(Gdiplus::Color(255, GetRValue(color), GetGValue(color), GetBValue(color)));
    graphics.FillPath(&brush, &path);
  }
};
}
