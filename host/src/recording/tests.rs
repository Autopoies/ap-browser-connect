use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
pub(super) static NEXT: AtomicU64 = AtomicU64::new(0);
pub(super) struct Fixture {
    pub(super) m: Arc<Manager>,
    parent: PathBuf,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let parent = std::env::temp_dir().join(format!(
            "recording-host-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        private_dir(&parent).unwrap();
        Self {
            m: Manager::in_parent(&parent).unwrap(),
            parent,
        }
    }
    pub(super) fn start(&self, op: &str) -> (Identity, Context) {
        let mut req = wire()["start"]["params"].clone();
        req["operation_id"] = json!(op);
        let Route::Forward(params, ctx) =
            self.m.prepare(method::START, req, "browser_test").unwrap()
        else {
            panic!()
        };
        let id: Identity = parse(params["identity"].clone()).unwrap();
        assert_eq!(params["initial_credit"]["next_seq"], 1);
        (id, ctx)
    }
    pub(super) fn started(&self, id: &Identity, ctx: Context) {
        let mut v = wire()["started"]["result"]["data"].clone();
        v["identity"] = value(id);
        self.m.complete(ctx, Ok(v)).unwrap();
    }
    pub(super) fn call(&self, method: &str, params: Value) -> mpsc::Receiver<Result<Value>> {
        let (tx, rx) = mpsc::channel();
        self.m.source(
            method,
            params,
            Box::new(move |v| {
                tx.send(v).unwrap();
            }),
        );
        rx
    }
    pub(super) fn frame(&self, id: &Identity, seq: u64) -> Value {
        let mut v = wire()["frame"]["params"].clone();
        v["identity"] = value(id);
        v["seq"] = json!(seq);
        v["observation"]["request_id"] = json!(format!("shot_{seq}"));
        v
    }
    pub(super) fn status(&self, id: &Identity) -> Value {
        local(
            self.m
                .prepare(method::STATUS, json!({"identity":id}), "browser_test")
                .unwrap(),
        )
    }
    pub(super) fn end(&self, id: &Identity, n: u64) -> Value {
        let mut v = wire()["ended"]["params"].clone();
        v["identity"] = value(id);
        v["end"]["final_seq"] = json!(n);
        v["end"]["counters"]["requests_started"] = json!(n);
        v["end"]["counters"]["responses_received"] = json!(n);
        v["end"]["counters"]["frames_sent"] = json!(n);
        if n == 0 {
            v["end"]["reason"] = json!("no_frames");
        }
        v
    }
    fn seal_one(&self, id: &Identity) {
        self.call(method::FRAME, self.frame(id, 1))
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        self.call(method::ENDED, self.end(id, 1))
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
    }
    pub(super) fn terminal(&self, id: &Identity) -> Value {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            let s = self.status(id);
            if s["end"].is_object() {
                return s;
            }
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}
pub(super) fn wire() -> Value {
    // Reuse the exact legacy JPEG/event/chunk bytes, not its live protocol.
    let mut wire: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/recording/wire.json")).unwrap();
    let v2: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording-v2/wire.json"
    ))
    .unwrap();
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/recording-v2/manifest.json"
    ))
    .unwrap();
    wire["start"] = v2["start"].clone();
    wire["start"]["params"]["operation_id"] = json!("op_start_1");
    wire["started"] = v2["started"].clone();
    let frame = wire["frame"]["params"].as_object_mut().unwrap();
    frame.remove("cdp_timestamp_s");
    frame.insert("geometry".into(), manifest["frames"][0]["geometry"].clone());
    frame.insert(
        "observation".into(),
        json!({"request_id":"shot_1","purpose":"sample",
        "request_started_ms":0.0,"response_received_ms":0.0,"geometry_validated_ms":0.0}),
    );
    wire["ended"]["params"]["end"] = json!({"final_seq":1,"duration_ms":1500.0,"duration_observed":true,
        "reason":"deadline","cutoff":{"t_ms":1500.0,"provenance":"deadline"},"stop_requested_ms":null,
        "final_observation":{"disposition":"not_requested"},"counters":{"preparation_requests":2,
        "preparation_responses":2,"requests_started":1,"responses_received":1,"request_failures":0,
        "observations_rejected":0,"late_responses":0,"frames_sent":1,"scheduling_delays":0}});
    wire
}
pub(super) fn local(r: Route) -> Value {
    if let Route::Local(v) = r {
        v
    } else {
        panic!("expected host-local route")
    }
}

