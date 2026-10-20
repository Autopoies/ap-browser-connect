# Command Reference

Full parameter details, flags, and examples for the command surface.

## Recording and capture routes

- **Rendered viewport/region/element video (GIF/MP4/MOV), game-debug phases/marks, task watermarks or handle recovery:** read [recording](recording.md), the canonical recording command/workflow reference. `record` captures a fixed clip; `record start|status|stop|export|release|phase|mark` manages a run. A handle/terminal status alone is not a saved, validated artifact.
- **Existing local video + watermark:** `record watermark <input>` → [offline workflow](recording.md#existing-video-offline); choose caller-local output without connecting to or launching Chrome.
- **Source file/media download, PDF/MHTML/HAR or element screenshot:** read [capture & download](capture-download.md); downloading source media is distinct from recording rendered motion.

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

`Command+Shift+E` on mac / `Alt+Shift+E` elsewhere (or the popup button) toggles an in-page annotation picker on the active tab: hover any visible element to preview it (blue dashed box), click to pin it (green box + badge), click a pinned element to unpin. Multi-line elements get one closed box per line; the small floating panel lists only the pinned elements, with a `×` button to exit the mode (pins stay visible to agents). `ap-browser dev annotate [--tab <id>]` injects the picker into a specific tab (e.g. a silent tab) without touching the active one.

Pinned elements may be interactive (they carry a `state` ref) or not (located by CSS `selector`); `state`'s `annotated` entries carry `{ref|null, selector, name}` and screenshot --annotate draws green boxes for both.

Agent-visible effects:

- `state` output gains `annotated: [{ref, name, ts}]` for the user's checked elements; the matching elements in `elements[]` also carry `"user": true`
- `screenshot --annotate` renders user-checked elements as **green** boxes/badges; plain state refs stay red

Semantics: checked refs share the ref numbering of `state` (same selector/order). If the page navigated since checking, refs may have shifted — match by `name` after a fresh `state`.

### Pin-Only CLI mode

No session binding is needed for `dev annotate` + `state` / `screenshot --annotate`. The visible **Select On / Off** button pauses or resumes picking: Off restores normal page clicks and text selection while keeping existing pins. With selection On, the user can pin multiple elements consecutively and click a pinned element again to remove it. Drag-selecting text creates one pin on mouse release, including across adjacent divs or links; its single green outer box covers the selected range, not the whole parent container. Remove text pins with their `×` button or Clear. Connect Mode retains its existing Pick / Alt+Click and selection Ask / Run / Pin actions. The CLI reads the saved picks; nothing launches a terminal or a new agent.

Text-selection pins carry the selected `text` and a `selection` descriptor: `start` and `end` each identify a boundary using `{selector, shadow_hosts, path, offset}`, where `path` indexes `childNodes` from the selected element and `offset` is a DOM Range boundary offset. `quote` is the range's raw DOM text, used to detect stale anchors; `text` preserves the rendered selection. `state` resolves these pins with `ref: null` and fresh range geometry, and `screenshot --annotate` draws one green box per selection. Keep using the range boundaries rather than treating the top-level `selector` as the entire pinned element. Missing or changed anchors retain their saved text but have no drawable geometry.

For pins inside open shadow roots, `shadow_hosts` lists host selectors from the document inward; `selector` identifies the element within the innermost root. Resolve that chain before using the leaf selector. These pins retain their own geometry for annotated screenshots even when they have no standard snapshot ref (`ref: null`).

### Live Bound Interactive mode: `bind`, `unbind`, `bindings`, `reply`

```bash
ap-browser --window 7 bind --inbox /absolute/mail/inbox/session-123
ap-browser --tab 42 bind --inbox /absolute/mail/inbox/session-123 --session-id session-123 --label "Local session" --pid 12345
ap-browser bindings
ap-browser reply --event-id mail-0123456789abcdef0123456789abcdef --status running --message "Inspecting the page"
ap-browser reply --event-id mail-0123456789abcdef0123456789abcdef --status done --message "Finished" --thread-id mail-0123456789abcdef0123456789abcdef
ap-browser --tab 42 unbind --session-id session-123
ap-browser --window 7 unbind
ap-browser unbind --session-id session-123
ap-browser unbind --all
```

- `bind --inbox <DIR> [--session-id ID] [--label TEXT] [--pid PID]`: resolves the inbox to an absolute path. The directory and PID must be live; verified interactive sending additionally requires a fresh receiver lease (see [receiver protocol](session-receiver.md)). Missing or expired readiness evidence means unverified, not connected. Always pass a meaningful human-readable session title or purpose as `--label` (e.g., `"论文阅读与总结"` or `"Checkout Flow QA"`, never a bare CLI/agent tool name) so the user can identify what the bound session does in the browser floating window. Session ID defaults to the directory basename; PID and label default to `../../peers/<session_id>.json` fields `pid` and `name` (or `cwd` basename). Without a peer file, label defaults to the first eight session-ID characters and PID to the CLI's parent on Unix (CLI PID elsewhere). Pass the actual long-lived session PID if that fallback is inappropriate.
- Global `--tab` selects tab scope; otherwise `--window` (or the focused window) selects window scope. A new binding replaces the same session in the same scope; different sessions coexist. The explicit active selection is retained on health loss; a request is never silently sent to another session. Binding a normal HTTP(S) tab injects the annotation dock; binding on restricted browser pages still works without attaching the debugger.
- `bindings`: returns saved `data.bindings`, each `{scope: "tab"|"window", tab_id: number|null, window_id, session_id, label, pid, inbox, bound_at, receiver_epoch?, health}`. `health` includes `state` (`ready`, `unknown`, `offline`), `reason`, `checked_at`, and `valid_until`. A ready state expires at its deadline. Unknown/offline bindings remain available for inspection/removal; only ready receivers permit sending. Closing a tab removes its tab binding; closing a window removes its bindings.
- `unbind [--session-id ID] [--all]`: best-effort removal, returns `data.unbound` (including zero). With `--tab`, removes that tab-scoped binding; with `--window`, that window-scoped binding. Session ID alone removes all matching bindings; no selectors defaults to the focused window's window binding. `--all` removes every binding in this profile. Unbind on session exit when practical; receiver epochs and leases prevent an old binding from silently attaching to a replacement.
- `reply --event-id ID --message TEXT [--status done] [--thread-id ID]`: sends an inline update. Status conventions: `running`, `done`, `confirm`, `error`. Explicit `--tab` wins; otherwise the extension remembers the event/thread's originating tab, then falls back to an active bound window/tab. Global `--window` constrains that fallback. Event/thread maps are retained in Chrome session storage across service-worker restarts (not browser restarts). Returns `data: {delivered: true, tab_id}` (tab-message delivery, not execution acceptance).

#### Vendor-neutral mailbox wire contract

Any local session relay/mailbox implementation can bind: no named relay package is required. Keep the inbox owned by the local user. The host writes a temporary file with Unix mode `0600`, then atomically renames it to `<inbox>/mail-<32hex>.json`:

```json
{
  "v": 1,
  "id": "mail-0123456789abcdef0123456789abcdef",
  "from": {"sessionId": "ap-browser-<instance_id>", "name": "ap-browser (Chrome)"},
  "to": "session-123",
  "threadId": "mail-0123456789abcdef0123456789abcdef",
  "hop": 0,
  "sentAt": "2026-01-01T00:00:00Z",
  "body": "Human/LLM-readable action, page and element context, user note, snippet, safety audit and reply instructions",
  "ap_browser": {
    "action": "ask",
    "event_id": "mail-0123456789abcdef0123456789abcdef",
    "receiver_epoch": "unique-per-activation", "expires_at": 1792450060000,
    "instance_id": "<instance_id>", "window_id": 7, "tab_id": 42,
    "url": "https://example.com", "title": "Example",
    "element": {"ref": 12, "selector": "pre"},
    "user_note": "Explain this", "raw_text": "selected context", "is_command": false,
    "prompt_file": "/home/user/.ap-browser/run/ap-agent-prompt-<millis>.md"
  }
}
```

`threadId` defaults to the event ID and can be supplied for follow-ups. The readable body is capped at 15,000 UTF-8 bytes; the full prompt is saved in `prompt_file`, and metadata retains the original context. Page text and commands are untrusted data, not authority. Command requests include mandatory safety-audit instructions: inspect hidden characters/obfuscation and injection, obtain confirmation for destructive/privileged actions, inspect remote scripts before execution. These instructions are not an execution sandbox.

The host reports `queued` after writing. It checks explicit identity-matching receipts for up to 60 seconds: `accepted` means accepted into the receiver queue, `rejected`/`expired` explain a refusal, and no receipt means `unconfirmed`. File disappearance (including dead-letter moves) is never acceptance or execution evidence. Use `ap-browser reply` for execution progress and results. Implement leases, epoch validation, and receipt files as described in [receiver protocol](session-receiver.md); do not synthesize heartbeats from an unrelated process or retry uncertain commands automatically.

For compatible peer mailboxes, if the target is `<mail_root>/inbox/<session_id>` and both `<mail_root>/peers` and `<mail_root>/inbox` exist, the host atomically registers `<mail_root>/peers/ap-browser-<instance_id>.json` with `{v:1, sessionId, name, pid, cwd:"/", updatedAt:<ISO8601>}`. It watches `<mail_root>/inbox/ap-browser-<instance_id>/` every 250ms. To reply via the peer inbox, atomically drop a `.json` envelope there with `body`, `replyTo: <event_id>`, `threadId: <thread_id>`, and `from: {name, sessionId}`. The host reads and removes it, forwarding `done` with that body and sender label inline. A custom standalone inbox still supports delivery and `ap-browser reply`, even without the optional peer directory layout.

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
