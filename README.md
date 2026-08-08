![Autopoies Browser Connect](docs/assets/banner.png)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg) ![Language](https://img.shields.io/badge/language-Rust-orange.svg) ![Extension](https://img.shields.io/badge/extension-Chrome-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS_|_Linux-lightgrey.svg) ![Platform](https://img.shields.io/badge/platform-Windows_(experimental)-yellow.svg)

**All-in-one agent browser connector.** One Rust CLI attaches any AI agent to the Chrome profile you already use. That profile keeps your cookies, logins, and open tabs.

In one surface:

- **Drive** — tabs, navigation, click / fill / wait, `eval`, screenshots
- **Adapters** — 42 sites, 200+ named commands (`ap-browser hackernews top`)
- **Batch** — multi-step flows in one round-trip
- **Annotate** — visual ref map (`screenshot --annotate`) and in-page pin picker for agents
- **Dev** — CDP console, network, errors, snapshot, perf, lighthouse, emulate
- **Capture** — `download` (session cookies / yt-dlp), `pdf`, `mhtml`, `har`, `media`
- **Filters** — site policies that omit/redact injection-prone nodes and can deny risky `click` / `fill` targets

Agents do not need a headless browser, a fresh login, a Node runtime, or a single vendor.

---

# Agent Quickstart

Paste this into Claude Code, Cursor, Codex, or any coding agent:

```
Install the skill with: npx skills add autopoies/ap-browser-connect/skill
Read that skill's install.md.
Follow its steps for release binaries, the unpacked extension, the native-host manifest, and adapters.
Verify with: `ap-browser ping`
```

After those steps, the agent can drive your logged-in Chrome.

# Human Quickstart

Install four parts: release binaries, the unpacked extension, the native-host manifest, and site adapters. The skill is optional for humans. Install the skill when an agent must set up and run `ap-browser` for you.

**1. Install the release binaries**

```bash
# Download the matching tarball from:
# https://github.com/autopoies/ap-browser-connect/releases/latest
tar xzf ap-browser-*-<target>.tar.gz
sudo cp ap-browser-*-<target>/bin/ap-browser* /usr/local/bin/
```

**2. Load the extension**

1. Download `ap-browser-extension-*.zip` from the same release (or use the `extension/` folder inside the tarball).
2. Unzip it to a stable path (for example `~/ap-browser-extension/`).
3. Open `chrome://extensions/`.
4. Enable **Developer mode** (top-right).
5. Click **Load unpacked** and select the unzipped extension directory.

v1 ships as load-unpacked only.

**3. Register the native host**

```bash
curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | bash
```

For source development:

1. Run `cargo install --path cli`.
2. Load this checkout's `extension/`.
3. Run `bash install/install.sh`.

The script builds `ap-browser-host` when no release host is installed.

**4. Install site adapters**

```bash
git clone https://github.com/autopoies/ap-browser-connect-adapters.git /tmp/abc-adapters
mkdir -p ~/.ap-browser
cp -R /tmp/abc-adapters/sites ~/.ap-browser/
cp -R /tmp/abc-adapters/filters ~/.ap-browser/
cp /tmp/abc-adapters/download-config.yml ~/.ap-browser/
```

**5. Verify**

```bash
ap-browser ping
ap-browser hackernews top --limit 5
ap-browser goto https://news.ycombinator.com
ap-browser text
```

# Why this exists

Agents that act on the open web usually hit one of two gaps:

- **Headless stacks** (Playwright, browser-use, and similar tools) start a clean browser and lose your logins.
- **Fetch-only / site-CLI tools** ship many named commands, but they do not cover a full operate, debug, and capture loop on the live tab.

Autopoies Browser Connect sits in the middle. It is one Rust CLI on **your** Chrome.

- Use an **adapter** when the site is known — or **create your own** (`skill/references/create-site.md`) for a new site.
- Use **`batch`** for multi-step work in one round-trip — fewer agent turns, lower token cost.
- Use **`dev`** for live-page web development: console, network, errors, snapshot, perf, lighthouse, emulate.
- Use **`download` / `pdf` / `mhtml`** when you need an artifact.

## What agents can do

```bash
# Named adapter (preferred when available)
ap-browser hackernews top --limit 5
ap-browser github repo-pulls rust-lang/rust
ap-browser twitter timeline --limit 10

# Multi-step in one round-trip
echo '[
  {"method":"goto","url":"https://news.ycombinator.com"},
  {"method":"wait","selector":".athing"},
  {"method":"text"}
]' | ap-browser batch

# Debug the same logged-in tab
ap-browser dev errors
ap-browser dev network list --status failed

# Capture through the live session
ap-browser download https://example.com/report.pdf --out report.pdf
```

Examples:

```bash
# "Summarize my X home timeline"
ap-browser twitter timeline --limit 20

# "List open PRs on rust-lang/rust"
ap-browser github repo-pulls rust-lang/rust --state open

# "What's broken on this page?"
ap-browser dev errors
ap-browser dev network list --status failed
```

## Site adapters (42 sites, 200+ commands)

Adapters are YAML (+ optional JS) loaded at runtime from `~/.ap-browser/sites/`. They are not compiled into the CLI.

```bash
ap-browser --help                 # lists installed sites + commands
ap-browser sites search reddit
ap-browser hackernews top
ap-browser twitter timeline
ap-browser zhihu hot
```

Library: [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters).  
Authoring guide: [`skill/references/create-site.md`](./skill/references/create-site.md).

## Site filters (reduce injection risk)

Page text is untrusted. Site filters add a narrower, deterministic layer on top of that warning. Policies load from `~/.ap-browser/filters/<site>/<name>.yaml` (shipped with the adapters repo). A policy matches on origin, path, and command.

A filter can:

- omit configured nodes from `text` / `html` extraction
- redact configured literal blocks from returned strings
- deny a configured `click` or `fill` target (`FILTER_DENIED`)

Filters do not rewrite the live DOM. They are not a universal prompt-injection detector. Do not bypass a denial with `eval`.  
Details: [`skill/references/safety.md`](./skill/references/safety.md).

## Batch (multi-step, one round-trip)

Deterministic sequences belong in `batch`. The CLI sends one RPC, returns one `meta` block, and stops on the first failed step.

```bash
echo '[
  {"method":"state"},
  {"method":"click","ref":12},
  {"method":"wait","selector":".result"},
  {"method":"text"}
]' | ap-browser batch
```

Use separate commands when the next step depends on the previous result.  
Patterns: [`skill/references/patterns.md`](./skill/references/patterns.md).

## Annotate (pixel → ref)

Agents need a stable map from what they see to what they click. Annotate mode provides that.

**Screenshot overlay** — draw numbered badges that match `state` refs 1:1:

```bash
ap-browser state
ap-browser screenshot --annotate --out /tmp/page.png
```

Red boxes are interactive `state` refs. Green boxes are elements the user pinned.

**In-page picker** — pin elements on the live tab:

- Shortcut: `Cmd+Shift+A` (macOS) / `Alt+Shift+A` (other)
- Extension popup button
- `ap-browser dev annotate` for a specific tab

Pinned elements appear in `state` as `annotated: [{ref|null, selector, name, ...}]`. Prefer those picks over guessing.  
Details: [`skill/references/commands.md`](./skill/references/commands.md).

## Capture & download

Download files with the **logged-in** browser session. Site cookies apply. You do not copy tokens by hand.

```bash
# File / document (uses the live Chrome session)
ap-browser download "https://example.com/report.pdf" --out report.pdf

# Video / audio via yt-dlp + Chrome cookies (requires yt-dlp installed)
ap-browser download "https://www.youtube.com/watch?v=…" --video --out clip.mp4

# Page exports
ap-browser pdf --out page.pdf
ap-browser mhtml --out page.mhtml
ap-browser har --out network.har
ap-browser media --type video
```

`download` selects a method automatically (`fetch` / browser download / yt-dlp). Discovery heuristics live in `~/.ap-browser/download-config.yml` (copied with the adapters install).  
Full reference: [`skill/references/capture-download.md`](./skill/references/capture-download.md).

## Commands

| Group | Commands | Description |
|-------|----------|-------------|
| **Meta** | `ping`, `status`, `profiles`, `use`, `current`, `info`, `doctor` | Connection, profiles, health check |
| **Tabs** | `tabs list`, `tabs new`, `tabs close`, `tabs activate`, `tabs get` | Tab lifecycle |
| **Navigation** | `goto`, `back`, `forward`, `reload` | Page navigation |
| **Read** | `screenshot`, `text`, `html` | Content extraction (`screenshot --annotate` overlays ref badges) |
| **Capture** | `download`, `pdf`, `mhtml`, `har`, `media` | Session-aware file / page / media export |
| **Interact** | `click`, `fill`, `press`, `wait` | DOM interaction |
| **Batch** | `batch` | JSON steps → one round-trip |
| **Power** | `eval` | Execute JavaScript in the page |
| **Dev** | `dev console`, `dev network`, `dev errors`, `dev snapshot`, `dev perf`, `dev lighthouse`, `dev emulate`, … | CDP debugging on the live tab |
| **Sites** | `sites list`, `sites search`, `<site> <cmd>` | Adapter discovery and named site commands |

Full reference: [`skill/`](./skill/).

When an agent controls a tab, the extension swaps the favicon, updates the toolbar icon, and shows Chrome's debugger banner.

## Dev mode (debug the live page)

Debug the same logged-in tab the agent already drives:

```bash
ap-browser dev errors
ap-browser dev console list --type error
ap-browser dev network list --status failed
ap-browser dev snapshot
ap-browser dev perf trace --reload
ap-browser dev lighthouse --categories accessibility
ap-browser dev emulate viewport 375x667 --mobile
```

Also covered: DOM inspection, cookies, storage, service workers, page-context API calls with real cookies, and extension reload.  
Full tree: [`skill/references/dev/README.md`](./skill/references/dev/README.md).

## Architecture

1. **CLI (`ap-browser`)** — agent entry point (drive, adapters, batch, annotate, dev, capture, filters)
2. **Native host (`ap-browser-host`)** — links the local socket to the Chrome extension (no separate daemon)
3. **Extension** — Chrome extension that runs commands in the browser
4. **Adapters repo** — runtime YAML/JS data under `~/.ap-browser/` (zero build-time coupling)
5. **TCP bridge (`ap-browser-bridge`)** — optional tunnel for container or remote CLI tests; not part of the normal install

## Skill (for agents)

```bash
npx skills add autopoies/ap-browser-connect/skill
```

The skill lives in [`skill/`](./skill/). It documents how agents install and operate `ap-browser`. It is not the CLI binary.

## Platforms

- **macOS**: Supported and tested
- **Linux**: Supported and tested
- **Windows**: Experimental (CI compiles; runtime may fail)

## FAQ

**Q:** What is the security model?  
**A:** `eval` and DOM commands are unrestricted. Any agent with access to the `ap-browser` CLI can run JavaScript in your logged-in browser. Grant access only to agents you trust.

**Q:** How is this different from browser-use / Playwright?  
**A:** Those tools usually start a new headless browser and require a new login. This attaches to the Chrome profile you already use.

**Q:** Does it support multiple Chrome profiles?  
**A:** Yes. Use `ap-browser profiles` and `ap-browser use <profile>`.

## Contributing

We follow GitHub Flow. For command-surface changes, read [`skill/SKILL.md`](./skill/SKILL.md) first. For per-site YAML adapters, see [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters).

## License

Apache-2.0

---

**Give your agent a browser that already knows who you are.**

[![GitHub Stars](https://img.shields.io/github/stars/autopoies/ap-browser-connect.svg?style=social)](https://github.com/autopoies/ap-browser-connect)
