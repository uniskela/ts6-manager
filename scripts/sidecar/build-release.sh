#!/usr/bin/env bash
# Cross-compile the native media sidecar for every supported platform.
#
#   scripts/sidecar/build-release.sh <version> [out-dir]
#
# <version> is the release without a leading "v" (1.11.0); it is stamped into
# the binary and the archive names. Archives and SHA256SUMS land in [out-dir]
# (default: dist/sidecar, which is git-ignored). Set SIDECAR_SKIP_ARCHIVE=1 to
# compile only, which is what PR validation does.
set -euo pipefail

VERSION="${1:?usage: build-release.sh <version> [out-dir]}"
VERSION="${VERSION#v}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${2:-$ROOT/dist/sidecar}"
SRC="$ROOT/packages/sidecar"
NAME="ts6-media-sidecar"

# GOOS/GOARCH pairs. The sidecar is pure Go (CGO_ENABLED=0), so one Linux
# runner builds all of them; the binaries find FFmpeg at run time.
TARGETS=(
  linux/amd64
  linux/arm64
  windows/amd64
  darwin/amd64
  darwin/arm64
)

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

archives=()
for target in "${TARGETS[@]}"; do
  goos="${target%/*}"
  goarch="${target#*/}"
  # macOS is the name operators look for; GOOS stays darwin.
  label="$goos"
  [[ "$goos" == "darwin" ]] && label="macos"
  base="${NAME}_${VERSION}_${label}_${goarch}"
  dir="$STAGE/$base"
  bin="$NAME"
  [[ "$goos" == "windows" ]] && bin="$NAME.exe"

  echo "==> $goos/$goarch"
  mkdir -p "$dir"
  (
    cd "$SRC"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
      -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o "$dir/$bin" .
  )

  if [[ "${SIDECAR_SKIP_ARCHIVE:-0}" == "1" ]]; then
    continue
  fi

  cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$dir/"
  cp "$SRC/packaging/README.md" "$SRC/packaging/sidecar.env.example" "$dir/"
  case "$goos" in
    linux) cp "$SRC/packaging/linux/"* "$dir/" ;;
    darwin) cp "$SRC/packaging/macos/"* "$dir/" ;;
    windows) cp "$SRC/packaging/windows/"* "$dir/" ;;
    *)
      echo "no packaging files for $goos" >&2
      exit 1
      ;;
  esac

  if [[ "$goos" == "windows" ]]; then
    (cd "$STAGE" && zip -qr "$OUT/$base.zip" "$base")
    archives+=("$base.zip")
  else
    tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$OUT/$base.tar.gz" "$base"
    archives+=("$base.tar.gz")
  fi
done

if ((${#archives[@]} > 0)); then
  (cd "$OUT" && sha256sum "${archives[@]}" > SHA256SUMS)
  echo "==> wrote ${#archives[@]} archive(s) and SHA256SUMS to $OUT"
fi
