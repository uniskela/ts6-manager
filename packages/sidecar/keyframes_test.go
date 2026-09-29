package main

import "testing"

func TestVP9KeyframeStart(t *testing.T) {
	// Descriptor: B bit only (as ffmpeg writes it), then a profile 0 key
	// frame header: marker 10, profile 00, show_existing 0, frame_type 0.
	key := []byte{0x08, 0x80, 0x00}
	if !isVP9KeyframeStart(key) {
		t.Fatal("expected key frame start")
	}
	// frame_type 1 (inter frame): 10 00 0 1 -> 0x84
	inter := []byte{0x08, 0x84, 0x00}
	if isVP9KeyframeStart(inter) {
		t.Fatal("inter frame must not open the gate")
	}
	// Continuation packet (no B bit).
	if isVP9KeyframeStart([]byte{0x00, 0x80, 0x00}) {
		t.Fatal("non-start packet must not open the gate")
	}
	// P bit set means inter-picture predicted.
	if isVP9KeyframeStart([]byte{0x48, 0x80, 0x00}) {
		t.Fatal("predicted picture must not open the gate")
	}
	// I bit with 15-bit picture id, then key frame header.
	if !isVP9KeyframeStart([]byte{0x88, 0x80, 0x01, 0x80}) {
		t.Fatal("expected key frame after extended picture id")
	}
	// Profile 3 has a reserved bit before show_existing_frame: 10 11 0 0 0 -> 0xB0
	if !isVP9KeyframeStart([]byte{0x08, 0xB0}) {
		t.Fatal("expected profile 3 key frame")
	}
}

func TestH264KeyframeStart(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		want    bool
	}{
		{"single SPS", []byte{0x67, 0x64}, true},
		{"single IDR", []byte{0x65, 0x88}, true},
		{"single non-IDR", []byte{0x41, 0x9a}, false},
		{"STAP-A with SPS", []byte{0x78, 0x00, 0x02, 0x67, 0x64, 0x00, 0x02, 0x68, 0xee}, true},
		{"STAP-A without key", []byte{0x78, 0x00, 0x02, 0x06, 0x05}, false},
		{"FU-A IDR start", []byte{0x7c, 0x85, 0x00}, true},
		{"FU-A IDR middle", []byte{0x7c, 0x05, 0x00}, false},
		{"FU-A non-IDR start", []byte{0x7c, 0x81, 0x00}, false},
		{"empty", nil, false},
	}
	for _, tc := range cases {
		if got := isH264KeyframeStart(tc.payload); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestKeyframeDispatchDefaultsToVP8(t *testing.T) {
	// VP8 descriptor with S bit, PID 0, then key frame tag (bit0 == 0).
	vp8Key := []byte{0x10, 0x00}
	if !isKeyframeStart(codecVP8, vp8Key) || !isKeyframeStart("", vp8Key) {
		t.Fatal("expected VP8 key frame")
	}
}
