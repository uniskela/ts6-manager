package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

// The H.264 profiles two browsers list. Constrained High, 640c1f, is in
// neither. Chromium's are from RTCRtpReceiver.getCapabilities (Chromium 152);
// Firefox takes Baseline-class H.264 only.
var (
	chromiumH264 = []string{"42001f", "42e01f", "4d001f", "f4001f", "64001f"}
	firefoxH264  = []string{"42001f", "42e01f"}
)

var h264FmtpLine = regexp.MustCompile(`^a=fmtp:(\d+) .*profile-level-id=([0-9a-fA-F]{6})`)

// asSeenByBrowser drops from offer the H.264 payload types a browser with the
// listed profiles does not know, which is what a browser does with them: it ignores them, and answers
// with what is left. Pion would accept them (it matches H.264 profiles
// loosely), so a Pion peer alone is not a faithful browser. The second result
// is how many video payload types the browser is left with.
func asSeenByBrowser(t *testing.T, offer string, listed []string) (string, int) {
	t.Helper()
	drop := map[string]bool{}
	for _, line := range strings.Split(offer, "\r\n") {
		m := h264FmtpLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		known := false
		for _, p := range listed {
			known = known || strings.EqualFold(p, m[2])
		}
		if !known {
			drop[m[1]] = true
		}
	}
	var out []string
	left := 0
	for _, line := range strings.Split(offer, "\r\n") {
		if strings.HasPrefix(line, "m=video ") {
			fields := strings.Fields(line)
			kept := fields[:3]
			for _, pt := range fields[3:] {
				if !drop[pt] {
					kept = append(kept, pt)
					left++
				}
			}
			line = strings.Join(kept, " ")
		}
		skip := false
		for pt := range drop {
			for _, attr := range []string{"a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"} {
				skip = skip || strings.HasPrefix(line, attr+pt+" ")
			}
		}
		if !skip {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\r\n"), left
}

// browserAnswer answers offer as a browser that knows the H.264 variant fmtp
// and Opus.
func browserAnswer(t *testing.T, offer, fmtp string) string {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: fmtp},
		PayloadType:        109,
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
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatalf("browser rejected the offer: %v", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("browser could not answer: %v", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	return answer.SDP
}

// The web UI preview failed with HTTP 500 for every H.264 stream: the offer
// carried Constrained High alone, a browser answered with no video codec, and
// SetAnswer could not start the video track ("codec is not supported by
// remote").
func TestBrowserPeerIsOfferedWhatBrowsersTake(t *testing.T) {
	cases := []struct {
		browser string
		listed  []string
		left    int    // video payload types the browser is left with
		answers string // the variant it answers with
	}{
		{"chromium", chromiumH264, 2, h264HighFmtp},
		{"firefox", firefoxH264, 1, h264ConstrainedBaselineFmtp},
	}
	for _, tc := range cases {
		t.Run(tc.browser, func(t *testing.T) {
			t.Setenv("STUN_SERVERS", "")
			s := NewSidecar()
			offer, err := s.CreatePeerFor("webui-preview", codecH264, true)
			if err != nil {
				t.Fatalf("CreatePeerFor: %v", err)
			}
			defer s.ClosePeer("webui-preview")

			// Constrained High first, then High, then Constrained Baseline: a
			// browser takes the first it knows.
			hi, base := strings.Index(offer, "profile-level-id=64001f"), strings.Index(offer, "profile-level-id=42e01f")
			if c := strings.Index(offer, "profile-level-id=640c1f"); c < 0 || hi < c || base < hi {
				t.Fatalf("offer order must be 640c1f, 64001f, 42e01f:\n%s", offer)
			}

			seen, left := asSeenByBrowser(t, offer, tc.listed)
			if left != tc.left || strings.Contains(seen, "640c1f") {
				t.Fatalf("%s should be left with %d video payload type(s), got %d:\n%s", tc.browser, tc.left, left, seen)
			}
			// The sidecar's track is Constrained High; it must still start
			// when the browser took another variant.
			if err := s.SetAnswer("webui-preview", browserAnswer(t, seen, tc.answers)); err != nil {
				t.Fatalf("SetAnswer after a %s answer: %v", tc.browser, err)
			}
		})
	}
}

// A TeamSpeak viewer keeps the single offer the client is known to render,
// which is the offer a browser has nothing to answer to.
func TestTeamSpeakPeerOfferIsUnchanged(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()

	offer, err := s.CreatePeer("42", codecH264)
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer("42")
	if !strings.Contains(offer, "profile-level-id=640c1f") || strings.Contains(offer, "profile-level-id=64001f") {
		t.Fatalf("TeamSpeak offer must carry Constrained High only:\n%s", offer)
	}
	for _, listed := range [][]string{chromiumH264, firefoxH264} {
		if _, left := asSeenByBrowser(t, offer, listed); left != 0 {
			t.Fatalf("a browser should find no video codec in the TeamSpeak offer, found %d", left)
		}
	}
}

func TestBrowserFallbacksAreForH264Only(t *testing.T) {
	for _, codec := range []string{codecVP8, codecVP9} {
		if got := browserVideoFallbacks(codec); len(got) != 0 {
			t.Errorf("%s needs no browser fallback, got %d", codec, len(got))
		}
	}
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	offer, err := s.CreatePeerFor("webui-preview", codecVP8, true)
	if err != nil {
		t.Fatalf("CreatePeerFor: %v", err)
	}
	defer s.ClosePeer("webui-preview")
	if strings.Contains(offer, "H264") {
		t.Errorf("a VP8 stream must not offer H.264 to the browser:\n%s", offer)
	}
}
