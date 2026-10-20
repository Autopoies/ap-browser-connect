//! Private, host-local recording storage. No caller-controlled paths enter this module.
//! Admission is short and in-memory; the single bounded writer owns all durable writes.
use ap_browser_core::recording::v2::*;
use ap_browser_core::recording::MAX_TEXT_BYTES;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct Error(pub &'static str, pub &'static str);
impl Error {
    pub fn remote(code: Option<&str>) -> Self {
        let code = match code {
            Some(
                "RECORD_UNSUPPORTED_VERSION" | "METHOD_NOT_FOUND" | "UNKNOWN_METHOD" | "-32601",
            ) => UNSUPPORTED_VERSION,
            Some("RECORD_UNSUPPORTED_BACKEND") => UNSUPPORTED_BACKEND,
            Some("RECORD_INVALID_PARAMS") => "RECORD_INVALID_PARAMS",
            Some("RECORD_BUSY") => "RECORD_BUSY",
            Some("RECORD_OPERATION_CONFLICT") => "RECORD_OPERATION_CONFLICT",
            Some("RECORD_NOT_FOUND") => "RECORD_NOT_FOUND",
            Some("RECORD_STALE_HOST") => "RECORD_STALE_HOST",
            Some("RECORD_INVALID_STATE") => "RECORD_INVALID_STATE",
            Some("RECORD_SEQUENCE") => "RECORD_SEQUENCE",
            Some("RECORD_LIMIT") => "RECORD_LIMIT",
            Some("RECORD_NO_FRAMES") => "RECORD_NO_FRAMES",
            Some("RECORD_GEOMETRY_CHANGED") => "RECORD_GEOMETRY_CHANGED",
            Some("RECORD_STORAGE") => "RECORD_STORAGE",
            Some("TIMEOUT") => "TIMEOUT",
            Some("EXTENSION_DISCONNECTED") => "EXTENSION_DISCONNECTED",
            _ => "RECORD_INTERRUPTED",
        };
        Self(code, "extension rejected recording control")
    }
}
type Result<T> = std::result::Result<T, Error>;
fn invalid() -> Error {
    Error("RECORD_INVALID_PARAMS", "invalid recording parameters")
}
fn state_error() -> Error {
    Error(
        "RECORD_INVALID_STATE",
        "recording is not in the required state",
    )
}
fn storage() -> Error {
    Error("RECORD_STORAGE", "private recording storage failed")
}
fn limit() -> Error {
    Error("RECORD_LIMIT", "recording resource limit exceeded")
}
fn parse<T: DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(|_| invalid())
}
fn value(v: impl Serialize) -> Value {
    serde_json::to_value(v).expect("validated recording value")
}
fn terminal(s: State) -> bool {
    matches!(s, State::Sealed | State::Failed)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encoded_bytes(s: &str) -> u64 {
    let padding = if s.ends_with("==") {
        2
    } else if s.ends_with('=') {
        1
    } else {
        0
    };
    (s.len() / 4 * 3).saturating_sub(padding) as u64
}
fn text_ok(t: &str) -> bool {
    t.len() <= MAX_TEXT_BYTES
        && t.split('\n').count() <= 8
        && !t.chars().any(|c| c.is_control() && c != '\n')
}
fn rect_ok(r: &Rect) -> bool {
    [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
        && r.x >= 0.0
        && r.y >= 0.0
        && r.width > 0.0
        && r.height > 0.0
        && r.x + r.width <= 1_000_000.0
        && r.y + r.height <= 1_000_000.0
}
pub fn check_live_version(v: &Value) -> Result<()> {
    match v.get("protocol_version") {
        None => {
            return Err(Error(
                UNSUPPORTED_VERSION,
                "recording requires protocol 2; upgrade matching components",
            ))
        }
        Some(n) if n.is_u64() && n.as_u64() != Some(u64::from(PROTOCOL_VERSION)) => {
            return Err(Error(
                UNSUPPORTED_VERSION,
                "recording requires protocol 2; no legacy capture fallback",
            ))
        }
        Some(n) if n.as_u64() != Some(u64::from(PROTOCOL_VERSION)) => return Err(invalid()),
        _ => {}
    }
    match v.get("backend") {
        Some(Value::String(s)) if s != "cdp_capture_screenshot" => Err(Error(
            UNSUPPORTED_BACKEND,
            "recording requires cdp_capture_screenshot; upgrade matching components",
        )),
        Some(Value::String(_)) => Ok(()),
        _ => Err(invalid()),
    }
}
fn config_ok(r: &StartRequest) -> bool {
    r.validate().is_ok()
        && valid_id(&r.operation_id)
        && !r
            .tab_id
            .is_some_and(|t| t < 0 || t as u64 > MAX_SAFE_INTEGER)
        && (1..=MAX_DURATION_MS).contains(&r.config.max_duration_ms)
        && (1..=30).contains(&r.config.capture_fps)
        && (1..=100).contains(&r.config.jpeg_quality)
        && validate_labels(&r.config.labels).is_ok()
        && match &r.config.run_id {
            Some(id) => valid_id(id),
            None => true,
        }
        && match &r.config.region {
            Region::Viewport => true,
            Region::Rect { rect } => rect_ok(rect),
            Region::Element { selector } => {
                !selector.is_empty() && selector.len() <= 1024 && !selector.contains('\0')
            }
        }
}

pub type Reply = Box<dyn FnOnce(Result<Value>) + Send>;
pub enum Route {
    Local(Value),
    Forward(Value, Context),
}
#[derive(Clone)]
pub enum Context {
    Capabilities,
    Start(Identity),
    RecoverStart(Identity),
    Stop(Identity),
    ReconcileStop(Identity),
    Event(Identity, String, EventKind),
}

struct Session {
    request: StartRequest,
    status: Status,
    started: Option<Started>,
    // One bounded exact-start replay may recover cached facts, never admission.
    start_recovery_until: Option<Instant>,
    start_recovery_attempted: bool,
    stop_operations: HashSet<String>,
    created: Instant,
    control_since: Instant,
    capture_since: Option<Instant>,
    retained: Option<Instant>,
    path: PathBuf,
    // Reads/release only; the writer never holds state while doing filesystem I/O.
    io: Arc<Mutex<()>>,
    frame_pending: bool,
    frame_since: Option<Instant>,
    sealing: bool,
    releasing: bool,
    admitted_seq: u64,
    reserved_bytes: u64,
    // Includes the single outstanding write, for shared prefix validation.
    admitted_frames: Vec<FrameEntry>,
    event_controls: HashMap<String, EventKind>,
    explicit_stop: bool,
    sample_after_stop: bool,
    frames: Vec<FrameEntry>,
    admitted_events: Vec<Event>,
    events: Vec<Event>,
    pending_end: Option<End>,
    end_waiters: Vec<Reply>,
    failure: Option<EndReason>,
    control_error: bool,
    needs_stop: bool,
    manifest: Option<Value>,
    hasher: Sha256,
}
struct Inner {
    sessions: HashMap<String, Session>,
    operations: HashMap<String, StartRequest>,
    released: HashSet<String>,
    next_record: u64,
    reserved_bytes: u64,
}
pub struct Manager {
    epoch: String,
    root: PathBuf,
    _owner: File,
    inner: Mutex<Inner>,
    writer: mpsc::SyncSender<Job>,
    #[cfg(test)]
    pause: Mutex<Option<Arc<std::sync::Barrier>>>,
}
enum Job {
    Frame(String, Box<Frame>, Reply),
    Event(String, Event, Reply),
}

impl Manager {
    pub fn new() -> std::io::Result<Arc<Self>> {
        Self::in_parent(&private_parent()?)
    }
    fn in_parent(parent: &Path) -> std::io::Result<Arc<Self>> {
        #[cfg(unix)]
        let _startup_lock = startup_lock(parent)?;
        cleanup_stale(parent)?;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        static EPOCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let epoch = format!(
            "host_{}_{}_{}",
            std::process::id(),
            nanos,
            EPOCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let root = parent.join(&epoch);
        private_dir(&root)?;
        let mut owner = private_file(&root.join("owner"))?;
        #[cfg(unix)]
        lock_file(&owner, false)?;
        writeln!(owner, "{}", std::process::id())?;
        owner.sync_all()?;
        let (tx, rx) = mpsc::sync_channel(MAX_EVENTS + 16);
        let manager = Arc::new(Self {
            epoch,
            root,
            _owner: owner,
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                operations: HashMap::new(),
                released: HashSet::new(),
                next_record: 1,
                reserved_bytes: 0,
            }),
            writer: tx,
            #[cfg(test)]
            pause: Mutex::new(None),
        });
        let weak = Arc::downgrade(&manager);
        std::thread::spawn(move || writer_loop(weak, rx));
        Ok(manager)
    }
    fn check_identity(&self, id: &Identity) -> Result<()> {
        if !valid_id(&id.host_epoch) || !valid_id(&id.record_id) {
            return Err(invalid());
        }
        if id.host_epoch != self.epoch {
            return Err(Error(
                "RECORD_STALE_HOST",
                "recording belongs to another host epoch",
            ));
        }
        Ok(())
    }
    fn lookup<'a>(&self, i: &'a mut Inner, id: &Identity) -> Result<&'a mut Session> {
        self.check_identity(id)?;
        i.sessions
            .get_mut(&id.record_id)
            .filter(|s| !s.releasing)
            .ok_or(Error("RECORD_NOT_FOUND", "recording is unavailable"))
    }
    /// New native creation must negotiate on the live port before allocation.
    /// Existing operation replays remain local even if that port is unavailable.
    pub fn needs_start_preflight(&self, params: &Value) -> Result<bool> {
        check_live_version(params)?;
        let req: StartRequest = parse(params.clone())?;
        if !config_ok(&req) {
            return Err(invalid());
        }
        Ok(!self
            .inner
            .lock()
            .unwrap()
            .operations
            .contains_key(&req.operation_id))
    }
    pub fn prepare(&self, method: &str, params: Value, instance: &str) -> Result<Route> {
        match method {
            method::CAPABILITIES => {
                if !params.as_object().is_some_and(|p| p.is_empty()) {
                    return Err(invalid());
                }
                let _: CapabilitiesRequest = parse(params)?;
                Ok(Route::Forward(serde_json::json!({}), Context::Capabilities))
            }
            method::START => {
                check_live_version(&params)?;
                let req: StartRequest = parse(params)?;
                if !config_ok(&req) || !valid_id(instance) {
                    return Err(invalid());
                }
                let mut i = self.inner.lock().unwrap();
                if let Some(old) = i.operations.get(&req.operation_id) {
                    if old != &req {
                        return Err(Error(
                            "RECORD_OPERATION_CONFLICT",
                            "operation was used with different parameters",
                        ));
                    }
                    let s = i
                        .sessions
                        .values()
                        .find(|s| s.request.operation_id == req.operation_id)
                        .ok_or(Error(
                            "RECORD_NOT_FOUND",
                            "recording was released or expired",
                        ))?;
                    return Ok(Route::Local(value(&s.status)));
                }
                if i.operations.len() >= 4096
                    || i.sessions.len() >= MAX_RETAINED_RECORDINGS
                    || i.reserved_bytes >= MAX_TOTAL_SPOOL_BYTES
                {
                    return Err(limit());
                }
                if i.sessions.values().any(|s| !terminal(s.status.state)) {
                    return Err(Error("RECORD_BUSY", "another recording is active"));
                }
                let identity = Identity {
                    host_epoch: self.epoch.clone(),
                    record_id: format!("rec_{}", i.next_record),
                };
                i.next_record += 1;
                let path = self.root.join(&identity.record_id);
                let now = Instant::now();
                let status = Status {
                    protocol_version: PROTOCOL_VERSION,
                    backend: Backend::CdpCaptureScreenshot,
                    identity: identity.clone(),
                    operation_id: req.operation_id.clone(),
                    instance_id: instance.into(),
                    tab_id: None,
                    state: State::Starting,
                    persisted_seq: 0,
                    spool_bytes: 0,
                    end: None,
                };
                i.operations.insert(req.operation_id.clone(), req.clone());
                i.sessions.insert(
                    identity.record_id.clone(),
                    Session {
                        request: req.clone(),
                        status,
                        started: None,
                        start_recovery_until: None,
                        start_recovery_attempted: false,
                        stop_operations: HashSet::new(),
                        created: now,
                        control_since: now,
                        capture_since: None,
                        retained: None,
                        path: path.clone(),
                        io: Arc::new(Mutex::new(())),
                        frame_pending: false,
                        frame_since: None,
                        sealing: false,
                        releasing: false,
                        admitted_seq: 0,
                        reserved_bytes: 0,
                        admitted_frames: vec![],
                        event_controls: HashMap::new(),
                        explicit_stop: false,
                        sample_after_stop: false,
                        frames: vec![],
                        admitted_events: vec![],
                        events: vec![],
                        pending_end: None,
                        end_waiters: vec![],
                        failure: None,
                        control_error: false,
                        needs_stop: false,
                        manifest: None,
                        hasher: Sha256::new(),
                    },
                );
                drop(i);
                if private_dir(&path).is_err()
                    || private_file(&path.join("frames")).is_err()
                    || private_file(&path.join("events")).is_err()
                {
                    self.fail(&identity, EndReason::StorageError);
                    return Err(storage());
                }
                Ok(Route::Forward(
                    value(ExtensionStart {
                        request: req,
                        identity: identity.clone(),
                        initial_credit: Credit {
                            identity: identity.clone(),
                            next_seq: 1,
                            max_frame_bytes: MAX_FRAME_BYTES,
                        },
                    }),
                    Context::Start(identity),
                ))
            }
            method::STATUS | method::MANIFEST => {
                let req: HandleRequest = parse(params)?;
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &req.identity)?;
                if method == method::STATUS {
                    return Ok(Route::Local(value(&s.status)));
                }
                if !terminal(s.status.state) {
                    return Err(state_error());
                }
                let missing = if s.status.persisted_seq > 0 {
                    Error("RECORD_INTERRUPTED", "durable source frames exist but recording provenance could not be recovered")
                } else {
                    Error(
                        "RECORD_NO_FRAMES",
                        "recording has no resolved source manifest",
                    )
                };
                Ok(Route::Local(s.manifest.clone().ok_or(missing)?))
            }
            method::READ => self.read(parse(params)?).map(|v| Route::Local(value(v))),
            method::RELEASE => self.release(parse(params)?).map(|v| Route::Local(value(v))),
            method::STOP => {
                let req: StopRequest = parse(params)?;
                if !valid_id(&req.operation_id) {
                    return Err(invalid());
                }
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &req.identity)?;
                if s.stop_operations.contains(&req.operation_id) {
                    return Ok(Route::Local(value(&s.status)));
                }
                if terminal(s.status.state) {
                    if s.status.state != State::Failed
                        || !s
                            .status
                            .end
                            .as_ref()
                            .is_some_and(|end| end.reason == EndReason::ControlError)
                    {
                        return Ok(Route::Local(value(&s.status)));
                    }
                    if s.stop_operations.len() >= MAX_EVENTS {
                        return Err(limit());
                    }
                    s.stop_operations.insert(req.operation_id.clone());
                    // Explicit bounded backend cleanup only: never reopen/rewrite
                    // this immutable failed recording or claim shutdown confirmation.
                    return Ok(Route::Forward(
                        value(&req),
                        Context::ReconcileStop(req.identity),
                    ));
                }
                if s.stop_operations.len() >= MAX_EVENTS {
                    return Err(limit());
                }
                s.stop_operations.insert(req.operation_id.clone());
                if s.status.state == State::Stopping {
                    return Ok(Route::Local(value(&s.status)));
                }
                let starting = s.status.state == State::Starting;
                s.explicit_stop = true;
                // A write already admitted at stop consumes the only possible
                // earlier operation. Otherwise at most one in-flight sample may drain.
                s.sample_after_stop = s.frame_pending;
                s.status.state = State::Stopping;
                s.control_since = Instant::now();
                // Do not race a stop ahead of the initial start on the native port.
                // The start completion reconciles a stopping slot by this identity.
                if starting {
                    return Ok(Route::Local(value(&s.status)));
                }
                Ok(Route::Forward(value(&req), Context::Stop(req.identity)))
            }
            method::PHASE | method::MARK => {
                let (identity, op, kind) = if method == method::PHASE {
                    let p: PhaseRequest = parse(params.clone())?;
                    (
                        p.identity,
                        p.operation_id,
                        EventKind::Phase { text: p.text },
                    )
                } else {
                    let p: MarkRequest = parse(params.clone())?;
                    (
                        p.identity,
                        p.operation_id,
                        EventKind::Mark {
                            text: p.text,
                            duration_ms: p.duration_ms,
                        },
                    )
                };
                if !valid_id(&op) || !kind_ok(&kind) {
                    return Err(invalid());
                }
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &identity)?;
                if let Some(e) = s.admitted_events.iter().find(|e| e.operation_id == op) {
                    if e.kind != kind {
                        return Err(Error(
                            "RECORD_OPERATION_CONFLICT",
                            "event operation conflicts",
                        ));
                    }
                    if s.events.iter().any(|v| v == e) {
                        return Ok(Route::Local(value(e)));
                    }
                }
                if s.status.state != State::Recording {
                    return Err(state_error());
                }
                if s.event_controls.len() >= MAX_EVENTS && !s.event_controls.contains_key(&op) {
                    return Err(limit());
                }
                if s.event_controls.get(&op).is_some_and(|old| old != &kind) {
                    return Err(Error(
                        "RECORD_OPERATION_CONFLICT",
                        "event operation conflicts",
                    ));
                }
                s.event_controls.insert(op.clone(), kind.clone());
                Ok(Route::Forward(params, Context::Event(identity, op, kind)))
            }
            _ => Err(invalid()),
        }
    }
    /// Reserve the failure barrier before replaying the EXACT augmented start once.
    /// The extension's original idempotency cache is the only source of Started facts.
    pub fn begin_start_recovery(&self, identity: &Identity) -> bool {
        let mut i = self.inner.lock().unwrap();
        let Ok(s) = self.lookup(&mut i, identity) else {
            return false;
        };
        if terminal(s.status.state)
            || s.sealing
            || s.started.is_some()
            || s.start_recovery_attempted
            || s.start_recovery_until
                .is_some_and(|until| Instant::now() >= until)
            || s.failure
                .is_some_and(|reason| reason != EndReason::ControlError)
            || s.admitted_seq == 0
        {
            return false;
        }
        s.start_recovery_attempted = true;
        s.start_recovery_until
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(CREDIT_TIMEOUT_MS));
        s.failure = Some(EndReason::ControlError);
        s.control_error = true;
        s.status.state = State::Stopping;
        s.control_since = Instant::now();
        s.needs_stop = false; // the dispatch owner sends the bounded identity-pinned stop
        true
    }
    pub fn complete(&self, context: Context, result: Result<Value>) -> Result<Value> {
        let recovering = matches!(&context, Context::RecoverStart(_));
        match context {
            Context::Capabilities => {
                let raw = result?;
                check_live_version(&raw)?;
                let extension: ProducerCapability = parse(raw)?;
                Ok(value(Capabilities {
                    host: ProducerCapability {
                        protocol_version: PROTOCOL_VERSION,
                        backend: Backend::CdpCaptureScreenshot,
                    },
                    extension,
                    legacy_v1_read_only: true,
                }))
            }
            Context::Start(identity) | Context::RecoverStart(identity) => {
                let started: Started = match result.and_then(|v| {
                    check_live_version(&v)?;
                    parse(v)
                }) {
                    Ok(v) => v,
                    Err(e) => {
                        if recovering {
                            let mut i = self.inner.lock().unwrap();
                            if let Ok(s) = self.lookup(&mut i, &identity) {
                                s.start_recovery_until = None;
                            }
                        }
                        let reason = match e.0 {
                            "TIMEOUT" | "RECORD_INTERRUPTED" => EndReason::ControlError,
                            "EXTENSION_DISCONNECTED" => EndReason::NativeDisconnected,
                            _ => EndReason::StartFailed,
                        };
                        self.fail(&identity, reason);
                        return Err(e);
                    }
                };
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &identity)?;
                if let Some(original) = &s.started {
                    // Cached Started is immutable, including uncertainty and target.
                    if original != &started {
                        return Err(invalid());
                    }
                    return Ok(value(&s.status));
                }
                if started.identity != identity
                    || started.tab_id < 0
                    || started.tab_id as u64 > MAX_SAFE_INTEGER
                    || s.request.tab_id.is_some_and(|t| t != started.tab_id)
                    || started.protocol_version != PROTOCOL_VERSION
                    || started.backend != Backend::CdpCaptureScreenshot
                    || started.clock.source != ClockSource::ExtensionPerformance
                    || started.clock.origin != ClockOrigin::BeforeFirstRecordedScreenshotRequest
                    || started
                        .clock
                        .uncertainty_ms
                        .is_some_and(|u| !u.is_finite() || u < 0.0 || u > MAX_SAFE_INTEGER as f64)
                    || !rect_ok(&started.resolved_region_css)
                    || matches!(&s.request.config.region, Region::Rect { rect } if rect != &started.resolved_region_css)
                    || s.admitted_frames
                        .first()
                        .is_some_and(|f| f.geometry.crop_css != started.resolved_region_css)
                {
                    if recovering {
                        s.start_recovery_until = None;
                    }
                    drop(i);
                    self.fail(&identity, EndReason::StartFailed);
                    return Err(invalid());
                }
                if !terminal(s.status.state) {
                    s.status.tab_id = Some(started.tab_id);
                    s.started = Some(started);
                    s.capture_since = Some(Instant::now());
                    if s.status.state == State::Starting {
                        s.status.state = State::Recording;
                    }
                }
                Ok(value(&s.status))
            }
            Context::Stop(identity) => {
                match result.and_then(parse::<EndAccepted>) {
                    Ok(e)
                        if e.identity == identity
                            && matches!(
                                e.state,
                                State::Stopping | State::Sealed | State::Failed
                            ) => {}
                    Err(e) if e.0 == "EXTENSION_DISCONNECTED" => {
                        self.fail(&identity, EndReason::NativeDisconnected);
                    }
                    _ => {
                        let mut i = self.inner.lock().unwrap();
                        let s = self.lookup(&mut i, &identity)?;
                        if !terminal(s.status.state) {
                            // Control failure is not an end barrier. Drain admitted data
                            // and allow a trustworthy source end before bounded fallback.
                            s.control_error = true;
                            s.needs_stop = true;
                            // Preserve the original absolute stop budget.
                            if s.status.state != State::Stopping {
                                s.control_since = Instant::now();
                            }
                            s.status.state = State::Stopping;
                        }
                    }
                }
                let mut i = self.inner.lock().unwrap();
                Ok(value(&self.lookup(&mut i, &identity)?.status))
            }
            Context::ReconcileStop(identity) => {
                let response: EndAccepted = result.and_then(parse)?;
                if response.identity != identity
                    || !matches!(
                        response.state,
                        State::Stopping | State::Sealed | State::Failed
                    )
                {
                    return Err(invalid());
                }
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &identity)?;
                // The extension acknowledgement precedes asynchronous quarantine
                // cleanup. Preserve the original end/reason/manifest regardless.
                Ok(value(&s.status))
            }
            Context::Event(identity, operation_id, kind) => {
                let e: Event = result.and_then(parse)?;
                if e.operation_id != operation_id || e.kind != kind {
                    return Err(Error(
                        "RECORD_OPERATION_CONFLICT",
                        "extension returned a different timeline operation",
                    ));
                }
                let mut i = self.inner.lock().unwrap();
                let s = self.lookup(&mut i, &identity)?;
                if !s.events.contains(&e) {
                    return Err(Error(
                        "RECORD_SEQUENCE",
                        "extension returned an event not persisted by host",
                    ));
                }
                Ok(value(e))
            }
        }
    }
    /// Called on stdin; no disk work and never waits for the writer.
    pub fn source(&self, method: &str, params: Value, reply: Reply) {
        let identity = params
            .get("identity")
            .cloned()
            .and_then(|v| parse::<Identity>(v).ok());
        let mut reply = Some(reply);
        let result = match method {
            method::FRAME => {
                parse::<Frame>(params).and_then(|f| self.admit_frame(f, reply.take().unwrap()))
            }
            method::EVENT => parse::<EventRequest>(params)
                .and_then(|e| self.admit_event(e, reply.take().unwrap())),
            method::ENDED => {
                parse::<Ended>(params).and_then(|e| self.admit_end(e, reply.take().unwrap()))
            }
            _ => Err(invalid()),
        };
        if let Err(e) = result {
            if let Some(reply) = reply {
                reply(Err(e));
            }
            // Wrong-direction calls cannot poison a valid recording.
            if matches!(method, method::FRAME | method::EVENT | method::ENDED) {
                if let Some(id) = identity {
                    self.fail(&id, EndReason::InvalidFrame);
                }
            }
        }
    }
    fn admit_frame(&self, f: Frame, reply: Reply) -> Result<()> {
        let mut i = self.inner.lock().unwrap();
        let mut reject = None;
        {
            let s = match self.lookup(&mut i, &f.identity) {
                Ok(s) => s,
                Err(e) => {
                    reply(Err(e.clone()));
                    return Err(e);
                }
            };
            if terminal(s.status.state) || s.pending_end.is_some() || s.failure.is_some() {
                reject = Some(state_error());
            } else if s.frame_pending || f.seq != s.admitted_seq + 1 {
                reject = Some(Error(
                    "RECORD_SEQUENCE",
                    "frame violates one-frame credit or contiguous sequence",
                ));
            } else if f.jpeg_base64.len() > (MAX_FRAME_BYTES as usize).div_ceil(3) * 4
                || f.seq > MAX_FRAMES as u64
            {
                reject = Some(limit());
            } else if f.geometry.validate(f.width, f.height).is_err() {
                reject = Some(Error("RECORD_GEOMETRY_CHANGED", "invalid capture mapping"));
            } else if f.validate(s.request.config.max_duration_ms as f64).is_err()
                || (f.observation.purpose == Purpose::Final && !s.explicit_stop)
                || (f.observation.purpose == Purpose::Sample
                    && s.explicit_stop
                    && s.sample_after_stop)
            {
                reject = Some(invalid());
            } else if matches!(s.request.config.region, Region::Viewport)
                && f.geometry.crop_css != f.geometry.viewport_css
            {
                reject = Some(Error(
                    "RECORD_GEOMETRY_CHANGED",
                    "viewport crop does not match frozen viewport",
                ));
            } else {
                let mut frames = s.admitted_frames.clone();
                frames.push(frame_entry(&f, s.status.spool_bytes));
                let end = lower_end(&frames, &s.admitted_events, EndReason::ControlError);
                if let Err(reason) =
                    prefix_manifest(s, frames, s.admitted_events.clone(), end).validate()
                {
                    reject = Some(if reason == "session mapping changed" {
                        Error("RECORD_GEOMETRY_CHANGED", "capture mapping changed")
                    } else {
                        invalid()
                    });
                }
            }
            if reject.is_none() {
                let reserved = encoded_bytes(&f.jpeg_base64);
                if s.status.spool_bytes + reserved > MAX_SPOOL_BYTES {
                    reject = Some(limit());
                }
            }
        }
        let reserved = encoded_bytes(&f.jpeg_base64);
        if reject.is_none() && i.reserved_bytes + reserved > MAX_TOTAL_SPOOL_BYTES {
            reject = Some(limit());
        }
        if let Some(e) = reject {
            let identity = f.identity.clone();
            drop(i);
            self.fail(
                &identity,
                match e.0 {
                    "RECORD_LIMIT" => EndReason::StorageLimit,
                    "RECORD_GEOMETRY_CHANGED" => EndReason::GeometryChanged,
                    _ => EndReason::InvalidFrame,
                },
            );
            reply(Err(e.clone()));
            return Err(e);
        }
        i.reserved_bytes += reserved;
        let s = i.sessions.get_mut(&f.identity.record_id).unwrap();
        s.reserved_bytes += reserved;
        s.frame_pending = true;
        s.frame_since = Some(Instant::now());
        s.admitted_seq = f.seq;
        if s.explicit_stop && f.observation.purpose == Purpose::Sample {
            s.sample_after_stop = true;
        }
        s.admitted_frames
            .push(frame_entry(&f, s.status.spool_bytes));
        let job = Job::Frame(f.identity.record_id.clone(), Box::new(f), reply);
        drop(i);
        match self.writer.try_send(job) {
            Ok(()) => Ok(()),
            Err(e) => {
                if let Job::Frame(id, _, cb) = match e {
                    mpsc::TrySendError::Full(j) | mpsc::TrySendError::Disconnected(j) => j,
                } {
                    self.fail_record(&id, EndReason::StorageError);
                    cb(Err(storage()));
                }
                Err(storage())
            }
        }
    }
    fn admit_event(&self, req: EventRequest, reply: Reply) -> Result<()> {
        let mut reply = Some(reply);
        let result = (|| {
            let mut i = self.inner.lock().unwrap();
            let s = self.lookup(&mut i, &req.identity)?;
            let e = &req.event;
            if let Some(old) = s
                .admitted_events
                .iter()
                .find(|v| v.operation_id == e.operation_id || v.event_index == e.event_index)
            {
                if old != e {
                    return Err(Error("RECORD_OPERATION_CONFLICT", "event retry conflicts"));
                }
                if s.events.contains(e) {
                    return Ok(Some(value(e)));
                }
            } else {
                if terminal(s.status.state) || s.pending_end.is_some() || s.failure.is_some() {
                    return Err(state_error());
                }
                if s.admitted_events.len() >= MAX_EVENTS {
                    return Err(limit());
                }
                if e.event_index != s.admitted_events.len() as u64 + 1 {
                    return Err(Error("RECORD_SEQUENCE", "timeline event sequence gap"));
                }
                if validate_event(e, s.request.config.max_duration_ms as f64).is_err()
                    || s.admitted_events.last().is_some_and(|p| p.t_ms > e.t_ms)
                    || s.admitted_frames.last().is_some_and(|f| f.observation.purpose == Purpose::Final)
                    // The control reservation and stop closure share this mutex.
                    // A tied clock tick is never permission for a new operation.
                    || s.event_controls.get(&e.operation_id) != Some(&e.kind)
                {
                    return Err(invalid());
                }
                s.admitted_events.push(e.clone());
            }
            // Enqueue under the admission lock to preserve event_index order across callers.
            match self.writer.try_send(Job::Event(
                req.identity.record_id.clone(),
                req.event.clone(),
                reply.take().unwrap(),
            )) {
                Ok(()) => Ok(None),
                Err(e) => {
                    if let Job::Event(_, _, cb) = match e {
                        mpsc::TrySendError::Full(j) | mpsc::TrySendError::Disconnected(j) => j,
                    } {
                        reply = Some(cb);
                    }
                    Err(limit())
                }
            }
        })();
        match result {
            Ok(Some(v)) => {
                reply.take().unwrap()(Ok(v));
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(e) => {
                reply.take().unwrap()(Err(e.clone()));
                Err(e)
            }
        }
    }
    fn admit_end(&self, req: Ended, reply: Reply) -> Result<()> {
        let mut reply = Some(reply);
        let result = (|| {
            let mut i = self.inner.lock().unwrap();
            let s = self.lookup(&mut i, &req.identity)?;
            if let Some(old) = &s.pending_end {
                if old != &req.end {
                    return Err(Error("RECORD_SEQUENCE", "conflicting end barrier"));
                }
                if terminal(s.status.state) {
                    return Ok(Some(value(EndAccepted {
                        identity: req.identity.clone(),
                        state: s.status.state,
                    })));
                }
            } else {
                if terminal(s.status.state)
                    || (s.failure.is_some() && s.start_recovery_until.is_none())
                {
                    return Err(state_error());
                }
                let e = &req.end;
                if e.final_seq != s.admitted_seq
                    || !e.duration_observed
                    || e.cutoff.provenance == CutoffProvenance::DurableLowerBound
                    || (e.stop_requested_ms.is_some() && !s.explicit_stop)
                    || prefix_manifest(
                        s,
                        s.admitted_frames.clone(),
                        s.admitted_events.clone(),
                        e.clone(),
                    )
                    .validate()
                    .is_err()
                {
                    return Err(Error(
                        "RECORD_SEQUENCE",
                        "end barrier does not match admitted source",
                    ));
                }
                s.pending_end = Some(e.clone());
                // Source-first Ended must not renew startup while awaiting Started;
                // an existing explicit stop likewise retains its absolute budget.
                if s.status.state == State::Recording {
                    s.control_since = Instant::now();
                }
                s.status.state = State::Stopping;
            }
            if s.end_waiters.len() >= 16 {
                return Err(limit());
            }
            s.end_waiters.push(reply.take().unwrap());
            Ok(None)
        })();
        match result {
            Ok(Some(v)) => {
                reply.take().unwrap()(Ok(v));
                Ok(())
            }
            // End/control storage lives separately from the bounded data queue.
            // The writer observes this reserved slot even if that queue is full.
            Ok(None) => Ok(()),
            Err(e) => {
                reply.take().unwrap()(Err(e.clone()));
                Err(e)
            }
        }
    }
    fn read(&self, req: ReadRequest) -> Result<Chunk> {
        if req.offset > MAX_SAFE_INTEGER || req.length == 0 || req.length > MAX_CHUNK_BYTES {
            return Err(invalid());
        }
        let (path, io) = {
            let mut i = self.inner.lock().unwrap();
            let s = self.lookup(&mut i, &req.identity)?;
            if !terminal(s.status.state) {
                return Err(state_error());
            }
            (s.path.clone(), s.io.clone())
        };
        let _guard = io.lock().unwrap();
        let total = {
            let mut i = self.inner.lock().unwrap();
            self.lookup(&mut i, &req.identity)?.status.spool_bytes
        };
        if req.offset > total {
            return Err(invalid());
        }
        let len = (total - req.offset).min(req.length as u64) as usize;
        let mut bytes = vec![0; len];
        let mut file = File::open(path.join("frames")).map_err(|_| storage())?;
        file.seek(SeekFrom::Start(req.offset))
            .map_err(|_| storage())?;
        file.read_exact(&mut bytes).map_err(|_| storage())?;
        Ok(Chunk {
            identity: req.identity,
            offset: req.offset,
            length: len as u32,
            total_bytes: total,
            sha256: digest(&bytes),
            data_base64: STANDARD.encode(&bytes),
            eof: req.offset + len as u64 == total,
        })
    }
    fn release(&self, req: HandleRequest) -> Result<Released> {
        self.check_identity(&req.identity)?;
        let (path, io) = {
            let mut i = self.inner.lock().unwrap();
            if i.released.contains(&req.identity.record_id) {
                return Ok(Released {
                    identity: req.identity,
                    released: true,
                });
            }
            let s = self.lookup(&mut i, &req.identity)?;
            if !terminal(s.status.state) {
                return Err(state_error());
            }
            (s.path.clone(), s.io.clone())
        };
        let _guard = io.lock().unwrap();
        {
            let mut i = self.inner.lock().unwrap();
            if i.released.contains(&req.identity.record_id) {
                return Ok(Released {
                    identity: req.identity,
                    released: true,
                });
            }
            self.lookup(&mut i, &req.identity)?.releasing = true;
        }
        let removed = fs::remove_dir_all(path).or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(e)
            }
        });
        let mut i = self.inner.lock().unwrap();
        if removed.is_err() {
            if let Some(s) = i.sessions.get_mut(&req.identity.record_id) {
                s.releasing = false;
            }
            return Err(storage());
        }
        let s = i
            .sessions
            .remove(&req.identity.record_id)
            .ok_or_else(state_error)?;
        i.reserved_bytes = i.reserved_bytes.saturating_sub(s.reserved_bytes);
        i.released.insert(req.identity.record_id.clone());
        Ok(Released {
            identity: req.identity,
            released: true,
        })
    }
    pub fn fail(&self, identity: &Identity, reason: EndReason) {
        if self.check_identity(identity).is_ok() {
            self.fail_record(&identity.record_id, reason);
        }
    }
    fn fail_record(&self, id: &str, reason: EndReason) {
        let mut i = self.inner.lock().unwrap();
        if let Some(s) = i.sessions.get_mut(id) {
            if terminal(s.status.state) || s.failure.is_some() || s.sealing {
                return;
            }
            // The native start watchdog can beat its waiting CLI thread. Hold the
            // immutable barrier for that thread's single cached-Started recovery.
            if reason == EndReason::ControlError
                && s.started.is_none()
                && s.admitted_seq > 0
                && !s.start_recovery_attempted
            {
                s.start_recovery_until.get_or_insert_with(|| {
                    Instant::now() + Duration::from_millis(CREDIT_TIMEOUT_MS)
                });
            }
            s.failure = Some(reason);
            s.needs_stop = true;
            s.status.state = State::Stopping;
            s.control_since = Instant::now();
        }
    }
    /// Monotonic watchdog. Returned identities must receive an identity-pinned stop.
    pub fn maintenance(&self) -> Vec<Identity> {
        let mut stop = vec![];
        let mut failures = vec![];
        let mut expired = vec![];
        {
            let mut i = self.inner.lock().unwrap();
            for s in i.sessions.values_mut() {
                if terminal(s.status.state) {
                    if s.retained
                        .is_some_and(|t| t.elapsed() >= Duration::from_millis(RETENTION_MS))
                    {
                        expired.push(s.status.identity.clone());
                    }
                } else if s.failure.is_some() {
                    // Already failed and reconciled once; a stalled writer must not
                    // turn the control watchdog into an unbounded stop retry loop.
                    continue;
                } else if (s.status.state == State::Starting
                    && s.created.elapsed() >= Duration::from_millis(CREDIT_TIMEOUT_MS))
                    || (s.status.state == State::Stopping
                        && s.control_since.elapsed() >= Duration::from_millis(CREDIT_TIMEOUT_MS))
                {
                    failures.push((s.status.identity.clone(), EndReason::ControlError));
                } else if s
                    .frame_since
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(CREDIT_TIMEOUT_MS))
                {
                    failures.push((s.status.identity.clone(), EndReason::CreditTimeout));
                } else if s.status.state == State::Recording
                    && s.capture_since.is_some_and(|t| {
                        t.elapsed() >= Duration::from_millis(s.request.config.max_duration_ms)
                    })
                {
                    s.status.state = State::Stopping;
                    s.control_since = Instant::now();
                    stop.push(s.status.identity.clone());
                }
            }
        }
        for (id, reason) in failures {
            self.fail(&id, reason);
            stop.push(id);
        }
        {
            let mut i = self.inner.lock().unwrap();
            for s in i.sessions.values_mut() {
                if s.needs_stop {
                    if !stop.contains(&s.status.identity) {
                        stop.push(s.status.identity.clone());
                    }
                    s.needs_stop = false;
                }
            }
        }
        for identity in expired {
            let _ = self.release(HandleRequest { identity });
        }
        stop
    }
    /// Preserve native-host EOF lifetime: bounded best effort, never an orphan daemon.
    /// All handles may become unavailable when the caller subsequently exits.
    pub fn shutdown(&self, budget: Duration) {
        self.disconnect();
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if self
                .inner
                .lock()
                .unwrap()
                .sessions
                .values()
                .all(|s| terminal(s.status.state))
            {
                break;
            }
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    pub fn disconnect(&self) {
        let ids: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter(|s| !terminal(s.status.state))
            .map(|s| s.status.identity.clone())
            .collect();
        for id in ids {
            self.fail(&id, EndReason::NativeDisconnected);
        }
    }
}
fn kind_ok(kind: &EventKind) -> bool {
    match kind {
        EventKind::Phase { text } => text_ok(text),
        EventKind::Mark { text, duration_ms } => {
            !text.is_empty() && text_ok(text) && (1..=10000).contains(duration_ms)
        }
    }
}

