//! Composites `state` ref annotations (red boxes + `[N]` badges) onto a
//! screenshot PNG, post-capture, in the CLI.
//!
//! Why CLI-side: DOM overlays injected before `Page.captureScreenshot` do not
//! survive CDP capture on background tabs (Chrome returns a stale composited
//! frame; injected layers are missing). Drawing onto the decoded PNG is
//! deterministic and independent of tab/window state.
//!
//! Geometry: the extension returns element rects in CSS px (viewport-relative)
//! plus `scroll.vw` (viewport CSS width) and `scroll.y`. The screenshot is
//! device px; `scale = img.width / vw` converts. For full-page captures the
//! image starts at scroll 0, so rects get `+ scroll.y`.

use anyhow::{Context, Result};
use image::{Rgba, RgbaImage};
use serde_json::Value;

const RED: Rgba<u8> = Rgba([255, 59, 48, 255]);
const RED_FILL: Rgba<u8> = Rgba([255, 59, 48, 30]);
const WHITE: Rgba<u8> = Rgba([255, 255, 255, 255]);

/// 5x7 bitmap digits; row bitmask, MSB = leftmost pixel.
const FONT_DIGITS: [[u8; 7]; 10] = [
    [
        0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
    ],
    [
        0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
    ],
    [
        0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110,
    ],
    [
        0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
    ],
    [
        0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
    ],
    [
        0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
    ],
];

fn fill_rect(img: &mut RgbaImage, x0: i64, y0: i64, x1: i64, y1: i64, color: Rgba<u8>) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let (x0, y0) = (x0.clamp(0, w), y0.clamp(0, h));
    let (x1, y1) = (x1.clamp(0, w), y1.clamp(0, h));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    for y in y0..y1 {
        for x in x0..x1 {
            img.put_pixel(x as u32, y as u32, color);
        }
    }
}

fn border_rect(
    img: &mut RgbaImage,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    thickness: i64,
    color: Rgba<u8>,
) {
    fill_rect(img, x, y, x + w, y + thickness, color);
    fill_rect(img, x, y + h - thickness, x + w, y + h, color);
    fill_rect(img, x, y, x + thickness, y + h, color);
    fill_rect(img, x + w - thickness, y, x + w, y + h, color);
}

fn draw_digits(img: &mut RgbaImage, x: i64, y: i64, scale: i64, text: &str) {
    let mut cx = x;
    for ch in text.chars() {
        let Some(digit) = ch.to_digit(10) else {
            continue;
        };
        let glyph = FONT_DIGITS[digit as usize];
        for (row, mask) in glyph.iter().enumerate() {
            for col in 0..5 {
                if mask & (0b10000 >> col) != 0 {
                    fill_rect(
                        img,
                        cx + col as i64 * scale,
                        y + row as i64 * scale,
                        cx + (col + 1) as i64 * scale,
                        y + (row + 1) as i64 * scale,
                        WHITE,
                    );
                }
            }
        }
        cx += 6 * scale; // 5 wide + 1 spacing
    }
}

/// Draw annotations from the extension's state.snapshot payload onto a PNG.
/// Returns the annotated PNG bytes. `full` = captureBeyondViewport was used
/// (rects are viewport-relative; the image spans scroll 0..page height).
pub fn apply_annotation(png: &[u8], annotation: &Value, full: bool) -> Result<Vec<u8>> {
    let Some(elements) = annotation.get("elements").and_then(|v| v.as_array()) else {
        return Ok(png.to_vec());
    };
    if elements.is_empty() {
        return Ok(png.to_vec());
    }
    let mut img = image::load_from_memory(png)
        .context("decode screenshot for annotation")?
        .to_rgba8();
    let vw = annotation
        .get("scroll")
        .and_then(|s| s.get("vw"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as f64;
    let scroll_y = annotation
        .get("scroll")
        .and_then(|s| s.get("y"))
        .and_then(Value::as_i64)
        .unwrap_or(0) as f64;
    let scale = if vw > 0.0 {
        img.width() as f64 / vw
    } else {
        1.0
    };
    let thickness = (2.0 * scale).round().max(1.0) as i64;
    let y_off = if full {
        (scroll_y * scale).round() as i64
    } else {
        0
    };

    for el in elements {
        let (Some(x), Some(y)) = (
            el.get("x").and_then(Value::as_i64),
            el.get("y").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let w = el.get("w").and_then(Value::as_i64).unwrap_or(10);
        let h = el.get("h").and_then(Value::as_i64).unwrap_or(10);
        let ref_n = el.get("ref").and_then(Value::as_u64);

        let (bx, by) = (
            (x as f64 * scale).round() as i64,
            (y as f64 * scale).round() as i64 + y_off,
        );
        let (bw, bh) = (
            (w as f64 * scale).round() as i64,
            (h as f64 * scale).round() as i64,
        );
        fill_rect(&mut img, bx, by, bx + bw, by + bh, RED_FILL);
        border_rect(&mut img, bx, by, bw, bh, thickness, RED);

        if let Some(ref_n) = ref_n {
            let text = ref_n.to_string();
            let fs = (scale as i64).max(1);
            let digits_w = text.len() as i64 * 6 * fs;
            let badge_h = (16.0 * scale).round() as i64;
            let badge_w = (digits_w + 8 * fs).max(badge_h);
            let badge_x = bx;
            let badge_y = (by - badge_h).max(0);
            fill_rect(
                &mut img,
                badge_x,
                badge_y,
                badge_x + badge_w,
                badge_y + badge_h,
                RED,
            );
            draw_digits(
                &mut img,
                badge_x + 4 * fs,
                badge_y + (badge_h - 7 * fs) / 2,
                fs,
                &text,
            );
        }
    }

    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .context("encode annotated screenshot")?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn draws_boxes_and_badges_at_scaled_positions() {
        // 200x100 image, vw=100 css px -> scale 2
        let img = RgbaImage::from_pixel(200, 100, Rgba([255, 255, 255, 255]));
        let png = {
            let mut buf = Vec::new();
            image::DynamicImage::ImageRgba8(img.clone())
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .unwrap();
            buf
        };
        let annotation = json!({
            "elements": [
                {"ref": 7, "tag": "button", "x": 10, "y": 20, "w": 30, "h": 10}
            ],
            "scroll": {"vw": 100, "y": 0}
        });
        let out = apply_annotation(&png, &annotation, false).unwrap();
        let decoded = image::load_from_memory(&out).unwrap().to_rgba8();
        // box fill at (10..40, 20..30) scaled x2 -> red-ish fill at (20, 40)
        let p = decoded.get_pixel(25, 45);
        assert!(p[0] > 200 && p[1] < 150, "expected red fill, got {p:?}");
        // border at top edge of box: (20, 40)
        let p = decoded.get_pixel(25, 41);
        assert!(p[0] > 200 && p[1] < 100, "expected red border, got {p:?}");
        // badge above the box (20, 20..32): solid red
        let p = decoded.get_pixel(25, 26);
        assert!(p[0] > 200 && p[1] < 100, "expected red badge, got {p:?}");
    }

    #[test]
    fn empty_elements_returns_original() {
        let png = vec![1, 2, 3];
        let out = apply_annotation(&png, &json!({"elements": []}), false).unwrap();
        assert_eq!(out, png);
    }
}
