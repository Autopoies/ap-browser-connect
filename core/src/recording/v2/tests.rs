use super::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

const MANIFEST: &str = include_str!("../../../../tests/fixtures/recording-v2/manifest.json");
const WIRE: &str = include_str!("../../../../tests/fixtures/recording-v2/wire.json");
const TIMELINE: &str = include_str!("../../../../tests/fixtures/recording-v2/timeline.jsonl");
const METADATA: &str = include_str!("../../../../tests/fixtures/recording-v2/metadata.json");
const BOUNDARIES: &str = include_str!("../../../../tests/fixtures/recording-v2/boundaries.json");
const LEGACY: &str = include_str!("../../../../tests/fixtures/recording/manifest.json");
const PERSISTED_WITHOUT_END: &str =
    include_str!("../../../../tests/fixtures/recording-v2/persisted-without-end.json");
fn durable_final_manifest() -> Manifest {
    let mut m = manifest();
    m.state = State::Failed;
    m.end = serde_json::from_str(PERSISTED_WITHOUT_END).unwrap();
    m
}
fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).unwrap()
}
fn roundtrip<T: DeserializeOwned + Serialize>(v: Value) {
    let t: T = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(t).unwrap(), v);
}
fn reject(f: impl FnOnce(&mut Manifest)) {
    let mut m = manifest();
    f(&mut m);
    assert!(m.validate().is_err(), "accepted invalid manifest: {m:?}");
}

#[test]
fn shared_v2_fixtures_and_envelopes_roundtrip() {
    let w: Value = serde_json::from_str(WIRE).unwrap();
    roundtrip::<CapabilitiesRequest>(w["capabilities"]["params"].clone());
    roundtrip::<Capabilities>(w["capabilities_result"]["result"]["data"].clone());
    roundtrip::<StartRequest>(w["start"]["params"].clone());
    roundtrip::<ExtensionStart>(w["extension_start"]["params"].clone());
    roundtrip::<Started>(w["started"]["result"]["data"].clone());
    roundtrip::<StopRequest>(w["stop"]["params"].clone());
    roundtrip::<Status>(w["stop_ack"]["result"]["data"].clone());
    roundtrip::<FrameAccepted>(w["frame_accepted"]["result"].clone());
    roundtrip::<crate::Request>(w["capabilities"].clone());
    roundtrip::<crate::Request>(w["start"].clone());
    roundtrip::<crate::Response>(w["unsupported_version"].clone());
    roundtrip::<crate::Response>(w["unsupported_backend"].clone());
    roundtrip::<Manifest>(serde_json::from_str(MANIFEST).unwrap());
    roundtrip::<ArtifactMetadata>(serde_json::from_str(METADATA).unwrap());
    for row in TIMELINE.lines() {
        roundtrip::<OutputFrame>(serde_json::from_str(row).unwrap());
    }
    manifest().validate().unwrap();
    let m = manifest();
    roundtrip::<Ended>(
        serde_json::to_value(Ended {
            identity: m.identity.clone(),
            end: m.end.clone(),
        })
        .unwrap(),
    );
    let legacy_wire: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/recording/wire.json"
    ))
    .unwrap();
    let entry = m.frames[0].clone();
    let mut value = serde_json::to_value(entry).unwrap();
    let obj = value.as_object_mut().unwrap();
    for k in ["offset", "length", "sha256"] {
        obj.remove(k);
    }
    obj.insert("identity".into(), serde_json::to_value(m.identity).unwrap());
    obj.insert(
        "jpeg_base64".into(),
        legacy_wire["frame"]["params"]["jpeg_base64"].clone(),
    );
    roundtrip::<Frame>(value.clone());
    serde_json::from_value::<Frame>(value)
        .unwrap()
        .validate(1500.0)
        .unwrap();
}

