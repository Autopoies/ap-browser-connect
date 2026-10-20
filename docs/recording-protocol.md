# Recording contract v1

Legacy offline-reader reference only. New native creation uses
[`recording-protocol-v2.md`](recording-protocol-v2.md), negotiated protocol2 /
`cdp_capture_screenshot`; no v1 producer fallback. Preserve original v1 source
bytes/hashes and schema1 semantics for valid offline inputs. The v1 structs and
fixtures remain unchanged; v2 lives in `ap_browser_core::recording::v2`.

Normative vocabulary for the extension, native host and calling CLI. Rust types:
`ap_browser_core::recording`; language-neutral examples: `tests/fixtures/recording/`.
This document specifies interfaces, **not a claim that recording is installed**.
No audio, full-page/desktop capture, element tracking, automatic action logging,
background-fps guarantee, or DOM/source-image watermarking is part of v1.

## 1. Transport, identities and routing

Use existing four-byte little-endian length-prefixed JSON on native messaging,
local IPC and the TCP bridge. The bridge remains one request / one response per
connection, with no streaming or unsolicited messages to the CLI. Generic framing
allows 64 MiB; Chrome host-to-extension messages must stay below 1 MiB. Large
reads go **directly from host to CLI**, never via Chrome. Numbers must be finite;
integer identities, sequences, offsets and counters must be in JavaScript's safe
integer range (0..9007199254740991). Validate before converting or allocating.
Finite fractional numbers must retain their original IEEE-754 binary64 value
through every JSON parse/serialize hop. All Rust peers inherit serde_json's
`float_roundtrip` feature from the workspace dependency. Decimal spelling may
canonicalize, but event echo/persistence must not change even one ULP; exact
identity/event equality remains strict, without tolerance or timestamp rounding.

`Identity = {host_epoch, record_id}` is nested as `identity`, never flattened.
All opaque IDs (including operation_id, run_id, export_id) are 1..128 ASCII
`[A-Za-z0-9_-]`, not paths. `host_epoch` is newly generated per host process;
`record_id` is host allocated and never reused in an epoch. A recording handle
must retain **instance_id plus identity** so later CLI commands select the same
browser, not whichever profile/tab is currently active. Persisting a handle does
not extend the retention period. A stale host_epoch is an error, not auto-resume.
Numeric host RPC IDs, extension `sw-*` IDs, opaque recording/operation IDs and
CDP `sessionId` are separate namespaces. Never treat a CDP sessionId as frame seq.

Existing envelopes are intentionally preserved (see `wire.json`):

* CLI request: `{"jsonrpc":"2.0","method":"record.status","params":{...}}`.
  CLI may omit id; host assigns a numeric id for each request.
* Host to extension: same request with numeric `id`. Extension success:
  `{"jsonrpc":"2.0","id":41,"result":{"ok":true,"data":VALUE}}`.
  Host-local successes use that same envelope. Optional existing `meta` is allowed.
  Failure: `{"jsonrpc":"2.0","id":41,"error":{"code":"...","message":"..."}}`.
  CLI's existing response normalization may unwrap `result` for JSON stdout.
* Extension to host: `{"id":"sw-1","method":"record.frame","params":VALUE}`
  (`jsonrpc` may be omitted). Reply **on the originating port**:
  `{"id":"sw-1","ok":true,"result":VALUE}` or
  `{"id":"sw-1","ok":false,"error":{"code":"...","message":"..."}}`.
  These are calls, not notifications; no new `record.credit` message exists.

Unknown fields may be ignored within v1; unknown enum variants or version != 1
are rejected. Missing required fields are invalid. Defaults are resolved by CLI
before sending StartRequest; hosts must not guess omitted configuration.

