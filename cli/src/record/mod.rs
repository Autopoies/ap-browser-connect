//! Recording orchestration and CLI-machine artifact generation. No browser/host paths.
mod args;
mod export;
mod model;
mod offline;
mod offline_v2;
mod template;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_crop;
#[cfg(test)]
mod tests_extra;
#[cfg(all(test, unix))]
mod tests_lifetime;
#[cfg(test)]
mod tests_v2;
#[cfg(test)]
mod tests_v2_crop;
#[cfg(test)]
mod tests_v2_text;
mod util;
mod validate;

pub use args::RecordArgs;
pub fn check_capabilities() -> anyhow::Result<()> {
    util::preflight()
}
use anyhow::{Context, Result};
use ap_browser_core::{
    recording::{
        v2::{self, StartRequest, Status},
        *,
    },
    transport,
};
use args::{Action, CaptureArgs, ExportArgs};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};
use util::*;

#[derive(Debug)]
struct RpcFailure {
    code: String,
    message: String,
}
impl std::fmt::Display for RpcFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcFailure {}
pub fn error_code(error: &anyhow::Error) -> Option<&str> {
    error.downcast_ref::<RpcFailure>().map(|e| e.code.as_str())
}
fn rpc_failure(value: &Value) -> anyhow::Error {
    RpcFailure {
        code: value["code"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| value["code"].as_i64().map(|n| n.to_string()))
            .unwrap_or_else(|| "RECORD_RPC_FAILED".into()),
        message: value["message"]
            .as_str()
            .unwrap_or("recording RPC failed")
            .into(),
    }
    .into()
}