#[test]
fn negotiation_is_no_target_and_exact_v2_only() {
    let w: Value = serde_json::from_str(WIRE).unwrap();
    let mut c: Capabilities =
        serde_json::from_value(w["capabilities_result"]["result"]["data"].clone()).unwrap();
    c.validate().unwrap();
    c.extension.protocol_version = 1;
    assert_eq!(c.validate(), Err(UNSUPPORTED_VERSION));
    c.extension.protocol_version = 2;
    c.host.protocol_version = 3;
    assert_eq!(c.validate(), Err(UNSUPPORTED_VERSION));
    assert!(serde_json::from_value::<CapabilitiesRequest>(json!({"tab_id":7})).is_err());
    assert!(serde_json::from_value::<Backend>(json!("cdp_screencast")).is_err());
    assert!(serde_json::from_value::<Backend>(json!("unknown")).is_err());
    let mut start: StartRequest = serde_json::from_value(w["start"]["params"].clone()).unwrap();
    start.validate().unwrap();
    start.protocol_version = 1;
    assert_eq!(start.validate(), Err(UNSUPPORTED_VERSION));
    start.protocol_version = 2;
    start.config.capture_fps = 31;
    assert!(start.validate().is_err());
    assert!(serde_json::from_value::<StartRequest>(
        json!({"operation_id":"old","config":start.config})
    )
    .is_err());
}

#[test]
fn observed_intervals_are_ordered_bounded_and_not_paint_timestamps() {
    let b: Value = serde_json::from_str(BOUNDARIES).unwrap();
    for v in b["invalid_intervals"].as_array().unwrap() {
        let o: Observation = serde_json::from_value(v.clone()).unwrap();
        assert!(o.validate(1500.0, o.response_received_ms).is_err());
    }
    let mut o = manifest().frames[0].observation.clone();
    o.request_started_ms = f64::NAN;
    assert!(o.validate(1500.0, 20.0).is_err());
    o.request_started_ms = f64::INFINITY;
    assert!(o.validate(1500.0, 20.0).is_err());
    o.request_started_ms = 0.0;
    assert!(o.validate(1500.0, 19.999).is_err());
    let mut v = serde_json::to_value(o).unwrap();
    v["purpose"] = json!("preparation");
    assert!(serde_json::from_value::<Observation>(v).is_err());
    let mut v = serde_json::to_value(manifest()).unwrap();
    v["frames"][0]["cdp_timestamp_s"] = json!(1234.0);
    assert!(serde_json::from_value::<Manifest>(v).is_err());
}

#[test]
fn serial_requests_unique_identity_contiguous_spool_and_hard_caps() {
    reject(|m| m.frames[1].observation.request_id = m.frames[0].observation.request_id.clone());
    reject(|m| m.frames[1].observation.request_started_ms = 24.0);
    reject(|m| m.frames[1].seq = 3);
    reject(|m| m.frames[1].offset += 1);
    reject(|m| m.frames[1].length = MAX_FRAME_BYTES + 1);
    reject(|m| m.end.final_seq = 3);
    reject(|m| m.spool_bytes += 1);
    reject(|m| m.spool_bytes = MAX_SPOOL_BYTES + 1);
    reject(|m| m.spool_sha256 = "bad".into());
    reject(|m| m.identity.record_id = "../path".into());
    reject(|m| m.config.max_duration_ms = MAX_DURATION_MS + 1);
    reject(|m| m.frames[1].observation.geometry_validated_ms = 1501.0);
    reject(|m| m.frames[0].width = 16385);
    reject(|m| m.frames[0].geometry.crop_css.width = 17.0);
    reject(|m| m.frames = vec![m.frames[0].clone(); MAX_FRAMES + 1]);
    reject(|m| m.events = vec![m.events[0].clone(); MAX_EVENTS + 1]);
}

