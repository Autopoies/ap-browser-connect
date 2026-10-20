//! Focused transport, offline pairing and actual compositor regressions.
use super::*;
use clap::Parser;
use std::path::{Path, PathBuf};

fn parsed_export(args: &[&str]) -> ExportArgs {
    let c = crate::Cli::try_parse_from(std::iter::once("ap-browser").chain(args.iter().copied()))
        .unwrap();
    match c.command {
        crate::Cmd::Record(a) => a.export,
        _ => panic!(),
    }
}
fn source(temp: &Temp) -> export::Source {
    super::tests::synthetic(temp, true)
}

#[test]
fn verified_offline_pairing_and_repeat_clean_exports() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let s = source(&temp);
    let input = temp.0.join("original.mp4");
    let args = ExportArgs {
        out: Some(input.clone()),
        preset: "tiny".into(),
        fps: Some(4),
        watermark: "task".into(),
        metadata: true,
        ..Default::default()
    };
    let plan = export::Plan::new(
        &args,
        s.manifest.as_ref().unwrap().config.labels.clone(),
        None,
        true,
    )
    .unwrap();
    let output = Output::new(Some(&input), true, None).unwrap();
    export::encode(&s, &plan, &output).unwrap();
    let mut offline_args = ExportArgs {
        out: Some(temp.0.join("verified.mov")),
        preset: "tiny".into(),
        fps: Some(8),
        watermark: "task".into(),
        metadata: true,
        ..Default::default()
    };
    offline::run(
        &input,
        Some(&output.metadata),
        Some(&output.timeline),
        &offline_args,
    )
    .unwrap();
    let result: ArtifactMetadata =
        serde_json::from_slice(&fs::read(temp.0.join("verified.metadata.json")).unwrap()).unwrap();
    let original: ArtifactMetadata =
        serde_json::from_slice(&fs::read(&output.metadata).unwrap()).unwrap();
    assert_eq!(result.provenance, Provenance::OfflineVerifiedSidecar);
    assert_eq!(result.parent_export_id, Some(original.export_id.clone()));
    assert_eq!(result.source_manifest_json, original.source_manifest_json);
    assert_ne!(result.export_id, original.export_id);
    // Shared fixture uses phase:"" for a cleared phase; omission/None carries
    // the same fact. A correctly re-hashed authentic sidecar must accept both.
    let rows = fs::read_to_string(&output.timeline)
        .unwrap()
        .lines()
        .map(|line| {
            let mut row: OutputFrame = serde_json::from_str(line).unwrap();
            if row.phase.is_none() {
                row.phase = Some(String::new());
            }
            serde_json::to_string(&row).unwrap() + "\n"
        })
        .collect::<String>();
    let variant_timeline = temp.0.join("empty-phase.timeline.jsonl");
    write_new(&variant_timeline, rows.as_bytes()).unwrap();
    let mut variant = original.clone();
    variant.timeline = HashedFile {
        bytes: rows.len() as u64,
        sha256: digest(rows.as_bytes()),
    };
    let variant_metadata = temp.0.join("empty-phase.metadata.json");
    write_new(&variant_metadata, &serde_json::to_vec(&variant).unwrap()).unwrap();
    let mut variant_args = offline_args.clone();
    variant_args.out = Some(temp.0.join("empty-phase-verified.mp4"));
    offline::run(
        &input,
        Some(&variant_metadata),
        Some(&variant_timeline),
        &variant_args,
    )
    .unwrap();
    // No fallback on tampered video/timeline/source facts.
    offline_args.out = Some(temp.0.join("rejected.mp4"));
    let mut bad = original.clone();
    bad.video.sha256 = "0".repeat(64);
    let bad_meta = temp.0.join("bad.metadata.json");
    write_new(&bad_meta, &serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(offline::run(
        &input,
        Some(&bad_meta),
        Some(&output.timeline),
        &offline_args
    )
    .is_err());
    assert!(!offline_args.out.as_ref().unwrap().exists());
    let bad_timeline = temp.0.join("bad.timeline.jsonl");
    write_new(&bad_timeline, b"{}\n").unwrap();
    assert!(offline::run(
        &input,
        Some(&output.metadata),
        Some(&bad_timeline),
        &offline_args
    )
    .is_err());
    let mut bad = original;
    bad.source_manifest_sha256 = Some("0".repeat(64));
    fs::write(&bad_meta, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(offline::run(
        &input,
        Some(&bad_meta),
        Some(&output.timeline),
        &offline_args
    )
    .is_err());
    // A different container renamed .mp4 must not be accepted by auto-probing.
    let disguised = temp.0.join("not-a-mp4.mp4");
    process(
        ffmpeg()
            .arg("-i")
            .arg(&input)
            .args(["-map", "0:v:0", "-c", "copy", "-f", "avi", "-n"])
            .arg(&disguised),
        Duration::from_secs(10),
        65536,
    )
    .unwrap();
    assert!(offline::run(&disguised, None, None, &offline_args).is_err());
    assert!(!offline_args.out.as_ref().unwrap().exists());
    // Clean source still supports a genuinely clean new export, not watermarked input.
    let clean = temp.0.join("clean.gif");
    let clean_args = ExportArgs {
        out: Some(clean.clone()),
        preset: "tiny".into(),
        fps: Some(4),
        watermark: "none".into(),
        ..Default::default()
    };
    let clean_plan = export::Plan::new(&clean_args, Labels::new(), None, true).unwrap();
    let clean_out = Output::new(Some(&clean), false, None).unwrap();
    export::encode(&s, &clean_plan, &clean_out).unwrap();
    let facts = export::probe(&clean).unwrap();
    assert_eq!((facts.width, facts.height), (101, 77));
    assert!(!clean_out.metadata.exists());
}

#[test]
fn custom_overlay_literal_and_cjk_actual_encode() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut s = source(&temp);
    s.duration_ms = 1010.0;
    s.manifest.as_mut().unwrap().end.duration_ms = 1010.0;
    s.snapshot = Some(serde_json::to_string(s.manifest.as_ref().unwrap()).unwrap());
    let font = Path::new("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc");
    let cjk = font.exists();
    let text = if cjk {
        "碰撞 '%{x}: [v]; /not-a-filter {phase}"
    } else {
        "collision '%{x}: [v]; /not-a-filter {phase}"
    };
    let template = Template {
        version: 1,
        layout: Layout::Overlay,
        strip_height: None,
        items: vec![TextItem {
            text: Text::Literal(text.into()),
            anchor: Anchor::TopLeft,
            x: 2,
            y: 2,
            font_size: 10,
            font_path: cjk.then(|| font.to_str().unwrap().into()),
            color: "#ffeecc".into(),
            background: Some("#103050".into()),
            opacity: 0.8,
            interval: Some(Interval {
                start_ms: 100,
                end_ms: 900,
            }),
            update_interval_ms: 0,
        }],
    };
    let config = temp.0.join("custom ' 空 [v].json");
    write_new(&config, &serde_json::to_vec(&template).unwrap()).unwrap();
    let out = temp.0.join("custom ' 空 ;[v] output.mov");
    let args = ExportArgs {
        out: Some(out.clone()),
        preset: "compact".into(),
        fps: Some(8),
        watermark_config: Some(config),
        ..Default::default()
    };
    let plan = export::Plan::new(&args, Labels::new(), None, true).unwrap();
    let output = Output::new(Some(&out), true, None).unwrap();
    export::encode(&s, &plan, &output).unwrap();
    let facts = export::probe(&out).unwrap();
    assert_eq!((facts.width, facts.height), (102, 78));
    assert!((facts.duration_ms - 1010.0).abs() < 1.1);
    assert!(!temp.0.join("not-a-filter").exists());
    let no_source = parsed_export(&[
        "record",
        "--out",
        "x.mp4",
        "--watermark-config",
        output.metadata.to_str().unwrap(),
    ]);
    assert!(export::Plan::new(&no_source, Labels::new(), None, false).is_err());
}

