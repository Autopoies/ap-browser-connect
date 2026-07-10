![Autopoies Browser Connect](docs/assets/banner.png)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg) ![Language](https://img.shields.io/badge/language-Rust-orange.svg) ![Extension](https://img.shields.io/badge/extension-Chrome_MV3-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS_|_Linux-lightgrey.svg) ![Platform](https://img.shields.io/badge/platform-Windows_(experimental)-yellow.svg)

Autopoies Browser Connect is a vendor-neutral Chrome control surface that lets any AI agent drive your *already-logged-in* browser. Instead of spinning up sterile headless instances that require re-authentication, it bridges your agent directly to your daily-driver Chrome via a native host and MV3 extension. It is the missing link for agents that need to read your feeds, fill forms behind login walls, or interact with platforms where you are already authenticated.

---

# 🤖 Agent Quickstart

Paste this into Claude Code, Cursor, Codex, or any coding agent:

```
Install the ap-browser CLI and native host from https://github.com/autopoies/ap-browser-connect/releases, load the extension/ directory unpacked at chrome://extensions, then run `curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | bash` to register its assigned ID. Read skill/SKILL.md for the commands and verify with `ap-browser ping`.
```

That's it. Your agent now drives your logged-in Chrome.

# 👋 Human Quickstart

**1. Install the release binaries:**

```bash
# Download the matching tarball from:
# https://github.com/autopoies/ap-browser-connect/releases/latest
tar xzf ap-browser-*-<target>.tar.gz
sudo cp ap-browser-*-<target>/bin/ap-browser* /usr/local/bin/
```

**2. Load the extension:**

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` directory from this repo

*(Not on the Chrome Web Store in v1 — load-unpacked only.)*

**3. Register the native host:**

```bash
curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | bash
```

For source development, run `cargo install --path cli`, load this checkout's
`extension/`, then run `bash install/install.sh`; it builds the host when no
release host is installed.

**4. Verify and use:**

```bash
ap-browser ping                                          # connection check
ap-browser goto https://news.ycombinator.com             # navigate
ap-browser text                                          # read the page
```

# Why Autopoies Browser Connect?

| | Autopoies Browser Connect | Codex Chrome Extension | Playwright / Puppeteer | browser-use |
|---|---|---|---|---|
| **Login state** | Your real, logged-in Chrome | Your real Chrome | Headless, re-login required | Headless, re-login required |
| **Vendor lock-in** | None — any agent via CLI | OpenAI-only | None, code-only | None, Python-only |
| **Interface** | CLI (`ap-browser`) | Closed UI | JS / Python API | Python API |
| **Works with** | Claude Code, Cursor, Codex, shell | Codex only | Custom scripts | Custom scripts |

## What Agents Can Do

```bash
# Claude Code — read a logged-in feed
claude "Summarize the top 5 posts on my Twitter timeline using ap-browser"

# Cursor — debug a local web app
"Use ap-browser to click 'Login' and capture the console errors."

# Codex — scrape behind a login wall
codex "Go to my internal dashboard with ap-browser and extract the revenue table."

# Plain shell — script your browser
ap-browser goto https://github.com && ap-browser screenshot --out github.png
```

## Commands

The CLI provides 22 commands across 6 groups. For full reference, see `skill/SKILL.md`.

| Group | Commands | Description |
|-------|----------|-------------|
| **Meta** | `ping`, `status`, `profiles`, `use`, `current`, `info` | Connection and profile management |
| **Tabs** | `tabs list`, `tabs new`, `tabs close`, `tabs activate`, `tabs get` | Tab lifecycle and querying |
| **Navigation** | `goto`, `back`, `forward`, `reload` | Page navigation |
| **Read** | `screenshot`, `text`, `html` | Content extraction |
| **Interact** | `click`, `fill`, `press`, `wait` | DOM interaction and input |
| **Power** | `eval` | Execute arbitrary JavaScript |

*Visual Signal: When an agent controls a tab, the extension swaps the favicon, updates the toolbar icon, and displays a Chrome debugger banner to keep you informed.*

## Architecture

The system consists of four main components:
1. **CLI (`ap-browser`)**: The entry point for agents and users.
2. **Native Host (`ap-browser-host`)**: A Rust binary that bridges the Unix socket and the Chrome extension.
3. **Extension**: An MV3 Chrome extension that executes commands in the browser.
4. **TCP Bridge (`ap-browser-bridge`)**: A bridge for containerized Linux testing.

For a deeper dive into the architecture, see `docs/`.

## Site Adapters

For complex sites, generic DOM commands (`click`, `text`) can be brittle. Autopoies Browser Connect supports a YAML-based site adapter system that provides robust, site-specific commands (e.g., `ap-browser hackernews top`). 

Users can clone the adapter library into `~/.ap-browser/sites/` to gain named per-site commands. See the [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters) repository for more details.

## Platforms

- **macOS**: Supported and tested
- **Linux**: Supported and tested
- **Windows**: Experimental (CI compiles, but may fail at runtime)

## FAQ

**What is the security model?**
The `eval` command and DOM interactions are unrestricted. Any agent with access to the `ap-browser` CLI can execute arbitrary JavaScript in your logged-in browser. Only grant access to trusted agents.

**Does it support multiple Chrome profiles?**
Yes. Multi-profile support is built-in via per-instance sockets. Use `ap-browser profiles` and `ap-browser use <profile>` to manage them.

**How is this different from browser-use?**
`browser-use` spins up a fresh, headless browser instance. Autopoies Browser Connect connects to your *existing*, logged-in Chrome instance, allowing agents to act on your behalf without needing to re-authenticate.

**When will it be on the Chrome Web Store?**
The v1 release is load-unpacked only. Web Store distribution is planned for a future release once the API surface stabilizes.

## Contributing

We follow GitHub Flow. PRs welcome — please read `skill/SKILL.md` before proposing changes to the command surface. For adapter contributions (per-site YAML commands), see [ap-browser-connect-adapters](https://github.com/autopoies/ap-browser-connect-adapters).

## License

Apache-2.0

---

**Give your agent a browser it can actually use.**

[![GitHub Stars](https://img.shields.io/github/stars/autopoies/ap-browser-connect.svg?style=social)](https://github.com/autopoies/ap-browser-connect)
[![Twitter Follow](https://img.shields.io/twitter/follow/autopoies.svg?style=social)](https://x.com/autopoies)

*Community: Discord / GitHub Discussions — coming soon.*
