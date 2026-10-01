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

// The TeamSpeak client does not connect to a loopback host candidate even on
// the Docker host itself, so a loopback-only advertise list is worth a warning.
func TestAdvertisesOnlyLoopback(t *testing.T) {
	cases := []struct {
		ips  []string
		want bool
	}{
		{nil, false},
		{[]string{"127.0.0.1"}, true},
		{[]string{"127.0.0.1", "127.0.1.1"}, true},
		{[]string{"127.0.0.1", "192.168.0.7"}, false},
		{[]string{"192.168.0.7"}, false},
	}
	for _, c := range cases {
		if got := advertisesOnlyLoopback(c.ips); got != c.want {
			t.Errorf("advertisesOnlyLoopback(%v) = %v, want %v", c.ips, got, c.want)
		}
	}
}

func TestOfferedAddresses(t *testing.T) {
	sdp := "v=0\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
		"a=candidate:2878742611 1 udp 2130706431 127.0.0.1 10000 typ host ufrag x generation 0\r\n" +
		"a=candidate:2878742611 2 udp 2130706431 127.0.0.1 10000 typ host ufrag x generation 0\r\n" +
		"a=candidate:1574576696 1 udp 1694498815 203.0.113.9 36203 typ srflx raddr 0.0.0.0 rport 36203 ufrag x generation 0\r\n" +
		"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
		"a=candidate:2878742611 1 udp 2130706431 127.0.0.1 10000 typ host ufrag x generation 0\r\n"
	got := offeredAddresses(sdp)
	want := "127.0.0.1:10000 host, 203.0.113.9:36203 srflx"
	if got != want {
		t.Fatalf("offeredAddresses = %q, want %q", got, want)
	}
	if got := offeredAddresses("v=0\r\n"); got != "none" {
		t.Fatalf("offeredAddresses(no candidates) = %q, want none", got)
	}
}
