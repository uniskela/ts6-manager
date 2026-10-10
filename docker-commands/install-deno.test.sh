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

printf '2.9.7\n' > "$TMP/version"
printf 'x86_64 %s\naarch64 %s\n' \
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

echo "install-deno.test: ok"