#[test]
fn scroll_document_and_contents_are_not_mapping_stability_requirements() {
    // Fixture scroll and document dimensions change both within and between operations.
    let m = manifest();
    m.validate().unwrap();
    let g = &m.frames[0].geometry;
    assert_ne!(g.before.dom.scroll_y, g.after.dom.scroll_y);
    assert_ne!(g.before.cdp.content_height, g.after.cdp.content_height);
    let mut m = m;
    m.frames[1].geometry.after.dom.document_height = 9999.0;
    m.frames[1].geometry.after.cdp.content_height = 9998.0;
    m.frames[1].geometry.after.dom.scroll_x = -20.0;
    m.validate().unwrap();
    // No content hashes, element requery, or document-offset inference are part of geometry.
}

#[test]
fn mapping_critical_changes_and_unknown_emulation_are_refused() {
    reject(|m| m.frames[0].geometry.after.dom.inner_width = 17.0);
    reject(|m| m.frames[0].geometry.after.dom.device_scale_factor = 2.0);
    reject(|m| m.frames[0].geometry.after.cdp.zoom = 2.0);
    reject(|m| m.frames[0].geometry.after.cdp.visual.offset_y = 1.0);
    reject(|m| m.frames[0].geometry.after.dom.visual.scale = 2.0);
    reject(|m| m.frames[1].geometry.css_to_image.scale_x = 2.0);
    reject(|m| m.frames[1].geometry.css_to_image.offset_x = 1.0);
    reject(|m| m.frames[1].geometry.after.cdp.visual.scale = f64::INFINITY);
    let mut v = serde_json::to_value(manifest()).unwrap();
    v["frames"][0]["geometry"]["before"]["emulation"] = json!("unknown");
    assert!(serde_json::from_value::<Manifest>(v).is_err());
    reject(|m| {
        m.frames[1].geometry.before.dom.device_scale_factor = 2.0;
        m.frames[1].geometry.after.dom.device_scale_factor = 2.0;
    });
}

#[test]
fn parent_review_equal_clock_ticks_do_not_invent_admission_order() {
    let mut m = manifest();
    // Admission before stop can share a reduced-precision monotonic clock tick.
    m.end.stop_requested_ms = Some(0.0);
    m.events[0].t_ms = 0.0;
    m.frames[0].t_ms = 0.1;
    m.frames[0].observation.response_received_ms = 0.1;
    m.frames[0].observation.geometry_validated_ms = 0.2;
    m.frames[1].t_ms = 10.3;
    m.frames[1].observation.request_started_ms = 0.25;
    m.frames[1].observation.response_received_ms = 10.3;
    m.frames[1].observation.geometry_validated_ms = 10.4;
    m.end.duration_ms = 10.4;
    m.end.cutoff.t_ms = 10.4;
    m.validate().unwrap();
    let mut after = m.clone();
    after.frames[0].observation.request_started_ms = 0.05;
    assert!(after.validate().is_err());
    m.events[0].t_ms = 0.05;
    assert!(m.validate().is_err());
}

#[test]
fn parent_review_shared_event_payload_bounds_are_validated() {
    let mut empty_phase = manifest();
    empty_phase.events[0].kind = EventKind::Phase {
        text: String::new(),
    };
    empty_phase.validate().unwrap();
    for kind in [
        EventKind::Phase { text: "\0".into() },
        EventKind::Phase {
            text: "中".repeat(171),
        },
        EventKind::Phase {
            text: "\n".repeat(8),
        },
        EventKind::Mark {
            text: String::new(),
            duration_ms: 1,
        },
        EventKind::Mark {
            text: "ok".into(),
            duration_ms: 0,
        },
        EventKind::Mark {
            text: "ok".into(),
            duration_ms: 10001,
        },
    ] {
        reject(move |m| m.events[0].kind = kind);
    }
}

#[test]
fn parent_review_instance_id_obeys_opaque_identity_contract() {
    reject(|m| m.instance_id = "../not-an-instance".into());
}

