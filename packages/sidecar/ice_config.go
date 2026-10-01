package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"strings"

	"github.com/pion/webrtc/v4"
)

// startICEMedia binds an optional shared UDP mux for WebRTC ICE (browser preview
// and any other Pion peers). Without a fixed mux port, Docker publishes cannot
// forward the ephemeral ICE ports Pion opens, so host/LAN browsers fail ICE.
//
// Env:
//   WEBRTC_UDP_PORT   — if >0, listen on 0.0.0.0:port (IPv4) and mux all ICE UDP there
//   WEBRTC_NAT1TO1_IP  — comma-separated IPv4 host/LAN/Tailscale IPs to advertise as
//                       host candidates (replaces container-private addresses)
func (s *Sidecar) startICEMedia() error {
	port := envIntOrDefault("WEBRTC_UDP_PORT", 0)
	ips, err := parseICEAdvertiseIPs(os.Getenv("WEBRTC_NAT1TO1_IP"))
	if err != nil {
		return err
	}
	s.iceAdvertiseIPs = ips

	if port <= 0 {
		if len(ips) > 0 {
			log.Printf("[ICE] WEBRTC_NAT1TO1_IP set without WEBRTC_UDP_PORT — address rewrite only; publish a mux UDP port for Docker/host browsers")
		}
		return nil
	}
	if port > 65535 {
		return fmt.Errorf("WEBRTC_UDP_PORT out of range: %d", port)
	}

	// IPv4-only mux: advertised rewrite IPs must also be IPv4 (enforced above).
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: port})
	if err != nil {
		return fmt.Errorf("bind WebRTC UDP mux :%d: %w", port, err)
	}
	s.iceUDPConn = conn
	s.iceUDPMux = webrtc.NewICEUDPMux(nil, conn)
	s.iceUDPPort = port
	log.Printf("[ICE] WebRTC UDP mux listening on :%d", port)

	if len(ips) == 0 {
		log.Printf("[ICE] WEBRTC_NAT1TO1_IP unset — host candidates may use container IPs unreachable from browsers outside the Docker network")
	} else {
		log.Printf("[ICE] Advertising host candidates as %s", strings.Join(ips, ", "))
	}
	if advertisesOnlyLoopback(ips) {
		log.Printf("[ICE] Only loopback is advertised: a browser on this host can open the web UI preview, but the TeamSpeak client cannot connect to loopback, even on this host. %s", teamSpeakReachHint)
	}
	return nil
}

// teamSpeakReachHint says how to give TeamSpeak viewers an address they can use.
const teamSpeakReachHint = "To watch in TeamSpeak, add this host's LAN or Tailscale IPv4 to WEBRTC_NAT1TO1_IP (comma-separated) and publish WEBRTC_UDP_PORT on it (WEBRTC_BIND_IP)."

// advertisesOnlyLoopback reports whether every advertised host address is
// loopback. Chromium connects to a loopback host candidate, but the TeamSpeak
// client does not, even when it runs on the Docker host: it never connects and
// asks to reconnect after about 20 seconds.
func advertisesOnlyLoopback(ips []string) bool {
	if len(ips) == 0 {
		return false
	}
	for _, raw := range ips {
		ip := net.ParseIP(raw)
		if ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	return true
}

// offeredAddresses lists the distinct "ip:port type" candidates in an SDP, for
// a log line that shows what a viewer was asked to reach.
func offeredAddresses(sdp string) string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		// foundation component transport priority address port "typ" type ...
		f := strings.Fields(line)
		if len(f) < 8 || f[6] != "typ" {
			continue
		}
		addr := net.JoinHostPort(f[4], f[5]) + " " + f[7]
		if !seen[addr] {
			seen[addr] = true
			out = append(out, addr)
		}
	}
	if len(out) == 0 {
		return "none"
	}
	return strings.Join(out, ", ")
}

func (s *Sidecar) applyICESettings(se *webrtc.SettingEngine) error {
	if s.iceUDPMux != nil {
		se.SetICEUDPMux(s.iceUDPMux)
	}
	if len(s.iceAdvertiseIPs) == 0 {
		return nil
	}
	return se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:        append([]string(nil), s.iceAdvertiseIPs...),
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:            webrtc.ICEAddressRewriteReplace,
	})
}

func (s *Sidecar) stopICEMedia() {
	if s.iceUDPMux != nil {
		_ = s.iceUDPMux.Close() // also closes the underlying UDP conn
		s.iceUDPMux = nil
		s.iceUDPConn = nil
		return
	}
	if s.iceUDPConn != nil {
		_ = s.iceUDPConn.Close()
		s.iceUDPConn = nil
	}
}

func parseICEAdvertiseIPs(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		ip := net.ParseIP(p)
		if ip == nil {
			return nil, fmt.Errorf("invalid WEBRTC_NAT1TO1_IP entry %q", p)
		}
		if ip.To4() == nil {
			return nil, fmt.Errorf("WEBRTC_NAT1TO1_IP entry %q is IPv6; only IPv4 is supported (UDP mux binds udp4)", p)
		}
		out = append(out, ip.To4().String())
	}
	return out, nil
}
