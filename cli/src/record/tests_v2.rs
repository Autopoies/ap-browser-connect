//! Synthetic source/IPC tests with real local encoders; never live feature evidence.
use super::*;
use clap::Parser;
use std::path::{Path, PathBuf};

pub(super) fn synthetic(temp: &Temp) -> export::Source {
    let mut m: v2::Manifest = serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording-v2/manifest.json"
    ))
    .unwrap();
    m.config.labels.clear();
    m.config
        .labels
        .insert("project".into(), "arena '%{x}: [v]; /not-a-filter".into());
    m.events.push(Event {
        event_index: 2,
        operation_id: "mark_2".into(),
        t_ms: 1000.0,
        kind: EventKind::Mark {
            text: "FINAL".into(),
            duration_ms: 1000,
        },
    });
    let mut spool = Vec::new();
    let frames = m
        .frames
        .iter_mut()
        .enumerate()
        .map(|(n, f)| {
            let color = if n == 0 { [220, 20, 20] } else { [20, 220, 20] };
            let image = image::RgbImage::from_pixel(16, 16, image::Rgb(color));
            let path = temp.0.join(format!("v2-{n}.jpg"));
            image.save(&path).unwrap();
            let bytes = fs::read(&path).unwrap();
            f.offset = spool.len() as u64;
            f.length = bytes.len() as u64;
            f.sha256 = digest(&bytes);
            spool.extend_from_slice(&bytes);
            export::SourceFrame {
                t_ms: f.t_ms,
                data: export::FrameData::Jpeg(path),
                original: None,
            }
        })
        .collect();
    m.spool_bytes = spool.len() as u64;
    m.spool_sha256 = digest(&spool);
    m.validate().unwrap();
    export::Source {
        frames,
        duration_ms: m.end.duration_ms,
        manifest: None,
        snapshot_v2: Some(m.clone()),
        snapshot: Some(serde_json::to_string_pretty(&m).unwrap()),
        provenance: Provenance::Recording,
        input_video: None,
        parent_export_id: None,
    }
}
pub(super) fn sync(s: &mut export::Source) {
    let m = s.snapshot_v2.as_ref().unwrap();
    m.validate().unwrap();
    s.duration_ms = m.end.duration_ms;
    s.snapshot = Some(serde_json::to_string_pretty(m).unwrap());
    for (f, e) in s.frames.iter_mut().zip(&m.frames) {
        f.t_ms = e.t_ms;
    }
}
fn args(path: PathBuf, fps: u32) -> ExportArgs {
    ExportArgs {
        out: Some(path),
        fps: Some(fps),
        preset: "tiny".into(),
        metadata: true,
        ..Default::default()
    }
}
pub(super) fn encode(
    s: &export::Source,
    a: &ExportArgs,
) -> (Output, v2::ArtifactMetadata, Vec<v2::OutputFrame>) {
    let plan = export::Plan::new(
        a,
        s.snapshot_v2.as_ref().unwrap().config.labels.clone(),
        Some("R042".into()),
        true,
    )
    .unwrap();
    let output = Output::new(a.out.as_deref(), true, None).unwrap();
    export::encode(s, &plan, &output).unwrap();
    let meta: v2::ArtifactMetadata =
        serde_json::from_slice(&fs::read(&output.metadata).unwrap()).unwrap();
    let rows = fs::read_to_string(&output.timeline)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (output, meta, rows)
}
fn last_pixel(path: &Path) -> [u8; 3] {
    let bytes = process(
        ffmpeg()
            .args(["-protocol_whitelist", "file", "-threads", "1", "-i"])
            .arg(path)
            .args([
                "-vf",
                "reverse",
                "-frames:v",
                "1",
                "-pix_fmt",
                "rgb24",
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "pipe:1",
            ]),
        Duration::from_secs(10),
        1024 * 1024,
    )
    .unwrap();
    [bytes[0], bytes[1], bytes[2]]
}
pub(super) fn retain(output: &Output) {
    if let Some(dir) = std::env::var_os("AP_RECORDING_TEST_ARTIFACTS") {
        let dir = PathBuf::from(dir).canonicalize().unwrap();
        assert!(!dir.starts_with(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()));
        for p in [&output.video, &output.metadata, &output.timeline] {
            write_new(&dir.join(p.file_name().unwrap()), &fs::read(p).unwrap()).unwrap();
        }
    }
}
#[test]
fn real_all_formats_final_visibility_and_verified_offline() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let source = synthetic(&temp);
    let m = source.snapshot_v2.as_ref().unwrap();
    for format in ["gif", "mp4", "mov"] {
        let a = args(temp.0.join(format!("v2 final 空 格 {format}.{format}")), 1);
        let (output, meta, rows) = encode(&source, &a);
        let facts = export::probe(&output.video).unwrap();
        let q = if format == "gif" { 10 } else { 1 };
        let final_row = rows.last().unwrap();
        assert_eq!(meta.schema_version, 2);
        assert_eq!(meta.source_manifest_json, source.snapshot);
        assert_eq!(
            meta.source_manifest_sha256,
            source.snapshot.as_ref().map(|s| digest(s.as_bytes()))
        );
        assert_eq!(meta.observed_source_end_ms, Some(1106.4));
        assert!(
            meta.final_visibility_extension_ms > 0.0
                && meta.final_visibility_extension_ms < 2.0 * q as f64
        );
        assert!(final_row.final_observation_visibility);
        assert_eq!(
            final_row.source.as_ref().unwrap(),
            &model::reference(m.frames.last().unwrap())
        );
        assert_eq!(
            final_row.pts_ms,
            if format == "gif" { 1110.0 } else { 1107.0 }
        );
        assert_eq!(final_row.duration_ms, q as f64);
        assert_eq!(
            facts.exact_end_ms().unwrap(),
            if format == "gif" { 1120 } else { 1108 }
        );
        assert_eq!(final_row.phase.as_deref(), Some("air collision"));
        assert_eq!(final_row.marks, ["FINAL"]);
        let pixel = last_pixel(&output.video);
        assert!(
            pixel[1] > 180 && pixel[0] < 60,
            "final pixels must really be encoded: {pixel:?}"
        );
        offline_v2::verify(
            &meta,
            &fs::read(&output.timeline).unwrap(),
            &hash_file(&output.video).unwrap(),
            &facts,
        )
        .unwrap();
        retain(&output);
        let input_hash = hash_file(&output.video).unwrap();
        let mut a = args(temp.0.join(format!("v2 derived {format}.mp4")), 2);
        a.watermark = "task".into();
        offline::run(
            &output.video,
            Some(&output.metadata),
            Some(&output.timeline),
            &a,
        )
        .unwrap();
        let derived: v2::ArtifactMetadata = serde_json::from_slice(
            &fs::read(a.out.as_ref().unwrap().with_extension("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(derived.provenance, Provenance::OfflineVerifiedSidecar);
        assert_eq!(derived.source_manifest_json, source.snapshot);
        assert_eq!(derived.parent_export_id, Some(meta.export_id));
        assert_eq!(derived.input_video, Some(input_hash.clone()));
        assert_eq!(hash_file(&output.video).unwrap(), input_hash);
    }
}
#[test]
fn real_quantum_equal_tick_deadline_and_failed_final_cases() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    for case in [
        "boundary",
        "just_after_quantum",
        "equal_tick",
        "ordinary_final",
        "deadline",
        "deadline_max",
        "failed_final",
        "persisted_without_end",
    ] {
        for format in ["gif", "mp4", "mov"] {
            let mut source = synthetic(&temp);
            let m = source.snapshot_v2.as_mut().unwrap();
            match case {
                "boundary" => {
                    let f = &mut m.frames[1];
                    f.t_ms = 1100.0;
                    f.observation.response_received_ms = 1100.0;
                    f.observation.geometry_validated_ms = 1100.0;
                    m.end.duration_ms = 1100.0;
                    m.end.cutoff.t_ms = 1100.0;
                }
                "just_after_quantum" => {
                    let f = &mut m.frames[1];
                    f.t_ms = 1100.0000000000002;
                    f.observation.response_received_ms = f.t_ms;
                    f.observation.geometry_validated_ms = 1100.0000000000005;
                    m.end.duration_ms = f.observation.geometry_validated_ms;
                    m.end.cutoff.t_ms = m.end.duration_ms;
                }
                "equal_tick" => {
                    m.frames[0].t_ms = 1000.0;
                    m.frames[0].observation.response_received_ms = 1000.0;
                    m.frames[0].observation.geometry_validated_ms = 1000.0;
                    let f = &mut m.frames[1];
                    f.t_ms = 1000.0;
                    f.observation.request_started_ms = 1000.0;
                    f.observation.response_received_ms = 1000.0;
                    f.observation.geometry_validated_ms = 1000.0;
                    m.end.duration_ms = 1000.0;
                    m.end.cutoff.t_ms = 1000.0;
                }
                "ordinary_final" => {
                    m.frames[1].t_ms = 1001.0;
                    m.frames[1].observation.response_received_ms = 1001.0;
                }
                "deadline" | "deadline_max" | "failed_final" => {
                    m.frames.truncate(1);
                    source.frames.truncate(1);
                    m.end.final_seq = 1;
                    m.spool_bytes = m.frames[0].length;
                    m.spool_sha256 = m.frames[0].sha256.clone();
                    m.end.duration_ms = 1106.0;
                    m.end.cutoff.t_ms = 1106.0;
                    m.end.counters.as_mut().unwrap().requests_started = 1;
                    m.end.counters.as_mut().unwrap().responses_received = 1;
                    m.end.counters.as_mut().unwrap().frames_sent = 1;
                    if case.starts_with("deadline") {
                        if case == "deadline_max" {
                            m.end.duration_ms = 60000.0;
                            m.end.cutoff.t_ms = 60000.0;
                        }
                        m.config.max_duration_ms = m.end.duration_ms as u64;
                        m.end.reason = v2::EndReason::Deadline;
                        m.end.cutoff.provenance = v2::CutoffProvenance::Deadline;
                        m.end.stop_requested_ms = None;
                        m.end.final_observation = v2::FinalObservation::NotRequested;
                    } else {
                        m.state = State::Failed;
                        m.end.reason = v2::EndReason::FinalObservationFailed;
                        m.end.cutoff.provenance = v2::CutoffProvenance::AdmissionClosed;
                        m.end.final_observation = v2::FinalObservation::Failed {
                            attempt: None,
                            reason: v2::FinalFailure::Deadline,
                        };
                    }
                }
                "persisted_without_end" => {
                    m.state = State::Failed;
                    m.end.reason = v2::EndReason::ControlError;
                    m.end.duration_observed = false;
                    m.end.cutoff.provenance = v2::CutoffProvenance::DurableLowerBound;
                    m.end.stop_requested_ms = None;
                    m.end.counters = None;
                    m.end.final_observation = v2::FinalObservation::PersistedWithoutEnd {
                        request_id: m.frames[1].observation.request_id.clone(),
                        seq: 2,
                    };
                }
                _ => unreachable!(),
            }
            sync(&mut source);
            let (out, meta, rows) = encode(
                &source,
                &args(temp.0.join(format!("v2-{case}-{format}.{format}")), 1),
            );
            let partial = matches!(case, "failed_final" | "persisted_without_end");
            assert_eq!(meta.partial, partial);
            assert_eq!(
                meta.observed_source_end_ms.is_none(),
                case == "persisted_without_end"
            );
            if matches!(
                case,
                "deadline" | "deadline_max" | "failed_final" | "ordinary_final"
            ) {
                assert!(!rows.iter().any(|r| r.final_observation_visibility));
            } else {
                assert!(rows.last().unwrap().final_observation_visibility);
            }
            if case == "deadline" {
                let mut bad = meta.clone();
                let mut wrong_end = source.snapshot_v2.as_ref().unwrap().clone();
                wrong_end.config.max_duration_ms = 60000;
                wrong_end.end.duration_ms = 60000.0;
                wrong_end.end.cutoff.t_ms = 60000.0;
                wrong_end.validate().unwrap();
                let raw = serde_json::to_string(&wrong_end).unwrap();
                bad.source_manifest_sha256 = Some(digest(raw.as_bytes()));
                bad.source_manifest_json = Some(raw);
                bad.observed_source_end_ms = Some(60000.0);
                assert!(
                    offline_v2::verify(
                        &bad,
                        &fs::read(&out.timeline).unwrap(),
                        &hash_file(&out.video).unwrap(),
                        &export::probe(&out.video).unwrap()
                    )
                    .is_err(),
                    "truncated deadline must not authenticate as complete"
                );
            }
            if case.starts_with("deadline") {
                assert!(meta.duration_ms <= source.duration_ms);
                assert!(
                    rows.iter()
                        .all(|r| r.source.as_ref().unwrap().observation.purpose
                            == v2::Purpose::Sample)
                );
            }
            if case == "persisted_without_end" {
                assert!(model::ValidatedSource::parse(
                    source.snapshot.as_ref().unwrap(),
                    &source.snapshot_v2.as_ref().unwrap().instance_id,
                    &source.snapshot_v2.as_ref().unwrap().identity,
                    false
                )
                .is_err());
            }
            let facts = export::probe(&out.video).unwrap();
            offline_v2::verify(
                &meta,
                &fs::read(&out.timeline).unwrap(),
                &hash_file(&out.video).unwrap(),
                &facts,
            )
            .unwrap_or_else(|e| {
                panic!(
                    "{case}/{format}: {e:#}; duration={} exact={:?}",
                    meta.duration_ms,
                    facts.exact_end_ms()
                )
            });
            retain(&out);
            if case == "persisted_without_end" {
                let a = args(temp.0.join(format!("partial-derived-{format}.mov")), 2);
                offline::run(&out.video, Some(&out.metadata), Some(&out.timeline), &a).unwrap();
                let derived: v2::ArtifactMetadata = serde_json::from_slice(
                    &fs::read(a.out.unwrap().with_extension("metadata.json")).unwrap(),
                )
                .unwrap();
                assert!(derived.partial && derived.observed_source_end_ms.is_none());
                assert_eq!(derived.source_manifest_json, source.snapshot);
                let v2::SourceManifest::V2(original) =
                    v2::parse_source_manifest(derived.source_manifest_json.as_ref().unwrap())
                        .unwrap()
                else {
                    panic!()
                };
                assert!(
                    !original.end.duration_observed
                        && original.end.stop_requested_ms.is_none()
                        && original.end.counters.is_none()
                );
            }
        }
    }
}
#[test]
fn v2_authentication_rejects_contradictions_without_fallback() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let source = synthetic(&temp);
    let (out, meta, rows) = encode(&source, &args(temp.0.join("auth.mp4"), 1));
    let facts = export::probe(&out.video).unwrap();
    let hash = hash_file(&out.video).unwrap();
    let data = fs::read(&out.timeline).unwrap();
    for case in 0..12 {
        let mut bad = meta.clone();
        let mut altered = rows.clone();
        let mut bytes = data.clone();
        match case {
            0 => bad.identity.as_mut().unwrap().record_id = "wrong".into(),
            1 => bad.source_manifest_sha256 = Some("0".repeat(64)),
            2 => bad.video.sha256 = "0".repeat(64),
            3 => bad.timeline.sha256 = "0".repeat(64),
            4 => {
                altered
                    .last_mut()
                    .unwrap()
                    .source
                    .as_mut()
                    .unwrap()
                    .observation
                    .request_started_ms += 0.1;
            }
            5 => altered.last_mut().unwrap().final_observation_visibility = false,
            6 => altered[0].final_observation_visibility = true,
            7 => {
                altered.last_mut().unwrap().source = Some(model::reference(
                    &source.snapshot_v2.as_ref().unwrap().frames[0],
                ))
            }
            8 => altered.last_mut().unwrap().pts_ms -= 1.0,
            9 => bad.observed_source_end_ms = None,
            10 => altered[0].schema_version = 1,
            _ => altered[0].duration_ms += 0.001,
        }
        if case >= 4 && case != 9 {
            bytes = altered
                .iter()
                .map(|r| serde_json::to_string(r).unwrap() + "\n")
                .collect::<String>()
                .into_bytes();
            bad.timeline = HashedFile {
                bytes: bytes.len() as u64,
                sha256: digest(&bytes),
            };
        }
        assert!(
            offline_v2::verify(&bad, &bytes, &hash, &facts).is_err(),
            "tamper {case}"
        );
        let bad_path = temp.0.join(format!("bad-{case}.json"));
        fs::write(&bad_path, serde_json::to_vec(&bad).unwrap()).unwrap();
        let timeline = temp.0.join(format!("bad-{case}.jsonl"));
        fs::write(&timeline, bytes).unwrap();
        let a = args(temp.0.join(format!("rejected-{case}.mp4")), 1);
        assert!(offline::run(&out.video, Some(&bad_path), Some(&timeline), &a).is_err());
        assert!(!a.out.unwrap().exists());
    }
    let raw = source.snapshot.as_ref().unwrap();
    let m = source.snapshot_v2.as_ref().unwrap();
    for mutation in 0..5 {
        let mut value: Value = serde_json::from_str(raw).unwrap();
        match mutation {
            0 => value["protocol_version"] = json!(9),
            1 => value["backend"] = json!("screencast"),
            2 => value["identity"]["record_id"] = json!("wrong"),
            3 => {
                value["frames"][1]["observation"]["request_id"] =
                    value["frames"][0]["observation"]["request_id"].clone()
            }
            _ => value["frames"][1]["observation"]["purpose"] = json!("sample"),
        }
        assert!(model::ValidatedSource::parse(
            &value.to_string(),
            &m.instance_id,
            &m.identity,
            true
        )
        .is_err());
    }
    let path = if let export::FrameData::Jpeg(p) = &source.frames[1].data {
        p
    } else {
        panic!()
    };
    fs::write(path, b"not authentic JPEG").unwrap();
    let a = args(temp.0.join("mutated-source.mp4"), 1);
    let plan = export::Plan::new(&a, Labels::new(), None, true).unwrap();
    let output = Output::new(a.out.as_deref(), true, None).unwrap();
    assert!(export::encode(&source, &plan, &output).is_err());
    assert!(!output.video.exists());
}
#[test]
fn capability_schema_errors_and_public_no_out_are_pre_capture() {
    let good = json!({"host":{"protocol_version":2,"backend":"cdp_capture_screenshot"},"extension":{"protocol_version":2,"backend":"cdp_capture_screenshot"},"legacy_v1_read_only":true});
    validate_capabilities(good.clone()).unwrap();
    for side in ["host", "extension"] {
        let mut v = good.clone();
        v[side]["protocol_version"] = json!(1);
        assert_eq!(
            error_code(&validate_capabilities(v).unwrap_err()),
            Some(v2::UNSUPPORTED_VERSION)
        );
        let mut v = good.clone();
        v[side]["backend"] = json!("old_stream");
        assert_eq!(
            error_code(&validate_capabilities(v).unwrap_err()),
            Some(v2::UNSUPPORTED_BACKEND)
        );
    }
    let mut malformed = good.clone();
    malformed["host"]["protocol_version"] = json!("2");
    assert_ne!(
        error_code(&validate_capabilities(malformed).unwrap_err()),
        Some(v2::UNSUPPORTED_VERSION)
    );
    for tail in [
        vec!["record"],
        vec!["record", "export", "instance:epoch:record"],
    ] {
        let cli = crate::Cli::try_parse_from(std::iter::once("ap-browser").chain(tail)).unwrap();
        let crate::Cmd::Record(ref args) = cli.command else {
            panic!()
        };
        let error = run_inner(&cli, args).unwrap_err();
        assert!(format!("{error:#}").contains("explicit --out"));
    }
}
#[cfg(unix)]
#[test]
fn negotiation_exact_empty_body_no_target_hints_and_no_fallback() {
    assert!(transport::remote_endpoint().is_none());
    for old in [false, true] {
        let instance = id();
        let name = transport::instance_name(&instance);
        let listener = std::os::unix::net::UnixListener::bind(&name).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let req = crate::cli_frame::read_response(&mut stream, Duration::from_secs(1)).unwrap();
            assert_eq!(req["method"], "record.capabilities");
            assert_eq!(req["params"], json!({}));
            let reply = if old {
                json!({"error":{"code":-32601,"message":"Method not found"}})
            } else {
                json!({"result":{"ok":true,"data":{"host":{"protocol_version":2,"backend":"cdp_capture_screenshot"},"extension":{"protocol_version":2,"backend":"cdp_capture_screenshot"},"legacy_v1_read_only":true}}})
            };
            stream
                .write_all(&crate::cli_frame::encode(&reply).unwrap())
                .unwrap();
            stream.flush().unwrap();
            drop(listener);
            let _ = fs::remove_file(name);
        });
        let result = negotiate(&instance, Duration::from_secs(1));
        if old {
            assert_eq!(
                error_code(&result.unwrap_err()),
                Some(v2::UNSUPPORTED_VERSION)
            );
        } else {
            result.unwrap();
        }
        server.join().unwrap();
    }
}
