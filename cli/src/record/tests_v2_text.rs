//! Real v2 annotation/offline compatibility tests, synthetic media only.
use super::*;
#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
#[test]
fn v2_task_cjk_custom_literals_and_unverified_offline() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut source = super::tests_v2::synthetic(&temp);
    let font = Path::new("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc");
    // Explicit environment capability failure is not a skipped CJK PASS.
    assert!(
        font.exists(),
        "this local CJK regression requires existing Hiragino font"
    );
    let m = source.snapshot_v2.as_mut().unwrap();
    m.config
        .labels
        .insert("test.case".into(), "碰撞 空 格".into());
    m.events[0].kind = EventKind::Phase {
        text: "碰撞".into(),
    };
    m.events[1].kind = EventKind::Mark {
        text: "碰撞".into(),
        duration_ms: 1000,
    };
    super::tests_v2::sync(&mut source);
    let task = ExportArgs {
        out: Some(temp.0.join("v2-cjk-task.mp4")),
        watermark: "task".into(),
        font: Some(font.into()),
        fps: Some(1),
        metadata: true,
        preset: "tiny".into(),
        ..Default::default()
    };
    let (out, meta, rows) = super::tests_v2::encode(&source, &task);
    assert!(meta.height > 16);
    assert_eq!(meta.labels["test.case"], "碰撞 空 格");
    assert_eq!(rows.last().unwrap().phase.as_deref(), Some("碰撞"));
    assert_eq!(rows.last().unwrap().marks, ["碰撞"]);
    super::tests_v2::retain(&out);
    let custom = Template {
        version: 1,
        layout: Layout::Overlay,
        strip_height: None,
        items: vec![TextItem {
            text: Text::Literal("碰撞 '%{x}: [v]; /not-a-filter {phase}".into()),
            anchor: Anchor::TopLeft,
            x: 0,
            y: 0,
            font_size: 6,
            font_path: Some(font.to_str().unwrap().into()),
            color: "#ffffff".into(),
            background: Some("#223344".into()),
            opacity: 1.0,
            interval: None,
            update_interval_ms: 0,
        }],
    };
    let config = temp.0.join("v2 custom '% 空.json");
    fs::write(&config, serde_json::to_vec(&custom).unwrap()).unwrap();
    let a = ExportArgs {
        out: Some(temp.0.join("v2-cjk-custom.mov")),
        watermark_config: Some(config),
        fps: Some(1),
        metadata: true,
        preset: "tiny".into(),
        ..Default::default()
    };
    let (custom, _, _) = super::tests_v2::encode(&source, &a);
    assert!(!temp.0.join("not-a-filter").exists());
    super::tests_v2::retain(&custom);
    let before = hash_file(&out.video).unwrap();
    let a = ExportArgs {
        out: Some(temp.0.join("v2-untagged-offline.mp4")),
        watermark: "task".into(),
        metadata: true,
        preset: "tiny".into(),
        ..Default::default()
    };
    offline::run(&out.video, None, None, &a).unwrap();
    let p = a.out.unwrap();
    let unverified: v2::ArtifactMetadata =
        serde_json::from_slice(&fs::read(p.with_extension("metadata.json")).unwrap()).unwrap();
    assert_eq!(unverified.provenance, Provenance::OfflineUnverified);
    assert!(
        unverified.identity.is_none()
            && unverified.backend.is_none()
            && unverified.source_protocol_version.is_none()
            && unverified.source_manifest_json.is_none()
            && unverified.observed_source_end_ms.is_none()
    );
    let rows: Vec<v2::OutputFrame> = fs::read_to_string(p.with_extension("timeline.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(rows.iter().all(|r| r.source.is_none()
        && r.normalization_hold.is_none()
        && r.phase.is_none()
        && r.marks.is_empty()
        && !r.final_observation_visibility));
    assert_eq!(hash_file(&out.video).unwrap(), before);
}
#[test]
fn legacy_row_cross_version_contradictions_are_rejected() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let source = super::tests::synthetic(&temp, true);
    let a = ExportArgs {
        out: Some(temp.0.join("legacy-source.mp4")),
        metadata: true,
        preset: "tiny".into(),
        ..Default::default()
    };
    let plan = export::Plan::new(&a, Labels::new(), None, true).unwrap();
    let out = Output::new(a.out.as_deref(), true, None).unwrap();
    export::encode(&source, &plan, &out).unwrap();
    let original: ArtifactMetadata =
        serde_json::from_slice(&fs::read(&out.metadata).unwrap()).unwrap();
    assert_eq!(original.schema_version, 1);
    assert_eq!(original.source_manifest_json, source.snapshot);
    for field in ["source", "final_observation_visibility", "request_id"] {
        let mut rows = fs::read_to_string(&out.timeline)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect::<Vec<_>>();
        rows[0][field] = json!(false);
        let data = rows
            .iter()
            .map(|r| serde_json::to_string(r).unwrap() + "\n")
            .collect::<String>();
        let timeline = temp.0.join(format!("legacy-bad-{field}.jsonl"));
        fs::write(&timeline, &data).unwrap();
        let mut meta = original.clone();
        meta.timeline = HashedFile {
            bytes: data.len() as u64,
            sha256: digest(data.as_bytes()),
        };
        let sidecar = temp.0.join(format!("legacy-bad-{field}.json"));
        fs::write(&sidecar, serde_json::to_vec(&meta).unwrap()).unwrap();
        let args = ExportArgs {
            out: Some(temp.0.join(format!("legacy-rejected-{field}.mp4"))),
            preset: "tiny".into(),
            ..Default::default()
        };
        assert!(offline::run(&out.video, Some(&sidecar), Some(&timeline), &args).is_err());
        assert!(!args.out.unwrap().exists());
    }
}
