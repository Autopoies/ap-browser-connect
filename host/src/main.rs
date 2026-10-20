//! ap-browser-host — Chrome native messaging host that owns a local IPC socket.
//!
//! Spawned by Chrome when the extension SW calls `chrome.runtime.connectNative`.
//! Reads frames from stdin (Chrome-native 4-byte LE framing), waits for the
//! first `hello` message to learn the instance_id, binds an IPC socket
//! (Unix domain socket on Unix, named pipe on Windows), then accepts CLI
//! connections and multiplexes them over the single stdin/stdout pipe to the SW.

use ap_browser_core::{encode, read_frame, transport, FrameError, HelloParams, Request};
// Bring in interprocess trait methods (incoming/accept) on transport::Listener.
use anyhow::{Context, Result};
use interprocess::local_socket::prelude::*;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tracing::{debug, error, info, warn};

mod recording;
mod relay;

const KEEPALIVE_METHOD: &str = "keepalive";
const HELLO_METHOD: &str = "hello";
const RESPONSE_TIMEOUT_SECS: u64 = 30;
const MAX_RESPONSE_TIMEOUT_SECS: u64 = 3_600;

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Vec<u8>>>>>;

struct Host {
    instance_id: Mutex<Option<String>>,
    relay: relay::RelayManager,
    recording: Option<Arc<recording::Manager>>,
    pending: Pending,
    next_id: AtomicU64,
    stdout_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl Host {
    fn new() -> Self {
        Self {
            instance_id: Mutex::new(None),
            relay: relay::RelayManager::default(),
            recording: recording::Manager::new()
                .map_err(|e| warn!("recording unavailable: {e}"))
                .ok(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            stdout_tx: Mutex::new(None),
        }
    }

    fn socket_name(&self) -> Option<String> {
        let id = self.instance_id.lock().ok()?.clone()?;
        Some(transport::instance_name(&id))
    }
}

fn unregister_host_instance(host: &Host) {
    if let Ok(Some(id)) = host.instance_id.lock().map(|id| id.clone()) {
        let _ = transport::unregister_instance(&id);
    }
}

fn init_logging() {
    let log_file = dirs::home_dir().and_then(|h| {
        let p = h.join(".ap-browser").join("host.log");
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .ok()
    });

    if let Some(file) = log_file {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info,debug".into()),
            )
            .with_writer(file)
            .with_ansi(false)
            .try_init();
    } else {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info".into()),
            )
            .with_writer(std::io::stderr)
            .try_init();
    }
}