#[test]
fn slot_retry_conflict_busy_and_tombstones() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op_start_1");
    let req = wire()["start"]["params"].clone();
    assert_eq!(
        local(
            f.m.prepare(method::START, req.clone(), "other_instance")
                .unwrap()
        )["identity"],
        value(&id)
    );
    let mut changed = req.clone();
    changed["config"]["capture_fps"] = json!(3);
    assert!(matches!(
        f.m.prepare(method::START, changed, "x"),
        Err(Error("RECORD_OPERATION_CONFLICT", _))
    ));
    let mut other = req.clone();
    other["operation_id"] = json!("other");
    assert!(matches!(
        f.m.prepare(method::START, other, "x"),
        Err(Error("RECORD_BUSY", _))
    ));
    f.started(&id, ctx);
    f.seal_one(&id);
    f.m.release(HandleRequest {
        identity: id.clone(),
    })
    .unwrap();
    assert!(
        f.m.release(HandleRequest { identity: id })
            .unwrap()
            .released
    );
    assert!(matches!(
        f.m.prepare(method::START, req, "x"),
        Err(Error("RECORD_NOT_FOUND", _))
    ));
}

#[test]
fn frames_before_started_durable_credit_seal_and_immutable_chunk_hashes() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    let ack = f
        .call(method::FRAME, f.frame(&id, 1))
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert_eq!(ack["credit"]["next_seq"], 2);
    assert_eq!(ack["credit"]["identity"], value(&id));
    assert_eq!(f.status(&id)["persisted_seq"], 1);
    let end = f.end(&id, 1);
    let rx = f.call(method::ENDED, end.clone());
    assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
    f.started(&id, ctx);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["state"],
        "sealed"
    );
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    let r = ReadRequest {
        identity: id.clone(),
        offset: 0,
        length: 262144,
    };
    let a = f.m.read(r.clone()).unwrap();
    let b = f.m.read(r).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.length, 221);
    assert_eq!(
        a.sha256,
        wire()["chunk"]["result"]["data"]["sha256"]
            .as_str()
            .unwrap()
    );
    assert_eq!(manifest["spool_sha256"], a.sha256);
    let eof =
        f.m.read(ReadRequest {
            identity: id.clone(),
            offset: 221,
            length: 1,
        })
        .unwrap();
    assert_eq!(eof.length, 0);
    assert_eq!(eof.sha256, digest(b""));
    assert!(eof.eof);
    let duplicate = f.call(method::ENDED, end.clone()).recv().unwrap().unwrap();
    assert_eq!(duplicate["state"], "sealed");
    let mut bad = end;
    bad["end"]["duration_ms"] = json!(1400);
    assert!(f.call(method::ENDED, bad).recv().unwrap().is_err());
    assert_eq!(
        manifest,
        local(
            f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
                .unwrap()
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let i = f.m.inner.lock().unwrap();
        let s = i.sessions.get(&id.record_id).unwrap();
        assert_eq!(
            fs::metadata(&s.path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for file in ["frames", "events", "manifest"] {
            assert_eq!(
                fs::metadata(s.path.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn slow_writer_does_not_block_status_stop_or_end_barrier() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let frame = f.call(method::FRAME, f.frame(&id, 1));
    pause.wait();
    assert!(frame.try_recv().is_err());
    let now = Instant::now();
    assert_eq!(f.status(&id)["persisted_seq"], 0);
    let Route::Forward(_, stop_ctx) =
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop1"}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    let duplicate = local(
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop2"}),
            "x",
        )
        .unwrap(),
    );
    assert_eq!(duplicate["state"], "stopping");
    let end = f.call(method::ENDED, f.end(&id, 1));
    assert!(end.try_recv().is_err());
    assert!(now.elapsed() < Duration::from_millis(200));
    let response =
        f.m.complete(
            stop_ctx,
            Ok(value(EndAccepted {
                identity: id.clone(),
                state: State::Stopping,
            })),
        )
        .unwrap();
    assert_eq!(response["state"], "stopping");
    pause.wait();
    frame.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(
        end.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()["state"],
        "sealed"
    );
}

#[test]
fn second_uncredited_frame_fails_without_crashing_or_double_append() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let first = f.call(method::FRAME, f.frame(&id, 1));
    pause.wait();
    let error = f
        .call(method::FRAME, f.frame(&id, 2))
        .recv()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.0, "RECORD_SEQUENCE");
    pause.wait();
    assert!(first.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
    let status = f.terminal(&id);
    assert_eq!(status["state"], "failed");
    assert_eq!(status["persisted_seq"], 0);
    let (other, ctx) = f.start("other");
    f.started(&other, ctx);
    f.seal_one(&other);
}

#[test]
fn bad_frames_are_isolated_and_never_append() {
    for case in 0..7 {
        let f = Fixture::new();
        let (id, ctx) = f.start("op");
        f.started(&id, ctx);
        let mut frame = f.frame(&id, 1);
        match case {
            0 => frame["jpeg_base64"] = json!("not base64!"),
            1 => {
                frame["jpeg_base64"] =
                    json!("x".repeat((MAX_FRAME_BYTES as usize).div_ceil(3) * 4 + 4))
            }
            2 => frame["width"] = json!(17),
            3 => frame["t_ms"] = json!(-1),
            4 => frame["seq"] = json!(9007199254740992u64),
            5 => frame["geometry"]["css_to_image"]["scale_x"] = json!(2),
            _ => frame["jpeg_base64"] = json!("/9j/2Q=="),
        }
        assert!(f
            .call(method::FRAME, frame)
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err());
        assert_eq!(f.terminal(&id)["persisted_seq"], 0);
    }
}

#[test]
fn malicious_ids_offsets_directions_and_parse_errors_return_errors() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.seal_one(&id);
    for record_id in ["../frames", "", "a/b", "a\\b"] {
        let bad = Identity {
            host_epoch: id.host_epoch.clone(),
            record_id: record_id.into(),
        };
        assert!(f
            .m
            .prepare(method::STATUS, json!({"identity":bad}), "x")
            .is_err());
    }
    let stale = Identity {
        host_epoch: "old_host".into(),
        record_id: id.record_id.clone(),
    };
    assert!(matches!(
        f.m.prepare(method::STATUS, json!({"identity":stale}), "x"),
        Err(Error("RECORD_STALE_HOST", _))
    ));
    for (offset, length) in [(222, 1), (u64::MAX, 1), (0, 0), (0, MAX_CHUNK_BYTES + 1)] {
        assert!(f
            .m
            .read(ReadRequest {
                identity: id.clone(),
                offset,
                length
            })
            .is_err());
    }
    assert!(f
        .m
        .prepare(
            method::READ,
            json!({"identity":id,"offset":-1,"length":1}),
            "x"
        )
        .is_err());
    for method in [method::STATUS, "record.export", method::FRAME] {
        assert!(f
            .call(method, json!({"bogus":true}))
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
    }
    assert!(f.m.prepare(method::FRAME, f.frame(&id, 1), "x").is_err());
}

#[test]
fn events_retry_conflict_boundaries_and_partial_observed_lower_bound() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let mut event = wire()["event"]["params"].clone();
    event["identity"] = value(&id);
    let phase_req = json!({"identity":id,"operation_id":"op_phase_1","text":"air collision"});
    let Route::Forward(_, phase_context) = f.m.prepare(method::PHASE, phase_req, "x").unwrap()
    else {
        panic!()
    };
    let original = f
        .call(method::EVENT, event.clone())
        .recv()
        .unwrap()
        .unwrap();
    assert_eq!(
        f.m.complete(phase_context, Ok(original.clone())).unwrap(),
        original
    );
    let Route::Forward(_, mark_context) =
        f.m.prepare(
            method::MARK,
            json!({"identity":id,"operation_id":"new_mark","text":"note","duration_ms":1}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.m.complete(mark_context, Ok(original.clone())),
        Err(Error("RECORD_OPERATION_CONFLICT", _))
    ));
    assert_eq!(
        original,
        f.call(method::EVENT, event.clone())
            .recv()
            .unwrap()
            .unwrap()
    );
    let phase = json!({"identity":id,"operation_id":"op_phase_1","text":"air collision"});
    assert_eq!(
        local(f.m.prepare(method::PHASE, phase, "x").unwrap()),
        original
    );
    f.m.disconnect();
    let status = f.terminal(&id);
    assert_eq!(status["end"]["duration_ms"], 200.0);
    assert_eq!(status["end"]["duration_observed"], false);
    assert_eq!(status["end"]["reason"], "native_disconnected");
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    assert_eq!(manifest["events"].as_array().unwrap().len(), 1);
    event["event"]["text"] = json!("changed");
    assert!(f.call(method::EVENT, event).recv().unwrap().is_err());
    assert_eq!(
        manifest,
        local(
            f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
                .unwrap()
        )
    );
}

#[test]
fn geometry_changes_fail_but_scroll_is_retained() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let mut second = f.frame(&id, 2);
    second["geometry"]["after"]["dom"]["scroll_y"] = json!(300);
    f.call(method::FRAME, second).recv().unwrap().unwrap();
    let mut third = f.frame(&id, 3);
    third["geometry"]["after"]["cdp"]["zoom"] = json!(2);
    assert!(f.call(method::FRAME, third).recv().unwrap().is_err());
    assert_eq!(f.terminal(&id)["end"]["reason"], "geometry_changed");
    assert_eq!(f.m.maintenance(), vec![id]); // one pinned best-effort stop, even after failure sealed
    assert!(f.m.maintenance().is_empty());
}

#[test]
fn quotas_expiry_tombstones_start_timeout_and_zero_frame_failure() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.m.inner.lock().unwrap().reserved_bytes = MAX_TOTAL_SPOOL_BYTES;
    assert!(f
        .call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .is_err());
    assert_eq!(f.terminal(&id)["end"]["reason"], "storage_limit");
    f.m.inner.lock().unwrap().reserved_bytes = 0;
    for n in 1..4 {
        let (id, ctx) = f.start(&format!("op{n}"));
        f.started(&id, ctx);
        let ended = f
            .call(method::ENDED, f.end(&id, 0))
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(ended["state"], "failed");
        assert_eq!(f.status(&id)["end"]["reason"], "no_frames");
    }
    let mut req = wire()["start"]["params"].clone();
    req["operation_id"] = json!("fifth");
    assert!(matches!(
        f.m.prepare(method::START, req.clone(), "x"),
        Err(Error("RECORD_LIMIT", _))
    ));
    {
        let mut i = f.m.inner.lock().unwrap();
        for s in i.sessions.values_mut() {
            s.retained = Some(Instant::now() - Duration::from_millis(RETENTION_MS + 1));
        }
    }
    f.m.maintenance();
    assert!(f.m.inner.lock().unwrap().sessions.is_empty());
    let (id, _) = f.start("fifth");
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .created = Instant::now() - Duration::from_secs(11);
    assert_eq!(f.m.maintenance(), vec![id.clone()]);
    assert_eq!(f.terminal(&id)["state"], "failed");
    assert!(matches!(
        f.m.prepare(method::START, req, "x"),
        Ok(Route::Local(_))
    ));
}

