# Command Reference

Full parameter details, flags, and examples for all 22 commands.

## Global flags (all commands)

| Flag | Type | Description |
| ------ | ------ | ------------- |
| `--profile <id\|label>` | string | Target a specific profile for this one command |
| `--tab <ID>` | integer | Operate on a specific tab (default: active tab of focused window) |
| `--window <ID>` | integer | Restrict to a window |
| `--human` | flag | Human-readable output instead of JSON |
| `--timeout <secs>` | integer | Response timeout (default 30, maximum 3600). Works on every command incl. adapters and dev; overrides an adapter's own `timeout`. |

Global flags work **before or after the command** — `ap-browser --tab 5 goto <url>` and `ap-browser goto <url> --tab 5` are equivalent (this includes adapter commands like `ap-browser --tab 5 hackernews top`).

**Adapter commands auto-isolate tabs.** Without `--tab`, an adapter runs on the active tab only when its host already matches the adapter's site domain (reads the page the user is on); otherwise it silently opens its own tab on the canonical domain. An explicit `--tab <ID>` always wins and never auto-opens.

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
| ------ | ------------- |
| `--filter <regex>` | Filter by URL or title (case-insensitive regex) |
| `--group <name>` | Only tabs in a named tab group |
| `--grouped` | Only tabs that belong to any group |
| `--window <ID>` | Only tabs in a specific window |

```bash
ap-browser tabs list
ap-browser tabs list --filter "github"
ap-browser tabs list --group "Research"
```

Each tab object: `{id, url, title, window_id, active, pinned, group}`. A tab with user-pinned annotations additionally shows `annotations: <count>` — when any tab has it, run `state` on that tab and read its `annotated` array before answering questions about the page.

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
| ------ | ------------- |
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
| ------ | ------------- |
| `--out <file>` | Output path (default `screenshot.png`) |
| `--full` | Capture full page (not just viewport) |
| `--annotate` | Overlay red boxes + `[N]` badges over interactive elements (from `state` refs) |

```bash
ap-browser screenshot --out /tmp/page.png
ap-browser screenshot --full --out /tmp/full.png
ap-browser screenshot --annotate --out /tmp/annotated.png
```

Returns `{tab_id, file, bytes, annotated}`. PNG base64 is never emitted to stdout when the file is written. `--annotate` composites the badges deterministically after capture (the badge numbers match `state` refs 1:1).

---

## Annotation mode

`Command+Shift+A` on mac / `Alt+Shift+A` elsewhere (or the popup button) toggles an in-page annotation picker on the active tab: hover any visible element to preview it (blue dashed box), click to pin it (green box + badge), click a pinned element to unpin. Multi-line elements get one closed box per line; the small floating panel lists only the pinned elements, with a `×` button to exit the mode (pins stay visible to agents). `ap-browser dev annotate [--tab <id>]` injects the picker into a specific tab (e.g. a silent tab) without touching the active one.

Pinned elements may be interactive (they carry a `state` ref) or not (located by CSS `selector`); `state`'s `annotated` entries carry `{ref|null, selector, name}` and screenshot --annotate draws green boxes for both.

Agent-visible effects:

- `state` output gains `annotated: [{ref, name, ts}]` for the user's checked elements; the matching elements in `elements[]` also carry `"user": true`
- `screenshot --annotate` renders user-checked elements as **green** boxes/badges; plain state refs stay red

Semantics: checked refs share the ref numbering of `state` (same selector/order). If the page navigated since checking, refs may have shifted — match by `name` after a fresh `state`.

## State

### `state`

The discovery primitive: snapshot of every visible interactive element with a stable `[N]` ref, tag, role, name, and viewport coordinates.

```bash
ap-browser state
ap-browser state --human          # compact text tree: [N] tag name (y=...)
```

Returns `{elements: [{ref, tag, role, name, x, y, w, h}], scroll: {y, h, vh, vw}, url}`. Refs are tagged into the DOM (`data-ap-ref`) and consumed by `click`/`fill`/`wait` with a numeric target. A page change invalidates refs (`STALE_REF`) — re-run `state`. **Scrolling does NOT change ref numbers** (they follow document order); only navigation/DOM changes invalidate them — but `y` coordinates are viewport-relative, so re-run `state` after scrolling if you need fresh coordinates.

---

## Interact

### `click <target>`

Click the first element matching the target. Target is either a **`state` ref** (bare integer, e.g. `12`) or a **CSS selector**. Scrolls into view first.

```bash
ap-browser click 12               # state ref
ap-browser click "#submit-button" # CSS selector
```

Clicks use **real CDP input events** (mouse move/press/release at the element center) so SPA custom controls that ignore `el.click()` work — with a `js-click` fallback when the element center is covered. Response includes the method used: `{clicked: true, method: "native-input"|"js-click"}`.

Error `SELECTOR_NO_MATCH` (exit 4) if a selector matches nothing; `STALE_REF` (exit 4) if a ref is gone (page changed — run `state` again).

### `fill <target> <value>`

Type a value into an input, textarea, **or contenteditable** (rich editors, comment boxes) using real keystrokes (`Input.insertText`) — replaces existing content. Target is a `state` ref or CSS selector.

```bash
ap-browser fill 7 "machine learning"    # state ref
ap-browser fill "#search-box" "machine learning"
```

Response includes the typed value read back from the field: `{filled: true, method: "native-insert", value: "..."}` — compare it against what you sent; React controlled inputs and masked fields can silently eat characters.

### `select <target> <option>`

Pick an option from a native `<select>` by **value or visible label**. Target is a `state` ref or CSS selector.

```bash
ap-browser select 12 "Beta"              # by label
ap-browser select "#country" "us"       # by value
```