#[test]
fn explicit_stop_requires_one_genuine_final_and_exact_cutoff() {
    manifest().validate().unwrap();
    reject(|m| m.end.final_observation = FinalObservation::NotRequested);
    reject(|m| m.frames[1].observation.purpose = Purpose::Sample);
    reject(|m| m.frames[1].observation.request_started_ms = 999.0);
    reject(|m| m.end.stop_requested_ms = None);
    reject(|m| m.end.stop_requested_ms = Some(0.0));
    reject(|m| {
        m.end.final_observation = FinalObservation::Accepted {
            request_id: "other".into(),
            seq: 2,
        }
    });
    reject(|m| {
        m.end.final_observation = FinalObservation::Accepted {
            request_id: "shot_final_2".into(),
            seq: 1,
        }
    });
    reject(|m| {
        m.end.duration_ms = 1120.0;
        m.end.cutoff.t_ms = 1120.0;
    });
    reject(|m| m.frames[0].observation.purpose = Purpose::Final);
    reject(|m| m.events[0].t_ms = 1000.1);
    reject(|m| m.end.duration_observed = false);
}

#[test]
fn failed_required_final_is_failed_partial_not_silent_complete() {
    let b: Value = serde_json::from_str(BOUNDARIES).unwrap();
    let mut m = manifest();
    m.frames[1].observation.purpose = Purpose::Sample;
    m.state = State::Failed;
    m.end = serde_json::from_value(b["failed_final_end"].clone()).unwrap();
    m.validate().unwrap();
    m.state = State::Sealed;
    assert!(m.validate().is_err());
    m.state = State::Failed;
    m.end.reason = EndReason::Stopped;
    assert!(m.validate().is_err());
    m.end.reason = EndReason::FinalObservationFailed;
    m.end.final_observation = FinalObservation::Failed {
        attempt: None,
        reason: FinalFailure::Deadline,
    };
    m.validate().unwrap();
    m.end.final_observation = FinalObservation::Failed {
        attempt: Some(FinalAttempt {
            request_id: "too_late".into(),
            request_started_ms: 1500.0,
        }),
        reason: FinalFailure::Deadline,
    };
    assert!(m.validate().is_err());
}

#[test]
fn deadline_does_not_promise_or_admit_post_cap_final() {
    let b: Value = serde_json::from_str(BOUNDARIES).unwrap();
    let mut m = manifest();
    m.frames[1].observation.purpose = Purpose::Sample;
    m.end = serde_json::from_value(b["deadline_end"].clone()).unwrap();
    m.validate().unwrap();
    m.frames[1].observation.geometry_validated_ms = 1500.01;
    assert!(m.validate().is_err());
    m.frames[1].observation.geometry_validated_ms = 1500.0;
    m.validate().unwrap(); // Equality at completion cap is allowed, not a new request there.
    let counters = m.end.counters.as_mut().unwrap();
    counters.requests_started = 3;
    counters.responses_received = 3;
    counters.observations_rejected = 1;
    counters.late_responses = 1;
    m.validate().unwrap(); // Settled late data can be honestly discarded at deadline.
    m.end.counters.as_mut().unwrap().late_responses = 0;
    assert!(m.validate().is_err()); // Other invalid data cannot silently complete.
    m.end.counters.as_mut().unwrap().late_responses = 1;
    m.frames[1].observation.request_started_ms = 1500.0;
    assert!(m.validate().is_err());
}

#[test]
fn unknown_host_counters_and_duration_are_honest_lower_bounds() {
    let mut m = manifest();
    m.state = State::Failed;
    m.end.reason = EndReason::NativeDisconnected;
    m.end.duration_observed = false;
    m.end.cutoff.provenance = CutoffProvenance::DurableLowerBound;
    m.end.counters = None;
    m.end.stop_requested_ms = None;
    m.end.final_observation = FinalObservation::NotRequested;
    m.frames[1].observation.purpose = Purpose::Sample;
    m.validate().unwrap();
    m.end.duration_ms = 1200.0;
    m.end.cutoff.t_ms = 1200.0;
    assert!(m.validate().is_err());
}

