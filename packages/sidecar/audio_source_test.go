package main

import (
	"strings"
	"testing"
)

// YouTube delivers video and audio separately above 720p. The audio is a
// second input, with its own input options, and the audio output reads it.
func TestSplitSourceReadsAudioFromASecondInput(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	req := SourceRequest{Source: "https://v.example/video", AudioSource: "https://a.example/audio", Mode: modeVOD, Volume: 100}
	args := s.buildFFmpegArgs(req, spec, false)
	got := strings.Join(args, " ")

	video := strings.Index(got, "-i https://v.example/video")
	audio := strings.Index(got, "-i https://a.example/audio")
	if video < 0 || audio < video {
		t.Fatalf("want the video input, then the audio input: %s", got)
	}
	// Input options apply to the next -i only: each input needs its own.
	for _, opt := range []string{"-reconnect 1", "-fflags +genpts+discardcorrupt", "-re -i"} {
		if n := strings.Count(got, opt); n != 2 {
			t.Errorf("%q appears %d times, want once per input: %s", opt, n, got)
		}
	}
	if !strings.Contains(got, "-map 0:v:0") || !strings.Contains(got, "-map 1:a:0 ") {
		t.Errorf("video must come from input 0 and audio from input 1: %s", got)
	}
	if strings.Contains(got, "0:a:0") {
		t.Errorf("the video-only input has no audio to map: %s", got)
	}
}

func TestSingleSourceKeepsItsOwnAudio(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	got := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://x.example/clip.mp4", Mode: modeVOD, Volume: 100}, spec, false), " ")
	if strings.Count(got, " -i ") != 1 || !strings.Contains(got, "-map 0:a:0?") {
		t.Fatalf("one input, audio optional from it: %s", got)
	}
}

func TestAudioSourceMustBeRemoteWithARemoteSource(t *testing.T) {
	cases := []struct {
		source, audio string
		ok            bool
	}{
		{"https://v.example/video", "", true},
		{"https://v.example/video", "https://a.example/audio", true},
		{"https://v.example/video", "/data/music/a.opus", false},
		{"https://v.example/video", "file:///etc/passwd", false},
		{"/data/music/clip.mp4", "https://a.example/audio", false},
		{"", "https://a.example/audio", false},
	}
	for _, tc := range cases {
		if err := validAudioSource(tc.source, tc.audio); (err == nil) != tc.ok {
			t.Errorf("validAudioSource(%q, %q) = %v, want ok=%v", tc.source, tc.audio, err, tc.ok)
		}
	}
	s := NewSidecar()
	if _, err := s.StartFFmpeg(SourceRequest{Source: "https://v.example/video", AudioSource: "/etc/passwd", Encoder: "vp8"}); err == nil {
		t.Fatal("StartFFmpeg must refuse a local audio source")
	}
}
