//! Recording v1 data contract. See `docs/recording-protocol.md` for routing and invariants.
//!
//! These are data types, not a capture/storage/export implementation. Deserialization
//! alone is not validation: receiving implementations must enforce the documented
//! cross-field, ordering, byte, finite-number and resource limits.
pub mod v2;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_DURATION_MS: u64 = 60_000;
pub const DEFAULT_DURATION_MS: u64 = 5_000;
pub const MAX_FRAME_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_SPOOL_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: u32 = 256 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAMES: usize = 1_800;
pub const MAX_EVENTS: usize = 1_024;
pub const MAX_RETAINED_RECORDINGS: usize = 4;
pub const MAX_TOTAL_SPOOL_BYTES: u64 = 512 * 1024 * 1024;
pub const RETENTION_MS: u64 = 15 * 60 * 1000;
pub const CREDIT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_LABELS: usize = 16;
pub const MAX_LABEL_BYTES: usize = 4_096;
pub const MAX_TEXT_BYTES: usize = 512;
pub const MAX_TEMPLATE_BYTES: usize = 32 * 1024;
pub const MAX_TEMPLATE_ITEMS: usize = 32;
pub const MAX_METADATA_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TIMELINE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub mod method {
    pub const START: &str = "record.start";
    pub const STOP: &str = "record.stop";
    pub const STATUS: &str = "record.status";
    pub const MANIFEST: &str = "record.manifest";
    pub const READ: &str = "record.read";
    pub const RELEASE: &str = "record.release";
    pub const PHASE: &str = "record.phase";
    pub const MARK: &str = "record.mark";
    pub const FRAME: &str = "record.frame";
    pub const EVENT: &str = "record.event";
    pub const ENDED: &str = "record.ended";
}

/// ASCII opaque token, not a path. The same grammar applies to operation/export/run IDs.
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Labels are unverified caller assertions; no automatic URL/page text collection.
pub type Labels = BTreeMap<String, String>;

