package main

import (
	"net"
	"strconv"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestParseICEAdvertiseIPs(t *testing.T) {
	got, err := parseICEAdvertiseIPs(" 127.0.0.1, 198.51.100.10 , ")
	if err != nil {
		t.Fatalf("parseICEAdvertiseIPs: %v", err)
	}
	if len(got) != 2 || got[0] != "127.0.0.1" || got[1] != "198.51.100.10" {
		t.Fatalf("parseICEAdvertiseIPs = %#v", got)
	}
	got, err = parseICEAdvertiseIPs("")
	if err != nil || got != nil {
		t.Fatalf("empty should be nil,nil; got %#v %v", got, err)
	}
}

func TestParseICEAdvertiseIPsRejectsIPv6AndInvalid(t *testing.T) {
	if _, err := parseICEAdvertiseIPs("2001:db8::1"); err == nil || !strings.Contains(err.Error(), "IPv6") {
		t.Fatalf("expected IPv6 error, got %v", err)
	}
	if _, err := parseICEAdvertiseIPs("not-an-ip"); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("expected invalid error, got %v", err)
	}
}

func TestStartICEMediaMuxAndRewrite(t *testing.T) {
	ln, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.LocalAddr().(*net.UDPAddr).Port
	_ = ln.Close()

	t.Setenv("WEBRTC_UDP_PORT", strconv.Itoa(port))
	t.Setenv("WEBRTC_NAT1TO1_IP", "198.51.100.20")

	s := NewSidecar()
	if err := s.startICEMedia(); err != nil {
		t.Fatalf("startICEMedia: %v", err)
	}
	t.Cleanup(s.stopICEMedia)

	if s.iceUDPMux == nil || s.iceUDPPort != port {
		t.Fatalf("mux not configured: port=%d mux=%v", s.iceUDPPort, s.iceUDPMux != nil)
	}

	se := webrtc.SettingEngine{}
	if err := s.applyICESettings(&se); err != nil {
		t.Fatalf("applyICESettings: %v", err)
	}
}

func TestStartICEMediaRejectsIPv6Advertise(t *testing.T) {
	t.Setenv("WEBRTC_UDP_PORT", "10000")
	t.Setenv("WEBRTC_NAT1TO1_IP", "2001:db8::1")
	s := NewSidecar()
	if err := s.startICEMedia(); err == nil || !strings.Contains(err.Error(), "IPv6") {
		t.Fatalf("expected IPv6 reject, got %v", err)
	}
}

func TestStartICEMediaDisabledByDefault(t *testing.T) {
	t.Setenv("WEBRTC_UDP_PORT", "")
	t.Setenv("WEBRTC_NAT1TO1_IP", "")
	s := NewSidecar()
	if err := s.startICEMedia(); err != nil {
		t.Fatalf("startICEMedia: %v", err)
	}
	if s.iceUDPMux != nil || s.iceUDPPort != 0 {
		t.Fatalf("expected mux disabled, got port=%d", s.iceUDPPort)
	}
}
