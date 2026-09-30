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
//   WEBRTC_UDP_PORT   — if >0, listen on 0.0.0.0:port and mux all ICE UDP there
//   WEBRTC_NAT1TO1_IP  — comma-separated host/LAN/Tailscale IPs to advertise as
//                       host candidates (replaces container-private addresses)
func (s *Sidecar) startICEMedia() error {
	port := envIntOrDefault("WEBRTC_UDP_PORT", 0)
	ips := parseICEAdvertiseIPs(os.Getenv("WEBRTC_NAT1TO1_IP"))
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
	return nil
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

func parseICEAdvertiseIPs(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if ip := net.ParseIP(p); ip == nil {
			log.Printf("[ICE] Ignoring invalid WEBRTC_NAT1TO1_IP entry %q", p)
			continue
		}
		out = append(out, p)
	}
	return out
}
