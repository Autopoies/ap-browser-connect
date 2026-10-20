//! Synthetic native/storage regressions; no Chrome or media-feature acceptance.
use super::tests::{local, wire, Fixture};
use super::*;
use serde_json::json;

pub(super) fn shot(
    f: &Fixture,
    id: &Identity,
    seq: u64,
    purpose: &str,
    start: f64,
    response: f64,
    validated: f64,
) -> Value {
    let mut v = f.frame(id, seq);
    v["t_ms"] = json!(response);
    v["observation"] = json!({"request_id":format!("shot_{seq}"),"purpose":purpose,
        "request_started_ms":start,"response_received_ms":response,"geometry_validated_ms":validated});
    v
}
fn stop(f: &Fixture, id: &Identity) {
    assert!(matches!(
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop"}),
            "browser_test"
        )
        .unwrap(),
        Route::Forward(_, Context::Stop(_))
    ));
}
fn manifest(f: &Fixture, id: &Identity) -> Value {
    local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "browser_test")
            .unwrap(),
    )
}
pub(super) fn stopped(f: &Fixture, id: &Identity) -> Value {
    let mut end = f.end(id, 2);
    end["end"]["reason"] = json!("stopped");
    end["end"]["duration_ms"] = json!(1106.4);
    end["end"]["cutoff"] = json!({"t_ms":1106.4,"provenance":"final_geometry_validation"});
    end["end"]["stop_requested_ms"] = json!(1000.0);
    end["end"]["final_observation"] =
        json!({"disposition":"accepted","request_id":"shot_2","seq":2});
    end
}
fn final_prefix(f: &Fixture, id: &Identity) {
    f.call(method::FRAME, shot(f, id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    stop(f, id);
    f.call(
        method::FRAME,
        shot(f, id, 2, "final", 1000.25, 1106.2999999523163, 1106.4),
    )
    .recv()
    .unwrap()
    .unwrap();
}

#[test]
fn explicit_final_is_durable_exact_and_terminal_source_is_immutable() {
    let f = Fixture::new();
    let (id, ctx) = f.start("explicit");
    f.started(&id, ctx);
    final_prefix(&f, &id);
    let ended = stopped(&f, &id);
    assert_eq!(
        f.call(method::ENDED, ended.clone())
            .recv()
            .unwrap()
            .unwrap()["state"],
        "sealed"
    );
    let m = manifest(&f, &id);
    parse::<Manifest>(m.clone()).unwrap().validate().unwrap();
    assert_eq!(
        m["frames"][1]["t_ms"].as_f64().unwrap().to_bits(),
        1106.2999999523163f64.to_bits()
    );
    let path = f.m.inner.lock().unwrap().sessions[&id.record_id]
        .path
        .clone();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(path.join("manifest")).unwrap()).unwrap(),
        m
    );
    assert_eq!(fs::read(path.join("frames")).unwrap().len(), 442);
    assert_eq!(
        f.call(method::ENDED, ended).recv().unwrap().unwrap()["state"],
        "sealed"
    );
    let mut bad = stopped(&f, &id);
    bad["end"]["stop_requested_ms"] = json!(999.0);
    assert!(f.call(method::ENDED, bad).recv().unwrap().is_err());
    assert!(f
        .call(
            method::FRAME,
            shot(&f, &id, 3, "sample", 1200.0, 1201.0, 1202.0)
        )
        .recv()
        .unwrap()
        .is_err());
    assert_eq!(manifest(&f, &id), m);
}