| RPC | Caller → receiver / routing | Params type | Success data/result |
|---|---|---|---|
| `record.start` | CLI → host; allocate then forward augmented call to extension | StartRequest / ExtensionStart | host: Status; extension: Started |
| `record.stop` | CLI → host → pinned extension, except already terminal | StopRequest | host: Status; extension: EndAccepted with state stopping or terminal |
| `record.phase` | CLI → host → pinned extension | PhaseRequest | Event, after host persistence |
| `record.mark` | CLI → host → pinned extension | MarkRequest | Event, after host persistence |
| `record.status` | CLI → host only | HandleRequest | Status |
| `record.manifest` | CLI → host only | HandleRequest | Manifest |
| `record.read` | CLI → host only | ReadRequest | Chunk |
| `record.release` | CLI → host only | HandleRequest | Released |
| `record.frame` | extension → host only | Frame | FrameAccepted |
| `record.event` | extension → host only | EventRequest | persisted Event |
| `record.ended` | extension → host only | Ended | EndAccepted |

No `record.export` or `record.watermark` host RPC: encoding and final storage
belong to the CLI machine. Host intercepts every record method before generic
forwarding/pending-response matching (particularly string sw-* IDs). Reject
wrong-direction methods and verify identity against the reserved/pinned session
before forwarding or accepting events. Extension handles recording start/stop/phase/mark
**before** generic active-tab resolution, debugger unlock/restore and favicon
logic. These calls never attach or operate on a different tab on retry.

Stable error codes: `RECORD_INVALID_PARAMS`, `RECORD_BUSY`,
`RECORD_OPERATION_CONFLICT`, `RECORD_NOT_FOUND`, `RECORD_STALE_HOST`,
`RECORD_INVALID_STATE`, `RECORD_SEQUENCE`, `RECORD_LIMIT`, `RECORD_NO_FRAMES`,
`RECORD_GEOMETRY_CHANGED`, `RECORD_STORAGE`, `RECORD_INTERRUPTED`.
Existing transport/disconnect/TIMEOUT errors remain valid. Errors expose no
host storage path or captured payload; malformed input must not kill the host.

## 2. Allocation, lifecycle and debugger lease

One active recording per browser instance; up to four retained terminal sessions.
States: `starting → recording → stopping → sealed|failed`; start failure may go
directly to failed. Only `sealed` with reason stopped/deadline is complete.
Every other reason is failed and requires explicit partial export. Terminal
zero-frame sessions cannot be exported. `Status.persisted_seq` counts durable
contiguous frames; `end` is absent until terminal, `tab_id` may be absent while
starting. Start/stop without export return a handle/status, **not a saved video**.

StartRequest contains operation_id, optional tab_id and fully resolved config.
Host binds operation_id to the parsed request contents, allocates the slot,
identity and initial credit *before* any extension call. Same operation_id +
identical parsed request returns the same handle/status, including while
starting or after a lost response. Changed contents give OPERATION_CONFLICT;
a different operation_id while active gives BUSY. Keep the mapping until release
or expiry; after either, retain a small in-memory tombstone for the rest of the
epoch so a late retry is NOT a fresh start (NOT_FOUND). Bound tombstones to 4096;
refuse new starts with LIMIT when full, rather than forget idempotency.

Host augments with identity and initial_credit (same identity, next_seq=1,
max_frame_bytes=4194304). Extension resolves the explicit tab, or resolves the
active tab **once**, acquires a recording-owned lease, then measures pre-capture
viewport stability before resolving the fixed region. Read-only observations have
a 40ms polling delay and must agree across a measured 200ms quiet window on CSS
viewport/visual viewport dimensions, device/page scale, visual offsets and scroll.
A change or ambiguous observation resets the quiet window; a fixed sleep alone
is not evidence of stability. All preparation, including lease readiness and CDP
start, shares the original 10-second total startup budget, never a renewed budget
per observation. A viewport that cannot stabilize fails with TIMEOUT/start_failed,
without capture or a recording clock origin, and releases only recorder resources.
Stop, tab loss or native disconnect cancels preparation promptly; late read/lease
completion cannot start or resume capture. Duplicate starts share the same work.

