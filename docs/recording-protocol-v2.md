# Recording contract v2 — correlated screenshot observations

Normative source: `ap_browser_core::recording::v2` (`core/src/recording/v2.rs`).
Shared synthetic examples: `tests/fixtures/recording-v2/`. These are contracts, not
an installed producer or recording acceptance. Ordinary screenshot API feasibility
has been observed on a fresh sole-owner, known-unemulated Chrome for Testing156
target. That does **not** establish recording-v2 E2E, arbitrary emulation safety,
distinct-source FPS, or paint timing.

## 1. Scope, reuse and exact negotiation

New native recording creation is **v2 only**. No unsafe/hidden v1 producer or
fallback is allowed. Legacy `recording::{Manifest,ArtifactMetadata,OutputFrame}`
and `tests/fixtures/recording/` remain intact for authenticated **offline readers**.
V2 types occupy a separate namespace so unmigrated application builds still
compile; compiling those old applications is not approval to run old capture.

Reuse all v1 requirements in `recording-protocol.md` except its screencast producer,
preparation, clock, drop counters, stop/deadline and source/artifact schema rules,
which this document replaces. In particular retain v1's framing/envelopes,
directions, opaque identity grammar, host epochs/instance pinning, idempotency,
source-first startup recovery, independent debugger lease, original bounded
budgets, durable credit/seal barrier, chunk/hash validation, caps, privacy,
retention, labels/events, templates, encoding quality/size/format controls,
explicit calling-Agent `--out`, atomic no-clobber publication and same-host loss
semantics. No audio, full-page, desktop, element tracking, resize, force-focus,
DOM mutation, infobar suppression, repaint hack, or automatic action log.

All Rust JSON peers must retain workspace `serde_json` **float_roundtrip**.
Finite IEEE-754 values survive every parse/frame/persist/echo hop exactly, not
within a tolerance; never round source clocks or subtract host/wall/CDP clocks.
JS-safe integers remain mandatory. Deserialization alone is not validation.
Unknown versions/variants and cross-version contradictions reject, not fallback.
V2 source-bearing structs reject unknown fields; reused stable v1 primitives
retain their existing serde behavior. Receivers must still check every shared
primitive's semantic/byte bounds before allocation or persistence.

`record.capabilities` is CLI → host → the **same connected extension**, using
ordinary numeric RPC envelopes. Params are exactly `{}` (`CapabilitiesRequest`):
no tab resolution, focus/favicon hooks, debugger attach, lease, slot, or identity
allocation. The extension answers its own `ProducerCapability`:
`{protocol_version:2,backend:"cdp_capture_screenshot"}`. The host aggregates:

```
{host:{protocol_version:2,backend:"cdp_capture_screenshot"},
 extension:{protocol_version:2,backend:"cdp_capture_screenshot"},
 legacy_v1_read_only:true}
```

The host must attest its own actual implementation and query actual extension
support, never echo assumed support. CLI validates **both** before capture;
host revalidates start before allocation, extension before target work. Native
connection replacement invalidates negotiated extension knowledge; query again.
Old/mixed components, missing capability method, or unavailable extension fail
preflight actionably, before capture; no target probe masquerading as negotiation.

Two narrowly added error codes: `RECORD_UNSUPPORTED_VERSION` (missing/unsupported
live protocol or capability method) and `RECORD_UNSUPPORTED_BACKEND` (unsupported
backend). Host maps an old extension's method-not-found to the former; an old
host's unknown-method response is recognized by CLI with an upgrade instruction.
Missing/wrong-typed ordinary fields remain `RECORD_INVALID_PARAMS`; wrong direction
also rejects. Version/backend negotiation errors precede tab allocation/attachment,
are propagated through existing error envelopes without payload/path disclosure,
and never become generic successful data or a v1 retry. Other v1 error codes stay.
Unknown backend strings must be classified before typed enum parsing if a receiver
needs to distinguish unsupported backend from malformed params.

All existing record.* RPC routing/envelopes remain. Only these data change:

