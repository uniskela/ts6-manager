#!/bin/sh
# Install a pinned Deno binary for yt-dlp YouTube EJS challenge solving.
# Expects the version string at /tmp/deno-version (copied from .deno-version).
set -eu

VERSION_FILE="${DENO_VERSION_FILE:-/tmp/deno-version}"
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

curl -fsSL \
  "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" \
  -o /tmp/deno.zip
unzip -qo /tmp/deno.zip -d /usr/local/bin
chmod +x /usr/local/bin/deno
rm -f /tmp/deno.zip "$VERSION_FILE"
deno --version