#[test]
fn persisted_without_end_preserves_real_final_interval_and_unknown_facts() {
    let m = durable_final_manifest();
    m.validate().unwrap();
    assert_eq!(m.frames, manifest().frames); // No accepted bytes, IDs or times dropped/rewritten.
    assert_eq!(m.spool_bytes, manifest().spool_bytes);
    assert_eq!(m.spool_sha256, manifest().spool_sha256);
    assert!(!m.end.duration_observed);
    assert_eq!(m.end.stop_requested_ms, None);
    assert_eq!(m.end.counters, None);
    assert_eq!(
        m.end.duration_ms,
        m.frames[1].observation.geometry_validated_ms
    );
    roundtrip::<End>(serde_json::from_str(PERSISTED_WITHOUT_END).unwrap());
    assert!(matches!(
        parse_source_manifest(&serde_json::to_string(&m).unwrap()).unwrap(),
        SourceManifest::V2(_)
    ));
    // Any noncomplete failure reason remains honest, including a lost final Ended.
    let mut final_failure = m;
    final_failure.end.reason = EndReason::FinalObservationFailed;
    final_failure.validate().unwrap();
}

#[test]
fn persisted_without_end_final_start_is_event_upper_bound_not_stop_time() {
    let mut m = durable_final_manifest();
    let upper = m.frames[1].observation.request_started_ms;
    m.events[0].t_ms = upper; // Reduced-precision ties remain valid.
    m.validate().unwrap();
    assert_eq!(m.end.stop_requested_ms, None);
    m.events[0].t_ms = upper + 0.001;
    assert!(m.validate().is_err()); // Even though this is below durable validation cutoff.
}

#[test]
fn persisted_without_end_rejects_malformed_or_complete_provenance() {
    let base = serde_json::to_value(durable_final_manifest()).unwrap();
    for (pointer, value) in [
        ("/state", json!("sealed")),
        ("/end/reason", json!("stopped")),
        ("/end/reason", json!("deadline")),
        ("/end/duration_observed", json!(true)),
        ("/end/cutoff/provenance", json!("admission_closed")),
        ("/end/cutoff/provenance", json!("final_geometry_validation")),
        ("/end/stop_requested_ms", json!(1000.0)),
        (
            "/end/counters",
            serde_json::to_value(manifest().end.counters).unwrap(),
        ),
        ("/end/final_observation/request_id", json!("other")),
        ("/end/final_observation/seq", json!(1)),
        ("/end/final_observation/seq", json!(0)),
        ("/frames/1/observation/purpose", json!("sample")),
        ("/frames/0/observation/purpose", json!("final")),
    ] {
        let mut v = base.clone();
        *v.pointer_mut(pointer).unwrap() = value;
        let m: Manifest = serde_json::from_value(v).unwrap();
        assert!(m.validate().is_err(), "accepted mutation {pointer}");
    }
    let mut m = durable_final_manifest();
    m.end.duration_ms += 1.0;
    m.end.cutoff.t_ms = m.end.duration_ms;
    assert!(m.validate().is_err()); // No invented source end beyond durable facts.
    let mut missing_final = durable_final_manifest();
    missing_final.frames.clear();
    missing_final.end.final_seq = 0;
    missing_final.spool_bytes = 0;
    missing_final.events.clear();
    missing_final.end.duration_ms = 0.0;
    missing_final.end.cutoff.t_ms = 0.0;
    assert!(missing_final.validate().is_err());
    let mut v = base;
    v["end"]["final_observation"]["stop_requested_ms"] = json!(1000.0);
    assert!(serde_json::from_value::<Manifest>(v).is_err());
}

#[test]
fn persisted_without_end_is_host_only_rejected_from_producer_ended() {
    let end: Value = serde_json::from_str(PERSISTED_WITHOUT_END).unwrap();
    let incoming = json!({"identity": manifest().identity, "end": end});
    assert!(serde_json::from_value::<Ended>(incoming).is_err());
    let m = manifest();
    let ordinary = json!({"identity": m.identity, "end": m.end});
    assert!(serde_json::from_value::<Ended>(ordinary).is_ok());
}