#[test]
fn short_and_fractional_fps_real_format_durations() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut s = source(&temp);
    s.frames[0].t_ms = 0.0;
    s.manifest.as_mut().unwrap().frames[0].t_ms = 0.0;
    s.manifest.as_mut().unwrap().events.clear();
    for format in ["gif", "mp4", "mov"] {
        for duration in [10.0, 101.0, 1500.0] {
            s.duration_ms = duration;
            s.manifest.as_mut().unwrap().end.duration_ms = duration;
            s.snapshot = Some(serde_json::to_string(s.manifest.as_ref().unwrap()).unwrap());
            let out = temp.0.join(format!("{format}-{duration}.{format}"));
            let args = ExportArgs {
                out: Some(out.clone()),
                preset: "balanced".into(),
                fps: Some(15),
                colors: Some(2),
                watermark: "none".into(),
                ..Default::default()
            };
            let plan = export::Plan::new(&args, Labels::new(), None, true).unwrap();
            let output = Output::new(Some(&out), false, None).unwrap();
            export::encode(&s, &plan, &output).unwrap();
            let facts = export::probe(&out).unwrap();
            assert!(
                (facts.duration_ms - duration).abs() <= if format == "gif" { 10.0 } else { 1.0 }
            );
            if format == "mp4" {
                let b = fs::read(&out).unwrap();
                let pos = |s: &[u8]| b.windows(s.len()).position(|w| w == s).unwrap();
                assert!(pos(b"moov") < pos(b"mdat"));
            }
        }
    }
}