#[derive(Clone, Debug)]
struct Handle {
    instance: String,
    identity: Identity,
}
impl Handle {
    fn parse(s: &str) -> Result<Self> {
        let parts = s.split(':').collect::<Vec<_>>();
        anyhow::ensure!(
            parts.len() == 3 && parts.iter().all(|s| valid_id(s)),
            "handle must be INSTANCE:HOST_EPOCH:RECORD_ID returned by record start"
        );
        Ok(Self {
            instance: parts[0].into(),
            identity: Identity {
                host_epoch: parts[1].into(),
                record_id: parts[2].into(),
            },
        })
    }
    fn token(&self) -> String {
        format!(
            "{}:{}:{}",
            self.instance, self.identity.host_epoch, self.identity.record_id
        )
    }
    fn params(&self) -> Value {
        json!({"identity":self.identity})
    }
}
/// A real caller deadline covers connect, handshake, writes and reads. Existing
/// transport read_response ignores timeout; do not rely on its timeout argument.
/// On deadline this command aborts, never retries a mutating RPC. The process
/// owns the bounded worker; it cannot keep the CLI alive after main exits.
fn bounded<T: Send + 'static>(
    timeout: Duration,
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(timeout) {
        Ok(result)=>result,
        Err(mpsc::RecvTimeoutError::Timeout)=>Err(RpcFailure{code:"TIMEOUT".into(),message:"recording operation timed out; outcome uncertain. Reconcile only on the same live host epoch/IPC; a new host epoch cannot recover old recording handles".into()}.into()),
        Err(e)=>Err(e).context("recording I/O worker disconnected"),
    }
}
fn resolve(cli: &crate::Cli) -> Result<String> {
    let profile = cli.profile.clone();
    let wait = cli.wait_online.min(600);
    bounded(Duration::from_secs(wait + 10), move || {
        crate::socket_client::resolve_socket_wait(profile.as_deref(), wait)
    })
}
fn rpc(instance: &str, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    let instance = instance.to_string();
    let method = method.to_string();
    let response = bounded(timeout, move || {
        let request = json!({"jsonrpc":"2.0","method":method,"params":params});
        let bytes = crate::cli_frame::encode(&request)?;
        let mut stream = crate::socket_client::dial_with_retry(&instance, 1, Duration::ZERO)?;
        stream.write_all(&bytes)?;
        stream.flush()?;
        crate::cli_frame::read_response(&mut stream, timeout)
    })?;
    if let Some(e) = response.get("error") {
        return Err(rpc_failure(e));
    }
    let result = response
        .get("result")
        .context("missing recording RPC result")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(rpc_failure(&result["error"]));
    }
    Ok(result
        .get("data")
        .context("missing recording RPC data")?
        .clone())
}
fn validate_capabilities(value: Value) -> Result<()> {
    for side in ["host", "extension"] {
        anyhow::ensure!(value[side]["protocol_version"].as_u64().is_some() && value[side]["backend"].as_str().is_some(), "invalid recording capability schema from {side}; expected numeric version and backend string");
    }
    let version = |side: &str| value[side]["protocol_version"].as_u64() == Some(2);
    if !version("host") || !version("extension") {
        return Err(RpcFailure { code: v2::UNSUPPORTED_VERSION.into(), message: "Recording requires host AND extension protocol v2; upgrade both components (no legacy capture fallback)".into() }.into());
    }
    if ["host", "extension"]
        .iter()
        .any(|s| value[*s]["backend"] != "cdp_capture_screenshot")
    {
        return Err(RpcFailure { code: v2::UNSUPPORTED_BACKEND.into(), message: "Recording requires cdp_capture_screenshot on host AND extension; upgrade both components".into() }.into());
    }
    let caps: v2::Capabilities =
        serde_json::from_value(value).context("invalid recording capability schema")?;
    caps.validate().map_err(anyhow::Error::msg)
}
fn negotiate(instance: &str, timeout: Duration) -> Result<()> {
    // Deliberately exact empty body: never generic tab/filter/timeout hints.
    let value = rpc(instance, v2::method::CAPABILITIES, json!({}), timeout).map_err(|e| {
        if matches!(
            error_code(&e),
            Some("-32601" | "METHOD_NOT_FOUND" | "UNKNOWN_METHOD")
        ) {
            RpcFailure {
                code: v2::UNSUPPORTED_VERSION.into(),
                message:
                    "record.capabilities unavailable; upgrade host AND extension to recording v2"
                        .into(),
            }
            .into()
        } else {
            e
        }
    })?;
    validate_capabilities(value)
}
fn rpc_timeout(cli: &crate::Cli) -> Duration {
    Duration::from_secs(cli.timeout.clamp(1, 10))
}
fn status(h: &Handle, t: Duration) -> Result<Status> {
    let s: Status = serde_json::from_value(rpc(&h.instance, method::STATUS, h.params(), t)?)?;
    anyhow::ensure!(
        s.protocol_version == 2
            && s.backend == v2::Backend::CdpCaptureScreenshot
            && s.identity == h.identity
            && s.instance_id == h.instance,
        "status identity/version mismatch"
    );
    Ok(s)
}
fn result_status(h: &Handle, s: Status) -> Value {
    json!({"handle":h.token(),"status":s})
}
fn operation(s: Option<&str>) -> Result<String> {
    let id = s.map(String::from).unwrap_or_else(id);
    anyhow::ensure!(valid_id(&id), "invalid operation_id");
    Ok(id)
}
fn capture_config(c: &CaptureArgs, plan: &export::Plan, duration: u64) -> Result<CaptureConfig> {
    let region = if let Some(region) = &c.region {
        let values = region
            .split(',')
            .map(str::parse::<f64>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        anyhow::ensure!(
            values.len() == 4
                && values.iter().all(|n| n.is_finite())
                && values[0] >= 0.0
                && values[1] >= 0.0
                && values[2] > 0.0
                && values[3] > 0.0,
            "--region requires nonnegative x,y and positive width,height"
        );
        Region::Rect {
            rect: Rect {
                x: values[0],
                y: values[1],
                width: values[2],
                height: values[3],
            },
        }
    } else if let Some(selector) = &c.element {
        anyhow::ensure!(
            !selector.is_empty() && selector.len() <= 1024,
            "element selector must be 1..1024 UTF-8 bytes"
        );
        Region::Element {
            selector: selector.clone(),
        }
    } else {
        Region::Viewport
    };
    let fps = c.capture_fps.unwrap_or(plan.settings.fps);
    anyhow::ensure!(
        (1..=30).contains(&fps) && (1..=100).contains(&c.jpeg_quality),
        "capture fps must be 1..30 and JPEG quality 1..100"
    );
    Ok(CaptureConfig {
        max_duration_ms: duration,
        capture_fps: fps,
        jpeg_quality: c.jpeg_quality,
        region,
        labels: plan.labels.clone(),
        run_id: plan.run_id.clone(),
    })
}
fn start(
    cli: &crate::Cli,
    c: &CaptureArgs,
    plan: &export::Plan,
    duration: u64,
) -> Result<(Handle, Status)> {
    let config = capture_config(c, plan, duration)?;
    let op = operation(c.operation_id.as_deref())?;
    let instance = resolve(cli)?;
    negotiate(&instance, rpc_timeout(cli))?;
    let request = StartRequest {
        protocol_version: 2,
        backend: v2::Backend::CdpCaptureScreenshot,
        operation_id: op.clone(),
        tab_id: cli.tab,
        config,
    };
    let s: Status = serde_json::from_value(
        rpc(
            &instance,
            method::START,
            serde_json::to_value(request)?,
            rpc_timeout(cli),
        )
        .with_context(|| format!("start operation_id={op}"))?,
    )?;
    validate::identity(&s.identity)?;
    anyhow::ensure!(
        s.protocol_version == 2
            && s.backend == v2::Backend::CdpCaptureScreenshot
            && valid_id(&s.instance_id)
            && s.operation_id == op
            && (transport::remote_endpoint().is_some() || s.instance_id == instance),
        "start status instance/version/operation mismatch"
    );
    let handle = Handle {
        instance: s.instance_id.clone(),
        identity: s.identity.clone(),
    };
    Ok((handle, s))
}
fn terminal(s: &Status) -> bool {
    matches!(s.state, State::Sealed | State::Failed)
}
fn wait_terminal(h: &Handle, timeout: Duration, rpc_limit: Duration) -> Result<Status> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "timed out waiting for durable seal; handle {} requires the same live host epoch/IPC for any retained source",
            h.token()
        );
        let s = status(h, rpc_limit.min(remaining))?;
        if terminal(&s) {
            return Ok(s);
        }
        std::thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}