#[test]
fn durable_final_then_lost_end_retains_real_bytes_and_unknown_facts() {
    for disconnect in [false, true] {
        let f = Fixture::new();
        let (id, ctx) = f.start("lost_end");
        f.started(&id, ctx);
        final_prefix(&f, &id);
        if disconnect {
            f.m.disconnect();
        } else {
            f.m.inner
                .lock()
                .unwrap()
                .sessions
                .get_mut(&id.record_id)
                .unwrap()
                .control_since = Instant::now() - Duration::from_secs(11);
            assert_eq!(f.m.maintenance(), vec![id.clone()]);
        }
        let status = f.terminal(&id);
        assert_eq!(status["state"], "failed");
        assert_eq!(
            status["end"]["final_observation"],
            json!({"disposition":"persisted_without_end","request_id":"shot_2","seq":2})
        );
        assert_eq!(status["end"]["duration_observed"], false);
        assert_eq!(status["end"]["stop_requested_ms"], Value::Null);
        assert_eq!(status["end"]["counters"], Value::Null);
        assert_eq!(status["end"]["duration_ms"], 1106.4);
        let m = manifest(&f, &id);
        parse::<Manifest>(m.clone()).unwrap().validate().unwrap();
        assert_eq!(m["spool_bytes"], 442);
        let read = json!({"identity":id,"offset":0,"length":262144});
        let a = local(
            f.m.prepare(method::READ, read.clone(), "browser_test")
                .unwrap(),
        );
        assert_eq!(
            a,
            local(f.m.prepare(method::READ, read, "browser_test").unwrap())
        );
        assert_eq!(a["length"], 442);
        assert_eq!(a["sha256"], m["spool_sha256"]);
        assert!(f
            .call(method::ENDED, stopped(&f, &id))
            .recv()
            .unwrap()
            .is_err());
        assert_eq!(manifest(&f, &id), m);
    }
}

#[test]
fn producer_cannot_supply_host_loss_or_preparation_source() {
    for host_end in [false, true] {
        let f = Fixture::new();
        let (id, ctx) = f.start("untrusted");
        f.started(&id, ctx);
        if host_end {
            final_prefix(&f, &id);
            let mut v = stopped(&f, &id);
            v["end"]["final_observation"]["disposition"] = json!("persisted_without_end");
            assert!(f.call(method::ENDED, v).recv().unwrap().is_err());
            assert_eq!(f.terminal(&id)["state"], "failed");
            assert_eq!(manifest(&f, &id)["frames"].as_array().unwrap().len(), 2);
        } else {
            assert!(f
                .call(
                    method::FRAME,
                    shot(&f, &id, 1, "preparation", 0.0, 1.0, 2.0)
                )
                .recv()
                .unwrap()
                .is_err());
            assert_eq!(f.terminal(&id)["persisted_seq"], 0);
        }
    }
}

