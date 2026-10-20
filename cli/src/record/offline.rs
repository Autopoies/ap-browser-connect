use super::{
    args::ExportArgs,
    export::{self, FrameData, Plan, Source, SourceFrame},
    template,
    util::*,
    validate,
};
use anyhow::{Context, Result};
use ap_browser_core::recording::{v2, *};
use std::{fs, path::Path, time::Duration};

pub fn run(
    input: &Path,
    sidecar: Option<&Path>,
    timeline: Option<&Path>,
    args: &ExportArgs,
) -> Result<serde_json::Value> {
    anyhow::ensure!(
        matches!(
            input
                .extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("gif" | "mp4" | "mov")
        ),
        "offline input must be GIF, MP4 or MOV"
    );
    let demuxer = if input
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("gif"))
    {
        "gif"
    } else {
        "mov"
    };
    // Reject absent out/collisions before expensive decode, and never alter input.
    let output = Output::new(
        args.out.as_deref(),
        args.metadata
            || args.watermark_config.is_some()
            || !matches!(args.watermark.as_str(), "none" | ""),
        Some(input),
    )?;
    let input_path = input.canonicalize()?;
    preflight()?;
    let clean_input = output.temp.0.join("input.clean");
    let input_hash = copy_snapshot(&input_path, &clean_input)?;
    let input = clean_input.as_path(); // Owned absolute path: arbitrary input names stay data.
                                       // Force the declared container, rather than autoprobing playlists/devices
                                       // disguised with a video extension. No network protocols or MOV data refs.
    let facts = export::probe_demuxer(input, Some(demuxer))?;
    anyhow::ensure!(
        facts.duration_ms <= 60020.0,
        "offline input exceeds bounded source plus final visibility"
    );
    let mut snapshot = None;
    let mut manifest = None;
    let mut snapshot_v2 = None;
    let mut original = None;
    let mut parent_export_id = None;
    let mut labels = Labels::new();
    let mut run_id = None;
    if let Some(sidecar) = sidecar {
        let raw = read_bounded(sidecar, MAX_METADATA_BYTES)?;
        let parsed =
            v2::parse_artifact_metadata(std::str::from_utf8(&raw)?).map_err(anyhow::Error::msg)?;
        if let v2::SourceArtifact::V2(meta) = parsed {
            let derived = sidecar.with_file_name(format!(
                "{}.timeline.jsonl",
                input_path
                    .file_stem()
                    .context("input filename")?
                    .to_string_lossy()
            ));
            let data = read_bounded(timeline.unwrap_or(&derived), MAX_TIMELINE_BYTES)?;
            let (m, rows) = super::offline_v2::verify(&meta, &data, &input_hash, &facts)?;
            labels = meta.labels;
            run_id = meta.run_id;
            parent_export_id = Some(meta.export_id);
            snapshot = meta.source_manifest_json;
            snapshot_v2 = m;
            original = Some(rows);
        } else {
            let v2::SourceArtifact::Legacy(meta) = parsed else {
                unreachable!()
            };
            anyhow::ensure!(
                meta.schema_version == 1
                    && valid_id(&meta.export_id)
                    && meta.video == input_hash
                    && meta.width == facts.width
                    && meta.height == facts.height
                    && meta.duration_ms.is_finite()
                    && (meta.duration_ms - facts.duration_ms).abs() < 1.1,
                "sidecar/video identity, hash, dimensions or duration mismatch"
            );
            validate_labels(&meta.labels).map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                meta.run_id.as_deref().is_none_or(valid_id),
                "invalid sidecar run_id"
            );
            let derived = sidecar.with_file_name(format!(
                "{}.timeline.jsonl",
                input_path
                    .file_stem()
                    .context("input filename")?
                    .to_string_lossy()
            ));
            let data = read_bounded(timeline.unwrap_or(&derived), MAX_TIMELINE_BYTES)?;
            anyhow::ensure!(
                meta.timeline.bytes == data.len() as u64 && meta.timeline.sha256 == digest(&data),
                "sidecar timeline hash/size mismatch"
            );
            let lines = std::str::from_utf8(&data)?;
            let mut rows = Vec::new();
            for line in lines.lines() {
                let value: serde_json::Value = serde_json::from_str(line)?;
                anyhow::ensure!(
                    [
                        "source",
                        "final_observation_visibility",
                        "observation",
                        "backend",
                        "request_id",
                        "request_started_ms",
                        "response_received_ms",
                        "geometry_validated_ms"
                    ]
                    .iter()
                    .all(|key| value.get(key).is_none()),
                    "contradictory legacy timeline row"
                );
                let row: OutputFrame = serde_json::from_value(value)?;
                let n = rows.len();
                let (pts, duration) = facts
                    .frames
                    .get(n)
                    .context("timeline has too many frames")?;
                anyhow::ensure!(
                    row.schema_version == 1
                        && row.export_id == meta.export_id
                        && row.output_frame == n as u64 + 1
                        && row.pts_ms.is_finite()
                        && row.duration_ms.is_finite()
                        && (row.pts_ms - pts).abs() < 0.01
                        && (row.duration_ms - duration).abs() < 0.01,
                    "sidecar presentation mapping mismatch"
                );
                if let Some(p) = &row.phase {
                    template::text_ok(p, true)?;
                }
                anyhow::ensure!(row.marks.len() <= MAX_EVENTS, "sidecar marks limit");
                for m in &row.marks {
                    template::text_ok(m, false)?;
                }
                rows.push(row);
            }
            anyhow::ensure!(
                rows.len() == facts.frames.len(),
                "sidecar frame count mismatch"
            );
            match (&meta.source_manifest_json, &meta.source_manifest_sha256) {
                (Some(s), Some(hash)) => {
                    anyhow::ensure!(
                        s.len() <= MAX_MANIFEST_BYTES && digest(s.as_bytes()) == *hash,
                        "sidecar source snapshot hash/size mismatch"
                    );
                    let v2::SourceManifest::Legacy(m) =
                        v2::parse_source_manifest(s).map_err(anyhow::Error::msg)?
                    else {
                        anyhow::bail!("schema1 requires legacy source")
                    };
                    validate::manifest(&m, &m.instance_id, &m.identity, true)?;
                    anyhow::ensure!(
                        meta.provenance != Provenance::OfflineUnverified
                            && meta.identity.as_ref() == Some(&m.identity),
                        "sidecar source identity/provenance mismatch"
                    );
                    let mut previous = None;
                    for row in &rows {
                        let seq = row.source_seq.context("verified source row lacks seq")?;
                        let f = m
                            .frames
                            .get(seq.checked_sub(1).context("zero source seq")? as usize)
                            .context("unknown source seq")?;
                        anyhow::ensure!(
                            row.source_t_ms == Some(f.t_ms)
                                && row.normalization_hold == Some(previous == Some(seq))
                                && previous.is_none_or(|last| seq >= last),
                            "sidecar source mapping mismatch"
                        );
                        previous = Some(seq);
                    }
                    let partial = m.state != State::Sealed
                        || !m.end.duration_observed
                        || !matches!(m.end.reason, EndReason::Stopped | EndReason::Deadline);
                    anyhow::ensure!(
                        meta.partial == partial && meta.end_reason == Some(m.end.reason),
                        "sidecar end/partial provenance mismatch"
                    );
                    for row in &rows {
                        let mut expected = export::empty_row(
                            &meta.export_id,
                            row.pts_ms,
                            row.duration_ms,
                            row.output_frame,
                        );
                        export::apply_events(&mut expected, &m, row.pts_ms);
                        anyhow::ensure!(
                            row.phase.as_deref().unwrap_or("")
                                == expected.phase.as_deref().unwrap_or("")
                                && row.marks == expected.marks,
                            "sidecar event history mismatch"
                        );
                    }
                    manifest = Some(m);
                    snapshot = Some(s.clone());
                }
                (None, None) => {
                    anyhow::ensure!(
                        meta.identity.is_none()
                            && meta.provenance != Provenance::Recording
                            && rows.iter().all(|r| r.source_seq.is_none()
                                && r.source_t_ms.is_none()
                                && r.normalization_hold.is_none()
                                && r.phase.is_none()
                                && r.marks.is_empty()),
                        "sidecar invents source facts without a source manifest"
                    );
                }
                _ => anyhow::bail!("sidecar source snapshot/hash pair incomplete"),
            }
            labels = meta.labels;
            run_id = meta.run_id;
            parent_export_id = Some(meta.export_id);
            original = Some(rows);
        }
    }
    if snapshot_v2.is_none() {
        anyhow::ensure!(
            facts.duration_ms <= 60000.0,
            "legacy/unverified input exceeds 60s"
        );
    }
    let plan = Plan::new(
        args,
        labels,
        run_id,
        manifest.is_some() || snapshot_v2.is_some(),
    )?;
    let ratio = (plan.settings.max_edge as f64 / facts.width.max(facts.height) as f64).min(1.0);
    let width = (facts.width as f64 * ratio).round().max(1.0) as u32;
    let height = (facts.height as f64 * ratio).round().max(1.0) as u32;
    let frame_bytes = width as u64 * height as u64 * 3;
    let required = frame_bytes
        .checked_mul(facts.frames.len() as u64)
        .context("decode size overflow")?;
    anyhow::ensure!(
        required <= SCRATCH_CAP,
        "offline decode exceeds bounded 512 MiB scratch budget; use a smaller --size"
    );
    let raw = output.temp.0.join("input.rgb");
    let mut decode = ffmpeg();
    decode.args([
        "-protocol_whitelist",
        "file",
        "-threads",
        "1",
        "-f",
        demuxer,
    ]);
    if demuxer == "mov" {
        decode.args(["-enable_drefs", "0"]);
    }
    process(
        decode
            .arg("-i")
            .arg(input)
            .args(["-map", "0:v:0", "-an", "-vf"])
            .arg(format!("scale={width}:{height}:flags=lanczos"))
            .args(["-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-frames:v"])
            .arg(facts.frames.len().to_string())
            .args(["-fs"])
            .arg((required + 1).to_string())
            .args(["-threads", "1", "-f", "rawvideo", "-n"])
            .arg(&raw),
        Duration::from_secs(120),
        65536,
    )?;
    anyhow::ensure!(
        fs::metadata(&raw)?.len() == required,
        "decoded video frame count mismatch"
    );
    let frames = facts
        .frames
        .iter()
        .enumerate()
        .map(|(n, (t, _))| SourceFrame {
            t_ms: *t,
            data: FrameData::Rgb {
                path: raw.clone(),
                offset: n as u64 * frame_bytes,
                width,
                height,
            },
            original: original.as_ref().map(|rows| rows[n].clone()),
        })
        .collect();
    let source = Source {
        frames,
        duration_ms: facts.duration_ms,
        manifest,
        snapshot_v2,
        snapshot,
        provenance: if sidecar.is_some() {
            Provenance::OfflineVerifiedSidecar
        } else {
            Provenance::OfflineUnverified
        },
        input_video: Some(input_hash),
        parent_export_id,
    };
    export::encode(&source, &plan, &output)
}
