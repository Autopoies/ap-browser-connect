//! Correlated screenshot contract, isolated from legacy reader types.
//! See docs/recording-protocol-v2.md. Serde is not byte/authentication validation.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub use super::{
    valid_id, valid_sha256, validate_labels, CaptureConfig, Chunk, Credit, CssToImage, EndAccepted,
    Event, EventKind, EventRequest, ExportSettings, Format, FrameAccepted, HandleRequest,
    HashedFile, Identity, Labels, MarkRequest, PhaseRequest, Provenance, ReadRequest, Rect, Region,
    Released, State, StopRequest, Template, Watermark, CREDIT_TIMEOUT_MS, DEFAULT_DURATION_MS,
    MAX_CHUNK_BYTES, MAX_DURATION_MS, MAX_EVENTS, MAX_FRAMES, MAX_FRAME_BYTES, MAX_MANIFEST_BYTES,
    MAX_METADATA_BYTES, MAX_RETAINED_RECORDINGS, MAX_SAFE_INTEGER, MAX_SPOOL_BYTES,
    MAX_TIMELINE_BYTES, MAX_TOTAL_SPOOL_BYTES, RETENTION_MS,
};

pub const PROTOCOL_VERSION: u32 = 2;
pub const SCHEMA_VERSION: u32 = 2;
pub const UNSUPPORTED_VERSION: &str = "RECORD_UNSUPPORTED_VERSION";
pub const UNSUPPORTED_BACKEND: &str = "RECORD_UNSUPPORTED_BACKEND";
pub mod method {
    pub use super::super::method::*;
    pub const CAPABILITIES: &str = "record.capabilities";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    CdpCaptureScreenshot,
}

/// No tab, identity, allocation or debugger work is allowed during negotiation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProducerCapability {
    pub protocol_version: u32,
    pub backend: Backend,
}