#[test]
fn invalid_intervals_identity_ids_and_final_order_never_become_source() {
    for case in 0..13 {
        let f = Fixture::new();
        let (id, ctx) = f.start("bad");
        f.started(&id, ctx);
        f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
            .recv()
            .unwrap()
            .unwrap();
        let mut frame = shot(&f, &id, 2, "sample", 110.0, 200.0, 210.0);
        match case {
            0 => frame["observation"]["request_id"] = json!("shot_1"),
            1 => frame["observation"]["request_started_ms"] = json!(109.0),
            2 => frame["t_ms"] = json!(200.00000000000003),
            3 => frame["observation"]["geometry_validated_ms"] = json!(199.0),
            4 => frame["observation"]["purpose"] = json!("final"), // no explicit stop
            5 => frame["observation"]["request_id"] = json!("bad/id"),
            6 => frame["observation"]["geometry_validated_ms"] = json!(1501.0),
            7 => frame["seq"] = json!(3),
            8 => frame["geometry"]["after"]["emulation"] = json!("unknown"),
            9 => frame["geometry"]["after"]["cdp"]["zoom"] = json!(2),
            10 => frame["jpeg_base64"] = json!("AAAA"),
            11 => frame["cdp_timestamp_s"] = json!(1),
            _ => frame["observation"]["request_started_ms"] = json!(-1),
        }
        assert!(
            f.call(method::FRAME, frame).recv().unwrap().is_err(),
            "case {case}"
        );
        assert_eq!(f.terminal(&id)["persisted_seq"], 1, "case {case}");
        assert_eq!(manifest(&f, &id)["frames"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn end_requires_exact_final_counters_stop_boundary_and_deadline() {
    for case in 0..7 {
        let f = Fixture::new();
        let (id, ctx) = f.start("end");
        f.started(&id, ctx);
        final_prefix(&f, &id);
        let mut e = stopped(&f, &id);
        match case {
            0 => e["end"]["final_observation"]["request_id"] = json!("wrong"),
            1 => e["end"]["cutoff"]["t_ms"] = json!(1106.4000000000003),
            2 => e["end"]["stop_requested_ms"] = json!(1001.0),
            3 => e["end"]["counters"]["frames_sent"] = json!(1),
            4 => e["end"]["counters"]["requests_started"] = json!(3),
            5 => e["end"]["final_seq"] = json!(1),
            _ => e["end"]["reason"] = json!("deadline"),
        }
        assert!(
            f.call(method::ENDED, e).recv().unwrap().is_err(),
            "case {case}"
        );
        assert_eq!(f.terminal(&id)["state"], "failed");
        assert_eq!(
            manifest(&f, &id)["end"]["final_observation"]["disposition"],
            "persisted_without_end"
        );
    }
    let f = Fixture::new();
    let (id, ctx) = f.start("deadline");
    f.started(&id, ctx);
    f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(
        f.call(method::ENDED, f.end(&id, 1))
            .recv()
            .unwrap()
            .unwrap()["state"],
        "sealed"
    );
    assert_eq!(
        manifest(&f, &id)["end"]["final_observation"]["disposition"],
        "not_requested"
    );
}

#[test]
fn same_tick_events_require_host_admission_before_stop_and_final_closes_source() {
    let f = Fixture::new();
    let (id, ctx) = f.start("ticks");
    f.started(&id, ctx);
    f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    let params = json!({"identity":id,"operation_id":"phase","text":"same tick"});
    f.m.prepare(method::PHASE, params.clone(), "browser_test")
        .unwrap();
    stop(&f, &id);
    assert!(f
        .m
        .prepare(
            method::PHASE,
            json!({"identity":id,"operation_id":"late","text":"same tick"}),
            "browser_test"
        )
        .is_err());
    let event = json!({"identity":id,"event":{"event_index":1,"operation_id":"phase","t_ms":1000.0,"kind":"phase","text":"same tick"}});
    f.call(method::EVENT, event).recv().unwrap().unwrap();
    f.call(
        method::FRAME,
        shot(&f, &id, 2, "final", 1000.0, 1106.2999999523163, 1106.4),
    )
    .recv()
    .unwrap()
    .unwrap();
    assert_eq!(
        f.call(method::ENDED, stopped(&f, &id))
            .recv()
            .unwrap()
            .unwrap()["state"],
        "sealed"
    );
    let m = manifest(&f, &id);
    parse::<Manifest>(m).unwrap().validate().unwrap();
}

#[test]
fn start_version_backend_and_capability_shape_are_strict_before_allocation() {
    let f = Fixture::new();
    for params in [
        json!({"tab_id":1}),
        json!({"_timeout_hint_secs":1}),
        json!([]),
        Value::Null,
    ] {
        assert!(f
            .m
            .prepare(method::CAPABILITIES, params, "browser_test")
            .is_err());
    }
    let Route::Forward(params, ctx) =
        f.m.prepare(method::CAPABILITIES, json!({}), "browser_test")
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(params, json!({}));
    let caps =
        f.m.complete(
            ctx,
            Ok(json!({"protocol_version":2,"backend":"cdp_capture_screenshot"})),
        )
        .unwrap();
    parse::<Capabilities>(caps).unwrap().validate().unwrap();
    for (field, v, code) in [
        ("protocol_version", json!(1), UNSUPPORTED_VERSION),
        ("protocol_version", json!("2"), "RECORD_INVALID_PARAMS"),
        ("backend", json!("screencast"), UNSUPPORTED_BACKEND),
    ] {
        let mut params = wire()["start"]["params"].clone();
        params[field] = v;
        assert_eq!(f.m.needs_start_preflight(&params).unwrap_err().0, code);
        assert!(f.m.prepare(method::START, params, "browser_test").is_err());
    }
    assert!(f.m.inner.lock().unwrap().sessions.is_empty());
}

#[test]
fn source_event_requires_preexisting_control_even_on_same_tick() {
    for registered in [false, true] {
        let f = Fixture::new();
        let (id, ctx) = f.start("event");
        f.started(&id, ctx);
        if registered {
            f.m.prepare(
                method::PHASE,
                json!({"identity":id,"operation_id":"op","text":"original"}),
                "browser_test",
            )
            .unwrap();
        }
        let event = json!({"identity":id,"event":{"event_index":1,"operation_id":"op","t_ms":0.0,"kind":"phase","text":"forged"}});
        assert!(f.call(method::EVENT, event).recv().unwrap().is_err());
        assert_eq!(f.terminal(&id)["state"], "failed");
        assert_eq!(manifest(&f, &id)["events"], json!([]));
    }
}

#[test]
fn started_facts_cannot_be_replaced() {
    let f = Fixture::new();
    let (id, ctx) = f.start("started");
    f.started(&id, ctx.clone());
    let mut changed = wire()["started"]["result"]["data"].clone();
    changed["identity"] = value(&id);
    changed["clock"]["uncertainty_ms"] = json!(5.0);
    assert!(f.m.complete(ctx, Ok(changed)).is_err());
    assert!(f.m.inner.lock().unwrap().sessions[&id.record_id]
        .started
        .as_ref()
        .unwrap()
        .clock
        .uncertainty_ms
        .is_none());
}

#[test]
fn started_must_match_admitted_source_even_before_disk_completion() {
    let f = Fixture::new();
    let (id, ctx) = f.start("pending_started");
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let frame = f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0));
    pause.wait();
    let mut changed = wire()["started"]["result"]["data"].clone();
    changed["identity"] = value(&id);
    changed["resolved_region_css"]["width"] = json!(15.0);
    assert!(f.m.complete(ctx, Ok(changed)).is_err());
    pause.wait();
    assert!(frame.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
    assert_eq!(f.terminal(&id)["persisted_seq"], 0);
}

#[test]
fn end_barrier_does_not_renew_original_stop_budget() {
    let f = Fixture::new();
    let (id, ctx) = f.start("budget");
    f.started(&id, ctx);
    f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    stop(&f, &id);
    let original = Instant::now() - Duration::from_secs(9);
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .control_since = original;
    // A delayed barrier while Started/write work drains must use the same budget.
    let end = f.call(method::ENDED, f.end(&id, 1));
    assert_eq!(
        f.m.inner.lock().unwrap().sessions[&id.record_id].control_since,
        original
    );
    end.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
}

#[test]
fn end_before_started_does_not_renew_original_start_budget() {
    let f = Fixture::new();
    let (id, ctx) = f.start("start_budget");
    f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    let original = Instant::now() - Duration::from_secs(9);
    {
        let mut i = f.m.inner.lock().unwrap();
        let s = i.sessions.get_mut(&id.record_id).unwrap();
        s.created = original;
        s.control_since = original;
    }
    let end = f.call(method::ENDED, f.end(&id, 1));
    assert_eq!(
        f.m.inner.lock().unwrap().sessions[&id.record_id].control_since,
        original
    );
    f.started(&id, ctx);
    end.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
}

#[test]
fn stop_during_native_write_cannot_allow_an_additional_sample() {
    let f = Fixture::new();
    let (id, ctx) = f.start("write_stop");
    f.started(&id, ctx);
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let first = f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0));
    pause.wait();
    stop(&f, &id);
    pause.wait();
    first.recv().unwrap().unwrap();
    assert!(f
        .call(
            method::FRAME,
            shot(&f, &id, 2, "sample", 110.0, 120.0, 130.0)
        )
        .recv()
        .unwrap()
        .is_err());
    assert_eq!(f.terminal(&id)["persisted_seq"], 1);
}

#[test]
fn earlier_sample_can_drain_on_stop_tick_then_one_final_or_explicit_partial() {
    let f = Fixture::new();
    let (id, ctx) = f.start("inflight");
    f.started(&id, ctx);
    stop(&f, &id);
    f.call(
        method::FRAME,
        shot(&f, &id, 1, "sample", 1000.0, 1001.0, 1002.0),
    )
    .recv()
    .unwrap()
    .unwrap();
    f.call(
        method::FRAME,
        shot(&f, &id, 2, "final", 1002.0, 1106.2999999523163, 1106.4),
    )
    .recv()
    .unwrap()
    .unwrap();
    assert_eq!(
        f.call(method::ENDED, stopped(&f, &id))
            .recv()
            .unwrap()
            .unwrap()["state"],
        "sealed"
    );

    let f = Fixture::new();
    let (id, ctx) = f.start("failed_final");
    f.started(&id, ctx);
    f.call(method::FRAME, shot(&f, &id, 1, "sample", 0.0, 100.0, 110.0))
        .recv()
        .unwrap()
        .unwrap();
    stop(&f, &id);
    let mut ended = f.end(&id, 1);
    ended["end"]["duration_ms"] = json!(1100.0);
    ended["end"]["reason"] = json!("final_observation_failed");
    ended["end"]["cutoff"] = json!({"t_ms":1100.0,"provenance":"admission_closed"});
    ended["end"]["stop_requested_ms"] = json!(1000.0);
    ended["end"]["final_observation"] = json!({"disposition":"failed","attempt":{"request_id":"failed_final_2","request_started_ms":1000.0},"reason":"request_failed"});
    ended["end"]["counters"]["requests_started"] = json!(2);
    ended["end"]["counters"]["request_failures"] = json!(1);
    assert_eq!(
        f.call(method::ENDED, ended).recv().unwrap().unwrap()["state"],
        "failed"
    );
    let m = manifest(&f, &id);
    parse::<Manifest>(m.clone()).unwrap().validate().unwrap();
    assert_eq!(m["spool_bytes"], 221);
    assert_eq!(
        m["end"]["final_observation"]["attempt"]["request_id"],
        "failed_final_2"
    );
}

#[test]
fn native_event_payloads_are_bounded_before_persistence() {
    for case in 0..7 {
        let f = Fixture::new();
        let (id, ctx) = f.start("event_bounds");
        f.started(&id, ctx);
        f.m.prepare(
            method::PHASE,
            json!({"identity":id,"operation_id":"op","text":"ok"}),
            "browser_test",
        )
        .unwrap();
        let mut event = json!({"identity":id,"event":{"event_index":1,"operation_id":"op","t_ms":0.0,"kind":"phase","text":"ok"}});
        match case {
            0 => event["event"]["text"] = json!("界".repeat(171)),
            1 => event["event"]["text"] = json!("bad\u{0000}"),
            2 => event["event"]["operation_id"] = json!("../op"),
            3 => event["event"]["t_ms"] = json!(1501.0),
            4 => event["event"]["event_index"] = json!(2),
            5 => event["event"]["text"] = json!("\n".repeat(8)),
            _ => {
                event["event"]["kind"] = json!("mark");
                event["event"]["duration_ms"] = json!(0);
            }
        }
        assert!(
            f.call(method::EVENT, event).recv().unwrap().is_err(),
            "case {case}"
        );
        f.terminal(&id);
        assert_eq!(manifest(&f, &id)["events"], json!([]));
    }
}
