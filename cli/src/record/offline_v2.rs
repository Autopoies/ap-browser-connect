//! Authenticate supplied v2 sidecars against media, exact source bytes and rows.
//! A failure is fatal; this never downgrades to unverified input.
use super::{
    export::{self, Probe},
    model, template,
    util::*,
};
use anyhow::{Context, Result};
use ap_browser_core::recording::{self as v1, v2};

pub fn verify(
    meta: &v2::ArtifactMetadata,
    data: &[u8],
    input: &v1::HashedFile,
    facts: &Probe,
) -> Result<(Option<v2::Manifest>, Vec<v1::OutputFrame>)> {
    meta.validate_source().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        !facts.audio && facts.exact_pts_ms(0)? == 0,
        "v2 input must have zero-origin video without audio"
    );
    anyhow::ensure!(
        meta.video == *input
            && meta.width == facts.width
            && meta.height == facts.height
            && meta.duration_ms == facts.exact_end_ms()? as f64,
        "sidecar/video hash, dimensions or exact duration mismatch"
    );
    anyhow::ensure!(
        meta.run_id.as_deref().is_none_or(v1::valid_id),
        "invalid sidecar run id"
    );
    anyhow::ensure!(
        meta.timeline.bytes == data.len() as u64 && meta.timeline.sha256 == digest(data),
        "sidecar timeline hash/size mismatch"
    );
    let manifest = if let (Some(raw), Some(hash)) =
        (&meta.source_manifest_json, &meta.source_manifest_sha256)
    {
        anyhow::ensure!(
            digest(raw.as_bytes()) == *hash,
            "source manifest hash mismatch"
        );
        let v2::SourceManifest::V2(m) =
            v2::parse_source_manifest(raw).map_err(anyhow::Error::msg)?
        else {
            anyhow::bail!("schema2 requires v2 source")
        };
        model::validate_v2(
            &m,
            &m.instance_id,
            meta.identity.as_ref().context("missing source identity")?,
            true,
        )?;
        Some(m)
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut v2rows = Vec::new();
    let mut previous = None;
    for line in std::str::from_utf8(data)?.lines() {
        let row: v2::OutputFrame = serde_json::from_str(line)?;
        let n = rows.len();
        let (pts, duration) = facts.frames.get(n).context("too many timeline rows")?;
        let next = if n + 1 < facts.frames.len() {
            facts.exact_pts_ms(n + 1)?
        } else {
            facts.exact_end_ms()?
        };
        let exact_duration = next - facts.exact_pts_ms(n)?;
        anyhow::ensure!(
            row.schema_version == 2
                && row.export_id == meta.export_id
                && row.output_frame == n as u64 + 1
                && row.pts_ms == facts.exact_pts_ms(n)? as f64
                && row.duration_ms == exact_duration as f64
                && (row.pts_ms - pts).abs() < 0.01
                && (row.duration_ms - duration).abs() < 0.01,
            "sidecar presentation mapping mismatch"
        );
        if let Some(phase) = &row.phase {
            template::text_ok(phase, true)?;
        }
        anyhow::ensure!(row.marks.len() <= v1::MAX_EVENTS, "marks bound");
        for mark in &row.marks {
            template::text_ok(mark, false)?;
        }
        if let Some(m) = &manifest {
            let s = row
                .source
                .as_ref()
                .context("source row missing reference")?;
            let f = m
                .frames
                .get(s.seq.checked_sub(1).context("zero source seq")? as usize)
                .context("unknown seq")?;
            anyhow::ensure!(
                *s == model::reference(f)
                    && row.normalization_hold == Some(previous == Some(s.seq))
                    && previous.is_none_or(|last| s.seq >= last),
                "source reference/hold mismatch"
            );
            // Ordinary normalization, including the explicit initial hold. No
            // future observations may be relabelled as already visible.
            let expected = m
                .frames
                .partition_point(|f| f.t_ms <= row.pts_ms)
                .saturating_sub(1);
            anyhow::ensure!(
                if meta.provenance == v1::Provenance::Recording {
                    s.seq == m.frames[expected].seq
                } else {
                    f.t_ms <= row.pts_ms || (s.seq == 1 && row.pts_ms < m.frames[0].t_ms)
                },
                "source observation is in the future/not latest recorded source"
            );
            let mut context = export::empty_row(
                &meta.export_id,
                row.pts_ms,
                row.duration_ms,
                row.output_frame,
            );
            model::apply_events(&mut context, m, row.pts_ms);
            anyhow::ensure!(
                row.phase.as_deref().unwrap_or("") == context.phase.as_deref().unwrap_or("")
                    && row.marks == context.marks,
                "event history mismatch"
            );
            previous = Some(s.seq);
        } else {
            anyhow::ensure!(
                row.source.is_none()
                    && row.normalization_hold.is_none()
                    && row.phase.is_none()
                    && row.marks.is_empty()
                    && !row.final_observation_visibility,
                "invented unverified source facts"
            );
        }
        rows.push(model::legacy_context(&row));
        v2rows.push(row);
    }
    anyhow::ensure!(
        rows.len() == facts.frames.len(),
        "timeline frame count mismatch"
    );
    if let Some(m) = &manifest {
        let final_frame = m
            .frames
            .last()
            .filter(|f| f.observation.purpose == v2::Purpose::Final);
        let special = v2rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.final_observation_visibility)
            .collect::<Vec<_>>();
        anyhow::ensure!(special.len() <= 1, "duplicate visibility append");
        if let Some((n, row)) = special.first().copied() {
            let f = final_frame.context("visibility append without stored final")?;
            let q = if meta.settings.format == v1::Format::Gif {
                10.0
            } else {
                1.0
            };
            anyhow::ensure!(
                n + 1 == rows.len()
                    && !v2rows[..n]
                        .iter()
                        .any(|r| r.source.as_ref().is_some_and(|s| s.seq == f.seq)),
                "unnecessary or nonfinal append"
            );
            v2::validate_final_visibility(
                row,
                f,
                m.end.duration_ms,
                q,
                facts.exact_end_ms()? as f64,
            )
            .map_err(anyhow::Error::msg)?;
        } else {
            let q = if meta.settings.format == v1::Format::Gif {
                10.0
            } else {
                1.0
            };
            let expected_end = if final_frame.is_some() {
                (m.end.duration_ms / q).round().max(1.0) * q
            } else {
                (m.end.duration_ms / q).floor() * q
            };
            anyhow::ensure!(
                facts.exact_end_ms()? as f64 == expected_end,
                "ordinary output truncates or exceeds source end quantization"
            );
        }
        if let Some(f) = final_frame {
            anyhow::ensure!(
                v2rows
                    .iter()
                    .any(|r| r.source.as_ref().is_some_and(|s| s.seq == f.seq)),
                "stored final is not presented"
            );
        }
    }
    Ok((manifest, rows))
}