fn main() -> Result<()> {
    init_logging();

    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && (args[1] == "--version" || args[1] == "-V") {
        println!("ap-browser-host {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    if args.len() < 2 {
        error!("this binary must be spawned by Chrome via connectNative");
        std::process::exit(1);
    }
    info!("ap-browser-host spawned by {}", args[1]);

    let host = Arc::new(Host::new());

    let (stdout_tx, stdout_rx) = mpsc::channel::<Vec<u8>>();
    *host.stdout_tx.lock().unwrap() = Some(stdout_tx);

    thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        for buf in stdout_rx.iter() {
            if stdout.write_all(&buf).is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    });

    {
        let host = Arc::clone(&host);
        thread::spawn(move || loop {
            thread::sleep(std::time::Duration::from_millis(100));
            if let Some(manager) = &host.recording {
                for identity in manager.maintenance() {
                    // Reconcile by identity only. This response is deliberately not a seal.
                    let id = host.next_id.fetch_add(1, Ordering::SeqCst);
                    if let Some(tx) = host.stdout_tx.lock().unwrap().as_ref() {
                        if let Ok(buf) = encode(&serde_json::json!({"jsonrpc":"2.0","id":id,
                            "method":"record.stop","params":{"identity":identity,"operation_id":"host_watchdog"}}))
                        {
                            let _ = tx.send(buf);
                        }
                    }
                }
            }
        });
    }
    {
        let host = Arc::clone(&host);
        thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut stdin = stdin.lock();
            loop {
                match read_frame(&mut stdin) {
                    Ok(msg) => {
                        if let Err(e) = handle_sw_message(&host, msg) {
                            error!("handle_sw_message: {e:#}");
                            break;
                        }
                    }
                    Err(FrameError::Io(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        info!("stdin closed (Chrome disconnected), exiting");
                        break;
                    }
                    Err(e) => {
                        error!("read_frame: {e:#}");
                        break;
                    }
                }
            }
            if let Some(manager) = &host.recording {
                manager.shutdown(std::time::Duration::from_millis(200));
            }
            unregister_host_instance(&host);
            std::process::exit(0);
        });
    }

    info!("waiting for hello from SW…");
    let socket_name = loop {
        if let Some(n) = host.socket_name() {
            break n;
        }
        thread::sleep(std::time::Duration::from_millis(50));
    };

    // Unix: clear stale socket file from a previous run before binding.
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(&socket_name);
    }

    let listener =
        transport::bind(&socket_name).with_context(|| format!("bind {}", socket_name))?;
    if let Err(e) = transport::register_instance(host.instance_id.lock().unwrap().as_ref().unwrap())
    {
        warn!("register_instance failed (non-fatal): {e}");
    }
    info!("listening on {}", socket_name);

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let host = Arc::clone(&host);
                thread::spawn(move || {
                    if let Err(e) = handle_cli_connection(host, stream) {
                        error!("cli connection: {e:#}");
                    }
                });
            }
            Err(e) => warn!("accept failed: {e}"),
        }
    }

    unregister_host_instance(&host);
    Ok(())
}