#[test]
fn disk_failure_does_not_kill_manager_and_deadline_reconciles_identity() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    {
        let mut i = f.m.inner.lock().unwrap();
        let s = i.sessions.get_mut(&id.record_id).unwrap();
        s.capture_since = Some(Instant::now() - Duration::from_secs(2));
    }
    assert_eq!(f.m.maintenance(), vec![id.clone()]);
    assert_eq!(f.status(&id)["state"], "stopping");
    let path = f.m.inner.lock().unwrap().sessions[&id.record_id]
        .path
        .join("frames");
    fs::remove_file(path).unwrap();
    assert!(f
        .call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .is_err());
    assert_eq!(f.terminal(&id)["end"]["reason"], "storage_error");
}

#[test]
fn startup_cleanup_keeps_live_sessions_and_ignores_symlinks() {
    let f = Fixture::new();
    let live = f.m.root.clone();
    cleanup_stale(&f.parent).unwrap();
    assert!(live.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let dead = f.parent.join("host_2147483647_1");
        private_dir(&dead).unwrap();
        private_file(&dead.join("frames")).unwrap();
        let target = f.parent.join("not-owned");
        private_dir(&target).unwrap();
        let link = f.parent.join("host_2147483647_2");
        symlink(&target, &link).unwrap();
        let reused = f.parent.join(format!("host_{}_old", std::process::id()));
        private_dir(&reused).unwrap();
        private_file(&reused.join("owner")).unwrap(); // no epoch lock: stale despite a live/reused PID
        cleanup_stale(&f.parent).unwrap();
        assert!(!dead.exists());
        assert!(!reused.exists());
        assert!(link.exists());
        assert!(target.exists());
    }
}

