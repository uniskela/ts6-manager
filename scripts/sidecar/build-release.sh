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

# The published archives must be built with a patched compiler. The floor is
# read from the go.mod directive so it cannot drift from the module, and it
# matches the GO-2026-6859 / CVE-2026-97054 fix line. See #693.
GO_MIN="$(awk '$1 == "go" { print "go" $2; exit }' "$SRC/go.mod")"
if [[ -z "$GO_MIN" ]]; then
  echo "could not read the go directive from $SRC/go.mod" >&2
  exit 1
fi
GO_ACTUAL="$(go version | awk '{print $3}')"
echo "==> Go toolchain: $GO_ACTUAL (minimum $GO_MIN)"
if [[ "$(printf '%s\n%s\n' "$GO_MIN" "$GO_ACTUAL" | sort -V | head -n1)" != "$GO_MIN" ]]; then
  echo "Go toolchain $GO_ACTUAL is below the patched floor $GO_MIN." >&2
  echo "Refusing to build release artifacts with an unpatched compiler." >&2
  exit 1
fi

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
