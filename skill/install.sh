#!/usr/bin/env bash
# ap-browser-connect skill installer.
#
# Primary path: `npx skills add autopoies/ap-browser-connect/skill`
# This script is a curl-pipe-bash convenience wrapper that runs the same npx
# command, then prints the URL the agent should read for the CLI/extension/
# adapter install steps (which can't be automated from here — they need
# GitHub Releases binaries + a manual Chrome load-unpacked).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/autopoies/ap-browser-connect/main/skill/install.sh | bash
#
# After this script finishes, the agent (or human) must read install.md in the
# installed skill directory and follow the 4 steps for binaries, Extension,
# native manifest, and adapters/filters.

set -euo pipefail

SKILL_REPO="autopoies/ap-browser-connect/skill"
INSTALL_DOC_URL="https://github.com/autopoies/ap-browser-connect/blob/main/skill/install.md"

if ! command -v npx >/dev/null 2>&1; then
  echo "✗ npx not found. Install Node.js (https://nodejs.org/) and retry," >&2
  echo "  or follow the manual install instructions at:" >&2
  echo "    ${INSTALL_DOC_URL}" >&2
  exit 1
fi

echo "→ Installing skill via npx skills add ${SKILL_REPO}"
npx -y skills add "${SKILL_REPO}"

cat <<EOF

✓ Skill installed. The skill tells your agent how to use ap-browser, but the
  CLI binary, Chrome extension, and site adapters must be installed separately.

→ NEXT: read the install reference and follow the 4 steps:
    ${INSTALL_DOC_URL}

  Or paste this into your agent:
    "Read install.md from the ap-browser-connect skill and follow the 4 install steps (release binaries, extension load-unpacked, native manifest, adapters/filters). Verify with ap-browser ping."

EOF
