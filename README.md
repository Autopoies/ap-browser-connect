![Autopoies Browser Connect](docs/assets/banner.png)

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://github.com/autopoies/ap-browser-connect-adapters">Site Adapters (47 Sites)</a> · <a href="skill/SKILL.md">Agent Skill</a> · <a href="skill/references/commands.md">CLI Reference</a>
</p>

<p align="center">
  <strong>Let your local coding agent use the Chrome you already have open.</strong>
</p>
<p align="center">
  Any coding agent · Your existing logins · 47 Site Adapters · In-page interaction · Video &amp; GIF recording
</p>

<div align="center">

[![Release](https://img.shields.io/github/v/release/autopoies/ap-browser-connect?label=release&color=brightgreen)](https://github.com/autopoies/ap-browser-connect/releases/latest)
[![npm](https://img.shields.io/npm/v/ap-browser-connect?logo=npm)](https://www.npmjs.com/package/ap-browser-connect)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Language](https://img.shields.io/badge/language-Rust-orange.svg)](https://www.rust-lang.org/)
[![Extension](https://img.shields.io/badge/extension-Chrome_MV3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Platform](https://img.shields.io/badge/platform-macOS_|_Linux-lightgrey.svg)](https://github.com/autopoies/ap-browser-connect)
[![Platform](https://img.shields.io/badge/platform-Windows_(experimental)-yellow.svg)](https://github.com/autopoies/ap-browser-connect)

</div>

`ap-browser` connects your signed-in Chrome directly to **Claude Code**, **Codex**, **Pi**, **Cursor**, and **OpenCode**. No 500 MB headless browser, no cookie exports, and no model locked inside a sidebar—just a **2 MiB Rust CLI** with **47 site adapters**, a **GIF/MP4 recorder**, and **in-page interaction** (`Cmd+Shift+E`) to highlight text and talk to your terminal agent right on the page.

<p align="center">
  <img src="docs/assets/demo-live-copilot.gif" width="860" alt="In-Page Copilot & Live Bound Session Demo on arXiv">
</p>
<p align="center"><sub>Highlight text on any page (<code>Cmd+Shift+E</code>), ask your running terminal agent inline, and watch the answer stream into the floating dock.</sub></p>

---

## Quickstart

Paste this into **Claude Code**, **Codex**, **Pi**, **Cursor**, or **OpenCode**:

```text
Install ap-browser: run `npx skills add autopoies/ap-browser-connect/skill` if the skill isn't already installed, then read that skill's `install.md` and follow the 4 steps it describes (release binaries, extension load-unpacked, native manifest, adapters/filters). Verify with `ap-browser ping`.
```

<details>
<summary><strong>Manual setup (4 steps)</strong></summary>

1. **Install the Skill**:
   ```bash
   npx skills add autopoies/ap-browser-connect/skill
   ```
2. **Install the CLI & Native Host**:
   ```bash
   npm install -g ap-browser-connect
   ```
   *(Or grab binaries from [Releases](https://github.com/autopoies/ap-browser-connect/releases/latest).)*
3. **Load the Extension**: Unzip `ap-browser-extension-*.zip` from [Releases](https://github.com/autopoies/ap-browser-connect/releases/latest), open `chrome://extensions/`, enable **Developer mode**, and click **Load unpacked**.
4. **Register Host & Adapters**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | bash
   git clone https://github.com/autopoies/ap-browser-connect-adapters.git /tmp/abc-adapters
   mkdir -p ~/.ap-browser && cp -R /tmp/abc-adapters/sites /tmp/abc-adapters/filters /tmp/abc-adapters/download-config.yml /tmp/abc-adapters/adapters-version.yml ~/.ap-browser/
   ap-browser ping
   ```

</details>

---

## Why ap-browser-connect?

### Built for both you and your agent

Other tools only go one way: either you chat in a browser sidebar, or an agent clicks around blindly in the background. `ap-browser` does both. Your terminal agent drives tabs by numeric ID (`click 12`), while you press `Cmd+Shift+E` in Chrome to pin elements, highlight text, and chat with that same terminal session on the page.

### One command instead of ten brittle clicks

`ap-browser` ships **47 site adapters** (196 commands) for GitHub, ChatGPT, Gemini, Muse, Gmail, Hacker News, Reddit, X/Twitter, arXiv, Bilibili, Zhihu, and more. One `ap-browser hackernews best --limit 5` returns clean JSON in a single call—cutting tool calls by **67%** and tokens by **88%** while quietly running in a background tab if you're browsing elsewhere.

### Record what happened, with context baked in

`ap-browser record` captures a viewport, CSS region, or element as a **GIF**, **MP4**, or **MOV**. Your agent can stamp live `phase` and `mark` notes onto a bottom strip as it works, making UI checks and multi-run debugging easy to review.

### Your everyday Chrome, 2 MiB of Rust

Connects to your real Chrome profiles (`Personal`, `Work`) over local Native Messaging—your logins, SSO, and 2FA just work. The Rust CLI is **2.05 MiB** (<5 MiB RAM, 26–47 ms latency), and local **Site Filters** strip ads and prompt-injection nodes before page text reaches your model.

---

## What you can do

### Highlight a page and ask your terminal agent in place

Tell your coding agent:

```text
Bind this Chrome tab to our session so I can select parts of this paper and ask you questions inline.
```

Select any passage (`Cmd+Shift+E`) and click **`✦ Ask`**. Your agent gets the selection and streams its reply back into the page:

```bash
ap-browser --tab 42 bind --inbox /path/to/mailbox/inbox/session-01 --label "Paper Reading & Synthesis"
ap-browser reply --event-id "$EVENT_ID" --status running --message "Reading abstract & extracting the 4-component agent taxonomy..."
ap-browser reply --event-id "$EVENT_ID" --status done --message "The survey structures LLM autonomous agents into **4 core modules**: **1. Profiling**, **2. Memory**, **3. Planning**, and **4. Action**."
```

<p align="center">
  <img src="docs/assets/demo-live-copilot.gif" width="840" alt="Live Bound Session & In-Page Copilot on arXiv">
</p>

---

### Pin the exact elements you mean—no selector guessing

Press `Cmd+Shift+E` (or run `ap-browser dev annotate`) to open **Pin Mode**:

```bash
ap-browser dev annotate                  # Open the in-page Pin Mode picker
ap-browser state                         # Read interactive [N] refs + your pinned elements
ap-browser screenshot --annotate         # Overlay [N] badges + green boxes on pinned items
ap-browser click 250                     # Act by ref number — no CSS selectors needed
```

<p align="center">
  <img src="docs/assets/demo-pin-grounding.gif" width="840" alt="Pin Mode on Hacker News">
</p>
<p align="center"><sub>Click to pin multiple items, drag-select text across elements for a single combined pin, and toggle <strong>Select On / Off</strong> to browse normally.</sub></p>

---

### Record the run as a GIF or MP4, with live stage watermarks

Capture a quick clip, or tag each stage of an agent run with `phase` and `mark`:

```bash
ap-browser record --duration 6s --region 560,60,1360,720 --preset balanced --watermark task --label task=wiki-extract --label target=rust-lang --out ./clips/rust-overview.gif

ap-browser record start --max-duration 25s --region 560,60,1360,720 --label task=wiki-extract --label target=rust-lang --run-id R042
ap-browser record phase "$HANDLE" --text "Phase 1: Extract language overview & infobox"
ap-browser record phase "$HANDLE" --text "Phase 2: Inspect Syntax & code examples"
ap-browser record mark "$HANDLE" --text "Extracted infobox: 14 fields verified" --duration 2.4s
ap-browser record stop "$HANDLE"
ap-browser record export "$HANDLE" --size 960 --fps 8 --watermark task --out ./clips/wiki-rust.gif
ap-browser record release "$HANDLE"
```

<p align="center">
  <img src="docs/assets/demo-task-recording.gif" width="840" alt="Recording on Wikipedia with Live Task Watermarks">
</p>

---

### Pull from 47 sites in one command

![Site Adapters Demo](docs/assets/adapters-demo.svg)

```bash
# Web AI apps
ap-browser chatgpt send "Compare Rust async runtimes" --wait
ap-browser gemini menus                                # List Gemini models, thinking levels & tools
ap-browser muse chats                                  # Read Meta Muse threads & side chats

# Code, papers & email
ap-browser github repo-pulls rust-lang/rust            # List open pull requests
ap-browser gmail search "label:unread" --limit 10      # Search, read, send, or reply in Gmail
ap-browser arxiv search "browser agent" --limit 10     # Search arXiv papers
ap-browser google-scholar search "LLM agents"          # Academic search & BibTeX export

# Communities & video
ap-browser hackernews top --limit 10                   # Hacker News front page
ap-browser reddit subreddit rust --limit 10            # Subreddit posts
ap-browser twitter timeline --limit 20                 # Your X/Twitter home timeline
ap-browser bilibili search "Rust"                      # Bilibili video search
ap-browser zhihu hot                                   # Zhihu trending topics
```

See all 47 sites in [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters) or add your own with the [Adapter Guide](skill/references/create-site.md).

---

## Comparison

| | **ap-browser-connect** | Sidebar Browser Agents | Headless Automation | Standard Browser MCPs / CLIs |
| --- | :-: | :-: | :-: | :-: |
| **Runs in your own logged-in Chrome (multi-profile)** | ✅ | ✅ | ❌ | ◐ |
| **Works with any terminal coding agent (no model lock-in)** | ✅ | ◐ | ✅ | ✅ |
| **In-page interaction (`Cmd+Shift+E`) + live session dock** | ✅ | ◐ | ❌ | ❌ |
| **47+ built-in Site Adapters (196 one-call commands)** | ✅ | ❌ | ❌ | ❌ |
| **Viewport / region / element video & GIF recording + task watermarks** | ✅ | ❌ | ◐ | ❌ |
| **Local anti-injection DOM filters & click guards** | ✅ | ❌ | ❌ | ❌ |
| **2 MiB Rust binary, <5 MiB RAM (no Node or Chromium daemon)** | ✅ | ❌ | ❌ | ❌ |

<sub>✅ built in · ◐ partial or needs setup/code · ❌ not supported.</sub>

---

## Command Reference

| Group | Commands | What it does |
| --- | --- | --- |
| **Session Binding** | `bind`, `unbind`, `bindings`, `reply` | Bind a tab/window to a local agent session and stream inline replies |
| **In-Page Interaction & State** | `Cmd+Shift+E`, `dev annotate`, `state`, `screenshot --annotate` | Pin elements on the page; snapshot `[N]` interactive refs and badge overlays |
| **Video & Watermarks** | `record`, `record start/status/stop/export/release`, `record phase/mark/watermark` | Record viewport, region, or element to GIF/MP4/MOV with live task watermarks |
| **Site Adapters** | `sites list`, `sites search <q>`, `sites doc <site>`, `<site> <cmd>` | Run 196+ commands across 47 sites with automatic tab isolation |
| **Navigate & Act** | `goto`, `click`, `fill`, `select`, `upload`, `press`, `scroll`, `wait`, `tabs` | Drive pages by `[N]` ref (`click 12`) or CSS selector; multi-file `upload` |
| **Batch & Power** | `batch`, `eval`, `cdp` | Run multi-step JSON in one round-trip; raw JS (`--raw`) or CDP calls |
| **Capture & Download** | `text`, `html`, `download [--video]`, `pdf`, `mhtml`, `har`, `media` | Cookie-aware downloads and `yt-dlp` streams; export PDF, MHTML, or HAR |
| **DevTools & Setup** | `dev console/network/errors/perf`, `profiles`, `use`, `doctor`, `update` | Inspect console/network logs, switch profiles, run diagnostics, update adapters |

See [CLI Commands](skill/references/commands.md), [Recording Guide](skill/references/recording.md), [Session Receiver Protocol](skill/references/session-receiver.md), [Patterns](skill/references/patterns.md), [Safety Policy](skill/references/safety.md), and [Multi-Profile Guide](skill/references/multi-profile.md).

---

## Architecture & FAQ

![System Architecture](docs/assets/architecture.svg)

- **Do I need an API key in the extension?** No. It connects your browser to the coding agent you already run in your terminal.
- **`download --video` vs `record`?** `download --video` grabs a site's original media stream via `yt-dlp`; `record` captures what the page renders on screen as a `GIF`/`MP4`/`MOV`.
- **Will it hijack my active tab?** No. Site adapters open and close their own background tab whenever your active tab is on another site.
- **Supported OS?** macOS and Linux (tested); Windows is **experimental**.

## License

[Apache-2.0](LICENSE)