After stability, viewport/rect capture freezes that final observation. Element
capture reads the selector's visible bounds **once**, in a final viewport read,
without scrolling or tracking; if that read disagrees with the stable viewport,
startup fails rather than requerying the element or silently changing the crop.
The extension then sets clock origin immediately before Page.startScreencast.
Preparation time is not recording duration. This is a bounded startup observation,
not a promise against future resize: every post-start geometry invariant below
remains enforced, including the first frame. A successful
Started means CDP start succeeded, not that a first frame is guaranteed. Capture
may send frames before the numeric start response arrives; host's reserved slot
must accept them. Duplicate augmented start returns original Started; conflicting
identity/config is refused. Startup/control timeout is bounded to 10 seconds;
a timed-out start is reconciled/stopped by its identity, never reallocated.
If frames were admitted before that numeric response was lost, the host closes
admission and holds immutable failure sealing for one additional bounded recovery
window (at most 10 seconds). It may replay the **exact original augmented start**
once to retrieve the extension's cached Started facts, using a fresh numeric RPC
ID but unchanged identity, operation, config and initial_credit. This is cache
retrieval, never replacement capture, renewed credit, tab resolution or resumed
admission. Only the original validated tab/clock/region may populate provenance.
An identity-pinned stop and trustworthy end preserve observed duration when
available; otherwise the failed partial uses the durable observed lower bound.
Identical caller start retries still return the same handle/status, not another
native replay. If cached provenance truly cannot be recovered, retained durable
bytes remain readable but manifest reports RECORD_INTERRUPTED with missing-source-
provenance detail, not RECORD_NO_FRAMES when persisted_seq is nonzero.

The lease blocks 3-second scheduleRestore, unlockAllTabs/unlockOtherTabs,
releaseTab and generic debugger cleanup from detaching the leased tab. Ordinary
commands may still use the tab but cannot transfer the lease. Cleanup releases
only recorder-owned lease state, not another command's lock. Tab removal,
debugger detach, native-port loss, credit timeout or monotonic deadline terminates
that capture; no switch to another tab/profile and no resumption after restart.

Stop closes new frame/event admission immediately, cancels candidate scheduling,
requests Page.stopScreencast, and drains the current frame plus the last already-
admitted candidate under valid credit before sending record.ended. That one final
candidate may bypass the fps wait; it keeps its original receipt time. Frame/event
drain shares one absolute 10-second budget from admission closure, not a renewed
credit timeout per candidate/event. CDP stop and end/cleanup calls remain separately
bounded controls. Failure/disconnect clears the owned slot/timer; late callbacks
cannot resume it or affect a replacement. No new observation or screenshot is
manufactured at stop. The stop numeric response
is a prompt admission-closed acknowledgement (EndAccepted), **not** a seal or
final-frame guarantee. Host responds with its current Status; CLI polls boundedly
until terminal. Ordinary duplicate stop is idempotent even with another stop
operation_id; no additional CDP stop or replacement end. Deadline also follows
this path.

Exception for retained failed/control_error sessions: an explicit record.stop
with a **new** operation_id may forward one identity-pinned, 10-second-bounded
cleanup request to the extension's existing quarantine reconciliation. Retain
stop operation IDs (up to 1024/session, then LIMIT) so retries of the initial stop
or the same cleanup operation stay local and never repeat the attempt. No new
capture/admission or automatic terminal retry loop is created. The response keeps
the original failed Status/end; an acknowledgement is **not confirmation** that
asynchronous backend cleanup succeeded. Manifest, duration/reason and source
bytes stay immutable, even when cleanup fails or later permits a new capture.
Sealed sessions, other failure reasons and stale identities do not enable this
exception. The extension must preserve normal debugger ownership and only clear
quarantine after confirmed shutdown/reconciliation or actual detach. Release
only deletes host source data, so request any needed cleanup while the failed
handle is still retained.
A failed or timed-out CDP start/stop ends with reason `control_error`, never
normal sealed completion, even after an otherwise normal stop/deadline. It does
not imply `debugger_detached` without an actual detach or `storage_error` without
a storage failure. `RECORD_INTERRUPTED` may carry control error details. Preserve
valid acknowledged frames and truthful observed duration when available; export
requires explicit partial permission. A stop RPC response or timeout alone never
proves backend shutdown. If shutdown is unconfirmed, the extension quarantines
its cleanup/lease state, rejects replacement capture until reconciliation or an
actual detach, and ACKs late frames without admitting them. Cleanup and retries
remain bounded and may not detach another command's debugger ownership.

Neither stop nor deadline promises a new final image. On native disconnect the
extension discards its pending capture/lease; a new connection cannot resume it.
Host restart uses a new epoch and removes old private spools at startup.

