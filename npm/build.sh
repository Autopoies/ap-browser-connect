#!/usr/bin/env bash
# Assemble npm/bin/<target>/ platform binaries from the matching GitHub release.
# Run before `npm publish` (or let CI run it). Requires gh or curl access to
# the public release assets; VERSION defaults to the Cargo.toml version.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(sed -n 's/^version = "\([^"]*\)"/\1/p' ../Cargo.toml | head -1)}"
TAG="v${VERSION}"
REPO="autopoies/ap-browser-connect"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # asset outdir
	local asset="$1" outdir="$2"
	mkdir -p "$outdir"
	if command -v gh >/dev/null 2>&1; then
		(cd "$outdir" && gh release download "$TAG" -R "$REPO" -p "$asset" --clobber)
	else
		curl -fsSL -o "$outdir/$asset" "https://github.com/$REPO/releases/download/$TAG/$asset"
	fi
}

for target in aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
	asset="ap-browser-${TAG}-${target}.tar.gz"
	fetch "$asset" "$TMP"
	mkdir -p "bin/$target"
	tar xzf "$TMP/$asset" -C "bin/$target" --strip-components=2 "ap-browser-${TAG}-${target}/bin"
done

asset="ap-browser-${TAG}-x86_64-pc-windows-msvc.zip"
fetch "$asset" "$TMP"
mkdir -p "bin/x86_64-pc-windows-msvc"
unzip -qo "$TMP/$asset" "bin/*.exe" -d "$TMP/win"
cp "$TMP"/win/bin/*.exe "bin/x86_64-pc-windows-msvc/"

echo "✓ npm/bin assembled for ${TAG}:"
du -sh bin
