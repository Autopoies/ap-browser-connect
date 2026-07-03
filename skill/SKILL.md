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

**Before reaching for `tabs new` / `goto` / `text`, ALWAYS check if a site adapter exists first.** 200+ adapters across 40+ sites are preinstalled — they handle selectors, pagination, SPA waits, and ad filtering in one command. Generic tab primitives are the **fallback**, not the default.

```bash
ap-browser --help                     # 1. FASTEST: see all sites + cmds right in help output
ap-browser sites list                 # 2. summary: total counts + your 5 recently-used sites
ap-browser sites search <query>       # 3. find a site or command by keyword (e.g. "wishlist", "reddit")
ap-browser sites doc <site>           # 4. read one site's knowledge doc
ap-browser hackernews top             # 5a. USE adapter if site matches
# 5b. Only if NO adapter matches:
ap-browser tabs new "<url>" --silent && ap-browser text
```

**`sites list` output shape (default):**
```json
{"data": {"total_sites": 42, "total_adapters": 150, "recent": [{"site": "github", "commands": 31}, ...], "sites": [...]}}
```
Use `sites list --full` only when you need the full flat adapter dump (150 entries).

**Decision tree (run mentally on every task):**

**CRITICAL: Adapters do NOT auto-isolate tabs.** Without `--tab`, any command (adapter or primitive) hijacks the user's **active tab** — navigating it away from whatever they were reading. Always check what the user is doing first (`tabs list`) and wrap in a silent tab unless they explicitly want to see the result.

1. **Target site in `sites list`?** → **use adapter**, but pick the tab mode:
   - **User is browsing something else** (most common) → wrap adapter in silent tab:
     ```bash
     T=$(ap-browser tabs new --silent | jq '.data.id')
     ap-browser <site> <cmd> --tab $T [args]    # MUST pass --tab
     ap-browser tabs close $T
     ```
   - **User explicitly asked to navigate / wants to see the page** → no `--tab`, adapter runs on active tab (user is watching)
2. **No adapter, but login/auth needed** → generic silent-tab flow (`tabs new --silent` → `goto` → `text`/`wait` → `tabs close`)
3. **Adapter exists but doesn't expose the exact subcommand you need** → check `sites doc <site>`; if still no fit, fall back to generic flow and consider extending the adapter (see `references/create-site.md`)

**Quick check before every adapter call:** if the user is on a tab they care about (reading, watching, composing), you MUST either (a) create a silent tab and pass `--tab`, or (b) ask permission to navigate their tab.

## Quick start

```bash
ap-browser ping                    # 1. verify extension is online
ap-browser profiles                # 2. (if multiple) see which profile to target
ap-browser use Work                # 2b. select a profile
ap-browser tabs list               # 3. see what's open
ap-browser goto "https://..."      # 4. navigate
ap-browser text                    # 5. read page
```

## Command menu

| Group | Command | What it does |
|-------|---------|-------------|
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
| | `screenshot [--out FILE]` | capture PNG |
| **Interact** | `click <CSS>` | click element |
| | `fill <CSS> <value>` | set input value |
| | `press <key>` | keyboard (Enter, Tab, Control+a) |
| | `wait <CSS>` | wait for element to appear |
| **Power** | `eval "<js>"` | run JS in page (CDP) |
| | `cdp <method>` | raw DevTools Protocol call |
| **Batch** | `batch` | pipe JSON array of steps → one round-trip, one response |

**Batch saves tokens:** one process, one socket, one `meta` block for N operations. See `references/patterns.md` Pattern 11.

**Global flags:** `--profile`, `--tab <ID>`, `--window <ID>`, `--human`, `--timeout <s>`

**Tab resolution:** without `--tab`, commands target the **active tab of the focused window**.

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
2. Run all commands with `--tab <id>` to target that tab
3. **Always close** the tab when done: `tabs close <id>`

