//! Explicitly discriminated, validated source provenance. Render rows are internal
//! legacy-shaped text contexts only; v2 wire artifacts are never serialized from them.
use super::{export, validate};
use anyhow::{Context, Result};
use ap_browser_core::recording::{self as v1, v2};

pub enum ValidatedSource {
    Legacy(v1::Manifest),
    Snapshot(v2::Manifest),
}
impl ValidatedSource {
    pub fn parse(
        raw: &str,
        instance: &str,
        identity: &v1::Identity,
        partial: bool,
    ) -> Result<Self> {
        match v2::parse_source_manifest(raw).map_err(anyhow::Error::msg)? {
            v2::SourceManifest::Legacy(m) => {
                validate::manifest(&m, instance, identity, partial)?;
                Ok(Self::Legacy(m))
            }
            v2::SourceManifest::V2(m) => {
                validate_v2(&m, instance, identity, partial)?;
                Ok(Self::Snapshot(m))
            }
        }
    }
}
pub fn validate_v2(
    m: &v2::Manifest,
    instance: &str,
    identity: &v1::Identity,
    partial: bool,
) -> Result<()> {
    m.validate().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        &m.identity == identity && m.instance_id == instance,
        "manifest identity mismatch"
    );
    anyhow::ensure!(
        m.state == v1::State::Sealed || partial,
        "interrupted recording requires explicit --partial"
    );
    anyhow::ensure!(
        !m.frames.is_empty() && m.end.duration_ms > 0.0,
        "no frames to export"
    );
    match &m.config.region {
        v1::Region::Viewport => anyhow::ensure!(
            m.resolved_region_css == m.frames[0].geometry.viewport_css,
            "viewport crop mismatch"
        ),
        v1::Region::Rect { rect } => {
            anyhow::ensure!(*rect == m.resolved_region_css, "requested crop mismatch")
        }
        _ => (),
    }
    for f in &m.frames {
        crop(f)?;
    }
    Ok(())
}
pub fn crop(f: &v2::FrameEntry) -> Result<(u32, u32, u32, u32)> {
    f.geometry
        .validate(f.width, f.height)
        .map_err(anyhow::Error::msg)?;
    let g = &f.geometry;
    let x = (g.crop_css.x * g.css_to_image.scale_x).ceil() as u32;
    let y = (g.crop_css.y * g.css_to_image.scale_y).ceil() as u32;
    let r = ((g.crop_css.x + g.crop_css.width) * g.css_to_image.scale_x).floor() as u32;
    let b = ((g.crop_css.y + g.crop_css.height) * g.css_to_image.scale_y).floor() as u32;
    anyhow::ensure!(
        r > x && b > y && r <= f.width && b <= f.height,
        "empty/outside crop"
    );
    Ok((x, y, r - x, b - y))
}
pub fn reference(f: &v2::FrameEntry) -> v2::SourceReference {
    v2::SourceReference {
        seq: f.seq,
        t_ms: f.t_ms,
        observation: f.observation.clone(),
    }
}
pub fn row_v2(
    row: &v1::OutputFrame,
    manifest: Option<&v2::Manifest>,
    final_visibility: bool,
) -> Result<v2::OutputFrame> {
    let source = match (manifest, row.source_seq) {
        (Some(m), Some(seq)) => Some(reference(
            m.frames
                .get(seq.checked_sub(1).context("zero seq")? as usize)
                .context("unknown source seq")?,
        )),
        (None, None) => None,
        _ => anyhow::bail!("unpaired source row"),
    };
    Ok(v2::OutputFrame {
        schema_version: 2,
        export_id: row.export_id.clone(),
        output_frame: row.output_frame,
        pts_ms: row.pts_ms,
        duration_ms: row.duration_ms,
        source,
        normalization_hold: row.normalization_hold,
        final_observation_visibility: final_visibility,
        phase: row.phase.clone(),
        marks: row.marks.clone(),
    })
}
pub fn apply_events(row: &mut v1::OutputFrame, m: &v2::Manifest, pts: f64) {
    row.phase = None;
    row.marks.clear();
    for e in &m.events {
        if e.t_ms > pts || e.t_ms > m.end.duration_ms {
            continue;
        }
        match &e.kind {
            v1::EventKind::Phase { text } => row.phase = (!text.is_empty()).then(|| text.clone()),
            v1::EventKind::Mark { text, duration_ms } if pts < e.t_ms + *duration_ms as f64 => {
                row.marks.push(text.clone())
            }
            _ => (),
        }
    }
}
pub fn legacy_context(r: &v2::OutputFrame) -> v1::OutputFrame {
    let mut row = export::empty_row(&r.export_id, r.pts_ms, r.duration_ms, r.output_frame);
    row.source_seq = r.source.as_ref().map(|s| s.seq);
    row.source_t_ms = r.source.as_ref().map(|s| s.t_ms);
    row.normalization_hold = r.normalization_hold;
    row.phase = r.phase.clone();
    row.marks = r.marks.clone();
    row
}