fn writer_loop(manager: Weak<Manager>, rx: mpsc::Receiver<Job>) {
    loop {
        let job = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let Some(m) = manager.upgrade() else { break };
                let ids: Vec<_> = m.inner.lock().unwrap().sessions.keys().cloned().collect();
                for id in ids {
                    seal(&m, &id);
                }
                continue;
            }
        };
        let Some(m) = manager.upgrade() else { break };
        #[cfg(test)]
        if let Some(b) = m.pause.lock().unwrap().take() {
            b.wait();
            b.wait();
        }
        match job {
            Job::Frame(id, f, reply) => {
                let result = write_frame(&m, &id, &f);
                if result.is_err() {
                    let mut i = m.inner.lock().unwrap();
                    // Retain the reservation on failure: a failed write may have left
                    // unindexed bytes. Release/expiry returns the full reservation.
                    if let Some(s) = i.sessions.get_mut(&id) {
                        s.frame_pending = false;
                        s.frame_since = None;
                    }
                    drop(i);
                    m.fail_record(
                        &id,
                        if result.as_ref().err().is_some_and(|e| e.0 == "RECORD_LIMIT") {
                            EndReason::StorageLimit
                        } else {
                            EndReason::InvalidFrame
                        },
                    );
                }
                reply(result);
                seal(&m, &id);
            }
            Job::Event(id, event, reply) => {
                let result = write_event(&m, &id, &event);
                if result.is_err() {
                    m.fail_record(&id, EndReason::StorageError);
                }
                reply(result);
                seal(&m, &id);
            }
        }
    }
}
fn write_frame(m: &Manager, id: &str, f: &Frame) -> Result<Value> {
    let bytes = STANDARD.decode(&f.jpeg_base64).map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_FRAME_BYTES {
        return Err(limit());
    }
    if jpeg_size(&bytes) != Some((f.width, f.height)) {
        return Err(invalid());
    }
    let sha256 = digest(&bytes);
    let (path, offset, mut hasher) = {
        let i = m.inner.lock().unwrap();
        let s = i.sessions.get(id).ok_or_else(state_error)?;
        if s.failure.is_some() {
            return Err(state_error());
        }
        (
            s.path.join("frames"),
            s.status.spool_bytes,
            s.hasher.clone(),
        )
    };
    hasher.update(&bytes);
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).open(&path)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&bytes)?;
        file.sync_data()
    })();
    if write_result.is_err() {
        m.fail_record(id, EndReason::StorageError);
        return Err(storage());
    }
    let mut i = m.inner.lock().unwrap();
    i.reserved_bytes = i
        .reserved_bytes
        .saturating_sub(encoded_bytes(&f.jpeg_base64) - bytes.len() as u64);
    let s = i.sessions.get_mut(id).ok_or_else(state_error)?;
    s.reserved_bytes -= encoded_bytes(&f.jpeg_base64) - bytes.len() as u64;
    s.frames.push(FrameEntry {
        seq: f.seq,
        t_ms: f.t_ms,
        observation: f.observation.clone(),
        width: f.width,
        height: f.height,
        geometry: f.geometry.clone(),
        offset,
        length: bytes.len() as u64,
        sha256,
    });
    s.hasher = hasher;
    s.status.spool_bytes += bytes.len() as u64;
    s.status.persisted_seq = f.seq;
    s.frame_pending = false;
    s.frame_since = None;
    Ok(value(FrameAccepted {
        accepted_seq: f.seq,
        credit: Credit {
            identity: f.identity.clone(),
            next_seq: f.seq + 1,
            max_frame_bytes: MAX_FRAME_BYTES,
        },
    }))
}
fn write_event(m: &Manager, id: &str, event: &Event) -> Result<Value> {
    let path = {
        let i = m.inner.lock().unwrap();
        let s = i.sessions.get(id).ok_or_else(state_error)?;
        if s.events.contains(event) {
            return Ok(value(event));
        }
        if s.failure.is_some() {
            return Err(state_error());
        }
        if event.event_index != s.events.len() as u64 + 1 {
            return Err(Error(
                "RECORD_SEQUENCE",
                "timeline persistence sequence gap",
            ));
        }
        s.path.join("events")
    };
    let mut bytes = serde_json::to_vec(event).map_err(|_| invalid())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|_| storage())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_data())
        .map_err(|_| storage())?;
    m.inner
        .lock()
        .unwrap()
        .sessions
        .get_mut(id)
        .ok_or_else(state_error)?
        .events
        .push(event.clone());
    Ok(value(event))
}
fn frame_entry(f: &Frame, offset: u64) -> FrameEntry {
    FrameEntry {
        seq: f.seq,
        t_ms: f.t_ms,
        observation: f.observation.clone(),
        width: f.width,
        height: f.height,
        geometry: f.geometry.clone(),
        offset,
        length: encoded_bytes(&f.jpeg_base64),
        sha256: digest(b""),
    }
}
fn lower_end(frames: &[FrameEntry], events: &[Event], reason: EndReason) -> End {
    let duration_ms = frames
        .last()
        .map_or(0.0, |f| f.observation.geometry_validated_ms)
        .max(events.last().map_or(0.0, |e| e.t_ms));
    End {
        final_seq: frames.len() as u64,
        duration_ms,
        duration_observed: false,
        reason,
        cutoff: Cutoff {
            t_ms: duration_ms,
            provenance: CutoffProvenance::DurableLowerBound,
        },
        stop_requested_ms: None,
        counters: None,
        final_observation: frames
            .last()
            .filter(|f| f.observation.purpose == Purpose::Final)
            .map_or(FinalObservation::NotRequested, |f| {
                FinalObservation::PersistedWithoutEnd {
                    request_id: f.observation.request_id.clone(),
                    seq: f.seq,
                }
            }),
    }
}
/// Shared contract validation over the bounded admitted prefix. Temporary metadata
/// defaults are ONLY for validation before Started, never persisted as provenance.
fn prefix_manifest(s: &Session, frames: Vec<FrameEntry>, events: Vec<Event>, end: End) -> Manifest {
    Manifest {
        protocol_version: PROTOCOL_VERSION,
        backend: Backend::CdpCaptureScreenshot,
        identity: s.status.identity.clone(),
        operation_id: s.request.operation_id.clone(),
        instance_id: s.status.instance_id.clone(),
        tab_id: s.started.as_ref().map_or(0, |v| v.tab_id),
        state: if matches!(end.reason, EndReason::Stopped | EndReason::Deadline) {
            State::Sealed
        } else {
            State::Failed
        },
        config: s.request.config.clone(),
        resolved_region_css: s
            .started
            .as_ref()
            .map(|v| v.resolved_region_css.clone())
            .or_else(|| frames.first().map(|f| f.geometry.crop_css.clone()))
            .unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }),
        clock: s
            .started
            .as_ref()
            .map(|v| v.clock.clone())
            .unwrap_or(Clock {
                source: ClockSource::ExtensionPerformance,
                origin: ClockOrigin::BeforeFirstRecordedScreenshotRequest,
                uncertainty_ms: None,
            }),
        spool_bytes: frames.iter().map(|f| f.length).sum(),
        spool_sha256: digest(b""),
        frames,
        events,
        end,
    }
}
fn seal(m: &Manager, id: &str) {
    let snapshot = {
        let mut i = m.inner.lock().unwrap();
        let Some(s) = i.sessions.get_mut(id) else {
            return;
        };
        if terminal(s.status.state) || (s.failure.is_none() && s.pending_end.is_none()) {
            return;
        }
        if s.start_recovery_until
            .is_some_and(|until| Instant::now() < until)
            && (s.started.is_none()
                || s.pending_end.is_none()
                || s.frame_pending
                || s.events.len() < s.admitted_events.len())
        {
            return;
        }
        if s.failure.is_none()
            && (s.frame_pending || s.events.len() < s.admitted_events.len() || s.started.is_none())
        {
            return;
        }
        let lower = s
            .frames
            .last()
            .map_or(0.0, |f| f.observation.geometry_validated_ms)
            .max(s.events.last().map_or(0.0, |e| e.t_ms));
        let mut end = if let Some(reason) = s.failure {
            if reason == EndReason::ControlError
                && s.pending_end.as_ref().is_some_and(|e| {
                    e.final_seq == s.status.persisted_seq && e.duration_ms >= lower
                })
            {
                // A trustworthy end already supplies the observed admission-close time.
                // Do not replace it with a shorter host-only lower bound or false detach.
                let mut end = s.pending_end.clone().unwrap();
                end.reason = EndReason::ControlError;
                end
            } else {
                lower_end(&s.frames, &s.events, reason)
            }
        } else {
            s.pending_end.clone().unwrap()
        };
        if s.control_error && matches!(end.reason, EndReason::Stopped | EndReason::Deadline) {
            end.reason = EndReason::ControlError;
        }
        if s.frames.is_empty() && matches!(end.reason, EndReason::Stopped | EndReason::Deadline) {
            end.reason = EndReason::NoFrames;
        }
        let state = if matches!(end.reason, EndReason::Stopped | EndReason::Deadline)
            && !s.frames.is_empty()
        {
            State::Sealed
        } else {
            State::Failed
        };
        s.sealing = true;
        let manifest = s.started.as_ref().map(|started| Manifest {
            protocol_version: PROTOCOL_VERSION,
            backend: Backend::CdpCaptureScreenshot,
            identity: s.status.identity.clone(),
            operation_id: s.request.operation_id.clone(),
            instance_id: s.status.instance_id.clone(),
            tab_id: started.tab_id,
            state,
            config: s.request.config.clone(),
            resolved_region_css: started.resolved_region_css.clone(),
            clock: started.clock.clone(),
            end: end.clone(),
            frames: s.frames.clone(),
            events: s.events.clone(),
            spool_bytes: s.status.spool_bytes,
            spool_sha256: format!("{:x}", s.hasher.clone().finalize()),
        });
        (s.path.clone(), state, end, manifest)
    };
    let (path, state, end, mut manifest) = snapshot;
    let saved = manifest
        .as_ref()
        .map(|manifest| {
            manifest.validate().map_err(|_| invalid())?;
            let bytes = serde_json::to_vec(manifest).map_err(|_| storage())?;
            if bytes.len() > MAX_MANIFEST_BYTES {
                return Err(limit());
            }
            let tmp = path.join("manifest-new");
            let mut f = private_file(&tmp).map_err(|_| storage())?;
            f.write_all(&bytes)
                .and_then(|_| f.sync_all())
                .map_err(|_| storage())?;
            fs::rename(&tmp, path.join("manifest")).map_err(|_| storage())?;
            #[cfg(unix)]
            File::open(&path)
                .and_then(|f| f.sync_all())
                .map_err(|_| storage())?;
            Ok(value(manifest))
        })
        .transpose();
    let mut i = m.inner.lock().unwrap();
    let Some(s) = i.sessions.get_mut(id) else {
        return;
    };
    let mut end = end;
    let state = match saved {
        Ok(v) => {
            s.manifest = v;
            state
        }
        Err(_) => {
            end = lower_end(&s.frames, &s.events, EndReason::StorageError);
            if let Some(ref mut failed) = manifest {
                failed.state = State::Failed;
                failed.end = end.clone();
                s.manifest = Some(value(failed));
            }
            State::Failed
        }
    };
    s.sealing = false;
    s.status.state = state;
    s.status.end = Some(end);
    s.retained = Some(Instant::now());
    let identity = s.status.identity.clone();
    let waiters = std::mem::take(&mut s.end_waiters);
    drop(i);
    for cb in waiters {
        cb(Ok(value(EndAccepted {
            identity: identity.clone(),
            state,
        })));
    }
}

