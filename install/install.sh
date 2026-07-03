#!/usr/bin/env bash
# ap-browser-connect installer (macOS / Linux)
#
# What it does:
#   1. Builds ap-browser-host (release) and symlinks to /usr/local/bin
#   2. Detects Chrome user-data-dir, derives extension ID, writes the
#      native messaging manifest with the correct allowed_origins
#   3. Drops the manifest in ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
#      (macOS) or ~/.config/google-chrome/NativeMessagingHosts/ (Linux)
#
# Usage:
#   ./install/install.sh                # install
#   ./install/install.sh --uninstall    # remove
#
# After install, load the extension unpacked at chrome://extensions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_NAME="com.apbrowser.connect"
HOST_BIN_NAME="ap-browser-host"
HOST_BIN_INSTALL="/usr/local/bin/${HOST_BIN_NAME}"

# OS detection
case "$(uname -s)" in
  Darwin)
    NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROME_USER_DATA="$HOME/Library/Application Support/Google/Chrome"
    ;;
  Linux)
    NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROME_USER_DATA="$HOME/.config/google-chrome"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)." >&2
    echo "  Windows users: run install/install.ps1 in PowerShell." >&2
    exit 1
    ;;
esac

NM_MANIFEST="${NM_DIR}/${HOST_NAME}.json"

uninstall() {
  echo "→ Removing native messaging manifest"
  rm -f "$NM_MANIFEST"
  echo "→ Removing host binary symlink"
  sudo rm -f "$HOST_BIN_INSTALL" 2>/dev/null || rm -f "$HOST_BIN_INSTALL" 2>/dev/null || true
  echo "✓ Uninstalled. The extension itself can be removed from chrome://extensions."
  exit 0
}

[[ "${1:-}" == "--uninstall" ]] && uninstall

# ─── 1. Build host binary ─────────────────────────────────────────────────
echo "→ Building ap-browser-host (release)…"
(cd "$REPO_ROOT" && cargo build --release -p ap-browser-host)
HOST_BIN="${REPO_ROOT}/target/release/${HOST_BIN_NAME}"
if [[ ! -x "$HOST_BIN" ]]; then
  echo "Build failed: $HOST_BIN not found" >&2
  exit 1
fi

echo "→ Symlinking host binary to ${HOST_BIN_INSTALL}"
sudo mkdir -p "$(dirname "$HOST_BIN_INSTALL")" 2>/dev/null || true
sudo ln -sf "$HOST_BIN" "$HOST_BIN_INSTALL" 2>/dev/null || ln -sf "$HOST_BIN" "$HOST_BIN_INSTALL"

# ─── 2. Find extension ID ────────────────────────────────────────────────
# The extension ID is computed from the public key OR assigned at load-unpacked
# time as a hash of the load path. For load-unpacked dev install, the ID is
# stable per machine once loaded.
#
# Strategy:
#   - Scan Preferences files in $CHROME_USER_DATA/{Default,Profile *}
#   - Find the entry for an extension whose name == "ap-browser-connect"
#   - Use that extension's manifest.key for a deterministic ID, or fall back
#     to the runtime-assigned ID stored in Preferences.

echo "→ Looking for extension ID in Chrome Preferences…"

EXT_ID=""
if [[ -d "$CHROME_USER_DATA" ]]; then
  for PREFS in "$CHROME_USER_DATA/Default/Preferences" "$CHROME_USER_DATA/Profile 1/Preferences" "$CHROME_USER_DATA/Profile 2/Preferences"; do
    [[ -f "$PREFS" ]] || continue
    # jq if available, else python
    if command -v jq >/dev/null; then
      EXT_ID=$(jq -r '
        .extensions.settings // {}
        | to_entries[]
        | select(.value.manifest.name == "ap-browser-connect")
        | .key' "$PREFS" 2>/dev/null | head -1 || true)
    else
      EXT_ID=$(python3 -c "
import json,sys
with open('$PREFS') as f: d=json.load(f)
ext=d.get('extensions',{}).get('settings',{})
for k,v in ext.items():
    if v.get('manifest',{}).get('name')=='ap-browser-connect':
        print(k); break
" 2>/dev/null || true)
    fi
    [[ -n "$EXT_ID" ]] && break
  done
fi

if [[ -z "$EXT_ID" ]]; then
  cat >&2 <<EOF
⚠ Could not auto-detect extension ID.
   Load the extension unpacked at chrome://extensions first, then re-run this installer.
   Or edit ${NM_MANIFEST} manually and replace REPLACE_WITH_EXTENSION_ID with the
   32-char ID shown on chrome://extensions after enabling Developer Mode.
EOF
  EXT_ID="REPLACE_WITH_EXTENSION_ID"
fi

echo "  Extension ID: $EXT_ID"

# ─── 3. Write manifest ────────────────────────────────────────────────────
echo "→ Writing native messaging manifest to ${NM_MANIFEST}"
mkdir -p "$NM_DIR"
cat > "$NM_MANIFEST" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "ap-browser-connect native messaging host",
  "path": "${HOST_BIN_INSTALL}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF

echo
echo "✓ Done. Next:"
echo "  1. Load the extension unpacked at: ${REPO_ROOT}/extension"
echo "  2. Open the extension popup to set a label"
echo "  3. Verify with: ap-browser ping"
echo
echo "If the extension ID changes (e.g. new load path), re-run this script."
