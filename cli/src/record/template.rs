//! Literal task text is rasterized in Rust: never passed to a shell/filter parser.
use super::util::read_bounded;
use anyhow::{bail, Context, Result};
use ap_browser_core::recording::*;
use fontdue::{Font, FontSettings};
use image::{Rgb, RgbImage};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub fn text_ok(text: &str, empty: bool) -> Result<()> {
    anyhow::ensure!(
        (empty || !text.is_empty())
            && text.len() <= MAX_TEXT_BYTES
            && text.split('\n').count() <= 8
            && !text.chars().any(|c| c.is_control() && c != '\n'),
        "text must be <=512 UTF-8 bytes, <=8 lines, no control characters except LF"
    );
    Ok(())
}
fn color(s: &str) -> Result<[u8; 3]> {
    anyhow::ensure!(
        s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit),
        "color must be #RRGGBB"
    );
    Ok([
        u8::from_str_radix(&s[1..3], 16)?,
        u8::from_str_radix(&s[3..5], 16)?,
        u8::from_str_radix(&s[5..7], 16)?,
    ])
}
/// One pass only; substituted values are literal and never reparsed.
pub fn expand(text: &str, values: &BTreeMap<String, String>) -> Result<String> {
    let mut chars = text.chars().peekable();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match c {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                out.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                out.push('}');
            }
            '{' => {
                let mut key = String::new();
                let mut closed = false;
                for c in chars.by_ref() {
                    if c == '}' {
                        closed = true;
                        break;
                    }
                    key.push(c);
                }
                anyhow::ensure!(closed, "unmatched template brace");
                out.push_str(
                    values
                        .get(&key)
                        .with_context(|| format!("unknown/unavailable placeholder {{{key}}}"))?,
                );
            }
            '}' => bail!("unmatched template brace"),
            c => out.push(c),
        }
        anyhow::ensure!(out.len() <= 4096, "expanded watermark exceeds 4096 bytes");
    }
    Ok(out)
}
pub fn values(
    labels: &Labels,
    run_id: Option<&str>,
    identity: Option<&Identity>,
    export_id: &str,
    row: &OutputFrame,
    source: bool,
) -> BTreeMap<String, String> {
    let mut v = BTreeMap::new();
    for (k, value) in labels {
        v.insert(format!("label.{k}"), value.clone());
    }
    for (k, value) in [
        ("run_id", run_id.unwrap_or("").to_string()),
        ("export_id", export_id.into()),
        ("phase", row.phase.clone().unwrap_or_default()),
        ("marks", row.marks.join(" | ")),
        ("pts_ms", decimal(row.pts_ms)),
        ("output_frame", row.output_frame.to_string()),
    ] {
        v.insert(k.into(), value);
    }
    if source {
        v.insert(
            "record_id".into(),
            identity.map(|i| i.record_id.clone()).unwrap_or_default(),
        );
        v.insert(
            "source_seq".into(),
            row.source_seq.map(|s| s.to_string()).unwrap_or_default(),
        );
        v.insert(
            "source_t_ms".into(),
            row.source_t_ms.map(decimal).unwrap_or_default(),
        );
    }
    v
}
fn decimal(n: f64) -> String {
    format!("{n:.3}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}
pub fn task(labels: &Labels) -> Template {
    let label_text = labels
        .keys()
        .map(|k| format!("{k}={{label.{k}}}"))
        .collect::<Vec<_>>()
        .join("  ");
    // A bounded compact UI; all labels remain in metadata, rather than silently
    // claiming every label will fit on a narrow video canvas.
    let label_text = if label_text.len() <= 280 {
        label_text
    } else {
        "task labels: see metadata".into()
    };
    Template {
        version: 1,
        layout: Layout::Strip,
        strip_height: Some(64),
        items: vec![TextItem {
            text: Text::Template(format!(
                "{label_text}\nrun={{run_id}}  phase={{phase}}\n{{marks}}"
            )),
            anchor: Anchor::TopLeft,
            x: 6,
            y: 3,
            font_size: 14,
            font_path: None,
            color: "#ffffff".into(),
            background: None,
            opacity: 1.0,
            interval: None,
            update_interval_ms: 100,
        }],
    }
}
pub fn validate(t: &Template, labels: &Labels, source: bool) -> Result<()> {
    anyhow::ensure!(
        t.version == 1 && t.items.len() <= MAX_TEMPLATE_ITEMS,
        "unsupported or oversized watermark template"
    );
    match t.layout {
        Layout::Strip => anyhow::ensure!(
            t.strip_height.is_some_and(|h| (16..=512).contains(&h)),
            "strip height must be 16..512"
        ),
        Layout::Overlay => {
            anyhow::ensure!(t.strip_height.is_none(), "overlay cannot have strip_height")
        }
    }
    let row = OutputFrame {
        schema_version: 1,
        export_id: String::new(),
        output_frame: 1,
        pts_ms: 0.0,
        duration_ms: 1.0,
        source_seq: source.then_some(1),
        source_t_ms: source.then_some(0.0),
        normalization_hold: source.then_some(false),
        phase: None,
        marks: vec![],
    };
    let v = values(labels, None, None, "", &row, source);
    for i in &t.items {
        let text = match &i.text {
            Text::Literal(s) | Text::Template(s) => s,
        };
        text_ok(text, true)?;
        if matches!(i.text, Text::Template(_)) {
            expand(text, &v)?;
        }
        anyhow::ensure!(
            (6..=128).contains(&i.font_size)
                && (-8192..=8192).contains(&i.x)
                && (-8192..=8192).contains(&i.y),
            "invalid font size/offset"
        );
        color(&i.color)?;
        if let Some(bg) = &i.background {
            color(bg)?;
        }
        anyhow::ensure!(
            i.opacity.is_finite()
                && (0.0..=1.0).contains(&i.opacity)
                && i.update_interval_ms <= 10000,
            "invalid opacity/update interval"
        );
        if let Some(interval) = &i.interval {
            anyhow::ensure!(
                interval.start_ms < interval.end_ms && interval.end_ms <= MAX_SAFE_INTEGER,
                "invalid text interval"
            );
        }
        if let Some(p) = &i.font_path {
            anyhow::ensure!(p.len() <= 4096 && !p.is_empty(), "invalid font path");
        }
    }
    Ok(())
}
pub struct Renderer {
    pub template: Template,
    fonts: Vec<std::sync::Arc<Font>>,
}
impl Renderer {
    pub fn new(mut template: Template, font_override: Option<&Path>) -> Result<Self> {
        let mut fonts = Vec::new();
        let mut cache = std::collections::BTreeMap::<PathBuf, std::sync::Arc<Font>>::new();
        let mut font_bytes = 0;
        for item in &mut template.items {
            let path = item.font_path.as_deref().map(PathBuf::from).or_else(||font_override.map(Path::to_path_buf)).or_else(default_font).context("no local font; supply --font PATH or font_path in template (CJK needs matching glyphs)")?;
            let path = path
                .canonicalize()
                .with_context(|| format!("cannot resolve font {}", path.display()))?;
            item.font_path = Some(path.to_str().context("font path must be UTF-8")?.into());
            let font = if let Some(font) = cache.get(&path) {
                font.clone()
            } else {
                let bytes = read_bounded(&path, 64 * 1024 * 1024)?;
                font_bytes += bytes.len();
                anyhow::ensure!(
                    font_bytes <= 64 * 1024 * 1024,
                    "template font files exceed 64 MiB total"
                );
                let font = std::sync::Arc::new(
                    Font::from_bytes(bytes, FontSettings::default()).map_err(|e| {
                        anyhow::anyhow!(
                            "font {}: {e}; provide a supported local TTF/OTF/TTC",
                            path.display()
                        )
                    })?,
                );
                cache.insert(path, font.clone());
                font
            };
            fonts.push(font);
        }
        Ok(Self { template, fonts })
    }
    pub fn check_text(&self, text: &str, item: usize) -> Result<()> {
        anyhow::ensure!(text.len() <= 4096, "expanded watermark exceeds 4096 bytes");
        for c in text.chars().filter(|c| *c != '\n') {
            if !c.is_whitespace() {
                anyhow::ensure!(self.fonts[item].lookup_glyph_index(c) != 0, "font lacks glyph U+{:04X} ({c}); supply --font/font_path with CJK or required glyph coverage", c as u32);
            }
            let m = self.fonts[item].metrics(c, self.template.items[item].font_size as f32);
            anyhow::ensure!(
                m.advance_width.is_finite()
                    && (0.0..=1024.0).contains(&m.advance_width)
                    && m.width <= 2048
                    && m.height <= 2048
                    && (-8192..=8192).contains(&m.xmin)
                    && (-8192..=8192).contains(&m.ymin),
                "font glyph metrics exceed bounded raster dimensions"
            );
        }
        Ok(())
    }
    pub fn paint(
        &self,
        image: &mut RgbImage,
        text: &str,
        item_index: usize,
        content_height: u32,
    ) -> Result<()> {
        self.check_text(text, item_index)?;
        let item = &self.template.items[item_index];
        let font = &self.fonts[item_index];
        let size = item.font_size as f32;
        let line_height = (size * 1.25).ceil() as i32;
        let width = text
            .split('\n')
            .map(|s| {
                s.chars()
                    .map(|c| font.metrics(c, size).advance_width)
                    .sum::<f32>()
                    .ceil() as i32
            })
            .max()
            .unwrap_or(0);
        let height = line_height * text.split('\n').count() as i32;
        let top = if self.template.layout == Layout::Strip {
            content_height as i32
        } else {
            0
        };
        let w = image.width() as i32;
        let h = image.height() as i32 - top;
        let (x, y) = match item.anchor {
            Anchor::TopLeft => (0, 0),
            Anchor::TopRight => (w - width, 0),
            Anchor::BottomLeft => (0, h - height),
            Anchor::BottomRight => (w - width, h - height),
            Anchor::Center => ((w - width) / 2, (h - height) / 2),
        };
        let (x, y) = (x + item.x, y + item.y + top);
        if let Some(bg) = &item.background {
            let bg = color(bg)?;
            for py in y.max(top)..(y + height).min(image.height() as i32) {
                for px in x.max(0)..(x + width).min(w) {
                    blend(image, px, py, bg, item.opacity);
                }
            }
        }
        let rgb = color(&item.color)?;
        for (line_index, line) in text.split('\n').enumerate() {
            let mut cursor = x as f32;
            for c in line.chars() {
                let m = font.metrics(c, size);
                let gx = cursor.floor() as i32 + m.xmin;
                let gy = y + line_index as i32 * line_height + item.font_size as i32
                    - m.height as i32
                    - m.ymin;
                cursor += m.advance_width;
                if gx >= w
                    || gx + m.width as i32 <= 0
                    || gy >= image.height() as i32
                    || gy + m.height as i32 <= top
                {
                    continue;
                }
                let (_, bitmap) = font.rasterize(c, size);
                for py in 0..m.height {
                    for px in 0..m.width {
                        let (dx, dy) = (gx + px as i32, gy + py as i32);
                        if dx >= 0 && dx < w && dy >= top && dy < image.height() as i32 {
                            blend(
                                image,
                                dx,
                                dy,
                                rgb,
                                item.opacity * bitmap[py * m.width + px] as f64 / 255.0,
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
fn blend(image: &mut RgbImage, x: i32, y: i32, rgb: [u8; 3], a: f64) {
    let old = image.get_pixel(x as u32, y as u32).0;
    image.put_pixel(
        x as u32,
        y as u32,
        Rgb(std::array::from_fn(|i| {
            (old[i] as f64 * (1.0 - a) + rgb[i] as f64 * a).round() as u8
        })),
    );
}
fn default_font() -> Option<PathBuf> {
    [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}
