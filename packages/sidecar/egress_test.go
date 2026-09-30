package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEgressPolicyCheck(t *testing.T) {
	cases := []struct {
		name  string
		allow []string
		host  string
		ip    string
		ok    bool
	}{
		{"public", nil, "cdn.example", "93.184.216.34", true},
		{"public v6", nil, "cdn.example", "2606:2800:220:1::", true},
		{"loopback", nil, "localhost", "127.0.0.1", false},
		{"loopback range", nil, "x", "127.3.2.1", false},
		{"loopback v6", nil, "x", "::1", false},
		{"metadata", nil, "metadata", "169.254.169.254", false},
		{"metadata v6", nil, "x", "fd00:ec2::254", false},
		{"this network", nil, "x", "0.1.2.3", false},
		{"unspecified", nil, "x", "0.0.0.0", false},
		{"multicast", nil, "x", "239.1.2.3", false},
		{"private unlisted", nil, "threadfin.lan", "192.168.1.20", false},
		{"private v6 unlisted", nil, "x", "fd12::1", false},
		{"private listed ip", []string{"192.168.1.20"}, "threadfin.lan", "192.168.1.20", true},
		{"private listed cidr", []string{"10.0.0.0/8"}, "x", "10.1.2.3", true},
		{"private listed host", []string{"Threadfin.LAN"}, "threadfin.lan", "192.168.1.20", true},
		{"other private host", []string{"192.168.1.20"}, "x", "10.0.0.5", false},
		{"allowlist cannot open loopback", []string{"127.0.0.1", "localhost"}, "localhost", "127.0.0.1", false},
		{"allowlist cannot open metadata", []string{"169.254.0.0/16"}, "x", "169.254.169.254", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &egressPolicy{allow: parseHostAllowlist(tc.allow)}
			err := p.check(tc.host, net.ParseIP(tc.ip))
			if tc.ok && err != nil {
				t.Fatalf("expected allowed, got %v", err)
			}
			if !tc.ok && !errors.Is(err, errEgressBlocked) {
				t.Fatalf("expected blocked, got %v", err)
			}
		})
	}
}

// Tests reach loopback servers through the permitIP hook: 127.0.0.1 stands in
// for an allowed destination and 127.0.0.2 for a blocked one.
var (
	allowedTestIP = net.IPv4(127, 0, 0, 1)
	blockedTestIP = net.IPv4(127, 0, 0, 2)
)

func testPolicy(permitted ...net.IP) *egressPolicy {
	return &egressPolicy{permitIP: func(ip net.IP) bool {
		for _, p := range permitted {
			if p.Equal(ip) {
				return true
			}
		}
		return false
	}}
}

type countingServer struct {
	*httptest.Server
	hits atomic.Int32
}

func startServerOn(t *testing.T, ip net.IP, useTLS bool, h http.Handler) *countingServer {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		t.Skipf("cannot listen on %s: %v", ip, err)
	}
	cs := &countingServer{}
	cs.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cs.hits.Add(1)
		h.ServeHTTP(w, r)
	}))
	cs.Listener.Close()
	cs.Listener = ln
	if useTLS {
		cs.StartTLS()
	} else {
		cs.Start()
	}
	t.Cleanup(cs.Close)
	return cs
}

func startTestProxy(t *testing.T, policy *egressPolicy) *egressProxy {
	t.Helper()
	proxy, err := startEgressProxy(policy)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)
	return proxy
}

func proxiedClient(proxy *egressProxy, followRedirects bool) *http.Client {
	proxyURL, _ := url.Parse(proxy.URL())
	c := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	if !followRedirects {
		c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	return c
}

func okHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
}

func TestEgressProxyBlocksLoopbackByDefault(t *testing.T) {
	srv := startServerOn(t, allowedTestIP, false, okHandler("secret"))
	proxy := startTestProxy(t, &egressPolicy{})

	resp, err := proxiedClient(proxy, true).Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d, want 403", resp.StatusCode)
	}
	if srv.hits.Load() != 0 {
		t.Fatal("blocked server was reached")
	}
}

func TestEgressProxyForwardsAllowedHTTP(t *testing.T) {
	srv := startServerOn(t, allowedTestIP, false, okHandler("hello"))
	proxy := startTestProxy(t, testPolicy(allowedTestIP))

	resp, err := proxiedClient(proxy, true).Get(srv.URL + "/a?b=c")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "hello" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
}