/// Host advertises its own support and the pinned extension's support separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub host: ProducerCapability,
    pub extension: ProducerCapability,
    pub legacy_v1_read_only: bool,
}
impl Capabilities {
    pub fn validate(&self) -> Result<(), &'static str> {
        version(self.host.protocol_version)?;
        version(self.extension.protocol_version)?;
        if !self.legacy_v1_read_only {
            return Err("legacy producer must be disabled");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub protocol_version: u32,
    pub backend: Backend,
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub config: CaptureConfig,
}
impl StartRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        version(self.protocol_version)?;
        id(&self.operation_id)?;
        if self
            .tab_id
            .is_some_and(|n| n < 0 || n as u64 > MAX_SAFE_INTEGER)
        {
            return Err("invalid tab");
        }
        config(&self.config)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionStart {
    #[serde(flatten)]
    pub request: StartRequest,
    pub identity: Identity,
    pub initial_credit: Credit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockSource {
    ExtensionPerformance,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockOrigin {
    BeforeFirstRecordedScreenshotRequest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Clock {
    pub source: ClockSource,
    pub origin: ClockOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncertainty_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Started {
    pub protocol_version: u32,
    pub backend: Backend,
    pub identity: Identity,
    pub tab_id: i64,
    pub clock: Clock,
    pub resolved_region_css: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Sample,
    Final,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub request_id: String,
    pub purpose: Purpose,
    pub request_started_ms: f64,
    pub response_received_ms: f64,
    pub geometry_validated_ms: f64,
}
impl Observation {
    pub fn validate(&self, hard_duration_ms: f64, t_ms: f64) -> Result<(), &'static str> {
        id(&self.request_id)?;
        for t in [
            self.request_started_ms,
            self.response_received_ms,
            self.geometry_validated_ms,
        ] {
            time(t, hard_duration_ms)?;
        }
        if self.request_started_ms > self.response_received_ms
            || self.response_received_ms > self.geometry_validated_ms
            || self.request_started_ms >= hard_duration_ms
            || t_ms != self.response_received_ms
        {
            return Err("invalid observation interval or response time");
        }
        Ok(())
    }
}

/// This is ownership knowledge, not a conclusion inferred from viewport numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmulationState {
    FreshKnownUnemulated,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisualViewport {
    pub width: f64,
    pub height: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub page_x: f64,
    pub page_y: f64,
    pub scale: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DomViewport {
    pub inner_width: f64,
    pub inner_height: f64,
    pub client_width: f64,
    pub client_height: f64,
    pub device_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub document_width: f64,
    pub document_height: f64,
    pub visual: VisualViewport,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CdpViewport {
    pub layout_width: f64,
    pub layout_height: f64,
    pub page_x: f64,
    pub page_y: f64,
    pub visual: VisualViewport,
    pub zoom: f64,
    pub content_width: f64,
    pub content_height: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewportObservation {
    pub dom: DomViewport,
    pub cdp: CdpViewport,
    pub emulation: EmulationState,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Geometry {
    pub viewport_css: Rect,
    pub crop_css: Rect,
    pub css_to_image: CssToImage,
    pub before: ViewportObservation,
    pub after: ViewportObservation,
}
impl Geometry {
    pub fn validate(&self, width: u32, height: u32) -> Result<(), &'static str> {
        if width == 0
            || height == 0
            || width > 16384
            || height > 16384
            || u64::from(width) * u64::from(height) > 64_000_000
        {
            return Err("invalid image dimensions");
        }
        rect(&self.viewport_css)?;
        rect(&self.crop_css)?;
        let v = &self.viewport_css;
        let c = &self.crop_css;
        if v.x != 0.0
            || v.y != 0.0
            || c.x < 0.0
            || c.y < 0.0
            || c.x + c.width > v.width
            || c.y + c.height > v.height
        {
            return Err("crop outside viewport");
        }
        let a = mapping(&self.before)?;
        let b = mapping(&self.after)?;
        if a != b
            || v.width != self.before.dom.inner_width
            || v.height != self.before.dom.inner_height
        {
            return Err("mapping-critical geometry changed");
        }
        let m = &self.css_to_image;
        positive(m.scale_x)?;
        positive(m.scale_y)?;
        finite(m.offset_x)?;
        finite(m.offset_y)?;
        // Initial v2 supports only the audited unshifted full viewport mapping.
        if m.offset_x != 0.0
            || m.offset_y != 0.0
            || m.scale_x != f64::from(width) / v.width
            || m.scale_y != f64::from(height) / v.height
        {
            return Err("unreliable CSS/image mapping");
        }
        Ok(())
    }
    fn same_mapping(&self, other: &Self) -> bool {
        self.viewport_css == other.viewport_css
            && self.crop_css == other.crop_css
            && self.css_to_image == other.css_to_image
            && mapping(&self.before).ok() == mapping(&other.before).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub identity: Identity,
    pub seq: u64,
    pub t_ms: f64,
    pub observation: Observation,
    pub width: u32,
    pub height: u32,
    pub geometry: Geometry,
    pub jpeg_base64: String,
}
impl Frame {
    /// Caller must additionally validate credit, bytes/JPEG and session history.
    pub fn validate(&self, hard_duration_ms: f64) -> Result<(), &'static str> {
        identity(&self.identity)?;
        safe(self.seq)?;
        if self.seq == 0 {
            return Err("zero sequence");
        }
        self.observation.validate(hard_duration_ms, self.t_ms)?;
        self.geometry.validate(self.width, self.height)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameEntry {
    pub seq: u64,
    pub t_ms: f64,
    pub observation: Observation,
    pub width: u32,
    pub height: u32,
    pub geometry: Geometry,
    pub offset: u64,
    pub length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureCounts {
    pub preparation_requests: u64,
    pub preparation_responses: u64,
    pub requests_started: u64,
    pub responses_received: u64,
    pub request_failures: u64,
    pub observations_rejected: u64,
    pub late_responses: u64,
    pub frames_sent: u64,
    pub scheduling_delays: u64,
}
impl CaptureCounts {
    pub fn validate(&self, persisted: u64) -> Result<(), &'static str> {
        for n in [
            self.preparation_requests,
            self.preparation_responses,
            self.requests_started,
            self.responses_received,
            self.request_failures,
            self.observations_rejected,
            self.late_responses,
            self.frames_sent,
            self.scheduling_delays,
        ] {
            safe(n)?;
        }
        if self.preparation_responses > self.preparation_requests
            || self.responses_received > self.requests_started
            || self.request_failures > self.requests_started - self.responses_received
            || self.observations_rejected > self.responses_received
            || self.late_responses > self.observations_rejected
            || self.frames_sent > self.responses_received - self.observations_rejected
            || persisted > self.frames_sent
        {
            return Err("contradictory request counters");
        }
        Ok(())
    }
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
    ControlError,
    NoFrames,
    StorageError,
    FinalObservationFailed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CutoffProvenance {
    FinalGeometryValidation,
    Deadline,
    AdmissionClosed,
    DurableLowerBound,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cutoff {
    pub t_ms: f64,
    pub provenance: CutoffProvenance,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalFailure {
    Deadline,
    StopBudget,
    RequestFailed,
    InvalidObservation,
    StorageLimit,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinalAttempt {
    pub request_id: String,
    pub request_started_ms: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "disposition", rename_all = "snake_case", deny_unknown_fields)]
pub enum FinalObservation {
    NotRequested,
    Accepted {
        request_id: String,
        seq: u64,
    },
    /// Host-only durable final when producer Ended/stop facts are unavailable.
    PersistedWithoutEnd {
        request_id: String,
        seq: u64,
    },
    Failed {
        attempt: Option<FinalAttempt>,
        reason: FinalFailure,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct End {
    pub final_seq: u64,
    pub duration_ms: f64,
    pub duration_observed: bool,
    pub reason: EndReason,
    pub cutoff: Cutoff,
    pub stop_requested_ms: Option<f64>,
    pub final_observation: FinalObservation,
    /// null means unavailable (e.g. host-only loss), never fabricated zero counts.
    pub counters: Option<CaptureCounts>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ended {
    pub identity: Identity,
    #[serde(deserialize_with = "deserialize_producer_end")]
    pub end: End,
}
fn deserialize_producer_end<'de, D: serde::Deserializer<'de>>(d: D) -> Result<End, D::Error> {
    let end = End::deserialize(d)?;
    if matches!(
        end.final_observation,
        FinalObservation::PersistedWithoutEnd { .. }
    ) {
        return Err(serde::de::Error::custom(
            "host-only final disposition in producer Ended",
        ));
    }
    Ok(end)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub protocol_version: u32,
    pub backend: Backend,
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
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub protocol_version: u32,
    pub backend: Backend,
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
impl Manifest {
    /// Structural/semantic validation only: caller authenticates exact bytes and JPEG hashes.
    pub fn validate(&self) -> Result<(), &'static str> {
        version(self.protocol_version)?;
        identity(&self.identity)?;
        id(&self.operation_id)?;
        id(&self.instance_id)?;
        if self.tab_id < 0 || self.tab_id as u64 > MAX_SAFE_INTEGER {
            return Err("invalid target");
        }
        config(&self.config)?;
        rect(&self.resolved_region_css)?;
        if let Some(t) = self.clock.uncertainty_ms {
            time(t, MAX_SAFE_INTEGER as f64)?;
        }
        let hard = self.config.max_duration_ms as f64;
        let end = &self.end;
        time(end.duration_ms, hard)?;
        if end.cutoff.t_ms != end.duration_ms {
            return Err("cutoff differs from duration");
        }
        if end.duration_observed == (end.cutoff.provenance == CutoffProvenance::DurableLowerBound) {
            return Err("cutoff provenance contradicts observation status");
        }
        if !matches!(self.state, State::Sealed | State::Failed) {
            return Err("manifest not terminal");
        }
        let complete = matches!(end.reason, EndReason::Stopped | EndReason::Deadline);
        if (self.state == State::Sealed) != complete {
            return Err("terminal reason/state mismatch");
        }
        if complete && (!end.duration_observed || self.frames.is_empty()) {
            return Err("incomplete sealed source");
        }
        if self.frames.len() > MAX_FRAMES
            || self.events.len() > MAX_EVENTS
            || end.final_seq != self.frames.len() as u64
            || self.spool_bytes > MAX_SPOOL_BYTES
            || !valid_sha256(&self.spool_sha256)
        {
            return Err("invalid source bounds");
        }
        if let Some(c) = &end.counters {
            c.validate(end.final_seq)?;
        }
        if complete
            && end.counters.as_ref().is_none_or(|c| {
                c.frames_sent != end.final_seq
                    || c.requests_started != c.responses_received + c.request_failures
                    || c.request_failures != 0
                    || c.observations_rejected != c.late_responses
                    || (end.reason == EndReason::Stopped && c.observations_rejected != 0)
            })
        {
            return Err("complete source lacks settled counters");
        }
        let stop = end.stop_requested_ms;
        if let Some(t) = stop {
            time(t, hard)?;
            if t > end.duration_ms {
                return Err("stop after cutoff");
            }
        }
        let persisted_without_end = matches!(
            end.final_observation,
            FinalObservation::PersistedWithoutEnd { .. }
        );
        let mut ids = BTreeSet::new();
        let mut offset = 0u64;
        let mut previous_end = 0.0;
        let mut final_frame = None;
        for (i, f) in self.frames.iter().enumerate() {
            f.observation.validate(hard, f.t_ms)?;
            f.geometry.validate(f.width, f.height)?;
            if f.seq != i as u64 + 1
                || f.offset != offset
                || f.length == 0
                || f.length > MAX_FRAME_BYTES
                || !valid_sha256(&f.sha256)
                || f.observation.request_started_ms < previous_end
                || f.observation.geometry_validated_ms > end.duration_ms
                || !ids.insert(f.observation.request_id.as_str())
                || f.geometry.crop_css != self.resolved_region_css
            {
                return Err("invalid source frame ordering/bounds");
            }
            if let Some(first) = self.frames.first() {
                if f.width != first.width
                    || f.height != first.height
                    || !f.geometry.same_mapping(&first.geometry)
                {
                    return Err("session mapping changed");
                }
            }
            if f.observation.purpose == Purpose::Final {
                if final_frame.is_some()
                    || (!persisted_without_end
                        && stop.is_none_or(|t| f.observation.request_started_ms < t))
                    || i + 1 != self.frames.len()
                {
                    return Err("invalid final admission");
                }
                final_frame = Some(f);
            } else if stop.is_some_and(|t| f.observation.request_started_ms > t) {
                return Err("sample admitted after stop");
            }
            previous_end = f.observation.geometry_validated_ms;
            offset = offset.checked_add(f.length).ok_or("offset overflow")?;
        }
        if offset != self.spool_bytes {
            return Err("spool total mismatch");
        }
        match &end.final_observation {
            FinalObservation::Accepted { request_id, seq } => {
                let f = final_frame.ok_or("missing final source")?;
                if request_id != &f.observation.request_id
                    || *seq != f.seq
                    || end.cutoff.provenance != CutoffProvenance::FinalGeometryValidation
                    || end.duration_ms != f.observation.geometry_validated_ms
                    || end.reason == EndReason::Deadline
                {
                    return Err("final reference/cutoff mismatch");
                }
            }
            FinalObservation::PersistedWithoutEnd { request_id, seq } => {
                let f = final_frame.ok_or("missing durable final source")?;
                if self.state != State::Failed
                    || complete
                    || end.cutoff.provenance != CutoffProvenance::DurableLowerBound
                    || end.duration_observed
                    || stop.is_some()
                    || end.counters.is_some()
                    || request_id != &f.observation.request_id
                    || *seq != f.seq
                {
                    return Err("invalid host-only durable final provenance");
                }
            }
            FinalObservation::Failed { attempt, .. } => {
                if stop.is_none() || final_frame.is_some() || complete {
                    return Err("failed final cannot complete");
                }
                if let Some(a) = attempt {
                    id(&a.request_id)?;
                    time(a.request_started_ms, hard)?;
                    if a.request_started_ms < stop.unwrap()
                        || a.request_started_ms >= hard
                        || ids.contains(a.request_id.as_str())
                    {
                        return Err("invalid final attempt");
                    }
                }
            }
            FinalObservation::NotRequested => {
                if final_frame.is_some() || stop.is_some() || end.reason == EndReason::Stopped {
                    return Err("required final omitted");
                }
            }
        }
        if end.cutoff.provenance == CutoffProvenance::FinalGeometryValidation
            && final_frame.is_none()
        {
            return Err("final cutoff without final source");
        }
        if end.reason == EndReason::FinalObservationFailed
            && !matches!(
                end.final_observation,
                FinalObservation::Failed { .. } | FinalObservation::PersistedWithoutEnd { .. }
            )
        {
            return Err("final failure lacks disposition");
        }
        if end.reason == EndReason::Stopped
            && !matches!(end.final_observation, FinalObservation::Accepted { .. })
        {
            return Err("stopped requires genuine final");
        }
        if end.reason == EndReason::Deadline
            && (stop.is_some()
                || end.duration_ms != hard
                || end.cutoff.provenance != CutoffProvenance::Deadline)
        {
            return Err("invalid deadline cutoff");
        }
        let mut last_event = 0.0;
        let mut operations = BTreeSet::new();
        for (i, e) in self.events.iter().enumerate() {
            validate_event(e, hard)?;
            if e.event_index != i as u64 + 1
                || e.t_ms < last_event
                || !operations.insert(&e.operation_id)
                || stop.is_some_and(|t| e.t_ms > t)
                // A durable final proves only that prior admission closed no later
                // than its request start. It does not recover an exact stop time.
                || (persisted_without_end
                    && final_frame.is_some_and(|f| e.t_ms > f.observation.request_started_ms))
                || (end.duration_observed && e.t_ms > end.duration_ms)
            {
                return Err("invalid event admission");
            }
            last_event = e.t_ms;
        }
        if end.cutoff.provenance == CutoffProvenance::DurableLowerBound {
            let lower = self
                .frames
                .last()
                .map_or(0.0, |f| f.observation.geometry_validated_ms)
                .max(last_event);
            if end.duration_ms != lower {
                return Err("invented lower bound");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceReference {
    pub seq: u64,
    pub t_ms: f64,
    pub observation: Observation,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputFrame {
    pub schema_version: u32,
    pub export_id: String,
    pub output_frame: u64,
    pub pts_ms: f64,
    pub duration_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalization_hold: Option<bool>,
    pub final_observation_visibility: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub marks: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_manifest_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_protocol_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<Backend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_video: Option<HashedFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_export_id: Option<String>,
    pub partial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<EndReason>,
    pub duration_ms: f64,
    /// Absent for durable-lower-bound sources: the actual recording end is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_source_end_ms: Option<f64>,
    pub final_visibility_extension_ms: f64,
    pub width: u32,
    pub height: u32,
}

impl ArtifactMetadata {
    /// Byte digests and actual media/timeline matching remain the caller's responsibility.
    pub fn validate_source(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(UNSUPPORTED_VERSION.into());
        }
        id(&self.export_id).map_err(str::to_owned)?;
        validate_labels(&self.labels).map_err(str::to_owned)?;
        time(self.duration_ms, MAX_DURATION_MS as f64 + 20.0).map_err(str::to_owned)?;
        time(self.final_visibility_extension_ms, 20.0).map_err(str::to_owned)?;
        if !valid_sha256(&self.video.sha256) || !valid_sha256(&self.timeline.sha256) {
            return Err("invalid artifact digest".into());
        }
        match (&self.source_manifest_json, &self.source_manifest_sha256) {
            (Some(raw), Some(hash)) => {
                if !valid_sha256(hash)
                    || self.source_protocol_version != Some(PROTOCOL_VERSION)
                    || self.backend != Some(Backend::CdpCaptureScreenshot)
                    || self.provenance == Provenance::OfflineUnverified
                {
                    return Err("source provenance mismatch".into());
                }
                let SourceManifest::V2(m) = parse_source_manifest(raw)? else {
                    return Err("legacy source requires schema1 output".into());
                };
                if self.identity.as_ref() != Some(&m.identity)
                    || self.partial != (m.state == State::Failed)
                    || self.end_reason != Some(m.end.reason)
                    || self.observed_source_end_ms
                        != m.end.duration_observed.then_some(m.end.duration_ms)
                    || self.final_visibility_extension_ms
                        != (self.duration_ms - m.end.duration_ms).max(0.0)
                {
                    return Err("artifact/source facts differ".into());
                }
                let quantum = if self.settings.format == Format::Gif {
                    10.0
                } else {
                    1.0
                };
                if self.final_visibility_extension_ms > 0.0
                    && (!matches!(
                        m.end.final_observation,
                        FinalObservation::Accepted { .. }
                            | FinalObservation::PersistedWithoutEnd { .. }
                    ) || self.final_visibility_extension_ms >= 2.0 * quantum)
                {
                    return Err("unpermitted final visibility extension".into());
                }
            }
            (None, None) => {
                if self.provenance == Provenance::Recording
                    || self.source_protocol_version.is_some()
                    || self.backend.is_some()
                    || self.identity.is_some()
                    || self.end_reason.is_some()
                    || self.observed_source_end_ms.is_some()
                    || self.final_visibility_extension_ms != 0.0
                {
                    return Err("invented source provenance".into());
                }
            }
            _ => return Err("unpaired source bytes/hash".into()),
        }
        Ok(())
    }
}

/// Only when a genuine FINAL observation would otherwise be absent from presentation.
/// Caller validates this row's exact SourceReference against the authenticated manifest.
/// The source cutoff may be a durable lower bound, not a known recording end; the
/// visibility exception never upgrades that failed/unknown-end provenance.
pub fn validate_final_visibility(
    row: &OutputFrame,
    source: &FrameEntry,
    source_cutoff_ms: f64,
    quantum_ms: f64,
    output_end_ms: f64,
) -> Result<(), &'static str> {
    positive(quantum_ms)?;
    time(source_cutoff_ms, MAX_DURATION_MS as f64)?;
    finite(output_end_ms)?;
    let expected = (source.t_ms / quantum_ms).ceil() * quantum_ms;
    if row.schema_version != SCHEMA_VERSION
        || !row.final_observation_visibility
        || source.observation.purpose != Purpose::Final
        || row.source.as_ref()
            != Some(&SourceReference {
                seq: source.seq,
                t_ms: source.t_ms,
                observation: source.observation.clone(),
            })
        || row.pts_ms != expected
        || row.duration_ms != quantum_ms
        || output_end_ms != row.pts_ms + row.duration_ms
        || source.observation.geometry_validated_ms != source_cutoff_ms
        || output_end_ms < source_cutoff_ms
        || output_end_ms - source_cutoff_ms >= 2.0 * quantum_ms
    {
        return Err("invalid final presentation boundary");
    }
    Ok(())
}

/// Version discrimination only, never heuristic fallback or a replacement for legacy
/// authentication/semantic checks. Retain the original input bytes separately for hashing.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceManifest {
    Legacy(super::Manifest),
    V2(Manifest),
}
pub fn parse_source_manifest(raw: &str) -> Result<SourceManifest, String> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err("manifest byte cap".into());
    }
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    match v.get("protocol_version").and_then(|v| v.as_u64()) {
        Some(1) => {
            if v.get("backend").is_some()
                || v["clock"]["source"] != "extension_performance"
                || v["clock"]["origin"] != "before_start_screencast"
                || v["end"].get("final_observation").is_some()
                || v["end"].get("counters").is_some()
                || v["frames"].as_array().is_some_and(|frames| {
                    frames.iter().any(|f| {
                        f.get("observation").is_some()
                            || f.get("request_id").is_some()
                            || f.get("purpose").is_some()
                            || f.get("request_started_ms").is_some()
                            || f.get("response_received_ms").is_some()
                            || f.get("geometry_validated_ms").is_some()
                            || f["geometry"].get("before").is_some()
                            || f["geometry"].get("after").is_some()
                    })
                })
            {
                return Err("contradictory legacy source".into());
            }
            serde_json::from_str(raw)
                .map(SourceManifest::Legacy)
                .map_err(|e| e.to_string())
        }
        Some(2) => {
            let m: Manifest = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            m.validate().map_err(str::to_owned)?;
            Ok(SourceManifest::V2(m))
        }
        _ => Err(UNSUPPORTED_VERSION.into()),
    }
}

/// Schema1 remains schema1 even when a new executable watermarks it offline.
#[derive(Debug, Clone, PartialEq)]
pub enum SourceArtifact {
    Legacy(super::ArtifactMetadata),
    V2(ArtifactMetadata),
}
pub fn parse_artifact_metadata(raw: &str) -> Result<SourceArtifact, String> {
    if raw.len() > MAX_METADATA_BYTES {
        return Err("metadata byte cap".into());
    }
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    match v.get("schema_version").and_then(|n| n.as_u64()) {
        Some(1) => {
            for field in [
                "backend",
                "source_protocol_version",
                "observed_source_end_ms",
                "final_visibility_extension_ms",
            ] {
                if v.get(field).is_some() {
                    return Err("contradictory legacy artifact".into());
                }
            }
            let m: super::ArtifactMetadata =
                serde_json::from_str(raw).map_err(|e| e.to_string())?;
            if let Some(source) = &m.source_manifest_json {
                if !matches!(parse_source_manifest(source)?, SourceManifest::Legacy(_)) {
                    return Err("schema1 requires legacy source".into());
                }
            }
            Ok(SourceArtifact::Legacy(m))
        }
        Some(2) => {
            let m: ArtifactMetadata = serde_json::from_str(raw).map_err(|e| e.to_string())?;
            m.validate_source()?;
            Ok(SourceArtifact::V2(m))
        }
        _ => Err(UNSUPPORTED_VERSION.into()),
    }
}

fn version(v: u32) -> Result<(), &'static str> {
    if v == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(UNSUPPORTED_VERSION)
    }
}
fn id(v: &str) -> Result<(), &'static str> {
    if valid_id(v) {
        Ok(())
    } else {
        Err("invalid opaque ID")
    }
}
fn identity(v: &Identity) -> Result<(), &'static str> {
    id(&v.host_epoch)?;
    id(&v.record_id)
}
fn safe(n: u64) -> Result<(), &'static str> {
    if n <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err("unsafe integer")
    }
}
fn finite(n: f64) -> Result<(), &'static str> {
    if n.is_finite() {
        Ok(())
    } else {
        Err("nonfinite number")
    }
}
fn positive(n: f64) -> Result<(), &'static str> {
    finite(n)?;
    if n > 0.0 {
        Ok(())
    } else {
        Err("nonpositive number")
    }
}
fn time(n: f64, max: f64) -> Result<(), &'static str> {
    finite(n)?;
    finite(max)?;
    if n >= 0.0 && n <= max {
        Ok(())
    } else {
        Err("time out of bounds")
    }
}
fn rect(r: &Rect) -> Result<(), &'static str> {
    finite(r.x)?;
    finite(r.y)?;
    positive(r.width)?;
    positive(r.height)
}
/// Validate reused event payload bounds before admission and when reading a manifest.
pub fn validate_event(event: &Event, hard_duration_ms: f64) -> Result<(), &'static str> {
    id(&event.operation_id)?;
    time(event.t_ms, hard_duration_ms)?;
    if event.event_index == 0 || event.event_index > MAX_EVENTS as u64 {
        return Err("invalid event index");
    }
    let (text, empty_allowed) = match &event.kind {
        EventKind::Phase { text } => (text, true),
        EventKind::Mark { text, duration_ms } => {
            if !(1..=10_000).contains(duration_ms) {
                return Err("invalid mark duration");
            }
            (text, false)
        }
    };
    if (!empty_allowed && text.is_empty())
        || text.len() > 512
        || text.split('\n').count() > 8
        || text.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err("invalid event text");
    }
    Ok(())
}

fn config(c: &CaptureConfig) -> Result<(), &'static str> {
    if c.max_duration_ms == 0
        || c.max_duration_ms > MAX_DURATION_MS
        || !(1..=30).contains(&c.capture_fps)
        || !(1..=100).contains(&c.jpeg_quality)
    {
        return Err("invalid capture config");
    }
    validate_labels(&c.labels)?;
    if let Some(r) = &c.run_id {
        id(r)?;
    }
    match &c.region {
        Region::Viewport => (),
        Region::Rect { rect: r } => {
            rect(r)?;
            if r.x < 0.0 || r.y < 0.0 {
                return Err("invalid region");
            }
        }
        Region::Element { selector } => {
            if selector.is_empty() || selector.len() > 1024 {
                return Err("invalid selector");
            }
        }
    }
    Ok(())
}
fn visual(v: &VisualViewport) -> Result<[f64; 5], &'static str> {
    positive(v.width)?;
    positive(v.height)?;
    positive(v.scale)?;
    for n in [v.offset_x, v.offset_y, v.page_x, v.page_y] {
        finite(n)?;
    }
    Ok([v.width, v.height, v.offset_x, v.offset_y, v.scale])
}
fn mapping(v: &ViewportObservation) -> Result<Vec<f64>, &'static str> {
    let d = &v.dom;
    let c = &v.cdp;
    let dv = visual(&d.visual)?;
    let cv = visual(&c.visual)?;
    let sizes = [
        d.inner_width,
        d.inner_height,
        d.client_width,
        d.client_height,
        d.device_scale_factor,
        d.document_width,
        d.document_height,
        c.layout_width,
        c.layout_height,
        c.zoom,
        c.content_width,
        c.content_height,
    ];
    for n in sizes {
        positive(n)?;
    }
    for n in [d.scroll_x, d.scroll_y, c.page_x, c.page_y] {
        finite(n)?;
    }
    // Strict initial policy: complete DOM/CDP viewport agreement, no pinch/zoom/offset.
    // Chromium's integer cssLayoutViewport can round clientWidth/clientHeight by 1px on .5 subpixel scroll offsets.
    if (d.client_width - c.layout_width).abs() > 1.0
        || (d.client_height - c.layout_height).abs() > 1.0
        || d.client_width > d.inner_width
        || d.client_height > d.inner_height
        || dv != cv
        || dv[0] != d.client_width
        || dv[1] != d.client_height
        || dv[2] != 0.0
        || dv[3] != 0.0
        || dv[4] != 1.0
        || c.zoom != 1.0
    {
        return Err("ambiguous viewport mapping");
    }
    let mut key = vec![
        d.inner_width,
        d.inner_height,
        d.client_width,
        d.client_height,
        d.device_scale_factor,
        c.zoom,
    ];
    key.extend(dv);
    key.extend(cv);
    Ok(key)
}

#[cfg(test)]
mod tests;
