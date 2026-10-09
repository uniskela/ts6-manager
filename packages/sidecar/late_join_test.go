package main

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// testViewer is a Pion peer standing in for a TeamSpeak client or browser: it
// answers the sidecar's offer and records the video RTP it is actually sent,
// after SRTP and the sidecar's per-peer numbering.
type testViewer struct {
	id    string
	pc    *webrtc.PeerConnection
	video chan *rtp.Packet
}

// startViewer creates the sidecar peer and answers it, without waiting for the
// connection to come up.
func startViewer(t *testing.T, s *Sidecar, id, codec string) *testViewer {
	t.Helper()
	t.Setenv("STUN_SERVERS", "")
	offer, err := s.CreatePeer(id, codec)
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	t.Cleanup(func() { s.ClosePeer(id) })

	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: codecCapability(codec),
		PayloadType:        96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("viewer peer: %v", err)
	}
	t.Cleanup(func() { pc.Close() })

	v := &testViewer{id: id, pc: pc, video: make(chan *rtp.Packet, 256)}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			v.video <- pkt
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatalf("viewer set offer: %v", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("viewer answer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("viewer set answer: %v", err)
	}
	<-gathered
	if err := s.SetAnswer(id, pc.LocalDescription().SDP); err != nil {
		t.Fatalf("SetAnswer: %v", err)
	}
	return v
}

