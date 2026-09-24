package main

import (
	"testing"
	"time"
)

// A viewer is answered only once ICE gathering completes, and gathering waits
// on every STUN server until it answers or times out. 192.0.2.1 (TEST-NET-1)
// never answers, standing in for a server in the list that has gone away.
func TestUnansweredSTUNServerDoesNotHoldAViewer(t *testing.T) {
	t.Setenv("STUN_SERVERS", "stun:192.0.2.1:3478")
	s := NewSidecar()

	start := time.Now()
	if _, err := s.CreatePeer("stun-timeout-test"); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	if took := time.Since(start); took > stunGatherTimeout+time.Second {
		t.Errorf("CreatePeer took %v; an unanswered STUN server should cost at most about %v", took, stunGatherTimeout)
	}
}
