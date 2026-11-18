//! Native window bounds are independent of the full-monitor layout space.
use crate::pet::{PetHitRegion, WorkArea};

/// Regions are monitor-local; fallback and result are global logical points.
/// Alpha holes remain the pointer controller's responsibility, never a rectangle.
pub fn crop(area: WorkArea, fallback: WorkArea, regions: &[PetHitRegion]) -> WorkArea {
    let mut union: Option<(f64, f64, f64, f64)> = None;
    for region in regions {
        let (mut l, mut t, mut r, mut b) = (region.left, region.top,
            region.left + region.width, region.top + region.height);
        if ![l, t, r, b].iter().all(|n| n.is_finite()) || region.width <= 0.0 || region.height <= 0.0 { continue; }
        if let Some(mask) = &region.mask {
            if !mask.valid() { continue; }
            let (mut x0, mut y0, mut x1, mut y1) = (mask.width as usize, mask.height as usize, 0, 0);
            for y in 0..mask.height as usize { for x in 0..mask.width as usize {
                if mask.contains(x, y) { x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x + 1); y1 = y1.max(y + 1); }
            }}
            if x1 <= x0 || y1 <= y0 { continue; }
            l += region.width * x0 as f64 / mask.width as f64;
            t += region.height * y0 as f64 / mask.height as f64;
            r = region.left + region.width * x1 as f64 / mask.width as f64;
            b = region.top + region.height * y1 as f64 / mask.height as f64;
        }
        l = l.floor().max(0.0); t = t.floor().max(0.0);
        r = r.ceil().min(area.width as f64); b = b.ceil().min(area.height as f64);
        if r <= l || b <= t { continue; }
        union = Some(match union { Some((a,c,d,e)) => (a.min(l),c.min(t),d.max(r),e.max(b)), None => (l,t,r,b) });
    }
    let (l,t,r,b) = union.unwrap_or_else(|| {
        let x = fallback.x as f64 - area.x as f64;
        let y = fallback.y as f64 - area.y as f64;
        let l = x.clamp(0.0, (area.width - 1).max(0) as f64);
        let t = y.clamp(0.0, (area.height - 1).max(0) as f64);
        (l,t,(x + fallback.width.max(1) as f64).clamp(l + 1.0, area.width.max(1) as f64),
            (y + fallback.height.max(1) as f64).clamp(t + 1.0, area.height.max(1) as f64))
    });
    WorkArea { x: area.x.saturating_add(l as i32), y: area.y.saturating_add(t as i32),
        width: (r-l).max(1.0) as i32, height: (b-t).max(1.0) as i32 }
}