| Method/result | v2 type/fields |
|---|---|
| start CLI → host | `StartRequest`: required `protocol_version:2`, `backend`, operation_id, optional tab_id, config |
| start host → extension | `ExtensionStart`: flattened start plus identity and initial_credit, as before |
| extension start result | `Started`: protocol_version, backend, identity, tab_id, clock, resolved_region_css |
| host start/stop/status result | `Status`: protocol_version, backend, identity, operation_id, instance_id, optional tab_id, state, persisted_seq, spool_bytes, optional end |
| extension frame/ended | `Frame` / `Ended`, described below; existing string-ID ACKs |
| terminal manifest | `Manifest`: protocol_version, backend, identity, operation_id, instance_id, tab_id, state, config, resolved_region_css, clock, end, frames, events, spool_bytes, spool_sha256 |

Backend is always `cdp_capture_screenshot`. Frame/end/events/credit/read/release
are interpreted in their reserved identity's negotiated version, not guessed
from shapes. Stop, handle, phase, mark, event, credit, accepted, chunk, released,
rect/config/labels/template/export settings/format primitives are reused unchanged.
Frame has no independent protocol/backend override and no `cdp_timestamp_s`.

## 2. Audited source options, ownership and preparation

Only ordinary `Page.captureScreenshot({format:"jpeg",quality:config.jpeg_quality,
fromSurface:true,captureBeyondViewport:false})`. **No clip**, optimize, resize,
emulation override, or trusted-client impersonation. `fromSurface:false` is
trusted-client-only and **forbidden**. Source is full viewport JPEG; fixed crop
is applied offline, never by a CDP clip that can cause resize/restore side effects.
No `Page.startScreencast`, `stopScreencast`, or `screencastFrameAck` in new capture.
Unrelated owners' streams/events remain untouched and cannot enter this producer.

The source audit found screenshot emulation setters/restores can resize and
asynchronously restore stale saved state on emulated/clip paths. The safe audited
path has a **fresh-known-unemulated** precondition: known clean target lifecycle
and recorder knowledge of emulation ownership/history, with all emulation mutators
excluded across preparation, capture, completion and unresolved RPC quarantine.
The serialized `emulation:"fresh_known_unemulated"` is that ownership assertion,
**not** a conclusion that equal DOM/CDP viewport values prove no overrides exist.
Arbitrary pre-attached/foreign/unknown emulation cannot be certified from these
readonly metrics. Refuse with existing geometry/start failure errors; never
reset, resize, restore another owner, silently accept, or infer disabled state
from DPR1 alone. A component unable to establish this precondition must fail
clearly, not broaden support. "Fresh-known" describes proven attachment lifecycle
and clean emulation history, not permission to detach another owner or a demand
for a new tab before every clip. A known-clean normal-command attachment may be
shared; unknown state must refuse without takeover. Ordinary non-mutating commands
still coexist under the independent lease; mutating Emulation/device-metrics commands must refuse
while recorder ownership/quarantine excludes them. No universal-target claim.

Preparation shares the original **10s total startup budget** with lease readiness
and final region selection. Use real screenshot operations with complete readonly
before/after viewport observations, JPEG dimensions and measured repeat agreement.
Bound retries/temporary decode and wait only within remaining original budget.
DOM-only stability or a longer fixed sleep is insufficient. Incoherent preparation
may retry boundedly; it cannot become stored source. Settle successive coherent
mapping observations before freezing viewport and rect. Element is selected once
at final region selection, intersected with visible viewport, without scrolling
or tracking; that read must agree with prepared mapping. Preparation callbacks
are internally purpose `preparation`, have immutable identity/request correlation,
and are **not** accepted by wire `Purpose` (`sample|final` only).

Set `Clock {source:"extension_performance",
origin:"before_first_recorded_screenshot_request",uncertainty_ms?:...}` after
successful preparation/final selection, immediately before the first recorded
request. Absent uncertainty means unknown, not zero. Stop during preparation
cancels with zero-frame/start failure and no invented clock or final image.
Late preparation/lease callbacks must not create/resume capture or a new identity.