#[test]
fn stop_during_start_is_deferred_and_end_mismatch_fails_partial() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    let status = local(
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop"}),
            "x",
        )
        .unwrap(),
    );
    assert_eq!(status["state"], "stopping");
    let mut started = wire()["started"]["result"]["data"].clone();
    started["identity"] = value(&id);
    assert_eq!(f.m.complete(ctx, Ok(started)).unwrap()["state"], "stopping");
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let mut bad_end = f.end(&id, 2);
    bad_end["end"]["duration_ms"] = json!(1500);
    assert_eq!(
        f.call(method::ENDED, bad_end)
            .recv()
            .unwrap()
            .unwrap_err()
            .0,
        "RECORD_SEQUENCE"
    );
    let status = f.terminal(&id);
    assert_eq!(status["persisted_seq"], 1);
    assert_eq!(status["end"]["duration_ms"], 0.0);
    assert_eq!(status["end"]["duration_observed"], false);
}

#[test]
fn manifest_storage_error_retains_failed_immutable_in_memory_snapshot() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let path = f.m.inner.lock().unwrap().sessions[&id.record_id]
        .path
        .clone();
    private_file(&path.join("manifest-new")).unwrap(); // force create_new failure
    assert_eq!(
        f.call(method::ENDED, f.end(&id, 1))
            .recv()
            .unwrap()
            .unwrap()["state"],
        "failed"
    );
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    assert_eq!(manifest["end"]["reason"], "storage_error");
    assert_eq!(manifest["state"], "failed");
    assert_eq!(manifest["end"]["duration_ms"], 0.0);
    assert_eq!(manifest["spool_bytes"], 221);
    assert_eq!(
        manifest,
        local(
            f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
                .unwrap()
        )
    );
}

