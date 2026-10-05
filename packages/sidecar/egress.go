package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// The backend checks a source URL before sending it here, but ffmpeg then
// follows HTTP redirects and fetches HLS segment URLs on its own. Every
// connection ffmpeg makes for a remote source goes through an egressProxy,
// which checks the address it actually connects to:
//
//   - loopback, link-local (incl. cloud metadata), unspecified and multicast
//     addresses are never reachable;
//   - private (LAN) addresses only when the source's admin-approved allowlist
//     lists them (IPTV sources on a local proxy);
//   - public addresses are reachable.
//
// The address is checked after DNS resolution and the connection is made to
// that exact address, so DNS rebinding cannot swap it afterwards.

var errEgressBlocked = errors.New("destination not allowed")

// egressEnabled is the escape hatch: SIDECAR_EGRESS_PROXY=off runs ffmpeg
// without the proxy (not recommended; the backend URL check still applies).
func egressEnabled() bool {
	return !strings.EqualFold(os.Getenv("SIDECAR_EGRESS_PROXY"), "off")
}

func isRemoteSource(source string) bool {
	return strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://")
}

// egressProtocols are the only protocols ffmpeg may open for a remote source:
// plain TCP only to reach the proxy, and no file, udp or rtp (an SDP or
// playlist response cannot make ffmpeg open anything outside the proxy).
const egressProtocols = "http,https,tls,tcp,httpproxy,crypto"

// egressInputArgs are the ffmpeg/ffprobe input options that send every
// connection for the input through proxyURL. The http and tls protocols pass
// http_proxy on to HLS playlists and segments and to each redirect.
func egressInputArgs(proxyURL string) []string {
	return []string{"-http_proxy", proxyURL, "-protocol_whitelist", egressProtocols}
}

// egressCommandEnv is the environment for an ffmpeg that uses the proxy.
// ffmpeg connects directly to hosts listed in no_proxy, so it is removed.
func egressCommandEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if strings.EqualFold(name, "no_proxy") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

func getFfprobePath() string {
	return envOrDefault("FFPROBE_PATH", "ffprobe")
}

// probeTimeout bounds one POST /probe; the backend waits a little longer.
const probeTimeout = 10 * time.Second

// probeRemoteSource runs ffprobe on source through a temporary egress proxy
// (unless SIDECAR_EGRESS_PROXY=off) and returns ffprobe's JSON.
func probeRemoteSource(ctx context.Context, source string, policy *egressPolicy) ([]byte, error) {
	if !isRemoteSource(source) {
		return nil, errors.New("not a remote source")
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	args := []string{"-v", "error"}
	var env []string
	if egressEnabled() {
		proxy, err := startEgressProxy(policy)
		if err != nil {
			return nil, fmt.Errorf("start egress proxy: %w", err)
		}
		defer proxy.Close()
		args = append(args, egressInputArgs(proxy.URL())...)
		env = egressCommandEnv()
	}
	args = append(args, remoteFFmpegInputArgs()...)
	args = append(args,
		"-rw_timeout", "8000000", // microseconds: bounds each network read
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height:format=duration",
		"-of", "json",
		source,
	)
	cmd := exec.CommandContext(ctx, getFfprobePath(), args...)
	cmd.Env = env
	var stdout bytes.Buffer
	stderr := &tailBuffer{}
	cmd.Stdout = &limitedWriter{w: &stdout, n: 16_000}
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if reason := stderr.summary(); reason != "" {
			return nil, fmt.Errorf("probe failed: %s", reason)
		}
		return nil, fmt.Errorf("probe failed: %w", err)
	}
	return stdout.Bytes(), nil
}

// limitedWriter keeps the first n bytes and discards the rest.
type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		keep := p
		if len(keep) > l.n {
			keep = keep[:l.n]
		}
		written, err := l.w.Write(keep)
		l.n -= written
		if err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// hostAllowlist mirrors the backend's LocalHostAllowlist: IPs, CIDRs and
// hostnames an admin approved for LAN IPTV sources.
type hostAllowlist struct {
	nets  []*net.IPNet
	hosts map[string]bool
}