Native `<select>` dropdowns are OS-level widgets, so selection is done via DOM mutation + change event (same semantics React/Vue listen to). Response: `{selected: {value, label}, method: "dom-select"}`.

Error `OPTION_NOT_FOUND` (exit 4) includes the real options in `error.data.available` — pick one and retry. `NOT_A_SELECT` means it's a custom (div-based) dropdown — use `click`/`eval` for those. Also available as an adapter step: `- select: {selector: ..., option: ...}`.

### `press <key>`

Send a key event. Supports named keys and combos.

```bash
ap-browser press Enter
ap-browser press Tab
ap-browser press "Control+a"
```

### `wait [<CSS>]`

Wait for a selector, element disappearance, JavaScript condition, URL navigation, or media completion. All modes run inside the browser extension with hardlimit timeout protection, so agents never need shell sleep loops.

| Flag | Description |
| ------ | ------------- |
| `--timeout-ms <ms>` | Max wait (default 5000); the RPC timeout is extended automatically |
| `--interval-ms <ms>` | Polling interval for condition checks (default 1000) |
| `--until-eval <JS>` | Wait until JavaScript expression returns truthy (e.g. `!document.querySelector('.loading')`) |
| `--gone <CSS>` | Wait until the matching element is removed from the DOM (e.g. spinner/stop-button disappearance) |
| `--url-change-from <URL>` | Wait until the tab leaves this URL, across page execution contexts |
| `--media-ended` | Wait for the selected media element (default `video`) to end; navigation after playback also succeeds |

```bash
ap-browser wait ".results"
ap-browser wait ".loaded" --timeout-ms 10000
ap-browser wait --gone "button[data-testid='stop-button']" --timeout-ms 300000
ap-browser wait --until-eval "document.title.includes('Done')" --timeout-ms 60000
ap-browser wait --url-change-from "https://example.com/lesson/1" --timeout-ms 180000
ap-browser wait --media-ended --timeout-ms 180000
ap-browser wait "audio.preview" --media-ended --timeout-ms 60000
```

Returns `{matched: bool, completed: bool, reason, waited_ms, current_status?}`.

When the target condition is met within the time budget, it returns `completed: true` with `reason: "condition_met" | "element_gone" | "selector_matched" | "url_changed" | "media_ended" | "xhr_completed"`.

When the wait deadline is reached while an operation is still in-flight, it returns `completed: false, reason: "deadline_reached"` along with the intermediate state in `current_status` and `meta.hint` — allowing the Agent to decide next steps (continue waiting, read partial progress, or check back later) without raising errors.

#### Adapter wait-until-done

For long-running site operations (like ChatGPT, Deep Research, generation tasks):

- Pass `--wait` directly to the adapter command: `ap-browser chatgpt send "..." --wait`
- Or use the dedicated site wait command: `ap-browser chatgpt wait --timeout 300`
- Long-running commands automatically return `meta.hint` recommending `--wait` when omitted.

---

### `scroll`

Scroll the page (or a specific element into view).

| Flag | Description |
| ------ | ------------- |
| `--count <n>` | Number of wheel scrolls (default 1, max 50) |
| `--pause-ms <n>` | Pause between scrolls (default 800) |
| `--selector <css>` | Scroll this element into view instead of wheeling |

```bash
ap-browser scroll
ap-browser scroll --count 5 --pause-ms 300
ap-browser scroll --selector ".results"
```

Returns `{scrolled_count, scrolled: [true|false, ...]}` — one entry per wheel step. A `false` entry means that wheel step produced no movement (e.g. the page has no scroll space because content fits the viewport, or the scrollbar is already at the end) — the command itself succeeded.

## Power

### `eval "<js>"`

Execute JavaScript in the page via CDP `Runtime.evaluate`. Uses `awaitPromise: true`. **First-class for scripting, fallback for interaction.** eval runs outside site-filter protection — deliberate for scripting, never to cross a `FILTER_DENIED`.

```bash
ap-browser eval "document.title"
ap-browser eval "Array.from(document.querySelectorAll('.product')).map(p => p.innerText)"
ap-browser eval "window.__INITIAL_STATE__"
ap-browser eval "await fetch('/api/data').then(r => r.json())"
```

Returns `{result: <value>}`. Error `JS_EXCEPTION` (exit 4) if the expression throws.

**Wrap multi-statement expressions in an IIFE** — top-level `const` declarations or bare object literals throw `JS_EXCEPTION` (CDP evaluates them as statements, not scripts):

```bash
ap-browser eval "(() => { const s = document.querySelector('#x'); return {value: s.value}; })()"
```

**eval is the right tool for:**

- Structured/scripted extraction (mapping many elements to a compact array)
- Reading page JS state (framework data on `window`)
- The page's own API endpoints (`await fetch(...)`)
- Escape hatch when a semantic command fails on a tricky control

**Prefer `state`/`click`/`fill`/`text` for:**

- Interaction — semantic commands return structured results, refs, and `STALE_REF` diagnostics; eval writes are opaque
- Discovery — "what's here / what's at this position" is `state` + `screenshot --annotate`

### `cdp <method>`

Raw Chrome DevTools Protocol passthrough. Full method list: <https://chromedevtools.github.io/devtools-protocol/tot/>

| Flag | Description |
|------|-------------|
| `--params <json>` | Method parameters as JSON string |

```bash
ap-browser cdp "Network.getCookiesForUrl" --params '{"url":"https://example.com"}'
ap-browser cdp "DOMSnapshot.captureSnapshot" --params '{"computedStyles":[]}'
```

Returns `{result: <cdp-response>}`.