Retention and partial reads apply only while the same host epoch and IPC endpoint
remain alive. Native-port loss preserves the host's existing unregister/exit
behavior: failure signaling/cleanup is bounded best effort, not a promise of a
durable or accessible partial after exit. Native disconnection, host exit or
restart may make **all** recordings in that epoch unavailable, including sealed
ones. The host does not become an orphan retention daemon or resume persisted
sessions. CLI-copied source/artifact files are unaffected; an abruptly lost host
must produce an honest disconnect/not-found/stale-host error, never synthesized
duration or a claimed export.

## 3. Frames, geometry, time and one-frame credit

CaptureConfig: max_duration_ms 1..60000 (fixed recording defaults 5000; start
maximum defaults 60000), capture_fps 1..30, jpeg_quality 1..100. Preset output fps
may also supply capture_fps unless explicitly overridden; JPEG quality is
separate from output CRF/palette quality. Source format is JPEG only.

Region is `{kind:"viewport"}`, `{kind:"rect",rect:{x,y,width,height}}`, or
`{kind:"element",selector:STRING}`. Rect uses viewport CSS coordinates, x/y >= 0,
width/height > 0, finite and fully inside the initial viewport. Element selector
is 1..1024 UTF-8 bytes; resolve the element's bounding box intersected with the
visible viewport **without scrolling**. Reject missing/empty bounds. Freeze the
resolved rectangle for the session; never follow/requery the element or expand
to full-page. Viewport also freezes its initial bounds.

Each transmitted frame gets a contiguous seq starting at 1. Assign only after
sampling and credit checks; dropped CDP events do not consume seq. ACK **every**
CDP screencastFrame, including discarded/invalid/oversize events, using its own
CDP sessionId. CDP ACK is not host acceptance and must not wait for disk I/O.
At most one transmitted frame RPC may be outstanding **plus one latest unsent
candidate**, superseding v1's earlier zero-pending/immediate-discard assumption.
This is a replaceable slot, not an accumulating queue. Before retaining any event,
validate its strict base64/JPEG/size and finite metadata even when busy. Retain only
its JPEG (decoded cap 4MiB, encoded cap 5,592,408 ASCII characters), measured image
dimensions, original receipt time and a fixed set of numeric CDP metadata fields;
never retain arbitrary event/metadata objects. The one processing/in-flight image
and one candidate each obey that cap; normalization has at most one additional
bounded incoming image/decoded temporary. No asynchronous validation task per
backpressured event may accumulate.

When sending is credit/processing-blocked or fps-gated, defer the latest valid
observation. A candidate has no sequence until it is actually sent. An eligibility
timer or successful credit completion flushes it without requiring another CDP
event. Timers exist only for an owned pending candidate: no screenshot polling,
extra repaint, constant sampling loop or invented producer observation. Regular
send eligibility uses elapsed time since the prior send; original source receipt
times need not be separated by that interval, and the bounded stop drain exception
above may send the last admitted candidate early. The 1800-frame/256MiB source caps
are checked before sending, including final drain; overflow fails storage_limit,
not silent success or an increased cap.

Deferral is **not** a drop. Only a deferred candidate actually superseded or
discarded before a send attempt increments sampled/backpressured once, using its
original deferral cause
(processing/credit backpressure takes priority at receipt). A delivered deferred
candidate increments neither. Failure cleanup discarding a slot or a promoted
candidate still awaiting validation follows the same rule. Invalid counts malformed observations and fails the recording even when a
send is busy; geometry changes still fail rather than hiding in the slot. A frame
is not counted in both sampled and backpressured. No CDP event means no observed
drop; do not invent a stall/drop count for silence. These counters are known slot
loss/invalid-input facts, not a claim about every producer paint or application
stall. The source receipt and raw CDP timestamp of a deferred image are never
changed to its later send/credit time.

Initial credit authorizes seq=1 only. Host validates identity/sequence, strict
standard padded base64 (no data URL), decoded length <=4 MiB, JPEG header/dimensions
matching width/height (each 1..16384, <=64 million pixels), finite timestamps and
geometry. Bound encoded input before decoding. Disk writes and fsync run off the
stdin reader in a bounded worker queue, not on the control-message path. Only
successful append **and sync_data** of the frame bytes, with its index accepted
in the session's serialized state, yields FrameAccepted `{accepted_seq,credit}`.
credit.next_seq MUST equal accepted_seq+1 and identify the same recording.
Duplicates, gaps or a second uncredited frame fail the session (SEQUENCE); do not
append twice. No automatic frame RPC retry; a lost reply terminates by the
10-second monotonic credit timeout. Slow storage must not block status/stop.

