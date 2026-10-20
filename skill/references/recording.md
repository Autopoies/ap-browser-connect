# Recording and task watermarks

Sample **rendered page motion** with ordinary correlated CDP screenshots (protocol v2, backend `cdp_capture_screenshot`), not a compositor screencast or a site's source video/audio stream (for those, use [capture & download](capture-download.md)). For existing local GIF/MP4/MOV, go directly to [offline watermarking](#existing-video-offline): no browser connection, adapter lookup or launch. For live capture, preserve existing safety checks and adapter-first navigation/interaction from [SKILL.md](../SKILL.md).

**Workflow:** [preflight](#choose-storage-and-preflight) · [fixed clip](#fixed-clip) · [task capture](#capture-while-doing-a-task) · [recovery](#interruption-and-recovery) · [validation](#completion-and-retention) · [watermarks](#watermark-choices-and-provenance) · [offline](#existing-video-offline)

## Choose storage and preflight

1. The **calling Agent must choose and pass** the final video's `--out PATH` on the **calling CLI machine** before capture or export. Resolve relative paths from the caller's cwd; absolute paths outside the project are supported. Create the parent directory first. Every video-producing operation requires `--out`; start and stop without export return a handle/status, not a saved file.
2. Check local `ffmpeg` and `ffprobe` (for live browser work, `ap-browser doctor` includes capability checks; for offline work, use local `ffprobe -version`, `ffmpeg -encoders` and `ffmpeg -filters`). Recording needs libx264, GIF/PNG encoders and scale/palette filters; tools and fonts are never downloaded automatically. Check exact flags with `ap-browser record --help` and subcommand help. Verify the intended binary supports `record`; these source instructions do not imply an older installed CLI has it, and installation/update is a separate decision.
3. For live capture, select the intended browser/profile and tab explicitly. Matching v2 CLI/host/extension capabilities are required before capture; mixed/older components fail with an upgrade error, with no v1 fallback. Capture one tab viewport, a fixed CSS rectangle (`--region x,y,width,height`), or an element's initially visible bounds (`--element SELECTOR`). Element selection does not scroll or track movement. One capture per browser instance; no audio, desktop or full-page recording.
4. Use a lifecycle-proven clean, unemulated debugger attachment. Unknown pre-attached/emulated targets refuse; capture does not reset another owner's emulation, resize, force-focus or steal its screencast. Keep mapping/visibility stable: zoom, viewport changes or ambiguous DOM/CDP/JPEG mapping can fail capture. Background delivery and fresh compositor paint are not guaranteed.

Existing outputs and adjacent sidecar names are refused, including symlinks; there is no overwrite/force mode. Publication requires a destination filesystem supporting hard links. JSON returns resolved absolute artifact paths. Host private temporary source storage is separate from your chosen destination.

## Fixed clip

```sh
mkdir -p clips
ap-browser --profile work --tab 7 record --duration 6s --preset compact --label project=arena --label attempt=42 --run-id R042 --watermark task --out 'clips/run 42.mp4'
# Fixed rectangle in CSS viewport coordinates (not full-page coordinates):
ap-browser --profile work --tab 7 record --duration 3s --region 40,60,640,360 --out 'clips/region.gif'
# Alternative: initially visible element bounds, with no scrolling/tracking:
ap-browser --profile work --tab 7 record --duration 3s --element '#arena' --out 'clips/arena.mov'
```

Default fixed duration is 5 seconds; default maximum is 60 seconds. Capture is bounded. Formats follow the output suffix: GIF, MP4 or MOV. MP4/MOV use H.264/yuv420p, even-size padding and no audio; MP4 enables faststart.

| Preset | Target fps | Longest edge | CRF | GIF colors |
| --- | ---: | ---: | ---: | ---: |
| tiny | 4 | 480 | 34 | 32 |
| compact | 8 | 720 | 30 | 64 |
| balanced (default) | 15 | 1280 | 25 | 128 |
| high | 30 | 1920 | 20 | 256 |

Override with `--fps`, `--size`, `--crf`, `--colors`; `--capture-fps` and `--jpeg-quality` control source sampling separately. Resize preserves aspect ratio without default upscaling. Capture FPS is **best effort**, serially limited by screenshot/coherence latency and durable native credit, without catch-up backlog. Output FPS is a presentation target, not distinct-source FPS or a background-delivery guarantee. Watermarks/GIF are not size-reduction guarantees.

Each stored observation carries `request_id`, `purpose` (`sample` or `final`), `request_started_ms`, `response_received_ms` and `geometry_validated_ms`. Source `t_ms` is the actual response time on the extension clock, not exact paint time; the interval brackets the operation/validation and cannot prove when cached pixels were painted. Readonly before/after viewport facts and actual JPEG dimensions validate a frozen viewport-local crop; scroll/content motion alone is not a paint timestamp.

## Capture while doing a task

For game debugging, label project/build/seed/attempt, set a persistent phase for each stage, and mark short observations around the relevant action. Choose the output directory before starting; keep the same live host up until exports are validated.

```sh
mkdir -p clips
ap-browser --profile work --tab 7 record start --max-duration 60s --operation-id arena_attempt_42 --label project=arena --label build=abc --label seed=17 --label attempt=42 --run-id R042
# Copy data.handle (INSTANCE:HOST_EPOCH:RECORD_ID) from the returned JSON into HANDLE.
ap-browser record phase HANDLE --text 'air collision'
# Perform the intended page action via its adapter or approved generic command.
ap-browser record mark HANDLE --text 'observed overlap' --duration 2s
ap-browser record status HANDLE
ap-browser record stop HANDLE
ap-browser record export HANDLE --watermark task --out 'clips/attempt 42.gif'
# Repeat a clean export before releasing source:
ap-browser record export HANDLE --metadata --out 'clips/attempt 42 clean.mp4'
# Validate and retain both artifact sets as below, then:
ap-browser record release HANDLE
```

Alternatively, `ap-browser record stop HANDLE --watermark task --out 'clips/attempt 42.mov'` stops and exports together.

Handles pin the original browser instance, host epoch and tab; subsequent commands do not select a replacement active tab. Start/phase/mark accept `--operation-id` for intentional same-operation retries. Stop waits for the durable terminal barrier, not just a stop acknowledgment. A phase persists until changed (empty text clears it); a mark is transient with bounded display duration. Labels, phases and marks are caller assertions/notes, not verified application outcomes. Capture continues independently of CLI actions until stopped/deadline; actions are not automatically logged.

**Explicit stop** closes sample/phase/mark admission, settles the earlier admitted operation/write, then requests at most one genuine `final` screenshot within the **original** hard duration and one bounded 10s stop budget. A missing/invalid required final means failed/explicit partial, not silent completion. Observed end is final geometry validation, not later disk/encoder time. A fixed `--duration` uses this explicit-stop path; leave room before `--max-duration` if a final is needed.

**Automatic deadline** closes admission at the hard cap and starts no new final request. Valid pre-cap observations may drain; late responses are discarded, never backdated. A deadline source can be complete without a fresh final image. When a genuinely stored final would otherwise miss nominal output FPS, the exporter appends it at the ceiling container tick plus one tick of visibility (GIF 10ms, MP4/MOV 1ms), with actual duration extended by **strictly less than two ticks** beyond source cutoff. This exception does not apply to ordinary/deadline/legacy sources.

## Interruption and recovery

Reconcile on the **same live host epoch and IPC**, before generic connection rescue/reload:

- **Lost start reply (R1):** retry the exact `record start` command with the same `--operation-id`, explicit profile/tab and identical capture/label/run settings (e.g. the `arena_attempt_42` start above). This retrieves the existing operation's handle/status, not a second capture. Changed parameters conflict. Without an explicit ID, use the `operation_id` from the start error if available; a new ID is not reconciliation. The host makes at most one bounded replay to recover cached Started provenance; durable frames alone do not guarantee exportable provenance.
- Once a handle is available, inspect `record status HANDLE`; if still active, `record stop HANDLE` waits for terminal durable state. For an interrupted/failed recording with readable source, explicitly permit partial output:

  ```sh
  ap-browser record status HANDLE
  ap-browser record stop HANDLE
  ap-browser record export HANDLE --partial --watermark task --out 'clips/partial.mp4'
  ```

- **Unresolved screenshot RPC:** a timeout does not cancel Chrome's underlying operation. The original callback remains quarantined until actual completion or owned lifecycle clearance; a replacement can stay busy. Preserve/export readable partials and report uncertainty rather than detaching a normal owner or repeatedly starting replacements. An old handle/late callback cannot mutate or stop a replacement recording.
- **Lost End after durable final:** host storage may preserve `final_observation.disposition: "persisted_without_end"`. This remains failed/partial with `duration_observed: false`, `durable_lower_bound` cutoff and null stop/counters: neither exact stop nor actual recording end is recovered. A genuine stored final can still be shown by the final-visibility rule without promoting unknown-end provenance. Producer assertions alone cannot create this host-only disposition.

Partial export requires readable source on the **same live host epoch and IPC**. Retention is bounded (15 minutes while that host runs), not restart recovery. Tab closure, debugger detach or control failure can leave a readable partial on a live host. Native disconnect, host exit or restart can invalidate active **and sealed** handles immediately; `--partial` cannot recover missing bytes. Report transport/not-found/stale-host errors honestly. Already copied/published CLI artifacts survive later host loss. Release deletes retained source; copy needed exports before release/expiry. An unresolved original screenshot RPC can quarantine replacement capture until resource clearance is confirmed.

## Completion and retention

Complete only after successful CLI export **and artifact validation**, not start/stop/status alone:

1. Check exit status and `ok: true`; use returned `data.out` (resolved absolute video path), `data.metadata` and `data.timeline` (paths or null), `data.video` (`bytes`, `sha256`), `data.duration_ms`, `data.width`, `data.height`. Confirm the files exist at the Agent-chosen destination with nonzero size and matching hashes.
2. Check actual decoded media: format/codec, dimensions/crop, duration and presentation frames (e.g. local `ffprobe`); GIF is GIF, MP4/MOV are H.264 with even-size padding and no audio. Inspect representative frames/motion and watermark readability, phase/mark timing and crop boundaries against the task. A valid file alone does not prove the intended page/game event occurred.
3. Preserve video plus any metadata/timeline together. For task/custom or `--metadata`, verify matching export IDs, video/timeline hashes, labels/events and partial/end reason. Report partial or lower-bound duration honestly. A clean export with `--metadata` is useful for later offline provenance.
4. Retain clean source for all needed repeat exports and baked-watermark-free versions; export/validate them **before** `record release HANDLE` or expiry. Keep already published files and sidecars; release deletes host source, not caller artifacts. Report absolute paths, validation results and any uncertainty to the user.

## Watermark choices and provenance

Default `--watermark none` leaves the content clean. `--watermark task` (also `debug`) appends a task-management strip; it does not automatically collect URLs, form values, tokens or page text. Arbitrary bounded `--label key=value` and `--run-id` organize builds, seeds, attempts or test cases without hardcoded business fields.

Task/custom exports, or explicit `--metadata`, write `stem.metadata.json` and `stem.timeline.jsonl` beside the chosen video. Preserve the set: export IDs and hashes bind video, timeline and source snapshot. Output presentation order differs from source observations and codec packet order. Schema2 timeline rows retain exact `source: {seq,t_ms,observation}` references and `final_observation_visibility`; repeated sources denote normalization holds, not proven application stalls. Manifest counters count actual requests/responses/rejections/scheduling delays, not unrequested producer paints. Metadata preserves exact source JSON/hash, backend/intervals, observed end when known, actual encoded duration and partial reason; a durable lower bound is not an observed end.

Use `--watermark-config template.json` for Template v1 custom `strip` or `overlay` composition. Text is literal data with whitelisted placeholders, not expressions or FFmpeg filters. Example:

```json
{
  "version": 1,
  "layout": "strip",
  "strip_height": 48,
  "items": [
    {"text": {"kind": "template", "value": "{label.project} / {phase}"}, "anchor": "top_left", "x": 4, "y": 4, "font_size": 14, "color": "#ffffff", "opacity": 1.0, "update_interval_ms": 250}
  ]
}
```

Template v1 requires `version`, `layout`, `items`, and `strip_height` (16–512 pixels) for a strip; omit `strip_height` for overlay. Items require `text` (`{"kind":"literal","value":"..."}` or `template` as above), `anchor` (`top_left`, `top_right`, `bottom_left`, `bottom_right`, `center`), signed `x`/`y` offsets, `font_size` (6–128), `color` (`#RRGGBB`), `opacity` (0–1), and `update_interval_ms` (0–10000). Optional item fields: `font_path`, `background` (`#RRGGBB`), and `interval: {"start_ms":0,"end_ms":1000}`. Intervals and coordinates use output time/pixels, after resize.

Available placeholders: `{label.KEY}`, `{run_id}`, `{export_id}`, `{phase}`, `{marks}`, `{pts_ms}`, `{output_frame}`. Authentic recording source also enables `{record_id}`, `{source_seq}`, `{source_t_ms}`. Unknown/unavailable placeholders fail; use `{{`/`}}` for literal braces. Templates, items and text are bounded; validation errors report oversized/unsupported input.

Supply a readable CLI-local `--font PATH` (or item `font_path`) containing every requested glyph, especially CJK. Missing glyphs fail with an actionable error rather than silently producing tofu. Complex-script shaping and color emoji are unsupported; long text may clip on narrow canvases. Source images and page DOM remain unchanged; composition occurs after crop/resize/time normalization and before GIF palette generation.

## Existing video, offline

Take this branch directly: skip browser `ping`, profile discovery, adapters and browser launch. Check local `ffmpeg`/`ffprobe` and fonts; input, sidecars, template and output are all CLI-local. Choose a new `--out`, preserve the clean input, then apply the same artifact validation above.

```sh
mkdir -p clips
ap-browser record watermark input.mp4 --label build=abc --watermark task --out 'clips/labeled.mov'
ap-browser record watermark input.mp4 --sidecar input.metadata.json --timeline input.timeline.jsonl --watermark-config template.json --out 'clips/labeled.gif'
```

Offline input supports GIF/MP4/MOV. Authentic supplied sidecars must match or the operation fails. Valid legacy v1 source/artifact sidecars remain readable **offline only**: derived outputs keep schema1 and the original exact manifest bytes/hash, clock/drop semantics and provenance. V2 inputs retain schema2 request intervals; unknown versions or contradictory schemas fail instead of being reinterpreted. Without sidecars, only derivable video presentation facts and new caller labels exist (`offline_unverified`); original source sequence, sampling drops or action history are not invented. Re-encoding cannot remove an already baked-in watermark; use retained clean source for a clean export. Inputs and unrelated outputs are never overwritten. Ordinary failures clean private CLI staging; abrupt termination may leave a `.ap-record-*` directory in the chosen output parent.