#[test]
fn timeline_and_operation_cache_caps_and_pending_frame_timeout_are_bounded() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    {
        let mut i = f.m.inner.lock().unwrap();
        let s = i.sessions.get_mut(&id.record_id).unwrap();
        s.admitted_events = (0..MAX_EVENTS)
            .map(|n| Event {
                event_index: n as u64 + 1,
                operation_id: format!("event{n}"),
                t_ms: 0.0,
                kind: EventKind::Phase {
                    text: String::new(),
                },
            })
            .collect();
    }
    let event = EventRequest {
        identity: id.clone(),
        event: Event {
            event_index: MAX_EVENTS as u64 + 1,
            operation_id: "overflow".into(),
            t_ms: 0.0,
            kind: EventKind::Phase {
                text: String::new(),
            },
        },
    };
    assert_eq!(
        f.call(method::EVENT, value(event))
            .recv()
            .unwrap()
            .unwrap_err()
            .0,
        "RECORD_LIMIT"
    );
    f.terminal(&id);
    let req: StartRequest = parse(wire()["start"]["params"].clone()).unwrap();
    {
        let mut i = f.m.inner.lock().unwrap();
        for n in 0..4096 {
            let mut r = req.clone();
            r.operation_id = format!("old{n}");
            i.operations.insert(r.operation_id.clone(), r);
        }
    }
    assert!(matches!(
        f.m.prepare(method::START, value(req), "x"),
        Err(Error("RECORD_LIMIT", _))
    ));
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let frame = f.call(method::FRAME, f.frame(&id, 1));
    pause.wait();
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .frame_since = Some(Instant::now() - Duration::from_secs(11));
    assert_eq!(f.m.maintenance(), vec![id.clone()]);
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .control_since = Instant::now() - Duration::from_secs(11);
    for _ in 0..3 {
        assert!(
            f.m.maintenance().is_empty(),
            "failed/stalled session must not retry stop forever"
        );
    }
    pause.wait();
    assert!(frame.recv().unwrap().is_err());
    assert_eq!(f.terminal(&id)["end"]["reason"], "credit_timeout");
}

#[test]
fn disconnect_shutdown_is_bounded_and_a_new_epoch_never_resumes_old_handles() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let frame = f.call(method::FRAME, f.frame(&id, 1));
    pause.wait();
    let start = Instant::now();
    f.m.shutdown(Duration::from_millis(30));
    assert!(start.elapsed() < Duration::from_millis(200));
    // The worker did not finish: shutdown must not claim a durable sealed partial.
    assert_eq!(f.status(&id)["state"], "stopping");
    assert!(f.status(&id)["end"].is_null());
    let next = Manager::in_parent(&f.parent).unwrap();
    assert!(matches!(
        next.prepare(method::STATUS, json!({"identity":id}), "x"),
        Err(Error("RECORD_STALE_HOST", _))
    ));
    pause.wait();
    assert!(frame.recv().unwrap().is_err());
    assert_eq!(f.terminal(&id)["end"]["reason"], "native_disconnected");
}

#[test]
fn exact_frame_byte_cap_and_padding_reservations_are_enforced() {
    for extra in [0, 1] {
        let f = Fixture::new();
        let (id, ctx) = f.start("op");
        f.started(&id, ctx);
        let mut frame = f.frame(&id, 1);
        let mut jpeg = STANDARD
            .decode(frame["jpeg_base64"].as_str().unwrap())
            .unwrap();
        jpeg.truncate(jpeg.len() - 2);
        jpeg.resize(MAX_FRAME_BYTES as usize + extra - 2, 0);
        jpeg.extend([0xff, 0xd9]);
        frame["jpeg_base64"] = json!(STANDARD.encode(jpeg));
        let result = f
            .call(method::FRAME, frame)
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        if extra == 0 {
            result.unwrap();
            assert_eq!(f.status(&id)["spool_bytes"], MAX_FRAME_BYTES);
            assert_eq!(f.m.inner.lock().unwrap().reserved_bytes, MAX_FRAME_BYTES);
            f.call(method::ENDED, f.end(&id, 1))
                .recv()
                .unwrap()
                .unwrap();
        } else {
            assert!(result.is_err());
            assert_eq!(f.terminal(&id)["persisted_seq"], 0);
        }
        f.m.release(HandleRequest { identity: id }).unwrap();
        assert_eq!(f.m.inner.lock().unwrap().reserved_bytes, 0);
    }
}

#[test]
fn control_error_barrier_is_partial_even_after_stop_ack_and_preserves_receipt_clock() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let mut second = f.frame(&id, 2);
    second["t_ms"] = json!(500.0);
    second["observation"]["response_received_ms"] = json!(500.0);
    second["observation"]["geometry_validated_ms"] = json!(510.0);
    f.call(method::FRAME, second).recv().unwrap().unwrap();
    let Route::Forward(_, stop) =
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop"}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    let status =
        f.m.complete(
            stop,
            Ok(value(EndAccepted {
                identity: id.clone(),
                state: State::Sealed,
            })),
        )
        .unwrap();
    assert_eq!(status["state"], "stopping");
    assert!(status["end"].is_null());
    let mut ended = f.end(&id, 2);
    ended["end"]["reason"] = json!("control_error");
    ended["end"]["duration_ms"] = json!(1000.0);
    ended["end"]["cutoff"] = json!({"t_ms":1000.0,"provenance":"admission_closed"});
    assert_eq!(
        f.call(method::ENDED, ended).recv().unwrap().unwrap()["state"],
        "failed"
    );
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    assert_eq!(manifest["end"]["reason"], "control_error");
    assert_eq!(manifest["end"]["duration_ms"], 1000.0);
    assert_eq!(manifest["end"]["duration_observed"], true);
    assert_eq!(manifest["frames"].as_array().unwrap().len(), 2);
    assert_eq!(manifest["frames"][1]["t_ms"], 500.0);
    assert_eq!(
        manifest["frames"][1]["observation"]["geometry_validated_ms"],
        510.0
    );
}

