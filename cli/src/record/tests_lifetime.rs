//! CLI-side lifetime regressions using only owned disposable local IPC.
//! Native EOF/unregister/process behavior itself belongs to host-lane tests.
use super::*;
use std::{os::unix::net::UnixListener, thread::JoinHandle};

fn fake_host(h: &Handle, replies: Vec<Option<Value>>) -> JoinHandle<Vec<Value>> {
    assert!(
        transport::remote_endpoint().is_none(),
        "lifetime test refuses a configured external browser bridge"
    );
    let name = transport::instance_name(&h.instance);
    let listener = UnixListener::bind(&name).unwrap();
    let identity = h.identity.clone();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            let request =
                crate::cli_frame::read_response(&mut stream, Duration::from_secs(1)).unwrap();
            assert_eq!(
                request["params"]["identity"],
                serde_json::to_value(&identity).unwrap()
            );
            assert!(request["params"].get("out").is_none());
            requests.push(request);
            if let Some(reply) = reply {
                stream
                    .write_all(&crate::cli_frame::encode(&reply).unwrap())
                    .unwrap();
                stream.flush().unwrap();
            }
            // None drops the connection without a reply: a real read EOF.
        }
        drop(listener);
        let _ = fs::remove_file(name);
        requests
    })
}
fn handle() -> Handle {
    Handle {
        instance: id(),
        identity: Identity {
            host_epoch: "old_epoch".into(),
            record_id: "old_record".into(),
        },
    }
}

#[test]
fn lost_or_replaced_host_surfaces_errors_without_video_or_new_epoch_retry() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let copied = temp.0.join("already-copied.source");
    write_new(&copied, b"caller-owned bytes").unwrap();
    let published = temp.0.join("previous-final.mp4");
    write_new(&published, b"previous published artifact").unwrap();
    let copied_hash = hash_file(&copied).unwrap();
    let published_hash = hash_file(&published).unwrap();
    for (n, code) in [None, Some("RECORD_NOT_FOUND"), Some("RECORD_STALE_HOST")]
        .iter()
        .enumerate()
    {
        let h = handle();
        let reply = code.map(
            |code| json!({"error":{"code":code,"message":"source unavailable on this host epoch"}}),
        );
        let server = fake_host(&h, vec![reply]);
        let out = temp.0.join(format!("unavailable-{n}.mp4"));
        let args = ExportArgs {
            out: Some(out.clone()),
            preset: "tiny".into(),
            metadata: true,
            partial: true,
            ..Default::default()
        };
        let error = export_record(&h, &args, Duration::from_secs(1)).unwrap_err();
        if let Some(code) = code {
            assert_eq!(error_code(&error), Some(*code));
        } else {
            assert!(
                format!("{error:#}").contains("read header"),
                "transport EOF must remain visible: {error:#}"
            );
        }
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "record.manifest");
        assert!(!out.exists());
        assert!(!out.with_extension("metadata.json").exists());
        assert!(!out.with_extension("timeline.jsonl").exists());
        assert_eq!(hash_file(&copied).unwrap(), copied_hash);
        assert_eq!(hash_file(&published).unwrap(), published_hash);
        assert_eq!(h.identity.host_epoch, "old_epoch");
    }
}

#[test]
fn fully_copied_source_encodes_after_original_host_ipc_is_gone() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let h = handle();
    let mut m: v2::Manifest = serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording-v2/manifest.json"
    ))
    .unwrap();
    m.identity = h.identity.clone();
    m.instance_id = h.instance.clone();
    let wire: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/recording/wire.json")).unwrap();
    let jpeg = STANDARD
        .decode(wire["frame"]["params"]["jpeg_base64"].as_str().unwrap())
        .unwrap();
    let spool = [jpeg.clone(), jpeg].concat();
    let chunk = Chunk {
        identity: h.identity.clone(),
        offset: 0,
        length: spool.len() as u32,
        total_bytes: spool.len() as u64,
        sha256: digest(&spool),
        data_base64: STANDARD.encode(spool),
        eof: true,
    };
    let server = fake_host(
        &h,
        vec![
            Some(json!({"result":{"ok":true,"data":m}})),
            Some(json!({"result":{"ok":true,"data":chunk}})),
        ],
    );
    let value = rpc(
        &h.instance,
        method::MANIFEST,
        h.params(),
        Duration::from_secs(1),
    )
    .unwrap();
    let snapshot = serde_json::to_string(&value).unwrap();
    let m: v2::Manifest = serde_json::from_value(value).unwrap();
    model::validate_v2(&m, &h.instance, &h.identity, false).unwrap();
    let out = temp.0.join("encoded-after-host-exit.mp4");
    let output = Output::new(Some(&out), true, None).unwrap();
    let frames = fetch(&h, &m, &output.temp, Duration::from_secs(1)).unwrap();
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        std::os::unix::net::UnixStream::connect(transport::instance_name(&h.instance)).is_err()
    );
    let args = ExportArgs {
        out: Some(out.clone()),
        preset: "tiny".into(),
        fps: Some(2),
        metadata: true,
        ..Default::default()
    };
    let plan = export::Plan::new(
        &args,
        m.config.labels.clone(),
        m.config.run_id.clone(),
        true,
    )
    .unwrap();
    let source = export::Source {
        frames,
        duration_ms: m.end.duration_ms,
        manifest: None,
        snapshot_v2: Some(m),
        snapshot: Some(snapshot),
        provenance: Provenance::Recording,
        input_video: None,
        parent_export_id: None,
    };
    export::encode(&source, &plan, &output).unwrap();
    let facts = export::probe(&out).unwrap();
    assert!((facts.duration_ms - 1108.0).abs() < 1.1);
    let metadata: ArtifactMetadata =
        serde_json::from_slice(&fs::read(&output.metadata).unwrap()).unwrap();
    assert_eq!(metadata.video, hash_file(&out).unwrap());
    assert_eq!(metadata.identity, Some(h.identity));
}