#[test]
fn persisted_without_end_partial_metadata_keeps_unknown_end_and_final_visibility() {
    let m = durable_final_manifest();
    let mut meta: ArtifactMetadata = serde_json::from_str(METADATA).unwrap();
    meta.provenance = Provenance::Recording;
    meta.identity = Some(m.identity.clone());
    meta.source_protocol_version = Some(2);
    meta.backend = Some(Backend::CdpCaptureScreenshot);
    meta.source_manifest_json = Some(serde_json::to_string(&m).unwrap());
    meta.source_manifest_sha256 = Some("a".repeat(64)); // Structural test, not authentication.
    meta.partial = true;
    meta.end_reason = Some(m.end.reason);
    meta.observed_source_end_ms = None;
    meta.duration_ms = m.end.duration_ms;
    meta.final_visibility_extension_ms = 0.0;
    meta.validate_source().unwrap();
    for (format, duration, limit) in [
        (Format::Gif, 1120.0, 20.0),
        (Format::Mp4, 1108.0, 2.0),
        (Format::Mov, 1108.0, 2.0),
    ] {
        meta.settings.format = format;
        meta.duration_ms = duration;
        meta.final_visibility_extension_ms = duration - m.end.duration_ms;
        meta.validate_source().unwrap();
        assert!(matches!(
            parse_artifact_metadata(&serde_json::to_string(&meta).unwrap()).unwrap(),
            SourceArtifact::V2(_)
        ));
        meta.observed_source_end_ms = Some(m.end.duration_ms);
        assert!(meta.validate_source().is_err()); // Lower bound is not an observed stop/end.
        meta.observed_source_end_ms = None;
        meta.duration_ms = m.end.duration_ms + limit;
        meta.final_visibility_extension_ms = meta.duration_ms - m.end.duration_ms;
        assert!(meta.validate_source().is_err()); // Strictly less than two quanta.
    }
    meta.duration_ms = 1108.0;
    meta.final_visibility_extension_ms = meta.duration_ms - m.end.duration_ms;
    meta.partial = false;
    assert!(meta.validate_source().is_err());
    meta.partial = true;
    let mut no_final = m;
    no_final.frames[1].observation.purpose = Purpose::Sample;
    no_final.end.final_observation = FinalObservation::NotRequested;
    no_final.validate().unwrap();
    meta.source_manifest_json = Some(serde_json::to_string(&no_final).unwrap());
    assert!(meta.validate_source().is_err()); // No general partial-source extension exemption.
}

#[test]
fn persisted_without_end_final_visibility_still_forbids_backdating() {
    let m = durable_final_manifest();
    let f = &m.frames[1];
    let b: Value = serde_json::from_str(BOUNDARIES).unwrap();
    let mut row: OutputFrame = serde_json::from_str(TIMELINE.lines().last().unwrap()).unwrap();
    for boundary in b["final_visibility"].as_array().unwrap() {
        let q = boundary["quantum_ms"].as_f64().unwrap();
        row.pts_ms = boundary["pts_ms"].as_f64().unwrap();
        row.duration_ms = q;
        let end = boundary["output_end_ms"].as_f64().unwrap();
        validate_final_visibility(&row, f, m.end.duration_ms, q, end).unwrap();
        row.pts_ms -= q;
        assert!(validate_final_visibility(&row, f, m.end.duration_ms, q, end).is_err());
        row.pts_ms += 2.0 * q;
        assert!(validate_final_visibility(&row, f, m.end.duration_ms, q, end + q).is_err());
    }
}

