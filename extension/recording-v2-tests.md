# Recording v2 pure-code gate and migration

Run `node --check extension/background.js && node --test extension/recording-v2.test.mjs`.
This gate imports the actual controller, geometry/validation/attachment guard and
background worker (VM sandbox), with injected CDP/native transports and real JPEG
fixtures. It does not launch Chrome or establish live feature/media acceptance.
No wildcard test runner: `annotate-ui.test.mjs` is a legacy real-browser case.

## Explicit retirement of v1 live-producer tests

The four existing recording test files are migrated, not silently disabled:

| Old invariant / producer-specific assertion | V2 coverage |
| --- | --- |
| `recording.test.mjs`: IDs, credit, bounds, target pinning, start retries/tombstones, regions, events, geometry, interruption | Same file plus startup/fidelity/boundary/background suites exercise actual v2 controller; reserved operation/epoch errors, literal event validation/cap and fixed JPEG mapping remain |
| DOM-only 200ms quiet-window/scroll equality / infobar warmup | `recording-startup.test.mjs`: real screenshot/pre/post layout coherence, measured repeat agreement, initial resize retry, original 10s total budget, one final element read, no scroll/tracking; scrolling/content changes are now explicitly allowed |
| Every screencast event ACK, CDP timestamps, sample/backpressure drops | Retired: recorder never owns that stream. `recording-fidelity.test.mjs` and background tests assert no start/stop/ACK, no event source/fallback; real immutable request IDs/purposes/response intervals and honest request counters replace global event attribution |
| Latest unsolicited candidate slot, supersession, flush-on-silence/stop | Retired: no unsolicited source queue. Actual screenshot request + durable write exclusion, FPS eligibility/no backlog, delayed-slot counter and one explicit correlated final request are tested instead |
| Stop control failure / stream shutdown quarantine | Replaced by unresolved screenshot/readiness/write quarantine, original-completion or confirmed-target-detach clearance, unknown pre-attachment refusal and no foreign detach; successful screenshot cleanup has no stream stop operation to fail |
| Final candidate drain, credit timeout, late credit, native loss, stale callback isolation | `recording-fidelity.test.mjs` and `recording-background.test.mjs`: settle admitted operation/write, one final, absolute stop budget, late response discard/frozen terminal, missing-ACK durable-prefix handoff, pinned native ports and normal-owner coexistence |
| Frame/JPEG/session/event caps and clock/geometry failures | `recording-boundaries.test.mjs`, controller and fidelity suites: actual 4MiB JPEGs, 256MiB session and 1800-frame hard caps including required-final failure, 1024 events, exact cap/stop ties, nonfinite/regressing intervals, invalid JPEG/mapping and source-end freeze before disk wait |

`recording-guard.test.mjs` independently checks lifecycle-derived clean provenance,
mutator history (including failed/clearing setters), in-flight exclusion, unsafe
clip/beyond-viewport screenshots, opaque nested CDP, ordinary focus emulation and
unrelated tabs. The recorder serializes `fresh_known_unemulated` only through that
reserved, still-current lifecycle-backed access object; never from DPR inference.

## Integration harness adaptation

Background VM sandboxes stripping imports must inject `createRecordingController`,
`recordingCapabilities`, and `createRecordingGuard` (plus existing helpers). Direct
controller transports now take `sendNative(method, params, onSent)`; call optional
`onSent()` synchronously only after a successful actual frame post, before awaiting
its ACK. Native seq/send counts cannot be inferred from ACKs or attempted posts.
Lease readiness resolves a guard-backed `{sendCommand, emulation}` access object;
its release must preserve normal users and pending ownership. Never stub clean
provenance as a constant in runtime wiring. See the maintained v2 test harness.

The session-relay suite has only the supervisor-approved import/context injection;
its assertions are unchanged. Annotation/source/helper suites remain untouched.
Top-level integration v1 stream harnesses require the same explicit adaptation by
the integration owner. No v1 live fixture is silently reinterpreted as v2; the v1
wire fixture is reused only for its genuine bounded JPEG bytes.

The host still owns global storage/retention, durable-prefix recovery (including
`persisted_without_end`), authentication and manifest validation. This extension
withholds contradictory Ended after an unacknowledged frame write, or when the
original stop budget has expired. Live host storage/browser/encoding/video QA and
independent review are separate required gates; synthetic tests are not substitutes.