## 3. Source request intervals and readonly geometry

`Frame` contains identity, contiguous seq, t_ms, **observation**, width, height,
geometry, jpeg_base64. `FrameEntry` replaces identity/jpeg_base64 with host-assigned
offset, length, sha256; otherwise the source fields are identical. Observation:

```
{request_id:OPAQUE, purpose:"sample"|"final",
 request_started_ms:NUMBER, response_received_ms:NUMBER,
 geometry_validated_ms:NUMBER}
```

IDs use the stable opaque grammar, unique across the recording including failed
final attempts, distinct from seq/native/CDP RPC IDs. Correlate the owned actual
screenshot invocation and callback with immutable record identity, request_id and
purpose. `request_started_ms` is measured immediately before actual screenshot
invocation (after before-geometry read); response is measured on its successful
owned callback; validated is measured after after-read, JPEG/geometry validation.
`0 <= started < hard_duration`, `started <= response <= validated <= hard_duration`.
`t_ms == response_received_ms` **exactly**. All stored intervals are serial and
nonoverlapping in seq order; next request start >= previous validated time.
Late/cancelled/preparatory/wrong-identity callbacks cannot consume seq or source.
Seq is assigned only at actual native send after validity/credit/cap checks.

This interval brackets API response/validation, **not compositor paint**. Cached
pixels may predate it. No invented CDP raw timestamp, clamping/backdating, or
claim of exact page-paint/scroll offset. Before-read time precedes request start;
the interval is not a claim that all geometry reads occurred inside it.

V2 `Geometry` fields are `viewport_css`, frozen `crop_css`, `css_to_image`,
`before`, `after`. Each `ViewportObservation` has `dom`, `cdp`, `emulation`:

* DOM: inner_width/height, client_width/height, device_scale_factor, scroll_x/y,
  document_width/height, visual.
* CDP CSS layout metrics: layout_width/height, page_x/y, visual, zoom,
  content_width/height. Never confuse deprecated physical layout metrics with CSS.
* Each visual: width, height, offset_x/y, page_x/y, scale. DOM maps visualViewport
  width/height/offsetLeft/offsetTop/pageLeft/pageTop/scale; CDP maps cssVisualViewport
  clientWidth/clientHeight/offsetX/offsetY/pageX/pageY/scale. CDP zoom is its zoom.

Numbers are complete finite readonly facts, not silently overwritten to agree.
Dimensions/scales are positive; scroll/page positions may be signed. The initial
strict policy requires DOM inner size = CDP CSS layout size = visual size;
DOM client size <= inner size; DOM/CDP visual dimensions/offsets/scale agree;
visual offsets0, scale1 and CDP zoom1. Device scale may differ from1 if reliable.
Mapping-critical key comprises inner/client/layout/visual sizes, device scale,
visual offsets/scales and zoom. It must agree before/after and remain frozen
across source observations, as must JPEG dimensions, viewport/crop and transform.
A mismatched post-start observation fails explicitly, not adaptive recrop/retry.

**Scroll/page positions, document/content dimensions and page content are not
mapping-critical equality requirements.** They may change within and across
operations; preserve each real before/after value without claiming exact paint
offset. Viewport-local crop can remain valid while scrolling/animating. No image
byte-identity, element-content stability, fixed scroll or repaint gate is added.

Viewport x=y=0. Crop is positive, finite, inside the frozen viewport. Initial
v2 allows the audited unshifted full-viewport transform only: offsets0,
scale_x=actual_JPEG_width/viewport_width and likewise y. Do not equate DPR to that
scale. Any letterboxing/ambiguous emulation/mapping fails. Offline crop rounds
edges inward and rejects an empty crop. Existing JPEG validation remains:
standard padded base64, <=4MiB decoded / 5,592,408 encoded chars, actual JPEG
header/dimensions, 1..16384 each and <=64M pixels; bound before decode.