#[test]
fn honest_request_counters_are_not_screencast_drop_counts() {
    let mut c = manifest().end.counters.unwrap();
    c.validate(2).unwrap();
    c.requests_started = MAX_SAFE_INTEGER + 1;
    assert!(c.validate(2).is_err());
    c.requests_started = 2;
    c.responses_received = 3;
    assert!(c.validate(2).is_err());
    c.responses_received = 2;
    c.observations_rejected = 1;
    assert!(c.validate(2).is_err());
    c.observations_rejected = 0;
    c.late_responses = 1;
    assert!(c.validate(2).is_err());
    reject(|m| m.end.counters.as_mut().unwrap().frames_sent = 3);
    reject(|m| m.end.counters.as_mut().unwrap().requests_started = 3);
    reject(|m| m.end.counters = None);
    let mut v = serde_json::to_value(manifest()).unwrap();
    v["end"]["drops"] = json!({"sampled":0,"backpressured":0,"invalid":0});
    assert!(serde_json::from_value::<Manifest>(v).is_err());
}

#[test]
fn final_visibility_is_ceil_not_backdating_and_less_than_two_container_quanta() {
    let m = manifest();
    let f = &m.frames[1];
    let b: Value = serde_json::from_str(BOUNDARIES).unwrap();
    let mut row: OutputFrame = serde_json::from_str(TIMELINE.lines().last().unwrap()).unwrap();
    for boundary in b["final_visibility"].as_array().unwrap() {
        let q = boundary["quantum_ms"].as_f64().unwrap();
        row.pts_ms = boundary["pts_ms"].as_f64().unwrap();
        row.duration_ms = boundary["duration_ms"].as_f64().unwrap();
        let end = boundary["output_end_ms"].as_f64().unwrap();
        validate_final_visibility(&row, f, m.end.duration_ms, q, end).unwrap();
        assert!(row.pts_ms >= f.t_ms);
        let original = row.pts_ms;
        row.pts_ms -= q;
        assert!(validate_final_visibility(&row, f, m.end.duration_ms, q, end).is_err());
        row.pts_ms = original + q;
        assert!(validate_final_visibility(&row, f, m.end.duration_ms, q, end + q).is_err());
        row.pts_ms = original;
        row.source.as_mut().unwrap().t_ms = original;
        assert!(validate_final_visibility(&row, f, m.end.duration_ms, q, end).is_err());
        row.source.as_mut().unwrap().t_ms = f.t_ms;
    }
    assert!(validate_final_visibility(&row, f, m.end.duration_ms, 0.0, 1108.0).is_err());
}

#[test]
fn precision_survives_typed_native_framing_without_one_ulp_tolerance() {
    let m = manifest();
    let expected = "1106.2999999523163".parse::<f64>().unwrap();
    assert_eq!(m.frames[1].t_ms.to_bits(), expected.to_bits());
    let mut value = serde_json::to_value(&m).unwrap();
    for _ in 0..8 {
        let bytes = crate::encode(&value).unwrap();
        value = crate::read_frame(&mut bytes.as_slice()).unwrap();
        let m: Manifest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            m.frames[1].observation.response_received_ms.to_bits(),
            expected.to_bits()
        );
        assert_eq!(m.frames[1].t_ms.to_bits(), expected.to_bits());
    }
    reject(|m| m.frames[1].t_ms = f64::from_bits(expected.to_bits() + 1));
}

#[test]
fn legacy_is_explicit_read_only_never_heuristically_upgraded() {
    let SourceManifest::Legacy(m) = parse_source_manifest(LEGACY).unwrap() else {
        panic!("not legacy")
    };
    assert_eq!(m.protocol_version, 1);
    assert_eq!(m.clock.origin, "before_start_screencast");
    assert!(matches!(
        parse_source_manifest(MANIFEST).unwrap(),
        SourceManifest::V2(_)
    ));
    let mut v: Value = serde_json::from_str(LEGACY).unwrap();
    for n in [0, 3, 999] {
        v["protocol_version"] = json!(n);
        assert!(parse_source_manifest(&v.to_string()).is_err());
    }
    v["protocol_version"] = json!(1);
    v["backend"] = json!("cdp_capture_screenshot");
    assert!(parse_source_manifest(&v.to_string()).is_err());
    v.as_object_mut().unwrap().remove("backend");
    v["frames"][0]["observation"] = json!({});
    assert!(parse_source_manifest(&v.to_string()).is_err());
    let mut v: Value = serde_json::from_str(MANIFEST).unwrap();
    v["clock"]["origin"] = json!("before_start_screencast");
    assert!(parse_source_manifest(&v.to_string()).is_err());
    // Exact original bytes remain in legacy fixture metadata; no v2 source facts are added.
    let metadata: crate::recording::ArtifactMetadata = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/recording/metadata.json"
    ))
    .unwrap();
    assert_eq!(metadata.source_manifest_json.as_deref(), Some(LEGACY));
    assert_eq!(
        metadata.source_manifest_sha256.as_deref(),
        Some("a26e86722e62cc7af02e3f64d78fa1589791cfa1c64b69f127441973db51be07")
    );
}

