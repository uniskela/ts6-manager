#!/bin/sh
# Check install-deno.sh verifies the pinned SHA-256 before installing,
# keeps curl on HTTPS, and refuses an HTTP redirect.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run_install() {
  PATH="$TMP:$PATH" \
    DENO_VERSION_FILE="$TMP/version" \
    DENO_CHECKSUM_FILE="$TMP/checksums" \
    DENO_BIN_DIR="$1" \
    DENO_ZIP="$2" \
    sh "$ROOT/docker-commands/install-deno.sh"
}

printf '#!/bin/sh\necho "deno 2.9.7 (test)"\n' > "$TMP/deno"
chmod +x "$TMP/deno"
python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], "deno")' \
  "$TMP/src.zip" "$TMP/deno"
HASH="$(sha256sum "$TMP/src.zip" | awk '{ print $1 }')"

# Fake curl: allowed HTTPS copy only when the installer pins both proto flags.
# SIMULATE_HTTP_REDIRECT=1 is a GitHub-style 302 to http:// that curl must refuse.
cat > "$TMP/curl" << EOF
#!/bin/sh
proto=""
redir=""
out=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --proto) proto="\$2"; shift 2 ;;
    --proto-redir) redir="\$2"; shift 2 ;;
    -o) out="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "\$proto" != "=https" ] || [ "\$redir" != "=https" ]; then
  echo "curl: HTTPS protocol restriction missing" >&2
  exit 1
fi
if [ "\${SIMULATE_HTTP_REDIRECT:-}" = "1" ]; then
  echo "curl: protocol http not supported or disabled in libcurl" >&2
  exit 1
fi
cp "$TMP/src.zip" "\$out"
EOF
chmod +x "$TMP/curl"

printf '2.9.7\n' > "$TMP/version"
printf 'x86_64 %s\naarch64 %s\n' "$HASH" "$HASH" > "$TMP/checksums"
mkdir -p "$TMP/bin"

run_install "$TMP/bin" "$TMP/got.zip"
test -x "$TMP/bin/deno"
test ! -e "$TMP/got.zip"

# A redirect to http:// must not install anything.
mkdir -p "$TMP/http-redir"
if SIMULATE_HTTP_REDIRECT=1 \
  run_install "$TMP/http-redir" "$TMP/http-redir.zip" >/dev/null 2>&1
then
  echo "install-deno.test: HTTP redirect was accepted" >&2
  exit 1
fi
test ! -e "$TMP/http-redir/deno"
test ! -e "$TMP/http-redir.zip"

# Real curl: 302 to http:// is rejected when --proto-redir is HTTPS-only.
# Same flags the installer now passes (Debian/node image curl supports them).
python3 - "$TMP/redir.port" <<'PY' &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://127.0.0.1:9/evil.zip")
        self.end_headers()
    def log_message(self, *args):
        pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(httpd.server_address[1]))
httpd.handle_request()
PY
redir_pid=$!
trap 'kill "$redir_pid" 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$TMP/redir.port" ] && break
  sleep 0.05
done
test -s "$TMP/redir.port"
redir_port="$(cat "$TMP/redir.port")"
if curl -fsSL --proto-redir '=https' "http://127.0.0.1:${redir_port}/" -o "$TMP/evil.zip"
then
  echo "install-deno.test: curl followed an HTTP redirect" >&2
  exit 1
fi
test ! -e "$TMP/evil.zip"
kill "$redir_pid" 2>/dev/null || true
trap 'rm -rf "$TMP"' EXIT

# CRLF version/checksum files from a Windows checkout must install too.
printf '2.9.7\r\n' > "$TMP/version"
printf 'x86_64 %s\r\naarch64 %s\r\n' "$HASH" "$HASH" > "$TMP/checksums"
mkdir -p "$TMP/crlf"
run_install "$TMP/crlf" "$TMP/crlf.zip"
test -x "$TMP/crlf/deno"
test ! -e "$TMP/crlf.zip"

printf '2.9.7\n' > "$TMP/version"
# Removing CRLF must not bypass checksum mismatch rejection.
printf 'x86_64 %s\r\naarch64 %s\r\n' \
  "0000000000000000000000000000000000000000000000000000000000000000" \
  "0000000000000000000000000000000000000000000000000000000000000000" \
  > "$TMP/checksums"
mkdir -p "$TMP/bad"
if run_install "$TMP/bad" "$TMP/bad.zip" >/dev/null 2>&1
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
