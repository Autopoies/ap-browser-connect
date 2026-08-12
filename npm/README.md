# ap-browser-connect

Drive your already-logged-in Chrome from any agent (CLI, coding agent, or script).

```bash
npm install -g ap-browser-connect
```

Installs three commands:

| Command | Role |
| --- | --- |
| `ap-browser` | CLI — tabs, navigation, scraping, adapter commands |
| `ap-browser-host` | Native messaging bridge between Chrome and the CLI |
| `ap-browser-bridge` | TCP bridge for containerized testing |

## What it installs

The package bundles the prebuilt binaries for all supported platforms
(macOS arm64/x64, Linux arm64/x64, Windows x64) and exposes them via
`bin` — no install scripts, no downloads at install time. `bin/` is
assembled from the
[GitHub release](https://github.com/autopoies/ap-browser-connect/releases)
by `npm/build.sh` before publishing.

Platforms: macOS (arm64/x64), Linux (arm64/x64), Windows x64 (experimental).

## Next steps

The CLI needs the Chrome extension loaded and the native messaging manifest
installed before commands will work:

1. Download `ap-browser-extension-<version>.zip` from the
   [latest release](https://github.com/autopoies/ap-browser-connect/releases/latest)
   and load it unpacked at `chrome://extensions` (Developer mode → Load
   unpacked) — Chrome requires this manual step.
2. Install the site adapters:

   ```bash
   git clone https://github.com/autopoies/ap-browser-connect-adapters.git
   mkdir -p ~/.ap-browser
   cp -R ap-browser-connect-adapters/sites ~/.ap-browser/
   cp ap-browser-connect-adapters/download-config.yml ~/.ap-browser/
   ```

3. Verify: `ap-browser ping`

## Development

Source: <https://github.com/autopoies/ap-browser-connect> · Apache-2.0
