package main

import (
	"testing"
	"time"
)

// Stop clears running while the RTP reader goroutines loop on it. Run with
// -race: a plain bool there was a data race between Stop and the readers.
func TestStopEndsTheRTPReaders(t *testing.T) {
	s := NewSidecar()
	if err := s.StartRTP(); err != nil {
		t.Fatal(err)
	}
	// Let both readers check running and block in Read before Stop.
	time.Sleep(50 * time.Millisecond)
	s.Stop()
	if s.running.Load() {
		t.Fatal("still running after Stop")
	}
}
