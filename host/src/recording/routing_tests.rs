//! A fake service worker drives the actual host IPC/native-message routing.
use super::tests::{wire, Fixture, NEXT};
use super::*;
use crate::{handle_cli_connection, handle_sw_message, Host};
use ap_browser_core::{encode, read_frame, transport};
use interprocess::local_socket::prelude::*;
use serde_json::json;
use std::sync::atomic::Ordering;

fn rpc(host: Arc<Host>, request: Value) -> mpsc::Receiver<Value> {
    let socket = transport::instance_name(&format!(
        "rectest_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let listener = transport::bind(&socket).unwrap();
    let mut stream = transport::connect(&socket).unwrap();
    std::thread::spawn(move || {
        let incoming = listener.accept().unwrap();
        handle_cli_connection(host, incoming).unwrap();
        drop(listener);
        #[cfg(unix)]
        let _ = fs::remove_file(socket);
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        stream.write_all(&encode(&request).unwrap()).unwrap();
        tx.send(read_frame(&mut stream).unwrap()).unwrap();
    });
    rx
}
fn recv(rx: &mpsc::Receiver<Value>) -> Value {
    rx.recv_timeout(Duration::from_secs(2)).unwrap()
}
fn native(rx: &mpsc::Receiver<Vec<u8>>) -> Value {
    read_frame(&mut rx.recv_timeout(Duration::from_secs(2)).unwrap().as_slice()).unwrap()
}
fn negotiated_start(host: &Arc<Host>, sw: &mpsc::Receiver<Vec<u8>>) -> Value {
    let query = native(sw);
    assert_eq!(query["method"], method::CAPABILITIES);
    assert_eq!(query["params"], json!({}));
    assert!(host
        .recording
        .as_ref()
        .unwrap()
        .inner
        .lock()
        .unwrap()
        .sessions
        .is_empty());
    handle_sw_message(
        host,
        json!({"id":query["id"],"result":{"ok":true,"data":{
        "protocol_version":2,"backend":"cdp_capture_screenshot"}}}),
    )
    .unwrap();
    native(sw)
}

#[test]
fn fake_sw_routes_local_reads_and_keeps_ordinary_rpc_responsive_while_writer_paused() {
    let f = Fixture::new();
    let mut h = Host::new();
    h.recording = Some(f.m.clone());
    *h.instance_id.lock().unwrap() = Some("fake_browser".into());
    let (tx, sw) = mpsc::channel();
    *h.stdout_tx.lock().unwrap() = Some(tx);
    let host = Arc::new(h);
    let start = rpc(host.clone(), wire()["start"].clone());
    let forwarded = negotiated_start(&host, &sw);
    assert_eq!(forwarded["method"], method::START);
    assert!(forwarded["id"].is_number());
    let identity = forwarded["params"]["identity"].clone();
    let id: Identity = parse(identity.clone()).unwrap();
    let mut frame = f.frame(&id, 1);
    handle_sw_message(
        &host,
        json!({"id":"sw-1","method":method::FRAME,"params":frame}),
    )
    .unwrap();
    assert_eq!(native(&sw)["result"]["accepted_seq"], 1);
    let mut started = wire()["started"].clone();
    started["id"] = forwarded["id"].clone();
    started["result"]["data"]["identity"] = identity.clone();
    handle_sw_message(&host, started).unwrap();
    assert_eq!(recv(&start)["result"]["data"]["identity"], identity);
    // Actual disk worker is stalled, not the stdin reader or an in-memory mock.
    let pause = Arc::new(std::sync::Barrier::new(2));
    *f.m.pause.lock().unwrap() = Some(pause.clone());
    frame = f.frame(&id, 2);
    frame["t_ms"] = json!(500);
    frame["observation"]["response_received_ms"] = json!(500);
    frame["observation"]["geometry_validated_ms"] = json!(510);
    handle_sw_message(
        &host,
        json!({"id":"sw-2","method":method::FRAME,"params":frame}),
    )
    .unwrap();
    pause.wait();
    let status = rpc(
        host.clone(),
        json!({"jsonrpc":"2.0","method":method::STATUS,"params":{"identity":identity}}),
    );
    assert_eq!(recv(&status)["result"]["data"]["persisted_seq"], 1);
    assert!(
        sw.try_recv().is_err(),
        "status must not be forwarded to Chrome"
    );
    let ordinary = rpc(
        host.clone(),
        json!({"jsonrpc":"2.0","method":"ping","params":{}}),
    );
    let ping = native(&sw);
    assert_eq!(ping["method"], "ping");
    handle_sw_message(
        &host,
        json!({"jsonrpc":"2.0","id":ping["id"],"result":{"ok":true,"data":{"ordinary":true}}}),
    )
    .unwrap();
    assert_eq!(recv(&ordinary)["result"]["data"]["ordinary"], true);
    let stop = rpc(
        host.clone(),
        json!({"jsonrpc":"2.0","method":method::STOP,"params":{"identity":identity,"operation_id":"stop"}}),
    );
    let stop_request = native(&sw);
    assert_eq!(stop_request["method"], method::STOP);
    handle_sw_message(
        &host,
        json!({"id":"sw-3","method":method::ENDED,"params":f.end(&id,2)}),
    )
    .unwrap();
    handle_sw_message(&host, json!({"jsonrpc":"2.0","id":stop_request["id"],"result":{"ok":true,"data":{"identity":identity,"state":"stopping"}}})).unwrap();
    assert_eq!(recv(&stop)["result"]["data"]["state"], "stopping");
    assert!(sw.try_recv().is_err());
    pause.wait();
    let a = native(&sw);
    let b = native(&sw);
    assert_eq!(a["id"], "sw-2");
    assert_eq!(a["result"]["credit"]["next_seq"], 3);
    assert_eq!(b["id"], "sw-3");
    assert_eq!(b["result"]["state"], "sealed");
    let read_req = json!({"jsonrpc":"2.0","method":method::READ,"params":{"identity":identity,"offset":0,"length":262144}});
    let chunk = recv(&rpc(host.clone(), read_req.clone()));
    assert_eq!(chunk["result"]["data"]["length"], 442);
    assert_eq!(
        chunk["result"]["data"]["sha256"],
        "f2e239ed195df3741f3255209a42705b34cea6a2a2508b78e505a2981fd677c9"
    );
    assert_eq!(
        chunk["result"],
        recv(&rpc(host.clone(), read_req))["result"]
    );
    let manifest = recv(&rpc(
        host.clone(),
        json!({"jsonrpc":"2.0","method":method::MANIFEST,"params":{"identity":identity}}),
    ));
    assert_eq!(manifest["result"]["data"]["spool_bytes"], 442);
    assert!(
        sw.try_recv().is_err(),
        "large chunks and manifests never traverse Chrome"
    );
    handle_sw_message(&host, json!({"id":"sw-bad","method":method::FRAME,"params":{"identity":identity,"seq":"malformed"}})).unwrap();
    assert_eq!(native(&sw)["error"]["code"], "RECORD_INVALID_PARAMS");
    // Malformed recording input did not kill the host or consume pending generic RPC IDs.
    let ordinary = rpc(
        host.clone(),
        json!({"jsonrpc":"2.0","method":"ping","params":{}}),
    );
    let ping = native(&sw);
    handle_sw_message(
        &host,
        json!({"id":ping["id"],"result":{"ok":true,"data":"still alive"}}),
    )
    .unwrap();
    assert_eq!(recv(&ordinary)["result"]["data"], "still alive");
    assert!(host.pending.lock().unwrap().is_empty());
}

fn raw_native(host: &Arc<Host>, text: &str) {
    let mut bytes = (text.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(text.as_bytes());
    handle_sw_message(host, read_frame(&mut bytes.as_slice()).unwrap()).unwrap();
}

#[test]
fn precision_raw_native_event_echo_and_durable_manifest_keep_captured_js_bits() {
    let f = Fixture::new();
    let mut h = Host::new();
    h.recording = Some(f.m.clone());
    *h.instance_id.lock().unwrap() = Some("precision_browser".into());
    let (tx, sw) = mpsc::channel();
    *h.stdout_tx.lock().unwrap() = Some(tx);
    let host = Arc::new(h);
    let start = rpc(host.clone(), wire()["start"].clone());
    let forwarded = negotiated_start(&host, &sw);
    let identity = forwarded["params"]["identity"].clone();
    let id: Identity = parse(identity.clone()).unwrap();
    let mut started = wire()["started"].clone();
    started["id"] = forwarded["id"].clone();
    started["result"]["data"]["identity"] = identity.clone();
    handle_sw_message(&host, started).unwrap();
    recv(&start);
    handle_sw_message(
        &host,
        json!({"id":"sw-frame","method":method::FRAME,"params":f.frame(&id,1)}),
    )
    .unwrap();
    assert_eq!(native(&sw)["result"]["accepted_seq"], 1);
    let mut mark = Value::Null;
    for (index, kind, lexeme) in [
        (1, "phase", "29.700000047683716"),
        (2, "mark", "1106.2999999523163"),
    ] {
        let operation = format!("precision_{kind}");
        let mut params = json!({"identity":identity,"operation_id":operation,"text":"STEP +1"});
        if kind == "mark" {
            params["duration_ms"] = json!(1000);
        }
        let method = format!("record.{kind}");
        let control = rpc(
            host.clone(),
            json!({"jsonrpc":"2.0","method":method,"params":params}),
        );
        let forwarded = native(&sw);
        let Route::Forward(_, strict) = f.m.prepare(&method, params, "precision_browser").unwrap()
        else {
            panic!()
        };
        let duration = if kind == "mark" {
            ",\"duration_ms\":1000"
        } else {
            ""
        };
        let event = format!(
            r#"{{"event_index":{index},"operation_id":"{operation}","t_ms":{lexeme},"kind":"{kind}","text":"STEP +1"{duration}}}"#
        );
        let text = format!(
            r#"{{"id":"sw-{kind}","method":"record.event","params":{{"identity":{identity},"event":{event}}}}}"#
        );
        raw_native(&host, &text); // real text parser: do not construct t_ms via json!
        let echoed = native(&sw);
        let expected = lexeme.parse::<f64>().unwrap();
        assert_eq!(
            echoed["result"]["t_ms"].as_f64().unwrap().to_bits(),
            expected.to_bits(),
            "native echo of {lexeme}"
        );
        assert_eq!(
            f.m.complete(strict.clone(), Ok(echoed["result"].clone()))
                .unwrap(),
            echoed["result"]
        );
        if kind == "mark" {
            mark = echoed["result"].clone();
            for field in ["event_index", "operation_id", "text", "duration_ms", "t_ms"] {
                let mut changed = mark.clone();
                changed[field] = match field {
                    "event_index" => json!(3),
                    "operation_id" => json!("another_operation"),
                    "text" => json!("changed"),
                    "duration_ms" => json!(999),
                    _ => Value::from(f64::from_bits(expected.to_bits() + 1)),
                };
                assert!(
                    f.m.complete(strict.clone(), Ok(changed)).is_err(),
                    "altered {field} must still reject"
                );
            }
        }
        handle_sw_message(
            &host,
            json!({"id":forwarded["id"],"result":{"ok":true,"data":echoed["result"]}}),
        )
        .unwrap();
        assert_eq!(
            recv(&control)["result"]["data"]["t_ms"]
                .as_f64()
                .unwrap()
                .to_bits(),
            expected.to_bits()
        );
    }
    handle_sw_message(
        &host,
        json!({"id":"sw-end","method":method::ENDED,"params":f.end(&id,1)}),
    )
    .unwrap();
    assert_eq!(native(&sw)["result"]["state"], "sealed");
    let req = json!({"jsonrpc":"2.0","method":method::MANIFEST,"params":{"identity":identity}});
    let manifest = recv(&rpc(host.clone(), req.clone()))["result"]["data"].clone();
    let expected = "1106.2999999523163".parse::<f64>().unwrap().to_bits();
    assert_eq!(
        manifest["events"][1]["t_ms"].as_f64().unwrap().to_bits(),
        expected
    );
    let path = f.m.inner.lock().unwrap().sessions[&id.record_id]
        .path
        .clone();
    let stored = fs::read_to_string(path.join("events")).unwrap();
    let durable: Event = serde_json::from_str(stored.lines().nth(1).unwrap()).unwrap();
    assert_eq!(durable.t_ms.to_bits(), expected);
    for field in ["identity", "event_index", "text", "duration_ms", "t_ms"] {
        let mut params = json!({"identity":identity,"event":mark});
        if field == "identity" {
            params["identity"]["record_id"] = json!("missing_record");
        } else {
            params["event"][field] = match field {
                "event_index" => json!(3),
                "text" => json!("changed"),
                "duration_ms" => json!(999),
                _ => Value::from(f64::from_bits(expected + 1)),
            };
        }
        handle_sw_message(
            &host,
            json!({"id":"sw-altered","method":method::EVENT,"params":params}),
        )
        .unwrap();
        assert_eq!(
            native(&sw)["ok"],
            false,
            "changed {field} is not an exact retry"
        );
    }
    assert_eq!(recv(&rpc(host.clone(), req))["result"]["data"], manifest);
}

#[test]
fn source_numeric_ids_cannot_collide_with_generic_pending_and_wrong_direction_is_local_error() {
    let h = Arc::new(Host::new());
    let (tx, rx) = mpsc::channel();
    *h.stdout_tx.lock().unwrap() = Some(tx);
    let (pending_tx, pending_rx) = mpsc::channel();
    h.pending.lock().unwrap().insert(7, pending_tx);
    handle_sw_message(&h, json!({"id":7,"method":method::FRAME,"params":{}})).unwrap();
    assert_eq!(native(&rx)["ok"], false);
    assert!(pending_rx.try_recv().is_err());
    assert!(h.pending.lock().unwrap().contains_key(&7));
    handle_sw_message(&h, json!({"id":"sw-1","method":method::READ,"params":{}})).unwrap();
    assert_eq!(native(&rx)["error"]["code"], "RECORD_INVALID_PARAMS");
}

fn isolated_host(f: &Fixture) -> (Arc<Host>, mpsc::Receiver<Vec<u8>>) {
    let (tx, rx) = mpsc::channel();
    (
        Arc::new(Host {
            instance_id: Mutex::new(None),
            relay: crate::relay::RelayManager::default(),
            recording: Some(f.m.clone()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: std::sync::atomic::AtomicU64::new(1),
            stdout_tx: Mutex::new(Some(tx)),
        }),
        rx,
    )
}

#[test]
fn ipc_capabilities_are_exact_no_target_no_slot_and_not_cached_for_start() {
    let f = Fixture::new();
    let (host, sw) = isolated_host(&f);
    for params in [
        json!({"tab_id":7}),
        json!({"_timeout_hint_secs":20}),
        json!({"identity":{}}),
        json!([]),
        Value::Null,
    ] {
        let result = recv(&rpc(
            host.clone(),
            json!({"method":method::CAPABILITIES,"params":params}),
        ));
        assert_eq!(result["error"]["code"], "RECORD_INVALID_PARAMS");
        assert!(sw.try_recv().is_err());
    }
    let query = rpc(
        host.clone(),
        json!({"method":method::CAPABILITIES,"params":{}}),
    );
    let forwarded = native(&sw);
    assert_eq!(forwarded["method"], method::CAPABILITIES);
    assert_eq!(forwarded["params"], json!({}));
    assert!(host.instance_id.lock().unwrap().is_none());
    assert!(f.m.inner.lock().unwrap().sessions.is_empty());
    assert_eq!(fs::read_dir(&f.m.root).unwrap().count(), 1); // owner only, no record directory
    handle_sw_message(&host,json!({"id":forwarded["id"],"result":{"ok":true,"data":{"protocol_version":2,"backend":"cdp_capture_screenshot"}}})).unwrap();
    let result = recv(&query);
    parse::<Capabilities>(result["result"]["data"].clone())
        .unwrap()
        .validate()
        .unwrap();
    assert!(sw.try_recv().is_err());
    // Even immediately after a successful CLI negotiation start rechecks this port.
    let start = rpc(host.clone(), wire()["start"].clone());
    let forwarded = native(&sw);
    assert_eq!(forwarded["method"], method::CAPABILITIES);
    handle_sw_message(&host,json!({"id":forwarded["id"],"result":{"ok":true,"data":{"protocol_version":1,"backend":"cdp_capture_screenshot"}}})).unwrap();
    assert_eq!(recv(&start)["error"]["code"], UNSUPPORTED_VERSION);
    assert!(sw.try_recv().is_err());
    let inner = f.m.inner.lock().unwrap();
    assert!(inner.sessions.is_empty());
    assert!(inner.operations.is_empty());
    assert_eq!(inner.next_record, 1);
    assert!(host.pending.lock().unwrap().is_empty());
}

#[test]
fn ipc_mixed_versions_missing_methods_and_disconnect_fail_before_start_allocation() {
    for response in [
        json!({"error":{"code":-32601}}),
        json!({"result":{"ok":false,"error":{"code":"UNKNOWN_METHOD"}}}),
        json!({"result":{"ok":false,"error":{"code":"RECORD_UNSUPPORTED_VERSION"}}}),
        json!({"result":{"ok":true,"data":{"protocol_version":2,"backend":"legacy_screencast"}}}),
        json!({"result":{"ok":true,"data":{"protocol_version":2,"backend":"cdp_capture_screenshot","tab_id":7}}}),
    ] {
        let f = Fixture::new();
        let (host, sw) = isolated_host(&f);
        let start = rpc(host.clone(), wire()["start"].clone());
        let query = native(&sw);
        assert_eq!(query["method"], method::CAPABILITIES);
        let mut response = response;
        response["id"] = query["id"].clone();
        let expected = if response["result"]["data"].get("tab_id").is_some() {
            "RECORD_INVALID_PARAMS"
        } else if response["result"]["data"]["backend"] == "legacy_screencast" {
            UNSUPPORTED_BACKEND
        } else {
            UNSUPPORTED_VERSION
        };
        handle_sw_message(&host, response).unwrap();
        assert_eq!(recv(&start)["error"]["code"], expected);
        assert!(sw.try_recv().is_err());
        assert!(f.m.inner.lock().unwrap().operations.is_empty());
        assert!(f.m.inner.lock().unwrap().sessions.is_empty());
        assert!(host.pending.lock().unwrap().is_empty());
    }
    let f = Fixture::new();
    let (host, sw) = isolated_host(&f);
    drop(sw);
    assert_eq!(
        recv(&rpc(host.clone(), wire()["start"].clone()))["error"]["code"],
        "EXTENSION_DISCONNECTED"
    );
    assert!(f.m.inner.lock().unwrap().sessions.is_empty());
    assert!(host.pending.lock().unwrap().is_empty());
    for version in [Value::Null, json!(1), json!(3)] {
        let mut req = wire()["start"].clone();
        if version.is_null() {
            req["params"]
                .as_object_mut()
                .unwrap()
                .remove("protocol_version");
        } else {
            req["params"]["protocol_version"] = version;
        }
        assert_eq!(
            recv(&rpc(host.clone(), req))["error"]["code"],
            UNSUPPORTED_VERSION
        );
    }
}

#[test]
fn ipc_final_durable_then_end_lost_preserves_failed_partial_reads_and_stop_retries() {
    use super::v2_tests::shot;
    let f = Fixture::new();
    let (host, sw) = isolated_host(&f);
    *host.instance_id.lock().unwrap() = Some("ipc_final_browser".into());
    let start = rpc(host.clone(), wire()["start"].clone());
    let forwarded = negotiated_start(&host, &sw);
    let identity = forwarded["params"]["identity"].clone();
    let id: Identity = parse(identity.clone()).unwrap();
    handle_sw_message(&host,json!({"id":"sw-sample","method":method::FRAME,"params":shot(&f,&id,1,"sample",0.0,100.0,110.0)})).unwrap();
    assert_eq!(native(&sw)["result"]["accepted_seq"], 1); // genuine private disk write, before Started
    let mut started = wire()["started"].clone();
    started["id"] = forwarded["id"].clone();
    started["result"]["data"]["identity"] = identity.clone();
    handle_sw_message(&host, started).unwrap();
    assert_eq!(recv(&start)["result"]["data"]["state"], "recording");
    let stop_req = json!({"method":method::STOP,"params":{"identity":identity,"operation_id":"explicit_stop"}});
    let stop = rpc(host.clone(), stop_req.clone());
    let forwarded = native(&sw);
    handle_sw_message(&host,json!({"id":forwarded["id"],"result":{"ok":true,"data":{"identity":identity,"state":"stopping"}}})).unwrap();
    assert_eq!(recv(&stop)["result"]["data"]["state"], "stopping");
    let final_frame = shot(&f, &id, 2, "final", 1000.25, 1106.2999999523163, 1106.4);
    raw_native(
        &host,
        &format!(r#"{{"id":"sw-final","method":"record.frame","params":{final_frame}}}"#),
    );
    assert_eq!(native(&sw)["result"]["accepted_seq"], 2);
    f.m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(&id.record_id)
        .unwrap()
        .control_since = Instant::now() - Duration::from_secs(11);
    assert_eq!(f.m.maintenance(), vec![id.clone()]);
    f.terminal(&id);
    let manifest_req = json!({"method":method::MANIFEST,"params":{"identity":identity}});
    let manifest = recv(&rpc(host.clone(), manifest_req.clone()))["result"]["data"].clone();
    parse::<Manifest>(manifest.clone())
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(
        manifest["end"]["final_observation"],
        json!({"disposition":"persisted_without_end","request_id":"shot_2","seq":2})
    );
    assert_eq!(manifest["end"]["stop_requested_ms"], Value::Null);
    assert_eq!(manifest["end"]["counters"], Value::Null);
    assert_eq!(
        manifest["frames"][1]["t_ms"].as_f64().unwrap().to_bits(),
        1106.2999999523163f64.to_bits()
    );
    assert_eq!(
        manifest["frames"][1]["observation"]["response_received_ms"],
        manifest["frames"][1]["t_ms"]
    );
    let read_req =
        json!({"method":method::READ,"params":{"identity":identity,"offset":0,"length":262144}});
    let a = recv(&rpc(host.clone(), read_req.clone()))["result"]["data"].clone();
    assert_eq!(a["length"], 442);
    assert_eq!(a["sha256"], manifest["spool_sha256"]);
    assert_eq!(a, recv(&rpc(host.clone(), read_req))["result"]["data"]);
    assert_eq!(
        recv(&rpc(host.clone(), stop_req))["result"]["data"]["state"],
        "failed"
    );
    // A late producer End cannot upgrade/rewrite this terminal source.
    handle_sw_message(&host,json!({"id":"sw-late-end","method":method::ENDED,"params":super::v2_tests::stopped(&f,&id)})).unwrap();
    assert_eq!(native(&sw)["ok"], false);
    assert_eq!(
        recv(&rpc(host.clone(), manifest_req))["result"]["data"],
        manifest
    );
    assert!(sw.try_recv().is_err());
    let release = json!({"method":method::RELEASE,"params":{"identity":identity}});
    assert_eq!(
        recv(&rpc(host.clone(), release.clone()))["result"]["data"]["released"],
        true
    );
    assert_eq!(
        recv(&rpc(host.clone(), release))["result"]["data"]["released"],
        true
    );
    assert!(host.pending.lock().unwrap().is_empty());
}

#[test]
fn ipc_lost_started_recovers_only_exact_original_source_provenance() {
    let f = Fixture::new();
    let (host, sw) = isolated_host(&f);
    *host.instance_id.lock().unwrap() = Some("ipc_recovery_browser".into());
    let start = rpc(host.clone(), wire()["start"].clone());
    let forwarded = negotiated_start(&host, &sw);
    let identity = forwarded["params"]["identity"].clone();
    let id: Identity = parse(identity.clone()).unwrap();
    handle_sw_message(
        &host,
        json!({"id":"sw-before-started","method":method::FRAME,"params":f.frame(&id,1)}),
    )
    .unwrap();
    assert_eq!(native(&sw)["result"]["accepted_seq"], 1);
    // Model a failed control channel reply after the source-first durable write.
    handle_sw_message(
        &host,
        json!({"id":forwarded["id"],"error":{"code":"TIMEOUT"}}),
    )
    .unwrap();
    let recovery = native(&sw);
    assert_eq!(recovery["method"], method::START);
    assert_eq!(recovery["params"], forwarded["params"]);
    assert_ne!(recovery["id"], forwarded["id"]);
    let mut started = wire()["started"].clone();
    started["id"] = recovery["id"].clone();
    started["result"]["data"]["identity"] = identity.clone();
    handle_sw_message(&host, started).unwrap();
    let reconcile = native(&sw);
    assert_eq!(reconcile["method"], method::STOP);
    assert_eq!(reconcile["params"]["identity"], identity);
    assert_eq!(recv(&start)["error"]["code"], "TIMEOUT");
    let mut end = f.end(&id, 1);
    end["end"]["reason"] = json!("control_error");
    end["end"]["duration_ms"] = json!(750.0);
    end["end"]["cutoff"] = json!({"t_ms":750.0,"provenance":"admission_closed"});
    handle_sw_message(
        &host,
        json!({"id":"sw-recovered-end","method":method::ENDED,"params":end}),
    )
    .unwrap();
    assert_eq!(native(&sw)["result"]["state"], "failed");
    let result = recv(&rpc(
        host.clone(),
        json!({"method":method::MANIFEST,"params":{"identity":identity}}),
    ));
    let manifest = &result["result"]["data"];
    parse::<Manifest>(manifest.clone())
        .unwrap()
        .validate()
        .unwrap();
    assert_eq!(manifest["end"]["duration_observed"], true);
    assert_eq!(manifest["end"]["duration_ms"], 750.0);
    assert_eq!(manifest["spool_bytes"], 221);
    assert!(host.pending.lock().unwrap().is_empty());
    assert!(sw.try_recv().is_err());
}
