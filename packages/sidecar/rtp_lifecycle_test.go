package main

import (
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// Stop clears running while the RTP reader goroutines loop on it. Run with
// -race: a plain bool there was a data race between Stop and the readers.
func TestStopEndsTheRTPReaders(t *testing.T) {
	s := NewSidecar()
	if err := s.StartRTP(); err != nil {
		t.Fatal(err)
	}
	// A counted packet shows that reader has checked running and is looping.
	waitForRTPReader(t, "video", s.videoPort, &s.videoPktCount)
	waitForRTPReader(t, "audio", s.audioPort, &s.audioPktCount)
	s.Stop()
	if s.running.Load() {
		t.Fatal("still running after Stop")
	}
}

func waitForRTPReader(t *testing.T, kind string, port int, count *uint64) {
	t.Helper()
	conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	pkt, err := (&rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: 1, Timestamp: 1, SSRC: 1},
		Payload: []byte{0},
	}).Marshal()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadUint64(count) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the %s RTP reader did not read a packet", kind)
		}
		if _, err := conn.Write(pkt); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