fn handle_sw_message(host: &Arc<Host>, msg: serde_json::Value) -> Result<()> {
    let method = msg
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id = msg.get("id").and_then(|v| v.as_u64());

    if method.starts_with("record.") {
        let Some(tx) = host.stdout_tx.lock().unwrap().clone() else {
            return Ok(());
        };
        let rpc_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let valid_source_id = rpc_id
            .as_str()
            .is_some_and(|s| s.starts_with("sw-") && s.len() <= 128);
        let reply: recording::Reply = Box::new(move |result| {
            let response = match result {
                Ok(v) => serde_json::json!({"id":rpc_id,"ok":true,"result":v}),
                Err(e) => {
                    serde_json::json!({"id":rpc_id,"ok":false,"error":{"code":e.0,"message":e.1}})
                }
            };
            if let Ok(buf) = encode(&response) {
                let _ = tx.send(buf);
            }
        });
        if !valid_source_id {
            reply(Err(recording::Error(
                "RECORD_INVALID_PARAMS",
                "source recording calls require a bounded sw-* RPC id",
            )));
            return Ok(());
        }
        match &host.recording {
            Some(manager) => manager.source(
                &method,
                msg.get("params").cloned().unwrap_or_default(),
                reply,
            ),
            None => reply(Err(recording::Error(
                "RECORD_STORAGE",
                "recording storage is unavailable",
            ))),
        }
        return Ok(());
    }

    match (method.as_str(), id) {
        (HELLO_METHOD, _) => {
            let params: HelloParams = serde_json::from_value(
                msg.get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .context("parse hello params")?;
            info!(
                "hello: instance_id={} label={:?} active_tab={:?}",
                params.instance_id, params.label, params.active_tab
            );
            *host.instance_id.lock().unwrap() = Some(params.instance_id);
            Ok(())
        }

        (KEEPALIVE_METHOD, _) => {
            debug!("keepalive");
            Ok(())
        }

        ("relay.check_liveness" | "relay.register_peer" | "relay.deliver", _) => {
            let tx = host
                .stdout_tx
                .lock()
                .unwrap()
                .clone()
                .context("stdout unavailable")?;
            let params = msg
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let result = (|| -> Result<serde_json::Value> {
                match method.as_str() {
                    "relay.check_liveness" => {
                        #[derive(serde::Deserialize)]
                        struct Liveness {
                            pid: u32,
                            inbox: String,
                            session_id: Option<String>,
                            receiver_epoch: Option<String>,
                        }
                        let p: Liveness = serde_json::from_value(params)?;
                        Ok(relay::check_liveness(
                            p.pid,
                            &p.inbox,
                            p.session_id.as_deref(),
                            p.receiver_epoch.as_deref(),
                        ))
                    }
                    "relay.register_peer" => {
                        #[derive(serde::Deserialize)]
                        struct Peer {
                            instance_id: String,
                            label: Option<String>,
                            inbox: String,
                        }
                        let p: Peer = serde_json::from_value(params)?;
                        let registered = host.relay.register_peer(
                            &p.instance_id,
                            p.label.as_deref(),
                            &p.inbox,
                            tx.clone(),
                        )?;
                        Ok(serde_json::json!({"registered": registered}))
                    }
                    _ => host
                        .relay
                        .deliver(serde_json::from_value(params)?, tx.clone()),
                }
            })();
            let resp = match result {
                Ok(result) => {
                    serde_json::json!({"id": msg.get("id"), "ok": true, "result": result})
                }
                Err(e) => serde_json::json!({"id": msg.get("id"), "ok": false, "error": {
                    "code": match e.to_string().as_str() {
                        "BINDING_OFFLINE" => "BINDING_OFFLINE",
                        "BINDING_UNVERIFIED" => "BINDING_UNVERIFIED",
                        _ => "RELAY_FAILED",
                    },
                    "message": format!("{e:#}")
                }}),
            };
            let _ = tx.send(encode(&resp)?);
            Ok(())
        }

        (_, Some(id)) => {
            let encoded = encode(&msg)?;
            let tx = host.pending.lock().unwrap().remove(&id);
            match tx {
                Some(tx) => {
                    let _ = tx.send(encoded);
                }
                None => warn!("received response for unknown id={id}, dropping"),
            }
            Ok(())
        }

        _ => {
            debug!("ignoring unknown SW message: {}", method);
            Ok(())
        }
    }
}

fn response_timeout_secs(request: &serde_json::Value) -> u64 {
    request
        .get("params")
        .and_then(|params| params.get("_timeout_hint_secs"))
        .and_then(serde_json::Value::as_u64)
        .filter(|seconds| *seconds > 0 && *seconds <= MAX_RESPONSE_TIMEOUT_SECS)
        .unwrap_or(RESPONSE_TIMEOUT_SECS)
}

fn write_error_to_cli(stream: &mut transport::Stream, code: &str, message: &str) -> Result<()> {
    let err = serde_json::json!({ "ok": false, "error": { "code": code, "message": message } });
    stream.write_all(&encode(&err)?)?;
    let _ = stream.flush();
    Ok(())
}

fn handle_cli_connection(host: Arc<Host>, mut stream: transport::Stream) -> Result<()> {
    let req_value = read_frame(&mut stream).context("read cli frame")?;
    let req: Request = serde_json::from_value(req_value.clone()).context("parse cli request")?;
    debug!("cli request method={}", req.method);

    let id = host.next_id.fetch_add(1, Ordering::SeqCst);
    if req.method.starts_with("record.") {
        return handle_record_cli(
            &host,
            &mut stream,
            id,
            &req.method,
            req_value.get("params").cloned().unwrap_or_default(),
        );
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    host.pending.lock().unwrap().insert(id, tx);

    let timeout_secs = response_timeout_secs(&req_value);

    let forwarded = {
        let mut v = req_value;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("id".into(), serde_json::json!(id));
        }
        v
    };
    let encoded = encode(&forwarded)?;

    let stdout_tx = match host.stdout_tx.lock().unwrap().clone() {
        Some(tx) => tx,
        None => {
            host.pending.lock().unwrap().remove(&id);
            return write_error_to_cli(
                &mut stream,
                "EXTENSION_DISCONNECTED",
                "stdout channel closed (Chrome disconnected)",
            );
        }
    };
    if stdout_tx.send(encoded).is_err() {
        // The stdout writer thread is gone — Chrome closed the native pipe,
        // so no response will ever come back. Tell the CLI instead of
        // silently dropping the connection (which would hang its read).
        host.pending.lock().unwrap().remove(&id);
        return write_error_to_cli(
            &mut stream,
            "EXTENSION_DISCONNECTED",
            "Chrome disconnected the native port before the response",
        );
    }

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(buf) => {
            stream.write_all(&buf).context("write response to cli")?;
            let _ = stream.flush();
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            write_error_to_cli(
                &mut stream,
                "TIMEOUT",
                &format!("request timed out after {timeout_secs}s"),
            )?;
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            write_error_to_cli(
                &mut stream,
                "EXTENSION_DISCONNECTED",
                "SW Port disconnected while waiting for response",
            )?;
        }
    }

    host.pending.lock().unwrap().remove(&id);
    Ok(())
}