## 4. Scheduler, durable credit and honest counters

At most **one screenshot/coherence operation OR one native frame write** at a
time, not one of each. Before-reads through validation constitute one operation;
then, if accepted, its native send/credit completion must finish before another
capture/coherence operation. No unsolicited candidate slot, rescue event, catch-up
backlog, accumulating promises, overlapping validation/decode, or frame RPC retry.
Next sample waits both FPS eligibility (from preceding request start) and durable
native credit. FPS is **best effort**, never guaranteed distinct-source cadence.
Missed eligibility is a scheduling delay, not a dropped producer paint. No Chrome
request issued means no source observation to count as a drop.

Credit remains identity-pinned next_seq, initially1/max_frame_bytes4194304.
Host append + sync_data + serialized index acceptance precedes FrameAccepted;
accepted_seq+1 is new credit. A lost ACK fails by remaining monotonic10s budget,
never retry/duplicate append. Status/stop stay responsive during disk I/O. Serial
interval validation is necessary but not proof of this runtime write exclusion;
component tests must independently verify scheduler/credit exclusion.

`CaptureCounts` (End.counters, **null** if unavailable on host-only failure):

| Field | Exact meaning |
|---|---|
| preparation_requests | actual internally-preparatory screenshot invocations |
| preparation_responses | successful screenshot data callbacks for those invocations |
| requests_started | actual recorded sample + final invocations, excluding preparation |
| responses_received | successful recorded data callbacks, including invalid or late data |
| request_failures | recorded RPC error completions (not successful data responses) |
| observations_rejected | received recorded observations not sent: invalid/late/cancelled data, once each |
| late_responses | subset rejected because their response/validation exceeded original cap/budget |
| frames_sent | actual native frame RPC sends, not ACK/persist count |
| scheduling_delays | regular FPS eligibility opportunities postponed by the one owned operation/write; once per postponed eligibility, not per timer spin |

An eligibility opportunity is one regular due slot; once postponed, do not count
again while blocked, and schedule from next actual request without catch-up.
Counters are JS-safe, monotonic known facts, never legacy sampled/backpressured
paint counts. Responses + failures <= started (difference can be quarantined
unresolved work); rejected <= responses, late <= rejected; frames_sent <=
responses-rejected; persisted <= frames_sent. Complete seal requires all sends
durable, exact sent/persisted count, no RPC failure and no unresolved request.
Complete stopped sources have no rejected recorded response; automatic deadline
may discard settled late responses but cannot hide other invalid observations.
Invalid post-start
geometry/data is a failure, not silently sampled out. Preparation counters do not
invent recorded intervals or imply preparation duration belongs to recording.
Freeze terminal counts; a late quarantined callback cannot mutate a sealed end.

All original budgets remain absolute, not renewed per step. Cancellation closes
new requests. Chrome RPC timeout does not cancel the underlying call: quarantine
its owner/lease until original completion or confirmed owned detach proves resource
clearance. No replacement recording, emulation mutation or foreign detach while
unresolved. Late results cannot write bytes, alter a terminal manifest or affect
a replacement identity. Bounded identity-pinned cleanup/reconciliation may clear
quarantine, never mutate terminal source or resume capture. Native loss is
same-epoch unrecoverable; no host daemon/orphan retention or restart resumption.

## 5. Explicit stop, automatic deadline and final disposition

Explicit stop records actual `stop_requested_ms`, immediately closes normal
sample and phase/mark admission, and promptly ACKs stopping (not sealed). Sample
request start and event admission must precede stop in the producer's atomic
state-machine order. Reduced-precision clock ticks can coincide, so persisted
validation allows their timestamps **equal to** stop_requested_ms and rejects
only later values. Equality does not authorize post-stop admission or prove order;
the producer must enforce closure rather than infer causality from timestamp ties.
A previously admitted sample may finish after stop, if validation is still within cap. Settle the one earlier
operation/write; then admit **at most one** genuine purpose `final` request with
`request_started_ms >= stop_requested_ms` and **< original max_duration_ms**.
This bypasses regular FPS eligibility, not credit, mapping, caps or timeout rules.
Complete final validation must be <= hard duration. Startup/stop/capture do not
renew the original hard cap. One **10s absolute stop budget**, measured from
stop request, bounds all settle/request/validation/write/end work, not10s each.

