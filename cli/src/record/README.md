# Recording CLI implementation notes

Final videos are encoded **on the calling CLI machine**. All video-producing
operations require `--out PATH`; relative paths use that process's cwd. Writable
absolute paths, spaces and CJK names are supported. The parent directory must
exist. Nothing defaults to Downloads or a browser-host path. Existing video or
adjacent sidecar names (including symlinks) are always refused; no force option.
Private same-directory staging plus atomic no-clobber hard links publish the
video, timeline, then metadata; failures roll back newly published files. A
filesystem without hard-link support fails explicitly rather than weakening
no-clobber. The JSON response contains actual resolved absolute paths.

```sh
ap-browser --profile work --tab 7 record --duration 6s --preset compact --label project=arena --watermark task --out 'clips/run 42.mp4'
ap-browser record start --max-duration 60s --label scene=jump --run-id R042
# Copy the returned INSTANCE:HOST_EPOCH:RECORD_ID handle:
ap-browser record phase HANDLE --text 'air collision'
ap-browser record mark HANDLE --text 'observed overlap' --duration 2s
ap-browser record status HANDLE
ap-browser record stop HANDLE                         # durable status, not a video
ap-browser record export HANDLE --watermark task --out '/tmp/caller/run 42.gif'
ap-browser record stop HANDLE --out result.mov         # stop and export
ap-browser record release HANDLE
ap-browser record watermark input.mp4 --label build=abc --watermark task --out labeled.mp4
ap-browser record watermark input.mp4 --sidecar input.metadata.json --timeline input.timeline.jsonl --watermark-config template.json --out labeled.mov
```

`--operation-id` on start/phase/mark supports explicit idempotent retries. Handles
pin browser instance and host epoch; later commands never resolve a new active
tab/profile. Stop polls the seal barrier, not just the stop acknowledgment.
`--partial` is required for interrupted/lower-bound exports. Retained clean
source and partial exports are available only while the **same host epoch and
IPC remain alive**, and still expire or can be released. Tab close, debugger
detach or control failure may leave exportable partials on that live host.
Native disconnect, process exit or restart may make both active and sealed
sessions unavailable; there is no orphan retention daemon or cross-host recovery.
A new epoch cannot recover an old handle. CLI commands surface transport,
not-found and stale-host errors instead of fabricating source or a video. Files
already fully copied to the CLI and published artifacts are unaffected by later
host loss. CLI scratch is removed on ordinary success/failure. Abrupt process kill may leave a private
`.ap-record-*` staging directory in the chosen output parent; there is no promise
of cleanup after SIGKILL or host retention while the host is not running.

Formats are inferred from `.gif`, `.mp4`, `.mov` (case insensitive). Presets:
`tiny`, `compact`, `balanced` (default), `high`. Overrides: `--fps 1..30`,
`--size 16..3840` (longest content edge), `--crf 0..51`, `--colors 2..256`.
`--capture-fps` and `--jpeg-quality` are independent capture settings. The fixed
CSS `--region x,y,width,height` and `--element SELECTOR` are mutually exclusive.
There is no audio, full-page/desktop capture or element tracking.

Temporal normalization retains receipt timestamps, delayed initial frames and
holds to the observed end. Target fps is not a distinct-frame promise. A final
format-quantum hold sample makes the last duration explicit. GIF uses 10ms
quantization; H.264 uses 1ms and even-size padding (not stretched pixels), with
MP4 faststart. ffprobe verifies actual presentation frames/duration/dimensions
and no audio; sidecars use these actual times, not codec packet order. Holds
are not application stalls and silent CDP periods are not invented drops.

Task/debug are task-management strips, not capture diagnostics. Arbitrary
bounded `--label key=value`, `--run-id`, persistent phases and transient marks
are caller assertions, not verified outcomes. Full labels persist in metadata;
very long label key lists use a compact "see metadata" strip heading. Text can
clip to a small output canvas; custom layouts/font sizes control that tradeoff.
`--watermark-config` uses protocol Template v1 JSON (`strip` or `overlay`).
Whitelisted placeholders, intervals, anchors, opacity and per-item fonts are
validated. Substitution is one-pass, and literal text is rasterized by Rust
fontdue/image: **no text reaches a shell or FFmpeg filter expression**. GIF
palette generation happens after compositing, in a separate pass to avoid
buffering the entire decoded clip on a filtergraph split branch. A local drawtext/overlay filter
is not required because compositing is implemented in the CLI itself.

A readable CLI-local TTF/OTF/TTC font is required for text. Use `--font PATH` or
per-item `font_path`; CJK requires a font containing those glyphs. Missing glyphs
fail with the codepoint and an actionable font hint, never successful tofu. The
first face of a collection is used. Default font lookup checks common Arial,
DejaVu Sans and Liberation Sans system locations; fonts are never downloaded.
Resolved font paths are saved in the settings snapshot. Unique font files are
bounded to 64MiB total per template; repeated items share the loaded font. The rasterizer does not
implement complex-script shaping or color emoji. Invalid/missing fonts are
errors rather than a silent fallback to an unrelated face.

Local `ffmpeg` and `ffprobe` must be on PATH, with libx264, GIF/PNG encoders and
scale/palette filters. `doctor` reports their capability; executable, encoder,
filter and font checks run before capture where possible. Processes use argv,
bounded lifetime and bounded output. Reads validate recording identity, chunk
size/offset/base64/SHA-256, JPEG header/digest and the entire spool hash. Decoder,
frame/time, input snapshot, raw-RGB, encoded-video and normalized-image scratch
budgets are finite (512MiB per byte budget). Offline probing and decoding use an
owned immutable input snapshot, so paired hashes identify the exact bytes used. A large
offline input can require a smaller `--size` to fit the 512MiB raw decode budget.

Task/custom exports (or `--metadata`) save `stem.metadata.json` and
`stem.timeline.jsonl` beside the video. Fresh export IDs and video/timeline
hashes bind the set; exact source manifest snapshots preserve original clock,
observations, drops and events. Offline supplied sidecars must match hashes,
IDs, presentation mapping and source facts or fail. Without sidecars, provenance
is `offline_unverified`: only derived presentation facts and new caller labels
exist, never original source sequence/drops/action history. Offline re-encoding
cannot remove an already baked-in watermark; use the retained clean recording
for a clean repeat export while the same host epoch/IPC still retains it.

Tests: `cargo test -p ap-browser record::` includes real local ffmpeg/ffprobe
encodes and **fails rather than skipping** when those dependencies are missing.
All outputs are in private OS temporary directories. The local fake-host test
requires `AP_BROWSER_REMOTE` unset and fails before connecting if it is set, so
it cannot accidentally contact a configured external browser bridge. Optional test-only
`AP_RECORDING_TEST_ARTIFACTS=/absolute/existing/directory` preserves selected
synthetic outputs there for independent inspection. This is not live browser,
extension or native-host end-to-end evidence.