#[test]
fn offline_unverified_metadata_does_not_invent_backend_intervals_or_clock() {
    assert!(matches!(
        parse_artifact_metadata(METADATA).unwrap(),
        SourceArtifact::V2(_)
    ));
    let legacy = include_str!("../../../../tests/fixtures/recording/metadata.json");
    assert!(matches!(
        parse_artifact_metadata(legacy).unwrap(),
        SourceArtifact::Legacy(_)
    ));
    let mut bad: Value = serde_json::from_str(legacy).unwrap();
    bad["source_protocol_version"] = json!(2);
    assert!(parse_artifact_metadata(&bad.to_string()).is_err());
    bad.as_object_mut()
        .unwrap()
        .remove("source_protocol_version");
    bad["source_manifest_json"] = json!(MANIFEST);
    assert!(parse_artifact_metadata(&bad.to_string()).is_err());
    bad["schema_version"] = json!(999);
    assert!(parse_artifact_metadata(&bad.to_string()).is_err());
    let mut meta: ArtifactMetadata = serde_json::from_str(METADATA).unwrap();
    meta.validate_source().unwrap();
    meta.backend = Some(Backend::CdpCaptureScreenshot);
    assert!(meta.validate_source().is_err());
    meta.backend = None;
    meta.source_protocol_version = Some(2);
    assert!(meta.validate_source().is_err());
    meta.source_protocol_version = None;
    meta.final_visibility_extension_ms = 1.0;
    assert!(meta.validate_source().is_err());
}

#[test]
fn metadata_preserves_exact_v2_source_and_rejects_cross_version_claims() {
    let m = manifest();
    let mut meta: ArtifactMetadata = serde_json::from_str(METADATA).unwrap();
    meta.export_id = "export_02".into();
    meta.provenance = Provenance::Recording;
    meta.identity = Some(m.identity.clone());
    meta.source_protocol_version = Some(2);
    meta.backend = Some(Backend::CdpCaptureScreenshot);
    meta.source_manifest_json = Some(MANIFEST.into());
    // Digest authentication itself is deliberately outside this structural validator.
    meta.source_manifest_sha256 = Some("a".repeat(64));
    meta.end_reason = Some(EndReason::Stopped);
    meta.observed_source_end_ms = Some(m.end.duration_ms);
    meta.duration_ms = 1108.0;
    meta.final_visibility_extension_ms = meta.duration_ms - m.end.duration_ms;
    meta.validate_source().unwrap();
    meta.duration_ms = m.end.duration_ms + 2.0;
    meta.final_visibility_extension_ms = 2.0;
    assert!(meta.validate_source().is_err());
    meta.duration_ms = 1108.0;
    meta.final_visibility_extension_ms = meta.duration_ms - m.end.duration_ms;
    meta.source_manifest_json = Some(LEGACY.into());
    assert!(meta.validate_source().is_err());
    meta.source_manifest_json = Some(MANIFEST.into());
    meta.source_protocol_version = Some(1);
    assert!(meta.validate_source().is_err());
    meta.source_protocol_version = Some(2);
    meta.schema_version = 3;
    assert!(meta.validate_source().is_err());
}