#[test]
fn publication_missing_sidecar_rolls_back_and_private_permissions() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let out = temp.0.join("out.mp4");
    let output = Output::new(Some(&out), true, None).unwrap();
    write_new(&output.temp.0.join("video"), b"video").unwrap();
    assert!(output.publish().is_err());
    assert!(!out.exists());
    let args = ExportArgs {
        out: Some(temp.0.join("no-extension")),
        preset: "tiny".into(),
        ..Default::default()
    };
    assert!(export::Plan::new(&args, Labels::new(), None, true).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&output.temp.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(output.temp.0.join("video"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let denied = temp.0.join("denied");
        fs::create_dir(&denied).unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o500)).unwrap();
        let result = Output::new(Some(&denied.join("no.mp4")), false, None);
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        if result.is_ok() {
            // A privileged container user can bypass Unix directory permissions.
            // Ordinary-user gates exercise the denial; do not mislabel root as
            // a product write-permission regression.
            eprintln!("permission-denial assertion unavailable for privileged filesystem user");
        }
        let alias = temp.0.join("alias.mp4");
        fs::hard_link(output.temp.0.join("video"), &alias).unwrap();
        assert!(Output::new(Some(&alias), false, Some(&output.temp.0.join("video"))).is_err());
        let symlink = temp.0.join("symlink.mp4");
        std::os::unix::fs::symlink(output.temp.0.join("video"), &symlink).unwrap();
        assert!(Output::new(Some(&symlink), false, None).is_err());
    }
    assert!(template::text_ok("\n\n\n\n\n\n\n\n", true).is_err());
}

