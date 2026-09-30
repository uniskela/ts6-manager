package main

import (
	"net"
	"strconv"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestParseICEAdvertiseIPs(t *testing.T) {
	got := parseICEAdvertiseIPs(" 127.0.0.1, 198.51.100.10 ,not-an-ip, ")
	if len(got) != 2 || got[0] != "127.0.0.1" || got[1] != "198.51.100.10" {
		t.Fatalf("parseICEAdvertiseIPs = %#v", got)
	}
	if parseICEAdvertiseIPs("") != nil {
		t.Fatalf("empty should be nil")
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
