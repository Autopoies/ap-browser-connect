use super::*;
use clap::Parser;
use std::path::Path;

fn cli(args: &[&str]) -> crate::Cli {
    crate::Cli::try_parse_from(std::iter::once("ap-browser").chain(args.iter().copied())).unwrap()
}
fn fixture() -> Manifest {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording/manifest.json"
    ))
    .unwrap()
}
pub(super) fn synthetic(temp: &Temp, static_only: bool) -> export::Source {
    let mut m = fixture();
    m.config.labels.clear();
    m.config.labels.insert(
        "project".into(),
        "arena ':%{x}; [v] drawtext=text=BAD".into(),
    );
    m.config.labels.insert("attempt".into(), "42".into());
    m.end.duration_ms = 5030.0;
    m.config.max_duration_ms = 5030;
    m.end.reason = EndReason::Stopped;
    m.frames.truncate(1);
    m.frames[0].t_ms = 350.0;
    m.frames[0].width = 101;
    m.frames[0].height = 77;
    let geometry = &mut m.frames[0].geometry;
    for r in [
        &mut geometry.viewport_css,
        &mut geometry.crop_css,
        &mut m.resolved_region_css,
    ] {
        r.width = 101.0;
        r.height = 77.0;
    }
    let mut frames = Vec::new();
    let count = if static_only { 1 } else { 4 };
    let first = m.frames[0].clone();
    m.frames.clear();
    let mut spool = Vec::new();
    for n in 0..count {
        let mut image = image::RgbImage::from_pixel(101, 77, image::Rgb([20, 40, 80]));
        for y in 35..55 {
            for x in (10 + n * 18)..(25 + n * 18) {
                image.put_pixel(x, y, image::Rgb([220, 80, 40]));
            }
        }
        let path = temp.0.join(format!("synthetic-{n}.jpg"));
        image.save(&path).unwrap();
        let data = fs::read(&path).unwrap();
        let t = 350.0 + n as f64 * 500.0;
        let mut f = first.clone();
        f.seq = n as u64 + 1;
        f.t_ms = t;
        f.offset = spool.len() as u64;
        f.length = data.len() as u64;
        f.sha256 = digest(&data);
        spool.extend_from_slice(&data);
        m.frames.push(f);
        frames.push(export::SourceFrame {
            t_ms: t,
            data: export::FrameData::Jpeg(path),
            original: None,
        });
    }
    m.end.final_seq = count as u64;
    m.spool_bytes = spool.len() as u64;
    m.spool_sha256 = digest(&spool);
    validate::manifest(&m, &m.instance_id, &m.identity, false).unwrap();
    let snapshot = serde_json::to_string(&m).unwrap();
    export::Source {
        frames,
        duration_ms: 5030.0,
        manifest: Some(m),
        snapshot_v2: None,
        snapshot: Some(snapshot),
        provenance: Provenance::Recording,
        input_video: None,
        parent_export_id: None,
    }
}
#[test]
fn command_surface_out_and_bounds() {
    for args in [
        vec!["record", "--out", "x.mp4"],
        vec!["record", "start", "--label", "project=arena"],
        vec![
            "record",
            "export",
            "browser_01:host_01:rec_01",
            "--out",
            "x.gif",
        ],
        vec![
            "--profile",
            "test",
            "record",
            "stop",
            "browser_01:host_01:rec_01",
        ],
        vec![
            "record",
            "mark",
            "browser_01:host_01:rec_01",
            "--text",
            "collision",
        ],
    ] {
        cli(&args);
    }
    assert!(Output::new(None, false, None).is_err());
    for s in ["0s", "61s", "NaNs", "-1s", "1.1ms"] {
        assert!(args::duration(s, 60000).is_err());
    }
    assert_eq!(args::duration("1.25s", 60000).unwrap(), 1250);
    assert!(Handle::parse("../x:host:rec").is_err());
    let parsed = cli(&["record", "start", "--label", "seed=42", "--run-id", "R042"]);
    if let crate::Cmd::Record(args) = parsed.command {
        if let Some(Action::Start { export, .. }) = args.command {
            let plan = export::Plan::new(&export, Labels::new(), None, true).unwrap();
            assert_eq!(plan.labels["seed"], "42");
        } else {
            panic!()
        }
    } else {
        panic!()
    }
}
#[test]
fn manifest_and_chunk_validation() {
    let m = fixture();
    validate::manifest(&m, &m.instance_id, &m.identity, false).unwrap();
    for mutation in 0..8 {
        let mut bad = m.clone();
        match mutation {
            0 => bad.frames[1].seq = 9,
            1 => bad.frames[1].offset = 0,
            2 => bad.end.duration_ms = 90000.0,
            3 => bad.frames[1].t_ms = -1.0,
            4 => bad.frames[1].geometry.css_to_image.offset_x = 1.0,
            5 => bad.events[1].event_index = 1,
            6 => bad.clock.source = "cdp".into(),
            _ => bad.spool_sha256 = "0".into(),
        };
        assert!(validate::manifest(&bad, &m.instance_id, &m.identity, false).is_err());
    }
    let mut partial = m.clone();
    partial.state = State::Failed;
    partial.end.duration_observed = false;
    partial.end.reason = EndReason::NativeDisconnected;
    assert!(validate::manifest(&partial, &m.instance_id, &m.identity, false).is_err());
    validate::manifest(&partial, &m.instance_id, &m.identity, true).unwrap();
    let v: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/recording/wire.json")).unwrap();
    let c: Chunk = serde_json::from_value(v["chunk"]["result"]["data"].clone()).unwrap();
    check_chunk(&c, &m.identity, c.offset, c.length, c.total_bytes).unwrap();
    for mutation in 0..6 {
        let mut bad = c.clone();
        match mutation {
            0 => bad.identity.record_id = "other".into(),
            1 => bad.offset += 1,
            2 => bad.length += 1,
            3 => bad.sha256 = "0".repeat(64),
            4 => bad.eof = !bad.eof,
            _ => bad.data_base64.push('='),
        };
        assert!(check_chunk(&bad, &m.identity, c.offset, c.length, c.total_bytes).is_err());
    }
}
#[test]
fn task_literals_placeholders_cjk_and_crop() {
    let mut values = std::collections::BTreeMap::new();
    values.insert("label.a".into(), "':%{phase}; [v] /tmp/NO".into());
    assert_eq!(
        template::expand("{{{label.a}}}", &values).unwrap(),
        "{':%{phase}; [v] /tmp/NO}"
    );
    for s in ["{expr}", "{pts_ms*2}", "{", "}"] {
        assert!(template::expand(s, &values).is_err());
    }
    assert!(template::text_ok("x\0bad", false).is_err());
    let t = template::task(&Labels::new());
    let r = template::Renderer::new(t, None).unwrap();
    r.check_text("stage: jump", 0).unwrap();
    let mut image = image::RgbImage::from_pixel(220, 100, image::Rgb([12, 24, 36]));
    r.paint(&mut image, "phase: jump ':%{x}", 0, 36).unwrap();
    assert!(
        image.rows().take(36).flatten().all(|p| p.0 == [12, 24, 36]),
        "strip must never obscure captured content"
    );
    assert!(image.rows().skip(36).flatten().any(|p| p.0 != [12, 24, 36]));
    assert!(r.check_text("碰撞", 0).is_err());
    let cjk = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc";
    if Path::new(cjk).exists() {
        let r =
            template::Renderer::new(template::task(&Labels::new()), Some(Path::new(cjk))).unwrap();
        r.check_text("碰撞", 0).unwrap();
    }
    let mut f = fixture().frames[0].clone();
    f.geometry.crop_css = Rect {
        x: 0.2,
        y: 0.2,
        width: 10.7,
        height: 10.7,
    };
    assert_eq!(validate::crop(&f).unwrap(), (1, 1, 9, 9));
}
#[test]
fn time_and_task_provenance_not_distinct_frame_fiction() {
    let times = export::schedule(1500.0, 15, false).unwrap();
    assert_eq!(export::text_clock(&times, 267.0, 500), (0.0, 1));
    assert_eq!(export::text_clock(&times, 267.0, 100), (200.0, 4));
    assert_eq!(export::text_clock(&times, 267.0, 0), (267.0, 5));
    let t = Temp::new(&std::env::temp_dir()).unwrap();
    let s = synthetic(&t, true);
    let first = s.row("export", 0.0, 1000.0, 1, None);
    assert_eq!(first.source_t_ms, Some(350.0));
    assert_eq!(first.normalization_hold, Some(false));
    let row = s.row("export", 800.0, 1000.0, 2, first.source_seq);
    assert_eq!(row.normalization_hold, Some(true));
    assert_eq!(row.phase.as_deref(), Some("air collision"));
    assert_eq!(row.marks, vec!["observed overlap"]);
    let row = s.row("export", 1600.0, 1000.0, 3, first.source_seq);
    assert!(row.marks.is_empty());
    assert_eq!(row.phase.as_deref(), Some("air collision"));
    for gif in [false, true] {
        for fps in [1, 4, 8, 15, 30] {
            for duration in [1.0, 9.0, 101.0, 1500.0, 5030.0, 60000.0] {
                let times = export::schedule(duration, fps, gif).unwrap();
                let end = times.last().unwrap().0 + times.last().unwrap().1;
                assert!((end - duration).abs() <= if gif { 10.0 } else { 1.0 });
                assert!(times.iter().all(|(_, d)| *d > 0.0));
            }
        }
    }
}
#[test]
fn paths_no_clobber_and_atomic_collision_rollback() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let path = temp.0.join("outside 空 格.mp4");
    let output = Output::new(Some(&path), true, None).unwrap();
    assert!(output.video.is_absolute());
    write_new(&output.temp.0.join("video"), b"video").unwrap();
    write_new(&output.temp.0.join("timeline"), b"timeline").unwrap();
    write_new(&output.temp.0.join("metadata"), b"metadata").unwrap();
    write_new(&output.timeline, b"unrelated").unwrap();
    assert!(output.publish().is_err());
    assert!(!output.video.exists());
    assert_eq!(fs::read(&output.timeline).unwrap(), b"unrelated");
    assert!(Output::new(Some(&path), true, None).is_err());
    assert!(Output::new(
        Some(Path::new("/nonexistent-parent-recording/no.mp4")),
        false,
        None
    )
    .is_err());
    #[cfg(unix)]
    {
        let cwd = std::env::current_dir().unwrap();
        let relative = std::path::PathBuf::from("../".repeat(cwd.components().count() - 1))
            .join(std::env::temp_dir().strip_prefix("/").unwrap())
            .join(format!("record-relative-{}.mov", id()));
        let out = Output::new(Some(&relative), false, None).unwrap();
        assert!(out.video.is_absolute());
        assert_eq!(
            out.video.parent().unwrap(),
            std::env::temp_dir().canonicalize().unwrap()
        );
    }
}
#[test]
fn missing_dependency_and_true_deadlines() {
    let error = preserve_error(
        anyhow::anyhow!("ffmpeg or CJK font failed").context("recording retained as handle"),
    );
    assert_eq!(error_code(&error), Some("CLI_ERROR"));
    assert!(format!("{error:#}").contains("CJK font failed"));
    assert!(process(
        std::process::Command::new("/nonexistent-recording-ffmpeg").arg("-version"),
        Duration::from_millis(50),
        100
    )
    .is_err());
    let start = Instant::now();
    assert!(bounded(Duration::from_millis(20), || {
        std::thread::sleep(Duration::from_millis(200));
        Ok(())
    })
    .is_err());
    assert!(start.elapsed() < Duration::from_millis(150));
    #[cfg(unix)]
    {
        let mut c = std::process::Command::new("/bin/sleep");
        c.arg("2");
        let start = Instant::now();
        assert!(process(&mut c, Duration::from_millis(30), 100).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        // Test fixture only: simulate an invalid local executable inheriting a
        // pipe into its own descendant. Product FFmpeg calls never use a shell.
        let start = Instant::now();
        assert!(process(
            std::process::Command::new("/bin/sh").args(["-c", "sleep 2 &"]),
            Duration::from_millis(100),
            100
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(process(
            &mut std::process::Command::new("/usr/bin/yes"),
            Duration::from_secs(2),
            100
        )
        .is_err());
    }
}
/// Real tools are intentionally NOT skipped when absent: missing dependencies
/// must be visible in this lane's acceptance gate, never an ignored green test.
#[test]
fn actual_ffmpeg_all_formats_sparse_static_tasks_and_offline() {
    preflight().unwrap();
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    for (format, static_only, fps) in [("mp4", true, 1), ("mov", false, 4), ("gif", false, 4)] {
        let source = synthetic(&temp, static_only);
        let path = temp.0.join(format!("caller 空 格 {format}.{format}"));
        let args = ExportArgs {
            out: Some(path.clone()),
            preset: "tiny".into(),
            fps: Some(fps),
            watermark: "task".into(),
            metadata: true,
            ..Default::default()
        };
        let plan = export::Plan::new(
            &args,
            source.manifest.as_ref().unwrap().config.labels.clone(),
            Some("R042".into()),
            true,
        )
        .unwrap();
        let output = Output::new(Some(&path), true, None).unwrap();
        let value = export::encode(&source, &plan, &output).unwrap();
        assert_eq!(value["out"], path.canonicalize().unwrap().to_str().unwrap());
        if let Some(directory) = std::env::var_os("AP_RECORDING_TEST_ARTIFACTS") {
            let directory = std::path::PathBuf::from(directory).canonicalize().unwrap();
            let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap();
            assert!(
                !directory.starts_with(repo),
                "test artifacts must stay outside repository"
            );
            for artifact in [&output.video, &output.metadata, &output.timeline] {
                write_new(
                    &directory.join(artifact.file_name().unwrap()),
                    &fs::read(artifact).unwrap(),
                )
                .unwrap();
            }
        }
        let facts = export::probe(&path).unwrap();
        assert!((facts.duration_ms - 5030.0).abs() < 11.0);
        assert!(!facts.audio);
        let metadata: ArtifactMetadata =
            serde_json::from_slice(&fs::read(&output.metadata).unwrap()).unwrap();
        assert_eq!(metadata.settings.fps, fps);
        assert_eq!(metadata.video, hash_file(&path).unwrap());
        let rows = fs::read_to_string(&output.timeline)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str::<OutputFrame>(s).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), facts.frames.len());
        assert!(rows
            .iter()
            .skip(1)
            .any(|r| r.normalization_hold == Some(true)));
        assert_eq!(rows[0].source_t_ms, Some(350.0));
        assert!(Output::new(Some(&path), true, Some(&path)).is_err());
        let input_hash = hash_file(&path).unwrap();
        let offline_args = ExportArgs {
            out: Some(temp.0.join(format!("offline {format}.mp4"))),
            preset: "tiny".into(),
            fps: Some(4),
            watermark: "task".into(),
            metadata: true,
            ..Default::default()
        };
        offline::run(&path, None, None, &offline_args).unwrap();
        let new_meta: ArtifactMetadata = serde_json::from_slice(
            &fs::read(
                offline_args
                    .out
                    .as_ref()
                    .unwrap()
                    .with_extension("metadata.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(new_meta.provenance, Provenance::OfflineUnverified);
        assert!(new_meta.identity.is_none());
        assert!(new_meta.source_manifest_json.is_none());
        assert_eq!(hash_file(&path).unwrap(), input_hash);
    }
}