fn forward_record_control(
    host: &Arc<Host>,
    id: u64,
    method: &str,
    params: &serde_json::Value,
) -> std::result::Result<serde_json::Value, recording::Error> {
    let (tx, rx) = mpsc::channel();
    host.pending.lock().unwrap().insert(id, tx);
    let forwarded = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    let sent = host.stdout_tx.lock().unwrap().as_ref().is_some_and(|tx| {
        encode(&forwarded)
            .ok()
            .is_some_and(|buf| tx.send(buf).is_ok())
    });
    let response = if sent {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| recording::Error("TIMEOUT", "recording control timed out"))
            .and_then(|buf| {
                read_frame(&mut buf.as_slice()).map_err(|_| {
                    recording::Error(
                        "RECORD_INVALID_PARAMS",
                        "invalid recording control response",
                    )
                })
            })
            .and_then(|v| {
                if v["result"]["ok"] == true {
                    Ok(v["result"]["data"].clone())
                } else {
                    let code = v["error"]["code"]
                        .as_str()
                        .or_else(|| v["result"]["error"]["code"].as_str());
                    let missing_method = v["error"]["code"].as_i64() == Some(-32601)
                        || v["result"]["error"]["code"].as_i64() == Some(-32601);
                    Err(recording::Error::remote(if missing_method {
                        Some("METHOD_NOT_FOUND")
                    } else {
                        code
                    }))
                }
            })
    } else {
        Err(recording::Error(
            "EXTENSION_DISCONNECTED",
            "recording native port disconnected",
        ))
    };
    host.pending.lock().unwrap().remove(&id);
    response
}