Frames record elapsed `t_ms = performance.now() - origin`, measured when the
extension receives the event (including a deferred candidate's original receipt,
not its later flush), in the same clock as phase/mark/end. t_ms >= 0 and
nondecreasing by seq, bounded by max_duration_ms; no admitted frame after the
capture deadline. Raw optional cdp_timestamp_s is seconds from CDP's own domain:
retain as diagnostic data only; **do not subtract it from performance or wall
clocks**. Clock has source `extension_performance`, origin
`before_start_screencast`, optional uncertainty_ms (absent = unknown). This is
receipt-time sampling, not a guarantee of when the page rendered.

Every frame supplies actual JPEG pixel dimensions and Geometry. viewport_css has
x=y=0; crop_css equals the frozen resolved rectangle. css_to_image describes
`image_x = css_x*scale_x + offset_x` and likewise y, using viewport-local CSS
coordinates, not document coordinates. Positive finite scales and bounded finite
offsets must map the crop fully inside the JPEG. Preserve actual device scale,
page scale and scroll offsets separately; do not assume DPR equals JPEG/CSS
scale. Initial mapping must be measured from viewport/CDP metadata and JPEG
geometry, not guessed from requested encoder size. V1 rejects changes to
viewport dimensions, image dimensions, CSS-to-image mapping, device/page scale,
or crop (GEOMETRY_CHANGED); normal document scroll with stable viewport mapping
may continue and is recorded. Letterboxing/browser controls that prevent a
reliable mapping must fail, not silently crop the wrong pixels. Encoder rounds
crop edges inward (ceil left/top, floor right/bottom) and rejects an empty crop.

## 4. End barrier, bounded private storage and reads

Ended supplies final_seq (0 if no frame), duration_ms, reason, duration_observed
and known drop counts. Extension duration is elapsed from the same origin,
clamped to the requested deadline; stopped uses actual stop-admission time.
It is >= last admitted frame/event t_ms. Draining may finish later but must not
inflate duration. Once admission closes, no more phase/mark events are admitted.
Host seals only after all seq 1..final_seq and admitted events are durable and
the immutable manifest is atomically written and synced (sync parent directory
on Unix). End arriving before writer completion waits behind the barrier, not
on the stdin thread. Final_seq must equal the transmitted/persisted high-water
mark when drained; mismatch is SEQUENCE. Duplicate identical end is idempotent;
a conflicting end cannot mutate a sealed manifest. Zero frames => failed,
reason no_frames (or preserve a more specific interruption); export NO_FRAMES.

On host-only failure without a trustworthy ended message, while the host remains
alive, stop admission, drain or fail pending writes, and construct failed End with
final_seq=persisted_seq, duration_ms=max(last durable frame/event t_ms,0),
duration_observed=false and
specific interruption reason. This duration is an observed lower bound, not
inferred host/extension clock subtraction. Partial export uses exactly that
bound, never the requested full duration. A failed start with no resolved target
may have only Status, no Manifest (NO_FRAMES). Complete manifests have tab_id and
Started geometry/clock. All other terminal sessions expose immutable Manifest
and retained readable bytes, including partials, while that host epoch/IPC remains
alive and storage permits reads. Native disconnect/exit only attempts bounded
best-effort failure signaling; it cannot guarantee post-exit partial availability.
EndAccepted reports actual terminal state only after the barrier; stop
acknowledgement uses stopping.

Spool is concatenated raw JPEG bytes without separators. FrameEntry offset/length
indexes that byte sequence; offsets start 0, are contiguous, and lengths sum to
spool_bytes. seq is contiguous; events have their own contiguous event_index.
SHA-256 fields are exactly 64 lowercase hex digits. FrameEntry.sha256 hashes
that JPEG; spool_sha256 hashes the entire concatenation. Hash raw bytes, never
base64 text. Host assigns all offsets/hashes; source messages cannot choose paths.