pub fn validate_labels(labels: &Labels) -> Result<(), &'static str> {
    if labels.len() > MAX_LABELS {
        return Err("too many labels");
    }
    let mut bytes = 0;
    for (key, value) in labels {
        if key.is_empty()
            || key.len() > 64
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || value.len() > 256
            || value.chars().any(char::is_control)
        {
            return Err("invalid label");
        }
        bytes += key.len() + value.len();
    }
    if bytes > MAX_LABEL_BYTES {
        return Err("labels exceed byte budget");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub host_epoch: String,
    pub record_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Region {
    Viewport,
    Rect { rect: Rect },
    Element { selector: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureConfig {
    pub max_duration_ms: u64,
    pub capture_fps: u32,
    pub jpeg_quality: u32,
    pub region: Region,
    pub labels: Labels,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartRequest {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub config: CaptureConfig,
}

/// Host allocates slot + identity BEFORE sending this to the extension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionStart {
    #[serde(flatten)]
    pub request: StartRequest,
    pub identity: Identity,
    pub initial_credit: Credit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandleRequest {
    pub identity: Identity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StopRequest {
    pub identity: Identity,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Starting,
    Recording,
    Stopping,
    Sealed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub protocol_version: u32,
    pub identity: Identity,
    pub operation_id: String,
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub state: State,
    pub persisted_seq: u64,
    pub spool_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<End>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Started {
    pub identity: Identity,
    pub tab_id: i64,
    pub clock: Clock,
    pub resolved_region_css: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Clock {
    /// v1: "extension_performance"; t_ms = performance.now() - origin.
    pub source: String,
    /// v1: "before_start_screencast"; not a wall-clock or CDP timestamp.
    pub origin: String,
    /// null/absent means unknown, never implied zero uncertainty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncertainty_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CssToImage {
    pub scale_x: f64,
    pub scale_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub viewport_css: Rect,
    pub crop_css: Rect,
    /// image_x = viewport_css_x * scale_x + offset_x (likewise y).
    pub css_to_image: CssToImage,
    pub device_scale_factor: f64,
    pub page_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

/// A credit authorizes precisely next_seq, not an additive token count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub identity: Identity,
    pub next_seq: u64,
    pub max_frame_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub identity: Identity,
    pub seq: u64,
    pub t_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_timestamp_s: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub geometry: Geometry,
    pub jpeg_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameAccepted {
    pub accepted_seq: u64,
    pub credit: Credit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrameEntry {
    pub seq: u64,
    pub t_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_timestamp_s: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub geometry: Geometry,
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DropCounts {
    pub sampled: u64,
    pub backpressured: u64,
    pub invalid: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Stopped,
    Deadline,
    TabClosed,
    DebuggerDetached,
    NativeDisconnected,
    CreditTimeout,
    HostRestart,
    StorageLimit,
    GeometryChanged,
    InvalidFrame,
    StartFailed,
    /// CDP start/stop failed or timed out; backend shutdown may be unconfirmed.
    ControlError,
    NoFrames,
    StorageError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct End {
    pub final_seq: u64,
    pub duration_ms: f64,
    pub reason: EndReason,
    /// false on host-only interruption: duration is only an observed lower bound.
    pub duration_observed: bool,
    pub drops: DropCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ended {
    pub identity: Identity,
    pub end: End,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndAccepted {
    pub identity: Identity,
    pub state: State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhaseRequest {
    pub identity: Identity,
    pub operation_id: String,
    /// Empty text clears the persistent phase.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkRequest {
    pub identity: Identity,
    pub operation_id: String,
    pub text: String,
    pub duration_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub event_index: u64,
    pub operation_id: String,
    pub t_ms: f64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    Phase { text: String },
    Mark { text: String, duration_ms: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventRequest {
    pub identity: Identity,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub protocol_version: u32,
    pub identity: Identity,
    pub operation_id: String,
    pub instance_id: String,
    pub tab_id: i64,
    pub state: State,
    pub config: CaptureConfig,
    pub resolved_region_css: Rect,
    pub clock: Clock,
    pub end: End,
    pub frames: Vec<FrameEntry>,
    pub events: Vec<Event>,
    pub spool_bytes: u64,
    pub spool_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadRequest {
    pub identity: Identity,
    pub offset: u64,
    pub length: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    pub identity: Identity,
    pub offset: u64,
    pub length: u32,
    pub total_bytes: u64,
    pub sha256: String,
    pub data_base64: String,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Released {
    pub identity: Identity,
    pub released: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Watermark {
    None,
    Task { template: Template },
    Debug { template: Template },
    Custom { template: Template },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    Strip,
    Overlay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub version: u32,
    pub layout: Layout,
    /// Required 16..512 for strip; absent for overlay. Output pixels after resize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_height: Option<u32>,
    pub items: Vec<TextItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Anchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Text {
    Literal(String),
    Template(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Interval {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextItem {
    pub text: Text,
    pub anchor: Anchor,
    pub x: i32,
    pub y: i32,
    pub font_size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_path: Option<String>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    pub opacity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<Interval>,
    pub update_interval_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Gif,
    Mp4,
    Mov,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportSettings {
    pub format: Format,
    pub fps: u32,
    pub max_edge: u32,
    pub crf: u32,
    pub colors: u32,
    pub upscale: bool,
    pub watermark: Watermark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    Recording,
    OfflineUnverified,
    OfflineVerifiedSidecar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HashedFile {
    pub sha256: String,
    pub bytes: u64,
}

/// Adjacent metadata JSON binds the video and timeline by content, never filename alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactMetadata {
    pub schema_version: u32,
    pub export_id: String,
    pub provenance: Provenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<Identity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub labels: Labels,
    pub settings: ExportSettings,
    pub video: HashedFile,
    pub timeline: HashedFile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_manifest_sha256: Option<String>,
    /// Exact UTF-8 JSON snapshot whose bytes source_manifest_sha256 commits to.
    /// Required for recording provenance; absent for offline inputs without source facts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_manifest_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_video: Option<HashedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_export_id: Option<String>,
    pub partial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<EndReason>,
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
}

/// JSONL is in output PRESENTATION order, not source sequence/codec packet order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputFrame {
    pub schema_version: u32,
    pub export_id: String,
    pub output_frame: u64,
    pub pts_ms: f64,
    pub duration_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_t_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalization_hold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub marks: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    const WIRE: &str = include_str!("../../tests/fixtures/recording/wire.json");
    const MANIFEST: &str = include_str!("../../tests/fixtures/recording/manifest.json");
    const TEMPLATE: &str = include_str!("../../tests/fixtures/recording/template.json");
    const METADATA: &str = include_str!("../../tests/fixtures/recording/metadata.json");
    const TIMELINE: &str = include_str!("../../tests/fixtures/recording/timeline.jsonl");

    fn roundtrip<T: DeserializeOwned + Serialize>(value: Value) {
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    #[test]
    fn precision_raw_js_event_keeps_exact_time_through_typed_and_framed_forms() {
        // Raw captured JS text must enter the JSON parser, not only json! construction.
        let raw = r#"{"event_index":2,"operation_id":"precision_mark","t_ms":1106.2999999523163,"kind":"mark","text":"STEP +1","duration_ms":1000}"#;
        let expected = "1106.2999999523163".parse::<f64>().unwrap();
        let event: Event = serde_json::from_str(raw).unwrap();
        assert_eq!(event.t_ms.to_bits(), expected.to_bits());
        let mut wire = (raw.len() as u32).to_le_bytes().to_vec();
        wire.extend_from_slice(raw.as_bytes());
        for _ in 0..8 {
            let parsed = crate::read_frame(&mut wire.as_slice()).unwrap();
            let typed: Event = serde_json::from_value(parsed).unwrap();
            assert_eq!(typed, event);
            assert_eq!(typed.t_ms.to_bits(), expected.to_bits());
            wire = crate::encode(&serde_json::to_value(typed).unwrap()).unwrap();
        }
        let mut altered = event.clone();
        altered.t_ms = f64::from_bits(expected.to_bits() + 1);
        assert_ne!(
            event, altered,
            "one ULP is a genuine value change, never a tolerance pass"
        );
    }

    #[test]
    fn shared_wire_fixtures_roundtrip() {
        let v: Value = serde_json::from_str(WIRE).unwrap();
        roundtrip::<StartRequest>(v["start"]["params"].clone());
        roundtrip::<ExtensionStart>(v["extension_start"]["params"].clone());
        roundtrip::<Started>(v["started"]["result"]["data"].clone());
        roundtrip::<Frame>(v["frame"]["params"].clone());
        roundtrip::<FrameAccepted>(v["frame_accepted"]["result"].clone());
        roundtrip::<PhaseRequest>(v["phase"]["params"].clone());
        roundtrip::<MarkRequest>(v["mark"]["params"].clone());
        roundtrip::<EventRequest>(v["event"]["params"].clone());
        roundtrip::<Event>(v["event_accepted"]["result"].clone());
        roundtrip::<Event>(v["mark_accepted"]["result"]["data"].clone());
        roundtrip::<StopRequest>(v["stop"]["params"].clone());
        roundtrip::<HandleRequest>(v["status"]["params"].clone());
        roundtrip::<Status>(v["status_result"]["result"]["data"].clone());
        roundtrip::<Ended>(v["ended"]["params"].clone());
        roundtrip::<EndAccepted>(v["end_accepted"]["result"].clone());
        roundtrip::<ReadRequest>(v["read"]["params"].clone());
        roundtrip::<Chunk>(v["chunk"]["result"]["data"].clone());
        roundtrip::<Released>(v["released"]["result"]["data"].clone());
        roundtrip::<crate::Request>(v["start"].clone());
        roundtrip::<crate::Response>(v["started"].clone());
        roundtrip::<crate::Response>(v["error"].clone());
    }

    #[test]
    fn shared_manifest_template_and_artifact_fixtures_roundtrip() {
        roundtrip::<Manifest>(serde_json::from_str(MANIFEST).unwrap());
        roundtrip::<Template>(serde_json::from_str(TEMPLATE).unwrap());
        roundtrip::<ArtifactMetadata>(serde_json::from_str(METADATA).unwrap());
        for line in TIMELINE.lines() {
            roundtrip::<OutputFrame>(serde_json::from_str(line).unwrap());
        }
    }

    #[test]
    fn control_error_end_reason_roundtrips_without_claiming_detach_or_storage_failure() {
        assert_eq!(
            serde_json::to_string(&EndReason::ControlError).unwrap(),
            "\"control_error\""
        );
        let end = End {
            final_seq: 2,
            duration_ms: 750.0,
            reason: EndReason::ControlError,
            duration_observed: true,
            drops: DropCounts::default(),
        };
        let encoded = serde_json::to_value(&end).unwrap();
        assert_eq!(encoded["reason"], "control_error");
        assert_eq!(serde_json::from_value::<End>(encoded).unwrap(), end);
    }

    #[test]
    fn identifiers_and_hashes_are_not_paths() {
        assert!(valid_id("rec_01-ABC"));
        for invalid in ["", "../rec", "a/b", "a\\b", "a.b", "a b", "记录"] {
            assert!(!valid_id(invalid), "{invalid}");
        }
        assert!(!valid_id(&"x".repeat(129)));
        assert!(valid_sha256(&"a0".repeat(32)));
        assert!(!valid_sha256(&"A0".repeat(32)));
        assert!(!valid_sha256("abc"));
    }

    #[test]
    fn task_labels_are_bounded_literal_utf8() {
        let mut labels = Labels::new();
        labels.insert(
            "test.case".into(),
            "碰撞: seed=42; [x] ' % {label.run}".into(),
        );
        assert_eq!(validate_labels(&labels), Ok(()));
        labels.insert("secret".into(), "line\nbreak".into());
        assert!(validate_labels(&labels).is_err());
        labels.remove("secret");
        labels.insert("bad/key".into(), "value".into());
        assert!(validate_labels(&labels).is_err());
        labels.remove("bad/key");
        labels.insert("long".into(), "界".repeat(86));
        assert!(validate_labels(&labels).is_err());
        labels.clear();
        for n in 0..17 {
            labels.insert(format!("k{n}"), "v".into());
        }
        assert!(validate_labels(&labels).is_err());
        labels.clear();
        for n in 0..16 {
            labels.insert(format!("k{n}"), "v".repeat(256));
        }
        assert!(validate_labels(&labels).is_err());
    }

    #[test]
    fn unknown_variants_and_negative_wire_offsets_are_rejected() {
        assert!(serde_json::from_str::<State>("\"paused\"").is_err());
        assert!(serde_json::from_value::<Region>(serde_json::json!({"kind":"full_page"})).is_err());
        assert!(serde_json::from_value::<ReadRequest>(serde_json::json!({
            "identity":{"host_epoch":"host_01","record_id":"rec_01"},
            "offset":-1,"length":1
        }))
        .is_err());
        assert!(serde_json::from_value::<Text>(serde_json::json!({
            "kind":"expression","value":"1+1"
        }))
        .is_err());
    }

    #[test]
    fn offline_unverified_frame_does_not_invent_capture_facts() {
        let row = serde_json::json!({
            "schema_version":1,"export_id":"offline_01","output_frame":1,
            "pts_ms":0.0,"duration_ms":100.0,"marks":[]
        });
        roundtrip::<OutputFrame>(row.clone());
        let parsed: OutputFrame = serde_json::from_value(row).unwrap();
        assert_eq!(parsed.source_seq, None);
        assert_eq!(parsed.source_t_ms, None);
        assert_eq!(parsed.normalization_hold, None);
        assert_eq!(parsed.phase, None);
    }

    #[test]
    fn fixture_source_and_presentation_domains_are_distinct() {
        let manifest: Manifest = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest.protocol_version, PROTOCOL_VERSION);
        assert_eq!(manifest.frames.len() as u64, manifest.end.final_seq);
        assert_eq!(manifest.state, State::Sealed);
        assert!(manifest.end.duration_observed);
        assert_eq!(manifest.end.reason, EndReason::Deadline);
        let mut offset = 0;
        for (i, frame) in manifest.frames.iter().enumerate() {
            assert_eq!(frame.seq, i as u64 + 1);
            assert_eq!(frame.offset, offset);
            assert!(valid_sha256(&frame.sha256));
            offset += frame.length;
        }
        assert_eq!(offset, manifest.spool_bytes);
        assert!(valid_sha256(&manifest.spool_sha256));
        let rows: Vec<OutputFrame> = TIMELINE
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(rows[0].source_seq, Some(1));
        assert_eq!(rows[1].source_seq, Some(1));
        assert_eq!(rows[1].normalization_hold, Some(true));
        assert_ne!(rows[1].output_frame, rows[1].source_seq.unwrap());
        let meta: ArtifactMetadata = serde_json::from_str(METADATA).unwrap();
        assert_eq!(meta.source_manifest_json.as_deref(), Some(MANIFEST));
        assert_eq!(
            serde_json::from_str::<Manifest>(meta.source_manifest_json.as_ref().unwrap()).unwrap(),
            manifest
        );
        assert!(rows.iter().all(|r| r.export_id == meta.export_id));
        assert!(meta.duration_ms <= manifest.end.duration_ms);
        validate_labels(&meta.labels).unwrap();
    }
}
