//! V2 uses its own validated readonly geometry, then the proven crop/resize encoder.
use super::*;
#[test]
fn v2_source_crop_is_inward_before_resize_and_padding() {
    let temp = Temp::new(&std::env::temp_dir()).unwrap();
    let mut source = super::tests_v2::synthetic(&temp);
    let m = source.snapshot_v2.as_mut().unwrap();
    let rect = Rect {
        x: 0.2,
        y: 0.2,
        width: 10.7,
        height: 10.7,
    };
    m.config.region = Region::Rect { rect: rect.clone() };
    m.resolved_region_css = rect.clone();
    for f in &mut m.frames {
        f.geometry.crop_css = rect.clone();
        assert_eq!(model::crop(f).unwrap(), (1, 1, 9, 9));
    }
    super::tests_v2::sync(&mut source);
    for format in ["gif", "mp4"] {
        let args = ExportArgs {
            out: Some(temp.0.join(format!("v2-crop-{format}.{format}"))),
            size: Some(16),
            fps: Some(1),
            metadata: true,
            preset: "tiny".into(),
            ..Default::default()
        };
        let (out, meta, _) = super::tests_v2::encode(&source, &args);
        let size = if format == "gif" { 9 } else { 10 };
        assert_eq!((meta.width, meta.height), (size, size));
        assert_eq!(meta.source_manifest_json, source.snapshot);
        super::tests_v2::retain(&out);
    }
}