#[cfg(unix)]
#[test]
fn fake_host_pinned_handle_stop_barrier_and_verified_chunk_export() {
    assert!(transport::remote_endpoint().is_none(),"local fake-host test requires AP_BROWSER_REMOTE unset; refusing to contact any configured external browser bridge");
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut manifest: v2::Manifest = serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording-v2/manifest.json"
    ))
    .unwrap();
    manifest.config.labels.clear();
    let instance = id();
    manifest.instance_id = instance.clone();
    let name = transport::instance_name(&instance);
    let listener = std::os::unix::net::UnixListener::bind(&name).unwrap();
    let wire: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/recording/wire.json")).unwrap();
    let jpeg = STANDARD
        .decode(wire["frame"]["params"]["jpeg_base64"].as_str().unwrap())
        .unwrap();
    let spool = [jpeg.clone(), jpeg].concat();
    let server_manifest = manifest.clone();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let mut stopped = false;
        // Exactly 7 one-request/one-response sockets: explicit start, stop,
        // status (durable seal), manifest, chunk, release, repeated release.
        for _ in 0..7 {
            let (mut stream, _) = listener.accept().unwrap();
            let request =
                crate::cli_frame::read_response(&mut stream, Duration::from_secs(1)).unwrap();
            let method = request["method"].as_str().unwrap();
            requests.push(method.to_owned());
            if method != "record.start" {
                assert_eq!(
                    request["params"]["identity"],
                    serde_json::to_value(&server_manifest.identity).unwrap()
                );
            }
            assert!(request["params"].get("out").is_none());
            let mut status = Status {
                protocol_version: 2,
                backend: v2::Backend::CdpCaptureScreenshot,
                identity: server_manifest.identity.clone(),
                operation_id: server_manifest.operation_id.clone(),
                instance_id: server_manifest.instance_id.clone(),
                tab_id: Some(server_manifest.tab_id),
                state: State::Recording,
                persisted_seq: 2,
                spool_bytes: spool.len() as u64,
                end: None,
            };
            let data = match method {
                "record.start" => serde_json::to_value(status).unwrap(),
                "record.stop" => {
                    stopped = true;
                    status.state = State::Stopping;
                    serde_json::to_value(status).unwrap()
                }
                "record.status" => {
                    assert!(stopped);
                    status.state = State::Sealed;
                    status.end = Some(server_manifest.end.clone());
                    serde_json::to_value(status).unwrap()
                }
                "record.manifest" => serde_json::to_value(&server_manifest).unwrap(),
                "record.read" => {
                    let offset = request["params"]["offset"].as_u64().unwrap();
                    let len = request["params"]["length"].as_u64().unwrap();
                    let data = &spool[offset as usize..(offset + len) as usize];
                    serde_json::to_value(Chunk {
                        identity: server_manifest.identity.clone(),
                        offset,
                        length: len as u32,
                        total_bytes: spool.len() as u64,
                        sha256: digest(data),
                        data_base64: STANDARD.encode(data),
                        eof: offset + len == spool.len() as u64,
                    })
                    .unwrap()
                }
                "record.release" => serde_json::to_value(Released {
                    identity: server_manifest.identity.clone(),
                    released: true,
                })
                .unwrap(),
                _ => panic!("unexpected RPC"),
            };
            stream
                .write_all(
                    &crate::cli_frame::encode(&json!({"result":{"ok":true,"data":data}})).unwrap(),
                )
                .unwrap();
            stream.flush().unwrap();
        }
        requests
    });
    let request = StartRequest {
        protocol_version: 2,
        backend: v2::Backend::CdpCaptureScreenshot,
        operation_id: manifest.operation_id.clone(),
        tab_id: Some(manifest.tab_id),
        config: manifest.config.clone(),
    };
    let s: Status = serde_json::from_value(
        rpc(
            &instance,
            method::START,
            serde_json::to_value(request).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap(),
    )
    .unwrap();
    let h = Handle {
        instance: instance.clone(),
        identity: s.identity,
    };
    let sealed = stop(&h, Duration::from_secs(2)).unwrap();
    assert_eq!(sealed.state, State::Sealed);
    let args = ExportArgs {
        out: Some(temp.0.join("fake host export.mp4")),
        preset: "tiny".into(),
        fps: Some(2),
        watermark: "none".into(),
        metadata: true,
        ..Default::default()
    };
    export_record(&h, &args, Duration::from_secs(2)).unwrap();
    for _ in 0..2 {
        let r = rpc(
            &instance,
            method::RELEASE,
            h.params(),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(r["released"], true);
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[1..3], ["record.stop", "record.status"]);
    let _ = fs::remove_file(PathBuf::from(name));
}