// The proxy passes redirects back to the client; the next hop is a new
// request that is checked again.
func TestEgressProxyChecksEachRedirectHop(t *testing.T) {
	blocked := startServerOn(t, blockedTestIP, false, okHandler("internal"))
	origin := startServerOn(t, allowedTestIP, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, blocked.URL+"/x", http.StatusFound)
	}))
	proxy := startTestProxy(t, testPolicy(allowedTestIP))

	resp, err := proxiedClient(proxy, false).Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != blocked.URL+"/x" {
		t.Fatalf("redirect not passed through: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}

	resp, err = proxiedClient(proxy, true).Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("followed redirect status %d, want 403", resp.StatusCode)
	}
	if blocked.hits.Load() != 0 {
		t.Fatal("redirect target was reached")
	}
}

func TestEgressProxyConnect(t *testing.T) {
	allowed := startServerOn(t, allowedTestIP, true, okHandler("tls ok"))
	blocked := startServerOn(t, blockedTestIP, true, okHandler("internal"))
	proxy := startTestProxy(t, testPolicy(allowedTestIP))
	client := proxiedClient(proxy, true)

	resp, err := client.Get(allowed.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "tls ok" {
		t.Fatalf("got %q", body)
	}

	if _, err := client.Get(blocked.URL); err == nil {
		t.Fatal("CONNECT to a blocked address succeeded")
	}
	if blocked.hits.Load() != 0 {
		t.Fatal("blocked TLS server was reached")
	}
}

func TestEgressProxyRejectsNonProxyRequests(t *testing.T) {
	proxy := startTestProxy(t, &egressPolicy{})
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL(), "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /relative HTTP/1.1\r\nHost: example.com\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}

func TestEgressProxyCloseStopsListening(t *testing.T) {
	proxy, err := startEgressProxy(&egressPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	addr := strings.TrimPrefix(proxy.URL(), "http://")
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Fatalf("proxy must listen on loopback only, got %s", addr)
	}
	proxy.Close()
	proxy.Close() // idempotent
	if conn, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		conn.Close()
		t.Fatal("proxy still accepting after Close")
	}
}

func TestBuildFFmpegArgsRoutesRemoteSourcesThroughEgress(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("vp8")
	s.egress = startTestProxy(t, &egressPolicy{})

	remote := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://cdn.example/live.m3u8"}, spec, false), " ")
	want := "-http_proxy " + s.egress.URL() + " -protocol_whitelist " + egressProtocols
	if !strings.Contains(remote, want) {
		t.Fatalf("remote args lack proxy options: %s", remote)
	}
	if strings.Index(remote, want) > strings.Index(remote, "-i https://cdn.example/live.m3u8") {
		t.Fatalf("proxy options must precede -i: %s", remote)
	}

	local := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4"}, spec, false), " ")
	if strings.Contains(local, "-http_proxy") {
		t.Fatalf("local file got proxy options: %s", local)
	}
}

func TestStopFFmpegClosesEgress(t *testing.T) {
	s := NewSidecar()
	proxy, err := startEgressProxy(&egressPolicy{})
	if err != nil {
		t.Fatal(err)
	}
	s.egress = proxy
	addr := strings.TrimPrefix(proxy.URL(), "http://")
	s.StopFFmpegLocked()
	if s.egress != nil {
		t.Fatal("egress not cleared")
	}
	if conn, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		conn.Close()
		t.Fatal("egress proxy still listening after stop")
	}
}

func TestEgressCommandEnvDropsNoProxy(t *testing.T) {
	t.Setenv("no_proxy", "*")
	t.Setenv("NO_PROXY", "*")
	t.Setenv("SIDECAR_EGRESS_TEST", "kept")
	kept := false
	for _, kv := range egressCommandEnv() {
		name, _, _ := strings.Cut(kv, "=")
		if strings.EqualFold(name, "no_proxy") {
			t.Fatalf("%s passed to ffmpeg", name)
		}
		kept = kept || kv == "SIDECAR_EGRESS_TEST=kept"
	}
	if !kept {
		t.Fatal("other variables dropped")
	}
}

func TestEgressEnabled(t *testing.T) {
	t.Setenv("SIDECAR_EGRESS_PROXY", "")
	if !egressEnabled() {
		t.Fatal("proxy must be on by default")
	}
	t.Setenv("SIDECAR_EGRESS_PROXY", "OFF")
	if egressEnabled() {
		t.Fatal("SIDECAR_EGRESS_PROXY=off must disable the proxy")
	}
}

