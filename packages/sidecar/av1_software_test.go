package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSoftwareAV1DecoderSelection(t *testing.T) {
	for _, tc := range []struct{ out, want string }{
		{" V....D libaom-av1 AV1\n V..... libdav1d AV1", "libdav1d"},
		{" V....D av1 AV1\n V....D libaom-av1 AV1", "libaom-av1"},
		{" V....D av1 AV1", ""},
		{" A..... libdav1d description\n V..... av1 description libdav1d", ""},
	} {
		if got := softwareAV1Decoder(tc.out); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.out, got, tc.want)
		}
	}
}

func TestSoftwareAV1DecoderIsAskedOncePerBuild(t *testing.T) {
	c := &av1SoftwareDecoderCache{}
	calls := 0
	run := func(_ context.Context, args []string) (string, error) {
		calls++
		if strings.Join(args, " ") != "-hide_banner -decoders" {
			t.Fatal(args)
		}
		return " V....D libaom-av1 AV1", nil
	}
	for i := 0; i < 2; i++ {
		if got := c.get(run, "build1"); got != "libaom-av1" {
			t.Fatalf("got %q", got)
		}
	}
	if calls != 1 {
		t.Fatal("list was not cached")
	}
	// A list that could not be read names no decoder and is asked for again.
	failing := func(context.Context, []string) (string, error) {
		calls++
		return " V..... libdav1d AV1", errors.New("failed")
	}
	for i := 0; i < 2; i++ {
		if got := c.get(failing, "build2"); got != "" {
			t.Fatalf("a failed query named %q", got)
		}
	}
	if calls != 3 {
		t.Fatalf("a failed query must not be cached: %d calls", calls)
	}
}

// The software fallback names the decoder the build has, on the video input
// only. A build that lists none is left to choose, as before.
func TestAV1SoftwareFallbackNamesTheDecoderOfTheBuild(t *testing.T) {
	for _, decoder := range []string{"libaom-av1", ""} {
		t.Run(decoder, func(t *testing.T) {
			calls := installFakeFFmpeg(t, "exec sleep 30\n")
			table := " V....D av1 AV1\n"
			if decoder != "" {
				table += " V....D " + decoder + " AV1\n"
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(calls), "decoders.txt"), []byte(table), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("VIDEO_HW_DECODE", "1")
			t.Setenv("VAAPI_VERIFY_MS", "50")
			s := NewSidecar()
			defer s.Stop()
			session, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/video", AudioSource: "https://example.com/audio", VideoCodec: "av1", Encoder: "h264_nvenc", av1FallbackReason: "decoder failed"})
			if err != nil {
				t.Fatal(err)
			}
			runs := waitForCalls(t, calls, 1)
			if decoder == "" {
				if session.Decoder != "software" || session.State != "running" {
					t.Fatalf("want the stream running on FFmpeg's choice: %+v", session)
				}
				if len(runs) != 1 || strings.Contains(runs[0], "-c:v av1 ") || strings.Contains(runs[0], "-c:v lib") {
					t.Fatalf("no decoder may be named: %v", runs)
				}
				return
			}
			if session.Decoder != decoder {
				t.Fatalf("misleading decoder: %+v", session)
			}
			if len(runs) != 1 || !strings.Contains(runs[0], "-c:v libaom-av1 -i https://example.com/video") || strings.Count(runs[0], "-c:v libaom-av1") != 1 {
				t.Fatalf("decoder not scoped to video input: %v", runs)
			}
		})
	}
}

func TestLocalVideoMetadataDoesNotOverrideStreamIndex(t *testing.T) {
	prev := localVideo
	defer func() { localVideo = prev }()
	localVideo = func(string) sourceVideo { return sourceVideo{codec: "av1", stream: 2} }
	got := sourceVideoOf(SourceRequest{Source: "/media/reordered.mkv", VideoCodec: "av1"})
	if got.stream != 2 {
		t.Fatalf("codec metadata hid local video stream: %+v", got)
	}
	localVideo = func(string) sourceVideo { return sourceVideo{} }
	if got := sourceVideoOf(SourceRequest{Source: "/media/reordered.mkv", VideoCodec: "av1"}); got.codec != "" {
		t.Fatal("failed probe guessed local stream 0")
	}
}
