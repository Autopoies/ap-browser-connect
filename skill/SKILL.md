---
name: ap-browser-connect
description: "Control the user's already-logged-in Chrome browser via the `ap-browser` CLI. Use when the task needs existing browser state: open tabs, logged-in sessions, cookies, or platform interactions (send messages, read feeds, fill forms, scrape behind login). Prefer purpose-built APIs or CLIs when available; fall back to this skill when authentication is the blocker. Triggers: 'open browser', 'check my', 'log into', 'go to website', 'scrape page', 'fill form', 'click button', 'take screenshot', 'read page'."
---

# Browser Use via ap-browser

Drive the user's **already-logged-in** Chrome — real cookies, real sessions, real tabs. No headless browser, no re-login.

## When to use

- Read/send messages on a logged-in platform (Slack, Discord, Twitter, V2EX…)
- Fill forms or submit data where the user is already authenticated
- Scrape pages behind a login wall
- Navigate and extract information from any site
- Take screenshots for visual context

**Do NOT use** when a purpose-built API/CLI exists (`gh`, `yt-dlp`, official SDKs). Prefer those.

## Adapter-first rule

**Every task starts the same way: identify the current/target site, then check for a matching adapter — before any generic `tabs`/`goto`/`text` command.** 200+ adapters across 40+ sites are preinstalled; they encode selectors, pagination, SPA waits, and ad filtering in one command. Generic tab primitives are the **fallback**, never the default.

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

**Decision tree (run mentally on every task):**

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
| **Interact** | `click <target>` | click — target is a `state` ref (`click 12`) or CSS selector |
| | `fill <target> <value>` | type into inputs, textareas, contenteditable (real keystrokes) |
| | `select <target> <option>` | pick a `<select>` option by value or label |
| | `press <key>` | keyboard (Enter, Tab, Control+a) |
| | `wait <CSS>` / `wait --url-change-from URL` / `wait --media-ended` | event-driven page/media waits |
| | `scroll [--count N] [--selector CSS]` | scroll page or element into view |
| **Power** | `eval "<js>"` | scripted extraction / page-state reads / escape hatch when semantic commands fail |
| | `cdp <method>` | raw DevTools Protocol call |
| **Batch** | `batch` | pipe JSON steps → one round-trip (use for deterministic 3+ step sequences and state→ref chains; see `patterns.md` #11) |

**Batch saves tokens:** one process, one socket, one `meta` block for N operations. See `references/patterns.md` Pattern 11.

**Global flags:** `--profile`, `--tab <ID>`, `--window <ID>`, `--human`, `--timeout <s>`

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

Every command returns JSON on stdout:

```json
{"ok": true, "data": {...}, "meta": {"focus": {"matched_operated_target": true}}}
```

| Exit code | Meaning |
| ----------- | --------- |
| 0 | success |
| 2 | extension offline → ask user to open Chrome |
| 4 | selector/JS error → fix CSS or JS |
| 5 | timeout → retry or check page |
| 6 | multiple profiles → run `profiles` + `use` |

## Health check

When `ap-browser` misbehaves (timeouts, missing adapters, version drift):

```bash
ap-browser doctor              # human-readable, exits 1 on critical failure
ap-browser doctor --json       # machine-readable for agents
ap-browser doctor --fix        # auto-create ~/.ap-browser/ + sites.history only
```

### Connection rescue (least disruptive first)

1. `ap-browser doctor --json` — don't infer a stuck process from socket files alone.
2. Profile online but flaky: `ap-browser dev extension reload`, then poll `ping` until it returns (exponential backoff, ≤30s).
3. CLI fully offline: wait ≤30s for automatic reconnect, retry `ping`.
4. Still offline: ask the user to reload the extension at `chrome://extensions`. Reopen Chrome only as the final fallback.

Never `pkill`/`taskkill` from stale-socket output alone; confirm a live `ap-browser-host` first and get user approval.

## References (load for details)

| File | When to load |
| ------ | ------------- |
| `install.md` | `ap-browser` is not installed or `ap-browser ping` fails — follow the 4 install steps |
| `references/commands.md` | Need full flags, examples, or edge cases for any command |
| `references/patterns.md` | Need a recipe (scrape list, fill form, SPA wait, pagination, screenshot) |
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

The user can pick elements on a page (shortcut Alt+Shift+A or the extension popup): an inspect-style picker — hovering previews the element (blue dashed outline), clicking pins it (green box + ref badge), clicking again unpins. The compact panel lists only the pinned elements. Pinned elements:

- appear in `state` output as the `annotated` array (`{ref, name}`)
- render as **green** boxes in `screenshot --annotate` (state refs stay red)

When `state` returns `annotated`, those are the user's explicit picks — prefer acting on them instead of guessing which element to use. Details: `references/commands.md`.

## Capture & download

**Downloading files from a site (PDFs, docs, media): use `download <url>`** — it downloads through the browser session with the site's cookies, no eval/fetch tricks. Also: `pdf`, `mhtml`, `har`, `media --type <t>`, `screenshot --element <sel>`. Details: `references/capture-download.md`.