**Example: user is reading V2EX, agent collects from HN + Reddit**
```bash
T1=$(ap-browser tabs new "https://news.ycombinator.com/" --silent | jq '.data.id')
ap-browser hackernews top --tab $T1 --limit 5
ap-browser tabs close $T1

T2=$(ap-browser tabs new "https://www.reddit.com/r/programming/hot/.json?limit=5" --silent | jq '.data.id')
ap-browser reddit hot programming --tab $T2 --limit 5
ap-browser tabs close $T2
```

**Reuse a silent tab for multiple adapters:**
```bash
T=$(ap-browser tabs new --silent | jq '.data.id')
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
|-----------|---------|
| 0 | success |
| 2 | extension offline → ask user to open Chrome |
| 4 | selector/JS error → fix CSS or JS |
| 5 | timeout → retry or check page |
| 6 | multiple profiles → run `profiles` + `use` |

## Health check

When `ap-browser` misbehaves (timeouts, missing adapters, version drift), run doctor first:

```bash
ap-browser doctor              # human-readable, exits 1 if critical fails
ap-browser doctor --json       # machine-readable for agents
ap-browser doctor --fix        # auto-create ~/.ap-browser/, sites.history (reversible only)
```

Checks 18 items across 3 severity tiers:
- **Critical (5)**: extension online, native messaging config, host binary, host version match, host running
- **Warning (8)**: yt-dlp/curl/jq/ffmpeg/npx deps, sites registry, sites lint, orphan sockets
- **Hygiene (5)**: `~/.ap-browser/` dir, `sites.history` writable, CLI in PATH, skill docs sync, download-config.yml

`--fix` only touches: `mkdir ~/.ap-browser`, `touch sites.history`. Orphan sockets, native messaging config, deps = report-only (agent/user handles).

## References (load for details)

| File | When to load |
|------|-------------|
| `references/commands.md` | Need full flags, examples, or edge cases for any command |
| `references/patterns.md` | Need a recipe (scrape list, fill form, SPA wait, pagination, screenshot) |
| `references/output-contract.md` | Need to understand `meta.focus`, truncation, or error codes in depth |
| `references/multi-profile.md` | Multiple Chrome profiles are online and need to pick/switch |
| `references/create-site.md` | Need to create a site-specific adapter (reusable command for a website) |
| `references/sites/` | Per-site knowledge docs (selectors, URL patterns, pitfalls) |
| `references/dev/README.md` | Need to debug a page (console, network, performance, emulation, inspection) |

## Site adapters

ap-browser supports **site-specific adapters** — reusable commands that orchestrate primitives for a single website.

```bash
ap-browser sites list                # see installed adapters
ap-browser sites doc <site>          # read site knowledge doc
ap-browser sites lint [<site>]       # validate adapter schema
ap-browser sites verify <site> <cmd> --test-args '<json>'  # live test

ap-browser hackernews top            # run an adapter
ap-browser hackernews top --format ndjson | jq '.title'    # pipe output
```

To create a new adapter: read `references/create-site.md`.

## Dev mode

ap-browser supports **dev mode** — structured debugging commands wrapping Chrome DevTools Protocol.

```bash
ap-browser dev console list          # captured console messages
ap-browser dev network list          # captured network requests
ap-browser dev errors                # JS errors + failed requests
ap-browser dev snapshot              # accessibility tree
ap-browser dev perf trace --reload   # Core Web Vitals
ap-browser dev lighthouse            # a11y/SEO audit
ap-browser dev emulate dark          # dark mode emulation
ap-browser dev dom <selector>        # deep DOM inspection
```

For the full command tree and when to use which: read `references/dev/README.md`.

## Capture & download

ap-browser supports **capture & download** — save files, videos, PDFs, page archives, and media from any page.

```bash
ap-browser download <url>                # auto-routes (fetch/browser)
ap-browser download <url> --video        # video via yt-dlp (1000+ sites)
ap-browser pdf                           # export page as PDF
ap-browser mhtml                         # single-file page archive
ap-browser har                           # network capture as HAR
ap-browser media --type image            # extract media URLs
ap-browser screenshot --element <sel>    # element-scoped screenshot
```

For the full guide: read `references/capture-download.md`.
| `references/safety.md` | Handling sensitive data, what NOT to do, confirmation policy |