fn stop(h: &Handle, t: Duration) -> Result<Status> {
    let mut params = h.params();
    params["operation_id"] = json!(id());
    let s: Status = serde_json::from_value(rpc(&h.instance, method::STOP, params, t)?)?;
    anyhow::ensure!(
        s.protocol_version == 2
            && s.backend == v2::Backend::CdpCaptureScreenshot
            && s.identity == h.identity
            && s.instance_id == h.instance,
        "stop identity/version/backend mismatch"
    );
    if terminal(&s) {
        Ok(s)
    } else {
        wait_terminal(h, Duration::from_secs(15), t)
    }
}
fn fetch(
    h: &Handle,
    m: &v2::Manifest,
    temp: &Temp,
    t: Duration,
) -> Result<Vec<export::SourceFrame>> {
    let path = temp.0.join("spool");
    let mut opts = fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path)?;
    let mut offset = 0;
    let mut digest_all = Sha256::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    while offset < m.spool_bytes {
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(!remaining.is_zero(), "chunk transfer timeout");
        let length = (m.spool_bytes - offset).min(MAX_CHUNK_BYTES as u64) as u32;
        let c: Chunk = serde_json::from_value(rpc(
            &h.instance,
            method::READ,
            json!({"identity":h.identity,"offset":offset,"length":length}),
            t.min(remaining),
        )?)?;
        let bytes = check_chunk(&c, &h.identity, offset, length, m.spool_bytes)?;
        file.write_all(&bytes)?;
        digest_all.update(&bytes);
        offset += bytes.len() as u64;
    }
    file.sync_all()?;
    drop(file);
    anyhow::ensure!(
        format!("{:x}", digest_all.finalize()) == m.spool_sha256,
        "spool SHA-256 mismatch"
    );
    let mut file = fs::File::open(&path)?;
    let mut frames = Vec::new();
    for entry in &m.frames {
        let mut bytes = vec![0; entry.length as usize];
        file.read_exact(&mut bytes)?;
        anyhow::ensure!(digest(&bytes) == entry.sha256, "JPEG frame digest mismatch");
        let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes));
        reader.set_format(image::ImageFormat::Jpeg);
        let dimensions = reader.into_dimensions()?;
        anyhow::ensure!(
            dimensions == (entry.width, entry.height),
            "JPEG header dimensions mismatch"
        );
        let path = temp.0.join(format!("source-{}.jpg", entry.seq));
        write_new(&path, &bytes)?;
        frames.push(export::SourceFrame {
            t_ms: entry.t_ms,
            data: export::FrameData::Jpeg(path),
            original: None,
        });
    }
    fs::remove_file(path)?;
    Ok(frames)
}
fn check_chunk(
    c: &Chunk,
    identity: &Identity,
    offset: u64,
    length: u32,
    total: u64,
) -> Result<Vec<u8>> {
    anyhow::ensure!(
        &c.identity == identity
            && c.offset == offset
            && c.total_bytes == total
            && c.length == length
            && length <= MAX_CHUNK_BYTES
            && offset
                .checked_add(length as u64)
                .is_some_and(|end| end <= total)
            && c.eof == (offset + length as u64 == total)
            && valid_sha256(&c.sha256)
            && c.data_base64.len() <= (MAX_CHUNK_BYTES as usize).div_ceil(3) * 4,
        "invalid chunk identity/size/offset/EOF"
    );
    let bytes = STANDARD.decode(&c.data_base64)?;
    anyhow::ensure!(
        bytes.len() == length as usize
            && STANDARD.encode(&bytes) == c.data_base64
            && digest(&bytes) == c.sha256,
        "chunk base64/length/digest mismatch"
    );
    Ok(bytes)
}
fn export_record(h: &Handle, args: &ExportArgs, t: Duration) -> Result<Value> {
    // Out is mandatory and checked before contact with the browser host.
    let output = Output::new(
        args.out.as_deref(),
        args.metadata
            || args.watermark_config.is_some()
            || !matches!(args.watermark.as_str(), "none" | ""),
        None,
    )?;
    let v = rpc(&h.instance, method::MANIFEST, h.params(), t)?;
    let snapshot = serde_json::to_string(&v)?;
    anyhow::ensure!(
        snapshot.len() <= MAX_MANIFEST_BYTES,
        "manifest exceeds limit"
    );
    let model::ValidatedSource::Snapshot(m) =
        model::ValidatedSource::parse(&snapshot, &h.instance, &h.identity, args.partial)?
    else {
        anyhow::bail!("live export requires protocol v2; legacy v1 is offline read-only");
    };
    let plan = export::Plan::new(args, m.config.labels.clone(), m.config.run_id.clone(), true)?;
    preflight()?;
    let frames = fetch(h, &m, &output.temp, t)?;
    let duration_ms = m.end.duration_ms;
    let source = export::Source {
        frames,
        duration_ms,
        manifest: None,
        snapshot_v2: Some(m),
        snapshot: Some(snapshot),
        provenance: Provenance::Recording,
        input_video: None,
        parent_export_id: None,
    };
    export::encode(&source, &plan, &output)
}

