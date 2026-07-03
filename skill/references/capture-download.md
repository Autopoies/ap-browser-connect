# Capture & Download

Save and export content from web pages: files, videos, PDFs, archives, media, screenshots.

## Commands at a glance

| Command | What it does |
|---|---|
| `download <url>` | Download any file (auto-routes to best method) |
| `download <url> --video` | Download video via yt-dlp (1000+ sites) |
| `pdf` | Export page as PDF |
| `mhtml` | Save full page as single-file MHTML archive |
| `har` | Export captured network requests as HAR 1.2 |
| `media` | List all image/video/audio URLs on page |
| `screenshot --element <sel>` | Screenshot a specific element |

## download

```bash
# Regular file (auto: fetch for <5MB, browser for larger)
ap-browser download "https://example.com/document.pdf"
ap-browser download "https://example.com/large.zip" --out archive.zip

# Video (explicit — uses yt-dlp with Chrome cookies)
ap-browser download "https://www.youtube.com/watch?v=abc" --video
ap-browser download "https://www.bilibili.com/video/BV1abc" --video --audio-only
ap-browser download "https://vimeo.com/12345" --video --format "best[height<=720]"

# Force a specific method
ap-browser download <url> --method fetch       # small file, inline base64
ap-browser download <url> --method browser     # chrome.downloads
ap-browser download <url> --method yt-dlp      # force yt-dlp even for non-video
```

### When to use `--video`

Use `--video` when you want the **video stream**. Without it, `download` fetches the URL directly (which for a video page returns HTML, not the video).

Without `--video` on a video site URL, the CLI prints a hint but still proceeds:
```
hint: this looks like a video page. Use --video to download via yt-dlp.
```

### yt-dlp integration

When `--video` is specified, the CLI shells out to `yt-dlp` with `--cookies-from-browser chrome`, which reads the user's Chrome cookie store directly. This means:
- Private/unlisted videos → downloadable
- Member-only content → downloadable
- Login-walled content → downloadable

**Prerequisite**: yt-dlp must be installed (`pip install yt-dlp` or `brew install yt-dlp`).

If yt-dlp is not installed and `--video` is requested, the CLI returns a structured error with install instructions.

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

Returns a list of `{type, url, filename, source}` objects. `source` indicates where the URL was found: `img`, `css` (background-image), `srcset`, `video`, `video-source`, `audio`, `audio-source`.

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
