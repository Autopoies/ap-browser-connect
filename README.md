![Autopoies Browser Connect](docs/assets/banner.png)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg) ![Language](https://img.shields.io/badge/language-Rust-orange.svg) ![Extension](https://img.shields.io/badge/extension-Chrome_MV3-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS_|_Linux-lightgrey.svg) ![Platform](https://img.shields.io/badge/platform-Windows_(experimental)-yellow.svg)

Autopoies Browser Connect is a vendor-neutral Chrome control surface that lets any AI agent drive your *already-logged-in* browser. Instead of spinning up sterile headless instances that require re-authentication, it bridges your agent directly to your daily-driver Chrome via a native host and MV3 extension. It is the missing link for agents that need to read your feeds, fill forms behind login walls, or interact with platforms where you are already authenticated.

## Why Autopoies Browser Connect?

| Feature | Autopoies Browser Connect | Playwright / Puppeteer | browser-use |
|---------|---------------------------|------------------------|-------------|
| **State** | Uses your real, logged-in Chrome | Headless, requires re-login | Headless, requires re-login |
| **Interface** | CLI (`ap-browser`) | Code (JS/Python) | Code (Python) |
| **Agent fit** | Any agent (Claude Code, Cursor, etc.) | Requires custom script | Requires custom script |

## Quick Start

### 1. Install the CLI

Choose your preferred installation method:

```bash
# L0: Quick install script (macOS/Linux)
curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | sh

# L2: Download pre-compiled binaries from GitHub Releases
# Visit: https://github.com/autopoies/ap-browser-connect/releases

# L3: Build from source via Cargo
cargo install ap-browser
```

### 2. Load the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked** and select the `extension/` directory from this repository.
   *(Note: The extension is plain JS MV3 and is not on the Chrome Web Store in v1).*

### 3. Verify Connection

```bash
ap-browser ping
```

### 4. Try a Command

```bash
ap-browser goto https://news.ycombinator.com && ap-browser text
```

## What Agents Can Do

Agents can use the `ap-browser` CLI to interact with your browser. Just provide them with the `skill/SKILL.md` file.

```bash
# Claude Code: Read a logged-in feed
claude "Summarize the top 5 posts on my Twitter timeline using ap-browser"

# Cursor: Debug a local web app
"Use ap-browser to click the 'Login' button and capture the console errors."

# Codex: Scrape behind a login wall
codex "Go to my internal dashboard with ap-browser and extract the revenue table."

# Plain Shell: Scripting your browser
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

We follow GitHub Flow. PRs are welcome! Please read `skill/SKILL.md` to understand how agents interact with the CLI before proposing changes to the command structure.

## License

Apache-2.0