fn handle_record_cli(
    host: &Arc<Host>,
    stream: &mut transport::Stream,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> Result<()> {
    let result = (|| {
        let manager = host.recording.as_ref().ok_or(recording::Error(
            "RECORD_STORAGE",
            "recording storage is unavailable",
        ))?;
        let instance = host.instance_id.lock().unwrap().clone().unwrap_or_default();
        if method == ap_browser_core::recording::method::START
            && manager.needs_start_preflight(&params)?
        {
            // Never trust a prior CLI assertion or cache support across native ports.
            // This pure negotiation happens before a recording identity/slot exists.
            let cap_id = host.next_id.fetch_add(1, Ordering::SeqCst);
            let capability = forward_record_control(
                host,
                cap_id,
                ap_browser_core::recording::v2::method::CAPABILITIES,
                &serde_json::json!({}),
            );
            manager.complete(recording::Context::Capabilities, capability)?;
        }
        match manager.prepare(method, params, &instance)? {
            recording::Route::Local(v) => Ok(v),
            recording::Route::Forward(params, context) => {
                let response = forward_record_control(host, id, method, &params);
                let recover = match (&context, &response) {
                    (recording::Context::Start(identity), Err(e))
                        if e.0 != "EXTENSION_DISCONNECTED" =>
                    {
                        manager.begin_start_recovery(identity)
                    }
                    _ => false,
                };
                let result = manager.complete(context.clone(), response);
                if recover {
                    if let recording::Context::Start(identity) = &context {
                        // Replay byte-for-byte-equivalent augmented params, not prepare(start):
                        // only the extension's original cached Started may supply provenance.
                        let recovery_id = host.next_id.fetch_add(1, Ordering::SeqCst);
                        let recovered = forward_record_control(host, recovery_id, method, &params);
                        let _ = manager.complete(
                            recording::Context::RecoverStart(identity.clone()),
                            recovered,
                        );
                    }
                }
                // A lost start response never allocates another slot; stop the reserved identity.
                if result
                    .as_ref()
                    .map_or(true, |v| v["state"] == "stopping" || v["state"] == "failed")
                {
                    if let recording::Context::Start(identity) = context {
                        if let Some(tx) = host.stdout_tx.lock().unwrap().as_ref() {
                            let stop_id = host.next_id.fetch_add(1, Ordering::SeqCst);
                            if let Ok(buf) = encode(
                                &serde_json::json!({"jsonrpc":"2.0","id":stop_id,"method":"record.stop",
                                "params":{"identity":identity,"operation_id":"host_start_reconcile"}}),
                            ) {
                                let _ = tx.send(buf);
                            }
                        }
                    }
                }
                result
            }
        }
    })();
    let response = match result {
        Ok(v) => serde_json::json!({"jsonrpc":"2.0","id":id,"result":{"ok":true,"data":v}}),
        Err(e) => serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":e.0,"message":e.1}}),
    };
    stream.write_all(&encode(&response)?)?;
    let _ = stream.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_rpc_responds_to_string_ids_and_recovers_from_bad_params() -> Result<()> {
        let host = Arc::new(Host::new());
        let (tx, rx) = mpsc::channel();
        *host.stdout_tx.lock().unwrap() = Some(tx);
        for (id, params, expected_ok) in [
            (
                "sw-1",
                serde_json::json!({"pid": std::process::id(), "inbox": std::env::temp_dir(), "session_id": "rpc-test"}),
                true,
            ),
            ("sw-2", serde_json::json!({"pid": "invalid"}), false),
            (
                "sw-3",
                serde_json::json!({"pid": 0, "inbox": std::env::temp_dir()}),
                true,
            ),
        ] {
            handle_sw_message(
                &host,
                serde_json::json!({"id": id, "method": "relay.check_liveness", "params": params}),
            )?;
            let frame = rx.recv_timeout(std::time::Duration::from_secs(1))?;
            let response = read_frame(&mut frame.as_slice())?;
            assert_eq!(response["id"], id);
            assert_eq!(response["ok"], expected_ok);
            if id == "sw-1" {
                assert_eq!(response["result"]["state"], "unknown");
                assert_eq!(response["result"]["reason"], "RECEIVER_UNVERIFIED");
            }
            if id == "sw-3" {
                assert_eq!(response["result"]["state"], "offline");
            }
        }
        Ok(())
    }

    #[test]
    fn accepts_long_bounded_response_timeout_hints() {
        assert_eq!(
            response_timeout_secs(&serde_json::json!({
                "params": {"_timeout_hint_secs": 1_800}
            })),
            1_800
        );
        assert_eq!(
            response_timeout_secs(&serde_json::json!({
                "params": {"_timeout_hint_secs": 3_601}
            })),
            RESPONSE_TIMEOUT_SECS
        );
    }

    #[cfg(unix)]
    #[test]
    fn unregisters_socket_before_forced_exit() {
        let host = Host::new();
        let id = format!("cleanup-test-{}", std::process::id());
        *host.instance_id.lock().unwrap() = Some(id.clone());
        let socket = transport::instance_name(&id);
        std::fs::File::create(&socket).unwrap();

        unregister_host_instance(&host);

        assert!(!std::path::Path::new(&socket).exists());
    }
}