// joinViewer is startViewer for a viewer that has fully connected: its gate is
// armed and the sidecar can send it media.
func joinViewer(t *testing.T, s *Sidecar, id, codec string) *testViewer {
	t.Helper()
	v := startViewer(t, s, id, codec)
	s.peersLock.RLock()
	peer := s.peers[id]
	s.peersLock.RUnlock()
	waitFor(t, "viewer "+id+" to connect", func() bool {
		peer.mu.Lock()
		armed := peer.Active
		peer.mu.Unlock()
		return armed && peer.PC.ConnectionState() == webrtc.PeerConnectionStateConnected &&
			v.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	return v
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// next returns the next video packet the viewer received.
func (v *testViewer) next(t *testing.T) *rtp.Packet {
	t.Helper()
	select {
	case pkt := <-v.video:
		return pkt
	case <-time.After(5 * time.Second):
		t.Fatalf("viewer %s received no video packet", v.id)
		return nil
	}
}

// Test streams, as FFmpeg's RTP muxer packetizes them.
var (
	testSPS = []byte{0x67, 0x64, 0x0c, 0x1f, 0xac}
	testPPS = []byte{0x68, 0xee, 0x3c}
	// STAP-A carrying SPS and PPS: what an encoder that repeats its headers
	// sends ahead of each IDR.
	h264Params = []byte{0x78, 0x00, 0x05, 0x67, 0x64, 0x0c, 0x1f, 0xac, 0x00, 0x03, 0x68, 0xee, 0x3c}
	h264IDR    = []byte{0x7c, 0x85, 0x88, 0x84} // FU-A start of an IDR slice
	h264Delta  = []byte{0x41, 0x9a, 0x02}
	vp8Key     = []byte{0x10, 0x00, 0x9d, 0x01, 0x2a}
	vp8Delta   = []byte{0x10, 0x01, 0x02}
)

// testStream feeds the sidecar as FFmpeg's RTP output would, one packet at a
// time, numbering them in order.
type testStream struct {
	s   *Sidecar
	seq uint16
	ts  uint32
}

func (f *testStream) send(payload []byte) *rtp.Packet {
	pkt := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: f.seq,
			Timestamp:      f.ts,
			SSRC:           0x1234,
		},
		Payload: append([]byte(nil), payload...),
	}
	f.seq++
	f.s.forwardVideoRTP(pkt)
	return pkt
}

// frame moves on to the next frame's timestamp.
func (f *testStream) frame() { f.ts += 3000 }

// lose drops one packet between FFmpeg and the viewers, as a full queue does.
func (f *testStream) lose() { f.seq++ }

func nalTypes(t *testing.T, pkts ...*rtp.Packet) []byte {
	t.Helper()
	var out []byte
	for _, p := range pkts {
		out = append(out, h264NALTypes(p.Payload)...)
	}
	return out
}

func sameBytes(a, b []byte) bool { return string(a) == string(b) }

// A viewer who joins well into a stream whose encoder sent SPS/PPS only once,
// at the start (h264_amf without header_spacing), must still be handed the
// parameter sets ahead of the first IDR it sees.
func TestLateH264ViewerGetsParameterSetsBeforeABareIDR(t *testing.T) {
	s := NewSidecar()
	s.streamCodec.Store(codecH264)
	stream := &testStream{s: s, seq: 5000, ts: 90000}

	// The stream starts with nobody watching.
	stream.send(h264Params)
	stream.send(h264IDR)
	for i := 0; i < 30; i++ {
		stream.frame()
		stream.send(h264Delta)
	}

	v := joinViewer(t, s, "late-h264", codecH264)

	// Nothing a decoder cannot start from reaches the viewer.
	stream.frame()
	stream.send(h264Delta)
	stream.frame()
	idr := stream.send(h264IDR)
	stream.frame()
	stream.send(h264Delta)

	sps, pps, first, delta := v.next(t), v.next(t), v.next(t), v.next(t)
	if got := nalTypes(t, sps, pps, first, delta); !sameBytes(got, []byte{7, 8, 5, 1}) {
		t.Fatalf("viewer received NAL types %v, want SPS, PPS, IDR, then the next frame", got)
	}
	if !sameBytes(sps.Payload, testSPS) || !sameBytes(pps.Payload, testPPS) {
		t.Fatalf("parameter sets changed on the way: sps=%x pps=%x", sps.Payload, pps.Payload)
	}
	if sps.Timestamp != idr.Timestamp || pps.Timestamp != idr.Timestamp || first.Timestamp != idr.Timestamp {
		t.Fatalf("parameter sets must share the IDR's timestamp %d, got %d %d %d",
			idr.Timestamp, sps.Timestamp, pps.Timestamp, first.Timestamp)
	}
	if sps.Marker || pps.Marker {
		t.Fatal("a parameter set must not end the frame")
	}
	for i, p := range []*rtp.Packet{pps, first, delta} {
		if want := sps.SequenceNumber + uint16(i) + 1; p.SequenceNumber != want {
			t.Fatalf("packet %d has sequence %d, want %d: the viewer would see a loss or a replay", i+1, p.SequenceNumber, want)
		}
	}
}

// With an encoder that repeats its headers (libx264 repeat-headers, NVENC,
// AMF header_spacing) the viewer starts on the stream's own SPS/PPS and
// nothing is added.
func TestLateH264ViewerStartsOnRepeatedHeadersUnchanged(t *testing.T) {
	s := NewSidecar()
	s.streamCodec.Store(codecH264)
	stream := &testStream{s: s, seq: 100, ts: 1000}
	stream.send(h264Params)
	stream.send(h264IDR)

	v := joinViewer(t, s, "late-h264-repeat", codecH264)

	stream.frame()
	stream.send(h264Delta)
	stream.frame()
	params := stream.send(h264Params)
	stream.send(h264IDR)

	first, second := v.next(t), v.next(t)
	if !sameBytes(first.Payload, h264Params) || !sameBytes(second.Payload, h264IDR) {
		t.Fatalf("viewer received %x then %x, want the stream's own SPS/PPS and IDR", first.Payload, second.Payload)
	}
	if first.SequenceNumber != params.SequenceNumber || second.SequenceNumber != params.SequenceNumber+1 {
		t.Fatalf("sequence numbers %d, %d: a packet was added ahead of the headers", first.SequenceNumber, second.SequenceNumber)
	}
}

// A packet lost before the sidecar forwards it must stay a gap in what the
// viewer receives. Numbered over, the viewer takes the damaged frame for a
// whole one and decodes it, instead of holding the picture until the next
// keyframe. This is the same for every codec and encoder.
func TestLostPacketStaysVisibleToTheViewer(t *testing.T) {
	cases := []struct {
		codec      string
		key, delta []byte
		opening    int // packets the viewer is sent when its gate opens
	}{
		{codecVP8, vp8Key, vp8Delta, 1},
		{codecH264, h264IDR, h264Delta, 3},
	}
	for _, tc := range cases {
		t.Run(tc.codec, func(t *testing.T) {
			s := NewSidecar()
			s.streamCodec.Store(tc.codec)
			stream := &testStream{s: s, seq: 65530, ts: 1000}
			if tc.codec == codecH264 {
				stream.send(h264Params)
			}
			v := joinViewer(t, s, "loss-"+tc.codec, tc.codec)

			stream.send(tc.key)
			var last *rtp.Packet
			for i := 0; i < tc.opening; i++ {
				last = v.next(t)
			}
			stream.frame()
			stream.send(tc.delta)
			if got := v.next(t); got.SequenceNumber != last.SequenceNumber+1 {
				t.Fatalf("sequence %d after %d without a loss", got.SequenceNumber, last.SequenceNumber)
			}
			stream.lose()
			stream.frame()
			stream.send(tc.delta)
			if got := v.next(t); got.SequenceNumber != last.SequenceNumber+3 {
				t.Fatalf("sequence %d after a lost packet, want %d: the loss was hidden from the viewer",
					got.SequenceNumber, last.SequenceNumber+3)
			}
		})
	}
}

// VP8 has no parameter sets: a late viewer waits for a keyframe and is then
// sent the stream exactly as it is.
func TestLateVP8ViewerStartsAtTheKeyframeUnchanged(t *testing.T) {
	s := NewSidecar()
	stream := &testStream{s: s, seq: 300, ts: 1000}
	stream.send(vp8Key)

	v := joinViewer(t, s, "late-vp8", codecVP8)

	stream.frame()
	stream.send(vp8Delta)
	stream.frame()
	key := stream.send(vp8Key)
	stream.frame()
	delta := stream.send(vp8Delta)

	first, second := v.next(t), v.next(t)
	if !sameBytes(first.Payload, vp8Key) || first.SequenceNumber != key.SequenceNumber || first.Timestamp != key.Timestamp {
		t.Fatalf("first packet seq=%d ts=%d payload=%x, want the keyframe as sent (seq=%d ts=%d)",
			first.SequenceNumber, first.Timestamp, first.Payload, key.SequenceNumber, key.Timestamp)
	}
	if !sameBytes(second.Payload, vp8Delta) || second.SequenceNumber != delta.SequenceNumber {
		t.Fatalf("second packet seq=%d payload=%x, want the next frame as sent", second.SequenceNumber, second.Payload)
	}
}

// Switching the source restarts FFmpeg. A connected viewer is held until the
// new run's keyframe, is not sent the old run's parameter sets, and sees no
// gap or repeat in its sequence numbers across the switch.
func TestSourceSwitchHoldsTheViewerForTheNewKeyframe(t *testing.T) {
	s := NewSidecar()
	s.streamCodec.Store(codecH264)
	stream := &testStream{s: s, seq: 100, ts: 1000}
	v := joinViewer(t, s, "switch-h264", codecH264)

	stream.send(h264Params)
	stream.send(h264IDR)
	stream.frame()
	stream.send(h264Delta)
	v.next(t)
	v.next(t)
	last := v.next(t)

	// What StartFFmpeg does between two runs.
	s.resetSyncTiming()
	s.resetPeerStreamState()

	// The new run's headers are lost, so its first IDR arrives bare. The old
	// run's SPS/PPS describe another stream and must not be put in front.
	stream.seq = 40000
	stream.frame()
	stream.send(h264Delta)
	stream.frame()
	stream.send(h264IDR)
	stream.frame()
	stream.send(h264Params)
	stream.send(h264IDR)

	first := v.next(t)
	if got := nalTypes(t, first); !sameBytes(got, []byte{5}) {
		t.Fatalf("first packet after the switch has NAL types %v, want the bare IDR alone", got)
	}
	if first.SequenceNumber != last.SequenceNumber+1 {
		t.Fatalf("sequence %d after %d across the switch", first.SequenceNumber, last.SequenceNumber)
	}
	// The new run's own headers follow in the stream and are passed on.
	params, idr := v.next(t), v.next(t)
	if !sameBytes(params.Payload, h264Params) || !sameBytes(idr.Payload, h264IDR) {
		t.Fatalf("new run's headers not passed on: %x then %x", params.Payload, idr.Payload)
	}
	if params.SequenceNumber != first.SequenceNumber+1 || idr.SequenceNumber != first.SequenceNumber+2 {
		t.Fatalf("sequences %d %d %d are not consecutive", first.SequenceNumber, params.SequenceNumber, idr.SequenceNumber)
	}
}

// A switch to another codec leaves a viewer negotiated for the old one with
// nothing: it cannot decode the new stream, and is recreated by the backend.
func TestCodecSwitchSendsNothingToAViewerOfTheOldCodec(t *testing.T) {
	s := NewSidecar()
	s.streamCodec.Store(codecH264)
	stream := &testStream{s: s, seq: 100, ts: 1000}
	old := joinViewer(t, s, "old-h264", codecH264)
	stream.send(h264Params)
	old.next(t)

	s.resetSyncTiming()
	s.resetPeerStreamState()
	s.streamCodec.Store(codecVP8)
	fresh := joinViewer(t, s, "new-vp8", codecVP8)
	stream.frame()
	stream.send(vp8Key)

	if got := fresh.next(t); !sameBytes(got.Payload, vp8Key) {
		t.Fatalf("VP8 viewer received %x, want the keyframe", got.Payload)
	}
	select {
	case pkt := <-old.video:
		t.Fatalf("H.264 viewer was sent a VP8 packet: %x", pkt.Payload)
	case <-time.After(200 * time.Millisecond):
	}
}

// ICE connects before the DTLS handshake is done, and until then the sidecar
// has nothing to send media over. A keyframe arriving in between must not use
// up the viewer's gate: it would lose that keyframe, and with it the only
// SPS/PPS the sidecar puts in front of a bare IDR.
func TestGateWaitsUntilMediaCanBeSent(t *testing.T) {
	s := NewSidecar()
	s.streamCodec.Store(codecH264)
	stream := &testStream{s: s, seq: 100, ts: 1000}
	stream.send(h264Params)
	stream.send(h264IDR)

	v := startViewer(t, s, "early-idr", codecH264)
	s.peersLock.RLock()
	peer := s.peers[v.id]
	s.peersLock.RUnlock()

	// Send bare IDRs from the moment ICE is up, as a running stream does.
	waitFor(t, "ICE to connect", func() bool {
		peer.mu.Lock()
		defer peer.mu.Unlock()
		return peer.Active
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stream.frame()
		stream.send(h264IDR)
		select {
		case first := <-v.video:
			if got := nalTypes(t, first); !sameBytes(got, []byte{7}) {
				t.Fatalf("viewer's first packet has NAL types %v, want the SPS: its gate opened before media could be sent", got)
			}
			return
		case <-time.After(time.Millisecond):
		}
	}
	t.Fatal("viewer received no video")
}
