use super::template::text_ok;
use anyhow::{Context, Result};
use ap_browser_core::recording::*;

pub fn identity(i: &Identity) -> Result<()> {
    anyhow::ensure!(
        valid_id(&i.host_epoch) && valid_id(&i.record_id),
        "invalid recording identity"
    );
    Ok(())
}
fn rect(r: &Rect) -> Result<()> {
    anyhow::ensure!(
        [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
            && r.x >= 0.0
            && r.y >= 0.0
            && r.width > 0.0
            && r.height > 0.0,
        "invalid CSS rectangle"
    );
    Ok(())
}
pub fn crop(f: &FrameEntry) -> Result<(u32, u32, u32, u32)> {
    let g = &f.geometry;
    rect(&g.viewport_css)?;
    rect(&g.crop_css)?;
    let m = &g.css_to_image;
    anyhow::ensure!(
        g.viewport_css.x == 0.0
            && g.viewport_css.y == 0.0
            && g.crop_css.x + g.crop_css.width <= g.viewport_css.width
            && g.crop_css.y + g.crop_css.height <= g.viewport_css.height,
        "crop outside viewport"
    );
    anyhow::ensure!(
        [
            m.scale_x,
            m.scale_y,
            m.offset_x,
            m.offset_y,
            g.device_scale_factor,
            g.page_scale_factor,
            g.scroll_x,
            g.scroll_y
        ]
        .iter()
        .all(|n| n.is_finite())
            && m.scale_x > 0.0
            && m.scale_y > 0.0
            && g.device_scale_factor > 0.0
            && g.page_scale_factor > 0.0,
        "invalid CSS-image mapping"
    );
    let x = g.crop_css.x * m.scale_x + m.offset_x;
    let y = g.crop_css.y * m.scale_y + m.offset_y;
    let right = (g.crop_css.x + g.crop_css.width) * m.scale_x + m.offset_x;
    let bottom = (g.crop_css.y + g.crop_css.height) * m.scale_y + m.offset_y;
    anyhow::ensure!(
        x >= 0.0 && y >= 0.0 && right <= f.width as f64 && bottom <= f.height as f64,
        "crop outside actual JPEG"
    );
    let (x, y, r, b) = (
        x.ceil() as u32,
        y.ceil() as u32,
        right.floor() as u32,
        bottom.floor() as u32,
    );
    anyhow::ensure!(r > x && b > y, "empty inward-rounded crop");
    Ok((x, y, r - x, b - y))
}
pub fn manifest(m: &Manifest, instance: &str, expected: &Identity, partial: bool) -> Result<()> {
    identity(&m.identity)?;
    anyhow::ensure!(
        m.protocol_version == 1
            && &m.identity == expected
            && m.instance_id == instance
            && valid_id(&m.instance_id)
            && valid_id(&m.operation_id),
        "manifest identity/version mismatch"
    );
    anyhow::ensure!(
        matches!(m.state, State::Sealed | State::Failed),
        "manifest is not terminal"
    );
    let complete = m.state == State::Sealed
        && matches!(m.end.reason, EndReason::Stopped | EndReason::Deadline)
        && m.end.duration_observed;
    anyhow::ensure!(
        complete || partial,
        "interrupted recording requires explicit --partial"
    );
    anyhow::ensure!(
        !m.frames.is_empty()
            && m.frames.len() <= MAX_FRAMES
            && m.end.final_seq == m.frames.len() as u64,
        "empty or invalid frame sequence"
    );
    anyhow::ensure!(
        (1..=MAX_DURATION_MS).contains(&m.config.max_duration_ms)
            && (1..=30).contains(&m.config.capture_fps)
            && (1..=100).contains(&m.config.jpeg_quality),
        "invalid capture settings"
    );
    validate_labels(&m.config.labels).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        m.config.run_id.as_deref().is_none_or(valid_id),
        "invalid run_id"
    );
    anyhow::ensure!(
        m.end.duration_ms.is_finite()
            && m.end.duration_ms > 0.0
            && m.end.duration_ms <= m.config.max_duration_ms as f64
            && m.spool_bytes <= MAX_SPOOL_BYTES
            && valid_sha256(&m.spool_sha256),
        "invalid duration/spool bounds"
    );
    anyhow::ensure!(
        m.clock.source == "extension_performance"
            && m.clock.origin == "before_start_screencast"
            && m.clock
                .uncertainty_ms
                .is_none_or(|n| n.is_finite() && n >= 0.0),
        "invalid recording clock"
    );
    anyhow::ensure!(
        [
            m.end.drops.sampled,
            m.end.drops.backpressured,
            m.end.drops.invalid
        ]
        .iter()
        .all(|n| *n <= MAX_SAFE_INTEGER),
        "invalid drop counts"
    );
    let first = &m.frames[0];
    match &m.config.region {
        Region::Viewport => anyhow::ensure!(
            m.resolved_region_css == first.geometry.viewport_css,
            "viewport crop mismatch"
        ),
        Region::Rect { rect } => anyhow::ensure!(
            *rect == m.resolved_region_css,
            "requested rectangle differs from resolved crop"
        ),
        Region::Element { selector } => anyhow::ensure!(
            !selector.is_empty() && selector.len() <= 1024,
            "invalid element selector"
        ),
    }
    let mut offset = 0u64;
    let mut last = 0.0;
    for (i, f) in m.frames.iter().enumerate() {
        anyhow::ensure!(
            f.seq == i as u64 + 1
                && f.offset == offset
                && (1..=MAX_FRAME_BYTES).contains(&f.length)
                && valid_sha256(&f.sha256),
            "invalid frame index/hash"
        );
        offset = offset
            .checked_add(f.length)
            .context("spool offset overflow")?;
        anyhow::ensure!(
            f.t_ms.is_finite()
                && f.t_ms >= last
                && f.t_ms <= m.end.duration_ms
                && f.cdp_timestamp_s.is_none_or(f64::is_finite),
            "invalid frame timestamp"
        );
        last = f.t_ms;
        anyhow::ensure!(
            (1..=16384).contains(&f.width)
                && (1..=16384).contains(&f.height)
                && f.width as u64 * f.height as u64 <= 64_000_000,
            "invalid JPEG geometry"
        );
        crop(f)?;
        anyhow::ensure!(
            f.width == first.width
                && f.height == first.height
                && f.geometry.viewport_css == first.geometry.viewport_css
                && f.geometry.crop_css == first.geometry.crop_css
                && f.geometry.css_to_image == first.geometry.css_to_image
                && f.geometry.device_scale_factor == first.geometry.device_scale_factor
                && f.geometry.page_scale_factor == first.geometry.page_scale_factor
                && f.geometry.crop_css == m.resolved_region_css,
            "recording geometry changed"
        );
    }
    anyhow::ensure!(
        offset == m.spool_bytes && m.events.len() <= MAX_EVENTS,
        "spool/event total mismatch"
    );
    let mut last = 0.0;
    let mut operations = std::collections::BTreeSet::new();
    for (i, e) in m.events.iter().enumerate() {
        anyhow::ensure!(
            e.event_index == i as u64 + 1
                && valid_id(&e.operation_id)
                && operations.insert(&e.operation_id)
                && e.t_ms.is_finite()
                && e.t_ms >= last
                && e.t_ms <= m.config.max_duration_ms as f64,
            "invalid event sequence/time"
        );
        last = e.t_ms;
        match &e.kind {
            EventKind::Phase { text } => text_ok(text, true)?,
            EventKind::Mark { text, duration_ms } => {
                text_ok(text, false)?;
                anyhow::ensure!((1..=10000).contains(duration_ms), "invalid mark duration");
            }
        }
        if m.end.duration_observed {
            anyhow::ensure!(e.t_ms <= m.end.duration_ms, "event after observed end");
        }
    }
    Ok(())
}