#[test]
fn control_rpc_failure_preserves_available_observed_end_and_acknowledged_prefix() {
    let f = Fixture::new();
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    // Reserve through actual host control admission before stop closes the slot.
    f.m.prepare(
        method::PHASE,
        json!({"identity":id,"operation_id":"op_phase_1","text":"air collision"}),
        "x",
    )
    .unwrap();
    let Route::Forward(_, stop) =
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"stop"}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    let mut event = wire()["event"]["params"].clone();
    event["identity"] = value(&id);
    let pending_event = f.call(method::EVENT, event);
    pause.wait();
    let mut ended = f.end(&id, 1);
    ended["end"]["reason"] = json!("control_error");
    ended["end"]["duration_ms"] = json!(750.0);
    ended["end"]["cutoff"] = json!({"t_ms":750.0,"provenance":"admission_closed"});
    let barrier = f.call(method::ENDED, ended);
    let status =
        f.m.complete(stop, Err(Error("RECORD_INTERRUPTED", "CDP stop failed")))
            .unwrap();
    assert_eq!(status["state"], "stopping");
    pause.wait();
    pending_event.recv().unwrap().unwrap(); // valid admitted work drains despite control failure
    assert_eq!(
        barrier
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()["state"],
        "failed"
    );
    let status = f.terminal(&id);
    assert_eq!(status["persisted_seq"], 1);
    assert_eq!(status["spool_bytes"], 221);
    assert_eq!(status["end"]["reason"], "control_error");
    assert_eq!(status["end"]["duration_ms"], 750.0);
    assert_eq!(status["end"]["duration_observed"], true);
}

#[test]
fn stop_control_timeout_is_not_a_false_disconnect_or_successful_seal() {
    for (code, reason) in [
        ("TIMEOUT", "control_error"),
        ("EXTENSION_DISCONNECTED", "native_disconnected"),
    ] {
        let f = Fixture::new();
        let (id, ctx) = f.start("op");
        f.started(&id, ctx);
        f.call(method::FRAME, f.frame(&id, 1))
            .recv()
            .unwrap()
            .unwrap();
        let Route::Forward(_, stop) =
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":"stop"}),
                "x",
            )
            .unwrap()
        else {
            panic!()
        };
        let status =
            f.m.complete(stop, Err(Error(code, "stop unconfirmed")))
                .unwrap();
        if code == "TIMEOUT" {
            assert_eq!(status["state"], "stopping");
            assert!(status["end"].is_null());
            f.m.inner
                .lock()
                .unwrap()
                .sessions
                .get_mut(&id.record_id)
                .unwrap()
                .control_since = Instant::now() - Duration::from_secs(11);
            f.m.maintenance();
        }
        let status = f.terminal(&id);
        assert_eq!(status["state"], "failed");
        assert_eq!(status["end"]["reason"], reason);
        assert_eq!(status["persisted_seq"], 1);
        assert_eq!(status["end"]["duration_observed"], false);
    }
}

#[test]
fn start_control_rejection_timeout_and_actual_disconnect_have_truthful_reasons() {
    for (code, reason) in [
        ("TIMEOUT", "control_error"),
        ("RECORD_INTERRUPTED", "control_error"),
        ("EXTENSION_DISCONNECTED", "native_disconnected"),
    ] {
        let f = Fixture::new();
        let (id, ctx) = f.start("op");
        assert!(f
            .m
            .complete(ctx, Err(Error(code, "control failed")))
            .is_err());
        let status = f.terminal(&id);
        assert_eq!(status["end"]["reason"], reason);
        assert_eq!(status["state"], "failed");
        assert_eq!(status["end"]["duration_observed"], false);
    }
}

#[test]
fn lost_started_watchdog_holds_failure_for_one_cached_provenance_recovery() {
    let f = Fixture::new();
    let (id, ctx) = f.start("original");
    let mut frame = f.frame(&id, 1);
    frame["t_ms"] = json!(100.0);
    frame["observation"]["response_received_ms"] = json!(100.0);
    frame["observation"]["geometry_validated_ms"] = json!(105.0);
    f.call(method::FRAME, frame).recv().unwrap().unwrap();
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .created = Instant::now() - Duration::from_secs(11);
    f.m.maintenance(); // watchdog races ahead of the waiting original CLI thread
    std::thread::sleep(Duration::from_millis(70));
    assert_eq!(f.status(&id)["state"], "stopping");
    assert!(f.status(&id)["end"].is_null());
    assert!(f.m.begin_start_recovery(&id));
    assert!(!f.m.begin_start_recovery(&id));
    assert!(f
        .m
        .complete(ctx, Err(Error("TIMEOUT", "lost numeric start reply")))
        .is_err());
    let mut ended = f.end(&id, 1);
    ended["end"]["duration_ms"] = json!(750.0);
    ended["end"]["cutoff"] = json!({"t_ms":750.0,"provenance":"admission_closed"});
    ended["end"]["reason"] = json!("control_error");
    let barrier = f.call(method::ENDED, ended);
    let mut started = wire()["started"]["result"]["data"].clone();
    started["identity"] = value(&id);
    let status =
        f.m.complete(Context::RecoverStart(id.clone()), Ok(started))
            .unwrap();
    assert_eq!(
        status["state"], "stopping",
        "cached facts must never reopen admission"
    );
    assert_eq!(
        barrier
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()["state"],
        "failed"
    );
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    assert_eq!(manifest["frames"][0]["t_ms"], 100.0);
    assert_eq!(manifest["end"]["reason"], "control_error");
    assert_eq!(manifest["end"]["duration_ms"], 750.0);
    assert_eq!(manifest["end"]["duration_observed"], true);
    assert_eq!(manifest["tab_id"], 7);
}

