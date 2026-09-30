package main

import (
	"fmt"
	"testing"

	"github.com/pion/webrtc/v4"
)

// answerFor plays the viewer: it takes the sidecar's offer and returns an
// answer, as the TeamSpeak client or browser would.
func answerFor(t *testing.T, offer string) string {
	t.Helper()
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("viewer peer: %v", err)
	}
	t.Cleanup(func() { viewer.Close() })
	if err := viewer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatalf("viewer set offer: %v", err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("viewer answer: %v", err)
	}
	if err := viewer.SetLocalDescription(answer); err != nil {
		t.Fatalf("viewer set answer: %v", err)
	}
	return answer.SDP
}

func pendingCount(s *Sidecar, id string) int {
	s.peersLock.RLock()
	peer := s.peers[id]
	s.peersLock.RUnlock()
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return len(peer.pendingICE)
}

func hostCandidate(port int) string {
	return fmt.Sprintf("candidate:1 1 udp 2130706431 192.0.2.10 %d typ host", port)
}

func TestEarlyICECandidatesAreHeldUntilTheAnswer(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	const id = "early-ice"
	offer, err := s.CreatePeer(id, "")
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer(id)

	// Before the answer Pion would reject these with InvalidStateError.
	for port := 50000; port < 50003; port++ {
		if err := s.AddICECandidate(id, hostCandidate(port), "0", 0); err != nil {
			t.Fatalf("early candidate rejected: %v", err)
		}
	}
	if got := pendingCount(s, id); got != 3 {
		t.Fatalf("held %d early candidates, want 3", got)
	}

	if err := s.SetAnswer(id, answerFor(t, offer)); err != nil {
		t.Fatalf("SetAnswer: %v", err)
	}
	if got := pendingCount(s, id); got != 0 {
		t.Errorf("%d candidates still held after the answer", got)
	}

	// After the answer, candidates go straight to the peer connection.
	if err := s.AddICECandidate(id, hostCandidate(50010), "0", 0); err != nil {
		t.Errorf("candidate after answer: %v", err)
	}
	if got := pendingCount(s, id); got != 0 {
		t.Errorf("candidate after the answer was buffered instead of applied")
	}
}

func TestEarlyICEBufferIsCapped(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	const id = "ice-cap"
	if _, err := s.CreatePeer(id, ""); err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer(id)

	for i := 0; i < maxPendingICE+10; i++ {
		if err := s.AddICECandidate(id, hostCandidate(40000+i), "0", 0); err != nil {
			t.Fatalf("candidate %d: %v", i, err)
		}
	}
	if got := pendingCount(s, id); got != maxPendingICE {
		t.Errorf("held %d candidates, want the cap of %d", got, maxPendingICE)
	}
}
