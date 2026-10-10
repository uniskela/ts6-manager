#!/bin/sh
# Install a pinned Deno binary for yt-dlp YouTube EJS challenge solving.
# Expects the version string at /tmp/deno-version (copied from .deno-version)
# and arch checksums at /tmp/deno-checksums (copied from .deno-checksums).
set -eu

VERSION_FILE="${DENO_VERSION_FILE:-/tmp/deno-version}"
CHECKSUM_FILE="${DENO_CHECKSUM_FILE:-/tmp/deno-checksums}"
BIN_DIR="${DENO_BIN_DIR:-/usr/local/bin}"
ZIP="${DENO_ZIP:-/tmp/deno.zip}"

DENO_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
test -n "$DENO_VERSION"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DENO_ARCH=x86_64 ;;
  aarch64|arm64) DENO_ARCH=aarch64 ;;
  *)
    echo "install-deno: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

EXPECTED="$(awk -v arch="$DENO_ARCH" '$1 == arch { print $2; exit }' "$CHECKSUM_FILE" | tr 'A-F' 'a-f')"
if ! printf '%s\n' "$EXPECTED" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "install-deno: missing sha256 for $DENO_ARCH" >&2
  exit 1
fi

curl -fsSL \
  "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" \
  -o "$ZIP"
printf '%s  %s\n' "$EXPECTED" "$ZIP" | sha256sum -c -

unzip -qo "$ZIP" deno -d "$BIN_DIR"
if [ -L "$BIN_DIR/deno" ] || [ ! -f "$BIN_DIR/deno" ]; then
  echo "install-deno: archive did not contain a regular deno binary" >&2
  exit 1
fi
chmod +x "$BIN_DIR/deno"
rm -f "$ZIP" "$VERSION_FILE" "$CHECKSUM_FILE"

"$BIN_DIR/deno" --version | head -n 1 | grep -q "^deno ${DENO_VERSION} "