/// Bounded JPEG header parser. Never decodes pixels or trusts dimensions from JSON.
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[..2] != [0xff, 0xd8] || b[b.len() - 2..] != [0xff, 0xd9] {
        return None;
    }
    let mut p = 2;
    let mut dimensions = None;
    while p + 3 < b.len() {
        if b[p] != 0xff {
            return None;
        }
        while p < b.len() && b[p] == 0xff {
            p += 1;
        }
        let marker = *b.get(p)?;
        p += 1;
        if marker == 0xd9 {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let len = u16::from_be_bytes([*b.get(p)?, *b.get(p + 1)?]) as usize;
        if len < 2 || p.checked_add(len)? > b.len() {
            return None;
        }
        if marker == 0xda {
            return if p + len < b.len() - 2 {
                dimensions
            } else {
                None
            };
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if len < 8 || b[p + 2] != 8 || b[p + 7] == 0 || len != 8 + 3 * b[p + 7] as usize {
                return None;
            }
            dimensions = Some((
                u16::from_be_bytes([b[p + 5], b[p + 6]]) as u32,
                u16::from_be_bytes([b[p + 3], b[p + 4]]) as u32,
            ));
        }
        p += len;
    }
    None
}
fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path)
}
fn private_file(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}
fn private_parent() -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    let suffix = unsafe { libc::geteuid() }.to_string();
    #[cfg(not(unix))]
    let suffix = digest(
        std::env::var("USERNAME")
            .unwrap_or_else(|_| "user".into())
            .as_bytes(),
    );
    let p = std::env::temp_dir().join(format!("ap-browser-recordings-{suffix}"));
    match private_dir(&p) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::symlink_metadata(&p)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(std::io::Error::other("unsafe recording directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
            return Err(std::io::Error::other("unsafe recording permissions"));
        }
    }
    Ok(p)
}
fn cleanup_stale(parent: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(entry.path())?;
        if !name.starts_with("host_")
            || !valid_id(&name)
            || !meta.is_dir()
            || meta.file_type().is_symlink()
        {
            continue;
        }
        // Process IDs only prove death; permission/query failures never authorize deletion.
        let dead = name
            .split('_')
            .nth(1)
            .and_then(|p| p.parse::<u32>().ok())
            .is_some_and(process_dead);
        #[cfg(unix)]
        let dead = match open_owned_file(&entry.path().join("owner")) {
            // A held epoch lock, not PID reuse, determines ownership on Unix.
            Ok(owner) => lock_file(&owner, true).is_ok(),
            Err(_) => dead,
        };
        if dead {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
#[cfg(unix)]
fn lock_file(file: &File, nonblocking: bool) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let flags = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
    if unsafe { libc::flock(file.as_raw_fd(), flags) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(unix)]
fn open_owned_file(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o600 {
        return Err(std::io::Error::other("unsafe recording ownership file"));
    }
    Ok(file)
}
#[cfg(unix)]
fn startup_lock(parent: &Path) -> std::io::Result<File> {
    let path = parent.join(".startup-lock");
    let file = match private_file(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => open_owned_file(&path)?,
        Err(e) => return Err(e),
    };
    lock_file(&file, false)?;
    Ok(file)
}
#[cfg(unix)]
fn process_dead(pid: u32) -> bool {
    pid > 0
        && pid <= i32::MAX as u32
        && unsafe { libc::kill(pid as i32, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
#[cfg(windows)]
fn process_dead(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return GetLastError() == 87;
        }
        let mut code = 259;
        let known = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        known && code != 259
    }
}
#[cfg(not(any(unix, windows)))]
fn process_dead(_: u32) -> bool {
    false
}

impl Drop for Manager {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
#[path = "recording/routing_tests.rs"]
mod routing_tests;
#[cfg(test)]
#[path = "recording/tests.rs"]
mod tests;
#[cfg(test)]
#[path = "recording/v2_tests.rs"]
mod v2_tests;
