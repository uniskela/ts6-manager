#!/bin/sh
# Check install-deno.sh verifies the pinned SHA-256 before installing,
# keeps curl on HTTPS, and refuses an HTTP redirect.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
fixture_pid=""
stop_fixture() {
  if [ -n "${fixture_pid:-}" ]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
    fixture_pid=""
  fi
}
trap 'stop_fixture; rm -rf "$TMP"' EXIT

# Resolve system curl before the fake installer shim is on PATH.
REAL_CURL="$(command -v curl)"
test -n "$REAL_CURL"
test -x "$REAL_CURL"

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

# Real curl against a local fixture: HTTP first hop allowed, HTTP redirect refused.
python3 - "$TMP/fixture.port" "$TMP/fixture.log" <<'PY' &
import http.server, os, socketserver, sys

port_file, log_file = sys.argv[1], sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(log_file, "a", encoding="utf-8") as fh:
            fh.write(self.path + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        if self.path == "/ok":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/redir":
            dest = "http://127.0.0.1:%d/followed" % self.server.server_address[1]
            self.send_response(302)
            self.send_header("Location", dest)
            self.end_headers()
            return
        if self.path == "/followed":
            body = b"followed\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        pass

httpd = socketserver.TCPServer(("127.0.0.1", 0), H)
with open(port_file, "w", encoding="utf-8") as fh:
    fh.write(str(httpd.server_address[1]))
    fh.flush()
    os.fsync(fh.fileno())
httpd.serve_forever()
PY
fixture_pid=$!

i=0
while [ ! -s "$TMP/fixture.port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "install-deno.test: HTTP fixture did not start" >&2
    exit 1
  fi
  sleep 0.1
done
fixture_port="$(cat "$TMP/fixture.port")"

control_err="$TMP/control.err"
control_rc=0
control_body="$("$REAL_CURL" -fsS --noproxy '*' --connect-timeout 2 --max-time 5 \
  "http://127.0.0.1:${fixture_port}/ok" 2>"$control_err")" || control_rc=$?
if [ "$control_rc" -ne 0 ] || [ "$control_body" != "ok" ]; then
  echo "install-deno.test: control request to local fixture failed (exit $control_rc)" >&2
  cat "$control_err" >&2 || true
  exit 1
fi

redir_err="$TMP/redir.err"
redir_rc=0
"$REAL_CURL" -fsSL --noproxy '*' --connect-timeout 2 --max-time 5 \
  --proto '=https,http' --proto-redir '=https' \
  "http://127.0.0.1:${fixture_port}/redir" \
  -o "$TMP/evil.zip" 2>"$redir_err" || redir_rc=$?
if [ "$redir_rc" -eq 7 ]; then
  echo "install-deno.test: curl could not connect before the redirect (exit 7)" >&2
  cat "$redir_err" >&2 || true
  exit 1
fi
if [ "$redir_rc" -ne 1 ]; then
  echo "install-deno.test: expected curl exit 1 rejecting HTTP redirect, got $redir_rc" >&2
  cat "$redir_err" >&2 || true
  exit 1
fi
if ! grep -qiE 'protocol.*"http".*disabled|protocol http not supported or disabled' "$redir_err"; then
  echo "install-deno.test: missing protocol-disabled diagnostic" >&2
  cat "$redir_err" >&2 || true
  exit 1
fi
if ! grep -qx '/redir' "$TMP/fixture.log"; then
  echo "install-deno.test: fixture did not receive the redirect request" >&2
  exit 1
fi
test ! -e "$TMP/evil.zip"
stop_fixture

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