#[test]
fn unrecoverable_started_reports_missing_provenance_not_missing_durable_frames() {
    for invalid_cached_reply in [false, true] {
        let f = Fixture::new();
        let (id, ctx) = f.start("original");
        f.call(method::FRAME, f.frame(&id, 1))
            .recv()
            .unwrap()
            .unwrap();
        assert!(f.m.begin_start_recovery(&id));
        f.m.complete(ctx, Err(Error("TIMEOUT", "lost reply")))
            .unwrap_err();
        let response = if invalid_cached_reply {
            Ok(wire()["started"]["result"]["data"].clone())
        } else {
            Err(Error("TIMEOUT", "cached reply unavailable"))
        };
        assert!(f
            .m
            .complete(Context::RecoverStart(id.clone()), response)
            .is_err());
        assert_eq!(f.terminal(&id)["persisted_seq"], 1);
        assert!(matches!(
            f.m.prepare(method::MANIFEST, json!({"identity":id}), "x"),
            Err(Error("RECORD_INTERRUPTED", _))
        ));
        assert!(!f.m.begin_start_recovery(&id));
        assert_eq!(
            f.m.read(ReadRequest {
                identity: id,
                offset: 0,
                length: MAX_CHUNK_BYTES
            })
            .unwrap()
            .length,
            221
        );
    }
}

#[test]
fn cached_start_recovery_has_a_fixed_deadline_even_if_no_reply_arrives() {
    let f = Fixture::new();
    let (id, ctx) = f.start("original");
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    assert!(f.m.begin_start_recovery(&id));
    f.m.complete(ctx, Err(Error("TIMEOUT", "lost reply")))
        .unwrap_err();
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .start_recovery_until = Some(Instant::now() - Duration::from_millis(1));
    let status = f.terminal(&id);
    assert_eq!(status["end"]["duration_observed"], false);
    assert!(matches!(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x"),
        Err(Error("RECORD_INTERRUPTED", _))
    ));
    assert!(!f.m.begin_start_recovery(&id));
}

fn failed_control_after_initial_stop(f: &Fixture) -> (Identity, Value) {
    let (id, ctx) = f.start("original");
    f.started(&id, ctx);
    f.call(method::FRAME, f.frame(&id, 1))
        .recv()
        .unwrap()
        .unwrap();
    let Route::Forward(_, stop) =
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"initial_stop"}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    f.m.complete(
        stop,
        Ok(value(EndAccepted {
            identity: id.clone(),
            state: State::Stopping,
        })),
    )
    .unwrap();
    assert_eq!(
        local(
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":"duplicate_stop"}),
                "x"
            )
            .unwrap()
        )["state"],
        "stopping"
    );
    let mut ended = f.end(&id, 1);
    ended["end"]["reason"] = json!("control_error");
    ended["end"]["duration_ms"] = json!(750.0);
    ended["end"]["cutoff"] = json!({"t_ms":750.0,"provenance":"admission_closed"});
    f.call(method::ENDED, ended).recv().unwrap().unwrap();
    let status = f.terminal(&id);
    (id, status)
}

