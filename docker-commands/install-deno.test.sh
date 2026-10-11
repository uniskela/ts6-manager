#!/bin/sh
# Check install-deno.sh verifies the pinned SHA-256 before installing.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '#!/bin/sh\necho "deno 2.9.7 (test)"\n' > "$TMP/deno"
chmod +x "$TMP/deno"
python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], "deno")' \
  "$TMP/src.zip" "$TMP/deno"
HASH="$(sha256sum "$TMP/src.zip" | awk '{ print $1 }')"

cat > "$TMP/curl" << EOF
#!/bin/sh
out=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$TMP/src.zip" "\$out"
EOF
chmod +x "$TMP/curl"

printf '2.9.7\n' > "$TMP/version"
printf 'x86_64 %s\naarch64 %s\n' "$HASH" "$HASH" > "$TMP/checksums"
mkdir -p "$TMP/bin"

PATH="$TMP:$PATH" \
  DENO_VERSION_FILE="$TMP/version" \
  DENO_CHECKSUM_FILE="$TMP/checksums" \
  DENO_BIN_DIR="$TMP/bin" \
  DENO_ZIP="$TMP/got.zip" \
  sh "$ROOT/docker-commands/install-deno.sh"
test -x "$TMP/bin/deno"
test ! -e "$TMP/got.zip"

# CRLF version/checksum files from a Windows checkout must install too.
printf '2.9.7\r\n' > "$TMP/version"
printf 'x86_64 %s\r\naarch64 %s\r\n' "$HASH" "$HASH" > "$TMP/checksums"
mkdir -p "$TMP/crlf"
PATH="$TMP:$PATH" \
  DENO_VERSION_FILE="$TMP/version" \
  DENO_CHECKSUM_FILE="$TMP/checksums" \
  DENO_BIN_DIR="$TMP/crlf" \
  DENO_ZIP="$TMP/crlf.zip" \
  sh "$ROOT/docker-commands/install-deno.sh"
test -x "$TMP/crlf/deno"
test ! -e "$TMP/crlf.zip"

printf '2.9.7\n' > "$TMP/version"
# Removing CRLF must not bypass checksum mismatch rejection.
printf 'x86_64 %s\r\naarch64 %s\r\n' \
  "0000000000000000000000000000000000000000000000000000000000000000" \
  "0000000000000000000000000000000000000000000000000000000000000000" \
  > "$TMP/checksums"
mkdir -p "$TMP/bad"
if PATH="$TMP:$PATH" \
  DENO_VERSION_FILE="$TMP/version" \
  DENO_CHECKSUM_FILE="$TMP/checksums" \
  DENO_BIN_DIR="$TMP/bad" \
  DENO_ZIP="$TMP/bad.zip" \
  sh "$ROOT/docker-commands/install-deno.sh" >/dev/null 2>&1
then
  echo "install-deno.test: checksum mismatch was accepted" >&2
  exit 1
fi
test ! -e "$TMP/bad/deno"

# Simulate Git's Windows checkout conversion without needing Windows.
mkdir -p "$TMP/checkout"
git -C "$TMP/checkout" init -q
git -C "$TMP/checkout" config core.autocrlf true
cp "$ROOT/.gitattributes" "$ROOT/.deno-checksums" "$TMP/checkout/"
git -C "$TMP/checkout" -c core.safecrlf=false add .gitattributes .deno-checksums
rm "$TMP/checkout/.deno-checksums"
git -C "$TMP/checkout" checkout-index .deno-checksums
if LC_ALL=C grep -q "$(printf '\r')" "$TMP/checkout/.deno-checksums"; then
  echo "install-deno.test: Windows checkout converted checksums to CRLF" >&2
  exit 1
fi

echo "install-deno.test: ok"