Persist this final observation before normal stopped seal. `t_ms` stays actual
response time. End cutoff/duration freeze at its actual geometry validation,
**not** stop admission, later credit/disk/encoder completion, requested duration,
or a fabricated timestamp. If final cannot be admitted, succeeds too late, is
invalid, times out, or cannot be persisted due to hard storage/frame caps,
explicit stop is **failed, explicit partial only**, never silent sealed completion.
No increased cap/hidden omitted final. Duplicate stop does not issue another final.
Keep a more specific failure reason (e.g. storage_limit) when appropriate;
otherwise use `final_observation_failed`.

Automatic deadline closes admission at the hard cap and issues **no new
post-cap request or special final**. It can boundedly drain already admitted
observations validated <=cap, without backdating late responses. Unresolved RPC
means failure/quarantine. With valid source and no other failure, deadline seals
with duration=cutoff=hard cap and no fresh-final promise. Stop received at/after
a deadline already closed admission does not retroactively change it to explicit
stop; return existing stopping/terminal status.

`End` fields: final_seq, duration_ms, duration_observed, reason, **cutoff**,
**stop_requested_ms**, **final_observation**, **counters**. Nullable fields are
explicitly null when unknown/not applicable. Cutoff `{t_ms,provenance}` must have
`t_ms == duration_ms` exactly, bounded0..hard cap:

* `final_geometry_validation`: accepted final's exact geometry_validated_ms.
* `deadline`: original max duration, only an automatic deadline complete end.
* `admission_closed`: measured actual failure admission cutoff, not renewed budget.
* `durable_lower_bound`: host-only loss, max(last durable source geometry validation,
  last durable event time,0), `duration_observed:false`. Other cutoffs are observed.

Final disposition is a tagged object, exactly one of:

```
{disposition:"not_requested"}
{disposition:"accepted",request_id:OPAQUE,seq:INTEGER}
{disposition:"persisted_without_end",request_id:OPAQUE,seq:INTEGER} // HOST ONLY
{disposition:"failed",attempt:null|{request_id:OPAQUE,request_started_ms:NUMBER},
 reason:"deadline"|"stop_budget"|"request_failed"|"invalid_observation"|
        "storage_limit"|"interrupted"}
```

`not_requested` means no explicit stop requirement (deadline or unrelated failure).
`accepted` references the sole stored final, last source seq, admitted after stop;
its cutoff is exactly final validation. `failed` requires explicit stop, no stored
final, failed state; attempt is null if no final RPC issued, otherwise original
unique request ID/start (before cap). Failed attempt is **not a FrameEntry** and
never receives invented response time/seq. Late diagnostic callbacks may be logged
boundedly as actual times outside source, never clamped into this disposition.
Accepted final plus subsequent disk/control failure may retain accepted provenance
but remains failed for its real end reason.

`persisted_without_end` is **host-only**: when the same live host has durably stored
one genuine final frame but lost producer Ended/control facts, preserve that sole
last final with its exact request_id/seq and original interval/bytes. It is valid
**only** for failed state, a noncomplete reason, durable_lower_bound cutoff,
duration_observed:false, stop_requested_ms:null and counters:null. The cutoff is
still the exact durable lower bound, not an observed recording end. The final's
request_started_ms is only an **upper bound** on prior event admission (ties
allowed), never an invented stop timestamp. Do not drop the accepted final or
relabel it as sample. The host must synthesize this from its own authenticated
durable prefix; producer Ended deserialization rejects this disposition. Complete
stopped seal still requires accepted final and known stop/end/counter facts.
Without a stored final, host-only loss uses not_requested/null and lower-bound
failure, without inferring stop or counters. Started source provenance
recovery/barrier rules stay.

