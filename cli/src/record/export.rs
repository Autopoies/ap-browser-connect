use super::model;
use super::{
    args::ExportArgs,
    template::{self, Renderer},
    util::*,
    validate,
};
use anyhow::{bail, Context, Result};
use ap_browser_core::recording::{v2, *};
use image::{imageops, ImageReader, RgbImage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Plan {
    pub settings: ExportSettings,
    pub labels: Labels,
    pub run_id: Option<String>,
    pub renderer: Option<Renderer>,
}
impl Plan {
    pub fn new(
        args: &ExportArgs,
        base_labels: Labels,
        base_run: Option<String>,
        source: bool,
    ) -> Result<Self> {
        let (fps, edge, crf, colors) = match args.preset.as_str() {
            "tiny" => (4, 480, 34, 32),
            "compact" => (8, 720, 30, 64),
            "balanced" | "" => (15, 1280, 25, 128),
            "high" => (30, 1920, 20, 256),
            _ => bail!("preset must be tiny, compact, balanced or high"),
        };
        let format = match args
            .out
            .as_deref()
            .and_then(Path::extension)
            .and_then(|s| s.to_str())
            .unwrap_or(if args.out.is_some() { "" } else { "mp4" })
            .to_ascii_lowercase()
            .as_str()
        {
            "gif" => Format::Gif,
            "mp4" => Format::Mp4,
            "mov" => Format::Mov,
            _ => bail!("--out extension must be .gif, .mp4 or .mov"),
        };
        let mut labels = base_labels;
        for s in &args.labels {
            let (k, v) = s.split_once('=').context("--label requires key=value")?;
            labels.insert(k.into(), v.into());
        }
        validate_labels(&labels).map_err(anyhow::Error::msg)?;
        let run_id = args.run_id.clone().or(base_run);
        anyhow::ensure!(run_id.as_deref().is_none_or(valid_id), "invalid run_id");
        let mut watermark = if let Some(path) = &args.watermark_config {
            Watermark::Custom {
                template: serde_json::from_slice(&read_bounded(path, MAX_TEMPLATE_BYTES)?)?,
            }
        } else {
            match args.watermark.as_str() {
                "none" | "" => Watermark::None,
                "task" => Watermark::Task {
                    template: template::task(&labels),
                },
                "debug" => Watermark::Debug {
                    template: template::task(&labels),
                },
                _ => bail!("watermark must be none, task or debug (or --watermark-config)"),
            }
        };
        let renderer = match &mut watermark {
            Watermark::None => None,
            Watermark::Task { template: t }
            | Watermark::Debug { template: t }
            | Watermark::Custom { template: t } => {
                if let Some(p) = &args.font {
                    for item in &mut t.items {
                        if item.font_path.is_none() {
                            item.font_path =
                                Some(p.to_str().context("font path must be UTF-8")?.into());
                        }
                    }
                }
                template::validate(t, &labels, source)?;
                let renderer = Renderer::new(t.clone(), None)?;
                *t = renderer.template.clone();
                Some(renderer)
            }
        };
        let settings = ExportSettings {
            format,
            fps: args.fps.unwrap_or(fps),
            max_edge: args.size.unwrap_or(edge),
            crf: args.crf.unwrap_or(crf),
            colors: args.colors.unwrap_or(colors),
            upscale: false,
            watermark,
        };
        anyhow::ensure!(
            (1..=30).contains(&settings.fps)
                && (16..=3840).contains(&settings.max_edge)
                && settings.crf <= 51
                && (2..=256).contains(&settings.colors),
            "invalid fps/size/CRF/colors override"
        );
        let plan = Self {
            settings,
            labels,
            run_id,
            renderer,
        };
        if let Some(r) = &plan.renderer {
            let row = empty_row("", 0.0, 1.0, 1);
            let v = template::values(&plan.labels, plan.run_id.as_deref(), None, "", &row, source);
            for (i, item) in r.template.items.iter().enumerate() {
                let s = match &item.text {
                    Text::Literal(s) => s.clone(),
                    Text::Template(s) => template::expand(s, &v)?,
                };
                r.check_text(&s, i)?;
            }
        }
        Ok(plan)
    }
    pub fn sidecars(&self, args: &ExportArgs) -> bool {
        args.metadata || self.renderer.is_some()
    }
}
pub enum FrameData {
    Jpeg(PathBuf),
    Rgb {
        path: PathBuf,
        offset: u64,
        width: u32,
        height: u32,
    },
}
pub struct SourceFrame {
    pub t_ms: f64,
    pub data: FrameData,
    pub original: Option<OutputFrame>,
}
pub struct Source {
    pub frames: Vec<SourceFrame>,
    pub duration_ms: f64,
    pub manifest: Option<Manifest>,
    pub snapshot_v2: Option<v2::Manifest>,
    pub snapshot: Option<String>,
    pub provenance: Provenance,
    pub input_video: Option<HashedFile>,
    pub parent_export_id: Option<String>,
}
impl Source {
    fn image(&self, index: usize) -> Result<RgbImage> {
        let f = &self.frames[index];
        match &f.data {
            FrameData::Jpeg(path) => {
                let mut reader = ImageReader::open(path)?.with_guessed_format()?;
                if self.manifest.is_some() || self.snapshot_v2.is_some() {
                    reader.set_format(image::ImageFormat::Jpeg);
                }
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(16384);
                limits.max_image_height = Some(16384);
                limits.max_alloc = Some(256 * 1024 * 1024);
                reader.limits(limits);
                let image = reader.decode()?.to_rgb8();
                if let Some(m) = &self.manifest {
                    let entry = &m.frames[index];
                    anyhow::ensure!(
                        image.width() == entry.width && image.height() == entry.height,
                        "decoded JPEG dimensions mismatch"
                    );
                    let (x, y, w, h) = validate::crop(entry)?;
                    Ok(imageops::crop_imm(&image, x, y, w, h).to_image())
                } else if let Some(m) = &self.snapshot_v2 {
                    let entry = &m.frames[index];
                    anyhow::ensure!(
                        (image.width(), image.height()) == (entry.width, entry.height),
                        "decoded JPEG dimensions mismatch"
                    );
                    let (x, y, w, h) = model::crop(entry)?;
                    Ok(imageops::crop_imm(&image, x, y, w, h).to_image())
                } else {
                    Ok(image)
                }
            }
            FrameData::Rgb {
                path,
                offset,
                width,
                height,
            } => {
                let mut f = fs::File::open(path)?;
                f.seek(SeekFrom::Start(*offset))?;
                let mut bytes = vec![0; *width as usize * *height as usize * 3];
                f.read_exact(&mut bytes)?;
                RgbImage::from_raw(*width, *height, bytes).context("invalid raw frame")
            }
        }
    }
    pub fn row(
        &self,
        id: &str,
        pts: f64,
        duration: f64,
        number: u64,
        previous: Option<u64>,
    ) -> OutputFrame {
        let index = self
            .frames
            .partition_point(|f| f.t_ms <= pts)
            .saturating_sub(1);
        let mut row = empty_row(id, pts, duration, number);
        if self.provenance == Provenance::Recording {
            if let Some(m) = &self.manifest {
                row.source_seq = Some(m.frames[index].seq);
                row.source_t_ms = Some(m.frames[index].t_ms);
                row.normalization_hold = Some(row.source_seq == previous);
                apply_events(&mut row, m, pts);
            }
        } else if let Some(original) = &self.frames[index].original {
            row.source_seq = original.source_seq;
            row.source_t_ms = original.source_t_ms;
            row.normalization_hold = original.source_seq.map(|s| Some(s) == previous);
            row.phase = original.phase.clone();
            row.marks = original.marks.clone();
            if let Some(m) = &self.manifest {
                apply_events(&mut row, m, pts);
            }
        }
        if let Some(m) = &self.snapshot_v2 {
            if self.provenance == Provenance::Recording {
                row.source_seq = Some(m.frames[index].seq);
                row.source_t_ms = Some(m.frames[index].t_ms);
                row.normalization_hold = Some(row.source_seq == previous);
            }
            model::apply_events(&mut row, m, pts);
        }
        row
    }
}
pub(super) fn apply_events(row: &mut OutputFrame, m: &Manifest, pts: f64) {
    row.phase = None;
    row.marks.clear();
    for event in &m.events {
        if event.t_ms > pts || event.t_ms > m.end.duration_ms {
            continue;
        }
        match &event.kind {
            EventKind::Phase { text } => row.phase = (!text.is_empty()).then(|| text.clone()),
            EventKind::Mark { text, duration_ms } if pts < event.t_ms + *duration_ms as f64 => {
                row.marks.push(text.clone())
            }
            _ => (),
        }
    }
}
pub fn empty_row(id: &str, pts: f64, duration: f64, n: u64) -> OutputFrame {
    OutputFrame {
        schema_version: 1,
        export_id: id.into(),
        output_frame: n,
        pts_ms: pts,
        duration_ms: duration,
        source_seq: None,
        source_t_ms: None,
        normalization_hold: None,
        phase: None,
        marks: vec![],
    }
}
pub fn schedule(duration_ms: f64, fps: u32, gif: bool) -> Result<Vec<(f64, f64)>> {
    anyhow::ensure!(
        duration_ms.is_finite()
            && duration_ms > 0.0
            && duration_ms <= 60000.0
            && (1..=30).contains(&fps),
        "invalid export duration/fps"
    );
    let quantum = if gif { 10.0 } else { 1.0 };
    let end = (duration_ms / quantum).round().max(1.0) * quantum;
    let mut points = vec![0.0];
    let mut n = 1;
    loop {
        let t = (n as f64 * 1000.0 / fps as f64 / quantum).round() * quantum;
        if t >= end {
            break;
        }
        if t > *points.last().unwrap() {
            points.push(t);
        }
        n += 1;
    }
    // A final quantum sample gives image2/vfr an explicit last duration; this
    // is a normalization hold, NOT an additional source observation.
    if end - quantum > *points.last().unwrap() {
        points.push(end - quantum);
    }
    let mut result = Vec::new();
    for (i, t) in points.iter().enumerate() {
        result.push((*t, points.get(i + 1).copied().unwrap_or(end) - t));
    }
    Ok(result)
}

pub(super) fn text_clock(samples: &[(f64, f64)], pts: f64, interval: u32) -> (f64, u64) {
    let pts = if interval == 0 {
        pts
    } else {
        (pts / interval as f64).floor() * interval as f64
    };
    (
        pts,
        samples.partition_point(|(p, _)| *p <= pts).max(1) as u64,
    )
}

fn validate_source(source: &Source) -> Result<()> {
    anyhow::ensure!(
        !(source.manifest.is_some() && source.snapshot_v2.is_some()),
        "contradictory source versions"
    );
    match (&source.manifest, &source.snapshot_v2, &source.snapshot) {
        (Some(m), None, Some(raw)) => {
            let model::ValidatedSource::Legacy(parsed) =
                model::ValidatedSource::parse(raw, &m.instance_id, &m.identity, true)?
            else {
                anyhow::bail!("source version mismatch")
            };
            anyhow::ensure!(parsed == *m, "source snapshot differs from render model");
        }
        (None, Some(m), Some(raw)) => {
            let model::ValidatedSource::Snapshot(parsed) =
                model::ValidatedSource::parse(raw, &m.instance_id, &m.identity, true)?
            else {
                anyhow::bail!("source version mismatch")
            };
            anyhow::ensure!(parsed == *m, "source snapshot differs from render model");
            if source.provenance == Provenance::Recording {
                anyhow::ensure!(
                    source.duration_ms == m.end.duration_ms
                        && source.frames.len() == m.frames.len(),
                    "source timing/count mismatch"
                );
                let mut spool = Sha256::new();
                for (frame, entry) in source.frames.iter().zip(&m.frames) {
                    anyhow::ensure!(frame.t_ms == entry.t_ms, "source observation time mismatch");
                    let FrameData::Jpeg(path) = &frame.data else {
                        anyhow::bail!("recording source requires original JPEG")
                    };
                    let bytes = read_bounded(path, MAX_FRAME_BYTES as usize)?;
                    anyhow::ensure!(
                        bytes.len() as u64 == entry.length && digest(&bytes) == entry.sha256,
                        "source JPEG hash/length mismatch"
                    );
                    spool.update(&bytes);
                }
                anyhow::ensure!(
                    format!("{:x}", spool.finalize()) == m.spool_sha256,
                    "source spool digest mismatch"
                );
            }
        }
        (None, None, None) => anyhow::ensure!(
            source.provenance != Provenance::Recording,
            "recording without provenance"
        ),
        _ => anyhow::bail!("unpaired source snapshot"),
    }
    Ok(())
}
fn final_image_index(source: &Source) -> Result<usize> {
    let m = source.snapshot_v2.as_ref().context("missing v2 source")?;
    let seq = m.frames.last().context("empty source")?.seq;
    if source.provenance == Provenance::Recording {
        return Ok(source.frames.len() - 1);
    }
    source
        .frames
        .iter()
        .position(|f| {
            f.original
                .as_ref()
                .is_some_and(|r| r.source_seq == Some(seq))
        })
        .context("verified input does not present stored final")
}
/// Ceil against integer milliseconds without rounding the source timestamp.
fn ceil_quantum(t: f64, q: u64) -> u64 {
    let mut ticks = (t / q as f64).ceil() as u64;
    if ((ticks * q) as f64) < t {
        ticks += 1;
    }
    ticks * q
}
struct Presentation {
    samples: Vec<(f64, f64)>,
    final_append: Option<usize>,
}
fn schedule_source(source: &Source, plan: &Plan) -> Result<Presentation> {
    let mut duration = source
        .snapshot_v2
        .as_ref()
        .map_or(source.duration_ms, |m| m.end.duration_ms);
    // Without a genuine stored final there is no extension permission. Quantize
    // inward, rather than rounding a deadline/failure past its actual cutoff.
    if source.snapshot_v2.as_ref().is_some_and(|m| {
        m.frames
            .last()
            .is_none_or(|f| f.observation.purpose != v2::Purpose::Final)
    }) {
        let q = if plan.settings.format == Format::Gif {
            10.0
        } else {
            1.0
        };
        duration = (duration / q).floor() * q;
        anyhow::ensure!(
            duration > 0.0,
            "source cutoff is shorter than one output container quantum"
        );
    }
    let mut samples = schedule(
        duration,
        plan.settings.fps,
        plan.settings.format == Format::Gif,
    )?;
    let Some(m) = &source.snapshot_v2 else {
        return Ok(Presentation {
            samples,
            final_append: None,
        });
    };
    let Some(final_frame) = m
        .frames
        .last()
        .filter(|f| f.observation.purpose == v2::Purpose::Final)
    else {
        return Ok(Presentation {
            samples,
            final_append: None,
        });
    };
    let visible = samples
        .iter()
        .any(|(p, d)| source.row("check", *p, *d, 1, None).source_seq == Some(final_frame.seq));
    if visible {
        return Ok(Presentation {
            samples,
            final_append: None,
        });
    }
    let q = if plan.settings.format == Format::Gif {
        10
    } else {
        1
    };
    let pts = ceil_quantum(final_frame.t_ms, q);
    let end = pts + q;
    // Integer container endpoints compared to original binary64 cutoff: no
    // subtraction of rounded seconds, no source timestamp rounding/backdating.
    anyhow::ensure!(
        end as f64 >= m.end.duration_ms && ((end as i64 - 2 * q as i64) as f64) < m.end.duration_ms,
        "final visibility cannot truncate observed end or exceed quantum bound"
    );
    anyhow::ensure!(
        samples.last().unwrap().0 < pts as f64,
        "final append must follow prior presentation PTS"
    );
    let last = samples.last_mut().unwrap();
    last.1 = pts as f64 - last.0;
    samples.push((pts as f64, q as f64));
    final_image_index(source)?;
    let index = samples.len() - 1;
    Ok(Presentation {
        samples,
        final_append: Some(index),
    })
}

pub fn encode(source: &Source, plan: &Plan, output: &Output) -> Result<Value> {
    anyhow::ensure!(!source.frames.is_empty(), "no frames to export");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    validate_source(source)?;
    let Presentation {
        samples,
        final_append,
    } = schedule_source(source, plan)?;
    let export_id = id();
    let mut rows = Vec::new();
    let mut concat = String::new();
    let mut bytes = 0;
    let mut dimensions = None;
    let mut previous = None;
    let mut last_index = None;
    let mut clean = None;
    for (n, (pts, duration)) in samples.iter().enumerate() {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "watermark/normalization deadline exceeded"
        );
        let index = if final_append == Some(n) {
            final_image_index(source)?
        } else {
            source
                .frames
                .partition_point(|f| f.t_ms <= *pts)
                .saturating_sub(1)
        };
        if last_index != Some(index) {
            let input = source.image(index)?;
            let ratio =
                (plan.settings.max_edge as f64 / input.width().max(input.height()) as f64).min(1.0);
            let width = (input.width() as f64 * ratio).round().max(1.0) as u32;
            let height = (input.height() as f64 * ratio).round().max(1.0) as u32;
            clean = Some(imageops::resize(
                &input,
                width,
                height,
                imageops::FilterType::Lanczos3,
            ));
            last_index = Some(index);
        }
        let clean = clean.as_ref().unwrap();
        let strip = plan
            .renderer
            .as_ref()
            .and_then(|r| r.template.strip_height)
            .unwrap_or(0);
        let (mut width, mut height) = (clean.width(), clean.height() + strip);
        if plan.settings.format != Format::Gif {
            width += width % 2;
            height += height % 2;
        }
        anyhow::ensure!(
            dimensions.is_none_or(|d| d == (width, height)),
            "output geometry changed"
        );
        dimensions = Some((width, height));
        let mut image = RgbImage::new(width, height);
        imageops::replace(&mut image, clean, 0, 0);
        let mut row = source.row(&export_id, *pts, *duration, n as u64 + 1, previous);
        if final_append == Some(n) {
            let f = source.snapshot_v2.as_ref().unwrap().frames.last().unwrap();
            row.source_seq = Some(f.seq);
            row.source_t_ms = Some(f.t_ms);
            row.normalization_hold = Some(previous == Some(f.seq));
        }
        previous = row.source_seq;
        if let Some(r) = &plan.renderer {
            for (i, item) in r.template.items.iter().enumerate() {
                if item
                    .interval
                    .as_ref()
                    .is_some_and(|t| *pts < t.start_ms as f64 || *pts >= t.end_ms as f64)
                {
                    continue;
                }
                let (text_pts, text_number) = text_clock(&samples, *pts, item.update_interval_ms);
                let text_row = if final_append == Some(n) && text_pts == *pts {
                    // Offline final pixels may be selected explicitly before
                    // their old container PTS, but never before observation time.
                    // The current-frame template must describe those same pixels.
                    row.clone()
                } else {
                    source.row(&export_id, text_pts, *duration, text_number, None)
                };
                let v = template::values(
                    &plan.labels,
                    plan.run_id.as_deref(),
                    source
                        .manifest
                        .as_ref()
                        .map(|m| &m.identity)
                        .or_else(|| source.snapshot_v2.as_ref().map(|m| &m.identity)),
                    &export_id,
                    &text_row,
                    row.source_seq.is_some(),
                );
                let text = match &item.text {
                    Text::Literal(t) => t.clone(),
                    Text::Template(t) => template::expand(t, &v)?,
                };
                r.paint(&mut image, &text, i, clean.height())?;
            }
        }
        let name = format!("frame-{n:04}.png");
        let path = output.temp.0.join(&name);
        image.save(&path)?;
        bytes += fs::metadata(&path)?.len();
        anyhow::ensure!(
            bytes <= SCRATCH_CAP,
            "normalized image scratch limit (512 MiB)"
        );
        concat.push_str(&format!(
            "file '{name}'\noption framerate 1000\nduration {:.6}\n",
            duration / 1000.0
        ));
        rows.push(row);
    }
    let last = samples.len() - 1;
    concat.push_str(&format!(
        "file 'frame-{last:04}.png'\noption framerate 1000\n"
    ));
    write_new(&output.temp.0.join("frames.ffconcat"), concat.as_bytes())?;
    let encoded_duration = samples.last().unwrap().0 + samples.last().unwrap().1;
    if plan.settings.format == Format::Gif {
        // Separate passes avoid buffering the entire decoded clip on the split
        // branch while palettegen waits for EOF. Clean normalized PNGs are reused.
        process(
            ffmpeg()
                .current_dir(&output.temp.0)
                .args([
                    "-threads",
                    "1",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    "frames.ffconcat",
                    "-t",
                ])
                .arg(format!("{:.6}", encoded_duration / 1000.0))
                .args(["-vf"])
                .arg(format!(
                    "palettegen=max_colors={}:reserve_transparent=0:stats_mode=full",
                    plan.settings.colors
                ))
                .args([
                    "-frames:v",
                    "1",
                    "-threads",
                    "1",
                    "-update",
                    "1",
                    "-n",
                    "palette.png",
                ]),
            Duration::from_secs(120),
            65536,
        )?;
    }
    let mut cmd = ffmpeg();
    cmd.current_dir(&output.temp.0).args([
        "-threads",
        "1",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "frames.ffconcat",
    ]);
    if plan.settings.format == Format::Gif {
        cmd.args(["-i", "palette.png"]);
    }
    cmd.args(["-an", "-fps_mode", "vfr", "-t"])
        .arg(format!("{:.6}", encoded_duration / 1000.0))
        .args(["-threads", "1", "-fs"])
        .arg(SCRATCH_CAP.to_string());
    match plan.settings.format {
        Format::Gif => {
            cmd.args([
                "-filter_complex_threads",
                "1",
                "-filter_complex",
                "[0:v][1:v]paletteuse=dither=sierra2_4a",
                "-loop",
                "0",
                "-final_delay",
            ])
            .arg(format!(
                "{}",
                (samples.last().unwrap().1 / 10.0).round() as u64
            ))
            .args(["-f", "gif"]);
        }
        Format::Mp4 | Format::Mov => {
            cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf"])
                .arg(plan.settings.crf.to_string())
                .args([
                    "-pix_fmt",
                    "yuv420p",
                    "-enc_time_base",
                    "1:1000",
                    "-video_track_timescale",
                    "1000",
                ]);
            if plan.settings.format == Format::Mp4 {
                cmd.args(["-movflags", "+faststart"]);
            }
            cmd.args([
                "-f",
                if plan.settings.format == Format::Mp4 {
                    "mp4"
                } else {
                    "mov"
                },
            ]);
        }
    }
    cmd.args(["-n", "video"]);
    process(&mut cmd, Duration::from_secs(120), 65536)?;
    let facts = probe(&output.temp.0.join("video"))?;
    let (width, height) = dimensions.unwrap();
    anyhow::ensure!(
        facts.width == width
            && facts.height == height
            && !facts.audio
            && facts.frames.len() == rows.len(),
        "encoded geometry/frame-count/audio mismatch"
    );
    anyhow::ensure!(
        (facts.duration_ms - encoded_duration).abs()
            <= if plan.settings.format == Format::Gif {
                10.1
            } else {
                1.1
            },
        "encoded duration {}ms differs from observed/quantized end {}ms",
        facts.duration_ms,
        encoded_duration
    );
    if plan.settings.format != Format::Gif {
        anyhow::ensure!(
            facts.codec == "h264" && facts.pixel_format == "yuv420p",
            "incompatible H.264 output"
        );
    }
    if source.manifest.is_none() {
        let end = facts.exact_end_ms()?;
        anyhow::ensure!(
            end as f64 == encoded_duration,
            "container end ticks differ from planned end"
        );
        for (i, (pts, _)) in samples.iter().enumerate() {
            anyhow::ensure!(
                facts.exact_pts_ms(i)? as f64 == *pts,
                "container PTS ticks differ from schedule"
            );
        }
        if let Some(n) = final_append {
            let m = source.snapshot_v2.as_ref().unwrap();
            let q = if plan.settings.format == Format::Gif {
                10
            } else {
                1
            };
            anyhow::ensure!(
                (end as f64) >= m.end.duration_ms && ((end - 2 * q) as f64) < m.end.duration_ms,
                "actual final visibility exceeds quantum bound"
            );
            let row = model::row_v2(&rows[n], Some(m), true)?;
            v2::validate_final_visibility(
                &row,
                m.frames.last().unwrap(),
                m.end.duration_ms,
                q as f64,
                end as f64,
            )
            .map_err(anyhow::Error::msg)?;
        }
    }
    let actual_duration = if source.manifest.is_none() {
        facts.exact_end_ms()? as f64
    } else {
        facts.duration_ms
    };
    for (i, row) in rows.iter_mut().enumerate() {
        anyhow::ensure!(
            (row.pts_ms - facts.frames[i].0).abs() < 0.01,
            "encoded presentation PTS differs from normalization schedule"
        );
        if source.manifest.is_none() {
            row.pts_ms = facts.exact_pts_ms(i)? as f64;
            let end = if i + 1 < facts.frames.len() {
                facts.exact_pts_ms(i + 1)? as f64
            } else {
                actual_duration
            };
            row.duration_ms = end - row.pts_ms;
        } else {
            row.pts_ms = facts.frames[i].0;
            row.duration_ms = facts.frames[i].1;
        }
    }
    if output.sidecars {
        let mut timeline = Vec::new();
        for row in &rows {
            if source.manifest.is_some() {
                serde_json::to_writer(&mut timeline, row)?;
            } else {
                let n = row.output_frame as usize - 1;
                serde_json::to_writer(
                    &mut timeline,
                    &model::row_v2(row, source.snapshot_v2.as_ref(), final_append == Some(n))?,
                )?;
            }
            timeline.push(b'\n');
        }
        anyhow::ensure!(
            timeline.len() <= MAX_TIMELINE_BYTES,
            "timeline exceeds limit"
        );
        write_new(&output.temp.0.join("timeline"), &timeline)?;
        let metadata = ArtifactMetadata {
            schema_version: 1,
            export_id: export_id.clone(),
            provenance: source.provenance,
            identity: source.manifest.as_ref().map(|m| m.identity.clone()),
            run_id: plan.run_id.clone(),
            labels: plan.labels.clone(),
            settings: plan.settings.clone(),
            video: hash_file(&output.temp.0.join("video"))?,
            timeline: HashedFile {
                sha256: digest(&timeline),
                bytes: timeline.len() as u64,
            },
            source_manifest_sha256: source.snapshot.as_ref().map(|s| digest(s.as_bytes())),
            source_manifest_json: source.snapshot.clone(),
            input_video: source.input_video.clone(),
            parent_export_id: source.parent_export_id.clone(),
            partial: source.manifest.as_ref().is_some_and(|m| {
                m.state != State::Sealed
                    || !m.end.duration_observed
                    || !matches!(m.end.reason, EndReason::Stopped | EndReason::Deadline)
            }),
            end_reason: source.manifest.as_ref().map(|m| m.end.reason),
            duration_ms: facts.duration_ms,
            width,
            height,
        };
        let mut meta = serde_json::to_value(metadata)?;
        meta["source_observed_duration_ms"] = source
            .manifest
            .as_ref()
            .map(|m| json!(m.end.duration_ms))
            .unwrap_or(Value::Null);
        meta["source_duration_observed"] = source
            .manifest
            .as_ref()
            .map(|m| json!(m.end.duration_observed))
            .unwrap_or(Value::Null);
        if source.manifest.is_none() {
            let m = source.snapshot_v2.as_ref();
            let metadata = v2::ArtifactMetadata {
                schema_version: 2,
                export_id: export_id.clone(),
                provenance: source.provenance,
                identity: m.map(|m| m.identity.clone()),
                run_id: plan.run_id.clone(),
                labels: plan.labels.clone(),
                settings: plan.settings.clone(),
                video: hash_file(&output.temp.0.join("video"))?,
                timeline: HashedFile {
                    sha256: digest(&timeline),
                    bytes: timeline.len() as u64,
                },
                source_manifest_sha256: source.snapshot.as_ref().map(|s| digest(s.as_bytes())),
                source_manifest_json: source.snapshot.clone(),
                source_protocol_version: m.map(|_| 2),
                backend: m.map(|m| m.backend),
                input_video: source.input_video.clone(),
                parent_export_id: source.parent_export_id.clone(),
                partial: m.is_some_and(|m| m.state == State::Failed),
                end_reason: m.map(|m| m.end.reason),
                duration_ms: actual_duration,
                observed_source_end_ms: m
                    .and_then(|m| m.end.duration_observed.then_some(m.end.duration_ms)),
                final_visibility_extension_ms: m
                    .map_or(0.0, |m| (actual_duration - m.end.duration_ms).max(0.0)),
                width,
                height,
            };
            metadata.validate_source().map_err(anyhow::Error::msg)?;
            meta = serde_json::to_value(metadata)?;
        }
        let bytes = serde_json::to_vec_pretty(&meta)?;
        anyhow::ensure!(bytes.len() <= MAX_METADATA_BYTES, "metadata exceeds limit");
        write_new(&output.temp.0.join("metadata"), &bytes)?;
    }
    let hash = hash_file(&output.temp.0.join("video"))?;
    output.publish()?;
    Ok(
        json!({"export_id":export_id,"out":output.video,"metadata":output.sidecars.then_some(&output.metadata),"timeline":output.sidecars.then_some(&output.timeline),"video":hash,"duration_ms":actual_duration,"width":width,"height":height}),
    )
}

pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub duration_ms: f64,
    pub frames: Vec<(f64, f64)>,
    pub audio: bool,
    pub codec: String,
    pub pixel_format: String,
    time_base: Option<(i64, i64)>,
    end_tick: Option<i64>,
    pts_ticks: Vec<Option<i64>>,
}
impl Probe {
    fn ticks_ms(&self, ticks: i64) -> Result<i64> {
        let (n, d) = self.time_base.context("missing container timebase")?;
        let value = i128::from(ticks) * i128::from(n) * 1000;
        anyhow::ensure!(
            n > 0 && d > 0 && value % i128::from(d) == 0,
            "nonintegral container millisecond boundary"
        );
        i64::try_from(value / i128::from(d)).context("container time overflow")
    }
    pub(super) fn exact_end_ms(&self) -> Result<i64> {
        self.ticks_ms(self.end_tick.context("missing container duration ticks")?)
    }
    pub(super) fn exact_pts_ms(&self, index: usize) -> Result<i64> {
        self.ticks_ms(
            self.pts_ticks
                .get(index)
                .copied()
                .flatten()
                .context("missing presentation ticks")?,
        )
    }
}
pub fn probe(path: &Path) -> Result<Probe> {
    probe_demuxer(path, None)
}
pub(super) fn probe_demuxer(path: &Path, demuxer: Option<&str>) -> Result<Probe> {
    let mut cmd = std::process::Command::new("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-threads",
        "1",
    ]);
    if let Some(demuxer) = demuxer {
        cmd.args(["-f", demuxer]);
        if demuxer == "mov" {
            cmd.args(["-enable_drefs", "0"]);
        }
    }
    let out=process(cmd.args(["-show_streams","-show_format","-show_frames","-show_entries","stream=codec_type,codec_name,pix_fmt,width,height,time_base,duration_ts:format=duration:frame=media_type,best_effort_timestamp,best_effort_timestamp_time,pts_time,duration_time,pkt_duration_time","-of","json"]).arg(path),Duration::from_secs(20),4*1024*1024)?;
    let v: Value = serde_json::from_slice(&out)?;
    let streams = v["streams"].as_array().context("ffprobe streams")?;
    let videos = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .collect::<Vec<_>>();
    anyhow::ensure!(videos.len() == 1, "input must have one video stream");
    let s = videos[0];
    let width = s["width"].as_u64().context("video width")? as u32;
    let height = s["height"].as_u64().context("video height")? as u32;
    anyhow::ensure!(
        width > 0
            && height > 0
            && width <= 16384
            && height <= 16384
            && width as u64 * height as u64 <= 64_000_000,
        "video dimensions exceed limits"
    );
    let duration_ms = v["format"]["duration"]
        .as_str()
        .context("video duration")?
        .parse::<f64>()?
        * 1000.0;
    anyhow::ensure!(
        duration_ms.is_finite() && duration_ms > 0.0 && duration_ms <= 60010.0,
        "video must be finite and <=60 seconds"
    );
    let time_base = s["time_base"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .and_then(|(n, d)| Some((n.parse().ok()?, d.parse().ok()?)));
    let end_tick = s["duration_ts"].as_i64();
    let mut pts_ticks = Vec::new();
    let mut frames = Vec::new();
    for f in v["frames"]
        .as_array()
        .context("ffprobe presentation frames")?
        .iter()
        .filter(|f| f["media_type"] == "video")
    {
        let pts = f["best_effort_timestamp_time"]
            .as_str()
            .or_else(|| f["pts_time"].as_str())
            .context("frame PTS")?
            .parse::<f64>()?
            * 1000.0;
        anyhow::ensure!(
            pts.is_finite() && pts >= 0.0 && frames.last().is_none_or(|(p, _)| pts > *p),
            "nonmonotonic/invalid presentation timestamps"
        );
        pts_ticks.push(f["best_effort_timestamp"].as_i64());
        frames.push((pts, 0.0));
        anyhow::ensure!(frames.len() <= MAX_FRAMES + 1, "video frame limit exceeded");
    }
    anyhow::ensure!(
        !frames.is_empty() && frames[0].0.abs() <= 1.0,
        "video requires zero-origin presentation time"
    );
    for i in 0..frames.len() {
        let end = frames.get(i + 1).map(|f| f.0).unwrap_or(duration_ms);
        anyhow::ensure!(end > frames[i].0, "invalid frame duration");
        frames[i].1 = end - frames[i].0;
    }
    Ok(Probe {
        width,
        height,
        duration_ms,
        frames,
        audio: streams.iter().any(|s| s["codec_type"] == "audio"),
        codec: s["codec_name"].as_str().unwrap_or("").into(),
        pixel_format: s["pix_fmt"].as_str().unwrap_or("").into(),
        time_base,
        end_tick,
        pts_ticks,
    })
}
