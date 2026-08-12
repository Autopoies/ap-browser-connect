---
name: ap-browser-connect-install
description: "Installation reference for the ap-browser-connect skill. Loaded by the parent SKILL.md and by the `npx skills add` flow. Tells the agent exactly how to get the ap-browser CLI, the Chrome extension, and the site adapter library onto the machine so the skill's commands work."
---

# Installing ap-browser

This skill shells out to the `ap-browser` CLI. The CLI must be installed, the
Chrome extension must be loaded, and the site adapters must be present in
`~/.ap-browser/sites/` before any command in `SKILL.md` will work. This file
tells you how to install those components and the native messaging manifest.

## TL;DR — paste this into your agent

```
Install ap-browser: run `npx skills add autopoies/ap-browser-connect/skill` if the skill isn't already installed, then read that skill's `install.md` and follow the 4 steps it describes (release binaries, extension load-unpacked, native manifest, adapters/filters). Verify with `ap-browser ping`. If any step fails, open https://github.com/autopoies/ap-browser-connect/blob/main/skill/install.md and follow it manually.
```

## How skill installation works

This skill ships inside `autopoies/ap-browser-connect` at `skill/`
and is compatible with the [vercel-labs/skills](https://github.com/vercel-labs/skills)
CLI convention. To install the skill itself:

```bash
npx skills add autopoies/ap-browser-connect/skill
```

This downloads the skill files into the agent-monitored skills directory
(e.g. `~/.claude/skills/ap-browser-connect/` or `.agents/skills/` depending on
your agent). Once installed, the agent activates this skill on prompts that
match its description.

**Skill installation is NOT the same as CLI installation.** The skill is just
the Markdown that tells the agent how to use `ap-browser`. The CLI binary,
extension, adapters, and site filters still need to be installed separately — that's what the
four steps below cover. The agent reads this file on first activation and
performs the steps.

## The four install steps (after the skill is loaded)

### Step 1 — CLI + native host binaries

The quickest way is npm (ships prebuilt binaries for all platforms, no build):

```bash
npm install -g ap-browser-connect
```

This installs three commands: `ap-browser` (CLI), `ap-browser-host` (native
host), and `ap-browser-bridge` (TCP bridge).

Alternatively, download the prebuilt binary tarball for your OS+arch from the
latest release:

<https://github.com/autopoies/ap-browser-connect/releases/latest>

Tarballs are named `ap-browser-<version>-<target>.tar.gz` and ship three
binaries: `ap-browser` (the CLI), `ap-browser-host` (the native messaging
bridge), and `ap-browser-bridge` (TCP bridge for containerized testing).
Targets shipped per release:

| Target | OS |
| --- | --- |
| `x86_64-apple-darwin` | macOS Intel |
| `aarch64-apple-darwin` | macOS Apple Silicon |
| `x86_64-unknown-linux-gnu` | Linux x86_64 |
| `aarch64-unknown-linux-gnu` | Linux arm64 |
| `x86_64-pc-windows-msvc` | Windows (experimental) |

Install:

```bash
# macOS / Linux
tar xzf ap-browser-*-<target>.tar.gz
sudo cp ap-browser-*-<target>/bin/ap-browser* /usr/local/bin/
```

For source development, clone `autopoies/ap-browser-connect` instead. Step 3
shows how its installer builds and links `ap-browser-host` when no release host
is already installed.

### Step 2 — Chrome extension (manual, Chrome-enforced)

Chrome does not allow scripting the load-unpacked step. Do it by hand once:

1. Download `ap-browser-extension-<version>.zip` from the latest release.
2. Unzip it somewhere stable (e.g. `~/ap-browser-extension/`). The zip
extracts the extension files at its root — the unzipped directory itself is
the extension folder (the tarball's `extension/` subdirectory holds the same
content).
3. Open `chrome://extensions`.
4. Toggle **Developer mode** (top-right).
5. Click **Load unpacked** → select that unzipped directory.
6. (Optional) Pin the extension for visibility.

Repeat the load-unpacked step in every Chrome profile you want `ap-browser` to
drive. Step 3 registers every distinct ID it finds across those profiles.

The extension stays loaded across Chrome restarts. Redo this step only when
upgrading the extension manually. v1 does NOT ship a CRX — Chrome's CRX signing
restrictions make load-unpacked the simpler, more portable choice.

### Step 3 — Native messaging manifest

Now that Chrome has assigned the unpacked Extension an ID, write its native
messaging manifest:

```bash
# Release binaries installed in Step 1:
curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/install/install.sh | bash

# Or, from a source checkout:
bash install/install.sh
```

The installer reuses `/usr/local/bin/ap-browser-host`; from a valid source
checkout with no installed host, it builds and links one. It then writes
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.apbrowser.connect.json`
(macOS) or `~/.config/google-chrome/NativeMessagingHosts/com.apbrowser.connect.json`
(Linux). If it cannot find the loaded **AP Browser Connect** Extension, it
copies the extension + `install_guide.pdf` into `~/ap-browser-extension/`,
opens that folder in your file manager, and fails without writing a placeholder
manifest — it stages the extension + `install_guide.pdf` into
`~/ap-browser-extension/`, opens that folder in your file manager, and waits
(up to 3 min, `AP_BROWSER_WAIT_SECONDS` to override) for you to load the
extension per the guide — no re-run needed. It only fails without writing a
placeholder manifest if the wait times out.

### Step 4 — Site adapters + filters

The site adapter library is published as `autopoies/ap-browser-connect-adapters`.
Install it by cloning into `~/.ap-browser/` so the CLI's runtime loader finds it:

`~/.ap-browser/filters/` is managed runtime data. Back up any local custom
policies before rerunning this step; the directory is replaced so retired
security rules cannot remain active.

```bash
(
  set -e
  adapter_tmp="$(mktemp -d)"
  trap 'rm -rf "$adapter_tmp"' EXIT
  git clone https://github.com/autopoies/ap-browser-connect-adapters.git "$adapter_tmp/repo"
  mkdir -p ~/.ap-browser
  cp -R "$adapter_tmp/repo/sites" ~/.ap-browser/
  rm -rf ~/.ap-browser/filters
  cp -R "$adapter_tmp/repo/filters" ~/.ap-browser/
  cp "$adapter_tmp/repo/download-config.yml" ~/.ap-browser/
)
```

After this, `ap-browser sites list` should print ~43 sites (arxiv, bilibili,
github, hackernews, ...), and `~/.ap-browser/filters/` should contain the
official site-specific content filters.

### Verify

```bash
ap-browser ping                                  # → JSON with ok:true + active profile
ap-browser goto https://news.ycombinator.com && ap-browser text | head -20
ap-browser hackernews top 2>/dev/null | head -5  # adapter command
```

If `ap-browser ping` fails:

- `ECONNREFUSED` → extension not loaded; reload `chrome://extensions` and check the toolbar icon
- `no profile` → open the extension popup and set a label
- `permission denied on /usr/local/bin` → re-run install with sudo

## Updating

- **Skill:** `npx skills update` (or re-run `npx skills add`).
- **CLI:** re-download the tarball from Releases; after reloading the Extension, re-run `install/install.sh` to refresh the manifest.
- **Extension:** re-download `extension.zip`, replace the loaded directory, click "reload" in `chrome://extensions`.
- **Adapters + filters:** re-run Step 4 to refresh adapters and replace the managed filter directory from the same repository revision. Back up local custom filters first.

## Platform support

| OS | Status |
| --- | --- |
| macOS (arm64, x86_64) | Tested |
| Linux (x86_64, arm64) | Tested |
| Windows | Experimental — compiles, untested. Try `cargo install` from source. |

## Reference URLs

| Resource | URL |
| --- | --- |
| Skill (this file) | <https://github.com/autopoies/ap-browser-connect/blob/main/skill/install.md> |
| Product repo (CLI, extension, skill) | <https://github.com/autopoies/ap-browser-connect> |
| Adapters repo (sites) | <https://github.com/autopoies/ap-browser-connect-adapters> |
| Issues | <https://github.com/autopoies/ap-browser-connect/issues> |