Only sealed + stopped (accepted final required) or deadline is complete. Other
reasons are failed; no-frames cannot export. Host validates unique request IDs,
ordered intervals, response equality, serial admission, final uniqueness/reference,
stop-event boundary, geometry/bytes/caps, final_seq and immutable end before seal.
All seq1..final_seq plus admitted events must be durable; append+sync and atomic
manifest+directory sync precede end ACK. Duplicate identical end is idempotent;
contradictory end rejects and never mutates terminal bytes.

## 6. V2 output schema and final visibility, without backdating

New v2 source artifacts use schema_version2 in metadata **and** JSONL; watermark
Template still version1. Preserve exact source JSON bytes/hash, not canonicalized
reconstruction. V2 metadata retains v1 common fields, replaces end_reason with v2
EndReason, and adds optional source_protocol_version/backend/observed_source_end_ms,
required final_visibility_extension_ms (0 ordinarily). Source-bearing v2 metadata
requires source_protocol_version2, backend, matching identity/end/partial and exact
source_manifest_json + its SHA256. Hash the original string-content UTF-8 bytes.
`duration_ms` is actual encoded/probed duration; observed_source_end_ms is the
actual source cutoff **only if duration_observed is true**, otherwise omitted
(unknown end). Preserve the failed manifest's durable lower bound and unknown
stop/counters exactly; metadata must not promote that lower bound to observed end.
Any special extension is max(actual duration - source cutoff,0), including when
the cutoff is a durable lower bound rather than a known end.

V2 `OutputFrame`: schema_version, export_id, output_frame, pts_ms, duration_ms,
optional **source** `{seq,t_ms,observation}`, optional normalization_hold, required
final_observation_visibility boolean, optional phase, marks. Source observation
must exactly match authenticated manifest seq/request/timing/purpose. No new
interval placeholders/template language. Source timestamps never become output
PTS; initial hold may present first observation at PTS0 while retaining its later
true source t_ms. JSONL remains actual decoded presentation order/container timing,
not codec packet order. Same seq repeated is hold, not an application stall.

Use normal latest-source-at/before-PTS normalization and observed-end rules.
Exporter must make a genuinely stored final visible even if nominal FPS would
miss it. This includes a failed partial source's host-only persisted_without_end
final, without upgrading its unknown-end provenance. **Only when needed** append that source at
`ceil(final.response_received_ms / container_quantum_ms) * container_quantum_ms`,
with one quantum duration, exact source reference and
`final_observation_visibility:true`. Do not move the source timestamp earlier.
Retiming the preceding presentation frame's duration is allowed to meet the new
append PTS without overlapping rows; all PTS/durations reflect actual media.
Append PTS must follow prior presentation PTS; never add a duplicate extra quantum
just to escape an invalid schedule. If final is already presented by ordinary
normalization, do not append/relabel or claim this exception.

For this final-visibility case only, actual output may extend **strictly less
than2 container quanta** beyond source cutoff (GIF quantum10ms, MP4/MOV1ms),
including a persisted_without_end durable lower bound with unknown actual end.
Append must not truncate a later observed end; when validation finishes sufficiently
later, ordinary normalization/holding covers it instead. Ordinary/deadline/legacy
exports retain stricter current timing/quantization rules; this is not permission
to extend every output, backdate frames, or report requested duration. Validate
actual ffprobe timing and row/video/source/hash correspondence independently.

Shared boundary: stop1000, final request1000.25, response1106.2999999523163,
validation/cutoff1106.4. GIF appended PTS1110/duration10/output1120 (extension13.6,
<20); MP4/MOV PTS1107/duration1/output1108 (extension~1.6,<2). The source response
stays1106.2999999523163 exactly. `validate_final_visibility` checks this row-level
boundary; the exporter must additionally prove necessity, complete presentation
ordering/container timing, actual duration and authentic source matching.

## 7. Legacy/offline discrimination, immutable provenance and privacy

