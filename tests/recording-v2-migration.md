# Snapshot v2 integration invariant migration

These tests use synthetic screenshot RPCs with the actual controller/guard and
actual native host, TCP bridge, fresh CLI subprocesses and local FFmpeg. They do
not authenticate Chrome capture or constitute live feature acceptance.

| Retired v1 implementation assertion | Maintained v2 invariant / executable coverage |
| --- | --- |
| Global screencast event ACK counts / raw CDP paint timestamps | `recording-integration`: exact ordinary screenshot options, immutable unique request references and real stored JPEG hashes; `extension/recording-v2.test.mjs` callback/identity tests |
| Warmup quiet window / startScreencast-derived origin | `recording-test-clock` drives actual preparation timers and observes the invocation resolving Started; controller startup suites require repeated coherent screenshots and original 10s budget |
| Latest unsolicited candidate queue / sampled and backpressure drops | `recording-repair-integration` stop-credit serial request-or-durable-write barrier; deadline-late exact request/response/rejection counts; no producer-paint drop inventions |
| Flush pre-stop candidate as final | stop-credit and all-format tests require a NEW correlated purpose=final screenshot after admission closes; actual final pixels and ceil-quantum presentation |
| R2 stopScreencast retry/ACK cleanup | guard/controller quarantine and boundaries suites: unresolved original RPC blocks replacement; no foreign detach; late completion inert. Integration checks no screencast/emulation command and immutable prior source after replacement |
| Legacy host `repair-r1-r2.test.mjs` screencast-specific fixtures | Explicitly skipped (not valid v2 producers); R1/R2 invariants remain required in routing, repair, quarantine and controller suites listed here |
| Captured mark numeric equality from controller through native/bridge/CLI | `host/src/recording/precision.test.mjs` now uses actual v2 guard/lease and correlated screenshot RPCs; both 10,006-value corpus tests remain active |
| R1 source-first Started replay | `host/src/recording/routing_tests.rs` source-first exact Started recovery and `v2_tests.rs` original startup-budget tests; `extension/recording-startup.test.mjs` idempotent replay/cancel; no obsolete CDP origin expectations |
| Receipt-time terminal duration | deadline-late hard cap/no post-cap final; lost-end actual durable final + null stop/counters/unknown-end lower bound; host/core interval and terminal validators |
| Legacy live v1 producer | Retired explicitly: new capture negotiates exact v2, mixed versions fail before target/allocation. Legacy OFFLINE reader retained: CLI legacy authentication/offline tests and actual all-format `tests_v2` encodes |
| Caller storage, hashes/chunks, fresh connections, no-clobber, release | `recording-integration` real bridge/fresh CLI, space/CJK paths, repeated immutable chunk reads, all formats, documented template, offline exact source bytes, no-clobber/release |
| Normal-owner stream safety | Actual guard refuses mutators during recording; all-format integration asserts no start/stop/ACK/emulation CDP; extension background/guard suites retain lifecycle-backed provenance and normal-owner coexistence checks |
| Safe stop on tied clock and late callbacks | stop-credit same-tick phase allowed before closure, subsequent phase rejected; deadline-late response discarded, original manifest unchanged after replacement; controller boundary suite regression/cancellation/quarantine |

Non-browser execution must enumerate audited tests, never use an extension
wildcard: `extension/annotate-ui.test.mjs` opens real Chrome and is excluded.
Live staging/readiness/state-oracle self-tests are pure fixtures, not live proof.
The browser-only live harness still needs a separately authorized v2 live port
and independent review before use; do not run its legacy screencast assertions.
