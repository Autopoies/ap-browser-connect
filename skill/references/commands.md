# Command Reference

Full parameter details, flags, and examples for all 22 commands.

## Global flags (all commands)

| Flag | Type | Description |
|------|------|-------------|
| `--profile <id\|label>` | string | Target a specific profile for this one command |
| `--tab <ID>` | integer | Operate on a specific tab (default: active tab of focused window) |
| `--window <ID>` | integer | Restrict to a window |
| `--human` | flag | Human-readable output instead of JSON |
| `--timeout <secs>` | integer | Response timeout (default 30) |

---

## Meta

### `ping`
Health check. Returns `{pong: true}`.

```bash
ap-browser ping
```

### `status`
Lists how many extension instances are online and their active tabs.

```bash
ap-browser status
```

### `profiles`
Enumerates all online Chrome profiles by scanning `/tmp/ap-browser-*.sock`.

```bash
ap-browser profiles
# → [{"instance_id":"a1b2…","label":"Work","active_tab_url":"https://slack.com","active_tab_title":"#general"}]
```

### `use <instance_id|label>`
Sets the default profile. Writes to `~/.ap-browser/current`. Can be overridden by `AP_BROWSER_PROFILE` env var.

```bash
ap-browser use Work
ap-browser use a1b2c3d4-e5f6-...
```

---

## Tabs

### `tabs list`
List open tabs. Supports filtering.

| Flag | Description |
|------|-------------|
| `--filter <regex>` | Filter by URL or title (case-insensitive regex) |
| `--group <name>` | Only tabs in a named tab group |
| `--grouped` | Only tabs that belong to any group |
| `--window <ID>` | Only tabs in a specific window |

```bash
ap-browser tabs list
ap-browser tabs list --filter "github"
ap-browser tabs list --group "Research"
```

Each tab object: `{id, url, title, window_id, active, pinned, group}`.

### `tabs new [<url>]`
Create a new tab. Optional URL.

```bash
ap-browser tabs new
ap-browser tabs new "https://example.com"
```

Returns `{id, url, title, window_id}`.

### `tabs close <ID>`
Close a tab by ID.

```bash
ap-browser tabs close 42
```

### `tabs activate <ID>`
Bring a tab to focus (within its window).

```bash
ap-browser tabs activate 42
```

### `tabs get <ID>`
Get details of a specific tab.

```bash
ap-browser tabs get 42
# → {id, url, title, window_id, active, pinned}
```

---

## Navigation

### `goto <url>`
Navigate the active tab (or `--tab`) to a URL.

```bash
ap-browser goto "https://news.ycombinator.com"
ap-browser --tab 42 goto "https://example.com"
```

Returns `{tab_id, url}`.

### `back` / `forward` / `reload`
Browser history controls on the active (or `--tab`) tab.

```bash
ap-browser back
ap-browser --tab 42 reload
```

---

## Read

### `text`
Read `innerText` of an element. Default selector: `body`.

| Flag | Description |
|------|-------------|
| `--selector <CSS>` | Element to read (default `body`) |
| `--full` | Disable 50000-char truncation |
| `--range <start:end>` | Read a byte-offset slice |

```bash
ap-browser text
ap-browser text --selector ".article-body"
ap-browser text --full
ap-browser text --range 50000:100000
```

Response includes: `{text, truncated, total_chars, returned_chars, range}`.

### `html`
Same as `text` but returns `outerHTML`. Default selector: `html`.

```bash
ap-browser html --selector "#content"
ap-browser html --range 0:10000
```

### `screenshot`
Capture a PNG screenshot.

| Flag | Description |
|------|-------------|
| `--out <file>` | Output path (default `screenshot.png`) |
| `--full` | Capture full page (not just viewport) |

```bash
ap-browser screenshot --out /tmp/page.png
ap-browser screenshot --full --out /tmp/full.png
```

Returns `{tab_id, data_url, bytes}`. The file is also written to `--out`.

---

## Interact

### `click <CSS>`
Click the first element matching the selector. Scrolls into view first.

```bash
ap-browser click "#submit-button"
ap-browser click ".storylink"
```

Error `SELECTOR_NO_MATCH` (exit 4) if element not found.

### `fill <CSS> <value>`
Set the value of an input, textarea, or select. Dispatches `input` + `change` events.

```bash
ap-browser fill "#search-box" "machine learning"
ap-browser fill "#email" "user@example.com"
```

### `press <key>`
Send a key event. Supports named keys and combos.

```bash
ap-browser press Enter
ap-browser press Tab
ap-browser press "Control+a"
```

### `wait <CSS>`
Poll until the selector matches an element, or timeout.

| Flag | Description |
|------|-------------|
| `--timeout <ms>` | Max wait (default 5000) |

```bash
ap-browser wait ".results"
ap-browser wait ".loaded" --timeout 10000
```

Returns `{matched: true, waited_ms}`. Throws `TIMEOUT` (exit 5) if not found.

---

## Power

### `eval "<js>"`
Execute JavaScript in the page via CDP `Runtime.evaluate`. Uses `awaitPromise: true`.

```bash
ap-browser eval "document.title"
ap-browser eval "Array.from(document.querySelectorAll('a')).map(a=>a.href)"
ap-browser eval "await fetch('/api/data').then(r=>r.json())"
```

Returns `{result: <value>}`. Error `JS_EXCEPTION` (exit 4) if the expression throws.

**Prefer `eval` over `text`/`html` when you need:**
- Arrays or structured data from multiple elements
- Computed values (counts, attributes, styles)
- Fetching data from the page's own API endpoints

### `cdp <method>`
Raw Chrome DevTools Protocol passthrough. Full method list: https://chromedevtools.github.io/devtools-protocol/tot/

| Flag | Description |
|------|-------------|
| `--params <json>` | Method parameters as JSON string |

```bash
ap-browser cdp "Network.getCookiesForUrl" --params '{"url":"https://example.com"}'
ap-browser cdp "DOMSnapshot.captureSnapshot" --params '{"computedStyles":[]}'
```

Returns `{result: <cdp-response>}`.