Caps (hard v1): 1800 frames, 1024 timeline events, 256 MiB/session, 512 MiB total
retained spool data, four retained sessions, 4 MiB serialized manifest, 15-minute
terminal retention, 256 KiB raw/read. Resource exhaustion fails active capture
with storage_limit; refuse new starts rather than evict unexpired retained data.
Bound queues to one frame and at most 1024 bounded events; reserve end/control
capacity separately. Admission/storage cleanup use monotonic deadlines. Private
host dirs 0700 and files 0600 on Unix, platform-private fallback on experimental
Windows; no symlinks/caller-provided names/paths. Clean stale data on startup and
expired sessions while running; **no promise of deletion while host is stopped**.
The 15-minute retention is a maximum live-host availability window, not survival
across native disconnect, process exit or restart.
Release is terminal-only, waits/excludes concurrent reads, deletes only owned
spool data and returns `{identity,released:true}`; repeats in epoch do likewise.
Unknown ID gives NOT_FOUND; stale epoch gives STALE_HOST.

Manifest/read are terminal-only. Manifest result is a JSON Manifest, with no
host path. Repeated calls return the same manifest content. Read offset must be
0..spool_bytes, length 1..262144; arithmetic must be checked before allocation.
Return min(length, total-offset) bytes, explicit offset/length/total_bytes,
SHA-256, padded data_base64, eof=(offset+length==total_bytes). Offset at EOF
returns empty bytes, SHA256(empty), length 0, eof true. Offset beyond EOF is an
error. Same offset/length request returns identical decoded bytes and digest.
CLI validates epoch/record/instance, terminal state, all bounds/order/geometry,
manifest totals, each chunk offset/length/base64/hash, each JPEG hash and entire
spool hash before encoding. A bridge/container cannot use host-local paths.

## 5. Task timeline and labels

Labels are arbitrary caller assertions (project/build/scene/seed/run/attempt/
agent/test.case are examples, not required fields). Max 16; keys 1..64 ASCII
`[A-Za-z0-9_.-]`; values <=256 UTF-8 bytes with no control characters; aggregate
key+value bytes <=4096. Optional run_id uses opaque-ID grammar. Never auto-collect
URLs, tokens, forms, page text or claim labels/marks prove a business outcome.
Text is literal UTF-8 <=512 bytes, no control characters except LF; at most 8
lines. Empty phase clears it; mark text nonempty and duration_ms 1..10000.

Extension stamps phase/mark on the pinned recording clock and serializes their
admission before stop. It sends record.event and returns that same persisted
Event to the CLI only after host acceptance. event_index starts 1, independent
of seq; event t_ms nondecreasing by event_index. Same operation_id + same
phase/mark request returns the original event (and original timestamp); different
content conflicts. Host deduplicates identical event_index/operation_id events;
changed duplicate/gap is rejected. Bound operation caches by the event cap.
The host event reply is the Event, not another credit. Phase persists from its
t_ms until next phase; mark occupies [t_ms,t_ms+duration_ms). Simultaneous events
apply event_index order; active marks join in that order. Accepted events beyond
an observed partial-export end are omitted, never extrapolated into history.
No automatic full action log is introduced.

## 6. CLI encoding and caller-chosen artifacts

Every video-producing CLI operation (fixed record, export, offline watermark,
stop-with-export) **requires explicit `--out PATH`**. Resolve relative to calling
CLI cwd; accept caller-selected writable absolute paths, including outside cwd.
Write on the CLI machine/container, never implicitly Downloads, project root or
host spool. Start and stop-without-export only return recording handle/status.
Return actual absolute video and sidecar paths in CLI JSON stdout. No `out` field
is sent to the host. Sidecars default beside the selected video using its stem:
`demo.mp4` → `demo.metadata.json`, `demo.timeline.jsonl`; check *all* collisions.
Spaces and CJK paths are ordinary literal paths. Explicit force policy is needed
for replacement; without it, existing files cause failure. Never overwrite an
input video, even with force, including hardlink/symlink aliases. Permission and
no-clobber errors are real failures, not successful file paths. Stage private
CLI temporaries, validate and encode before final atomic no-clobber publication;
clean only owned temporary/new outputs on failure. Multi-file publication must
not leave metadata claiming an uncommitted/wrong video; fail and remove newly
created artifacts if the complete set cannot be published.