Dispatch manifest by **required protocol_version**, metadata/rows by required
schema_version, never presence heuristics. `parse_source_manifest` and
`parse_artifact_metadata` are bounded version/contradiction dispatch helpers, not
cryptographic authentication or complete legacy semantic validators. Call existing
legacy validation for v1, v2 validation for2, and verify all exact-byte hashes,
source/chunk/JPEG totals, actual videos/timelines and identity coherence. Unknown
versions, schema1+Manifest2, schema2+Manifest1, v1+v2 backend/interval/final fields,
v2+legacy clock/CDP timestamps/drop counters, mismatched source row fields, and
missing required facts reject. Never silently fall back to offline_unverified
when supplied sidecars fail authentication or semantics.

Valid schema1/Manifest1 source remains legacy with its **original manifest bytes
and SHA256**, clock/drop semantics and strict legacy output timing. New offline
watermarked outputs derived from legacy keep **schema1** sidecars and provenance
`offline_verified_sidecar` with original source pair/parent/input hashes. A new
executable cannot invent v2 backend/intervals/request IDs or final disposition
for old source. Do not reinterpret receipt-time screencasts as screenshot requests.

Untagged/offline input without verified matching sidecars remains
`offline_unverified`. Schema2 offline-unverified output may omit source completely:
no backend/source_protocol_version/identity/clock/interval/end/observed end,
normalization_hold/source/phase history or invented final. Extension0 and literal
new labels/static text only. Valid v2 offline-verified inputs preserve only
actually present authenticated facts; input/parent identity/hash pairing stays.
Existing reader validation and no-clobber behavior remain required.

Host spools/chunks expose no paths to remote CLI. Remain private0700/0600, raw JPEG
SHA256 + concatenated spool SHA256, contiguous offsets, bounded4MiB manifest,
256KiB reads, 1800 frames/1024 events, 256MiB/session/512MiB total/four retained,
15-minute **same-live-epoch** retention (not after exit/restart). Release/expiry,
no-symlink ownership, tombstones, no eviction of unexpired sources, exact output
hashes, input alias protection and atomic no-clobber publication are unchanged.
Never collect URLs, page text, tokens or secrets in diagnostics/metadata by default.
Source JPEGs remain clean; output annotation happens locally after validation.

## 8. Fixtures and acceptance boundaries

* `wire.json`: no-target capability request/aggregate, explicit versioned starts,
  start/stop-ACK statuses, durable-credit example, narrow errors. Other unchanged
  envelope/chunk/event/handle examples remain in legacy fixtures without changes.
* `manifest.json`: two **synthetic** real221-byte16x16 JPEG entries referencing
  the same black JPEG as legacy wire fixture (real frame/spool hashes), sample
  then final. Scroll/document facts deliberately vary; not a live page assertion.
* `timeline.jsonl`: nominal2FPS holds plus GIF final append with exact source
  correspondence and true final timestamp. Illustrative presentation, not media.
* `boundaries.json`: automatic-deadline End, failed-required-final End, rejected
  source intervals and GIF/MP4/MOV final-boundary values.
* `persisted-without-end.json`: host-only failed End boundary for the same two
  synthetic source frames, genuine stored final retained but stop/end/counters
  unknown; never valid as producer Ended or complete seal.
* `metadata.json`: offline-unverified schema2, deliberately no source inventions.
  Zero digest/byte media sentinels are **not actual artifacts** and must fail real
  media authentication. Source-bearing metadata tests embed exact manifest text;
  structural tests do not authenticate digests or produce video.

Core tests cover exact serde/framing precision, capability/version errors,
legacy discrimination, semantic intervals/serial IDs, complete/partial/deadline
cutoffs, readonly mapping versus scroll, counters/caps and final-visibility bounds.
These do **not** prove actual Chrome ownership/precondition enforcement, durable
fsync ordering, scheduler/write exclusion, emulation race prevention/quarantine,
real encoding, no-clobber, live artifact pixels, or Gemini video QA. Component,
integration and independent reviews must verify those; no browser launched here.
