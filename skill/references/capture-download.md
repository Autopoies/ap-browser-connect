# Capture & Download

Save and export content from web pages: files, source media, PDFs, archives and screenshots.

**Choose by intent:** download the site's original file/stream → `download` (use `--video` for video-site extraction); discover source URLs → `media`. Capture **what the page renders over time**, including a region/element or game-debug run → [recording](recording.md) for GIF/MP4/MOV, phases/marks, task watermarks and required Agent-chosen output/validation. Watermark an **existing local video** → that reference's [offline branch](recording.md#existing-video-offline), with no browser/adapter lookup or launch. Recording is not a substitute for source-media download.

## Commands at a glance

| Command | What it does |
|---|---|
| `download <url>` | Download any file (auto-routes to best method) |
| `download <url> --video` | Video-site extraction (Vimeo: page streams; other sites: yt-dlp) |
| `download --list` / `--auto` / `--pick <id>` | Discover/select files and HLS/DASH streams |
| `download --hls <master> --start <time> --duration <seconds>` | Download only a source-media interval via ffmpeg |
| `pdf` | Export page as PDF |
| `mhtml` | Save full page as single-file MHTML archive |
| `har` | Export captured network requests as HAR 1.2 |
| `media` | List all image/video/audio URLs on page |
| `screenshot --element <sel>` | Screenshot a specific element |
| `record` / `record watermark <input>` | Rendered video / offline task watermarks — [canonical recording workflow](recording.md) |

## download

```bash
# Regular file (auto: fetch for <5MB, browser for larger)
ap-browser download "https://example.com/document.pdf"
ap-browser download "https://example.com/large.zip" --out archive.zip

# Video (yt-dlp with Chrome cookies, except Vimeo's page-stream path)
ap-browser download "https://www.youtube.com/watch?v=abc" --video
ap-browser download "https://www.bilibili.com/video/BV1abc" --video --audio-only
ap-browser download "https://www.youtube.com/watch?v=abc" --video --start 00:01:00 --duration 120 --out clip.mp4
ap-browser download "https://www.bilibili.com/video/BV1abc" --video --start 00:01:00 --duration 120 --out clip.mp4
ap-browser download "https://vimeo.com/12345" --video --out video.mp4

# Force a specific method
ap-browser download <url> --method fetch       # small file, inline base64
ap-browser download <url> --method browser     # chrome.downloads
ap-browser download <url> --method yt-dlp      # force yt-dlp even for non-video
```

### When to use `--video`

Use `--video` when you want the **video stream**. On most video sites, omitting it fetches the page HTML. Vimeo URLs auto-discover the loaded player's streams instead; `--method yt-dlp` explicitly forces the external extractor.

Without `--video` on a video site URL, the CLI prints a hint but still proceeds:
```
hint: this looks like a video page. Use --video to download via yt-dlp.
```

### yt-dlp integration

For non-Vimeo sites, `--video` shells out to `yt-dlp` with `--cookies-from-browser chrome`. Availability depends on the site's extractor and the account's access; cookies do not guarantee extraction of private, member-only or login-walled media.

**Prerequisite**: yt-dlp must be installed (`pip install yt-dlp` or `brew install yt-dlp`).

If yt-dlp is not installed and `--video` is requested, the CLI returns a structured error with install instructions.

YouTube/Bilibili (and other supported extractors) accept `--video --start ... --duration ...` or `--end ...`. The CLI passes a bounded `--download-sections` request and `--force-keyframes-at-cuts` to yt-dlp; ffmpeg/ffprobe are required. Clips use a private workspace, duration validation and no-clobber publication. Choose a concrete `.mp4`/`.mov`/`.mkv` output, or `.mp3` with `--audio-only`; yt-dlp output templates and `--subtitles` sidecars apply to whole downloads only. Playlists are disabled, and extractor progress never contaminates the CLI's JSON stdout. This extractor route reads browser cookies directly and does not require the Chrome extension to be online. YouTube challenge/signature failures may require an updated yt-dlp plus its supported JavaScript runtime/EJS components; Bilibili initial-state failures may indicate extractor drift or site risk control. Report these as blocked downloads, not successful clips.

### MSE/blob players and source-media intervals

`download --list`, `--auto` and `media` share discovery: DOM media, Vimeo's in-page `window.playerConfig`, resource timing and captured network manifest URLs/MIME types. A `blob:` video handle is not a downloadable source. Network history covers requests made while the debugger was attached; it is not a promise to recover every MSE player. DRM streams are unsupported.

For Vimeo, prefer the exact player URL (including `?h=...` for an unlisted video), or pass an already-loaded player tab. A supplied page URL without `--tab` opens an owned silent tab and closes it afterward; the CLI preserves an embedded Vimeo player's hash when following its iframe. It reads the page configuration, not the often-forbidden HTTP `/config` endpoint, and does not depend on Vimeo's yt-dlp extractor.

```bash
# Loaded player: select the default HLS master and fetch only two minutes
ap-browser download --auto --tab 123 --start 01:29:00 --duration 120 --out clip.mp4
# Or give the full player/page URL; no manual source extraction needed
ap-browser download "https://player.vimeo.com/video/12345?h=UNLISTED_HASH" --auto --start 01:29:00 --end 01:31:00 --out clip.mp4
# Explicit signed HLS URL: works without Chrome unless --tab is supplied for headers/cookies
ap-browser download --hls "https://cdn.example/master.m3u8?signature=..." --start 01:29:00 --duration 120 --out clip.mp4
# Select a labeled resolution/bandwidth; --pick keeps the master's separate audio group
ap-browser download --list --tab 123
ap-browser download --pick 4 --tab 123 --start 5340 --duration 120 --out clip.mp4
```

Requires local `ffmpeg` and `ffprobe` (`brew install ffmpeg` or the system package manager). Time values accept seconds or `HH:MM:SS[.mmm]`; `--ss` aliases `--start`, and `--to` aliases `--end`. `--end` and `--duration` are exclusive. Intervals use input seeking and H.264/AAC re-encoding, not keyframe-only stream copy or a full-video download; whole streams are remuxed. Direct `.m3u8`/`.mpd` URLs also use this path.

HLS variant entries include `resolution`, `bandwidth`, `fps`, `program_index` and `variant_url`; their `url` remains the master so selecting video does not lose external audio. DASH entries expose the master and available config quality labels. If the manifest cannot be fetched from the page (e.g. CORS), its master remains listed without parsed HLS variants. Signed URLs expire: refresh `--list` before retrying. Use the same tab/profile for `--list` and `--pick`; an empty list clears previous selections.

The stream path reconnects on network errors, retries HLS segments when supported by the installed ffmpeg, and checks output duration before publishing a bounded clip. Failure leaves no final file; existing output files are not overwritten. `--format`, `--subtitles` and `--cookies-from` belong to yt-dlp, not this path; use `--list/--pick` and `--profile` for page streams.

### Silent downloads (no browser UI)

Downloads use CDP `Page.setDownloadBehavior` when a target path is provided via `--out`. This downloads directly to the specified directory without showing Chrome's download bar or "Save As" dialog. If `--out` is omitted, downloads go to the current working directory silently.

```bash
ap-browser download "https://example.com/file.pdf" --out /tmp/paper.pdf
# → file saved to /tmp/paper.pdf, no popup, no download bar
```

### Download discovery config

The `--list` and `--auto` heuristics are configurable via `~/.ap-browser/download-config.yml`. Edit this file to add custom file extensions or URL patterns for sites you work with frequently.

```yaml
# ~/.ap-browser/download-config.yml

extensions:
  ".pdf": pdf
  ".zip": archive
  # Add custom extensions:
  ".myformat": custom

url_patterns:
  "/download/": download
  "/pdf/": pdf
  # Add custom patterns for sites you use:
  "/custom-api/export/": export
  "/dataset/": dataset
```

- **extensions**: map of file extension → type label. Links ending with these extensions are detected as downloadable.
- **url_patterns**: map of URL path fragment → type label. Links containing these path segments are detected as downloadable.
- **Defaults are baked in**: your config **merges** with defaults — you only need to list additions or overrides.
- **Type labels** are arbitrary strings used by `--pick <type>` for fuzzy matching.

To extend for a new site (e.g. a journal with custom download URLs):
1. Browse the site with `ap-browser download --list` to see what's detected
2. If something is missing, add its URL pattern to `download-config.yml`
3. Re-run `--list` to verify your new pattern works

## pdf

```bash
ap-browser pdf                           # → page.pdf (A4 portrait)
ap-browser pdf --out invoice.pdf         # custom filename
ap-browser pdf --landscape --format Letter
```

PDFs are saved to the browser's Downloads directory via `Page.printToPDF`. Dynamic content (JS-rendered) is captured at current state.

## mhtml

```bash
ap-browser mhtml                          # → page.mhtml
ap-browser mhtml --out receipt.mhtml
```

MHTML is a single-file archive containing the full page (HTML + CSS + images + JS state). Openable in Chrome/Edge/Firefox. Captures the **current DOM state** (post-JavaScript render), not the original source.

## har

```bash
ap-browser har                            # → page.har
ap-browser har --out debug.har --tab 123
```

Exports captured network requests (from dev mode's network buffer) as HAR 1.2 format. Importable in Chrome DevTools, Charles Proxy, Wireshark.

**Note**: only requests captured while the debugger was attached are included. Navigate + interact before exporting.

## media

```bash
ap-browser media                          # all media types
ap-browser media --type image             # images only
ap-browser media --type video             # video sources only
ap-browser media --type audio             # audio sources only
```

Returns `{type, url, filename, source}` objects, plus stream metadata when available. Sources include `img`, `css`, `srcset`, `video`, `video-source`, `audio`, `audio-source`, `player-config`, `performance` and `network`. HLS/DASH manifests are video media; browser-local `blob:` handles are omitted.

Use with `download` to fetch individual media files:
```bash
ap-browser media --type image --format ndjson | head -1 | jq -r .url | xargs ap-browser download
```

## screenshot --element

```bash
ap-browser screenshot --element ".video-card" --out card.png
ap-browser screenshot --element "#header" --tab 123
```

Captures only the bounding box of the matched element. The element is scrolled into view first. If the selector matches nothing, the command errors.

Without `--element`, the existing `screenshot` behavior (full viewport or `--full` page) is unchanged.

## Common workflows

### Download a YouTube video
```bash
ap-browser download "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --video
```

### Download audio from Bilibili
```bash
ap-browser download "https://www.bilibili.com/video/BV1abc" --video --audio-only
```

### Save a receipt page as PDF
```bash
ap-browser goto "https://shop.example.com/receipt/123"
ap-browser pdf --out receipt.pdf
```

### Archive a page for offline analysis
```bash
ap-browser goto "https://important-article.com"
ap-browser mhtml --out article.mhtml
```

### Debug failing API calls
```bash
ap-browser dev console clear
ap-browser goto "https://app.example.com"
ap-browser har --out debug.har
ap-browser dev errors
```

### Extract all images from a page
```bash
ap-browser media --type image --format ndjson | jq -r .url | while read url; do
  ap-browser download "$url"
done
```