#[test]
fn terminal_failed_stop_reconciliation_is_explicit_pinned_idempotent_and_immutable() {
    let f = Fixture::new();
    let (id, status) = failed_control_after_initial_stop(&f);
    let manifest = local(
        f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
            .unwrap(),
    );
    let chunk =
        f.m.read(ReadRequest {
            identity: id.clone(),
            offset: 0,
            length: MAX_CHUNK_BYTES,
        })
        .unwrap();
    assert_eq!(
        local(
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":"initial_stop"}),
                "x"
            )
            .unwrap()
        ),
        status
    );
    assert_eq!(
        local(
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":"duplicate_stop"}),
                "x"
            )
            .unwrap()
        ),
        status
    );
    let request = json!({"identity":id,"operation_id":"cleanup"});
    let Route::Forward(params, cleanup) = f.m.prepare(method::STOP, request.clone(), "x").unwrap()
    else {
        panic!("terminal cleanup was incorrectly intercepted locally")
    };
    assert_eq!(params, request);
    assert_eq!(
        local(f.m.prepare(method::STOP, request.clone(), "x").unwrap()),
        status
    );
    assert!(f
        .m
        .complete(cleanup, Err(Error("TIMEOUT", "cleanup unconfirmed")))
        .is_err());
    assert_eq!(f.status(&id), status);
    assert_eq!(
        local(f.m.prepare(method::STOP, request, "x").unwrap()),
        status
    );
    let Route::Forward(_, cleanup) =
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"cleanup_again"}),
            "x",
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        f.m.complete(
            cleanup,
            Ok(value(EndAccepted {
                identity: id.clone(),
                state: State::Failed
            }))
        )
        .unwrap(),
        status
    );
    assert_eq!(
        local(
            f.m.prepare(method::MANIFEST, json!({"identity":id}), "x")
                .unwrap()
        ),
        manifest
    );
    assert_eq!(
        f.m.read(ReadRequest {
            identity: id,
            offset: 0,
            length: MAX_CHUNK_BYTES
        })
        .unwrap(),
        chunk
    );
    for _ in 0..3 {
        assert!(
            f.m.maintenance().is_empty(),
            "explicit cleanup must not schedule automatic retry loops"
        );
    }
}

#[test]
fn terminal_stop_reconciliation_is_not_enabled_for_sealed_other_failures_or_stale_epochs() {
    for reason in ["deadline", "debugger_detached"] {
        let f = Fixture::new();
        let (id, ctx) = f.start("original");
        f.started(&id, ctx);
        f.call(method::FRAME, f.frame(&id, 1))
            .recv()
            .unwrap()
            .unwrap();
        let mut ended = f.end(&id, 1);
        ended["end"]["reason"] = json!(reason);
        f.call(method::ENDED, ended).recv().unwrap().unwrap();
        let status = f.terminal(&id);
        assert_eq!(
            local(
                f.m.prepare(
                    method::STOP,
                    json!({"identity":id,"operation_id":"fresh_stop"}),
                    "x"
                )
                .unwrap()
            ),
            status
        );
        let stale = Identity {
            host_epoch: "stale_epoch".into(),
            record_id: id.record_id,
        };
        assert!(matches!(
            f.m.prepare(
                method::STOP,
                json!({"identity":stale,"operation_id":"cleanup"}),
                "x"
            ),
            Err(Error("RECORD_STALE_HOST", _))
        ));
    }
}

#[test]
fn terminal_stop_reconciliation_operation_cache_is_bounded_without_forgetting_retries() {
    let f = Fixture::new();
    let (id, status) = failed_control_after_initial_stop(&f);
    for n in 1..(MAX_EVENTS - 1) {
        let Route::Forward(_, cleanup) =
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":format!("cleanup_{n}")}),
                "x",
            )
            .unwrap()
        else {
            panic!("explicit cleanup must reach extension")
        };
        assert_eq!(
            f.m.complete(
                cleanup,
                Ok(value(EndAccepted {
                    identity: id.clone(),
                    state: State::Failed
                }))
            )
            .unwrap(),
            status
        );
    }
    assert!(matches!(
        f.m.prepare(
            method::STOP,
            json!({"identity":id,"operation_id":"over_limit"}),
            "x"
        ),
        Err(Error("RECORD_LIMIT", _))
    ));
    assert_eq!(
        local(
            f.m.prepare(
                method::STOP,
                json!({"identity":id,"operation_id":"cleanup_1"}),
                "x"
            )
            .unwrap()
        ),
        status
    );
    assert_eq!(f.status(&id), status);
}

#[test]
fn invalid_start_and_marker_inputs_do_not_allocate_or_forward() {
    let f = Fixture::new();
    for (field, bad) in [
        ("max_duration_ms", json!(0)),
        ("max_duration_ms", json!(60001)),
        ("capture_fps", json!(31)),
        ("jpeg_quality", json!(0)),
    ] {
        let mut req = wire()["start"]["params"].clone();
        req["config"][field] = bad;
        assert!(f.m.prepare(method::START, req, "x").is_err());
    }
    let mut req = wire()["start"]["params"].clone();
    req["operation_id"] = json!("../op");
    assert!(f.m.prepare(method::START, req, "x").is_err());
    assert!(f.m.inner.lock().unwrap().sessions.is_empty());
    let (id, ctx) = f.start("op");
    f.started(&id, ctx);
    for text in ["a\0b".into(), "x".repeat(513), "\n".repeat(8)] {
        assert!(f
            .m
            .prepare(
                method::PHASE,
                json!({"identity":id,"operation_id":"phase","text":text}),
                "x"
            )
            .is_err());
    }
    for duration in [0, 10001] {
        assert!(f.m.prepare(method::MARK,json!({"identity":id,"operation_id":"mark","text":"literal","duration_ms":duration}),"x").is_err());
    }
    assert_eq!(f.status(&id)["state"], "recording");
}