fn preserve_error(error: anyhow::Error) -> anyhow::Error {
    if error_code(&error).is_some() {
        error
    } else {
        RpcFailure {
            code: "CLI_ERROR".into(),
            message: format!("{error:#}"),
        }
        .into()
    }
}
pub fn run(cli: &crate::Cli, args: &RecordArgs) -> Result<()> {
    run_inner(cli, args).map_err(preserve_error)
}
fn run_inner(cli: &crate::Cli, args: &RecordArgs) -> Result<()> {
    let t = rpc_timeout(cli);
    let value = match &args.command {
        Some(Action::Watermark {
            input,
            sidecar,
            timeline,
            export,
        }) => offline::run(input, sidecar.as_deref(), timeline.as_deref(), export)?,
        Some(Action::Start { capture, export }) => {
            anyhow::ensure!(
                export.out.is_none(),
                "record start returns a handle, not video; use record export HANDLE --out PATH"
            );
            let plan = export::Plan::new(export, Labels::new(), None, true)?;
            preflight()?;
            let (h, s) = start(
                cli,
                capture,
                &plan,
                args::duration(&capture.max_duration, MAX_DURATION_MS)?,
            )?;
            result_status(&h, s)
        }
        Some(Action::Status { handle }) => {
            let h = Handle::parse(handle)?;
            result_status(&h, status(&h, t)?)
        }
        Some(Action::Stop { handle, export }) => {
            let h = Handle::parse(handle)?;
            let checked_output = if export.out.is_some() {
                // Retained source labels are available only in the sealed manifest;
                // defer custom placeholder resolution until then, not against empty labels.
                let output = Output::new(
                    export.out.as_deref(),
                    export.metadata
                        || export.watermark_config.is_some()
                        || !matches!(export.watermark.as_str(), "none" | ""),
                    None,
                )?;
                anyhow::ensure!(
                    matches!(
                        output
                            .video
                            .extension()
                            .and_then(|s| s.to_str())
                            .map(str::to_ascii_lowercase)
                            .as_deref(),
                        Some("gif" | "mp4" | "mov")
                    ),
                    "--out extension must be .gif, .mp4 or .mov"
                );
                preflight()?;
                Some(output)
            } else {
                None
            };
            let s = stop(&h, t)?;
            drop(checked_output);
            if export.out.is_some() {
                export_record(&h, export, t)?
            } else {
                result_status(&h, s)
            }
        }
        Some(Action::Export { handle, export }) => {
            export_record(&Handle::parse(handle)?, export, t)?
        }
        Some(Action::Release { handle }) => {
            let h = Handle::parse(handle)?;
            let r: Released =
                serde_json::from_value(rpc(&h.instance, method::RELEASE, h.params(), t)?)?;
            anyhow::ensure!(
                r.identity == h.identity && r.released,
                "release identity/result mismatch"
            );
            serde_json::to_value(r)?
        }
        Some(Action::Phase {
            handle,
            text,
            operation_id,
        })
        | Some(Action::Mark {
            handle,
            text,
            operation_id,
            ..
        }) => {
            let h = Handle::parse(handle)?;
            let phase = matches!(args.command, Some(Action::Phase { .. }));
            template::text_ok(text, phase)?;
            let mut p = h.params();
            let operation = operation(operation_id.as_deref())?;
            p["operation_id"] = json!(operation);
            p["text"] = json!(text);
            if let Some(Action::Mark { duration, .. }) = &args.command {
                p["duration_ms"] = json!(args::duration(duration, 10000)?);
            }
            let event: Event = serde_json::from_value(rpc(
                &h.instance,
                if phase { method::PHASE } else { method::MARK },
                p,
                t,
            )?)?;
            anyhow::ensure!(
                event.operation_id == operation
                    && event.event_index >= 1
                    && event.event_index <= MAX_EVENTS as u64
                    && event.t_ms.is_finite()
                    && event.t_ms >= 0.0
                    && event.t_ms <= 60000.0,
                "event response mismatch"
            );
            match (&event.kind, &args.command) {
                (EventKind::Phase { text: actual }, Some(Action::Phase { .. })) => {
                    anyhow::ensure!(actual == text, "phase response mismatch")
                }
                (
                    EventKind::Mark {
                        text: actual,
                        duration_ms,
                    },
                    Some(Action::Mark { duration, .. }),
                ) => anyhow::ensure!(
                    actual == text && *duration_ms as u64 == args::duration(duration, 10000)?,
                    "mark response mismatch"
                ),
                _ => anyhow::bail!("event kind response mismatch"),
            }
            serde_json::to_value(event)?
        }
        None => {
            let duration = args::duration(&args.duration, MAX_DURATION_MS)?;
            anyhow::ensure!(
                duration <= args::duration(&args.capture.max_duration, MAX_DURATION_MS)?,
                "--duration exceeds --max-duration"
            );
            let plan = export::Plan::new(&args.export, Labels::new(), None, true)?;
            // Reserve/check caller destination and validate all options before capture.
            let preflight_output = Output::new(
                args.export.out.as_deref(),
                plan.sidecars(&args.export),
                None,
            )?;
            preflight()?;
            let (h, s) = start(cli, &args.capture, &plan, duration)?;
            eprintln!("[record handle: {}]", h.token());
            let status = if terminal(&s) {
                s
            } else {
                wait_terminal(&h, Duration::from_millis(duration + 15000), t)?
            };
            drop(preflight_output);
            anyhow::ensure!(terminal(&status), "recording not terminal");
            export_record(&h, &args.export, t).with_context(|| {
                format!("export failed for recording handle {}; source retention requires the same live host epoch/IPC and remains subject to release/expiry; host disconnect, exit or restart may make it unavailable", h.token())
            })?
        }
    };
    let response = json!({"ok":true,"data":value});
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}