// TestFFprobeThroughEgress checks the claims the proxy rests on against a real
// ffprobe: HLS segments, redirects and https all go through -http_proxy, so a
// blocked address is never contacted. Runs only with SIDECAR_FFMPEG_IT=1.
func TestFFprobeThroughEgress(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	if _, err := exec.LookPath(getFfprobePath()); err != nil {
		t.Skip("ffprobe not found")
	}
	t.Setenv("SIDECAR_EGRESS_PROXY", "")
	// The proxy must hold even when no_proxy would exempt loopback.
	t.Setenv("no_proxy", "localhost,127.0.0.0/8")

	dir := t.TempDir()
	gen := exec.Command(getFfmpegPath(), "-hide_banner", "-v", "error",
		"-f", "lavfi", "-i", "testsrc2=s=320x240:r=10:d=3",
		"-c:v", "libx264", "-g", "10", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
		filepath.Join(dir, "index.m3u8"))
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("generate HLS: %v %s", err, out)
	}
	files := http.FileServer(http.Dir(dir))

	blocked := startServerOn(t, blockedTestIP, false, files)
	blockedTLS := startServerOn(t, blockedTestIP, true, files)
	origin := startServerOn(t, allowedTestIP, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect.m3u8":
			http.Redirect(w, r, blocked.URL+"/index.m3u8", http.StatusFound)
		case "/remote-segments.m3u8":
			// The playlist is on the allowed host; its segments are not.
			raw, _ := os.ReadFile(filepath.Join(dir, "index.m3u8"))
			var b strings.Builder
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasSuffix(line, ".ts") {
					line = blocked.URL + "/" + line
				}
				b.WriteString(line + "\n")
			}
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			io.WriteString(w, b.String())
		default:
			files.ServeHTTP(w, r)
		}
	}))
	originTLS := startServerOn(t, allowedTestIP, true, files)

	probe := func(source string, permitted ...net.IP) error {
		_, err := probeRemoteSource(context.Background(), source, testPolicy(permitted...))
		return err
	}

	t.Run("allowed playlist", func(t *testing.T) {
		if err := probe(origin.URL+"/index.m3u8", allowedTestIP); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("allowed https", func(t *testing.T) {
		if err := probe(originTLS.URL+"/index.m3u8", allowedTestIP); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("blocked source", func(t *testing.T) {
		before := blocked.hits.Load()
		if err := probe(blocked.URL+"/index.m3u8", allowedTestIP); err == nil {
			t.Fatal("probe of a blocked source succeeded")
		}
		if blocked.hits.Load() != before {
			t.Fatal("blocked server was reached")
		}
	})
	t.Run("blocked https", func(t *testing.T) {
		if err := probe(blockedTLS.URL+"/index.m3u8", allowedTestIP); err == nil {
			t.Fatal("probe of a blocked https source succeeded")
		}
		if blockedTLS.hits.Load() != 0 {
			t.Fatal("blocked TLS server was reached")
		}
	})
	t.Run("redirect to blocked", func(t *testing.T) {
		before := blocked.hits.Load()
		if err := probe(origin.URL+"/redirect.m3u8", allowedTestIP); err == nil {
			t.Fatal("probe followed a redirect to a blocked address")
		}
		if blocked.hits.Load() != before {
			t.Fatal("redirect target was reached")
		}
	})
	t.Run("segments on blocked host", func(t *testing.T) {
		before := blocked.hits.Load()
		_ = probe(origin.URL+"/remote-segments.m3u8", allowedTestIP)
		if blocked.hits.Load() != before {
			t.Fatal("segment host was reached")
		}
	})
	t.Run("segments and redirects go through the proxy", func(t *testing.T) {
		// Same sources with both addresses permitted: they now load, so the
		// blocked cases above failed because of the policy, not the setup.
		before := blocked.hits.Load()
		if err := probe(origin.URL+"/redirect.m3u8", allowedTestIP, blockedTestIP); err != nil {
			t.Fatal(err)
		}
		if err := probe(origin.URL+"/remote-segments.m3u8", allowedTestIP, blockedTestIP); err != nil {
			t.Fatal(err)
		}
		if blocked.hits.Load() == before {
			t.Fatal("expected requests to the second host")
		}
	})
}
