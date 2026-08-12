![Autopoies Browser Connect](docs/assets/banner.png)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg) ![Language](https://img.shields.io/badge/language-Rust-orange.svg) ![Extension](https://img.shields.io/badge/extension-Chrome-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS_|_Linux-lightgrey.svg) ![Platform](https://img.shields.io/badge/platform-Windows_(experimental)-yellow.svg)

**Small. Fast. Efficient.** The native Rust CLI connects an AI agent to your open Chrome session.
The agent can use the profile's cookies and logins. It can also use the open tabs.

The CLI provides these functions:

- **Drive**: Control tabs, navigate, click, fill, wait, run `eval`, and take screenshots.
- **Adapters**: Run 159 named commands for 43 sites (`ap-browser hackernews top`).
- **Annotate**: Map screenshot markers to element references and user-selected elements.
- **Dev**: Inspect the console, network, errors, DOM, performance, and emulation state.
- **Capture**: Download files and export PDF, MHTML, HAR, and media files.
- **Filters**: Omit or redact untrusted content and deny configured `click` or `fill` targets.

The CLI uses the open Chrome session. It does not include a headless browser, Node.js, or an LLM runtime.

## Measured results

| | Measured result |
| --- | --- |
| **Footprint** | The CLI is 2.05 MiB. Peak CLI RSS is 4.3–5.3 MiB. Native host RSS is 2–3 MiB. |
| **Latency** | Common operations take 26–47 ms. A three-step batch takes 80 ms. |
| **Agent use** | One tool call and about 2.3K tokens for each steady-state adapter or batch task. |

Measurements used a stripped v0.1.0 release on Apple Silicon and macOS, 10 warm local runs, and Pi 0.84.1 with `opencode-go/deepseek-v4-flash`.
Thinking was off. We excluded the first skill load. Results vary by workload.

---

# Agent Quickstart

Paste this prompt into Claude Code, Cursor, Codex, or another coding agent:

```
Install the skill with: npx skills add autopoies/ap-browser-connect/skill
Read that skill's install.md.
Follow its steps for the CLI (npm install -g ap-browser-connect), the unpacked extension, the native-host manifest, and adapters.
Verify with: `ap-browser ping`
```

After those steps, the agent can drive your logged-in Chrome.

# Human Quickstart

Install the release binaries, extension, native-host manifest, and site adapters.
Humans do not need the skill. Install it only when an agent must install or run `ap-browser`.

**1. Install the CLI + native host**

```bash
npm install -g ap-browser-connect
```

The npm package ships prebuilt binaries for macOS (arm64/x64), Linux (arm64/x64),
and Windows x64 — no install scripts, no extra steps. It installs three
commands: `ap-browser` (CLI), `ap-browser-host` (native host), and
`ap-browser-bridge` (TCP bridge).

No npm? Download the matching tarball instead:

```bash
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

If the release host is not installed, the script builds `ap-browser-host`.

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

Autopoies Browser Connect gives an agent a deterministic interface to your Chrome session.
The calling agent makes task decisions.
The CLI operates the browser, debugs pages, captures files, and runs named site commands.

- Use an **adapter** when one is available. Create an adapter (`skill/references/create-site.md`) for a new site.
- Use **`batch`** to run multiple steps in one round-trip. This reduces agent turns and token use.
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

## Site adapters (43 sites, 159 commands)

The CLI loads YAML adapters from `~/.ap-browser/sites/` at runtime. An adapter can use an optional JavaScript file. The adapters are not compiled into the CLI.

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

Page text is untrusted. Site filters apply deterministic rules to that text.
The CLI loads each policy from `~/.ap-browser/filters/<site>/<name>.yaml`.
The adapters repository includes these policies. A policy matches an origin, path, and command.

A filter can:

- omit configured nodes from `text` / `html` extraction
- redact configured literal blocks from returned strings
- deny a configured `click` or `fill` target (`FILTER_DENIED`)

Site filters do not change the live DOM. Site filters do not detect all prompt injections.
Do not bypass a denial with `eval`.

Details: [`skill/references/safety.md`](./skill/references/safety.md).

## Batch (multi-step, one round-trip)

Use `batch` for a deterministic sequence. The CLI sends one RPC and returns one `meta` block. The CLI stops when a step fails.

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

**Screenshot overlay**: Draw numbered badges that match `state` references:

```bash
ap-browser state
ap-browser screenshot --annotate --out /tmp/page.png
```

Red boxes are interactive `state` refs. Green boxes are elements the user pinned.

**In-page picker**: Pin elements on the live tab:

- Shortcut: `Cmd+Shift+A` (macOS) / `Alt+Shift+A` (other)
- Extension popup button
- `ap-browser dev annotate` for a specific tab

Pinned elements appear in `state` as `annotated: [{ref|null, selector, name, ...}]`.
Use the pinned elements. Do not guess which element to select.

Details: [`skill/references/commands.md`](./skill/references/commands.md).

## Capture & download

Download files with the logged-in browser session. The download uses the site's cookies. You do not need to copy authentication tokens.

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

The `download` command selects `fetch`, browser download, or yt-dlp.
The file `~/.ap-browser/download-config.yml` contains the selection rules.
The adapter installation copies this file.

Full reference: [`skill/references/capture-download.md`](./skill/references/capture-download.md).

## Commands

| Group | Commands | Description |
| ------- | ---------- | ------------- |
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

Use the `dev` commands to debug the current logged-in tab:

```bash
ap-browser dev errors
ap-browser dev console list --type error
ap-browser dev network list --status failed
ap-browser dev snapshot
ap-browser dev perf trace --reload
ap-browser dev lighthouse --categories accessibility
ap-browser dev emulate viewport 375x667 --mobile
```

The commands also inspect the DOM, cookies, storage, and service workers.
They call page APIs with the current cookies. They can also reload the extension.

Full tree: [`skill/references/dev/README.md`](./skill/references/dev/README.md).

## Architecture

1. **CLI (`ap-browser`)**: Provides drive, adapter, batch, annotate, development, capture, and filter commands.
2. **Native host (`ap-browser-host`)**: Connects the local socket to the Chrome extension. It does not require a separate daemon.
3. **Extension**: Runs commands in Chrome.
4. **Adapters repository**: Stores runtime YAML and JavaScript files under `~/.ap-browser/`. The CLI has no build-time dependency on these files.
5. **TCP bridge (`ap-browser-bridge`)**: Connects a container or remote test client to the CLI. A normal installation does not use the bridge.

## Skill (for agents)

```bash
npx skills add autopoies/ap-browser-connect/skill
```

The [`skill/`](./skill/) directory contains the skill. The skill tells agents how to install and operate `ap-browser`. The skill is not the CLI binary.

## Platforms

- **macOS**: Supported and tested
- **Linux**: Supported and tested
- **Windows**: Experimental. CI compiles the code, but the runtime can fail.

## FAQ

**Q:** What is the security model?  
**A:** The CLI does not restrict `eval` or DOM commands.
An agent that can run `ap-browser` can run JavaScript in your logged-in browser.
Give CLI access only to agents that you trust.

**Q:** Does it support multiple Chrome profiles?  
**A:** Yes. Use `ap-browser profiles` and `ap-browser use <profile>`.

## Contributing

We follow GitHub Flow.
For command-surface changes, read [`skill/SKILL.md`](./skill/SKILL.md) first.
For per-site YAML adapters, see [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters).

## License

Apache-2.0

---

**Connect your agent to your current Chrome session.**

[![GitHub Stars](https://img.shields.io/github/stars/autopoies/ap-browser-connect.svg?style=social)](https://github.com/autopoies/ap-browser-connect)
