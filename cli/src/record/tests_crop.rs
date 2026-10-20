use super::*;
#[test]
fn actual_inward_crop_aspect_scale_and_no_upscale() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut source = super::tests::synthetic(&temp, true);
    let rect = Rect {
        x: 10.2,
        y: 5.2,
        width: 60.7,
        height: 40.7,
    };
    let m = source.manifest.as_mut().unwrap();
    m.resolved_region_css = rect.clone();
    m.config.region = Region::Rect { rect: rect.clone() };
    m.frames[0].geometry.crop_css = rect;
    validate::manifest(m, &m.instance_id, &m.identity, false).unwrap();
    source.snapshot = Some(serde_json::to_string(m).unwrap());
    for (size, expected) in [(32, (32, 21)), (480, (59, 39))] {
        let out = temp.0.join(format!("crop-{size}.gif"));
        let args = ExportArgs {
            out: Some(out.clone()),
            preset: "compact".into(),
            fps: Some(4),
            size: Some(size),
            watermark: "none".into(),
            ..Default::default()
        };
        let plan = export::Plan::new(&args, Labels::new(), None, true).unwrap();
        let output = Output::new(Some(&out), false, None).unwrap();
        export::encode(&source, &plan, &output).unwrap();
        let facts = export::probe(&out).unwrap();
        assert_eq!((facts.width, facts.height), expected);
        assert!((facts.duration_ms - 5030.0).abs() < 10.1);
    }
    // Source-only tokens are rejected before unverified offline rendering.
    let mut t = template::task(&Labels::new());
    t.items[0].text = Text::Template("{source_seq}:{source_t_ms}:{record_id}".into());
    assert!(template::validate(&t, &Labels::new(), false).is_err());
    template::validate(&t, &Labels::new(), true).unwrap();
}
