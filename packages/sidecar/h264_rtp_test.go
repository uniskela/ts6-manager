package main

import (
	"testing"

	"github.com/pion/rtp"
)

func TestH264NALTypesSingleSTAPAndFU(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		want    []byte
	}{
		{"single SPS", []byte{0x67, 0x64, 0x0c, 0x1f}, []byte{7}},
		{"single PPS", []byte{0x68, 0xee}, []byte{8}},
		{"single IDR", []byte{0x65, 0x88}, []byte{5}},
		{"STAP-A SPS+PPS", []byte{0x78, 0x00, 0x04, 0x67, 0x64, 0x0c, 0x1f, 0x00, 0x02, 0x68, 0xee}, []byte{7, 8}},
		{"FU-A IDR start", []byte{0x7c, 0x85, 0x00, 0x01}, []byte{5}},
		{"FU-A IDR middle", []byte{0x7c, 0x05, 0x00}, nil},
		{"empty", nil, nil},
	}
	for _, tc := range cases {
		got := h264NALTypes(tc.payload)
		if len(got) != len(tc.want) {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
				break
			}
		}
	}
}

func TestH264SPSProfileLevelID(t *testing.T) {
	id, ok := h264SPSProfileLevelID([]byte{0x67, 0x64, 0x0c, 0x1f, 0xac})
	if !ok || id != "640c1f" {
		t.Fatalf("got %q ok=%v, want 640c1f", id, ok)
	}
	if _, ok := h264SPSProfileLevelID([]byte{0x65, 0x64, 0x0c, 0x1f}); ok {
		t.Fatal("IDR must not parse as SPS")
	}
	// TeamSpeak offer stays Constrained High; a plain High SPS is 64001f.
	if id, ok := h264SPSProfileLevelID([]byte{0x67, 0x64, 0x00, 0x1f}); !ok || id != "64001f" {
		t.Fatalf("plain High SPS = %q ok=%v", id, ok)
	}
}

func TestH264LateJoinPrefixInjectsSPSAndPPSBeforeIDR(t *testing.T) {
	var c h264ParamCache
	// Stream starts: SPS, PPS, IDR, then P frames — viewer not yet joined.
	c.observe([]byte{0x67, 0x64, 0x0c, 0x1f, 0xac})
	c.observe([]byte{0x68, 0xee, 0x3c})
	c.observe([]byte{0x65, 0x88})
	c.observe([]byte{0x41, 0x9a})

	idr := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: 1000,
			Timestamp:      90000,
			SSRC:           11111111,
			Marker:         true,
		},
		Payload: []byte{0x65, 0x88},
	}
	if !isH264KeyframeStart(idr.Payload) {
		t.Fatal("IDR must open the gate")
	}
	prefix := c.prefixBefore(idr)
	if len(prefix) != 2 {
		t.Fatalf("want SPS+PPS prefix, got %d packets", len(prefix))
	}
	if prefix[0].Timestamp != idr.Timestamp || prefix[1].Timestamp != idr.Timestamp {
		t.Fatal("parameter sets must share the IDR timestamp")
	}
	if prefix[0].Marker || prefix[1].Marker {
		t.Fatal("parameter-set packets must not set the marker bit")
	}
	if prefix[0].PayloadType != 96 || prefix[1].PayloadType != 96 {
		t.Fatal("payload type must match the negotiated video PT")
	}
	if got := h264NALTypes(prefix[0].Payload); len(got) != 1 || got[0] != 7 {
		t.Fatalf("first inject NAL = %v", got)
	}
	if got := h264NALTypes(prefix[1].Payload); len(got) != 1 || got[0] != 8 {
		t.Fatalf("second inject NAL = %v", got)
	}
	// Viewer receives SPS, PPS, then IDR — the required late-join order.
	got := append(h264NALTypes(prefix[0].Payload), h264NALTypes(prefix[1].Payload)...)
	got = append(got, h264NALTypes(idr.Payload)...)
	want := []byte{7, 8, 5}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("viewer NAL order %v want %v", got, want)
		}
	}

	// After a gate reset the peer already delivered seq 100. Continuity numbers
	// the dropped STAP-A as 101 and the IDR as 102; prefix must not reuse 100.
	peer := &Peer{videoOutSeq: 100, videoOutSeqOK: true}
	var seqs []uint16
	for _, p := range append(prefix, idr) {
		out := peer.nextVideoRTP(p)
		seqs = append(seqs, out.SequenceNumber)
	}
	if seqs[0] != 101 || seqs[1] != 102 || seqs[2] != 103 {
		t.Fatalf("per-peer seq after restart = %v, want [101 102 103]", seqs)
	}
}

func TestH264PrefixSkippedWhenPacketAlreadyHasParameterSets(t *testing.T) {
	var c h264ParamCache
	c.observe([]byte{0x67, 0x64, 0x0c, 0x1f})
	c.observe([]byte{0x68, 0xee})
	stap := &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 50, Timestamp: 1, PayloadType: 96},
		Payload: []byte{0x78, 0x00, 0x04, 0x67, 0x64, 0x0c, 0x1f, 0x00, 0x02, 0x68, 0xee},
	}
	if c.prefixBefore(stap) != nil {
		t.Fatal("STAP-A with SPS+PPS must not be prefixed again")
	}
}

func TestH264ParamCacheClears(t *testing.T) {
	var c h264ParamCache
	c.observe([]byte{0x67, 0x64, 0x0c, 0x1f})
	c.observe([]byte{0x68, 0xee})
	c.clear()
	idr := &rtp.Packet{Header: rtp.Header{SequenceNumber: 10}, Payload: []byte{0x65, 0x88}}
	if c.prefixBefore(idr) != nil {
		t.Fatal("cleared cache must not inject")
	}
}

func TestH264GateOpenInfo(t *testing.T) {
	got := h264GateOpenInfo([]byte{0x65, 0x88}, 2)
	if got != "nal=[5] inject=2" {
		t.Fatalf("got %q", got)
	}
	got = h264GateOpenInfo([]byte{0x67, 0x64, 0x0c, 0x1f}, 0)
	if got != "nal=[7] sps=640c1f inject=0" {
		t.Fatalf("got %q", got)
	}
}