Resolve ffmpeg/ffprobe on the CLI machine, no automatic tool downloads. Preflight
executable, H.264 encoder, GIF palette/overlay/text filters and font capabilities
before capture where possible. Spawn argument vectors, never shell strings;
bound process time/output and JPEG decode resources. Check exit status and
ffprobe facts. MP4/MOV: H.264/yuv420p, even output dimensions; MP4 faststart. No
audio. Preserve aspect ratio, don't upscale by default (even-size adjustment
may pad <=1px, not stretch). Formats gif/mp4/mov. Presets (fps/max_edge/CRF/colors):
tiny=4/480/34/32, compact=8/720/30/64, balanced=15/1280/25/128,
high=30/1920/20/256. Explicit values override presets. Output bounds fps 1..30,
max_edge 16..3840, CRF 0..51, colors 2..256. No target-size guarantee.

Crop → aspect-preserving resize → temporal normalization → watermark → GIF
palette/encoding. Output fps is a target, not distinct-source-frame promise.
Timeline JSONL is in decoded output **presentation** order (1-based output_frame),
not source seq or codec packet order. Nominal samples use the latest source at
or before each output PTS; before the first source, hold that first frame and
retain its true source_t_ms (initial hold, not evidence it existed at origin).
Hold last accepted source until actual observed end; zero-frame errors. Output
PTS/duration must reflect actual container timing, including GIF centisecond
quantization, not ideal fps fiction. Keep true end in metadata, limit rounding
to the format time quantum and report actual probed output duration. Identical
JPEG bytes at different seq are still different observations. Reusing the same
seq sets normalization_hold=true after its first appearance, not 'app stall'.

Partial failed-session export requires an explicit partial option and preserves
end reason and observed duration/lower-bound status. No assumption of a final
frame at stop. Raw source stays clean so a later unmarked export is possible
until release/retention expiry; no unbounded raw retention.

## 7. Watermark template v1

Watermark mode defaults none. Task/debug are reusable task-management templates,
not automatic recorder diagnostics. All non-none modes resolve to a saved
Template `{version:1,layout,strip_height?,items}`; custom JSON uses the same type.
Debug is an alias preset with task fields; capture-internal fields are explicitly
opt-in. None stores no template and does not modify pixels.

Template file <=32768 UTF-8 bytes, <=32 items. Layout strip appends a 16..512px
band **after resizing content**, and anchors items within that band, never over
content. overlay anchors inside the output canvas; no strip_height. Source
images/DOM are unchanged. Anchor is top_left/top_right/bottom_left/bottom_right/
center; position the text bounding box at that anchor, then apply signed x/y
pixel offsets (-8192..8192; positive right/down). Font size 6..128 output px,
font_path optional <=4096 UTF-8 bytes referring only to a CLI-local readable font.
Colors/background are `#RRGGBB` only; opacity finite 0..1 applies to item text
and optional box background. Text is literal or template, <=512 UTF-8 bytes,
<=8 lines; reject NUL/control bytes except LF. Interval is optional [start_ms,
end_ms), safe nonnegative integers with end>start. update_interval_ms 0..10000:
0 updates each presentation frame; otherwise evaluate text at the preceding
interval boundary (floor(pts/interval)*interval), without coarsening JSONL facts.

Template syntax: `{name}`, `{{` literal `{`, `}}` literal `}`. Reject unmatched
braces and unknown placeholders **before capture/export**, no expressions or
recursive interpolation. Whitelist: `label.KEY` (a supplied label key), `run_id`,
`record_id`, `export_id`, `phase`, `marks`, `pts_ms`, `output_frame`, `source_seq`,
`source_t_ms`. Optional IDs/phases/marks resolve to empty text; source-only
placeholders require verified recording provenance or are invalid. pts_ms and
source_t_ms render nonnegative decimal milliseconds with at most three fractional
digits; counters render decimal integers. marks joins active literal texts with
` | `. Label substitution is one pass: text containing `{...}`, percent signs,
quotes, colons, slashes or filter syntax remains literal data, never reparsed.
Bound expanded item text to 4096 UTF-8 bytes and fail on overflow.

