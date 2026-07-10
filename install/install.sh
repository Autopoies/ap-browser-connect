#!/usr/bin/env bash
# ap-browser-connect installer (macOS / Linux)
#
# What it does:
#   1. Reuses /usr/local/bin/ap-browser-host, or builds it from a source checkout
#   2. Scans all Chrome profiles and writes every distinct extension ID
#      to the native messaging manifest's allowed_origins
#   3. Drops the manifest in ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
#      (macOS) or ~/.config/google-chrome/NativeMessagingHosts/ (Linux)
#
# Usage:
#   ./install/install.sh                # install
#   ./install/install.sh --uninstall    # remove
#
# Load the extension unpacked at chrome://extensions before running this script.

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
REPO_ROOT=""
if [[ -n "$SCRIPT_PATH" && "$SCRIPT_PATH" != /dev/fd/* && -f "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
HOST_NAME="com.apbrowser.connect"
HOST_BIN_NAME="ap-browser-host"
HOST_BIN_INSTALL="${AP_BROWSER_HOST_BIN_INSTALL:-/usr/local/bin/${HOST_BIN_NAME}}"

# OS detection
case "$(uname -s)" in
  Darwin)
    NM_DIR="${AP_BROWSER_NM_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
    CHROME_USER_DATA="${AP_BROWSER_CHROME_USER_DATA:-$HOME/Library/Application Support/Google/Chrome}"
    ;;
  Linux)
    NM_DIR="${AP_BROWSER_NM_DIR:-$HOME/.config/google-chrome/NativeMessagingHosts}"
    CHROME_USER_DATA="${AP_BROWSER_CHROME_USER_DATA:-$HOME/.config/google-chrome}"
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

# ─── 1. Ensure host binary exists ─────────────────────────────────────────
if [[ -x "$HOST_BIN_INSTALL" ]]; then
  echo "→ Reusing installed host binary: ${HOST_BIN_INSTALL}"
elif [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/Cargo.toml" && -f "$REPO_ROOT/host/Cargo.toml" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build ap-browser-host from this source checkout." >&2
    exit 1
  fi
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
else
  echo "Host binary not found at ${HOST_BIN_INSTALL}." >&2
  echo "Install the release binaries first, or run this script from an ap-browser-connect source checkout." >&2
  exit 1
fi

# ─── 2. Find extension IDs across all Chrome profiles ─────────────────────
# Load-unpacked IDs depend on the load path, so different profiles can have
# different IDs. A profile is any user-data subdirectory with Preferences.

echo "→ Looking for extension IDs across all Chrome profiles…"

# Match the current manifest name and the legacy slug.
extract_ids() {
  local prefs="$1"
  if command -v jq >/dev/null; then
    jq -r '
      .extensions.settings // {}
      | to_entries[]
      | select(.value.manifest.name == "AP Browser Connect"
            or .value.manifest.name == "ap-browser-connect")
      | .key' "$prefs" 2>/dev/null || true
  else
    python3 - "$prefs" <<'PY' 2>/dev/null || true
import json
import sys

with open(sys.argv[1]) as f:
    settings = json.load(f).get("extensions", {}).get("settings", {})
for extension_id, value in settings.items():
    if value.get("manifest", {}).get("name") in {"AP Browser Connect", "ap-browser-connect"}:
        print(extension_id)
PY
  fi
}

# macOS ships Bash 3.2, so avoid associative arrays.
ext_seen() {
  local needle="$1" existing
  for existing in ${EXT_IDS[@]+"${EXT_IDS[@]}"}; do
    [[ "$existing" == "$needle" ]] && return 0
  done
  return 1
}

EXT_IDS=()
if [[ -d "$CHROME_USER_DATA" ]]; then
  shopt -s nullglob
  for PREFS in "$CHROME_USER_DATA"/*/Preferences; do
    while IFS= read -r extension_id; do
      [[ -n "$extension_id" ]] || continue
      ext_seen "$extension_id" || EXT_IDS+=("$extension_id")
    done < <(extract_ids "$PREFS")
  done
fi

if [[ ${#EXT_IDS[@]} -eq 0 ]]; then
  cat >&2 <<EOF
✗ Could not auto-detect any AP Browser Connect extension ID.
   Load the extension unpacked at chrome://extensions in each profile you want
   to drive, then re-run this installer. No manifest was written.
EOF
  exit 1
fi

echo "  Found ${#EXT_IDS[@]} extension ID(s):"
for extension_id in "${EXT_IDS[@]}"; do
  echo "    - $extension_id"
done

# ─── 3. Write manifest ────────────────────────────────────────────────────
ORIGINS=$(printf '    "chrome-extension://%s/",\n' "${EXT_IDS[@]}")
ORIGINS="${ORIGINS%,}"

echo "→ Writing native messaging manifest to ${NM_MANIFEST}"
mkdir -p "$NM_DIR"
cat > "$NM_MANIFEST" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "ap-browser-connect native messaging host",
  "path": "${HOST_BIN_INSTALL}",
  "type": "stdio",
  "allowed_origins": [
${ORIGINS}
  ]
}
EOF

echo
echo "✓ Done. Next:"
echo "  1. Open the extension popup in each profile to set a label"
echo "  2. Verify with: ap-browser profiles"
echo "     then:         ap-browser use <id-or-label> && ap-browser ping"
echo
echo "If a profile's extension ID changes (e.g. new load path), re-run this script."
