//! Capture the primary display's physical pixel grid (the same grid as native input).
use super::{Shot, MAX_JPEG};
use image::{codecs::jpeg::JpegEncoder, ExtendedColorType};
use std::{mem::size_of, ptr::null_mut};
use windows_sys::Win32::{
    Graphics::Gdi::*,
    UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN},
};

pub(super) fn capture() -> Result<Shot, String> {
    unsafe {
        let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        if w <= 0
            || h <= 0
            || w > 32767
            || h > 32767
            || i64::from(w) * i64::from(h) > 32 * 1024 * 1024
        {
            return Err("主屏幕尺寸无效或过大。".into());
        }
        let screen = GetDC(null_mut());
        if screen.is_null() {
            return Err("无法访问 Windows 主屏幕。".into());
        }
        let memory = CreateCompatibleDC(screen);
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // top-down BGRA, tightly packed at 32 bpp
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bits = null_mut();
        let bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        let rgb = (|| {
            if memory.is_null() || bitmap.is_null() || bits.is_null() {
                return Err("无法分配 Windows 截图缓冲区。");
            }
            let previous = SelectObject(memory, bitmap);
            if previous.is_null() || previous as isize == -1 {
                return Err("无法选择 Windows 截图缓冲区。");
            }
            let ok = BitBlt(memory, 0, 0, w, h, screen, 0, 0, SRCCOPY | CAPTUREBLT) != 0
                && GdiFlush() != 0;
            SelectObject(memory, previous);
            if !ok {
                return Err("Windows 未返回主屏幕截图。");
            }
            let bgra = std::slice::from_raw_parts(bits.cast::<u8>(), w as usize * h as usize * 4);
            let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
            for pixel in bgra.chunks_exact(4) {
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
            Ok(rgb)
        })();
        if !bitmap.is_null() {
            DeleteObject(bitmap);
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
        ReleaseDC(null_mut(), screen);
        let rgb = rgb?;
        for quality in [78, 57, 38] {
            let mut jpeg = Vec::new();
            JpegEncoder::new_with_quality(&mut jpeg, quality)
                .encode(&rgb, w as u32, h as u32, ExtendedColorType::Rgb8)
                .map_err(|_| "Windows 主屏幕 JPEG 编码失败。")?;
            if jpeg.len() <= MAX_JPEG {
                return Ok(Shot {
                    width: w as u32,
                    height: h as u32,
                    jpeg,
                });
            }
        }
        Err("主屏幕截图超过 3 MiB。".into())
    }
}
