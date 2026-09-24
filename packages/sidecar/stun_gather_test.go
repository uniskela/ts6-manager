package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

// stunMagicCookie is the fixed value at bytes 4-8 of every RFC 5389 STUN
// message; seeing it proves a datagram was a STUN request.
const stunMagicCookie = 0x2112A442

// A viewer is answered only once ICE gathering completes, and gathering waits
// on every STUN server until it answers or times out. The server here is a
// local socket that reads requests and never replies, standing in for a server
// in the list that has gone away.
//
// It has to be a real listener rather than an unroutable address: on a host
// with no route to the address, the send fails at once, gathering completes
// early, and the timing assertion would pass without the timeout ever being
// exercised.
func TestUnansweredSTUNServerDoesNotHoldAViewer(t *testing.T) {
	sink, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer sink.Close()

	var stunRequests atomic.Int32
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := sink.ReadFromUDP(buf)
			if err != nil {
				return // closed at the end of the test
			}
			if n >= 20 && binary.BigEndian.Uint32(buf[4:8]) == stunMagicCookie {
				stunRequests.Add(1)
			}
		}
	}()

	t.Setenv("STUN_SERVERS", fmt.Sprintf("stun:%s", sink.LocalAddr()))
	s := NewSidecar()

	start := time.Now()
	if _, err := s.CreatePeer("stun-timeout-test"); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	took := time.Since(start)

	if stunRequests.Load() == 0 {
		t.Fatalf("no STUN request reached the unanswering server, so the gather timeout was not exercised")
	}
	if took > stunGatherTimeout+time.Second {
		t.Errorf("CreatePeer took %v; an unanswered STUN server should cost at most about %v", took, stunGatherTimeout)
	}
}
