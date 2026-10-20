---
name: ap-browser-connect
description: "Control the user's already-logged-in Chrome via `ap-browser`: tabs, sessions, messages, feeds, forms, scraping and screenshots. Also use for rendered-page recording, region/element capture to GIF/MP4/MOV, tagged game-debug runs, and task watermarks on new or existing local video (offline). Distinguish source-media downloads from rendered recording. Prefer purpose-built APIs/CLIs for site tasks when available; use this skill when browser authentication is the blocker or rendered capture is needed."
---

# Browser Use via ap-browser

Drive the user's **already-logged-in** Chrome — real cookies, real sessions, real tabs. No headless browser, no re-login.

## When to use

- Read/send messages on a logged-in platform (Slack, Discord, Twitter, V2EX…)
- Fill forms or submit data where the user is already authenticated
- Scrape pages behind a login wall
- Navigate and extract information from any site
- Take screenshots for visual context
- Snapshot-record a viewport, fixed region or initially visible element to GIF/MP4/MOV; tag runs with phases/marks or watermark local video — [recording workflow](references/recording.md)

**For site tasks, prefer a purpose-built API/CLI** (`gh`, `yt-dlp`, official SDKs) when available. Rendered recording captures what the page displays, not the site's original media stream.

**Route first:** existing local video + watermark → [offline recording branch](references/recording.md#existing-video-offline), with no browser connection, `ping`, adapter lookup or launch. Browser recording → the same reference for capture/storage/validation; use adapter-first for any site navigation or interaction needed during the task. The quick start below is for online site work only.

## Adapter-first rule

**Every online site task starts the same way: identify the current/target site, then check for a matching adapter — before any generic `tabs`/`goto`/`text` command.** 159 adapters across 43 sites are preinstalled; they encode selectors, pagination, SPA waits, and ad filtering in one command. Generic tab primitives are the **fallback**, never the default.

**Step 0 — what site is this task about?**

- The site the user is currently on → `ap-browser tabs list` (active tab URL) or `tabs get <ID>`
- The site a target URL points at → derive the domain from the URL yourself

**Step 1 — match an adapter for that site:**

```bash
ap-browser --help                     # 1. FASTEST: help lists every site + its commands
ap-browser sites search <site>        # 2. keyword match (e.g. "reddit", "wishlist")
ap-browser sites doc <site>           # 3. read the site's knowledge doc before first use
ap-browser <site> <cmd> --help        # 4. args + defaults, one hop (every adapter has it)
ap-browser <site> <cmd> ...           # 5. USE the adapter — it already knows this site
# 6. Only if NO adapter matches:
ap-browser tabs new "<url>" --silent && ap-browser text
```

**Discover once, reuse forever.** Steps 1-4 are for the FIRST time you touch a site. Once you've run `sites search`/`--help` for a site, later tasks on the same site go straight to step 5 — no re-searching, no re-reading docs. If the adapter matches but lacks the exact command, read its doc (`sites doc <site>`) — the doc lists every command that adapter ships. Only then fall back to the generic flow.

**`sites list` output shape (default):**

```json
{"data": {"total_sites": 42, "total_adapters": 150, "recent": [{"site": "github", "commands": 31}, ...], "sites": [...]}}
```

Use `sites list --full` only when you need the full flat adapter dump (150 entries).

**Decision tree (run mentally on every online site task):**

**Adapters auto-isolate tabs.** An adapter without `--tab` runs on the active tab **only when it already matches the site domain** (reads the page the user is on — the intended contract). Otherwise it **silently opens its own tab** on the canonical domain, so the user's tabs are never hijacked. Explicit `--tab <ID>` always wins (no auto-tab).

1. **Adapter matches the current/target site (Step 0-1)?** → **use adapter** — no manual tab juggling needed:
   - User on the site already → adapter reads their page directly (no `--tab`)
   - User on another site / chrome:// → adapter auto-opens a silent tab; pass `--tab` only when you need to reuse one specific tab
2. **No adapter, but login/auth needed** → generic silent-tab flow (`tabs new "<url>" --silent` → `goto` → `text`/`wait` → `tabs close`)
3. **Adapter exists but doesn't expose the exact subcommand you need** → check `sites doc <site>`; if still no fit, fall back to generic flow and consider extending the adapter (see `references/create-site.md`)

**Generic commands (goto/text/click/state) still target the active tab** unless you pass `--tab` — wrap user-visible navigation in a silent tab unless the user asked to see the page.

## Install (if `ap-browser` is not on PATH)

The CLI binary, Chrome extension, native host, and adapters install separately
from this skill. If `ap-browser ping` fails with "command not found" or socket
errors, read `install.md` and follow its 4 steps (skill → binaries →
extension → adapters).

## Failure discipline (mandatory)

**A hanging CLI call is a broken install, not a wrong tool choice.** Never
switch tool family (other CLIs, APIs, skills) because an `ap-browser` command
hangs — diagnose the binary first:

1. Retest bounded: `timeout 3 ap-browser ping`. A shim overwritten by a
   native-host binary hangs forever waiting on stdin; a healthy CLI answers in
   under a second.
2. Diagnose: `which ap-browser && file "$(which ap-browser)"`. The npm
   install is a Node launcher script; `Mach-O`/`ELF` at that path means the
   package is corrupted.
3. Repair: `npm install -g ap-browser-connect`, or bypass the shim directly:
   `ln -sf /opt/homebrew/lib/node_modules/ap-browser-connect/bin/aarch64-apple-darwin/ap-browser /opt/homebrew/bin/ap-browser`
   (Apple silicon; use the matching `bin/<target>/` dir otherwise).
4. Only after `ap-browser ping` answers may you fall back to another tool.

**Check the profile before login-dependent work.** Multiple Chrome profiles
may be online. `ap-browser status` marks the current one with `*` (and every
response carries `meta.profile.label`); `tabs new` reports `data.profile`. If
the site's login lives in another profile: `ap-browser use <label>`, or pass
`--profile <label|instance_id>` (position flexible: leading or trailing).

## Quick start

```bash
ap-browser ping                    # 1. verify extension is online
ap-browser tabs list               # 2. what's open — identify the CURRENT site (active tab URL)
ap-browser sites search <site>     # 3. adapter for that site? (or: ap-browser --help)
ap-browser <site> <cmd>            # 4. USE the adapter (auto silent tab when off-site)
# no adapter matched? then generic:
ap-browser goto "https://..."      # 5. navigate
ap-browser text                    # 6. read page
# deterministic multi-step sequences → ONE batch (state→click→wait→text in 1 round-trip):
echo '[{"method":"state"},{"method":"click","ref":12},{"method":"text"}]' | ap-browser batch
```

The generic flow (goto → text → click) only runs when **no adapter exists** for the site. Any deterministic 3+ step sequence becomes a `batch` (one round-trip, one `meta` block — see `references/patterns.md` #11). See **Adapter-first rule** for the full match recipe.

## Efficiency rules (measured, not stylistic)

Every tool call costs an LLM round-trip and every output costs context. These
rules came from replaying real scenarios before/after — the numbers are
measured, not estimated.

1. **Adapter-first for online site work.** One adapter command replaces N generic steps AND
   returns structured JSON instead of a raw text dump. Reading HN top stories:
   `hackernews best --limit 3` = 1 call, ~450 chars of structured items vs
   `tabs new → wait → text` = 3 calls, 3961 chars of prose the model must parse
   (−67% calls, −88% tokens).
2. **Parallelize independent commands inside ONE tool call.** Independent
   read-only commands (searches, listings, status reads) run as background
   processes in a single shell invocation — one agent round-trip instead of
   N. Measured: two `arxiv search` + one `hackernews best` in one call = 3.4s
   vs 7.5s sequential. Recipe: `references/patterns.md` #15.
3. **`--wait` completes the wait inside the command.** `chatgpt send "…" --wait`
   types, submits, and waits for the response in ONE call — never
   sleep-then-poll (`sleep N && status` loops burned ~90s in the session audit
   behind these rules). Waits return a graceful deadline result carrying
   `current_status`, never an opaque kill.
4. **Bounded waits beat open-ended ones.** Pass a `--timeout` you can afford;
   the returned status fields tell you whether to re-wait, `read` partial
   output, or move on.
5. **Fail on evidence, not silence.** Long-running adapters verify their own
   side effects (e.g. `chatgpt send` reports success only when generation
   actually started). An empty/quiet page is NOT success — read the returned
   `current_status` fields before concluding anything.

Measured end-to-end (ChatGPT Q&A on a fresh tab): **4 calls / 10s** with these
rules vs **59 calls / 229s** with the anti-patterns above.

## Command menu

| Group | Command | What it does |
| ------- | --------- | ------------- |
| **Meta** | `ping` | health check |
| | `status` | how many instances online |
| | `profiles` | list online Chrome profiles |
| | `use <id\|label>` | set default profile |
| **Tabs** | `tabs list` | list open tabs (filter/group/window) |
| | `tabs new [<url>] [--silent]` | create tab (`--silent` = don't steal focus) |
| | `tabs close <ID>` | close tab |
| | `tabs activate <ID>` | focus tab |
| | `tabs get <ID>` | tab details |
| **Navigate** | `goto <url>` | navigate active (or --tab) tab |
| | `back` / `forward` / `reload` | history controls |
| **Read** | `text [--selector CSS]` | page text (caps 50k chars) |
| | `html [--selector CSS]` | raw HTML |
| | `state` | **interactive-element snapshot with `[N]` refs + coordinates** — the discovery primitive |
| | `screenshot [--out FILE] [--annotate]` | capture PNG; `--annotate` overlays `[N]` badges |
| **Record** | `record` / `record start` | v2 snapshot sampling → GIF/MP4/MOV; best-effort FPS, [final/deadline limits](references/recording.md#capture-while-doing-a-task) |
| | `record phase` / `record mark` | persistent stage / transient game-debug note |
| | `record status` / `stop` / `export` / `release` | manage retained source and validate caller-local artifacts |
| | `record watermark <input>` | offline task/custom watermark; no browser needed |
| **Interact** | `click <target>` | click — target is a `state` ref (`click 12`) or CSS selector |
| | `fill <target> <value>` | type into inputs, textareas, contenteditable (real keystrokes) |
| | `select <target> <option>` | pick a `<select>` option by value or label |
| | `upload <selector> <file> [file...]` | set file(s) on an `<input type="file">` (CSV import etc.; same engine as `dev upload`) |
| | `press <key>` | keyboard (Enter, Tab, Control+a) |
| | `wait <CSS>` / `wait --until-eval JS` / `wait --gone CSS` / `wait --url-change-from URL` / `wait --media-ended` | wait for element, removal, JS condition, URL or media |
| | `scroll [--count N] [--selector CSS]` | scroll page or element into view; `--detect` classifies the list (see patterns.md #16) |
| **Power** | `eval "<js>"` | scripted extraction / page-state reads / escape hatch when semantic commands fail |
| | `cdp <method>` | raw DevTools Protocol call |
| **Batch** | `batch` | pipe JSON steps → one round-trip (use for deterministic 3+ step sequences and state→ref chains; see `patterns.md` #11) |

**Batch saves tokens:** one process, one socket, one `meta` block for N operations. See `references/patterns.md` Pattern 11.

**Global flags:** `--profile`, `--tab <ID>`, `--window <ID>`, `--human`, `--timeout <s>`, `--raw`, `--wait-online <s>`

**`--timeout <s>`** works on **every** command (generic, adapter, dev) and beats the default 30s — and beats an adapter's own `timeout` field. Use it when you know the operation will take longer (or shorter) than the default.

**Tab resolution:** without `--tab`, commands target the **active tab of the focused window**.

## State loop (the default agent workflow)

**`state` → act by ref → `state`** — this is how agents operate any page without raw eval:

```bash
ap-browser state                    # 1. snapshot: [N] refs, tag, name, y-coordinate
ap-browser state --human            #    compact text tree for humans
ap-browser click 12                 # 2. act BY REF (numeric target = state ref)
ap-browser fill 7 "hello"           #    fill by ref
ap-browser wait 7 --timeout-ms 10000
ap-browser state                    # 3. fresh snapshot after any page change
```

**Target contract:** `click`/`fill`/`wait` take either a **numeric ref** from `state` (a bare integer) or a **CSS selector** — `click 12` and `click "button.submit"` both work.

**Refs are per-snapshot.** A page change invalidates them: you get `STALE_REF` → run `state` again. Never reuse a ref across navigations.

**Screenshot with visual refs:**

```bash
ap-browser screenshot --annotate    # red boxes + [N] badges over every interactive element
```

The annotated screenshot maps pixels directly to refs — the element at y≈683 in the image is `[N]` in the same spot in `state` output. No `getBoundingClientRect` evals needed.

**When to use eval — first-class for scripting, not for interaction:**

- **Use eval freely for** scripted/structured extraction (mapping 50 cards to `{name, price, link}`), reading page JS state (`window.__INITIAL_STATE__`), fetching the page's own APIs, or any operation `text`/`html`/`state` can't express.
- **Prefer `state`/`click`/`fill` for interaction** — they return structured results, refs, and `STALE_REF` diagnostics; eval writes are opaque.
- **Escape hatch:** if a semantic command fails on a tricky control (custom dropdowns, intercepted clicks), eval is the legitimate fallback.
- **Filter cost:** eval runs outside site-filter protection. That's fine for extraction/escape; using eval to cross a `FILTER_DENIED` is a violation (see `references/safety.md`).

## Silent tab workflow

Use `--silent` mode when your task does **not** need user attention — e.g. gathering information in the background, fetching data from multiple sites, running site adapters — while the user is actively using their browser. This keeps the user's focus on whatever they're doing.

**When to use `--silent`:**

- User is reading/browsing and you need to fetch data from other sites
- Running multiple site adapters that the user doesn't need to watch
- Any task where the user doesn't need to see the page load

**When NOT to use `--silent`:**

- User asked you to navigate to a specific page (they want to see it)
- Filling forms or interacting with the page (user wants to follow along)
- Taking a screenshot the user requested

**Rules:**

1. Open a silent tab: `tabs new "<url>" --silent` — opens without stealing focus, returns `tab_id`
2. **No `goto` needed after `tabs new "<url>"`** — the URL is already navigating; the next command attaches the tab as-is. `goto` is only for a tab that is somewhere else.
3. Run all commands with `--tab <id>` to target that tab
4. **Always close** the tab when done: `tabs close <id>`
5. **Never navigate a tab the user already has open** — not even when the target is the same site, and not even to reuse its login state. Silent tabs share the browser's cookies, so sessions work there too. If the only open tab is the user's, open a silent one and leave theirs untouched.

**Always pass the URL to `tabs new`** — a bare `tabs new --silent` lands on `chrome://newtab`, and chrome:// pages reject DOM/adapter operations (`Cannot access a chrome:// URL`). If you already have a bare tab, `goto <url> --tab <id>` first.

**Example: user is reading V2EX, agent collects from HN + Reddit**

```bash
T1=$(ap-browser tabs new "https://news.ycombinator.com/" --silent | jq '.data.id')
ap-browser hackernews top --tab $T1 --limit 5
ap-browser tabs close $T1

T2=$(ap-browser tabs new "https://www.reddit.com/r/programming/hot/.json?limit=5" --silent | jq '.data.id')
ap-browser reddit hot programming --tab $T2 --limit 5
ap-browser tabs close $T2
```

**Reuse a silent tab for multiple adapters (no bare tabs):**

```bash
T=$(ap-browser tabs new "https://news.ycombinator.com/" --silent | jq '.data.id')
ap-browser hackernews top --tab $T
ap-browser hackernews best --tab $T
ap-browser tabs close $T   # close once, after all adapters done
```

## Output at a glance

Every command returns JSON on stdout — **including failures** (offline, transport, usage errors print `{"ok":false,"error":{"code":...}}`), so `json.load`/`jq` never see empty or invalid output:

```json
{"ok": true, "data": {...}, "meta": {"focus": {"matched_operated_target": true}}}
```

**`--raw`** (global flag): on success with a `data.result` (eval/cdp), print only that value — strings verbatim, everything else compact JSON. Failures still print the full envelope. This replaces wrapper scripts like `python3 -c 'json.load(...)['data']['result']'`:

```bash
ap-browser eval 'document.title' --raw        # → the title, nothing else
ap-browser eval '1+1' --raw                    # → 2
```

| Exit code | Meaning |
| ----------- | --------- |
| 0 | success |
| 2 | usage error (clap; JSON envelope has `code: "USAGE"`) |
| 3 | tab not found |
| 4 | selector/JS error → fix CSS or JS |
| 5 | timeout → retry or check page |
| 6 | multiple profiles → run `profiles` + `use` |
| 7 | offline / transport (`code: "OFFLINE"`) → retry with `--wait-online`, then ask user to open Chrome |

## Health check

When `ap-browser` misbehaves (timeouts, missing adapters, version drift):

```bash
ap-browser doctor              # human-readable, exits 1 on critical failure
ap-browser doctor --json       # machine-readable for agents
ap-browser doctor --fix        # auto-create ~/.ap-browser/ + sites.history only
```

### Keeping current

```bash
ap-browser update              # adapters + skill sync, CLI version report
ap-browser update --check      # exit 0 = current, 1 = updates ready, 2 = offline
```

A stderr `[warn] adapters require ap-browser >= X` at startup means the
installed adapters outgrew the CLI — upgrade the CLI; adapters never crash the
CLI, they only fail per command/site.

### Connection rescue (least disruptive first)

**Recording handles:** first follow [recording recovery](references/recording.md#interruption-and-recovery); host/extension restart can invalidate retained source. Export needed artifacts before considering reload/restart.

0. Any command with `--wait-online <s>` (or env `AP_BROWSER_WAIT_ONLINE`) blocks through brief reconnects instead of failing — during a service-worker/native-host restart just retry once with `--wait-online 30`. `ap-browser status --wait-online 60` replaces poll-in-a-loop status scripts. Only idempotent discovery is retrried; writes are never auto-retried.
1. `ap-browser doctor --json` — don't infer a stuck process from socket files alone.
2. Profile online but flaky: `ap-browser dev extension reload`, then `ping --wait-online 30` until it returns.
3. CLI fully offline: `ping --wait-online 30` covers the automatic-reconnect window in one call.
4. Still offline: ask the user to reload the extension at `chrome://extensions`. Reopen Chrome only as the final fallback.

Never `pkill`/`taskkill` from stale-socket output alone; confirm a live `ap-browser-host` first and get user approval.

## References (load for details)

| File | When to load |
| ------ | ------------- |
| `install.md` | `ap-browser` is not installed or `ap-browser ping` fails — follow the 4 install steps |
| `references/commands.md` | Need full flags, examples, or edge cases for any command |
| [Recording](references/recording.md) | Record viewport/region/element to GIF/MP4/MOV, tag game runs, recover handles, validate artifacts, or watermark local video offline — choose Agent-owned caller-local `--out` before capture/export |
| [Capture & download](references/capture-download.md) | Download source files/media or export PDF/MHTML/HAR/screenshots; distinguish source downloads from rendered video |
| `references/patterns.md` | Need a recipe (scrape list, fill form, SPA wait, pagination, screenshot, efficiency patterns #15) |
| `references/output-contract.md` | Need to understand `meta.focus`, truncation, or error codes in depth |
| `references/multi-profile.md` | Multiple Chrome profiles are online and need to pick/switch |
| `references/create-site.md` | Need to create a site-specific adapter (reusable command for a website) |
| `references/sites/` | Per-site knowledge docs (selectors, URL patterns, pitfalls) |
| `references/safety.md` | Understand untrusted-content warnings, site filters, denials, and raw-command limitations |
| `references/dev/README.md` | Need to debug a page (console, network, performance, emulation, inspection) |

## Site adapters

```bash
ap-browser sites list                      # installed adapters
ap-browser sites search <kw>               # find an adapter
ap-browser sites doc <site>                # site knowledge doc
ap-browser <site> <cmd> --help             # adapter usage
ap-browser hackernews top --format ndjson  # run + pipe
```

Create a new adapter: `references/create-site.md`.

## Site filters

Page-derived output stays untrusted (global warning preserved). Deterministic filters from `~/.ap-browser/filters/<site>/<name>.yaml` can omit/redact injection nodes or deny a configured `click`/`fill` target (`FILTER_DENIED`). Never bypass a denial with `eval`/raw CDP. See `references/safety.md`.

## Dev mode

Structured debugging over CDP: `dev console list`, `dev network list`, `dev errors`, `dev snapshot`, `dev perf trace`, `dev lighthouse`, `dev emulate <mode>`, `dev dom <sel>`. Full tree: `references/dev/README.md`.

## Annotation mode (user marks elements)

The user can pick elements on a page (shortcut Cmd+Shift+E on mac / Alt+Shift+E elsewhere or the extension popup): an inspect-style picker — hovering previews the element (blue dashed outline), clicking pins it (green box + ref badge), clicking again unpins. The compact panel lists only the pinned elements. Pinned elements:

- appear in `state` output as the `annotated` array (`{ref, name}`)
- render as **green** boxes in `screenshot --annotate` (state refs stay red)

When `state` returns `annotated`, those are the user's explicit picks — prefer acting on them instead of guessing which element to use. Details: `references/commands.md`.

### Two annotation modes

**Pin-Only CLI mode** requires no binding or mailbox. Run `ap-browser dev annotate --tab <ID>`, let the user pin elements, then read `ap-browser --tab <ID> state` or `screenshot --annotate`. No agent is launched; page text remains untrusted context.

**Live Bound Interactive mode** connects a running local session to a tab or window:

```bash
ap-browser --window 7 bind --inbox /absolute/mail/inbox/session-id --label "Web Research & Summary"
ap-browser bindings
ap-browser reply --event-id mail-0123456789abcdef0123456789abcdef --status running --message "Reviewing the selection"
ap-browser reply --event-id mail-0123456789abcdef0123456789abcdef --status done --message "Finished"
ap-browser --window 7 unbind
```

Use `--tab <ID>` instead of `--window` for a tab-only binding; tab scope takes precedence over window scope. Always pass a meaningful, human-readable session title or task description to `--label` (explaining what the session is doing, e.g. `"论文阅读与总结"` or `"Checkout Flow QA"`, never a generic tool name like `"pi"`). `bind` can infer session ID from the inbox directory name and PID/label from `../../peers/<session_id>.json`; pass `--session-id`, `--label`, and `--pid` when needed (especially when your CLI's parent is not the long-lived session process). Saved bindings are not proof of readiness. Interactive actions require a fresh receiver lease; unknown health pauses sending, while confirmed offline restores Pin Mode without losing drafts or pins. Popup/options distinguish ready and saved bindings. Read `references/session-receiver.md` when implementing receiver health and acknowledgements or diagnosing an unverified binding.

Any local session relay/mailbox system can consume atomic **v: 1 JSON file drops** in `--inbox <DIR>`; no particular agent vendor or relay installation is required. Files are `mail-<32hex>.json`, with a readable `body` plus structured `ap_browser` page/element metadata. Writing a message means queued, not delivered. A matching explicit receiver receipt means accepted; removing/moving the file proves nothing. Only an execution update means running. Missing receipts become unconfirmed and are never automatically retried. `ap-browser reply` sends inline progress (`running`, `done`, `confirm`, `error`) back to its originating tab; a compatible peer inbox reply with `replyTo` / `threadId` also works. See `references/commands.md` for the exact file-drop and peer contracts. Command requests require a safety audit and explicit confirmation for destructive/privileged actions; queueing or acceptance does not mean execution or approval.

## Capture & download

**Source file/media** → `download <url>` (video-site stream: `--video`); `media` discovers URLs. Also: PDF/MHTML/HAR and element screenshots. Read [capture & download](references/capture-download.md).

**Rendered motion** → v2 snapshot `record` for viewport/region/element GIF/MP4/MOV, including phase/mark and task watermarks. Capture FPS is best effort; explicit stop seeks one final observation within the original cap, whereas deadline promises none. **Existing local video + watermark** → offline `record watermark`, without contacting Chrome. Read [recording](references/recording.md) for required Agent-chosen `--out`, validation and source retention; a handle or stop acknowledgement is not a completed video.