func parseHostAllowlist(entries []string) *hostAllowlist {
	a := &hostAllowlist{hosts: map[string]bool{}}
	for _, raw := range entries {
		entry := strings.ToLower(strings.TrimSpace(raw))
		if entry == "" {
			continue
		}
		if _, cidr, err := net.ParseCIDR(entry); err == nil {
			a.nets = append(a.nets, cidr)
			continue
		}
		if ip := net.ParseIP(entry); ip != nil {
			bits := 128
			if ip.To4() != nil {
				ip, bits = ip.To4(), 32
			}
			a.nets = append(a.nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		a.hosts[entry] = true
	}
	return a
}

func (a *hostAllowlist) permits(host string, ip net.IP) bool {
	if a == nil {
		return false
	}
	if a.hosts[strings.ToLower(host)] {
		return true
	}
	for _, n := range a.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

var awsMetadataV6 = net.ParseIP("fd00:ec2::254")

// neverAllowedIP matches addresses no allowlist can open.
func neverAllowedIP(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 0 { // "this network" 0.0.0.0/8
			return true
		}
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.Equal(awsMetadataV6)
}

// egressPolicy is one source's rules.
type egressPolicy struct {
	allow *hostAllowlist
	// permitIP lets tests reach loopback test servers; nil in production.
	permitIP func(net.IP) bool
}

func (p *egressPolicy) check(host string, ip net.IP) error {
	if p.permitIP != nil && p.permitIP(ip) {
		return nil
	}
	if neverAllowedIP(ip) {
		return fmt.Errorf("%w: %s is a loopback, link-local or reserved address", errEgressBlocked, host)
	}
	if ip.IsPrivate() && !p.allow.permits(host, ip) {
		return fmt.Errorf("%w: %s is a private address that is not an allowed local IPTV host", errEgressBlocked, host)
	}
	return nil
}

// dial resolves addr, keeps only the addresses the policy allows, and
// connects to one of those exact addresses.
func (p *egressPolicy) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, a := range addrs {
			ips = append(ips, a.IP)
		}
	}
	var lastErr error = fmt.Errorf("%w: %s did not resolve", errEgressBlocked, host)
	for _, ip := range ips {
		if err := p.check(host, ip); err != nil {
			lastErr = err
			continue
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if errors.Is(lastErr, errEgressBlocked) {
		log.Printf("[Egress] Blocked connection: %v", lastErr)
	}
	return nil, lastErr
}

// egressProxy is a loopback-only forward proxy (absolute-URI GET for http,
// CONNECT for https) enforcing one egressPolicy. It never follows redirects:
// ffmpeg does, through the proxy, so each hop is checked again.
type egressProxy struct {
	policy    *egressPolicy
	listener  net.Listener
	server    *http.Server
	transport *http.Transport
	closeOnce sync.Once
}

func startEgressProxy(policy *egressPolicy) (*egressProxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &egressProxy{policy: policy, listener: ln}
	p.transport = &http.Transport{
		Proxy:                 nil,
		DialContext:           policy.dial,
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       60 * time.Second,
	}
	p.server = &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second}
	go func() {
		if err := p.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[Egress] Proxy stopped: %v", err)
		}
	}()
	return p, nil
}

// URL is the value for ffmpeg's -http_proxy.
func (p *egressProxy) URL() string {
	return "http://" + p.listener.Addr().String()
}

func (p *egressProxy) Close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		// Serve may not have taken the listener yet, so close it here too.
		p.listener.Close()
		p.server.Close()
		p.transport.CloseIdleConnections()
	})
}

// Hop-by-hop headers are not forwarded (RFC 9110 §7.6.1).
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func (p *egressProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.serveConnect(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "proxy forwards absolute http:// URLs and CONNECT only", http.StatusBadRequest)
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	resp, err := p.transport.RoundTrip(out)
	if err != nil {
		writeEgressError(w, err)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	// Live streams never end: flush as data arrives.
	copyFlushing(w, resp.Body)
}

func (p *egressProxy) serveConnect(w http.ResponseWriter, r *http.Request) {
	upstream, err := p.policy.dial(r.Context(), "tcp", r.Host)
	if err != nil {
		writeEgressError(w, err)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		client.Close()
		upstream.Close()
		return
	}
	go func() {
		defer upstream.Close()
		defer client.Close()
		// Anything the client sent right after CONNECT is already buffered.
		if n := buf.Reader.Buffered(); n > 0 {
			pending, _ := buf.Reader.Peek(n)
			if _, err := upstream.Write(pending); err != nil {
				return
			}
		}
		done := make(chan struct{}, 2)
		go func() { io.Copy(upstream, client); done <- struct{}{} }()
		go func() { io.Copy(client, upstream); done <- struct{}{} }()
		<-done
	}()
}

func writeEgressError(w http.ResponseWriter, err error) {
	if errors.Is(err, errEgressBlocked) {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
}

func copyFlushing(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
