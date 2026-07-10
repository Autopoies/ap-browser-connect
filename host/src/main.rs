//! ap-browser-host — Chrome native messaging host that owns a local IPC socket.
//!
//! Spawned by Chrome when the extension SW calls `chrome.runtime.connectNative`.
//! Reads frames from stdin (Chrome-native 4-byte LE framing), waits for the
//! first `hello` message to learn the instance_id, binds an IPC socket
//! (Unix domain socket on Unix, named pipe on Windows), then accepts CLI
//! connections and multiplexes them over the single stdin/stdout pipe to the SW.

use ap_browser_core::{encode, read_frame, transport, FrameError, HelloParams, Request};
// Bring in interprocess trait methods (incoming/accept) on transport::Listener.
use interprocess::local_socket::prelude::*;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tracing::{debug, error, info, warn};

const KEEPALIVE_METHOD: &str = "keepalive";
const HELLO_METHOD: &str = "hello";
const RESPONSE_TIMEOUT_SECS: u64 = 30;

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Vec<u8>>>>>;

struct Host {
    instance_id: Mutex<Option<String>>,
    pending: Pending,
    next_id: AtomicU64,
    stdout_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl Host {
    fn new() -> Self {
        Self {
            instance_id: Mutex::new(None),
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

fn main() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .try_init();

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
                    Err(FrameError::Io(ref e))
                        if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        info!("stdin closed (Chrome disconnected), exiting");
                        break;
                    }
                    Err(e) => {
                        error!("read_frame: {e:#}");
                        break;
                    }
                }
            }
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

    let listener = transport::bind(&socket_name)
        .with_context(|| format!("bind {}", socket_name))?;
    if let Err(e) = transport::register_instance(host.instance_id.lock().unwrap().as_ref().unwrap()) {
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

    if let Some(id) = host.instance_id.lock().unwrap().clone() {
        let _ = transport::unregister_instance(&id);
    }
    Ok(())
}

fn handle_sw_message(host: &Arc<Host>, msg: serde_json::Value) -> Result<()> {
    let method = msg
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id = msg.get("id").and_then(|v| v.as_u64());

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

fn handle_cli_connection(host: Arc<Host>, mut stream: transport::Stream) -> Result<()> {
    let req_value = read_frame(&mut stream).context("read cli frame")?;
    let req: Request =
        serde_json::from_value(req_value.clone()).context("parse cli request")?;
    debug!("cli request method={}", req.method);

    let id = host.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    host.pending.lock().unwrap().insert(id, tx);

    let timeout_secs = req_value
        .get("params")
        .and_then(|p| p.get("_timeout_hint_secs"))
        .and_then(|v| v.as_u64())
        .filter(|&s| s > 0 && s <= 300)
        .unwrap_or(RESPONSE_TIMEOUT_SECS);

    let forwarded = {
        let mut v = req_value;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("id".into(), serde_json::json!(id));
        }
        v
    };
    let encoded = encode(&forwarded)?;

    let stdout_tx = host
        .stdout_tx
        .lock()
        .unwrap()
        .clone()
        .context("stdout channel closed")?;
    stdout_tx.send(encoded).context("forward to SW via stdout")?;

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(buf) => {
            stream.write_all(&buf).context("write response to cli")?;
            let _ = stream.flush();
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let err = serde_json::json!({
                "ok": false,
                "error": {
                    "code": "TIMEOUT",
                    "message": format!("request timed out after {timeout_secs}s")
                }
            });
            let _ = stream.write_all(&encode(&err)?);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let err = serde_json::json!({
                "ok": false,
                "error": {
                    "code": "EXTENSION_DISCONNECTED",
                    "message": "SW Port disconnected while waiting for response"
                }
            });
            let _ = stream.write_all(&encode(&err)?);
        }
    }

    host.pending.lock().unwrap().remove(&id);
    Ok(())
}