No arbitrary expressions, shell/filtergraph options, file expansion or filter
injection. Use safe literal text files/escaping even when process arguments are
vectors: ffmpeg's text/filter parsers are a separate injection surface. Validate
font glyph coverage for requested text before reporting success; CJK requires
a suitable installed font or explicit font_path. Missing glyph/font capability
is an actionable error, never tofu reported as success. No built-in font download.
Per-frame text or GIF may **increase** size; compact text update rates do not
change exact timeline mappings.

## 8. Metadata, hashes and offline provenance

Task/debug/custom exports, or explicit metadata requests, save ArtifactMetadata
JSON (<=32 MiB) and OutputFrame JSONL (<=4 MiB) beside the selected video. These
limits also apply before reading/parsing supplied offline sidecars. Store resolved labels,
settings/template version, identity/run/export IDs, actual dimensions/timing,
partial/end reason and content hashes. A fresh export_id is allocated per output,
not reused across formats. Video hash/bytes bind the sidecars to the actual
encoded video; timeline hash/bytes binds exact JSONL bytes to metadata. Each row
includes export_id. File names alone are not pairing evidence. Clock/drop/source
event facts must remain accessible in the saved metadata: embed the sealed
source manifest's exact UTF-8 JSON snapshot in `source_manifest_json` when
provenance is recording; source_manifest_sha256 hashes those string-content
bytes (not the JSON-escaped enclosing string or an invented cross-language
canonicalization). Consumers verify the hash and parse that string as Manifest.
For offline verified sidecars preserve this pair if available. Additional fields
are permitted; secrets/URLs are not added implicitly.

Offline watermark input is an existing GIF/MP4/MOV. With no matching metadata,
provenance=offline_unverified, input_video records actual input hash/bytes; only
probed presentation timing/frame and new caller labels are usable. Omit identity,
source_seq/source_t_ms/normalization_hold, phase history, drops, original clock
and unverified end reason. Never fabricate source history. A caller may supply
new literal labels/static text but that is not a captured event history.

With supplied sidecars, verify actual input video hash/bytes, timeline hash/bytes,
export IDs and schema/recording identity coherence. Any mismatch is an error,
not silent fallback to unverified. provenance=offline_verified_sidecar and
parent_export_id bind the new artifact to the matched input; preserve only facts
actually present. Content matching is not a cryptographic signature or proof
that caller assertions are true. Source-only placeholders still require actual
verified source facts. Decode/retime mappings without assuming codec packet
order, preserve input, and assign new output hash/export_id/sidecars.

## 9. Shared fixtures and required implementation checks

`wire.json` covers both envelopes, initial credit, an actual 16x16 black JPEG,
phase/mark, end, status, chunk and release. `manifest.json` indexes two identical
221-byte JPEG observations (0ms and 1000ms), 442 bytes concatenated. Its hashes
and wire chunk hashes are real. `template.json` exercises CJK labels and dynamic
phase/marks. `timeline.jsonl` maps three presentation frames to two source seqs,
including one normalization hold; its hash/length in `metadata.json` are real.
The metadata video's all-zero digest and zero length are **illustrative sentinels
only**: no encoded video is shipped and these must fail real artifact matching.
The metadata fixture embeds the exact source snapshot as a JSON string. Examples are
synthetic assertions, not a report of a game outcome or live browser recording.

Core tests round-trip the contract types, separate ID namespaces/presentation
mapping, and bound labels. Component tests must additionally verify semantics:
duplicate/conflicting starts, wrong identities/directions, ACK vs credit,
malformed/oversize JPEG and sequence failures, nonblocking durable writes,
end-before-write completion, duplicate/conflicting barriers, zero frames,
static initial-frame behavior, crop/DPR/viewport changes, interruption/lease
cleanup, stable chunk reads/hashes, ordinary command coexistence, bounds/expiry,
CJK/font and filter escaping, GIF palette/timing, H.264 even sizes, explicit out
outside cwd/relative/spaces/CJK, permissions, no-clobber and sidecar mismatch.
Serialization tests alone do not verify those runtime behaviors.
