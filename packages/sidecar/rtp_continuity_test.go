package main

import (
	"sort"
	"testing"
	"time"

	"github.com/pion/rtp"
)

func vp8Packet(seq uint16, ts uint32, pic uint16) *rtp.Packet {
	return &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: seq, Timestamp: ts},
		Payload: []byte{0x90, 0x80, 0x80 | byte(pic>>8), byte(pic), 0x00},
	}
}

func TestRTPContinuityPassesFirstRunThrough(t *testing.T) {
	c := rtpContinuity{clockRate: 90000}
	t0 := time.Now()
	for i := uint16(0); i < 3; i++ {
		p := vp8Packet(500+i, 1000+uint32(i)*3000, 7+i)
		c.rewrite(p, codecVP8, t0, nil)
		if p.SequenceNumber != 500+i || p.Timestamp != 1000+uint32(i)*3000 {
			t.Fatalf("packet %d rewritten: seq=%d ts=%d", i, p.SequenceNumber, p.Timestamp)
		}
		if got, _, _ := pictureID(p.Payload, codecVP8); got != 7+i {
			t.Fatalf("picture id %d, want %d", got, 7+i)
		}
	}
}

func TestRTPContinuityCarriesOnAfterRestart(t *testing.T) {
	c := rtpContinuity{clockRate: 90000}
	t0 := time.Now()
	last := vp8Packet(60000, 4_000_000_000, 300)
	c.rewrite(last, codecVP8, t0, nil)

	// A new FFmpeg run: random seq and timestamp, picture ID back at zero.
	c.markRestart()
	first := vp8Packet(12, 5000, 0)
	c.rewrite(first, codecVP8, t0.Add(200*time.Millisecond), nil)
	if first.SequenceNumber != 60001 {
		t.Fatalf("seq=%d, want 60001", first.SequenceNumber)
	}
	if want := uint32(4_000_000_000 + 18000); first.Timestamp != want {
		t.Fatalf("ts=%d, want %d", first.Timestamp, want)
	}
	if got, _, _ := pictureID(first.Payload, codecVP8); got != 301 {
		t.Fatalf("picture id %d, want 301", got)
	}

	next := vp8Packet(13, 8000, 1)
	c.rewrite(next, codecVP8, t0.Add(233*time.Millisecond), nil)
	if next.SequenceNumber != 60002 || next.Timestamp != first.Timestamp+3000 {
		t.Fatalf("next seq=%d ts=%d", next.SequenceNumber, next.Timestamp)
	}
	if got, _, _ := pictureID(next.Payload, codecVP8); got != 302 {
		t.Fatalf("picture id %d, want 302", got)
	}
}

func TestRTPContinuityRebasesOnSequenceJumpWithoutRestartMark(t *testing.T) {
	c := rtpContinuity{clockRate: 48000}
	t0 := time.Now()
	c.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 100, Timestamp: 960}}, "", t0, nil)
	// A leftover packet of the old run consumes the restart mark...
	c.markRestart()
	c.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 101, Timestamp: 1920}}, "", t0.Add(20*time.Millisecond), nil)
	// ...and the new run's jump is still caught.
	p := &rtp.Packet{Header: rtp.Header{SequenceNumber: 40000, Timestamp: 7}}
	c.rewrite(p, "", t0.Add(40*time.Millisecond), nil)
	if p.SequenceNumber != 102 {
		t.Fatalf("seq=%d, want 102", p.SequenceNumber)
	}
}

func TestRTPContinuityKeepsSmallStepsAndTimestampBreaks(t *testing.T) {
	c := rtpContinuity{clockRate: 90000}
	t0 := time.Now()
	c.rewrite(vp8Packet(10, 1000, 0), codecVP8, t0, nil)
	// Same run, an IPTV timestamp break: left to the pacer, not rebased here.
	p := vp8Packet(11, 900_000_000, 1)
	c.rewrite(p, codecVP8, t0, nil)
	if p.SequenceNumber != 11 || p.Timestamp != 900_000_000 {
		t.Fatalf("seq=%d ts=%d rewritten within one run", p.SequenceNumber, p.Timestamp)
	}
}

func TestRTPContinuityLeavesH264PayloadAlone(t *testing.T) {
	c := rtpContinuity{clockRate: 90000}
	t0 := time.Now()
	c.rewrite(&rtp.Packet{Header: rtp.Header{SequenceNumber: 1}, Payload: []byte{0x65, 0x88}}, codecH264, t0, nil)
	c.markRestart()
	p := &rtp.Packet{Header: rtp.Header{SequenceNumber: 9000}, Payload: []byte{0x67, 0x42}}
	c.rewrite(p, codecH264, t0.Add(time.Second), nil)
	if p.SequenceNumber != 2 || p.Payload[0] != 0x67 || p.Payload[1] != 0x42 {
		t.Fatalf("seq=%d payload=%x", p.SequenceNumber, p.Payload)
	}
}

// feed runs arrivals through the read loop's steps: the continuity rewrite,
// then the pacer. seqBase and tsBase stand in for one FFmpeg run's random
// starting points.
func feed(s *Sidecar, seqBase uint16, tsBase map[string]uint32, arrivals ...[]arrival) {
	var all []arrival
	for _, a := range arrivals {
		all = append(all, a...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].arrived.Before(all[j].arrived) })
	for _, a := range all {
		step := uint32(audioStep)
		if a.kind == "video" {
			step = videoStep
		}
		p := &rtp.Packet{Header: rtp.Header{
			SequenceNumber: seqBase + uint16(a.index),
			Timestamp:      tsBase[a.kind] + uint32(a.index)*step,
		}}
		s.continueRTP(a.kind, p, "", a.arrived)
		s.recordFrame(a.kind, p.Timestamp, a.arrived)
	}
}

// After a source switch both tracks must carry on the same clock line, or a
// viewer that keeps the connection pairs them with the old offset and the
// audio and video drift apart.
func TestSwitchKeepsTracksOnOneClockLine(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	first := map[string]uint32{"audio": testAudioRTP, "video": testVideoRTP}
	feed(s, 100, first, frames("audio", t0, 10*time.Millisecond, 10*time.Second),
		frames("video", t0, 530*time.Millisecond, 10*time.Second))

	s.resetSyncTiming()
	t1 := t0.Add(11 * time.Second)
	// The new run starts at unrelated numbers, and its video trails its audio
	// by a different amount than before.
	feed(s, 40000, map[string]uint32{"audio": 7, "video": 3_000_000_000},
		frames("audio", t1, 300*time.Millisecond, 10*time.Second),
		frames("video", t1, 1100*time.Millisecond, 10*time.Second))

	now := t1.Add(9 * time.Second)
	vts, vok := s.senderReportRTPTime("video", now)
	ats, aok := s.senderReportRTPTime("audio", now)
	if !vok || !aok {
		t.Fatalf("both tracks have started, got ok video=%v audio=%v", vok, aok)
	}
	videoMedia := time.Duration(vts-testVideoRTP) * time.Second / 90000
	audioMedia := time.Duration(ats-testAudioRTP) * time.Second / 48000
	if !near(videoMedia, audioMedia) {
		t.Errorf("after the switch reports pair video %v with audio %v on the first run's line; want the same", videoMedia, audioMedia)
	}
	// The new run's media zero lands where the old line was at that instant.
	if want := t1.Add(300 * time.Millisecond).Sub(t0.Add(10 * time.Millisecond)); s.audioTiming.baseRTP-testAudioRTP != uint32(int64(want)*48000/int64(time.Second)) {
		t.Errorf("audio base %d, want old line + %v", s.audioTiming.baseRTP-testAudioRTP, want)
	}
}
